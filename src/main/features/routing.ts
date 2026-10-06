import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { ModelOption, RoutingCombo, RoutingSettings, RoutingStatus, RoutingTarget } from '@shared/types'
import { ROUTED_MODEL_PREFIX, routedModel } from '@shared/routing'

const ENGINE_VERSION = '2.79.0'
const MANAGED_ENDPOINT = 'http://127.0.0.1:10101'
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
type Json = Record<string, any>
type Credentials = { dataKey?: string; adminKey?: string }

export interface RoutingDeps {
  root: string
  settings: () => RoutingSettings
  saveSettings: (settings: RoutingSettings) => void
  env: () => NodeJS.ProcessEnv
  encrypt: (value: string) => Buffer
  decrypt: (value: Buffer) => string
}

export function routingEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid routing server address.')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Enter a valid routing server address.') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || !['', '/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('Use HTTPS, or HTTP on localhost. Enter the server address without credentials or a path.')
  }
  return url.origin
}

function text(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x1f]/.test(value) ? value : undefined
}

/** Normalize only models the server advertises. Never invent capabilities from a model's name. */
export function routingModels(list: unknown, catalog: unknown = null): ModelOption[] {
  const rows = Array.isArray((list as Json)?.data) ? (list as Json).data : []
  const metadata = Array.isArray((catalog as Json)?.models) ? (catalog as Json).models : []
  const byId = new Map<string, Json>()
  for (const m of metadata.filter((m: unknown) => m && typeof m === 'object')) {
    for (const id of [m.namespaced, m.slug, m.id, m.model]) if (typeof id === 'string') byId.set(id, m)
  }
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const row of rows.slice(0, 10000)) {
    const id = text(row?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const m = { ...row, ...(byId.get(id) ?? {}) }
    if (m.visibility === 'hide' || m.hidden === true || m.disabled === true || m.initialSelectionPending === true) continue
    const provider = id.includes('/') ? id.split('/')[0] : text(row.owned_by) ?? 'Provider'
    const levels = m.reasoningEfforts ?? m.supported_reasoning_levels ?? m.supportedReasoningEfforts ?? []
    const efforts = Array.isArray(levels) ? levels.map((e) => text(typeof e === 'string' ? e : e?.effort ?? e?.reasoningEffort, 32)).filter((e): e is string => !!e) : []
    const modalities = m.input_modalities ?? m.inputModalities
    models.push({
      id: `${ROUTED_MODEL_PREFIX}${id}`,
      label: text(m.displayNameOverride ?? m.display_name ?? m.displayName ?? m.name, 200) ?? id,
      description: text(m.description, 1500),
      efforts,
      defaultEffort: text(m.defaultReasoningEffort ?? m.default_reasoning_level, 32),
      supportsImages: Array.isArray(modalities) ? modalities.includes('image') : false,
      routing: { model: id, provider, combo: provider === 'combo' }
    })
  }
  return models
}

export function validateCombo(input: unknown): { id: string; strategy: 'failover' | 'round-robin'; targets: RoutingTarget[] } {
  const body = input as Json
  if (!body || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.id) || !['failover', 'round-robin'].includes(body.strategy)) throw new Error('Give the route a name using letters, numbers, dots, dashes or underscores, and choose a routing strategy.')
  if (!Array.isArray(body.targets) || !body.targets.length || body.targets.length > 20) throw new Error('Choose between one and twenty route targets.')
  const seen = new Set<string>()
  const targets = body.targets.map((t: Json) => {
    if (!text(t?.provider, 200) || !text(t?.model) || t.provider === 'combo' || t.provider.includes('/') || !Number.isInteger(t.weight) || t.weight < 1 || t.weight > 10000) throw new Error('Each route target needs a provider, model and weight from 1 to 10,000.')
    const id = `${t.provider}/${t.model}`
    if (seen.has(id)) throw new Error('Choose each model only once in a route.')
    seen.add(id)
    return { provider: t.provider, model: t.model, weight: t.weight } as RoutingTarget
  })
  return { id: body.id, strategy: body.strategy, targets }
}

export class RoutingService {
  private child: ChildProcess | null = null
  private installing: Promise<RoutingStatus> | null = null
  private starting: Promise<void> | null = null
  private cache: { at: number; endpoint: string; value: RoutingStatus } | null = null
  private credentials: Record<string, Credentials> = {}
  private readonly secretPath: string
  private readonly engineDir: string
  private readonly engineHome: string

