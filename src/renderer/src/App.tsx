import { useEffect, useState } from 'react'
import { duet } from '@/lib/api'
import { addProject, goHome, onCommand, openBrowser, setView, switchProvider, togglePanel, useApp } from '@/state/store'
import { BackgroundEffect } from './components/BackgroundEffect'
import { UsageView } from './components/views/UsageView'
import { CustomizeView } from './components/views/CustomizeView'
import { Sidebar } from './components/Sidebar'
import { ThreadView } from './components/ThreadView'
import { HomeView } from './components/views/HomeView'
import { HistoryView } from './components/views/HistoryView'
import { McpView } from './components/views/McpView'
import { SyncView } from './components/views/SyncView'
import { BackupsView } from './components/views/BackupsView'
import { SettingsView } from './components/views/SettingsView'
import { BrowserPanel } from './components/panels/BrowserPanel'
import { ChangesPanel } from './components/panels/ChangesPanel'
import { TerminalDrawer } from './components/panels/TerminalDrawer'
import { CommandPalette, Lightbox, Toasts } from './components/overlays'
import { Onboarding } from './components/Onboarding'
import { IconDiff, IconGlobe, IconX } from './components/icons'
import { EmptyState, IconButton } from './components/ui/primitives'

function MainView() {
  const view = useApp((s) => s.view)
  const meta = useApp((s) => (s.currentId ? s.threads[s.currentId] : undefined))
  switch (view) {
    case 'thread':
      // Keyed so nothing typed, picked or in flight in one thread's composer shows up in another.
      return meta ? <ThreadView key={meta.id} meta={meta} /> : <HomeView />
    case 'history':
      return <HistoryView />
    case 'mcp':
      return <McpView />
    case 'sync':
      return <SyncView />
    case 'backups':
      return <BackupsView />
    case 'settings':
      return <SettingsView />
    case 'usage':
      return <UsageView />
    case 'customize':
      return <CustomizeView />
    default:
      return <HomeView />
  }
}

function RightPanel() {
  const panel = useApp((s) => s.rightPanel)
  const width = useApp((s) => s.rightWidth)
  const cwd = useApp((s) => (s.view === 'thread' && s.currentId ? s.threads[s.currentId]?.cwd : s.homeProject) ?? null)
  if (!panel) return null
  return (
    <div className="relative z-[1] flex h-full shrink-0 flex-col border-l border-line bg-panel" style={{ width }} data-testid="right-panel">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        className="absolute -left-[3px] top-0 z-20 h-full w-[6px] cursor-col-resize hover:bg-accent/30"
        onMouseDown={(e) => {
          e.preventDefault()
          const startX = e.clientX
          const startW = useApp.getState().rightWidth
          // Webviews swallow mouse events; block them while dragging.
          document.querySelectorAll('webview').forEach((w) => ((w as HTMLElement).style.pointerEvents = 'none'))
          const move = (ev: MouseEvent) => useApp.setState({ rightWidth: Math.min(window.innerWidth * 0.7, Math.max(320, startW - (ev.clientX - startX))) })
          const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            document.body.style.cursor = ''
            document.querySelectorAll('webview').forEach((w) => ((w as HTMLElement).style.pointerEvents = ''))
          }
          document.body.style.cursor = 'col-resize'
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
      />
      <div className="drag flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-2">
        <button type="button" onClick={() => togglePanel('browser')} className={`press flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] ${panel === 'browser' ? 'bg-active text-fg' : 'text-fg-3 hover:text-fg-2'}`}>
          <IconGlobe size={14} /> Browser
        </button>
        <button type="button" onClick={() => togglePanel('changes')} className={`press flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] ${panel === 'changes' ? 'bg-active text-fg' : 'text-fg-3 hover:text-fg-2'}`}>
          <IconDiff size={14} /> Changes
        </button>
        <div className="ml-auto">
          <IconButton label="Close panel" onClick={() => useApp.setState({ rightPanel: null })}>
            <IconX size={14} />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {panel === 'browser' ? (
          <BrowserPanel />
        ) : cwd ? (
          <ChangesPanel cwd={cwd} />
        ) : (
          <EmptyState icon={<IconDiff size={18} />} title="No project selected">
            Open a thread or pick a project to see its changes.
          </EmptyState>
        )}
      </div>
    </div>
  )
}

export function App() {
  const ready = useApp((s) => s.ready)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const terminalOpen = useApp((s) => s.terminalOpen)
  const terminalCwd = useApp((s) => (s.view === 'thread' && s.currentId ? s.threads[s.currentId]?.cwd : s.homeProject) ?? s.info.home)
  // Once opened, the terminal stays mounted (just hidden), so closing the panel never kills shells.
  const [terminalUsed, setTerminalUsed] = useState(false)
  if (terminalOpen && !terminalUsed) setTerminalUsed(true)

  useEffect(() => {
    onCommand((name) => {
      switch (name) {
        case 'new-thread':
          goHome()
          break
        case 'open-project':
          void addProject()
          break
        case 'palette':
          useApp.setState((s) => ({ paletteOpen: !s.paletteOpen }))
          break
        case 'toggle-sidebar':
          useApp.setState((s) => ({ sidebarOpen: !s.sidebarOpen }))
          break
        case 'toggle-browser':
          togglePanel('browser')
          break
        case 'toggle-terminal':
          useApp.setState((s) => ({ terminalOpen: !s.terminalOpen }))
          break
      }
    })
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'k' && !e.shiftKey) {
        e.preventDefault()
        useApp.setState((s) => ({ paletteOpen: !s.paletteOpen }))
      } else if (key === 'b' && !e.shiftKey) {
        e.preventDefault()
        useApp.setState((s) => ({ sidebarOpen: !s.sidebarOpen }))
      } else if (key === 'b' && e.shiftKey) {
        e.preventDefault()
        const s = useApp.getState()
        if (s.rightPanel === 'browser') useApp.setState({ rightPanel: null })
        else openBrowser()
      } else if (key === 'd' && e.shiftKey) {
        e.preventDefault()
        togglePanel('changes')
      } else if (key === 'j' && !e.shiftKey) {
        e.preventDefault()
        useApp.setState((s) => ({ terminalOpen: !s.terminalOpen }))
      } else if ((key === '1' || key === '2') && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        void switchProvider(key === '1' ? 'claude' : 'codex')
      } else if (key === 'n' && !e.shiftKey) {
        // Fallback when the menu accelerator didn't fire (e.g. focus inside a webview popup).
        e.preventDefault()
        goHome()
      } else if (key === ',') {
        e.preventDefault()
        setView('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) {
    return <div className="h-full w-full bg-bg" />
  }
  return (
    <div
      className="relative flex h-full w-full overflow-hidden text-fg"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        // A folder dropped anywhere outside the message box becomes a project with a new chat.
        if (e.defaultPrevented) return
        const file = e.dataTransfer.files[0]
        if (!file) return
        e.preventDefault()
        const path = duet.util.pathForFile(file)
        if (path) void duet.app.isFolder(path).then((folder) => (folder ? addProject(path) : undefined))
      }}
    >
      <BackgroundEffect />
      {sidebarOpen && <Sidebar />}
      <main className="relative z-[1] flex min-w-0 flex-1 flex-col bg-panel">
        <div className="flex min-h-0 flex-1">
          <MainView />
        </div>
        {terminalUsed && <TerminalDrawer cwd={terminalCwd} open={terminalOpen} />}
      </main>
      <RightPanel />
      <CommandPalette />
      <Lightbox />
      <Toasts />
      <Onboarding />
    </div>
  )
}
