import { memo, useMemo, useRef, useState } from 'react'
import type { ProviderId, ThreadMeta } from '@shared/types'
import { PROVIDERS } from '@shared/types'
import { duet } from '@/lib/api'
import { projectName, resetsIn, timeAgo, tildify } from '@/lib/format'
import { copyMarkdown, forkThread, goHome, openThread, removeThread, saveSettings, setView, updateThread, useApp, type View } from '@/state/store'
import { DuetMark, ProviderLogo } from './brand'
import {
  IconArchive,
  IconBackup,
  IconChevronRight,
  IconCopy,
  IconFolder,
  IconForkThread,
  IconHistory,
  IconMore,
  IconPencil,
  IconPin,
  IconPlug,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconSync,
  IconTrash,
  IconX,
  Spinner
} from './icons'
import { MenuItem, MenuSeparator, Popover, useMenuKeys } from './ui/Popover'
import { Dialog, Button, IconButton, Meter, Tooltip, inputClass } from './ui/primitives'

function StatusGlyph({ meta }: { meta: ThreadMeta }) {
  if (meta.status === 'running') return <Spinner size={12} className="text-accent" />
  if (meta.status === 'approval') return <span className="breathe h-2 w-2 rounded-full bg-warn" title="Needs your approval" />
  if (meta.status === 'error') return <span className="h-2 w-2 rounded-full bg-bad" title="Stopped with an error" />
  if (meta.unread) return <span className="h-2 w-2 rounded-full bg-accent" title="New reply" />
  return null
}

const ThreadRow = memo(function ThreadRow({ meta, active }: { meta: ThreadMeta; active: boolean }) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const keys = useMenuKeys()
  const glyph = StatusGlyph({ meta })
  const others = PROVIDERS.filter((p) => p !== meta.provider && meta.native[p])
  return (
    <div ref={anchor} className="relative" data-testid="thread-row" data-thread-id={meta.id}>
      {renaming ? (
        <input
          autoFocus
          defaultValue={meta.title}
          className={`${inputClass} h-7`}
          onBlur={(e) => {
            setRenaming(false)
            if (e.target.value.trim() && e.target.value !== meta.title) void updateThread(meta.id, { title: e.target.value })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => void openThread(meta.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu(true)
          }}
          onDoubleClick={() => setRenaming(true)}
          className={`press group/row flex h-[30px] w-full items-center gap-2 rounded-lg pl-2 pr-1.5 text-left text-[13px] ${active ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'}`}
        >
          <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" title={others.length ? 'Used with both agents' : undefined}>
            <ProviderLogo provider={meta.provider} size={12} className={active ? '' : 'opacity-80'} />
            {others.length > 0 && (
              <span className="absolute -bottom-[3px] -right-[4px] flex h-[10px] w-[10px] items-center justify-center rounded-full bg-sidebar ring-1 ring-line-strong">
                <ProviderLogo provider={others[0]} size={7} className="opacity-90" />
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{meta.title}</span>
          {meta.pinned && <IconPin size={11} className="shrink-0 text-fg-3" />}
          <span className="flex w-7 shrink-0 items-center justify-end">
            {glyph ?? <span className="text-[11px] tabular-nums text-fg-3 group-hover/row:hidden">{timeAgo(meta.updatedAt)}</span>}
            {!glyph && (
              <span
                role="button"
                tabIndex={-1}
                aria-label="Thread actions"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenu(true)
                }}
                className="hidden h-5 w-5 items-center justify-center rounded text-fg-3 hover:bg-hover hover:text-fg group-hover/row:flex"
              >
                <IconMore size={14} />
              </span>
            )}
          </span>
        </button>
      )}
      <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} placement="bottom-end" width={210}>
        <div className="p-1" onKeyDown={keys} onClick={() => setMenu(false)}>
          <MenuItem icon={<IconPencil size={14} />} onSelect={() => setRenaming(true)}>
            Rename
          </MenuItem>
          <MenuItem icon={<IconPin size={14} />} onSelect={() => void updateThread(meta.id, { pinned: !meta.pinned })}>
            {meta.pinned ? 'Unpin' : 'Pin to top'}
          </MenuItem>
          <MenuItem icon={<IconForkThread size={14} />} onSelect={() => void forkThread(meta.id)}>
            Fork thread
          </MenuItem>
          <MenuItem icon={<IconCopy size={14} />} onSelect={() => void copyMarkdown(meta.id)}>
            Copy as Markdown
          </MenuItem>
          <MenuItem icon={<IconFolder size={14} />} onSelect={() => void duet.app.reveal(meta.cwd)}>
            Show project in Finder
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<IconArchive size={14} />} onSelect={() => void updateThread(meta.id, { archived: !meta.archived })}>
            {meta.archived ? 'Unarchive' : 'Archive'}
          </MenuItem>
          <MenuItem icon={<IconTrash size={14} />} danger onSelect={() => setConfirmDelete(true)}>
            Delete…
          </MenuItem>
        </div>
      </Popover>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this thread?"
        description={`“${meta.title}” will be removed from Duet. The underlying Claude/Codex session files are not deleted.`}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              data-autofocus
              onClick={() => {
                setConfirmDelete(false)
                void removeThread(meta.id)
              }}
            >
              Delete thread
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
    </div>
  )
})

