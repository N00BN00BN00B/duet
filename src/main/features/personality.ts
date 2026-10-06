import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { PersonalityPreset } from '@shared/types'

/** Claude Code's built-in output styles, in Duet's terms. */
const BUILT_IN: Record<string, { preset: PersonalityPreset; custom?: string }> = {
  default: { preset: 'default' },
  concise: { preset: 'concise' },
  explanatory: { preset: 'teacher' },
  proactive: {
    preset: 'custom',
    custom:
      'Communication style: act rather than plan out loud. Carry out the task straight away, keep interruptions to a minimum, make reasonable assumptions instead of asking, and report briefly what you did.'
  },
  learning: {
    preset: 'custom',
    custom:
      'Communication style: teach by doing. Explain your approach briefly, and for small, meaningful pieces of code ask the user to write them (mark the spot with TODO(human)) and review what they wrote, instead of writing everything yourself.'
  }
}

function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return { fields, body: text.slice(match[0].length) }
}

function styleFiles(dir: string, depth = 0): string[] {
  if (depth > 3 || !existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      if (statSync(full).isDirectory()) out.push(...styleFiles(full, depth + 1))
      else if (name.endsWith('.md')) out.push(full)
    } catch {
      // vanished
    }
  }
  return out
}

/**
 * Reads the output style Claude Code is set to (its "personality") so Duet can give Codex the
 * same one. Custom styles are read from ~/.claude/output-styles.
 */
export function readClaudePersonality(claudeDir: string): { preset: PersonalityPreset; custom: string; label: string } | null {
  let style = 'default'
  try {
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))
    if (typeof settings?.outputStyle === 'string' && settings.outputStyle.trim()) style = settings.outputStyle.trim()
  } catch {
    // no settings: the default style
  }
  const builtIn = BUILT_IN[style.toLowerCase()]
  if (builtIn) return { preset: builtIn.preset, custom: builtIn.custom ?? '', label: `Claude Code · ${style[0].toUpperCase()}${style.slice(1)}` }
  for (const file of styleFiles(join(claudeDir, 'output-styles'))) {
    try {
      const { fields, body } = frontmatter(readFileSync(file, 'utf8'))
      const name = fields.name || basename(file, '.md')
      if (name !== style) continue
      const text = body.trim()
      if (!text) return null
      return { preset: 'custom', custom: text.slice(0, 4000), label: `Claude Code · ${name}` }
    } catch {
      // unreadable style file
    }
  }
  return null
}
