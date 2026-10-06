import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { CliStatus } from '@shared/types'

const MARKER = '# Installed by Duet'

/** Candidate folders for the `duet` command, best first (tests point DUET_CLI_DIR elsewhere). */
function candidates(): string[] {
  if (process.env.DUET_CLI_DIR) return [process.env.DUET_CLI_DIR]
  return ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), 'bin')]
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function onPath(dir: string, pathVar: string | undefined): boolean {
  return (pathVar ?? '').split(delimiter).some((p) => p.replace(/\/+$/, '') === dir)
}

function ours(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').includes(MARKER)
  } catch {
    return false
  }
}

/** Where `duet` is installed, or where it would go. */
export function cliStatus(pathVar: string | undefined): CliStatus {
  for (const dir of candidates()) {
    const file = join(dir, 'duet')
    if (existsSync(file) && ours(file)) return { installed: true, path: file, onPath: onPath(dir, pathVar) }
  }
  // Best: a writable folder already on PATH; then any writable one; then the first candidate
  // (with an override set, that is the only place it may go).
  const dirs = candidates()
  const dir = dirs.find((d) => writable(d) && onPath(d, pathVar)) ?? dirs.find((d) => writable(d)) ?? dirs.find((d) => d.startsWith(homedir())) ?? dirs[0]
  return { installed: false, path: join(dir, 'duet'), onPath: onPath(dir, pathVar) }
}

/** The small shell script that runs Duet's bundled cli.js with Duet's own runtime. */
export function cliScript(appBundle: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return [
    '#!/bin/sh',
    `${MARKER} (Settings → Command line). Remove it there, or delete this file.`,
    `DUET_APP=${q(appBundle)}`,
    'if [ ! -d "$DUET_APP" ]; then echo "duet: Duet.app was moved or deleted ($DUET_APP)" >&2; exit 1; fi',
    'exec env ELECTRON_RUN_AS_NODE=1 "$DUET_APP/Contents/MacOS/Duet" "$DUET_APP/Contents/Resources/cli.js" "$@"',
    ''
  ].join('\n')
}

export function installCli(appBundle: string, pathVar: string | undefined): CliStatus {
  const status = cliStatus(pathVar)
  const file = status.path
  if (existsSync(file) && !ours(file)) throw new Error(`${file} already exists and isn't Duet's. Remove it first.`)
  const dir = file.slice(0, file.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, cliScript(appBundle), { mode: 0o755 })
  return cliStatus(pathVar)
}

export function uninstallCli(pathVar: string | undefined): CliStatus {
  const status = cliStatus(pathVar)
  if (status.installed && ours(status.path)) rmSync(status.path, { force: true })
  return cliStatus(pathVar)
}