  constructor(private readonly deps: RoutingDeps) {
    this.secretPath = join(deps.root, 'routing-credentials.enc')
    this.engineDir = join(deps.root, 'routing-engine')
    this.engineHome = join(deps.root, 'routing-state')
    if (existsSync(this.secretPath)) {
      try { this.credentials = JSON.parse(deps.decrypt(readFileSync(this.secretPath))) } catch { /* Locked Keychain: ask to enter the keys again. */ }
    }
  }

  private get binary(): string { return join(this.engineDir, 'node_modules', '.bin', 'ocx') }

  private credential(endpoint: string): Credentials { return this.credentials[endpoint] ?? {} }

  private localAdmin(endpoint: string): string | undefined {
    const url = new URL(endpoint)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined
    const home = endpoint === MANAGED_ENDPOINT ? this.engineHome : url.port === '10100' ? this.deps.env().OPENCODEX_HOME || join(homedir(), '.opencodex') : null
    if (!home) return undefined
    try {
      const path = join(home, 'admin-api-token')
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 || (stat.mode & 0o077) !== 0) return undefined
      const key = readFileSync(path, 'utf8').trim()
      return /^ocx_admin_[A-Za-z0-9_-]{43}$/.test(key) ? key : undefined
    } catch { return undefined }
  }

  private async request(endpoint: string, path: string, admin = false, method = 'GET', body?: unknown): Promise<any> {
    const keys = this.credential(endpoint)
    const key = admin ? keys.adminKey || this.localAdmin(endpoint) : keys.dataKey
    if (admin && !key) throw new Error('Add the server’s admin key to manage routes, or use its dashboard.')
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (key) headers['X-OpenCodex-API-Key'] = key
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let res: Response
    try {
      res = await fetch(`${endpoint}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' })
    } catch { throw new Error('The routing server did not respond. Start it, then check the address and try again.') }
    if (!res.ok) {
      await res.body?.cancel()
      // A remote error body can echo credentials. Show only an actionable status, never that body.
      if (res.status === 401 || res.status === 403) throw new Error(admin ? 'The server rejected the admin key. Check it in connection settings.' : 'The server rejected the API key. Check it in connection settings.')
      if (res.status === 404) throw new Error('This server does not support the requested OpenCodex API. Update the routing engine.')
      throw new Error(`The routing server returned HTTP ${res.status}. Check its dashboard for details.`)
    }
    const reader = res.body?.getReader()
    if (!reader) throw new Error('The routing server returned an empty response.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('The routing server returned too much data.') }
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      if (size > MAX_RESPONSE_BYTES) throw error
      throw new Error('The routing server returned an invalid response.')
    } finally { reader.releaseLock() }
  }

  async connect(input: { endpoint: string; enabled: boolean; dataKey?: string; adminKey?: string }): Promise<RoutingStatus> {
    const endpoint = routingEndpoint(input?.endpoint)
    if (typeof input.enabled !== 'boolean') throw new Error('Choose whether routing is enabled.')
    const next = { ...this.credential(endpoint) }
    for (const name of ['dataKey', 'adminKey'] as const) {
      if (input[name] === undefined) continue
      const key = input[name]!.trim()
      if (key.length > 4096 || /[\x00-\x1f]/.test(key)) throw new Error('That key is not valid.')
      if (name === 'dataKey' && key.startsWith('ocx_admin_')) throw new Error('Use a data-plane API key here. The admin key belongs in its separate field.')
      next[name] = key || undefined
    }
    const credentials = { ...this.credentials, [endpoint]: next }
    if (next.dataKey && next.dataKey === (next.adminKey || this.localAdmin(endpoint))) throw new Error('The API key and admin key must be different.')
    const encrypted = this.deps.encrypt(JSON.stringify(credentials))
    mkdirSync(this.deps.root, { recursive: true })
    const tmp = `${this.secretPath}.${randomUUID()}.tmp`
    writeFileSync(tmp, encrypted, { mode: 0o600 })
    renameSync(tmp, this.secretPath)
    chmodSync(this.secretPath, 0o600)
    this.credentials = credentials
    this.deps.saveSettings({ enabled: input.enabled, endpoint })
    this.cache = null
    if (input.enabled && endpoint === MANAGED_ENDPOINT && existsSync(this.binary)) await this.startManaged()
    return this.status(true)
  }

  async status(force = false): Promise<RoutingStatus> {
    const endpoint = routingEndpoint(this.deps.settings().endpoint)
    if (!force && this.cache?.endpoint === endpoint && Date.now() - this.cache.at < 30000) return this.cache.value
    const keys = this.credential(endpoint)
    const status: RoutingStatus = { endpoint, connected: false, managedInstalled: existsSync(this.binary), managedRunning: !!this.child, models: [], combos: [], canManage: false, hasDataKey: !!keys.dataKey, hasAdminKey: !!(keys.adminKey || this.localAdmin(endpoint)) }
    try {
      const models = await this.request(endpoint, '/v1/models')
      const rows = status.hasAdminKey ? await this.request(endpoint, '/api/models', true).catch(() => null) : null
      const catalog = Array.isArray(rows) ? { models: rows } : await this.request(endpoint, '/v1/catalog').catch(() => null)
      status.models = routingModels(models, catalog)
      status.connected = true
      if (status.hasAdminKey) {
        try {
          const combos = await this.request(endpoint, '/api/combos', true)
          status.combos = Array.isArray(combos?.combos) ? combos.combos.filter((c: Json) => text(c?.id) && Array.isArray(c.targets)).map((c: Json) => ({ id: c.id, model: c.model ?? `combo/${c.id}`, strategy: c.strategy ?? 'failover', targets: c.targets.map((t: Json) => ({ provider: t.provider, model: t.model, weight: t.weight ?? 1 })) })) : []
          status.canManage = true
        } catch (error) { status.managementError = (error as Error).message }
      }
    } catch (error) { status.error = (error as Error).message }
    this.cache = { at: Date.now(), endpoint, value: status }
    return status
  }

  async models(): Promise<ModelOption[]> {
    if (!this.deps.settings().enabled) return []
    if (this.deps.settings().endpoint === MANAGED_ENDPOINT && existsSync(this.binary)) await this.startManaged()
    return (await this.status()).models
  }

  async ensureModel(model: string | undefined, hasImages = false): Promise<ModelOption | undefined> {
    const selected = routedModel(model)
    if (selected === undefined) return
    this.codexConfig(model)
    const models = await this.models()
    const match = models.find((m) => m.routing?.model === selected)
    if (!match) throw new Error('This routed model is unavailable. Start the routing engine and refresh models in Settings → Models & routing.')
    if (hasImages && !match.supportsImages) throw new Error('This provider does not advertise image support for that model. Choose a model that supports images, or remove the attachment.')
    return match
  }

  sessionKey(model: string | undefined): string | undefined {
    return routedModel(model) === undefined ? undefined : `routing:${routingEndpoint(this.deps.settings().endpoint)}`
  }

  /** Per-thread overrides: the real model id goes upstream, while Duet stores an explicit routed id. */
  codexConfig(model: string | undefined): { model: string | undefined; modelProvider?: string; config?: Json } {
    const selected = routedModel(model)
    if (selected === undefined) return { model }
    if (!selected || !this.deps.settings().enabled) throw new Error('Routing is disabled. Enable it in Settings → Models & routing, or choose a native model.')
    const endpoint = routingEndpoint(this.deps.settings().endpoint)
    const key = this.credential(endpoint).dataKey
    return {
      model: selected,
      modelProvider: 'duet_router',
      config: {
        'model_providers.duet_router': { name: 'Duet routing', base_url: `${endpoint}/v1`, wire_api: 'responses', requires_openai_auth: false, ...(key ? { env_http_headers: { 'X-OpenCodex-API-Key': 'DUET_ROUTING_API_KEY' } } : {}) }
      }
    }
  }

  claudeEnv(model: string | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (routedModel(model) === undefined) return env
    this.codexConfig(model) // validates enabled state and address
    const next: NodeJS.ProcessEnv = { ...env, ANTHROPIC_BASE_URL: routingEndpoint(this.deps.settings().endpoint), CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' }
    const key = this.credential(this.deps.settings().endpoint).dataKey
    // Gateway credentials replace native API credentials only for explicitly routed sessions.
    delete next.ANTHROPIC_API_KEY
    next.ANTHROPIC_AUTH_TOKEN = key || 'duet-local-routing'
    return next
  }

  codexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const next = { ...env }
    const key = this.credential(routingEndpoint(this.deps.settings().endpoint)).dataKey
    if (key) next.DUET_ROUTING_API_KEY = key
    else delete next.DUET_ROUTING_API_KEY
    return next
  }

  async saveCombo(input: unknown): Promise<RoutingStatus> {
    const combo = validateCombo(input)
    const status = await this.status(true)
    if (!status.canManage) throw new Error(status.managementError || 'Connect an admin key to create routes.')
    const advertised = new Set(status.models.filter((m) => !m.routing?.combo).map((m) => m.routing?.model))
    for (const target of combo.targets) if (!advertised.has(`${target.provider}/${target.model}`)) throw new Error('A route target is no longer available. Refresh models and choose it again.')
    const current = await this.request(status.endpoint, '/api/combos', true)
    const previous = Array.isArray(current?.combos) ? current.combos.find((c: Json) => c.id === combo.id) : undefined
    const { id: _id, model: _model, ...options } = previous ?? {}
    await this.request(status.endpoint, '/api/combos', true, 'PUT', { id: combo.id, combo: { ...options, strategy: combo.strategy, targets: combo.targets } })
    this.cache = null
    return this.status(true)
  }

  async removeCombo(id: string): Promise<RoutingStatus> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error('Invalid route name.')
    await this.request(routingEndpoint(this.deps.settings().endpoint), `/api/combos?id=${encodeURIComponent(id)}`, true, 'DELETE')
    this.cache = null
    return this.status(true)
  }

  install(): Promise<RoutingStatus> {
    if (this.installing) return this.installing
    this.installing = (async () => {
      mkdirSync(this.engineDir, { recursive: true })
      // Recent npm versions require lifecycle permissions in the project's manifest,
      // rather than an --allow-scripts command-line flag for project installations.
      writeFileSync(join(this.engineDir, 'package.json'), JSON.stringify({
        name: 'duet-routing-engine', private: true, version: '1.0.0',
        dependencies: { '@bitkyc08/opencodex': ENGINE_VERSION },
        allowScripts: { 'bun@1.4.0': true }
      }, null, 2), { mode: 0o600 })
      await new Promise<void>((resolve, reject) => {
        execFile('npm', ['install', '--prefix', this.engineDir, '--no-audit', '--no-fund'], { cwd: this.engineDir, env: this.deps.env(), timeout: 300000, maxBuffer: 2 * 1024 * 1024 }, (error) => error ? reject(new Error('Could not install the routing engine. Check your internet connection and that npm is installed.')) : resolve())
      })
      return this.start()
    })().finally(() => { this.installing = null })
    return this.installing
  }

  private startManaged(): Promise<void> {
    if (this.child) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = (async () => {
      if (!existsSync(this.binary)) throw new Error('Install the routing engine first.')
      await new Promise<void>((resolve, reject) => {
        const probe = createServer()
        probe.once('error', () => reject(new Error('Port 10101 is already in use. Stop the other server, or connect to it in connection settings.')))
        probe.listen({ host: '127.0.0.1', port: 10101, exclusive: true }, () => probe.close(() => resolve()))
      })
      mkdirSync(this.engineHome, { recursive: true, mode: 0o700 })
      for (const name of ['codex', 'claude']) mkdirSync(join(this.engineHome, name), { recursive: true, mode: 0o700 })
      const path = join(this.engineHome, 'config.json')
      if (!existsSync(path)) writeFileSync(path, JSON.stringify({ port: 10101, hostname: '127.0.0.1', codexAutoStart: false, claudeCode: { enabled: true, systemEnv: false, cliFirstParty: false, intercept: { enabled: false } } }), { mode: 0o600 })
      const env = { ...this.deps.env(), OPENCODEX_HOME: this.engineHome, CODEX_HOME: join(this.engineHome, 'codex'), CLAUDE_CONFIG_DIR: join(this.engineHome, 'claude'), CI: '1' }
      const child = spawn(this.binary, ['start', '--port', '10101', '--socks5-off'], { env, stdio: 'ignore', detached: process.platform !== 'win32' })
      this.child = child
      let failed = false
      child.on('error', () => { failed = true; if (this.child === child) this.child = null })
      child.on('exit', () => { failed = true; if (this.child === child) this.child = null; this.cache = null })
      for (let i = 0; i < 60; i++) {
        if (failed) throw new Error('Could not start the routing engine. Port 10101 may already be in use.')
        try {
          const health = await fetch(`${MANAGED_ENDPOINT}/readyz`, { signal: AbortSignal.timeout(500), redirect: 'error' })
          const data = await health.json() as Json
          if (health.ok && data.service === 'opencodex' && this.child === child && !failed) return
        } catch { /* The listener is still starting. */ }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      await this.shutdown()
      throw new Error('The routing engine took too long to start. Try again.')
    })().finally(() => { this.starting = null })
    return this.starting
  }

  async start(): Promise<RoutingStatus> {
    await this.startManaged()
    this.deps.saveSettings({ enabled: true, endpoint: MANAGED_ENDPOINT })
    this.cache = null
    return this.status(true)
  }

  async stop(): Promise<RoutingStatus> {
    await this.shutdown()
    if (this.deps.settings().endpoint === MANAGED_ENDPOINT) this.deps.saveSettings({ ...this.deps.settings(), enabled: false })
    this.cache = null
    return this.status(true)
  }

  async shutdown(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* Already exited. */ }
    }
    kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { kill('SIGKILL'); resolve() }, 10000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}
