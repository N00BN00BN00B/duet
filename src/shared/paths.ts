/** Shows a path relative to the project (or ~) for compact UI labels. */
export function displayPath(path: string, cwd?: string, home?: string): string {
  if (!path) return ''
  const norm = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
  const p = norm(path)
  if (cwd) {
    const c = norm(cwd)
    if (p === c) return '.'
    if (p.startsWith(c + '/')) return p.slice(c.length + 1)
  }
  if (home) {
    const h = norm(home)
    if (p === h) return '~'
    if (p.startsWith(h + '/')) return '~/' + p.slice(h.length + 1)
  }
  return p
}

export function basename(path: string): string {
  const p = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  return line.trim()
}
