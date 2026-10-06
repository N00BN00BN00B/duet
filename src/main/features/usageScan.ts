import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProviderId } from '@shared/types'

/**
 * Token usage read from Claude Code transcripts and Codex rollouts. Both are append-only JSONL,
 * so each file remembers how far it was read and later scans only parse what was added.
 */

export interface UsageCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Cost the agent itself worked out (Claude Code records it; Codex doesn't). */
  costUsd: number
  /** Model responses counted. */
  turns: number
}

export interface FileUsage {
  provider: ProviderId
  /** Claude session id / Codex thread id the file belongs to. */
  session: string
  size: number
  mtimeMs: number
  /** Byte offset after the last complete line read. */
  offset: number
  /** Totals per `${day}|${model}`. */
  buckets: Record<string, UsageCounts>
  // Parser state carried between scans.
  lastMessageId?: string
  /** Day of the last response seen, for the cost snapshots that follow it. */
  lastDay?: string
  /** Claude's running cost per model at the last snapshot. */
  lastCosts?: Record<string, number>
  model?: string
  turnModels?: Record<string, string>
  lastTotals?: [number, number, number]
  hasRecords?: boolean
}

export interface UsageCache {
  version: 1
  scannedAt: number
  files: Record<string, FileUsage>
}

export const emptyCache = (): UsageCache => ({ version: 1, scannedAt: 0, files: {} })

const zero = (): UsageCounts => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 })
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** Local calendar day (YYYY-MM-DD) of an ISO timestamp. */
export function localDay(iso: unknown): string | null {
  const t = typeof iso === 'string' ? Date.parse(iso) : typeof iso === 'number' ? iso : NaN
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function add(file: FileUsage, day: string, model: string, c: Partial<UsageCounts>): void {
  const key = `${day}|${model}`
  const b = (file.buckets[key] ??= zero())
  b.inputTokens += c.inputTokens ?? 0
  b.outputTokens += c.outputTokens ?? 0
  b.cacheReadTokens += c.cacheReadTokens ?? 0
  b.cacheWriteTokens += c.cacheWriteTokens ?? 0
  b.costUsd += c.costUsd ?? 0
  b.turns += c.turns ?? 0
}

/**
 * One Claude Code transcript line. Assistant messages carry `message.usage` (repeated on every
 * line of a multi-block response, so counted once per message id); `cost-state` lines are running
 * cost snapshots, so only the growth since the previous one is added.
 */
export function readClaudeLine(line: string, file: FileUsage): void {
  const isCost = line.includes('"cost-state"')
  if (!isCost && (!line.includes('"usage"') || !line.includes('"assistant"'))) return
  let obj: { type?: string; timestamp?: string; startTime?: number; modelUsage?: Record<string, { costUSD?: number }>; message?: { id?: string; model?: string; usage?: Record<string, unknown> } }
  try {
    obj = JSON.parse(line)
  } catch {
    return
  }
  if (obj.type === 'cost-state') {
    const day = file.lastDay ?? localDay(obj.startTime)
    if (!day || !obj.modelUsage) return
    const last = (file.lastCosts ??= {})
    for (const [model, usage] of Object.entries(obj.modelUsage)) {
      const total = n(usage?.costUSD)
      const before = last[model] ?? 0
      const delta = total >= before ? total - before : total
      last[model] = total
      if (delta > 0) add(file, day, model, { costUsd: delta })
    }
    return
  }
  const m = obj.message
  if (obj.type !== 'assistant' || !m?.usage) return
  // One response is written as several lines (one per content block) with the same id.
  if (m.id && m.id === file.lastMessageId) return
  file.lastMessageId = m.id
  if (!m.model || m.model === '<synthetic>') return
  const day = localDay(obj.timestamp)
  if (!day) return
  file.lastDay = day
  const u = m.usage
  add(file, day, m.model, {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
    turns: 1
  })
}

/**
 * One Codex rollout line. Newer rollouts write a `token_usage_record` per model response (the
 * accurate source, compaction calls included); older ones only have cumulative `token_count`
 * totals, counted as deltas so a repeated total after compaction adds nothing.
 */
export function readCodexLine(line: string, file: FileUsage): void {
  const isContext = line.includes('"turn_context"')
  const isRecord = line.includes('"token_usage_record"')
  const isCount = line.includes('"token_count"')
  if (!isContext && !isRecord && !isCount) return
  let obj: { type?: string; timestamp?: string; payload?: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    obj = JSON.parse(line)
  } catch {
    return
  }
  const p = obj.payload ?? {}
  if (obj.type === 'turn_context') {
    if (typeof p.model === 'string') {
      file.model = p.model
      if (typeof p.turn_id === 'string') {
        const turns = (file.turnModels ??= {})
        turns[p.turn_id] = p.model
        const keys = Object.keys(turns)
        if (keys.length > 64) for (const k of keys.slice(0, keys.length - 64)) delete turns[k]
      }
    }
    return
  }
  const day = localDay(obj.timestamp)
  if (!day) return
  if (obj.type === 'token_usage_record') {
    file.hasRecords = true
    const u = p.usage ?? {}
    const model = (typeof p.turn_id === 'string' && file.turnModels?.[p.turn_id]) || file.model || 'codex'
    const cached = n(u.cached_input_tokens)
    add(file, day, model, { inputTokens: Math.max(0, n(u.input_tokens) - cached), outputTokens: n(u.output_tokens), cacheReadTokens: cached, cacheWriteTokens: n(u.cache_write_input_tokens), turns: 1 })
    return
  }
  if (obj.type === 'event_msg' && p.type === 'token_count' && !file.hasRecords) {
    const total = p.info?.total_token_usage
    if (!total) return
    const now: [number, number, number] = [n(total.input_tokens), n(total.cached_input_tokens), n(total.output_tokens)]
    const before = file.lastTotals ?? [0, 0, 0]
    // A smaller total means a new count started (resumed elsewhere): take it as is.
    const delta = now.some((v, i) => v < before[i]) ? now : (now.map((v, i) => v - before[i]) as [number, number, number])
    file.lastTotals = now
    if (!delta[0] && !delta[1] && !delta[2]) return
    add(file, day, file.model || 'codex', { inputTokens: Math.max(0, delta[0] - delta[1]), outputTokens: delta[2], cacheReadTokens: delta[1], turns: 1 })
  }
}

const CHUNK = 4 * 1024 * 1024

/** Reads what was appended to a file since the last scan (or all of it if it was rewritten). */
export function scanFile(path: string, provider: ProviderId, previous: FileUsage | undefined): FileUsage | null {
  let st
  try {
    st = statSync(path)
  } catch {
    return null
  }
  if (previous && previous.size === st.size && previous.mtimeMs === st.mtimeMs) return previous
  const restart = !previous || st.size < previous.offset
  const file: FileUsage = restart
    ? { provider, session: sessionOf(path, provider), size: 0, mtimeMs: 0, offset: 0, buckets: {} }
    : {
        ...previous,
        buckets: Object.fromEntries(Object.entries(previous.buckets).map(([k, v]) => [k, { ...v }])),
        turnModels: previous.turnModels ? { ...previous.turnModels } : undefined,
        lastCosts: previous.lastCosts ? { ...previous.lastCosts } : undefined
      }
  const read = provider === 'claude' ? readClaudeLine : readCodexLine
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return previous ?? null
  }
  try {
    let position = file.offset
    let carry = ''
    const buf = Buffer.allocUnsafe(CHUNK)
    while (position < st.size) {
      const got = readSync(fd, buf, 0, Math.min(CHUNK, st.size - position), position)
      if (got <= 0) break
      position += got
      const text = carry + buf.toString('utf8', 0, got)
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline < 0) {
        carry = text
        continue
      }
      for (const line of text.slice(0, lastNewline).split('\n')) if (line) read(line, file)
      carry = text.slice(lastNewline + 1)
    }
    // An unfinished last line is read again next time.
    file.offset = position - Buffer.byteLength(carry)
    file.size = st.size
    file.mtimeMs = st.mtimeMs
    return file
  } finally {
    closeSync(fd)
  }
}

