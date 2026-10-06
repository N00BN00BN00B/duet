import { useCallback, useEffect, useMemo, useState } from 'react'
import type { McpEditSource, McpEntry, McpServerConfig, McpTransport, ProviderId } from '@shared/types'
import { PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { duet, errorMessage } from '@/lib/api'
import { toast, toastError, useApp } from '@/state/store'
import { joinArgs, splitArgs } from '@/lib/args'
import { ProviderLogo } from '../brand'
import { IconArrowRight, IconGlobe, IconPencil, IconPlug, IconPlus, IconRefresh, IconSync, IconTerminal, IconTrash, IconUpload, IconX, Spinner } from '../icons'
import { Button, Chip, Dialog, EmptyState, Field, IconButton, Segmented, inputClass } from '../ui/primitives'
import { Card, Page, Section } from './Page'

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral' | 'info'> = {
  connected: 'ok',
  'needs-auth': 'warn',
  failed: 'bad',
  pending: 'info',
  disabled: 'neutral',
  unknown: 'neutral'
}
const STATUS_TEXT: Record<string, string> = { connected: 'Connected', 'needs-auth': 'Needs login', failed: 'Failed', pending: 'Starting', disabled: 'Disabled', unknown: 'Configured' }

interface Row {
  name: string
  config: McpServerConfig
  claude?: McpEntry
  codex?: McpEntry
}

function describe(cfg: McpServerConfig): string {
  if (cfg.transport === 'stdio') return [cfg.command, joinArgs(cfg.args)].filter(Boolean).join(' ')
  return cfg.url ?? ''
}

type KV = { key: string; value: string }

function toRows(obj?: Record<string, string>): KV[] {
  const rows = Object.entries(obj ?? {}).map(([key, value]) => ({ key, value }))
  return rows.length ? rows : [{ key: '', value: '' }]
}

function fromRows(rows: KV[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value
  return Object.keys(out).length ? out : undefined
}

function KeyValueEditor({ rows, onChange, keyLabel, valueLabel }: { rows: KV[]; onChange: (rows: KV[]) => void; keyLabel: string; valueLabel: string }) {
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-1.5">
          <input value={r.key} placeholder={keyLabel} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} className={`${inputClass} w-[40%] font-mono text-[12px]`} />
          <input value={r.value} placeholder={valueLabel} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className={`${inputClass} flex-1 font-mono text-[12px]`} />
          <IconButton label="Remove" onClick={() => onChange(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ key: '', value: '' }])}>
            <IconX size={13} />
          </IconButton>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { key: '', value: '' }])} className="press flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-fg-3 hover:text-fg-2">
        <IconPlus size={12} /> Add
      </button>
    </div>
  )
}

