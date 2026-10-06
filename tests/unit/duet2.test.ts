import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DuetEvent, HistoryEntry, ProviderId, ProviderStatus, ThreadMeta, TimelineItem } from '../../src/shared/types'
import { contrast, extractJsonObject, findTheme, normalizeTheme, parseColor, PRESET_THEMES, resolveTheme, themeFromPrompt, themeVariables } from '../../src/shared/theme'
import { personalityInstructions } from '../../src/shared/personality'
import { planChatSync } from '../../src/main/features/chatSync'
import { parseDeepLink } from '../../src/main/features/deeplink'
import { readClaudeLine, readCodexLine, scanAll, scanFile, type FileUsage } from '../../src/main/features/usageScan'
import { UsageService } from '../../src/main/features/usage'
import { oldSafetyCopies, storageStats, unusedAttachments } from '../../src/main/features/storage'
import { cliScript, cliStatus, installCli, uninstallCli } from '../../src/main/features/cli'
import { readClaudePersonality } from '../../src/main/features/personality'
import { generateTheme } from '../../src/main/features/themeGen'
import { Store } from '../../src/main/store'
import { Orchestrator } from '../../src/main/orchestrator'
import { FakeAdapter } from '../../src/main/providers/fake/adapter'
import type { Emit, ProviderAdapter, RuntimeEvent, TurnRequest } from '../../src/main/providers/types'
import { CodexAdapter } from '../../src/main/providers/codex/adapter'
import { ClaudeAdapter } from '../../src/main/providers/claude/adapter'
import { ClaudeMapper } from '../../src/main/providers/claude/mapper'
import { agentCommands, parseCommand, rankCommands, reviewTarget, DUET_COMMANDS } from '../../src/renderer/src/lib/commands'
import { ladderIndex, modelLadder, modelTier, shortModelName } from '../../src/renderer/src/lib/models'
import { buildBlocks, summarize } from '../../src/renderer/src/lib/timeline'

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `duet2-${name}-`))
const fixture = (name: string) => resolve(__dirname, '../fixtures', name)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timed out')
    await wait(5)
  }
}

