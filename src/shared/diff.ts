// Small, dependency-free line diff (Myers) plus unified-diff helpers.

type Op = { type: 'equal' | 'insert' | 'delete'; line: string }

const MAX_EDIT_DISTANCE = 2000

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  v[offset + 1] = 0
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null
    // Store only the window of k values reachable in this round.
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, a, b)
    }
  }
  return backtrack(trace, a, b)
}

function backtrack(trace: Int32Array[], a: string[], b: string[]): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length
  for (let d = trace.length - 1; d >= 0; d--) {
    const window = trace[d]
    const at = (k: number) => window[k + d + 1]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1
    else prevK = k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', line: a[x - 1] })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'insert', line: b[y - 1] })
      else ops.push({ type: 'delete', line: a[x - 1] })
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

export function diffLines(oldText: string, newText: string): Op[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  // Trim the common prefix/suffix first; most edits touch a few lines.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const middle =
    myers(a.slice(start, endA), b.slice(start, endB)) ?? [
      ...a.slice(start, endA).map((line) => ({ type: 'delete' as const, line })),
      ...b.slice(start, endB).map((line) => ({ type: 'insert' as const, line }))
    ]
  return [
    ...a.slice(0, start).map((line) => ({ type: 'equal' as const, line })),
    ...middle,
    ...a.slice(endA).map((line) => ({ type: 'equal' as const, line }))
  ]
}

/** Builds a unified diff (with `---`/`+++` headers) between two texts. */
export function unifiedDiff(oldText: string, newText: string, path = 'file', context = 3): string {
  const ops = diffLines(oldText, newText)
  if (!ops.some((op) => op.type !== 'equal')) return ''
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
  let oldLine = 1
  let newLine = 1
  let i = 0
  while (i < ops.length) {
    // Find next change.
    let changeAt = i
    while (changeAt < ops.length && ops[changeAt].type === 'equal') changeAt++
    if (changeAt >= ops.length) break
    const lead = Math.min(context, changeAt - i)
    const hunkStart = changeAt - lead
    // Advance line counters up to hunkStart.
    for (let j = i; j < hunkStart; j++) {
      oldLine++
      newLine++
    }
    // Extend the hunk over later changes separated by at most 2*context equal lines.
    let lastChangeEnd = changeAt
    let j = changeAt
    while (j < ops.length) {
      if (ops[j].type !== 'equal') {
        j++
        lastChangeEnd = j
        continue
      }
      let run = 0
      while (j + run < ops.length && ops[j + run].type === 'equal') run++
      if (j + run >= ops.length || run > context * 2) break
      j += run
    }
    const hunkEnd = Math.min(ops.length, lastChangeEnd + context)
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    for (let j = hunkStart; j < hunkEnd; j++) {
      const op = ops[j]
      if (op.type === 'equal') {
        body.push(` ${op.line}`)
        oldCount++
        newCount++
      } else if (op.type === 'delete') {
        body.push(`-${op.line}`)
        oldCount++
      } else {
        body.push(`+${op.line}`)
        newCount++
      }
    }
    out.push(`@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`)
    out.push(...body)
    oldLine += oldCount
    newLine += newCount
    i = hunkEnd
  }
  return out.join('\n') + '\n'
}

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'hunk' | 'meta'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffFile {
  path: string
  oldPath?: string
  lines: DiffLine[]
  additions: number
  deletions: number
  binary?: boolean
}

/** Parses one or more files of unified diff text (git or plain). */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let oldNo = 0
  let newNo = 0
  const ensure = (path: string): DiffFile => {
    if (!current) {
      current = { path, lines: [], additions: 0, deletions: 0 }
      files.push(current)
    }
    return current
  }
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = raw.match(/^diff --git a\/(.+?) b\/(.+)$/)
      current = { path: match ? match[2] : raw.slice(11), oldPath: match?.[1], lines: [], additions: 0, deletions: 0 }
      files.push(current)
      continue
    }
    if (raw.startsWith('--- ')) {
      const p = raw.slice(4).replace(/^a\//, '')
      if (!current || current.lines.some((l) => l.type !== 'meta')) {
        current = { path: p === '/dev/null' ? '' : p, oldPath: p, lines: [], additions: 0, deletions: 0 }
        files.push(current)
      }
      continue
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '')
      const file = ensure(p)
      if (p !== '/dev/null') file.path = p
      else if (!file.path && file.oldPath) file.path = file.oldPath
      continue
    }
    if (raw.startsWith('@@')) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      oldNo = match ? Number(match[1]) : 0
      newNo = match ? Number(match[2]) : 0
      ensure('file').lines.push({ type: 'hunk', text: raw })
      continue
    }
    if (!current) continue
    const file: DiffFile = current
    if (raw.startsWith('Binary files')) {
      file.binary = true
      file.lines.push({ type: 'meta', text: raw })
    } else if (raw.startsWith('+')) {
      file.lines.push({ type: 'add', text: raw.slice(1), newNo: newNo++ })
      file.additions++
    } else if (raw.startsWith('-')) {
      file.lines.push({ type: 'del', text: raw.slice(1), oldNo: oldNo++ })
      file.deletions++
    } else if (raw.startsWith(' ')) {
      file.lines.push({ type: 'context', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    } else if (raw.startsWith('\\')) {
      file.lines.push({ type: 'meta', text: raw })
    } else if (/^(index |new file|deleted file|similarity|rename |old mode|new mode)/.test(raw)) {
      file.lines.push({ type: 'meta', text: raw })
    }
  }
  return files.filter((f) => f.path || f.lines.length > 0)
}

export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** Converts Claude's `structuredPatch` hunks into unified diff text. */
export function structuredPatchToDiff(
  path: string,
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]
): string {
  if (!Array.isArray(hunks) || hunks.length === 0) return ''
  const out = [`--- a/${path}`, `+++ b/${path}`]
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    out.push(...h.lines)
  }
  return out.join('\n') + '\n'
}
