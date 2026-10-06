import { useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { duet } from '@/lib/api'
import { normalizeUrl } from '@/lib/url'
import { draftKey, setDraft, toast, toastError, useApp } from '@/state/store'
import { IconArrowLeft, IconArrowRight, IconCamera, IconCode, IconCrosshair, IconExternal, IconGlobe, IconLock, IconRefresh, IconX } from '../icons'
import { IconButton } from '../ui/primitives'

type WebviewEl = HTMLElement & {
  src: string
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  getWebContentsId(): number
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>
}

const PICKER_SCRIPT = `(() => new Promise((resolve) => {
  if (window.__duetPick) { resolve(null); return; }
  window.__duetPick = true;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent;';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #7c8cff;background:rgba(124,140,255,.14);border-radius:4px;transition:all 60ms ease-out;left:0;top:0;width:0;height:0;';
  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;font:500 11px -apple-system,system-ui,sans-serif;background:#18181b;color:#fff;padding:3px 7px;border-radius:5px;box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap;';
  document.documentElement.append(host, box, tag);
  let current = null;
  const at = (x, y) => { host.style.pointerEvents = 'none'; const el = document.elementFromPoint(x, y); host.style.pointerEvents = 'auto'; return el; };
  const label = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2); if (cls.length) s += '.' + cls.join('.'); return s; };
  const selector = (el) => { const parts = []; let node = el; while (node && node.nodeType === 1 && parts.length < 5) { let s = node.tagName.toLowerCase(); if (node.id) { parts.unshift(s + '#' + node.id); break; } const cls = (node.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2); if (cls.length) s += '.' + cls.join('.'); const parent = node.parentElement; if (parent) { const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'; } parts.unshift(s); node = parent; } return parts.join(' > '); };
  const move = (e) => { const el = at(e.clientX, e.clientY); if (!el || el === current) return; current = el; const r = el.getBoundingClientRect(); Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); tag.textContent = label(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height); tag.style.left = Math.max(4, r.left) + 'px'; tag.style.top = (r.top > 26 ? r.top - 24 : r.bottom + 4) + 'px'; };
  const finish = (result) => { host.remove(); box.remove(); tag.remove(); window.removeEventListener('keydown', key, true); window.__duetPick = false; resolve(result); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };
  host.addEventListener('mousemove', move);
  window.addEventListener('keydown', key, true);
  host.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = at(e.clientX, e.clientY);
    if (!el) { finish(null); return; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const pad = 6;
    finish({
      url: location.href,
      title: document.title,
      selector: selector(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 280),
      html: el.outerHTML.replace(/\\s+/g, ' ').slice(0, 1600),
      size: Math.round(r.width) + '×' + Math.round(r.height),
      styles: { color: cs.color, background: cs.backgroundColor, font: cs.fontSize + ' ' + cs.fontWeight + ' ' + cs.fontFamily.split(',')[0], padding: cs.padding, margin: cs.margin, radius: cs.borderRadius, display: cs.display },
      rect: { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), width: Math.min(innerWidth, r.width + pad * 2), height: Math.min(innerHeight, r.height + pad * 2) }
    });
  });
}))()`

interface PickResult {
  url: string
  title: string
  selector: string
  tag: string
  text: string
  html: string
  size: string
  styles: Record<string, string>
  rect: { x: number; y: number; width: number; height: number }
}

function attachToDraft(att: Attachment, text?: string) {
  const key = draftKey()
  const current = useApp.getState().drafts[key] ?? { text: '', attachments: [] }
  setDraft(key, { text: text ? (current.text ? `${current.text}\n\n${text}` : text) : current.text, attachments: [...current.attachments, att] })
}

export function BrowserPanel() {
  const url = useApp((s) => s.browserUrl)
  const nonce = useApp((s) => s.browserNonce)
  const home = useApp((s) => s.settings?.browserHome ?? '')
  const ref = useRef<WebviewEl | null>(null)
  const [address, setAddress] = useState(url)
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  // `committed` is the page being shown; `address` is just the text in the URL bar.
  const [committed, setCommitted] = useState(() => (url ? normalizeUrl(url) : ''))
  const [initialSrc, setInitialSrc] = useState(committed)
  const mounted = committed !== ''

  const sync = useCallback(() => {
    const wv = ref.current
    if (!wv) return
    try {
      setNav({ back: wv.canGoBack(), forward: wv.canGoForward() })
      const current = wv.getURL()
      if (current && current !== 'about:blank') {
        setAddress(current)
        useApp.setState({ browserUrl: current })
      }
    } catch {
      // webview not ready
    }
  }, [])

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const onStart = () => {
      setLoading(true)
      setError(null)
    }
    const onStop = () => {
      setLoading(false)
      sync()
    }
    const onFail = (e: Event) => {
      const ev = e as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
      if (!ev.isMainFrame || ev.errorCode === -3) return
      setError(`${ev.errorDescription || 'Failed to load'} — ${ev.validatedURL}`)
      setLoading(false)
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', sync)
    wv.addEventListener('did-navigate-in-page', sync)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', sync)
      wv.removeEventListener('did-navigate-in-page', sync)
      wv.removeEventListener('did-fail-load', onFail)
    }
  }, [sync, mounted])

  const go = useCallback((target: string) => {
    const next = normalizeUrl(target)
    if (!next) return
    setAddress(next)
    setError(null)
    useApp.setState({ browserUrl: next })
    const wv = ref.current
    if (wv) wv.loadURL(next).catch(() => undefined)
    else setInitialSrc(next)
    setCommitted(next)
  }, [])

  // External "open this URL" requests (links from agents, popups).
  const lastNonce = useRef(nonce)
  useEffect(() => {
    if (nonce !== lastNonce.current) {
      lastNonce.current = nonce
      if (url) go(url)
    }
  }, [nonce, url, go])

  const capture = async (rect?: PickResult['rect']) => {
    const wv = ref.current
    if (!wv) return null
    return duet.browser.capture(wv.getWebContentsId(), rect)
  }

  const screenshot = async () => {
    try {
      const att = await capture()
      if (att) {
        attachToDraft(att)
        toast('Screenshot attached to your message', 'success')
      }
    } catch (e) {
      toastError(e)
    }
  }

  const pick = async () => {
    const wv = ref.current
    if (!wv || picking) return
    setPicking(true)
    try {
      const result = await wv.executeJavaScript<PickResult | null>(PICKER_SCRIPT, true)
      if (!result) return
      const att = await capture(result.rect)
      const context = [
        `Selected element on ${result.url}`,
        '```html',
        result.html,
        '```',
        `Selector: \`${result.selector}\` · ${result.size}${result.text ? ` · text: “${result.text.slice(0, 140)}”` : ''}`,
        `Styles: ${Object.entries(result.styles)
          .map(([k, v]) => `${k} ${v}`)
          .join('; ')}`
      ].join('\n')
      if (att) attachToDraft(att, context)
      toast('Element added to your message', 'success')
    } catch (e) {
      toastError(e)
    } finally {
      setPicking(false)
    }
  }

  const secure = address.startsWith('https://')
  return (
    <div className="flex h-full min-w-0 flex-col bg-bg" data-testid="browser-panel">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton label="Back" disabled={!nav.back} onClick={() => ref.current?.goBack()}>
          <IconArrowLeft size={15} />
        </IconButton>
        <IconButton label="Forward" disabled={!nav.forward} onClick={() => ref.current?.goForward()}>
          <IconArrowRight size={15} />
        </IconButton>
        <IconButton label={loading ? 'Stop' : 'Reload'} disabled={!mounted} onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}>
          {loading ? <IconX size={15} /> : <IconRefresh size={15} />}
        </IconButton>
        <form
          className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 focus-within:border-line-strong"
          onSubmit={(e) => {
            e.preventDefault()
            go(address)
          }}
        >
          {secure ? <IconLock size={12} className="shrink-0 text-fg-3" /> : <IconGlobe size={12} className="shrink-0 text-fg-3" />}
          <input value={address} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => e.target.select()} placeholder="localhost:3000 or any URL" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-3" data-testid="browser-url" />
          {loading && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent breathe" />}
        </form>
        <IconButton label="Pick an element for the agent" active={picking} disabled={!mounted} onClick={() => void pick()} data-testid="browser-pick">
          <IconCrosshair size={15} />
        </IconButton>
        <IconButton label="Attach screenshot" disabled={!mounted} onClick={() => void screenshot()} data-testid="browser-screenshot">
          <IconCamera size={15} />
        </IconButton>
        <IconButton label="Developer tools" disabled={!mounted} onClick={() => ref.current && void duet.browser.devtools(ref.current.getWebContentsId())}>
          <IconCode size={15} />
        </IconButton>
        <IconButton label="Open in your browser" disabled={!address} onClick={() => void duet.app.openExternal(normalizeUrl(address))}>
          <IconExternal size={15} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {mounted ? <webview ref={ref as never} src={initialSrc} partition="persist:duet-browser" allowpopups={'true' as never} style={{ width: '100%', height: '100%' }} /> : null}
        {!mounted && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-line bg-surface-2 text-fg-2">
              <IconGlobe size={20} />
            </div>
            <div>
              <div className="text-[14px] font-medium">Preview your app</div>
              <div className="mt-1 text-[12.5px] text-fg-2">A real Chromium browser. Pick elements or grab screenshots and they land in your message.</div>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {['3000', '5173', '8080', '4321', '8000'].map((p) => (
                <button key={p} type="button" onClick={() => go(p)} className="press rounded-lg border border-line bg-surface-2 px-2.5 py-1 font-mono text-[12px] text-fg-2 hover:text-fg">
                  localhost:{p}
                </button>
              ))}
              {home && !/localhost:(3000|5173|8080|4321|8000)$/.test(home) && (
                <button type="button" onClick={() => go(home)} className="press rounded-lg border border-line bg-surface-2 px-2.5 py-1 font-mono text-[12px] text-fg-2 hover:text-fg">
                  {home.replace(/^https?:\/\//, '')}
                </button>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-x-0 top-0 flex items-center gap-2 border-b border-warn/30 bg-[color-mix(in_srgb,var(--warn)_12%,var(--bg))] px-3 py-2 text-[12px] text-fg">
            <span className="min-w-0 flex-1 truncate">{error}</span>
            <button type="button" onClick={() => ref.current?.reload()} className="press rounded-md px-2 py-0.5 text-[12px] text-accent hover:bg-hover">
              Retry
            </button>
          </div>
        )}
        {picking && <div className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-max rounded-full bg-surface-3 px-3 py-1 text-[11.5px] text-fg shadow-lg">Click an element · Esc to cancel</div>}
      </div>
    </div>
  )
}
