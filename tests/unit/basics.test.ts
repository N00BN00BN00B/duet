import { describe, expect, it } from 'vitest'
import { LineSplitter, TailBuffer } from '../../src/main/util/lines'
import { diffLines, diffStats, parseUnifiedDiff, structuredPatchToDiff, unifiedDiff } from '../../src/shared/diff'
import { basename, displayPath, firstLine, truncate } from '../../src/shared/paths'
import { mergePath, parseEnvNul } from '../../src/main/env'
import { parseBranchLine, parsePorcelain } from '../../src/main/features/git'
import { fuzzyScore } from '../../src/main/features/files'
import { joinArgs, splitArgs } from '../../src/renderer/src/lib/args'
import { normalizeUrl } from '../../src/renderer/src/lib/url'
import { formatBytes, formatDuration, formatTokens, projectName, resetsIn, shortModel, timeAgo, tildify } from '../../src/renderer/src/lib/format'

describe('LineSplitter', () => {
  it('splits across chunks, handles CRLF and multibyte characters', () => {
    const lines: string[] = []
    const s = new LineSplitter((l) => lines.push(l))
    const emoji = Buffer.from('{"a":"héllo 🎉"}\n', 'utf8')
    s.push(emoji.subarray(0, 9))
    s.push(emoji.subarray(9, 15))
    s.push(Buffer.concat([emoji.subarray(15), Buffer.from('second\r\n\nthird')]))
    expect(lines).toEqual(['{"a":"héllo 🎉"}', 'second'])
    s.flush()
    expect(lines).toEqual(['{"a":"héllo 🎉"}', 'second', 'third'])
  })

  it('TailBuffer keeps only the end', () => {
    const t = new TailBuffer(5)
    t.push('hello ')
    t.push('world')
    expect(t.value).toBe('world')
  })
})

describe('diff', () => {
  it('computes minimal line edits', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')
    expect(ops.map((o) => `${o.type[0]}${o.line}`)).toEqual(['ea', 'db', 'iB', 'ec', 'id'])
  })

  it('builds a unified diff with correct hunk headers', () => {
    const d = unifiedDiff('one\ntwo\nthree\n', 'one\n2\nthree\n', 'f.txt')
    expect(d).toBe('--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n')
    expect(diffStats(d)).toEqual({ additions: 1, deletions: 1 })
  })

  it('handles new and empty files', () => {
    expect(unifiedDiff('', 'x\ny\n', 'new.ts')).toContain('@@ -0,0 +1,2 @@')
    expect(unifiedDiff('same\n', 'same\n')).toBe('')
  })

  it('separates distant changes into hunks', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const after = before.replace('line 2\n', 'line two\n').replace('line 27\n', 'line twenty-seven\n')
    const d = unifiedDiff(before, after, 'big.txt')
    expect(d.match(/^@@/gm)).toHaveLength(2)
    const files = parseUnifiedDiff(d)
    expect(files).toHaveLength(1)
    expect(files[0].additions).toBe(2)
    expect(files[0].deletions).toBe(2)
    const added = files[0].lines.filter((l) => l.type === 'add')
    expect(added.map((l) => l.newNo)).toEqual([3, 28])
  })

  it('parses multi-file git diffs', () => {
    const git = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      'diff --git a/b.md b/b.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/b.md',
      '@@ -0,0 +1 @@',
      '+hello'
    ].join('\n')
    const files = parseUnifiedDiff(git)
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'b.md'])
    expect(files[1].additions).toBe(1)
  })

  it('converts Claude structured patches', () => {
    const d = structuredPatchToDiff('x.ts', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }])
    expect(d).toBe('--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n')
    expect(structuredPatchToDiff('x', [])).toBe('')
  })

  it('falls back to a full replace for huge rewrites', () => {
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n')
    const ops = diffLines(a, b)
    expect(ops.filter((o) => o.type === 'delete')).toHaveLength(2500)
    expect(ops.filter((o) => o.type === 'insert')).toHaveLength(2500)
  })
})

