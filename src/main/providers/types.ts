import type {
  AccessMode,
  ApprovalDecision,
  ApprovalStatus,
  Attachment,
  ContextUsage,
  ProviderId,
  ProviderStatus,
  RateWindow,
  SlashCommand,
  TimelineItem
} from '@shared/types'

export interface TurnRequest {
  threadId: string
  cwd: string
  /** Existing native session (Claude session id / Codex thread id) to continue. */
  nativeId?: string
  model?: string
  effort?: string
  access: AccessMode
  /** Final prompt text, including any hand-off context. */
  text: string
  attachments: Attachment[]
}

export type TurnEndStatus = 'completed' | 'interrupted' | 'failed'

export type RuntimeEvent =
  | { type: 'native-id'; nativeId: string }
  | { type: 'item'; item: TimelineItem }
  | { type: 'delta'; itemId: string; field: 'text' | 'output'; delta: string }
  | {
      type: 'turn-end'
      status: TurnEndStatus
      error?: string
      costUsd?: number
      durationMs?: number
      inputTokens?: number
      outputTokens?: number
      model?: string
    }
  | { type: 'context'; usage: ContextUsage }
  | { type: 'limits'; limits: RateWindow[] }
  | { type: 'access'; access: AccessMode }
  | { type: 'model'; model: string }
  | { type: 'approval-status'; itemId: string; status: ApprovalStatus }

export type Emit = (event: RuntimeEvent) => void

/** Thrown when a stored native session can no longer be resumed. */
export class NativeSessionLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeSessionLostError'
  }
}

export interface ProviderAdapter {
  readonly id: ProviderId
  /** Detects the CLI, account, models and limits. Cheap calls are cached by the adapter. */
  status(force?: boolean): Promise<ProviderStatus>
  /** Starts a turn. Resolves once the agent accepted it; progress arrives through `emit`. */
  startTurn(req: TurnRequest, emit: Emit): Promise<void>
  interrupt(threadId: string): Promise<void>
  /** Stop pressed while the turn is still starting: abandon the start if that's possible. */
  cancelStart?(threadId: string): void
  /** Reports whether a turn is running for the thread. */
  isActive?(threadId: string): boolean
  /** Answers a pending approval. Returns false when the request is no longer pending. */
  respond(threadId: string, itemId: string, decision: ApprovalDecision): boolean
  /** Applies a new access mode to a live session, if the provider supports it mid-session. */
  setAccess?(threadId: string, access: AccessMode): Promise<void>
  commands(cwd: string): Promise<SlashCommand[]>
  /** Frees per-thread resources (processes, subscriptions). */
  release(threadId: string): void
  shutdown(): Promise<void>
}
