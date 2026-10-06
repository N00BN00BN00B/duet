import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { FileSuggestion } from '@shared/types'
import { runCommand } from '../env'

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.turbo', '.cache', 'coverage', '.venv', '__pycache__', 'target', 'release'])
const MAX_FILES = 20_000
const TTL_MS = 20_000

const cache = new Map<string, { at: number; files: string[] }>()

function walk(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.claude' && e.name !== '.codex') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(full)
      } else if (e.isFile()) out.push(relative(root, full))
    }
  }
  return out
}

async function listFiles(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files
  let files: string[] = []
  const res = await runCommand('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard'], { timeoutMs: 10_000 })
  if (res.code === 0 && res.stdout.trim()) files = res.stdout.split('\n').filter(Boolean).slice(0, MAX_FILES)
  else files = walk(cwd)
  cache.set(cwd, { at: Date.now(), files })
  return files
}

/** Scores a fuzzy subsequence match; higher is better, -1 means no match. */
export function fuzzyScore(path: string, query: string): number {
  if (!query) return 1
  const p = path.toLowerCase()
  const q = query.toLowerCase()
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (base === q) return 1000 - p.length / 100
  if (base.startsWith(q)) return 800 - base.length - p.length / 100
  const idx = p.indexOf(q)
  if (idx >= 0) return 600 - idx - p.length / 10
  let score = 0
  let pi = 0
  let streak = 0
  for (const ch of q) {
    const found = p.indexOf(ch, pi)
    if (found < 0) return -1
    streak = found === pi ? streak + 1 : 0
    score += 10 + streak * 5 - Math.min(found - pi, 10)
    pi = found + 1
  }
  return score - p.length / 20
}

export async function suggestFiles(cwd: string, query: string): Promise<FileSuggestion[]> {
  if (!cwd) return []
  const files = await listFiles(cwd)
  const dirs = new Set<string>()
  for (const f of files) {
    let i = f.indexOf('/')
    while (i > 0) {
      dirs.add(f.slice(0, i))
      i = f.indexOf('/', i + 1)
    }
  }
  const candidates: FileSuggestion[] = [...[...dirs].map((d) => ({ path: d, isDir: true })), ...files.map((f) => ({ path: f, isDir: false }))]
  return candidates
    .map((c) => ({ c, s: fuzzyScore(c.path, query) - (c.isDir ? 5 : 0) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.c.path.length - b.c.path.length)
    .slice(0, 40)
    .map((x) => x.c)
}