function ServerDialog({
  open,
  onClose,
  initial,
  initialTargets,
  source,
  onSaved
}: {
  open: boolean
  onClose: () => void
  initial: McpServerConfig | null
  initialTargets: ProviderId[]
  /** Where the edited server lives, so Claude's copy is changed in its own scope. */
  source?: McpEditSource
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState<KV[]>([{ key: '', value: '' }])
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<KV[]>([{ key: '', value: '' }])
  const [bearer, setBearer] = useState('')
  const [targets, setTargets] = useState<ProviderId[]>(['claude', 'codex'])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setTransport(initial?.transport === 'sse' ? 'http' : (initial?.transport ?? 'stdio'))
    setCommand(initial?.command ?? '')
    setArgs(joinArgs(initial?.args))
    setEnv(toRows(initial?.env))
    setUrl(initial?.url ?? '')
    setHeaders(toRows(initial?.headers))
    setBearer(initial?.bearerTokenEnvVar ?? '')
    setTargets(initialTargets.length ? initialTargets : ['claude', 'codex'])
    setError(null)
  }, [open, initial, initialTargets])

  const save = async () => {
    setSaving(true)
    setError(null)
    const config: McpServerConfig =
      transport === 'stdio'
        ? { name: name.trim(), transport, command: command.trim(), args: splitArgs(args), env: fromRows(env) }
        : { name: name.trim(), transport: initial?.transport === 'sse' ? 'sse' : 'http', url: url.trim(), headers: fromRows(headers), bearerTokenEnvVar: bearer.trim() || undefined }
    try {
      await duet.mcp.save(config, targets, initial ? (source ?? { name: initial.name }) : undefined)
      toast(`Saved ${config.name} to ${targets.map((t) => PROVIDER_LABEL[t]).join(' and ')}`, 'success')
      onSaved()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? `Edit ${initial.name}` : 'Add an MCP server'}
      description="Duet writes it straight into Claude Code (~/.claude.json) and Codex (~/.codex/config.toml) using their own tools, so formatting and other settings are preserved."
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" disabled={saving || !name.trim() || !targets.length || (transport === 'stdio' ? !command.trim() : !url.trim())} onClick={() => void save()} icon={saving ? <Spinner size={13} /> : undefined}>
            Save server
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-1">
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label="Name" hint="Letters, numbers, dashes and underscores.">
            <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="github" className={inputClass} spellCheck={false} />
          </Field>
          <div className="pb-[22px]">
            <Segmented value={transport} onChange={setTransport} options={[{ value: 'stdio', label: 'Local command', icon: <IconTerminal size={12} /> }, { value: 'http', label: 'Remote URL', icon: <IconGlobe size={12} /> }]} />
          </div>
        </div>
        {transport === 'stdio' ? (
          <>
            <Field label="Command">
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className={`${inputClass} font-mono text-[12.5px]`} spellCheck={false} />
            </Field>
            <Field label="Arguments" hint="Separated by spaces; quote arguments that contain spaces.">
              <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-github" className={`${inputClass} font-mono text-[12.5px]`} spellCheck={false} />
            </Field>
            <Field label="Environment variables">
              <KeyValueEditor rows={env} onChange={setEnv} keyLabel="NAME" valueLabel="value" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Server URL">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" className={`${inputClass} font-mono text-[12.5px]`} spellCheck={false} />
            </Field>
            <Field label="Headers">
              <KeyValueEditor rows={headers} onChange={setHeaders} keyLabel="Header" valueLabel="value" />
            </Field>
            <Field label="Bearer token variable (optional)" hint="Name of an environment variable that holds the token, e.g. GITHUB_TOKEN.">
              <input value={bearer} onChange={(e) => setBearer(e.target.value)} placeholder="MY_TOKEN" className={`${inputClass} font-mono text-[12.5px]`} spellCheck={false} />
            </Field>
          </>
        )}
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-fg-2">Install for</div>
          <div className="flex gap-2">
            {PROVIDERS.map((p) => {
              const on = targets.includes(p)
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setTargets((t) => (on ? t.filter((x) => x !== p) : [...t, p]))}
                  className={`press flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12.5px] ${on ? 'border-accent/50 bg-accent/10 text-fg' : 'border-line text-fg-3 hover:text-fg-2'}`}
                  aria-pressed={on}
                >
                  <ProviderLogo provider={p} size={13} />
                  {PROVIDER_LABEL[p]}
                </button>
              )
            })}
          </div>
        </div>
        {error && <div className="rounded-lg border border-bad/30 bg-bad/8 px-3 py-2 text-[12px] whitespace-pre-wrap text-bad">{error}</div>}
      </div>
    </Dialog>
  )
}

function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('')
  const [targets, setTargets] = useState<ProviderId[]>(['claude', 'codex'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setText('')
      setError(null)
    }
  }, [open])
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import MCP servers from JSON"
      description='Paste the "mcpServers" block from any README, Cursor or Claude Desktop config.'
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={!text.trim() || busy || !targets.length}
            icon={busy ? <Spinner size={13} /> : undefined}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                const n = await duet.mcp.importJson(text, targets)
                toast(`Imported ${n} server${n === 1 ? '' : 's'}`, 'success')
                onDone()
                onClose()
              } catch (e) {
                setError(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Import
          </Button>
        </>
      }
    >
      <textarea
        data-autofocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Projects"] }\n  }\n}'}
        className="h-56 w-full resize-none rounded-lg border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed outline-none placeholder:text-fg-3 focus:border-accent/50"
      />
      <div className="mt-3 flex gap-2">
        {PROVIDERS.map((p) => {
          const on = targets.includes(p)
          return (
            <button key={p} type="button" aria-pressed={on} onClick={() => setTargets((t) => (on ? t.filter((x) => x !== p) : [...t, p]))} className={`press flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12.5px] ${on ? 'border-accent/50 bg-accent/10 text-fg' : 'border-line text-fg-3'}`}>
              <ProviderLogo provider={p} size={13} />
              {PROVIDER_LABEL[p]}
            </button>
          )
        })}
      </div>
      {error && <div className="mt-3 rounded-lg border border-bad/30 bg-bad/8 px-3 py-2 text-[12px] text-bad">{error}</div>}
    </Dialog>
  )
}

