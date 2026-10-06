import { memo, useMemo, type CSSProperties } from 'react'
import type { ThemeSpec } from '@shared/theme'
import { useApp } from '@/state/store'

const at = (colors: string[], i: number) => colors[i % colors.length]

/** Seconds for one loop at the theme's speed (0 = still). */
function loop(base: number, speed: number): string | undefined {
  return speed > 0 ? `${(base / speed).toFixed(1)}s` : undefined
}

function anim(name: string, base: number, speed: number, extra = 'ease-in-out infinite'): CSSProperties {
  const duration = loop(base, speed)
  return duration ? { animation: `${name} ${duration} ${extra}` } : {}
}

/** A wide strip of one wave period, repeated twice so sliding it left by half loops seamlessly. */
function wavePath(amplitude: number, baseline: number): string {
  let d = `M0 ${baseline}`
  for (let i = 0; i < 4; i++) {
    const x = i * 400
    d += ` C ${x + 100} ${baseline - amplitude}, ${x + 300} ${baseline + amplitude}, ${x + 400} ${baseline}`
  }
  return `${d} L1600 200 L0 200 Z`
}

/** Deterministic star field, as one box-shadow per layer (a few dozen dots, no images). */
function starShadows(count: number, seed: number, color: string): string {
  let x = seed
  const rand = () => {
    x = (x * 16807) % 2147483647
    return x / 2147483647
  }
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(`${Math.round(rand() * 2400)}px ${Math.round(rand() * 1600)}px 0 ${rand() > 0.85 ? 1 : 0}px ${color}`)
  return out.join(', ')
}

const NOISE =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.9'/></svg>\")"

function Layers({ theme }: { theme: ThemeSpec }) {
  const { effect, colors, speed, angle } = theme.background
  const bg = theme.colors.bg
  const stars = useMemo(() => (effect === 'stars' ? [starShadows(140, 7, at(colors, 0)), starShadows(70, 99, at(colors, 1))] : []), [effect, colors])
  switch (effect) {
    case 'gradient':
      return (
        <div
          className="fx-layer"
          style={{ inset: '-20%', background: `linear-gradient(${angle}deg, ${colors.map((c, i) => `${c} ${Math.round((i / Math.max(1, colors.length - 1)) * 100)}%`).join(', ')})`, ...anim('fx-drift', 40, speed) }}
        />
      )
    case 'mesh':
      return (
        <>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="fx-layer rounded-full"
              style={{
                width: '70vmax',
                height: '70vmax',
                left: ['-20%', '45%', '10%', '60%'][i],
                top: ['-25%', '-10%', '45%', '50%'][i],
                background: `radial-gradient(circle at center, ${at(colors, i)} 0%, transparent 62%)`,
                opacity: 0.75,
                ...anim(i % 2 ? 'fx-blob-b' : 'fx-blob-a', 34 + i * 7, speed)
              }}
            />
          ))}
        </>
      )
    case 'aurora':
      return (
        <>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="fx-layer"
              style={{
                width: '90vw',
                height: '55vh',
                left: ['-15%', '20%', '45%'][i],
                top: ['-12%', '-6%', '-16%'][i],
                borderRadius: '50%',
                background: `radial-gradient(ellipse at center, ${at(colors, i)} 0%, transparent 65%)`,
                opacity: 0.7,
                ...anim('fx-aurora', 22 + i * 6, speed)
              }}
            />
          ))}
          <div className="fx-layer" style={{ inset: 0, background: `linear-gradient(to bottom, transparent 30%, ${bg} 85%)` }} />
        </>
      )
    case 'wave':
      return (
        <>
          <div className="fx-layer" style={{ inset: 0, background: `linear-gradient(${angle}deg, ${bg} 20%, ${at(colors, 0)}33 100%)` }} />
          {[0, 1, 2].map((i) => (
            <svg
              key={i}
              className="fx-layer"
              viewBox="0 0 1600 200"
              preserveAspectRatio="none"
              style={{ left: 0, bottom: 0, width: '200%', height: `${26 + i * 9}vh`, opacity: 0.32 + i * 0.12, ...anim('fx-wave', 26 - i * 6, speed, 'linear infinite') }}
            >
              <path d={wavePath(28 + i * 8, 70 + i * 18)} fill={at(colors, i)} />
            </svg>
          ))}
        </>
      )
    case 'grid':
      return (
        <>
          <div className="fx-layer" style={{ left: 0, right: 0, top: '30%', height: '22%', background: `radial-gradient(ellipse at 50% 100%, ${at(colors, 0)}55 0%, transparent 70%)` }} />
          <div className="fx-layer" style={{ left: '-50%', right: '-50%', bottom: 0, height: '55%', perspective: '420px', overflow: 'hidden' }}>
            <div
              style={{
                position: 'absolute',
                inset: '-48px 0 0 0',
                transform: 'rotateX(62deg)',
                transformOrigin: '50% 100%',
                maskImage: 'linear-gradient(to top, black 30%, transparent 95%)'
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: '-96px 0 0 0',
                  backgroundImage: `linear-gradient(${at(colors, 1)}66 1px, transparent 1px), linear-gradient(90deg, ${at(colors, 0)}66 1px, transparent 1px)`,
                  backgroundSize: '48px 48px',
                  willChange: 'transform',
                  ...anim('fx-grid', 3, speed, 'linear infinite')
                }}
              />
            </div>
          </div>
        </>
      )
    case 'stars':
      return (
        <>
          {stars.map((shadow, i) => (
            <div key={i} className="fx-layer" style={{ left: 0, top: 0, width: 1, height: 1, borderRadius: '50%', boxShadow: shadow, ...anim('fx-twinkle', 5 + i * 3, speed) }} />
          ))}
          <div className="fx-layer" style={{ inset: 0, background: `radial-gradient(ellipse at 70% 0%, ${at(colors, 1)}22 0%, transparent 60%)` }} />
        </>
      )
    case 'noise':
      return (
        <>
          <div className="fx-layer" style={{ inset: 0, background: `linear-gradient(${angle}deg, ${at(colors, 0)}22, transparent 70%)` }} />
          <div className="fx-layer" style={{ inset: 0, backgroundImage: NOISE, opacity: 0.18, mixBlendMode: theme.base === 'dark' ? 'overlay' : 'multiply' }} />
        </>
      )
    case 'glow':
      return (
        <>
          <div className="fx-layer" style={{ width: '80vmax', height: '80vmax', left: '-30vmax', top: '-40vmax', background: `radial-gradient(circle, ${at(colors, 0)}55 0%, transparent 60%)`, ...anim('fx-pulse', 14, speed) }} />
          <div className="fx-layer" style={{ width: '70vmax', height: '70vmax', right: '-30vmax', bottom: '-40vmax', background: `radial-gradient(circle, ${at(colors, 1)}44 0%, transparent 60%)`, ...anim('fx-pulse', 18, speed) }} />
        </>
      )
    default:
      return null
  }
}

