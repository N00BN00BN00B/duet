/**
 * Live checks for the Duet 2 features against the real Claude Code and Codex on this Mac.
 * Opt-in (`npm run test:live`); tiny prompts on cheap models. User data is only read.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProviderStatus, TimelineItem } from '../../src/shared/types'
import { findBinary, getEnv, loadShellEnv } from '../../src/main/env'
import { ClaudeAdapter } from '../../src/main/providers/claude/adapter'
import { CodexAdapter } from '../../src/main/providers/codex/adapter'
import type { Emit, RuntimeEvent, TurnRequest } from '../../src/main/providers/types'
import { generateTheme } from '../../src/main/features/themeGen'
import { emptyCache, scanAll } from '../../src/main/features/usageScan'
import { claudeHome, codexHome, listClaudeSessions, listCodexThreads } from '../../src/main/features/history'
import { planChatSync } from '../../src/main/features/chatSync'

const LIVE = !!process.env.DUET_LIVE
const time = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
  const t = performance.now()
  const out = await fn()
  console.log(`${label}: ${Math.round(performance.now() - t)}ms`)
  return out
}

/** Runs one turn and collects its events, with streamed text folded into the items. */
function run(adapter: { startTurn: (req: TurnRequest, emit: Emit) => Promise<void> }, req: TurnRequest, onApproval?: (item: TimelineItem) => void) {
  const events: RuntimeEvent[] = []
  const items = new Map<string, TimelineItem>()
  let resolve!: () => void
  const ended = new Promise<void>((r) => (resolve = r))
  const out = { events, approvals: 0, done: Promise.resolve(), text: () => '' }
  const emit: Emit = (e) => {
    events.push(e)
    if (e.type === 'item') {
      if (e.item.kind === 'approval' && e.item.status === 'pending' && !items.has(e.item.id)) {
        out.approvals++
        const item = e.item
        if (onApproval) setTimeout(() => onApproval(item), 50)
      }
      items.set(e.item.id, e.item)
    }
    if (e.type === 'delta') {
      const it = items.get(e.itemId)
      if (it && (it.kind === 'assistant' || it.kind === 'reasoning')) items.set(it.id, { ...it, text: it.text + e.delta })
    }
    if (e.type === 'turn-end') resolve()
  }
  out.text = () =>
    [...items.values()]
      .map((i) => (i.kind === 'assistant' ? i.text : ''))
      .filter(Boolean)
      .join('\n')
  out.done = adapter.startTurn(req, emit).then(() => ended)
  return out
}

