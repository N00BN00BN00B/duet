/** Read-only checks against this Mac's real Claude/Codex data (no writes). */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listClaudeSessions, loadClaudeSession } from '../../src/main/features/history'
import { listMcp } from '../../src/main/features/mcp'
import { scanSync } from '../../src/main/features/sync'
import { defaultContext, describeSets } from '../../src/main/features/backup'

const LIVE = !!process.env.DUET_LIVE
const time = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
  const t = performance.now()
  const out = await fn()
  console.log(`${label}: ${Math.round(performance.now() - t)}ms`)
  return out
}

describe.skipIf(!LIVE)('real data (read-only)', () => {
  it('lists and loads Claude sessions quickly', async () => {
    const list = await time('listClaudeSessions', () => listClaudeSessions())
    console.log(`  ${list.length} sessions; newest: ${list[0]?.title?.slice(0, 50)}`)
    expect(list.length).toBeGreaterThan(0)
    const again = await time('listClaudeSessions (cached)', () => listClaudeSessions())
    expect(again.length).toBe(list.length)
    const loaded = await time('loadClaudeSession(newest)', () => loadClaudeSession(list[0].nativeId))
    console.log(`  ${loaded.items.length} items, cwd ${loaded.cwd}`)
    expect(loaded.items.length).toBeGreaterThan(0)
  })

  it('reads MCP config from both agents', async () => {
    const entries = await time('listMcp', () => listMcp())
    console.log('  ' + entries.map((e) => `${e.provider}:${e.config.name}`).join(', '))
    expect(entries.some((e) => e.provider === 'codex')).toBe(true)
  })

  it('scans everything that can be synced', async () => {
    const items = await time('scanSync', () => scanSync(process.env.DUET_LIVE_DIR ?? process.cwd()))
    const summary: Record<string, number> = {}
    for (const i of items) summary[`${i.kind}:${i.state}`] = (summary[`${i.kind}:${i.state}`] ?? 0) + 1
    console.log('  ' + JSON.stringify(summary))
    expect(items.length).toBeGreaterThan(0)
  })

  it('sizes the backup sets', async () => {
    const sets = await time('describeSets', () => describeSets(defaultContext(join(homedir(), 'Library', 'Application Support', 'Duet'), 'test')))
    console.log('  ' + sets.map((s) => `${s.id}=${Math.round((s.bytes ?? 0) / 1e6)}MB/${s.files}`).join(' '))
    expect(sets.find((s) => s.id === 'claude-sessions')!.files).toBeGreaterThan(0)
  })
})

import { findBinary, getEnv, loadShellEnv } from '../../src/main/env'
import { CodexAdapter } from '../../src/main/providers/codex/adapter'
import { listCodexThreads, loadCodexThread } from '../../src/main/features/history'

describe.skipIf(!LIVE)('real Codex history (read-only)', () => {
  it('lists threads and converts one into a timeline', async () => {
    await loadShellEnv()
    const codex = new CodexAdapter({ binary: () => findBinary('codex'), env: getEnv, appVersion: 'test' })
    try {
      const request = <T,>(m: string, p?: unknown, t?: number) => codex.rpcRequest<T>(m, p, t)
      const list = await time('listCodexThreads', () => listCodexThreads(request))
      console.log(`  ${list.length} threads; newest: ${list[0]?.title?.slice(0, 60)} (${list[0]?.cwd})`)
      expect(list.length).toBeGreaterThan(0)
      // Load a few, including an older one.
      for (const entry of [list[0], list[Math.floor(list.length / 2)], list[list.length - 1]]) {
        const loaded = await time(`loadCodexThread(${entry.nativeId.slice(0, 8)})`, () => loadCodexThread(request, entry.nativeId))
        const kinds: Record<string, number> = {}
        for (const i of loaded.items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1
        console.log(`  ${loaded.items.length} items ${JSON.stringify(kinds)} title=${loaded.title?.slice(0, 40)}`)
        expect(loaded.items.length).toBeGreaterThan(0)
        expect(loaded.items.some((i) => i.kind === 'user')).toBe(true)
      }
    } finally {
      await codex.shutdown()
    }
  }, 180_000)
})
