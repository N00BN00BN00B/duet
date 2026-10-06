// Shared contract between the Electron main process and the renderer.

export type ProviderId = 'claude' | 'codex'

export const PROVIDERS: ProviderId[] = ['claude', 'codex']

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

export function otherProvider(p: ProviderId): ProviderId {
  return p === 'claude' ? 'codex' : 'claude'
}

/** How much the agent may do without asking. Mapped onto each provider's own permission model. */
export type AccessMode = 'plan' | 'ask' | 'auto' | 'full'

export const ACCESS_MODES: { id: AccessMode; label: string; hint: string }[] = [
  { id: 'plan', label: 'Plan', hint: 'Read-only. The agent explores and proposes a plan.' },
  { id: 'ask', label: 'Ask', hint: 'Asks before running commands or editing files.' },
  { id: 'auto', label: 'Auto-edit', hint: 'Edits files freely, asks before risky commands.' },
  { id: 'full', label: 'Full access', hint: 'No prompts. Commands and edits run without asking.' }
]

export interface ModelOption {
  id: string
  label: string
  description?: string
  efforts?: string[]
  defaultEffort?: string
  isDefault?: boolean
  supportsImages?: boolean
}

export interface Attachment {
  id: string
  name: string
  mime: string
  /** Absolute path of the stored copy inside Duet's attachments folder. */
  path: string
  size: number
}

export type ToolKind =
  | 'command'
  | 'edit'
  | 'write'
  | 'read'
  | 'search'
  | 'mcp'
  | 'web'
  | 'agent'
  | 'todo'
  | 'image'
  | 'skill'
  | 'other'

export type ItemStatus = 'running' | 'done' | 'error' | 'declined'

export interface PlanStep {
  text: string
  status: 'pending' | 'active' | 'done'
}

interface ItemBase {
  id: string
  ts: number
}

export interface UserItem extends ItemBase {
  kind: 'user'
  provider: ProviderId
  text: string
  attachments: Attachment[]
}

export interface AssistantItem extends ItemBase {
  kind: 'assistant'
  provider: ProviderId
  model?: string
  text: string
  streaming?: boolean
}

export interface ReasoningItem extends ItemBase {
  kind: 'reasoning'
  provider: ProviderId
  text: string
  streaming?: boolean
}

export interface ToolItem extends ItemBase {
  kind: 'tool'
  provider: ProviderId
  tool: ToolKind
  /** Raw tool name, e.g. "Bash", "mcp__github__create_issue", "commandExecution". */
  name: string
  /** Short human title, e.g. "npm test" or "src/app.ts". */
  title: string
  /** Secondary text, e.g. a command description or MCP server name. */
  detail?: string
  input?: unknown
  output?: string
  /** Unified diff for edits. */
  diff?: string
  exitCode?: number | null
  status: ItemStatus
  durationMs?: number
  /** Absolute paths of images produced or viewed by the tool. */
  images?: string[]
  steps?: PlanStep[]
}

export type ApprovalStatus = 'pending' | 'approved' | 'approved-session' | 'denied' | 'expired'

export interface ApprovalItem extends ItemBase {
  kind: 'approval'
  provider: ProviderId
  /** What is being approved. */
  request: 'command' | 'edit' | 'tool' | 'permissions' | 'plan' | 'question'
  title: string
  detail?: string
  command?: string
  cwd?: string
  diff?: string
  /** Plan markdown for plan approvals (Claude ExitPlanMode). */
  plan?: string
  questions?: Question[]
  answers?: Record<string, string>
  status: ApprovalStatus
  canAllowForSession: boolean
}

export interface Question {
  id: string
  header?: string
  question: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
  allowOther?: boolean
}

export interface SwitchItem extends ItemBase {
  kind: 'switch'
  from: ProviderId | null
  to: ProviderId
  model?: string
}

export interface NoticeItem extends ItemBase {
  kind: 'notice'
  level: 'info' | 'warn' | 'error'
  text: string
  provider?: ProviderId
}

export interface TurnItem extends ItemBase {
  kind: 'turn'
  provider: ProviderId
  model?: string
  status: 'completed' | 'interrupted' | 'failed'
  durationMs?: number
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}

export type TimelineItem =
  | UserItem
  | AssistantItem
  | ReasoningItem
  | ToolItem
  | ApprovalItem
  | SwitchItem
  | NoticeItem
  | TurnItem

export type ThreadStatus = 'idle' | 'running' | 'approval' | 'error'

export interface NativeSession {
  /** Claude session id or Codex thread id. */
  id: string
  /** Number of timeline items this native session has already "seen". */
  syncedTo: number
  /** Last cumulative cost the agent reported for this session (Claude reports running totals). */
  costTotal?: number
}

export interface ContextUsage {
  usedTokens: number
  windowTokens?: number
}

export interface ThreadMeta {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  /** Provider used for the next message. */
  provider: ProviderId
  models: Partial<Record<ProviderId, string>>
  efforts: Partial<Record<ProviderId, string>>
  access: AccessMode
  status: ThreadStatus
  pinned?: boolean
  archived?: boolean
  unread?: boolean
  native: Partial<Record<ProviderId, NativeSession>>
  /** Set when the thread was imported from an existing Claude/Codex session. */
  origin?: { provider: ProviderId; nativeId: string }
  preview?: string
  itemCount: number
  context?: ContextUsage
  costUsd?: number
}

