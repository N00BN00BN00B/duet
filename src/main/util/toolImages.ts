import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}
const MAX_BYTES = 25 * 1024 * 1024

/**
 * Saves a picture a tool returned (base64) into `dir`, named after its content, so the same
 * screenshot seen twice (live, then again on a History import) is stored once. Returns its path,
 * or null for anything that isn't a supported image.
 */
export function saveToolImage(dir: string, base64: string, mediaType: string): string | null {
  const ext = EXTENSIONS[String(mediaType).toLowerCase()]
  if (!ext || typeof base64 !== 'string' || !base64) return null
  try {
    const bytes = Buffer.from(base64, 'base64')
    if (!bytes.length || bytes.length > MAX_BYTES) return null
    const path = join(dir, `tool-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`)
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, bytes)
    }
    return path
  } catch {
    return null
  }
}

/** Splits a `data:image/png;base64,…` URL into its parts. */
export function parseImageDataUrl(url: string): { data: string; mediaType: string } | null {
  const match = /^data:(image\/[\w.+-]+);base64,(.+)$/i.exec(String(url))
  return match ? { mediaType: match[1].toLowerCase(), data: match[2] } : null
}
