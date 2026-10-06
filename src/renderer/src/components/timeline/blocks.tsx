import { memo, useMemo, useState } from 'react'
import type { ApprovalItem, AssistantItem, NoticeItem, PlanStep, ReasoningItem, SwitchItem, ToolItem, TurnItem, UserItem } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { diffStats } from '@shared/diff'
import { duet } from '@/lib/api'
import { formatCost, formatDuration, formatTokens, shortModel } from '@/lib/format'
import { useApp } from '@/state/store'
import { groupImages, summarize, type WorkEntry } from '@/lib/timeline'
import { ProviderLogo } from '../brand'
import { CopyButton, Markdown } from '../Markdown'
import { DiffStat, DiffView } from '../DiffView'
import { IconArrowRight, IconCheck, IconChevronRight, IconCode, IconFile, IconInfo, IconListChecks, IconShield, IconWarning, Spinner } from '../icons'

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
      {item.skills && item.skills.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {item.skills.map((name) => (
            <span key={name} className="rounded-full bg-accent/12 px-2 py-0.5 text-[11.5px] text-accent ring-1 ring-accent/25">
              skill · {name}
            </span>
          ))}
        </div>
      )}
      {item.text && (
        <div className="relative max-w-full rounded-2xl rounded-br-md bg-surface-3 px-3.5 py-2 text-[0.97em] leading-relaxed text-fg">
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

function liveLabel(entries: WorkEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'reasoning' && e.streaming) return 'Thinking'
    if (e.kind === 'tool' && e.status === 'running') {
      const { verb, subject } = describeRow(e)
      return [verb, subject].filter(Boolean).join(' ')
    }
  }
  return null
}

/** How a tool reads in the work log: "Ran npm test", "Edited src/app.ts", "Called take_screenshot". */
function describeRow(item: ToolItem): { verb: string; subject: string; extra?: string; mono: boolean } {
  const running = item.status === 'running'
  const pick = (now: string, done: string) => (running ? now : done)
  switch (item.tool) {
    case 'command':
      return { verb: pick('Running', 'Ran'), subject: item.title, mono: true }
    case 'read':
      return item.detail === 'List directory' ? { verb: pick('Listing', 'Listed'), subject: item.title, mono: true } : { verb: pick('Reading', 'Read'), subject: item.title, extra: item.detail, mono: true }
    case 'edit':
      return { verb: pick('Editing', 'Edited'), subject: item.title, extra: item.detail, mono: true }
    case 'write':
      return { verb: pick('Writing', 'Wrote'), subject: item.title, mono: true }
    case 'search':
      return { verb: pick('Searching for', 'Searched for'), subject: item.title, extra: item.detail, mono: true }
    case 'web':
      return /^https?:\/\//i.test(item.title) ? { verb: pick('Fetching', 'Fetched'), subject: item.title, mono: false } : { verb: pick('Searching the web for', 'Searched the web for'), subject: item.title, mono: false }
    case 'mcp':
      return { verb: pick('Calling', 'Called'), subject: item.title, extra: item.detail, mono: false }
    case 'agent':
      return { verb: pick('Subagent working on', 'Subagent'), subject: item.title, extra: item.detail, mono: false }
    case 'todo':
      return { verb: item.title === 'Proposed plan' ? 'Proposed a plan' : 'Updated the plan', subject: '', extra: item.detail, mono: false }
    case 'image':
      return item.name === 'imageGeneration' ? { verb: pick('Generating an image', 'Generated an image'), subject: '', extra: item.detail, mono: false } : { verb: pick('Looking at', 'Looked at'), subject: item.title, mono: true }
    case 'skill':
      return { verb: pick('Using skill', 'Used skill'), subject: item.title, mono: false }
    default:
      return { verb: '', subject: item.title, extra: item.detail, mono: false }
  }
}