export interface Thread extends ThreadMeta {
  items: TimelineItem[]
}

export interface NewThreadInput {
  cwd: string
  provider?: ProviderId
  model?: string
  title?: string
}

export interface SendInput {
  text: string
  attachments: Attachment[]
}

export type ApprovalDecision =
  | { kind: 'allow' }
  | { kind: 'allow-session' }
  | { kind: 'deny'; message?: string }
  | { kind: 'answer'; answers: Record<string, string> }

export type ThreadPatch = Partial<
  Pick<ThreadMeta, 'title' | 'provider' | 'models' | 'efforts' | 'access' | 'pinned' | 'archived' | 'unread' | 'cwd'>
>

// ---------- provider status ----------

export interface RateWindow {
  label: string
  usedPercent: number
  resetsAt?: number
}

export interface ProviderStatus {
  id: ProviderId
  installed: boolean
  binaryPath?: string
  version?: string
  loggedIn?: boolean
  account?: string
  plan?: string
  models: ModelOption[]
  defaultModel?: string
  limits: RateWindow[]
  error?: string
  checkedAt?: number
}

// ---------- events pushed from main to renderer ----------

export type DuetEvent =
  | { type: 'thread-meta'; meta: ThreadMeta }
  | { type: 'thread-removed'; id: string }
  | { type: 'item'; threadId: string; item: TimelineItem }
  /** `offset` is where the chunk starts in the field, so a chunk is never applied twice. */
  | { type: 'item-delta'; threadId: string; itemId: string; field: 'text' | 'output'; delta: string; offset: number }
  | { type: 'provider-status'; status: ProviderStatus }
  | { type: 'terminal-data'; id: string; data: string }
  | { type: 'terminal-exit'; id: string; code: number }
  | { type: 'toast'; level: 'info' | 'success' | 'error'; text: string }
  | { type: 'backup-progress'; phase: string; done: number; total: number }
  | { type: 'navigate'; view: string }
  | { type: 'command'; name: string }
  | { type: 'browser-open'; url: string }

// ---------- settings ----------

export type ThemePref = 'system' | 'dark' | 'light'

export interface Settings {
  theme: ThemePref
  defaultProvider: ProviderId
  defaultModels: Partial<Record<ProviderId, string>>
  defaultEfforts: Partial<Record<ProviderId, string>>
  defaultAccess: AccessMode
  sendWithEnter: boolean
  notifications: boolean
  sounds: boolean
  claudePath: string
  codexPath: string
  projects: string[]
  backupDir: string
  autoBackup: 'off' | 'daily' | 'weekly'
  lastAutoBackup?: number
  includeAuthInBackups: boolean
  fontSize: number
  browserHome: string
  onboarded: boolean
}

// ---------- MCP ----------

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerConfig {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  bearerTokenEnvVar?: string
  enabled?: boolean
}

export type McpScope = 'user' | 'project' | 'local' | 'plugin' | 'cloud'

/** The server an edit started from, so it is changed where it lives. */
export interface McpEditSource {
  name: string
  /** Where Claude keeps it (user, local or project). */
  claudeScope?: McpScope
  project?: string
}

export interface McpEntry {
  provider: ProviderId
  scope: McpScope
  /** Project path for project/local scoped servers. */
  project?: string
  config: McpServerConfig
  status?: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'unknown'
  readOnly?: boolean
  /** Number of tools exposed, when known. */
  tools?: number
}

// ---------- sync ----------

export type SyncKind = 'instructions' | 'skill' | 'mcp' | 'command'

export interface SyncItem {
  key: string
  kind: SyncKind
  name: string
  claude?: { path: string; mtime: number; size: number; hash: string }
  codex?: { path: string; mtime: number; size: number; hash: string }
  state: 'same' | 'claude-only' | 'codex-only' | 'different'
  newer?: ProviderId
}

export interface SyncAction {
  key: string
  direction: 'to-claude' | 'to-codex'
}

// ---------- backups ----------

export interface BackupSet {
  id: string
  label: string
  description: string
  sensitive?: boolean
  defaultOn: boolean
  bytes?: number
  files?: number
}

export interface BackupInfo {
  file: string
  name: string
  createdAt: number
  bytes: number
  sets: string[]
  files: number
  host?: string
  app?: string
}

// ---------- history import ----------

export interface HistoryEntry {
  provider: ProviderId
  nativeId: string
  title: string
  cwd: string
  updatedAt: number
  createdAt: number
  messages?: number
  model?: string
  importedThreadId?: string
}

// ---------- git ----------

export interface GitFileChange {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface GitStatus {
  isRepo: boolean
  branch?: string
  ahead?: number
  behind?: number
  files: GitFileChange[]
}

// ---------- files ----------

export interface FileSuggestion {
  path: string
  isDir: boolean
}

export interface SlashCommand {
  name: string
  description: string
  argumentHint?: string
}
