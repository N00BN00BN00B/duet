import { homedir } from 'node:os'
import type { ApprovalItem, PlanStep, Question, ToolKind } from '@shared/types'
import { displayPath, firstLine, truncate } from '@shared/paths'
import { unifiedDiff } from '@shared/diff'

type Input = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export interface ToolDescription {
  tool: ToolKind
  title: string
  detail?: string
  steps?: PlanStep[]
  diff?: string
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const idx = rest.indexOf('__')
  if (idx < 0) return { server: rest, tool: rest }
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) }
}

export function todoSteps(todos: unknown): PlanStep[] {
  if (!Array.isArray(todos)) return []
  return todos.map((t) => {
    const todo = (t ?? {}) as Input
    const status = str(todo.status)
    return {
      text: str(todo.content) || str(todo.activeForm),
      status: status === 'completed' ? 'done' : status === 'in_progress' ? 'active' : 'pending'
    }
  })
}

export function describeClaudeTool(name: string, rawInput: unknown, cwd: string): ToolDescription {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Input
  const home = homedir()
  const path = (key: string) => displayPath(str(input[key]), cwd, home)
  switch (name) {
    case 'Bash':
      return { tool: 'command', title: truncate(firstLine(str(input.command)), 160) || 'Shell command', detail: str(input.description) || undefined }
    case 'BashOutput':
      return { tool: 'command', title: 'Read background output', detail: str(input.bash_id) || undefined }
    case 'KillShell':
    case 'KillBash':
      return { tool: 'command', title: 'Stop background command', detail: str(input.shell_id) || undefined }
    case 'Read':
      return { tool: 'read', title: path('file_path') || 'file' }
    case 'Edit': {
      const p = path('file_path')
      return { tool: 'edit', title: p || 'file', diff: unifiedDiff(str(input.old_string), str(input.new_string), p || 'file') }
    }
    case 'MultiEdit': {
      const p = path('file_path')
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : []
      const diff = edits.map((e) => unifiedDiff(str(e.old_string), str(e.new_string), p || 'file')).join('')
      return { tool: 'edit', title: p || 'file', detail: `${edits.length} edits`, diff }
    }
    case 'Write': {
      const p = path('file_path')
      return { tool: 'write', title: p || 'file', diff: unifiedDiff('', str(input.content), p || 'file') }
    }
    case 'NotebookEdit':
      return { tool: 'edit', title: path('notebook_path') || 'notebook' }
    case 'Glob':
      return { tool: 'search', title: str(input.pattern) || 'files', detail: input.path ? path('path') : undefined }
    case 'Grep':
      return { tool: 'search', title: str(input.pattern) || 'search', detail: [input.path ? path('path') : '', str(input.glob)].filter(Boolean).join(' · ') || undefined }
    case 'LS':
      return { tool: 'read', title: path('path') || '.', detail: 'List directory' }
    case 'WebFetch':
      return { tool: 'web', title: str(input.url) || 'web page', detail: truncate(str(input.prompt), 120) || undefined }
    case 'WebSearch':
      return { tool: 'web', title: str(input.query) || 'web search' }
    case 'Task':
    case 'Agent':
      return { tool: 'agent', title: str(input.description) || 'Subagent', detail: str(input.subagent_type) || undefined }
    case 'TodoWrite':
      return { tool: 'todo', title: 'Updated plan', steps: todoSteps(input.todos) }
    case 'Skill':
      return { tool: 'skill', title: str(input.skill) || str(input.command) || 'Skill' }
    case 'SlashCommand':
      return { tool: 'skill', title: str(input.command) || 'Command' }
    case 'ExitPlanMode':
      return { tool: 'todo', title: 'Proposed plan', detail: truncate(firstLine(str(input.plan)), 120) || undefined }
    case 'AskUserQuestion':
      return { tool: 'other', title: 'Asked a question' }
    case 'ListMcpResourcesTool':
      return { tool: 'mcp', title: 'List MCP resources', detail: str(input.server) || undefined }
    case 'ReadMcpResourceTool':
      return { tool: 'mcp', title: str(input.uri) || 'Read MCP resource', detail: str(input.server) || undefined }
    default: {
      const mcp = parseMcpToolName(name)
      if (mcp) return { tool: 'mcp', title: mcp.tool, detail: mcp.server }
      return { tool: 'other', title: name }
    }
  }
}

export function parseQuestions(input: unknown): Question[] {
  const list = (input as Input | undefined)?.questions
  if (!Array.isArray(list)) return []
  return list.map((q, i) => {
    const item = (q ?? {}) as Input
    const options = Array.isArray(item.options) ? (item.options as Input[]) : []
    return {
      id: str(item.question) || `q${i}`,
      header: str(item.header) || undefined,
      question: str(item.question),
      options: options.map((o) => ({ label: str(o.label), description: str(o.description) || undefined })),
      multiSelect: item.multiSelect === true,
      allowOther: true
    }
  })
}

export type ApprovalShape = Pick<ApprovalItem, 'request' | 'title' | 'detail' | 'command' | 'cwd' | 'diff' | 'plan' | 'questions' | 'canAllowForSession'>

export function describeClaudeApproval(
  toolName: string,
  rawInput: unknown,
  cwd: string,
  extra: { title?: string; description?: string; displayName?: string; hasSuggestions: boolean; decisionReason?: string; blockedPath?: string }
): ApprovalShape {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Input
  const desc = describeClaudeTool(toolName, input, cwd)
  const reason = extra.decisionReason || extra.description || undefined
  if (toolName === 'Bash') {
    return {
      request: 'command',
      title: extra.title || 'Run this command?',
      command: str(input.command),
      cwd,
      detail: str(input.description) || reason,
      canAllowForSession: extra.hasSuggestions
    }
  }
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    return {
      request: 'edit',
      title: extra.title || `${toolName === 'Write' ? 'Write' : 'Edit'} ${desc.title}?`,
      diff: desc.diff,
      detail: reason,
      canAllowForSession: extra.hasSuggestions
    }
  }
  if (toolName === 'ExitPlanMode') {
    return { request: 'plan', title: 'Ready to start building?', plan: str(input.plan), canAllowForSession: true }
  }
  if (toolName === 'AskUserQuestion') {
    return { request: 'question', title: 'Claude has a question', questions: parseQuestions(input), canAllowForSession: false }
  }
  const mcp = parseMcpToolName(toolName)
  const label = extra.displayName || (mcp ? `${mcp.server} › ${mcp.tool}` : toolName)
  let summary = ''
  try {
    summary = JSON.stringify(input, null, 2)
  } catch {
    summary = ''
  }
  return {
    request: 'tool',
    title: extra.title || `Allow ${label}?`,
    detail: [reason, extra.blockedPath ? `Path: ${extra.blockedPath}` : '', summary && summary !== '{}' ? truncate(summary, 1500) : ''].filter(Boolean).join('\n\n') || undefined,
    canAllowForSession: extra.hasSuggestions
  }
}
