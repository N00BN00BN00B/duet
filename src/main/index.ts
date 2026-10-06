import { app, BrowserWindow, dialog, Menu, nativeTheme, net, Notification, protocol, safeStorage, session, shell, webContents, type MenuItemConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EVENT_CHANNEL, FILE_PROTOCOL } from '@shared/api'
import type { AccessMode, DuetEvent, HistoryEntry, McpEditSource, McpServerConfig, ProviderId, SendInput, Settings, SyncAction, ThemePref, ThreadMeta, TimelineItem } from '@shared/types'
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
import { oldSafetyCopies, storageStats, unusedAttachments, type StorageContext } from './features/storage'
import { cliStatus, installCli, uninstallCli } from './features/cli'
import { parseDeepLink } from './features/deeplink'
import { planChatSync } from './features/chatSync'
import { generateTheme, type ThemeAgent } from './features/themeGen'
import { UsageService } from './features/usage'
import { readClaudePersonality } from './features/personality'
import { claudeHome, codexHome } from './features/history'
import { fakeMcpDeps } from './features/fakeMcp'
import { initLogger, logLine } from './logger'
import { saveToolImage } from './util/toolImages'
import { RoutingService } from './features/routing'
import { modelEffort } from '@shared/routing'
import { findTheme, normalizeTheme, parseColor, resolveTheme, toHex, type ThemeSpec } from '@shared/theme'

