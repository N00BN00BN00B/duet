import { timingSafeEqual } from 'node:crypto'
import type { ProviderId } from '@shared/types'

export type DeepLink =
  | { kind: 'open'; cwd?: string; prompt?: string; provider?: ProviderId; model?: string; send: boolean }
  | { kind: 'thread'; id: string }
  | { kind: 'view'; view: 'settings' | 'usage' | 'customize' | 'history' }

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/**
 * Reads a duet:// link (from the `duet` command or anywhere else). A prompt is only sent
 * straight away when the link carries the secret token from the user's own Duet folder; links
 * from web pages can't know it, so their prompts land in the message box for review instead.
 */
export function parseDeepLink(raw: string, token: string): DeepLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'duet:') return null
  const action = (url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0]).toLowerCase()
  const q = url.searchParams
  switch (action) {
    case 'open':
    case 'new': {
      const provider = q.get('provider')
      const model = q.get('model') ?? ''
      const prompt = (q.get('prompt') ?? '').slice(0, 20_000).trim()
      const cwd = (q.get('cwd') ?? '').trim()
      return {
        kind: 'open',
        cwd: cwd.startsWith('/') ? cwd : undefined,
        prompt: prompt || undefined,
        provider: provider === 'claude' || provider === 'codex' ? provider : undefined,
        model: /^[\w.:/-]{1,80}$/.test(model) ? model : undefined,
        send: !!prompt && q.get('send') === '1' && sameToken(q.get('token') ?? '', token)
      }
    }
    case 'thread': {
      const id = q.get('id') ?? url.pathname.replace(/^\/+/, '')
      return /^[\w-]{1,64}$/.test(id) ? { kind: 'thread', id } : null
    }
    case 'settings':
    case 'usage':
    case 'customize':
    case 'history':
      return { kind: 'view', view: action }
    default:
      return null
  }
}
