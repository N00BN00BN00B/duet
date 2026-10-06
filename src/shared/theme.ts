/**
 * Themes are plain data: colours, a background effect and a few knobs. Anything a person or an
 * agent writes goes through `normalizeTheme`, so a theme can never carry CSS or script into the
 * app — only checked colours, numbers and names from fixed lists.
 */

export type ThemeBase = 'dark' | 'light'
export type ThemeFont = 'system' | 'rounded' | 'serif' | 'mono'
export type ThemeEffect = 'none' | 'gradient' | 'mesh' | 'wave' | 'aurora' | 'grid' | 'stars' | 'noise' | 'glow'

export const THEME_EFFECTS: { id: ThemeEffect; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'gradient', label: 'Gradient' },
  { id: 'wave', label: 'Waves' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'glow', label: 'Glow' },
  { id: 'grid', label: 'Grid' },
  { id: 'stars', label: 'Stars' },
  { id: 'noise', label: 'Grain' }
]

export const THEME_FONTS: { id: ThemeFont; label: string; stack: string }[] = [
  { id: 'system', label: 'System', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif" },
  { id: 'rounded', label: 'Rounded', stack: "ui-rounded, 'SF Pro Rounded', -apple-system, system-ui, sans-serif" },
  { id: 'serif', label: 'Serif', stack: "ui-serif, 'New York', Charter, Georgia, serif" },
  { id: 'mono', label: 'Mono', stack: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace" }
]

export interface ThemeColors {
  bg: string
  sidebar: string
  surface: string
  surface2: string
  surface3: string
  border: string
  borderStrong: string
  hover: string
  active: string
  fg: string
  fg2: string
  fg3: string
  accent: string
  codeBg: string
}

export interface ThemeBackground {
  effect: ThemeEffect
  /** One to four colours the effect is drawn with. */
  colors: string[]
  /** 0 is still, 1 normal, 2 fast. */
  speed: number
  /** 0–1. */
  intensity: number
  /** Gradient direction in degrees. */
  angle: number
}

export interface ThemeSpec {
  id: string
  name: string
  base: ThemeBase
  colors: ThemeColors
  background: ThemeBackground
  /** How much of the background effect shows through the sidebar and chat, 0–1. */
  glass: number
  /** Corner roundness, 0.4 (sharp) – 1.6 (soft). */
  radius: number
  font: ThemeFont
  source: 'preset' | 'ai' | 'custom'
  /** The description an AI theme was made from. */
  prompt?: string
}

// ---------- colour maths ----------

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  gold: '#f5b301',
  green: '#22c55e',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  navy: '#1e3a8a',
  indigo: '#6366f1',
  purple: '#8b5cf6',
  violet: '#8b5cf6',
  magenta: '#d946ef',
  pink: '#ec4899',
  gray: '#6b7280',
  grey: '#6b7280'
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const channel = (s: string, max: number) => (s.endsWith('%') ? (parseFloat(s) / 100) * max : parseFloat(s))

export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== 'string') return null
  const s = input.trim().toLowerCase()
  if (s.length > 64) return null
  if (NAMED[s]) return parseColor(NAMED[s])
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s)
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((v) => clamp(Math.round(channel(v, 255)), 0, 255))
    const a = rgb[4] === undefined ? 1 : clamp(channel(rgb[4], 1), 0, 1)
    return [r, g, b, a].every(Number.isFinite) ? { r, g, b, a } : null
  }
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s)
  if (hsl) {
    const c = fromHsl(parseFloat(hsl[1]), parseFloat(hsl[2]) / 100, parseFloat(hsl[3]) / 100)
    const a = hsl[4] === undefined ? 1 : clamp(channel(hsl[4], 1), 0, 1)
    return [c.r, c.g, c.b, a].every(Number.isFinite) ? { ...c, a } : null
  }
  return null
}