function StatusCell({ entry, provider, onCopy, copying }: { entry?: McpEntry; provider: ProviderId; onCopy: () => void; copying: boolean }) {
  if (!entry) {
    return (
      <button type="button" onClick={onCopy} disabled={copying} className="press flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-fg-3 hover:bg-hover hover:text-accent">
        {copying ? <Spinner size={12} /> : <IconPlus size={12} />} Add to {PROVIDER_LABEL[provider]}
      </button>
    )
  }
  const s = entry.status ?? 'unknown'
  return (
    <span className="flex items-center gap-1.5">
      <Chip tone={STATUS_TONE[s]}>{STATUS_TEXT[s]}</Chip>
      {entry.scope !== 'user' && <span className="text-[11px] text-fg-3">{entry.scope}</span>}
      {entry.tools !== undefined && entry.tools > 0 && <span className="text-[11px] text-fg-3">{entry.tools} tools</span>}
    </span>
  )
}

export function McpView() {
  const [entries, setEntries] = useState<McpEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<{ config: McpServerConfig | null; targets: ProviderId[]; source?: McpEditSource } | null>(null)
  const [importing, setImporting] = useState(false)
  const [copying, setCopying] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Row | null>(null)
  const project = useApp((s) => (s.currentId ? s.threads[s.currentId]?.cwd : s.homeProject) ?? undefined)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await duet.mcp.list(project))
    } catch (e) {
      toastError(e)
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [project])

  useEffect(() => {
    void load()
  }, [load])

  const { rows, managed } = useMemo(() => {
    const map = new Map<string, Row>()
    const managed: McpEntry[] = []
    for (const e of entries ?? []) {
      if (e.readOnly) {
        managed.push(e)
        continue
      }
      const row = map.get(e.config.name) ?? { name: e.config.name, config: e.config }
      if (e.provider === 'claude' && (!row.claude || e.scope === 'user')) row.claude = e
      if (e.provider === 'codex') row.codex = e
      map.set(e.config.name, row)
    }
    return { rows: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)), managed }
  }, [entries])

  const copy = async (row: Row, to: ProviderId) => {
    const from: ProviderId = to === 'claude' ? 'codex' : 'claude'
    setCopying(`${row.name}:${to}`)
    try {
      await duet.mcp.copy(row.name, from, to)
      toast(`Added ${row.name} to ${PROVIDER_LABEL[to]}`, 'success')
      await load()
    } catch (e) {
      toastError(e)
    } finally {
      setCopying(null)
    }
  }

  const missing = rows.filter((r) => !r.claude || !r.codex)
  const syncAll = async () => {
    for (const r of missing) {
      if (!r.claude && r.codex) await copy(r, 'claude')
      else if (r.claude && !r.codex && r.claude.scope === 'user') await copy(r, 'codex')
    }
  }

  return (
    <Page
      title="MCP servers"
      testId="mcp-view"
      subtitle="One list for both agents. Add a server once and install it in Claude, Codex or both — or copy what you already have from one to the other."
      actions={
        <>
          {missing.length > 0 && (
            <Button size="sm" variant="secondary" icon={<IconSync size={13} />} onClick={() => void syncAll()} data-testid="mcp-sync-all">
              Sync all
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<IconUpload size={13} />} onClick={() => setImporting(true)}>
            Import JSON
          </Button>
          <Button size="sm" variant="accent" icon={<IconPlus size={13} />} onClick={() => setEditing({ config: null, targets: ['claude', 'codex'] })} data-testid="mcp-add">
            Add server
          </Button>
        </>
      }
    >
      <Section
        title="Your servers"
        actions={
          <IconButton label="Refresh status" onClick={() => void load()}>
            {loading ? <Spinner size={14} /> : <IconRefresh size={15} />}
          </IconButton>
        }
      >
        {entries === null ? (
          <div className="flex justify-center py-12 text-fg-3">
            <Spinner size={18} />
          </div>
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState icon={<IconPlug size={18} />} title="No MCP servers yet" action={<Button size="sm" variant="accent" onClick={() => setEditing({ config: null, targets: ['claude', 'codex'] })}>Add your first server</Button>}>
              MCP servers give the agents new tools — GitHub, databases, design files, browsers and more.
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-2 text-[11.5px] font-medium text-fg-3">
              <span>Server</span>
              <span className="flex items-center gap-1.5">
                <ProviderLogo provider="claude" size={11} /> Claude
              </span>
              <span className="flex items-center gap-1.5">
                <ProviderLogo provider="codex" size={11} /> Codex
              </span>
              <span className="w-[60px]" />
            </div>
            {rows.map((row) => (
              <div key={row.name} className="group/m grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-hover/50" data-testid="mcp-row">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-fg-3">{row.config.transport === 'stdio' ? <IconTerminal size={13} /> : <IconGlobe size={13} />}</span>
                    <span className="truncate text-[13px] font-medium">{row.name}</span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3" title={describe(row.config)}>
                    {describe(row.config)}
                  </div>
                </div>
                <StatusCell entry={row.claude} provider="claude" copying={copying === `${row.name}:claude`} onCopy={() => void copy(row, 'claude')} />
                <StatusCell entry={row.codex} provider="codex" copying={copying === `${row.name}:codex`} onCopy={() => void copy(row, 'codex')} />
                <div className="flex w-[60px] justify-end gap-0.5 opacity-0 transition-opacity group-hover/m:opacity-100 focus-within:opacity-100">
                  <IconButton
                    label="Edit"
                    onClick={() =>
                      setEditing({
                        config: (row.claude ?? row.codex)!.config,
                        targets: PROVIDERS.filter((p) => (p === 'claude' ? !!row.claude : !!row.codex)),
                        source: { name: row.name, claudeScope: row.claude?.scope, project: row.claude?.project }
                      })
                    }
                  >
                    <IconPencil size={14} />
                  </IconButton>
                  <IconButton label="Remove" onClick={() => setRemoving(row)}>
                    <IconTrash size={14} />
                  </IconButton>
                </div>
              </div>
            ))}
          </Card>
        )}
      </Section>
      {managed.length > 0 && (
        <Section title="Managed by Claude" description="Plugin and claude.ai connector servers. Manage these in Claude itself.">
          <Card>
            {managed.map((e) => (
              <div key={e.config.name} className="flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0">
                <ProviderLogo provider="claude" size={12} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.config.name.replace(/^plugin:/, '').replace(/^claude\.ai /, '')}</span>
                <Chip tone={STATUS_TONE[e.status ?? 'unknown']}>{STATUS_TEXT[e.status ?? 'unknown']}</Chip>
                <span className="w-14 text-right text-[11px] text-fg-3">{e.scope === 'plugin' ? 'plugin' : 'claude.ai'}</span>
              </div>
            ))}
          </Card>
        </Section>
      )}
      <ServerDialog open={!!editing} onClose={() => setEditing(null)} initial={editing?.config ?? null} initialTargets={editing?.targets ?? []} source={editing?.source} onSaved={() => void load()} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} onDone={() => void load()} />
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name}?`}
        description="Choose where to remove it from."
        width={440}
        footer={
          <Button variant="ghost" onClick={() => setRemoving(null)}>
            Close
          </Button>
        }
      >
        <div className="space-y-2 pb-1">
          {removing &&
            PROVIDERS.filter((p) => (p === 'claude' ? removing.claude : removing.codex)).map((p) => {
              const entry = (p === 'claude' ? removing.claude : removing.codex)!
              return (
                <div key={p} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                  <ProviderLogo provider={p} size={14} />
                  <span className="flex-1 text-[13px]">
                    {PROVIDER_LABEL[p]} <span className="text-fg-3">· {entry.scope}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<IconTrash size={12} />}
                    onClick={async () => {
                      try {
                        await duet.mcp.remove(removing.name, p, entry.scope, entry.project)
                        toast(`Removed ${removing.name} from ${PROVIDER_LABEL[p]}`, 'success')
                        const remaining = PROVIDERS.filter((x) => x !== p && (x === 'claude' ? removing.claude : removing.codex))
                        if (!remaining.length) setRemoving(null)
                        else setRemoving({ ...removing, [p]: undefined })
                        await load()
                      } catch (e) {
                        toastError(e)
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              )
            })}
        </div>
      </Dialog>
      <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-fg-3">
        <IconArrowRight size={11} /> New servers load the next time an agent session starts.
      </p>
    </Page>
  )
}
