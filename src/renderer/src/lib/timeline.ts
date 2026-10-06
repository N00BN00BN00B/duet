import type { ProviderId, ReasoningItem, TimelineItem, ToolItem } from '@shared/types'

export type WorkEntry = ToolItem | ReasoningItem

export type Block =
  | { type: 'item'; key: string; item: TimelineItem; showHeader?: boolean }
  | { type: 'work'; key: string; entries: WorkEntry[]; provider: ProviderId; showHeader: boolean; last: boolean }

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


export function summarize(entries: WorkEntry[]): string {
  const count = (fn: (e: WorkEntry) => boolean) => entries.filter(fn).length
  const parts: string[] = []
  const thought = count((e) => e.kind === 'reasoning')
  const reads = count((e) => e.kind === 'tool' && e.tool === 'read')
  const files = new Set(entries.filter((e): e is ToolItem => e.kind === 'tool' && (e.tool === 'edit' || e.tool === 'write')).map((e) => e.title)).size
  const commands = count((e) => e.kind === 'tool' && e.tool === 'command')
  const searches = count((e) => e.kind === 'tool' && e.tool === 'search')
  const web = count((e) => e.kind === 'tool' && e.tool === 'web')
  const mcp = count((e) => e.kind === 'tool' && e.tool === 'mcp')
  const agents = count((e) => e.kind === 'tool' && e.tool === 'agent')
  const plans = count((e) => e.kind === 'tool' && e.tool === 'todo')
  const other = count((e) => e.kind === 'tool' && (e.tool === 'other' || e.tool === 'skill' || e.tool === 'image'))
  if (thought) parts.push('Thought')
  if (reads) parts.push(`Read ${reads} file${reads === 1 ? '' : 's'}`)
  if (files) parts.push(`Changed ${files} file${files === 1 ? '' : 's'}`)
  if (commands) parts.push(`Ran ${commands} command${commands === 1 ? '' : 's'}`)
  if (searches) parts.push(`Searched ${searches} time${searches === 1 ? '' : 's'}`)
  if (web) parts.push(`Browsed the web${web > 1 ? ` ${web}×` : ''}`)
  if (mcp) parts.push(`Used ${mcp} MCP tool${mcp === 1 ? '' : 's'}`)
  if (agents) parts.push(`Ran ${agents} subagent${agents === 1 ? '' : 's'}`)
  if (plans) parts.push('Updated the plan')
  if (other) parts.push(`${other} other action${other === 1 ? '' : 's'}`)
  return parts.join(' · ') || 'Worked'
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