export function fromHsl(h: number, s: number, l: number): Rgba {
  const hue = (((h % 360) + 360) % 360) / 360
  const sat = clamp(s, 0, 1)
  const lig = clamp(l, 0, 1)
  if (sat === 0) {
    const v = Math.round(lig * 255)
    return { r: v, g: v, b: v, a: 1 }
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat
  const p = 2 * lig - q
  const f = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return { r: Math.round(f(hue + 1 / 3) * 255), g: Math.round(f(hue) * 255), b: Math.round(f(hue - 1 / 3) * 255), a: 1 }
}

export function toHsl(c: Rgba): { h: number; s: number; l: number } {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s, l }
}

export function toHex(c: Rgba): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

export function toCss(c: Rgba): string {
  if (c.a >= 0.999) return toHex(c)
  return `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)} / ${Math.round(c.a * 1000) / 1000})`
}

export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const k = clamp(t, 0, 1)
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k, a: a.a + (b.a - a.a) * k }
}

export const withAlpha = (c: Rgba, a: number): Rgba => ({ ...c, a: clamp(a, 0, 1) })

export function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Nudges `fg` towards white or black until it reads on `bg` with at least `min` contrast. */
export function readable(fg: Rgba, bg: Rgba, min: number): Rgba {
  if (contrast(fg, bg) >= min) return fg
  const target = luminance(bg) < 0.4 ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 }
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const next = mix(fg, target, t)
    if (contrast(next, bg) >= min) return next
  }
  return target
}

// ---------- normalizing ----------

const DEFAULTS: Record<ThemeBase, { bg: string; fg: string; accent: string }> = {
  dark: { bg: '#18181a', fg: '#ececec', accent: '#d97757' },
  light: { bg: '#fafaf9', fg: '#1d1d1f', accent: '#c4633f' }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : fallback)

function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f<>{}]/g, '').replace(/\s+/g, ' ').trim() : ''
  return s.slice(0, 40) || 'Custom theme'
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'theme'
  )
}

/**
 * Turns anything theme-shaped (a preset, a saved theme, an agent's JSON) into a complete, safe
 * theme. Missing colours are derived; unreadable text is fixed; unknown fields are dropped.
 * Returns null only when there is nothing usable at all.
 */
