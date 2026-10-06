import type { ProviderId, ReviewTarget, SlashCommand } from '@shared/types'

export type CommandSource = 'duet' | ProviderId

export interface CommandEntry {
  name: string
  description: string
  source: CommandSource
  /** 'run': Duet does it; 'send': goes to the agent as text; 'skill': attached to the message. */
  kind: 'run' | 'send' | 'skill'
  argumentHint?: string
  /** Waits for arguments before running. */
  needsArgs?: boolean
  /** Only offered when this agent is active. */
  only?: ProviderId
  /** Only offered inside a chat (not on the home screen). */
  inChat?: boolean
  path?: string
  scope?: string
  prompt?: string
}

/** Commands Duet itself understands, whichever agent is active. */
export const DUET_COMMANDS: CommandEntry[] = [
  { name: 'theme', description: 'Change the look — describe it and an agent designs the theme', argumentHint: 'dark gradient with a wave effect', needsArgs: true, source: 'duet', kind: 'run' },
  { name: 'new', description: 'New chat in this project', source: 'duet', kind: 'run' },
  { name: 'clear', description: 'Start fresh: a new chat in this project', source: 'duet', kind: 'run' },
  { name: 'fork', description: 'Copy this chat into a new one', source: 'duet', kind: 'run', inChat: true },
  { name: 'claude', description: 'Switch to Claude — it picks up the conversation', source: 'duet', kind: 'run' },
  { name: 'codex', description: 'Switch to Codex — it picks up the conversation', source: 'duet', kind: 'run' },
  { name: 'model', description: 'Pick a model', source: 'duet', kind: 'run' },
  { name: 'effort', description: 'How hard the agent thinks', argumentHint: 'auto | low | medium | high | max', source: 'duet', kind: 'run' },
  { name: 'plan', description: 'Plan mode: read-only, the agent proposes a plan', source: 'duet', kind: 'run' },
  { name: 'ask', description: 'Ask before running commands or editing files', source: 'duet', kind: 'run' },
  { name: 'auto', description: 'Edit files freely, ask before risky commands', source: 'duet', kind: 'run' },
  { name: 'full-access', description: 'No prompts: commands and edits run without asking', source: 'duet', kind: 'run' },
  { name: 'fast', description: 'Codex Fast mode on/off — about 2× speed, uses more of your limits', source: 'duet', kind: 'run', only: 'codex' },
  { name: 'usage', description: 'Limits and usage for both agents', source: 'duet', kind: 'run' },
  { name: 'customize', description: 'Themes, colours, layout and personality', source: 'duet', kind: 'run' },
  { name: 'sync', description: 'List every Claude Code and Codex chat in the sidebar', source: 'duet', kind: 'run' },
  { name: 'terminal', description: 'Open the terminal', source: 'duet', kind: 'run' },
  { name: 'browser', description: 'Open the built-in browser', source: 'duet', kind: 'run' },
  { name: 'export', description: 'Copy this chat as Markdown', source: 'duet', kind: 'run', inChat: true },
  { name: 'help', description: 'Show every command', source: 'duet', kind: 'run' }
]

/** Claude Code commands Duet replaces with its own (theirs would confuse Duet's view of the chat). */
const SHADOWED = new Set(['clear', 'reset', 'new', 'model', 'effort', 'usage', 'cost', 'stats', 'login', 'logout', 'resume', 'exit', 'help', 'theme', 'config', 'permissions'])

/** Turns an agent's own command list into menu entries. */
export function agentCommands(provider: ProviderId, list: SlashCommand[]): CommandEntry[] {
  return list
    .filter((c) => !(provider === 'claude' && SHADOWED.has(c.name)))
    .map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      source: provider,
      // Codex's built-ins run through its app-server; Claude handles its own commands as text.
      kind: c.kind === 'skill' ? 'skill' : provider === 'codex' ? 'run' : 'send',
      path: c.path,
      scope: c.scope,
      prompt: c.prompt
    }))
}

/** Fuzzy-ish match: prefix beats substring beats description. */
export function rankCommands(entries: CommandEntry[], query: string): CommandEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  const score = (e: CommandEntry) => {
    const n = e.name.toLowerCase()
    if (n === q) return 0
    if (n.startsWith(q)) return 1
    if (n.includes(q)) return 2
    if (e.description.toLowerCase().includes(q)) return 3
    return -1
  }
  return entries
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.e)
}

/** Splits "/name rest of line" typed in the composer. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: m[1], args: (m[2] ?? '').trim() } : null
}

/** What `/review …` should look at: nothing = your uncommitted changes. */
export function reviewTarget(args: string): ReviewTarget {
  const a = args.trim()
  if (!a) return { type: 'uncommittedChanges' }
  if (/^[0-9a-f]{7,40}$/i.test(a)) return { type: 'commit', sha: a }
  if (/^[\w./-]+$/.test(a) && !/\s/.test(a)) return { type: 'baseBranch', branch: a }
  return { type: 'custom', instructions: a }
}
