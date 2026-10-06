import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings, Thread, ThreadMeta, TimelineItem } from '@shared/types'

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
  onboarded: false
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

  constructor(root: string) {
    this.root = root
    this.threadsDir = join(root, 'threads')
    this.attachmentsDir = join(root, 'attachments')
    this.settingsPath = join(root, 'settings.json')
    this.indexPath = join(this.threadsDir, 'index.json')
    for (const dir of [root, this.threadsDir, this.attachmentsDir]) mkdirSync(dir, { recursive: true })
    const saved = readJson<Partial<Settings>>(this.settingsPath) ?? {}
    this.settings = { ...DEFAULT_SETTINGS, ...saved, defaultModels: { ...saved.defaultModels }, defaultEfforts: { ...saved.defaultEfforts } }
    this.loadIndex()
  }

  private loadIndex(): void {
    const index = readJson<ThreadMeta[]>(this.indexPath)
    const files = new Set(readdirSync(this.threadsDir).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5)))
    if (Array.isArray(index)) {
      for (const meta of index) {
        if (meta && typeof meta.id === 'string' && files.has(meta.id)) this.metas.set(meta.id, meta)
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
    writeFileAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2))
    return this.settings
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
      const file = readJson<ThreadFile>(join(this.threadsDir, `${id}.json`))
      items = Array.isArray(file?.items) ? file.items : []
      // Streaming flags never survive a restart.
      for (const item of items) {
        if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) item.streaming = false
        if (item.kind === 'tool' && item.status === 'running') item.status = 'error'
        if (item.kind === 'approval' && item.status === 'pending') item.status = 'expired'
      }
      this.items.set(id, items)
    }
    return items
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
    rmSync(join(this.threadsDir, `${id}.json`), { force: true })
    this.indexDirty = true
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
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
    for (const id of this.dirty) {
      const meta = this.metas.get(id)
      if (!meta) continue
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
