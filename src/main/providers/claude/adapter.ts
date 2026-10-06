import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type {
  AccessMode,
  ApprovalDecision,
  ModelOption,
  ProviderStatus,
  RateWindow,
  SlashCommand
} from '@shared/types'
import { unifiedDiff } from '@shared/diff'
import { displayPath } from '@shared/paths'
import { homedir } from 'node:os'
import { LineSplitter, TailBuffer } from '../../util/lines'
import { binaryVersion } from '../../env'
import { NativeSessionLostError, type Emit, type ProviderAdapter, type TurnRequest } from '../types'
import { ClaudeMapper, claudeRateWindows } from './mapper'
import { describeClaudeApproval } from './describe'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

export interface ClaudeDeps {
  binary: () => string | null
  env: () => NodeJS.ProcessEnv
  attachmentsDir: string
  /** Returns base64 image data ready for the Claude API (resized if needed). */
  prepareImage: (path: string, mime: string) => { data: string; mediaType: string } | null
  log?: (...args: unknown[]) => void
}

const IDLE_KILL_MS = 15 * 60 * 1000
const INIT_TIMEOUT_MS = 90_000

export function claudePermissionMode(access: AccessMode): string {
  switch (access) {
    case 'plan':
      return 'plan'
    case 'auto':
      return 'acceptEdits'
    case 'full':
      return 'bypassPermissions'
    default:
      return 'default'
  }
}

interface PendingApproval {
  requestId: string
  toolUseId: string
  toolName: string
  input: Json
  suggestions: Json[]
}

class ClaudeSession {
  child: ChildProcess
  private splitter: LineSplitter
  readonly stderr = new TailBuffer(6000)
  private pending = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  readonly approvals = new Map<string, PendingApproval>()
  readonly mapper: ClaudeMapper
  emit: Emit
  turnActive = false
  exited = false
  exitCode: number | null = null
  idleTimer: NodeJS.Timeout | null = null
  interruptTimer: NodeJS.Timeout | null = null
  initResponse: Json = null
  onExit?: () => void
  onCommands?: (commands: SlashCommand[]) => void
  onLimits?: (limits: RateWindow[]) => void

  constructor(
    bin: string,
    args: string[],
    readonly cwd: string,
    env: NodeJS.ProcessEnv,
    readonly sessionId: string,
    public model: string | undefined,
    readonly effort: string | undefined,
    public permissionMode: string,
    readonly access: AccessMode,
    emit: Emit,
    saveImage: (data: string, mediaType: string) => string | null
  ) {
    this.emit = emit
    this.mapper = new ClaudeMapper({
      cwd,
      emit: (e) => {
        if (e.type === 'limits') this.onLimits?.(e.limits)
        this.emit(e)
      },
      saveImage
    })
    this.child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.splitter = new LineSplitter((line) => this.onLine(line))
    this.child.stdout?.on('data', (chunk) => this.splitter.push(chunk))
    this.child.stderr?.on('data', (chunk) => this.stderr.push(chunk))
    this.child.stdin?.on('error', () => {
      // EPIPE when the process died; handled by the exit listener.
    })
    this.child.on('error', (error) => {
      this.stderr.push(`\n${error.message}`)
      this.handleExit(null)
    })
    this.child.on('exit', (code) => this.handleExit(code))
  }

