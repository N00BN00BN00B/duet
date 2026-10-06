import { useCallback, useEffect, useState } from 'react'
import type { GitStatus } from '@shared/types'
import { duet } from '@/lib/api'
import { useApp } from '@/state/store'
import { DiffStat, DiffView } from '../DiffView'
import { CopyButton } from '../Markdown'
import { IconBranch, IconDiff, IconFolder, IconRefresh, Spinner } from '../icons'
import { EmptyState, IconButton } from '../ui/primitives'

const STATUS_TONE: Record<string, string> = {
  added: 'text-ok',
  untracked: 'text-ok',
  deleted: 'text-bad',
  modified: 'text-warn',
  renamed: 'text-info',
  conflict: 'text-bad'
}
const STATUS_LETTER: Record<string, string> = { added: 'A', untracked: 'U', deleted: 'D', modified: 'M', renamed: 'R', conflict: '!' }

export function ChangesPanel({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  // Refresh whenever a turn in this folder finishes.
  const pulse = useApp((s) => Object.values(s.threads).filter((t) => t.cwd === cwd).map((t) => `${t.status}:${t.updatedAt}`).join('|'))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const st = await duet.git.status(cwd)
      setStatus(st)
      const target = selected && st.files.some((f) => f.path === selected) ? selected : undefined
      setDiff(st.isRepo && st.files.length ? await duet.git.diff(cwd, target) : '')
    } catch {
      setStatus({ isRepo: false, files: [] })
    } finally {
      setLoading(false)
    }
  }, [cwd, selected])

  useEffect(() => {
    void load()
  }, [load, pulse])

  const totals = status?.files.reduce((acc, f) => ({ a: acc.a + f.additions, d: acc.d + f.deletions }), { a: 0, d: 0 }) ?? { a: 0, d: 0 }
  return (
    <div className="flex h-full min-w-0 flex-col bg-bg" data-testid="changes-panel">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <IconDiff size={15} className="text-fg-3" />
        <span className="text-[13px] font-medium">Changes</span>
        {status?.isRepo && status.branch && (
          <span className="flex min-w-0 items-center gap-1 text-[12px] text-fg-3">
            <IconBranch size={12} />
            <span className="truncate">{status.branch}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {status?.files.length ? <DiffStat additions={totals.a} deletions={totals.d} /> : null}
          {diff && <CopyButton text={diff} label="Copy diff" />}
          <IconButton label="Refresh" onClick={() => void load()}>
            {loading ? <Spinner size={14} /> : <IconRefresh size={15} />}
          </IconButton>
        </span>
      </div>
      {!status ? (
        <div className="flex flex-1 items-center justify-center text-fg-3">
          <Spinner size={16} />
        </div>
      ) : !status.isRepo ? (
        <EmptyState icon={<IconFolder size={18} />} title="Not a git repository">
          Initialize git in this project to see what the agents change.
        </EmptyState>
      ) : status.files.length === 0 ? (
        <EmptyState icon={<IconDiff size={18} />} title="Working tree is clean">
          Edits made by Claude or Codex show up here as they happen.
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="scroll-y max-h-[38%] shrink-0 border-b border-line p-1.5">
            <button type="button" onClick={() => setSelected(null)} className={`press flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] ${selected === null ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover'}`}>
              All files <span className="text-fg-3">({status.files.length})</span>
            </button>
            {status.files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelected(f.path)}
                className={`press flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] ${selected === f.path ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover'}`}
              >
                <span className={`w-3 shrink-0 font-mono text-[11px] font-semibold ${STATUS_TONE[f.status] ?? 'text-fg-3'}`}>{STATUS_LETTER[f.status] ?? '•'}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{f.path}</span>
                <DiffStat additions={f.additions} deletions={f.deletions} />
              </button>
            ))}
          </div>
          <div className="scroll-y min-h-0 flex-1">{diff ? <DiffView diff={diff} /> : <div className="p-4 text-[12px] text-fg-3">No textual diff for this selection.</div>}</div>
        </div>
      )}
    </div>
  )
}
