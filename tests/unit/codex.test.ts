import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '../../src/shared/types'
import { CodexThreadMapper, codexItemToTimeline, codexRateWindows, mapStatus, planSteps, unwrapShell } from '../../src/main/providers/codex/mapper'
import { codexPolicy, friendlyCodexError } from '../../src/main/providers/codex/adapter'
import type { RuntimeEvent } from '../../src/main/providers/types'

const ctx = { cwd: '/repo', home: '/Users/me', now: () => 5000 }

function mapper() {
  const events: RuntimeEvent[] = []
  const items = new Map<string, TimelineItem>()
  const m = new CodexThreadMapper(ctx, (e) => {
    events.push(e)
    if (e.type === 'item') items.set(e.item.id, e.item)
    if (e.type === 'delta') {
      const it = items.get(e.itemId)
      if (it && (it.kind === 'assistant' || it.kind === 'reasoning')) items.set(it.id, { ...it, text: it.text + e.delta })
      if (it && it.kind === 'tool') items.set(it.id, { ...it, output: (it.output ?? '') + e.delta })
    }
  })
  return { m, events, items }
}

describe('Codex item mapping', () => {
  it('unwraps shell wrappers', () => {
    expect(unwrapShell('/bin/zsh -lc "npm test"')).toBe('npm test')
    expect(unwrapShell("bash -lc 'ls -la'")).toBe('ls -la')
    expect(unwrapShell('/bin/zsh -lc "echo \\"hi\\""')).toBe('echo "hi"')
    expect(unwrapShell(['git', 'status'])).toBe('git status')
    expect(unwrapShell('cargo build')).toBe('cargo build')
  })

  it('maps statuses and plans', () => {
    expect(mapStatus('inProgress')).toBe('running')
    expect(mapStatus('declined')).toBe('declined')
    expect(planSteps([{ step: 'a', status: 'completed' }, { step: 'b', status: 'inProgress' }, { step: 'c', status: 'pending' }])).toEqual([
      { text: 'a', status: 'done' },
      { text: 'b', status: 'active' },
      { text: 'c', status: 'pending' }
    ])
  })

  it('maps command executions, using command actions for reads and searches', () => {
    const read = codexItemToTimeline({ type: 'commandExecution', id: 'c1', command: '/bin/zsh -lc "cat src/a.ts"', cwd: '/repo', status: 'completed', commandActions: [{ type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: '/repo/src/a.ts' }], aggregatedOutput: 'x', exitCode: 0, durationMs: 12 }, ctx)
    expect(read).toMatchObject({ kind: 'tool', tool: 'read', title: 'src/a.ts', status: 'done' })
    const failed = codexItemToTimeline({ type: 'commandExecution', id: 'c2', command: 'npm test', status: 'completed', commandActions: [], exitCode: 1 }, ctx)
    expect(failed).toMatchObject({ tool: 'command', title: 'npm test', status: 'error', exitCode: 1 })
    const search = codexItemToTimeline({ type: 'commandExecution', id: 'c3', command: 'rg foo', status: 'completed', commandActions: [{ type: 'search', command: 'rg foo', query: 'foo', path: '/repo/src' }] }, ctx)
    expect(search).toMatchObject({ tool: 'search', title: 'foo', detail: 'src' })
  })

  it('maps file changes into unified diffs', () => {
    const item = codexItemToTimeline(
      {
        type: 'fileChange',
        id: 'f1',
        status: 'completed',
        changes: [
          { path: '/repo/new.txt', kind: { type: 'add' }, diff: 'hello\n' },
          { path: '/repo/src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }
        ]
      },
      ctx
    )
    expect(item).toMatchObject({ kind: 'tool', tool: 'edit', title: 'new.txt, src/a.ts', status: 'done' })
    const diff = item && item.kind === 'tool' ? item.diff! : ''
    expect(diff).toContain('--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello')
    expect(diff).toContain('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b')
    const only = codexItemToTimeline({ type: 'fileChange', id: 'f2', status: 'inProgress', changes: [{ path: '/repo/x', kind: { type: 'add' }, diff: '' }] }, ctx)
    expect(only).toMatchObject({ tool: 'write', status: 'running' })
  })

  it('maps MCP calls, images, user messages and notices', () => {
    expect(codexItemToTimeline({ type: 'mcpToolCall', id: 'm1', server: 'figma', tool: 'get_file', arguments: { id: 1 }, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }, { type: 'image' }] } }, ctx)).toMatchObject({ tool: 'mcp', title: 'get_file', detail: 'figma', output: 'ok\n[image]', status: 'done' })
    expect(codexItemToTimeline({ type: 'mcpToolCall', id: 'm2', server: 's', tool: 't', status: 'failed', error: { message: 'boom' } }, ctx)).toMatchObject({ status: 'error', output: 'boom' })
    expect(codexItemToTimeline({ type: 'imageGeneration', id: 'g', status: 'completed', result: '', revisedPrompt: 'a cat', savedPath: '/tmp/cat.png' }, ctx)).toMatchObject({ tool: 'image', images: ['/tmp/cat.png'], detail: 'a cat' })
    expect(codexItemToTimeline({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'hi' }, { type: 'localImage', path: '/tmp/a.png' }] }, ctx)).toMatchObject({ kind: 'user', text: 'hi', attachments: [{ path: '/tmp/a.png' }] })
    expect(codexItemToTimeline({ type: 'contextCompaction', id: 'cc' }, ctx)).toMatchObject({ kind: 'notice', text: 'Context compacted' })
    expect(codexItemToTimeline({ type: 'reasoning', id: 'r', summary: [], content: [] }, ctx)).toBeNull()
    expect(codexItemToTimeline({ type: 'sleep', id: 's' }, ctx)).toBeNull()
  })

  it('reads rate limit windows', () => {
    expect(codexRateWindows({ primary: { usedPercent: 27.4, windowDurationMins: 10080, resetsAt: 10 }, secondary: { usedPercent: 3, windowDurationMins: 300, resetsAt: null } })).toEqual([
      { label: 'Weekly', usedPercent: 27, resetsAt: 10_000 },
      { label: '5-hour', usedPercent: 3, resetsAt: undefined }
    ])
    expect(codexRateWindows(null)).toEqual([])
  })
})

