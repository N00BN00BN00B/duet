import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { PersonalityPreset } from '@shared/types'
import { PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { PERSONALITIES } from '@shared/personality'
import { PRESET_THEMES } from '@shared/theme'
import { duet } from '@/lib/api'
import { chooseTheme, connectProvider, designTheme, refreshProviders, saveSettings, syncAllChats, toastError, useApp } from '@/state/store'
import { ThemeSwatch } from './BackgroundEffect'
import { DuetMark, ProviderLogo } from './brand'
import { IconCheck, IconRefresh, IconSparkle, Spinner } from './icons'
import { Button, Kbd, Switch, inputClass } from './ui/primitives'

const STEPS = ['Welcome', 'Agents', 'Chats', 'Look', 'Ready'] as const
const FEATURED = ['graphite', 'paper', 'midnight', 'ocean-waves', 'aurora', 'sunset']

function AgentsStep() {
  const providers = useApp((s) => s.providers)
  const connecting = useApp((s) => s.connecting)
  const [checking, setChecking] = useState(false)
  return (
    <div className="space-y-2">
      {PROVIDERS.map((p) => {
        const st = providers[p]
        const ready = st?.installed && st.loggedIn !== false
        return (
          <div key={p} className="flex items-center gap-3 rounded-xl border border-line bg-surface-2/50 px-3.5 py-3">
            <ProviderLogo provider={p} size={18} />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">{PROVIDER_LABEL[p]}</div>
              <div className="text-[12px] text-fg-3">{!st ? 'Checking…' : !st.installed ? 'Not installed yet' : st.loggedIn === false ? 'Installed — sign in to use it' : [st.plan, st.account].filter(Boolean).join(' · ') || 'Ready'}</div>
            </div>
            {ready ? (
              <span className="flex items-center gap-1 text-[12px] text-ok">
                <IconCheck size={13} /> Connected
              </span>
            ) : st ? (
              <Button size="sm" variant="accent" onClick={() => void connectProvider(p)} icon={connecting === p ? <Spinner size={12} /> : undefined} data-testid={`onboarding-connect-${p}`}>
                {connecting === p ? 'Waiting…' : !st.installed ? 'Install' : 'Connect'}
              </Button>
            ) : (
              <Spinner size={14} />
            )}
          </div>
        )
      })}
      <div className="flex items-center justify-between pt-1 text-[12px] text-fg-3">
        <span>Duet uses the agents on your Mac with your own subscriptions. One is enough to start.</span>
        <button
          type="button"
          className="press flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg-2"
          onClick={async () => {
            setChecking(true)
            await refreshProviders()
            setChecking(false)
          }}
        >
          {checking ? <Spinner size={11} /> : <IconRefresh size={11} />} Check again
        </button>
      </div>
    </div>
  )
}

function LookStep() {
  const current = useApp((s) => s.theme)
  const settings = useApp((s) => s.settings)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const themes = PRESET_THEMES.filter((t) => FEATURED.includes(t.id))
  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {themes.map((t) => (
          <button key={t.id} type="button" onClick={() => void chooseTheme(t)} className={`press rounded-xl p-1 text-left ${current.id === t.id ? 'ring-2 ring-accent' : 'ring-1 ring-line hover:ring-line-strong'}`}>
            <ThemeSwatch theme={t} className="h-14 w-full rounded-lg" />
            <span className="block truncate px-1 pt-1 text-[11.5px]">{t.name}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="…or describe one: “dark gradient with a wave effect”" className={`${inputClass} h-8 flex-1`} onKeyDown={(e) => e.key === 'Enter' && prompt.trim() && !busy && (setBusy(true), void designTheme(prompt).finally(() => setBusy(false)))} />
        <Button size="sm" variant="secondary" disabled={!prompt.trim() || busy} icon={busy ? <Spinner size={12} /> : <IconSparkle size={12} />} onClick={() => (setBusy(true), void designTheme(prompt).finally(() => setBusy(false)))}>
          Make it
        </Button>
      </div>
      {settings && (
        <div className="mt-4">
          <div className="mb-1.5 text-[12px] font-medium text-fg-2">How should the agents talk to you?</div>
          <div className="flex flex-wrap gap-1.5">
            {PERSONALITIES.filter((p) => p.id !== 'custom').map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.description}
                onClick={() => void saveSettings({ personality: { ...settings.personality, preset: p.id as PersonalityPreset, importedFrom: undefined } })}
                className={`press rounded-full px-3 py-1 text-[12px] ${settings.personality.preset === p.id ? 'bg-accent text-white' : 'bg-surface-2 text-fg-2 ring-1 ring-line hover:text-fg'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** First run: connect the agents, bring in old chats, pick a look. */
export function Onboarding() {
  const settings = useApp((s) => s.settings)
  const [step, setStep] = useState(0)
  const [syncChats, setSyncChats] = useState(true)
  const [cli, setCli] = useState<'idle' | 'busy' | 'done'>('idle')
  if (!settings || settings.onboarded) return null
  const finish = async () => {
    await saveSettings({ onboarded: true })
  }
  const next = async () => {
    if (STEPS[step] === 'Chats' && syncChats) {
      void syncAllChats()
      void saveSettings({ chatSync: 'auto' })
    }
    if (step < STEPS.length - 1) setStep(step + 1)
    else await finish()
  }
  return createPortal(
    <div className="anim-fade fixed inset-0 z-[72] flex items-center justify-center bg-black/55 p-6" data-testid="onboarding">
      <div className="anim-pop w-[560px] max-w-full rounded-2xl border border-line-strong bg-surface p-6 shadow-[var(--pop-shadow)]">
        <div className="mb-5 flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span key={s} className={`h-1 flex-1 rounded-full transition-colors duration-300 ${i <= step ? 'bg-accent' : 'bg-surface-3'}`} title={s} />
          ))}
        </div>
        {STEPS[step] === 'Welcome' && (
          <div>
            <DuetMark size={34} />
            <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.01em]">Claude and Codex, in one window</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-fg-2">Start a chat with either agent and switch whenever you like — the other one picks up right where the conversation left off. Your projects, chats, MCP servers and skills work with both.</p>
          </div>
        )}
        {STEPS[step] === 'Agents' && (
          <div>
            <h2 className="mb-1 text-[17px] font-semibold">Connect your agents</h2>
            <p className="mb-4 text-[13px] text-fg-2">Sign in once; Duet remembers.</p>
            <AgentsStep />
          </div>
        )}
        {STEPS[step] === 'Chats' && (
          <div>
            <h2 className="mb-1 text-[17px] font-semibold">Bring your chats along</h2>
            <p className="mb-4 text-[13px] leading-relaxed text-fg-2">Every conversation from Claude Code and Codex shows up in the sidebar with its original date, labelled “Claude ·” or “Codex ·”. Duet only reads one when you open it, so it takes no extra space.</p>
            <label className="flex items-center gap-3 rounded-xl border border-line bg-surface-2/50 px-3.5 py-3">
              <span className="flex-1 text-[13px]">Sync my Claude Code & Codex chats, and keep them in sync</span>
              <Switch checked={syncChats} onChange={setSyncChats} label="Sync chats" />
            </label>
          </div>
        )}
        {STEPS[step] === 'Look' && (
          <div>
            <h2 className="mb-1 text-[17px] font-semibold">Make it yours</h2>
            <p className="mb-4 text-[13px] text-fg-2">Change any of this later in Customize.</p>
            <LookStep />
          </div>
        )}
        {STEPS[step] === 'Ready' && (
          <div>
            <h2 className="mb-3 text-[17px] font-semibold">You're set</h2>
            <ul className="space-y-2 text-[13px] text-fg-2">
              <li className="flex items-center gap-2">
                <Kbd>⌘N</Kbd> new chat · <Kbd>⌘1</Kbd> <Kbd>⌘2</Kbd> switch between Claude and Codex
              </li>
              <li className="flex items-center gap-2">
                <Kbd>/</Kbd> every command, skill and action · <Kbd>@</Kbd> mention a file
              </li>
              <li className="flex items-center gap-2">
                <Kbd>⌘K</Kbd> jump to any chat or setting
              </li>
            </ul>
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-surface-2/50 px-3.5 py-3">
              <span className="flex-1 text-[13px]">
                Use Duet from the terminal: <span className="font-mono">duet .</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={cli !== 'idle'}
                onClick={async () => {
                  setCli('busy')
                  try {
                    await duet.cli.install()
                    setCli('done')
                  } catch (error) {
                    toastError(error)
                    setCli('idle')
                  }
                }}
              >
                {cli === 'done' ? 'Installed' : cli === 'busy' ? 'Installing…' : 'Install'}
              </Button>
            </div>
          </div>
        )}
        <div className="mt-6 flex items-center justify-between">
          <button type="button" onClick={() => void finish()} className="press rounded-md px-2 py-1 text-[12.5px] text-fg-3 hover:text-fg-2" data-testid="onboarding-skip">
            Skip
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="ghost" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button variant="accent" onClick={() => void next()} data-testid="onboarding-next">
              {step === STEPS.length - 1 ? 'Start building' : 'Continue'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
