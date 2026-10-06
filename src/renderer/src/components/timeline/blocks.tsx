import { memo, useMemo, useState, type ReactNode } from 'react'
import type { ApprovalItem, AssistantItem, NoticeItem, PlanStep, ReasoningItem, SwitchItem, ToolItem, TurnItem, UserItem } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { diffStats } from '@shared/diff'
import { duet } from '@/lib/api'
import { formatCost, formatDuration, formatTokens, shortModel } from '@/lib/format'
import { useApp } from '@/state/store'
import { summarize, type WorkEntry } from '@/lib/timeline'
import { ProviderLogo } from '../brand'
import { CopyButton, Markdown } from '../Markdown'
import { DiffStat, DiffView } from '../DiffView'
import {
  IconArrowRight,
  IconBot,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconEye,
  IconFile,
  IconGlobe,
  IconImage,
  IconInfo,
  IconListChecks,
  IconPencil,
  IconPlug,
  IconSearch,
  IconShield,
  IconSparkle,
  IconTerminal,
  IconWarning,
  IconWrench,
  IconX,
  Spinner
} from '../icons'

// ---------- user ----------

export const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  const [expanded, setExpanded] = useState(false)
  const long = item.text.length > 900 || item.text.split('\n').length > 14
  const images = item.attachments.filter((a) => a.mime.startsWith('image/'))
  const files = item.attachments.filter((a) => !a.mime.startsWith('image/'))
  return (
    <div className="group/user anim-rise flex flex-col items-end gap-1.5 pl-16">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((a) => (
            <button key={a.id} type="button" onClick={() => useApp.setState({ lightbox: a.path })} className="press overflow-hidden rounded-xl border border-line">
              <img src={duet.util.fileUrl(a.path)} alt={a.name} className="h-24 max-w-[220px] object-cover" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {files.map((a) => (
            <button key={a.id} type="button" onClick={() => void duet.app.reveal(a.path)} className="press inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-[12px] text-fg-2 hover:text-fg">
              <IconFile size={13} />
              {a.name}
            </button>
          ))}
        </div>
      )}
      {item.text && (
        <div className="relative max-w-full rounded-[18px] rounded-br-md bg-surface-3 px-3.5 py-2 text-[0.97em] leading-relaxed text-fg">
          <div className={`selectable whitespace-pre-wrap break-words ${long && !expanded ? 'fade-mask-b max-h-[16rem] overflow-hidden' : ''}`}>{item.text}</div>
          {long && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="press mt-1 text-[12px] font-medium text-fg-2 hover:text-fg">
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      <div className="flex h-5 items-center gap-1 opacity-0 transition-opacity group-hover/user:opacity-100">
        <span className="flex items-center gap-1 text-[11px] text-fg-3">
          <ProviderLogo provider={item.provider} size={11} /> to {PROVIDER_LABEL[item.provider]}
        </span>
        <CopyButton text={item.text} />
      </div>
    </div>
  )
})

// ---------- assistant ----------

export const AssistantMessage = memo(function AssistantMessage({ item, showHeader }: { item: AssistantItem; showHeader: boolean }) {
  return (
    <div className="group/msg anim-fade">
      {showHeader && <AgentHeader provider={item.provider} model={item.model} />}
      <Markdown text={item.text} streaming={item.streaming} className={item.streaming ? 'streaming' : ''} />
      {!item.streaming && (
        <div className="mt-1 flex h-6 items-center opacity-0 transition-opacity group-hover/msg:opacity-100">
          <CopyButton text={item.text} />
        </div>
      )}
    </div>
  )
})

export function AgentHeader({ provider, model }: { provider: AssistantItem['provider']; model?: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[12.5px]">
      <span className={`flex h-[22px] w-[22px] items-center justify-center rounded-md ${provider === 'claude' ? 'bg-claude/12' : 'bg-surface-3'}`}>
        <ProviderLogo provider={provider} size={13} />
      </span>
      <span className="font-medium text-fg">{PROVIDER_LABEL[provider]}</span>
      {model && <span className="text-fg-3">{shortModel(model)}</span>}
    </div>
  )
}

// ---------- work log ----------


const TOOL_ICON: Record<ToolItem['tool'], (p: { size?: number; className?: string }) => ReactNode> = {
  command: (p) => <IconTerminal {...p} />,
  edit: (p) => <IconPencil {...p} />,
  write: (p) => <IconFile {...p} />,
  read: (p) => <IconEye {...p} />,
  search: (p) => <IconSearch {...p} />,
  mcp: (p) => <IconPlug {...p} />,
  web: (p) => <IconGlobe {...p} />,
  agent: (p) => <IconBot {...p} />,
  todo: (p) => <IconListChecks {...p} />,
  image: (p) => <IconImage {...p} />,
  skill: (p) => <IconSparkle {...p} />,
  other: (p) => <IconWrench {...p} />
}

function liveLabel(entries: WorkEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'reasoning' && e.streaming) return 'Thinking'
    if (e.kind === 'tool' && e.status === 'running') {
      switch (e.tool) {
        case 'command':
          return `Running ${e.title}`
        case 'read':
          return `Reading ${e.title}`
        case 'edit':
        case 'write':
          return `Editing ${e.title}`
        case 'search':
          return `Searching ${e.title}`
        case 'web':
          return `Browsing ${e.title}`
        case 'mcp':
          return `Calling ${e.detail ? `${e.detail} › ` : ''}${e.title}`
        case 'agent':
          return `Subagent: ${e.title}`
        default:
          return e.title
      }
    }
  }
  return null
}

