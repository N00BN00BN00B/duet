import { appendFileSync, chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import * as tarStream from 'tar-stream'
import { parse as parseToml } from 'smol-toml'
import { describe, expect, it, vi } from 'vitest'
import type { DuetEvent, ProviderId, ProviderStatus, TimelineItem, ToolItem, TurnItem } from '../../src/shared/types'
import { Store } from '../../src/main/store'
import { Orchestrator } from '../../src/main/orchestrator'
import { FakeAdapter } from '../../src/main/providers/fake/adapter'
import type { Emit, ProviderAdapter, RuntimeEvent, TurnRequest } from '../../src/main/providers/types'
import { ClaudeAdapter } from '../../src/main/providers/claude/adapter'
import { ClaudeMapper } from '../../src/main/providers/claude/mapper'
import { CodexAdapter } from '../../src/main/providers/codex/adapter'
import { CodexThreadMapper } from '../../src/main/providers/codex/mapper'
import { BACKUP_SETS, collectFiles, createBackup, restoreBackup, type BackupContext } from '../../src/main/features/backup'
import { fakeMcpDeps } from '../../src/main/features/fakeMcp'
import { writeClaudeServer, writeCodexServer, type McpWriteDeps } from '../../src/main/features/mcp'
import { applyDelta } from '../../src/renderer/src/lib/timeline'

/* eslint-disable @typescript-eslint/no-explicit-any */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `duet-${name}-`))
const fixture = (name: string) => resolve(__dirname, '../fixtures', name)

async function until(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timed out')
    await wait(5)
  }
}

/** An agent whose turns the test drives by hand. */
class ScriptedAgent implements ProviderAdapter {
  emit: Emit = () => undefined
  active = false
  interrupts = 0
  cancels = 0
  startDelayMs = 0
  failStart?: Error

  constructor(readonly id: ProviderId) {}

  async status(): Promise<ProviderStatus> {
    return { id: this.id, installed: true, models: [], limits: [] }
  }

  async startTurn(_req: TurnRequest, emit: Emit): Promise<void> {
    this.emit = emit
    if (this.startDelayMs) await new Promise((r) => setTimeout(r, this.startDelayMs))
    if (this.failStart) throw this.failStart
    this.active = true
  }

  async interrupt(): Promise<void> {
    this.interrupts++
    if (this.active) this.end('interrupted')
  }

  cancelStart(): void {
    this.cancels++
  }

  isActive(): boolean {
    return this.active
  }

  end(status: 'completed' | 'interrupted' | 'failed', extra: { costUsd?: number } = {}): void {
    this.active = false
    this.emit({ type: 'turn-end', status, ...extra })
  }

  respond(): boolean {
    return false
  }

  async commands() {
    return []
  }

  release(): void {}

  async shutdown(): Promise<void> {}
}

function orchestrate(agents: Partial<Record<ProviderId, ProviderAdapter>> = {}) {
  const dir = tmp('robust')
  const store = new Store(dir)
  const events: DuetEvent[] = []
  const orch = new Orchestrator({
    store,
    adapters: { claude: agents.claude ?? new FakeAdapter('claude', 50), codex: agents.codex ?? new FakeAdapter('codex', 50) },
    broadcast: (e) => events.push(e)
  })
  const thread = (provider: ProviderId = 'claude') => orch.create({ cwd: tmpdir(), provider })
  return { dir, store, orch, events, thread }
}

