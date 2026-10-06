import { useEffect, useMemo, useState } from 'react'
import type { ProviderId, UsageDay, UsageSummary } from '@shared/types'
import { PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { duet } from '@/lib/api'
import { formatCost, formatTokens, resetsIn, shortModel } from '@/lib/format'
import { connectProvider, saveSettings, toastError, useApp } from '@/state/store'
import { ProviderLogo } from '../brand'
import { IconRefresh, Spinner } from '../icons'
import { Button, Meter, Segmented, Switch } from '../ui/primitives'
import { Card, Page, Row, Section } from './Page'

const total = (d: Pick<UsageDay, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>) => d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens
const COLOR: Record<ProviderId, string> = { claude: 'var(--claude)', codex: 'var(--codex)' }

function dayList(from: string, to: string): string[] {
  const out: string[] = []
  const d = new Date(`${from}T12:00:00`)
  const end = new Date(`${to}T12:00:00`)
  while (d <= end && out.length < 400) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    d.setDate(d.getDate() + 1)
  }
  return out
}

function LimitsCard({ id }: { id: ProviderId }) {
  const st = useApp((s) => s.providers[id])
  const connecting = useApp((s) => s.connecting === id)
  const disconnected = st && (!st.installed || st.loggedIn === false)
  return (
    <Card data-testid={`limits-${id}`}>
      <Row>
        <ProviderLogo provider={id} size={16} />
        <div className="flex-1">
          <div className="text-[13px] font-medium">{PROVIDER_LABEL[id]}</div>
          <div className="text-[11.5px] text-fg-3">{!st ? 'Checking…' : !st.installed ? 'Not installed' : st.loggedIn === false ? 'Signed out' : [st.plan, st.account].filter(Boolean).join(' · ') || 'Connected'}</div>
        </div>
        {disconnected && (
          <Button size="sm" variant="accent" onClick={() => void connectProvider(id)} icon={connecting ? <Spinner size={12} /> : undefined}>
            {!st?.installed ? 'Install' : 'Connect'}
          </Button>
        )}
      </Row>
      <div className="space-y-3 px-4 py-3">
        {st?.limits?.length ? (
          st.limits.map((l) => (
            <div key={l.label}>
              <div className="mb-1 flex justify-between text-[12px]">
                <span className="text-fg-2">{l.label}</span>
                <span className="tabular-nums text-fg-3">
                  {l.usedPercent}% used{l.resetsAt ? ` · ${resetsIn(l.resetsAt)}` : ''}
                </span>
              </div>
              <Meter value={l.usedPercent} />
            </div>
          ))
        ) : (
          <div className="text-[12px] text-fg-3">{disconnected ? 'Connect to see your limits.' : 'Limits show up after the first reply.'}</div>
        )}
      </div>
    </Card>
  )
}

