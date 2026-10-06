import { create } from 'zustand'
import type {
  AccessMode,
  ApprovalDecision,
  Attachment,
  DuetEvent,
  ProviderId,
  ProviderStatus,
  ReviewTarget,
  Settings,
  SkillRef,
  ThreadMeta,
  ThreadPatch,
  TimelineItem
} from '@shared/types'
import { duet, errorMessage, terminalBus } from '@/lib/api'
import { applyDelta } from '@/lib/timeline'
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, PRESET_THEMES, resolveTheme, themeVariables, type ThemeSpec } from '@shared/theme'

export type View = 'home' | 'thread' | 'history' | 'mcp' | 'sync' | 'backups' | 'settings' | 'usage' | 'customize'
export const VIEWS: View[] = ['home', 'thread', 'history', 'mcp', 'sync', 'backups', 'settings', 'usage', 'customize']
export type RightPanel = 'browser' | 'changes' | null

export interface Draft {
  text: string
  attachments: Attachment[]
  /** Codex skills picked from the commands menu. */
  skills?: SkillRef[]
}

export interface Toast {
  id: number
  level: 'info' | 'success' | 'error'
  text: string
  action?: { label: string; run: () => void }
}

export interface AppInfo {
  version: string
  platform: string
  fake: boolean
  home: string
  userData: string
  /** Folder used for chats that don't belong to a project. */
  chatsDir: string
}

interface UiPrefs {
  sidebarOpen: boolean
  sidebarMoreOpen: boolean
  sidebarWidth: number
  rightPanel: RightPanel
  rightWidth: number
  terminalHeight: number
}

interface State extends UiPrefs {
  ready: boolean
  info: AppInfo
  settings: Settings | null
  threads: Record<string, ThreadMeta>
  items: Record<string, TimelineItem[]>
  currentId: string | null
  view: View
  homeProject: string | null
  homeProvider: ProviderId
  providers: Partial<Record<ProviderId, ProviderStatus>>
  terminalOpen: boolean
  paletteOpen: boolean
  toasts: Toast[]
  drafts: Record<string, Draft>
  /** Messages typed while the agent was busy; sent automatically when the turn ends. */
  queued: Record<string, Draft>
  lightbox: string | null
  backupProgress: { phase: string; done: number; total: number } | null
  browserUrl: string
  browserNonce: number
  focusNonce: number
  /** The theme on screen right now (resolved from settings and the system appearance). */
  theme: ThemeSpec
  /** A theme being previewed in Customize; shown instead of `theme` until applied or dropped. */
  previewTheme: ThemeSpec | null
  /** The window is in the background: animations pause to save power. */
  idle: boolean
  /** Chat sync in progress (sidebar shows a hint). */
  chatSyncing: boolean
  /** Bumped when usage numbers change so the Usage view refetches. */
  usageNonce: number
  /** An agent sign-in we're waiting for. */
  connecting: ProviderId | null
}

const PREFS_KEY = 'duet.ui.v1'
const DRAFTS_KEY = 'duet.drafts.v1'

function loadPrefs(): UiPrefs {
  const fallback: UiPrefs = { sidebarOpen: true, sidebarMoreOpen: false, sidebarWidth: 272, rightPanel: null, rightWidth: 520, terminalHeight: 260 }
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return { ...fallback, ...raw }
  } catch {
    return fallback
  }
}

