import { useLayoutEffect, useState, type RefObject } from 'react'

/** Top edge of the area an element can be seen in: the window, or the nearest ancestor that clips overflow. */
function visibleTop(el: HTMLElement): number {
  let top = 0
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (s.overflowY !== 'visible' || s.overflowX !== 'visible') top = Math.max(top, p.getBoundingClientRect().top)
  }
  return top
}

/**
 * Height limit for the scrolling list of a menu that opens upward from its anchor (`bottom-full`),
 * so the whole menu fits below the top of whatever would clip it — e.g. the home screen, where the
 * composer sits mid-window. `refit` re-measures when the menu's content changes.
 */
export function useFitAbove(menu: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>, preferred: number, refit?: unknown): number {
  const [max, setMax] = useState(preferred)
  useLayoutEffect(() => {
    const fit = () => {
      const m = menu.current
      const l = list.current
      if (!m || !l) return
      const chrome = m.offsetHeight - l.offsetHeight
      // The menu's offset parent is its anchor; it isn't animated, unlike the menu itself.
      const anchorTop = (m.offsetParent as HTMLElement | null)?.getBoundingClientRect().top ?? m.getBoundingClientRect().bottom
      const room = anchorTop - parseFloat(getComputedStyle(m).marginBottom || '0') - visibleTop(m) - 8
      setMax(Math.max(96, Math.min(preferred, Math.floor(room - chrome))))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [menu, list, preferred, refit])
  return max
}
