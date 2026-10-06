import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ProviderId, UsageDay, UsageSummary } from '@shared/types'
import { emptyCache, localDay, scanAll, type UsageCache } from './usageScan'

export interface UsageRoots {
  claudeProjects: string
  codexRoots: string[]
}

const STALE_MS = 60_000

/**
 * Token usage across Claude Code and Codex, read from their own history files (so it includes
 * use outside Duet) and kept in a small cache that later scans only extend.
 */
export class UsageService {
  private cache: UsageCache = emptyCache()
  private running: Promise<void> | null = null

  constructor(
    private readonly cacheFile: string,
    private readonly roots: () => UsageRoots,
    /** Built worker script; null scans on the calling thread (tests). */
    private readonly workerFile: string | null,
    private readonly onUpdate: () => void,
    private readonly log: (...args: unknown[]) => void = () => undefined
  ) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8')) as UsageCache
      if (saved?.version === 1 && saved.files && typeof saved.files === 'object') this.cache = saved
    } catch {
      // first scan
    }
  }

  get scanning(): boolean {
    return !!this.running
  }

  /** Reads whatever was added to the histories since the last scan. */
  scan(): Promise<void> {
    if (this.running) return this.running
    const { claudeProjects, codexRoots } = this.roots()
    const job = this.workerFile && existsSync(this.workerFile) ? this.scanInWorker(this.workerFile, claudeProjects, codexRoots) : Promise.resolve(scanAll(claudeProjects, codexRoots, this.cache))
    this.running = job
      .then((next) => {
        this.cache = next
        this.save()
        this.onUpdate()
      })
      .catch((error) => this.log('[usage] scan failed', (error as Error).message))
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private scanInWorker(file: string, claudeProjects: string, codexRoots: string[]): Promise<UsageCache> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(file, { workerData: { claudeProjects, codexRoots, cache: this.cache } })
      worker.on('message', (msg: { type: string; cache?: UsageCache }) => {
        if (msg.type === 'done' && msg.cache) resolve(msg.cache)
      })
      worker.on('error', reject)
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`usage scan stopped (${code})`))
      })
    })
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      const tmp = `${this.cacheFile}.tmp`
      writeFileSync(tmp, JSON.stringify(this.cache))
      renameSync(tmp, this.cacheFile)
    } catch (error) {
      this.log('[usage] could not save cache', (error as Error).message)
    }
  }

  /**
   * Daily totals for the last `days` days. `duetSessions` holds `provider:sessionId` of chats run
   * in Duet, which are labelled 'duet'; the rest is 'outside' and left out unless asked for.
   */
  summary(days: number, duetSessions: Set<string>, includeOutside: boolean): UsageSummary {
    if (!this.running && Date.now() - this.cache.scannedAt > STALE_MS) void this.scan()
    const span = Math.max(1, Math.min(365, Math.round(days)))
    const to = localDay(Date.now())!
    const from = localDay(Date.now() - (span - 1) * 86_400_000)!
    const rows = new Map<string, UsageDay>()
    for (const file of Object.values(this.cache.files)) {
      const source: UsageDay['source'] = duetSessions.has(`${file.provider}:${file.session}`) ? 'duet' : 'outside'
      if (source === 'outside' && !includeOutside) continue
      for (const [key, b] of Object.entries(file.buckets)) {
        const cut = key.indexOf('|')
        const day = key.slice(0, cut)
        if (day < from || day > to) continue
        const model = key.slice(cut + 1)
        const id = `${day}|${file.provider}|${model}|${source}`
        let row = rows.get(id)
        if (!row) {
          row = { day, provider: file.provider as ProviderId, model, source, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 }
          rows.set(id, row)
        }
        row.inputTokens += b.inputTokens
        row.outputTokens += b.outputTokens
        row.cacheReadTokens += b.cacheReadTokens
        row.cacheWriteTokens += b.cacheWriteTokens
        row.costUsd += b.costUsd ?? 0
        row.turns += b.turns
      }
    }
    return { days: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day)), from, to, scannedAt: this.cache.scannedAt || undefined, scanning: this.scanning }
  }

  cacheBytes(): number {
    try {
      return readFileSync(this.cacheFile).length
    } catch {
      return 0
    }
  }
}
