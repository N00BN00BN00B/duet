import type {
  ApprovalDecision,
  Attachment,
  BackupInfo,
  BackupSet,
  DuetEvent,
  FileSuggestion,
  GitStatus,
  HistoryEntry,
  McpEntry,
  McpServerConfig,
  NewThreadInput,
  ProviderId,
  ProviderStatus,
  SendInput,
  Settings,
  SlashCommand,
  SyncAction,
  SyncItem,
  Thread,
  ThreadMeta,
  ThreadPatch
} from './types'

/**
 * Every method maps 1:1 to an `ipcMain.handle` channel named `<group>:<method>`.
 * The preload script builds `window.duet` from this list, so main and renderer
 * can never drift apart.
 */
export interface DuetApi {
  app: {
    info(): Promise<{ version: string; platform: string; userData: string; fake: boolean; home: string }>
    openExternal(url: string): Promise<void>
    reveal(path: string): Promise<void>
    openPath(path: string): Promise<string>
    pickFolder(): Promise<string | null>
    pickFiles(): Promise<string[]>
    notify(title: string, body: string): Promise<void>
    setBadge(count: number): Promise<void>
  }
  threads: {
    list(): Promise<ThreadMeta[]>
    get(id: string): Promise<Thread | null>
    create(input: NewThreadInput): Promise<ThreadMeta>
    update(id: string, patch: ThreadPatch): Promise<ThreadMeta | null>
    remove(id: string): Promise<void>
    send(id: string, input: SendInput): Promise<void>
    stop(id: string): Promise<void>
    respond(id: string, itemId: string, decision: ApprovalDecision): Promise<void>
    fork(id: string): Promise<ThreadMeta | null>
    exportMarkdown(id: string): Promise<string | null>
  }
  providers: {
    status(): Promise<ProviderStatus[]>
    refresh(id?: ProviderId): Promise<ProviderStatus[]>
    commands(id: ProviderId, cwd: string): Promise<SlashCommand[]>
  }
  attachments: {
    fromBytes(name: string, mime: string, bytes: Uint8Array): Promise<Attachment>
    fromPath(path: string): Promise<Attachment>
  }
  files: {
    suggest(cwd: string, query: string): Promise<FileSuggestion[]>
  }
  git: {
    status(cwd: string): Promise<GitStatus>
    diff(cwd: string, file?: string): Promise<string>
  }
  mcp: {
    list(cwd?: string): Promise<McpEntry[]>
    save(config: McpServerConfig, targets: ProviderId[], previousName?: string): Promise<void>
    remove(name: string, provider: ProviderId, scope: string, project?: string): Promise<void>
    copy(name: string, from: ProviderId, to: ProviderId): Promise<void>
    importJson(json: string, targets: ProviderId[]): Promise<number>
  }
  sync: {
    scan(cwd?: string): Promise<SyncItem[]>
    apply(actions: SyncAction[], cwd?: string): Promise<{ applied: number; errors: string[] }>
  }
  backup: {
    sets(): Promise<BackupSet[]>
    list(): Promise<BackupInfo[]>
    create(sets: string[]): Promise<BackupInfo>
    restore(file: string, sets: string[]): Promise<{ restored: number; safetyBackup: string }>
    remove(file: string): Promise<void>
    chooseDir(): Promise<string | null>
  }
  history: {
    list(provider: ProviderId): Promise<HistoryEntry[]>
    import(provider: ProviderId, nativeId: string): Promise<ThreadMeta>
  }
  browser: {
    /** Screenshots a <webview> guest (optionally a region) and stores it as an attachment. */
    capture(webContentsId: number, rect?: { x: number; y: number; width: number; height: number }): Promise<Attachment>
    devtools(webContentsId: number): Promise<void>
  }
  terminal: {
    create(cwd: string, cols: number, rows: number): Promise<string>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    kill(id: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
  }
  /** Subscribe to main-process events. Returns an unsubscribe function. */
  on(listener: (event: DuetEvent) => void): () => void
  /** Synchronous helpers that do not need IPC. */
  util: {
    pathForFile(file: File): string
    fileUrl(path: string): string
  }
}

type AsyncGroups = Omit<DuetApi, 'on' | 'util'>

export const API_CHANNELS: { [G in keyof AsyncGroups]: (keyof AsyncGroups[G])[] } = {
  app: ['info', 'openExternal', 'reveal', 'openPath', 'pickFolder', 'pickFiles', 'notify', 'setBadge'],
  threads: ['list', 'get', 'create', 'update', 'remove', 'send', 'stop', 'respond', 'fork', 'exportMarkdown'],
  providers: ['status', 'refresh', 'commands'],
  attachments: ['fromBytes', 'fromPath'],
  files: ['suggest'],
  git: ['status', 'diff'],
  mcp: ['list', 'save', 'remove', 'copy', 'importJson'],
  sync: ['scan', 'apply'],
  backup: ['sets', 'list', 'create', 'restore', 'remove', 'chooseDir'],
  history: ['list', 'import'],
  browser: ['capture', 'devtools'],
  terminal: ['create', 'write', 'resize', 'kill'],
  settings: ['get', 'update']
}

export const EVENT_CHANNEL = 'duet:event'

/** Custom protocol used to show local images (attachments, screenshots) in the renderer. */
export const FILE_PROTOCOL = 'duet-file'
