import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DuetEvent, ProviderId, TimelineItem } from '../../src/shared/types'
import { Store } from '../../src/main/store'
import { Orchestrator, makeTitle } from '../../src/main/orchestrator'
import { buildHandoff, withHandoff } from '../../src/main/handoff'
import { FakeAdapter } from '../../src/main/providers/fake/adapter'
import { NativeSessionLostError, type Emit, type ProviderAdapter, type TurnRequest } from '../../src/main/providers/types'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timed out')
    await wait(10)
  }
}

describe('handoff', () => {
  const items: TimelineItem[] = [
    { kind: 'user', id: 'u1', ts: 1, provider: 'claude', text: 'Build a login page', attachments: [] },
    { kind: 'assistant', id: 'a1', ts: 2, provider: 'claude', model: 'opus', text: 'I created Login.tsx' },
    { kind: 'tool', id: 't1', ts: 3, provider: 'claude', tool: 'write', name: 'Write', title: 'src/Login.tsx', status: 'done', diff: '--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b\n' },
    { kind: 'tool', id: 't2', ts: 4, provider: 'claude', tool: 'command', name: 'Bash', title: 'npm test', status: 'done', exitCode: 0 },
    { kind: 'turn', id: 'tt', ts: 5, provider: 'claude', status: 'completed' }
  ]

  it('summarizes what the other agent did', () => {
    const text = buildHandoff(items, 0, 'codex')!
    expect(text).toContain('<duet_handoff>')
    expect(text).toContain('handled by Claude')
    expect(text).toContain('### User\nBuild a login page')
    expect(text).toContain('### Claude (opus)\nI created Login.tsx')
    expect(text).toContain('- Wrote src/Login.tsx (+2 −0)')
    expect(text).toContain('- Ran `npm test`, exit 0')
    expect(withHandoff(text, 'add tests')).toMatch(/<\/duet_handoff>\n\nThe user's new message:\n\nadd tests$/)
  })

  it('returns nothing when the target already saw everything', () => {
    expect(buildHandoff(items, items.length, 'codex')).toBeNull()
    expect(buildHandoff(items, 0, 'claude')).toBeNull()
    expect(buildHandoff(items, 0, 'claude', { force: true })).toContain('previous session')
    expect(withHandoff(null, 'hi')).toBe('hi')
  })

  it('stays within budget and keeps the original task', () => {
    const many: TimelineItem[] = [{ kind: 'user', id: 'first', ts: 0, provider: 'claude', text: 'ORIGINAL TASK', attachments: [] }]
    for (let i = 0; i < 60; i++) {
      many.push({ kind: 'user', id: `u${i}`, ts: i, provider: 'claude', text: `question ${i} ` + 'x'.repeat(400), attachments: [] })
      many.push({ kind: 'assistant', id: `a${i}`, ts: i, provider: 'claude', text: `answer ${i} ` + 'y'.repeat(400) })
    }
    const text = buildHandoff(many, 0, 'codex', { budget: 6000 })!
    expect(text.length).toBeLessThan(7500)
    expect(text).toContain('ORIGINAL TASK')
    expect(text).toContain('answer 59')
    expect(text).toMatch(/earlier entries omitted/)
  })

  it('makes readable titles', () => {
    expect(makeTitle('## Fix the `login` bug\nmore')).toBe('Fix the login bug')
    expect(makeTitle('   ')).toBe('New thread')
    expect(makeTitle('x'.repeat(100)).length).toBe(60)
  })
})

function setup(adapters?: Partial<Record<ProviderId, ProviderAdapter>>) {
  const dir = mkdtempSync(join(tmpdir(), 'duet-orch-'))
  const store = new Store(dir)
  const events: DuetEvent[] = []
  const notified: string[] = []
  const orch = new Orchestrator({
    store,
    adapters: { claude: adapters?.claude ?? new FakeAdapter('claude', 50), codex: adapters?.codex ?? new FakeAdapter('codex', 50) },
    broadcast: (e) => events.push(e),
    notify: (_m, kind) => notified.push(kind)
  })
  return { dir, store, orch, events, notified }
}

describe('Orchestrator with demo agents', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  it('runs a turn, titles the thread and records the native session', async () => {
    const { orch, store, notified } = env
    const meta = orch.create({ cwd: '/tmp', provider: 'claude' })
    await orch.send(meta.id, { text: 'Hello there', attachments: [] })
    expect(orch.get(meta.id)!.status).toBe('running')
    await until(() => orch.get(meta.id)!.status === 'idle')
    const thread = orch.get(meta.id)!
    expect(thread.title).toBe('Hello there')
    expect(thread.native.claude?.id).toMatch(/^claude-demo-/)
    expect(thread.native.claude?.syncedTo).toBe(thread.items.length)
    expect(thread.items.map((i) => i.kind)).toEqual(['user', 'reasoning', 'assistant', 'turn'])
    expect(thread.items.every((i) => !('streaming' in i) || !i.streaming)).toBe(true)
    expect(notified).toContain('done')
    store.flush()
  })

  it('hands off context when switching providers and back', async () => {
    const { orch } = env
    const meta = orch.create({ cwd: '/tmp', provider: 'claude' })
    await orch.send(meta.id, { text: 'Plan a feature', attachments: [] })
    await until(() => orch.get(meta.id)!.status === 'idle')
    orch.update(meta.id, { provider: 'codex' })
    await orch.send(meta.id, { text: 'Now implement it', attachments: [] })
    await until(() => orch.get(meta.id)!.status === 'idle')
    let thread = orch.get(meta.id)!
    const sw = thread.items.find((i) => i.kind === 'switch')
    expect(sw).toMatchObject({ from: 'claude', to: 'codex' })
    const codexReply = thread.items.filter((i) => i.kind === 'assistant' && i.provider === 'codex').at(-1)
    expect(codexReply && codexReply.kind === 'assistant' && codexReply.text).toContain('Picking up from Claude')
    // Back to Claude: it only gets what Codex did.
    orch.update(meta.id, { provider: 'claude' })
    await orch.send(meta.id, { text: 'Review it', attachments: [] })
    await until(() => orch.get(meta.id)!.status === 'idle')
    thread = orch.get(meta.id)!
    const claudeReply = thread.items.filter((i) => i.kind === 'assistant' && i.provider === 'claude').at(-1)
    expect(claudeReply && claudeReply.kind === 'assistant' && claudeReply.text).toContain('Picking up from Codex')
    expect(thread.native.claude?.syncedTo).toBe(thread.items.length)
  })

  it('handles approvals: allow, deny and expire on stop', async () => {
    const { orch } = env
    const meta = orch.create({ cwd: '/tmp', provider: 'codex' })
    await orch.send(meta.id, { text: 'run the tests', attachments: [] })
    await until(() => orch.get(meta.id)!.status === 'approval')
    let approval = orch.get(meta.id)!.items.find((i) => i.kind === 'approval')!
    orch.respond(meta.id, approval.id, { kind: 'allow' })
    await until(() => orch.get(meta.id)!.status === 'idle')
    expect(orch.get(meta.id)!.items.find((i) => i.id === approval.id)).toMatchObject({ status: 'approved' })
    const tool = orch.get(meta.id)!.items.find((i) => i.kind === 'tool' && i.tool === 'command')
    expect(tool).toMatchObject({ status: 'done', exitCode: 0 })
    expect(tool && tool.kind === 'tool' && tool.output).toContain('Tests  20 passed')

    await orch.send(meta.id, { text: 'run them again', attachments: [] })
    await until(() => orch.get(meta.id)!.status === 'approval')
    approval = orch.get(meta.id)!.items.filter((i) => i.kind === 'approval').at(-1)!
    await orch.stop(meta.id)
    await until(() => orch.get(meta.id)!.status === 'idle')
    const thread = orch.get(meta.id)!
    expect(thread.items.find((i) => i.id === approval.id)).toMatchObject({ status: 'expired' })
    expect(thread.items.at(-1)).toMatchObject({ kind: 'turn', status: 'interrupted' })
  })

  it('refuses a second message while running and ignores empty sends', async () => {
    const { orch } = env
    const meta = orch.create({ cwd: '/tmp' })
    await orch.send(meta.id, { text: '   ', attachments: [] })
    expect(orch.get(meta.id)!.items).toHaveLength(0)
    await orch.send(meta.id, { text: 'one', attachments: [] })
    await expect(orch.send(meta.id, { text: 'two', attachments: [] })).rejects.toThrow(/still working/)
    await until(() => orch.get(meta.id)!.status === 'idle')
  })

  it('forks, renames, archives and deletes threads', async () => {
    const { orch, store, events } = env
    const meta = orch.create({ cwd: '/tmp' })
    await orch.send(meta.id, { text: 'Original', attachments: [] })
    await until(() => orch.get(meta.id)!.status === 'idle')
    const fork = orch.fork(meta.id)!
    expect(fork.title).toBe('Original (fork)')
    expect(fork.native).toEqual({})
    expect(orch.get(fork.id)!.items.length).toBe(orch.get(meta.id)!.items.length)
    orch.update(meta.id, { title: 'Renamed', pinned: true, archived: true })
    expect(store.getMeta(meta.id)).toMatchObject({ title: 'Renamed', pinned: true, archived: true })
    await orch.remove(fork.id)
    expect(orch.get(fork.id)).toBeNull()
    expect(events.some((e) => e.type === 'thread-removed' && e.id === fork.id)).toBe(true)
    expect(orch.exportMarkdown(meta.id)).toContain('# Renamed')
  })

  it('persists threads to disk and reloads them', async () => {
    const { orch, store, dir } = env
    const meta = orch.create({ cwd: '/tmp', provider: 'codex' })
    await orch.send(meta.id, { text: 'Persist me', attachments: [] })
    await until(() => orch.get(meta.id)!.status === 'idle')
    store.flush()
    const index = JSON.parse(readFileSync(join(dir, 'threads', 'index.json'), 'utf8'))
    expect(index[0].id).toBe(meta.id)
    const reloaded = new Store(dir)
    expect(reloaded.getThread(meta.id)!.items.length).toBe(orch.get(meta.id)!.items.length)
    expect(reloaded.getMeta(meta.id)!.title).toBe('Persist me')
  })
})

