import { app, BrowserWindow, dialog, Menu, nativeTheme, net, Notification, protocol, session, shell, webContents, type MenuItemConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EVENT_CHANNEL, FILE_PROTOCOL } from '@shared/api'
import type { AccessMode, DuetEvent, McpEditSource, McpServerConfig, ProviderId, Settings, SyncAction, ThemePref, ThreadMeta } from '@shared/types'
import { PROVIDERS } from '@shared/types'
import { truncate } from '@shared/paths'
import { findBinary, getEnv, loadShellEnv, runCommand } from './env'
import { Store } from './store'
import { Orchestrator } from './orchestrator'
import { registerIpc, type HandlerMap } from './ipc'
import { ClaudeAdapter } from './providers/claude/adapter'
import { CodexAdapter } from './providers/codex/adapter'
import { FakeAdapter } from './providers/fake/adapter'
import type { ProviderAdapter } from './providers/types'
import { prepareImage } from './images'
import { attachmentFromBytes, attachmentFromPath } from './features/attachments'
import { suggestFiles } from './features/files'
import { gitDiff, gitStatus } from './features/git'
import { TerminalManager } from './features/terminal'
import { listClaudeSessions, listCodexThreads, loadClaudeSession, loadCodexThread } from './features/history'
import { listMcp, mergeStatus, parseMcpJson, removeClaudeServer, removeCodexServer, writeClaudeServer, writeCodexServer, type McpWriteDeps } from './features/mcp'
import { applySync, scanSync } from './features/sync'
import { createBackup, defaultContext, describeSets, listBackups, restoreBackup } from './features/backup'
import { fakeMcpDeps } from './features/fakeMcp'
import { initLogger, logLine } from './logger'

protocol.registerSchemesAsPrivileged([{ scheme: FILE_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

const FAKE = process.env.DUET_FAKE_PROVIDERS === '1'
if (process.env.DUET_USER_DATA) app.setPath('userData', resolve(process.env.DUET_USER_DATA))

const log = (...args: unknown[]) => {
  logLine('info', ...args)
  if (!app.isPackaged || process.env.DUET_DEBUG) console.log(...args)
}

// Never show Electron's crash dialog for a stray background error; record it instead.
process.on('uncaughtException', (error) => logLine('error', 'uncaughtException', error))
process.on('unhandledRejection', (reason) => logLine('error', 'unhandledRejection', reason))

let mainWindow: BrowserWindow | null = null
let store: Store
let orchestrator: Orchestrator
let adapters: Record<ProviderId, ProviderAdapter>
let terminals: TerminalManager
let quitting = false

function broadcast(event: DuetEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVENT_CHANNEL, event)
}

function isTrusted(sender: Electron.WebContents): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id
}

// ---------- window ----------

const windowStatePath = () => join(app.getPath('userData'), 'window-state.json')

function loadWindowState(): { width: number; height: number; x?: number; y?: number; maximized?: boolean } {
  try {
    const s = JSON.parse(readFileSync(windowStatePath(), 'utf8'))
    if (typeof s.width === 'number' && typeof s.height === 'number') return s
  } catch {
    // first launch
  }
  return { width: 1380, height: 880 }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const b = win.getNormalBounds()
    writeFileSync(windowStatePath(), JSON.stringify({ ...b, maximized: win.isMaximized() }))
  } catch {
    // ignore
  }
}

