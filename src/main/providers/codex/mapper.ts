import type { AssistantItem, Attachment, ItemStatus, PlanStep, RateWindow, ReasoningItem, TimelineItem, ToolItem, UserItem } from '@shared/types'
import { unifiedDiff } from '@shared/diff'
import { basename, displayPath, firstLine, truncate } from '@shared/paths'
import type { Emit } from '../types'
import { parseImageDataUrl } from '../../util/toolImages'

/** Upper bound for command output a mapper keeps in memory while it streams. */
const MAX_TRACKED_OUTPUT = 256 * 1024

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

const SHELL_WRAPPER = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/

/** Strips the `/bin/zsh -lc "..."` wrapper Codex puts around commands. */
export function unwrapShell(command: unknown): string {
  const text = Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : ''
  const match = text.trim().match(SHELL_WRAPPER)
  if (!match) return text.trim()
  const inner = match[2]
  return match[1] === '"' ? inner.replace(/\\"/g, '"') : inner
}

/**
 * The Codex app wraps prompts that have attachments in a "# Files mentioned by the user … ## My request:"
 * preamble and escapes some characters as HTML entities. Show only what the user typed.
 */
export function cleanUserText(text: string): string {
  let out = text
  const marker = out.match(/^\s*# Files mentioned by the user:[\s\S]*?\n## My request:\s*\n?/)
  if (marker) out = out.slice(marker[0].length)
  out = out.replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d{1,7});/g, (_, dec) => String.fromCodePoint(Number(dec)))
  return out.trim()
}

export function mapStatus(status: unknown): ItemStatus {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'error'
    case 'declined':
      return 'declined'
    default:
      return 'running'
  }
}

export function codexRateWindows(snapshot: Json): RateWindow[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const out: RateWindow[] = []
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (!window || typeof window.usedPercent !== 'number') continue
    const mins = window.windowDurationMins
    const label =
      typeof mins !== 'number'
        ? 'Usage'
        : Math.abs(mins - 300) <= 1
          ? '5-hour'
          : Math.abs(mins - 10080) <= 1
            ? 'Weekly'
            : mins % 1440 === 0
              ? `${mins / 1440}-day`
              : `${Math.round(mins / 60)}-hour`
    out.push({ label, usedPercent: Math.round(window.usedPercent), resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : undefined })
  }
  return out
}

function normalizeChangeDiff(path: string, kind: Json, diff: string): string {
  const type = kind?.type
  if (diff.startsWith('--- ') || diff.startsWith('diff --git')) return diff.endsWith('\n') ? diff : diff + '\n'
  if (type === 'add') return unifiedDiff('', diff, path)
  if (type === 'delete') return unifiedDiff(diff, '', path)
  const body = diff.endsWith('\n') ? diff : diff + '\n'
  const target = kind?.move_path ? String(kind.move_path) : path
  return `--- a/${path}\n+++ b/${target}\n${body}`
}

export function planSteps(plan: Json): PlanStep[] {
  if (!Array.isArray(plan)) return []
  return plan.map((s) => ({
    text: String(s?.step ?? ''),
    status: s?.status === 'completed' ? 'done' : s?.status === 'inProgress' || s?.status === 'in_progress' ? 'active' : 'pending'
  }))
}

function isImageMime(mime: unknown): boolean {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/')
}

/**
 * Splits an MCP result into its text and its pictures (saved to disk so they show in the
 * conversation). A picture that can't be saved stays visible as "[image]".
 */
function mcpResult(result: Json, save: CodexItemContext['saveImage']): { text: string; images: string[] } {
  const text: string[] = []
  const images: string[] = []
  if (!result || !Array.isArray(result.content)) return { text: '', images }
  for (const c of result.content) {
    if (c?.type === 'text' && typeof c.text === 'string') {
      text.push(c.text)
      continue
    }
    const picture =
      c?.type === 'image' && typeof c.data === 'string'
        ? { data: c.data, mime: c.mimeType ?? 'image/png' }
        : c?.type === 'resource' && isImageMime(c.resource?.mimeType) && typeof c.resource?.blob === 'string'
          ? { data: c.resource.blob, mime: c.resource.mimeType }
          : null
    const saved = picture && save ? save(picture.data, picture.mime) : null
    if (saved) {
      if (!images.includes(saved)) images.push(saved)
    } else if (c?.type === 'resource_link' && typeof c.uri === 'string') text.push(`[${c.name ?? 'resource'}: ${c.uri}]`)
    else if (c?.type) text.push(`[${c.type}]`)
  }
  return { text: text.join('\n'), images }
}

