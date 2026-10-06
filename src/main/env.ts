import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { ProviderId } from '@shared/types'

/**
 * Apps launched from Finder/Dock get a minimal PATH (/usr/bin:/bin:...). Agents need the
 * user's real login-shell environment to find node, git, brew tools, etc.
 */
let cachedEnv: NodeJS.ProcessEnv | null = null

const STRIP_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS']

function extraPathDirs(): string[] {
  const home = homedir()
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.local/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.bun/bin'),
    join(home, '.cargo/bin'),
    join(home, '.claude/local'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
}

function run(file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: env ?? process.env }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

export function parseEnvNul(output: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of output.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq).replace(/^\s+/, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = entry.slice(eq + 1)
  }
  return env
}

export function mergePath(...paths: (string | undefined)[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!p) continue
    for (const dir of p.split(delimiter)) {
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      out.push(dir)
    }
  }
  return out.join(delimiter)
}

export async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedEnv) return cachedEnv
  let shellVars: Record<string, string> = {}
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || '/bin/zsh'
    const marker = '__DUET_ENV_START__'
    try {
      const out = await run(shell, ['-ilc', `printf '${marker}'; /usr/bin/env -0`], 10_000, {
        ...process.env,
        DISABLE_AUTO_UPDATE: 'true',
        ZSH_TMUX_AUTOSTARTED: 'true'
      })
      const start = out.indexOf(marker)
      if (start >= 0) shellVars = parseEnvNul(out.slice(start + marker.length))
    } catch {
      // Fall back to the process environment plus well-known directories.
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...shellVars }
  env.PATH = mergePath(shellVars.PATH, process.env.PATH, extraPathDirs().join(delimiter))
  for (const key of STRIP_VARS) delete env[key]
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  cachedEnv = env
  return env
}

export function getEnv(): NodeJS.ProcessEnv {
  return cachedEnv ?? { ...process.env, PATH: mergePath(process.env.PATH, extraPathDirs().join(delimiter)) }
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const BINARY_NAMES: Record<ProviderId, string> = { claude: 'claude', codex: 'codex' }

function knownLocations(id: ProviderId): string[] {
  const home = homedir()
  if (id === 'claude') {
    return [
      join(home, '.claude/local/claude'),
      join(home, '.local/bin/claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      join(home, '.npm-global/bin/claude'),
      join(home, '.bun/bin/claude')
    ]
  }
  return [
    join(home, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.npm-global/bin/codex'),
    join(home, '.bun/bin/codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  ]
}

/** Finds an agent CLI: explicit override first, then PATH, then well-known install locations. */
export function findBinary(id: ProviderId, override?: string): string | null {
  if (override && override.trim()) {
    const p = override.trim().replace(/^~(?=$|\/)/, homedir())
    return isExecutable(p) ? p : null
  }
  const name = BINARY_NAMES[id]
  const path = getEnv().PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  for (const candidate of knownLocations(id)) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export async function binaryVersion(path: string): Promise<string | undefined> {
  try {
    const out = await run(path, ['--version'], 15_000, getEnv())
    const match = out.match(/\d+\.\d+\.\d+(?:[-.\w]*)?/)
    return match ? match[0] : out.trim().slice(0, 40) || undefined
  } catch {
    return undefined
  }
}

export function runCommand(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024, env: getEnv() },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((error as { code?: unknown }).code) : 1) : 0
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error && !stderr ? error.message : ''), code })
      }
    )
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }
  })
}