function createWindow(): void {
  const state = loadWindowState()
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 580,
    show: false,
    title: 'Duet',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0c0e' : '#f7f7f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true
    }
  })
  mainWindow = win
  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => {
    if (process.env.DUET_HIDDEN === '1') return
    // Automated test runs show the window without stealing keyboard focus from the user.
    if (process.env.DUET_E2E === '1') win.showInactive()
    else win.show()
  })
  win.on('close', () => saveWindowState(win))
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.on('focus', () => broadcast({ type: 'command', name: 'window-focus' }))

  const devUrl = process.env.ELECTRON_RENDERER_URL
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    if (src && !/^(https?:|file:|about:blank|data:text\/html)/i.test(src)) {
      event.preventDefault()
      return
    }
    delete (webPreferences as Record<string, unknown>).preload
    delete (params as Record<string, unknown>).preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.partition = 'persist:duet-browser'
  })
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) broadcast({ type: 'browser-open', url })
      return { action: 'deny' }
    })
  })

  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function focusWindow(): void {
  if (!mainWindow) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

// ---------- notifications & badge ----------

function notify(meta: ThreadMeta, kind: 'done' | 'approval' | 'error', text: string): void {
  if (!store.settings.notifications || !Notification.isSupported()) return
  if (mainWindow && mainWindow.isFocused()) return
  const title = kind === 'approval' ? `${meta.title} — needs your OK` : kind === 'error' ? `${meta.title} — stopped` : `${meta.title} — done`
  const n = new Notification({ title: truncate(title, 80), body: truncate(text.replace(/\s+/g, ' '), 180), silent: !store.settings.sounds })
  n.on('click', () => {
    focusWindow()
    broadcast({ type: 'navigate', view: `thread:${meta.id}` })
  })
  n.show()
}

function setBadge(count: number): void {
  if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '')
}

// ---------- providers ----------

async function refreshProviders(force = false, only?: ProviderId): Promise<void> {
  await Promise.all(
    PROVIDERS.filter((p) => !only || p === only).map(async (id) => {
      try {
        const status = await adapters[id].status(force)
        broadcast({ type: 'provider-status', status })
      } catch (error) {
        log('[status]', id, (error as Error).message)
      }
    })
  )
}

function mcpDeps(): McpWriteDeps {
  if (FAKE) return fakeMcpDeps(homedir())
  return {
    claude: async (args, cwd) => {
      const bin = findBinary('claude', store.settings.claudePath)
      if (!bin) throw new Error('Claude Code is not installed')
      return runCommand(bin, args, { cwd: cwd && existsSync(cwd) ? cwd : homedir(), timeoutMs: 60_000 })
    },
    codex: async (method, params) => {
      const codex = adapters.codex
      if (!(codex instanceof CodexAdapter)) throw new Error('Codex is not available')
      return codex.rpcRequest(method, params, 30_000)
    }
  }
}

// ---------- backups ----------

function backupContext() {
  return defaultContext(app.getPath('userData'), app.getVersion())
}

let backupRunning = false

async function runAutoBackupIfDue(): Promise<void> {
  const s = store.settings
  if (s.autoBackup === 'off' || backupRunning) return
  const interval = s.autoBackup === 'daily' ? 86_400_000 : 7 * 86_400_000
  if (s.lastAutoBackup && Date.now() - s.lastAutoBackup < interval) return
  backupRunning = true
  try {
    const sets = ['claude-config', 'codex-config', 'duet', ...(s.includeAuthInBackups ? ['codex-auth'] : [])]
    await createBackup(backupContext(), { sets, dir: s.backupDir, suffix: 'auto' })
    store.updateSettings({ lastAutoBackup: Date.now() })
    // Keep the 10 newest automatic backups.
    const autos = listBackups(s.backupDir).filter((b) => b.name.endsWith('-auto'))
    for (const old of autos.slice(10)) {
      await shell.trashItem(old.file).catch(() => undefined)
      const sidecar = old.file.replace(/\.tar\.gz$/, '.json')
      if (existsSync(sidecar)) await shell.trashItem(sidecar).catch(() => undefined)
    }
  } catch (error) {
    log('[auto-backup]', (error as Error).message)
  } finally {
    backupRunning = false
  }
}

function relaunchSoon(delayMs: number): void {
  setTimeout(() => {
    void (async () => {
      quitting = true
      terminals?.killAll()
      await Promise.all(Object.values(adapters).map((a) => a.shutdown().catch(() => undefined)))
      app.relaunch()
      app.exit(0)
    })()
  }, delayMs)
}