function loadDrafts(): Record<string, Draft> {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export const useApp = create<State>(() => ({
  ready: false,
  info: { version: '', platform: 'darwin', fake: false, home: '', userData: '', chatsDir: '' },
  settings: null,
  threads: {},
  items: {},
  currentId: null,
  view: 'home',
  homeProject: null,
  homeProvider: 'claude',
  providers: {},
  terminalOpen: false,
  paletteOpen: false,
  toasts: [],
  drafts: loadDrafts(),
  queued: {},
  lightbox: null,
  backupProgress: null,
  browserUrl: '',
  browserNonce: 0,
  focusNonce: 0,
  theme: PRESET_THEMES[0],
  previewTheme: null,
  idle: false,
  chatSyncing: false,
  usageNonce: 0,
  connecting: null,
  ...loadPrefs()
}))

const get = useApp.getState
const set = useApp.setState

// Persist layout prefs and drafts.
let draftTimer: ReturnType<typeof setTimeout> | null = null
useApp.subscribe((s, prev) => {
  if (
    s.sidebarOpen !== prev.sidebarOpen ||
    s.sidebarMoreOpen !== prev.sidebarMoreOpen ||
    s.sidebarWidth !== prev.sidebarWidth ||
    s.rightPanel !== prev.rightPanel ||
    s.rightWidth !== prev.rightWidth ||
    s.terminalHeight !== prev.terminalHeight
  ) {
    const prefs: UiPrefs = { sidebarOpen: s.sidebarOpen, sidebarMoreOpen: s.sidebarMoreOpen, sidebarWidth: s.sidebarWidth, rightPanel: s.rightPanel, rightWidth: s.rightWidth, terminalHeight: s.terminalHeight }
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // storage full / unavailable
    }
  }
  if (s.drafts !== prev.drafts) {
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(get().drafts))
      } catch {
        // ignore
      }
    }, 300)
  }
})

// ---------- toasts ----------

let toastId = 0
export function toast(text: string, level: Toast['level'] = 'info', action?: Toast['action']): void {
  const id = ++toastId
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, level, text, action }] }))
  setTimeout(() => dismissToast(id), level === 'error' ? 7000 : action ? 8000 : 3800)
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function toastError(error: unknown): void {
  toast(errorMessage(error), 'error')
}

// ---------- theme / accent ----------

const media = window.matchMedia('(prefers-color-scheme: dark)')

const SPACING: Record<string, string> = { compact: '0.225rem', comfortable: '0.25rem', spacious: '0.28rem' }
const CHAT_WIDTH: Record<string, string> = { narrow: '680px', normal: '760px', wide: '940px' }

/** Puts the current theme and appearance settings on the document. */
export function applyTheme(): void {
  const settings = get().settings
  const theme = get().previewTheme ?? resolveTheme(settings, media.matches)
  const root = document.documentElement
  root.dataset.theme = theme.base
  for (const [key, value] of Object.entries(themeVariables(theme))) root.style.setProperty(key, value)
  const accent = settings?.accentMode === 'theme' ? theme.colors.accent : settings?.accentMode === 'custom' ? settings.accentColor : null
  if (accent) root.style.setProperty('--accent', accent)
  else root.style.removeProperty('--accent') // follows the agent: Claude terracotta, Codex periwinkle
  root.style.setProperty('--app-font-size', `${settings?.fontSize ?? 14}px`)
  root.style.setProperty('--spacing', SPACING[settings?.density ?? 'comfortable'])
  root.style.setProperty('--chat-width', CHAT_WIDTH[settings?.chatWidth ?? 'normal'])
  root.dataset.motion = settings?.reduceMotion ? 'reduced' : 'full'
  root.dataset.effect = theme.background.effect
  if (get().theme !== theme) set({ theme })
}
media.addEventListener('change', applyTheme)

/** Shows a theme without saving it (Customize preview); null goes back to the saved one. */
export function previewTheme(theme: ThemeSpec | null): void {
  set({ previewTheme: theme })
  applyTheme()
}

// Pause decorative animation while Duet is in the background.
const updateIdle = () => {
  const idle = document.hidden || !document.hasFocus()
  if (get().idle !== idle) {
    set({ idle })
    document.documentElement.dataset.idle = idle ? 'true' : 'false'
  }
}
window.addEventListener('focus', updateIdle)
window.addEventListener('blur', updateIdle)
document.addEventListener('visibilitychange', updateIdle)

export function activeProvider(s: State = get()): ProviderId {
  if (s.view === 'thread' && s.currentId && s.threads[s.currentId]) return s.threads[s.currentId].provider
  return s.homeProvider
}

useApp.subscribe((s) => {
  const p = activeProvider(s)
  if (document.documentElement.dataset.provider !== p) document.documentElement.dataset.provider = p
})

// ---------- items ----------

function upsertItem(list: TimelineItem[], item: TimelineItem): TimelineItem[] {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id === item.id) {
      const copy = list.slice()
      copy[i] = item
      return copy
    }
  }
  return [...list, item]
}

// ---------- events ----------

