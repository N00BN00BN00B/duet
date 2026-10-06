import type { AssistantItem, RateWindow, ReasoningItem, ToolItem } from '@shared/types'
import { structuredPatchToDiff, unifiedDiff } from '@shared/diff'
import { displayPath } from '@shared/paths'
import { homedir } from 'node:os'
import type { Emit, TurnEndStatus } from '../types'
import { describeClaudeTool } from './describe'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

interface BlockState {
  itemId: string
  kind: 'text' | 'thinking' | 'tool_use'
  text: string
  created: boolean
  toolUseId?: string
  name?: string
  json: string
}

export interface ClaudeMapperOptions {
  cwd: string
  emit: Emit
  now?: () => number
  /** Stores a base64 image produced by a tool and returns its path (optional). */
  saveImage?: (base64: string, mediaType: string) => string | null
}

const RATE_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_overage_included: 'Weekly',
  overage: 'Extra usage'
}

export function claudeRateWindows(info: Json): RateWindow[] {
  if (!info || typeof info !== 'object') return []
  const out: RateWindow[] = []
  const windows = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : null
  if (windows) {
    for (const [key, value] of Object.entries<Json>(windows)) {
      if (!value || typeof value.utilization !== 'number') continue
      out.push({
        label: RATE_LABELS[key] ?? key,
        usedPercent: Math.round(Math.max(0, Math.min(1, value.utilization)) * 100),
        resetsAt: typeof value.resetsAt === 'number' ? value.resetsAt * 1000 : undefined
      })
    }
  } else if (typeof info.utilization === 'number' && info.rateLimitType) {
    out.push({
      label: RATE_LABELS[info.rateLimitType] ?? info.rateLimitType,
      usedPercent: Math.round(Math.max(0, Math.min(1, info.utilization)) * 100),
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : undefined
    })
  }
  return out
}

function textOfToolResult(content: Json): { text: string; images: { data: string; mediaType: string }[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  const images: { data: string; mediaType: string }[] = []
  if (!Array.isArray(content)) return { text: '', images }
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') {
      images.push({ data: block.source.data, mediaType: block.source.media_type ?? 'image/png' })
    }
  }
  return { text: parts.join('\n'), images }
}

/**
 * Turns Claude Code stream-json messages into Duet timeline events.
 * Pure: no process or file-system access besides the optional `saveImage` hook.
 */
export class ClaudeMapper {
  private readonly cwd: string
  private readonly emit: Emit
  private readonly now: () => number
  private readonly saveImage?: ClaudeMapperOptions['saveImage']
  private blocks = new Map<string, BlockState>()
  private blockCounts = new Map<string, number>()
  private currentMessageId = ''
  private tools = new Map<string, ToolItem>()
  private texts = new Map<string, AssistantItem | ReasoningItem>()
  private declined = new Set<string>()
  private subagentCounts = new Map<string, number>()
  private contextWindow?: number
  private interrupted = false
  /** A local command already showed its output this turn. */
  private localOutput = false
  model?: string
  sessionId?: string
  mcpServers: { name: string; status: string }[] = []

  constructor(opts: ClaudeMapperOptions) {
    this.cwd = opts.cwd
    this.emit = opts.emit
    this.now = opts.now ?? Date.now
    this.saveImage = opts.saveImage
  }

  beginTurn(): void {
    this.blocks.clear()
    this.blockCounts.clear()
    this.currentMessageId = ''
    this.interrupted = false
    this.localOutput = false
  }

  markInterrupted(): void {
    this.interrupted = true
  }

  markDeclined(toolUseId: string): void {
    this.declined.add(toolUseId)
  }

