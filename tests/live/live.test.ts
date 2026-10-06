/**
 * Live tests against the real Claude Code and Codex CLIs on this machine.
 * Opt-in only (`npm run test:live`): they use your subscriptions (tiny prompts, cheap models).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Attachment, DuetEvent, ProviderStatus, TimelineItem } from '../../src/shared/types'
import { findBinary, getEnv, loadShellEnv } from '../../src/main/env'
import { ClaudeAdapter } from '../../src/main/providers/claude/adapter'
import { CodexAdapter } from '../../src/main/providers/codex/adapter'
import type { RuntimeEvent, TurnRequest } from '../../src/main/providers/types'
import { Store } from '../../src/main/store'
import { Orchestrator } from '../../src/main/orchestrator'

const LIVE = !!process.env.DUET_LIVE
const CLAUDE_MODEL = process.env.DUET_LIVE_CLAUDE_MODEL ?? 'haiku'

/** Solid-color PNG, built by hand so the test needs no image library. */
function solidPng(r: number, g: number, b: number, size = 64): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

interface Collected {
  events: RuntimeEvent[]
  items: Map<string, TimelineItem>
  done: Promise<Extract<RuntimeEvent, { type: 'turn-end' }>>
  emit: (e: RuntimeEvent) => void
  onApproval?: (item: TimelineItem) => void
}

function collector(): Collected {
  const events: RuntimeEvent[] = []
  const items = new Map<string, TimelineItem>()
  let resolve!: (e: Extract<RuntimeEvent, { type: 'turn-end' }>) => void
  const done = new Promise<Extract<RuntimeEvent, { type: 'turn-end' }>>((r) => (resolve = r))
  const c: Collected = {
    events,
    items,
    done,
    emit: (e) => {
      events.push(e)
      if (e.type === 'item') {
        items.set(e.item.id, e.item)
        if (e.item.kind === 'approval' && e.item.status === 'pending') c.onApproval?.(e.item)
      }
      if (e.type === 'delta') {
        const it = items.get(e.itemId)
        if (it && (it.kind === 'assistant' || it.kind === 'reasoning')) items.set(it.id, { ...it, text: it.text + e.delta })
      }
      if (e.type === 'turn-end') resolve(e)
    }
  }
  return c
}

const text = (c: Collected) =>
  [...c.items.values()]
    .filter((i) => i.kind === 'assistant')
    .map((i) => (i.kind === 'assistant' ? i.text : ''))
    .join('\n')

describe.skipIf(!LIVE)('live: Claude Code', () => {
  let claude: ClaudeAdapter
  let project: string
  let status: ProviderStatus

  beforeAll(async () => {
    await loadShellEnv()
    project = realpathSync(mkdtempSync(join(tmpdir(), 'duet-live-claude-')))
    claude = new ClaudeAdapter({
      binary: () => findBinary('claude'),
      env: getEnv,
      attachmentsDir: project,
      prepareImage: (path, mime) => ({ data: readFileSync(path).toString('base64'), mediaType: mime })
    })
    status = await claude.status(true)
  }, 120_000)

  afterAll(async () => {
    await claude?.shutdown()
  })

  it('detects the CLI, account and models', () => {
    expect(status.installed).toBe(true)
    expect(status.version).toMatch(/^\d+\.\d+/)
    expect(status.loggedIn).toBe(true)
    expect(status.models.length).toBeGreaterThan(2)
    expect(status.models.some((m) => m.id === 'haiku')).toBe(true)
  })

  it('streams a reply and remembers context across turns (including after a restart)', async () => {
    const first = collector()
    const base: Omit<TurnRequest, 'text'> = { threadId: 'live-1', cwd: project, model: CLAUDE_MODEL, access: 'ask', attachments: [] }
    await claude.startTurn({ ...base, text: 'Remember the code word PINEAPPLE. Reply with just: ok' }, first.emit)
    const end1 = await first.done
    expect(end1.status).toBe('completed')
    const native = first.events.find((e) => e.type === 'native-id')
    expect(native && native.type === 'native-id' && native.nativeId).toMatch(/[0-9a-f-]{36}/)
    // Kill the process; the next turn must resume the same session from disk.
    claude.release('live-1')
    const second = collector()
    await claude.startTurn({ ...base, nativeId: native && native.type === 'native-id' ? native.nativeId : undefined, text: 'What was the code word? Reply with just the word.' }, second.emit)
    const end2 = await second.done
    expect(end2.status).toBe('completed')
    expect(text(second).toUpperCase()).toContain('PINEAPPLE')
  }, 240_000)

  it('asks for approval before writing a file, then writes it', async () => {
    const c = collector()
    c.onApproval = (item) => setTimeout(() => claude.respond('live-2', item.id, { kind: 'allow' }), 50)
    await claude.startTurn(
      { threadId: 'live-2', cwd: project, model: CLAUDE_MODEL, access: 'ask', attachments: [], text: 'Create a file named hello.txt in the current directory containing exactly the text: hi from duet. Use the Write tool. Then reply: done' },
      c.emit
    )
    const end = await c.done
    expect(end.status).toBe('completed')
    const approvals = [...c.items.values()].filter((i) => i.kind === 'approval')
    expect(approvals.length).toBeGreaterThanOrEqual(1)
    expect(approvals[0]).toMatchObject({ request: 'edit' })
    expect(readFileSync(join(project, 'hello.txt'), 'utf8').trim()).toBe('hi from duet')
    const write = [...c.items.values()].find((i) => i.kind === 'tool' && i.tool === 'write')
    expect(write).toMatchObject({ status: 'done' })
  }, 240_000)

  it('understands an attached image', async () => {
    const path = join(project, 'red.png')
    writeFileSync(path, solidPng(220, 20, 20))
    const att: Attachment = { id: 'img', name: 'red.png', mime: 'image/png', path, size: 1 }
    const c = collector()
    await claude.startTurn({ threadId: 'live-3', cwd: project, model: CLAUDE_MODEL, access: 'ask', attachments: [att], text: 'What single color fills this image? Answer with one lowercase word.' }, c.emit)
    const end = await c.done
    expect(end.status).toBe('completed')
    expect(text(c).toLowerCase()).toContain('red')
  }, 240_000)

  it('can be interrupted', async () => {
    const c = collector()
    await claude.startTurn({ threadId: 'live-4', cwd: project, model: CLAUDE_MODEL, access: 'full', attachments: [], text: 'Run the shell command `sleep 45` with the Bash tool, then reply: finished' }, c.emit)
    // Wait until the command is actually running, then stop it.
    const start = Date.now()
    while (![...c.items.values()].some((i) => i.kind === 'tool' && i.tool === 'command') && Date.now() - start < 60_000) await new Promise((r) => setTimeout(r, 200))
    await new Promise((r) => setTimeout(r, 1000))
    await claude.interrupt('live-4')
    const end = await c.done
    expect(end.status).toBe('interrupted')
  }, 240_000)
})

