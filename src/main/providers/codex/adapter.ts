import { homedir } from 'node:os'
import type {
  AccessMode,
  ApprovalDecision,
  ApprovalItem,
  ModelOption,
  ProviderStatus,
  RateWindow,
  SlashCommand
} from '@shared/types'
import { CODEX_INIT_PROMPT } from './prompts'
import { binaryVersion } from '../../env'
import { NativeSessionLostError, type Emit, type ProviderAdapter, type TurnRequest } from '../types'
import { CodexRpc, RpcError } from './rpc'
import { CodexThreadMapper, codexRateWindows, unwrapShell } from './mapper'
import { saveToolImage } from '../../util/toolImages'
import { modelEffort } from '@shared/routing'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

export interface CodexDeps {
  routing?: {
    ensureModel: (model: string | undefined, hasImages: boolean) => Promise<ModelOption | undefined>
    codexConfig: (model: string | undefined) => { model: string | undefined; modelProvider?: string; config?: Json }
  }
  binary: () => string | null
  env: () => NodeJS.ProcessEnv
  appVersion: string
  log?: (...args: unknown[]) => void
  /** How long Codex gets to confirm a Stop before the turn is ended locally. */
  interruptGraceMs?: number
  /** Where pictures returned by tools (MCP screenshots…) are kept. */
  attachmentsDir?: string
}

const SERVER_IDLE_MS = 30 * 60 * 1000

export function codexPolicy(access: AccessMode): { approvalPolicy: string; sandbox: string; sandboxPolicy: Json } {
  const workspaceWrite = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  switch (access) {
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
    case 'auto':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: workspaceWrite }
    case 'full':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    default:
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: workspaceWrite }
  }
}

interface ThreadState {
  duetId: string
  codexId?: string
  loaded: boolean
  cwd: string
  emit: Emit
  mapper: CodexThreadMapper
  /** The turn Codex is running now — what `turn/interrupt` needs. */
  turnId?: string
  /**
   * The turn Duet started (`turn/start` / `review/start` reply). A review reports an inner turn as
   * started, which `turnId` then holds, but completes under this id.
   */
  rootTurnId?: string
  active: boolean
  interrupted: boolean
  interruptTimer?: NodeJS.Timeout
  /** Turn the last `turn/interrupt` was sent for. */
  interruptSentFor?: string
  /** Incremented for every turn, so timers armed for an old turn can never touch a newer one. */
  turnSeq: number
  startedAt: number
  /** Thread token totals: latest, and at the start of the current turn (for per-turn usage). */
  tokens?: { input: number; cached: number; output: number }
  tokensAtStart?: { input: number; cached: number; output: number }
}

