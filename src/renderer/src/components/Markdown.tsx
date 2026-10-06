import { isValidElement, memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { duet } from '@/lib/api'
import { highlight, normalizeLang } from '@/lib/highlight'
import { IconCheck, IconCopy } from './icons'

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
      className={`press inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-fg-3 hover:bg-hover hover:text-fg ${className}`}
    >
      {done ? <IconCheck size={13} className="text-ok" /> : <IconCopy size={13} />}
      <span>{done ? 'Copied' : label}</span>
    </button>
  )
}

export const CodeBlock = memo(function CodeBlock({ code, lang, live }: { code: string; lang?: string; live?: boolean }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    if (live) return
    let cancelled = false
    highlight(code, lang)
      .then((h) => !cancelled && setHtml(h))
      .catch(() => !cancelled && setHtml(null))
    return () => {
      cancelled = true
    }
  }, [code, lang, live])
  const label = normalizeLang(lang) ?? lang ?? ''
  return (
    <div className="code-block group/code">
      <div className="flex h-8 items-center justify-between border-b border-line px-3 text-[11px] text-fg-3">
        <span className="font-mono">{label || 'text'}</span>
        <CopyButton text={code} className="opacity-70 group-hover/code:opacity-100" />
      </div>
      {html && !live ? (
        <div className="selectable" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
})

function resolveSrc(src: string | undefined): string | undefined {
  if (!src) return src
  if (src.startsWith('/') && !src.startsWith('//')) return duet.util.fileUrl(src)
  if (src.startsWith('file://')) return duet.util.fileUrl(decodeURI(src.slice(7)))
  return src
}

function makeComponents(live: boolean): Components {
  return {
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children
      if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        const match = /language-([\w+#.-]+)/.exec(child.props.className ?? '')
        const code = textOf(child.props.children).replace(/\n$/, '')
        return <CodeBlock code={code} lang={match?.[1]} live={live} />
      }
      return <pre>{children}</pre>
    },
    a({ href, children }) {
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault()
            if (href && /^(https?:|mailto:)/i.test(href)) void duet.app.openExternal(href)
          }}
          title={href}
        >
          {children}
        </a>
      )
    },
    img({ src, alt }) {
      return <img src={resolveSrc(typeof src === 'string' ? src : undefined)} alt={alt ?? ''} loading="lazy" />
    }
  }
}

const staticComponents = makeComponents(false)
const liveComponents = makeComponents(true)

export const Markdown = memo(function Markdown({ text, streaming = false, className = '' }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={streaming ? liveComponents : staticComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
