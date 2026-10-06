import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { McpEntry, McpServerConfig, ProviderId } from '@shared/types'
import { codexHome } from './history'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

const strRecord = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (val !== undefined && val !== null) out[k] = String(val)
  return Object.keys(out).length ? out : undefined
}

const strArray = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => String(x)) : undefined)

// ---------- format conversion ----------

export function claudeToConfig(name: string, raw: Json): McpServerConfig {
  const type = raw?.type
  const url = typeof raw?.url === 'string' ? raw.url : undefined
  const transport = type === 'sse' ? 'sse' : type === 'http' || (url && !raw?.command) ? 'http' : 'stdio'
  return {
    name,
    transport,
    command: typeof raw?.command === 'string' ? raw.command : undefined,
    args: strArray(raw?.args),
    env: strRecord(raw?.env),
    url,
    headers: strRecord(raw?.headers),
    enabled: raw?.disabled === true ? false : undefined
  }
}

export function codexToConfig(name: string, raw: Json): McpServerConfig {
  const url = typeof raw?.url === 'string' ? raw.url : undefined
  return {
    name,
    transport: url && !raw?.command ? 'http' : 'stdio',
    command: typeof raw?.command === 'string' ? raw.command : undefined,
    args: strArray(raw?.args),
    env: strRecord(raw?.env),
    cwd: typeof raw?.cwd === 'string' ? raw.cwd : undefined,
    url,
    headers: strRecord(raw?.http_headers),
    bearerTokenEnvVar: typeof raw?.bearer_token_env_var === 'string' ? raw.bearer_token_env_var : undefined,
    enabled: raw?.enabled === false ? false : undefined
  }
}

/** JSON accepted by `claude mcp add-json`. */
export function configToClaude(cfg: McpServerConfig): Json {
  if (cfg.transport === 'stdio') {
    const out: Json = { type: 'stdio', command: cfg.command ?? '' }
    if (cfg.args?.length) out.args = cfg.args
    if (cfg.env && Object.keys(cfg.env).length) out.env = cfg.env
    return out
  }
  const out: Json = { type: cfg.transport, url: cfg.url ?? '' }
  const headers: Record<string, string> = { ...(cfg.headers ?? {}) }
  if (cfg.bearerTokenEnvVar && !headers.Authorization) headers.Authorization = `Bearer \${${cfg.bearerTokenEnvVar}}`
  if (Object.keys(headers).length) out.headers = headers
  return out
}

