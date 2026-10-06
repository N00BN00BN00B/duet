import { useMemo } from 'react'
import type { ProviderId } from '@shared/types'
import { PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { duet } from '@/lib/api'
import { projectName, timeAgo } from '@/lib/format'
import { addProject, connectProvider, openThread, saveSettings, syncAllChats, useApp } from '@/state/store'
import { ProviderLogo } from '../brand'
import { Composer } from '../composer/Composer'
import { IconArrowRight, IconHistory, IconSidebar, Spinner } from '../icons'
import { Button, IconButton } from '../ui/primitives'

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Working late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** Shown while an agent isn't usable yet, so connecting it is one click away. */
function ConnectBanner({ id }: { id: ProviderId }) {
  const st = useApp((s) => s.providers[id])
  const connecting = useApp((s) => s.connecting === id)
  if (!st || (st.installed && st.loggedIn !== false)) return null
  return (
    <div className="anim-rise flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3" data-testid={`connect-${id}`}>
      <ProviderLogo provider={id} size={18} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{!st.installed ? `${PROVIDER_LABEL[id]} isn't installed` : `Connect ${PROVIDER_LABEL[id]}`}</div>
        <div className="text-[12px] text-fg-3">{!st.installed ? `Install it to switch between ${PROVIDER_LABEL[id]} and the other agent in any chat.` : `Sign in with your ${id === 'claude' ? 'Claude' : 'ChatGPT'} account — your own subscription, nothing extra.`}</div>
      </div>
      <Button size="sm" variant="accent" onClick={() => void connectProvider(id)} icon={connecting ? <Spinner size={12} /> : undefined}>
        {connecting ? 'Waiting…' : !st.installed ? 'Install' : 'Connect'}
      </Button>
    </div>
  )
}

export function HomeView() {
  const project = useApp((s) => s.homeProject)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const threads = useApp((s) => s.threads)
  const settings = useApp((s) => s.settings)
  const focusNonce = useApp((s) => s.focusNonce)
  const syncing = useApp((s) => s.chatSyncing)
  const recent = useMemo(
    () =>
      Object.values(threads)
        .filter((t) => !t.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [threads]
  )
  const synced = Object.values(threads).some((t) => t.origin)

  const pickProject = async (): Promise<string | null> => {
    const dir = await duet.app.pickFolder()
    if (!dir) return null
    return addProject(dir)
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
        <div className="mx-auto flex min-h-full w-full max-w-[var(--chat-width,760px)] flex-col justify-center px-6 pb-16">
          <div className="anim-rise mb-6 text-center">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{greeting()}</h1>
            <p className="mt-1.5 text-[13.5px] text-fg-3">{project ? `Working in ${projectName(project)}` : 'Pick a project below, or just start typing.'}</p>
          </div>
          <div className="mb-3 space-y-2">
            {PROVIDERS.map((p) => (
              <ConnectBanner key={p} id={p} />
            ))}
          </div>
          <div className="anim-rise" style={{ animationDelay: '40ms' }}>
            <Composer mode="home" project={project} onPickProject={pickProject} autoFocusKey={focusNonce} />
          </div>
          {recent.length > 0 && (
            <div className="anim-rise mt-9" style={{ animationDelay: '80ms' }}>
              <div className="mb-1.5 flex items-center px-1 text-[12px] font-medium text-fg-3">
                Recent
                {settings && settings.chatSync !== 'auto' && (
                  <button type="button" onClick={() => void syncAllChats().then(() => saveSettings({ chatSync: 'auto' }))} className="press ml-auto flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-normal hover:bg-hover hover:text-fg-2" data-testid="home-sync">
                    {syncing ? <Spinner size={11} /> : <IconHistory size={12} />}
                    {synced ? 'Keep Claude Code & Codex chats in sync' : 'Bring in your Claude Code & Codex chats'}
                  </button>
                )}
              </div>
              <div className="overflow-hidden rounded-xl border border-line">
                {recent.map((t) => (
                  <button key={t.id} type="button" onClick={() => void openThread(t.id)} className="press group/card flex w-full min-w-0 items-center gap-3 border-b border-line px-3.5 py-2.5 text-left last:border-b-0 hover:bg-hover">
                    <ProviderLogo provider={t.provider} size={13} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      <span className="text-fg-3">{PROVIDER_LABEL[t.provider]} · </span>
                      {t.title}
                    </span>
                    <span className="shrink-0 text-[11.5px] text-fg-3">
                      {projectName(t.cwd)} · {timeAgo(t.updatedAt)}
                    </span>
                    <IconArrowRight size={13} className="shrink-0 text-fg-3 opacity-0 transition-opacity group-hover/card:opacity-100" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {recent.length === 0 && settings && (
            <div className="anim-rise mt-8 text-center" style={{ animationDelay: '80ms' }}>
              <button type="button" onClick={() => void syncAllChats().then(() => saveSettings({ chatSync: 'auto' }))} className="press inline-flex items-center gap-2 rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-fg-2 hover:border-line-strong hover:text-fg" data-testid="home-sync">
                {syncing ? <Spinner size={12} /> : <IconHistory size={13} />}
                Bring in your Claude Code & Codex chats
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
