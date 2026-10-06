import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

export interface SliderStop {
  id: string
  label: string
  /** Short name shown under the stop when `showLabels` is on. */
  short?: string
}

interface StepSliderProps {
  stops: SliderStop[]
  /** The chosen stop, or null when none is (drawn as a hollow knob at `rest`). */
  value: number | null
  /** Where the hollow knob sits while `value` is null. */
  rest?: number
  /** Marked "Recommended" under the track. */
  recommended?: number
  onCommit: (index: number) => void
  /** The stop under the pointer while hovering or dragging; null when it leaves. */
  onPreview?: (index: number | null) => void
  label: string
  valueText?: string
  describedBy?: string
  /** A pinned model with no known position on this ladder. */
  unplaced?: boolean
  minLabel?: string
  maxLabel?: string
  showLabels?: boolean
  autoFocus?: boolean
  testId?: string
}

// Track geometry: the knob's centre runs from PAD + KNOB/2 to width − PAD − KNOB/2.
const PAD = 3
const KNOB = 22
const INSET = PAD + KNOB / 2
const SPRING = 'cubic-bezier(0.34, 1.4, 0.64, 1)'

/** Cheap deterministic noise, so the pixel field looks the same on every open. */
function noise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
  return n - Math.floor(n)
}

interface Pixel {
  x: number
  y: number
  size: number
  opacity: number
  mix: number
}

/** Pixels that thicken and warm up towards the "smarter" end, like a dithered gradient. */
function pixelField(width: number, height: number): Pixel[] {
  const pitch = 5
  const cols = Math.max(8, Math.floor((width - 6) / pitch))
  const rows = Math.max(2, Math.floor((height - 6) / pitch))
  const left = (width - (cols - 1) * pitch) / 2
  const top = (height - (rows - 1) * pitch) / 2
  const out: Pixel[] = []
  for (let c = 0; c < cols; c++) {
    const f = c / (cols - 1)
    const intensity = 0.1 + 0.9 * Math.pow(f, 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r, 1) > 0.42 + 0.58 * intensity) continue
      out.push({
        x: left + c * pitch,
        y: top + r * pitch,
        size: 1.5 + 2.5 * intensity * (0.6 + 0.4 * noise(c, r, 2)),
        opacity: 0.4 + 0.6 * intensity,
        mix: Math.round(100 * Math.pow(f, 1.05))
      })
    }
  }
  return out
}

/**
 * A stepped slider in the style of Claude's effort control: drag the knob (or click, or use the
 * arrow keys) and it glides, then settles on the nearest stop with a little spring.
 */