describe('themes', () => {
  it('reads colours in the usual formats and nothing else', () => {
    expect(parseColor('#abc')).toMatchObject({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseColor('#11223380')?.a).toBeCloseTo(0.5, 1)
    expect(parseColor('rgb(10 20 30 / 50%)')).toMatchObject({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(parseColor('hsl(0, 100%, 50%)')).toMatchObject({ r: 255, g: 0, b: 0 })
    expect(parseColor('pink')).not.toBeNull()
    expect(parseColor('red; background: url(javascript:alert(1))')).toBeNull()
    expect(parseColor('var(--x)')).toBeNull()
    expect(parseColor(42)).toBeNull()
  })

  it('turns any agent answer into a safe, readable theme', () => {
    const t = normalizeTheme({ name: '<script>Bad</script> theme{}', base: 'dark', colors: { bg: '#ffffff', fg: '#222222', accent: '#000001' }, background: { effect: 'tornado', speed: 99, intensity: -1 }, glass: 5, font: 'comic', extra: 'ignored' })!
    // A "dark" theme with a white background is darkened, and text stays readable on it.
    expect(contrast(parseColor(t.colors.fg)!, parseColor(t.colors.bg)!)).toBeGreaterThanOrEqual(7)
    expect(contrast(parseColor(t.colors.accent)!, parseColor(t.colors.bg)!)).toBeGreaterThanOrEqual(3)
    expect(t.name).not.toMatch(/[<>{}]/)
    expect(t.background).toMatchObject({ effect: 'none', speed: 2, intensity: 0 })
    expect(t.glass).toBe(1)
    expect(t.font).toBe('system')
    expect(t).not.toHaveProperty('extra')
    expect(normalizeTheme(null)).toBeNull()
    expect(normalizeTheme('nope')).toBeNull()
  })

  it('designs something sensible from words alone', () => {
    const wave = themeFromPrompt('Change the theme of the app to dark gradient with a wave effect')
    expect(wave.base).toBe('dark')
    expect(wave.background.effect).toBe('wave')
    expect(wave.source).toBe('ai')
    const paper = themeFromPrompt('a calm light paper theme, no effects')
    expect(paper.base).toBe('light')
    expect(paper.background.effect).toBe('none')
    expect(themeFromPrompt('neon synthwave').background.effect).toBe('grid')
    expect(themeFromPrompt('slow pink aurora').background).toMatchObject({ effect: 'aurora', speed: 0.5 })
    expect(themeFromPrompt('sharp mono hacker').radius).toBe(0.5)
  })

  it('finds the JSON in an agent reply and maps presets to CSS variables', () => {
    expect(extractJsonObject('Sure! ```json\n{"name":"A {b}","n":1}\n``` hope it helps')).toEqual({ name: 'A {b}', n: 1 })
    expect(extractJsonObject('no json here')).toBeNull()
    const vars = themeVariables(PRESET_THEMES.find((t) => t.id === 'ocean-waves')!)
    expect(vars['--bg']).toMatch(/^#/)
    expect(vars['--bg-panel']).toMatch(/^rgb\(/) // see-through over the waves
    expect(vars['--radius-scale']).toBe('1')
    expect(PRESET_THEMES.every((t) => normalizeTheme(t)?.id === t.id)).toBe(true)
  })

  it('picks the dark or light theme from the settings', () => {
    const custom = { ...themeFromPrompt('forest'), id: 'mine' }
    expect(resolveTheme({ theme: 'dark', darkTheme: 'midnight' }, false).id).toBe('midnight')
    expect(resolveTheme({ theme: 'system', lightTheme: 'paper', darkTheme: 'graphite' }, false).id).toBe('paper')
    expect(resolveTheme({ theme: 'dark', darkTheme: 'mine', customThemes: [custom] }, true).id).toBe('mine')
    expect(resolveTheme({ theme: 'dark', darkTheme: 'gone' }, true).id).toBe('graphite')
    expect(resolveTheme({ theme: 'dark', darkTheme: 'ocean-waves', backgroundEffects: false }, true).background.effect).toBe('none')
    expect(findTheme('aurora')?.name).toBe('Aurora')
  })

  it('asks the agents in order and falls back to designing offline', async () => {
    const answer = JSON.stringify({ name: 'Agent Made', base: 'light', colors: { bg: '#fafafa', fg: '#111111', accent: '#e11d48' }, background: { effect: 'glow', colors: ['#fda4af'] }, glass: 0.3, radius: 1, font: 'rounded' })
    const failing = { id: 'claude' as ProviderId, ready: true, ask: async () => Promise.reject(new Error('busy')) }
    const working = { id: 'codex' as ProviderId, ready: true, ask: async () => `Here you go: ${answer}` }
    const viaCodex = await generateTheme('rosy light', [failing, working], 'claude')
    expect(viaCodex.via).toBe('codex')
    expect(viaCodex.theme).toMatchObject({ name: 'Agent Made', base: 'light', font: 'rounded', source: 'ai', prompt: 'rosy light' })
    expect(viaCodex.theme.id).toMatch(/^agent-made-[0-9a-f]{6}$/)
    const offline = await generateTheme('dark waves', [failing, { ...working, ready: false }])
    expect(offline.via).toBe('local')
    expect(offline.theme.background.effect).toBe('wave')
    expect(offline.note).toMatch(/busy/)
    await expect(generateTheme('   ', [])).rejects.toThrow(/Describe/)
  })
})

describe('personality', () => {
  it('gives each chosen agent the right instructions', () => {
    expect(personalityInstructions({ preset: 'default', custom: '', providers: ['claude', 'codex'] }, 'claude')).toBeUndefined()
    expect(personalityInstructions({ preset: 'concise', custom: '', providers: ['codex'] }, 'codex')).toMatch(/concise/)
    expect(personalityInstructions({ preset: 'concise', custom: '', providers: ['codex'] }, 'claude')).toBeUndefined()
    expect(personalityInstructions({ preset: 'custom', custom: '  Talk like a pirate  ', providers: ['claude'] }, 'claude')).toBe('Talk like a pirate')
  })

  it("imports Claude Code's output style, built-in or custom", () => {
    const dir = tmp('claude-home')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ outputStyle: 'Explanatory' }))
    expect(readClaudePersonality(dir)).toMatchObject({ preset: 'teacher', label: 'Claude Code · Explanatory' })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ outputStyle: 'Pirate' }))
    mkdirSync(join(dir, 'output-styles', 'fun'), { recursive: true })
    writeFileSync(join(dir, 'output-styles', 'fun', 'pirate.md'), '---\nname: Pirate\ndescription: Arr\n---\nAlways talk like a pirate.\n')
    expect(readClaudePersonality(dir)).toEqual({ preset: 'custom', custom: 'Always talk like a pirate.', label: 'Claude Code · Pirate' })
    writeFileSync(join(dir, 'settings.json'), '{}')
    expect(readClaudePersonality(dir)).toMatchObject({ preset: 'default' })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ outputStyle: 'Missing' }))
    expect(readClaudePersonality(dir)).toBeNull()
  })
})

