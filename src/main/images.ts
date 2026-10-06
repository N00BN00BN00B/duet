import { readFileSync } from 'node:fs'
import { nativeImage } from 'electron'

const API_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_BYTES = 3.6 * 1024 * 1024
const MAX_EDGE = 2000

/**
 * Produces base64 image data the Claude API accepts: one of png/jpeg/gif/webp,
 * under ~3.6 MB and at most 2000px on the long edge.
 */
export function prepareImage(path: string, mime: string): { data: string; mediaType: string } | null {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return null
  }
  const passthrough = API_TYPES.has(mime) && bytes.length <= MAX_BYTES
  let image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) image = nativeImage.createFromPath(path)
  if (image.isEmpty()) {
    // nativeImage can't decode GIF/WebP; send them untouched if the API accepts them.
    return passthrough ? { data: bytes.toString('base64'), mediaType: mime } : null
  }
  const { width, height } = image.getSize()
  const tooBig = Math.max(width, height) > MAX_EDGE
  if (passthrough && !tooBig) return { data: bytes.toString('base64'), mediaType: mime }
  if (tooBig) {
    const scale = MAX_EDGE / Math.max(width, height)
    image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
  }
  let out = mime === 'image/jpeg' ? image.toJPEG(88) : image.toPNG()
  let mediaType = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  if (out.length > MAX_BYTES) {
    out = image.toJPEG(82)
    mediaType = 'image/jpeg'
  }
  if (out.length > MAX_BYTES) return null
  return { data: out.toString('base64'), mediaType }
}