export function StepSlider({ stops, value, rest, recommended, onCommit, onPreview, label, valueText, describedBy, unplaced, minLabel, maxLabel, showLabels, autoFocus, testId }: StepSliderProps) {
  const track = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const drag = useRef<{ id: number; index: number; key: string } | null>(null)
  const stopKey = JSON.stringify(stops.map((s) => s.id))
  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview
  // A committed stop the parent hasn't confirmed yet (saving is async), so the knob doesn't bounce back.
  const [pending, setPending] = useState<{ index: number; key: string } | null>(null)
  const last = stops.length - 1
  const optimistic = pending?.key === stopKey ? pending.index : null
  const at = Math.max(0, Math.min(last, optimistic ?? value ?? rest ?? recommended ?? Math.floor(last / 2)))
  const hasPosition = !unplaced || optimistic !== null
  const fraction = (i: number) => (last <= 0 ? 0 : i / last)

  useEffect(() => {
    if (pending?.key === stopKey && value === pending.index) setPending(null)
  }, [value, pending, stopKey])
  useLayoutEffect(() => {
    drag.current = null
    setDragging(false)
    setHover(null)
    setPending(null)
    onPreviewRef.current?.(null)
    return () => onPreviewRef.current?.(null)
  }, [stopKey])
  useEffect(() => {
    if (pending === null) return
    const t = setTimeout(() => setPending(null), 2000)
    return () => clearTimeout(t)
  }, [pending])

  useLayoutEffect(() => {
    const el = track.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!autoFocus) return
    const frame = requestAnimationFrame(() => track.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [autoFocus])

  // Puts the knob on its stop after every render that isn't mid-drag. Releasing a drag re-renders
  // with the spring transition back on first, so the knob settles instead of jumping.
  useLayoutEffect(() => {
    if (!drag.current) track.current?.style.setProperty('--pos', String(fraction(at)))
  })

  const pixels = useMemo(() => (width > 0 ? pixelField(width, 30) : []), [width])

  const fractionAt = (clientX: number) => {
    const el = track.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left - INSET) / Math.max(1, r.width - 2 * INSET)))
  }
  const nearest = (f: number) => Math.round(f * last)

  const preview = (i: number | null) => {
    setHover(i)
    onPreviewRef.current?.(i)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || last < 0) return
    e.preventDefault()
    track.current?.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    const f = last === 0 ? 0 : fractionAt(e.clientX)
    drag.current = { id: e.pointerId, index: nearest(f), key: stopKey }
    setDragging(true)
    track.current?.style.setProperty('--pos', String(f))
    preview(nearest(f))
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const f = last === 0 ? 0 : fractionAt(e.clientX)
    if (drag.current?.id === e.pointerId) {
      // The knob follows the pointer freely; the stop it would land on is previewed.
      track.current?.style.setProperty('--pos', String(f))
      const i = nearest(f)
      if (i !== drag.current.index) {
        drag.current.index = i
        preview(i)
      }
    } else if (!drag.current && e.pointerType === 'mouse') {
      const i = nearest(f)
      if (i !== hover) preview(i)
    }
  }
  const finish = (e: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    setDragging(false)
    if (commit && d.key === stopKey && (d.index !== at || value === null)) {
      setPending({ index: d.index, key: stopKey })
      onCommit(d.index)
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (e.pointerType !== 'mouse') preview(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (last < 0) return
    const step: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, PageDown: -1, ArrowRight: 1, ArrowUp: 1, PageUp: 1 }
    let next: number | null = null
    if (e.key in step) next = Math.min(last, Math.max(0, at + step[e.key]))
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next === null) return
    // Keep surrounding menus (which also use the arrow keys) out of it.
    e.preventDefault()
    e.stopPropagation()
    if (hover !== null) preview(null)
    if (next !== at || value === null) {
      setPending({ index: next, key: stopKey })
      onCommit(next)
    }
  }

  const shown = hover !== null && hover >= 0 && hover <= last ? hover : at
  const knobLeft = `calc(${PAD}px + var(--pos, 0) * (100% - ${2 * PAD + KNOB}px))`
  const litTo = `calc(100% - ${INSET}px - var(--pos, 0) * (100% - ${2 * INSET}px))`
  const glide = dragging ? 'none' : `left 320ms ${SPRING}, clip-path 320ms ${SPRING}`
  const stopLeft = (i: number) => `calc(${INSET}px + ${fraction(i)} * (100% - ${2 * INSET}px))`

  const field = (lit: boolean) => (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden style={lit ? { clipPath: `inset(0 ${litTo} 0 0)`, transition: glide } : { opacity: 0.2, filter: 'saturate(0)' }}>
      {pixels.map((p, i) => (
        <rect
          key={i}
          x={p.x - p.size / 2}
          y={p.y - p.size / 2}
          width={p.size}
          height={p.size}
          rx={0.4}
          style={{ fill: `color-mix(in srgb, var(--accent) ${p.mix}%, var(--text-3))`, opacity: p.opacity }}
        />
      ))}
    </svg>
  )

  if (!stops.length) return null
  return (
    <div className="select-none" data-testid={testId}>
      {(minLabel || maxLabel) && (
        <div className="mb-1.5 flex justify-between text-[11.5px] text-fg-3">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-describedby={describedBy}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={hasPosition ? at : undefined}
        aria-valuetext={valueText ?? `${stops[at]?.label ?? ''}${recommended === at ? ', recommended' : ''}`}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, true)}
        onPointerCancel={(e) => finish(e, false)}
        onLostPointerCapture={(e) => finish(e, false)}
        onPointerLeave={() => !drag.current && hover !== null && preview(null)}
        onKeyDown={onKeyDown}
        className="relative h-[30px] cursor-pointer touch-none overflow-hidden rounded-full bg-surface-2 outline-none ring-1 ring-line transition-shadow duration-200 focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        {field(false)}
        {hasPosition && field(true)}
        {stops.map((s, i) =>
          hasPosition && i === at && !dragging ? null : (
            <span
              key={s.id}
              aria-hidden
              className={`pointer-events-none absolute top-1/2 h-[9px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[background-color,height] duration-200 ${
                i === hover ? 'h-[13px] bg-fg' : i === recommended ? 'bg-fg-2' : 'bg-[color-mix(in_srgb,var(--text)_45%,transparent)]'
              }`}
              style={{ left: stopLeft(i) }}
            />
          )
        )}
        {hasPosition && <span
          aria-hidden
          data-slider-knob
          className={`pointer-events-none absolute top-[3px] h-[24px] rounded-[8px] ${
            value === null ? 'border-2 border-fg bg-[color-mix(in_srgb,var(--text)_14%,transparent)]' : 'bg-fg'
          } shadow-[0_1px_3px_rgba(0,0,0,0.35),0_0_0_0.5px_rgba(0,0,0,0.12)]`}
          style={{ left: knobLeft, width: KNOB, transition: dragging ? 'transform 160ms ease-out' : `left 320ms ${SPRING}, transform 160ms ease-out`, transform: dragging ? 'scale(1.08)' : 'none' }}
        />}
      </div>
      {(showLabels || recommended !== undefined) && (
        <div className="relative mt-1.5" style={{ height: showLabels && recommended !== undefined ? 32 : 16 }}>
          {showLabels &&
            stops.map((s, i) => (
              <span
                key={s.id}
                className={`absolute top-0 whitespace-nowrap text-[11px] transition-colors duration-200 ${i === shown ? 'font-medium text-fg' : 'text-fg-3'}`}
                style={edgeAligned(stopLeft(i), fraction(i))}
              >
                {s.short ?? s.label}
              </span>
            ))}
          {recommended !== undefined && (
            <span className="absolute whitespace-nowrap text-[11px] text-fg-3" style={{ top: showLabels ? 16 : 0, ...edgeAligned(stopLeft(recommended), fraction(recommended)) }} data-testid={testId ? `${testId}-recommended` : undefined}>
              Recommended
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** Centres a caption under its stop, except at the ends where it hugs the edge instead. */
function edgeAligned(left: string, f: number): CSSProperties {
  if (f <= 0.08) return { left: 0 }
  if (f >= 0.92) return { right: 0 }
  return { left, transform: 'translateX(-50%)' }
}