interface PendingRequest {
  duetId: string
  rpcId: number | string
  method: string
  params: Json
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const
  private rpc: CodexRpc | null = null
  private starting: Promise<CodexRpc> | null = null
  private threads = new Map<string, ThreadState>()
  private byCodex = new Map<string, string>()
  /** Codex thread ids of deleted Duet threads: their late events are dropped, never reassigned. */
  private released = new Set<string>()
  /** Throwaway threads (theme design…) and who listens to them. Never routed to a chat. */
  private oneShots = new Map<string, (method: string, params: Json) => void>()
  private pendingLogin: { id: string | null; onDone: (ok: boolean, message?: string) => void } | null = null
  private approvals = new Map<string, PendingRequest>()
  private statusCache: ProviderStatus | null = null
  private statusPromise: Promise<ProviderStatus> | null = null
  private limits: RateWindow[] = []
  private serverVersion?: string
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: CodexDeps) {}

  // ---------- server lifecycle ----------

  private async ensureServer(): Promise<CodexRpc> {
    if (this.rpc && !this.rpc.exited) {
      this.touch()
      return this.rpc
    }
    if (this.starting) return this.starting
    this.starting = (async () => {
      const bin = this.deps.binary()
      if (!bin) throw new Error('Codex CLI not found. Install it (npm i -g @openai/codex) or set its path in Settings → Providers.')
      const rpc = new CodexRpc(bin, ['app-server'], this.deps.env(), homedir())
      rpc.onNotification = (method, params) => this.onNotification(method, params)
      rpc.onRequest = (id, method, params) => this.onRequest(id, method, params)
      rpc.onExit = () => this.onServerExit(rpc)
      try {
        const init = await rpc.request(
          'initialize',
          {
            clientInfo: { name: 'duet', title: 'Duet', version: this.deps.appVersion },
            capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['turn/diff/updated'] }
          },
          30_000
        )
        const ua: string = init?.userAgent ?? ''
        const match = ua.match(/\/(\d+\.\d+\.\d+[^\s]*)/)
        if (match) this.serverVersion = match[1]
        rpc.notify('initialized')
      } catch (error) {
        rpc.kill()
        throw new Error(friendlyCodexError((error as Error).message, rpc.stderr.value))
      }
      this.rpc = rpc
      this.touch()
      return rpc
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      const busy = [...this.threads.values()].some((t) => t.active)
      if (!busy && this.rpc) {
        this.rpc.kill()
        this.rpc = null
      } else this.touch()
    }, SERVER_IDLE_MS)
    this.idleTimer.unref?.()
  }

  private onServerExit(rpc: CodexRpc): void {
    if (this.rpc === rpc) this.rpc = null
    for (const st of this.threads.values()) {
      st.loaded = false
      if (st.active) {
        st.active = false
        if (st.interruptTimer) clearTimeout(st.interruptTimer)
        st.emit({
          type: 'turn-end',
          status: st.interrupted ? 'interrupted' : 'failed',
          error: st.interrupted ? undefined : `Codex stopped unexpectedly. ${rpc.stderr.value.trim().split('\n').slice(-2).join(' ')}`.trim()
        })
      }
    }
    for (const [itemId, pending] of this.approvals) {
      const st = this.threads.get(pending.duetId)
      st?.emit({ type: 'approval-status', itemId, status: 'expired' })
    }
    this.approvals.clear()
  }

  // ---------- turns ----------

  private stateFor(req: TurnRequest, emit: Emit): ThreadState {
    let st = this.threads.get(req.threadId)
    if (!st) {
      const dir = this.deps.attachmentsDir
      const saveImage = dir ? (data: string, mime: string) => saveToolImage(dir, data, mime) : undefined
      const mapper = new CodexThreadMapper({ cwd: req.cwd, home: homedir(), now: Date.now, saveImage }, emit)
      st = { duetId: req.threadId, loaded: false, cwd: req.cwd, emit, mapper, active: false, interrupted: false, turnSeq: 0, startedAt: 0 }
      this.threads.set(req.threadId, st)
    }
    st.emit = emit
    st.mapper.emit = emit
    return st
  }

  async startTurn(req: TurnRequest, emit: Emit): Promise<void> {
    const selected = await this.deps.routing?.ensureModel(req.model, req.attachments.some((a) => a.mime.startsWith('image/')))
    req = { ...req, effort: modelEffort(selected, req.effort) }
    const routing = this.deps.routing?.codexConfig(req.model)
    const model = routing?.model ?? req.model
    const rpc = await this.ensureServer()
    const st = this.stateFor(req, emit)
    if (st.active) throw new Error('Codex is still working on the previous message.')
    const policy = codexPolicy(req.access)
    if (st.cwd !== req.cwd) {
      st.cwd = req.cwd
      st.loaded = false
    }
    const needsThread = !st.codexId || !st.loaded || (req.nativeId !== undefined && st.codexId !== req.nativeId)
    if (needsThread) {
      if (req.nativeId) {
        try {
          await this.resumeThread(rpc, req.nativeId, req, policy)
          st.codexId = req.nativeId
        } catch (error) {
          const msg = (error as Error).message
          if (/not found|no (such )?(thread|rollout|session)|unknown thread|does not exist/i.test(msg)) {
            throw new NativeSessionLostError(`Codex thread ${req.nativeId} can no longer be resumed`)
          }
          throw new Error(friendlyCodexError(msg, rpc.stderr.value))
        }
      } else {
        const params: Json = {
          cwd: req.cwd,
          model: model ?? null,
          ...(routing?.modelProvider ? { modelProvider: routing.modelProvider } : {}),
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          developerInstructions: req.instructions || null,
          config: { 'tools.update_plan.enabled': true, ...routing?.config }
        }
        let res: Json
        try {
          res = await rpc.request('thread/start', params)
        } catch (error) {
          // Dropping a routed provider config could send the prompt to the native account.
          if (routing?.modelProvider) throw error
          delete params.config
          res = await rpc.request('thread/start', params)
        }
        st.codexId = res.thread.id as string
        st.mapper.model = res.model ?? req.model
      }
      st.loaded = true
      this.bind(st.codexId!, req.threadId)
      emit({ type: 'native-id', nativeId: st.codexId! })
    }
    const pathLines: string[] = []
    const input: Json[] = []
    for (const att of req.attachments) {
      if (att.mime.startsWith('image/')) input.push({ type: 'localImage', path: att.path })
      else pathLines.push(`[Attached file "${att.name}" is saved at: ${att.path}]`)
    }
    let text = req.text
    if (req.access === 'plan') text = `(Plan mode: investigate and propose a plan. Do not modify files.)\n\n${text}`
    if (pathLines.length) text = `${text}\n\n${pathLines.join('\n')}`
    input.unshift({ type: 'text', text, text_elements: [] })
    for (const skill of req.skills ?? []) input.push({ type: 'skill', name: skill.name, path: skill.path })
    if (req.model) st.mapper.model = req.model
    if (st.interruptTimer) {
      clearTimeout(st.interruptTimer)
      st.interruptTimer = undefined
    }
    st.turnSeq++
    st.active = true
    st.interrupted = false
    st.interruptSentFor = undefined
    st.turnId = undefined
    st.rootTurnId = undefined
    st.startedAt = Date.now()
    st.tokensAtStart = st.tokens ? { ...st.tokens } : undefined
    try {
      const res = req.review
        ? // A code review runs as a turn of its own in this thread; its findings arrive as items.
          await rpc.request('review/start', { threadId: st.codexId, target: req.review, delivery: 'inline' })
        : await rpc.request('turn/start', {
            threadId: st.codexId,
            input,
            cwd: req.cwd,
            model: model ?? null,
            effort: req.effort ?? null,
            approvalPolicy: policy.approvalPolicy,
            sandboxPolicy: policy.sandboxPolicy,
            summary: 'auto',
            ...(req.fast && !routing?.modelProvider ? { serviceTier: 'priority' } : {})
          })
      if (res?.turn?.id) {
        st.rootTurnId = res.turn.id
        // `turn/started` may have come first; for a review it names the inner turn, which is the one to interrupt.
        st.turnId ??= res.turn.id
      }
      // Stop pressed before Codex told us the turn id.
      if (st.interrupted && st.active) void this.sendInterrupt(st)
    } catch (error) {
      st.active = false
      throw new Error(friendlyCodexError((error as Error).message, rpc.stderr.value))
    }
  }

  private async resumeThread(rpc: CodexRpc, threadId: string, req: TurnRequest, policy: ReturnType<typeof codexPolicy>): Promise<void> {
    const routing = this.deps.routing?.codexConfig(req.model)
    const params = { threadId, cwd: req.cwd, model: routing?.model ?? req.model ?? null, ...(routing?.modelProvider ? { modelProvider: routing.modelProvider, config: routing.config } : {}), approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, developerInstructions: req.instructions || null, excludeTurns: true }
    try {
      await rpc.request('thread/resume', params)
    } catch (error) {
      if (/archived/i.test((error as Error).message)) {
        await rpc.request('thread/unarchive', { threadId })
        await rpc.request('thread/resume', params)
        return
      }
      throw error
    }
  }

  /** Adds hand-off history to a Codex thread as a developer message. Returns false if unsupported. */
  async injectContext(threadId: string, text: string): Promise<boolean> {
    const st = this.threads.get(threadId)
    if (!st?.codexId || !this.rpc) return false
    try {
      await this.rpc.request('thread/inject_items', {
        threadId: st.codexId,
        items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }]
      })
      return true
    } catch (error) {
      this.deps.log?.('[codex] inject_items failed', (error as Error).message)
      return false
    }
  }

  /** Makes sure the thread exists in Codex before a hand-off injection. */
  async prepareThread(req: TurnRequest, emit: Emit): Promise<string | undefined> {
    await this.deps.routing?.ensureModel(req.model, req.attachments.some((a) => a.mime.startsWith('image/')))
    const routing = this.deps.routing?.codexConfig(req.model)
    const rpc = await this.ensureServer()
    const st = this.stateFor(req, emit)
    const policy = codexPolicy(req.access)
    if (st.codexId && st.loaded && (req.nativeId === undefined || req.nativeId === st.codexId)) return st.codexId
    if (req.nativeId) {
      try {
        await this.resumeThread(rpc, req.nativeId, req, policy)
      } catch {
        return undefined
      }
      st.codexId = req.nativeId
    } else {
      const res = await rpc.request('thread/start', {
        cwd: req.cwd,
        model: routing?.model ?? req.model ?? null,
        ...(routing?.modelProvider ? { modelProvider: routing.modelProvider } : {}),
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        developerInstructions: req.instructions || null,
        config: { 'tools.update_plan.enabled': true, ...routing?.config }
      })
      st.codexId = res.thread.id as string
    }
    st.cwd = req.cwd
    st.loaded = true
    this.bind(st.codexId!, req.threadId)
    emit({ type: 'native-id', nativeId: st.codexId! })
    return st.codexId
  }

  private bind(codexId: string, duetId: string): void {
    // A thread can come back (e.g. imported again from History after being deleted).
    this.released.delete(codexId)
    this.byCodex.set(codexId, duetId)
  }

  async interrupt(threadId: string): Promise<void> {
    const st = this.threads.get(threadId)
    if (!st || !st.active) return
    st.interrupted = true
    for (const [itemId, pending] of this.approvals) {
      if (pending.duetId !== threadId) continue
      this.answer(pending, { kind: 'deny' }, true)
      this.approvals.delete(itemId)
      st.emit({ type: 'approval-status', itemId, status: 'expired' })
    }
    // Pressing Stop twice re-arms one timer instead of leaving an older one behind that could
    // end the next turn.
    const turn = st.turnSeq
    if (st.interruptTimer) clearTimeout(st.interruptTimer)
    st.interruptTimer = setTimeout(() => {
      st.interruptTimer = undefined
      if (st.active && st.turnSeq === turn) {
        st.active = false
        st.emit({ type: 'turn-end', status: 'interrupted' })
      }
    }, this.deps.interruptGraceMs ?? 10_000)
    // Without a turn id yet, the interrupt goes out as soon as Codex reports one.
    await this.sendInterrupt(st)
  }

  private async sendInterrupt(st: ThreadState): Promise<void> {
    if (!this.rpc || !st.codexId || !st.turnId || st.interruptSentFor === st.turnId) return
    st.interruptSentFor = st.turnId
    try {
      await this.rpc.request('turn/interrupt', { threadId: st.codexId, turnId: st.turnId }, 8000)
    } catch (error) {
      this.deps.log?.('[codex] interrupt failed', (error as Error).message)
    }
  }

  private answer(pending: PendingRequest, decision: ApprovalDecision, cancel = false): void {
    if (!this.rpc) return
    const deny = decision.kind === 'deny'
    switch (pending.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.rpc.respond(pending.rpcId, {
          decision: deny ? (cancel ? 'cancel' : 'decline') : decision.kind === 'allow-session' ? 'acceptForSession' : 'accept'
        })
        break
      case 'item/permissions/requestApproval': {
        if (deny) {
          this.rpc.respond(pending.rpcId, { permissions: {}, scope: 'turn' })
          break
        }
        const requested = pending.params?.permissions ?? {}
        const granted: Json = {}
        if (requested.network) granted.network = requested.network
        if (requested.fileSystem) granted.fileSystem = requested.fileSystem
        this.rpc.respond(pending.rpcId, { permissions: granted, scope: decision.kind === 'allow-session' ? 'session' : 'turn' })
        break
      }
      case 'item/tool/requestUserInput': {
        const answers: Json = {}
        if (decision.kind === 'answer') {
          for (const [questionId, value] of Object.entries(decision.answers)) {
            answers[questionId] = { answers: value ? value.split('\u001f') : [] }
          }
        }
        this.rpc.respond(pending.rpcId, { answers })
        break
      }
      default:
        this.rpc.respondError(pending.rpcId, -32601, 'Unsupported request')
    }
  }

  respond(threadId: string, itemId: string, decision: ApprovalDecision): boolean {
    const pending = this.approvals.get(itemId)
    if (!pending || pending.duetId !== threadId) return false
    this.approvals.delete(itemId)
    this.answer(pending, decision)
    if (decision.kind === 'deny') {
      const st = this.threads.get(threadId)
      const target = pending.params?.itemId ? st?.mapper.get(pending.params.itemId) : undefined
      if (target && target.kind === 'tool') st?.emit({ type: 'item', item: { ...target, status: 'declined' } })
    }
    return true
  }

  async setAccess(): Promise<void> {
    // Codex takes the policy on every turn/start, nothing to do mid-session.
  }

  // ---------- incoming traffic ----------

  private resolveThread(codexThreadId: string | undefined): ThreadState | undefined {
    if (!codexThreadId || this.released.has(codexThreadId)) return undefined
    const duetId = this.byCodex.get(codexThreadId)
    if (duetId) return this.threads.get(duetId)
    // A sub-agent we didn't see start: it can only belong to a thread that is working right now.
    // Not remembered, so a stray id can never stick to a thread that happens to be active.
    const active = [...this.threads.values()].filter((t) => t.active)
    return active.length === 1 ? active[0] : undefined
  }

  /** Remembers which Duet thread a sub-agent belongs to (`thread/started` names its parent). */
  private adoptSubagent(thread: Json): void {
    const id: unknown = thread?.id
    if (typeof id !== 'string' || this.byCodex.has(id) || this.released.has(id)) return
    const source = thread?.source?.subAgent ?? thread?.source?.subagent
    const parent: unknown = thread?.parentThreadId ?? source?.thread_spawn?.parent_thread_id
    if (typeof parent !== 'string') return
    if (this.released.has(parent)) {
      this.released.add(id)
      return
    }
    const duetId = this.byCodex.get(parent)
    if (duetId) this.byCodex.set(id, duetId)
  }

  private isPrimary(st: ThreadState, codexThreadId: string): boolean {
    return st.codexId === codexThreadId
  }

  private onNotification(method: string, params: Json): void {
    if (method === 'account/rateLimits/updated') {
      const limits = codexRateWindows(params?.rateLimits)
      if (!limits.length) return
      this.setLimits(limits)
      for (const st of this.threads.values()) if (st.active) st.emit({ type: 'limits', limits: this.limits })
      return
    }
    if (method === 'thread/started') {
      this.adoptSubagent(params?.thread)
      return
    }
    if (method === 'account/login/completed') {
      const pending = this.pendingLogin
      if (pending && (!pending.id || !params?.loginId || params.loginId === pending.id)) {
        this.pendingLogin = null
        this.statusCache = null
        pending.onDone(!!params?.success, params?.error ?? undefined)
      }
      return
    }
    if (method === 'account/updated') {
      this.statusCache = null
      return
    }
    const oneShot = typeof params?.threadId === 'string' ? this.oneShots.get(params.threadId) : undefined
    if (oneShot) {
      oneShot(method, params)
      return
    }
    const st = this.resolveThread(params?.threadId)
    if (!st) return
    const primary = this.isPrimary(st, params.threadId)
    const m = st.mapper
    switch (method) {
      case 'turn/started':
        if (primary && params.turn?.id) {
          st.turnId = params.turn.id
          if (st.interrupted && st.active) void this.sendInterrupt(st)
        }
        break
      case 'item/started':
        m.itemStarted(params.item)
        break
      case 'item/completed':
        m.itemCompleted(params.item)
        break
      case 'item/agentMessage/delta':
        m.textDelta(params.itemId, params.delta, 'assistant')
        break
      case 'item/plan/delta':
        m.textDelta(params.itemId, params.delta, 'assistant')
        break
      case 'item/reasoning/summaryTextDelta':
        m.reasoningSummaryDelta(params.itemId, params.delta)
        break
      case 'item/reasoning/summaryPartAdded':
        m.reasoningSummaryPart(params.itemId)
        break
      case 'item/reasoning/textDelta':
        m.reasoningRawDelta(params.itemId, params.delta)
        break
      case 'item/commandExecution/outputDelta':
        m.outputDelta(params.itemId, params.delta)
        break
      case 'turn/plan/updated':
        if (params.turnId) m.plan(params.turnId, params.explanation ?? null, params.plan)
        break
      case 'thread/tokenUsage/updated': {
        if (!primary) break
        const usage = params.tokenUsage
        const total = usage?.total
        if (total) st.tokens = { input: Number(total.inputTokens ?? 0), cached: Number(total.cachedInputTokens ?? 0), output: Number(total.outputTokens ?? 0) + Number(total.reasoningOutputTokens ?? 0) }
        const used = usage?.last?.totalTokens ?? 0
        if (used > 0) st.emit({ type: 'context', usage: { usedTokens: used, windowTokens: usage?.modelContextWindow ?? undefined } })
        break
      }
      case 'error': {
        if (!primary) break
        const message = params.error?.message ?? 'Codex reported an error'
        if (params.willRetry) {
          st.emit({ type: 'item', item: { kind: 'notice', id: `x-retry-${Date.now()}`, ts: Date.now(), level: 'warn', provider: 'codex', text: `${message} — retrying…` } })
        }
        break
      }
      case 'turn/completed': {
        if (!primary) break
        const turn = params.turn ?? {}
        const expected = st.rootTurnId ?? st.turnId
        if (turn.id && expected && turn.id !== expected) break
        st.rootTurnId = undefined
        if (st.interruptTimer) {
          clearTimeout(st.interruptTimer)
          st.interruptTimer = undefined
        }
        m.finishTurn(turn.id ?? st.turnId ?? '')
        if (!st.active) break
        st.active = false
        const status = turn.status === 'interrupted' || st.interrupted ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed'
        const err = turn.error
        const spent = st.tokens && st.tokensAtStart ? { input: st.tokens.input - st.tokensAtStart.input, cached: st.tokens.cached - st.tokensAtStart.cached, output: st.tokens.output - st.tokensAtStart.output } : st.tokens
        st.emit({
          type: 'turn-end',
          status,
          error: status === 'failed' ? [err?.message, err?.additionalDetails].filter(Boolean).join('\n') || 'Codex turn failed' : undefined,
          durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : Date.now() - st.startedAt,
          inputTokens: spent && spent.input > 0 ? spent.input : undefined,
          outputTokens: spent && spent.output > 0 ? spent.output : undefined,
          cacheReadTokens: spent && spent.cached > 0 ? spent.cached : undefined,
          model: m.model
        })
        this.touch()
        break
      }
      case 'serverRequest/resolved': {
        for (const [itemId, pending] of this.approvals) {
          if (pending.rpcId === params.requestId && pending.duetId === st.duetId) {
            this.approvals.delete(itemId)
            st.emit({ type: 'approval-status', itemId, status: 'expired' })
          }
        }
        break
      }
      case 'model/rerouted':
        if (primary && typeof params.toModel === 'string') {
          m.model = params.toModel
          st.emit({ type: 'model', model: params.toModel })
        }
        break
      default:
        break
    }
  }

  private onRequest(id: number | string, method: string, params: Json): void {
    const rpc = this.rpc
    if (!rpc) return
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      rpc.respond(id, { decision: 'denied' })
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      rpc.respond(id, { action: 'decline', content: null, _meta: null })
      const st = this.resolveThread(params?.threadId)
      st?.emit({
        type: 'item',
        item: { kind: 'notice', id: `x-elicit-${id}-${Date.now()}`, ts: Date.now(), level: 'warn', provider: 'codex', text: `MCP server "${params?.serverName ?? 'unknown'}" asked for input (${params?.message ?? 'no details'}). Duet declined it; answer it in the Codex app if needed.` }
      })
      return
    }
    const handled = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']
    if (!handled.includes(method)) {
      rpc.respondError(id, -32601, `Duet does not support ${method}`)
      return
    }
    const st = typeof params?.threadId === 'string' && this.oneShots.has(params.threadId) ? undefined : this.resolveThread(params?.threadId)
    if (!st) {
      // Nobody to ask (or a throwaway thread): decline safely.
      this.answer({ duetId: '', rpcId: id, method, params }, { kind: 'deny' })
      return
    }
    const itemId = `x-approval-${id}-${st.startedAt}`
    this.approvals.set(itemId, { duetId: st.duetId, rpcId: id, method, params })
    const base = { kind: 'approval' as const, id: itemId, ts: Date.now(), provider: 'codex' as const, status: 'pending' as const }
    let item: ApprovalItem
    if (method === 'item/commandExecution/requestApproval') {
      item = { ...base, request: 'command', title: 'Run this command?', command: unwrapShell(params.command ?? ''), cwd: params.cwd ?? st.cwd, detail: params.reason ?? undefined, canAllowForSession: true }
    } else if (method === 'item/fileChange/requestApproval') {
      const target = st.mapper.get(params.itemId)
      item = {
        ...base,
        request: 'edit',
        title: target && target.kind === 'tool' ? `Apply changes to ${target.title}?` : 'Apply these file changes?',
        diff: target && target.kind === 'tool' ? target.diff : undefined,
        detail: params.reason ?? (params.grantRoot ? `Grants write access to ${params.grantRoot}` : undefined),
        permissionGrant: !!params.grantRoot || undefined,
        canAllowForSession: true
      }
    } else if (method === 'item/permissions/requestApproval') {
      const p = params.permissions ?? {}
      const lines: string[] = []
      if (p.network?.enabled) lines.push('• Network access')
      for (const path of p.fileSystem?.write ?? []) lines.push(`• Write to ${path}`)
      for (const path of p.fileSystem?.read ?? []) lines.push(`• Read ${path}`)
      item = { ...base, request: 'permissions', title: 'Allow extra permissions?', detail: [params.reason, lines.join('\n')].filter(Boolean).join('\n\n') || undefined, canAllowForSession: true }
    } else {
      const questions = Array.isArray(params.questions) ? params.questions : []
      item = {
        ...base,
        request: 'question',
        title: 'Codex has a question',
        questions: questions.map((q: Json) => ({
          id: String(q.id),
          header: q.header || undefined,
          question: String(q.question ?? ''),
          options: Array.isArray(q.options) ? q.options.map((o: Json) => ({ label: String(o.label ?? ''), description: o.description || undefined })) : [],
          allowOther: q.isOther !== false
        })),
        canAllowForSession: false
      }
    }
    st.emit({ type: 'item', item })
  }

  // ---------- status ----------

  /** Updates often carry one window only; merge by label so the others don't flicker away. */
  private setLimits(limits: RateWindow[]): void {
    const merged = new Map(this.limits.map((l) => [l.label, l]))
    for (const l of limits) merged.set(l.label, l)
    this.limits = [...merged.values()]
    if (this.statusCache) this.statusCache = { ...this.statusCache, limits: this.limits }
  }

  getLimits(): RateWindow[] {
    return this.limits
  }

  async status(force = false): Promise<ProviderStatus> {
    if (this.statusCache && !force && Date.now() - (this.statusCache.checkedAt ?? 0) < 5 * 60_000) return this.statusCache
    if (this.statusPromise) return this.statusPromise
    this.statusPromise = (async () => {
      const bin = this.deps.binary()
      if (!bin) {
        this.statusCache = { id: 'codex', installed: false, models: [], limits: [], checkedAt: Date.now(), error: 'Codex CLI not found' }
        return this.statusCache
      }
      const status: ProviderStatus = { id: 'codex', installed: true, binaryPath: bin, models: this.statusCache?.models ?? [], limits: this.limits }
      try {
        const rpc = await this.ensureServer()
        status.version = this.serverVersion ?? (await binaryVersion(bin))
        const account = await rpc.request('account/read', { refreshToken: false }, 20_000)
        const acct = account?.account
        status.loggedIn = !!acct
        if (acct?.type === 'chatgpt') {
          status.account = acct.email ?? 'ChatGPT account'
          status.plan = acct.planType ? prettyPlan(String(acct.planType)) : undefined
        } else if (acct?.type === 'apiKey') {
          status.account = 'API key'
          status.plan = 'API key'
        } else if (acct?.type === 'amazonBedrock') {
          status.account = 'Amazon Bedrock'
        }
        if (!acct && account?.requiresOpenaiAuth) status.error = 'Not signed in — run `codex login` in a terminal.'
        const models: ModelOption[] = []
        let cursor: string | null = null
        for (let page = 0; page < 10; page++) {
          const res: Json = await rpc.request('model/list', cursor ? { cursor, limit: 100 } : { limit: 100 }, 20_000)
          for (const m of res?.data ?? []) {
            if (m.hidden) continue
            const efforts: Json[] = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []
            const fast = (Array.isArray(m.serviceTiers) ? m.serviceTiers : []).find((t: Json) => t?.id && t.id !== 'default')
            models.push({
              id: m.id ?? m.model,
              label: m.displayName || m.id,
              description: m.description || undefined,
              efforts: efforts.length ? efforts.map((e: Json) => e.reasoningEffort).filter(Boolean) : undefined,
              effortHints: Object.fromEntries(efforts.filter((e: Json) => e?.reasoningEffort && e.description).map((e: Json) => [e.reasoningEffort, String(e.description)])),
              defaultEffort: m.defaultReasoningEffort || undefined,
              isDefault: !!m.isDefault,
              supportsImages: Array.isArray(m.inputModalities) ? m.inputModalities.includes('image') : true,
              fastTier: fast ? { id: String(fast.id), name: String(fast.name ?? 'Fast'), description: String(fast.description ?? '') } : undefined
            })
          }
          cursor = res?.nextCursor ?? null
          if (!cursor) break
        }
        if (models.length) status.models = models
        status.defaultModel = models.find((m) => m.isDefault)?.id
        try {
          const rl = await rpc.request('account/rateLimits/read', undefined, 10_000)
          const limits = codexRateWindows(rl?.rateLimits)
          if (limits.length) this.setLimits(limits)
          status.limits = this.limits
        } catch {
          // Rate limits are only available for ChatGPT sign-ins.
        }
      } catch (error) {
        status.error = friendlyCodexError((error as Error).message, this.rpc?.stderr.value ?? '')
        if (!status.version) status.version = await binaryVersion(bin)
      }
      status.checkedAt = Date.now()
      this.statusCache = status
      return status
    })().finally(() => {
      this.statusPromise = null
    })
    return this.statusPromise
  }

  /** Codex's own commands (Duet runs them through the app-server) plus your Codex skills. */
  async commands(cwd: string): Promise<SlashCommand[]> {
    const builtIn: SlashCommand[] = [
      { name: 'review', description: 'Review your uncommitted changes (or a branch / commit)', argumentHint: '[branch | commit | what to focus on]' },
      { name: 'compact', description: 'Summarize the conversation to free up context' },
      { name: 'init', description: 'Write an AGENTS.md with instructions for this project', prompt: CODEX_INIT_PROMPT }
    ]
    try {
      const res: Json = await this.rpcRequest('skills/list', { cwds: cwd ? [cwd] : [] }, 15_000)
      const skills: SlashCommand[] = []
      for (const entry of res?.data ?? []) {
        for (const s of entry?.skills ?? []) {
          if (!s?.name || s.enabled === false || typeof s.path !== 'string') continue
          if (skills.some((x) => x.name === s.name)) continue
          skills.push({ name: String(s.name), description: String(s.interface?.shortDescription ?? s.shortDescription ?? s.description ?? ''), kind: 'skill', path: s.path, scope: s.scope })
        }
      }
      return [...builtIn, ...skills]
    } catch {
      return builtIn
    }
  }

  /** The prompt Duet sends for /init. */
  initPrompt(): string {
    return CODEX_INIT_PROMPT
  }

  /** Summarizes a thread's history (`thread/compact/start`), as a turn of its own. */
  async compact(threadId: string, emit: Emit): Promise<void> {
    const st = this.threads.get(threadId)
    if (!st?.codexId || !st.loaded || !this.rpc) throw new Error('Nothing to compact yet — send Codex a message first.')
    if (st.active) throw new Error('Codex is still working on the previous message.')
    st.emit = emit
    st.mapper.emit = emit
    st.turnSeq++
    st.active = true
    st.interrupted = false
    st.interruptSentFor = undefined
    st.turnId = undefined
    st.rootTurnId = undefined
    st.startedAt = Date.now()
    try {
      await this.rpc.request('thread/compact/start', { threadId: st.codexId })
    } catch (error) {
      st.active = false
      throw new Error(friendlyCodexError((error as Error).message, this.rpc?.stderr.value ?? ''))
    }
  }

  /**
   * Runs one question in a throwaway thread that Codex never saves (theme design and the like)
   * and returns the final answer. `outputSchema` makes Codex answer with matching JSON.
   */
  async oneShot(prompt: string, opts: { outputSchema?: unknown; timeoutMs?: number } = {}): Promise<string> {
    const rpc = await this.ensureServer()
    const started: Json = await rpc.request('thread/start', { cwd: homedir(), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', model: null }, 30_000)
    const codexId: string | undefined = started?.thread?.id
    if (!codexId) throw new Error('Codex did not start a thread')
    return new Promise<string>((resolve, reject) => {
      let answer = ''
      const finish = (error?: Error) => {
        clearTimeout(timer)
        this.oneShots.delete(codexId)
        this.rpc?.request('thread/unsubscribe', { threadId: codexId }, 5000).catch(() => undefined)
        if (error) reject(error)
        else resolve(answer)
      }
      const timer = setTimeout(() => finish(new Error('Codex took too long to answer')), opts.timeoutMs ?? 120_000)
      this.oneShots.set(codexId, (method, params) => {
        if (method === 'item/completed' && params?.item?.type === 'agentMessage') answer = String(params.item.text ?? answer)
        else if (method === 'turn/completed') {
          const turn = params?.turn ?? {}
          if (turn.status === 'failed') finish(new Error(turn.error?.message || 'Codex could not answer'))
          else finish()
        }
      })
      rpc
        .request('turn/start', {
          threadId: codexId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          effort: 'low',
          summary: 'none',
          outputSchema: opts.outputSchema ?? null
        })
        .catch((error: Error) => finish(new Error(friendlyCodexError(error.message, rpc.stderr.value))))
    })
  }

  /** Starts ChatGPT sign-in in the browser; `onDone` hears how it ended. */
  async login(onDone: (ok: boolean, message?: string) => void): Promise<string> {
    const rpc = await this.ensureServer()
    const res: Json = await rpc.request('account/login/start', { type: 'chatgpt' }, 30_000)
    if (res?.type !== 'chatgpt' || typeof res.authUrl !== 'string') throw new Error('Codex did not return a sign-in link')
    this.pendingLogin = { id: typeof res.loginId === 'string' ? res.loginId : null, onDone }
    return res.authUrl
  }

  /** Account-wide Codex usage: daily tokens and streaks, straight from OpenAI. */
  async accountUsage(): Promise<{ daily: { day: string; tokens: number }[]; lifetimeTokens?: number; peakDailyTokens?: number; currentStreakDays?: number; longestStreakDays?: number } | null> {
    try {
      const res: Json = await this.rpcRequest('account/usage/read', {}, 20_000)
      const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v))
      return {
        daily: (Array.isArray(res?.dailyUsageBuckets) ? res.dailyUsageBuckets : []).map((b: Json) => ({ day: String(b.startDate).slice(0, 10), tokens: Number(b.tokens ?? 0) })),
        lifetimeTokens: n(res?.summary?.lifetimeTokens),
        peakDailyTokens: n(res?.summary?.peakDailyTokens),
        currentStreakDays: n(res?.summary?.currentStreakDays),
        longestStreakDays: n(res?.summary?.longestStreakDays)
      }
    } catch {
      return null
    }
  }

  async rpcRequest<T = Json>(method: string, params?: Json, timeoutMs?: number): Promise<T> {
    const rpc = await this.ensureServer()
    return rpc.request<T>(method, params, timeoutMs)
  }

  isActive(threadId: string): boolean {
    return !!this.threads.get(threadId)?.active
  }

  release(threadId: string): void {
    const st = this.threads.get(threadId)
    if (st?.interruptTimer) clearTimeout(st.interruptTimer)
    for (const [codexId, duetId] of [...this.byCodex]) {
      if (duetId !== threadId) continue
      this.byCodex.delete(codexId)
      this.released.add(codexId)
    }
    for (const [itemId, pending] of [...this.approvals]) {
      if (pending.duetId !== threadId) continue
      this.answer(pending, { kind: 'deny' }, true)
      this.approvals.delete(itemId)
    }
    if (!st) return
    if (st.codexId) {
      this.released.add(st.codexId)
      if (this.rpc && st.loaded) this.rpc.request('thread/unsubscribe', { threadId: st.codexId }, 5000).catch(() => undefined)
    }
    this.threads.delete(threadId)
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.rpc?.kill()
    this.rpc = null
  }

  /** Apply new connection credentials without placing them in RPC messages or saved config. */
  async resetConnection(): Promise<void> {
    if ([...this.threads.values()].some((st) => st.active)) throw new Error('Stop Codex before changing the routing connection.')
    if (this.starting) await this.starting.catch(() => undefined)
    const rpc = this.rpc
    if (!rpc || rpc.exited) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4000)
      rpc.child.once('exit', () => { clearTimeout(timer); resolve() })
      rpc.kill()
    })
    if (this.rpc === rpc) this.rpc = null
    for (const st of this.threads.values()) st.loaded = false
  }
}

const PLAN_NAMES: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' }

export function prettyPlan(plan: string): string {
  return PLAN_NAMES[plan.toLowerCase()] ?? plan.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function friendlyCodexError(message: string, stderr: string): string {
  const text = `${message}\n${stderr}`
  if (/not logged in|login required|unauthorized|401/i.test(text)) return 'Codex is not signed in. Open a terminal and run `codex login`.'
  if (/ENOENT/.test(text)) return 'Codex could not be started (binary not found). Check the path in Settings → Providers.'
  if (/usage limit|rate limit/i.test(text)) return 'Codex usage limit reached. Switch to Claude to keep going, or wait for the limit to reset.'
  return message.trim() || 'Codex failed.'
}

export { RpcError }
