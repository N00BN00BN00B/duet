import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import * as tarStream from 'tar-stream'
import type { BackupInfo, BackupSet } from '@shared/types'

/**
 * Backups are gzip'd tar archives. Every entry is stored under a logical root
 * (`claude/…`, `codex/…`, `duet/…`, `claude-json/.claude.json`) instead of an absolute
 * path, so an archive restores correctly on another Mac or with custom config folders.
 */

export interface BackupContext {
  home: string
  claudeDir: string
  claudeJson: string
  codexDir: string
  duetDir: string
  appVersion: string
}

type RootKey = 'claude' | 'claude-json' | 'codex' | 'duet'

function roots(ctx: BackupContext): Record<RootKey, string> {
  return { claude: ctx.claudeDir, 'claude-json': dirname(ctx.claudeJson), codex: ctx.codexDir, duet: ctx.duetDir }
}

interface SetSpec {
  id: string
  label: string
  description: string
  sensitive?: boolean
  defaultOn: boolean
  /** Absolute paths (files or folders) that belong to this set. */
  paths: (ctx: BackupContext) => string[]
  exclude?: (ctx: BackupContext) => string[]
}

const SKIP_NAMES = new Set(['.DS_Store'])
const CODEX_DB = /^(state|thread_history|memories|goals|queue|logs)_\d+\.sqlite(-wal|-shm)?$/

export const BACKUP_SETS: SetSpec[] = [
  {
    id: 'claude-config',
    label: 'Claude settings & skills',
    description: 'settings.json, CLAUDE.md, skills, agents, commands, plugins list, MCP servers (~/.claude.json)',
    defaultOn: true,
    paths: (c) => [
      join(c.claudeDir, 'settings.json'),
      join(c.claudeDir, 'settings.local.json'),
      join(c.claudeDir, 'CLAUDE.md'),
      join(c.claudeDir, 'keybindings.json'),
      join(c.claudeDir, 'skills'),
      join(c.claudeDir, 'agents'),
      join(c.claudeDir, 'commands'),
      join(c.claudeDir, 'output-styles'),
      join(c.claudeDir, 'hooks'),
      join(c.claudeDir, 'plugins', 'installed_plugins.json'),
      join(c.claudeDir, 'plugins', 'known_marketplaces.json'),
      join(c.claudeDir, 'plugins', 'config.json'),
      c.claudeJson
    ]
  },
  {
    id: 'claude-sessions',
    label: 'Claude conversations',
    description: 'Every Claude Code session transcript, prompt history and to-dos',
    defaultOn: true,
    paths: (c) => [join(c.claudeDir, 'projects'), join(c.claudeDir, 'history.jsonl'), join(c.claudeDir, 'todos')]
  },
  {
    id: 'codex-config',
    label: 'Codex settings & skills',
    description: 'config.toml (MCP servers, models), AGENTS.md, skills, prompts, rules, memories',
    defaultOn: true,
    paths: (c) => [
      join(c.codexDir, 'config.toml'),
      join(c.codexDir, 'AGENTS.md'),
      join(c.codexDir, 'skills'),
      join(c.codexDir, 'prompts'),
      join(c.codexDir, 'rules'),
      join(c.codexDir, 'hooks.json'),
      join(c.codexDir, 'memories'),
      join(c.codexDir, 'automations')
    ],
    exclude: (c) => [join(c.codexDir, 'skills', '.system')]
  },
  {
    id: 'codex-sessions',
    label: 'Codex conversations',
    description: 'Codex session rollouts, archived sessions and the session index',
    defaultOn: true,
    paths: (c) => [join(c.codexDir, 'sessions'), join(c.codexDir, 'archived_sessions'), join(c.codexDir, 'session_index.jsonl')]
  },
  {
    id: 'codex-app-state',
    label: 'Codex app databases',
    description: 'Codex desktop app state and thread-history databases (*.sqlite). Large; quit Codex first for a clean copy.',
    defaultOn: false,
    paths: (c) => (existsSync(c.codexDir) ? readdirSync(c.codexDir).filter((n) => CODEX_DB.test(n) && !n.startsWith('logs_')).map((n) => join(c.codexDir, n)) : [])
  },
  {
    id: 'codex-auth',
    label: 'Codex login',
    description: 'auth.json — contains your Codex sign-in tokens. Only include it if you keep the backup private.',
    sensitive: true,
    defaultOn: false,
    paths: (c) => [join(c.codexDir, 'auth.json')]
  },
  {
    id: 'duet',
    label: 'Duet threads & settings',
    description: 'Duet conversations, attachments and preferences',
    defaultOn: true,
    paths: (c) => [join(c.duetDir, 'settings.json'), join(c.duetDir, 'threads'), join(c.duetDir, 'attachments')]
  }
]

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function excluded(path: string, excludes: string[]): boolean {
  return excludes.some((e) => within(path, e))
}

