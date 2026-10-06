import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PROVIDER_LABEL } from '@shared/types'
import { duet } from '@/lib/api'
import { projectName, timeAgo } from '@/lib/format'
import { dismissToast, goHome, openBrowser, openThread, setView, switchProvider, togglePanel, useApp } from '@/state/store'
import { ProviderLogo } from './brand'
import { IconBackup, IconCheck, IconDiff, IconGlobe, IconHistory, IconInfo, IconPlug, IconPlus, IconSearch, IconSettings, IconSidebar, IconSync, IconTerminal, IconWarning, IconX } from './icons'

interface PaletteItem {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  run: () => void
  group: string
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen)
  const threads = useApp((s) => s.threads)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
    }
  }, [open])

  const close = () => useApp.setState({ paletteOpen: false })

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: 'new', group: 'Actions', label: 'New thread', hint: '⌘N', icon: <IconPlus size={15} />, run: () => goHome() },
      { id: 'claude', group: 'Actions', label: 'Switch to Claude', hint: '⌘1', icon: <ProviderLogo provider="claude" size={14} />, run: () => void switchProvider('claude') },
      { id: 'codex', group: 'Actions', label: 'Switch to Codex', hint: '⌘2', icon: <ProviderLogo provider="codex" size={14} />, run: () => void switchProvider('codex') },
      { id: 'browser', group: 'Actions', label: 'Open browser', hint: '⌘⇧B', icon: <IconGlobe size={15} />, run: () => openBrowser() },
      { id: 'changes', group: 'Actions', label: 'Show changes', hint: '⌘⇧D', icon: <IconDiff size={15} />, run: () => togglePanel('changes') },
      { id: 'terminal', group: 'Actions', label: 'Toggle terminal', hint: '⌘J', icon: <IconTerminal size={15} />, run: () => useApp.setState((s) => ({ terminalOpen: !s.terminalOpen })) },
      { id: 'sidebar', group: 'Actions', label: 'Toggle sidebar', hint: '⌘B', icon: <IconSidebar size={15} />, run: () => useApp.setState((s) => ({ sidebarOpen: !s.sidebarOpen })) },
      { id: 'history', group: 'Go to', label: 'History — import Claude & Codex chats', icon: <IconHistory size={15} />, run: () => setView('history') },
      { id: 'mcp', group: 'Go to', label: 'MCP servers', icon: <IconPlug size={15} />, run: () => setView('mcp') },
      { id: 'sync', group: 'Go to', label: 'Sync Claude ⇄ Codex', icon: <IconSync size={15} />, run: () => setView('sync') },
      { id: 'backups', group: 'Go to', label: 'Backups', icon: <IconBackup size={15} />, run: () => setView('backups') },
      { id: 'settings', group: 'Go to', label: 'Settings', hint: '⌘,', icon: <IconSettings size={15} />, run: () => setView('settings') }
    ]
    const threadItems: PaletteItem[] = Object.values(threads)
      .filter((t) => !t.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map((t) => ({
        id: `t-${t.id}`,
        group: 'Threads',
        label: t.title,
        hint: `${projectName(t.cwd)} · ${timeAgo(t.updatedAt)}`,
        icon: <ProviderLogo provider={t.provider} size={13} />,
        run: () => void openThread(t.id)
      }))
    const q = query.trim().toLowerCase()
    const all = [...actions, ...threadItems]
    if (!q) return [...actions, ...threadItems.slice(0, 8)]
    return all.filter((i) => i.label.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q)).slice(0, 60)
  }, [threads, query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null
  let lastGroup = ''
  return createPortal(
    <div className="anim-fade fixed inset-0 z-[75] flex items-start justify-center bg-black/35 pt-[14vh]" onMouseDown={(e) => e.target === e.currentTarget && close()} data-testid="palette">
      <div className="anim-pop w-[560px] max-w-[92vw] overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[var(--pop-shadow)]">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <IconSearch size={15} className="text-fg-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(items.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const item = items[index]
                if (item) {
                  close()
                  item.run()
                }
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
            placeholder="Search threads and actions"
            className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-3"
          />
        </div>
        <div ref={listRef} className="scroll-y max-h-[50vh] p-1.5">
          {items.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-fg-3">No matches</div>}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-fg-3">{header}</div>}
                <div
                  data-index={i}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => {
                    close()
                    item.run()
                  }}
                  className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] ${i === index ? 'bg-hover text-fg' : 'text-fg-2'}`}
                >
                  <span className="flex h-4 w-4 items-center justify-center text-fg-3">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 truncate text-[11.5px] text-fg-3">{item.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[360px] max-w-[90vw] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="anim-toast pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-[12.5px] leading-relaxed shadow-[var(--pop-shadow)]" role="status">
          <span className="mt-[2px] shrink-0">{t.level === 'error' ? <IconWarning size={14} className="text-bad" /> : t.level === 'success' ? <IconCheck size={14} className="text-ok" /> : <IconInfo size={14} className="text-info" />}</span>
          <span className="selectable min-w-0 flex-1 break-words">{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="shrink-0 text-fg-3 hover:text-fg">
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}

export function Lightbox() {
  const path = useApp((s) => s.lightbox)
  useEffect(() => {
    if (!path) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useApp.setState({ lightbox: null })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [path])
  if (!path) return null
  return createPortal(
    <div className="anim-fade fixed inset-0 z-[85] flex items-center justify-center bg-black/80 p-10" onClick={() => useApp.setState({ lightbox: null })}>
      <img src={duet.util.fileUrl(path)} alt="" className="anim-pop max-h-full max-w-full rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()} />
      <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-[12px] text-white/80">
        <span className="max-w-[50vw] truncate">{path.split('/').pop()}</span>
        <button type="button" className="text-white/70 hover:text-white" onClick={(e) => (e.stopPropagation(), void duet.app.reveal(path))}>
          Show in Finder
        </button>
      </div>
    </div>,
    document.body
  )
}

export function Onboarding() {
  const settings = useApp((s) => s.settings)
  const providers = useApp((s) => s.providers)
  if (!settings || settings.onboarded) return null
  return createPortal(
    <div className="anim-fade fixed inset-0 z-[72] flex items-center justify-center bg-black/50 p-6 backdrop-blur-[2px]">
      <div className="anim-pop w-[520px] max-w-full rounded-2xl border border-line-strong bg-surface p-6 shadow-[var(--pop-shadow)]">
        <h2 className="text-[18px] font-semibold tracking-[-0.01em]">Welcome to Duet</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-2">
          Duet runs Claude Code and Codex — the ones already on your Mac, with your own subscriptions — in one window. Start a thread with either agent and switch any time; the other one picks up the conversation where it left off.
        </p>
        <div className="mt-4 space-y-2">
          {(['claude', 'codex'] as const).map((p) => {
            const st = providers[p]
            return (
              <div key={p} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
                <ProviderLogo provider={p} size={16} />
                <span className="flex-1 text-[13px] font-medium">{PROVIDER_LABEL[p]}</span>
                <span className={`text-[12px] ${!st ? 'text-fg-3' : st.installed ? (st.loggedIn === false ? 'text-warn' : 'text-ok') : 'text-bad'}`}>
                  {!st ? 'Checking…' : !st.installed ? 'Not found — see Settings' : st.loggedIn === false ? 'Installed · signed out' : `Ready${st.version ? ` · ${/^\d/.test(st.version) ? 'v' : ''}${st.version}` : ''}`}
                </span>
              </div>
            )
          })}
        </div>
        <ul className="mt-4 space-y-1.5 text-[12.5px] text-fg-2">
          <li>• History imports every Claude and Codex conversation you already have.</li>
          <li>• MCP and Sync keep both agents set up the same way.</li>
          <li>• Backups snapshot all of it into one archive.</li>
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              void duet.settings.update({ onboarded: true }).then((s) => useApp.setState({ settings: s }))
              setView('history')
            }}
            className="press h-8 rounded-lg px-3.5 text-[13px] font-medium text-fg-2 hover:bg-hover hover:text-fg"
          >
            Import my history
          </button>
          <button type="button" onClick={() => void duet.settings.update({ onboarded: true }).then((s) => useApp.setState({ settings: s }))} className="press h-8 rounded-lg bg-accent px-3.5 text-[13px] font-medium text-white hover:brightness-110" data-testid="onboarding-start">
            Start building
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
