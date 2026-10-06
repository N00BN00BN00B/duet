import { useEffect, useRef, type ReactNode } from 'react'
import type { ProviderId } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import type { CommandEntry } from '@/lib/commands'
import { useFitAbove } from '@/lib/fit'
import { ProviderLogo } from '../brand'
import {
  IconBolt,
  IconCommand,
  IconCopy,
  IconForkThread,
  IconGauge,
  IconGlobe,
  IconHand,
  IconMap,
  IconPalette,
  IconPencil,
  IconPlus,
  IconSparkle,
  IconSync,
  IconTerminal,
  IconUnlock,
  IconWand,
  Spinner
} from '../icons'
import { EffortBars } from './pickers'

const DUET_ICON: Record<string, ReactNode> = {
  theme: <IconWand size={14} />,
  new: <IconPlus size={14} />,
  clear: <IconPlus size={14} />,
  fork: <IconForkThread size={14} />,
  claude: <ProviderLogo provider="claude" size={13} />,
  codex: <ProviderLogo provider="codex" size={13} />,
  model: <IconSparkle size={14} />,
  effort: <EffortBars level={3} of={4} size={13} />,
  plan: <IconMap size={14} />,
  ask: <IconHand size={14} />,
  auto: <IconPencil size={14} />,
  'full-access': <IconUnlock size={14} />,
  fast: <IconBolt size={14} />,
  usage: <IconGauge size={14} />,
  customize: <IconPalette size={14} />,
  sync: <IconSync size={14} />,
  terminal: <IconTerminal size={14} />,
  browser: <IconGlobe size={14} />,
  export: <IconCopy size={14} />,
  help: <IconCommand size={14} />
}

function iconFor(e: CommandEntry): ReactNode {
  if (e.kind === 'skill') return <IconSparkle size={14} />
  if (e.source === 'duet') return DUET_ICON[e.name] ?? <IconCommand size={14} />
  return <ProviderLogo provider={e.source} size={13} />
}

const SECTION: Record<string, string> = { duet: 'Duet', skill: 'Skills' }

/** The "/" menu: every command Duet, the active agent and its skills offer. */
export function CommandMenu({ entries, index, onHover, onPick, provider, grouped, loading }: { entries: CommandEntry[]; index: number; onHover: (i: number) => void; onPick: (e: CommandEntry) => void; provider: ProviderId; grouped: boolean; loading: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const maxHeight = useFitAbove(box, list, 340, entries)
  useEffect(() => {
    // The first entry keeps its group header in view.
    if (index === 0) list.current?.scrollTo({ top: 0 })
    else list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index, entries])
  let lastSection = ''
  return (
    <div ref={box} className="anim-pop absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[var(--pop-shadow)]" role="listbox" aria-label="Commands" data-testid="command-menu">
      <div ref={list} className="scroll-y p-1.5" style={{ maxHeight }}>
        {entries.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-fg-3">{loading ? 'Loading commands…' : 'No command matches'}</div>}
        {entries.map((e, i) => {
          const section = e.kind === 'skill' ? 'skill' : e.source
          const header = grouped && section !== lastSection ? (SECTION[section] ?? PROVIDER_LABEL[section as ProviderId]) : null
          lastSection = section
          const selected = i === index
          return (
            <div key={`${e.source}:${e.kind}:${e.name}`}>
              {header && (
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[11px] font-medium text-fg-3">
                  {header}
                  {header === 'Skills' && <span className="font-normal">· attached to your message</span>}
                </div>
              )}
              <div
                role="option"
                aria-selected={selected}
                data-index={i}
                onMouseEnter={() => onHover(i)}
                onMouseDown={(ev) => {
                  ev.preventDefault()
                  onPick(e)
                }}
                className={`group/cmd flex cursor-default items-center gap-3 rounded-xl px-2.5 py-1.5 transition-colors duration-150 ${selected ? 'bg-hover' : ''}`}
                data-testid="command-option"
              >
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 transition-[background-color,color] duration-150 ${selected ? 'bg-accent/15 text-accent ring-accent/30' : 'bg-surface-2 text-fg-3 ring-line'}`}>{iconFor(e)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[12.5px] text-fg">
                      <span className="text-fg-3">/</span>
                      {e.name}
                    </span>
                    {e.argumentHint && <span className="truncate font-mono text-[11px] text-fg-3">{e.argumentHint}</span>}
                  </span>
                  {e.description && <span className="block truncate text-[11.5px] text-fg-3">{e.description}</span>}
                </span>
                {!grouped && <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-px text-[10px] text-fg-3">{e.kind === 'skill' ? 'Skill' : e.source === 'duet' ? 'Duet' : PROVIDER_LABEL[e.source]}</span>}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[10.5px] text-fg-3">
        <span>↑↓ move</span>
        <span>↵ run</span>
        <span>esc close</span>
        <span className="ml-auto flex items-center gap-1.5">
          {loading && <Spinner size={10} />}
          {entries.length} commands · {PROVIDER_LABEL[provider]}
        </span>
      </div>
    </div>
  )
}