export function collectFiles(spec: SetSpec, ctx: BackupContext): { files: string[]; bytes: number } {
  const excludes = spec.exclude?.(ctx) ?? []
  const files: string[] = []
  let bytes = 0
  const visit = (path: string) => {
    if (excluded(path, excludes) || SKIP_NAMES.has(basename(path))) return
    let st
    try {
      st = lstatSync(path)
    } catch {
      return
    }
    if (st.isSymbolicLink()) files.push(path)
    else if (st.isDirectory()) {
      let names: string[] = []
      try {
        names = readdirSync(path)
      } catch {
        return
      }
      for (const name of names.sort()) visit(join(path, name))
    } else if (st.isFile()) {
      files.push(path)
      bytes += st.size
    }
  }
  for (const p of spec.paths(ctx)) visit(p)
  return { files, bytes }
}

export function describeSets(ctx: BackupContext, includeAuthDefault = false): BackupSet[] {
  return BACKUP_SETS.map((spec) => {
    const { files, bytes } = collectFiles(spec, ctx)
    return {
      id: spec.id,
      label: spec.label,
      description: spec.description,
      sensitive: spec.sensitive,
      defaultOn: spec.id === 'codex-auth' ? includeAuthDefault : spec.defaultOn,
      bytes,
      files: files.length
    }
  })
}

/** Maps an absolute path to its archive name, e.g. `~/.codex/config.toml` → `codex/config.toml`. */
export function archiveName(path: string, ctx: BackupContext): string | null {
  if (path === ctx.claudeJson) return `claude-json/${basename(ctx.claudeJson)}`
  const r = roots(ctx)
  // Most specific root first (duet may live inside home, claude inside home, …).
  const ordered = (Object.entries(r) as [RootKey, string][]).filter(([k]) => k !== 'claude-json').sort((a, b) => b[1].length - a[1].length)
  for (const [key, root] of ordered) {
    if (within(path, root)) {
      const rel = relative(root, path)
      if (!rel || rel.startsWith('..')) return null
      return `${key}/${rel.split(sep).join('/')}`
    }
  }
  return null
}

/** Maps an archive name back to an absolute path on this machine, refusing anything that escapes its root. */
export function restorePath(name: string, ctx: BackupContext): string | null {
  const clean = name.replace(/^\.\//, '')
  const slash = clean.indexOf('/')
  if (slash <= 0) return null
  const key = clean.slice(0, slash) as RootKey
  const rest = clean.slice(slash + 1)
  if (!rest || rest.split('/').some((seg) => seg === '..' || seg === '')) return null
  if (key === 'claude-json') return rest === basename(ctx.claudeJson) ? ctx.claudeJson : null
  const root = roots(ctx)[key]
  if (!root) return null
  const target = resolve(root, rest)
  return within(target, resolve(root)) && target !== resolve(root) ? target : null
}

export function setForPath(abs: string, ctx: BackupContext): string | null {
  for (const spec of BACKUP_SETS) {
    if (excluded(abs, spec.exclude?.(ctx) ?? [])) continue
    if (spec.id === 'codex-app-state') {
      if (dirname(abs) === ctx.codexDir && CODEX_DB.test(basename(abs))) return spec.id
      continue
    }
    for (const p of spec.paths(ctx)) if (within(abs, p)) return spec.id
  }
  return null
}

function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export interface CreateOptions {
  sets: string[]
  dir: string
  suffix?: string
  onProgress?: (done: number, total: number) => void
}

interface Manifest extends BackupInfo {
  version: 2
  total: number
  roots: Record<RootKey, string>
}

function addEntry(pack: tarStream.Pack, header: Partial<tarStream.Header> & { name: string }, body?: { file?: string; data?: Buffer }): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const done = (err?: Error | null) => (err ? reject(err) : resolvePromise())
    if (body?.data) {
      pack.entry(header, body.data, done)
      return
    }
    if (!body?.file) {
      pack.entry(header, done)
      return
    }
    const entry = pack.entry(header, done)
    const read = createReadStream(body.file)
    read.on('error', (err) => {
      entry.destroy(err)
      reject(err)
    })
    read.pipe(entry)
  })
}

