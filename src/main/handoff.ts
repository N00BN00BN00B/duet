import type { ProviderId, TimelineItem, ToolItem } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { diffStats } from '@shared/diff'
import { truncate } from '@shared/paths'

export interface HandoffOptions {
  /** Max characters of transcript to include. */
  budget?: number
  /** Max characters per assistant/user message. */
  perMessage?: number
  /** Include the transcript even if only `target` took part (used after a lost session). */
  force?: boolean
}

const DEFAULT_BUDGET = 48_000
const DEFAULT_PER_MESSAGE = 6_000

function toolLine(item: ToolItem): string {
  const status = item.status === 'error' ? ' (failed)' : item.status === 'declined' ? ' (declined by user)' : ''
  switch (item.tool) {
    case 'command': {
      const exit = typeof item.exitCode === 'number' ? `, exit ${item.exitCode}` : ''
      return `- Ran \`${truncate(item.title, 200)}\`${exit}${status}`
    }
    case 'edit':
    case 'write': {
      const stats = item.diff ? diffStats(item.diff) : null
      const delta = stats ? ` (+${stats.additions} −${stats.deletions})` : ''
      return `- ${item.tool === 'write' ? 'Wrote' : 'Edited'} ${item.title}${delta}${status}`
    }
    case 'read':
      return `- Read ${item.title}${status}`
    case 'search':
      return `- Searched for "${truncate(item.title, 120)}"${status}`
    case 'web':
      return `- Looked up ${truncate(item.title, 160)} on the web${status}`
    case 'mcp':
      return `- Used MCP tool ${item.detail ? `${item.detail}/` : ''}${item.title}${status}`
    case 'agent':
      return `- Delegated to a subagent: ${truncate(item.title, 160)}${status}`
    case 'todo':
      return item.steps?.length ? `- Plan: ${item.steps.map((s) => `[${s.status === 'done' ? 'x' : s.status === 'active' ? '~' : ' '}] ${s.text}`).join('; ')}` : '- Updated the plan'
    case 'image':
      return `- ${item.title}${item.images?.length ? ` (${item.images.join(', ')})` : ''}`
    default:
      return `- Used ${item.name}${item.title && item.title !== item.name ? `: ${truncate(item.title, 120)}` : ''}${status}`
  }
}

interface Block {
  text: string
  /** The first user message is kept even when trimming, so the task stays clear. */
  pinned?: boolean
}

/**
 * Renders the part of a thread that `target` has not seen yet, so a provider can
 * continue a conversation that another provider was handling. Returns null when
 * there is nothing new to tell it.
 */
export function buildHandoff(items: TimelineItem[], fromIndex: number, target: ProviderId, opts: HandoffOptions = {}): string | null {
  const budget = opts.budget ?? DEFAULT_BUDGET
  const perMessage = opts.perMessage ?? DEFAULT_PER_MESSAGE
  const slice = items.slice(Math.max(0, fromIndex))
  const blocks: Block[] = []
  let sawOther = false
  let toolLines: string[] = []
  let toolsOwner: ProviderId | null = null

  const flushTools = () => {
    if (toolLines.length && toolsOwner) {
      blocks.push({ text: `Actions taken by ${PROVIDER_LABEL[toolsOwner]}:\n${toolLines.join('\n')}` })
    }
    toolLines = []
    toolsOwner = null
  }

  let firstUser = true
  for (const item of slice) {
    switch (item.kind) {
      case 'user': {
        flushTools()
        const files = item.attachments.map((a) => `[attached ${a.mime.startsWith('image/') ? 'image' : 'file'}: ${a.path}]`).join('\n')
        const text = truncate(item.text.trim(), perMessage)
        blocks.push({ text: `### User\n${[text, files].filter(Boolean).join('\n')}`, pinned: firstUser && fromIndex === 0 })
        firstUser = false
        break
      }
      case 'assistant': {
        if (item.provider !== target) sawOther = true
        flushTools()
        if (!item.text.trim()) break
        blocks.push({ text: `### ${PROVIDER_LABEL[item.provider]}${item.model ? ` (${item.model})` : ''}\n${truncate(item.text.trim(), perMessage)}` })
        break
      }
      case 'tool': {
        if (item.provider !== target) sawOther = true
        if (toolsOwner && toolsOwner !== item.provider) flushTools()
        toolsOwner = item.provider
        toolLines.push(toolLine(item))
        break
      }
      case 'notice':
        if (item.level === 'error') {
          flushTools()
          blocks.push({ text: `(Error shown to the user: ${truncate(item.text, 400)})` })
        }
        break
      case 'turn':
        if (item.status === 'interrupted') {
          flushTools()
          blocks.push({ text: '(The user stopped this turn before it finished.)' })
        }
        break
      default:
        break
    }
  }
  flushTools()
  if (!blocks.length || (!sawOther && !opts.force)) return null

  // Trim from the oldest (non-pinned) blocks until within budget.
  let total = blocks.reduce((n, b) => n + b.text.length + 2, 0)
  let omitted = 0
  const kept = [...blocks]
  while (total > budget && kept.length > 1) {
    const idx = kept.findIndex((b) => !b.pinned)
    if (idx < 0 || idx === kept.length - 1) break
    total -= kept[idx].text.length + 2
    kept.splice(idx, 1)
    omitted++
  }
  if (omitted > 0) {
    const insertAt = kept[0]?.pinned ? 1 : 0
    kept.splice(insertAt, 0, { text: `[… ${omitted} earlier entr${omitted === 1 ? 'y' : 'ies'} omitted for length …]` })
  }

  const others = [...new Set(slice.filter((i) => (i.kind === 'assistant' || i.kind === 'tool') && i.provider !== target).map((i) => PROVIDER_LABEL[(i as { provider: ProviderId }).provider]))]
  if (!others.length) others.push('a previous session')
  const header =
    fromIndex === 0
      ? `This conversation started in Duet, an app where the user switches between coding agents (Claude Code and Codex) in one thread. Until now it was handled by ${others.join(' and ')}. Here is the conversation so far — treat it as your own context and continue seamlessly. The project files already reflect any edits listed.`
      : `The user switched agents in this Duet thread. While you were away, ${others.join(' and ')} handled the conversation. Here is what happened since your last turn — continue seamlessly. The project files already reflect any edits listed.`

  return `<duet_handoff>\n${header}\n\n${kept.map((b) => b.text).join('\n\n')}\n</duet_handoff>`
}

/** Joins the hand-off block and the user's message into one prompt. */
export function withHandoff(handoff: string | null, userText: string): string {
  if (!handoff) return userText
  return `${handoff}\n\nThe user's new message:\n\n${userText}`
}