  private handleExit(code: number | null): void {
    if (this.exited) return
    this.splitter.flush()
    this.exited = true
    this.exitCode = code
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(this.stderr.value.trim() || `Claude exited (code ${code ?? 'unknown'})`))
    }
    this.pending.clear()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.interruptTimer) clearTimeout(this.interruptTimer)
    if (this.turnActive) {
      this.turnActive = false
      const interrupted = this.interruptTimer !== null
      const tail = this.stderr.value.trim().split('\n').slice(-6).join('\n')
      this.emit({
        type: 'turn-end',
        status: interrupted ? 'interrupted' : 'failed',
        error: interrupted ? undefined : tail || `Claude exited unexpectedly (code ${code ?? 'unknown'})`
      })
    }
    this.onExit?.()
  }

  write(message: Json): void {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) throw new Error('Claude process is not running')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  request(request: Json, timeoutMs = 30_000): Promise<Json> {
    const requestId = `duet-${randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Claude did not answer ${request.subtype} in time`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.write({ type: 'control_request', request_id: requestId, request })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error as Error)
      }
    })
  }

  respondControl(requestId: string, response: Json): void {
    try {
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    } catch {
      // Process gone; nothing to answer.
    }
  }

  respondControlError(requestId: string, error: string): void {
    try {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })
    } catch {
      // ignore
    }
  }

  private onLine(line: string): void {
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'control_response') {
      const response = msg.response ?? {}
      const pending = this.pending.get(response.request_id)
      if (!pending) return
      this.pending.delete(response.request_id)
      clearTimeout(pending.timer)
      if (response.subtype === 'error') pending.reject(new Error(response.error || 'Claude control request failed'))
      else pending.resolve(response.response ?? {})
      return
    }
    if (msg.type === 'control_request') {
      this.onControlRequest(msg)
      return
    }
    if (msg.type === 'control_cancel_request') {
      for (const [itemId, approval] of this.approvals) {
        if (approval.requestId === msg.request_id) {
          this.approvals.delete(itemId)
          this.emit({ type: 'approval-status', itemId, status: 'expired' })
        }
      }
      return
    }
    if (msg.type === 'system' && msg.subtype === 'commands_changed' && Array.isArray(msg.commands)) {
      this.onCommands?.(toCommands(msg.commands))
      return
    }
    if (msg.type === 'rate_limit_event' || this.turnActive) this.mapper.handle(msg)
    if (msg.type === 'result') {
      this.turnActive = false
      if (this.interruptTimer) {
        clearTimeout(this.interruptTimer)
        this.interruptTimer = null
      }
      this.armIdle()
    }
  }

  private onControlRequest(msg: Json): void {
    const req = msg.request ?? {}
    if (req.subtype === 'can_use_tool') {
      const itemId = `c-approval-${msg.request_id}`
      const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : []
      const shape = describeClaudeApproval(req.tool_name, req.input, this.cwd, {
        title: req.title,
        description: req.description,
        displayName: req.display_name,
        hasSuggestions: suggestions.length > 0 || req.tool_name !== 'Bash',
        decisionReason: req.decision_reason,
        blockedPath: req.blocked_path
      })
      if (req.tool_name === 'Write' && typeof req.input?.file_path === 'string') {
        const file = isAbsolute(req.input.file_path) ? req.input.file_path : join(this.cwd, req.input.file_path)
        try {
          if (existsSync(file)) {
            const before = readFileSync(file, 'utf8')
            shape.diff = unifiedDiff(before, String(req.input.content ?? ''), displayPath(file, this.cwd, homedir()))
          }
        } catch {
          // Keep the "all new" diff.
        }
      }
      this.approvals.set(itemId, { requestId: msg.request_id, toolUseId: req.tool_use_id, toolName: req.tool_name, input: req.input ?? {}, suggestions })
      this.emit({ type: 'item', item: { kind: 'approval', id: itemId, ts: Date.now(), provider: 'claude', status: 'pending', ...shape } })
      return
    }
    if (req.subtype === 'elicitation') {
      this.respondControl(msg.request_id, { action: 'decline' })
      return
    }
    this.respondControlError(msg.request_id, `Duet does not handle "${req.subtype}" requests`)
  }

  armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.turnActive) this.kill()
    }, IDLE_KILL_MS)
  }

  kill(): void {
    if (this.exited) return
    try {
      this.child.stdin?.end()
    } catch {
      // ignore
    }
    this.child.kill('SIGTERM')
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 3000).unref?.()
  }
}

function toCommands(list: Json[]): SlashCommand[] {
  return list
    .filter((c) => c && typeof c.name === 'string')
    .map((c) => ({ name: c.name, description: typeof c.description === 'string' ? c.description : '', argumentHint: c.argumentHint || undefined }))
}

