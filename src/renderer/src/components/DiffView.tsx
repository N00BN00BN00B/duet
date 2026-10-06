import { memo, useMemo, useState } from 'react'
import { parseUnifiedDiff, type DiffFile } from '@shared/diff'
import { IconFile } from './icons'

const LINE_CAP = 1500

export function DiffStat({ additions, deletions, className = '' }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] tabular-nums ${className}`}>
      {additions > 0 && <span className="text-[color:var(--diff-add-fg)]">+{additions}</span>}
      {deletions > 0 && <span className="text-[color:var(--diff-del-fg)]">−{deletions}</span>}
      {additions === 0 && deletions === 0 && <span className="text-fg-3">±0</span>}
    </span>
  )
}

function FileDiff({ file, showHeader }: { file: DiffFile; showHeader: boolean }) {
  const [all, setAll] = useState(false)
  const lines = all ? file.lines : file.lines.slice(0, LINE_CAP)
  return (
    <div className="overflow-hidden">
      {showHeader && (
        <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-3 py-1.5 text-[12px]">
          <IconFile size={13} className="text-fg-3" />
          <span className="min-w-0 flex-1 truncate font-mono text-fg-2">{file.path || file.oldPath}</span>
          <DiffStat additions={file.additions} deletions={file.deletions} />
        </div>
      )}
      <div className="diff selectable overflow-x-auto py-1">
        {file.binary && <div className="px-3 py-2 text-fg-3">Binary file</div>}
        {lines.map((line, i) => {
          if (line.type === 'meta') return null
          const cls = line.type === 'add' ? 'add' : line.type === 'del' ? 'del' : line.type === 'hunk' ? 'hunk' : ''
          return (
            <div key={i} className={`diff-row ${cls}`}>
              <span className="num">{line.type === 'hunk' ? '' : (line.oldNo ?? '')}</span>
              <span className="num">{line.type === 'hunk' ? '' : (line.newNo ?? '')}</span>
              <span className="sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}</span>
              <span className="code pr-4">{line.text || ' '}</span>
            </div>
          )
        })}
        {!all && file.lines.length > LINE_CAP && (
          <button type="button" onClick={() => setAll(true)} className="press mx-3 my-2 rounded-md px-2 py-1 text-[11.5px] text-accent hover:bg-hover">
            Show {file.lines.length - LINE_CAP} more lines
          </button>
        )}
      </div>
    </div>
  )
}

export const DiffView = memo(function DiffView({ diff, className = '', headers = true }: { diff: string; className?: string; headers?: boolean }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  if (!files.length) return <div className={`px-3 py-2 text-[12px] text-fg-3 ${className}`}>No changes</div>
  return (
    <div className={`divide-y divide-line ${className}`}>
      {files.map((f, i) => (
        <FileDiff key={`${f.path}-${i}`} file={f} showHeader={headers} />
      ))}
    </div>
  )
})