export function normalizeTheme(input: unknown, id?: string): ThemeSpec | null {
  if (!isObject(input)) return null
  const src = input
  const colorsIn = isObject(src.colors) ? src.colors : {}
  const pick = (key: string) => parseColor(colorsIn[key] ?? src[key])
  const bgGiven = pick('bg') ?? pick('background')
  const base: ThemeBase = src.base === 'light' || src.base === 'dark' ? src.base : bgGiven ? (luminance(bgGiven) > 0.4 ? 'light' : 'dark') : 'dark'
  const dark = base === 'dark'
  const d = DEFAULTS[base]
  const black: Rgba = { r: 0, g: 0, b: 0, a: 1 }
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 }
  let bg = withAlpha(bgGiven ?? parseColor(d.bg)!, 1)
  // A "dark" theme with a light background (or the other way round) is fixed rather than trusted.
  if (dark && luminance(bg) > 0.2) bg = mix(bg, black, 0.85)
  if (!dark && luminance(bg) < 0.5) bg = mix(bg, white, 0.9)
  const fg = readable(withAlpha(pick('fg') ?? pick('text') ?? parseColor(d.fg)!, 1), bg, 7)
  const accent = readable(withAlpha(pick('accent') ?? parseColor(d.accent)!, 1), bg, 3)
  const sidebar = withAlpha(pick('sidebar') ?? (dark ? mix(bg, black, 0.22) : mix(bg, black, 0.035)), 1)
  const surface = withAlpha(pick('surface') ?? (dark ? mix(bg, fg, 0.045) : mix(bg, white, 0.8)), 1)
  const fg2 = readable(withAlpha(pick('fg2') ?? mix(fg, bg, 0.36), 1), bg, 4.5)
  const fg3 = readable(withAlpha(pick('fg3') ?? mix(fg, bg, 0.56), 1), bg, 2.6)
  const colors: ThemeColors = {
    bg: toHex(bg),
    sidebar: toHex(sidebar),
    surface: toHex(surface),
    surface2: toHex(mix(bg, fg, dark ? 0.075 : 0.045)),
    surface3: toHex(mix(bg, fg, dark ? 0.115 : 0.075)),
    border: toCss(withAlpha(fg, dark ? 0.08 : 0.09)),
    borderStrong: toCss(withAlpha(fg, dark ? 0.14 : 0.15)),
    hover: toCss(withAlpha(fg, dark ? 0.05 : 0.045)),
    active: toCss(withAlpha(fg, dark ? 0.085 : 0.075)),
    fg: toHex(fg),
    fg2: toHex(fg2),
    fg3: toHex(fg3),
    accent: toHex(accent),
    codeBg: toHex(dark ? mix(bg, black, 0.25) : mix(bg, fg, 0.03))
  }
  const bgIn = isObject(src.background) ? src.background : isObject(src.effect) ? src.effect : {}
  const effectName = typeof bgIn.effect === 'string' ? bgIn.effect : typeof bgIn.type === 'string' ? bgIn.type : typeof src.effect === 'string' ? src.effect : 'none'
  const effect: ThemeEffect = THEME_EFFECTS.some((e) => e.id === effectName) ? (effectName as ThemeEffect) : 'none'
  const effectColors = (Array.isArray(bgIn.colors) ? bgIn.colors : [])
    .map((c) => parseColor(c))
    .filter((c): c is Rgba => !!c)
    .slice(0, 4)
    .map((c) => toHex(c))
  const background: ThemeBackground = {
    effect,
    colors: effectColors.length ? effectColors : [toHex(accent), toHex(mix(accent, dark ? white : black, 0.35))],
    speed: num(bgIn.speed, 1, 0, 2),
    intensity: num(bgIn.intensity, 0.6, 0, 1),
    angle: num(bgIn.angle, 160, 0, 360)
  }
  const font = typeof src.font === 'string' && THEME_FONTS.some((f) => f.id === src.font) ? (src.font as ThemeFont) : 'system'
  const name = cleanName(src.name)
  const source = src.source === 'preset' || src.source === 'ai' ? src.source : 'custom'
  const theme: ThemeSpec = {
    id: id ?? (typeof src.id === 'string' && /^[a-z0-9-]{1,48}$/.test(src.id) ? src.id : slug(name)),
    name,
    base,
    colors,
    background,
    glass: num(src.glass, effect === 'none' ? 0 : 0.4, 0, 1),
    radius: num(src.radius, 1, 0.4, 1.6),
    font,
    source
  }
  if (typeof src.prompt === 'string' && src.prompt.trim()) theme.prompt = src.prompt.trim().slice(0, 300)
  return theme
}

// ---------- presets ----------

const preset = (input: Record<string, unknown>) => normalizeTheme({ ...input, source: 'preset' })!