let commandHandler: ((name: string) => void) | null = null
export function onCommand(fn: (name: string) => void): void {
  commandHandler = fn
}

function handleEvent(e: DuetEvent): void {
  switch (e.type) {
    case 'thread-meta': {
      const before = get().threads[e.meta.id]
      set((s) => ({ threads: { ...s.threads, [e.meta.id]: e.meta } }))
      const wasBusy = before && (before.status === 'running' || before.status === 'approval')
      const pending = get().queued[e.meta.id]
      if (wasBusy && pending && e.meta.status === 'idle') {
        clearQueued(e.meta.id)
        void sendMessage(e.meta.id, pending).catch((error) => {
          restoreQueued(e.meta.id, pending)
          toastError(error)
        })
      } else if (wasBusy && pending && e.meta.status === 'error') {
        // The turn failed: don't fire the follow-up blindly, hand it back for review.
        restoreQueued(e.meta.id, pending)
        toast('The turn stopped with an error, so your queued message wasn’t sent. It’s back in the message box.', 'info')
      }
      if (e.meta.unread && get().currentId === e.meta.id && get().view === 'thread' && document.hasFocus()) {
        void duet.threads.update(e.meta.id, { unread: false }).catch(() => undefined)
      }
      break
    }
    case 'thread-removed':
      set((s) => {
        const threads = { ...s.threads }
        delete threads[e.id]
        const items = { ...s.items }
        delete items[e.id]
        const leaving = s.currentId === e.id
        return { threads, items, ...(leaving ? { currentId: null, view: 'home' as View } : {}) }
      })
      break
    case 'item':
      set((s) => (s.items[e.threadId] ? { items: { ...s.items, [e.threadId]: upsertItem(s.items[e.threadId], e.item) } } : {}))
      break
    case 'item-delta':
      set((s) => {
        const list = s.items[e.threadId]
        if (!list) return {}
        const next = applyDelta(list, e.itemId, e.field, e.delta, e.offset)
        return next ? { items: { ...s.items, [e.threadId]: next } } : {}
      })
      break
    case 'provider-status':
      set((s) => ({ providers: { ...s.providers, [e.status.id]: e.status } }))
      break
    case 'terminal-data':
      terminalBus.emitData(e.id, e.data)
      break
    case 'terminal-exit':
      terminalBus.emitExit(e.id, e.code)
      break
    case 'toast':
      toast(e.text, e.level)
      break
    case 'backup-progress':
      set({ backupProgress: e.done >= e.total ? null : { phase: e.phase, done: e.done, total: e.total } })
      break
    case 'navigate':
      if (e.view.startsWith('thread:')) void openThread(e.view.slice(7))
      else if (VIEWS.includes(e.view as View) && e.view !== 'thread') setView(e.view as View)
      break
    case 'command':
      if (e.name === 'window-focus') {
        const { currentId, threads, view } = get()
        if (view === 'thread' && currentId && threads[currentId]?.unread) void duet.threads.update(currentId, { unread: false }).catch(() => undefined)
      } else commandHandler?.(e.name)
      break
    case 'browser-open':
      openBrowser(e.url)
      break
    case 'threads-bulk':
      set((s) => {
        const threads = { ...s.threads }
        const items = { ...s.items }
        for (const meta of e.metas) {
          threads[meta.id] = meta
          // A synced chat that will be re-read from its source drops any copy shown before.
          if (meta.lazy) delete items[meta.id]
        }
        return { threads, items }
      })
      break
    case 'chat-sync':
      set({ chatSyncing: e.phase === 'running' })
      if (e.phase === 'done' && (e.added || e.updated)) toast(`Synced chats: ${e.added} new${e.updated ? `, ${e.updated} updated` : ''} (${e.total} in Claude Code and Codex)`, 'success')
      break
    case 'usage-updated':
      set((s) => ({ usageNonce: s.usageNonce + 1 }))
      break
    case 'login-finished':
      set({ connecting: null })
      toast(e.ok ? `${e.provider === 'claude' ? 'Claude' : 'Codex'} is connected.` : `Sign-in didn't finish${e.message ? `: ${e.message}` : '.'}`, e.ok ? 'success' : 'error')
      void refreshProviders(e.provider)
      break
    case 'compose': {
      if (e.provider) set({ homeProvider: e.provider })
      void duet.settings.get().then((settings) => set({ settings }))
      goHome(e.cwd ?? null)
      if (e.text) setDraft('home', { text: e.text, attachments: [] })
      break
    }
  }
}