/** Pages in the built-in browser get no camera, microphone, location, notifications or devices. */
function lockDownBrowserSession(): void {
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write'])
  const browser = session.fromPartition('persist:duet-browser')
  browser.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  browser.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  browser.setDevicePermissionHandler(() => false)
}

// ---------- IPC handlers ----------

const THEMES: ThemePref[] = ['system', 'dark', 'light']
const ACCESS: AccessMode[] = ['plan', 'ask', 'auto', 'full']

function sanitizeSettings(patch: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (patch.theme && THEMES.includes(patch.theme)) out.theme = patch.theme
  if (patch.defaultProvider && PROVIDERS.includes(patch.defaultProvider)) out.defaultProvider = patch.defaultProvider
  if (patch.defaultModels && typeof patch.defaultModels === 'object') out.defaultModels = { ...store.settings.defaultModels, ...patch.defaultModels }
  if (patch.defaultEfforts && typeof patch.defaultEfforts === 'object') out.defaultEfforts = { ...store.settings.defaultEfforts, ...patch.defaultEfforts }
  if (patch.defaultAccess && ACCESS.includes(patch.defaultAccess)) out.defaultAccess = patch.defaultAccess
  for (const key of ['sendWithEnter', 'notifications', 'sounds', 'includeAuthInBackups', 'onboarded'] as const) {
    if (typeof patch[key] === 'boolean') out[key] = patch[key]
  }
  for (const key of ['claudePath', 'codexPath', 'backupDir', 'browserHome'] as const) {
    if (typeof patch[key] === 'string') out[key] = (patch[key] as string).trim()
  }
  if (Array.isArray(patch.projects)) out.projects = patch.projects.filter((p) => typeof p === 'string')
  if (patch.autoBackup && ['off', 'daily', 'weekly'].includes(patch.autoBackup)) out.autoBackup = patch.autoBackup
  if (typeof patch.fontSize === 'number' && patch.fontSize >= 11 && patch.fontSize <= 20) out.fontSize = Math.round(patch.fontSize)
  return out
}

function inBackupDir(file: string): boolean {
  const dir = resolve(store.settings.backupDir)
  const full = resolve(file)
  return dirname(full) === dir && /^duet-backup-[\w-]+\.tar\.gz$/.test(basename(full))
}