describe('paths', () => {
  it('shows paths relative to the project or home', () => {
    expect(displayPath('/Users/me/proj/src/a.ts', '/Users/me/proj', '/Users/me')).toBe('src/a.ts')
    expect(displayPath('/Users/me/other/b.ts', '/Users/me/proj', '/Users/me')).toBe('~/other/b.ts')
    expect(displayPath('/Users/me/proj', '/Users/me/proj/')).toBe('.')
    expect(displayPath('/etc/hosts', '/Users/me/proj', '/Users/me')).toBe('/etc/hosts')
    expect(basename('/a/b/c/')).toBe('c')
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(firstLine('\n\n  hi there\nnext')).toBe('hi there')
  })
})

describe('env', () => {
  it('parses NUL separated env output and merges PATH', () => {
    expect(parseEnvNul('A=1\0B=x=y\0\nC=multi\nline\0bad\0')).toEqual({ A: '1', B: 'x=y', C: 'multi\nline' })
    expect(mergePath('/a:/b', undefined, '/b:/c')).toBe('/a:/b:/c')
  })
})

describe('git parsing', () => {
  it('reads branch lines', () => {
    expect(parseBranchLine('## main...origin/main [ahead 2, behind 1]')).toEqual({ branch: 'main', ahead: 2, behind: 1 })
    expect(parseBranchLine('## feature/x')).toEqual({ branch: 'feature/x' })
    expect(parseBranchLine('## No commits yet on main')).toEqual({ branch: 'main' })
  })
  it('reads porcelain status', () => {
    const { files, branchLine } = parsePorcelain('## main\n M src/a.ts\n?? new.txt\nR  old.ts -> renamed.ts\n D gone.ts\n')
    expect(branchLine).toBe('## main')
    expect(files).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'new.txt', status: 'untracked' },
      { path: 'renamed.ts', status: 'renamed' },
      { path: 'gone.ts', status: 'deleted' }
    ])
  })
})

describe('fuzzy file search', () => {
  it('ranks exact and prefix basename matches first', () => {
    const paths = ['src/components/Composer.tsx', 'src/composer.css', 'docs/compose.md', 'README.md']
    const ranked = paths.map((p) => ({ p, s: fuzzyScore(p, 'composer') })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)
    expect(ranked[0].p).toBe('src/composer.css')
    expect(fuzzyScore('README.md', 'zzz')).toBe(-1)
    expect(fuzzyScore('src/main/index.ts', 'smi')).toBeGreaterThan(0)
  })
})

describe('renderer helpers', () => {
  it('splits and joins shell arguments', () => {
    expect(splitArgs('-y @x/server "/tmp/my files" \'a b\' plain\\ space ""')).toEqual(['-y', '@x/server', '/tmp/my files', 'a b', 'plain space', ''])
    const args = ['-y', 'pkg', 'with space', 'quo"te', '']
    expect(splitArgs(joinArgs(args))).toEqual(args)
  })

  it('normalizes browser input', () => {
    expect(normalizeUrl('3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('https://x.dev/a?b=1')).toBe('https://x.dev/a?b=1')
    expect(normalizeUrl('how to center a div')).toContain('google.com/search?q=how%20to%20center%20a%20div')
    expect(normalizeUrl('  ')).toBe('')
  })

  it('formats numbers and times', () => {
    const now = 1_000_000_000_000
    expect(timeAgo(now - 10_000, now)).toBe('now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatDuration(450)).toBe('450ms')
    expect(formatDuration(12_300)).toBe('12s')
    expect(formatDuration(65_000)).toBe('1m 5s')
    expect(formatTokens(18_234)).toBe('18k')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
    expect(projectName('/Users/me/Desktop/Duet/')).toBe('Duet')
    expect(tildify('/Users/me/x', '/Users/me')).toBe('~/x')
    expect(resetsIn(now + 90 * 60_000, now)).toBe('resets in 1h 30m')
    expect(resetsIn(now + 3 * 3_600_000 - 1000, now)).toBe('resets in 3h 0m')
    expect(resetsIn(now + 20_000, now)).toBe('resets in 1m')
    expect(resetsIn(now - 1, now)).toBe('resetting')
  })
})