export async function init(): Promise<void> {
  duet.on(handleEvent)
  const [info, settings, metas] = await Promise.all([duet.app.info(), duet.settings.get(), duet.threads.list()])
  const threads: Record<string, ThreadMeta> = {}
  for (const m of metas) threads[m.id] = m
  set({
    info,
    settings,
    threads,
    homeProvider: settings.defaultProvider,
    homeProject: settings.projects[0] ?? null,
    ready: true
  })
  applyTheme()
  void duet.providers
    .status()
    .then((list) => set((s) => ({ providers: { ...s.providers, ...Object.fromEntries(list.map((p) => [p.id, p])) } })))
    .catch(() => undefined)
}

// ---------- navigation ----------

export function setView(view: View): void {
  set({ view, paletteOpen: false })
}

export async function openThread(id: string): Promise<void> {
  const s = get()
  if (!s.threads[id]) return
  set({ currentId: id, view: 'thread', paletteOpen: false, focusNonce: s.focusNonce + 1 })
  if (!s.items[id]) {
    try {
      const thread = await duet.threads.get(id)
      if (thread) set((st) => ({ items: { ...st.items, [id]: thread.items }, threads: { ...st.threads, [id]: { ...st.threads[id], ...stripItems(thread) } } }))
    } catch (error) {
      toastError(error)
    }
  }
  // Keep at most a handful of threads' items in memory.
  const loaded = Object.keys(get().items)
  if (loaded.length > 12) {
    set((st) => {
      const items = { ...st.items }
      for (const key of loaded.slice(0, loaded.length - 12)) if (key !== id) delete items[key]
      return { items }
    })
  }
  if (get().threads[id]?.unread) void duet.threads.update(id, { unread: false }).catch(() => undefined)
}

function stripItems<T extends { items?: unknown }>(t: T): Omit<T, 'items'> {
  const copy = { ...t }
  delete copy.items
  return copy
}

export function goHome(project?: string | null): void {
  set((s) => ({ view: 'home', currentId: null, homeProject: project ?? s.homeProject, focusNonce: s.focusNonce + 1, paletteOpen: false }))
}

/** Adds a project folder (asking for one if none is given) and starts a new chat in it. */
export async function addProject(dir?: string): Promise<string | null> {
  try {
    const folder = dir ?? (await duet.app.pickFolder())
    if (!folder) return null
    const added = await duet.app.addProject(folder)
    set((s) => ({ settings: s.settings && !s.settings.projects.includes(added) ? { ...s.settings, projects: [added, ...s.settings.projects] } : s.settings }))
    goHome(added)
    return added
  } catch (error) {
    toastError(error)
    return null
  }
}

// ---------- threads ----------

export async function createAndSend(cwd: string, provider: ProviderId, draft: Draft, model?: string, review?: ReviewTarget): Promise<void> {
  const meta = await duet.threads.create({ cwd, provider, model })
  set((s) => ({ threads: { ...s.threads, [meta.id]: meta }, items: { ...s.items, [meta.id]: [] } }))
  await openThread(meta.id)
  await duet.threads.send(meta.id, { text: draft.text, attachments: draft.attachments, skills: draft.skills, review })
}

export async function sendMessage(threadId: string, draft: Draft, review?: ReviewTarget): Promise<void> {
  await duet.threads.send(threadId, { text: draft.text, attachments: draft.attachments, skills: draft.skills, review })
}

export async function updateThread(id: string, patch: ThreadPatch): Promise<void> {
  try {
    const meta = await duet.threads.update(id, patch)
    if (meta) set((s) => ({ threads: { ...s.threads, [id]: meta } }))
  } catch (error) {
    toastError(error)
  }
}

