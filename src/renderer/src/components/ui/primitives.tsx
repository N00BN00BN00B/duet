import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconX } from '../icons'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent'
type Size = 'xs' | 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-fg text-bg hover:opacity-90',
  accent: 'bg-accent text-white hover:brightness-110',
  secondary: 'bg-surface-2 text-fg border border-line hover:bg-surface-3 hover:border-line-strong',
  ghost: 'text-fg-2 hover:text-fg hover:bg-hover',
  danger: 'bg-bad/12 text-bad border border-bad/25 hover:bg-bad/20'
}
const SIZES: Record<Size, string> = {
  xs: 'h-6 px-2 text-[12px] gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-lg',
  md: 'h-8 px-3.5 text-[13px] gap-2 rounded-lg'
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode }>(
  function Button({ variant = 'secondary', size = 'md', icon, className = '', children, type = 'button', ...rest }, ref) {
    return (
      <button ref={ref} type={type} className={`press inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-45 ${VARIANTS[variant]} ${SIZES[size]} ${className}`} {...rest}>
        {icon}
        {children}
      </button>
    )
  }
)

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; active?: boolean; size?: 'sm' | 'md' }>(
  function IconButton({ label, shortcut, active, size = 'md', className = '', children, type = 'button', ...rest }, ref) {
    const inner = useRef<HTMLButtonElement | null>(null)
    return (
      <Tooltip label={label} shortcut={shortcut} anchorRef={inner}>
        <button
          ref={(node) => {
            inner.current = node
            if (typeof ref === 'function') ref(node)
            else if (ref) ref.current = node
          }}
          type={type}
          aria-label={label}
          aria-pressed={active}
          className={`press inline-flex shrink-0 items-center justify-center rounded-lg disabled:opacity-40 ${size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'} ${active ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'} ${className}`}
          {...rest}
        >
          {children}
        </button>
      </Tooltip>
    )
  }
)

export function Tooltip({ label, shortcut, children, anchorRef, side = 'bottom' }: { label: ReactNode; shortcut?: string; children: React.ReactElement; anchorRef?: React.RefObject<HTMLElement | null>; side?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapper = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const target = (anchorRef?.current ?? wrapper.current?.firstElementChild) as HTMLElement | null
    const b = bubble.current
    if (!target || !b) return
    const r = target.getBoundingClientRect()
    const br = b.getBoundingClientRect()
    let top = side === 'top' ? r.top - br.height - 6 : r.bottom + 6
    if (top + br.height > window.innerHeight - 6) top = r.top - br.height - 6
    if (top < 6) top = r.bottom + 6
    const left = Math.min(Math.max(6, r.left + r.width / 2 - br.width / 2), window.innerWidth - br.width - 6)
    setPos({ top, left })
  }, [open, anchorRef, side])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const show = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), 420)
  }
  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setOpen(false)
  }
  return (
    <span ref={wrapper} className="contents" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide} onFocus={(e) => e.target.matches(':focus-visible') && show()} onBlur={hide}>
      {children}
      {open &&
        createPortal(
          <div
            ref={bubble}
            role="tooltip"
            style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, zIndex: 80, visibility: pos ? 'visible' : 'hidden' }}
            className="anim-fade pointer-events-none flex items-center gap-2 rounded-md border border-line-strong bg-surface-3 px-2 py-1 text-[11.5px] text-fg shadow-lg"
          >
            {label}
            {shortcut && <span className="text-fg-3">{shortcut}</span>}
          </div>,
          document.body
        )}
    </span>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`press relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full border transition-colors disabled:opacity-40 ${checked ? 'border-transparent bg-accent' : 'border-line-strong bg-surface-3'}`}
    >
      <span className={`absolute left-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform duration-200 ease-[var(--ease-out)] ${checked ? 'translate-x-[14px]' : ''}`} />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: { value: T; label: ReactNode; icon?: ReactNode }[]; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div role="radiogroup" className={`relative grid rounded-lg border border-line bg-surface-2 p-[2px] ${size === 'sm' ? 'text-[12px]' : 'text-[12.5px]'}`} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <span
        className="absolute bottom-[2px] top-[2px] rounded-md bg-surface shadow-sm ring-1 ring-line-strong transition-transform duration-300 ease-[var(--ease-out)]"
        style={{ left: 2, width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${idx * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`relative z-[1] flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 ${size === 'sm' ? 'h-6' : 'h-7'} font-medium transition-colors ${o.value === value ? 'text-fg' : 'text-fg-3 hover:text-fg-2'}`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Dialog({ open, onClose, title, children, footer, width = 520, description }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; description?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, button')?.focus())
    return () => {
      document.removeEventListener('keydown', onKey, true)
      prev?.focus?.()
    }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="anim-fade fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" style={{ width }} className="anim-pop flex max-h-[85vh] max-w-full flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[var(--pop-shadow)]">
        <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
            {description && <p className="mt-1 text-[12.5px] leading-relaxed text-fg-2">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} size="sm">
            <IconX size={14} />
          </IconButton>
        </div>
        <div className="scroll-y min-h-0 flex-1 px-5 py-3">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Meter({ value, tone }: { value: number; tone?: 'auto' | 'accent' }) {
  const v = Math.max(0, Math.min(100, value))
  const color = tone === 'accent' ? 'bg-accent' : v >= 90 ? 'bg-bad' : v >= 70 ? 'bg-warn' : 'bg-fg-2'
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-surface-3">
      <div className={`h-full rounded-full ${color} transition-[width] duration-500 ease-[var(--ease-out)]`} style={{ width: `${v}%` }} />
    </div>
  )
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] leading-snug text-fg-3">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-[color-mix(in_srgb,var(--accent)_60%,transparent)] focus:bg-surface'

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="anim-rise flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface-2 text-fg-2">{icon}</div>}
      <div className="text-[14px] font-medium">{title}</div>
      {children && <div className="mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-fg-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Chip({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent'; title?: string }) {
  const tones = {
    neutral: 'bg-surface-3 text-fg-2 border-line',
    ok: 'bg-ok/10 text-ok border-ok/20',
    warn: 'bg-warn/10 text-warn border-warn/25',
    bad: 'bg-bad/10 text-bad border-bad/25',
    info: 'bg-info/10 text-info border-info/25',
    accent: 'bg-accent/12 text-accent border-accent/25'
  }
  return (
    <span title={title} className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  )
}

/** A range slider in the app's style. */
export function Slider({ value, min, max, step = 0.05, onChange, label, format }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; format?: (v: number) => string }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <label className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-[12px] text-fg-2">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="duet-range h-5 flex-1"
        style={{ '--fill': `${pct}%` } as React.CSSProperties}
      />
      <span className="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-fg-3">{format ? format(value) : value.toFixed(2)}</span>
    </label>
  )
}

/** A colour well with its hex value. */
export function ColorField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="group/color flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-2 py-1 pl-1 pr-2 hover:border-line-strong">
      <span className="relative h-6 w-6 shrink-0 overflow-hidden rounded-md ring-1 ring-line-strong" style={{ background: value }}>
        <input type="color" value={value.slice(0, 7)} aria-label={label} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] text-fg-3">{label}</span>
        <span className="block font-mono text-[11.5px] text-fg-2">{value.slice(0, 7)}</span>
      </span>
    </label>
  )
}
