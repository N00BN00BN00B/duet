import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'bottom' | 'top'

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  placement?: Placement
  offset?: number
  children: ReactNode
  className?: string
  width?: number | 'anchor'
  /** Keep focus where it is (e.g. composer typeahead menus). */
  noFocus?: boolean
  label?: string
}

const MARGIN = 8

function compute(anchor: DOMRect, pop: DOMRect, placement: Placement, offset: number): { top: number; left: number; flipped: boolean } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top = 0
  let left = 0
  let flipped = false
  const below = anchor.bottom + offset
  const above = anchor.top - offset - pop.height
  if (placement.startsWith('bottom')) {
    top = below
    if (top + pop.height > vh - MARGIN && above > MARGIN) {
      top = above
      flipped = true
    }
  } else if (placement.startsWith('top')) {
    top = above
    if (top < MARGIN && below + pop.height < vh - MARGIN) {
      top = below
      flipped = true
    }
  } else {
    top = anchor.top
    left = anchor.right + offset
  }
  if (!placement.startsWith('right')) {
    if (placement.endsWith('end')) left = anchor.right - pop.width
    else if (placement === 'bottom' || placement === 'top') left = anchor.left + anchor.width / 2 - pop.width / 2
    else left = anchor.left
  }
  left = Math.min(Math.max(MARGIN, left), vw - pop.width - MARGIN)
  top = Math.min(Math.max(MARGIN, top), vh - pop.height - MARGIN)
  return { top, left, flipped }
}

export function Popover({ anchor, open, onClose, placement = 'bottom-start', offset = 6, children, className = '', width, noFocus, label }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; flipped: boolean } | null>(null)

  const place = useCallback(() => {
    const a = anchor.current
    const p = ref.current
    if (!a || !p) return
    setPos(compute(a.getBoundingClientRect(), p.getBoundingClientRect(), placement, offset))
  }, [anchor, placement, offset])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const p = ref.current
    if (!p) return
    const ro = new ResizeObserver(() => place())
    ro.observe(p)
    window.addEventListener('resize', place)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, place, onClose, anchor, noFocus])

  useEffect(() => {
    if (!open || noFocus) return
    const frame = requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]), input, button')
      first?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, noFocus])

  if (!open) return null
  const style: CSSProperties = {
    position: 'fixed',
    top: pos?.top ?? -9999,
    left: pos?.left ?? -9999,
    zIndex: 60,
    width: width === 'anchor' ? anchor.current?.getBoundingClientRect().width : width,
    visibility: pos ? 'visible' : 'hidden',
    transformOrigin: pos?.flipped || placement.startsWith('top') ? 'bottom center' : 'top center'
  }
  return createPortal(
    <div ref={ref} style={style} className={`anim-pop rounded-xl border border-line-strong bg-surface text-fg shadow-[var(--pop-shadow)] ${className}`} role="dialog" aria-label={label}>
      {children}
    </div>,
    document.body
  )
}

/** Roving focus for a list of `[role=menuitem]` children. */
export function useMenuKeys(): (e: React.KeyboardEvent<HTMLElement>) => void {
  return (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'))
    if (!items.length) return
    e.preventDefault()
    const idx = items.indexOf(document.activeElement as HTMLElement)
    let next = 0
    if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % items.length
    else if (e.key === 'ArrowUp') next = idx <= 0 ? items.length - 1 : idx - 1
    else if (e.key === 'End') next = items.length - 1
    items[next].focus()
  }
}

export function MenuItem({
  children,
  onSelect,
  icon,
  hint,
  active,
  danger,
  disabled,
  description
}: {
  children: ReactNode
  onSelect: () => void
  icon?: ReactNode
  hint?: ReactNode
  active?: boolean
  danger?: boolean
  disabled?: boolean
  description?: ReactNode
}) {
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      aria-checked={active || undefined}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
          e.preventDefault()
          onSelect()
        }
      }}
      className={`group flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] outline-none ${disabled ? 'opacity-40' : 'hover:bg-hover focus:bg-hover'} ${danger ? 'text-bad' : 'text-fg'}`}
    >
      {icon !== undefined && <span className={`mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center ${danger ? 'text-bad' : active ? 'text-accent' : 'text-fg-2'}`}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {description && <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-3">{description}</span>}
      </span>
      {hint !== undefined && <span className="mt-[1px] shrink-0 text-[11.5px] text-fg-3">{hint}</span>}
    </div>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-fg-3">{children}</div>
}

export function MenuSeparator() {
  return <div className="mx-1 my-1 h-px bg-line" />
}
