import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '../../src/shared/types'
import { ClaudeMapper, claudeRateWindows } from '../../src/main/providers/claude/mapper'
import { describeClaudeApproval, describeClaudeTool, parseMcpToolName, parseQuestions, todoSteps } from '../../src/main/providers/claude/describe'
import { claudePermissionMode, friendlyClaudeError, usageToLimits } from '../../src/main/providers/claude/adapter'
import type { RuntimeEvent } from '../../src/main/providers/types'

function run(messages: unknown[]) {
  const events: RuntimeEvent[] = []
  const items = new Map<string, TimelineItem>()
  let t = 1000
  const mapper = new ClaudeMapper({
    cwd: '/repo',
    now: () => (t += 10),
    emit: (e) => {
      events.push(e)
      if (e.type === 'item') items.set(e.item.id, e.item)
      if (e.type === 'delta') {
        const it = items.get(e.itemId)
        if (it && (it.kind === 'assistant' || it.kind === 'reasoning')) items.set(it.id, { ...it, text: it.text + e.delta })
        if (it && it.kind === 'tool') items.set(it.id, { ...it, output: (it.output ?? '') + e.delta })
      }
    }
  })
  mapper.beginTurn()
  for (const m of messages) mapper.handle(m)
  return { events, items, mapper }
}

const stream = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 's' })

describe('ClaudeMapper', () => {
  it('streams text deltas, then settles on the final snapshot', () => {
    const { events, items } = run([
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-haiku-4-5', mcp_servers: [{ name: 'rogold', status: 'connected' }] },
      stream({ type: 'message_start', message: { id: 'msg_1', model: 'claude-haiku-4-5' } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } }),
      stream({ type: 'content_block_stop', index: 0 }),
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo **world**' } }),
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-haiku-4-5', content: [{ type: 'thinking', thinking: '', signature: 'x' }], usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 3 } }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Hello **world**' }] }, parent_tool_use_id: null },
      stream({ type: 'content_block_stop', index: 1 }),
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello **world**', total_cost_usd: 0.07, duration_ms: 1234, usage: { input_tokens: 10, output_tokens: 50 }, modelUsage: { 'claude-haiku-4-5': { contextWindow: 200000 } } }
    ])
    expect(events[0]).toEqual({ type: 'native-id', nativeId: 'sess-1' })
    const texts = [...items.values()].filter((i) => i.kind === 'assistant')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ id: 'c-msg_1-1', text: 'Hello **world**', streaming: false })
    // Empty thinking blocks never create an item.
    expect([...items.values()].some((i) => i.kind === 'reasoning')).toBe(false)
    expect(events.some((e) => e.type === 'delta' && e.delta === 'lo **world**')).toBe(true)
    const ctx = events.find((e) => e.type === 'context')
    expect(ctx).toMatchObject({ type: 'context', usage: { usedTokens: 113 } })
    const end = events.at(-1)
    expect(end).toMatchObject({ type: 'turn-end', status: 'completed', costUsd: 0.07, durationMs: 1234, outputTokens: 50 })
  })

  it('tracks tool calls from start to result with diffs and outputs', () => {
    const { items } = run([
      stream({ type: 'message_start', message: { id: 'msg_2' } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm te' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'st","description":"Run tests"}' } }),
      stream({ type: 'content_block_stop', index: 0 }),
      { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] }, parent_tool_use_id: null },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'raw', is_error: false }] }, tool_use_result: { stdout: '2 passed', stderr: '' }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'msg_3', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' } }] }, parent_tool_use_id: null },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'updated' }] },
        tool_use_result: { filePath: '/repo/src/a.ts', structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-const a = 1', '+const a = 2'] }] },
        parent_tool_use_id: null
      },
      { type: 'assistant', message: { id: 'msg_4', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Read', input: { file_path: '/repo/missing.ts' } }] }, parent_tool_use_id: null },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'File does not exist', is_error: true }] }, parent_tool_use_id: null }
    ])
    const bash = items.get('c-tool-toolu_1')!
    expect(bash).toMatchObject({ kind: 'tool', tool: 'command', title: 'npm test', detail: 'Run tests', status: 'done', output: '2 passed' })
    const edit = items.get('c-tool-toolu_2')!
    expect(edit).toMatchObject({ tool: 'edit', title: 'src/a.ts', status: 'done' })
    expect(edit.kind === 'tool' && edit.diff).toBe('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,1 +3,1 @@\n-const a = 1\n+const a = 2\n')
    expect(items.get('c-tool-toolu_3')).toMatchObject({ tool: 'read', status: 'error', output: 'File does not exist' })
  })

  it('marks declined tools and interrupted turns', () => {
    const events: RuntimeEvent[] = []
    const mapper = new ClaudeMapper({ cwd: '/repo', emit: (e) => events.push(e) })
    mapper.beginTurn()
    mapper.handle({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/repo/x', content: 'hi' } }] }, parent_tool_use_id: null })
    mapper.markDeclined('t1')
    mapper.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'denied', is_error: true }] }, parent_tool_use_id: null })
    mapper.markInterrupted()
    mapper.handle({ type: 'result', subtype: 'error_during_execution', is_error: true })
    const tool = events.filter((e) => e.type === 'item').map((e) => (e as { item: TimelineItem }).item).filter((i) => i.id === 'c-tool-t1').at(-1)
    expect(tool).toMatchObject({ status: 'declined' })
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', status: 'interrupted' })
  })

  it('reports failures with the result text', () => {
    const { events } = run([{ type: 'result', subtype: 'error_max_turns', is_error: true }])
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', status: 'failed', error: 'Claude hit the maximum number of turns.' })
  })

  it('counts subagent tool calls on the parent Task item', () => {
    const { items } = run([
      { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'Explore repo', subagent_type: 'Explore' } }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 's1', content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: {} }, { type: 'tool_use', id: 'x2', name: 'Grep', input: {} }] }, parent_tool_use_id: 'task1' }
    ])
    expect(items.get('c-tool-task1')).toMatchObject({ tool: 'agent', title: 'Explore repo', detail: 'Explore · 2 tool calls' })
  })

  it('reads rate limit windows and notices', () => {
    const limits = claudeRateWindows({ unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 100 }, seven_day: { utilization: 0.31 } } })
    expect(limits).toEqual([
      { label: '5-hour', usedPercent: 8, resetsAt: 100_000 },
      { label: 'Weekly', usedPercent: 31, resetsAt: undefined }
    ])
    const { events } = run([{ type: 'system', subtype: 'compact_boundary', uuid: 'u', compact_metadata: { pre_tokens: 150_000 } }])
    expect(events[0]).toMatchObject({ type: 'item', item: { kind: 'notice', text: 'Context compacted (150k tokens summarized)' } })
    expect(usageToLimits({ rate_limits: { five_hour: { utilization: 12, resets_at: '2026-10-06T20:00:00Z' }, seven_day: null } })).toEqual([{ label: '5-hour', usedPercent: 12, resetsAt: Date.parse('2026-10-06T20:00:00Z') }])
  })
})

