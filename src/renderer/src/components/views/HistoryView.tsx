import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HistoryEntry, ProviderId, ThreadMeta } from '@shared/types'
import { PROVIDER_LABEL, otherProvider } from '@shared/types'
import { duet } from '@/lib/api'
import { projectName, shortModel, timeAgo } from '@/lib/format'
import { openThread, switchProvider, syncAllChats, toastError, useApp } from '@/state/store'
import { ProviderLogo } from '../brand'
import { IconArrowRight, IconCheck, IconDownload, IconHistory, IconRefresh, IconSearch, Spinner } from '../icons'
import { Button, Chip, EmptyState, Segmented, inputClass } from '../ui/primitives'
import { Card, Page } from './Page'

export function HistoryView() {
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [entries, setEntries] = useState<Partial<Record<ProviderId, HistoryEntry[]>>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const syncing = useApp((s) => s.chatSyncing)

  const load = useCallback(async (p: ProviderId) => {
    setLoading(true)
    setError(null)
    try {
      const list = await duet.history.list(p)
      setEntries((e) => ({ ...e, [p]: list }))
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!entries[provider]) void load(provider)
  }, [provider, entries, load])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (entries[provider] ?? []).filter((e) => !q || e.title.toLowerCase().includes(q) || e.cwd.toLowerCase().includes(q))
  }, [entries, provider, query])

  const markImported = (entry: HistoryEntry, meta: ThreadMeta) => {
    useApp.setState((s) => ({ threads: { ...s.threads, [meta.id]: meta } }))
    setEntries((e) => ({ ...e, [entry.provider]: (e[entry.provider] ?? []).map((x) => (x.nativeId === entry.nativeId ? { ...x, importedThreadId: meta.id } : x)) }))
  }

  const open = async (entry: HistoryEntry, continueWith?: ProviderId) => {
    setBusy(entry.nativeId)
    try {
      const meta = entry.importedThreadId ? useApp.getState().threads[entry.importedThreadId] : await duet.history.import(entry.provider, entry.nativeId)
      if (!meta) throw new Error('Thread not found')
      markImported(entry, meta)
      await openThread(meta.id)
      if (continueWith && continueWith !== meta.provider) await switchProvider(continueWith)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(null)
    }
  }

  const counts = { claude: entries.claude?.length, codex: entries.codex?.length }
  const notImported = list.filter((e) => !e.importedThreadId).length
  return (
    <Page
      title="History"
      testId="history-view"
      subtitle="Every conversation you've had in Claude Code and Codex on this Mac. Open one to keep going with the same agent, or hand it to the other one — Duet brings the context along."
      actions={
        <>
          {notImported > 0 && (
            <Button
              size="sm"
              variant="secondary"
              icon={syncing ? <Spinner size={13} /> : <IconDownload size={13} />}
              disabled={syncing}
              onClick={() => void syncAllChats().then(() => load(provider))}
              data-testid="history-sync-all"
            >
              {`Add all to sidebar (${notImported})`}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={loading ? <Spinner size={13} /> : <IconRefresh size={13} />} onClick={() => void load(provider)}>
            Refresh
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-[260px]">
          <Segmented
            value={provider}
            onChange={setProvider}
            options={(['claude', 'codex'] as ProviderId[]).map((p) => ({ value: p, label: `${PROVIDER_LABEL[p]}${counts[p] !== undefined ? ` · ${counts[p]}` : ''}`, icon: <ProviderLogo provider={p} size={12} /> }))}
          />
        </div>
        <div className="relative min-w-[200px] flex-1">
          <IconSearch size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by title or folder" className={`${inputClass} pl-8`} data-testid="history-search" />
        </div>
      </div>
      {error ? (
        <EmptyState icon={<IconHistory size={18} />} title={`Couldn't read ${PROVIDER_LABEL[provider]} history`} action={<Button size="sm" onClick={() => void load(provider)}>Try again</Button>}>
          {error}
        </EmptyState>
      ) : loading && !entries[provider] ? (
        <div className="flex items-center justify-center py-16 text-fg-3">
          <Spinner size={18} />
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={<IconHistory size={18} />} title={query ? 'Nothing matches that search' : `No ${PROVIDER_LABEL[provider]} conversations found`}>
          {query ? 'Try a different word or folder name.' : `Conversations you start in ${PROVIDER_LABEL[provider]} appear here automatically.`}
        </EmptyState>
      ) : (
        <Card>
          {list.slice(0, 300).map((e) => (
            <div key={e.nativeId} className="group/h flex min-h-[54px] items-center gap-3 border-b border-line px-4 py-2 last:border-b-0 hover:bg-hover" data-testid="history-row">
              <ProviderLogo provider={e.provider} size={14} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{e.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-fg-3">
                  <span className="truncate" title={e.cwd}>
                    {projectName(e.cwd || '~')}
                  </span>
                  <span>·</span>
                  <span>{timeAgo(e.updatedAt)}</span>
                  {e.model && (
                    <>
                      <span>·</span>
                      <span>{shortModel(e.model)}</span>
                    </>
                  )}
                </div>
              </div>
              {e.importedThreadId && (
                <Chip tone="ok">
                  <IconCheck size={10} /> In Duet
                </Chip>
              )}
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void open(e, otherProvider(e.provider))} className="opacity-0 group-hover/h:opacity-100 focus:opacity-100" icon={<ProviderLogo provider={otherProvider(e.provider)} size={12} />}>
                  Continue in {PROVIDER_LABEL[otherProvider(e.provider)]}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void open(e)} icon={busy === e.nativeId ? <Spinner size={12} /> : <IconArrowRight size={13} />} data-testid="history-open">
                  Open
                </Button>
              </div>
            </div>
          ))}
          {list.length > 300 && <div className="px-4 py-3 text-[12px] text-fg-3">Showing the 300 most recent. Search to find older ones.</div>}
        </Card>
      )}
    </Page>
  )
}