export const WorkGroup = memo(function WorkGroup({ entries, live, defaultOpen }: { entries: WorkEntry[]; live: boolean; defaultOpen: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? defaultOpen
  const running = live && entries.some((e) => (e.kind === 'tool' && e.status === 'running') || (e.kind === 'reasoning' && e.streaming))
  const label = running ? liveLabel(entries) : null
  const failed = entries.some((e) => e.kind === 'tool' && e.status === 'error')
  const latestPlan = [...entries].reverse().find((e): e is ToolItem => e.kind === 'tool' && e.tool === 'todo' && !!e.steps?.length)
  const images = useMemo(() => groupImages(entries), [entries])
  const onlyThoughts = entries.every((e) => e.kind === 'reasoning')
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
    <div className="anim-fade" data-testid="work-group">
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        aria-expanded={isOpen}
        className="press group/wl inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[13px] text-fg-2 outline-none hover:text-fg focus-visible:text-fg focus-visible:underline focus-visible:decoration-fg-3/50 focus-visible:underline-offset-4"
      >
        {running && <Spinner size={12} className="shrink-0 text-accent" />}
        <span className={`min-w-0 truncate ${running ? 'shimmer-text' : ''}`}>{label ?? summarize(entries)}</span>
        {!running && (changed.additions > 0 || changed.deletions > 0) && <DiffStat additions={changed.additions} deletions={changed.deletions} />}
        {!running && failed && <span className="shrink-0 text-[11.5px] text-bad">· failed</span>}
        <IconChevronRight size={12} className={`shrink-0 text-fg-3 transition-transform duration-200 group-hover/wl:text-fg-2 ${isOpen ? 'rotate-90' : ''}`} />
      </button>
      {latestPlan && !isOpen && <PlanSteps steps={latestPlan.steps!} className="mt-2" />}
      {isOpen &&
        (onlyThoughts ? (
          // Just thinking: open straight into the thoughts rather than a row that says "Thought" again.
          <div className="anim-fade mt-1.5 space-y-2 rounded-[10px] border border-line px-3 py-2" data-testid="work-log">
            {entries.map((e) => (e.kind === 'reasoning' ? <Markdown key={e.id} text={e.text} streaming={e.streaming} className="text-[0.92em] !text-fg-2" /> : null))}
          </div>
        ) : (
          <div className="anim-fade mt-1.5 overflow-hidden rounded-[10px] border border-line" data-testid="work-log">
            {entries.map((e, i) => (
              <div key={e.id} className={i > 0 ? 'border-t border-line' : ''}>
                {e.kind === 'reasoning' ? <ReasoningRow item={e} /> : <ToolRow item={e} />}
              </div>
            ))}
          </div>
        ))}
      {images.length > 0 && <ToolImages paths={images} />}
    </div>
  )
})

/** Screenshots and other pictures from tools, shown right in the conversation. */
function ToolImages({ paths }: { paths: string[] }) {
  const single = paths.length === 1
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="tool-images">
      {paths.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => useApp.setState({ lightbox: p })}
          title="Open full size"
          className="press overflow-hidden rounded-xl border border-line bg-surface-2 transition-[border-color] hover:border-line-strong"
        >
          <img src={duet.util.fileUrl(p)} alt="Picture from a tool" loading="lazy" draggable={false} className={single ? 'block max-h-[360px] w-auto max-w-full object-contain' : 'block h-36 w-auto max-w-[260px] object-cover'} />
        </button>
      ))}
    </div>
  )
}

