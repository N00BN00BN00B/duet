import type { DuetApi } from '@shared/api'

export const duet: DuetApi = window.duet

/** Electron prefixes IPC errors with "Error invoking remote method 'x': Error: ". */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim() || 'Something went wrong'
}

type Listener = (data: string) => void
const terminalListeners = new Map<string, Set<Listener>>()
const terminalExitListeners = new Map<string, Set<(code: number) => void>>()

/** Terminal output bypasses React state; components subscribe directly. */
export const terminalBus = {
  onData(id: string, fn: Listener): () => void {
    const set = terminalListeners.get(id) ?? new Set()
    set.add(fn)
    terminalListeners.set(id, set)
    return () => set.delete(fn)
  },
  onExit(id: string, fn: (code: number) => void): () => void {
    const set = terminalExitListeners.get(id) ?? new Set()
    set.add(fn)
    terminalExitListeners.set(id, set)
    return () => set.delete(fn)
  },
  emitData(id: string, data: string): void {
    terminalListeners.get(id)?.forEach((fn) => fn(data))
  },
  emitExit(id: string, code: number): void {
    terminalExitListeners.get(id)?.forEach((fn) => fn(code))
    terminalListeners.delete(id)
    terminalExitListeners.delete(id)
  }
}