export async function switchProvider(provider: ProviderId, model?: string): Promise<void> {
  const s = get()
  if (s.view === 'thread' && s.currentId) {
    const meta = s.threads[s.currentId]
    if (!meta) return
    const patch: ThreadPatch = { provider }
    if (model) patch.models = { [provider]: model }
    // Optimistic so the accent fades immediately.
    set((st) => ({ threads: { ...st.threads, [meta.id]: { ...meta, provider, models: model ? { ...meta.models, [provider]: model } : meta.models } } }))
    await updateThread(meta.id, patch)
  } else {
    set({ homeProvider: provider })
    if (model && s.settings) await saveSettings({ defaultModels: { ...s.settings.defaultModels, [provider]: model } })
  }
}

export async function setAccess(access: AccessMode): Promise<void> {
  const s = get()
  if (s.view === 'thread' && s.currentId) await updateThread(s.currentId, { access })
  else await saveSettings({ defaultAccess: access })
}

export async function respond(threadId: string, itemId: string, decision: ApprovalDecision): Promise<void> {
  try {
    await duet.threads.respond(threadId, itemId, decision)
  } catch (error) {
    toastError(error)
  }
}

export async function stopThread(threadId: string): Promise<void> {
  try {
    await duet.threads.stop(threadId)
  } catch (error) {
    toastError(error)
  }
}

export async function removeThread(id: string): Promise<void> {
  try {
    await duet.threads.remove(id)
  } catch (error) {
    toastError(error)
  }
}

export async function forkThread(id: string): Promise<void> {
  try {
    const meta = await duet.threads.fork(id)
    if (meta) {
      set((s) => ({ threads: { ...s.threads, [meta.id]: meta } }))
      await openThread(meta.id)
      toast('Forked into a new thread', 'success')
    }
  } catch (error) {
    toastError(error)
  }
}

export async function copyMarkdown(id: string): Promise<void> {
  try {
    const md = await duet.threads.exportMarkdown(id)
    if (md) {
      await navigator.clipboard.writeText(md)
      toast('Copied the conversation as Markdown', 'success')
    }
  } catch (error) {
    toastError(error)
  }
}

// ---------- drafts ----------

export function draftKey(): string {
  const s = get()
  return s.view === 'thread' && s.currentId ? s.currentId : `home`
}

export function setDraft(key: string, draft: Draft): void {
  set((s) => ({ drafts: { ...s.drafts, [key]: draft } }))
}

export function clearDraft(key: string): void {
  set((s) => {
    const drafts = { ...s.drafts }
    delete drafts[key]
    return { drafts }
  })
}

export function queueMessage(threadId: string, draft: Draft): void {
  set((s) => {
    const existing = s.queued[threadId]
    const merged: Draft = existing
      ? { text: [existing.text, draft.text].filter(Boolean).join('\n\n'), attachments: [...existing.attachments, ...draft.attachments] }
      : draft
    return { queued: { ...s.queued, [threadId]: merged } }
  })
}

/** Moves a queued message back into the thread's message box, ahead of anything typed since. */
export function restoreQueued(threadId: string, queued: Draft): void {
  clearQueued(threadId)
  const current = get().drafts[threadId]
  setDraft(threadId, {
    text: [queued.text, current?.text].filter(Boolean).join('\n\n'),
    attachments: [...queued.attachments, ...(current?.attachments ?? [])]
  })
}

export function clearQueued(threadId: string): void {
  set((s) => {
    if (!s.queued[threadId]) return {}
    const queued = { ...s.queued }
    delete queued[threadId]
    return { queued }
  })
}

// ---------- settings ----------

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  try {
    const settings = await duet.settings.update(patch)
    set({ settings })
    applyTheme()
  } catch (error) {
    toastError(error)
  }
}

// ---------- panels ----------

export function togglePanel(panel: Exclude<RightPanel, null>): void {
  set((s) => ({ rightPanel: s.rightPanel === panel ? null : panel }))
}

export function openBrowser(url?: string): void {
  set((s) => ({ rightPanel: 'browser', browserUrl: url ?? s.browserUrl, browserNonce: url ? s.browserNonce + 1 : s.browserNonce }))
}

export async function refreshProviders(id?: ProviderId): Promise<void> {
  try {
    const list = await duet.providers.refresh(id)
    set((s) => ({ providers: { ...s.providers, ...Object.fromEntries(list.map((p) => [p.id, p])) } }))
  } catch (error) {
    toastError(error)
  }
}