export function PlanSteps({ steps, className = '' }: { steps: PlanStep[]; className?: string }) {
  const done = steps.filter((s) => s.status === 'done').length
  return (
    <div className={`rounded-[10px] border border-line px-3 py-2 ${className}`}>
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

const rowClass = 'flex w-full min-w-0 items-center gap-2 px-3 py-[7px] text-left text-[12.5px] outline-none'
const pressableRow = `${rowClass} hover:bg-hover/50 focus-visible:bg-hover`

/** First line of a thought, without markdown, as a hint of what it was about. */
function thoughtTitle(text: string): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/[*_`#>]/g, '').trim()
}

const ReasoningRow = memo(function ReasoningRow({ item }: { item: ReasoningItem }) {
  const [open, setOpen] = useState(false)
  const title = item.streaming ? '' : thoughtTitle(item.text)
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={pressableRow}>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className={`shrink-0 text-fg-3 ${item.streaming ? 'shimmer-text' : ''}`}>{item.streaming ? 'Thinking…' : 'Thought'}</span>{' '}
          {title && <span className="min-w-0 truncate text-fg-2">{title}</span>}
        </span>
        <IconChevronRight size={12} className={`shrink-0 text-fg-3 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-line bg-[var(--code-bg)] px-3 py-2">
          <Markdown text={item.text} className="text-[0.92em] !text-fg-2" />
        </div>
      )}
    </div>
  )
})

export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const hasDetails = !!(item.output || item.diff || hasInput(item) || item.steps?.length || (item.tool === 'command' && item.detail))
  const stats = item.diff && (item.tool === 'edit' || item.tool === 'write') ? diffStats(item.diff) : null
  const { verb, subject, extra, mono } = describeRow(item)
  const declined = item.status === 'declined'
  const failed = item.status === 'error'
  const content = (
    <>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {/* Real spaces between the parts, so it reads and copies as a sentence. */}
        {verb && <span className="shrink-0 text-fg-3">{verb}</span>}{' '}
        {subject && <span className={`min-w-0 truncate text-fg-2 ${mono ? 'font-mono text-[11.5px]' : ''} ${declined ? 'line-through decoration-fg-3/50' : ''}`}>{subject}</span>}{' '}
        {extra && <span className="min-w-0 shrink truncate text-[12px] text-fg-3">{extra}</span>}
      </span>
      {stats && <DiffStat additions={stats.additions} deletions={stats.deletions} />}
      <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-fg-3 tabular-nums">
        {typeof item.exitCode === 'number' && item.exitCode !== 0 ? <span className="text-bad">exit {item.exitCode}</span> : failed ? <span className="text-bad">failed</span> : null}
        {declined && <span>declined</span>}
        {item.durationMs !== undefined && item.status !== 'running' && item.durationMs > 900 && <span>{formatDuration(item.durationMs)}</span>}
        {item.status === 'running' ? (
          <Spinner size={11} className="text-accent" />
        ) : hasDetails ? (
          <IconChevronRight size={12} className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        ) : null}
      </span>
    </>
  )
  return (
    <div data-testid="tool-row">
      {hasDetails ? (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={pressableRow}>
          {content}
        </button>
      ) : (
        <div className={rowClass}>{content}</div>
      )}
      {open && <ToolDetails item={item} />}
    </div>
  )
})

function hasInput(item: ToolItem): boolean {
  return toolInputText(item) !== ''
}

function toolInputText(item: ToolItem): string {
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
}

function ToolDetails({ item }: { item: ToolItem }) {
  const inputText = useMemo(() => toolInputText(item), [item])
  return (
    <div className="anim-fade divide-y divide-line border-t border-line bg-[var(--code-bg)]">
      {item.steps?.length ? <PlanSteps steps={item.steps} className="m-2" /> : null}
      {item.detail && item.tool === 'command' && <div className="px-3 py-1.5 text-[11.5px] text-fg-3">{item.detail}</div>}
      {inputText && (
        <pre className="selectable max-h-48 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">
          {item.tool === 'command' ? <span className="text-fg-3">$ </span> : null}
          {inputText}
        </pre>
      )}
      {item.diff && <DiffView diff={item.diff} headers={item.tool !== 'edit' || (item.diff.match(/^\+\+\+ /gm)?.length ?? 0) > 1} className="max-h-96 overflow-auto" />}
      {item.output && (
        <div className="group/out relative">
          <pre className="selectable max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">{item.output}</pre>
          <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover/out:opacity-100">
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
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${tone}`}>{pending ? <IconShield size={13} className="breathe" /> : <IconShield size={13} />}</span>
      <span className={`shrink-0 whitespace-nowrap ${tone}`}>{verb}</span>
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
