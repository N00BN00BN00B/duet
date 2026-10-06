import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AssistantItem, HistoryEntry, ReasoningItem, TimelineItem, ToolItem, UserItem } from '@shared/types'
import { firstLine, truncate } from '@shared/paths'
import { describeClaudeTool } from '../providers/claude/describe'
import { codexItemToTimeline } from '../providers/codex/mapper'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function readSlice(path: string, start: number, length: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const SKIP_USER = /^(<command-|<local-command|Caveat: The messages below|<system-reminder>|<bash-|<user-prompt-submit-hook>)/

function userText(content: Json): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: Json) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: Json) => b.text)
    .join('\n')
}

function isRealUserLine(msg: Json): boolean {
  if (msg?.type !== 'user' || msg.isMeta || msg.isSidechain || msg.isCompactSummary) return false
  const content = msg.message?.content
  if (Array.isArray(content) && content.length > 0 && content.every((b: Json) => b?.type === 'tool_result')) return false
  const text = userText(content).trim()
  return text.length > 0 && !SKIP_USER.test(text)
}

const listCache = new Map<string, { key: string; entry: HistoryEntry | null }>()

/** Reads just the head and tail of a Claude session file to describe it. */
export function describeClaudeSession(path: string): HistoryEntry | null {
  let st
  try {
    st = statSync(path)
  } catch {
    return null
  }
  const key = `${st.size}:${st.mtimeMs}`
  const cached = listCache.get(path)
  if (cached?.key === key) return cached.entry
  const HEAD = 96 * 1024
  const TAIL = 96 * 1024
  const head = readSlice(path, 0, Math.min(HEAD, st.size))
  const tail = st.size > HEAD ? readSlice(path, Math.max(HEAD, st.size - TAIL), Math.min(TAIL, st.size - HEAD)) : ''
  let cwd = ''
  let firstPrompt = ''
  let title = ''
  let created = 0
  let model = ''
  let sessionId = ''
  const scan = (text: string, isTail: boolean) => {
    const lines = text.split('\n')
    if (isTail) lines.shift() // first tail line is probably partial
    for (const line of lines) {
      if (!line.startsWith('{')) continue
      let msg: Json
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (!sessionId && typeof msg.sessionId === 'string') sessionId = msg.sessionId
      if (!cwd && typeof msg.cwd === 'string') cwd = msg.cwd
      if (!created && typeof msg.timestamp === 'string') created = Date.parse(msg.timestamp) || 0
      if (msg.type === 'custom-title' && typeof msg.customTitle === 'string') title = msg.customTitle
      else if (msg.type === 'ai-title' && typeof msg.aiTitle === 'string' && !title) title = msg.aiTitle
      else if (msg.type === 'summary' && typeof msg.summary === 'string' && !title) title = msg.summary
      if (!firstPrompt && isRealUserLine(msg)) firstPrompt = firstLine(userText(msg.message?.content))
      if (msg.type === 'assistant' && typeof msg.message?.model === 'string' && msg.message.model !== '<synthetic>') model = msg.message.model
    }
  }
  scan(head, false)
  if (tail) scan(tail, true)
  const id = sessionId || path.split('/').pop()!.replace(/\.jsonl$/, '')
  const entry: HistoryEntry | null =
    firstPrompt || title
      ? {
          provider: 'claude',
          nativeId: id,
          title: truncate(title || firstPrompt, 100),
          cwd,
          createdAt: created || st.birthtimeMs || st.mtimeMs,
          updatedAt: st.mtimeMs,
          model: model || undefined
        }
      : null
  listCache.set(path, { key, entry })
  return entry
}

export function claudeSessionFiles(): string[] {
  const root = join(claudeHome(), 'projects')
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const full = join(root, dir.name)
    let entries: string[] = []
    try {
      entries = readdirSync(full)
    } catch {
      continue
    }
    for (const name of entries) if (name.endsWith('.jsonl')) files.push(join(full, name))
  }
  return files
}