describe('chat sync', () => {
  const defaults = { models: {}, efforts: {}, access: 'ask' as const, fallbackCwd: '/duet/chats', folderExists: (p: string) => p.startsWith('/exists') }
  const entry = (provider: ProviderId, nativeId: string, updatedAt: number, cwd = '/exists/proj'): HistoryEntry => ({ provider, nativeId, title: `chat ${nativeId}`, cwd, createdAt: updatedAt - 1000, updatedAt })
  const meta = (over: Partial<ThreadMeta>): ThreadMeta => ({ id: 'm', title: 't', cwd: '/exists/proj', createdAt: 1, updatedAt: 1, provider: 'claude', models: {}, efforts: {}, access: 'ask', status: 'idle', native: {}, itemCount: 0, ...over })

  it('lists unknown chats lazily, with their own dates, and never duplicates', () => {
    const known = [meta({ id: 'a', native: { codex: { id: 'x1', syncedTo: 3 } } }), meta({ id: 'b', origin: { provider: 'claude', nativeId: 'c1' }, native: {} })]
    const plan = planChatSync(known, [entry('codex', 'x1', 50_000), entry('claude', 'c1', 60_000), entry('claude', 'c2', 70_000), entry('claude', 'c2', 70_000), entry('codex', 'x9', 80_000, '/gone')], defaults)
    expect(plan.added.map((m) => m.origin?.nativeId)).toEqual(['c2', 'x9'])
    expect(plan.added[0]).toMatchObject({ lazy: true, provider: 'claude', createdAt: 69_000, updatedAt: 70_000, cwd: '/exists/proj', title: 'chat c2', native: { claude: { id: 'c2', syncedTo: 0 } } })
    expect(plan.added[1].cwd).toBe('/duet/chats')
    expect(plan.updated).toEqual([])
  })

  it('refreshes synced chats that changed at the source but leaves continued ones alone', () => {
    const lazy = meta({ id: 'l', lazy: true, origin: { provider: 'claude', nativeId: 'c1' }, sourceUpdatedAt: 10, title: 'old' })
    const pristine = meta({ id: 'p', pristine: true, origin: { provider: 'codex', nativeId: 'x1' }, sourceUpdatedAt: 10 })
    const continued = meta({ id: 'c', origin: { provider: 'claude', nativeId: 'c3' }, sourceUpdatedAt: 10 })
    const busy = meta({ id: 'b', lazy: true, status: 'running', origin: { provider: 'claude', nativeId: 'c4' }, sourceUpdatedAt: 10 })
    const plan = planChatSync([lazy, pristine, continued, busy], [entry('claude', 'c1', 20), entry('codex', 'x1', 30), entry('claude', 'c3', 40), entry('claude', 'c4', 50)], defaults)
    expect(plan.added).toEqual([])
    expect(plan.updated.map((m) => m.id)).toEqual(['l', 'p'])
    expect(plan.updated[0]).toMatchObject({ title: 'chat c1', updatedAt: 20, sourceUpdatedAt: 20, lazy: true })
    expect(plan.updated[1]).toMatchObject({ lazy: true, pristine: false, title: 't' })
  })
})

describe('duet:// links', () => {
  const token = 'a'.repeat(64)
  it('opens folders and drafts prompts, sending only with the secret', () => {
    expect(parseDeepLink('duet://open?cwd=%2FUsers%2Fme%2Fproj&prompt=fix%20it', token)).toEqual({ kind: 'open', cwd: '/Users/me/proj', prompt: 'fix it', provider: undefined, model: undefined, send: false })
    expect(parseDeepLink(`duet://open?cwd=/p&prompt=go&send=1&token=${token}&provider=codex&model=gpt-5.5`, token)).toMatchObject({ send: true, provider: 'codex', model: 'gpt-5.5' })
    expect(parseDeepLink(`duet://open?cwd=/p&prompt=go&send=1&token=${'b'.repeat(64)}`, token)).toMatchObject({ send: false })
    expect(parseDeepLink('duet://open?cwd=relative/path&provider=evil&model=a b', token)).toMatchObject({ cwd: undefined, provider: undefined, model: undefined, send: false })
    expect(parseDeepLink('duet://thread?id=abc-123', token)).toEqual({ kind: 'thread', id: 'abc-123' })
    expect(parseDeepLink('duet://usage', token)).toEqual({ kind: 'view', view: 'usage' })
    expect(parseDeepLink('duet://format-disk', token)).toBeNull()
    expect(parseDeepLink('https://duet/open', token)).toBeNull()
    expect(parseDeepLink('not a url', token)).toBeNull()
  })
})