export interface CodexItemContext {
  cwd: string
  home?: string
  now: () => number
  model?: string
  /** Stores a base64 picture a tool returned and gives back its path. */
  saveImage?: (base64: string, mediaType: string) => string | null
}

/** Converts a Codex `ThreadItem` into a Duet timeline item (or null for items Duet doesn't show). */
export function codexItemToTimeline(item: Json, ctx: CodexItemContext, ts?: number): TimelineItem | null {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null
  const id = `x-${item.id}`
  const at = ts ?? ctx.now()
  const rel = (p: string) => displayPath(p, ctx.cwd, ctx.home)
  switch (item.type) {
    case 'userMessage': {
      const content = Array.isArray(item.content) ? item.content : []
      const text = cleanUserText(content.filter((c: Json) => c?.type === 'text').map((c: Json) => c.text ?? '').join('\n'))
      const attachments: Attachment[] = content
        .filter((c: Json) => c?.type === 'localImage' && typeof c.path === 'string')
        .map((c: Json, i: number) => ({ id: `${item.id}-${i}`, name: basename(c.path), mime: 'image/png', path: c.path, size: 0 }))
      const user: UserItem = { kind: 'user', id, ts: at, provider: 'codex', text, attachments }
      return user
    }
    case 'agentMessage': {
      const assistant: AssistantItem = { kind: 'assistant', id, ts: at, provider: 'codex', model: ctx.model, text: String(item.text ?? '') }
      return assistant
    }
    case 'plan': {
      const assistant: AssistantItem = { kind: 'assistant', id, ts: at, provider: 'codex', model: ctx.model, text: String(item.text ?? '') }
      return assistant
    }
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.filter(Boolean).join('\n\n') : ''
      const content = Array.isArray(item.content) ? item.content.filter(Boolean).join('\n\n') : ''
      const text = summary || content
      if (!text.trim()) return null
      const reasoning: ReasoningItem = { kind: 'reasoning', id, ts: at, provider: 'codex', text }
      return reasoning
    }
    case 'commandExecution': {
      const command = unwrapShell(item.command)
      const actions = Array.isArray(item.commandActions) ? item.commandActions : []
      let tool: ToolItem['tool'] = 'command'
      let title = truncate(firstLine(command), 160) || 'Shell command'
      let detail: string | undefined
      if (actions.length === 1) {
        const a = actions[0]
        if (a?.type === 'read') {
          tool = 'read'
          title = rel(String(a.path ?? a.name ?? ''))
          detail = undefined
        } else if (a?.type === 'listFiles') {
          tool = 'read'
          title = rel(String(a.path ?? '.')) || '.'
          detail = 'List files'
        } else if (a?.type === 'search') {
          tool = 'search'
          title = String(a.query ?? '') || 'search'
          detail = a.path ? rel(String(a.path)) : undefined
        }
      }
      const toolItem: ToolItem = {
        kind: 'tool',
        id,
        ts: at,
        provider: 'codex',
        tool,
        name: 'commandExecution',
        title,
        detail,
        input: { command, cwd: item.cwd },
        output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined,
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
        status: mapStatus(item.status),
        durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined
      }
      if (toolItem.status === 'done' && typeof item.exitCode === 'number' && item.exitCode !== 0) toolItem.status = 'error'
      return toolItem
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes.map((c: Json) => rel(String(c?.path ?? '')))
      const diff = changes.map((c: Json) => normalizeChangeDiff(rel(String(c?.path ?? 'file')), c?.kind, String(c?.diff ?? ''))).join('')
      const added = changes.filter((c: Json) => c?.kind?.type === 'add').length
      const toolItem: ToolItem = {
        kind: 'tool',
        id,
        ts: at,
        provider: 'codex',
        tool: added === changes.length && changes.length > 0 ? 'write' : 'edit',
        name: 'fileChange',
        title: paths.length <= 2 ? paths.join(', ') || 'files' : `${paths[0]} and ${paths.length - 1} more`,
        detail: paths.length > 2 ? paths.join('\n') : undefined,
        diff,
        status: mapStatus(item.status)
      }
      return toolItem
    }
    case 'mcpToolCall': {
      const toolItem: ToolItem = {
        kind: 'tool',
        id,
        ts: at,
        provider: 'codex',
        tool: 'mcp',
        name: `mcp__${item.server}__${item.tool}`,
        title: String(item.tool ?? 'tool'),
        detail: String(item.server ?? ''),
        input: item.arguments,
        status: item.error ? 'error' : mapStatus(item.status),
        durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined
      }
      const { text, images } = mcpResult(item.result, ctx.saveImage)
      toolItem.output = item.error?.message ?? text
      if (images.length) toolItem.images = images
      return toolItem
    }
    case 'dynamicToolCall': {
      const toolItem: ToolItem = {
        kind: 'tool',
        id,
        ts: at,
        provider: 'codex',
        tool: 'other',
        name: String(item.tool ?? 'tool'),
        title: String(item.tool ?? 'tool'),
        detail: item.namespace ?? undefined,
        input: item.arguments,
        status: item.success === false ? 'error' : mapStatus(item.status)
      }
      const content: Json[] = Array.isArray(item.contentItems) ? item.contentItems : []
      const text = content.filter((c) => c?.type === 'inputText' && typeof c.text === 'string').map((c) => c.text).join('\n')
      if (text) toolItem.output = text
      // Only inline data is kept: a picture on the web is never fetched behind the user's back.
      const images = content
        .map((c) => (c?.type === 'inputImage' && ctx.saveImage ? parseImageDataUrl(c.imageUrl) : null))
        .map((img) => (img ? ctx.saveImage!(img.data, img.mediaType) : null))
        .filter((p): p is string => !!p)
      if (images.length) toolItem.images = [...new Set(images)]
      return toolItem
    }
    case 'webSearch': {
      const toolItem: ToolItem = { kind: 'tool', id, ts: at, provider: 'codex', tool: 'web', name: 'webSearch', title: String(item.query ?? '') || 'Web search', status: 'done' }
      return toolItem
    }
    case 'imageView': {
      const toolItem: ToolItem = { kind: 'tool', id, ts: at, provider: 'codex', tool: 'image', name: 'imageView', title: rel(String(item.path ?? '')), detail: 'Viewed image', images: item.path ? [String(item.path)] : [], status: 'done' }
      return toolItem
    }
    case 'imageGeneration': {
      const toolItem: ToolItem = {
        kind: 'tool',
        id,
        ts: at,
        provider: 'codex',
        tool: 'image',
        name: 'imageGeneration',
        title: 'Generated an image',
        detail: item.revisedPrompt ?? undefined,
        images: item.savedPath ? [String(item.savedPath)] : [],
        status: item.failure ? 'error' : item.status === 'completed' || item.savedPath ? 'done' : 'running'
      }
      return toolItem
    }
    case 'collabAgentToolCall': {
      const toolItem: ToolItem = {
        kind: 'tool',
        id,
        ts: at,
        provider: 'codex',
        tool: 'agent',
        name: 'collabAgent',
        title: truncate(firstLine(String(item.prompt ?? '')), 120) || String(item.tool ?? 'Subagent'),
        detail: item.model ?? undefined,
        status: mapStatus(item.status)
      }
      return toolItem
    }
    case 'contextCompaction':
      return { kind: 'notice', id, ts: at, level: 'info', provider: 'codex', text: 'Context compacted' }
    case 'enteredReviewMode':
      return { kind: 'notice', id, ts: at, level: 'info', provider: 'codex', text: 'Codex started a code review' }
    case 'exitedReviewMode':
      return { kind: 'notice', id, ts: at, level: 'info', provider: 'codex', text: 'Code review finished' }
    default:
      return null
  }
}

