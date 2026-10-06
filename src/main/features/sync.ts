import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { McpServerConfig, SyncAction, SyncItem } from '@shared/types'
import { claudeHome, codexHome } from './history'
import { claudeToConfig, codexToConfig, readClaudeJson, readCodexConfig, sameServer, writeClaudeServer, writeCodexServer, type McpWriteDeps } from './mcp'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

interface Side {
  path: string
  mtime: number
  size: number
  hash: string
}

function fileSide(path: string): Side | undefined {
  try {
    const st = statSync(path)
    if (!st.isFile()) return undefined
    const data = readFileSync(path)
    return { path, mtime: st.mtimeMs, size: st.size, hash: createHash('sha1').update(data).digest('hex') }
  } catch {
    return undefined
  }
}

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full))
  }
  return out
}

function dirSide(path: string): Side | undefined {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return undefined
    const files = walkFiles(path).sort()
    const hash = createHash('sha1')
    let size = 0
    let mtime = st.mtimeMs
    for (const rel of files) {
      const full = join(path, rel)
      const fst = statSync(full)
      size += fst.size
      mtime = Math.max(mtime, fst.mtimeMs)
      hash.update(rel).update('\0').update(readFileSync(full)).update('\0')
    }
    return { path, mtime, size, hash: hash.digest('hex') }
  } catch {
    return undefined
  }
}

function compare(key: string, kind: SyncItem['kind'], name: string, claude?: Side, codex?: Side): SyncItem | null {
  if (!claude && !codex) return null
  let state: SyncItem['state']
  if (claude && codex) state = claude.hash === codex.hash ? 'same' : 'different'
  else if (claude) state = 'claude-only'
  else state = 'codex-only'
  // MCP entries carry no timestamps; never guess a winner for those.
  const newer = claude && codex && state === 'different' && (claude.mtime || codex.mtime) ? (claude.mtime >= codex.mtime ? 'claude' : 'codex') : undefined
  return { key, kind, name, claude, codex, state, newer }
}

function listSkillDirs(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((name) => existsSync(join(root, name, 'SKILL.md')))
}

function listMarkdown(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name.slice(0, -3))
}

export interface SyncPaths {
  claudeHome: string
  codexHome: string
}

export function defaultSyncPaths(): SyncPaths {
  return { claudeHome: claudeHome(), codexHome: codexHome() }
}

/** Compares everything that can be shared between Claude Code and Codex. */
export function scanSync(cwd?: string, paths: SyncPaths = defaultSyncPaths(), mcp?: { claude: Record<string, Json>; codex: Record<string, Json> }): SyncItem[] {
  const found: (SyncItem | null)[] = []
  found.push(compare('instructions:global', 'instructions', 'Global instructions (CLAUDE.md ↔ AGENTS.md)', fileSide(join(paths.claudeHome, 'CLAUDE.md')), fileSide(join(paths.codexHome, 'AGENTS.md'))))
  if (cwd && existsSync(cwd)) {
    found.push(compare(`instructions:project:${cwd}`, 'instructions', 'Project instructions (CLAUDE.md ↔ AGENTS.md)', fileSide(join(cwd, 'CLAUDE.md')), fileSide(join(cwd, 'AGENTS.md'))))
  }
  const claudeSkills = join(paths.claudeHome, 'skills')
  const codexSkills = join(paths.codexHome, 'skills')
  const skillNames = new Set([...listSkillDirs(claudeSkills), ...listSkillDirs(codexSkills)])
  for (const name of [...skillNames].sort((a, b) => a.localeCompare(b))) {
    found.push(compare(`skill:${name}`, 'skill', name, dirSide(join(claudeSkills, name)), dirSide(join(codexSkills, name))))
  }
  const claudeCommands = join(paths.claudeHome, 'commands')
  const codexPrompts = join(paths.codexHome, 'prompts')
  const commandNames = new Set([...listMarkdown(claudeCommands), ...listMarkdown(codexPrompts)])
  for (const name of [...commandNames].sort((a, b) => a.localeCompare(b))) {
    found.push(compare(`command:${name}`, 'command', `/${name}`, fileSide(join(claudeCommands, `${name}.md`)), fileSide(join(codexPrompts, `${name}.md`))))
  }
  const claudeMcp = mcp?.claude ?? readClaudeJson().mcpServers ?? {}
  const codexMcp = mcp?.codex ?? readCodexConfig().mcp_servers ?? {}
  const names = new Set([...Object.keys(claudeMcp), ...Object.keys(codexMcp)])
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const c = claudeMcp[name] ? claudeToConfig(name, claudeMcp[name]) : undefined
    const x = codexMcp[name] ? codexToConfig(name, codexMcp[name]) : undefined
    const side = (cfg: McpServerConfig, where: string): Side => ({ path: where, mtime: 0, size: 0, hash: createHash('sha1').update(JSON.stringify([cfg.transport === 'sse' ? 'http' : cfg.transport, cfg.command ?? '', cfg.args ?? [], Object.entries(cfg.env ?? {}).sort(), cfg.url ?? ''])).digest('hex') })
    const item = compare(`mcp:${name}`, 'mcp', name, c ? side(c, '~/.claude.json') : undefined, x ? side(x, '~/.codex/config.toml') : undefined)
    if (item && c && x && sameServer(c, x)) item.state = 'same'
    found.push(item)
  }
  return found.filter((i): i is SyncItem => i !== null)
}