protocol.registerSchemesAsPrivileged([{ scheme: FILE_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

const FAKE = process.env.DUET_FAKE_PROVIDERS === '1'

// duet:// links (from the `duet` command) can arrive before Duet has finished starting.
const pendingLinks: string[] = []
let linksReady = false
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (linksReady) void handleDeepLink(url)
  else pendingLinks.push(url)
})
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
let routing: RoutingService
let changingRouting = false
let terminals: TerminalManager
let usage: UsageService
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
    // The theme's own background, so the window never flashes a different colour while loading.
    backgroundColor: resolveTheme(store.settings, nativeTheme.shouldUseDarkColors).colors.bg,
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
  else if (process.env.DUET_E2E === '1') mainWindow.showInactive() // tests never take the keyboard from whatever you're typing in
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

async function providerStatus(id: ProviderId, force = false) {
  const status = await adapters[id].status(force)
  const models = await routing.models().catch(() => [])
  const routed = models.map((model) => ({ ...model, efforts: model.efforts?.filter((effort) => !!modelEffort(model, effort, id)), defaultEffort: modelEffort(model, model.defaultEffort, id) }))
  return { ...status, models: [...status.models, ...routed] }
}

async function refreshProviders(force = false, only?: ProviderId): Promise<void> {
  await Promise.all(
    PROVIDERS.filter((p) => !only || p === only).map(async (id) => {
      try {
        const status = await providerStatus(id, force)
        broadcast({ type: 'provider-status', status })
      } catch (error) {
        log('[status]', id, (error as Error).message)
      }
    })
  )
  writeLimitsCache()
}

let codexAccountCache: { at: number; value: Awaited<ReturnType<CodexAdapter['accountUsage']>> } | null = null

/** Codex's account-wide usage numbers, fetched at most every 5 minutes. */
async function codexAccount() {
  const codex = adapters.codex
  if (!(codex instanceof CodexAdapter)) return null
  if (codexAccountCache && Date.now() - codexAccountCache.at < 5 * 60_000) return codexAccountCache.value
  const value = await codex.accountUsage()
  codexAccountCache = { at: Date.now(), value }
  return value
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

// ---------- chats folder, deep links, chat sync ----------

const chatsDir = () => join(app.getPath('userData'), 'chats')

/** Secret the `duet` command passes along, so only this user's terminal can auto-send prompts. */
function cliToken(): string {
  const file = join(app.getPath('userData'), 'cli-token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
  } catch {
    // first run
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, token, { mode: 0o600 })
  return token
}

async function handleDeepLink(raw: string): Promise<void> {
  const link = parseDeepLink(raw, cliToken())
  if (!link) return
  focusWindow()
  if (link.kind === 'thread') return broadcast({ type: 'navigate', view: `thread:${link.id}` })
  if (link.kind === 'view') return broadcast({ type: 'navigate', view: link.view })
  const cwd = link.cwd && existsSync(link.cwd) && statSync(link.cwd).isDirectory() ? link.cwd : undefined
  if (cwd && cwd !== chatsDir() && !store.settings.projects.includes(cwd)) store.updateSettings({ projects: [cwd, ...store.settings.projects] })
  if (link.prompt && link.send && cwd) {
    const meta = orchestrator.create({ cwd, provider: link.provider ?? store.settings.defaultProvider, model: link.model })
    broadcast({ type: 'navigate', view: `thread:${meta.id}` })
    await orchestrator.send(meta.id, { text: link.prompt, attachments: [] }).catch((error) => broadcast({ type: 'toast', level: 'error', text: (error as Error).message }))
    return
  }
  broadcast({ type: 'compose', cwd, text: link.prompt, provider: link.provider })
}

const saveImage = (data: string, mime: string) => saveToolImage(store.attachmentsDir, data, mime)

function codexRequest() {
  const codex = adapters.codex
  return codex instanceof CodexAdapter ? <T>(m: string, p?: unknown, t?: number) => codex.rpcRequest<T>(m, p, t) : null
}

/** Reads a synced chat's messages from where they live (Claude Code transcript / Codex thread). */
async function loadSource(meta: ThreadMeta): Promise<TimelineItem[]> {
  if (!meta.origin) return []
  if (meta.origin.provider === 'claude') return loadClaudeSession(meta.origin.nativeId, saveImage).items
  const request = codexRequest()
  if (!request) throw new Error('Codex is not available')
  return (await loadCodexThread(request, meta.origin.nativeId, saveImage)).items
}

let syncing: Promise<{ added: number; updated: number; total: number }> | null = null

/** Lists every Claude Code and Codex chat in the sidebar; messages load when a chat is opened. */
function syncChats(): Promise<{ added: number; updated: number; total: number }> {
  if (syncing) return syncing
  syncing = (async () => {
    mkdirSync(chatsDir(), { recursive: true })
    broadcast({ type: 'chat-sync', phase: 'running', added: 0, updated: 0, total: 0 })
    const entries: HistoryEntry[] = [...listClaudeSessions()]
    const request = codexRequest()
    if (request && (await adapters.codex.status(false).catch(() => null))?.installed) {
      try {
        entries.push(...(await listCodexThreads(request, 2000)))
      } catch (error) {
        log('[sync] codex list failed', (error as Error).message)
      }
    }
    const s = store.settings
    const plan = planChatSync(orchestrator.list(), entries, { models: s.defaultModels, efforts: s.defaultEfforts, access: s.defaultAccess, fallbackCwd: chatsDir(), folderExists: (p) => existsSync(p) })
    orchestrator.upsertSynced([...plan.added, ...plan.updated])
    store.updateSettings({ lastChatSync: Date.now() })
    const result = { added: plan.added.length, updated: plan.updated.length, total: entries.length }
    broadcast({ type: 'chat-sync', phase: 'done', ...result })
    return result
  })().finally(() => {
    syncing = null
  })
  return syncing
}

let lastAutoSync = 0
function autoSyncChats(): void {
  if (store.settings.chatSync !== 'auto' || Date.now() - lastAutoSync < 120_000) return
  lastAutoSync = Date.now()
  void syncChats().catch((error) => log('[sync]', (error as Error).message))
}

/** Remembers the latest limits for `duet --usage`. */
function writeLimitsCache(): void {
  void Promise.all(PROVIDERS.map(async (p) => [p, (await adapters[p].status(false).catch(() => null))?.limits ?? []] as const))
    .then((pairs) => {
      const dir = join(app.getPath('userData'), 'cache')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'limits.json'), JSON.stringify(Object.fromEntries(pairs)))
    })
    .catch(() => undefined)
}