export const PRESET_THEMES: ThemeSpec[] = [
  preset({ id: 'graphite', name: 'Graphite', base: 'dark', colors: { bg: '#18181a', sidebar: '#131315', fg: '#ececec', accent: '#d97757' } }),
  preset({ id: 'paper', name: 'Paper', base: 'light', colors: { bg: '#fafaf9', sidebar: '#f2f2f0', surface: '#ffffff', fg: '#1d1d1f', accent: '#c4633f' } }),
  preset({ id: 'midnight', name: 'Midnight', base: 'dark', colors: { bg: '#0d1017', sidebar: '#0a0c12', fg: '#e6e9f0', accent: '#7c8cff' } }),
  preset({
    id: 'ocean-waves',
    name: 'Ocean Waves',
    base: 'dark',
    colors: { bg: '#0a1222', sidebar: '#08101d', fg: '#e7eefb', accent: '#38bdf8' },
    background: { effect: 'wave', colors: ['#1d4ed8', '#0ea5e9', '#6366f1'], speed: 1, intensity: 0.7, angle: 170 },
    glass: 0.45
  }),
  preset({
    id: 'aurora',
    name: 'Aurora',
    base: 'dark',
    colors: { bg: '#071216', sidebar: '#061014', fg: '#e3f4f1', accent: '#34d399' },
    background: { effect: 'aurora', colors: ['#22d3ee', '#a78bfa', '#34d399'], speed: 0.8, intensity: 0.65 },
    glass: 0.45
  }),
  preset({
    id: 'sunset',
    name: 'Sunset',
    base: 'dark',
    colors: { bg: '#170f12', sidebar: '#120b0e', fg: '#f6ebe7', accent: '#fb7185' },
    background: { effect: 'gradient', colors: ['#7c2d12', '#be185d', '#312e81'], speed: 0.6, intensity: 0.55, angle: 155 },
    glass: 0.4
  }),
  preset({
    id: 'synthwave',
    name: 'Synthwave',
    base: 'dark',
    colors: { bg: '#120a1f', sidebar: '#0e0718', fg: '#f4ecff', accent: '#ff4fd8' },
    background: { effect: 'grid', colors: ['#ff4fd8', '#22d3ee'], speed: 1, intensity: 0.55 },
    glass: 0.35
  }),
  preset({
    id: 'deep-space',
    name: 'Deep Space',
    base: 'dark',
    colors: { bg: '#07080f', sidebar: '#05060b', fg: '#e8eaf6', accent: '#a5b4fc' },
    background: { effect: 'stars', colors: ['#ffffff', '#a5b4fc'], speed: 0.6, intensity: 0.7 },
    glass: 0.35
  }),
  preset({ id: 'nord', name: 'Nord', base: 'dark', colors: { bg: '#2e3440', sidebar: '#292e39', surface: '#3b4252', fg: '#eceff4', accent: '#88c0d0' } }),
  preset({ id: 'forest', name: 'Forest', base: 'dark', colors: { bg: '#0f1712', sidebar: '#0c130f', fg: '#e5f0e8', accent: '#4ade80' }, background: { effect: 'mesh', colors: ['#14532d', '#166534', '#1e3a2f'], speed: 0.5, intensity: 0.5 }, glass: 0.35 }),
  preset({ id: 'mono', name: 'Mono', base: 'dark', colors: { bg: '#0a0a0a', sidebar: '#060606', fg: '#f5f5f5', accent: '#e5e5e5' } }),
  preset({ id: 'solarized', name: 'Solarized Light', base: 'light', colors: { bg: '#fdf6e3', sidebar: '#f5eed8', surface: '#fffbf0', fg: '#3b4a50', accent: '#268bd2' } }),
  preset({ id: 'rose', name: 'Rosé', base: 'light', colors: { bg: '#fff7f8', sidebar: '#fbecee', surface: '#ffffff', fg: '#2a1a1e', accent: '#e11d48' }, background: { effect: 'glow', colors: ['#fda4af', '#f9a8d4'], intensity: 0.5, speed: 0 }, glass: 0.3 })
]

export const DEFAULT_DARK_THEME = 'graphite'
export const DEFAULT_LIGHT_THEME = 'paper'

export function findTheme(id: string | undefined, custom: ThemeSpec[] = []): ThemeSpec | undefined {
  return custom.find((t) => t.id === id) ?? PRESET_THEMES.find((t) => t.id === id)
}

// ---------- CSS variables ----------