/** Per-thread streaming state for one Codex conversation. */
export class CodexThreadMapper {
  private items = new Map<string, TimelineItem>()
  private reasoningHasSummary = new Set<string>()
  model?: string

  constructor(
    private readonly ctx: Omit<CodexItemContext, 'model'>,
    public emit: Emit
  ) {}

  get(itemId: string): TimelineItem | undefined {
    return this.items.get(`x-${itemId}`)
  }

  private context(): CodexItemContext {
    return { ...this.ctx, model: this.model }
  }

  itemStarted(item: Json): void {
    if (item?.type === 'userMessage') return
    const mapped = codexItemToTimeline(item, this.context())
    if (!mapped) return
    if (mapped.kind === 'tool' && mapped.status === 'done' && item.type !== 'webSearch' && item.type !== 'imageView') mapped.status = 'running'
    if (mapped.kind === 'assistant' || mapped.kind === 'reasoning') {
      mapped.streaming = true
      // Deltas usually start before the text exists; don't emit an empty bubble.
      if (!mapped.text) {
        this.items.set(mapped.id, mapped)
        return
      }
    }
    this.items.set(mapped.id, mapped)
    this.emit({ type: 'item', item: mapped })
  }

  itemCompleted(item: Json): void {
    if (item?.type === 'userMessage') return
    const mapped = codexItemToTimeline(item, this.context())
    const key = `x-${item?.id}`
    const previous = this.items.get(key)
    if (!mapped) {
      if (previous && (previous.kind === 'assistant' || previous.kind === 'reasoning') && previous.text.trim()) {
        const done = { ...previous, streaming: false }
        this.items.set(key, done)
        this.emit({ type: 'item', item: done })
      }
      return
    }
    if (previous) {
      mapped.ts = previous.ts
      if (mapped.kind === 'reasoning' && previous.kind === 'reasoning' && !mapped.text.trim()) mapped.text = previous.text
      if (mapped.kind === 'tool' && previous.kind === 'tool') {
        if (!mapped.output && previous.output) mapped.output = previous.output
        if (mapped.durationMs === undefined) mapped.durationMs = this.ctx.now() - previous.ts
      }
    }
    if ((mapped.kind === 'assistant' || mapped.kind === 'reasoning') && !mapped.text.trim()) return
    if (mapped.kind === 'assistant' || mapped.kind === 'reasoning') mapped.streaming = false
    this.items.set(key, mapped)
    this.emit({ type: 'item', item: mapped })
  }