function handlers(): HandlerMap {
  return {
    app: {
      info: () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData'), fake: FAKE, home: homedir() }),
      openExternal: async (url: string) => {
        if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) await shell.openExternal(url)
      },
      reveal: (path: string) => {
        if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path)
      },
      openPath: async (path: string) => (typeof path === 'string' && existsSync(path) ? shell.openPath(path) : 'File not found'),
      pickFolder: async () => {
        const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a project folder' })
        return res.canceled ? null : (res.filePaths[0] ?? null)
      },
      pickFiles: async () => {
        const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile', 'multiSelections'], title: 'Attach files' })
        return res.canceled ? [] : res.filePaths
      },
      notify: (title: string, body: string) => {
        if (Notification.isSupported()) new Notification({ title: String(title), body: String(body) }).show()
      },
      setBadge: (count: number) => setBadge(Number(count) || 0)
    },
    threads: {
      list: () => orchestrator.list(),
      get: (id: string) => orchestrator.get(id),
      create: (input) => {
        if (!input || typeof input.cwd !== 'string' || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new Error('Pick an existing project folder first.')
        if (input.provider && !PROVIDERS.includes(input.provider)) throw new Error('Unknown provider')
        return orchestrator.create(input)
      },
      update: (id: string, patch) => {
        if (patch?.cwd !== undefined && (!existsSync(patch.cwd) || !statSync(patch.cwd).isDirectory())) throw new Error('That folder does not exist.')
        if (patch?.provider !== undefined && !PROVIDERS.includes(patch.provider)) throw new Error('Unknown provider')
        if (patch?.access !== undefined && !ACCESS.includes(patch.access)) throw new Error('Unknown access mode')
        return orchestrator.update(id, patch ?? {})
      },
      remove: (id: string) => orchestrator.remove(id),
      send: (id: string, input) => {
        if (!input || typeof input.text !== 'string' || !Array.isArray(input.attachments)) throw new Error('Invalid message')
        return orchestrator.send(id, input)
      },
      stop: (id: string) => orchestrator.stop(id),
      respond: (id: string, itemId: string, decision) => orchestrator.respond(id, itemId, decision),
      fork: (id: string) => orchestrator.fork(id),
      exportMarkdown: (id: string) => orchestrator.exportMarkdown(id)
    },
    providers: {
      status: () => Promise.all(PROVIDERS.map((p) => adapters[p].status(false))),
      refresh: async (id?: ProviderId) => {
        await refreshProviders(true, id)
        return Promise.all(PROVIDERS.map((p) => adapters[p].status(false)))
      },
      commands: (id: ProviderId, cwd: string) => (PROVIDERS.includes(id) ? adapters[id].commands(cwd) : [])
    },
    attachments: {
      fromBytes: (name: string, mime: string, bytes: Uint8Array) => attachmentFromBytes(store.attachmentsDir, String(name), String(mime), bytes),
      fromPath: (path: string) => attachmentFromPath(store.attachmentsDir, String(path))
    },
    files: {
      suggest: (cwd: string, query: string) => suggestFiles(String(cwd), String(query ?? ''))
    },
    git: {
      status: (cwd: string) => gitStatus(String(cwd)),
      diff: (cwd: string, file?: string) => gitDiff(String(cwd), typeof file === 'string' ? file : undefined)
    },
    mcp: {
      list: async (cwd?: string) => {
        const entries = listMcp(typeof cwd === 'string' && cwd ? cwd : undefined)
        const claudeStatus = adapters.claude instanceof ClaudeAdapter ? adapters.claude.mcpStatus() : []
        let codexStatus: { name: string; status: string; tools?: number }[] = []
        if (adapters.codex instanceof CodexAdapter) {
          try {
            const res = await adapters.codex.rpcRequest('mcpServerStatus/list', { limit: 200 }, 15_000)
            codexStatus = (res?.data ?? []).map((s: { name: string; runtimeStatus: string | null; authStatus?: string; tools?: Record<string, unknown> }) => ({
              name: s.name,
              status: s.runtimeStatus ?? (s.authStatus === 'notLoggedIn' ? 'notLoggedIn' : 'unknown'),
              tools: s.tools ? Object.keys(s.tools).length : undefined
            }))
          } catch {
            // Codex unavailable: show config only.
          }
        }
        return mergeStatus(entries, claudeStatus, codexStatus)
      },
      save: async (config: McpServerConfig, targets: ProviderId[], source?: McpEditSource) => {
        const deps = mcpDeps()
        const errors: string[] = []
        // An edit changes the server where it lives: same Claude scope, same project.
        const scope = source?.claudeScope === 'local' || source?.claudeScope === 'project' ? source.claudeScope : 'user'
        const project = scope !== 'user' && typeof source?.project === 'string' ? source.project : undefined
        const previousName = typeof source?.name === 'string' ? source.name : undefined
        for (const target of targets) {
          try {
            if (target === 'claude') {
              if (scope !== 'user' && (!project || !existsSync(project))) throw new Error(`the project folder of this ${scope} server no longer exists`)
              await writeClaudeServer(deps, config, { scope, project, previousName })
            } else await writeCodexServer(deps, config, previousName)
          } catch (error) {
            errors.push(`${target === 'claude' ? 'Claude' : 'Codex'}: ${(error as Error).message}`)
          }
        }
        if (errors.length) throw new Error(errors.join('\n'))
      },
      remove: async (name: string, provider: ProviderId, scope: string, project?: string) => {
        const deps = mcpDeps()
        if (provider === 'claude') await removeClaudeServer(deps, name, scope || 'user', project)
        else await removeCodexServer(deps, name)
      },
      copy: async (name: string, from: ProviderId, to: ProviderId) => {
        const entry = listMcp().find((e) => e.provider === from && e.config.name === name)
        if (!entry) throw new Error(`${name} was not found`)
        const deps = mcpDeps()
        if (to === 'claude') await writeClaudeServer(deps, entry.config)
        else await writeCodexServer(deps, entry.config)
      },
      importJson: async (json: string, targets: ProviderId[]) => {
        const servers = parseMcpJson(String(json))
        const deps = mcpDeps()
        let count = 0
        for (const cfg of servers) {
          for (const target of targets) {
            if (target === 'claude') await writeClaudeServer(deps, cfg)
            else await writeCodexServer(deps, cfg)
          }
          count++
        }
        return count
      }
    },
    sync: {
      scan: (cwd?: string) => scanSync(typeof cwd === 'string' && cwd ? cwd : undefined),
      apply: async (actions: SyncAction[], cwd?: string) => {
        const backupRoot = join(app.getPath('userData'), 'sync-backups', new Date().toISOString().replace(/[:.]/g, '-'))
        return applySync(Array.isArray(actions) ? actions : [], { cwd: typeof cwd === 'string' && cwd ? cwd : undefined, backupRoot, mcp: mcpDeps() })
      }
    },
    backup: {
      sets: () => describeSets(backupContext(), store.settings.includeAuthInBackups),
      list: () => listBackups(store.settings.backupDir),
      create: async (sets: string[]) => {
        if (backupRunning) throw new Error('A backup is already running.')
        backupRunning = true
        try {
          return await createBackup(backupContext(), {
            sets,
            dir: store.settings.backupDir,
            onProgress: (done, total) => broadcast({ type: 'backup-progress', phase: 'Backing up', done, total })
          })
        } finally {
          backupRunning = false
        }
      },
      restore: async (file: string, sets: string[]) => {
        if (!inBackupDir(file)) throw new Error('Only backups in your backup folder can be restored.')
        if (backupRunning) throw new Error('A backup is already running.')
        backupRunning = true
        const restoringDuet = Array.isArray(sets) && sets.includes('duet')
        try {
          if (restoringDuet) {
            // Duet's own threads are being replaced: stop the agents, save what's pending, and
            // keep the in-memory copy from ever being written over the restored files.
            await orchestrator.stopAll()
            store.freeze()
          }
          return await restoreBackup(backupContext(), file, sets, {
            safetyDir: store.settings.backupDir,
            onProgress: (done, total) => broadcast({ type: 'backup-progress', phase: 'Restoring', done, total }),
            log
          })
        } catch (error) {
          if (restoringDuet) throw new Error(`${(error as Error).message} — Duet will restart to reload your threads.`)
          throw error
        } finally {
          backupRunning = false
          // Reload from disk whether or not every file made it.
          if (restoringDuet) relaunchSoon(1800)
        }
      },
      remove: async (file: string) => {
        if (!inBackupDir(file)) throw new Error('Not a Duet backup.')
        await shell.trashItem(file)
        const sidecar = file.replace(/\.tar\.gz$/, '.json')
        if (existsSync(sidecar)) await shell.trashItem(sidecar).catch(() => undefined)
      },
      chooseDir: async () => {
        const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose where backups are saved', defaultPath: store.settings.backupDir })
        if (res.canceled || !res.filePaths[0]) return null
        store.updateSettings({ backupDir: res.filePaths[0] })
        return res.filePaths[0]
      }
    },
    history: {
      list: async (provider: ProviderId) => {
        const imported = new Map<string, string>()
        for (const meta of orchestrator.list()) {
          if (meta.origin) imported.set(`${meta.origin.provider}:${meta.origin.nativeId}`, meta.id)
          for (const p of PROVIDERS) if (meta.native[p]) imported.set(`${p}:${meta.native[p]!.id}`, meta.id)
        }
        let entries = provider === 'claude' ? listClaudeSessions() : adapters.codex instanceof CodexAdapter ? await listCodexThreads((m, p, t) => (adapters.codex as CodexAdapter).rpcRequest(m, p, t)) : []
        entries = entries.map((e) => ({ ...e, importedThreadId: imported.get(`${e.provider}:${e.nativeId}`) }))
        return entries
      },
      import: async (provider: ProviderId, nativeId: string) => {
        const existing = orchestrator.list().find((m) => (m.origin?.provider === provider && m.origin.nativeId === nativeId) || m.native[provider]?.id === nativeId)
        if (existing) return existing
        const loaded =
          provider === 'claude'
            ? loadClaudeSession(nativeId)
            : adapters.codex instanceof CodexAdapter
              ? await loadCodexThread((m, p, t) => (adapters.codex as CodexAdapter).rpcRequest(m, p, t), nativeId)
              : null
        if (!loaded) throw new Error('History is not available for this provider')
        const cwd = loaded.cwd && existsSync(loaded.cwd) ? loaded.cwd : homedir()
        const now = Date.now()
        const firstTs = loaded.items[0]?.ts ?? now
        const lastTs = loaded.items[loaded.items.length - 1]?.ts ?? now
        const meta: ThreadMeta = {
          id: randomUUID(),
          title: truncate(loaded.title || 'Imported conversation', 100),
          cwd,
          createdAt: firstTs,
          updatedAt: lastTs,
          provider,
          models: { ...store.settings.defaultModels },
          efforts: { ...store.settings.defaultEfforts },
          access: store.settings.defaultAccess,
          status: 'idle',
          native: { [provider]: { id: nativeId, syncedTo: loaded.items.length } },
          origin: { provider, nativeId },
          itemCount: loaded.items.length,
          preview: undefined
        }
        if (cwd !== loaded.cwd && loaded.cwd) {
          loaded.items.push({ kind: 'notice', id: `n-${now}`, ts: now, level: 'warn', text: `The original folder (${loaded.cwd}) no longer exists, so this thread uses your home folder.` })
          meta.native = {}
        }
        return orchestrator.insert(meta, loaded.items)
      }
    },
    browser: {
      capture: async (webContentsId: number, rect?: { x: number; y: number; width: number; height: number }) => {
        const wc = webContents.fromId(Number(webContentsId))
        if (!wc || wc.getType() !== 'webview' || wc.hostWebContents?.id !== mainWindow?.webContents.id) throw new Error('Browser view not found')
        const area = rect && rect.width > 0 && rect.height > 0 ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : undefined
        const image = await wc.capturePage(area)
        if (image.isEmpty()) throw new Error('Nothing to capture yet')
        return attachmentFromBytes(store.attachmentsDir, `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`, 'image/png', image.toPNG())
      },
      devtools: (webContentsId: number) => {
        const wc = webContents.fromId(Number(webContentsId))
        if (wc && wc.getType() === 'webview' && wc.hostWebContents?.id === mainWindow?.webContents.id) wc.openDevTools({ mode: 'detach' })
      }
    },
    terminal: {
      create: (cwd: string, cols: number, rows: number) => terminals.create(String(cwd ?? ''), Number(cols), Number(rows)),
      write: (id: string, data: string) => terminals.write(String(id), String(data)),
      resize: (id: string, cols: number, rows: number) => terminals.resize(String(id), Number(cols), Number(rows)),
      kill: (id: string) => terminals.kill(String(id))
    },
    settings: {
      get: () => store.settings,
      update: (patch: Partial<Settings>) => {
        const clean = sanitizeSettings(patch ?? {})
        const before = store.settings
        const next = store.updateSettings(clean)
        if (clean.theme) nativeTheme.themeSource = clean.theme
        if (clean.claudePath !== undefined && clean.claudePath !== before.claudePath) void refreshProviders(true, 'claude')
        if (clean.codexPath !== undefined && clean.codexPath !== before.codexPath) void refreshProviders(true, 'codex')
        if (clean.autoBackup && clean.autoBackup !== before.autoBackup) void runAutoBackupIfDue()
        if (clean.backupDir) mkdirSync(clean.backupDir, { recursive: true })
        return next
      }
    }
  }
}

