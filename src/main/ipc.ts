import { ipcMain, type WebContents } from 'electron'
import { API_CHANNELS } from '@shared/api'
import { logLine } from './logger'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (...args: any[]) => unknown
export type HandlerMap = Record<string, Record<string, Handler>>

/**
 * Registers one `ipcMain.handle` per API method. Every method listed in
 * API_CHANNELS must have a handler, so a missing implementation fails at startup.
 */
export function registerIpc(handlers: HandlerMap, isTrusted: (sender: WebContents) => boolean): void {
  for (const [group, methods] of Object.entries(API_CHANNELS)) {
    for (const method of methods as string[]) {
      const fn = handlers[group]?.[method]
      if (!fn) throw new Error(`Missing IPC handler ${group}:${method}`)
      const channel = `${group}:${method}`
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        if (!isTrusted(event.sender)) throw new Error('Blocked IPC from an untrusted page')
        try {
          return await fn(...args)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logLine('warn', `[ipc] ${channel} failed:`, message)
          throw new Error(message)
        }
      })
    }
  }
}

export function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}