describe('streaming', () => {
  it('keeps its own copy of items an agent goes on changing', async () => {
    const agent = new ScriptedAgent('claude')
    const { orch, thread } = orchestrate({ claude: agent })
    const meta = thread()
    await orch.send(meta.id, { text: 'hi', attachments: [] })
    const item: TimelineItem = { kind: 'assistant', id: 'a1', ts: 1, provider: 'claude', text: 'Hel', streaming: true }
    agent.emit({ type: 'item', item })
    item.text += 'lo' // the agent keeps editing its own object…
    agent.emit({ type: 'delta', itemId: 'a1', field: 'text', delta: 'lo' }) // …and reports the change
    expect(orch.get(meta.id)!.items.find((i) => i.id === 'a1')).toMatchObject({ text: 'Hello' })
    agent.end('completed')
  })

  it('stores Claude text exactly once while it streams', async () => {
    const agent = new ScriptedAgent('claude')
    const { orch, thread } = orchestrate({ claude: agent })
    const meta = thread()
    await orch.send(meta.id, { text: 'hi', attachments: [] })
    const mapper = new ClaudeMapper({ cwd: '/repo', emit: (e) => agent.emit(e) })
    mapper.beginTurn()
    mapper.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    mapper.handle({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    for (const word of ['Hello', ' brave', ' new', ' world']) {
      mapper.handle({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } })
    }
    expect(orch.get(meta.id)!.items.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'Hello brave new world', streaming: true })
    agent.end('completed')
  })

  it('Claude mapper never edits an item after sending it', () => {
    const sent: RuntimeEvent[] = []
    const mapper = new ClaudeMapper({ cwd: '/repo', emit: (e) => sent.push(e) })
    mapper.beginTurn()
    mapper.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    mapper.handle({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    for (const word of ['Hello', ' world']) mapper.handle({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } })
    const first = sent.find((e) => e.type === 'item')
    expect(first?.type === 'item' && first.item.kind === 'assistant' ? first.item.text : null).toBe('Hello')
  })

  it('keeps a bounded copy of chatty Codex output and never edits items it already sent', () => {
    const sent: RuntimeEvent[] = []
    const m = new CodexThreadMapper({ cwd: '/repo', home: '/Users/me', now: () => 1 }, (e) => sent.push(e))
    m.itemStarted({ type: 'commandExecution', id: 'c1', command: 'yes', status: 'inProgress' })
    const first = sent.find((e) => e.type === 'item')
    const chunk = 'y\n'.repeat(32 * 1024)
    for (let i = 0; i < 20; i++) m.outputDelta('c1', chunk)
    expect((m.get('c1') as ToolItem).output!.length).toBeLessThanOrEqual(512 * 1024)
    expect(first?.type === 'item' && first.item.kind === 'tool' ? first.item.output : 'missing').toBeFalsy()
  })

  it('sends pending chunks before a snapshot, and a chunk is never applied twice', async () => {
    const agent = new ScriptedAgent('codex')
    const { orch, events, thread } = orchestrate({ codex: agent })
    const meta = thread('codex')
    await orch.send(meta.id, { text: 'hi', attachments: [] })
    agent.emit({ type: 'item', item: { kind: 'assistant', id: 'x1', ts: 1, provider: 'codex', text: 'Hello', streaming: true } })
    agent.emit({ type: 'delta', itemId: 'x1', field: 'text', delta: ' world' })
    const snapshot = orch.get(meta.id)!
    expect(events.find((e) => e.type === 'item-delta')).toMatchObject({ itemId: 'x1', delta: ' world', offset: 5 })
    expect(applyDelta(snapshot.items, 'x1', 'text', ' world', 5)).toBeNull()
    expect(applyDelta(snapshot.items, 'x1', 'text', ' world!', 5)!.find((i) => i.id === 'x1')).toMatchObject({ text: 'Hello world!' })
    expect(applyDelta(snapshot.items, 'x1', 'text', '?', 11)!.find((i) => i.id === 'x1')).toMatchObject({ text: 'Hello world?' })
    agent.end('completed')
  })
})

describe('stopping', () => {
  it('honours a Stop pressed while the agent starts, without ending the turn too early', async () => {
    vi.useFakeTimers()
    try {
      const agent = new ScriptedAgent('claude')
      agent.startDelayMs = 15_000
      const { orch, thread } = orchestrate({ claude: agent })
      const meta = thread()
      const sending = orch.send(meta.id, { text: 'hi', attachments: [] })
      await vi.advanceTimersByTimeAsync(100)
      await orch.stop(meta.id)
      expect(agent.cancels).toBe(1)
      // The 12 s safety net must not invent an "interrupted" turn while the agent is starting.
      await vi.advanceTimersByTimeAsync(13_000)
      expect(orch.get(meta.id)!.status).toBe('running')
      await vi.advanceTimersByTimeAsync(2_000)
      await sending
      expect(agent.interrupts).toBe(1)
      const done = orch.get(meta.id)!
      expect(done.status).toBe('idle')
      expect(done.items.filter((i) => i.kind === 'turn')).toHaveLength(1)
      expect(done.items.at(-1)).toMatchObject({ kind: 'turn', status: 'interrupted' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends quietly when the start fails after Stop', async () => {
    const agent = new ScriptedAgent('codex')
    agent.startDelayMs = 30
    agent.failStart = new Error('process ended')
    const { orch, thread } = orchestrate({ codex: agent })
    const meta = thread('codex')
    const sending = orch.send(meta.id, { text: 'hi', attachments: [] })
    await orch.stop(meta.id)
    await sending
    const done = orch.get(meta.id)!
    expect(done.status).toBe('idle')
    expect(done.items.at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: 'Stopped before the agent started.' })
  })

  it('a second Stop never leaves a timer behind that kills the next Claude turn', async () => {
    const adapter = new ClaudeAdapter({
      binary: () => fixture('fake-claude.mjs'),
      env: () => ({ ...process.env, FAKE_CLAUDE_WIND_DOWN_MS: '40' }),
      attachmentsDir: tmpdir(),
      prepareImage: () => null,
      interruptGraceMs: 300
    })
    try {
      const req: TurnRequest = { threadId: 't1', cwd: tmpdir(), access: 'ask', text: 'one', attachments: [] }
      const first: RuntimeEvent[] = []
      await adapter.startTurn(req, (e) => first.push(e))
      await Promise.all([adapter.interrupt('t1'), adapter.interrupt('t1')])
      await until(() => first.some((e) => e.type === 'turn-end'))
      expect(first.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'interrupted' })
      const nativeId = (first.find((e) => e.type === 'native-id') as { nativeId: string }).nativeId
      const second: RuntimeEvent[] = []
      await adapter.startTurn({ ...req, nativeId, text: 'two' }, (e) => second.push(e))
      await wait(600)
      expect(second.filter((e) => e.type === 'turn-end')).toEqual([])
      expect(adapter.isActive('t1')).toBe(true)
    } finally {
      await adapter.shutdown()
    }
  })

  it('a second Stop never leaves a timer behind that ends the next Codex turn', async () => {
    const adapter = new CodexAdapter({ binary: () => fixture('fake-codex.mjs'), env: () => ({ ...process.env, FAKE_CODEX_WIND_DOWN_MS: '40' }), appVersion: 'test', interruptGraceMs: 300 })
    try {
      const req: TurnRequest = { threadId: 'd1', cwd: tmpdir(), access: 'ask', text: 'one', attachments: [] }
      const first: RuntimeEvent[] = []
      await adapter.startTurn(req, (e) => first.push(e))
      await Promise.all([adapter.interrupt('d1'), adapter.interrupt('d1')])
      await until(() => first.some((e) => e.type === 'turn-end'))
      const nativeId = (first.find((e) => e.type === 'native-id') as { nativeId: string }).nativeId
      const second: RuntimeEvent[] = []
      await adapter.startTurn({ ...req, nativeId, text: 'two' }, (e) => second.push(e))
      await wait(600)
      expect(second.filter((e) => e.type === 'turn-end')).toEqual([])
      expect(adapter.isActive('d1')).toBe(true)
    } finally {
      await adapter.shutdown()
    }
  })
})

describe('Codex thread routing', () => {
  it('drops late events from a deleted thread and routes sub-agents to their parent', async () => {
    const adapter = new CodexAdapter({ binary: () => fixture('fake-codex.mjs'), env: () => process.env, appVersion: 'test' })
    try {
      const got: Record<string, RuntimeEvent[]> = { A: [], B: [], C: [] }
      for (const id of ['A', 'B', 'C']) {
        await adapter.startTurn({ threadId: id, cwd: tmpdir(), access: 'ask', text: id, attachments: [] }, (e) => got[id].push(e))
      }
      const codexId = (id: string) => (got[id].find((e) => e.type === 'native-id') as { nativeId: string }).nativeId
      const push = (method: string, params: unknown) => adapter.rpcRequest('test/emit', { method, params })
      const message = (id: string) => ({ type: 'agentMessage', id, text: `hello from ${id}` })
      const received = (thread: string, itemId: string) => got[thread].some((e) => e.type === 'item' && e.item.id === `x-${itemId}`)

      const aCodexId = codexId('A')
      adapter.release('A')
      await adapter.interrupt('C')
      await until(() => !adapter.isActive('C'))
      // Only B is still working: A's late events must not land in B.
      await push('item/completed', { threadId: aCodexId, item: message('late') })
      // A sub-agent announced by B's thread belongs to B.
      await push('thread/started', { thread: { id: 'sub-1', parentThreadId: codexId('B') } })
      await push('item/completed', { threadId: 'sub-1', item: message('sub') })
      await wait(80)
      expect(received('B', 'late')).toBe(false)
      expect(received('A', 'late')).toBe(false)
      expect(received('B', 'sub')).toBe(true)
    } finally {
      await adapter.shutdown()
    }
  })

  it('merges partial rate-limit updates instead of dropping windows', async () => {
    const adapter = new CodexAdapter({ binary: () => fixture('fake-codex.mjs'), env: () => process.env, appVersion: 'test' })
    try {
      const push = (rateLimits: unknown) => adapter.rpcRequest('test/emit', { method: 'account/rateLimits/updated', params: { rateLimits } })
      await push({ primary: { usedPercent: 10, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } })
      await until(() => adapter.getLimits().length === 2)
      await push({ primary: { usedPercent: 12, windowDurationMins: 300 } })
      await until(() => adapter.getLimits().find((l) => l.label === '5-hour')?.usedPercent === 12)
      expect(adapter.getLimits().map((l) => [l.label, l.usedPercent])).toEqual([
        ['5-hour', 12],
        ['Weekly', 40]
      ])
    } finally {
      await adapter.shutdown()
    }
  })
})

describe('threads', () => {
  it('counts Claude cost from its running totals', async () => {
    const agent = new ScriptedAgent('claude')
    const { orch, thread } = orchestrate({ claude: agent })
    const meta = thread()
    // 0.05 last: a fresh Claude process that no longer knew the earlier total.
    for (const total of [0.1, 0.25, 0.05]) {
      await orch.send(meta.id, { text: 'go', attachments: [] })
      agent.emit({ type: 'native-id', nativeId: 'session-1' })
      agent.end('completed', { costUsd: total })
    }
    const done = orch.get(meta.id)!
    const costs = done.items.filter((i): i is TurnItem => i.kind === 'turn').map((i) => i.costUsd ?? 0)
    expect(costs[0]).toBeCloseTo(0.1)
    expect(costs[1]).toBeCloseTo(0.15)
    expect(costs[2]).toBeCloseTo(0.05)
    expect(done.costUsd).toBeCloseTo(0.3)
    expect(done.native.claude?.costTotal).toBe(0.05)
  })

  it('demo agents report cost like the real ones', async () => {
    const { orch, thread } = orchestrate()
    const meta = thread()
    for (const text of ['one', 'two']) {
      await orch.send(meta.id, { text, attachments: [] })
      await until(() => orch.get(meta.id)!.status === 'idle')
    }
    expect(orch.get(meta.id)!.costUsd).toBeCloseTo(0.0246)
  })

  it('forks a running thread without spinners', async () => {
    const agent = new ScriptedAgent('claude')
    const { orch, thread } = orchestrate({ claude: agent })
    const meta = thread()
    await orch.send(meta.id, { text: 'hi', attachments: [] })
    agent.emit({ type: 'item', item: { kind: 'assistant', id: 'a', ts: 1, provider: 'claude', text: 'partial', streaming: true } })
    agent.emit({ type: 'item', item: { kind: 'tool', id: 't', ts: 2, provider: 'claude', tool: 'command', name: 'Bash', title: 'sleep 60', status: 'running' } })
    const fork = orch.fork(meta.id)!
    const items = orch.get(fork.id)!.items
    expect(items.find((i) => i.id === 'a')).toMatchObject({ streaming: false })
    expect(items.find((i) => i.id === 't')).toMatchObject({ status: 'error' })
    agent.end('completed')
  })

  it('sets a damaged thread file aside instead of overwriting it', () => {
    const { store, orch, dir, thread } = orchestrate()
    const meta = thread()
    store.setItems(meta.id, [{ kind: 'user', id: 'u', ts: 1, provider: 'claude', text: 'keep me', attachments: [] }])
    store.flush()
    const file = join(dir, 'threads', `${meta.id}.json`)
    const damaged = '{"meta":{"id":"x"},"items":[{"kind":"us'
    writeFileSync(file, damaged)
    const reloaded = new Store(dir)
    expect(reloaded.getItems(meta.id)).toMatchObject([{ kind: 'notice', level: 'error' }])
    reloaded.flush()
    const kept = readdirSync(join(dir, 'threads')).find((f) => f.startsWith(`${meta.id}.json.corrupt-`))
    expect(kept && readFileSync(join(dir, 'threads', kept), 'utf8')).toBe(damaged)
    expect(orch).toBeTruthy()
  })

  it('never overwrites a thread file it could not read', () => {
    const { store, dir, thread } = orchestrate()
    const meta = thread()
    store.setItems(meta.id, [{ kind: 'user', id: 'u', ts: 1, provider: 'claude', text: 'keep me', attachments: [] }])
    store.flush()
    const file = join(dir, 'threads', `${meta.id}.json`)
    const original = readFileSync(file, 'utf8')
    chmodSync(file, 0o000)
    try {
      const reloaded = new Store(dir)
      expect(reloaded.getItems(meta.id)).toMatchObject([{ kind: 'notice', level: 'error' }])
      reloaded.setItems(meta.id, [])
      reloaded.flush()
    } finally {
      chmodSync(file, 0o644)
    }
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('writes nothing once frozen for a restore, and refuses new messages', async () => {
    const { store, orch, dir, thread } = orchestrate()
    const meta = thread()
    store.updateSettings({ fontSize: 15 })
    store.freeze()
    const threadsBefore = readdirSync(join(dir, 'threads')).sort()
    store.updateSettings({ fontSize: 18 })
    orch.update(meta.id, { title: 'Changed after freeze' })
    store.flush()
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).fontSize).toBe(15)
    expect(readdirSync(join(dir, 'threads')).sort()).toEqual(threadsBefore)
    expect(new Store(dir).getMeta(meta.id)?.title).not.toBe('Changed after freeze')
    await expect(orch.send(meta.id, { text: 'hi', attachments: [] })).rejects.toThrow(/restoring a backup/)
  })
})

describe('backups', () => {
  function context(root: string): BackupContext {
    const home = join(root, 'home')
    return { home, claudeDir: join(home, '.claude'), claudeJson: join(home, '.claude.json'), codexDir: join(root, 'codex'), duetDir: join(root, 'duet'), appVersion: 'test' }
  }

  it('archives a transcript that keeps growing while it is being read', async () => {
    const src = context(tmp('grow'))
    const file = join(src.claudeDir, 'projects', 'p', 'live.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    const initial = 24 * 1024 * 1024
    writeFileSync(file, Buffer.alloc(initial, 'a'))
    let growing = true
    const grower = (async () => {
      while (growing) {
        appendFileSync(file, 'b'.repeat(64 * 1024))
        await new Promise((r) => setImmediate(r))
      }
    })()
    const info = await createBackup(src, { sets: ['claude-sessions'], dir: join(src.home, 'out') }).finally(() => {
      growing = false
    })
    await grower
    const dst = context(tmp('grow-dst'))
    await restoreBackup(dst, info.file, ['claude-sessions'], { safetyDir: join(dst.home, 'out') })
    const restored = readFileSync(join(dst.claudeDir, 'projects', 'p', 'live.jsonl'))
    expect(restored.length).toBeGreaterThanOrEqual(initial)
    expect(readFileSync(file).subarray(0, restored.length).equals(restored)).toBe(true)
  })

  it('backs up linked skills as files, skips links to the home folder, and never restores links', async () => {
    const src = context(tmp('links'))
    const outside = join(src.home, 'dev', 'my-skill')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), 'linked skill')
    mkdirSync(join(src.claudeDir, 'skills'), { recursive: true })
    symlinkSync(outside, join(src.claudeDir, 'skills', 'mine'))
    symlinkSync(src.home, join(src.claudeDir, 'skills', 'home'))
    const files = collectFiles(BACKUP_SETS.find((s) => s.id === 'claude-config')!, src).files
    expect(files).toEqual([join(src.claudeDir, 'skills', 'mine', 'SKILL.md')])
    const info = await createBackup(src, { sets: ['claude-config'], dir: join(src.home, 'out') })
    const dst = context(tmp('links-dst'))
    await restoreBackup(dst, info.file, ['claude-config'], { safetyDir: join(dst.home, 'out') })
    const restored = join(dst.claudeDir, 'skills', 'mine')
    expect(lstatSync(restored).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(restored, 'SKILL.md'), 'utf8')).toBe('linked skill')
  })

  it('refuses archive entries that would write outside the data folders', async () => {
    const dst = context(tmp('evil'))
    const outside = tmp('outside')
    const userTarget = tmp('user-target')
    mkdirSync(join(dst.codexDir, 'skills'), { recursive: true })
    symlinkSync(userTarget, join(dst.codexDir, 'skills', 'linked'))
    const archive = join(dst.home, 'out', 'evil.tar.gz')
    mkdirSync(dirname(archive), { recursive: true })
    const pack = tarStream.pack()
    const written = pipeline(pack, createGzip(), createWriteStream(archive))
    const add = (header: Parameters<tarStream.Pack["entry"]>[0], body?: string) =>
      new Promise<void>((done, fail) => {
        const cb = (err?: Error | null) => (err ? fail(err) : done())
        if (body === undefined) pack.entry(header, cb)
        else pack.entry(header, body, cb)
      })
    await add({ name: 'codex/skills/evil', type: 'symlink', linkname: outside })
    await add({ name: 'codex/skills/evil/pwned.txt' }, 'owned')
    await add({ name: 'codex/skills/linked/SKILL.md' }, 'through a link')
    await add({ name: 'codex/skills/ok/SKILL.md' }, 'fine')
    pack.finalize()
    await written
    const result = await restoreBackup(dst, archive, ['codex-config'], { safetyDir: join(dst.home, 'out') })
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false)
    expect(existsSync(join(userTarget, 'SKILL.md'))).toBe(false)
    expect(lstatSync(join(dst.codexDir, 'skills', 'evil')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(dst.codexDir, 'skills', 'ok', 'SKILL.md'), 'utf8')).toBe('fine')
    expect(result.skipped).toBe(2)
  })
})

