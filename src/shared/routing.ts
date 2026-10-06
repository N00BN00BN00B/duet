import type { ModelOption, ProviderId } from './types'

export const ROUTED_MODEL_PREFIX = 'router:'

export function routedModel(id: string | undefined): string | undefined {
  return id?.startsWith(ROUTED_MODEL_PREFIX) ? id.slice(ROUTED_MODEL_PREFIX.length) : undefined
}

/** Native controls must not become unsupported reasoning options on a routed model. */
export function modelEffort(model: ModelOption | undefined, effort: string | undefined, provider?: ProviderId): string | undefined {
  if (!model?.routing) return effort
  if (!effort || !model.efforts?.includes(effort)) return undefined
  // Claude's CLI accepts this subset of the routing engine's wider reasoning ladder.
  if (provider === 'claude' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return undefined
  return effort
}

/** Keep the speed slider about the agent's native families; routed providers have separate rows. */
export function nativeModels(models: ModelOption[]): ModelOption[] {
  return models.filter((m) => !m.routing && !routedModel(m.id))
}
