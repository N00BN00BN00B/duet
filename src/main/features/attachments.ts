import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Attachment } from '@shared/types'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv'
}

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

const EXT_FOR_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/tiff': '.tiff',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'text/plain': '.txt'
}

function safeName(name: string): string {
  const clean = basename(name).replace(/[^\w.\- ()]+/g, '_').slice(0, 80)
  return clean || 'file'
}

const MAX_BYTES = 50 * 1024 * 1024

export function attachmentFromBytes(dir: string, name: string, mime: string, bytes: Uint8Array): Attachment {
  if (bytes.byteLength > MAX_BYTES) throw new Error('That file is larger than 50 MB.')
  mkdirSync(dir, { recursive: true })
  let fileName = safeName(name)
  if (!extname(fileName) && EXT_FOR_MIME[mime]) fileName += EXT_FOR_MIME[mime]
  const id = randomUUID()
  const path = join(dir, `${id.slice(0, 8)}-${fileName}`)
  writeFileSync(path, bytes)
  return { id, name: fileName, mime: mime || mimeFor(fileName), path, size: bytes.byteLength }
}

export function attachmentFromPath(dir: string, source: string): Attachment {
  const st = statSync(source)
  if (!st.isFile()) throw new Error('Only files can be attached.')
  const mime = mimeFor(source)
  const id = randomUUID()
  // Big non-image files are referenced in place instead of copied.
  if (!mime.startsWith('image/') && st.size > 20 * 1024 * 1024) {
    return { id, name: basename(source), mime, path: source, size: st.size }
  }
  if (st.size > MAX_BYTES) throw new Error('That file is larger than 50 MB.')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id.slice(0, 8)}-${safeName(basename(source))}`)
  copyFileSync(source, path)
  return { id, name: basename(source), mime, path, size: st.size }
}

export function readBytes(path: string): Buffer {
  return readFileSync(path)
}
