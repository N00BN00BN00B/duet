import type { ApprovalDecision, ProviderId, ProviderStatus, SlashCommand, ToolItem } from '@shared/types'
import { PROVIDER_LABEL, otherProvider } from '@shared/types'
import { unifiedDiff } from '@shared/diff'
import type { Emit, ProviderAdapter, TurnRequest } from '../types'

interface Run {
  nativeId: string
  emit: Emit
  timers: NodeJS.Timeout[]
  wakers: (() => void)[]
  interrupted: boolean
  approvals: Map<string, (d: ApprovalDecision) => void>
}

/**
 * Deterministic stand-in for Claude/Codex used by end-to-end tests and the
 * `DUET_FAKE_PROVIDERS=1` demo mode. Streams text, runs tools, asks for approval.
 */
export class FakeAdapter implements ProviderAdapter {
  private runs = new Map<string, Run>()
  private counter = 0
  /** Running cost per session: Claude reports totals, not per-turn amounts. */
  private totals = new Map<string, number>()

  constructor(
    readonly id: ProviderId,
    private readonly speed = Number(process.env.DUET_FAKE_SPEED ?? '1')
  ) {}

  async status(): Promise<ProviderStatus> {
    const models =
      this.id === 'claude'
        ? [
            { id: 'fake-opus', label: 'Opus (demo)', efforts: ['low', 'medium', 'high', 'max'], isDefault: true, supportsImages: true },
            { id: 'fake-haiku', label: 'Haiku (demo)', supportsImages: true }
          ]
        : [
            { id: 'fake-gpt', label: 'GPT (demo)', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: true, supportsImages: true },
            { id: 'fake-gpt-mini', label: 'GPT mini (demo)', efforts: ['low', 'medium'], supportsImages: true }
          ]
    return {
      id: this.id,
      installed: true,
      binaryPath: `/usr/local/bin/${this.id}`,
      version: 'demo',
      loggedIn: true,
      account: 'demo@duet.local',
      plan: this.id === 'claude' ? 'Max (demo)' : 'Pro (demo)',
      models,
      defaultModel: models[0].id,
      limits: [
        { label: '5-hour', usedPercent: this.id === 'claude' ? 12 : 4, resetsAt: Date.now() + 3 * 3600_000 },
        { label: 'Weekly', usedPercent: this.id === 'claude' ? 31 : 27, resetsAt: Date.now() + 4 * 86400_000 }
      ],
      checkedAt: Date.now()
    }
  }

