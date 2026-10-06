import { useEffect, useState } from 'react'
import type { CliStatus, ProviderId, StorageStats } from '@shared/types'
import { ACCESS_MODES, PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { duet } from '@/lib/api'
import { formatBytes, resetsIn, timeAgo, tildify } from '@/lib/format'
import { connectProvider, refreshProviders, saveSettings, setView, syncAllChats, toast, toastError, useApp } from '@/state/store'
import { DuetMark, ProviderLogo } from '../brand'
import { runInTerminal } from '../panels/TerminalDrawer'
import { IconExternal, IconFolder, IconHardDrive, IconLogin, IconPalette, IconRefresh, IconTerminal, IconTrash, IconWarning, Spinner } from '../icons'
import { Button, Chip, Kbd, Meter, Segmented, Switch, inputClass } from '../ui/primitives'
import { modelLabel } from '../composer/pickers'
import { Card, Page, Row, Section } from './Page'

function AgentCard({ id }: { id: ProviderId }) {
  const status = useApp((s) => s.providers[id])
  const settings = useApp((s) => s.settings)
  const home = useApp((s) => s.info.home)
  const [refreshing, setRefreshing] = useState(false)
  const pathKey = id === 'claude' ? 'claudePath' : 'codexPath'
  const [path, setPath] = useState(settings?.[pathKey] ?? '')
  const refresh = async () => {
    setRefreshing(true)
    await refreshProviders(id)
    setRefreshing(false)
  }
  const connecting = useApp((s) => s.connecting === id)
  const installCommand = id === 'claude' ? 'curl -fsSL https://claude.ai/install.sh | bash' : 'npm install -g @openai/codex'
  const models = status?.models ?? []
  const defaultModel = settings?.defaultModels[id]
  return (
    <Card className="mb-3" data-testid={`agent-card-${id}`}>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${id === 'claude' ? 'bg-claude/12' : 'bg-surface-3'}`}>
          <ProviderLogo provider={id} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            {PROVIDER_LABEL[id]}
            {!status ? (
              <Chip>checking…</Chip>
            ) : !status.installed ? (
              <Chip tone="bad">not installed</Chip>
            ) : status.loggedIn === false ? (
              <Chip tone="warn">signed out</Chip>
            ) : status.error ? (
              <Chip tone="warn">needs attention</Chip>
            ) : (
              <Chip tone="ok">ready</Chip>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-fg-3">
            {[status?.version && (/^\d/.test(status.version) ? `v${status.version}` : status.version), status?.account, status?.plan].filter(Boolean).join(' · ') || (status?.installed === false ? 'CLI not found on this Mac' : '')}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} icon={refreshing ? <Spinner size={13} /> : <IconRefresh size={13} />}>
          Check again
        </Button>
        {status?.installed && (
          <Button size="sm" variant={status.loggedIn === false ? 'accent' : 'secondary'} icon={connecting ? <Spinner size={13} /> : <IconLogin size={13} />} onClick={() => void connectProvider(id)} data-testid={`connect-button-${id}`}>
            {connecting ? 'Waiting…' : status.loggedIn === false ? 'Sign in' : 'Switch account'}
          </Button>
        )}
      </div>
      {status?.error && (
        <div className="flex items-start gap-2 border-t border-line bg-warn/6 px-4 py-2.5 text-[12px] text-fg-2">
          <IconWarning size={14} className="mt-[1px] shrink-0 text-warn" />
          <span className="whitespace-pre-wrap">{status.error}</span>
        </div>
      )}
      {status && !status.installed && (
        <div className="border-t border-line px-4 py-3 text-[12.5px] text-fg-2">
          Install {PROVIDER_LABEL[id]} with
          <div className="mt-1.5 flex items-center gap-2">
            <code className="selectable flex-1 rounded-md border border-line bg-[var(--code-bg)] px-2.5 py-1.5 font-mono text-[12px]">{installCommand}</code>
            <Button size="sm" variant="secondary" onClick={() => runInTerminal(installCommand)} icon={<IconTerminal size={13} />}>
              Run
            </Button>
          </div>
        </div>
      )}
      {status?.limits && status.limits.length > 0 && (
        <div className="grid grid-cols-2 gap-4 border-t border-line px-4 py-3">
          {status.limits.map((l) => (
            <div key={l.label}>
              <div className="mb-1 flex justify-between text-[11.5px]">
                <span className="text-fg-2">{l.label} limit</span>
                <span className="tabular-nums text-fg-3">
                  {l.usedPercent}% · {resetsIn(l.resetsAt)}
                </span>
              </div>
              <Meter value={l.usedPercent} />
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 border-t border-line px-4 py-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11.5px] text-fg-3">Default model</span>
          <select
            value={defaultModel ?? ''}
            onChange={(e) => settings && void saveSettings({ defaultModels: { ...settings.defaultModels, [id]: e.target.value || undefined } })}
            className={`${inputClass} appearance-none`}
          >
            <option value="">Automatic ({modelLabel(models, undefined)})</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] text-fg-3">CLI path (leave empty to auto-detect)</span>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onBlur={() => path !== (settings?.[pathKey] ?? '') && void saveSettings({ [pathKey]: path })}
            placeholder={status?.binaryPath ? tildify(status.binaryPath, home) : id}
            spellCheck={false}
            className={`${inputClass} font-mono text-[12px]`}
          />
        </label>
      </div>
    </Card>
  )
}

const SHORTCUTS: [string, string][] = [
  ['New thread', '⌘N'],
  ['Command palette', '⌘K'],
  ['Switch to Claude / Codex', '⌘1 / ⌘2'],
  ['Toggle sidebar', '⌘B'],
  ['Browser panel', '⌘⇧B'],
  ['Changes panel', '⌘⇧D'],
  ['Terminal', '⌘J'],
  ['Stop the agent', 'Esc'],
  ['Approve request', '⌘↵'],
  ['Always allow', '⇧⌘↵'],
  ['Settings', '⌘,']
]

export function SettingsView() {
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.info)
  const [browserHome, setBrowserHome] = useState(settings?.browserHome ?? '')
  if (!settings) return null
  return (
    <Page title="Settings" testId="settings-view">
      <Section title="Agents" description="Duet drives the Claude Code and Codex command-line tools already on your Mac, with your own subscriptions.">
        {PROVIDERS.map((p) => (
          <AgentCard key={p} id={p} />
        ))}
      </Section>

      <Section title="Behavior">
        <Card>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Start new threads with</div>
            </div>
            <div className="w-[220px] max-w-full">
              <Segmented value={settings.defaultProvider} onChange={(v) => void saveSettings({ defaultProvider: v })} options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p], icon: <ProviderLogo provider={p} size={12} /> }))} />
            </div>
          </Row>
          <Row>
            <div className="min-w-[200px] flex-1">
              <div className="text-[13px]">Default permissions</div>
              <div className="text-[11.5px] text-fg-3">{ACCESS_MODES.find((m) => m.id === settings.defaultAccess)?.hint}</div>
            </div>
            <div className="w-[400px] max-w-full">
              <Segmented size="sm" value={settings.defaultAccess} onChange={(v) => void saveSettings({ defaultAccess: v })} options={ACCESS_MODES.map((m) => ({ value: m.id, label: m.label }))} />
            </div>
          </Row>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Send with Enter</div>
              <div className="text-[11.5px] text-fg-3">Off: Enter adds a new line and ⌘↵ sends.</div>
            </div>
            <Switch checked={settings.sendWithEnter} onChange={(v) => void saveSettings({ sendWithEnter: v })} label="Send with Enter" />
          </Row>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Notifications</div>
              <div className="text-[11.5px] text-fg-3">When an agent finishes or needs approval while Duet is in the background.</div>
            </div>
            <Switch checked={settings.notifications} onChange={(v) => void saveSettings({ notifications: v })} label="Notifications" />
          </Row>
          <Row>
            <div className="flex-1 text-[13px]">Notification sound</div>
            <Switch checked={settings.sounds} onChange={(v) => void saveSettings({ sounds: v })} label="Notification sound" />
          </Row>
        </Card>
      </Section>

      <Section title="Appearance">
        <Card>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Themes, colours, layout and personality</div>
              <div className="text-[11.5px] text-fg-3">All in Customize — including “describe a look” and your agents' personality.</div>
            </div>
            <Button size="sm" variant="secondary" icon={<IconPalette size={13} />} onClick={() => setView('customize')}>
              Open Customize
            </Button>
          </Row>
        </Card>
      </Section>

      <ChatsSection />
      <CommandLineSection />
      <StorageSection />

      <Section title="Browser">
        <Card>
          <Row>
            <div className="flex-1">
              <div className="text-[13px]">Start page</div>
              <div className="text-[11.5px] text-fg-3">What the built-in browser opens first — usually your dev server.</div>
            </div>
            <input value={browserHome} onChange={(e) => setBrowserHome(e.target.value)} onBlur={() => browserHome !== settings.browserHome && void saveSettings({ browserHome })} className={`${inputClass} w-[260px] font-mono text-[12px]`} spellCheck={false} />
          </Row>
        </Card>
      </Section>

      <Section title="Keyboard shortcuts">
        <Card>
          <div className="grid grid-cols-1 md:grid-cols-2">
            {SHORTCUTS.map(([label, keys]) => (
              <div key={label} className="flex items-center justify-between border-b border-line px-4 py-2 text-[12.5px] md:odd:border-r">
                <span className="text-fg-2">{label}</span>
                <span className="flex gap-1">
                  {keys.split(' / ').map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="About">
        <Card>
          <Row>
            <DuetMark size={22} />
            <div className="flex-1">
              <div className="text-[13px] font-medium">Duet {info.version}</div>
              <div className="text-[11.5px] text-fg-3">Claude Code and Codex, side by side.</div>
            </div>
            <Button size="sm" variant="ghost" icon={<IconFolder size={13} />} onClick={() => void duet.app.openPath(info.userData)}>
              Data folder
            </Button>
          </Row>
          <Row>
            <span className="flex-1 text-[12.5px] text-fg-2">Documentation</span>
            <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => void duet.app.openExternal('https://docs.claude.com/en/docs/claude-code/overview')}>
              Claude Code
            </Button>
            <Button size="sm" variant="ghost" icon={<IconExternal size={13} />} onClick={() => void duet.app.openExternal('https://developers.openai.com/codex')}>
              Codex
            </Button>
          </Row>
        </Card>
      </Section>
    </Page>
  )
}

function ChatsSection() {
  const settings = useApp((s) => s.settings)
  const syncing = useApp((s) => s.chatSyncing)
  const synced = useApp((s) => Object.values(s.threads).filter((t) => t.origin).length)
  if (!settings) return null
  return (
    <Section title="Chats" description="Every conversation you've had in Claude Code or Codex can live in Duet's sidebar, with its original date. Messages are read from them when you open one, so nothing gets copied until then.">
      <Card>
        <Row>
          <div className="flex-1">
            <div className="text-[13px]">Keep Claude Code & Codex chats in sync</div>
            <div className="text-[11.5px] text-fg-3">
              {settings.lastChatSync ? `Last synced ${timeAgo(settings.lastChatSync)} ago · ${synced} chats from Claude Code and Codex` : 'New chats from the Claude Code and Codex apps show up on their own.'}
            </div>
          </div>
          <Button size="sm" variant="ghost" icon={syncing ? <Spinner size={13} /> : <IconRefresh size={13} />} onClick={() => void syncAllChats()} data-testid="sync-now">
            Sync now
          </Button>
          <Switch checked={settings.chatSync === 'auto'} onChange={(v) => void saveSettings({ chatSync: v ? 'auto' : 'off' })} label="Keep chats in sync" />
        </Row>
      </Card>
    </Section>
  )
}

function CommandLineSection() {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void duet.cli.status().then(setStatus).catch(() => undefined)
  }, [])
  const run = async (fn: () => Promise<CliStatus>, done: string) => {
    setBusy(true)
    try {
      const next = await fn()
      setStatus(next)
      toast(done, 'success')
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Command line" description="Start Duet from any terminal: open a project, or hand an agent a task without leaving the shell.">
      <Card>
        <Row>
          <IconTerminal size={16} className="text-fg-3" />
          <div className="flex-1">
            <div className="text-[13px]">
              <span className="font-mono">duet</span> command {status?.installed ? <Chip tone="ok">installed</Chip> : <Chip>not installed</Chip>}
            </div>
            <div className="text-[11.5px] text-fg-3">{status ? `${status.installed ? 'At' : 'Goes in'} ${status.path}${status.onPath ? '' : ' — add that folder to your PATH'}` : 'Checking…'}</div>
          </div>
          {status?.installed ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => duet.cli.uninstall(), 'Removed the duet command.')}>
              Remove
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => duet.cli.install(), 'Installed — try `duet .` in a project folder.')} data-testid="cli-install">
              Install
            </Button>
          )}
        </Row>
        <div className="space-y-1 px-4 py-3 font-mono text-[12px] text-fg-2">
          {[
            ['duet .', 'open this folder in Duet'],
            ['duet "fix the failing test"', 'start a chat here and send it'],
            ['duet --codex -p "review my changes"', 'pick the agent'],
            ['duet --list', 'recent chats'],
            ['duet --usage', 'limits at a glance']
          ].map(([cmd, what]) => (
            <div key={cmd} className="flex gap-3">
              <span className="selectable text-fg">{cmd}</span>
              <span className="text-fg-3"># {what}</span>
            </div>
          ))}
        </div>
      </Card>
    </Section>
  )
}

function StorageSection() {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [busy, setBusy] = useState(false)
  const keep = () => {
    const s = useApp.getState()
    return [...Object.values(s.drafts), ...Object.values(s.queued)].flatMap((d) => d.attachments.map((a) => a.path))
  }
  const load = () => void duet.storage.stats(keep()).then(setStats).catch(() => undefined)
  useEffect(load, [])
  return (
    <Section title="Storage" description="Duet keeps its own data small: synced chats aren't copied until you open them, and pictures are stored once even when they appear in many chats.">
      <Card>
        {!stats ? (
          <div className="flex justify-center py-6 text-fg-3">
            <Spinner size={16} />
          </div>
        ) : (
          <>
            {[
              ['Chats', `${stats.threads.count} saved`, stats.threads.bytes],
              ['Attachments & pictures', `${stats.attachments.count} files`, stats.attachments.bytes],
              ['Safety copies from Sync', `${stats.safetyCopies.count} files`, stats.safetyCopies.bytes],
              ['Caches', 'usage numbers', stats.caches.bytes],
              ['Logs', 'kept small automatically', stats.logs.bytes]
            ].map(([label, hint, bytes]) => (
              <Row key={label as string}>
                <div className="flex-1">
                  <div className="text-[13px]">{label}</div>
                  <div className="text-[11.5px] text-fg-3">{hint}</div>
                </div>
                <span className="text-[12.5px] tabular-nums text-fg-2">{formatBytes(bytes as number)}</span>
              </Row>
            ))}
            <Row>
              <IconHardDrive size={16} className="text-fg-3" />
              <div className="flex-1">
                <div className="text-[13px]">Clean up</div>
                <div className="text-[11.5px] text-fg-3">
                  {stats.unused.count ? `${stats.unused.count} unused attachments (${formatBytes(stats.unused.bytes)}) and safety copies older than 30 days go to the Trash.` : 'Nothing to clean up right now.'}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon={busy ? <Spinner size={13} /> : <IconTrash size={13} />}
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    const res = await duet.storage.clean(keep())
                    toast(res.files ? `Moved ${res.files} files (${formatBytes(res.bytes)}) to the Trash.` : 'Nothing to clean up.', 'success')
                    load()
                  } catch (error) {
                    toastError(error)
                  } finally {
                    setBusy(false)
                  }
                }}
                data-testid="storage-clean"
              >
                Clean up
              </Button>
            </Row>
          </>
        )}
      </Card>
    </Section>
  )
}