describe('usage', () => {
  const file = (provider: ProviderId): FileUsage => ({ provider, session: 's', size: 0, mtimeMs: 0, offset: 0, buckets: {} })
  const day = (iso: string) => {
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('counts each Claude response once and turns cost snapshots into daily cost', () => {
    const f = file('claude')
    const line = (id: string, block: number) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-06T10:00:00Z', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } }, apiBlockIndex: block })
    for (const l of [line('m1', 0), line('m1', 1), line('m1', 2), line('m2', 0)]) readClaudeLine(l, f)
    readClaudeLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-06T10:00:00Z', message: { id: 'm3', model: '<synthetic>', usage: { output_tokens: 1 } } }), f)
    readClaudeLine(JSON.stringify({ type: 'cost-state', modelUsage: { 'claude-opus-5-5': { costUSD: 0.5 } } }), f)
    readClaudeLine(JSON.stringify({ type: 'cost-state', modelUsage: { 'claude-opus-5-5': { costUSD: 0.75 } } }), f)
    readClaudeLine('{broken', f)
    const b = f.buckets[`${day('2026-10-06T10:00:00Z')}|claude-opus-5-5`]
    expect(b).toMatchObject({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 40, turns: 2 })
    expect(b.costUsd).toBeCloseTo(0.75)
  })

  it('prefers Codex usage records and otherwise counts token totals as deltas', () => {
    const records = file('codex')
    readCodexLine(JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5' } }), records)
    readCodexLine(JSON.stringify({ timestamp: '2026-10-06T10:00:00Z', type: 'token_usage_record', payload: { turn_id: 't1', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } } }), records)
    readCodexLine(JSON.stringify({ timestamp: '2026-10-06T10:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9999, cached_input_tokens: 0, output_tokens: 9999 } } } }), records)
    expect(records.buckets[`${day('2026-10-06T10:00:00Z')}|gpt-5.5`]).toMatchObject({ inputTokens: 400, cacheReadTokens: 600, outputTokens: 50, turns: 1 })

    const counts = file('codex')
    const count = (input: number, cached: number, output: number) => JSON.stringify({ timestamp: '2026-10-06T11:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } })
    readCodexLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-old' } }), counts)
    for (const l of [count(100, 50, 10), count(300, 150, 30), count(300, 150, 30)]) readCodexLine(l, counts) // the repeat after compaction adds nothing
    expect(counts.buckets[`${day('2026-10-06T11:00:00Z')}|gpt-old`]).toMatchObject({ inputTokens: 150, cacheReadTokens: 150, outputTokens: 30, turns: 2 })
  })

  it('reads only what was appended, never half a line, and maps subagents to their session', () => {
    const root = tmp('usage')
    const projects = join(root, 'claude')
    const session = join(projects, '-proj', 'sess-1.jsonl')
    const sub = join(projects, '-proj', 'sess-1', 'subagents', 'agent-abc.jsonl')
    mkdirSync(join(projects, '-proj', 'sess-1', 'subagents'), { recursive: true })
    const line = (id: string, out: number) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: 'claude-x', usage: { input_tokens: 1, output_tokens: out } } }) + '\n'
    writeFileSync(session, line('a', 10) + line('b', 20).slice(0, 30)) // second line still being written
    writeFileSync(sub, line('s', 5))
    let cache = scanAll(projects, [], { version: 1, scannedAt: 0, files: {} })
    const total = () => Object.values(cache.files).reduce((n, f) => n + Object.values(f.buckets).reduce((m, b) => m + b.outputTokens, 0), 0)
    expect(total()).toBe(15)
    expect(cache.files[sub].session).toBe('sess-1')
    appendFileSync(session, line('b', 20).slice(30) + line('c', 40))
    utimesSync(session, new Date(), new Date(Date.now() + 5000))
    cache = scanAll(projects, [], cache)
    expect(total()).toBe(75)
    // Nothing changed: the cached entry is reused as is.
    const again = scanFile(session, 'claude', cache.files[session])
    expect(again).toBe(cache.files[session])
  })

  it('separates Duet chats from use outside Duet', async () => {
    const root = tmp('usage-svc')
    const projects = join(root, 'claude')
    mkdirSync(join(projects, 'p'), { recursive: true })
    const line = (id: string) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: 'claude-x', usage: { input_tokens: 0, output_tokens: 10 } } }) + '\n'
    writeFileSync(join(projects, 'p', 'duet-session.jsonl'), line('a'))
    writeFileSync(join(projects, 'p', 'other-session.jsonl'), line('b'))
    const updates: number[] = []
    const svc = new UsageService(join(root, 'cache.json'), () => ({ claudeProjects: projects, codexRoots: [] }), null, () => updates.push(1))
    await svc.scan()
    expect(updates).toHaveLength(1)
    const duetOnly = svc.summary(7, new Set(['claude:duet-session']), false)
    expect(duetOnly.days.map((d) => [d.source, d.outputTokens])).toEqual([['duet', 10]])
    const all = svc.summary(7, new Set(['claude:duet-session']), true)
    expect(all.days.reduce((n, d) => n + d.outputTokens, 0)).toBe(20)
    expect(existsSync(join(root, 'cache.json'))).toBe(true)
    // The cache survives a restart.
    expect(new UsageService(join(root, 'cache.json'), () => ({ claudeProjects: projects, codexRoots: [] }), null, () => undefined).summary(7, new Set(), true).days).toHaveLength(1)
  })
})

describe('storage', () => {
  it('finds attachments nothing uses any more, keeping drafts and recent files', async () => {
    const root = tmp('storage')
    const ctx = { threadsDir: join(root, 'threads'), attachmentsDir: join(root, 'attachments'), safetyDir: join(root, 'sync-backups'), logsDir: join(root, 'logs'), cacheDir: join(root, 'cache') }
    for (const d of Object.values(ctx)) mkdirSync(d, { recursive: true })
    const old = (name: string) => {
      const p = join(ctx.attachmentsDir, name)
      writeFileSync(p, 'x'.repeat(100))
      utimesSync(p, new Date(Date.now() - 3 * 86_400_000), new Date(Date.now() - 3 * 86_400_000))
      return p
    }
    const used = old('used.png')
    const draft = old('draft.png')
    old('orphan.png')
    writeFileSync(join(ctx.attachmentsDir, 'fresh.png'), 'new')
    writeFileSync(join(ctx.threadsDir, 't1.json'), JSON.stringify({ meta: {}, items: [{ kind: 'tool', images: [used] }] }))
    writeFileSync(join(ctx.threadsDir, 'index.json'), '[]')
    const unused = await unusedAttachments(ctx, [draft])
    expect(unused.map((f) => f.path.split('/').pop())).toEqual(['orphan.png'])
    mkdirSync(join(ctx.safetyDir, 'old-run'))
    utimesSync(join(ctx.safetyDir, 'old-run'), new Date(Date.now() - 40 * 86_400_000), new Date(Date.now() - 40 * 86_400_000))
    mkdirSync(join(ctx.safetyDir, 'new-run'))
    expect(oldSafetyCopies(ctx).map((f) => f.path.split('/').pop())).toEqual(['old-run'])
    const stats = await storageStats(ctx, [draft])
    expect(stats).toMatchObject({ threads: { count: 1 }, attachments: { count: 4 }, unused: { count: 1, bytes: 100 } })
  })
})

