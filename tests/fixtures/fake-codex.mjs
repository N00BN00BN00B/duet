#!/usr/bin/env node
// Stand-in for `codex app-server` for adapter tests: starts threads and turns, winds a turn down
// shortly after `turn/interrupt`, and lets a test push any notification with `test/emit`.
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const windDownMs = Number(process.env.FAKE_CODEX_WIND_DOWN_MS ?? 50)
const active = new Map() // codex thread id -> running turn id
let threads = 0
let turns = 0

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id === undefined || typeof msg.method !== 'string') return // notifications and replies
    const reply = (result) => send({ id: msg.id, result })
    const p = msg.params ?? {}
    switch (msg.method) {
      case 'initialize':
        return reply({ userAgent: 'codex_fake/0.0.1' })
      case 'thread/start':
        return reply({ thread: { id: `thr-${++threads}` }, model: 'fake-model' })
      case 'thread/resume':
      case 'thread/unsubscribe':
        return reply({})
      case 'turn/start': {
        const id = `turn-${++turns}`
        active.set(p.threadId, id)
        reply({ turn: { id } })
        return send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } })
      }
      case 'turn/interrupt':
        reply({})
        return setTimeout(() => {
          if (active.get(p.threadId) !== p.turnId) return
          active.delete(p.threadId)
          send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted' } } })
        }, windDownMs)
      case 'test/emit':
        reply({})
        return send({ method: p.method, params: p.params })
      default:
        return send({ id: msg.id, error: { code: -32601, message: `unsupported ${msg.method}` } })
    }
  })
  .on('close', () => process.exit(0))
