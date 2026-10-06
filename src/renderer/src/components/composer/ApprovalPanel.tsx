import { useEffect, useState } from 'react'
import type { ApprovalItem } from '@shared/types'
import { PROVIDER_LABEL } from '@shared/types'
import { respond, useApp } from '@/state/store'
import { tildify } from '@/lib/format'
import { ProviderLogo } from '../brand'
import { DiffView } from '../DiffView'
import { Markdown } from '../Markdown'
import { IconShield } from '../icons'
import { Button } from '../ui/primitives'

const SEP = '\u001f'

function Questions({ item, threadId }: { item: ApprovalItem; threadId: string }) {
  const questions = item.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const complete = questions.every((q) => (answers[q.id]?.length ?? 0) > 0 || (other[q.id] ?? '').trim())
  const toggle = (qid: string, label: string, multi: boolean) =>
    setAnswers((prev) => {
      const cur = prev[qid] ?? []
      if (!multi) return { ...prev, [qid]: [label] }
      return { ...prev, [qid]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  const submit = () => {
    const out: Record<string, string> = {}
    for (const q of questions) {
      const picked = [...(answers[q.id] ?? [])]
      const extra = (other[q.id] ?? '').trim()
      if (extra) picked.push(extra)
      out[q.id] = picked.join(SEP)
    }
    void respond(threadId, item.id, { kind: 'answer', answers: out })
  }
  return (
    <div className="space-y-3">
      {questions.map((q) => (
        <div key={q.id}>
          {q.header && <div className="mb-0.5 text-[11px] font-medium text-fg-3">{q.header}</div>}
          <div className="mb-2 text-[13px] text-fg">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((o) => {
              const on = answers[q.id]?.includes(o.label)
              return (
                <button
                  key={o.label}
                  type="button"
                  title={o.description}
                  onClick={() => toggle(q.id, o.label, !!q.multiSelect)}
                  className={`press rounded-lg border px-2.5 py-1 text-[12.5px] ${on ? 'border-accent/60 bg-accent/12 text-fg' : 'border-line bg-surface-2 text-fg-2 hover:text-fg'}`}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
          {q.allowOther !== false && (
            <input
              value={other[q.id] ?? ''}
              onChange={(e) => setOther((p) => ({ ...p, [q.id]: e.target.value }))}
              placeholder="Something else…"
              className="mt-2 h-7 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[12.5px] outline-none placeholder:text-fg-3 focus:border-accent/50"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && complete) submit()
              }}
            />
          )}
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void respond(threadId, item.id, { kind: 'deny' })}>
          Skip
        </Button>
        <Button size="sm" variant="accent" disabled={!complete} onClick={submit}>
          Send answer
        </Button>
      </div>
    </div>
  )
}

export function ApprovalPanel({ threadId, approvals }: { threadId: string; approvals: ApprovalItem[] }) {
  const item = approvals[0]
  const home = useApp((s) => s.info.home)
  useEffect(() => {
    if (!item || item.request === 'question' || item.request === 'plan') return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return
      const active = document.activeElement as HTMLTextAreaElement | null
      if (active?.tagName === 'TEXTAREA' && active.value.trim()) return
      e.preventDefault()
      void respond(threadId, item.id, { kind: e.shiftKey && item.canAllowForSession ? 'allow-session' : 'allow' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, threadId])
  if (!item) return null
  const who = PROVIDER_LABEL[item.provider]
  const headline =
    item.request === 'command'
      ? `${who} wants to run a command`
      : item.request === 'edit'
        ? `${who} wants to change files`
        : item.request === 'permissions'
          ? `${who} needs extra permissions`
          : item.request === 'plan'
            ? `${who} has a plan`
            : item.request === 'question'
              ? `${who} has a question`
              : `${who} wants to use a tool`
  return (
    <div className="anim-rise relative z-[1] -mb-3 rounded-t-[20px] border border-b-0 border-accent/35 bg-[color-mix(in_srgb,var(--accent)_7%,var(--surface))] px-4 pb-6 pt-3" data-testid="approval-panel">
      <div className="mb-2 flex items-center gap-2 text-[12.5px]">
        <IconShield size={14} className="text-accent" />
        <span className="font-medium text-fg">{headline}</span>
        <ProviderLogo provider={item.provider} size={12} />
        {approvals.length > 1 && <span className="ml-auto text-[11.5px] text-fg-3">1 of {approvals.length}</span>}
      </div>
      {item.request === 'question' ? (
        <Questions key={item.id} item={item} threadId={threadId} />
      ) : (
        <>
          {item.command && (
            <pre className="selectable mb-2 max-h-28 overflow-auto rounded-lg border border-line bg-[var(--code-bg)] px-3 py-2 font-mono text-[12px] leading-relaxed text-fg whitespace-pre-wrap break-all">
              <span className="text-fg-3">$ </span>
              {item.command}
            </pre>
          )}
          {item.diff && (
            <div className="mb-2 max-h-56 overflow-auto rounded-lg border border-line bg-[var(--code-bg)]">
              <DiffView diff={item.diff} />
            </div>
          )}
          {item.plan && (
            <div className="scroll-y mb-2 max-h-72 rounded-lg border border-line bg-surface px-3.5 py-2.5">
              <Markdown text={item.plan} />
            </div>
          )}
          {(item.detail || item.cwd) && (
            <div className="mb-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg-2">
              {item.detail}
              {item.cwd && item.request === 'command' && <span className="text-fg-3">{item.detail ? ' · ' : ''}in {tildify(item.cwd, home)}</span>}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {item.request === 'plan' ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => void respond(threadId, item.id, { kind: 'deny' })}>
                  Keep planning
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void respond(threadId, item.id, { kind: 'allow' })}>
                  Approve · ask before edits
                </Button>
                <Button size="sm" variant="accent" onClick={() => void respond(threadId, item.id, { kind: 'allow-session' })} data-testid="approve-plan">
                  Approve · auto-edit
                </Button>
              </>
            ) : (
              <>
                <span className="mr-auto hidden text-[11px] text-fg-3 sm:inline">⌘↵ allow{item.canAllowForSession ? ' · ⇧⌘↵ always' : ''}</span>
                <Button size="sm" variant="ghost" onClick={() => void respond(threadId, item.id, { kind: 'deny' })} data-testid="approval-deny">
                  Deny
                </Button>
                {item.canAllowForSession && (
                  <Button size="sm" variant="secondary" onClick={() => void respond(threadId, item.id, { kind: 'allow-session' })} data-testid="approval-always">
                    Always allow
                  </Button>
                )}
                <Button size="sm" variant="accent" onClick={() => void respond(threadId, item.id, { kind: 'allow' })} data-testid="approval-allow">
                  Allow
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