/** Table written to `[mcp_servers.<name>]` in Codex's config.toml. */
export function configToCodex(cfg: McpServerConfig): Json {
  if (cfg.transport === 'stdio') {
    const out: Json = { command: cfg.command ?? '' }
    out.args = cfg.args ?? []
    if (cfg.cwd) out.cwd = cfg.cwd
    if (cfg.enabled === false) out.enabled = false
    return out
  }
  const out: Json = { url: cfg.url ?? '' }
  const headers = { ...(cfg.headers ?? {}) }
  let bearer = cfg.bearerTokenEnvVar
  // "Authorization: Bearer ${VAR}" in Claude maps to Codex's bearer_token_env_var.
  const auth = headers.Authorization ?? headers.authorization
  const envRef = auth?.match(/^Bearer\s+\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
  if (envRef && !bearer) {
    bearer = envRef[1]
    delete headers.Authorization
    delete headers.authorization
  }
  if (bearer) out.bearer_token_env_var = bearer
  if (Object.keys(headers).length) out.http_headers = headers
  if (cfg.enabled === false) out.enabled = false
  return out
}

export function sameServer(a: McpServerConfig, b: McpServerConfig): boolean {
  const norm = (c: McpServerConfig) =>
    JSON.stringify({
      t: c.transport === 'sse' ? 'http' : c.transport,
      c: c.command ?? '',
      a: c.args ?? [],
      e: Object.entries(c.env ?? {}).sort(),
      u: c.url ?? ''
    })
  return norm(a) === norm(b)
}

/** Accepts `{mcpServers:{...}}`, a bare `{name: config}` map, or a single named config. */
export function parseMcpJson(text: string): McpServerConfig[] {
  const data = JSON.parse(text)
  const map: Record<string, Json> = data?.mcpServers ?? data?.mcp_servers ?? data?.servers ?? data
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Expected an object of MCP servers')
  const looksLikeSingle = typeof map.command === 'string' || typeof map.url === 'string'
  if (looksLikeSingle) throw new Error('Wrap a single server as {"name": { ... }} so it has a name')
  const out: McpServerConfig[] = []
  for (const [name, raw] of Object.entries(map)) {
    if (!raw || typeof raw !== 'object') continue
    if (typeof (raw as Json).command !== 'string' && typeof (raw as Json).url !== 'string') continue
    out.push(claudeToConfig(name, raw))
  }
  if (!out.length) throw new Error('No MCP servers found in that JSON')
  return out
}

// ---------- reading ----------

export function readClaudeJson(): Json {
  const path = join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export function readCodexConfig(): Json {
  const path = join(codexHome(), 'config.toml')
  if (!existsSync(path)) return {}
  try {
    return parseToml(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export function listMcp(cwd?: string): McpEntry[] {
  const entries: McpEntry[] = []
  const claude = readClaudeJson()
  for (const [name, raw] of Object.entries<Json>(claude.mcpServers ?? {})) {
    entries.push({ provider: 'claude', scope: 'user', config: claudeToConfig(name, raw) })
  }
  if (cwd) {
    const local = claude.projects?.[cwd]?.mcpServers ?? {}
    for (const [name, raw] of Object.entries<Json>(local)) entries.push({ provider: 'claude', scope: 'local', project: cwd, config: claudeToConfig(name, raw) })
    const projectFile = join(cwd, '.mcp.json')
    if (existsSync(projectFile)) {
      try {
        const data = JSON.parse(readFileSync(projectFile, 'utf8'))
        for (const [name, raw] of Object.entries<Json>(data.mcpServers ?? {})) entries.push({ provider: 'claude', scope: 'project', project: cwd, config: claudeToConfig(name, raw) })
      } catch {
        // Invalid .mcp.json — skip.
      }
    }
  }
  const codex = readCodexConfig()
  for (const [name, raw] of Object.entries<Json>(codex.mcp_servers ?? {})) {
    entries.push({ provider: 'codex', scope: 'user', config: codexToConfig(name, raw) })
  }
  return entries
}

export function mergeStatus(
  entries: McpEntry[],
  claudeStatus: { name: string; status: string; source?: string }[],
  codexStatus: { name: string; status: string; tools?: number }[]
): McpEntry[] {
  const out = entries.map((e) => ({ ...e }))
  const mapClaude = (s: string): McpEntry['status'] => (s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : s === 'needs-auth' ? 'needs-auth' : s === 'pending' ? 'pending' : s === 'disabled' ? 'disabled' : 'unknown')
  for (const s of claudeStatus) {
    const match = out.find((e) => e.provider === 'claude' && e.config.name === s.name)
    if (match) match.status = mapClaude(s.status)
    else if (s.name.startsWith('plugin:') || s.name.startsWith('claude.ai ')) {
      out.push({
        provider: 'claude',
        scope: s.name.startsWith('plugin:') ? 'plugin' : 'cloud',
        readOnly: true,
        status: mapClaude(s.status),
        config: { name: s.name, transport: 'http' }
      })
    }
  }
  for (const s of codexStatus) {
    const match = out.find((e) => e.provider === 'codex' && e.config.name === s.name)
    if (match) {
      match.status = s.status === 'connected' ? 'connected' : s.status === 'failed' ? 'failed' : s.status === 'authenticationRequired' || s.status === 'notLoggedIn' ? 'needs-auth' : s.status === 'disabled' ? 'disabled' : s.status === 'starting' ? 'pending' : match.status ?? 'unknown'
      if (typeof s.tools === 'number') match.tools = s.tools
    }
  }
  return out
}

export const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/

export function validateServer(cfg: McpServerConfig): string | null {
  if (!MCP_NAME.test(cfg.name)) return 'Use letters, numbers, dashes or underscores for the name (max 64).'
  if (cfg.transport === 'stdio' && !cfg.command?.trim()) return 'A command is required for local (stdio) servers.'
  if (cfg.transport !== 'stdio') {
    try {
      const u = new URL(cfg.url ?? '')
      if (!/^https?:$/.test(u.protocol)) return 'The URL must start with http:// or https://'
    } catch {
      return 'Enter a valid server URL.'
    }
  }
  return null
}

// ---------- writing ----------

export interface McpWriteDeps {
  /** Runs the Claude CLI (`claude mcp ...`). */
  claude: (args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string; code: number }>
  /** Sends a request to the Codex app-server. */
  codex: (method: string, params: Json) => Promise<Json>
  /** Reads ~/.claude.json (defaults to the real one). */
  readClaude?: () => Json
  /** Reads ~/.codex/config.toml (defaults to the real one). */
  readCodex?: () => Json
}

export type ClaudeScope = 'user' | 'local' | 'project'

export interface ClaudeWriteTarget {
  scope?: ClaudeScope
  /** Project folder for local and project scoped servers. */
  project?: string
  /** The server's current name when it is being renamed. */
  previousName?: string
}

/** Keys Duet edits; everything else in a server's entry (oauth, headersHelper, timeouts…) is kept. */
const CLAUDE_MANAGED = ['type', 'command', 'args', 'env', 'url', 'headers']
const CODEX_MANAGED = ['command', 'args', 'env', 'url', 'http_headers', 'bearer_token_env_var']

function plainObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** The raw entry Claude has for a server in one scope, or null. */
export function readClaudeServer(deps: McpWriteDeps, name: string, scope: ClaudeScope, project?: string): Json | null {
  if (scope === 'project') {
    if (!project) return null
    try {
      return plainObject(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'))?.mcpServers?.[name])
    } catch {
      return null
    }
  }
  const data = (deps.readClaude ?? readClaudeJson)()
  return plainObject(scope === 'local' ? data?.projects?.[project ?? '']?.mcpServers?.[name] : data?.mcpServers?.[name])
}

/** New Claude entry: Duet's fields on top of whatever else the existing entry had. */
export function mergeClaudeEntry(existing: Json | null, cfg: McpServerConfig): Json {
  const base: Json = { ...(plainObject(existing) ?? {}) }
  for (const key of CLAUDE_MANAGED) delete base[key]
  return { ...base, ...configToClaude(cfg) }
}

export async function writeClaudeServer(deps: McpWriteDeps, cfg: McpServerConfig, target: ClaudeWriteTarget = {}): Promise<void> {
  const err = validateServer(cfg)
  if (err) throw new Error(err)
  const scope = target.scope ?? 'user'
  const cwd = scope === 'user' ? undefined : target.project
  if (scope !== 'user' && !cwd) throw new Error(`A project folder is needed to change a ${scope} server.`)
  const oldName = target.previousName ?? cfg.name
  const existing = readClaudeServer(deps, oldName, scope, cwd)
  const entry = mergeClaudeEntry(existing, cfg)
  const run = async (args: string[], what: string) => {
    const res = await deps.claude([...args, '--scope', scope], cwd)
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `claude mcp ${what} failed (${res.code})`)
  }
  const add = (name: string, value: Json) => run(['mcp', 'add-json', name, JSON.stringify(value)], 'add-json')
  if (oldName !== cfg.name) {
    // Rename: add under the new name first, so a failure leaves the old entry untouched.
    await add(cfg.name, entry)
    if (existing) await run(['mcp', 'remove', oldName], 'remove')
    return
  }
  if (!existing) return add(cfg.name, entry)
  // Claude has no "update": replace the entry, and put the old one back if the new one is refused.
  await run(['mcp', 'remove', cfg.name], 'remove')
  try {
    await add(cfg.name, entry)
  } catch (error) {
    await add(cfg.name, existing).catch(() => undefined)
    throw error
  }
}

export async function removeClaudeServer(deps: McpWriteDeps, name: string, scope: string, cwd?: string): Promise<void> {
  const res = await deps.claude(['mcp', 'remove', name, '--scope', scope], cwd)
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `claude mcp remove failed (${res.code})`)
}

export async function writeCodexServer(deps: McpWriteDeps, cfg: McpServerConfig, previousName?: string): Promise<void> {
  const err = validateServer(cfg)
  if (err) throw new Error(err)
  const renamed = !!previousName && previousName !== cfg.name
  if (renamed && !MCP_NAME.test(previousName)) throw new Error(`Cannot rename "${previousName}" in Codex: unsupported name`)
  let table = configToCodex(cfg)
  if (renamed) {
    // Carry the old entry's other settings (per-tool approvals, timeouts…) over to the new name.
    const old = plainObject((deps.readCodex ?? readCodexConfig)()?.mcp_servers?.[previousName])
    if (old) {
      const base: Json = { ...old }
      for (const key of CODEX_MANAGED) delete base[key]
      table = { ...base, ...table }
    }
  }
  const key = `mcp_servers.${cfg.name}`
  const edits: Json[] = [{ keyPath: key, value: table, mergeStrategy: 'upsert' }]
  // Fields Duet manages are replaced so removed args/env/headers really disappear,
  // while unrelated keys (per-tool approval settings, timeouts) are preserved.
  edits.push({ keyPath: `${key}.env`, value: cfg.transport === 'stdio' && cfg.env && Object.keys(cfg.env).length ? cfg.env : null, mergeStrategy: 'replace' })
  if (cfg.transport === 'stdio') {
    edits.push({ keyPath: `${key}.url`, value: null, mergeStrategy: 'replace' })
    edits.push({ keyPath: `${key}.http_headers`, value: null, mergeStrategy: 'replace' })
    edits.push({ keyPath: `${key}.bearer_token_env_var`, value: null, mergeStrategy: 'replace' })
  } else {
    edits.push({ keyPath: `${key}.command`, value: null, mergeStrategy: 'replace' })
    edits.push({ keyPath: `${key}.args`, value: null, mergeStrategy: 'replace' })
    if (!table.http_headers) edits.push({ keyPath: `${key}.http_headers`, value: null, mergeStrategy: 'replace' })
    if (!table.bearer_token_env_var) edits.push({ keyPath: `${key}.bearer_token_env_var`, value: null, mergeStrategy: 'replace' })
  }
  // Only an explicit choice changes whether the server is on: an edit never re-enables it.
  if (cfg.enabled === true) edits.push({ keyPath: `${key}.enabled`, value: null, mergeStrategy: 'replace' })
  // A rename removes the old entry in the same atomic write.
  if (renamed) edits.push({ keyPath: `mcp_servers.${previousName}`, value: null, mergeStrategy: 'replace' })
  await deps.codex('config/batchWrite', { edits, reloadUserConfig: true })
  await deps.codex('config/mcpServer/reload', {}).catch(() => undefined)
}

export async function removeCodexServer(deps: McpWriteDeps, name: string): Promise<void> {
  if (!MCP_NAME.test(name)) throw new Error(`Cannot remove "${name}" from Codex: unsupported name`)
  const key = `mcp_servers.${name}`
  await deps.codex('config/batchWrite', { edits: [{ keyPath: key, value: null, mergeStrategy: 'replace' }], reloadUserConfig: true })
  await deps.codex('config/mcpServer/reload', {}).catch(() => undefined)
}

export type ProviderTarget = ProviderId