export async function createBackup(ctx: BackupContext, opts: CreateOptions): Promise<BackupInfo> {
  const specs = BACKUP_SETS.filter((s) => opts.sets.includes(s.id))
  if (!specs.length) throw new Error('Pick at least one thing to back up.')
  const files: { abs: string; name: string }[] = []
  let total = 0
  for (const spec of specs) {
    const { files: list, bytes } = collectFiles(spec, ctx)
    total += bytes
    for (const abs of list) {
      const name = archiveName(abs, ctx)
      if (name) files.push({ abs, name })
    }
  }
  if (!files.length) throw new Error('Nothing to back up — those folders are empty.')
  mkdirSync(opts.dir, { recursive: true })
  const name = `duet-backup-${stamp()}${opts.suffix ? `-${opts.suffix}` : ''}`
  const file = join(opts.dir, `${name}.tar.gz`)
  const partial = `${file}.partial`
  const info: BackupInfo = { file, name, createdAt: Date.now(), bytes: 0, sets: specs.map((s) => s.id), files: files.length, host: hostname(), app: `Duet ${ctx.appVersion}` }
  const manifest: Manifest = { ...info, version: 2, total, roots: roots(ctx) }

  const pack = tarStream.pack()
  const done = pipeline(pack, createGzip({ level: 6 }), createWriteStream(partial))
  let written = 0
  let lastReport = 0
  try {
    await addEntry(pack, { name: 'duet-backup.json', mode: 0o644, mtime: new Date() }, { data: Buffer.from(JSON.stringify(manifest, null, 2)) })
    for (const f of files) {
      let st
      try {
        st = lstatSync(f.abs)
      } catch {
        continue // vanished since we scanned
      }
      if (st.isSymbolicLink()) {
        await addEntry(pack, { name: f.name, type: 'symlink', linkname: readlinkSync(f.abs), mode: 0o755, mtime: st.mtime })
      } else if (st.isFile()) {
        await addEntry(pack, { name: f.name, size: st.size, mode: st.mode & 0o777, mtime: st.mtime }, { file: f.abs })
        written += st.size
      }
      const now = Date.now()
      if (now - lastReport > 150) {
        lastReport = now
        opts.onProgress?.(written, total)
      }
    }
    pack.finalize()
    await done
  } catch (error) {
    pack.destroy()
    await done.catch(() => undefined)
    rmSync(partial, { force: true })
    throw error
  }
  renameSync(partial, file)
  opts.onProgress?.(total, total)
  info.bytes = statSync(file).size
  writeFileSync(join(opts.dir, `${name}.json`), JSON.stringify({ ...manifest, bytes: info.bytes }, null, 2))
  return info
}

export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return []
  const out: BackupInfo[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('duet-backup-') || !entry.endsWith('.tar.gz')) continue
    const file = join(dir, entry)
    const name = entry.slice(0, -'.tar.gz'.length)
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    let meta: Partial<BackupInfo> = {}
    try {
      meta = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))
    } catch {
      // No sidecar: show what we know from the file itself.
    }
    out.push({ file, name, createdAt: meta.createdAt ?? st.mtimeMs, bytes: st.size, sets: meta.sets ?? [], files: meta.files ?? 0, host: meta.host, app: meta.app })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function restoreBackup(
  ctx: BackupContext,
  file: string,
  sets: string[],
  opts: { safetyDir: string; onProgress?: (done: number, total: number) => void }
): Promise<{ restored: number; safetyBackup: string }> {
  if (!existsSync(file)) throw new Error('Backup file not found')
  const wanted = new Set(sets)
  // 1. Snapshot what is about to be overwritten so a restore can always be undone.
  let safetyBackup = ''
  const present = BACKUP_SETS.filter((s) => wanted.has(s.id) && collectFiles(s, ctx).files.length > 0).map((s) => s.id)
  if (present.length) safetyBackup = (await createBackup(ctx, { sets: present, dir: opts.safetyDir, suffix: 'before-restore' })).file
  // 2. Stream through the archive and write the chosen sets.
  let restored = 0
  let processed = 0
  const total = statSync(file).size
  const extract = tarStream.extract()
  extract.on('entry', (header, stream, next) => {
    const finish = (err?: unknown) => {
      if (err) stream.resume()
      next(err instanceof Error ? err : undefined)
    }
    processed += header.size ?? 0
    opts.onProgress?.(Math.min(processed, total), total)
    const target = header.name === 'duet-backup.json' ? null : restorePath(header.name, ctx)
    const set = target ? setForPath(target, ctx) : null
    if (!target || !set || !wanted.has(set)) {
      stream.on('end', () => finish())
      stream.resume()
      return
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
      if (header.type === 'symlink' && header.linkname) {
        stream.resume()
        stream.on('end', () => {
          try {
            // Only recreate links that stay inside their data folder.
            const linkTarget = isAbsolute(header.linkname!) ? header.linkname! : resolve(dirname(target), header.linkname!)
            const root = Object.values(roots(ctx)).find((r) => within(target, r))
            if (root && within(linkTarget, root)) {
              rmSync(target, { force: true, recursive: true })
              symlinkSync(header.linkname!, target)
              restored++
            }
            finish()
          } catch (e) {
            finish(e)
          }
        })
        return
      }
      if (header.type !== 'file' && header.type !== undefined) {
        stream.on('end', () => finish())
        stream.resume()
        return
      }
      const tmp = `${target}.duet-restore`
      const out = createWriteStream(tmp, { mode: header.mode ? header.mode & 0o777 : 0o644 })
      pipeline(stream, out)
        .then(() => {
          renameSync(tmp, target)
          restored++
          finish()
        })
        .catch((e) => {
          rmSync(tmp, { force: true })
          finish(e)
        })
    } catch (e) {
      finish(e)
    }
  })
  await pipeline(createReadStream(file), createGunzip(), extract)
  return { restored, safetyBackup }
}

export function defaultContext(duetDir: string, appVersion: string): BackupContext {
  const home = homedir()
  return {
    home,
    claudeDir: process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    claudeJson: join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json'),
    codexDir: process.env.CODEX_HOME || join(home, '.codex'),
    duetDir,
    appVersion
  }
}