export const WorkGroup = memo(function WorkGroup({ entries, live, defaultOpen }: { entries: WorkEntry[]; live: boolean; defaultOpen: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? defaultOpen
  const running = live && entries.some((e) => (e.kind === 'tool' && e.status === 'running') || (e.kind === 'reasoning' && e.streaming))
  const label = running ? liveLabel(entries) : null
  const failed = entries.some((e) => e.kind === 'tool' && e.status === 'error')
  const latestPlan = [...entries].reverse().find((e): e is ToolItem => e.kind === 'tool' && e.tool === 'todo' && !!e.steps?.length)
  const changed = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const e of entries) {
      if (e.kind === 'tool' && e.diff && (e.tool === 'edit' || e.tool === 'write') && e.status !== 'declined') {
        const s = diffStats(e.diff)
        additions += s.additions
        deletions += s.deletions
      }
    }
    return { additions, deletions }
  }, [entries])
  return (
    <div className="anim-fade">
      <button type="button" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen} className="press group/wl flex w-full items-center gap-2 rounded-lg py-1 text-left text-[12.5px] text-fg-2 hover:text-fg">
        <span className="flex h-5 w-5 items-center justify-center text-fg-3">{running ? <Spinner size={13} className="text-accent" /> : <IconChevronRight size={13} className={`transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`} />}</span>
        <span className={`min-w-0 truncate ${running ? 'shimmer-text' : ''}`}>{label ?? summarize(entries)}</span>
        {!running && (changed.additions > 0 || changed.deletions > 0) && <DiffStat additions={changed.additions} deletions={changed.deletions} />}
        {!running && failed && <IconWarning size={13} className="text-warn" />}
      </button>
      {latestPlan && !isOpen && <PlanSteps steps={latestPlan.steps!} className="ml-7 mt-1" />}
      {isOpen && (
        <div className="anim-fade ml-[9px] mt-1 border-l border-line pl-4">
          {entries.map((e) => (e.kind === 'reasoning' ? <ReasoningRow key={e.id} item={e} /> : <ToolRow key={e.id} item={e} />))}
        </div>
      )}
    </div>
  )
})