function ProjectGroup({ path, threads, currentId, home }: { path: string; threads: ThreadMeta[]; currentId: string | null; home: string }) {
  const [collapsed, setCollapsed] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? threads : threads.slice(0, 8)
  return (
    <div className="mb-2">
      <div className="group/proj flex h-7 items-center gap-1 pl-1 pr-1">
        <button type="button" onClick={() => setCollapsed((v) => !v)} className="press flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] font-medium text-fg-3 hover:text-fg-2" title={tildify(path, home)}>
          <IconChevronRight size={11} className={`shrink-0 transition-transform duration-200 ${collapsed ? '' : 'rotate-90'}`} />
          <span className="truncate">{projectName(path)}</span>
        </button>
        <IconButton label={`New thread in ${projectName(path)}`} size="sm" className="opacity-0 group-hover/proj:opacity-100 focus:opacity-100" onClick={() => goHome(path)}>
          <IconPlus size={13} />
        </IconButton>
      </div>
      {!collapsed && (
        <div className="space-y-px">
          {visible.map((t) => (
            <ThreadRow key={t.id} meta={t} active={t.id === currentId} />
          ))}
          {threads.length > 8 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="press ml-8 py-0.5 text-[11.5px] text-fg-3 hover:text-fg-2">
              {showAll ? 'Show less' : `Show ${threads.length - 8} more`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function UsageMeters() {
  const providers = useApp((s) => s.providers)
  return (
    <div className="space-y-2 px-3 pb-3 pt-1" data-testid="usage-meters">
      {PROVIDERS.map((p: ProviderId) => {
        const st = providers[p]
        const limit = st?.limits?.reduce<{ label: string; usedPercent: number; resetsAt?: number } | null>((max, l) => (!max || l.usedPercent > max.usedPercent ? l : max), null)
        return (
          <Tooltip key={p} label={st?.limits?.length ? st.limits.map((l) => `${l.label}: ${l.usedPercent}% ${resetsIn(l.resetsAt)}`).join(' · ') : st?.installed === false ? 'Not installed' : 'Usage appears after the first reply'}>
            <div className="flex items-center gap-2">
              <ProviderLogo provider={p} size={11} className={st?.installed === false ? 'opacity-40' : ''} />
              <div className="min-w-0 flex-1">
                <Meter value={limit?.usedPercent ?? 0} />
              </div>
              <span className="w-[54px] shrink-0 text-right text-[10.5px] tabular-nums text-fg-3">{limit ? `${limit.usedPercent}% ${limit.label === 'Weekly' ? 'wk' : limit.label === '5-hour' ? '5h' : ''}` : st?.installed === false ? 'missing' : '—'}</span>
            </div>
          </Tooltip>
        )
      })}
    </div>
  )
}

const NAV: { view: View; label: string; icon: React.ReactNode }[] = [
  { view: 'history', label: 'History', icon: <IconHistory size={15} /> },
  { view: 'mcp', label: 'MCP servers', icon: <IconPlug size={15} /> },
  { view: 'sync', label: 'Sync', icon: <IconSync size={15} /> },
  { view: 'backups', label: 'Backups', icon: <IconBackup size={15} /> },
  { view: 'settings', label: 'Settings', icon: <IconSettings size={15} /> }
]

export function Sidebar() {
  const threads = useApp((s) => s.threads)
  const currentId = useApp((s) => s.currentId)
  const view = useApp((s) => s.view)
  const width = useApp((s) => s.sidebarWidth)
  const settings = useApp((s) => s.settings)
  const home = useApp((s) => s.info.home)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const { pinned, groups, archivedCount } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = Object.values(threads)
      .filter((t) => (showArchived ? t.archived : !t.archived))
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q) || (t.preview ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const pinned = showArchived ? [] : all.filter((t) => t.pinned)
    const rest = showArchived ? all : all.filter((t) => !t.pinned)
    const byProject = new Map<string, ThreadMeta[]>()
    for (const t of rest) {
      const list = byProject.get(t.cwd) ?? []
      list.push(t)
      byProject.set(t.cwd, list)
    }
    // Keep explicitly added (empty) projects visible too.
    if (!q && !showArchived) for (const p of settings?.projects ?? []) if (!byProject.has(p)) byProject.set(p, [])
    const groups = [...byProject.entries()].sort((a, b) => (b[1][0]?.updatedAt ?? 0) - (a[1][0]?.updatedAt ?? 0))
    const archivedCount = Object.values(threads).filter((t) => t.archived).length
    return { pinned, groups, archivedCount }
  }, [threads, query, showArchived, settings?.projects])

  const addProject = async () => {
    const dir = await duet.app.pickFolder()
    if (!dir) return
    if (settings && !settings.projects.includes(dir)) await saveSettings({ projects: [dir, ...settings.projects] })
    goHome(dir)
  }

  return (
    <aside className="relative flex h-full shrink-0 flex-col border-r border-line bg-sidebar" style={{ width }} data-testid="sidebar">
      <div className="drag flex h-[52px] shrink-0 items-center justify-end gap-1 pl-[84px] pr-2.5">
        <IconButton label="Hide sidebar" shortcut="⌘B" onClick={() => useApp.setState({ sidebarOpen: false })}>
          <IconSidebar size={16} />
        </IconButton>
      </div>
      <div className="px-2.5 pb-2">
        <button
          type="button"
          onClick={() => goHome()}
          data-testid="new-thread"
          className={`press mb-2 flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium ${view === 'home' ? 'bg-active text-fg' : 'text-fg hover:bg-hover'}`}
        >
          <DuetMark size={17} />
          <span className="flex-1 text-left">New thread</span>
          <span className="text-[11px] text-fg-3">⌘N</span>
        </button>
        <div className="flex h-8 items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-2.5 focus-within:border-line-strong">
          <IconSearch size={13} className="shrink-0 text-fg-3" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search threads" className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-3" data-testid="thread-search" />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-fg-3 hover:text-fg">
              <IconX size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="scroll-y min-h-0 flex-1 px-2.5 pb-2">
        {pinned.length > 0 && (
          <div className="mb-3">
            <div className="px-2 pb-1 text-[12px] font-medium text-fg-3">Pinned</div>
            <div className="space-y-px">
              {pinned.map((t) => (
                <ThreadRow key={t.id} meta={t} active={t.id === currentId} />
              ))}
            </div>
          </div>
        )}
        {groups.map(([path, list]) => (
          <ProjectGroup key={path} path={path} threads={list} currentId={currentId} home={home} />
        ))}
        {groups.length === 0 && pinned.length === 0 && (
          <div className="px-3 py-8 text-center text-[12px] leading-relaxed text-fg-3">{query ? 'No threads match.' : showArchived ? 'Nothing archived.' : 'Your threads will show up here.'}</div>
        )}
        <div className="mt-1 flex items-center gap-1 px-1">
          <button type="button" onClick={() => void addProject()} className="press flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-fg-3 hover:bg-hover hover:text-fg-2">
            <IconFolder size={13} /> Add project
          </button>
          {(archivedCount > 0 || showArchived) && (
            <button type="button" onClick={() => setShowArchived((v) => !v)} className="press ml-auto flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-fg-3 hover:bg-hover hover:text-fg-2">
              <IconArchive size={13} /> {showArchived ? 'Back' : `Archived (${archivedCount})`}
            </button>
          )}
        </div>
      </div>
      <nav className="border-t border-line px-2.5 py-2">
        {NAV.map((n) => (
          <button
            key={n.view}
            type="button"
            onClick={() => setView(n.view)}
            data-testid={`nav-${n.view}`}
            className={`press flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-[13px] ${view === n.view ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'}`}
          >
            <span className="text-fg-3">{n.icon}</span>
            {n.label}
          </button>
        ))}
      </nav>
      <UsageMeters />
      <SidebarResizer />
    </aside>
  )
}

function SidebarResizer() {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      className="absolute -right-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize hover:bg-accent/30"
      onMouseDown={(e) => {
        e.preventDefault()
        const startX = e.clientX
        const startW = useApp.getState().sidebarWidth
        const move = (ev: MouseEvent) => useApp.setState({ sidebarWidth: Math.min(420, Math.max(220, startW + ev.clientX - startX)) })
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          document.body.style.cursor = ''
        }
        document.body.style.cursor = 'col-resize'
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
    />
  )
}

