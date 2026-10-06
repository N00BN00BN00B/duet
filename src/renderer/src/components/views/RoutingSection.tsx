import { useEffect, useState } from 'react'
import type { RoutingCombo, RoutingStatus } from '@shared/types'
import { duet } from '@/lib/api'
import { refreshProviders, toast, toastError, useApp } from '@/state/store'
import { IconExternal, IconPlus, IconRefresh, IconTrash, Spinner } from '../icons'
import { Button, Chip, Switch, inputClass } from '../ui/primitives'
import { Card, Row, Section } from './Page'

type Target = { selector: string; weight: number }

export function RoutingSection() {
  const settings = useApp((s) => s.settings)
  const running = useApp((s) => Object.values(s.threads).some((t) => t.status === 'running' || t.status === 'approval'))
  const [status, setStatus] = useState<RoutingStatus | null>(null)
  const [endpoint, setEndpoint] = useState(settings?.routing.endpoint ?? 'http://127.0.0.1:10100')
  const [enabled, setEnabled] = useState(settings?.routing.enabled ?? false)
  const [dataKey, setDataKey] = useState('')
  const [adminKey, setAdminKey] = useState('')
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState(false)
  const [id, setId] = useState('')
  const [editingId, setEditingId] = useState('')
  const [strategy, setStrategy] = useState<'failover' | 'round-robin'>('failover')
  const [targets, setTargets] = useState<Target[]>([{ selector: '', weight: 1 }])
  const [error, setError] = useState('')
  const load = () => duet.routing.status().then(setStatus).catch((e) => setError(String(e.message ?? e)))
  useEffect(() => { void load() }, [])

  const run = async (label: string, action: () => Promise<RoutingStatus>, success?: string) => {
    setBusy(label)
    setError('')
    try {
      const next = await action()
      setStatus(next)
      const saved = await duet.settings.get()
      useApp.setState({ settings: saved })
      setEndpoint(saved.routing.endpoint)
      setEnabled(saved.routing.enabled)
      setDataKey('')
      setAdminKey('')
      await refreshProviders()
      if (success) toast(success, 'success')
      return next
    } catch (e) { setError((e as Error).message); return null } finally { setBusy('') }
  }
  const edit = (combo?: RoutingCombo) => {
    setEditing(true)
    setId(combo?.id ?? '')
    setEditingId(combo?.id ?? '')
    setStrategy(combo?.strategy === 'round-robin' ? 'round-robin' : 'failover')
    setTargets(combo?.targets.map((t) => ({ selector: `${t.provider}/${t.model}`, weight: t.weight })) ?? [{ selector: '', weight: 1 }])
  }
  const models = status?.models.filter((m) => m.routing && !m.routing.combo && m.routing.model.includes('/')) ?? []
  const providers = [...new Set(status?.models.map((m) => m.routing?.provider).filter((p) => p && p !== 'combo'))]
  return (
    <Section title="Models & routing" description="Use Gemini, Grok, DeepSeek, Kimi, Qwen, OpenRouter, Ollama and other providers with either agent. OpenCodex handles the provider connections and routing.">
      <Card data-testid="routing-settings">
        <Row>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              Provider models
              {status?.connected ? <Chip tone="ok">{status.models.length} models</Chip> : <Chip>not connected</Chip>}
            </div>
            <div className="mt-1 text-[11.5px] text-fg-3">Keep your native Claude and Codex models, and add models from your connected providers.</div>
          </div>
          <Switch checked={enabled} disabled={!!busy || running} onChange={(v) => { setEnabled(v); void run('Saving', () => duet.routing.connect({ endpoint, enabled: v })) }} label="Enable provider models" />
        </Row>
        <div className="space-y-3 border-t border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[200px] flex-1 text-[12px] text-fg-2">Install the routing engine once, then connect your providers in its dashboard.</div>
            {!status?.managedInstalled ? (
              <Button size="sm" variant="secondary" disabled={!!busy || running} onClick={() => void run('Installing routing engine', () => duet.routing.install(), 'Routing engine installed. Open Providers to connect your models.')} data-testid="routing-install">
                {busy === 'Installing routing engine' && <Spinner size={13} />} Install engine
              </Button>
            ) : status.managedRunning ? (
              <Button size="sm" variant="ghost" disabled={!!busy || running} onClick={() => void run('Stopping', () => duet.routing.stop())}>Stop engine</Button>
            ) : (
              <Button size="sm" variant="secondary" disabled={!!busy || running} onClick={() => void run('Starting', () => duet.routing.start())}>Start engine</Button>
            )}
            <Button size="sm" variant="secondary" disabled={!status?.connected || !!busy} icon={<IconExternal size={13} />} onClick={() => void duet.routing.dashboard().catch(toastError)} data-testid="routing-dashboard">Providers</Button>
          </div>
          {status?.connected && <div className="text-[11.5px] text-fg-3">{providers.join(' · ') || 'Connect a provider to discover its models.'}</div>}
          <details className="text-[12px] text-fg-2">
            <summary className="cursor-pointer py-1">Connection settings {status?.connected && <span className="ml-1 text-fg-3">· {status.endpoint}</span>}</summary>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block md:col-span-2"><span className="mb-1 block text-[11.5px] text-fg-3">Routing server address</span>
                <input aria-label="Routing server address" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} spellCheck={false} className={`${inputClass} font-mono text-[12px]`} />
              </label>
              <label className="block"><span className="mb-1 block text-[11.5px] text-fg-3">API key · optional for localhost</span>
                <input aria-label="Routing API key" type="password" autoComplete="off" value={dataKey} onChange={(e) => setDataKey(e.target.value)} placeholder={status?.hasDataKey ? 'Saved · leave blank to keep' : 'Data-plane API key'} className={inputClass} />
              </label>
              <label className="block"><span className="mb-1 block text-[11.5px] text-fg-3">Admin key · for editing routes</span>
                <input aria-label="Routing admin key" type="password" autoComplete="off" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} placeholder={status?.hasAdminKey ? 'Connected · leave blank to keep' : 'Auto-detected for local OpenCodex'} className={inputClass} />
              </label>
              <div className="flex flex-wrap items-center gap-2 md:col-span-2">
                <Button size="sm" disabled={!!busy || running} variant="secondary" onClick={() => void run('Connecting', () => duet.routing.connect({ endpoint, enabled, ...(dataKey ? { dataKey } : {}), ...(adminKey ? { adminKey } : {}) }))} data-testid="routing-connect">Save connection</Button>
                {(status?.hasDataKey || status?.hasAdminKey) && <Button size="sm" variant="ghost" disabled={!!busy || running} onClick={() => void run('Clearing keys', () => duet.routing.connect({ endpoint, enabled, dataKey: '', adminKey: '' }))}>Clear saved keys</Button>}
                <span className="text-[11px] text-fg-3">Keys stay encrypted on this Mac and are excluded from backups.</span>
              </div>
            </div>
          </details>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={!!busy} icon={busy ? <Spinner size={13} /> : <IconRefresh size={13} />} onClick={() => void run('Refreshing models', () => duet.routing.status())} data-testid="routing-refresh">Refresh models</Button>
            {busy && <span role="status" className="text-[12px] text-fg-3">{busy}…</span>}
            {running && <span className="text-[11.5px] text-fg-3">Stop the agents before changing routes.</span>}
          </div>
          {(error || (enabled && status?.error)) && <div role="alert" className="rounded-lg border border-warn/25 bg-warn/6 px-3 py-2 text-[12px] text-fg-2">{error || status?.error}</div>}
        </div>

        <div className="border-t border-line px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div><div className="text-[13px] font-medium">Routes</div><div className="mt-0.5 text-[11.5px] text-fg-3">Prefer a model with backups, or distribute requests across models.</div></div>
            <Button size="sm" variant="secondary" icon={<IconPlus size={13} />} disabled={!status?.canManage || !!busy || running} onClick={() => edit()} data-testid="routing-new-route">New route</Button>
          </div>
          {!status?.canManage && <p className="text-[12px] text-fg-3">{status?.managementError || 'Connect the engine to create routes. For a remote server, add its admin key.'}</p>}
          {status?.combos.map((combo) => (
            <div key={combo.id} className="flex items-center gap-3 border-t border-line py-2.5" data-testid="routing-route">
              <div className="min-w-0 flex-1"><div className="text-[12.5px] font-medium">{combo.id} <span className="ml-1 font-normal text-fg-3">· {combo.strategy === 'failover' ? 'Fallback' : combo.strategy === 'round-robin' ? 'Weighted distribution' : combo.strategy}</span></div><div className="mt-0.5 truncate text-[11.5px] text-fg-3">{combo.targets.map((t) => `${t.provider}/${t.model}`).join(' → ')}</div></div>
              <Button size="sm" variant="ghost" disabled={!!busy || running || !['failover', 'round-robin'].includes(combo.strategy)} onClick={() => edit(combo)}>Edit</Button>
              <Button size="sm" variant="ghost" icon={<IconTrash size={13} />} disabled={!!busy || running} onClick={() => void run('Removing route', () => duet.routing.removeCombo(combo.id))} aria-label={`Remove route ${combo.id}`} />
            </div>
          ))}
          {status?.canManage && !status.combos.length && !editing && <p className="text-[12px] text-fg-3">No routes yet. Choose New route to set your preferred model and backups.</p>}
          {editing && (
            <form className="mt-3 space-y-3 rounded-xl border border-line bg-surface-2 p-3" data-testid="routing-route-editor" onSubmit={(e) => {
              e.preventDefault()
              if (!editingId && status?.combos.some((c) => c.id === id)) { setError('That route already exists. Choose another name, or edit the existing route.'); return }
              void run('Saving route', () => duet.routing.saveCombo({ id, strategy, targets: targets.map((t) => { const slash = t.selector.indexOf('/'); return { provider: t.selector.slice(0, slash), model: t.selector.slice(slash + 1), weight: t.weight } }) }), 'Route saved — choose it in the model menu.').then((next) => { if (next) setEditing(false) })
            }}>
              <div className="grid grid-cols-2 gap-3">
                <label><span className="mb-1 block text-[11.5px] text-fg-3">Route name</span><input aria-label="Route name" readOnly={!!editingId} required maxLength={64} pattern={'[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}'} value={id} onChange={(e) => setId(e.target.value)} className={inputClass} /></label>
                <label><span className="mb-1 block text-[11.5px] text-fg-3">Strategy</span><select aria-label="Routing strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)} className={inputClass}><option value="failover">Ordered fallback</option><option value="round-robin">Weighted distribution</option></select></label>
              </div>
              <p className="text-[11.5px] text-fg-3">{strategy === 'failover' ? 'The first model is preferred. Retryable failures use the next available model in this order.' : 'Models receive requests in proportion to their weights. Retryable failures can use another target.'}</p>
              {targets.map((target, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-5 text-center text-[11px] text-fg-3">{i + 1}</span>
                  <select aria-label={`Route target ${i + 1}`} required value={target.selector} onChange={(e) => setTargets((t) => t.map((x, j) => j === i ? { ...x, selector: e.target.value } : x))} className={`${inputClass} min-w-0 flex-1`}>
                    <option value="">Choose a model</option>
                    {target.selector && !models.some((m) => m.routing?.model === target.selector) && <option value={target.selector}>{target.selector} · unavailable</option>}
                    {models.map((m) => <option key={m.id} value={m.routing!.model}>{m.routing!.provider} · {m.label}</option>)}
                  </select>
                  {strategy === 'round-robin' && <input type="number" aria-label={`Target ${i + 1} weight`} min={1} max={10000} required value={target.weight} onChange={(e) => setTargets((t) => t.map((x, j) => j === i ? { ...x, weight: Number(e.target.value) } : x))} className={`${inputClass} w-20`} />}
                  <Button size="sm" variant="ghost" icon={<IconTrash size={13} />} disabled={targets.length === 1} aria-label={`Remove target ${i + 1}`} onClick={() => setTargets((t) => t.filter((_, j) => j !== i))} />
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="ghost" disabled={targets.length >= 20} icon={<IconPlus size={13} />} onClick={() => setTargets((t) => [...t, { selector: '', weight: 1 }])}>Add target</Button><span className="flex-1" /><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button><Button type="submit" size="sm" variant="accent" disabled={!!busy || running}>Save route</Button></div>
            </form>
          )}
        </div>
        <div className="border-t border-line px-4 py-2.5 text-[11.5px] text-fg-3">Models appear after you connect a provider or install a local model. Access, billing and model capabilities come from that provider.</div>
      </Card>
    </Section>
  )
}
