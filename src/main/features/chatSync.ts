import { randomUUID } from 'node:crypto'
import type { AccessMode, HistoryEntry, ProviderId, ThreadMeta } from '@shared/types'
import { PROVIDERS } from '@shared/types'
import { truncate } from '@shared/paths'

export const entryKey = (provider: ProviderId, nativeId: string) => `${provider}:${nativeId}`

export interface SyncDefaults {
  models: Partial<Record<ProviderId, string>>
  efforts: Partial<Record<ProviderId, string>>
  access: AccessMode
  /** Folder for chats whose project folder no longer exists. */
  fallbackCwd: string
  folderExists: (path: string) => boolean
}

/**
 * Decides what chat sync changes: every Claude Code / Codex chat Duet doesn't know yet becomes a
 * lazy thread (just a sidebar entry, no messages copied), and synced chats that changed at the
 * source get their title and date updated. Threads continued in Duet are never touched.
 */
export function planChatSync(metas: ThreadMeta[], entries: HistoryEntry[], d: SyncDefaults): { added: ThreadMeta[]; updated: ThreadMeta[] } {
  const known = new Map<string, ThreadMeta>()
  for (const m of metas) {
    if (m.origin) known.set(entryKey(m.origin.provider, m.origin.nativeId), m)
    for (const p of PROVIDERS) if (m.native[p]) known.set(entryKey(p, m.native[p]!.id), m)
  }
  const added: ThreadMeta[] = []
  const updated: ThreadMeta[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    const key = entryKey(e.provider, e.nativeId)
    if (seen.has(key)) continue
    seen.add(key)
    const existing = known.get(key)
    const title = truncate((e.title || '').trim() || 'Untitled chat', 100)
    const updatedAt = e.updatedAt || e.createdAt || Date.now()
    if (!existing) {
      added.push({
        id: randomUUID(),
        title,
        cwd: e.cwd && d.folderExists(e.cwd) ? e.cwd : d.fallbackCwd,
        createdAt: e.createdAt || updatedAt,
        updatedAt,
        provider: e.provider,
        models: { ...d.models },
        efforts: { ...d.efforts },
        access: d.access,
        status: 'idle',
        native: { [e.provider]: { id: e.nativeId, syncedTo: 0 } },
        origin: { provider: e.provider, nativeId: e.nativeId },
        lazy: true,
        sourceUpdatedAt: updatedAt,
        itemCount: 0
      })
      continue
    }
    const fromSource = existing.lazy || existing.pristine
    if (!fromSource || updatedAt <= (existing.sourceUpdatedAt ?? 0) || existing.status !== 'idle') continue
    updated.push({
      ...existing,
      title: existing.lazy ? title : existing.title,
      updatedAt: Math.max(existing.updatedAt, updatedAt),
      sourceUpdatedAt: updatedAt,
      // A copy that is behind its source is re-read the next time it's opened.
      lazy: true,
      pristine: false
    })
  }
  return { added, updated }
}