describe('command line', () => {
  const saved = process.env.DUET_CLI_DIR
  afterEach(() => {
    if (saved === undefined) delete process.env.DUET_CLI_DIR
    else process.env.DUET_CLI_DIR = saved
  })

  it('installs a small script, never over somebody else’s duet', () => {
    const dir = tmp('cli')
    process.env.DUET_CLI_DIR = dir
    expect(cliStatus(`/usr/bin:${dir}`)).toEqual({ installed: false, path: join(dir, 'duet'), onPath: true })
    const status = installCli("/Applications/Duet's.app", '/usr/bin')
    expect(status).toMatchObject({ installed: true, onPath: false })
    const script = readFileSync(join(dir, 'duet'), 'utf8')
    expect(script).toContain("DUET_APP='/Applications/Duet'\\''s.app'")
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(cliScript('/A.app').startsWith('#!/bin/sh')).toBe(true)
    expect(uninstallCli('/usr/bin').installed).toBe(false)
    writeFileSync(join(dir, 'duet'), '#!/bin/sh\necho someone else\n')
    expect(() => installCli('/Applications/Duet.app', '')).toThrow(/isn't Duet's/)
    expect(uninstallCli('').installed).toBe(false)
    expect(readFileSync(join(dir, 'duet'), 'utf8')).toContain('someone else')
  })
})

/** An agent the test drives by hand. */
class Agent implements ProviderAdapter {
  emit: Emit = () => undefined
  requests: TurnRequest[] = []
  constructor(readonly id: ProviderId) {}
  async status(): Promise<ProviderStatus> {
    return { id: this.id, installed: true, models: [], limits: [] }
  }
  async startTurn(req: TurnRequest, emit: Emit) {
    this.requests.push(req)
    this.emit = emit
  }
  async interrupt() {}
  respond() {
    return false
  }
  async commands() {
    return []
  }
  release() {}
  async shutdown() {}
}

function orchestrate(agents: Partial<Record<ProviderId, ProviderAdapter>> = {}) {
  const dir = tmp('orch')
  const store = new Store(dir)
  const events: DuetEvent[] = []
  const orch = new Orchestrator({ store, adapters: { claude: agents.claude ?? new FakeAdapter('claude', 50), codex: agents.codex ?? new FakeAdapter('codex', 50) }, broadcast: (e) => events.push(e) })
  return { dir, store, orch, events }
}

describe('store and lazy chats', () => {
  it('keeps only a few chats in memory, but never one with unsaved changes or an agent at work', () => {
    const { store, orch } = orchestrate()
    const ids = Array.from({ length: 12 }, () => orch.create({ cwd: tmpdir() }).id)
    store.flush()
    store.isBusy = (id) => id === ids[0]
    for (const id of ids) store.getItems(id)
    const cached = (store as unknown as { items: Map<string, unknown> }).items
    expect(cached.size).toBeLessThanOrEqual(8)
    expect(cached.has(ids[0])).toBe(true)
    // Evicted chats come back from disk unchanged.
    expect(store.getItems(ids[1])).toEqual([])
  })

  it('lists synced chats without files and loads them when opened', async () => {
    const claude = new Agent('claude')
    const { orch, store, dir, events } = orchestrate({ claude })
    const lazy: ThreadMeta = { id: 'lazy-1', title: 'From Claude Code', cwd: tmpdir(), createdAt: 1, updatedAt: 2, provider: 'claude', models: {}, efforts: {}, access: 'ask', status: 'idle', native: { claude: { id: 'native-1', syncedTo: 0 } }, origin: { provider: 'claude', nativeId: 'native-1' }, lazy: true, itemCount: 0 }
    orch.upsertSynced([lazy])
    expect(events.find((e) => e.type === 'threads-bulk')).toMatchObject({ metas: [{ id: 'lazy-1' }] })
    store.flush()
    expect(existsSync(join(dir, 'threads', 'lazy-1.json'))).toBe(false)
    expect(new Store(dir).getMeta('lazy-1')?.lazy).toBe(true)
    await expect(orch.send('lazy-1', { text: 'hi', attachments: [] })).rejects.toThrow(/loading/)
    const items: TimelineItem[] = [
      { kind: 'user', id: 'u', ts: 1, provider: 'claude', text: 'old question', attachments: [] },
      { kind: 'assistant', id: 'a', ts: 2, provider: 'claude', text: 'old answer' }
    ]
    await Promise.all([orch.hydrate('lazy-1', async () => items), orch.hydrate('lazy-1', async () => items)])
    const thread = orch.get('lazy-1')!
    expect(thread).toMatchObject({ lazy: false, pristine: true, preview: 'old answer', itemCount: 2 })
    expect(thread.native.claude?.syncedTo).toBe(2)
    await orch.send('lazy-1', { text: 'new question', attachments: [] })
    expect(orch.get('lazy-1')?.pristine).toBe(false)
    expect(claude.requests[0].nativeId).toBe('native-1')
  })

  it('gives agents the personality, and Codex its skills, reviews and Fast mode', async () => {
    const claude = new Agent('claude')
    const codex = new Agent('codex')
    const { orch, store } = orchestrate({ claude, codex })
    store.updateSettings({ personality: { preset: 'concise', custom: '', providers: ['codex'] } })
    const a = orch.create({ cwd: tmpdir(), provider: 'claude' })
    await orch.send(a.id, { text: 'hi', attachments: [], skills: [{ name: 's', path: '/s' }], review: { type: 'uncommittedChanges' } })
    expect(claude.requests[0]).toMatchObject({ instructions: undefined, skills: undefined, review: undefined, fast: false })
    const b = orch.create({ cwd: tmpdir(), provider: 'codex' })
    orch.update(b.id, { fast: true })
    await orch.send(b.id, { text: '/review main', attachments: [], skills: [{ name: 'deploy', path: '/skills/deploy' }], review: { type: 'baseBranch', branch: 'main' } })
    expect(codex.requests[0]).toMatchObject({ skills: [{ name: 'deploy', path: '/skills/deploy' }], review: { type: 'baseBranch', branch: 'main' }, fast: true })
    expect(codex.requests[0].instructions).toMatch(/concise/)
    expect(orch.get(b.id)!.items.find((i) => i.kind === 'user')).toMatchObject({ skills: ['deploy'] })
  })
})

