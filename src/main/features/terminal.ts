import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import { getEnv } from '../env'

type PtyModule = typeof import('node-pty')

let ptyModule: PtyModule | null = null
function loadPty(): PtyModule {
  if (!ptyModule) {
    // Loaded lazily so a broken native build only disables the terminal, not the app.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty') as PtyModule
  }
  return ptyModule
}

export class TerminalManager {
  private terms = new Map<string, IPty>()

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, code: number) => void
  ) {}

  create(cwd: string, cols: number, rows: number): string {
    const pty = loadPty()
    const id = randomUUID()
    const shell = process.env.SHELL || '/bin/zsh'
    const env = { ...getEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Duet' } as Record<string, string>
    const term = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(10, Math.floor(cols) || 80),
      rows: Math.max(4, Math.floor(rows) || 24),
      cwd: cwd && existsSync(cwd) ? cwd : homedir(),
      env
    })
    this.terms.set(id, term)
    term.onData((data) => this.onData(id, data))
    term.onExit(({ exitCode }) => {
      this.terms.delete(id)
      this.onExit(id, exitCode)
    })
    return id
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.terms.get(id)
    if (!term) return
    try {
      term.resize(Math.max(10, Math.floor(cols)), Math.max(4, Math.floor(rows)))
    } catch {
      // Resizing a pty that just exited throws; ignore.
    }
  }

  kill(id: string): void {
    const term = this.terms.get(id)
    if (!term) return
    this.terms.delete(id)
    try {
      term.kill()
    } catch {
      // already gone
    }
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }
}
