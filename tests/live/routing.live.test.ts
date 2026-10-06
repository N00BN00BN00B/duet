import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findBinary } from '../../src/main/env'
import { CodexAdapter } from '../../src/main/providers/codex/adapter'
import { RoutingService } from '../../src/main/features/routing'
import { ClaudeAdapter } from '../../src/main/providers/claude/adapter'
import type { RoutingSettings } from '../../src/shared/types'
import type { RuntimeEvent } from '../../src/main/providers/types'

// Local protocol test: real engine and both real agents, with mock upstreams. No provider credentials or billing.
it.skipIf(!process.env.DUET_ROUTER_TEST_ENGINE && !process.env.DUET_ROUTER_INSTALL_TEST)('real engine falls back and streams through real Codex and Claude', async () => {
  const requests: string[] = []
  const server = createServer(async (req, res) => {
    const path = req.url ?? ''
    requests.push(path)
    if (path.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] })) }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.from(c))
    if (path.includes('/bad/')) { res.statusCode = 503; return res.end(JSON.stringify({ error: { message: 'temporary mock outage', type: 'server_error' } })) }
    if (!path.endsWith('/responses')) { res.statusCode = 404; return res.end('{}') }
    const text = 'ROUTING_FALLBACK_OK'
    const item = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] }
    const response = { id: 'resp_test', object: 'response', status: 'completed', model: 'mock-model', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(response)) }
    res.setHeader('Content-Type', 'text/event-stream')
    const emit = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`)
    emit('response.created', { response: { ...response, status: 'in_progress', output: [] } })
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
    emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text })
    emit('response.output_item.done', { output_index: 0, item })
    emit('response.completed', { response })
    res.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const root = mkdtempSync(join(tmpdir(), 'duet-routing-live-'))
  if (!process.env.DUET_ROUTER_INSTALL_TEST) symlinkSync(process.env.DUET_ROUTER_TEST_ENGINE!, join(root, 'routing-engine'), 'dir')
  const engineHome = join(root, 'routing-state')
  mkdirSync(engineHome, { recursive: true, mode: 0o700 })
  const provider = (name: string) => ({ adapter: 'openai-responses', baseUrl: `${base}/${name}/v1`, authMode: 'key', apiKey: 'mock-key', allowPrivateNetwork: true, liveModels: false, models: ['mock-model'] })
  writeFileSync(join(engineHome, 'config.json'), JSON.stringify({ port: 10101, hostname: '127.0.0.1', codexAutoStart: false, providers: { bad: provider('bad'), good: provider('good') }, defaultProvider: 'good', claudeCode: { enabled: true, systemEnv: false, intercept: { enabled: false } } }), { mode: 0o600 })
  let settings: RoutingSettings = { enabled: true, endpoint: 'http://127.0.0.1:10101' }
  const service = new RoutingService({ root, settings: () => settings, saveSettings: (s) => { settings = s }, env: () => process.env, encrypt: (s) => Buffer.from(s), decrypt: (s) => s.toString() })
  const codexHome = join(root, 'codex-client')
  mkdirSync(codexHome)
  const adapter = new CodexAdapter({ binary: () => findBinary('codex'), env: () => service.codexEnv({ ...process.env, CODEX_HOME: codexHome }), appVersion: 'routing-test', routing: { codexConfig: (m) => service.codexConfig(m), ensureModel: (m, images) => service.ensureModel(m, images) } })
  const claudeHome = join(root, 'claude-client')
  mkdirSync(claudeHome)
  const claude = new ClaudeAdapter({ binary: () => findBinary('claude'), env: () => ({ ...process.env, CLAUDE_CONFIG_DIR: claudeHome, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_AUTO_CONNECT_IDE: '0' }), attachmentsDir: root, prepareImage: () => null, routing: { claudeEnv: (m, env) => service.claudeEnv(m, env), ensureModel: (m, images) => service.ensureModel(m, images) } })
  try {
    const status = process.env.DUET_ROUTER_INSTALL_TEST ? await service.install() : await service.start()
    expect(status.connected, status.error).toBe(true)
    expect(status.canManage, status.managementError).toBe(true)
    expect(status.models.map((m) => m.routing?.model)).toContain('bad/mock-model')
    await service.connect({ endpoint: status.endpoint, enabled: true, dataKey: 'mock-admission-key' })
    const saved = await service.saveCombo({ id: 'fallback-test', strategy: 'failover', targets: [{ provider: 'bad', model: 'mock-model', weight: 1 }, { provider: 'good', model: 'mock-model', weight: 1 }] })
    expect(saved.models.some((m) => m.routing?.model === 'combo/fallback-test')).toBe(true)
    const events: RuntimeEvent[] = []
    await adapter.startTurn({ threadId: 'live-test', cwd: root, model: 'router:combo/fallback-test', effort: 'xhigh', text: 'Say hello.', attachments: [], access: 'plan' }, (event) => events.push(event))
    const deadline = Date.now() + 25000
    while (!events.some((e) => e.type === 'turn-end') && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
    expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ status: 'completed' })
    expect(JSON.stringify(events)).toContain('ROUTING_FALLBACK_OK')
    expect(requests.some((p) => p.includes('/bad/') && p.endsWith('/responses'))).toBe(true)
    expect(requests.some((p) => p.includes('/good/') && p.endsWith('/responses'))).toBe(true)
    const claudeEvents: RuntimeEvent[] = []
    await claude.startTurn({ threadId: 'claude-live', cwd: root, model: 'router:good/mock-model', effort: 'xhigh', text: 'Say hello.', attachments: [], access: 'plan' }, (event) => claudeEvents.push(event))
    const claudeDeadline = Date.now() + 30000
    while (!claudeEvents.some((e) => e.type === 'turn-end') && Date.now() < claudeDeadline) await new Promise((done) => setTimeout(done, 100))
    expect(claudeEvents.find((e) => e.type === 'turn-end'), JSON.stringify(claudeEvents)).toMatchObject({ status: 'completed' })
    expect(JSON.stringify(claudeEvents)).toContain('ROUTING_FALLBACK_OK')
    await service.stop()
    expect(settings.enabled).toBe(false)
  } finally {
    await adapter.shutdown()
    await claude.shutdown()
    await service.shutdown()
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) })
  }
}, 120000)