class LostSessionAdapter extends FakeAdapter {
  calls: TurnRequest[] = []
  override async startTurn(req: TurnRequest, emit: Emit): Promise<void> {
    this.calls.push(req)
    if (req.nativeId) throw new NativeSessionLostError('gone')
    return super.startTurn(req, emit)
  }
}

describe('Orchestrator recovery', () => {
  it('starts a fresh session with full context when the old one is gone', async () => {
    const claude = new LostSessionAdapter('claude', 50)
    const { orch } = setup({ claude })
    const meta = orch.create({ cwd: '/tmp', provider: 'claude' })
    await orch.send(meta.id, { text: 'First message', attachments: [] })
    await until(() => orch.get(meta.id)!.status === 'idle')
    await orch.send(meta.id, { text: 'Second message', attachments: [] })
    await until(() => orch.get(meta.id)!.status === 'idle')
    expect(claude.calls).toHaveLength(3)
    expect(claude.calls[2].nativeId).toBeUndefined()
    expect(claude.calls[2].text).toContain('First message')
    expect(orch.get(meta.id)!.items.some((i) => i.kind === 'notice' && i.text.includes('fresh one'))).toBe(true)
  })

  it('reports adapter failures as an error notice', async () => {
    class Broken extends FakeAdapter {
      override async startTurn(): Promise<void> {
        throw new Error('Codex CLI not found')
      }
    }
    const { orch } = setup({ codex: new Broken('codex') })
    const meta = orch.create({ cwd: '/tmp', provider: 'codex' })
    await orch.send(meta.id, { text: 'hi', attachments: [] })
    const thread = orch.get(meta.id)!
    expect(thread.status).toBe('error')
    expect(thread.items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'Codex CLI not found' })
    // A later send is allowed again.
    await expect(orch.send(meta.id, { text: 'again', attachments: [] })).resolves.toBeUndefined()
  })
})
