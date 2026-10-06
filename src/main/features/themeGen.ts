import { randomBytes } from 'node:crypto'
import type { ProviderId } from '@shared/types'
import { PROVIDERS } from '@shared/types'
import { extractJsonObject, normalizeTheme, slug, THEME_JSON_SCHEMA, themeFromPrompt, themePrompt, type ThemeSpec } from '@shared/theme'

export interface ThemeAgent {
  id: ProviderId
  /** Whether the agent is installed and signed in. */
  ready: boolean
  ask: (prompt: string, schema: unknown) => Promise<string>
}

/** A theme id that can't clash with presets or earlier custom themes. */
function freshId(name: string): string {
  return `${slug(name).slice(0, 32)}-${randomBytes(3).toString('hex')}`
}

/**
 * Designs a theme from a description. Asks the preferred agent first, then the other one, and
 * falls back to the offline generator, so the button always does something sensible.
 */
export async function generateTheme(description: string, agents: ThemeAgent[], preferred?: ProviderId): Promise<{ theme: ThemeSpec; via: ProviderId | 'local'; note?: string }> {
  const text = description.trim().slice(0, 400)
  if (!text) throw new Error('Describe the look you want first.')
  const order = [...agents].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred) || PROVIDERS.indexOf(a.id) - PROVIDERS.indexOf(b.id))
  const problems: string[] = []
  for (const agent of order) {
    if (!agent.ready) continue
    try {
      const reply = await agent.ask(themePrompt(text), THEME_JSON_SCHEMA)
      const parsed = extractJsonObject(reply)
      const theme = parsed && typeof parsed === 'object' ? normalizeTheme({ ...(parsed as Record<string, unknown>), source: 'ai', prompt: text }) : null
      if (theme) return { theme: { ...theme, id: freshId(theme.name) }, via: agent.id }
      problems.push(`${agent.id} answered without a usable theme`)
    } catch (error) {
      problems.push(`${agent.id}: ${(error as Error).message}`)
    }
  }
  const theme = themeFromPrompt(text)
  return {
    theme: { ...theme, id: freshId(theme.name) },
    via: 'local',
    note: problems.length ? `Made offline (${problems.join('; ')})` : 'Made offline — connect Claude or Codex for agent-designed themes'
  }
}