  private sleep(run: Run, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(1, ms / this.speed))
      run.timers.push(t)
      run.wakers.push(resolve)
    })
  }

  async startTurn(req: TurnRequest, emit: Emit): Promise<void> {
    if (this.runs.has(req.threadId)) throw new Error(`${PROVIDER_LABEL[this.id]} is still working on the previous message.`)
    const nativeId = req.nativeId ?? `${this.id}-demo-${req.threadId.slice(0, 8)}`
    const run: Run = { nativeId, emit, timers: [], wakers: [], interrupted: false, approvals: new Map() }
    this.runs.set(req.threadId, run)
    emit({ type: 'native-id', nativeId })
    void this.script(req, run).finally(() => {
      for (const t of run.timers) clearTimeout(t)
      this.runs.delete(req.threadId)
    })
  }

  private async script(req: TurnRequest, run: Run): Promise<void> {
    const emit = run.emit
    const p = this.id === 'claude' ? 'c' : 'x'
    const turn = `${p}-demo-${++this.counter}-${Date.now()}`
    const started = Date.now()
    const handoffMatch = req.text.match(/<duet_handoff>[\s\S]*?<\/duet_handoff>\s*/)
    const userText = (handoffMatch ? req.text.slice(handoffMatch.index! + handoffMatch[0].length) : req.text).replace(/^The user's new message:\s*/, '').trim()
    const priorMessages = handoffMatch ? (handoffMatch[0].match(/^### /gm) ?? []).length : 0

    emit({ type: 'item', item: { kind: 'reasoning', id: `${turn}-think`, ts: Date.now(), provider: this.id, text: 'Reading the request and planning a short answer.', streaming: true } })
    await this.sleep(run, 250)
    if (run.interrupted) return
    emit({ type: 'item', item: { kind: 'reasoning', id: `${turn}-think`, ts: Date.now(), provider: this.id, text: 'Reading the request and planning a short answer.', streaming: false } })

    const lines: string[] = []
    if (handoffMatch) lines.push(`Picking up from ${PROVIDER_LABEL[otherProvider(this.id)]} — I can see the earlier conversation (${priorMessages} entries).`)
    lines.push(`**${PROVIDER_LABEL[this.id]}** here (${req.model ?? 'default model'}). You said: “${userText.slice(0, 200)}”.`)
    if (req.attachments.length) lines.push(`I received ${req.attachments.length} attachment${req.attachments.length === 1 ? '' : 's'}: ${req.attachments.map((a) => a.name).join(', ')}.`)
    lines.push('Here is a code sample:\n\n```ts\nexport function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n```')
    // A picture from the web (port 9 refuses connections, so nothing is ever fetched for real).
    if (/\bdiagram\b/i.test(userText)) lines.push('![Architecture diagram](https://127.0.0.1:9/diagram.png)')
    const answer = lines.join('\n\n')
    const answerId = `${turn}-answer`
    const words = answer.split(/(?<=\s)/)
    emit({ type: 'item', item: { kind: 'assistant', id: answerId, ts: Date.now(), provider: this.id, model: req.model, text: words[0], streaming: true } })
    for (const word of words.slice(1)) {
      await this.sleep(run, 12)
      if (run.interrupted) return
      emit({ type: 'delta', itemId: answerId, field: 'text', delta: word })
    }
    emit({ type: 'item', item: { kind: 'assistant', id: answerId, ts: Date.now(), provider: this.id, model: req.model, text: answer, streaming: false } })

    if (/\b(run|test|command)\b/i.test(userText)) {
      const tool: ToolItem = { kind: 'tool', id: `${turn}-cmd`, ts: Date.now(), provider: this.id, tool: 'command', name: 'Bash', title: 'npm test', detail: 'Run the test suite', status: 'running' }
      emit({ type: 'item', item: tool })
      if (req.access === 'ask' || req.access === 'plan') {
        const approvalId = `${turn}-approval`
        emit({ type: 'item', item: { kind: 'approval', id: approvalId, ts: Date.now(), provider: this.id, request: 'command', title: 'Run this command?', command: 'npm test', cwd: req.cwd, status: 'pending', canAllowForSession: true } })
        const decision = await new Promise<ApprovalDecision>((resolve) => {
          run.approvals.set(approvalId, resolve)
          run.wakers.push(() => resolve({ kind: 'deny' }))
        })
        if (run.interrupted) return
        if (decision.kind === 'deny') {
          emit({ type: 'item', item: { ...tool, status: 'declined' } })
          emit({ type: 'item', item: { kind: 'assistant', id: `${turn}-declined`, ts: Date.now(), provider: this.id, text: 'Okay, I won’t run the tests.' } })
          emit({ type: 'turn-end', status: 'completed', durationMs: Date.now() - started, costUsd: this.charge(run, 0.001), model: req.model })
          return
        }
      }
      const output = ['> duet@1.0.0 test', '> vitest run', '', ' ✓ tests/unit/diff.test.ts (12 tests)', ' ✓ tests/unit/handoff.test.ts (8 tests)', '', ' Test Files  2 passed (2)', '      Tests  20 passed (20)']
      emit({ type: 'item', item: { ...tool, output: '' } })
      for (const line of output) {
        await this.sleep(run, 40)
        if (run.interrupted) return
        emit({ type: 'delta', itemId: tool.id, field: 'output', delta: line + '\n' })
      }
      emit({ type: 'item', item: { ...tool, output: output.join('\n') + '\n', status: 'done', exitCode: 0, durationMs: 420 } })
    }

    if (/\b(edit|change|fix)\b/i.test(userText)) {
      const diff = unifiedDiff('export const answer = 41\nexport const name = "duet"\n', 'export const answer = 42\nexport const name = "duet"\n', 'src/answer.ts')
      emit({ type: 'item', item: { kind: 'tool', id: `${turn}-edit`, ts: Date.now(), provider: this.id, tool: 'edit', name: 'Edit', title: 'src/answer.ts', diff, status: 'done', durationMs: 30 } })
    }

    if (/\bplan\b/i.test(userText)) {
      emit({
        type: 'item',
        item: {
          kind: 'tool',
          id: `${turn}-plan`,
          ts: Date.now(),
          provider: this.id,
          tool: 'todo',
          name: 'TodoWrite',
          title: 'Updated plan',
          status: 'done',
          steps: [
            { text: 'Read the codebase', status: 'done' },
            { text: 'Write the feature', status: 'active' },
            { text: 'Add tests', status: 'pending' }
          ]
        }
      })
    }

    if (/\bcrash\b/i.test(userText)) {
      await this.sleep(run, 4500)
      if (run.interrupted) return
      emit({ type: 'turn-end', status: 'failed', error: 'The demo agent crashed on purpose.', durationMs: Date.now() - started, model: req.model })
      return
    }

    await this.sleep(run, 60)
    if (run.interrupted) return
    emit({ type: 'context', usage: { usedTokens: 18_000 + this.counter * 1200, windowTokens: 200_000 } })
    emit({ type: 'turn-end', status: 'completed', durationMs: Date.now() - started, costUsd: this.charge(run, 0.0123), inputTokens: 1800, outputTokens: 240, model: req.model })
  }

  /** Mirrors the real agents: Claude reports the session's running total, Codex reports nothing. */
  private charge(run: Run, amount: number): number | undefined {
    if (this.id !== 'claude') return undefined
    const total = (this.totals.get(run.nativeId) ?? 0) + amount
    this.totals.set(run.nativeId, total)
    return total
  }

  async interrupt(threadId: string): Promise<void> {
    const run = this.runs.get(threadId)
    if (!run) return
    run.interrupted = true
    for (const t of run.timers) clearTimeout(t)
    for (const wake of run.wakers) wake()
    run.emit({ type: 'turn-end', status: 'interrupted' })
  }

  respond(threadId: string, itemId: string, decision: ApprovalDecision): boolean {
    const run = this.runs.get(threadId)
    const resolve = run?.approvals.get(itemId)
    if (!run || !resolve) return false
    run.approvals.delete(itemId)
    resolve(decision)
    return true
  }

  async commands(): Promise<SlashCommand[]> {
    return [
      { name: 'review', description: 'Review the current changes' },
      { name: 'compact', description: 'Summarize the conversation' },
      { name: 'init', description: 'Create an instructions file for this project' }
    ]
  }

  isActive(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  release(threadId: string): void {
    void this.interrupt(threadId)
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.runs.keys()]) await this.interrupt(id)
  }
}
