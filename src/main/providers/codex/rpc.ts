import { spawn, type ChildProcess } from 'node:child_process'
import { LineSplitter, TailBuffer } from '../../util/lines'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/**
 * Minimal client for `codex app-server`: newline-delimited JSON-RPC over stdio
 * (no "jsonrpc" field; requests `{id, method, params}`, notifications `{method, params}`).
 */
export class CodexRpc {
  readonly child: ChildProcess
  readonly stderr = new TailBuffer(8000)
  private splitter: LineSplitter
  private nextId = 1
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }>()
  exited = false
  onNotification?: (method: string, params: Json) => void
  onRequest?: (id: number | string, method: string, params: Json) => void
  onExit?: (code: number | null) => void

  constructor(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
    this.child = spawn(bin, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.splitter = new LineSplitter((line) => this.onLine(line))
    this.child.stdout?.on('data', (chunk) => this.splitter.push(chunk))
    this.child.stderr?.on('data', (chunk) => this.stderr.push(chunk))
    this.child.stdin?.on('error', () => {
      // EPIPE after exit; handled by the exit listener.
    })
    this.child.on('error', (error) => {
      this.stderr.push(`\n${error.message}`)
      this.handleExit(null)
    })
    this.child.on('exit', (code) => this.handleExit(code))
  }

  private handleExit(code: number | null): void {
    if (this.exited) return
    this.splitter.flush()
    this.exited = true
    const reason = this.stderr.value.trim().split('\n').slice(-4).join('\n') || `Codex app-server exited (code ${code ?? 'unknown'})`
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new RpcError(reason))
    }
    this.pending.clear()
    this.onExit?.(code)
  }

  private onLine(line: string): void {
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const hasId = msg.id !== undefined && msg.id !== null
    if (hasId && typeof msg.method === 'string') {
      this.onRequest?.(msg.id, msg.method, msg.params)
      return
    }
    if (hasId) {
      const pending = this.pending.get(Number(msg.id))
      if (!pending) return
      this.pending.delete(Number(msg.id))
      clearTimeout(pending.timer)
      if (msg.error) pending.reject(new RpcError(msg.error.message || `${pending.method} failed`, msg.error.code, msg.error.data))
      else pending.resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string') this.onNotification?.(msg.method, msg.params)
  }

  private write(message: Json): void {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) throw new RpcError('Codex app-server is not running')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  request<T = Json>(method: string, params?: Json, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(`Codex did not answer ${method} in time`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.write(params === undefined ? { id, method } : { id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  notify(method: string, params?: Json): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: number | string, result: Json): void {
    try {
      this.write({ id, result })
    } catch {
      // Server gone.
    }
  }

  respondError(id: number | string, code: number, message: string): void {
    try {
      this.write({ id, error: { code, message } })
    } catch {
      // Server gone.
    }
  }

  kill(): void {
    if (this.exited) return
    try {
      this.child.stdin?.end()
    } catch {
      // ignore
    }
    this.child.kill('SIGTERM')
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 3000).unref?.()
  }
}
