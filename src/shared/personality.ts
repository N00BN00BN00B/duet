import type { PersonalityPreset, PersonalitySettings, ProviderId } from './types'

export const PERSONALITIES: { id: PersonalityPreset; label: string; description: string; instructions: string }[] = [
  { id: 'default', label: 'Default', description: "Each agent's own style", instructions: '' },
  {
    id: 'concise',
    label: 'Concise',
    description: 'Short answers, no filler',
    instructions:
      'Communication style: be concise. Lead with the answer or the result, skip preamble and recaps, and keep explanations short. Use bullet points only when they make things clearer. Never restate the question.'
  },
  {
    id: 'friendly',
    label: 'Friendly',
    description: 'Warm and encouraging',
    instructions:
      'Communication style: be warm, upbeat and encouraging, like a friendly senior teammate. Explain what you did in plain language and acknowledge progress briefly, while staying clear and accurate.'
  },
  {
    id: 'pragmatic',
    label: 'Pragmatic',
    description: 'Direct, opinionated engineer',
    instructions:
      'Communication style: be direct and pragmatic, like an experienced engineer. Give clear recommendations, say plainly when an approach is a bad idea and why, and prefer the simplest thing that works.'
  },
  {
    id: 'teacher',
    label: 'Teacher',
    description: 'Explains the why as it works',
    instructions:
      'Communication style: explain your reasoning as you work so the user learns. Say briefly why you chose an approach, name the key concepts involved, and point out patterns worth remembering — without padding.'
  },
  { id: 'custom', label: 'Custom', description: 'Your own words', instructions: '' }
]

/** The standing instructions an agent gets for the chosen personality (none for Default). */
export function personalityInstructions(p: PersonalitySettings | undefined, provider: ProviderId): string | undefined {
  if (!p || !p.providers.includes(provider)) return undefined
  const text = p.preset === 'custom' ? p.custom.trim() : (PERSONALITIES.find((x) => x.id === p.preset)?.instructions ?? '')
  return text ? text.slice(0, 4000) : undefined
}
