import type { ModelOption } from '@shared/types'

/**
 * How capable a model is, 0 (fastest) to 4 (most capable), from the agent's own description of it
 * ("Fastest for quick answers", "Frontier intelligence for the most demanding work"…) and, failing
 * that, its name. Undefined when neither says.
 */
export function modelTier(m: Pick<ModelOption, 'id' | 'label' | 'description'>): number | undefined {
  const d = (m.description ?? '').toLowerCase()
  if (/most capable|frontier|hardest|most demanding/.test(d)) return 4
  if (/fastest/.test(d)) return 0
  if (/\b(fast|affordable|quick|lightweight)\b/.test(d)) return 1
  if (/\b(efficient|routine|balanced|straightforward)\b/.test(d)) return 2
  if (/\b(workhorse|everyday|complex)\b/.test(d)) return 3
  const name = `${m.id} ${m.label}`.toLowerCase()
  if (/nano/.test(name)) return 0
  if (/haiku|luna|mini|flash|spark|lite/.test(name)) return 1
  if (/sonnet|terra/.test(name)) return 2
  if (/fable|astra|\bpro\b|-pro\b/.test(name)) return 4
  if (/opus|\bsol\b|-sol\b|codex/.test(name)) return 3
  return undefined
}

/** Older generations stay in the list but don't get a place on the slider. */
const older = (m: ModelOption) => /\b(previous|older|legacy|deprecated)\b/i.test(m.description ?? '')

/** The family word for a stop label: "Opus 5.5" → "Opus", "GPT-6.1-Sol" → "Sol". */
export function shortModelName(label: string): string {
  const name = label.replace(/^gpt-[\d.]+-/i, '').replace(/\s*\(.*\)\s*$/, '')
  return name.split(/\s+/)[0] || label
}

/**
 * The agent's model families from fastest to most capable, one model each (the newest, preferring
 * a version-less alias like `opus`), plus which of them the agent recommends.
 */
export function modelLadder(models: ModelOption[]): { stops: ModelOption[]; recommended?: number } {
  const byTier = new Map<number, ModelOption>()
  for (const m of models) {
    if (m.id === 'default' || older(m)) continue
    const tier = modelTier(m)
    if (tier === undefined) continue
    const have = byTier.get(tier)
    if (!have || (/\d/.test(have.id) && !/\d/.test(m.id))) byTier.set(tier, m)
  }
  const stops = [...byTier.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m)
  if (stops.length < 2) return { stops: [] }
  const def = models.find((m) => m.isDefault)
  let recommended = def ? stops.findIndex((s) => s.id === def.id) : -1
  if (def && recommended < 0) {
    // Claude's "Default" names what it stands for: "Opus 5.5 · Best for everyday, complex tasks".
    const named = def.description?.split(' · ')[0]?.trim().toLowerCase()
    recommended = stops.findIndex((s) => s.label.toLowerCase() === named)
    if (recommended < 0) {
      const tier = modelTier(def)
      recommended = tier === undefined ? -1 : stops.findIndex((s) => modelTier(s) === tier)
    }
  }
  return { stops, recommended: recommended >= 0 ? recommended : undefined }
}

/** Where a model sits on the ladder: its own stop, or the stop of its family (e.g. an older Opus). */
export function ladderIndex(stops: ModelOption[], model: ModelOption | undefined): { index: number; exact: boolean } | null {
  if (!model) return null
  const exact = stops.findIndex((s) => s.id === model.id)
  if (exact >= 0) return { index: exact, exact: true }
  const tier = modelTier(model)
  const near = tier === undefined ? -1 : stops.findIndex((s) => modelTier(s) === tier)
  return near >= 0 ? { index: near, exact: false } : null
}