describe('commands', () => {
  it('parses commands and review targets', () => {
    expect(parseCommand('/theme dark waves')).toEqual({ name: 'theme', args: 'dark waves' })
    expect(parseCommand('/compact')).toEqual({ name: 'compact', args: '' })
    expect(parseCommand('not a command')).toBeNull()
    expect(reviewTarget('')).toEqual({ type: 'uncommittedChanges' })
    expect(reviewTarget('a1b2c3d')).toEqual({ type: 'commit', sha: 'a1b2c3d' })
    expect(reviewTarget('origin/main')).toEqual({ type: 'baseBranch', branch: 'origin/main' })
    expect(reviewTarget('focus on security')).toEqual({ type: 'custom', instructions: 'focus on security' })
  })

  it('merges agent commands and ranks matches', () => {
    const claude = agentCommands('claude', [{ name: 'clear', description: '' }, { name: 'compact', description: 'Compact' }, { name: 'my-skill', description: 'Mine' }])
    expect(claude.map((c) => c.name)).toEqual(['compact', 'my-skill'])
    expect(claude[0].kind).toBe('send')
    const codex = agentCommands('codex', [{ name: 'review', description: 'Review' }, { name: 'deploy', description: 'Ship', kind: 'skill', path: '/p' }])
    expect(codex.map((c) => c.kind)).toEqual(['run', 'skill'])
    const ranked = rankCommands([...DUET_COMMANDS, ...claude], 'com')
    expect(ranked[0].name).toBe('compact')
    expect(rankCommands(DUET_COMMANDS, 'zzz')).toEqual([])
  })
})