function storageContext(): StorageContext {
  const userData = app.getPath('userData')
  return { threadsDir: store.threadsDir, attachmentsDir: store.attachmentsDir, safetyDir: join(userData, 'sync-backups'), logsDir: join(userData, 'logs'), cacheDir: join(userData, 'cache') }
}

async function themeAgents(): Promise<ThemeAgent[]> {
  return Promise.all(
    PROVIDERS.map(async (id) => {
      const adapter = adapters[id]
      const st = await adapter.status(false).catch(() => null)
      return { id, ready: !!adapter.oneShot && !!st?.installed && st.loggedIn !== false, ask: (prompt: string, schema: unknown) => adapter.oneShot!(prompt, { outputSchema: schema, timeoutMs: 90_000 }) }
    })
  )
}

function cleanSendInput(input: SendInput): SendInput {
  if (!input || typeof input.text !== 'string' || !Array.isArray(input.attachments)) throw new Error('Invalid message')
  const out: SendInput = { text: input.text, attachments: input.attachments }
  if (Array.isArray(input.skills)) out.skills = input.skills.filter((s) => s && typeof s.name === 'string' && typeof s.path === 'string').slice(0, 8)
  const r = input.review
  if (r && typeof r === 'object') {
    if (r.type === 'uncommittedChanges') out.review = { type: 'uncommittedChanges' }
    else if (r.type === 'baseBranch' && typeof r.branch === 'string' && r.branch.trim()) out.review = { type: 'baseBranch', branch: r.branch.trim() }
    else if (r.type === 'commit' && typeof r.sha === 'string' && /^[0-9a-f]{4,40}$/i.test(r.sha)) out.review = { type: 'commit', sha: r.sha }
    else if (r.type === 'custom' && typeof r.instructions === 'string' && r.instructions.trim()) out.review = { type: 'custom', instructions: r.instructions.trim().slice(0, 4000) }
  }
  return out
}

