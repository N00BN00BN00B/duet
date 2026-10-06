import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { API_CHANNELS, EVENT_CHANNEL, FILE_PROTOCOL, type DuetApi } from '@shared/api'
import type { DuetEvent } from '@shared/types'

const api: Record<string, unknown> = {}

for (const [group, methods] of Object.entries(API_CHANNELS)) {
  const target: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const method of methods as string[]) {
    const channel = `${group}:${method}`
    target[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
  }
  api[group] = target
}

api.on = (listener: (event: DuetEvent) => void) => {
  const handler = (_: unknown, event: DuetEvent) => listener(event)
  ipcRenderer.on(EVENT_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(EVENT_CHANNEL, handler)
  }
}

api.util = {
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  fileUrl: (path: string) => `${FILE_PROTOCOL}://local${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
} satisfies DuetApi['util']

contextBridge.exposeInMainWorld('duet', api as unknown as DuetApi)
