import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
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
/** Never worth backing up, and huge when a linked skill points into a whole repository. */
const SKIP_DIRS = new Set(['node_modules', '.git'])
const CHUNK = 1024 * 1024
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

/**
 * Lists the files of a set under their logical paths. Symlinks are followed, so a linked skill
 * is backed up as its content and the archive stands on its own. A link that loops back, or
 * leads to a folder holding the home folder or a data folder (say `skills/home -> ~`), is skipped.
 */
export function collectFiles(spec: SetSpec, ctx: BackupContext): { files: string[]; bytes: number } {
  const excludes = spec.exclude?.(ctx) ?? []
  const guards = [ctx.home, ...Object.values(roots(ctx))].map(realish)
  const files: string[] = []
  let bytes = 0
  const visit = (path: string, ancestors: Set<string>) => {
    const name = basename(path)
    if (excluded(path, excludes) || SKIP_NAMES.has(name)) return
    let st
    let linked = false
    try {
      linked = lstatSync(path).isSymbolicLink()
      st = statSync(path)
    } catch {
      return // gone, unreadable or a dangling link
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) return
      let real: string
      let names: string[]
      try {
        real = realpathSync(path)
        names = readdirSync(path)
      } catch {
        return
      }
      if (ancestors.has(real)) return
      if (linked && guards.some((g) => within(g, real))) return
      const inside = new Set(ancestors).add(real)
      for (const child of names.sort()) visit(join(path, child), inside)
    } else if (st.isFile()) {
      files.push(path)
      bytes += st.size
    }
  }
  for (const p of spec.paths(ctx)) visit(p, new Set())
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

function addData(pack: tarStream.Pack, name: string, data: Buffer): Promise<void> {
  return new Promise((resolveEntry, rejectEntry) => {
    pack.entry({ name, mode: 0o644, mtime: new Date() }, data, (err) => (err ? rejectEntry(err) : resolveEntry()))
  })
}

type Sink = ReturnType<tarStream.Pack['entry']>

function drained(entry: Sink): Promise<void> {
  return new Promise((resolveDrain, rejectDrain) => {
    const cleanup = () => {
      entry.off('drain', onDrain)
      entry.off('close', onClose)
      entry.off('error', onError)
    }
    const onDrain = () => (cleanup(), resolveDrain())
    const onClose = () => (cleanup(), rejectDrain(new Error('The archive was closed while writing')))
    const onError = (err: Error) => (cleanup(), rejectDrain(err))
    entry.on('drain', onDrain)
    entry.on('close', onClose)
    entry.on('error', onError)
  })
}

/**
 * Adds one file, writing exactly the size the tar header promises: chat transcripts keep
 * growing while a backup runs, and tar refuses an entry whose size changes. Bytes appended
 * after the header are left out; a file that shrank is padded with zeros.
 * Returns the bytes written, or null when the file can no longer be read (it is skipped).
 */