  handle(msg: Json): void {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'system':
        this.handleSystem(msg)
        break
      case 'stream_event':
        if (!msg.parent_tool_use_id) this.handleStream(msg.event)
        break
      case 'assistant':
        if (msg.parent_tool_use_id) this.handleSubagentAssistant(msg)
        else this.handleAssistant(msg)
        break
      case 'user':
        if (!msg.parent_tool_use_id) this.handleUser(msg)
        break
      case 'result':
        this.handleResult(msg)
        break
      case 'rate_limit_event': {
        const limits = claudeRateWindows(msg.rate_limit_info)
        if (limits.length) this.emit({ type: 'limits', limits })
        if (msg.rate_limit_info?.status === 'rejected') {
          this.emit({
            type: 'item',
            item: { kind: 'notice', id: `c-limit-${this.now()}`, ts: this.now(), level: 'warn', provider: 'claude', text: 'Claude usage limit reached. Switch to Codex to keep going, or wait for the limit to reset.' }
          })
        }
        break
      }
      default:
        break
    }
  }

  private handleSystem(msg: Json): void {
    if (msg.subtype === 'init') {
      if (typeof msg.session_id === 'string' && msg.session_id) {
        this.sessionId = msg.session_id
        this.emit({ type: 'native-id', nativeId: msg.session_id })
      }
      if (typeof msg.model === 'string') {
        this.model = msg.model
        this.emit({ type: 'model', model: msg.model })
      }
      if (Array.isArray(msg.mcp_servers)) this.mcpServers = msg.mcp_servers
    } else if (msg.subtype === 'compact_boundary') {
      const pre = msg.compact_metadata?.pre_tokens
      this.emit({
        type: 'item',
        item: { kind: 'notice', id: `c-compact-${msg.uuid ?? this.now()}`, ts: this.now(), level: 'info', provider: 'claude', text: pre ? `Context compacted (${Math.round(pre / 1000)}k tokens summarized)` : 'Context compacted' }
      })
    } else if (msg.subtype === 'local_command_output' && typeof msg.content === 'string' && msg.content.trim()) {
      // Output of a command Claude runs itself (/context, /usage, /output-style…).
      this.localOutput = true
      this.emit({ type: 'item', item: { kind: 'assistant', id: `c-local-${msg.uuid ?? this.now()}`, ts: this.now(), provider: 'claude', text: msg.content.trim() } })
    } else if (msg.subtype === 'api_retry' && typeof msg.attempt === 'number' && msg.attempt >= 2) {
      this.emit({
        type: 'item',
        item: { kind: 'notice', id: `c-retry-${msg.uuid ?? this.now()}`, ts: this.now(), level: 'warn', provider: 'claude', text: `Claude API hiccup — retrying (attempt ${msg.attempt}${msg.max_retries ? ` of ${msg.max_retries}` : ''})` }
      })
    }
  }

  private blockKey(messageId: string, index: number): string {
    return `${messageId}:${index}`
  }

  private handleStream(event: Json): void {
    if (!event || typeof event !== 'object') return
    switch (event.type) {
      case 'message_start': {
        this.currentMessageId = event.message?.id ?? `m${this.now()}`
        if (typeof event.message?.model === 'string') this.model = event.message.model
        break
      }
      case 'content_block_start': {
        const block = event.content_block ?? {}
        const key = this.blockKey(this.currentMessageId, event.index)
        const itemId = `c-${this.currentMessageId}-${event.index}`
        if (block.type === 'text') {
          const state: BlockState = { itemId, kind: 'text', text: block.text ?? '', created: false, json: '' }
          this.blocks.set(key, state)
          if (state.text) this.upsertText(state, true)
        } else if (block.type === 'thinking') {
          const state: BlockState = { itemId, kind: 'thinking', text: block.thinking ?? '', created: false, json: '' }
          this.blocks.set(key, state)
          if (state.text) this.upsertText(state, true)
        } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
          const state: BlockState = { itemId: `c-tool-${block.id}`, kind: 'tool_use', text: '', created: true, toolUseId: block.id, name: block.name, json: '' }
          this.blocks.set(key, state)
          this.startTool(block.id, block.name, block.input && Object.keys(block.input).length ? block.input : undefined)
        }
        break
      }
      case 'content_block_delta': {
        const state = this.blocks.get(this.blockKey(this.currentMessageId, event.index))
        if (!state) break
        const delta = event.delta ?? {}
        if (delta.type === 'text_delta' && state.kind === 'text') this.appendText(state, delta.text ?? '')
        else if (delta.type === 'thinking_delta' && state.kind === 'thinking') this.appendText(state, delta.thinking ?? '')
        else if (delta.type === 'input_json_delta' && state.kind === 'tool_use') state.json += delta.partial_json ?? ''
        break
      }
      case 'content_block_stop': {
        const state = this.blocks.get(this.blockKey(this.currentMessageId, event.index))
        if (!state) break
        if (state.kind === 'tool_use' && state.toolUseId && state.json) {
          try {
            this.startTool(state.toolUseId, state.name ?? 'tool', JSON.parse(state.json))
          } catch {
            // Final input arrives with the assistant snapshot anyway.
          }
        } else if (state.kind !== 'tool_use' && state.created) {
          this.upsertText(state, false)
        }
        break
      }
      case 'message_delta':
        break
      default:
        break
    }
  }

  private appendText(state: BlockState, delta: string): void {
    if (!delta) return
    state.text += delta
    if (!state.created) {
      this.upsertText(state, true)
      return
    }
    this.emit({ type: 'delta', itemId: state.itemId, field: 'text', delta })
  }

  private upsertText(state: BlockState, streaming: boolean): void {
    if (!state.text.trim()) return
    const existing = this.texts.get(state.itemId)
    const item: AssistantItem | ReasoningItem =
      state.kind === 'thinking'
        ? { kind: 'reasoning', id: state.itemId, ts: existing?.ts ?? this.now(), provider: 'claude', text: state.text, streaming }
        : { kind: 'assistant', id: state.itemId, ts: existing?.ts ?? this.now(), provider: 'claude', model: this.model, text: state.text, streaming }
    state.created = true
    this.texts.set(state.itemId, item)
    this.emit({ type: 'item', item })
  }

  private startTool(toolUseId: string, name: string, input: unknown): void {
    const existing = this.tools.get(toolUseId)
    const desc = describeClaudeTool(name, input ?? existing?.input ?? {}, this.cwd)
    const item: ToolItem = {
      kind: 'tool',
      id: `c-tool-${toolUseId}`,
      ts: existing?.ts ?? this.now(),
      provider: 'claude',
      tool: desc.tool,
      name,
      title: input === undefined && existing ? existing.title : desc.title,
      detail: desc.detail ?? existing?.detail,
      input: input ?? existing?.input,
      diff: existing?.diff ?? desc.diff,
      steps: desc.steps ?? existing?.steps,
      output: existing?.output,
      status: existing?.status ?? 'running',
      images: existing?.images
    }
    // Prefer the description computed from the full input over the streamed placeholder.
    if (input !== undefined) {
      item.title = desc.title
      if (desc.diff !== undefined && existing?.status !== 'done') item.diff = desc.diff
    }
    this.tools.set(toolUseId, item)
    this.emit({ type: 'item', item })
  }

  private handleAssistant(msg: Json): void {
    const message = msg.message ?? {}
    const messageId: string = message.id ?? msg.uuid ?? `m${this.now()}`
    if (typeof message.model === 'string' && message.model !== '<synthetic>') this.model = message.model
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      const index = this.blockCounts.get(messageId) ?? 0
      this.blockCounts.set(messageId, index + 1)
      if (!block || typeof block !== 'object') continue
      const key = this.blockKey(messageId, index)
      const itemId = `c-${messageId}-${index}`
      if (block.type === 'text' || block.type === 'thinking') {
        const text = block.type === 'text' ? (block.text ?? '') : (block.thinking ?? '')
        const state = this.blocks.get(key) ?? { itemId, kind: block.type === 'text' ? 'text' : 'thinking', text: '', created: false, json: '' }
        state.text = text
        this.blocks.set(key, state)
        this.upsertText(state, false)
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        this.startTool(block.id, block.name, block.input ?? {})
      }
    }
    if (msg.error === 'rate_limit' || msg.error === 'authentication_failed' || msg.error === 'billing_error') {
      const text =
        msg.error === 'authentication_failed'
          ? 'Claude is not signed in. Run `claude` in a terminal and log in, then try again.'
          : msg.error === 'billing_error'
            ? 'Claude reported a billing problem with this account.'
            : 'Claude is rate limited right now.'
      this.emit({ type: 'item', item: { kind: 'notice', id: `c-err-${messageId}`, ts: this.now(), level: 'error', provider: 'claude', text } })
    }
    const usage = message.usage
    if (usage && typeof usage === 'object') {
      const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0)
      if (used > 0) this.emit({ type: 'context', usage: { usedTokens: used, windowTokens: this.contextWindow } })
    }
  }

  private handleSubagentAssistant(msg: Json): void {
    const parentId: string = msg.parent_tool_use_id
    const parent = this.tools.get(parentId)
    if (!parent) return
    const content = Array.isArray(msg.message?.content) ? msg.message.content : []
    const calls = content.filter((b: Json) => b?.type === 'tool_use').length
    if (!calls) return
    const count = (this.subagentCounts.get(parentId) ?? 0) + calls
    this.subagentCounts.set(parentId, count)
    const base = describeClaudeTool(parent.name, parent.input, this.cwd).detail
    const item: ToolItem = { ...parent, detail: `${base ? base + ' · ' : ''}${count} tool call${count === 1 ? '' : 's'}` }
    this.tools.set(parentId, item)
    this.emit({ type: 'item', item })
  }

  private handleUser(msg: Json): void {
    const content = Array.isArray(msg.message?.content) ? msg.message.content : []
    const structured = msg.tool_use_result
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      const toolUseId: string = block.tool_use_id
      const existing = this.tools.get(toolUseId)
      if (!existing) continue
      const { text, images } = textOfToolResult(block.content)
      const item: ToolItem = { ...existing }
      const savedImages = images.map((img) => this.saveImage?.(img.data, img.mediaType) ?? null).filter((p): p is string => !!p)
      if (savedImages.length) item.images = [...(existing.images ?? []), ...savedImages]
      let output = text
      if (structured && typeof structured === 'object' && content.length === 1) {
        if (typeof structured.stdout === 'string' || typeof structured.stderr === 'string') {
          output = [structured.stdout, structured.stderr].filter((s: unknown) => typeof s === 'string' && s.length > 0).join('\n') || text
        }
        const filePath: string | undefined = structured.filePath ?? structured.file?.filePath
        const shown = filePath ? displayPath(filePath, this.cwd, homedir()) : existing.title
        if (Array.isArray(structured.structuredPatch) && structured.structuredPatch.length) {
          item.diff = structuredPatchToDiff(shown, structured.structuredPatch)
        } else if (structured.type === 'create' && typeof structured.content === 'string') {
          item.diff = unifiedDiff('', structured.content, shown)
        }
        if (existing.tool === 'read' && structured.file && typeof structured.file.numLines === 'number') {
          item.detail = `${structured.file.numLines} lines`
        }
      }
      item.output = output
      item.durationMs = this.now() - existing.ts
      if (this.declined.has(toolUseId)) item.status = 'declined'
      else if (block.is_error) item.status = 'error'
      else item.status = 'done'
      this.tools.set(toolUseId, item)
      this.emit({ type: 'item', item })
    }
  }

  private handleResult(msg: Json): void {
    const modelUsage = msg.modelUsage && typeof msg.modelUsage === 'object' ? msg.modelUsage : {}
    for (const value of Object.values<Json>(modelUsage)) {
      if (value && typeof value.contextWindow === 'number') this.contextWindow = value.contextWindow
    }
    const terminal: string | undefined = msg.terminal_reason
    let status: TurnEndStatus = 'completed'
    let error: string | undefined
    if (this.interrupted || terminal === 'aborted_tools' || terminal === 'aborted_streaming') status = 'interrupted'
    else if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
      status = 'failed'
      const errors = Array.isArray(msg.errors) ? msg.errors.filter((e: unknown) => typeof e === 'string') : []
      error = (typeof msg.result === 'string' && msg.result) || errors.join('\n') || `Claude stopped (${msg.subtype ?? 'error'})`
      if (msg.subtype === 'error_max_turns') error = 'Claude hit the maximum number of turns.'
    }
    // A local slash command answers without a model call: its output is the result text.
    if (msg.local_command && !this.localOutput && status === 'completed' && typeof msg.result === 'string' && msg.result.trim()) {
      this.emit({ type: 'item', item: { kind: 'assistant', id: `c-local-${msg.uuid ?? this.now()}`, ts: this.now(), provider: 'claude', text: msg.result.trim() } })
    }
    const usage = msg.usage ?? {}
    this.emit({
      type: 'turn-end',
      status,
      error,
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
      durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) || undefined,
      outputTokens: usage.output_tokens,
      model: this.model
    })
  }
}