function sessionOf(path: string, provider: ProviderId): string {
  const name = basename(path, '.jsonl')
  // Subagents write to <project>/<session>/subagents/agent-<id>.jsonl: they belong to <session>.
  const sub = /\/([^/]+)\/subagents\/[^/]+$/.exec(path)
  if (provider === 'claude') return sub ? sub[1] : name
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name)
  return uuid ? uuid[1] : name
}

/** Every transcript / rollout file under the given folders. */
export function listUsageFiles(claudeProjects: string, codexRoots: string[]): { path: string; provider: ProviderId }[] {
  const out: { path: string; provider: ProviderId }[] = []
  const walk = (dir: string, provider: ProviderId, depth: number) => {
    if (depth > 6 || !existsSync(dir)) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      if (name.endsWith('.jsonl')) {
        if (provider === 'codex' && !name.startsWith('rollout-')) continue
        out.push({ path: full, provider })
      } else if (!name.includes('.')) {
        try {
          if (statSync(full).isDirectory()) walk(full, provider, depth + 1)
        } catch {
          // vanished
        }
      }
    }
  }
  walk(claudeProjects, 'claude', 0)
  for (const root of codexRoots) walk(root, 'codex', 0)
  return out
}

/** Scans everything, reusing what the cache already knows. */
export function scanAll(claudeProjects: string, codexRoots: string[], cache: UsageCache, onProgress?: (done: number, total: number) => void): UsageCache {
  const files = listUsageFiles(claudeProjects, codexRoots)
  const next: UsageCache = { version: 1, scannedAt: Date.now(), files: {} }
  files.forEach((f, i) => {
    const scanned = scanFile(f.path, f.provider, cache.files[f.path])
    if (scanned) next.files[f.path] = scanned
    if (onProgress && i % 25 === 0) onProgress(i, files.length)
  })
  return next
}