const STATUS: Record<ThemeBase, Record<string, string>> = {
  dark: {
    '--ok': '#4ade80',
    '--warn': '#fbbf24',
    '--bad': '#f87171',
    '--info': '#60a5fa',
    '--diff-add-bg': 'rgb(74 222 128 / 0.1)',
    '--diff-add-fg': '#86efac',
    '--diff-del-bg': 'rgb(248 113 113 / 0.1)',
    '--diff-del-fg': '#fca5a5',
    '--composer-shadow': '0 1px 0 rgb(255 255 255 / 0.035) inset, 0 16px 40px -24px rgb(0 0 0 / 0.8)',
    '--pop-shadow': '0 0 0 1px var(--border-strong), 0 16px 40px -14px rgb(0 0 0 / 0.6)'
  },
  light: {
    '--ok': '#16a34a',
    '--warn': '#d97706',
    '--bad': '#dc2626',
    '--info': '#2563eb',
    '--diff-add-bg': 'rgb(22 163 74 / 0.09)',
    '--diff-add-fg': '#15803d',
    '--diff-del-bg': 'rgb(220 38 38 / 0.08)',
    '--diff-del-fg': '#b91c1c',
    '--composer-shadow': '0 1px 0 rgb(255 255 255 / 0.9) inset, 0 14px 32px -22px rgb(0 0 0 / 0.25)',
    '--pop-shadow': '0 0 0 1px var(--border-strong), 0 14px 36px -14px rgb(0 0 0 / 0.2)'
  }
}

/** The CSS custom properties a theme sets on the document root. */
export function themeVariables(theme: ThemeSpec): Record<string, string> {
  const c = theme.colors
  const glass = theme.background.effect === 'none' ? 0 : theme.glass
  const bg = parseColor(c.bg)!
  const sidebar = parseColor(c.sidebar)!
  return {
    '--bg': c.bg,
    // Panels let the background effect show through by `glass`.
    '--bg-panel': toCss(withAlpha(bg, 1 - glass * 0.85)),
    '--bg-sidebar': toCss(withAlpha(sidebar, 1 - glass * 0.6)),
    '--surface': c.surface,
    '--surface-2': c.surface2,
    '--surface-3': c.surface3,
    '--hover': c.hover,
    '--active': c.active,
    '--border': c.border,
    '--border-strong': c.borderStrong,
    '--text': c.fg,
    '--text-2': c.fg2,
    '--text-3': c.fg3,
    '--code-bg': c.codeBg,
    '--theme-accent': c.accent,
    '--radius-scale': String(theme.radius),
    '--font-ui': THEME_FONTS.find((f) => f.id === theme.font)?.stack ?? THEME_FONTS[0].stack,
    ...STATUS[theme.base]
  }
}

// ---------- describe a look (offline) ----------

const HUES: [RegExp, string][] = [
  [/\b(red|crimson|ruby|scarlet)\b/, '#ef4444'],
  [/\b(orange|tangerine|amber)\b/, '#f97316'],
  [/\b(gold|golden|yellow|honey)\b/, '#eab308'],
  [/\b(lime)\b/, '#84cc16'],
  [/\b(green|emerald|forest|mint|matrix)\b/, '#22c55e'],
  [/\b(teal|turquoise)\b/, '#14b8a6'],
  [/\b(cyan|aqua|ice|icy)\b/, '#06b6d4'],
  [/\b(blue|ocean|sea|sky|navy|cobalt|azure)\b/, '#3b82f6'],
  [/\b(indigo)\b/, '#6366f1'],
  [/\b(purple|violet|lavender|grape)\b/, '#8b5cf6'],
  [/\b(magenta|fuchsia)\b/, '#d946ef'],
  [/\b(pink|rose|sakura|blush)\b/, '#ec4899'],
  [/\b(brown|coffee|mocha|espresso|wood)\b/, '#a16207'],
  [/\b(gr[ae]y|slate|silver|mono|monochrome|minimal)\b/, '#94a3b8']
]