/** The theme's decorative background, drawn once behind the whole window. */
export const BackgroundEffect = memo(function BackgroundEffect() {
  const theme = useApp((s) => s.theme)
  if (theme.background.effect === 'none') return null
  return (
    <div className="fx-root" style={{ opacity: theme.background.intensity }} aria-hidden data-testid="background-effect" data-effect={theme.background.effect}>
      <Layers theme={theme} />
    </div>
  )
})

/** A small, still rendering of a theme for pickers. */
export function ThemeSwatch({ theme, className = '' }: { theme: ThemeSpec; className?: string }) {
  const c = theme.colors
  const fx = theme.background
  const wash =
    fx.effect === 'none'
      ? c.bg
      : fx.effect === 'wave'
        ? `linear-gradient(to bottom, ${c.bg} 45%, ${fx.colors[0]} 100%)`
        : fx.effect === 'stars'
          ? `radial-gradient(circle at 30% 30%, ${fx.colors[0]} 0 1px, transparent 2px), radial-gradient(circle at 70% 60%, ${fx.colors[0]} 0 1px, transparent 2px), ${c.bg}`
          : `linear-gradient(${fx.angle}deg, ${fx.colors.map((col) => `${col}cc`).join(', ')}), ${c.bg}`
  return (
    <div className={`relative overflow-hidden ${className}`} style={{ background: wash }} aria-hidden>
      <div className="absolute inset-y-0 left-0 w-[28%]" style={{ background: c.sidebar, opacity: 0.92 }} />
      <div className="absolute left-[36%] right-[10%] top-[24%] h-[9%] rounded-full" style={{ background: c.fg, opacity: 0.85 }} />
      <div className="absolute left-[36%] right-[26%] top-[40%] h-[7%] rounded-full" style={{ background: c.fg2, opacity: 0.7 }} />
      <div className="absolute bottom-[12%] left-[36%] right-[10%] h-[18%] rounded-md" style={{ background: c.surface, boxShadow: `inset 0 0 0 1px ${c.border}` }}>
        <div className="absolute bottom-[22%] right-[6%] h-[56%] w-[12%] rounded-full" style={{ background: c.accent }} />
      </div>
    </div>
  )
}