function safetyCopy(target: string, backupRoot: string): void {
  if (!existsSync(target)) return
  const dest = join(backupRoot, target.replace(/^\/+/, ''))
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(target, dest, { recursive: true, dereference: false })
}

export async function applySync(
  actions: SyncAction[],
  opts: { cwd?: string; paths?: SyncPaths; backupRoot: string; mcp?: McpWriteDeps }
): Promise<{ applied: number; errors: string[] }> {
  const paths = opts.paths ?? defaultSyncPaths()
  const scanned = new Map(scanSync(opts.cwd, paths).map((i) => [i.key, i]))
  const errors: string[] = []
  let applied = 0
  for (const action of actions) {
    const item = scanned.get(action.key)
    if (!item) {
      errors.push(`${action.key}: not found (rescan and try again)`)
      continue
    }
    const toCodex = action.direction === 'to-codex'
    try {
      if (item.kind === 'instructions' || item.kind === 'command') {
        const src = toCodex ? item.claude : item.codex
        if (!src) throw new Error('nothing to copy')
        let target: string
        if (item.kind === 'command') target = toCodex ? join(paths.codexHome, 'prompts', `${item.name.slice(1)}.md`) : join(paths.claudeHome, 'commands', `${item.name.slice(1)}.md`)
        else if (item.key === 'instructions:global') target = toCodex ? join(paths.codexHome, 'AGENTS.md') : join(paths.claudeHome, 'CLAUDE.md')
        else {
          const cwd = item.key.slice('instructions:project:'.length)
          target = toCodex ? join(cwd, 'AGENTS.md') : join(cwd, 'CLAUDE.md')
        }
        safetyCopy(target, opts.backupRoot)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, readFileSync(src.path))
      } else if (item.kind === 'skill') {
        const src = toCodex ? item.claude : item.codex
        if (!src) throw new Error('nothing to copy')
        const target = join(toCodex ? join(paths.codexHome, 'skills') : join(paths.claudeHome, 'skills'), item.name)
        if (existsSync(target)) {
          safetyCopy(target, opts.backupRoot)
          const trash = `${target}.duet-old-${Date.now()}`
          renameSync(target, trash)
          try {
            cpSync(src.path, target, { recursive: true, dereference: true })
          } catch (copyError) {
            rmSync(target, { recursive: true, force: true })
            renameSync(trash, target)
            throw copyError
          }
          // The old copy is preserved in the safety backup; drop the temporary rename.
          rmSync(trash, { recursive: true, force: true })
        } else {
          mkdirSync(dirname(target), { recursive: true })
          cpSync(src.path, target, { recursive: true, dereference: true })
        }
      } else if (item.kind === 'mcp') {
        if (!opts.mcp) throw new Error('MCP writes are unavailable')
        const name = item.name
        if (toCodex) {
          const raw = readClaudeJson().mcpServers?.[name]
          if (!raw) throw new Error('server not found in Claude')
          await writeCodexServer(opts.mcp, claudeToConfig(name, raw))
        } else {
          const raw = readCodexConfig().mcp_servers?.[name]
          if (!raw) throw new Error('server not found in Codex')
          const cfg = codexToConfig(name, raw)
          if (raw.env && typeof raw.env === 'object') cfg.env = Object.fromEntries(Object.entries<Json>(raw.env).map(([k, v]) => [k, String(v)]))
          await writeClaudeServer(opts.mcp, cfg, 'user')
        }
      }
      applied++
    } catch (error) {
      errors.push(`${item.name}: ${(error as Error).message}`)
    }
  }
  return { applied, errors }
}
