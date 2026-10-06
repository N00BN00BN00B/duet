import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 1024 * 1024
let file: string | null = null

/** Appends to `<userData>/logs/duet.log` (rotated at 1 MB) and mirrors to stderr. */
export function initLogger(userData: string): void {
  const dir = join(userData, 'logs')
  mkdirSync(dir, { recursive: true })
  file = join(dir, 'duet.log')
}

export function logLine(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  const text = parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`
  if (level === 'error') process.stderr.write(line)
  if (!file) return
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
    appendFileSync(file, line)
  } catch {
    // Logging must never throw.
  }
}