describe.skipIf(!LIVE)('live: Codex', () => {
  let codex: CodexAdapter
  let project: string
  let status: ProviderStatus
  let model: string
  const created: string[] = []

  beforeAll(async () => {
    await loadShellEnv()
    project = realpathSync(mkdtempSync(join(tmpdir(), 'duet-live-codex-')))
    codex = new CodexAdapter({ binary: () => findBinary('codex'), env: getEnv, appVersion: '1.0.0-test' })
    status = await codex.status(true)
    // Prefer a small model for cost; fall back to the default.
    model = process.env.DUET_LIVE_CODEX_MODEL ?? status.models.find((m) => /luna|mini/i.test(m.id))?.id ?? status.defaultModel ?? status.models[0]?.id
  }, 120_000)

  afterAll(async () => {
    // Keep the user's Codex history tidy: archive the threads these tests created.
    for (const id of created) await codex.rpcRequest('thread/archive', { threadId: id }, 15_000).catch(() => undefined)
    await codex?.shutdown()
  }, 60_000)

  const track = (c: Collected) => {
    const n = c.events.find((e) => e.type === 'native-id')
    if (n && n.type === 'native-id' && !created.includes(n.nativeId)) created.push(n.nativeId)
    return n && n.type === 'native-id' ? n.nativeId : undefined
  }

  it('detects the CLI, account, models and limits', () => {
    expect(status.installed).toBe(true)
    expect(status.loggedIn).toBe(true)
    expect(status.models.length).toBeGreaterThan(0)
    expect(model).toBeTruthy()
  })

  it('streams a reply and resumes the thread after a server restart', async () => {
    const c = collector()
    await codex.startTurn({ threadId: 'cx-1', cwd: project, model, effort: 'low', access: 'ask', attachments: [], text: 'Remember the code word MANGO. Reply with just: ok' }, c.emit)
    const end = await c.done
    expect(end.status).toBe('completed')
    expect(text(c).toLowerCase()).toContain('ok')
    const threadId = track(c)!
    // Restart the app-server: the next turn must resume from disk.
    await codex.shutdown()
    const again = collector()
    await codex.startTurn({ threadId: 'cx-1', cwd: project, model, effort: 'low', access: 'ask', attachments: [], nativeId: threadId, text: 'What was the code word? Reply with just the word.' }, again.emit)
    const end2 = await again.done
    expect(end2.status).toBe('completed')
    expect(text(again).toUpperCase()).toContain('MANGO')
  }, 300_000)

  it('asks before running a command when access is "ask"', async () => {
    const c = collector()
    let asked = 0
    c.onApproval = (item) => {
      asked++
      setTimeout(() => codex.respond('cx-2', item.id, { kind: 'allow' }), 50)
    }
    await codex.startTurn(
      { threadId: 'cx-2', cwd: project, model, effort: 'low', access: 'ask', attachments: [], text: 'Run this exact shell command: echo duet-ok > codex.txt   Then reply: done' },
      c.emit
    )
    const end = await c.done
    track(c)
    expect(end.status).toBe('completed')
    expect(asked).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(project, 'codex.txt'))).toBe(true)
  }, 300_000)

  it('understands an attached image', async () => {
    const path = join(project, 'blue.png')
    writeFileSync(path, solidPng(20, 40, 230))
    const c = collector()
    await codex.startTurn(
      { threadId: 'cx-3', cwd: project, model, effort: 'low', access: 'ask', attachments: [{ id: 'b', name: 'blue.png', mime: 'image/png', path, size: 1 }], text: 'What single color fills the attached image? Answer with one lowercase word.' },
      c.emit
    )
    const end = await c.done
    track(c)
    expect(end.status).toBe('completed')
    expect(text(c).toLowerCase()).toContain('blue')
  }, 300_000)

  it('lists MCP server status', async () => {
    const res = await codex.rpcRequest<{ data: { name: string }[] }>('mcpServerStatus/list', { limit: 50 }, 30_000)
    expect(Array.isArray(res.data)).toBe(true)
  }, 60_000)
})