describe.skipIf(!LIVE)('live: Claude Code (Duet 2)', () => {
  let claude: ClaudeAdapter
  let project: string

  beforeAll(async () => {
    await loadShellEnv()
    project = realpathSync(mkdtempSync(join(tmpdir(), 'duet-live-claude2-')))
    claude = new ClaudeAdapter({ binary: () => findBinary('claude'), env: getEnv, attachmentsDir: project, prepareImage: () => null })
  }, 60_000)

  afterAll(async () => {
    await claude?.shutdown()
  })

  it('designs a theme in a throwaway run that leaves no session behind', async () => {
    const sessions = join(claudeHome(), 'projects', homedir().replace(/[^a-zA-Z0-9]/g, '-'))
    const before = existsSync(sessions) ? readdirSync(sessions).length : 0
    const result = await time('claude theme', () => generateTheme('dark gradient with a wave effect', [{ id: 'claude', ready: true, ask: (p) => claude.oneShot(p, { timeoutMs: 120_000 }) }]))
    expect(result.via).toBe('claude')
    expect(result.theme.base).toBe('dark')
    expect(result.theme.colors.bg).toMatch(/^#[0-9a-f]{6}$/)
    console.log('Claude designed:', result.theme.name, result.theme.background.effect, result.theme.colors.accent)
    expect(existsSync(sessions) ? readdirSync(sessions).length : 0).toBe(before)
  }, 180_000)

  it('follows the personality it was started with', async () => {
    const turn = run(claude, { threadId: 'p1', cwd: project, access: 'ask', model: 'haiku', text: 'Say hello in five words or fewer.', attachments: [], instructions: 'Always end every reply with the single word PINEAPPLE in capitals.' })
    await turn.done
    expect(turn.text()).toMatch(/PINEAPPLE/)
  }, 180_000)

  it('reports sign-in status without starting a session', async () => {
    expect(await claude.loginStatus()).toBe(true)
  })
})

describe.skipIf(!LIVE)('live: Codex (Duet 2)', () => {
  let codex: CodexAdapter
  let status: ProviderStatus
  let model: string | undefined
  let repo: string
  const created: string[] = []

  beforeAll(async () => {
    await loadShellEnv()
    codex = new CodexAdapter({ binary: () => findBinary('codex'), env: getEnv, appVersion: '1.0.0-test' })
    status = await codex.status(true)
    model = status.models.find((m) => /luna|mini/i.test(m.id))?.id ?? status.defaultModel
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'duet-live-codex2-')))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    git('init', '-q')
    git('-c', 'user.email=test@duet.local', '-c', 'user.name=Duet Test', 'commit', '-q', '--allow-empty', '-m', 'start')
    writeFileSync(join(repo, 'math.js'), 'export function add(a, b) {\n  return a - b\n}\n')
  }, 120_000)

  afterAll(async () => {
    for (const id of created) await codex.rpcRequest('thread/archive', { threadId: id }, 15_000).catch(() => undefined)
    await codex?.shutdown()
  }, 60_000)

  const track = (events: RuntimeEvent[]) => {
    for (const e of events) if (e.type === 'native-id' && !created.includes(e.nativeId)) created.push(e.nativeId)
  }

  it('designs a theme in a thread Codex never saves', async () => {
    const list = async () => ((await codex.rpcRequest('thread/list', { limit: 20, sortKey: 'created_at', sortDirection: 'desc' }, 30_000)) as { data: { id: string }[] }).data.map((t) => t.id)
    const before = await list()
    const result = await time('codex theme', () => generateTheme('calm light paper theme', [{ id: 'codex', ready: true, ask: (p, schema) => codex.oneShot(p, { outputSchema: schema, timeoutMs: 120_000 }) }]))
    expect(result.via).toBe('codex')
    expect(result.theme.base).toBe('light')
    console.log('Codex designed:', result.theme.name, result.theme.background.effect, result.theme.colors.accent)
    const after = await list()
    expect(after.filter((id) => !before.includes(id))).toEqual([])
  }, 180_000)

  it('reviews uncommitted changes and finds the bug', async () => {
    const started = Date.now()
    const turn = run(codex, { threadId: 'r1', cwd: repo, access: 'ask', model, text: '/review', attachments: [], review: { type: 'uncommittedChanges' } }, (item) => codex.respond('r1', item.id, { kind: 'allow' }))
    await turn.done
    track(turn.events)
    const review = turn.text()
    const steps = turn.events.filter((e) => e.type === 'item' && e.item.kind === 'tool').length
    console.log(`Codex review (${Math.round((Date.now() - started) / 1000)}s, ${steps} tool events, ${turn.approvals} approvals):`, review.slice(0, 200).replace(/\s+/g, ' '))
    expect(turn.events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'completed' })
    expect(review).toMatch(/sum|subtract|add/i)
  }, 900_000)

  it('stops a review when asked', async () => {
    const turn = run(codex, { threadId: 'r2', cwd: repo, access: 'ask', model, text: '/review', attachments: [], review: { type: 'uncommittedChanges' } }, (item) => codex.respond('r2', item.id, { kind: 'allow' }))
    const start = Date.now()
    while (!turn.events.some((e) => e.type === 'item' && e.item.kind === 'notice') && Date.now() - start < 60_000) await new Promise((r) => setTimeout(r, 100))
    await new Promise((r) => setTimeout(r, 1500))
    const stopped = Date.now()
    await codex.interrupt('r2')
    await turn.done
    track(turn.events)
    console.log(`review stopped in ${Date.now() - stopped}ms`)
    expect(turn.events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'interrupted' })
    expect(Date.now() - stopped).toBeLessThan(9000) // Codex ended it, not Duet's 10s fallback
  }, 180_000)

  it('follows the personality and compacts on request', async () => {
    const turn = run(codex, { threadId: 'p2', cwd: repo, access: 'ask', model, effort: 'low', text: 'Say hello in five words or fewer.', attachments: [], instructions: 'Always end every reply with the single word PINEAPPLE in capitals.' })
    await turn.done
    track(turn.events)
    expect(turn.text()).toMatch(/PINEAPPLE/)
    const compact = run({ startTurn: (_req, emit) => codex.compact('p2', emit) }, { threadId: 'p2', cwd: repo, access: 'ask', text: '', attachments: [] })
    await compact.done
    expect(compact.events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'completed' })
    expect(compact.events.some((e) => e.type === 'item' && e.item.kind === 'notice')).toBe(true)
  }, 300_000)

  it('sends a message with a skill attached, in Fast mode', async () => {
    // A throwaway project skill in its own temp folder, so your own skills are never touched.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'duet-live-skill-')))
    mkdirSync(join(dir, '.agents', 'skills', 'duet-live-check'), { recursive: true })
    writeFileSync(join(dir, '.agents', 'skills', 'duet-live-check', 'SKILL.md'), '---\nname: duet-live-check\ndescription: Answers the Duet live check.\n---\n\nWhen this skill is used, reply with exactly: SKILL-OK\n')
    const skill = (await codex.commands(dir)).find((c) => c.name === 'duet-live-check')
    expect(skill).toMatchObject({ kind: 'skill', scope: 'repo' })
    const fast = status.models.find((m) => m.fastTier)
    const turn = run(codex, { threadId: 's1', cwd: dir, access: 'ask', model: fast?.id ?? model, effort: 'low', text: 'Use the attached skill.', attachments: [], skills: [{ name: skill!.name, path: skill!.path! }], fast: !!fast })
    await turn.done
    track(turn.events)
    console.log(`skill turn on ${fast?.id ?? model}${fast ? ' (Fast)' : ''}:`, turn.text().slice(0, 80))
    expect(turn.events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'completed' })
    expect(turn.text()).toMatch(/SKILL-OK/)
  }, 300_000)

  it('lists its commands and skills, and account usage', async () => {
    const commands = await codex.commands(repo)
    expect(commands.slice(0, 3).map((c) => c.name)).toEqual(['review', 'compact', 'init'])
    for (const skill of commands.filter((c) => c.kind === 'skill')) expect(skill.path).toMatch(/SKILL\.md$/)
    console.log(`Codex skills: ${commands.filter((c) => c.kind === 'skill').length}`)
    const usage = await codex.accountUsage()
    if (usage) {
      expect(Array.isArray(usage.daily)).toBe(true)
      console.log('Codex account:', usage.lifetimeTokens, 'tokens,', usage.currentStreakDays, 'day streak')
    }
  }, 120_000)
})

