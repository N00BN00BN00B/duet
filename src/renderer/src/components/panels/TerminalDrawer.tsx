import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { duet, terminalBus } from '@/lib/api'
import { projectName } from '@/lib/format'
import { toastError, useApp } from '@/state/store'
import { IconPlus, IconTerminal, IconX } from '../icons'
import { IconButton } from '../ui/primitives'

interface Tab {
  key: number
  cwd: string
  title: string
  /** Command to type once the shell is ready (e.g. `codex login`). */
  run?: string
}

function themeFor(dark: boolean) {
  return dark
    ? {
        background: '#0d0d10',
        foreground: '#e6e6ea',
        cursor: '#e6e6ea',
        cursorAccent: '#0d0d10',
        selectionBackground: 'rgba(124,140,255,0.35)',
        black: '#1d1f21',
        red: '#f87171',
        green: '#86efac',
        yellow: '#fcd34d',
        blue: '#93a5ff',
        magenta: '#d8b4fe',
        cyan: '#67e8f9',
        white: '#d4d4d8',
        brightBlack: '#71717a',
        brightRed: '#fca5a5',
        brightGreen: '#bbf7d0',
        brightYellow: '#fde68a',
        brightBlue: '#c7d2fe',
        brightMagenta: '#e9d5ff',
        brightCyan: '#a5f3fc',
        brightWhite: '#fafafa'
      }
    : {
        background: '#fafafa',
        foreground: '#18181b',
        cursor: '#18181b',
        cursorAccent: '#fafafa',
        selectionBackground: 'rgba(217,119,87,0.25)',
        black: '#18181b',
        red: '#dc2626',
        green: '#15803d',
        yellow: '#a16207',
        blue: '#2563eb',
        magenta: '#9333ea',
        cyan: '#0e7490',
        white: '#52525b',
        brightBlack: '#71717a',
        brightRed: '#ef4444',
        brightGreen: '#16a34a',
        brightYellow: '#ca8a04',
        brightBlue: '#3b82f6',
        brightMagenta: '#a855f7',
        brightCyan: '#0891b2',
        brightWhite: '#27272a'
      }
}

function TerminalPane({ tab, active }: { tab: Tab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const [exited, setExited] = useState<number | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const dark = document.documentElement.dataset.theme !== 'light'
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: false,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: themeFor(dark)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => void duet.app.openExternal(uri)))
    term.open(el)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      // not visible yet
    }
    let disposed = false
    const offs: (() => void)[] = []
    duet.terminal
      .create(tab.cwd, term.cols, term.rows)
      .then((id) => {
        if (disposed) {
          void duet.terminal.kill(id)
          return
        }
        idRef.current = id
        offs.push(terminalBus.onData(id, (data) => term.write(data)))
        offs.push(terminalBus.onExit(id, (code) => setExited(code)))
        if (tab.run) setTimeout(() => void duet.terminal.write(id, `${tab.run}\r`), 400)
      })
      .catch((error) => {
        term.write(`\r\n\x1b[31mCould not start a shell: ${String(error?.message ?? error)}\x1b[0m\r\n`)
        toastError(error)
      })
    const sub = term.onData((data) => {
      if (idRef.current) void duet.terminal.write(idRef.current, data)
    })
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        if (idRef.current) void duet.terminal.resize(idRef.current, term.cols, term.rows)
      } catch {
        // hidden
      }
    })
    ro.observe(el)
    const themeObserver = new MutationObserver(() => {
      term.options.theme = themeFor(document.documentElement.dataset.theme !== 'light')
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      disposed = true
      ro.disconnect()
      themeObserver.disconnect()
      sub.dispose()
      offs.forEach((off) => off())
      if (idRef.current) void duet.terminal.kill(idRef.current)
      term.dispose()
    }
  }, [tab.cwd, tab.run])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
        } catch {
          // ignore
        }
        termRef.current?.focus()
      })
    }
  }, [active])

  return (
    <div className={`absolute inset-0 ${active ? 'visible' : 'invisible'}`}>
      <div ref={host} className="h-full w-full" />
      {exited !== null && <div className="absolute bottom-2 right-3 rounded-md bg-surface-3 px-2 py-1 text-[11px] text-fg-3">Shell exited ({exited})</div>}
    </div>
  )
}

let tabKey = 0
const pendingRuns: string[] = []

/** Opens the terminal drawer and runs a command in a new tab (used for `codex login` etc.). */
export function runInTerminal(command: string): void {
  pendingRuns.push(command)
  useApp.setState({ terminalOpen: true })
  window.dispatchEvent(new CustomEvent('duet:terminal-run'))
}

export function TerminalDrawer({ cwd }: { cwd: string }) {
  const height = useApp((s) => s.terminalHeight)
  const [tabs, setTabs] = useState<Tab[]>(() => [{ key: ++tabKey, cwd, title: projectName(cwd), run: pendingRuns.shift() }])
  const [active, setActive] = useState(tabs[0].key)

  useEffect(() => {
    const onRun = () => {
      const run = pendingRuns.shift()
      if (!run) return
      const tab = { key: ++tabKey, cwd, title: run.split(' ')[0], run }
      setTabs((t) => [...t, tab])
      setActive(tab.key)
    }
    window.addEventListener('duet:terminal-run', onRun)
    return () => window.removeEventListener('duet:terminal-run', onRun)
  }, [cwd])

  const close = (key: number) => {
    setTabs((list) => {
      const next = list.filter((t) => t.key !== key)
      if (!next.length) useApp.setState({ terminalOpen: false })
      else if (key === active) setActive(next[next.length - 1].key)
      return next
    })
  }

  return (
    <div className="relative flex shrink-0 flex-col border-t border-line bg-bg" style={{ height }} data-testid="terminal-drawer">
      <div
        className="absolute -top-[3px] left-0 right-0 z-10 h-[6px] cursor-row-resize hover:bg-accent/30"
        onMouseDown={(e) => {
          e.preventDefault()
          const startY = e.clientY
          const startH = useApp.getState().terminalHeight
          const move = (ev: MouseEvent) => useApp.setState({ terminalHeight: Math.min(window.innerHeight * 0.75, Math.max(140, startH - (ev.clientY - startY))) })
          const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            document.body.style.cursor = ''
          }
          document.body.style.cursor = 'row-resize'
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
      />
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        {tabs.map((t) => (
          <div key={t.key} className={`group/tab flex h-6 items-center gap-1.5 rounded-md pl-2 pr-1 text-[11.5px] ${t.key === active ? 'bg-active text-fg' : 'text-fg-3 hover:text-fg-2'}`}>
            <button type="button" onClick={() => setActive(t.key)} className="flex items-center gap-1.5">
              <IconTerminal size={12} />
              {t.title}
            </button>
            <button type="button" aria-label="Close terminal" onClick={() => close(t.key)} className="flex h-4 w-4 items-center justify-center rounded opacity-60 hover:bg-hover hover:opacity-100">
              <IconX size={10} />
            </button>
          </div>
        ))}
        <IconButton
          label="New terminal"
          size="sm"
          onClick={() => {
            const tab = { key: ++tabKey, cwd, title: projectName(cwd) }
            setTabs((list) => [...list, tab])
            setActive(tab.key)
          }}
        >
          <IconPlus size={13} />
        </IconButton>
        <div className="ml-auto">
          <IconButton label="Close panel" shortcut="⌘J" size="sm" onClick={() => useApp.setState({ terminalOpen: false })}>
            <IconX size={13} />
          </IconButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => (
          <TerminalPane key={t.key} tab={t} active={t.key === active} />
        ))}
      </div>
    </div>
  )
}