describe('MCP edits', () => {
  const readClaude = (home: string) => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
  const readCodex = (home: string) => parseToml(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, any>

  it('edits a server where it lives and keeps the fields Duet does not manage', async () => {
    const home = tmp('mcp-edit')
    const project = join(home, 'proj')
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { remote: { type: 'http', url: 'https://a', oauth: { clientId: 'abc' }, headersHelper: 'helper.sh' } },
        projects: { [project]: { mcpServers: { local1: { type: 'stdio', command: 'old', timeout: 5 } } } }
      })
    )
    const deps = fakeMcpDeps(home)
    await writeClaudeServer(deps, { name: 'local1', transport: 'stdio', command: 'new' }, { scope: 'local', project })
    await writeClaudeServer(deps, { name: 'remote', transport: 'http', url: 'https://b' })
    const data = readClaude(home)
    expect(data.projects[project].mcpServers.local1).toEqual({ timeout: 5, type: 'stdio', command: 'new' })
    expect(data.mcpServers.local1).toBeUndefined()
    expect(data.mcpServers.remote).toEqual({ oauth: { clientId: 'abc' }, headersHelper: 'helper.sh', type: 'http', url: 'https://b' })
  })

  it('renames safely and puts the old entry back when Claude refuses the new one', async () => {
    const home = tmp('mcp-rename')
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { type: 'stdio', command: 'x', extra: 1 }, taken: { type: 'stdio', command: 't' } } }))
    const deps = fakeMcpDeps(home)
    await expect(writeClaudeServer(deps, { name: 'taken', transport: 'stdio', command: 'y' }, { previousName: 'a' })).rejects.toThrow(/already exists/)
    expect(readClaude(home).mcpServers.a).toEqual({ type: 'stdio', command: 'x', extra: 1 })
    await writeClaudeServer(deps, { name: 'b', transport: 'stdio', command: 'y' }, { previousName: 'a' })
    expect(readClaude(home).mcpServers.a).toBeUndefined()
    expect(readClaude(home).mcpServers.b).toEqual({ extra: 1, type: 'stdio', command: 'y' })
    let adds = 0
    const flaky: McpWriteDeps = { ...deps, claude: async (args, cwd) => (args[1] === 'add-json' && adds++ === 0 ? { stdout: '', stderr: 'invalid config', code: 1 } : deps.claude(args, cwd)) }
    await expect(writeClaudeServer(flaky, { name: 'b', transport: 'stdio', command: 'z' })).rejects.toThrow(/invalid config/)
    expect(readClaude(home).mcpServers.b).toEqual({ extra: 1, type: 'stdio', command: 'y' })
  })

  it('keeps a disabled Codex server disabled and carries its settings across a rename', async () => {
    const home = tmp('mcp-codex')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.fs]\ncommand = "npx"\nargs = []\nenabled = false\nstartup_timeout_sec = 30\n')
    const deps = fakeMcpDeps(home)
    await writeCodexServer(deps, { name: 'fs', transport: 'stdio', command: 'node' })
    expect(readCodex(home).mcp_servers.fs).toMatchObject({ command: 'node', enabled: false, startup_timeout_sec: 30 })
    await writeCodexServer(deps, { name: 'files', transport: 'stdio', command: 'node' }, 'fs')
    expect(readCodex(home).mcp_servers.fs).toBeUndefined()
    expect(readCodex(home).mcp_servers.files).toMatchObject({ command: 'node', enabled: false, startup_timeout_sec: 30 })
    await writeCodexServer(deps, { name: 'files', transport: 'stdio', command: 'node', enabled: true })
    expect(readCodex(home).mcp_servers.files.enabled).toBeUndefined()
  })
})