describe('model slider', () => {
  // What Claude Code and Codex actually report on this Mac (2026-10-06).
  const claude = [
    { id: 'default', label: 'Default', description: 'Opus 5.5 · Best for everyday, complex tasks', isDefault: true },
    { id: 'opus', label: 'Opus 5.5', description: 'Best for everyday, complex tasks' },
    { id: 'fable', label: 'Fable 5.1', description: 'Most capable for your hardest and longest-running tasks' },
    { id: 'sonnet', label: 'Sonnet 5.5', description: 'Efficient for routine tasks' },
    { id: 'haiku', label: 'Haiku 4.5', description: 'Fastest for quick answers' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Efficient for routine tasks' },
    { id: 'claude-opus-4-7', label: 'Opus 4.7', description: 'Best for everyday, complex tasks' }
  ]
  const codex = [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', isDefault: true },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.' },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol', description: 'Previous generation workhorse model.' },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Older fast and efficient model.' }
  ]

  it('orders each agent\'s families from fastest to most capable, newest of each', () => {
    const c = modelLadder(claude)
    expect(c.stops.map((m) => m.id)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(c.recommended).toBe(2) // Claude's Default is Opus 5.5
    const x = modelLadder(codex)
    expect(x.stops.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']) // older generations stay in the list only
    expect(x.recommended).toBe(1)
    expect(x.stops.map((m) => shortModelName(m.label))).toEqual(['Luna', 'Sol', 'Astra'])
    expect(shortModelName('Opus 5.5')).toBe('Opus')
  })

  it('places a model that isn\'t a stop on its family, and skips the slider when there is nothing to compare', () => {
    const { stops } = modelLadder(claude)
    expect(ladderIndex(stops, claude.find((m) => m.id === 'claude-opus-4-7'))).toEqual({ index: 2, exact: false })
    expect(ladderIndex(stops, claude.find((m) => m.id === 'haiku'))).toEqual({ index: 0, exact: true })
    expect(modelLadder([{ id: 'x', label: 'Mystery' }, { id: 'y', label: 'Other' }]).stops).toEqual([])
    expect(modelTier({ id: 'gpt-5-nano', label: 'nano' })).toBe(0)
  })

  it('keeps pinned and missing families near the right stop without claiming an exact match', () => {
    const c = modelLadder(claude)
    expect(ladderIndex(c.stops, { id: 'claude-haiku-unlisted', label: 'Pinned Haiku' })).toEqual({ index: 0, exact: false })
    const x = modelLadder(codex)
    expect(ladderIndex(x.stops, codex.find((m) => m.id === 'gpt-5.6-terra'))).toEqual({ index: 0, exact: false, approximate: true })
    expect(ladderIndex(x.stops, { id: 'unknown', label: 'Unknown' })).toBeNull()
  })

  it('ranks capability before speed marketing and gives demo models distinct captions', () => {
    expect(modelTier({ id: 'gpt-5.1-codex-max', label: 'Codex Max', description: 'Flagship coding model, fast on complex tasks' })).toBe(4)
    expect(modelTier({ id: 'x', label: 'X', description: 'Fast, capable model for everyday work' })).toBe(3)
    expect(modelTier({ id: 'x', label: 'X', description: 'A quick-thinking model for complex tasks' })).toBe(3)
    expect(shortModelName('GPT (demo)')).toBe('GPT')
    expect(shortModelName('GPT mini (demo)')).toBe('mini')
  })
})

describe('work log', () => {
  const tool = (id: string, title: string): TimelineItem => ({ kind: 'tool', id, ts: 1, provider: 'codex', tool: 'read', title, status: 'done' }) as TimelineItem
  const approval = (id: string, status: string, request = 'command'): TimelineItem => ({ kind: 'approval', id, ts: 1, provider: 'codex', request, title: 'Run this command?', command: 'cat x', status, canAllowForSession: true }) as TimelineItem

  it('approved requests fold into the steps instead of splitting them; declined ones stay visible', () => {
    const items = [tool('t1', 'a.md'), approval('a1', 'approved-session'), tool('t2', 'b.md'), approval('a2', 'approved'), tool('t3', 'c.md'), approval('a3', 'denied'), tool('t4', 'd.md')]
    const blocks = buildBlocks(items)
    expect(blocks.map((b) => b.type)).toEqual(['work', 'item', 'work'])
    const first = blocks[0]
    expect(first.type === 'work' && summarize(first.entries)).toBe('Read 3 files')
    expect(blocks[1].type === 'item' && blocks[1].item.id).toBe('a3')
    // Questions and plans are part of the conversation, so they always show.
    expect(buildBlocks([approval('q', 'approved', 'question'), approval('p', 'approved', 'plan')]).length).toBe(2)
  })

  it('keeps approved path and capability grants visible', () => {
    const pathGrant = { ...approval('path', 'approved-session', 'edit'), permissionGrant: true } as TimelineItem
    const blocks = buildBlocks([tool('t1', 'a.md'), approval('network', 'approved', 'permissions'), pathGrant, tool('t2', 'b.md')])
    expect(blocks.map((b) => b.type)).toEqual(['work', 'item', 'item', 'work'])
    expect(blocks[1].type === 'item' && blocks[1].item.id).toBe('network')
    expect(blocks[2].type === 'item' && blocks[2].item.id).toBe('path')
  })
})

describe('agent adapters', () => {
  it('Codex: one-off answers in throwaway threads, sign-in, review, compact, skills and usage', async () => {
    const theme = JSON.stringify({ name: 'From Codex', base: 'dark', colors: { bg: '#101010', fg: '#eeeeee', accent: '#22d3ee' } })
    const adapter = new CodexAdapter({ binary: () => fixture('fake-codex.mjs'), env: () => ({ ...process.env, FAKE_CODEX_ANSWER: theme }), appVersion: 'test' })
    try {
      expect(JSON.parse(await adapter.oneShot('design a theme', { outputSchema: { type: 'object' } }))).toMatchObject({ name: 'From Codex' })
      let signedIn: boolean | null = null
      expect(await adapter.login((ok) => (signedIn = ok))).toBe('https://auth.example.test/login')
      await adapter.rpcRequest('test/emit', { method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null } })
      await until(() => signedIn !== null)
      expect(signedIn).toBe(true)

      const events: RuntimeEvent[] = []
      const req: TurnRequest = { threadId: 'd1', cwd: tmpdir(), access: 'ask', text: '/review', attachments: [], review: { type: 'uncommittedChanges' }, instructions: 'Be brief.', fast: true }
      await adapter.startTurn(req, (e) => events.push(e))
      await until(() => events.some((e) => e.type === 'turn-end'))
      expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'completed' })
      expect(events.find((e) => e.type === 'item' && e.item.kind === 'assistant')).toMatchObject({ item: { text: 'No issues found in the diff.' } })

      const compacted: RuntimeEvent[] = []
      await adapter.compact('d1', (e) => compacted.push(e))
      await until(() => compacted.some((e) => e.type === 'turn-end'))
      expect(compacted.find((e) => e.type === 'item')).toMatchObject({ item: { kind: 'notice', text: 'Context compacted' } })

      const commands = await adapter.commands(tmpdir())
      expect(commands.map((c) => c.name)).toEqual(['review', 'compact', 'init', 'deploy'])
      expect(commands.find((c) => c.name === 'deploy')).toMatchObject({ kind: 'skill', path: '/skills/deploy/SKILL.md', description: 'Ship it' })
      expect(commands.find((c) => c.name === 'init')?.prompt).toMatch(/AGENTS\.md/)

      expect(await adapter.accountUsage()).toMatchObject({ lifetimeTokens: 123456, currentStreakDays: 3, daily: [{ day: '2026-10-05', tokens: 500 }] })

      const sent = ((await adapter.rpcRequest('test/requests', {})) as { received: { method: string; params: Record<string, unknown> }[] }).received
      expect(sent.find((r) => r.method === 'thread/start' && r.params.ephemeral)).toMatchObject({ params: { ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' } })
      expect(sent.find((r) => r.method === 'turn/start')?.params.outputSchema).toEqual({ type: 'object' })
      expect(sent.find((r) => r.method === 'thread/start' && !r.params.ephemeral)?.params.developerInstructions).toBe('Be brief.')
      expect(sent.find((r) => r.method === 'review/start')?.params).toMatchObject({ target: { type: 'uncommittedChanges' }, delivery: 'inline' })
    } finally {
      await adapter.shutdown()
    }
  })

  it('Codex: Stop during a review stops the review', async () => {
    // A review runs as an inner turn: Stop has to name that one, and the end arrives under the outer id.
    const adapter = new CodexAdapter({ binary: () => fixture('fake-codex.mjs'), env: () => ({ ...process.env, FAKE_CODEX_REVIEW_MS: '60000' }), appVersion: 'test', interruptGraceMs: 60_000 })
    try {
      const events: RuntimeEvent[] = []
      await adapter.startTurn({ threadId: 'r', cwd: tmpdir(), access: 'ask', text: '/review', attachments: [], review: { type: 'uncommittedChanges' } }, (e) => events.push(e))
      await until(() => events.some((e) => e.type === 'item' && e.item.kind === 'notice'))
      await adapter.interrupt('r')
      await until(() => events.some((e) => e.type === 'turn-end'))
      expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'interrupted' })
      const sent = ((await adapter.rpcRequest('test/requests', {})) as { received: { method: string; params: Record<string, unknown> }[] }).received
      expect(sent.filter((r) => r.method === 'turn/interrupt').at(-1)?.params.turnId).toMatch(/-review$/)
    } finally {
      await adapter.shutdown()
    }
  })

  it('Codex: skills go along with a message and Fast mode asks for the priority tier', async () => {
    const adapter = new CodexAdapter({ binary: () => fixture('fake-codex.mjs'), env: () => process.env, appVersion: 'test' })
    try {
      await adapter.startTurn({ threadId: 'd2', cwd: tmpdir(), access: 'ask', text: 'ship it', attachments: [], skills: [{ name: 'deploy', path: '/skills/deploy/SKILL.md' }], fast: true }, () => undefined)
      const sent = ((await adapter.rpcRequest('test/requests', {})) as { received: { method: string; params: Record<string, unknown> }[] }).received
      const turn = sent.find((r) => r.method === 'turn/start')!.params
      expect(turn.serviceTier).toBe('priority')
      expect(turn.input).toEqual([{ type: 'text', text: 'ship it', text_elements: [] }, { type: 'skill', name: 'deploy', path: '/skills/deploy/SKILL.md' }])
    } finally {
      await adapter.shutdown()
    }
  })

  it('Claude: one-off answers without tools or saved sessions, personality, and login checks', async () => {
    const argsFile = join(tmp('claude-args'), 'args.jsonl')
    const adapter = new ClaudeAdapter({
      binary: () => fixture('fake-claude.mjs'),
      env: () => ({ ...process.env, FAKE_CLAUDE_ANSWER: '{"name":"From Claude"}', FAKE_CLAUDE_ARGS_FILE: argsFile, FAKE_CLAUDE_LOGGED_IN: '1' }),
      attachmentsDir: tmpdir(),
      prepareImage: () => null
    })
    try {
      expect(await adapter.oneShot('hello')).toBe('{"name":"From Claude"}')
      expect(await adapter.loginStatus()).toBe(true)
      const req: TurnRequest = { threadId: 't', cwd: tmpdir(), access: 'ask', text: 'hi', attachments: [], instructions: 'Be concise.' }
      await adapter.startTurn(req, () => undefined)
      await adapter.interrupt('t')
      const runs = readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
      const oneShot = runs.find((a) => a.includes('-p') && !a.includes('stream-json'))!
      for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) expect(oneShot).toContain(flag)
      expect(oneShot[oneShot.indexOf('--tools') + 1]).toBe('')
      expect(oneShot[oneShot.indexOf('--setting-sources') + 1]).toBe('')
      expect(oneShot).toContain('env:MAX_THINKING_TOKENS=0') // thinking would make a theme take ~4× longer
      const stream = runs.find((a) => a.includes('stream-json'))!
      expect(stream[stream.indexOf('--append-system-prompt') + 1]).toBe('Be concise.')
    } finally {
      await adapter.shutdown()
    }
    const signedOut = new ClaudeAdapter({ binary: () => fixture('fake-claude.mjs'), env: () => ({ ...process.env, FAKE_CLAUDE_LOGGED_IN: '0' }), attachmentsDir: tmpdir(), prepareImage: () => null })
    expect(await signedOut.loginStatus()).toBe(false)
  })

  it('Claude: output of commands like /context shows up as a reply', () => {
    const sent: RuntimeEvent[] = []
    const m = new ClaudeMapper({ cwd: '/repo', emit: (e) => sent.push(e) })
    m.beginTurn()
    m.handle({ type: 'result', subtype: 'success', is_error: false, result: 'Context: 12k / 200k', local_command: 'context', num_turns: 0, uuid: 'r1' })
    expect(sent[0]).toMatchObject({ type: 'item', item: { kind: 'assistant', text: 'Context: 12k / 200k' } })
    const again: RuntimeEvent[] = []
    const m2 = new ClaudeMapper({ cwd: '/repo', emit: (e) => again.push(e) })
    m2.beginTurn()
    m2.handle({ type: 'system', subtype: 'local_command_output', content: 'Output style set to Concise', uuid: 'x' })
    m2.handle({ type: 'result', subtype: 'success', result: 'Output style set to Concise', local_command: 'output-style' })
    expect(again.filter((e) => e.type === 'item')).toHaveLength(1)
  })
})
