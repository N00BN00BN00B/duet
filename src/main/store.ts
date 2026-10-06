import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Settings, Thread, ThreadMeta, TimelineItem } from '@shared/types'
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, normalizeTheme, type ThemeSpec } from '@shared/theme'

const MAX_CACHED_THREADS = 8

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  defaultProvider: 'claude',
  defaultModels: {},
  defaultEfforts: {},
  defaultAccess: 'ask',
  sendWithEnter: true,
  notifications: true,
  sounds: true,
  claudePath: '',
  codexPath: '',
  projects: [],
  backupDir: join(homedir(), 'Documents', 'Duet Backups'),
  autoBackup: 'off',
  includeAuthInBackups: false,
  fontSize: 14,
  browserHome: 'http://localhost:3000',
  onboarded: false,
  darkTheme: DEFAULT_DARK_THEME,
  lightTheme: DEFAULT_LIGHT_THEME,
  customThemes: [],
  accentMode: 'agent',
  accentColor: '#d97757',
  density: 'comfortable',
  chatWidth: 'normal',
  reduceMotion: false,
  backgroundEffects: true,
  sidebarAgentNames: true,
  showTurnDetails: true,
  personality: { preset: 'default', custom: '', providers: ['claude', 'codex'] },
  chatSync: 'off',
  usageIncludeOutside: true
}

/** Writes via a temp file + rename so a crash never leaves a half-written file. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, path)
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: 'missing' | 'corrupt' | 'unreadable'; error?: string }

/** Tells a damaged file (set it aside) from one that just can't be read right now (leave it alone). */
function readJsonFile<T>(path: string): ReadResult<T> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { ok: false, reason: 'missing' } : { ok: false, reason: 'unreadable', error: code ?? (error as Error).message }
  }
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
}

/** Moves a damaged file out of the way (keeping it) and returns its new name. */
function setAside(path: string): string | null {
  const kept = `${path}.corrupt-${Date.now()}`
  try {
    renameSync(path, kept)
    return kept
  } catch {
    return null
  }
}

interface ThreadFile {
  meta: ThreadMeta
  items: TimelineItem[]
}

export class Store {
  readonly root: string
  readonly threadsDir: string
  readonly attachmentsDir: string
  private settingsPath: string
  private indexPath: string
  settings: Settings
  private metas = new Map<string, ThreadMeta>()
  private items = new Map<string, TimelineItem[]>()
  private dirty = new Set<string>()
  private indexDirty = false
  private timer: NodeJS.Timeout | null = null
  /** Threads whose file couldn't be read: never overwritten until Duet restarts and reads it. */
  private protectedIds = new Set<string>()
  /** Set while a backup of Duet's own data is restored: nothing may be written over it. */
  private frozen = false
  /** Threads whose messages are in memory, least recently used first. */
  private recent: string[] = []
  /** Threads that must stay in memory (an agent is working in them). */
  isBusy: (id: string) => boolean = () => false