export function listClaudeSessions(): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const file of claudeSessionFiles()) {
    const entry = describeClaudeSession(file)
    if (entry) out.push(entry)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function findClaudeSessionFile(sessionId: string): string | null {
  for (const file of claudeSessionFiles()) {
    if (file.endsWith(`/${sessionId}.jsonl`)) return file
  }
  return null
}

/** Converts a full Claude session transcript into Duet timeline items. */
export function parseClaudeTranscript(text: string, cwdHint = ''): { items: TimelineItem[]; cwd: string; model?: string } {
  const items: TimelineItem[] = []
  const tools = new Map<string, ToolItem>()
  const textByMessage = new Map<string, AssistantItem>()
  let cwd = cwdHint
  let model: string | undefined
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.isSidechain) continue
    if (!cwd && typeof msg.cwd === 'string') cwd = msg.cwd
    const ts = typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) || Date.now() : Date.now()
    if (msg.type === 'user') {
      const content = msg.message?.content
      if (msg.isCompactSummary) {
        items.push({ kind: 'notice', id: `h-${msg.uuid}`, ts, level: 'info', provider: 'claude', text: 'Context compacted' })
        continue
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue
          const tool = tools.get(block.tool_use_id)
          if (!tool) continue
          const out = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.filter((b: Json) => b?.type === 'text').map((b: Json) => b.text).join('\n') : ''
          tool.output = truncate(out, 64 * 1024)
          tool.status = block.is_error ? 'error' : 'done'
        }
      }
      if (!isRealUserLine(msg)) continue
      const user: UserItem = { kind: 'user', id: `h-${msg.uuid ?? ts}`, ts, provider: 'claude', text: userText(content).trim(), attachments: [] }
      items.push(user)
    } else if (msg.type === 'assistant') {
      const message = msg.message ?? {}
      if (typeof message.model === 'string' && message.model !== '<synthetic>') model = message.model
      const content = Array.isArray(message.content) ? message.content : []
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          const key = message.id ?? msg.uuid
          const existing = textByMessage.get(key)
          if (existing) existing.text += `\n\n${block.text}`
          else {
            const item: AssistantItem = { kind: 'assistant', id: `h-${msg.uuid}-t`, ts, provider: 'claude', model: message.model, text: block.text }
            textByMessage.set(key, item)
            items.push(item)
          }
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          const reasoning: ReasoningItem = { kind: 'reasoning', id: `h-${msg.uuid}-r`, ts, provider: 'claude', text: block.thinking }
          items.push(reasoning)
        } else if (block?.type === 'tool_use') {
          const desc = describeClaudeTool(block.name, block.input, cwd)
          const tool: ToolItem = { kind: 'tool', id: `h-tool-${block.id}`, ts, provider: 'claude', tool: desc.tool, name: block.name, title: desc.title, detail: desc.detail, input: block.input, diff: desc.diff, steps: desc.steps, status: 'done' }
          tools.set(block.id, tool)
          items.push(tool)
        }
      }
    }
  }
  return { items, cwd, model }
}

export function loadClaudeSession(sessionId: string): { items: TimelineItem[]; cwd: string; model?: string; title?: string } {
  const file = findClaudeSessionFile(sessionId)
  if (!file) throw new Error('Claude session file not found')
  const entry = describeClaudeSession(file)
  const parsed = parseClaudeTranscript(readFileSync(file, 'utf8'), entry?.cwd ?? '')
  return { ...parsed, title: entry?.title }
}

// ---------- Codex ----------

export type CodexRequest = <T = Json>(method: string, params?: Json, timeoutMs?: number) => Promise<T>

export async function listCodexThreads(request: CodexRequest, max = 400): Promise<HistoryEntry[]> {
  const out: HistoryEntry[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10 && out.length < max; page++) {
    const res: Json = await request('thread/list', { limit: 100, cursor, sortKey: 'updated_at', sortDirection: 'desc', archived: false }, 30_000)
    for (const t of res?.data ?? []) {
      if (t.parentThreadId || t.ephemeral) continue
      const source = t.source
      if (source && typeof source === 'object' && ('subagent' in source || 'internal' in source)) continue
      out.push({
        provider: 'codex',
        nativeId: t.id,
        title: truncate(t.name || firstLine(t.preview ?? '') || 'Untitled Codex thread', 100),
        cwd: t.cwd ?? '',
        createdAt: (t.createdAt ?? 0) * 1000,
        updatedAt: (t.updatedAt ?? t.createdAt ?? 0) * 1000,
        model: t.model ?? undefined
      })
    }
    cursor = res?.nextCursor ?? null
    if (!cursor) break
  }
  return out
}

export async function loadCodexThread(request: CodexRequest, threadId: string): Promise<{ items: TimelineItem[]; cwd: string; model?: string; title?: string }> {
  const read: Json = await request('thread/read', { threadId, includeTurns: true }, 60_000).catch(() => request('thread/read', { threadId, includeTurns: false }, 60_000))
  const thread = read?.thread ?? {}
  const cwd: string = thread.cwd ?? ''
  const ctx = { cwd, home: homedir(), now: Date.now, model: thread.model ?? undefined }
  let rawItems: { item: Json; ts: number }[] = []
  const turns: Json[] = Array.isArray(thread.turns) ? thread.turns : []
  const hasItems = turns.some((t) => Array.isArray(t.items) && t.items.length > 0)
  if (hasItems) {
    for (const turn of turns) {
      const ts = (turn.startedAt ?? thread.createdAt ?? 0) * 1000
      for (const item of turn.items ?? []) rawItems.push({ item, ts })
    }
  } else {
    // Paginated history: walk the items list.
    let cursor: Json = null
    rawItems = []
    for (let page = 0; page < 50; page++) {
      const res: Json = await request('thread/items/list', { threadId, cursor, limit: 200, sortDirection: 'asc' }, 60_000)
      for (const entry of res?.data ?? []) rawItems.push({ item: entry.item, ts: entry.startedAtMs ?? Date.now() })
      cursor = res?.nextCursor ?? null
      if (!cursor) break
    }
  }
  const items: TimelineItem[] = []
  for (const { item, ts } of rawItems) {
    const mapped = codexItemToTimeline(item, ctx, ts)
    if (!mapped) continue
    if (mapped.kind === 'tool' && mapped.output) mapped.output = truncate(mapped.output, 64 * 1024)
    if (mapped.kind === 'tool' && mapped.status === 'running') mapped.status = 'done'
    items.push(mapped)
  }
  return { items, cwd, model: thread.model ?? undefined, title: thread.name ?? (thread.preview ? firstLine(thread.preview) : undefined) }
}
