import { useMemo } from 'react'
import type { ProviderId } from '@shared/types'
import { PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { duet } from '@/lib/api'
import { projectName, timeAgo } from '@/lib/format'
import { openThread, saveSettings, setView, useApp } from '@/state/store'
import { DuetMark, ProviderLogo } from '../brand'
import { Composer } from '../composer/Composer'
import { IconArrowRight, IconSidebar, IconWarning } from '../icons'
import { IconButton } from '../ui/primitives'

function AgentStatusPill({ id }: { id: ProviderId }) {
  const st = useApp((s) => s.providers[id])
  const tone = !st ? 'text-fg-3' : !st.installed ? 'text-bad' : st.loggedIn === false || st.error ? 'text-warn' : 'text-ok'
  const text = !st ? 'Checking…' : !st.installed ? 'Not installed' : st.loggedIn === false ? 'Signed out' : st.plan ? st.plan.replace(/^\w/, (c) => c.toUpperCase()) : 'Ready'
  return (
    <button type="button" onClick={() => setView('settings')} className="press flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 text-[12px] hover:border-line-strong" title={st?.error}>
      <ProviderLogo provider={id} size={13} />
      <span className="text-fg-2">{PROVIDER_LABEL[id]}</span>
      <span className={`flex items-center gap-1 ${tone}`}>
        {st && (!st.installed || st.error) ? <IconWarning size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
        {text}
      </span>
      {st?.version && <span className="text-fg-3">v{st.version}</span>}
    </button>
  )
}

export function HomeView() {
  const project = useApp((s) => s.homeProject)
  const provider = useApp((s) => s.homeProvider)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const threads = useApp((s) => s.threads)
  const settings = useApp((s) => s.settings)
  const focusNonce = useApp((s) => s.focusNonce)
  const recent = useMemo(
    () =>
      Object.values(threads)
        .filter((t) => !t.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4),
    [threads]
  )

  const pickProject = async (): Promise<string | null> => {
    const dir = await duet.app.pickFolder()
    if (!dir) return null
    useApp.setState({ homeProject: dir })
    if (settings && !settings.projects.includes(dir)) await saveSettings({ projects: [dir, ...settings.projects] })
    return dir
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid="home-view">
      <div className="drag flex h-[52px] shrink-0 items-center px-4" style={{ paddingLeft: sidebarOpen ? 16 : 84 }}>
        {!sidebarOpen && (
          <IconButton label="Show sidebar" shortcut="⌘B" onClick={() => useApp.setState({ sidebarOpen: true })}>
            <IconSidebar size={16} />
          </IconButton>
        )}
      </div>
      <div className="scroll-y min-h-0 flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-6 pb-16">
          <div className="anim-rise mb-7 flex flex-col items-center text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[18px] border border-line bg-surface shadow-[0_10px_30px_-12px_rgba(0,0,0,0.6)]">
              <DuetMark size={30} />
            </div>
            <h1 className="text-[26px] font-semibold tracking-[-0.02em]">What are we building?</h1>
            <p className="mt-2 text-[13.5px] text-fg-2">
              {PROVIDER_LABEL[provider]} is up first. Switch to {PROVIDER_LABEL[PROVIDERS.find((p) => p !== provider)!]} any time — the conversation comes with you.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {PROVIDERS.map((p) => (
                <AgentStatusPill key={p} id={p} />
              ))}
            </div>
          </div>
          <div className="anim-rise" style={{ animationDelay: '60ms' }}>
            <Composer mode="home" project={project} onPickProject={pickProject} autoFocusKey={focusNonce} />
          </div>
          {settings && settings.projects.length > 1 && (
            <div className="anim-rise mt-4 flex flex-wrap items-center justify-center gap-1.5" style={{ animationDelay: '90ms' }}>
              {settings.projects.slice(0, 6).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => useApp.setState({ homeProject: p })}
                  className={`press rounded-full border px-2.5 py-0.5 text-[11.5px] ${p === project ? 'border-accent/50 bg-accent/10 text-fg' : 'border-line text-fg-3 hover:text-fg-2'}`}
                  title={p}
                >
                  {projectName(p)}
                </button>
              ))}
            </div>
          )}
          {recent.length > 0 && (
            <div className="anim-rise mt-10" style={{ animationDelay: '120ms' }}>
              <div className="mb-2 px-1 text-[12px] font-medium text-fg-3">Pick up where you left off</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {recent.map((t) => (
                  <button key={t.id} type="button" onClick={() => void openThread(t.id)} className="press group/card flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface/60 p-3 text-left hover:border-line-strong hover:bg-surface">
                    <span className="flex items-center gap-2">
                      <ProviderLogo provider={t.provider} size={12} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.title}</span>
                      <IconArrowRight size={13} className="text-fg-3 opacity-0 transition-opacity group-hover/card:opacity-100" />
                    </span>
                    <span className="truncate text-[12px] text-fg-3">
                      {projectName(t.cwd)} · {timeAgo(t.updatedAt)}
                      {t.preview ? ` · ${t.preview}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
