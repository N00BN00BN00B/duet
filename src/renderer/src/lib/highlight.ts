import type { HighlighterCore } from 'shiki/core'

type Loader = () => Promise<unknown>

/* Languages are loaded on demand so the first paint stays fast. */
const LANGS: Record<string, Loader> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  luau: () => import('shiki/langs/luau.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs')
}

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  console: 'bash',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  rb: 'ruby',
  cs: 'csharp',
  'c++': 'cpp',
  kt: 'kotlin',
  docker: 'dockerfile',
  patch: 'diff',
  htm: 'html',
  svg: 'xml',
  gql: 'graphql'
}

export function normalizeLang(lang: string | undefined): string | null {
  if (!lang) return null
  const l = lang.toLowerCase().trim()
  const name = ALIASES[l] ?? l
  return LANGS[name] ? name : null
}

let highlighterPromise: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, dark, light] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-dark-default.mjs'),
        import('shiki/themes/github-light-default.mjs')
      ])
      return createHighlighterCore({
        themes: [dark.default, light.default],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true })
      })
    })()
  }
  return highlighterPromise
}

const cache = new Map<string, string>()

/** Returns highlighted HTML (dual light/dark theme) or null if the language is unknown. */
export async function highlight(code: string, lang: string | undefined): Promise<string | null> {
  const name = normalizeLang(lang)
  if (!name || code.length > 200_000) return null
  const key = `${name}\u0000${code}`
  const hit = cache.get(key)
  if (hit) return hit
  const hl = await getHighlighter()
  if (!loaded.has(name)) {
    const mod = (await LANGS[name]()) as { default: Parameters<HighlighterCore['loadLanguage']>[0] }
    await hl.loadLanguage(mod.default)
    loaded.add(name)
  }
  const html = hl.codeToHtml(code, { lang: name, themes: { dark: 'github-dark-default', light: 'github-light-default' }, defaultColor: false })
  if (cache.size > 300) cache.clear()
  cache.set(key, html)
  return html
}
