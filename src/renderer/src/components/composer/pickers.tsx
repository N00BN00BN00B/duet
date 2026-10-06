import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AccessMode, ModelOption, ProviderId, ProviderStatus } from '@shared/types'
import { ACCESS_MODES, PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { ProviderLogo } from '../brand'
import { ladderIndex, modelLadder, modelTier, shortModelName } from '@/lib/models'
import { IconCheck, IconChevronDown, IconHand, IconHelp, IconMap, IconPencil, IconSearch, IconUnlock } from '../icons'
import { MenuLabel, MenuSeparator, Popover, useMenuKeys } from '../ui/Popover'
import { Tooltip } from '../ui/primitives'
import { StepSlider } from '../ui/StepSlider'
import { nativeModels } from '@shared/routing'

export function ProviderSwitch({ value, onChange, statuses, disabled }: { value: ProviderId; onChange: (p: ProviderId) => void; statuses: Partial<Record<ProviderId, ProviderStatus>>; disabled?: boolean }) {
  const idx = PROVIDERS.indexOf(value)
  return (
    <div role="radiogroup" aria-label="Agent" className="relative grid h-7 shrink-0 grid-cols-2 rounded-full border border-line bg-surface-2 p-[2px]" data-testid="provider-switch">
      <span
        className="absolute bottom-[2px] top-[2px] rounded-full bg-surface shadow-sm ring-1 ring-line-strong transition-transform duration-300 ease-[var(--ease-out)]"
        style={{ left: 2, width: 'calc((100% - 4px) / 2)', transform: `translateX(${idx * 100}%)` }}
      />
      {PROVIDERS.map((p) => {
        const missing = statuses[p] && !statuses[p]!.installed
        const button = (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={value === p}
            disabled={disabled}
            onClick={() => onChange(p)}
            data-testid={`switch-${p}`}
            className={`relative z-[1] flex items-center justify-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors ${value === p ? 'text-fg' : 'text-fg-3 hover:text-fg-2'} ${missing ? 'opacity-50' : ''}`}
          >
            <span className={`transition-[filter,opacity,transform] duration-300 ${value === p ? 'scale-110' : 'opacity-70 grayscale'}`}>
              <ProviderLogo provider={p} size={13} />
            </span>
            <span className="hidden @[460px]/composer:inline">{PROVIDER_LABEL[p]}</span>
          </button>
        )
        return missing ? (
          <Tooltip key={p} label={`${PROVIDER_LABEL[p]} isn't connected — click to set it up`}>
            {button}
          </Tooltip>
        ) : (
          button
        )
      })}
    </div>
  )
}

function PickerButton({ children, onClick, open, label, testId }: { children: ReactNode; onClick: () => void; open: boolean; label: string; testId?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      onClick={onClick}
      data-testid={testId}
      className={`press flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium ${open ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'}`}
    >
      {children}
      <IconChevronDown size={12} className={`shrink-0 text-fg-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
    </button>
  )
}

export function modelLabel(models: ModelOption[], id: string | undefined): string {
  if (!id) {
    const def = models.find((m) => m.isDefault)
    return def ? def.label : 'Default'
  }
  return models.find((m) => m.id === id)?.label ?? id
}

const TIER_TAG = ['Fastest', 'Fast', 'Efficient', 'Everyday', 'Most capable']

/** Rough "smarts" and "speed" (1–5), for an at-a-glance comparison: from how the agent describes the model, else its name. */
export function modelTraits(m: Pick<ModelOption, 'id' | 'label' | 'description'>): { smarts: number; speed: number; tag?: string } {
  if (m.description && !/\bdefault\b/i.test(m.id)) {
    const tier = modelTier({ ...m, id: '', label: '' })
    if (tier !== undefined) return { smarts: tier + 1, speed: 5 - tier, tag: TIER_TAG[tier] }
  }
  const name = `${m.id} ${m.label}`.toLowerCase()
  if (/\bdefault\b/.test(name) && !/opus|sonnet|haiku|gpt|o\d/.test(name)) return { smarts: 4, speed: 3, tag: 'Recommended' }
  if (/nano/.test(name)) return { smarts: 2, speed: 5, tag: 'Fastest' }
  if (/haiku|spark|flash/.test(name)) return { smarts: 3, speed: 5, tag: 'Fast' }
  if (/mini/.test(name)) return { smarts: 3, speed: 4, tag: 'Fast' }
  if (/opus|\bpro\b|-pro|max/.test(name)) return { smarts: 5, speed: 2, tag: 'Most capable' }
  if (/codex/.test(name)) return { smarts: 4, speed: 3, tag: 'Coding' }
  if (/sonnet/.test(name)) return { smarts: 4, speed: 4, tag: 'Balanced' }
  if (/gpt-5|gpt5|o3|o4/.test(name)) return { smarts: 4, speed: 3 }
  return { smarts: 3, speed: 3 }
}

/** "Effort  High  (?)" — the popover title with the chosen (or previewed) value. */
function SliderHeader({ title, value, previewing, help, helpId, children }: { title: string; value: string; previewing: boolean; help: string; helpId: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="text-[13px] text-fg-2">{title}</span>
      <span key={value} className={`anim-fade min-w-0 truncate text-[13px] font-medium text-accent-fg ${previewing ? 'italic' : ''}`}>
        {value}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {children}
        <Tooltip label={<span className="block max-w-[220px] leading-snug">{help}</span>}>
          <button type="button" aria-label={`About ${title.toLowerCase()}`} aria-describedby={helpId} className="flex h-6 w-6 items-center justify-center rounded-full text-fg-3 hover:text-fg-2">
            <IconHelp size={15} />
          </button>
        </Tooltip>
        <span id={helpId} className="sr-only">{help}</span>
      </span>
    </div>
  )
}

function Dots({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-center gap-1" aria-label={`${label} ${value} of 5`}>
      <span className="w-9 text-[10.5px] text-fg-3">{label}</span>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`h-[5px] w-[9px] rounded-full transition-colors duration-300 ${i <= value ? 'bg-accent' : 'bg-line-strong'}`} />
      ))}
    </span>
  )
}

function ModelRow({ m, provider, active, onPick }: { m: ModelOption; provider: ProviderId; active: boolean; onPick: () => void }) {
  const traits = modelTraits(m)
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-checked={active || undefined}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick()
        }
      }}
      data-testid="model-option"
      className={`group/model relative flex cursor-default gap-3 rounded-xl px-2.5 py-2 outline-none transition-[background-color,box-shadow] duration-200 ${
        active ? 'bg-accent/10 ring-1 ring-accent/35' : 'hover:bg-hover focus:bg-hover'
      }`}
    >
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 ring-1 ring-line transition-transform duration-200 group-hover/model:scale-105 ${active ? 'ring-accent/40' : ''}`}>
        <ProviderLogo provider={provider} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-fg">{m.label}</span>
          {m.isDefault && <span className="rounded-full bg-surface-3 px-1.5 py-px text-[10px] text-fg-2">Default</span>}
          {m.routing && <span className="rounded-full bg-surface-3 px-1.5 py-px text-[10px] text-fg-3">{m.routing.combo ? 'Route' : m.routing.provider}</span>}
          {traits.tag && !m.isDefault && !m.routing && <span className="rounded-full bg-surface-3 px-1.5 py-px text-[10px] text-fg-3">{traits.tag}</span>}
        </span>
        {m.description && <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-fg-3">{m.description}</span>}
        {m.routing ? <span className="mt-1 block truncate text-[10.5px] text-fg-3">{m.routing.model}{m.supportsImages ? ' · images' : ''}</span> : <span className="mt-1.5 flex items-center gap-3"><Dots value={traits.smarts} label="Smarts" /><Dots value={traits.speed} label="Speed" /></span>}
      </span>
      <span className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center text-accent transition-opacity duration-200 ${active ? 'opacity-100' : 'opacity-0'}`}>
        <IconCheck size={14} />
      </span>
    </div>
  )
}

export function ModelMenu({
  provider,
  model,
  statuses,
  onPick,
  openSignal
}: {
  provider: ProviderId
  model: string | undefined
  statuses: Partial<Record<ProviderId, ProviderStatus>>
  onPick: (provider: ProviderId, model: string) => void
  /** Bump to open the menu from elsewhere (the /model command). */
  openSignal?: number
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (openSignal) setOpen(true)
  }, [openSignal])
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<number | null>(null)
  const helpId = useId()
  const anchor = useRef<HTMLDivElement>(null)
  const keys = useMenuKeys()
  const models = statuses[provider]?.models ?? []
  const ladder = useMemo(() => modelLadder(nativeModels(models)), [models])
  // Where the knob goes: on the chosen model, or hollow on its family (e.g. "Default", an older Opus).
  const chosen = model ? models.find((m) => m.id === model) ?? { id: model, label: model } : models.find((m) => m.isDefault)
  const place = ladderIndex(ladder.stops, chosen?.id === 'default' ? undefined : chosen)
  const ladderKey = JSON.stringify(ladder.stops.map((m) => m.id))
  useEffect(() => setPreview(null), [provider, ladderKey])
  useEffect(() => { if (!open) setPreview(null) }, [open])
  const previewStop = preview !== null ? ladder.stops[preview] : undefined
  const shorts = ladder.stops.map((m) => shortModelName(m.label))
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const order: ProviderId[] = [provider, ...PROVIDERS.filter((p) => p !== provider)]
    return order.flatMap((p) => {
      const all = (statuses[p]?.models ?? []).filter((m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.routing?.provider.toLowerCase().includes(q))
      const native = all.filter((m) => !m.routing)
      const routed = all.filter((m) => m.routing)
      return [{ provider: p, name: PROVIDER_LABEL[p], models: native }, ...[...new Set(routed.map((m) => m.routing!.provider))].sort().map((name) => ({ provider: p, name: name === 'combo' ? 'Routes' : name, models: routed.filter((m) => m.routing!.provider === name) }))]
    })
  }, [statuses, provider, query])
  return (
    <div ref={anchor} className="min-w-0">
      <PickerButton open={open} onClick={() => setOpen((v) => !v)} label="Model" testId="model-menu">
        <span className="max-w-[9rem] truncate @[640px]/composer:max-w-[14rem]">{modelLabel(models, model)}</span>
      </PickerButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" width={360} label="Model">
        <div onKeyDown={keys} className="p-1.5">
          {ladder.stops.length > 1 && (
            <>
              <div className="px-2.5 pb-2 pt-2" data-testid="model-ladder">
                <SliderHeader
                  title="Model"
                  value={previewStop?.label ?? (chosen?.id === 'default' && chosen.description?.includes(' · ') ? `Default · ${chosen.description.split(' · ')[0]}` : modelLabel(models, model))}
                  previewing={!!previewStop}
                  help={`${PROVIDER_LABEL[provider]}'s model families, from quickest to most capable. Exact versions and the other agent's models are in the list below.`}
                  helpId={helpId}
                />
                <StepSlider
                  stops={ladder.stops.map((m, i) => ({ id: m.id, label: m.label, short: shorts.filter((s) => s === shorts[i]).length > 1 ? m.label.replace(/\s*\(.*\)\s*$/, '') : shorts[i] }))}
                  value={place?.exact ? place.index : null}
                  rest={place?.index}
                  recommended={ladder.recommended}
                  onCommit={(i) => onPick(provider, ladder.stops[i].id)}
                  onPreview={setPreview}
                  label="Model"
                  describedBy={helpId}
                  unplaced={!!chosen && chosen.id !== 'default' && !place}
                  valueText={!place?.exact ? chosen?.id === 'default' || !chosen ? 'Default (automatic model selection)' : `${chosen.label}${place ? ` (near ${ladder.stops[place.index].label})` : ' (not on this ladder)'}` : undefined}
                  minLabel="Faster"
                  maxLabel="Smarter"
                  showLabels
                  testId="model-slider"
                />
              </div>
              <MenuSeparator />
            </>
          )}
          <div className="mb-1.5 mt-1 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 focus-within:border-line-strong">
            <IconSearch size={13} className="text-fg-3" />
            <input
              data-autofocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models"
              className="h-8 w-full bg-transparent text-[12.5px] outline-none placeholder:text-fg-3"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  e.currentTarget.closest('[role="dialog"]')?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
                }
              }}
            />
          </div>
          <div className="scroll-y max-h-[420px] space-y-0.5">
            {groups.map((g, gi) => (
              <div key={`${g.provider}:${g.name}`} className="space-y-0.5">
                {gi > 0 && <MenuSeparator />}
                <MenuLabel>
                  <span className="flex items-center gap-1.5">
                    {g.name}
                    {g.name !== PROVIDER_LABEL[g.provider] && <span className="font-normal text-fg-3">· via {PROVIDER_LABEL[g.provider]}</span>}
                    {g.provider !== provider && <span className="font-normal text-fg-3">· picking one switches agent</span>}
                  </span>
                </MenuLabel>
                {g.models.length === 0 && <div className="px-2.5 py-1.5 text-[12px] text-fg-3">{statuses[g.provider]?.installed === false ? 'Not connected' : 'Loading models…'}</div>}
                {g.models.map((m) => (
                  <ModelRow
                    key={`${g.provider}:${m.id}`}
                    m={m}
                    provider={g.provider}
                    active={g.provider === provider && (model ? model === m.id : !!m.isDefault)}
                    onPick={() => {
                      onPick(g.provider, m.id)
                      setOpen(false)
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </Popover>
    </div>
  )
}

export const EFFORT_LABEL: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
const EFFORT_HINT: Record<string, string> = {
  none: 'Answers straight away, no thinking.',
  minimal: 'Barely thinks — quickest answers.',
  low: 'Light thinking for simple tasks.',
  medium: 'Balanced thinking for everyday work.',
  high: 'Thinks harder on tricky problems.',
  xhigh: 'Very thorough. Slower, uses more of your limits.',
  max: 'Thinks as long as it needs. Slowest, uses the most of your limits.',
  ultra: 'Thinks as long as it needs. Slowest, uses the most of your limits.'
}

/** Signal-strength bars: how much thinking the selected effort buys. */
export function EffortBars({ level, of, size = 13, className = '' }: { level: number; of: number; size?: number; className?: string }) {
  const bars = Math.max(3, Math.min(5, of))
  const filled = of <= 0 ? 0 : Math.round((level / of) * bars)
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className={className} aria-hidden>
      {Array.from({ length: bars }, (_, i) => {
        const w = 14 / bars
        const h = 3 + ((14 - 3) * (i + 1)) / bars
        return <rect key={i} x={i * w + 0.6} y={14 - h} width={w - 1.6} height={h} rx={0.9} fill="currentColor" opacity={i < filled ? 1 : 0.25} style={{ transition: 'opacity 250ms var(--ease-out)' }} />
      })}
    </svg>
  )
}

export function EffortMenu({
  efforts,
  value,
  defaultEffort,
  onPick,
  hints,
  openSignal
}: {
  efforts: string[]
  value: string | undefined
  defaultEffort?: string
  onPick: (effort: string | undefined) => void
  /** The agent's own description of each level, when it gives one. */
  hints?: Record<string, string>
  openSignal?: number
}) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<number | null>(null)
  const helpId = useId()
  const effortKey = JSON.stringify(efforts)
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (openSignal) setOpen(true)
  }, [openSignal])
  useEffect(() => {
    if (!open) setPreview(null)
  }, [open])
  useEffect(() => setPreview(null), [effortKey])
  if (!efforts.length) return null
  const current = value && efforts.includes(value) ? value : undefined
  const recommended = defaultEffort && efforts.includes(defaultEffort) ? efforts.indexOf(defaultEffort) : undefined
  const previewEffort = preview !== null ? efforts[preview] : undefined
  const shown = previewEffort ?? current
  const name = (level: string) => EFFORT_LABEL[level] ?? level
  const idx = current ? efforts.indexOf(current) + 1 : efforts.indexOf(defaultEffort ?? '') + 1
  return (
    <div ref={anchor}>
      <PickerButton open={open} onClick={() => setOpen((v) => !v)} label="Reasoning effort" testId="effort-menu">
        <EffortBars level={idx} of={efforts.length} className={current ? 'text-accent' : 'text-fg-3'} />
        <span className="hidden @[600px]/composer:inline">{current ? name(current) : 'Auto'}</span>
      </PickerButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" width={320} noFocus label="Reasoning effort">
        <div className="p-3.5 pb-3" data-testid="effort-popover">
          <SliderHeader
            title="Effort"
            value={shown ? name(shown) : 'Auto'}
            previewing={!!previewEffort}
            help="How long the agent thinks before it answers. More effort is smarter but slower, and uses more of your limits."
            helpId={helpId}
          >
            <button
              type="button"
              aria-label="Use automatic effort"
              aria-disabled={!current || undefined}
              onClick={() => { if (current) onPick(undefined) }}
              data-testid="effort-auto"
              className={`press rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${!current ? 'bg-accent/15 text-accent-fg ring-1 ring-accent/30' : 'text-fg-3 ring-1 ring-line hover:text-fg-2'}`}
            >
              Auto
            </button>
          </SliderHeader>
          <StepSlider
            stops={efforts.map((e) => ({ id: e, label: name(e) }))}
            value={current ? efforts.indexOf(current) : null}
            rest={recommended}
            recommended={recommended}
            onCommit={(i) => onPick(efforts[i])}
            onPreview={setPreview}
            label="Reasoning effort"
            describedBy={helpId}
            valueText={current ? undefined : `Auto (automatic${defaultEffort ? `; usually ${name(defaultEffort)}` : ''})`}
            minLabel="Faster"
            maxLabel="Smarter"
            autoFocus
            testId="effort-slider"
          />
          <div className="mt-2 h-[4.2em] overflow-y-auto text-[12px] leading-snug text-fg-2">
            {shown ? (hints?.[shown] ?? EFFORT_HINT[shown] ?? '') : `Lets the model decide${defaultEffort ? ` — usually ${name(defaultEffort)}` : ''}. Drag to choose a level.`}
          </div>
        </div>
      </Popover>
    </div>
  )
}

const ACCESS_TONE: Record<AccessMode, string> = {
  plan: 'bg-info/15 text-info',
  ask: 'bg-surface-3 text-fg-2',
  auto: 'bg-ok/15 text-ok',
  full: 'bg-warn/15 text-warn'
}

export const ACCESS_ICON: Record<AccessMode, (size: number) => ReactNode> = {
  plan: (s) => <IconMap size={s} />,
  ask: (s) => <IconHand size={s} />,
  auto: (s) => <IconPencil size={s} />,
  full: (s) => <IconUnlock size={s} />
}

export function AccessMenu({ value, onPick }: { value: AccessMode; onPick: (a: AccessMode) => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const keys = useMenuKeys()
  const current = ACCESS_MODES.find((m) => m.id === value) ?? ACCESS_MODES[1]
  return (
    <div ref={anchor}>
      <PickerButton open={open} onClick={() => setOpen((v) => !v)} label="Permissions" testId="access-menu">
        <span className={`shrink-0 ${value === 'full' ? 'text-warn' : 'text-fg-3'}`}>{ACCESS_ICON[value](13)}</span>
        <span className="hidden @[540px]/composer:inline">{current.label}</span>
      </PickerButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" width={300}>
        <div onKeyDown={keys} className="space-y-0.5 p-1.5">
          <MenuLabel>What the agent may do without asking</MenuLabel>
          {ACCESS_MODES.map((m) => (
            <div
              key={m.id}
              role="menuitem"
              tabIndex={-1}
              aria-checked={m.id === value || undefined}
              onClick={() => {
                onPick(m.id)
                setOpen(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onPick(m.id)
                  setOpen(false)
                }
              }}
              className={`group/acc flex cursor-default items-start gap-3 rounded-xl px-2.5 py-2 outline-none transition-colors ${m.id === value ? 'bg-accent/10 ring-1 ring-accent/30' : 'hover:bg-hover focus:bg-hover'}`}
            >
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 group-hover/acc:scale-105 ${ACCESS_TONE[m.id]}`}>{ACCESS_ICON[m.id](14)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-fg">{m.label}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-3">{m.hint}</span>
              </span>
              {m.id === value && <IconCheck size={14} className="mt-1 shrink-0 text-accent" />}
            </div>
          ))}
        </div>
      </Popover>
    </div>
  )
}

export function ContextRing({ used, total }: { used: number; total?: number }) {
  if (!total || !used) return null
  const pct = Math.min(100, (used / total) * 100)
  const r = 6.5
  const c = 2 * Math.PI * r
  const color = pct > 85 ? 'var(--bad)' : pct > 65 ? 'var(--warn)' : 'var(--text-3)'
  return (
    <Tooltip label={`Context: ${Math.round(used / 1000)}k of ${Math.round(total / 1000)}k tokens (${Math.round(pct)}%)`}>
      <span className="flex h-7 items-center gap-1 px-1 text-[11px] tabular-nums text-fg-3" aria-label="Context used">
        <svg width="15" height="15" viewBox="0 0 17 17">
          <circle cx="8.5" cy="8.5" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="2.2" />
          <circle cx="8.5" cy="8.5" r={r} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 8.5 8.5)" style={{ transition: 'stroke-dasharray 500ms var(--ease-out)' }} />
        </svg>
        {Math.round(pct)}%
      </span>
    </Tooltip>
  )
}
