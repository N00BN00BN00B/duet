import type { ProviderId, ReasoningItem, TimelineItem, ToolItem } from '@shared/types'

export type WorkEntry = ToolItem | ReasoningItem

export type Block =
  | { type: 'item'; key: string; item: TimelineItem; showHeader?: boolean }
  | { type: 'work'; key: string; entries: WorkEntry[]; provider: ProviderId; showHeader: boolean; last: boolean }

/**
 * A command, edit or tool use that was approved (once or for the whole chat) adds nothing the step
 * itself doesn't show; as a row of its own it would only split the work log into one line per step.
 * Permission grants, declined, expired and still-pending requests, questions and plans stay visible.
 */
export function isSettledApproval(item: TimelineItem): boolean {
  return item.kind === 'approval' && (item.request === 'command' || item.request === 'edit' || item.request === 'tool') && !item.permissionGrant && (item.status === 'approved' || item.status === 'approved-session')
}

/** Folds consecutive tool/reasoning items into work groups and decides where agent headers go. */
export function buildBlocks(items: TimelineItem[]): Block[] {
  const blocks: Block[] = []
  let work: WorkEntry[] = []
  let headerShownForTurn = false
  let lastProvider: ProviderId | null = null
  const flush = () => {
    if (!work.length) return
    const provider = work[0].provider
    blocks.push({ type: 'work', key: `w-${work[0].id}`, entries: work, provider, showHeader: !headerShownForTurn || lastProvider !== provider, last: false })
    headerShownForTurn = true
    lastProvider = provider
    work = []
  }
  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'reasoning') {
      work.push(item)
      continue
    }
    if (isSettledApproval(item)) continue
    flush()
    if (item.kind === 'user' || item.kind === 'switch') {
      headerShownForTurn = false
      lastProvider = null
    }
    if (item.kind === 'assistant') {
      const showHeader = !headerShownForTurn || lastProvider !== item.provider
      headerShownForTurn = true
      lastProvider = item.provider
      blocks.push({ type: 'item', key: item.id, item, showHeader })
      continue
    }
    blocks.push({ type: 'item', key: item.id, item })
  }
  flush()
  const lastWork = [...blocks].reverse().find((b) => b.type === 'work')
  if (lastWork && lastWork.type === 'work') lastWork.last = true
  return blocks
}


const counted = (n: number, one: string, many: string) => (n <= 0 ? '' : n === 1 ? one : many.replace('#', String(n)))

/** One plain sentence for a work group, e.g. "Read 3 files, edited a file, ran 2 commands". */
export function summarize(entries: WorkEntry[]): string {
  const tools = entries.filter((e): e is ToolItem => e.kind === 'tool')
  const count = (fn: (t: ToolItem) => boolean) => tools.filter(fn).length
  const fetches = count((t) => t.tool === 'web' && /^https?:\/\//i.test(t.title))
  const generated = count((t) => t.tool === 'image' && t.name === 'imageGeneration')
  const parts = [
    counted(count((t) => t.tool === 'read'), 'read a file', 'read # files'),
    counted(new Set(tools.filter((t) => (t.tool === 'edit' || t.tool === 'write') && t.status !== 'declined').map((t) => t.title)).size, 'edited a file', 'edited # files'),
    counted(count((t) => t.tool === 'command'), 'ran a command', 'ran # commands'),
    counted(count((t) => t.tool === 'search'), 'searched the code', 'searched the code # times'),
    counted(count((t) => t.tool === 'web') - fetches, 'searched the web', 'searched the web # times'),
    counted(fetches, 'fetched a page', 'fetched # pages'),
    counted(count((t) => t.tool === 'mcp'), 'used an MCP tool', 'used # MCP tools'),
    counted(count((t) => t.tool === 'agent'), 'ran a subagent', 'ran # subagents'),
    count((t) => t.tool === 'todo') ? 'updated the plan' : '',
    counted(count((t) => t.tool === 'image') - generated, 'looked at an image', 'looked at # images'),
    counted(generated, 'generated an image', 'generated # images'),
    counted(count((t) => t.tool === 'skill'), 'used a skill', 'used # skills'),
    counted(count((t) => t.tool === 'other'), 'used a tool', 'used # tools')
  ].filter(Boolean)
  if (!parts.length) return entries.some((e) => e.kind === 'reasoning') ? 'Thought' : 'Worked'
  const sentence = parts.join(', ')
  return sentence[0].toUpperCase() + sentence.slice(1)
}

/** Pictures the tools in a group produced (screenshots, viewed or generated images). */
export function groupImages(entries: WorkEntry[]): string[] {
  const out: string[] = []
  for (const e of entries) if (e.kind === 'tool') for (const p of e.images ?? []) if (!out.includes(p)) out.push(p)
  return out
}

/**
 * Applies a streamed chunk to a copy of the list. `offset` is where the chunk starts, so a chunk
 * the item already contains (one that arrived again after a fresh snapshot) is never added twice.
 * Returns null when nothing changes.
 */
export function applyDelta(list: TimelineItem[], itemId: string, field: 'text' | 'output', delta: string, offset?: number): TimelineItem[] | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item.id !== itemId) continue
    const current = field === 'text' && (item.kind === 'assistant' || item.kind === 'reasoning') ? item.text : field === 'output' && item.kind === 'tool' ? (item.output ?? '') : null
    if (current === null) return null
    let add = delta
    if (offset !== undefined && offset < current.length) {
      const overlap = current.length - offset
      if (overlap >= delta.length) return null
      add = delta.slice(overlap)
    }
    const copy = list.slice()
    copy[i] = (field === 'text' ? { ...item, text: current + add } : { ...item, output: current + add }) as TimelineItem
    return copy
  }
  return null
}
