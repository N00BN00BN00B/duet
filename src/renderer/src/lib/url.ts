/** Turns what someone types in the browser bar into a URL. */
export function normalizeUrl(input: string): string {
  const raw = input.trim()
  if (!raw) return ''
  if (/^\d{2,5}$/.test(raw)) return `http://localhost:${raw}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0):\d/i.test(raw)) return raw
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(raw)) return `http://${raw}`
  if (/^[^\s/]+\.[^\s]{2,}/.test(raw) && !raw.includes(' ')) return `https://${raw}`
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}