const MOODS: { match: RegExp; colors: string[]; effect?: ThemeEffect; base?: ThemeBase }[] = [
  { match: /\b(synthwave|vaporwave|retro ?wave|cyber(punk)?|neon)\b/, colors: ['#ff4fd8', '#22d3ee', '#7c3aed'], effect: 'grid', base: 'dark' },
  { match: /\bsunset|sunrise|dusk\b/, colors: ['#f97316', '#ec4899', '#6d28d9'], effect: 'gradient' },
  { match: /\b(ocean|sea|underwater|deep sea)\b/, colors: ['#1d4ed8', '#0ea5e9', '#14b8a6'], effect: 'wave' },
  { match: /\b(aurora|northern lights|borealis)\b/, colors: ['#22d3ee', '#a78bfa', '#34d399'], effect: 'aurora' },
  { match: /\b(space|galaxy|cosmic|night sky|starry)\b/, colors: ['#ffffff', '#a5b4fc', '#6366f1'], effect: 'stars', base: 'dark' },
  { match: /\b(forest|jungle|nature)\b/, colors: ['#14532d', '#16a34a', '#1e3a2f'], effect: 'mesh' },
  { match: /\b(fire|lava|volcan\w*|ember)\b/, colors: ['#dc2626', '#f97316', '#7c2d12'], effect: 'glow', base: 'dark' },
  { match: /\b(matrix|hacker|terminal)\b/, colors: ['#22c55e', '#15803d'], effect: 'grid', base: 'dark' },
  { match: /\b(paper|notebook|cream|latte)\b/, colors: ['#f5e6c8', '#e7d2a8'], base: 'light' }
]

const EFFECT_WORDS: [RegExp, ThemeEffect][] = [
  [/\bwav(e|es|y)\b/, 'wave'],
  [/\baurora\b/, 'aurora'],
  [/\b(mesh|blobs?|lava ?lamp)\b/, 'mesh'],
  [/\b(grid|retro|tron)\b/, 'grid'],
  [/\b(stars?|starry|sparkl\w*)\b/, 'stars'],
  [/\b(grain|grainy|noise|film)\b/, 'noise'],
  [/\b(glow|glowing|spotlight)\b/, 'glow'],
  [/\bgradient\b/, 'gradient']
]

/**
 * Builds a theme from a description without asking an agent: picks light/dark, colours and an
 * effect from the words used. Used offline and as the fallback when an agent's answer is unusable.
 */
export function themeFromPrompt(prompt: string): ThemeSpec {
  const text = prompt.toLowerCase()
  const mood = MOODS.find((m) => m.match.test(text))
  const hues = HUES.filter(([re]) => re.test(text)).map(([, c]) => c)
  const palette = [...hues, ...(mood?.colors ?? [])].slice(0, 4)
  const primary = parseColor(palette[0] ?? '#7c8cff')!
  const light = /\b(light|white|bright|day|pastel|paper|cream|soft light)\b/.test(text) && !/\bdark\b/.test(text)
  const base: ThemeBase = mood?.base && !/\b(light|dark)\b/.test(text) ? mood.base : light ? 'light' : 'dark'
  let effect: ThemeEffect = EFFECT_WORDS.find(([re]) => re.test(text))?.[1] ?? mood?.effect ?? 'none'
  if (/\b(plain|flat|no effects?|simple|clean)\b/.test(text) && !EFFECT_WORDS.some(([re]) => re.test(text))) effect = 'none'
  const speed = /\b(still|static|calm|no animation|not moving)\b/.test(text) ? 0 : /\bslow\b/.test(text) ? 0.5 : /\b(fast|energetic|wild)\b/.test(text) ? 1.6 : 1
  const black: Rgba = { r: 0, g: 0, b: 0, a: 1 }
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 }
  const bg = base === 'dark' ? mix(mix(black, primary, 0.1), { r: 12, g: 12, b: 16, a: 1 }, 0.5) : mix(white, primary, 0.035)
  const effectColors = (palette.length >= 2 ? palette : [toHex(primary), toHex(mix(primary, base === 'dark' ? black : white, 0.45)), toHex(mix(primary, { r: 99, g: 102, b: 241, a: 1 }, 0.5))]).slice(0, 3)
  const words = prompt
    .replace(/\b(change|make|set|turn|the|theme|of|app|to|with|a|an|and|please|into|look|like|effect|style)\b/gi, ' ')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
  return normalizeTheme({
    name: words.join(' ') || 'Custom theme',
    base,
    colors: { bg: toHex(bg), accent: toHex(primary) },
    background: { effect, colors: effectColors, speed, intensity: base === 'dark' ? 0.65 : 0.45, angle: 160 },
    glass: effect === 'none' ? 0 : 0.45,
    radius: /\b(sharp|square|boxy)\b/.test(text) ? 0.5 : /\b(round|rounded|soft|bubbly)\b/.test(text) ? 1.4 : 1,
    font: /\b(rounded|friendly|playful)\b/.test(text) ? 'rounded' : /\b(serif|classic|elegant|book)\b/.test(text) ? 'serif' : /\b(mono|code|terminal|hacker)\b/.test(text) ? 'mono' : 'system',
    source: 'ai',
    prompt
  })!
}

