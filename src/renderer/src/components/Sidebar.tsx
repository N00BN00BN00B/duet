import { memo, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ProviderId, ThreadMeta } from '@shared/types'
import { PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { duet } from '@/lib/api'
import { projectName, resetsIn, timeAgo, tildify } from '@/lib/format'
import { addProject, copyMarkdown, forkThread, goHome, openThread, removeThread, setView, updateThread, useApp, type View } from '@/state/store'
import { ProviderLogo } from './brand'
import {
  IconArchive,
  IconBackup,
  IconChevronRight,
  IconCopy,
  IconFolder,
  IconForkThread,
  IconGauge,
  IconHistory,
  IconMore,
  IconPalette,
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
import { Button, Dialog, IconButton, Tooltip, inputClass } from './ui/primitives'

function StatusGlyph({ meta }: { meta: ThreadMeta }) {
  if (meta.status === 'running') return <Spinner size={12} className="text-accent" />
  if (meta.status === 'approval') return <span className="breathe h-2 w-2 rounded-full bg-warn" title="Needs your approval" />
  if (meta.status === 'error') return <span className="h-2 w-2 rounded-full bg-bad" title="Stopped with an error" />
  if (meta.unread) return <span className="h-2 w-2 rounded-full bg-accent" title="New reply" />
  return null
}

const ThreadRow = memo(function ThreadRow({ meta, active, agentNames }: { meta: ThreadMeta; active: boolean; agentNames: boolean }) {
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
          title={meta.title}
          className={`press group/row flex h-[30px] w-full items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-left text-[13px] ${active ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'}`}
        >
          <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" title={others.length ? 'Used with both agents' : PROVIDER_LABEL[meta.provider]}>
            <ProviderLogo provider={meta.provider} size={12} className={active ? '' : 'opacity-75 grayscale-[35%]'} />
            {others.length > 0 && (
              <span className="absolute -bottom-[3px] -right-[4px] flex h-[10px] w-[10px] items-center justify-center rounded-full bg-sidebar ring-1 ring-line-strong">
                <ProviderLogo provider={others[0]} size={7} className="opacity-90" />
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {agentNames && <span className="text-fg-3">{PROVIDER_LABEL[meta.provider]} · </span>}
            {meta.title}
          </span>
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

const PAGE = 6

function Group({ title, tooltip, threads, currentId, agentNames, onNew, defaultCollapsed = false }: { title: string; tooltip?: string; threads: ThreadMeta[]; currentId: string | null; agentNames: boolean; onNew?: () => void; defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [limit, setLimit] = useState(PAGE)
  // The open chat always stays visible, even when it is old.
  const activeIndex = threads.findIndex((t) => t.id === currentId)
  const visible = threads.slice(0, Math.max(limit, activeIndex + 1))
  return (
    <div className="mb-2" data-testid="sidebar-group">
      <div className="group/proj flex h-7 items-center gap-1 pr-1">
        <button type="button" onClick={() => setCollapsed((v) => !v)} className="press flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2.5 py-0.5 text-left text-[12px] font-medium text-fg-3 hover:text-fg-2" title={tooltip}>
          <span className="truncate">{title}</span>
          <IconChevronRight size={11} className={`shrink-0 opacity-0 transition-[transform,opacity] duration-200 group-hover/proj:opacity-100 ${collapsed ? '' : 'rotate-90'}`} />
        </button>
        {onNew && (
          <IconButton label={`New chat in ${title}`} size="sm" className="opacity-0 group-hover/proj:opacity-100 focus:opacity-100" onClick={onNew}>
            <IconPlus size={13} />
          </IconButton>
        )}
      </div>
      {!collapsed && (
        <div className="space-y-px">
          {visible.map((t) => (
            <ThreadRow key={t.id} meta={t} active={t.id === currentId} agentNames={agentNames} />
          ))}
          {threads.length === 0 && onNew && (
            <button type="button" onClick={onNew} className="press flex h-[30px] w-full items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg-2">
              <IconPlus size={12} /> New chat
            </button>
          )}
          {threads.length > visible.length && (
            <button type="button" onClick={() => setLimit((n) => n + 20)} className="press px-2.5 py-0.5 text-[11.5px] text-fg-3 hover:text-fg-2">
              Show {Math.min(20, threads.length - visible.length)} more
            </button>
          )}
          {limit > PAGE && threads.length <= visible.length && threads.length > PAGE && (
            <button type="button" onClick={() => setLimit(PAGE)} className="press px-2.5 py-0.5 text-[11.5px] text-fg-3 hover:text-fg-2">
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function NavItem({ view, icon, label, shortcut, onClick, active, testId }: { view?: View; icon: ReactNode; label: string; shortcut?: string; onClick?: () => void; active?: boolean; testId?: string }) {
  const current = useApp((s) => s.view)
  const isActive = active ?? (view ? current === view : false)
  return (
    <button
      type="button"
      onClick={onClick ?? (() => view && setView(view))}
      data-testid={testId ?? (view ? `nav-${view}` : undefined)}
      className={`press group/nav flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] ${isActive ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'}`}
    >
      <span className={`flex w-4 justify-center ${isActive ? 'text-fg' : 'text-fg-3 group-hover/nav:text-fg-2'}`}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {shortcut && <span className="text-[11px] text-fg-3">{shortcut}</span>}
    </button>
  )
}

/** One provider's status for the footer: logo plus a ring for the busiest usage window. */
function ProviderChip({ id }: { id: ProviderId }) {
  const st = useApp((s) => s.providers[id])
  const worst = st?.limits?.reduce<{ label: string; usedPercent: number; resetsAt?: number } | null>((max, l) => (!max || l.usedPercent > max.usedPercent ? l : max), null)
  const pct = worst?.usedPercent ?? 0
  const r = 7
  const c = 2 * Math.PI * r
  const tone = !st ? 'var(--text-3)' : !st.installed || st.loggedIn === false ? 'var(--bad)' : pct > 85 ? 'var(--bad)' : pct > 65 ? 'var(--warn)' : 'var(--accent)'
  const label = !st
    ? 'Checking…'
    : !st.installed
      ? 'Not installed — click to connect'
      : st.loggedIn === false
        ? 'Signed out — click to connect'
        : st.limits?.length
          ? st.limits.map((l) => `${l.label}: ${l.usedPercent}% ${resetsIn(l.resetsAt)}`).join(' · ')
          : `${st.plan ?? 'Connected'} · usage shows after the first reply`
  return (
    <Tooltip label={`${PROVIDER_LABEL[id]} — ${label}`} side="top">
      <button type="button" onClick={() => setView('usage')} className="press relative flex h-8 w-8 items-center justify-center rounded-lg hover:bg-hover" aria-label={`${PROVIDER_LABEL[id]} usage`} data-testid={`provider-chip-${id}`}>
        <svg width="24" height="24" viewBox="0 0 18 18" className="absolute">
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="1.6" />
          {st?.installed && st.loggedIn !== false && <circle cx="9" cy="9" r={r} fill="none" stroke={tone} strokeWidth="1.6" strokeLinecap="round" strokeDasharray={`${(Math.max(pct, 2) / 100) * c} ${c}`} transform="rotate(-90 9 9)" />}
        </svg>
        <ProviderLogo provider={id} size={11} className={st && (!st.installed || st.loggedIn === false) ? 'opacity-40' : ''} />
        {st && (!st.installed || st.loggedIn === false) && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-bad" />}
      </button>
    </Tooltip>
  )
}

export function Sidebar() {
  const threads = useApp((s) => s.threads)
  const currentId = useApp((s) => s.currentId)
  const view = useApp((s) => s.view)
  const width = useApp((s) => s.sidebarWidth)
  const settings = useApp((s) => s.settings)
  const home = useApp((s) => s.info.home)
  const chatsDir = useApp((s) => s.info.chatsDir)
  const moreOpen = useApp((s) => s.sidebarMoreOpen)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const agentNames = settings?.sidebarAgentNames ?? true

  const { pinned, groups, chats, archivedCount } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = Object.values(threads)
      .filter((t) => (showArchived ? t.archived : !t.archived))
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q) || (t.preview ?? '').toLowerCase().includes(q) || PROVIDER_LABEL[t.provider].toLowerCase() === q)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const pinned = showArchived ? [] : all.filter((t) => t.pinned)
    const rest = showArchived ? all : all.filter((t) => !t.pinned)
    const chats = rest.filter((t) => t.cwd === chatsDir)
    const byProject = new Map<string, ThreadMeta[]>()
    for (const t of rest) {
      if (t.cwd === chatsDir) continue
      const list = byProject.get(t.cwd) ?? []
      list.push(t)
      byProject.set(t.cwd, list)
    }
    // Keep explicitly added (empty) projects visible too.
    if (!q && !showArchived) for (const p of settings?.projects ?? []) if (!byProject.has(p) && p !== chatsDir) byProject.set(p, [])
    const groups = [...byProject.entries()].sort((a, b) => (b[1][0]?.updatedAt ?? 0) - (a[1][0]?.updatedAt ?? 0))
    const archivedCount = Object.values(threads).filter((t) => t.archived).length
    return { pinned, groups, chats, archivedCount }
  }, [threads, query, showArchived, settings?.projects, chatsDir])

  return (
    <aside className="relative z-[1] flex h-full shrink-0 flex-col border-r border-line bg-sidebar" style={{ width }} data-testid="sidebar">
      <div className="drag flex h-[52px] shrink-0 items-center justify-end gap-1 pl-[84px] pr-2.5">
        <IconButton label="Hide sidebar" shortcut="⌘B" onClick={() => useApp.setState({ sidebarOpen: false })}>
          <IconSidebar size={16} />
        </IconButton>
      </div>
      <div className="space-y-0.5 px-2 pb-2">
        <div className="mb-1.5 flex h-8 items-center gap-2 rounded-lg bg-hover px-2.5 ring-1 ring-transparent focus-within:ring-line-strong">
          <IconSearch size={13} className="shrink-0 text-fg-3" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-3" data-testid="thread-search" />
          {query ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-fg-3 hover:text-fg">
              <IconX size={12} />
            </button>
          ) : (
            <span className="text-[11px] text-fg-3">⌘K</span>
          )}
        </div>
        <NavItem icon={<IconPlus size={15} />} label="New chat" shortcut="⌘N" onClick={() => goHome()} active={view === 'home'} testId="new-thread" />
        <NavItem view="usage" icon={<IconGauge size={15} />} label="Usage" />
        <NavItem view="customize" icon={<IconPalette size={15} />} label="Customize" />
        <NavItem
          icon={<IconChevronRight size={13} className={`transition-transform duration-200 ${moreOpen ? 'rotate-90' : ''}`} />}
          label="More"
          active={false}
          onClick={() => useApp.setState((s) => ({ sidebarMoreOpen: !s.sidebarMoreOpen }))}
          testId="nav-more"
        />
        {moreOpen && (
          <div className="anim-fade space-y-0.5 pl-3">
            <NavItem view="history" icon={<IconHistory size={15} />} label="Chat history" />
            <NavItem view="mcp" icon={<IconPlug size={15} />} label="MCP servers" />
            <NavItem view="sync" icon={<IconSync size={15} />} label="Sync settings" />
            <NavItem view="backups" icon={<IconBackup size={15} />} label="Backups" />
          </div>
        )}
      </div>
      <div className="scroll-y min-h-0 flex-1 px-2 pb-2 pt-1">
        {pinned.length > 0 && (
          <Group title="Pinned" threads={pinned} currentId={currentId} agentNames={agentNames} />
        )}
        {groups.map(([path, list]) => (
          <Group key={path} title={projectName(path)} tooltip={tildify(path, home)} threads={list} currentId={currentId} agentNames={agentNames} onNew={() => goHome(path)} />
        ))}
        {chats.length > 0 && <Group title="Chats" tooltip="Chats without a project" threads={chats} currentId={currentId} agentNames={agentNames} onNew={() => goHome(chatsDir)} />}
        {groups.length === 0 && pinned.length === 0 && chats.length === 0 && (
          <div className="px-3 py-8 text-center text-[12px] leading-relaxed text-fg-3">{query ? 'No chats match.' : showArchived ? 'Nothing archived.' : 'Your chats will show up here.'}</div>
        )}
        <div className="mt-1 flex items-center gap-1 px-1">
          <button type="button" onClick={() => void addProject()} className="press flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-fg-3 hover:bg-hover hover:text-fg-2" data-testid="add-project">
            <IconFolder size={13} /> Add project
          </button>
          {(archivedCount > 0 || showArchived) && (
            <button type="button" onClick={() => setShowArchived((v) => !v)} className="press ml-auto flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-fg-3 hover:bg-hover hover:text-fg-2">
              <IconArchive size={13} /> {showArchived ? 'Back' : `Archived (${archivedCount})`}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5 border-t border-line px-2 py-1.5" data-testid="usage-meters">
        {PROVIDERS.map((p) => (
          <ProviderChip key={p} id={p} />
        ))}
        <div className="ml-auto">
          <IconButton label="Settings" shortcut="⌘," onClick={() => setView('settings')} active={view === 'settings'} data-testid="nav-settings">
            <IconSettings size={16} />
          </IconButton>
        </div>
      </div>
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