function relaunchSoon(delayMs: number): void {
  setTimeout(() => {
    void (async () => {
      quitting = true
      terminals?.killAll()
      await Promise.all(Object.values(adapters).map((a) => a.shutdown().catch(() => undefined)))
      await routing?.shutdown()
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

const CLAUDE_LOGIN_COMMAND = 'claude auth login'
const INSTALL_COMMAND: Record<ProviderId, string> = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'npm install -g @openai/codex'
}
const ACCESS: AccessMode[] = ['plan', 'ask', 'auto', 'full']

function sanitizeSettings(patch: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (patch.theme && THEMES.includes(patch.theme)) out.theme = patch.theme
  if (patch.defaultProvider && PROVIDERS.includes(patch.defaultProvider)) out.defaultProvider = patch.defaultProvider
  if (patch.defaultModels && typeof patch.defaultModels === 'object') out.defaultModels = { ...store.settings.defaultModels, ...patch.defaultModels }
  if (patch.defaultEfforts && typeof patch.defaultEfforts === 'object') out.defaultEfforts = { ...store.settings.defaultEfforts, ...patch.defaultEfforts }
  if (patch.defaultAccess && ACCESS.includes(patch.defaultAccess)) out.defaultAccess = patch.defaultAccess
  for (const key of ['sendWithEnter', 'notifications', 'sounds', 'includeAuthInBackups', 'onboarded', 'reduceMotion', 'backgroundEffects', 'sidebarAgentNames', 'showTurnDetails', 'usageIncludeOutside'] as const) {
    if (typeof patch[key] === 'boolean') out[key] = patch[key]
  }
  // Appearance: only known values, and themes only after they've been checked.
  if (Array.isArray(patch.customThemes)) {
    out.customThemes = patch.customThemes
      .map((t) => normalizeTheme(t))
      .filter((t): t is ThemeSpec => !!t)
      .filter((t, i, list) => list.findIndex((x) => x.id === t.id) === i)
      .slice(0, 60)
  }
  const knownTheme = (id: unknown) => typeof id === 'string' && !!findTheme(id, out.customThemes ?? store.settings.customThemes)
  if (knownTheme(patch.darkTheme)) out.darkTheme = patch.darkTheme
  if (knownTheme(patch.lightTheme)) out.lightTheme = patch.lightTheme
  if (patch.accentMode && ['agent', 'theme', 'custom'].includes(patch.accentMode)) out.accentMode = patch.accentMode
  if (typeof patch.accentColor === 'string' && parseColor(patch.accentColor)) out.accentColor = toHex(parseColor(patch.accentColor)!)
  if (patch.density && ['compact', 'comfortable', 'spacious'].includes(patch.density)) out.density = patch.density
  if (patch.chatWidth && ['narrow', 'normal', 'wide'].includes(patch.chatWidth)) out.chatWidth = patch.chatWidth
  if (patch.chatSync && ['off', 'auto'].includes(patch.chatSync)) out.chatSync = patch.chatSync
  if (patch.personality && typeof patch.personality === 'object') {
    const p = patch.personality
    const current = store.settings.personality
    out.personality = {
      preset: ['default', 'concise', 'friendly', 'pragmatic', 'teacher', 'custom'].includes(p.preset) ? p.preset : current.preset,
      custom: typeof p.custom === 'string' ? p.custom.slice(0, 4000) : current.custom,
      providers: Array.isArray(p.providers) ? p.providers.filter((x): x is ProviderId => PROVIDERS.includes(x)) : current.providers,
      importedFrom: typeof p.importedFrom === 'string' ? p.importedFrom.slice(0, 120) : p.importedFrom === undefined ? current.importedFrom : undefined
    }
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
  const idleRouting = () => {
    if (store.listMetas().some((m) => orchestrator.isRunning(m.id))) throw new Error('Stop the agents before changing the routing connection.')
  }
  const routingChange = async (action: () => Promise<unknown>) => {
    if (changingRouting) throw new Error('A routing change is already in progress.')
    idleRouting()
    changingRouting = true
    try {
      const result = await action()
      if (adapters.codex instanceof CodexAdapter) await adapters.codex.resetConnection()
      // Idle Claude processes retain their launch environment. Resume with the new keys.
      for (const meta of store.listMetas()) adapters.claude.release(meta.id)
      await refreshProviders()
      return result
    } finally { changingRouting = false }
  }
  return {
    routing: {
      status: () => routing.status(true),
      connect: (input) => routingChange(() => routing.connect(input)),
      install: () => routingChange(() => routing.install()),
      start: () => routingChange(() => routing.start()),
      stop: () => routingChange(() => routing.stop()),
      saveCombo: (input) => routingChange(() => routing.saveCombo(input)),
      removeCombo: (id: string) => routingChange(() => routing.removeCombo(id)),
      dashboard: async () => {
        const status = await routing.status()
        if (!status.connected) throw new Error(status.error || 'Start the routing engine first.')
        broadcast({ type: 'browser-open', url: status.endpoint })
      }
    },
    app: {
      info: () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData'), fake: FAKE, home: homedir(), chatsDir: chatsDir() }),
      addProject: (path: string) => {
        if (typeof path !== 'string' || !existsSync(path) || !statSync(path).isDirectory()) throw new Error('That folder does not exist.')
        if (path !== chatsDir() && !store.settings.projects.includes(path)) store.updateSettings({ projects: [path, ...store.settings.projects].slice(0, 200) })
        return path
      },
      isFolder: (path: string) => typeof path === 'string' && existsSync(path) && statSync(path).isDirectory(),
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
      get: async (id: string) => {
        if (store.getMeta(id)?.lazy) await orchestrator.hydrate(id, loadSource)
        return orchestrator.get(id)
      },
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
      send: async (id: string, input: SendInput) => {
        if (changingRouting) throw new Error('Wait for routing setup to finish before starting an agent.')
        const clean = cleanSendInput(input)
        if (store.getMeta(id)?.lazy) await orchestrator.hydrate(id, loadSource)
        return orchestrator.send(id, clean)
      },
      compact: async (id: string) => {
        if (store.getMeta(id)?.lazy) await orchestrator.hydrate(id, loadSource)
        return orchestrator.compact(id)
      },
      stop: (id: string) => orchestrator.stop(id),
      respond: (id: string, itemId: string, decision) => orchestrator.respond(id, itemId, decision),
      fork: (id: string) => orchestrator.fork(id),
      exportMarkdown: (id: string) => orchestrator.exportMarkdown(id)
    },
    providers: {
      status: () => Promise.all(PROVIDERS.map((p) => providerStatus(p))),
      refresh: async (id?: ProviderId) => {
        await refreshProviders(true, id)
        return Promise.all(PROVIDERS.map((p) => providerStatus(p)))
      },
      commands: (id: ProviderId, cwd: string) => (PROVIDERS.includes(id) ? adapters[id].commands(cwd) : []),
      login: async (id: ProviderId) => {
        if (id === 'codex' && adapters.codex instanceof CodexAdapter) {
          const url = await adapters.codex.login((ok, message) => {
            broadcast({ type: 'login-finished', provider: 'codex', ok, message })
            void refreshProviders(true, 'codex')
          })
          await shell.openExternal(url)
          return { kind: 'browser' as const, url, message: 'Finish signing in to ChatGPT in your browser, then come back here.' }
        }
        if (id === 'claude') return { kind: 'terminal' as const, command: CLAUDE_LOGIN_COMMAND, message: 'Sign in to Claude in the terminal below, then come back here.' }
        throw new Error('Sign-in is not available here')
      },
      installCommand: (id: ProviderId) => INSTALL_COMMAND[id] ?? '',
      loginStatus: async (id: ProviderId) => {
        if (id === 'claude' && adapters.claude instanceof ClaudeAdapter) return adapters.claude.loginStatus()
        const status = await adapters[id]?.status(true).catch(() => null)
        return !!status?.installed && status.loggedIn !== false
      }
    },
    themes: {
      generate: async (prompt: string, provider?: ProviderId) => generateTheme(String(prompt ?? ''), await themeAgents(), provider && PROVIDERS.includes(provider) ? provider : store.settings.defaultProvider)
    },
    personality: {
      importFromClaude: () => readClaudePersonality(claudeHome())
    },
    usage: {
      summary: async (days: number) => {
        const sessions = new Set<string>()
        for (const meta of orchestrator.list()) for (const p of PROVIDERS) if (meta.native[p] && !meta.lazy) sessions.add(`${p}:${meta.native[p]!.id}`)
        const summary = usage.summary(Number(days) || 14, sessions, store.settings.usageIncludeOutside)
        const account = await codexAccount().catch(() => null)
        if (account) summary.codexAccount = { lifetimeTokens: account.lifetimeTokens, peakDailyTokens: account.peakDailyTokens, currentStreakDays: account.currentStreakDays, longestStreakDays: account.longestStreakDays }
        return summary
      },
      rescan: () => usage.scan()
    },
    storage: {
      stats: (keep: string[]) => storageStats(storageContext(), Array.isArray(keep) ? keep.filter((k) => typeof k === 'string') : []),
      clean: async (keep: string[]) => {
        const ctx = storageContext()
        const files = [...(await unusedAttachments(ctx, Array.isArray(keep) ? keep.filter((k) => typeof k === 'string') : [])), ...oldSafetyCopies(ctx)]
        let count = 0
        let bytes = 0
        for (const f of files) {
          try {
            await shell.trashItem(f.path)
            count++
            bytes += f.bytes
          } catch {
            // in use or already gone
          }
        }
        return { files: count, bytes }
      }
    },
    cli: {
      status: () => cliStatus(getEnv().PATH),
      install: () => {
        if (!app.isPackaged && !process.env.DUET_CLI_DIR) throw new Error('The duet command runs the installed app — install Duet in Applications first.')
        const bundle = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '')
        return installCli(bundle, getEnv().PATH)
      },
      uninstall: () => uninstallCli(getEnv().PATH)
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
        const saveImage = (data: string, mime: string) => saveToolImage(store.attachmentsDir, data, mime)
        const loaded =
          provider === 'claude'
            ? loadClaudeSession(nativeId, saveImage)
            : adapters.codex instanceof CodexAdapter
              ? await loadCodexThread((m, p, t) => (adapters.codex as CodexAdapter).rpcRequest(m, p, t), nativeId, saveImage)
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
      },
      syncAll: () => syncChats()
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
  mkdirSync(chatsDir(), { recursive: true })
  cliToken()
  // Tests of the packaged app must not make a throwaway build the Mac's handler for duet:// links.
  if (app.isPackaged && process.env.DUET_E2E !== '1') app.setAsDefaultProtocolClient('duet')
  usage = new UsageService(
    join(app.getPath('userData'), 'cache', 'usage-v1.json'),
    () => ({ claudeProjects: join(claudeHome(), 'projects'), codexRoots: [join(codexHome(), 'sessions'), join(codexHome(), 'archived_sessions')] }),
    join(__dirname, 'usageWorker.js'),
    () => broadcast({ type: 'usage-updated' }),
    log
  )

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

  routing = new RoutingService({
    root: store.root,
    settings: () => store.settings.routing,
    saveSettings: (value) => store.updateSettings({ routing: value }),
    env: getEnv,
    encrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Unlock your system keychain before saving routing keys.')
      return safeStorage.encryptString(value)
    },
    decrypt: (value) => safeStorage.decryptString(value)
  })

  adapters = FAKE
    ? { claude: new FakeAdapter('claude', undefined, store.attachmentsDir), codex: new FakeAdapter('codex', undefined, store.attachmentsDir) }
    : {
        claude: new ClaudeAdapter({ binary: () => findBinary('claude', store.settings.claudePath), env: getEnv, attachmentsDir: store.attachmentsDir, prepareImage, log, routing: { ensureModel: (m, images) => routing.ensureModel(m, images), claudeEnv: (m, env) => routing.claudeEnv(m, env) } }),
        codex: new CodexAdapter({ binary: () => findBinary('codex', store.settings.codexPath), env: () => routing.codexEnv(getEnv()), appVersion: app.getVersion(), attachmentsDir: store.attachmentsDir, log, routing: { ensureModel: (m, images) => routing.ensureModel(m, images), codexConfig: (m) => routing.codexConfig(m) } })
      }

  orchestrator = new Orchestrator({
    store,
    adapters,
    sessionKey: (_provider, model) => routing.sessionKey(model),
    broadcast,
    notify,
    onBadge: setBadge,
    onLimits: (provider) => {
      void providerStatus(provider).then((status) => {
        broadcast({ type: 'provider-status', status })
        writeLimitsCache()
      }).catch((error) => log('[status]', provider, (error as Error).message))
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
  mainWindow?.webContents.once('did-finish-load', () => {
    linksReady = true
    for (const url of pendingLinks.splice(0)) void handleDeepLink(url)
  })
  mainWindow?.on('focus', () => autoSyncChats())
  if (process.env.DUET_E2E === '1') (globalThis as unknown as { __duetOpenUrl: typeof handleDeepLink }).__duetOpenUrl = handleDeepLink
  void refreshProviders(false)
  setTimeout(() => autoSyncChats(), 4000).unref?.()
  setInterval(() => autoSyncChats(), 10 * 60_000).unref?.()
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
        await routing?.shutdown()
      } finally {
        app.quit()
      }
    })()
  })
}
