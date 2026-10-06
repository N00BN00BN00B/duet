import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type {
  ApprovalDecision,
  ApprovalItem,
  DuetEvent,
  NewThreadInput,
  ProviderId,
  RateWindow,
  SendInput,
  Thread,
  ThreadMeta,
  ThreadPatch,
  TimelineItem,
  ToolItem,
  TurnItem
} from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { firstLine, truncate } from '@shared/paths'
import type { Store } from './store'
import { buildHandoff, withHandoff } from './handoff'
import { NativeSessionLostError, type ProviderAdapter, type RuntimeEvent, type TurnRequest } from './providers/types'

const MAX_TOOL_OUTPUT = 256 * 1024
const DELTA_FLUSH_MS = 24

export interface OrchestratorDeps {
  store: Store
  adapters: Record<ProviderId, ProviderAdapter>
  broadcast: (event: DuetEvent) => void
  notify?: (meta: ThreadMeta, kind: 'done' | 'approval' | 'error', text: string) => void
  onLimits?: (provider: ProviderId, limits: RateWindow[]) => void
  onBadge?: (count: number) => void
  /** Optional native context injection (Codex `thread/inject_items`). */
  injectHandoff?: (provider: ProviderId, req: TurnRequest, handoff: string, emit: (e: RuntimeEvent) => void) => Promise<boolean>
  log?: (...args: unknown[]) => void
}