export function currentThread(s: State = get()): ThreadMeta | null {
  return s.currentId ? (s.threads[s.currentId] ?? null) : null
}

// ---------- themes ----------

/** Shows a theme and remembers it as the dark or light theme (switching mode if needed). */
export async function chooseTheme(theme: ThemeSpec): Promise<void> {
  const s = get().settings
  if (!s) return
  const patch: Partial<Settings> = theme.base === 'dark' ? { darkTheme: theme.id } : { lightTheme: theme.id }
  const showing = get().theme.base
  if (s.theme === 'system' ? showing !== theme.base : s.theme !== theme.base) patch.theme = theme.base
  if (theme.source !== 'preset') {
    patch.customThemes = [...s.customThemes.filter((t) => t.id !== theme.id), theme]
    // A designed theme brings its own accent.
    if (s.accentMode === 'agent') patch.accentMode = 'theme'
  }
  set({ previewTheme: null })
  await saveSettings(patch)
}

export async function deleteCustomTheme(id: string): Promise<void> {
  const s = get().settings
  if (!s) return
  await saveSettings({
    customThemes: s.customThemes.filter((t) => t.id !== id),
    ...(s.darkTheme === id ? { darkTheme: DEFAULT_DARK_THEME } : {}),
    ...(s.lightTheme === id ? { lightTheme: DEFAULT_LIGHT_THEME } : {})
  })
}

/** Designs a theme from a description (with an agent when possible) and puts it on. */
export async function designTheme(prompt: string, provider?: ProviderId): Promise<ThemeSpec | null> {
  const before = get().settings
  try {
    const res = await duet.themes.generate(prompt, provider)
    await chooseTheme(res.theme)
    const by = res.via === 'local' ? 'offline' : res.via === 'claude' ? 'by Claude' : 'by Codex'
    toast(`Theme “${res.theme.name}” applied (${by}).`, 'success', before ? { label: 'Undo', run: () => void saveSettings({ theme: before.theme, darkTheme: before.darkTheme, lightTheme: before.lightTheme, accentMode: before.accentMode }) } : undefined)
    return res.theme
  } catch (error) {
    toastError(error)
    return null
  }
}

// ---------- agents ----------

/** Starts signing in to an agent: Codex opens the browser, Claude signs in in the terminal. */
export async function connectProvider(id: ProviderId): Promise<void> {
  try {
    const status = get().providers[id]
    if (status && !status.installed) {
      const command = await duet.providers.installCommand(id)
      const { runInTerminal } = await import('@/components/panels/TerminalDrawer')
      runInTerminal(command)
      toast(`Installing ${id === 'claude' ? 'Claude Code' : 'Codex'} in the terminal below. Click Check again when it's done.`, 'info')
      return
    }
    const start = await duet.providers.login(id)
    set({ connecting: id })
    if (start.kind === 'terminal' && start.command) {
      const { runInTerminal } = await import('@/components/panels/TerminalDrawer')
      runInTerminal(start.command)
    }
    toast(start.message, 'info')
    if (id === 'claude') void waitForLogin(id)
  } catch (error) {
    set({ connecting: null })
    toastError(error)
  }
}

/** Polls the cheap login check for a couple of minutes after a terminal sign-in started. */
async function waitForLogin(id: ProviderId): Promise<void> {
  for (let i = 0; i < 60 && get().connecting === id; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    if (await duet.providers.loginStatus(id).catch(() => false)) {
      set({ connecting: null })
      toast(`${id === 'claude' ? 'Claude' : 'Codex'} is connected.`, 'success')
      await refreshProviders(id)
      return
    }
  }
  if (get().connecting === id) set({ connecting: null })
}

// ---------- commands ----------

export async function compactThread(id: string): Promise<void> {
  try {
    await duet.threads.compact(id)
  } catch (error) {
    toastError(error)
  }
}

export async function sendReview(threadId: string, text: string, target: ReviewTarget): Promise<void> {
  await duet.threads.send(threadId, { text, attachments: [], review: target })
}

export async function syncAllChats(): Promise<void> {
  try {
    set({ chatSyncing: true })
    await duet.history.syncAll()
  } catch (error) {
    toastError(error)
  } finally {
    set({ chatSyncing: false })
  }
}
