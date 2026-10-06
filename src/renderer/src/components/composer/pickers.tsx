import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { AccessMode, ModelOption, ProviderId, ProviderStatus } from '@shared/types'
import { ACCESS_MODES, PROVIDER_LABEL, PROVIDERS } from '@shared/types'
import { ProviderLogo } from '../brand'
import { IconCheck, IconChevronDown, IconGauge, IconHand, IconMap, IconPencil, IconSearch, IconUnlock } from '../icons'
import { MenuItem, MenuLabel, MenuSeparator, Popover, useMenuKeys } from '../ui/Popover'
import { Tooltip } from '../ui/primitives'

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
            <span className={`transition-[filter,opacity] duration-300 ${value === p ? '' : 'opacity-70 grayscale'}`}>
              <ProviderLogo provider={p} size={13} />
            </span>
            <span className="hidden @[460px]/composer:inline">{PROVIDER_LABEL[p]}</span>
          </button>
        )
        return missing ? (
          <Tooltip key={p} label={`${PROVIDER_LABEL[p]} CLI not found — see Settings`}>
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
      <IconChevronDown size={12} className="shrink-0 text-fg-3" />
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

export function ModelMenu({
  provider,
  model,
  statuses,
  onPick
}: {
  provider: ProviderId
  model: string | undefined
  statuses: Partial<Record<ProviderId, ProviderStatus>>
  onPick: (provider: ProviderId, model: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchor = useRef<HTMLDivElement>(null)
  const keys = useMenuKeys()
  const models = statuses[provider]?.models ?? []
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const order: ProviderId[] = [provider, ...PROVIDERS.filter((p) => p !== provider)]
    return order.map((p) => ({ provider: p, models: (statuses[p]?.models ?? []).filter((m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) }))
  }, [statuses, provider, query])
  return (
    <div ref={anchor} className="min-w-0">
      <PickerButton open={open} onClick={() => setOpen((v) => !v)} label="Model" testId="model-menu">
        <span className="max-w-[9rem] truncate @[640px]/composer:max-w-[14rem]">{modelLabel(models, model)}</span>
      </PickerButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" width={300}>
        <div onKeyDown={keys} className="p-1.5">
          <div className="mb-1 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2">
            <IconSearch size={13} className="text-fg-3" />
            <input
              data-autofocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models"
              className="h-7 w-full bg-transparent text-[12.5px] outline-none placeholder:text-fg-3"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  e.currentTarget.closest('[role="dialog"]')?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
                }
              }}
            />
          </div>
          <div className="scroll-y max-h-[340px]">
            {groups.map((g, gi) => (
              <div key={g.provider}>
                {gi > 0 && <MenuSeparator />}
                <MenuLabel>
                  <span className="flex items-center gap-1.5">
                    <ProviderLogo provider={g.provider} size={11} />
                    {PROVIDER_LABEL[g.provider]}
                    {g.provider !== provider && <span className="text-fg-3">· switches agent</span>}
                  </span>
                </MenuLabel>
                {g.models.length === 0 && <div className="px-2.5 py-1.5 text-[12px] text-fg-3">{statuses[g.provider]?.installed === false ? 'Not installed' : 'Loading models…'}</div>}
                {g.models.map((m) => {
                  const active = g.provider === provider && (model ? model === m.id : !!m.isDefault)
                  return (
                    <MenuItem
                      key={`${g.provider}:${m.id}`}
                      active={active}
                      icon={active ? <IconCheck size={14} /> : <span />}
                      description={m.description && m.description.length < 90 ? m.description : undefined}
                      onSelect={() => {
                        onPick(g.provider, m.id)
                        setOpen(false)
                      }}
                    >
                      {m.label}
                    </MenuItem>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </Popover>
    </div>
  )
}

const EFFORT_LABEL: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }

export function EffortMenu({ efforts, value, defaultEffort, onPick }: { efforts: string[]; value: string | undefined; defaultEffort?: string; onPick: (effort: string | undefined) => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const keys = useMenuKeys()
  if (!efforts.length) return null
  const current = value && efforts.includes(value) ? value : undefined
  return (
    <div ref={anchor}>
      <PickerButton open={open} onClick={() => setOpen((v) => !v)} label="Reasoning effort" testId="effort-menu">
        <IconGauge size={13} className="shrink-0 text-fg-3" />
        <span className="hidden @[600px]/composer:inline">{current ? (EFFORT_LABEL[current] ?? current) : 'Auto'}</span>
      </PickerButton>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" width={220}>
        <div onKeyDown={keys} className="p-1.5">
          <MenuLabel>Reasoning effort</MenuLabel>
          <MenuItem
            active={!current}
            icon={!current ? <IconCheck size={14} /> : <span />}
            description={defaultEffort ? `Model default (${EFFORT_LABEL[defaultEffort] ?? defaultEffort})` : 'Model default'}
            onSelect={() => {
              onPick(undefined)
              setOpen(false)
            }}
          >
            Auto
          </MenuItem>
          {efforts.map((e) => (
            <MenuItem
              key={e}
              active={current === e}
              icon={current === e ? <IconCheck size={14} /> : <span />}
              onSelect={() => {
                onPick(e)
                setOpen(false)
              }}
            >
              {EFFORT_LABEL[e] ?? e}
            </MenuItem>
          ))}
        </div>
      </Popover>
    </div>
  )
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
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" width={280}>
        <div onKeyDown={keys} className="p-1.5">
          <MenuLabel>What the agent may do without asking</MenuLabel>
          {ACCESS_MODES.map((m) => (
            <MenuItem
              key={m.id}
              active={m.id === value}
              icon={ACCESS_ICON[m.id](14)}
              hint={m.id === value ? <IconCheck size={13} className="text-accent" /> : undefined}
              description={m.hint}
              onSelect={() => {
                onPick(m.id)
                setOpen(false)
              }}
            >
              {m.label}
            </MenuItem>
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