function toModels(list: Json[]): ModelOption[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((m) => m && typeof m.value === 'string')
    .map((m) => ({
      id: m.value,
      label: m.value === 'default' ? 'Default' : m.displayName || m.value,
      description: m.description || undefined,
      efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : undefined,
      isDefault: m.value === 'default',
      supportsImages: true
    }))
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const
  private sessions = new Map<string, ClaudeSession>()
  private commandsCache: SlashCommand[] = []
  private statusCache: ProviderStatus | null = null
  private limits: RateWindow[] = []
  private statusPromise: Promise<ProviderStatus> | null = null

  constructor(private readonly deps: ClaudeDeps) {}

  private saveImage = (data: string, mediaType: string): string | null => {
    try {
      const ext = mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
      const path = join(this.deps.attachmentsDir, `tool-${randomUUID()}.${ext}`)
      writeFileSync(path, Buffer.from(data, 'base64'))
      return path
    } catch {
      return null
    }
  }

  private spawnSession(req: TurnRequest, emit: Emit): ClaudeSession {
    const bin = this.deps.binary()
    if (!bin) throw new Error('Claude Code is not installed. Install it from https://claude.com/claude-code or set its path in Settings → Providers.')
    const mode = claudePermissionMode(req.access)
    const resume = !!req.nativeId
    const sessionId = req.nativeId ?? randomUUID()
    const args = [
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      mode
    ]
    if (mode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions')
    if (req.model && req.model !== 'default') args.push('--model', req.model)
    if (req.effort) args.push('--effort', req.effort)
    if (resume) args.push('--resume', sessionId)
    else args.push('--session-id', sessionId)
    this.deps.log?.('[claude] spawn', bin, args.join(' '), 'cwd', req.cwd)
    const session = new ClaudeSession(bin, args, req.cwd, this.deps.env(), sessionId, req.model, req.effort, mode, req.access, emit, this.saveImage)
    session.onCommands = (commands) => {
      if (commands.length) this.commandsCache = commands
    }
    session.onLimits = (limits) => this.setLimits(limits)
    session.onExit = () => {
      if (this.sessions.get(req.threadId) === session) this.sessions.delete(req.threadId)
    }
    return session
  }

  private setLimits(limits: RateWindow[]): void {
    const merged = new Map(this.limits.map((l) => [l.label, l]))
    for (const l of limits) merged.set(l.label, l)
    this.limits = [...merged.values()]
    if (this.statusCache) this.statusCache = { ...this.statusCache, limits: this.limits }
  }

  getLimits(): RateWindow[] {
    return this.limits
  }

  async startTurn(req: TurnRequest, emit: Emit): Promise<void> {
    let session = this.sessions.get(req.threadId)
    if (session && !session.exited && session.turnActive) throw new Error('Claude is still working on the previous message.')
    const reusable =
      session &&
      !session.exited &&
      session.cwd === req.cwd &&
      session.effort === req.effort &&
      (req.nativeId === undefined || req.nativeId === session.sessionId) &&
      // Bypass mode needs a launch flag, so switching into/out of it needs a fresh process.
      (session.permissionMode === 'bypassPermissions') === (req.access === 'full')
    if (session && !reusable) {
      session.kill()
      this.sessions.delete(req.threadId)
      session = undefined
    }
    if (!session) {
      session = this.spawnSession(req, emit)
      this.sessions.set(req.threadId, session)
      try {
        session.initResponse = await session.request({ subtype: 'initialize' }, INIT_TIMEOUT_MS)
        const commands = toCommands(session.initResponse?.commands ?? [])
        if (commands.length) this.commandsCache = commands
        this.mergeStatusFromInit(session.initResponse)
      } catch (error) {
        const message = (error as Error).message
        session.kill()
        this.sessions.delete(req.threadId)
        if (req.nativeId && /no conversation found|not found|does not exist|invalid session/i.test(message + session.stderr.value)) {
          throw new NativeSessionLostError(`Claude session ${req.nativeId} can no longer be resumed`)
        }
        throw new Error(friendlyClaudeError(message, session.stderr.value))
      }
    }
    session.emit = emit
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    const wantModel = req.model && req.model !== 'default' ? req.model : undefined
    if (wantModel !== (session.model && session.model !== 'default' ? session.model : undefined)) {
      try {
        await session.request({ subtype: 'set_model', model: wantModel ?? null })
        session.model = req.model
      } catch (error) {
        this.deps.log?.('[claude] set_model failed', (error as Error).message)
      }
    }
    const mode = claudePermissionMode(req.access)
    if (mode !== session.permissionMode) {
      try {
        await session.request({ subtype: 'set_permission_mode', mode })
        session.permissionMode = mode
      } catch (error) {
        this.deps.log?.('[claude] set_permission_mode failed', (error as Error).message)
      }
    }
    // Make sure the thread knows the native id even before Claude's init message arrives.
    emit({ type: 'native-id', nativeId: session.sessionId })
    const content: Json[] = []
    const pathLines: string[] = []
    for (const att of req.attachments) {
      if (att.mime.startsWith('image/')) {
        const image = this.deps.prepareImage(att.path, att.mime)
        if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })
        pathLines.push(`[Attached image "${att.name}" is saved at: ${att.path}]`)
      } else {
        pathLines.push(`[Attached file "${att.name}" is saved at: ${att.path}]`)
      }
    }
    const text = pathLines.length ? `${req.text}\n\n${pathLines.join('\n')}` : req.text
    content.push({ type: 'text', text })
    session.mapper.beginTurn()
    session.turnActive = true
    try {
      session.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: session.sessionId })
    } catch (error) {
      session.turnActive = false
      throw error
    }
  }

  private mergeStatusFromInit(init: Json): void {
    if (!init || typeof init !== 'object') return
    const models = toModels(init.models ?? [])
    const account = init.account ?? {}
    const base: ProviderStatus = this.statusCache ?? { id: 'claude', installed: true, models: [], limits: this.limits }
    this.statusCache = {
      ...base,
      installed: true,
      loggedIn: !!(account.email || account.apiKeySource || (account.tokenSource && account.tokenSource !== 'none')),
      account: account.email || account.organization || undefined,
      plan: account.subscriptionType || (account.apiKeySource ? 'API key' : undefined),
      models: models.length ? models : base.models,
      limits: this.limits,
      checkedAt: Date.now()
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session || !session.turnActive) return
    session.mapper.markInterrupted()
    for (const [itemId, approval] of session.approvals) {
      session.respondControl(approval.requestId, { behavior: 'deny', message: 'Interrupted by the user.', interrupt: true, toolUseID: approval.toolUseId })
      session.approvals.delete(itemId)
    }
    session.interruptTimer = setTimeout(() => {
      // Claude didn't wind down on its own; stop the process. The exit handler ends the turn.
      if (session.turnActive) session.kill()
    }, 8000)
    try {
      await session.request({ subtype: 'interrupt' }, 6000)
    } catch {
      // The timer above takes care of a stuck process.
    }
  }

  respond(threadId: string, itemId: string, decision: ApprovalDecision): boolean {
    const session = this.sessions.get(threadId)
    const pending = session?.approvals.get(itemId)
    if (!session || !pending) return false
    session.approvals.delete(itemId)
    const base = { toolUseID: pending.toolUseId }
    if (pending.toolName === 'ExitPlanMode') {
      if (decision.kind === 'deny') {
        session.respondControl(pending.requestId, { behavior: 'deny', message: decision.message || 'The user wants to keep planning. Ask what to change, then refine the plan.', ...base })
      } else {
        const mode = decision.kind === 'allow-session' ? 'acceptEdits' : 'default'
        session.respondControl(pending.requestId, {
          behavior: 'allow',
          updatedInput: pending.input,
          updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
          ...base
        })
        session.permissionMode = mode
        session.emit({ type: 'access', access: mode === 'acceptEdits' ? 'auto' : 'ask' })
      }
      return true
    }
    switch (decision.kind) {
      case 'allow':
        session.respondControl(pending.requestId, { behavior: 'allow', updatedInput: pending.input, ...base })
        break
      case 'allow-session':
        session.respondControl(pending.requestId, {
          behavior: 'allow',
          updatedInput: pending.input,
          updatedPermissions: pending.suggestions.length
            ? pending.suggestions.map((s: Json) => ({ ...s, destination: 'session' }))
            : [{ type: 'addRules', rules: [{ toolName: pending.toolName }], behavior: 'allow', destination: 'session' }],
          ...base
        })
        break
      case 'answer': {
        // Multi-select answers arrive joined with U+001F; Claude expects "a, b".
        const answers = Object.fromEntries(Object.entries(decision.answers).map(([q, a]) => [q, a.split('\u001f').join(', ')]))
        session.respondControl(pending.requestId, { behavior: 'allow', updatedInput: { ...pending.input, answers }, ...base })
        break
      }
      case 'deny':
        session.mapper.markDeclined(pending.toolUseId)
        session.respondControl(pending.requestId, { behavior: 'deny', message: decision.message || 'The user declined this action.', ...base })
        break
    }
    return true
  }

  async setAccess(threadId: string, access: AccessMode): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session || session.exited) return
    const mode = claudePermissionMode(access)
    if (mode === session.permissionMode) return
    if (mode === 'bypassPermissions' || session.permissionMode === 'bypassPermissions') return // applied on next spawn
    try {
      await session.request({ subtype: 'set_permission_mode', mode })
      session.permissionMode = mode
    } catch {
      // Applied on the next turn instead.
    }
  }

  async commands(cwd: string): Promise<SlashCommand[]> {
    if (this.commandsCache.length) return this.commandsCache
    await this.probe(cwd).catch(() => undefined)
    return this.commandsCache
  }

  /** Starts Claude just long enough to read account, models and commands. Costs no tokens. */
  private async probe(cwd: string): Promise<void> {
    const bin = this.deps.binary()
    if (!bin) return
    const env = { ...this.deps.env(), ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_AUTO_CONNECT_IDE: '0' }
    const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
    const noop: Emit = () => undefined
    const session = new ClaudeSession(bin, args, existsSync(cwd) ? cwd : homedir(), env, randomUUID(), undefined, undefined, 'default', 'ask', noop, () => null)
    try {
      const init = await session.request({ subtype: 'initialize' }, 60_000)
      const commands = toCommands(init?.commands ?? [])
      if (commands.length) this.commandsCache = commands
      this.mergeStatusFromInit(init)
      try {
        const usage = await session.request({ subtype: 'get_usage', skip_behaviors: true }, 15_000)
        const limits = usageToLimits(usage)
        if (limits.length) this.setLimits(limits)
      } catch {
        // Older Claude versions don't support get_usage.
      }
    } finally {
      session.kill()
    }
  }

  async status(force = false): Promise<ProviderStatus> {
    if (this.statusCache && !force && Date.now() - (this.statusCache.checkedAt ?? 0) < 5 * 60_000) return this.statusCache
    if (this.statusPromise) return this.statusPromise
    this.statusPromise = (async () => {
      const bin = this.deps.binary()
      if (!bin) {
        this.statusCache = { id: 'claude', installed: false, models: [], limits: [], checkedAt: Date.now(), error: 'Claude Code CLI not found' }
        return this.statusCache
      }
      const version = await binaryVersion(bin)
      this.statusCache = { ...(this.statusCache ?? { id: 'claude', models: [], limits: [] }), id: 'claude', installed: true, binaryPath: bin, version, error: undefined }
      try {
        await this.probe(homedir())
      } catch (error) {
        this.statusCache = { ...this.statusCache, error: friendlyClaudeError((error as Error).message, '') }
      }
      this.statusCache = { ...this.statusCache, limits: this.limits, checkedAt: Date.now() }
      return this.statusCache
    })().finally(() => {
      this.statusPromise = null
    })
    return this.statusPromise
  }

  release(threadId: string): void {
    const session = this.sessions.get(threadId)
    if (session) {
      session.kill()
      this.sessions.delete(threadId)
    }
  }

  isActive(threadId: string): boolean {
    return !!this.sessions.get(threadId)?.turnActive
  }

  mcpStatus(): { name: string; status: string }[] {
    for (const session of this.sessions.values()) {
      if (session.mapper.mcpServers.length) return session.mapper.mcpServers
    }
    return []
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) session.kill()
    this.sessions.clear()
  }
}