// ---------- menu ----------

function buildMenu(): void {
  const send = (name: string) => () => broadcast({ type: 'command', name })
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Duet',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => broadcast({ type: 'navigate', view: 'settings' }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Thread', accelerator: 'CmdOrCtrl+N', click: send('new-thread') },
        { label: 'Open Project Folder…', accelerator: 'CmdOrCtrl+O', click: send('open-project') },
        { type: 'separator' },
        { label: 'Back Up Now', click: () => broadcast({ type: 'navigate', view: 'backups' }) },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette', click: send('palette') },
        { label: 'Toggle Sidebar', click: send('toggle-sidebar') },
        { label: 'Toggle Browser', click: send('toggle-browser') },
        { label: 'Toggle Terminal', click: send('toggle-terminal') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Claude Code docs', click: () => void shell.openExternal('https://docs.claude.com/en/docs/claude-code/overview') },
        { label: 'Codex docs', click: () => void shell.openExternal('https://developers.openai.com/codex') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- lifecycle ----------

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.heic', '.tif', '.tiff', '.ico', '.avif'])

async function bootstrap(): Promise<void> {
  initLogger(app.getPath('userData'))
  logLine('info', `Duet ${app.getVersion()} starting${FAKE ? ' (demo agents)' : ''}`)
  await loadShellEnv()
  store = new Store(app.getPath('userData'))
  nativeTheme.themeSource = store.settings.theme
  mkdirSync(store.settings.backupDir, { recursive: true })

  protocol.handle(FILE_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url)
      const path = decodeURIComponent(url.pathname)
      if (!IMAGE_EXT.has(extname(path).toLowerCase()) || !existsSync(path)) return new Response('Not found', { status: 404 })
      return net.fetch(pathToFileURL(path).toString())
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })

  adapters = FAKE
    ? { claude: new FakeAdapter('claude'), codex: new FakeAdapter('codex') }
    : {
        claude: new ClaudeAdapter({ binary: () => findBinary('claude', store.settings.claudePath), env: getEnv, attachmentsDir: store.attachmentsDir, prepareImage, log }),
        codex: new CodexAdapter({ binary: () => findBinary('codex', store.settings.codexPath), env: getEnv, appVersion: app.getVersion(), log })
      }

  orchestrator = new Orchestrator({
    store,
    adapters,
    broadcast,
    notify,
    onBadge: setBadge,
    onLimits: (provider) => {
      void adapters[provider].status(false).then((status) => broadcast({ type: 'provider-status', status }))
    },
    injectHandoff: async (provider, req, handoff, emit) => {
      const codex = adapters.codex
      if (provider !== 'codex' || !(codex instanceof CodexAdapter)) return false
      const id = await codex.prepareThread(req, emit)
      if (!id) return false
      return codex.injectContext(req.threadId, handoff)
    },
    log
  })

  terminals = new TerminalManager(
    (id, data) => broadcast({ type: 'terminal-data', id, data }),
    (id, code) => broadcast({ type: 'terminal-exit', id, code })
  )

  registerIpc(handlers(), isTrusted)
  lockDownBrowserSession()
  buildMenu()
  createWindow()
  void refreshProviders(false)
  setTimeout(() => void runAutoBackupIfDue(), 60_000).unref?.()
  setInterval(() => void runAutoBackupIfDue(), 60 * 60_000).unref?.()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusWindow())
  app.whenReady().then(bootstrap).catch((error) => {
    console.error('Duet failed to start', error)
    dialog.showErrorBox('Duet failed to start', String(error?.stack ?? error))
    app.exit(1)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && store) createWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (quitting || !orchestrator) return
    quitting = true
    event.preventDefault()
    void (async () => {
      try {
        terminals?.killAll()
        await orchestrator.shutdown()
        await Promise.all(Object.values(adapters).map((a) => a.shutdown().catch(() => undefined)))
      } finally {
        app.quit()
      }
    })()
  })
}