/** What an agent is asked to return when it designs a theme. */
export const THEME_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'base', 'colors', 'background', 'glass', 'radius', 'font'],
  properties: {
    name: { type: 'string', description: 'Short theme name, 1-3 words' },
    base: { type: 'string', enum: ['dark', 'light'] },
    colors: {
      type: 'object',
      additionalProperties: false,
      required: ['bg', 'sidebar', 'surface', 'fg', 'accent'],
      properties: {
        bg: { type: 'string', description: 'Main background, #rrggbb' },
        sidebar: { type: 'string', description: 'Sidebar background, #rrggbb' },
        surface: { type: 'string', description: 'Cards and the message box, #rrggbb' },
        fg: { type: 'string', description: 'Main text, #rrggbb, must be very readable on bg' },
        accent: { type: 'string', description: 'Buttons, links and highlights, #rrggbb' }
      }
    },
    background: {
      type: 'object',
      additionalProperties: false,
      required: ['effect', 'colors', 'speed', 'intensity', 'angle'],
      properties: {
        effect: { type: 'string', enum: THEME_EFFECTS.map((e) => e.id) },
        colors: { type: 'array', items: { type: 'string' }, description: '1-4 colours #rrggbb for the effect' },
        speed: { type: 'number', description: '0 still, 1 normal, 2 fast' },
        intensity: { type: 'number', description: '0-1' },
        angle: { type: 'number', description: 'Gradient angle in degrees' }
      }
    },
    glass: { type: 'number', description: '0-1, how much the effect shows through panels' },
    radius: { type: 'number', description: '0.4 sharp to 1.6 very round, 1 normal' },
    font: { type: 'string', enum: THEME_FONTS.map((f) => f.id) }
  }
} as const

/** The instructions given to an agent that designs a theme. */
export function themePrompt(description: string): string {
  return [
    'You design colour themes for Duet, a desktop chat app for coding agents (sidebar on the left, chat in the middle, a message box at the bottom).',
    `Design a theme for this request: "${description.replace(/"/g, "'").slice(0, 400)}"`,
    'Rules: return ONLY a JSON object (no prose, no code fences) matching this schema:',
    JSON.stringify(THEME_JSON_SCHEMA),
    'Colours are #rrggbb. Text (fg) must be easy to read on bg and surface; keep large areas calm so long chats stay readable, and put the personality into the accent and the background effect.',
    `Effects: ${THEME_EFFECTS.map((e) => e.id).join(', ')}. Use "none" unless the request asks for something animated or decorative.`
  ].join('\n')
}

/** Pulls the first JSON object out of an agent's reply (it may wrap it in prose or a code fence). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

/** The theme to show for the current appearance settings. */
export function resolveTheme(
  settings: { theme?: 'system' | 'dark' | 'light'; darkTheme?: string; lightTheme?: string; customThemes?: ThemeSpec[]; backgroundEffects?: boolean } | null | undefined,
  systemDark: boolean
): ThemeSpec {
  const mode = settings?.theme ?? 'system'
  const dark = mode === 'system' ? systemDark : mode === 'dark'
  const custom = settings?.customThemes ?? []
  const theme =
    findTheme(dark ? settings?.darkTheme : settings?.lightTheme, custom) ??
    findTheme(dark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME)!
  if (settings?.backgroundEffects === false && theme.background.effect !== 'none') return { ...theme, background: { ...theme.background, effect: 'none' } }
  return theme
}
