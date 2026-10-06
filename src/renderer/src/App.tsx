import { useEffect } from 'react'
import { duet } from '@/lib/api'
import { goHome, onCommand, openBrowser, saveSettings, setView, switchProvider, togglePanel, useApp } from '@/state/store'
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
import { CommandPalette, Lightbox, Onboarding, Toasts } from './components/overlays'
import { IconDiff, IconGlobe, IconX } from './components/icons'
import { EmptyState, IconButton } from './components/ui/primitives'

function MainView() {
  const view = useApp((s) => s.view)
  const meta = useApp((s) => (s.currentId ? s.threads[s.currentId] : undefined))
  switch (view) {
    case 'thread':
      return meta ? <ThreadView meta={meta} /> : <HomeView />
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
    <div className="relative flex h-full shrink-0 flex-col border-l border-line" style={{ width }} data-testid="right-panel">
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

  useEffect(() => {
    onCommand((name) => {
      switch (name) {
        case 'new-thread':
          goHome()
          break
        case 'open-project':
          void duet.app.pickFolder().then(async (dir) => {
            if (!dir) return
            const s = useApp.getState().settings
            if (s && !s.projects.includes(dir)) await saveSettings({ projects: [dir, ...s.projects] })
            goHome(dir)
          })
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
    <div className="flex h-full w-full overflow-hidden bg-bg text-fg">
      {sidebarOpen && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <MainView />
        </div>
        {terminalOpen && <TerminalDrawer cwd={terminalCwd} />}
      </main>
      <RightPanel />
      <CommandPalette />
      <Lightbox />
      <Toasts />
      <Onboarding />
    </div>
  )
}