  constructor(root: string) {
    this.root = root
    this.threadsDir = join(root, 'threads')
    this.attachmentsDir = join(root, 'attachments')
    this.settingsPath = join(root, 'settings.json')
    this.indexPath = join(this.threadsDir, 'index.json')
    for (const dir of [root, this.threadsDir, this.attachmentsDir]) mkdirSync(dir, { recursive: true })
    const read = readJsonFile<Partial<Settings>>(this.settingsPath)
    if (!read.ok && read.reason === 'corrupt') setAside(this.settingsPath)
    const saved = read.ok && read.value && typeof read.value === 'object' ? read.value : {}
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      defaultModels: { ...saved.defaultModels },
      defaultEfforts: { ...saved.defaultEfforts },
      personality: { ...DEFAULT_SETTINGS.personality, ...(saved.personality ?? {}) },
      // Saved themes are re-checked on load, so a hand-edited settings file can't break the UI.
      customThemes: (Array.isArray(saved.customThemes) ? saved.customThemes : []).map((t) => normalizeTheme(t)).filter((t): t is ThemeSpec => !!t)
    }
    this.loadIndex()
  }

  private loadIndex(): void {
    const index = readJson<ThreadMeta[]>(this.indexPath)
    const files = new Set(readdirSync(this.threadsDir).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5)))
    if (Array.isArray(index)) {
      for (const meta of index) {
        // Synced chats that were never opened have no file yet.
        if (meta && typeof meta.id === 'string' && (files.has(meta.id) || meta.lazy)) this.metas.set(meta.id, meta)
      }
    }
    // Recover threads missing from the index (e.g. crash between writes).
    for (const id of files) {
      if (this.metas.has(id)) continue
      const file = readJson<ThreadFile>(join(this.threadsDir, `${id}.json`))
      if (file?.meta?.id === id) {
        this.metas.set(id, file.meta)
        this.indexDirty = true
      }
    }
    // A thread can't still be running after a restart.
    for (const meta of this.metas.values()) {
      if (meta.status === 'running' || meta.status === 'approval') {
        meta.status = 'idle'
        this.indexDirty = true
      }
    }
    if (this.indexDirty) this.schedule()
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch }
    if (!this.frozen) writeFileAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2))
    return this.settings
  }

  /** Writes everything pending, then stops writing for good (Duet relaunches after a restore). */
  freeze(): void {
    this.flush()
    this.frozen = true
  }

  get isFrozen(): boolean {
    return this.frozen
  }

  listMetas(): ThreadMeta[] {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getMeta(id: string): ThreadMeta | undefined {
    return this.metas.get(id)
  }

  getItems(id: string): TimelineItem[] {
    let items = this.items.get(id)
    if (!items) {
      const path = join(this.threadsDir, `${id}.json`)
      const read = readJsonFile<ThreadFile>(path)
      const valid = read.ok && Array.isArray(read.value?.items)
      items = valid && read.ok ? read.value.items : []
      if (!valid && !(!read.ok && read.reason === 'missing')) {
        // Never answer a damaged or unreadable file with an empty thread that later overwrites it.
        let text: string
        if (!read.ok && read.reason === 'unreadable') {
          this.protectedIds.add(id)
          text = `Duet couldn’t read this thread’s saved file (${read.error}). It hasn’t been touched — restart Duet to try again. New messages here won’t be saved until then.`
        } else {
          const kept = setAside(path)
          text = kept
            ? `This thread’s saved file was damaged, so Duet set it aside as ${basename(kept)} (in ${this.threadsDir}) and started the thread fresh.`
            : `This thread’s saved file is damaged and couldn’t be moved aside. It hasn’t been touched.`
          if (!kept) this.protectedIds.add(id)
        }
        items = [{ kind: 'notice', id: `n-unreadable-${Date.now()}`, ts: Date.now(), level: 'error', text }]
      }
      // Streaming flags never survive a restart.
      for (const item of items) {
        if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) item.streaming = false
        if (item.kind === 'tool' && item.status === 'running') item.status = 'error'
        if (item.kind === 'approval' && item.status === 'pending') item.status = 'expired'
      }
      this.items.set(id, items)
    }
    this.used(id)
    return items
  }

  /** Keeps only a handful of threads' messages in memory; the rest are re-read from disk. */
  private used(id: string): void {
    const at = this.recent.indexOf(id)
    if (at >= 0) this.recent.splice(at, 1)
    this.recent.push(id)
    for (let i = 0; this.items.size > MAX_CACHED_THREADS && i < this.recent.length; ) {
      const old = this.recent[i]
      if (old === id || this.dirty.has(old) || this.isBusy(old)) {
        i++
        continue
      }
      this.items.delete(old)
      this.recent.splice(i, 1)
    }
  }

  /** Adds or replaces many metas at once (chat sync) with a single write. */
  putMetas(metas: ThreadMeta[]): void {
    for (const meta of metas) {
      this.metas.set(meta.id, meta)
      if (meta.lazy) {
        // A synced chat is re-read from its source when opened; drop any stale copy.
        this.items.delete(meta.id)
        this.dirty.delete(meta.id)
        if (!this.frozen) rmSync(join(this.threadsDir, `${meta.id}.json`), { force: true })
      }
    }
    this.indexDirty = true
    this.schedule()
  }

  getThread(id: string): Thread | null {
    const meta = this.metas.get(id)
    if (!meta) return null
    return { ...meta, items: this.getItems(id) }
  }

  putMeta(meta: ThreadMeta): void {
    this.metas.set(meta.id, meta)
    this.markDirty(meta.id)
  }

  setItems(id: string, items: TimelineItem[]): void {
    this.items.set(id, items)
    this.markDirty(id)
    this.used(id)
  }

  markDirty(id: string): void {
    this.dirty.add(id)
    this.indexDirty = true
    this.schedule()
  }

  remove(id: string): void {
    this.metas.delete(id)
    this.items.delete(id)
    this.dirty.delete(id)
    if (this.frozen) return
    rmSync(join(this.threadsDir, `${id}.json`), { force: true })
    this.indexDirty = true
    this.schedule()
  }

  private schedule(): void {
    if (this.timer || this.frozen) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 400)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.frozen) return
    for (const id of this.dirty) {
      const meta = this.metas.get(id)
      if (!meta || meta.lazy || this.protectedIds.has(id)) continue
      const items = this.items.get(id) ?? []
      try {
        writeFileAtomic(join(this.threadsDir, `${id}.json`), JSON.stringify({ meta, items } satisfies ThreadFile))
      } catch (error) {
        console.error('[store] failed to write thread', id, error)
      }
    }
    this.dirty.clear()
    if (this.indexDirty) {
      this.indexDirty = false
      try {
        writeFileAtomic(this.indexPath, JSON.stringify(this.listMetas()))
      } catch (error) {
        console.error('[store] failed to write index', error)
      }
    }
  }

  hasThreadFile(id: string): boolean {
    return existsSync(join(this.threadsDir, `${id}.json`))
  }
}
