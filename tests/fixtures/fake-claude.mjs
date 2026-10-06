#!/usr/bin/env node
// Stand-in for `claude` that speaks just enough of the stream-json control protocol for adapter
// tests: answers control requests, runs a turn per user message, and winds a turn down a little
// while after an interrupt (like the real CLI does).
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// Records each run's arguments (plus the thinking budget it was given, if any) for tests to inspect.
const thinking = process.env.MAX_THINKING_TOKENS === undefined ? [] : [`env:MAX_THINKING_TOKENS=${process.env.MAX_THINKING_TOKENS}`]
if (process.env.FAKE_CLAUDE_ARGS_FILE) appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify([...process.argv.slice(2), ...thinking]) + '\n')

if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_IN === '1'
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' }))
  process.exit(loggedIn ? 0 : 1)
}

// One-shot: `claude -p --output-format json`, prompt on stdin.
if (process.argv.includes('-p') && !process.argv.includes('stream-json')) {
  let prompt = ''
  process.stdin.on('data', (c) => (prompt += c))
  process.stdin.on('end', () => {
    const answer = process.env.FAKE_CLAUDE_ANSWER ?? `echo: ${prompt.slice(0, 40)}`
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: 0.001 }))
    process.exit(0)
  })
} else {

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const arg = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const sessionId = arg('--session-id') ?? arg('--resume') ?? 'fake-session'
const windDownMs = Number(process.env.FAKE_CLAUDE_WIND_DOWN_MS ?? 50)
const initDelayMs = Number(process.env.FAKE_CLAUDE_INIT_DELAY_MS ?? 0)
let total = 0
let turn = null

function finish() {
  if (!turn) return
  clearTimeout(turn)
  turn = null
  total += 0.01
  send({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: total, duration_ms: 5, usage: { output_tokens: 1 }, session_id: sessionId })
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type === 'control_request') {
      const subtype = msg.request?.subtype
      const answer = () => send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: subtype === 'initialize' ? { commands: [], models: [], account: {} } : {} } })
      if (subtype === 'initialize' && initDelayMs) setTimeout(answer, initDelayMs)
      else answer()
      if (subtype === 'interrupt' && turn) {
        const interrupted = turn
        setTimeout(() => turn === interrupted && finish(), windDownMs)
      }
      return
    }
    if (msg.type === 'user') {
      send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', mcp_servers: [] })
      turn = setTimeout(finish, Number(process.env.FAKE_CLAUDE_TURN_MS ?? 60_000))
    }
  })
  .on('close', () => process.exit(0))
}