describe('CodexThreadMapper streaming', () => {
  it('streams agent text and reasoning summaries, then completes', () => {
    const { m, items, events } = mapper()
    m.itemStarted({ type: 'reasoning', id: 'r1', summary: [], content: [] })
    m.reasoningSummaryDelta('r1', 'Looking at')
    m.reasoningSummaryDelta('r1', ' the code')
    m.reasoningSummaryPart('r1')
    m.reasoningSummaryDelta('r1', 'Second part')
    m.reasoningRawDelta('r1', 'raw text that should be ignored')
    m.itemCompleted({ type: 'reasoning', id: 'r1', summary: ['Looking at the code', 'Second part'], content: [] })
    m.itemStarted({ type: 'agentMessage', id: 'a1', text: '' })
    expect(items.has('x-a1')).toBe(false)
    m.textDelta('a1', 'Hi', 'assistant')
    m.textDelta('a1', ' there', 'assistant')
    m.itemCompleted({ type: 'agentMessage', id: 'a1', text: 'Hi there' })
    expect(items.get('x-r1')).toMatchObject({ kind: 'reasoning', text: 'Looking at the code\n\nSecond part', streaming: false })
    expect(items.get('x-a1')).toMatchObject({ kind: 'assistant', text: 'Hi there', streaming: false })
    // ' the code', the paragraph break, 'Second part' and ' there' stream as deltas.
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(4)
  })

  it('streams command output and keeps it when the completed item has none', () => {
    const { m, items } = mapper()
    m.itemStarted({ type: 'commandExecution', id: 'c1', command: 'npm test', status: 'inProgress', commandActions: [] })
    expect(items.get('x-c1')).toMatchObject({ status: 'running' })
    m.outputDelta('c1', 'line 1\n')
    m.outputDelta('c1', 'line 2\n')
    m.itemCompleted({ type: 'commandExecution', id: 'c1', command: 'npm test', status: 'completed', commandActions: [], exitCode: 0, aggregatedOutput: null })
    expect(items.get('x-c1')).toMatchObject({ status: 'done', output: 'line 1\nline 2\n' })
  })

  it('tracks plan updates and finishes them with the turn', () => {
    const { m, items } = mapper()
    m.plan('t1', 'Doing it', [{ step: 'one', status: 'inProgress' }])
    expect(items.get('x-plan-t1')).toMatchObject({ tool: 'todo', status: 'running', detail: 'Doing it' })
    m.finishTurn('t1')
    expect(items.get('x-plan-t1')).toMatchObject({ status: 'done' })
  })
})

describe('Codex policies', () => {
  it('maps Duet access modes to sandbox + approval settings', () => {
    expect(codexPolicy('plan')).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } })
    expect(codexPolicy('ask')).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'workspace-write' })
    expect(codexPolicy('auto')).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } })
    expect(codexPolicy('full')).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } })
    expect(friendlyCodexError('401 Unauthorized', '')).toContain('codex login')
  })
})
