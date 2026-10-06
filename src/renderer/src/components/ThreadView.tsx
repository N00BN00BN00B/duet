import { useEffect, useRef, useState } from 'react'
import type { GitStatus, ThreadMeta } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { duet } from '@/lib/api'
import { formatCost, projectName, tildify } from '@/lib/format'
import { copyMarkdown, forkThread, togglePanel, updateThread, useApp } from '@/state/store'
import { ProviderLogo } from './brand'
import { Composer } from './composer/Composer'
import { Timeline } from './timeline/Timeline'
import { IconBranch, IconCopy, IconDiff, IconFolder, IconForkThread, IconGlobe, IconMore, IconSidebar, IconTerminal, Spinner } from './icons'
import { MenuItem, Popover, useMenuKeys } from './ui/Popover'
import { IconButton } from './ui/primitives'

function useBranch(cwd: string, status: ThreadMeta['status']): GitStatus | null {
  const [git, setGit] = useState<GitStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    duet.git
      .status(cwd)
      .then((g) => !cancelled && setGit(g))
      .catch(() => !cancelled && setGit(null))
    return () => {
      cancelled = true
    }
  }, [cwd, status])
  return git
}

export function ThreadHeader({ meta }: { meta: ThreadMeta }) {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const rightPanel = useApp((s) => s.rightPanel)
  const terminalOpen = useApp((s) => s.terminalOpen)
  const home = useApp((s) => s.info.home)
  const git = useBranch(meta.cwd, meta.status)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const keys = useMenuKeys()
  const changed = git?.files.length ?? 0
  return (
    <header className={`drag flex h-[52px] shrink-0 items-center gap-2 border-b border-line pr-3 ${sidebarOpen ? 'pl-4' : 'pl-[84px]'}`}>
      {!sidebarOpen && (
        <IconButton label="Show sidebar" shortcut="⌘B" onClick={() => useApp.setState({ sidebarOpen: true })}>
          <IconSidebar size={16} />
        </IconButton>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {editing ? (
          <input
            autoFocus
            defaultValue={meta.title}
            className="no-drag h-7 min-w-0 max-w-md flex-1 rounded-md border border-line-strong bg-surface-2 px-2 text-[13.5px] font-medium outline-none"
            onBlur={(e) => {
              setEditing(false)
              if (e.target.value.trim() && e.target.value !== meta.title) void updateThread(meta.id, { title: e.target.value })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <h1 className="no-drag min-w-0 truncate text-[13.5px] font-medium" onDoubleClick={() => setEditing(true)} title="Double-click to rename" data-testid="thread-title">
            {meta.title}
          </h1>
        )}
        {(meta.status === 'running' || meta.status === 'approval') && (
          <span className="flex items-center gap-1.5 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
            <Spinner size={10} />
            {meta.status === 'approval' ? 'Needs approval' : `${PROVIDER_LABEL[meta.provider]} working`}
          </span>
        )}
        <button type="button" onClick={() => void duet.app.reveal(meta.cwd)} className="no-drag press hidden min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-fg-3 hover:bg-hover hover:text-fg-2 md:flex" title={tildify(meta.cwd, home)}>
          <IconFolder size={12} />
          <span className="truncate">{projectName(meta.cwd)}</span>
        </button>
        {git?.isRepo && git.branch && (
          <span className="hidden min-w-0 items-center gap-1 text-[12px] text-fg-3 lg:flex" title={`${git.branch}${git.ahead ? ` · ${git.ahead} ahead` : ''}${git.behind ? ` · ${git.behind} behind` : ''}`}>
            <IconBranch size={12} />
            <span className="truncate">{git.branch}</span>
          </span>
        )}
      </div>
      {meta.costUsd ? <span className="hidden text-[11.5px] tabular-nums text-fg-3 xl:block">{formatCost(meta.costUsd)}</span> : null}
      <div className="flex items-center gap-0.5">
        <IconButton label="Browser" shortcut="⌘⇧B" active={rightPanel === 'browser'} onClick={() => togglePanel('browser')} data-testid="toggle-browser">
          <IconGlobe size={16} />
        </IconButton>
        <IconButton label={changed ? `Changes (${changed} files)` : 'Changes'} shortcut="⌘⇧D" active={rightPanel === 'changes'} onClick={() => togglePanel('changes')} data-testid="toggle-changes">
          <span className="relative">
            <IconDiff size={16} />
            {changed > 0 && <span className="absolute -right-1.5 -top-1 h-1.5 w-1.5 rounded-full bg-accent" />}
          </span>
        </IconButton>
        <IconButton label="Terminal" shortcut="⌘J" active={terminalOpen} onClick={() => useApp.setState((s) => ({ terminalOpen: !s.terminalOpen }))} data-testid="toggle-terminal">
          <IconTerminal size={16} />
        </IconButton>
        <div ref={anchor}>
          <IconButton label="More" onClick={() => setMenu((v) => !v)}>
            <IconMore size={16} />
          </IconButton>
        </div>
        <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} placement="bottom-end" width={220}>
          <div className="p-1" onKeyDown={keys} onClick={() => setMenu(false)}>
            <MenuItem icon={<IconForkThread size={14} />} onSelect={() => void forkThread(meta.id)}>
              Fork thread
            </MenuItem>
            <MenuItem icon={<IconCopy size={14} />} onSelect={() => void copyMarkdown(meta.id)}>
              Copy as Markdown
            </MenuItem>
            <MenuItem icon={<IconFolder size={14} />} onSelect={() => void duet.app.reveal(meta.cwd)}>
              Show project in Finder
            </MenuItem>
          </div>
        </Popover>
      </div>
    </header>
  )
}

export function ThreadView({ meta }: { meta: ThreadMeta }) {
  const items = useApp((s) => s.items[meta.id])
  const focusNonce = useApp((s) => s.focusNonce)
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ThreadHeader meta={meta} />
      {items ? (
        <Timeline meta={meta} items={items} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-fg-3">
          <Spinner size={18} />
        </div>
      )}
      <div className="shrink-0 px-6 pb-4 pt-1">
        <div className="mx-auto w-full max-w-[var(--chat-width,760px)]">
          {items && items.length === 0 && meta.status === 'idle' && (
            <div className="mb-3 flex items-center justify-center gap-2 text-[12px] text-fg-3">
              <ProviderLogo provider={meta.provider} size={12} /> New chat with {PROVIDER_LABEL[meta.provider]} in {projectName(meta.cwd)}
            </div>
          )}
          <Composer mode="thread" meta={meta} autoFocusKey={focusNonce} />
        </div>
      </div>
    </div>
  )
}