describe.skipIf(!LIVE)('real data for Duet 2 (read-only)', () => {
  it('reads all usage from Claude Code and Codex, then only what changed', async () => {
    const roots = [join(claudeHome(), 'projects'), [join(codexHome(), 'sessions'), join(codexHome(), 'archived_sessions')]] as const
    const first = await time('usage scan (cold)', () => scanAll(roots[0], [...roots[1]], emptyCache()))
    const files = Object.keys(first.files).length
    const tokens = Object.values(first.files).reduce((n, f) => n + Object.values(f.buckets).reduce((m, b) => m + b.inputTokens + b.outputTokens, 0), 0)
    console.log(`usage: ${files} files, ${tokens.toLocaleString()} tokens, cache ${Math.round(JSON.stringify(first).length / 1024)} KB`)
    expect(files).toBeGreaterThan(0)
    expect(tokens).toBeGreaterThan(0)
    const second = await time('usage scan (warm)', () => scanAll(roots[0], [...roots[1]], first))
    expect(Object.keys(second.files).length).toBeGreaterThanOrEqual(files)
  }, 600_000)

  it('plans a chat sync over every Claude Code and Codex chat', async () => {
    const codex = new CodexAdapter({ binary: () => findBinary('codex'), env: getEnv, appVersion: '1.0.0-test' })
    try {
      await loadShellEnv()
      const entries = await time('list all chats', async () => [...listClaudeSessions(), ...(await listCodexThreads((m, p, t) => codex.rpcRequest(m, p, t), 2000))])
      const plan = planChatSync([], entries, { models: {}, efforts: {}, access: 'ask', fallbackCwd: '/tmp', folderExists: existsSync })
      console.log(`chat sync: ${plan.added.length} chats (${plan.added.filter((m) => m.provider === 'claude').length} Claude, ${plan.added.filter((m) => m.provider === 'codex').length} Codex), index ${Math.round(JSON.stringify(plan.added).length / 1024)} KB`)
      expect(plan.added.length).toBeGreaterThan(0)
      expect(plan.added.every((m) => m.lazy && m.createdAt > 0 && m.updatedAt >= m.createdAt - 1000)).toBe(true)
    } finally {
      await codex.shutdown()
    }
  }, 300_000)
})