export function PlanSteps({ steps, className = '' }: { steps: PlanStep[]; className?: string }) {
  const done = steps.filter((s) => s.status === 'done').length
  return (
    <div className={`rounded-xl border border-line bg-surface/60 px-3 py-2 ${className}`}>
      <div className="mb-1 flex items-center justify-between text-[11.5px] text-fg-3">
        <span className="flex items-center gap-1.5">
          <IconListChecks size={13} /> Plan
        </span>
        <span className="tabular-nums">
          {done}/{steps.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug">
            <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {s.status === 'done' ? (
                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-ok/20 text-ok">
                  <IconCheck size={10} strokeWidth={2.5} />
                </span>
              ) : s.status === 'active' ? (
                <Spinner size={12} className="text-accent" />
              ) : (
                <span className="h-3 w-3 rounded-full border border-line-strong" />
              )}
            </span>
            <span className={s.status === 'done' ? 'text-fg-3 line-through decoration-fg-3/40' : s.status === 'active' ? 'text-fg' : 'text-fg-2'}>{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const ReasoningRow = memo(function ReasoningRow({ item }: { item: ReasoningItem }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-0.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="press flex w-full items-center gap-2 rounded-md py-0.5 text-left text-[12.5px] text-fg-3 hover:text-fg-2">
        <IconSparkle size={13} />
        <span className={item.streaming ? 'shimmer-text' : ''}>{item.streaming ? 'Thinking…' : 'Thought'}</span>
        <IconChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <Markdown text={item.text} className="mb-1 mt-1 text-[0.92em] !text-fg-2" />}
    </div>
  )
})

function statusIcon(item: ToolItem): ReactNode {
  if (item.status === 'running') return <Spinner size={12} className="text-accent" />
  if (item.status === 'error') return <IconX size={12} className="text-bad" />
  if (item.status === 'declined') return <span className="text-[10.5px] text-warn">declined</span>
  return null
}

export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const hasDetails = !!(item.output || item.diff || item.input || item.images?.length || item.steps?.length)
  const stats = item.diff && (item.tool === 'edit' || item.tool === 'write') ? diffStats(item.diff) : null
  const mono = item.tool === 'command' || item.tool === 'read' || item.tool === 'edit' || item.tool === 'write' || item.tool === 'search'
  return (
    <div className="py-[1px]">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={`press flex w-full min-w-0 items-center gap-2 rounded-md py-[3px] text-left text-[12.5px] ${hasDetails ? 'hover:text-fg' : ''} text-fg-2`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-3">{TOOL_ICON[item.tool]({ size: 13 })}</span>
        <span className={`min-w-0 truncate ${mono ? 'font-mono text-[11.5px]' : ''} ${item.status === 'declined' ? 'line-through decoration-fg-3/50' : ''}`}>{item.title}</span>
        {item.detail && item.tool !== 'command' && <span className="min-w-0 shrink truncate text-[11.5px] text-fg-3">{item.detail}</span>}
        {stats && <DiffStat additions={stats.additions} deletions={stats.deletions} />}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11px] text-fg-3">
          {typeof item.exitCode === 'number' && item.exitCode !== 0 && <span className="text-bad">exit {item.exitCode}</span>}
          {item.durationMs !== undefined && item.status !== 'running' && item.durationMs > 900 && <span className="tabular-nums">{formatDuration(item.durationMs)}</span>}
          {statusIcon(item)}
        </span>
      </button>
      {open && <ToolDetails item={item} />}
    </div>
  )
})