export function usageToLimits(usage: Json): RateWindow[] {
  const limits: RateWindow[] = []
  const rl = usage?.rate_limits
  if (!rl || typeof rl !== 'object') return limits
  const add = (key: string, label: string) => {
    const w = rl[key]
    if (!w || typeof w.utilization !== 'number') return
    const pct = w.utilization > 1 ? w.utilization : w.utilization * 100
    const reset = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : typeof w.resets_at === 'number' ? w.resets_at * (w.resets_at < 1e12 ? 1000 : 1) : undefined
    limits.push({ label, usedPercent: Math.round(Math.max(0, Math.min(100, pct))), resetsAt: Number.isFinite(reset) ? reset : undefined })
  }
  add('five_hour', '5-hour')
  add('seven_day', 'Weekly')
  add('seven_day_opus', 'Weekly (Opus)')
  add('seven_day_sonnet', 'Weekly (Sonnet)')
  return limits
}

export function friendlyClaudeError(message: string, stderr: string): string {
  const text = `${message}\n${stderr}`
  if (/not logged in|please run .*login|invalid api key|authentication/i.test(text)) return 'Claude Code is not signed in. Open a terminal, run `claude`, and log in.'
  if (/ENOENT/.test(text)) return 'Claude Code could not be started (binary not found). Check the path in Settings → Providers.'
  const line = text.trim().split('\n').filter(Boolean).slice(-3).join(' ')
  return line || 'Claude Code failed to start.'
}

export { claudeRateWindows }