function ActivityChart({ days, rows }: { days: string[]; rows: UsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const perDay = useMemo(() => {
    const map = new Map<string, Record<ProviderId, number>>()
    for (const d of days) map.set(d, { claude: 0, codex: 0 })
    for (const r of rows) {
      const e = map.get(r.day)
      if (e) e[r.provider] += total(r)
    }
    return days.map((d) => ({ day: d, ...map.get(d)! }))
  }, [days, rows])
  const max = Math.max(1, ...perDay.map((d) => d.claude + d.codex))
  const W = 720
  const H = 150
  const gap = days.length > 60 ? 1 : 3
  const bar = (W - gap * (days.length - 1)) / days.length
  const shown = hover !== null ? perDay[hover] : null
  return (
    <div className="relative">
      <div className="mb-2 flex h-5 items-center gap-3 text-[11.5px] text-fg-3">
        {shown ? (
          <>
            <span className="text-fg-2">{new Date(`${shown.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            {PROVIDERS.map((p) => (
              <span key={p} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm" style={{ background: COLOR[p] }} />
                {formatTokens(shown[p])}
              </span>
            ))}
          </>
        ) : (
          PROVIDERS.map((p) => (
            <span key={p} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm" style={{ background: COLOR[p] }} />
              {PROVIDER_LABEL[p]}
            </span>
          ))
        )}
        <span className="ml-auto">{perDay.some((d) => d.claude + d.codex > 0) ? `peak ${formatTokens(max)} tokens/day` : 'no activity in this range yet'}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[150px] w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)} role="img" aria-label="Tokens per day">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H - H * f} y2={H - H * f} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {perDay.map((d, i) => {
          const x = i * (bar + gap)
          const hc = (d.claude / max) * (H - 4)
          const hx = (d.codex / max) * (H - 4)
          const dim = hover !== null && hover !== i
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} style={{ opacity: dim ? 0.45 : 1, transition: 'opacity 150ms' }}>
              <rect x={x} y={0} width={bar} height={H} fill="transparent" />
              {hx > 0 && <rect x={x} y={H - hx} width={bar} height={hx} rx={Math.min(3, bar / 3)} fill={COLOR.codex} />}
              {hc > 0 && <rect x={x} y={H - hx - hc} width={bar} height={hc} rx={Math.min(3, bar / 3)} fill={COLOR.claude} />}
            </g>
          )
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10.5px] text-fg-3">
        <span>{days[0]}</span>
        <span>{days[days.length - 1]}</span>
      </div>
    </div>
  )
}

export function UsageView() {
  const settings = useApp((s) => s.settings)
  const nonce = useApp((s) => s.usageNonce)
  const [range, setRange] = useState('14')
  const [data, setData] = useState<UsageSummary | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let cancelled = false
    duet.usage
      .summary(Number(range))
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && toastError(e))
    return () => {
      cancelled = true
    }
  }, [range, nonce, settings?.usageIncludeOutside])

  const days = useMemo(() => (data ? dayList(data.from, data.to) : []), [data])
  const totals = useMemo(() => {
    const t = { tokens: 0, input: 0, output: 0, cache: 0, cost: 0, turns: 0, duet: 0 }
    for (const r of data?.days ?? []) {
      t.tokens += total(r)
      t.input += r.inputTokens
      t.output += r.outputTokens
      t.cache += r.cacheReadTokens + r.cacheWriteTokens
      t.cost += r.costUsd
      t.turns += r.turns
      if (r.source === 'duet') t.duet += total(r)
    }
    return t
  }, [data])
  const models = useMemo(() => {
    const map = new Map<string, { provider: ProviderId; model: string; tokens: number; cost: number; turns: number }>()
    for (const r of data?.days ?? []) {
      const key = `${r.provider}|${r.model}`
      const m = map.get(key) ?? { provider: r.provider, model: r.model, tokens: 0, cost: 0, turns: 0 }
      m.tokens += total(r)
      m.cost += r.costUsd
      m.turns += r.turns
      map.set(key, m)
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens)
  }, [data])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await duet.usage.rescan()
      setData(await duet.usage.summary(Number(range)))
    } catch (e) {
      toastError(e)
    } finally {
      setRefreshing(false)
    }
  }

  if (!settings) return null
  return (
    <Page
      title="Usage"
      testId="usage-view"
      actions={
        <Button size="sm" variant="ghost" onClick={() => void refresh()} icon={refreshing || data?.scanning ? <Spinner size={13} /> : <IconRefresh size={13} />}>
          Refresh
        </Button>
      }
    >
      <Section title="Limits" description="How much of each plan's rolling limits you've used. Switch agents when one runs low.">
        <div className="grid gap-3 md:grid-cols-2">
          {PROVIDERS.map((p) => (
            <LimitsCard key={p} id={p} />
          ))}
        </div>
      </Section>

      <Section title="Activity" description={settings.usageIncludeOutside ? 'Tokens from everything you ran in Claude Code and Codex, in Duet or not.' : 'Tokens from chats run in Duet.'}>
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="w-[220px]">
              <Segmented size="sm" value={range} onChange={setRange} options={[{ value: '7', label: '7 days' }, { value: '14', label: '14' }, { value: '30', label: '30' }, { value: '90', label: '90' }]} />
            </div>
            <label className="ml-auto flex items-center gap-2 whitespace-nowrap text-[12px] text-fg-2">
              Count use outside Duet
              <Switch checked={settings.usageIncludeOutside} onChange={(v) => void saveSettings({ usageIncludeOutside: v })} label="Count use outside Duet" />
            </label>
          </div>
          {!data ? (
            <div className="flex h-[190px] items-center justify-center text-fg-3">
              <Spinner size={18} />
            </div>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="usage-totals">
                <Stat label="Tokens" value={formatTokens(totals.tokens)} hint={`${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out`} />
                <Stat label="Cached" value={formatTokens(totals.cache)} hint="read from cache — cheap and fast" />
                <Stat label="Responses" value={totals.turns.toLocaleString()} hint={totals.duet ? `${Math.round((totals.duet / Math.max(1, totals.tokens)) * 100)}% in Duet` : 'model calls'} />
                <Stat label="Est. cost" value={totals.cost > 0 ? formatCost(totals.cost) : '—'} hint="Claude's own estimate at API prices" />
              </div>
              <ActivityChart days={days} rows={data.days} />
              {data.scanning && <div className="mt-2 text-[11.5px] text-fg-3">Reading your Claude Code and Codex history… numbers fill in as it goes.</div>}
            </>
          )}
        </Card>
      </Section>

      {models.length > 0 && (
        <Section title="By model">
          <Card>
            {models.slice(0, 12).map((m) => (
              <Row key={`${m.provider}|${m.model}`}>
                <ProviderLogo provider={m.provider} size={13} />
                <span className="w-44 truncate font-mono text-[12px]">{shortModel(m.model)}</span>
                <div className="min-w-[120px] flex-1">
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(2, (m.tokens / Math.max(1, models[0].tokens)) * 100)}%`, background: COLOR[m.provider] }} />
                  </div>
                </div>
                <span className="w-20 text-right text-[12px] tabular-nums text-fg-2">{formatTokens(m.tokens)}</span>
                <span className="w-16 text-right text-[12px] tabular-nums text-fg-3">{m.cost > 0 ? formatCost(m.cost) : ''}</span>
              </Row>
            ))}
          </Card>
        </Section>
      )}

      {data?.codexAccount && (
        <Section title="Codex account" description="Straight from OpenAI, across all your devices.">
          <Card className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
            <Stat label="Lifetime tokens" value={formatTokens(data.codexAccount.lifetimeTokens)} />
            <Stat label="Best day" value={formatTokens(data.codexAccount.peakDailyTokens)} />
            <Stat label="Current streak" value={`${data.codexAccount.currentStreakDays ?? 0} days`} />
            <Stat label="Longest streak" value={`${data.codexAccount.longestStreakDays ?? 0} days`} />
          </Card>
        </Section>
      )}
    </Page>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[11.5px] text-fg-3">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold tabular-nums tracking-[-0.01em]">{value}</div>
      {hint && <div className="text-[11px] text-fg-3">{hint}</div>}
    </div>
  )
}
