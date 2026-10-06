import type { SyncAction, SyncItem } from '@shared/types'

export type Strategy = 'newest' | 'to-codex' | 'to-claude'

export function planActions(items: SyncItem[], strategy: Strategy): SyncAction[] {
  const actions: SyncAction[] = []
  for (const item of items) {
    if (item.state === 'same') continue
    if (item.state === 'claude-only') {
      if (strategy !== 'to-claude') actions.push({ key: item.key, direction: 'to-codex' })
    } else if (item.state === 'codex-only') {
      if (strategy !== 'to-codex') actions.push({ key: item.key, direction: 'to-claude' })
    } else if (strategy === 'to-codex') actions.push({ key: item.key, direction: 'to-codex' })
    else if (strategy === 'to-claude') actions.push({ key: item.key, direction: 'to-claude' })
    else if (item.newer) actions.push({ key: item.key, direction: item.newer === 'claude' ? 'to-codex' : 'to-claude' })
  }
  return actions
}

