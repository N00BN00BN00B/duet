import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { GitFileChange, GitStatus } from '@shared/types'
import { runCommand } from '../env'

const git = (cwd: string, args: string[], timeoutMs = 15_000) => runCommand('git', ['-C', cwd, ...args], { timeoutMs })

export function parseBranchLine(line: string): { branch?: string; ahead?: number; behind?: number } {
  // "## main...origin/main [ahead 1, behind 2]" | "## No commits yet on main" | "## HEAD (no branch)"
  const body = line.replace(/^##\s+/, '')
  if (body.startsWith('No commits yet on ')) return { branch: body.slice('No commits yet on '.length).trim() }
  if (body.startsWith('HEAD (no branch)')) return { branch: 'detached HEAD' }
  const match = body.match(/^(.+?)(?:\.\.\.\S+)?(?:\s+\[(.+)\])?$/)
  const out: { branch?: string; ahead?: number; behind?: number } = { branch: match?.[1]?.trim() }
  const info = match?.[2] ?? ''
  const ahead = info.match(/ahead (\d+)/)
  const behind = info.match(/behind (\d+)/)
  if (ahead) out.ahead = Number(ahead[1])
  if (behind) out.behind = Number(behind[1])
  return out
}

export function parsePorcelain(text: string): { branchLine?: string; files: { path: string; status: string }[] } {
  const files: { path: string; status: string }[] = []
  let branchLine: string | undefined
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.startsWith('## ')) {
      branchLine = line
      continue
    }
    const code = line.slice(0, 2)
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ')[1]
    if (path.startsWith('"') && path.endsWith('"')) {
      try {
        path = JSON.parse(path)
      } catch {
        // keep raw
      }
    }
    let status = 'modified'
    if (code === '??') status = 'untracked'
    else if (code.includes('A')) status = 'added'
    else if (code.includes('D')) status = 'deleted'
    else if (code.includes('R')) status = 'renamed'
    else if (code.includes('U')) status = 'conflict'
    files.push({ path, status })
  }
  return { branchLine, files }
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  if (!cwd || !existsSync(cwd)) return { isRepo: false, files: [] }
  const res = await git(cwd, ['status', '--porcelain=v1', '-b', '-uall'])
  if (res.code !== 0) return { isRepo: false, files: [] }
  const { branchLine, files } = parsePorcelain(res.stdout)
  const branch = branchLine ? parseBranchLine(branchLine) : {}
  const numstat = new Map<string, { a: number; d: number }>()
  let ns = await git(cwd, ['diff', 'HEAD', '--numstat'])
  if (ns.code !== 0) ns = await git(cwd, ['diff', '--numstat'])
  for (const line of ns.stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    let p = m[3]
    if (p.includes(' => ')) p = p.replace(/\{.*? => (.*?)\}/, '$1').replace(/^.* => /, '')
    numstat.set(p, { a: m[1] === '-' ? 0 : Number(m[1]), d: m[2] === '-' ? 0 : Number(m[2]) })
  }
  const out: GitFileChange[] = []
  for (const f of files.slice(0, 500)) {
    const stat = numstat.get(f.path)
    let additions = stat?.a ?? 0
    if (f.status === 'untracked') {
      try {
        const full = join(cwd, f.path)
        const st = statSync(full)
        if (st.isFile() && st.size < 512 * 1024) {
          const text = readFileSync(full, 'utf8')
          additions = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
        }
      } catch {
        // ignore
      }
    }
    out.push({ path: f.path, status: f.status, additions, deletions: stat?.d ?? 0 })
  }
  return { isRepo: true, branch: branch.branch, ahead: branch.ahead, behind: branch.behind, files: out }
}

const MAX_DIFF = 1024 * 1024

export async function gitDiff(cwd: string, file?: string): Promise<string> {
  if (!cwd || !existsSync(cwd)) return ''
  const status = await gitStatus(cwd)
  if (!status.isRepo) return ''
  const targets = file ? status.files.filter((f) => f.path === file) : status.files
  const tracked = targets.filter((f) => f.status !== 'untracked').map((f) => f.path)
  const untracked = targets.filter((f) => f.status === 'untracked').map((f) => f.path)
  let diff = ''
  if (tracked.length) {
    let res = await git(cwd, ['diff', 'HEAD', '--no-color', '--', ...tracked], 30_000)
    if (res.code !== 0) res = await git(cwd, ['diff', '--no-color', '--', ...tracked], 30_000)
    diff += res.stdout
  }
  for (const path of untracked.slice(0, 60)) {
    if (diff.length > MAX_DIFF) break
    const res = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', path])
    diff += res.stdout
  }
  return diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n… diff truncated …\n' : diff
}
