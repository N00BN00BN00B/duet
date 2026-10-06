#!/usr/bin/env node
// Stand-in for `codex app-server` for adapter tests: starts threads and turns, winds a turn down
// shortly after `turn/interrupt`, and lets a test push any notification with `test/emit`.
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const windDownMs = Number(process.env.FAKE_CODEX_WIND_DOWN_MS ?? 50)
const active = new Map() // codex thread id -> running turn id
const outer = new Map() // a review's inner turn id -> the turn id review/start returned
const reviewMs = Number(process.env.FAKE_CODEX_REVIEW_MS ?? 10)
const ephemeral = new Set()
const received = []
let threads = 0
let turns = 0
const later = (fn) => setTimeout(fn, 10)

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
    if (!msg.method.startsWith('test/')) received.push({ method: msg.method, params: p })
    switch (msg.method) {
      case 'initialize':
        return reply({ userAgent: 'codex_fake/0.0.1' })
      case 'thread/start': {
        const id = `thr-${++threads}`
        if (p.ephemeral) ephemeral.add(id)
        return reply({ thread: { id }, model: 'fake-model' })
      }
      case 'review/start': {
        // Like the real server: the review runs as an inner turn (the one turn/interrupt accepts),
        // but its items and its completion carry the id review/start returned.
        const id = `turn-${++turns}`
        const inner = `${id}-review`
        active.set(p.threadId, inner)
        outer.set(inner, id)
        reply({ turn: { id }, reviewThreadId: p.threadId })
        send({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { type: 'enteredReviewMode', id: 'rev-0', review: 'current changes' } } })
        send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: inner } } })
        return setTimeout(() => {
          if (active.get(p.threadId) !== inner) return
          send({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { type: 'exitedReviewMode', id: 'rev-1', review: 'No issues found in the diff.' } } })
          active.delete(p.threadId)
          send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed' } } })
        }, reviewMs)
      }
      case 'thread/compact/start': {
        const id = `turn-${++turns}`
        reply({})
        send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } })
        return later(() => {
          send({ method: 'item/completed', params: { threadId: p.threadId, item: { type: 'contextCompaction', id: 'cmp-1' } } })
          send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed' } } })
        })
      }
      case 'skills/list':
        return reply({
          data: [
            {
              cwd: (p.cwds ?? [])[0] ?? '/',
              skills: [
                { name: 'deploy', description: 'Ship the app', shortDescription: 'Ship it', path: '/skills/deploy/SKILL.md', scope: 'user', enabled: true },
                { name: 'disabled-one', description: 'Off', path: '/skills/off/SKILL.md', scope: 'user', enabled: false }
              ],
              errors: []
            }
          ]
        })
      case 'account/login/start':
        return reply({ type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example.test/login' })
      case 'account/read':
        return reply({ account: { type: 'chatgpt', email: 'dev@example.test', planType: 'pro' }, requiresOpenaiAuth: true })
      case 'account/usage/read':
        return reply({ summary: { lifetimeTokens: 123456, peakDailyTokens: 999, currentStreakDays: 3, longestStreakDays: 9 }, dailyUsageBuckets: [{ startDate: '2026-10-05', tokens: 500 }] })
      case 'test/requests':
        return reply({ received })
      case 'thread/resume':
      case 'thread/unsubscribe':
        return reply({})
      case 'turn/start': {
        const id = `turn-${++turns}`
        reply({ turn: { id } })
        send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } })
        if (ephemeral.has(p.threadId)) {
          // One-off questions answer at once.
          const answer = process.env.FAKE_CODEX_ANSWER ?? JSON.stringify({ schema: !!p.outputSchema })
          return later(() => {
            send({ method: 'item/completed', params: { threadId: p.threadId, item: { type: 'agentMessage', id: 'ans-1', text: answer } } })
            send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed' } } })
          })
        }
        active.set(p.threadId, id)
        return undefined
      }
      case 'turn/interrupt':
        if (active.has(p.threadId) && active.get(p.threadId) !== p.turnId) {
          return send({ id: msg.id, error: { code: -32600, message: `expected active turn id ${p.turnId} but found ${active.get(p.threadId)}` } })
        }
        reply({})
        return setTimeout(() => {
          if (active.get(p.threadId) !== p.turnId) return
          active.delete(p.threadId)
          send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: outer.get(p.turnId) ?? p.turnId, status: 'interrupted' } } })
        }, windDownMs)
      case 'test/emit':
        reply({})
        return send({ method: p.method, params: p.params })
      default:
        return send({ id: msg.id, error: { code: -32601, message: `unsupported ${msg.method}` } })
    }
  })
  .on('close', () => process.exit(0))