describe.skipIf(!LIVE)('live: switching agents mid-thread', () => {
  let orch: Orchestrator
  let claude: ClaudeAdapter
  let codex: CodexAdapter
  let project: string

  beforeAll(async () => {
    await loadShellEnv()
    project = realpathSync(mkdtempSync(join(tmpdir(), 'duet-live-switch-')))
    mkdirSync(join(project, 'data'), { recursive: true })
    claude = new ClaudeAdapter({ binary: () => findBinary('claude'), env: getEnv, attachmentsDir: project, prepareImage: (p, m) => ({ data: readFileSync(p).toString('base64'), mediaType: m }) })
    codex = new CodexAdapter({ binary: () => findBinary('codex'), env: getEnv, appVersion: '1.0.0-test' })
    const status = await codex.status(true)
    const cheap = status.models.find((m) => /luna|mini/i.test(m.id))?.id ?? status.defaultModel
    const store = new Store(join(project, 'data'))
    store.updateSettings({ defaultModels: { claude: CLAUDE_MODEL, codex: cheap }, defaultEfforts: { codex: 'low' }, defaultAccess: 'ask' })
    orch = new Orchestrator({
      store,
      adapters: { claude, codex },
      broadcast: (_e: DuetEvent) => undefined,
      injectHandoff: async (provider, req, handoff, emit) => {
        if (provider !== 'codex') return false
        const id = await codex.prepareThread(req, emit)
        return id ? codex.injectContext(req.threadId, handoff) : false
      }
    })
  }, 120_000)

  afterAll(async () => {
    for (const meta of orch.list()) if (meta.native.codex) await codex.rpcRequest('thread/archive', { threadId: meta.native.codex.id }, 15_000).catch(() => undefined)
    await claude?.shutdown()
    await codex?.shutdown()
  }, 60_000)

  const waitIdle = async (id: string) => {
    const start = Date.now()
    while (orch.get(id)!.status === 'running' || orch.get(id)!.status === 'approval') {
      if (Date.now() - start > 240_000) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  it('Codex knows what was said to Claude, and Claude knows what Codex did', async () => {
    const meta = orch.create({ cwd: project, provider: 'claude' })
    await orch.send(meta.id, { text: 'My favourite fruit is KIWI. Just reply: noted', attachments: [] })
    await waitIdle(meta.id)
    expect(orch.get(meta.id)!.status).toBe('idle')
    orch.update(meta.id, { provider: 'codex' })
    await orch.send(meta.id, { text: 'What is my favourite fruit? Also tell me a two-digit number of your choice. Reply as: FRUIT NUMBER', attachments: [] })
    await waitIdle(meta.id)
    let thread = orch.get(meta.id)!
    expect(thread.status).toBe('idle')
    const codexReply = thread.items.filter((i) => i.kind === 'assistant' && i.provider === 'codex').map((i) => (i.kind === 'assistant' ? i.text : '')).join(' ')
    expect(codexReply.toUpperCase()).toContain('KIWI')
    const number = codexReply.match(/\b\d{2}\b/)?.[0]
    expect(number).toBeTruthy()
    orch.update(meta.id, { provider: 'claude' })
    await orch.send(meta.id, { text: 'What number did Codex just pick? Reply with just the number.', attachments: [] })
    await waitIdle(meta.id)
    thread = orch.get(meta.id)!
    const claudeReply = thread.items.filter((i) => i.kind === 'assistant' && i.provider === 'claude').at(-1)
    expect(claudeReply && claudeReply.kind === 'assistant' && claudeReply.text).toContain(number!)
    expect(thread.items.filter((i) => i.kind === 'switch')).toHaveLength(2)
  }, 600_000)
})