function ToolDetails({ item }: { item: ToolItem }) {
  const inputText = useMemo(() => {
    if (item.input === undefined || item.tool === 'edit' || item.tool === 'write' || item.tool === 'todo') return ''
    if (item.tool === 'command') {
      const cmd = (item.input as { command?: string })?.command
      return typeof cmd === 'string' ? cmd : ''
    }
    try {
      const s = JSON.stringify(item.input, null, 2)
      return s === '{}' ? '' : s
    } catch {
      return ''
    }
  }, [item.input, item.tool])
  return (
    <div className="anim-fade mb-2 ml-6 mt-1 overflow-hidden rounded-lg border border-line bg-[var(--code-bg)]">
      {item.steps?.length ? <PlanSteps steps={item.steps} className="m-2" /> : null}
      {item.detail && item.tool === 'command' && <div className="border-b border-line px-3 py-1.5 text-[11.5px] text-fg-3">{item.detail}</div>}
      {inputText && (
        <pre className="selectable max-h-48 overflow-auto border-b border-line px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">
          {item.tool === 'command' ? <span className="text-fg-3">$ </span> : null}
          {inputText}
        </pre>
      )}
      {item.diff && <DiffView diff={item.diff} headers={item.tool !== 'edit' || (item.diff.match(/^\+\+\+ /gm)?.length ?? 0) > 1} className="max-h-96 overflow-auto" />}
      {item.images?.length ? (
        <div className="flex flex-wrap gap-2 p-2">
          {item.images.map((p) => (
            <button key={p} type="button" onClick={() => useApp.setState({ lightbox: p })} className="press overflow-hidden rounded-lg border border-line">
              <img src={duet.util.fileUrl(p)} alt="" className="h-28 max-w-[240px] object-cover" />
            </button>
          ))}
        </div>
      ) : null}
      {item.output && (
        <div className="relative">
          <pre className="selectable max-h-80 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2 whitespace-pre-wrap break-words">{item.output}</pre>
          <div className="absolute right-1 top-1">
            <CopyButton text={item.output} />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- approvals, switches, notices, turns ----------

export const ApprovalRecord = memo(function ApprovalRecord({ item }: { item: ApprovalItem }) {
  const pending = item.status === 'pending'
  const tone = item.status === 'denied' ? 'text-warn' : item.status === 'expired' ? 'text-fg-3' : pending ? 'text-accent' : 'text-ok'
  const verb =
    item.request === 'question'
      ? pending
        ? 'Waiting for your answer'
        : item.status === 'expired'
          ? 'Question withdrawn'
          : 'Answered'
      : pending
        ? 'Waiting for your approval'
        : item.status === 'denied'
          ? 'Declined'
          : item.status === 'expired'
            ? 'Request expired'
            : item.status === 'approved-session'
              ? 'Always allowed'
              : 'Approved'
  const subject = item.command ?? item.title
  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5 text-[12px]">
      <span className={`flex h-5 w-5 items-center justify-center ${tone}`}>{pending ? <IconShield size={13} className="breathe" /> : <IconShield size={13} />}</span>
      <span className={tone}>{verb}</span>
      <span className="min-w-0 truncate font-mono text-[11.5px] text-fg-3">{subject}</span>
      {item.answers && (
        <span className="min-w-0 truncate text-fg-2">
          → {Object.values(item.answers).map((a) => a.split('\u001f').join(', ')).join(' · ')}
        </span>
      )}
    </div>
  )
})

export const SwitchDivider = memo(function SwitchDivider({ item }: { item: SwitchItem }) {
  return (
    <div className="anim-fade my-2 flex items-center gap-3" role="separator">
      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-line-strong" />
      <span className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[11.5px] text-fg-2">
        {item.from && <ProviderLogo provider={item.from} size={12} />}
        {item.from && <IconArrowRight size={11} className="text-fg-3" />}
        <ProviderLogo provider={item.to} size={12} />
        <span>
          Switched to <span className="font-medium text-fg">{PROVIDER_LABEL[item.to]}</span>
          {item.model ? <span className="text-fg-3"> · {shortModel(item.model)}</span> : null}
        </span>
      </span>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-line-strong" />
    </div>
  )
})

export const Notice = memo(function Notice({ item }: { item: NoticeItem }) {
  if (item.level === 'info') {
    return (
      <div className="flex items-center justify-center gap-1.5 py-1 text-[12px] text-fg-3">
        <IconInfo size={12} />
        {item.text}
      </div>
    )
  }
  const bad = item.level === 'error'
  return (
    <div className={`anim-fade flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-[12.5px] leading-relaxed ${bad ? 'border-bad/25 bg-bad/8 text-fg' : 'border-warn/25 bg-warn/8 text-fg'}`}>
      <IconWarning size={15} className={`mt-[2px] shrink-0 ${bad ? 'text-bad' : 'text-warn'}`} />
      <div className="selectable min-w-0 whitespace-pre-wrap break-words">{item.text}</div>
    </div>
  )
})

export const TurnFooter = memo(function TurnFooter({ item }: { item: TurnItem }) {
  const parts = [PROVIDER_LABEL[item.provider], shortModel(item.model), formatDuration(item.durationMs), formatCost(item.costUsd), item.outputTokens ? `${formatTokens(item.outputTokens)} out` : ''].filter(Boolean)
  return (
    <div className="flex items-center gap-1.5 pb-1 text-[11px] text-fg-3">
      {item.status === 'interrupted' && <span className="text-warn">Stopped ·</span>}
      {item.status === 'failed' && <span className="text-bad">Failed ·</span>}
      <span className="tabular-nums">{parts.join(' · ')}</span>
    </div>
  )
})

export function ThinkingIndicator({ provider, label }: { provider: AssistantItem['provider']; label?: string }) {
  return (
    <div className="anim-fade flex items-center gap-2.5 py-1 text-[12.5px]">
      <span className={`breathe flex h-[22px] w-[22px] items-center justify-center rounded-md ${provider === 'claude' ? 'bg-claude/12' : 'bg-surface-3'}`}>
        <ProviderLogo provider={provider} size={13} />
      </span>
      <span className="shimmer-text">{label ?? `${PROVIDER_LABEL[provider]} is thinking…`}</span>
    </div>
  )
}

export function HandoffNote({ from, to }: { from: string; to: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
      <IconCode size={12} />
      {to} received the conversation from {from}
    </div>
  )
}