export function makeTitle(text: string): string {
  const line = firstLine(text)
    .replace(/[`*_#>[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return truncate(line || 'New thread', 60)
}

function capOutput(text: string | undefined): string | undefined {
  if (!text || text.length <= MAX_TOOL_OUTPUT) return text
  return `[… ${Math.round((text.length - MAX_TOOL_OUTPUT) / 1024)} KB of earlier output trimmed …]\n` + text.slice(-MAX_TOOL_OUTPUT)
}

interface Run {
  provider: ProviderId
  startedAt: number
  /** The adapter accepted the turn (startTurn resolved). */
  started: boolean
  /** Stop was pressed; honoured as soon as the turn can be interrupted. */
  cancelled: boolean
}

/** Copies an item so the store never shares objects with an adapter that keeps mutating its own copy. */
function cloneItem<T extends TimelineItem>(item: T): T {
  return { ...item }
}

export class Orchestrator {
  private readonly store: Store
  private readonly adapters: Record<ProviderId, ProviderAdapter>
  private running = new Map<string, Run>()
  private pendingDeltas = new Map<string, { threadId: string; itemId: string; field: 'text' | 'output'; delta: string; offset: number }>()
  private deltaTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: OrchestratorDeps) {
    this.store = deps.store
    this.adapters = deps.adapters
  }

  // ---------- queries ----------

  list(): ThreadMeta[] {
    return this.store.listMetas()
  }

  get(id: string): Thread | null {
    // Deltas already applied to the store must reach the renderer before the snapshot does,
    // otherwise they would be applied twice.
    this.flushDeltas()
    return this.store.getThread(id)
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  // ---------- mutations ----------

  private touch(meta: ThreadMeta, broadcast = true): void {
    meta.itemCount = this.store.getItems(meta.id).length
    this.store.putMeta(meta)
    if (broadcast) this.deps.broadcast({ type: 'thread-meta', meta: { ...meta } })
    this.updateBadge()
  }

  private updateBadge(): void {
    if (!this.deps.onBadge) return
    const count = this.store.listMetas().filter((m) => !m.archived && (m.status === 'approval' || m.unread)).length
    this.deps.onBadge(count)
  }

  create(input: NewThreadInput): ThreadMeta {
    const s = this.store.settings
    const provider = input.provider ?? s.defaultProvider
    const now = Date.now()
    const meta: ThreadMeta = {
      id: randomUUID(),
      title: input.title?.trim() || 'New thread',
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
      provider,
      models: { ...s.defaultModels, ...(input.model ? { [provider]: input.model } : {}) },
      efforts: { ...s.defaultEfforts },
      access: s.defaultAccess,
      status: 'idle',
      native: {},
      itemCount: 0
    }
    this.store.setItems(meta.id, [])
    this.touch(meta)
    if (input.cwd && !s.projects.includes(input.cwd)) this.store.updateSettings({ projects: [input.cwd, ...s.projects] })
    return meta
  }

  /** Inserts an already-built thread (history import). */
  insert(meta: ThreadMeta, items: TimelineItem[]): ThreadMeta {
    this.store.setItems(meta.id, items)
    this.touch(meta)
    const s = this.store.settings
    if (meta.cwd && !s.projects.includes(meta.cwd)) this.store.updateSettings({ projects: [meta.cwd, ...s.projects] })
    return meta
  }

  update(id: string, patch: ThreadPatch): ThreadMeta | null {
    const meta = this.store.getMeta(id)
    if (!meta) return null
    const next: ThreadMeta = { ...meta }
    if (patch.title !== undefined) next.title = truncate(patch.title.trim() || meta.title, 120)
    if (patch.provider !== undefined) next.provider = patch.provider
    if (patch.models !== undefined) next.models = { ...meta.models, ...patch.models }
    if (patch.efforts !== undefined) next.efforts = { ...meta.efforts, ...patch.efforts }
    if (patch.pinned !== undefined) next.pinned = patch.pinned
    if (patch.archived !== undefined) next.archived = patch.archived
    if (patch.unread !== undefined) next.unread = patch.unread
    if (patch.access !== undefined && patch.access !== meta.access) {
      next.access = patch.access
      for (const provider of Object.keys(meta.native) as ProviderId[]) {
        void this.adapters[provider].setAccess?.(id, patch.access).catch(() => undefined)
      }
    }
    if (patch.cwd !== undefined && patch.cwd !== meta.cwd) {
      if (this.running.has(id)) throw new Error('Stop the agent before changing the project folder.')
      next.cwd = patch.cwd
      // Native sessions are tied to a folder; start fresh ones (with the transcript as context).
      next.native = {}
      for (const adapter of Object.values(this.adapters)) adapter.release(id)
    }
    this.touch(next)
    return next
  }

  async remove(id: string): Promise<void> {
    if (this.running.has(id)) await this.stop(id).catch(() => undefined)
    for (const adapter of Object.values(this.adapters)) adapter.release(id)
    this.running.delete(id)
    this.store.remove(id)
    this.deps.broadcast({ type: 'thread-removed', id })
    this.updateBadge()
  }

  fork(id: string): ThreadMeta | null {
    const thread = this.store.getThread(id)
    if (!thread) return null
    const now = Date.now()
    const items = (JSON.parse(JSON.stringify(thread.items)) as TimelineItem[])
      .filter((i) => i.kind !== 'approval' || i.status !== 'pending')
      .map((i): TimelineItem => {
        // Nothing keeps running in a fork.
        if ((i.kind === 'assistant' || i.kind === 'reasoning') && i.streaming) return { ...i, streaming: false }
        if (i.kind === 'tool' && i.status === 'running') return { ...i, status: 'error' }
        return i
      })
    const meta: ThreadMeta = {
      ...thread,
      id: randomUUID(),
      title: truncate(`${thread.title} (fork)`, 120),
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      native: {},
      pinned: false,
      archived: false,
      unread: false,
      origin: undefined,
      itemCount: items.length
    }
    delete (meta as Partial<Thread>).items
    this.store.setItems(meta.id, items)
    this.touch(meta)
    return meta
  }

  private push(threadId: string, item: TimelineItem): void {
    const items = this.store.getItems(threadId)
    items.push(item)
    this.store.setItems(threadId, items)
    this.deps.broadcast({ type: 'item', threadId, item })
  }

  async send(id: string, input: SendInput): Promise<void> {
    const meta = this.store.getMeta(id)
    if (!meta) throw new Error('Thread not found')
    if (this.store.isFrozen) throw new Error('Duet is restoring a backup and will restart in a moment.')
    if (this.running.has(id)) throw new Error('The agent is still working. Wait for it to finish or press Stop.')
    const text = input.text.trim()
    if (!text && input.attachments.length === 0) return
    if (meta.cwd && !existsSync(meta.cwd)) throw new Error(`The project folder ${meta.cwd} no longer exists. Restore it, or start a new thread in another folder.`)
    const provider = meta.provider
    const adapter = this.adapters[provider]
    const items = this.store.getItems(id)
    const before = items.slice()

    const lastUser = [...items].reverse().find((i) => i.kind === 'user')
    const previousProvider = lastUser && lastUser.kind === 'user' ? lastUser.provider : (meta.origin?.provider ?? null)
    if (previousProvider && previousProvider !== provider) {
      this.push(id, { kind: 'switch', id: `s-${randomUUID()}`, ts: Date.now(), from: previousProvider, to: provider, model: meta.models[provider] })
    }

    const native = meta.native[provider]
    const handoff = native ? buildHandoff(before, native.syncedTo, provider) : buildHandoff(before, 0, provider, { force: true })

    const userText = text || '(see attached files)'
    this.push(id, { kind: 'user', id: `u-${randomUUID()}`, ts: Date.now(), provider, text: userText, attachments: input.attachments })

    const now = Date.now()
    const next: ThreadMeta = {
      ...meta,
      title: meta.title === 'New thread' ? makeTitle(userText) : meta.title,
      status: 'running',
      updatedAt: now,
      preview: truncate(firstLine(userText), 140),
      unread: false
    }
    this.touch(next)
    const run: Run = { provider, startedAt: now, started: false, cancelled: false }
    this.running.set(id, run)

    const emit = (event: RuntimeEvent) => this.onRuntime(id, provider, event)
    const req: TurnRequest = {
      threadId: id,
      cwd: meta.cwd,
      nativeId: native?.id,
      model: meta.models[provider],
      effort: meta.efforts[provider],
      access: meta.access,
      text: withHandoff(handoff, userText),
      attachments: input.attachments
    }

    try {
      if (handoff && this.deps.injectHandoff) {
        const injected = await this.deps.injectHandoff(provider, { ...req, text: userText }, handoff, emit).catch(() => false)
        if (injected) {
          req.text = userText
          req.nativeId = this.store.getMeta(id)?.native[provider]?.id ?? req.nativeId
        }
      }
      if (run.cancelled) throw new Error('Stopped before the agent started.')
      await adapter.startTurn(req, emit)
      await this.afterStart(id, run)
    } catch (error) {
      if (error instanceof NativeSessionLostError) {
        const current = this.store.getMeta(id)
        if (current) {
          const copy = { ...current, native: { ...current.native } }
          delete copy.native[provider]
          this.touch(copy)
        }
        this.push(id, {
          kind: 'notice',
          id: `n-${randomUUID()}`,
          ts: Date.now(),
          level: 'info',
          provider,
          text: `Couldn’t reopen the earlier ${PROVIDER_LABEL[provider]} session, so Duet started a fresh one with this conversation as context.`
        })
        const full = buildHandoff(before, 0, provider, { force: true })
        try {
          if (run.cancelled) throw new Error('Stopped before the agent started.')
          await adapter.startTurn({ ...req, nativeId: undefined, text: withHandoff(full, userText) }, emit)
          await this.afterStart(id, run)
          return
        } catch (retryError) {
          this.failTurn(id, provider, (retryError as Error).message, run)
          return
        }
      }
      this.failTurn(id, provider, (error as Error).message, run)
    }
  }

  /** Runs once an adapter accepted a turn: honours a Stop that was pressed while it was starting. */
  private async afterStart(id: string, run: Run): Promise<void> {
    run.started = true
    if (run.cancelled && this.running.get(id) === run) {
      await this.adapters[run.provider].interrupt(id).catch(() => undefined)
      this.armStopSafetyNet(id, run)
    }
  }

  private failTurn(id: string, provider: ProviderId, message: string, run?: Run): void {
    // A failure from an older run must never clobber a newer one.
    const current = this.running.get(id)
    const stale = run !== undefined && current !== undefined && current !== run
    if (!stale) this.running.delete(id)
    // Stop pressed while starting: whatever the start then reported, the user asked for this.
    const interrupted = run?.cancelled === true
    this.push(id, {
      kind: 'notice',
      id: `n-${randomUUID()}`,
      ts: Date.now(),
      level: interrupted ? 'info' : 'error',
      provider,
      text: interrupted ? 'Stopped before the agent started.' : message
    })
    const meta = this.store.getMeta(id)
    if (meta && !stale) {
      const next = { ...meta, status: interrupted ? ('idle' as const) : ('error' as const), updatedAt: Date.now() }
      this.touch(next)
      if (!interrupted) this.deps.notify?.(next, 'error', message)
    }
  }

  async stop(id: string): Promise<void> {
    const run = this.running.get(id)
    if (!run) return
    run.cancelled = true
    if (!run.started) {
      // Honoured by afterStart / failTurn once the start settles; cut it short where possible.
      this.adapters[run.provider].cancelStart?.(id)
      return
    }
    await this.adapters[run.provider].interrupt(id)
    this.armStopSafetyNet(id, run)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id).catch(() => undefined)))
  }

  /** If the adapter turns out to have nothing running, end the turn locally so the UI never hangs. */
  private armStopSafetyNet(id: string, run: Run): void {
    setTimeout(() => {
      const still = this.running.get(id)
      if (still === run && run.started && !this.adapters[run.provider].isActive?.(id)) {
        this.onRuntime(id, run.provider, { type: 'turn-end', status: 'interrupted' })
      }
    }, 12_000).unref?.()
  }

  respond(threadId: string, itemId: string, decision: ApprovalDecision): void {
    const items = this.store.getItems(threadId)
    const idx = items.findIndex((i) => i.id === itemId)
    const item = items[idx]
    if (!item || item.kind !== 'approval' || item.status !== 'pending') return
    const ok = this.adapters[item.provider].respond(threadId, itemId, decision)
    const updated: ApprovalItem = {
      ...item,
      status: !ok ? 'expired' : decision.kind === 'deny' ? 'denied' : decision.kind === 'allow-session' ? 'approved-session' : 'approved',
      answers: decision.kind === 'answer' ? decision.answers : item.answers
    }
    items[idx] = updated
    this.store.setItems(threadId, items)
    this.deps.broadcast({ type: 'item', threadId, item: updated })
    this.refreshApprovalStatus(threadId)
  }

  private refreshApprovalStatus(threadId: string): void {
    const meta = this.store.getMeta(threadId)
    if (!meta) return
    const pending = this.store.getItems(threadId).some((i) => i.kind === 'approval' && i.status === 'pending')
    const status = this.running.has(threadId) ? (pending ? 'approval' : 'running') : meta.status === 'approval' ? 'idle' : meta.status
    if (status !== meta.status) this.touch({ ...meta, status })
  }

  // ---------- runtime events ----------

  private queueDelta(threadId: string, itemId: string, field: 'text' | 'output', delta: string, offset: number): void {
    const key = `${threadId}\u0000${itemId}\u0000${field}`
    const existing = this.pendingDeltas.get(key)
    if (existing) existing.delta += delta
    else this.pendingDeltas.set(key, { threadId, itemId, field, delta, offset })
    if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS)
    }
  }

  private flushDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer)
    this.deltaTimer = null
    const batch = [...this.pendingDeltas.values()]
    this.pendingDeltas.clear()
    for (const d of batch) this.deps.broadcast({ type: 'item-delta', ...d })
  }

  /** Drops queued deltas for an item that is about to be replaced wholesale. */
  private dropDeltas(threadId: string, itemId: string): void {
    for (const field of ['text', 'output'] as const) this.pendingDeltas.delete(`${threadId}\u0000${itemId}\u0000${field}`)
  }

  onRuntime(threadId: string, provider: ProviderId, event: RuntimeEvent): void {
    const meta = this.store.getMeta(threadId)
    if (!meta) return
    switch (event.type) {
      case 'native-id': {
        const existing = meta.native[provider]
        if (existing?.id === event.nativeId) return
        // A different native session starts over: nothing seen yet, no cost carried over.
        this.touch({ ...meta, native: { ...meta.native, [provider]: { id: event.nativeId, syncedTo: 0 } } }, false)
        return
      }
      case 'item': {
        const items = this.store.getItems(threadId)
        let item = cloneItem(event.item)
        if (item.kind === 'tool' && item.output) item = { ...item, output: capOutput(item.output) }
        const idx = items.findIndex((i) => i.id === item.id)
        this.dropDeltas(threadId, item.id)
        if (idx >= 0) {
          // Keep the original position/timestamp so items don't jump around.
          items[idx] = { ...item, ts: items[idx].ts } as TimelineItem
        } else items.push(item)
        this.store.setItems(threadId, items)
        this.deps.broadcast({ type: 'item', threadId, item: idx >= 0 ? items[idx] : item })
        if (item.kind === 'approval' && item.status === 'pending') {
          this.touch({ ...meta, status: 'approval' })
          this.deps.notify?.(meta, 'approval', item.title)
        }
        return
      }
      case 'delta': {
        const items = this.store.getItems(threadId)
        const item = items.find((i) => i.id === event.itemId)
        if (!item) return
        let offset: number
        if (event.field === 'text' && (item.kind === 'assistant' || item.kind === 'reasoning')) {
          offset = item.text.length
          item.text += event.delta
        } else if (event.field === 'output' && item.kind === 'tool') {
          offset = item.output?.length ?? 0
          if (offset > MAX_TOOL_OUTPUT) return
          item.output = (item.output ?? '') + event.delta
        } else return
        this.store.markDirty(threadId)
        this.queueDelta(threadId, event.itemId, event.field, event.delta, offset)
        return
      }
      case 'approval-status': {
        const items = this.store.getItems(threadId)
        const idx = items.findIndex((i) => i.id === event.itemId)
        const item = items[idx]
        if (!item || item.kind !== 'approval' || item.status !== 'pending') return
        items[idx] = { ...item, status: event.status }
        this.store.setItems(threadId, items)
        this.deps.broadcast({ type: 'item', threadId, item: items[idx] })
        this.refreshApprovalStatus(threadId)
        return
      }
      case 'context':
        this.touch({ ...meta, context: event.usage })
        return
      case 'limits':
        this.deps.onLimits?.(provider, event.limits)
        return
      case 'access':
        if (meta.access !== event.access) this.touch({ ...meta, access: event.access })
        return
      case 'model':
        return
      case 'turn-end':
        this.finishTurn(threadId, provider, event)
        return
    }
  }

  private finishTurn(threadId: string, provider: ProviderId, event: Extract<RuntimeEvent, { type: 'turn-end' }>): void {
    const run = this.running.get(threadId)
    if (!run) return
    this.flushDeltas()
    this.running.delete(threadId)
    const items = this.store.getItems(threadId)
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      let changed: TimelineItem | null = null
      if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) changed = { ...item, streaming: false }
      else if (item.kind === 'tool' && item.status === 'running') {
        changed = { ...item, status: event.status === 'completed' ? 'done' : 'error', output: capOutput(item.output) } as ToolItem
      } else if (item.kind === 'approval' && item.status === 'pending') changed = { ...item, status: 'expired' }
      if (changed) {
        items[i] = changed
        this.deps.broadcast({ type: 'item', threadId, item: changed })
      }
    }
    const meta = this.store.getMeta(threadId)
    const native = meta?.native[provider]
    // Claude reports a running total per session (resumed sessions continue from their saved
    // total), so a turn costs the difference to the previous total.
    let turnCost = event.costUsd
    let costTotal = native?.costTotal
    if (provider === 'claude' && typeof event.costUsd === 'number' && event.costUsd > 0) {
      const previous = native?.costTotal ?? 0
      turnCost = event.costUsd >= previous ? event.costUsd - previous : event.costUsd
      costTotal = event.costUsd
    }
    const turn: TurnItem = {
      kind: 'turn',
      id: `t-${randomUUID()}`,
      ts: Date.now(),
      provider,
      model: event.model ?? meta?.models[provider],
      status: event.status,
      durationMs: event.durationMs ?? Date.now() - run.startedAt,
      costUsd: turnCost,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens
    }
    items.push(turn)
    this.deps.broadcast({ type: 'item', threadId, item: turn })
    if (event.status === 'failed' && event.error) {
      const notice: TimelineItem = { kind: 'notice', id: `n-${randomUUID()}`, ts: Date.now(), level: 'error', provider, text: event.error }
      items.push(notice)
      this.deps.broadcast({ type: 'item', threadId, item: notice })
    }
    this.store.setItems(threadId, items)
    if (!meta) return
    const next: ThreadMeta = {
      ...meta,
      status: event.status === 'failed' ? 'error' : 'idle',
      updatedAt: Date.now(),
      unread: true,
      costUsd: (meta.costUsd ?? 0) + (turnCost ?? 0) || meta.costUsd,
      native: native ? { ...meta.native, [provider]: { ...native, syncedTo: items.length, ...(costTotal !== undefined ? { costTotal } : {}) } } : meta.native
    }
    const lastAssistant = [...items].reverse().find((i) => i.kind === 'assistant')
    if (lastAssistant && lastAssistant.kind === 'assistant') next.preview = truncate(firstLine(lastAssistant.text), 140)
    this.touch(next)
    this.store.flush()
    if (event.status === 'completed') {
      this.deps.notify?.(next, 'done', next.preview ?? `${PROVIDER_LABEL[provider]} finished`)
    } else if (event.status === 'failed') {
      this.deps.notify?.(next, 'error', event.error ?? `${PROVIDER_LABEL[provider]} stopped with an error`)
    }
  }

  // ---------- export ----------

  exportMarkdown(id: string): string | null {
    const thread = this.store.getThread(id)
    if (!thread) return null
    const out: string[] = [`# ${thread.title}`, '', `Project: \`${thread.cwd}\``, '']
    for (const item of thread.items) {
      switch (item.kind) {
        case 'user':
          out.push(`## You → ${PROVIDER_LABEL[item.provider]}`, '', item.text, ...item.attachments.map((a) => `- 📎 ${a.name} (${a.path})`), '')
          break
        case 'assistant':
          out.push(`## ${PROVIDER_LABEL[item.provider]}${item.model ? ` · ${item.model}` : ''}`, '', item.text, '')
          break
        case 'tool':
          out.push(`> ${item.tool} · ${item.title}${item.status === 'error' ? ' (failed)' : item.status === 'declined' ? ' (declined)' : ''}`, '')
          break
        case 'switch':
          out.push(`---`, '', `*Switched to ${PROVIDER_LABEL[item.to]}${item.model ? ` · ${item.model}` : ''}*`, '')
          break
        case 'notice':
          out.push(`> ${item.level === 'error' ? '⚠️ ' : ''}${item.text}`, '')
          break
        default:
          break
      }
    }
    return out.join('\n')
  }

  async shutdown(): Promise<void> {
    this.flushDeltas()
    this.store.flush()
  }
}
