import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { McpWriteDeps } from './mcp'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

/**
 * File-based stand-ins for `claude mcp …` and Codex `config/batchWrite`, used in demo/test
 * mode so automated runs never touch a real installation.
 */
export function fakeMcpDeps(home: string): McpWriteDeps {
  const claudeJson = join(home, '.claude.json')
  const codexToml = join(home, '.codex', 'config.toml')
  const readJson = (): Json => (existsSync(claudeJson) ? JSON.parse(readFileSync(claudeJson, 'utf8')) : {})
  const readToml = (): Json => (existsSync(codexToml) ? parseToml(readFileSync(codexToml, 'utf8')) : {})
  return {
    readClaude: readJson,
    readCodex: readToml,
    // Behaves like `claude mcp add-json/remove --scope …`, including refusing duplicate names.
    claude: async (args, cwd) => {
      const scopeAt = args.indexOf('--scope')
      const scope = scopeAt >= 0 ? args[scopeAt + 1] : 'local'
      const [cmd, sub, name, json] = args
      if (cmd !== 'mcp' || (sub !== 'add-json' && sub !== 'remove')) return { stdout: '', stderr: 'unsupported', code: 1 }
      const projectFile = join(cwd ?? home, '.mcp.json')
      const data: Json = scope === 'project' ? (existsSync(projectFile) ? JSON.parse(readFileSync(projectFile, 'utf8')) : {}) : readJson()
      let servers: Json
      if (scope === 'user' || scope === 'project') servers = data.mcpServers ??= {}
      else servers = ((data.projects ??= {})[cwd ?? home] ??= {}).mcpServers ??= {}
      if (sub === 'add-json') {
        if (servers[name]) return { stdout: '', stderr: `MCP server ${name} already exists in ${scope} config`, code: 1 }
        const parsed = JSON.parse(json)
        if (parsed.type === 'stdio' && !parsed.command) return { stdout: '', stderr: 'Invalid configuration: command is required', code: 1 }
        servers[name] = parsed
      } else {
        if (!servers[name]) return { stdout: '', stderr: `No MCP server named ${name}`, code: 1 }
        delete servers[name]
      }
      writeFileSync(scope === 'project' ? projectFile : claudeJson, JSON.stringify(data, null, 2))
      return { stdout: 'ok', stderr: '', code: 0 }
    },
    codex: async (method, params) => {
      if (method === 'config/mcpServer/reload') return {}
      if (method !== 'config/batchWrite') throw new Error(`unsupported ${method}`)
      const data = readToml()
      for (const edit of params.edits as { keyPath: string; value: Json; mergeStrategy: string }[]) {
        const parts = edit.keyPath.split('.')
        let node = data
        for (const part of parts.slice(0, -1)) {
          if (edit.value === null && !node[part]) {
            node = null
            break
          }
          node[part] ??= {}
          node = node[part]
        }
        if (!node) continue
        const last = parts[parts.length - 1]
        if (edit.value === null) delete node[last]
        else if (edit.mergeStrategy === 'upsert' && typeof edit.value === 'object' && !Array.isArray(edit.value)) node[last] = { ...(node[last] ?? {}), ...edit.value }
        else node[last] = edit.value
      }
      mkdirSync(dirname(codexToml), { recursive: true })
      writeFileSync(codexToml, stringifyToml(data))
      return { status: 'ok' }
    }
  }
}