  textDelta(itemId: string, delta: string, kind: 'assistant' | 'reasoning'): void {
    if (!delta) return
    const key = `x-${itemId}`
    const existing = this.items.get(key)
    if (existing && (existing.kind === 'assistant' || existing.kind === 'reasoning')) {
      const next = { ...existing, text: existing.text + delta }
      this.items.set(key, next)
      if (!existing.text) this.emit({ type: 'item', item: { ...next, streaming: true } })
      else this.emit({ type: 'delta', itemId: key, field: 'text', delta })
      return
    }
    const created: AssistantItem | ReasoningItem =
      kind === 'assistant'
        ? { kind: 'assistant', id: key, ts: this.ctx.now(), provider: 'codex', model: this.model, text: delta, streaming: true }
        : { kind: 'reasoning', id: key, ts: this.ctx.now(), provider: 'codex', text: delta, streaming: true }
    this.items.set(key, created)
    this.emit({ type: 'item', item: created })
  }

  reasoningSummaryDelta(itemId: string, delta: string): void {
    this.reasoningHasSummary.add(itemId)
    this.textDelta(itemId, delta, 'reasoning')
  }

  reasoningSummaryPart(itemId: string): void {
    const existing = this.items.get(`x-${itemId}`)
    if (existing && existing.kind === 'reasoning' && existing.text && !existing.text.endsWith('\n\n')) this.textDelta(itemId, '\n\n', 'reasoning')
  }

  reasoningRawDelta(itemId: string, delta: string): void {
    if (this.reasoningHasSummary.has(itemId)) return
    this.textDelta(itemId, delta, 'reasoning')
  }

  outputDelta(itemId: string, delta: string): void {
    if (!delta) return
    const key = `x-${itemId}`
    const existing = this.items.get(key)
    if (!existing || existing.kind !== 'tool') return
    // Keep only the tail of very chatty commands; the timeline caps what it shows anyway.
    let output = (existing.output ?? '') + delta
    if (output.length > MAX_TRACKED_OUTPUT * 2) output = output.slice(-MAX_TRACKED_OUTPUT)
    this.items.set(key, { ...existing, output })
    this.emit({ type: 'delta', itemId: key, field: 'output', delta })
  }

  plan(turnId: string, explanation: string | null, plan: Json): void {
    const id = `x-plan-${turnId}`
    const existing = this.items.get(id)
    const item: ToolItem = {
      kind: 'tool',
      id,
      ts: existing?.ts ?? this.ctx.now(),
      provider: 'codex',
      tool: 'todo',
      name: 'update_plan',
      title: 'Updated plan',
      detail: explanation ?? undefined,
      steps: planSteps(plan),
      status: 'running'
    }
    this.items.set(id, item)
    this.emit({ type: 'item', item })
  }

  finishTurn(turnId: string): void {
    const plan = this.items.get(`x-plan-${turnId}`)
    if (plan && plan.kind === 'tool' && plan.status === 'running') {
      const done: ToolItem = { ...plan, status: 'done' }
      this.items.set(done.id, done)
      this.emit({ type: 'item', item: done })
    }
  }
}