describe('Claude tool descriptions', () => {
  it('describes common tools', () => {
    expect(describeClaudeTool('Grep', { pattern: 'TODO', path: '/repo/src', glob: '*.ts' }, '/repo')).toMatchObject({ tool: 'search', title: 'TODO', detail: 'src · *.ts' })
    expect(describeClaudeTool('WebFetch', { url: 'https://x.dev', prompt: 'summarize' }, '/repo')).toMatchObject({ tool: 'web', title: 'https://x.dev' })
    expect(describeClaudeTool('mcp__github__create_issue', {}, '/repo')).toMatchObject({ tool: 'mcp', title: 'create_issue', detail: 'github' })
    expect(describeClaudeTool('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] }, '/repo').steps).toEqual([
      { text: 'a', status: 'done' },
      { text: 'b', status: 'active' },
      { text: 'c', status: 'pending' }
    ])
    expect(describeClaudeTool('MultiEdit', { file_path: '/repo/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }, '/repo').diff?.match(/^@@/gm)).toHaveLength(2)
    expect(parseMcpToolName('mcp__a__b__c')).toEqual({ server: 'a', tool: 'b__c' })
    expect(todoSteps(null)).toEqual([])
  })

  it('describes approvals', () => {
    expect(describeClaudeApproval('Bash', { command: 'rm -rf build', description: 'Clean' }, '/repo', { hasSuggestions: true })).toMatchObject({ request: 'command', command: 'rm -rf build', detail: 'Clean', canAllowForSession: true })
    expect(describeClaudeApproval('ExitPlanMode', { plan: '1. Do it' }, '/repo', { hasSuggestions: false })).toMatchObject({ request: 'plan', plan: '1. Do it' })
    const q = describeClaudeApproval('AskUserQuestion', { questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: 'SQL' }, { label: 'Mongo', description: 'Docs' }], multiSelect: false }] }, '/repo', { hasSuggestions: false })
    expect(q.questions).toEqual(parseQuestions({ questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: 'SQL' }, { label: 'Mongo', description: 'Docs' }], multiSelect: false }] }))
    expect(q.questions?.[0]).toMatchObject({ id: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'Mongo' }] })
    const tool = describeClaudeApproval('mcp__figma__get_file', { id: 1 }, '/repo', { hasSuggestions: false, decisionReason: 'MCP tool' })
    expect(tool).toMatchObject({ request: 'tool', title: 'Allow figma › get_file?' })
    expect(tool.detail).toContain('"id": 1')
  })

  it('maps access modes and friendly errors', () => {
    expect(claudePermissionMode('plan')).toBe('plan')
    expect(claudePermissionMode('ask')).toBe('default')
    expect(claudePermissionMode('auto')).toBe('acceptEdits')
    expect(claudePermissionMode('full')).toBe('bypassPermissions')
    expect(friendlyClaudeError('x', 'Invalid API key · Please run /login')).toContain('not signed in')
  })
})
