import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RoutingService, routingEndpoint, routingModels, validateCombo } from '../../src/main/features/routing'
import { CodexAdapter } from '../../src/main/providers/codex/adapter'
import { Orchestrator } from '../../src/main/orchestrator'
import { Store } from '../../src/main/store'
import { FakeAdapter } from '../../src/main/providers/fake/adapter'
import type { RoutingSettings } from '../../src/shared/types'
import type { Emit, TurnRequest } from '../../src/main/providers/types'
import { modelEffort } from '../../src/shared/routing'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }))) })

async function mockRouter() {
  const writes: any[] = []
  const requests: { path: string; key?: string }[] = []
  const combos: Record<string, any> = {}
  const server = createServer(async (req, res) => {
    const path = req.url ?? '/'
    const key = req.headers['x-opencodex-api-key'] as string | undefined
    requests.push({ path, key })
    res.setHeader('Content-Type', 'application/json')
    const send = (body: unknown) => res.end(JSON.stringify(body))
    if (key !== (path.startsWith('/api/') ? 'admin-test-key' : 'model-test-key')) { res.statusCode = 401; return send({ error: `bad key ${key}` }) }
    if (path === '/v1/models') return send({ data: [{ id: 'google/gemini-test', owned_by: 'google' }, { id: 'ollama/qwen-test' }, ...Object.keys(combos).map((id) => ({ id: `combo/${id}` }))] })
    if (path === '/v1/catalog') return send({ models: [{ slug: 'google/gemini-test', display_name: 'Gemini Test', input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] })
    if (path.startsWith('/api/combos')) {
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString())
        writes.push(body)
        combos[body.id] = body.combo
      }
      if (req.method === 'DELETE') delete combos[new URL(path, 'http://localhost').searchParams.get('id')!]
      return send({ combos: Object.entries(combos).map(([id, combo]) => ({ id, model: `combo/${id}`, ...combo })) })
    }
    res.statusCode = 404
    send({ error: 'missing' })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const root = mkdtempSync(join(tmpdir(), 'duet-routing-'))
  let settings: RoutingSettings = { endpoint, enabled: true }
  const deps = { root, settings: () => settings, saveSettings: (s: RoutingSettings) => { settings = s }, env: () => process.env, encrypt: (s: string) => Buffer.from(s.split('').reverse().join('')), decrypt: (b: Buffer) => b.toString().split('').reverse().join('') }
  const service = new RoutingService(deps)
  await service.connect({ endpoint, enabled: true, dataKey: 'model-test-key', adminKey: 'admin-test-key' })
  return { service, root, endpoint, requests, writes, combos, deps }
}

describe('provider routing', () => {
  it('requires secure remote connections and rejects credentials in URLs', () => {
    expect(routingEndpoint('http://localhost:10100/v1/')).toBe('http://localhost:10100')
    expect(routingEndpoint('https://router.example')).toBe('https://router.example')
    for (const url of ['http://router.example', 'https://key@router.example', 'file:///etc/passwd', 'https://router.example/?key=secret', 'https://router.example/api']) expect(() => routingEndpoint(url)).toThrow()
  })

  it('keeps explicit provider identity, metadata, and excludes hidden and duplicate models', () => {
    const models = routingModels({ data: [{ id: 'google/gemini-test' }, { id: 'combo/main' }, { id: 'hidden' }, { id: 'google/gemini-test' }, null] }, { models: [{ slug: 'hidden', visibility: 'hide' }, { slug: 'google/gemini-test', input_modalities: ['image', 'text'], supported_reasoning_levels: [{ effort: 'high' }] }] })
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({ id: 'router:google/gemini-test', routing: { provider: 'google', model: 'google/gemini-test' }, efforts: ['high'], supportsImages: true })
    expect(models[1]).toMatchObject({ routing: { combo: true }, supportsImages: false, efforts: [] })
  })

  it('encrypts keys separately, persists them across restarts, and never returns their values', async () => {
    const { service, root, deps } = await mockRouter()
    const encrypted = readFileSync(join(root, 'routing-credentials.enc'), 'utf8')
    expect(encrypted).not.toContain('model-test-key')
    expect(encrypted).not.toContain('admin-test-key')
    expect(JSON.stringify(await service.status(true))).not.toContain('test-key')
    const restored = new RoutingService(deps)
    expect(await restored.status(true)).toMatchObject({ connected: true, canManage: true, hasDataKey: true, hasAdminKey: true })
  })

  it('separates management and model credentials, and fails without exposing a rejected key', async () => {
    const { service, endpoint, requests } = await mockRouter()
    expect(requests.find((r) => r.path === '/api/combos')?.key).toBe('admin-test-key')
    expect(requests.find((r) => r.path === '/v1/models')?.key).toBe('model-test-key')
    const bad = await service.connect({ endpoint, enabled: true, dataKey: 'wrong-secret' })
    expect(bad.connected).toBe(false)
    expect(JSON.stringify(bad)).not.toContain('wrong-secret')
    await expect(service.connect({ endpoint, enabled: true, dataKey: 'admin-test-key' })).rejects.toThrow('must be different')
  })

  it('creates, edits, and removes real combos while retaining advanced settings', async () => {
    const { service, writes, combos } = await mockRouter()
    const targets = [{ provider: 'google', model: 'gemini-test', weight: 2 }, { provider: 'ollama', model: 'qwen-test', weight: 1 }]
    const saved = await service.saveCombo({ id: 'daily', strategy: 'failover', targets })
    expect(saved.combos[0]).toMatchObject({ id: 'daily', strategy: 'failover' })
    expect(saved.models.some((m) => m.id === 'router:combo/daily')).toBe(true)
    combos.daily.cooldownMs = 42000
    await service.saveCombo({ id: 'daily', strategy: 'round-robin', targets })
    expect(writes[1].combo).toMatchObject({ strategy: 'round-robin', cooldownMs: 42000 })
    expect((await service.removeCombo('daily')).combos).toHaveLength(0)
  })

  it('rejects unavailable targets, duplicate models and invalid weights', async () => {
    const { service } = await mockRouter()
    await expect(service.saveCombo({ id: 'daily', strategy: 'failover', targets: [{ provider: 'missing', model: 'x', weight: 1 }] })).rejects.toThrow('no longer available')
    const target = { provider: 'google', model: 'gemini-test', weight: 1 }
    expect(() => validateCombo({ id: 'daily', strategy: 'failover', targets: [target, target] })).toThrow('only once')
    expect(() => validateCombo({ id: 'daily', strategy: 'round-robin', targets: [{ ...target, weight: 0 }] })).toThrow()
  })

  it('only overrides explicitly routed models and checks image capability', async () => {
    const { service, endpoint } = await mockRouter()
    expect(service.codexConfig('gpt-native')).toEqual({ model: 'gpt-native' })
    expect(service.codexConfig('router:google/gemini-test')).toMatchObject({ model: 'google/gemini-test', modelProvider: 'duet_router', config: { 'model_providers.duet_router': { base_url: `${endpoint}/v1`, env_http_headers: { 'X-OpenCodex-API-Key': 'DUET_ROUTING_API_KEY' }, requires_openai_auth: false } } })
    expect(JSON.stringify(service.codexConfig('router:google/gemini-test'))).not.toContain('model-test-key')
    expect(service.codexEnv({})).toMatchObject({ DUET_ROUTING_API_KEY: 'model-test-key' })
    const env = { ANTHROPIC_API_KEY: 'native-key', OTHER: 'keep' }
    expect(service.claudeEnv('opus', env)).toBe(env)
    expect(service.claudeEnv('router:google/gemini-test', env)).toMatchObject({ ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: 'model-test-key', OTHER: 'keep' })
    expect(service.claudeEnv('router:google/gemini-test', env).ANTHROPIC_API_KEY).toBeUndefined()
    await expect(service.ensureModel('router:ollama/qwen-test', true)).rejects.toThrow('image support')
    const model = await service.ensureModel('router:google/gemini-test')
    expect(modelEffort(model, 'high')).toBe('high')
    expect(modelEffort(model, 'xhigh')).toBeUndefined()
    expect(modelEffort(undefined, 'xhigh')).toBe('xhigh')
    expect(modelEffort({ ...model!, efforts: ['ultra'] }, 'ultra', 'codex')).toBe('ultra')
    expect(modelEffort({ ...model!, efforts: ['ultra'] }, 'ultra', 'claude')).toBeUndefined()
    await service.connect({ endpoint, enabled: false })
    await expect(service.ensureModel('router:google/gemini-test')).rejects.toThrow('disabled')
    expect(await service.models()).toEqual([])
  })

  it('sends routed provider config on Codex start, turn and resume', async () => {
    const { service } = await mockRouter()
    const adapter = new CodexAdapter({ binary: () => resolve('tests/fixtures/fake-codex.mjs'), env: () => process.env, appVersion: 'test', routing: { ensureModel: (m, images) => service.ensureModel(m, images), codexConfig: (m) => service.codexConfig(m) } })
    const req: TurnRequest = { threadId: 'duet-test', cwd: tmpdir(), model: 'router:google/gemini-test', effort: 'xhigh', text: 'hello', attachments: [], access: 'ask' }
    try {
      await adapter.startTurn(req, () => {})
      await adapter.interrupt(req.threadId)
      await new Promise((done) => setTimeout(done, 100))
      const first = await adapter.rpcRequest<{ received: any[] }>('test/requests')
      expect(first.received.find((r) => r.method === 'thread/start').params).toMatchObject({ model: 'google/gemini-test', modelProvider: 'duet_router' })
      expect(first.received.find((r) => r.method === 'turn/start').params.model).toBe('google/gemini-test')
      expect(first.received.find((r) => r.method === 'turn/start').params.effort).toBeNull()
      adapter.release(req.threadId)
      await adapter.startTurn({ ...req, nativeId: 'thr-1' }, () => {})
      const resumed = await adapter.rpcRequest<{ received: any[] }>('test/requests')
      expect(resumed.received.find((r) => r.method === 'thread/resume').params).toMatchObject({ model: 'google/gemini-test', modelProvider: 'duet_router', config: { 'model_providers.duet_router': { wire_api: 'responses' } } })
    } finally { await adapter.shutdown() }
  })

  it('carries context into a new native session when switching connection, then resumes it', async () => {
    const { service } = await mockRouter()
    const root = mkdtempSync(join(tmpdir(), 'duet-routing-handoff-'))
    const store = new Store(root)
    const requests: TurnRequest[] = []
    class RecordingAdapter extends FakeAdapter {
      override async startTurn(req: TurnRequest, emit: Emit): Promise<void> {
        requests.push({ ...req })
        await super.startTurn(req, (e) => emit(e.type === 'native-id' ? { ...e, nativeId: req.nativeId ?? randomUUID() } : e))
      }
    }
    const adapter = new RecordingAdapter('codex', 1)
    const orch = new Orchestrator({ store, adapters: { claude: new FakeAdapter('claude', 1), codex: adapter }, broadcast: () => {}, sessionKey: (_, model) => service.sessionKey(model) })
    const thread = orch.create({ cwd: tmpdir(), provider: 'codex', model: 'native-model' })
    const wait = async () => { while (orch.isRunning(thread.id)) await new Promise((done) => setTimeout(done, 10)) }
    try {
      await orch.send(thread.id, { text: 'remember the task', attachments: [] }); await wait()
      const native = store.getMeta(thread.id)!.native.codex!.id
      orch.update(thread.id, { models: { codex: 'router:google/gemini-test' } })
      await orch.send(thread.id, { text: 'continue', attachments: [] }); await wait()
      const routed = store.getMeta(thread.id)!.native.codex!
      expect(routed.id).not.toBe(native)
      expect(routed.backend).toMatch(/^routing:/)
      expect(requests[1].nativeId).toBeUndefined()
      expect(requests[1].text).toContain('remember the task')
      await orch.send(thread.id, { text: 'again', attachments: [] }); await wait()
      expect(store.getMeta(thread.id)!.native.codex!.id).toBe(routed.id)
      expect(requests[2].nativeId).toBe(routed.id)
      orch.update(thread.id, { models: { codex: 'native-model' } })
      await orch.send(thread.id, { text: 'back to native', attachments: [] }); await wait()
      expect(store.getMeta(thread.id)!.native.codex!.backend).toBeUndefined()
      expect(store.getMeta(thread.id)!.native.codex!.id).not.toBe(routed.id)
    } finally { await orch.shutdown(); store.flush() }
  })
})