async function addFile(pack: tarStream.Pack, name: string, abs: string): Promise<number | null> {
  let handle: FileHandle
  try {
    handle = await open(abs, 'r')
  } catch {
    return null
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return null
    const size = st.size
    await new Promise<void>((resolveEntry, rejectEntry) => {
      let settled = false
      const settle = (err?: Error | null) => {
        if (settled) return
        settled = true
        if (err) rejectEntry(err)
        else resolveEntry()
      }
      const entry = pack.entry({ name, size, mode: st.mode & 0o777, mtime: st.mtime }, settle)
      void (async () => {
        let offset = 0
        while (offset < size) {
          const want = Math.min(CHUNK, size - offset)
          const chunk = Buffer.alloc(want) // zero-filled, so a file that shrank pads itself
          let filled = 0
          while (filled < want) {
            const { bytesRead } = await handle.read(chunk, filled, want - filled, offset + filled)
            if (bytesRead === 0) break
            filled += bytesRead
          }
          offset += want
          if (!entry.write(chunk)) await drained(entry)
        }
        entry.end(null) // streamx: no final chunk
      })().catch((err: Error) => {
        entry.destroy(err)
        settle(err)
      })
    })
    return size
  } finally {
    await handle.close().catch(() => undefined)
  }
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
    await addData(pack, 'duet-backup.json', Buffer.from(JSON.stringify(manifest, null, 2)))
    for (const f of files) {
      const size = await addFile(pack, f.name, f.abs)
      if (size === null) continue // vanished or became unreadable since the scan
      written += size
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

/** realpath that also works for paths that don't exist yet (resolved through their nearest existing parent). */
function realish(path: string): string {
  let existing = resolve(path)
  const rest: string[] = []
  while (!existsSync(existing)) {
    const up = dirname(existing)
    if (up === existing) break
    rest.unshift(basename(existing))
    existing = up
  }
  try {
    return join(realpathSync(existing), ...rest)
  } catch {
    return resolve(path)
  }
}

/**
 * Where a restored file may be written: never through a folder or link that leads outside its
 * data folder. A file that is itself a link inside the folder is updated at its real location,
 * so the link survives.
 */
export function restoreTarget(target: string, rootKey: string, ctx: BackupContext): string | null {
  const root = rootKey === 'claude-json' ? dirname(ctx.claudeJson) : roots(ctx)[rootKey as RootKey]
  if (!root) return null
  const realRoot = realish(root)
  if (!within(realish(dirname(target)), realRoot)) return null
  let st
  try {
    st = lstatSync(target)
  } catch {
    return target // new file
  }
  if (st.isDirectory()) return null
  if (!st.isSymbolicLink()) return target
  try {
    const real = realpathSync(target)
    return within(real, realRoot) && statSync(real).isFile() ? real : null
  } catch {
    return null // dangling link: leave it alone
  }
}

export async function restoreBackup(
  ctx: BackupContext,
  file: string,
  sets: string[],
  opts: { safetyDir: string; onProgress?: (done: number, total: number) => void; log?: (...args: unknown[]) => void }
): Promise<{ restored: number; skipped: number; safetyBackup: string }> {
  if (!existsSync(file)) throw new Error('Backup file not found')
  const wanted = new Set(sets)
  // 1. Snapshot what is about to be overwritten so a restore can always be undone.
  let safetyBackup = ''
  const present = BACKUP_SETS.filter((s) => wanted.has(s.id) && collectFiles(s, ctx).files.length > 0).map((s) => s.id)
  if (present.length) safetyBackup = (await createBackup(ctx, { sets: present, dir: opts.safetyDir, suffix: 'before-restore' })).file
  // 2. Stream through the archive and write the chosen sets.
  let restored = 0
  let skipped = 0
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
    const skip = (counted: boolean) => {
      if (counted) skipped++
      stream.on('end', () => finish())
      stream.resume()
    }
    const target = header.name === 'duet-backup.json' ? null : restorePath(header.name, ctx)
    const set = target ? setForPath(target, ctx) : null
    if (!target || !set || !wanted.has(set)) return skip(false)
    // Archives never create links (older Duet backups stored some): a link written by an
    // archive could point the next entry anywhere on disk.
    if (header.type !== 'file' && header.type !== undefined) return skip(header.type !== 'directory')
    const dest = restoreTarget(target, header.name.slice(0, header.name.indexOf('/')), ctx)
    if (!dest) {
      opts.log?.('[backup] skipped (outside its data folder)', header.name)
      return skip(true)
    }
    const tmp = `${dest}.duet-restore`
    try {
      mkdirSync(dirname(dest), { recursive: true })
    } catch (e) {
      opts.log?.('[backup] skipped', header.name, (e as Error).message)
      return skip(true)
    }
    const out = createWriteStream(tmp, { mode: header.mode ? header.mode & 0o777 : 0o644 })
    pipeline(stream, out)
      .then(() => {
        renameSync(tmp, dest)
        restored++
        finish()
      })
      .catch((e) => {
        rmSync(tmp, { force: true })
        finish(e)
      })
  })
  await pipeline(createReadStream(file), createGunzip(), extract)
  return { restored, skipped, safetyBackup }
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
