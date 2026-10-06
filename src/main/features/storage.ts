import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageStats } from '@shared/types'

export interface StorageContext {
  threadsDir: string
  attachmentsDir: string
  /** Copies Sync makes before overwriting something. */
  safetyDir: string
  logsDir: string
  cacheDir: string
}

/** Files a cleanup must keep even if no chat mentions them yet (drafts, queued messages). */
const RECENT_MS = 24 * 3600_000
const SAFETY_KEEP_MS = 30 * 24 * 3600_000

function dirSize(path: string): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) walk(full)
        else if (st.isFile()) {
          count++
          bytes += st.size
        }
      } catch {
        // vanished
      }
    }
  }
  if (existsSync(path)) walk(path)
  return { count, bytes }
}

/** Every attachment path any saved chat refers to (read straight from the thread files). */
export async function referencedAttachments(ctx: StorageContext): Promise<Set<string>> {
  const used = new Set<string>()
  if (!existsSync(ctx.threadsDir)) return used
  const prefix = ctx.attachmentsDir
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escaped}/[^"\\\\]+`, 'g')
  for (const name of readdirSync(ctx.threadsDir)) {
    if (!name.endsWith('.json') || name === 'index.json') continue
    try {
      const text = await readFile(join(ctx.threadsDir, name), 'utf8')
      for (const match of text.matchAll(pattern)) used.add(match[0])
    } catch {
      // unreadable thread files are left alone
    }
  }
  return used
}

/** Attachments that no chat, draft or queued message uses and that are older than a day. */
export async function unusedAttachments(ctx: StorageContext, keep: Iterable<string>): Promise<{ path: string; bytes: number }[]> {
  if (!existsSync(ctx.attachmentsDir)) return []
  const used = await referencedAttachments(ctx)
  for (const p of keep) used.add(p)
  const now = Date.now()
  const out: { path: string; bytes: number }[] = []
  for (const name of readdirSync(ctx.attachmentsDir)) {
    const full = join(ctx.attachmentsDir, name)
    if (used.has(full)) continue
    try {
      const st = statSync(full)
      if (st.isFile() && now - st.mtimeMs > RECENT_MS) out.push({ path: full, bytes: st.size })
    } catch {
      // vanished
    }
  }
  return out
}

/** Safety copies older than 30 days (each Sync run makes one folder). */
export function oldSafetyCopies(ctx: StorageContext): { path: string; bytes: number }[] {
  if (!existsSync(ctx.safetyDir)) return []
  const now = Date.now()
  const out: { path: string; bytes: number }[] = []
  for (const name of readdirSync(ctx.safetyDir)) {
    const full = join(ctx.safetyDir, name)
    try {
      const st = statSync(full)
      if (now - st.mtimeMs > SAFETY_KEEP_MS) out.push({ path: full, bytes: dirSize(full).bytes })
    } catch {
      // vanished
    }
  }
  return out
}

export async function storageStats(ctx: StorageContext, keep: Iterable<string>): Promise<StorageStats> {
  const threadFiles = dirSize(ctx.threadsDir)
  const attachments = dirSize(ctx.attachmentsDir)
  const unused = await unusedAttachments(ctx, keep)
  const safety = dirSize(ctx.safetyDir)
  const caches = dirSize(ctx.cacheDir)
  const logs = dirSize(ctx.logsDir)
  const stats: StorageStats = {
    threads: { count: Math.max(0, threadFiles.count - (existsSync(join(ctx.threadsDir, 'index.json')) ? 1 : 0)), bytes: threadFiles.bytes },
    attachments,
    unused: { count: unused.length, bytes: unused.reduce((n, f) => n + f.bytes, 0) },
    safetyCopies: safety,
    caches: { bytes: caches.bytes },
    logs: { bytes: logs.bytes },
    total: threadFiles.bytes + attachments.bytes + safety.bytes + caches.bytes + logs.bytes
  }
  return stats
}
