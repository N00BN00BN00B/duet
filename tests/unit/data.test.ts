import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { claudeToConfig, codexToConfig, configToClaude, configToCodex, mergeStatus, parseMcpJson, sameServer, validateServer, writeCodexServer, removeCodexServer, writeClaudeServer } from '../../src/main/features/mcp'
import { fakeMcpDeps } from '../../src/main/features/fakeMcp'
import { applySync, scanSync } from '../../src/main/features/sync'
import { archiveName, createBackup, describeSets, listBackups, restoreBackup, restorePath, setForPath, type BackupContext } from '../../src/main/features/backup'
import { describeClaudeSession, parseClaudeTranscript } from '../../src/main/features/history'
import { planActions } from '../../src/renderer/src/lib/syncPlan'
import { buildBlocks, summarize } from '../../src/renderer/src/lib/timeline'
import type { TimelineItem } from '../../src/shared/types'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `duet-${p}-`))

describe('MCP config conversion', () => {
  it('round-trips stdio servers between Claude and Codex', () => {
    const claude = claudeToConfig('fs', { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { A: '1' } })
    expect(claude).toMatchObject({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: { A: '1' } })
    expect(configToCodex(claude)).toEqual({ command: 'npx', args: ['-y', 'server'] })
    const back = codexToConfig('fs', { command: 'npx', args: ['-y', 'server'], env: { A: '1' } })
    expect(sameServer(claude, back)).toBe(true)
    expect(configToClaude(back)).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { A: '1' } })
  })

  it('maps bearer tokens and headers for remote servers', () => {
    const fromClaude = claudeToConfig('gh', { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${GH_TOKEN}', 'X-Team': 'a' } })
    expect(configToCodex(fromClaude)).toEqual({ url: 'https://x/mcp', bearer_token_env_var: 'GH_TOKEN', http_headers: { 'X-Team': 'a' } })
    const fromCodex = codexToConfig('gh', { url: 'https://x/mcp', bearer_token_env_var: 'GH_TOKEN' })
    expect(configToClaude(fromCodex)).toEqual({ type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${GH_TOKEN}' } })
    expect(claudeToConfig('s', { type: 'sse', url: 'https://y' }).transport).toBe('sse')
  })

  it('parses pasted JSON and validates names', () => {
    const list = parseMcpJson('{"mcpServers":{"a":{"command":"x"},"b":{"url":"https://b"},"junk":5}}')
    expect(list.map((s) => s.name)).toEqual(['a', 'b'])
    expect(() => parseMcpJson('{"command":"x"}')).toThrow(/single server/)
    expect(() => parseMcpJson('{}')).toThrow(/No MCP servers/)
    expect(validateServer({ name: 'bad name', transport: 'stdio', command: 'x' })).toMatch(/letters/)
    expect(validateServer({ name: 'ok', transport: 'stdio' })).toMatch(/command/)
    expect(validateServer({ name: 'ok', transport: 'http', url: 'ftp://x' })).toMatch(/http/)
    expect(validateServer({ name: 'ok_1-2', transport: 'http', url: 'https://x' })).toBeNull()
  })

  it('merges live status from both agents', () => {
    const merged = mergeStatus(
      [
        { provider: 'claude', scope: 'user', config: { name: 'a', transport: 'stdio', command: 'x' } },
        { provider: 'codex', scope: 'user', config: { name: 'a', transport: 'stdio', command: 'x' } }
      ],
      [
        { name: 'a', status: 'connected' },
        { name: 'plugin:figma:figma', status: 'needs-auth' }
      ],
      [{ name: 'a', status: 'failed', tools: 3 }]
    )
    expect(merged.find((e) => e.provider === 'claude' && e.config.name === 'a')?.status).toBe('connected')
    expect(merged.find((e) => e.provider === 'codex')).toMatchObject({ status: 'failed', tools: 3 })
    expect(merged.find((e) => e.scope === 'plugin')).toMatchObject({ readOnly: true, status: 'needs-auth' })
  })

  it('writes and removes servers through the file-based fakes', async () => {
    const home = tmp('mcp')
    const deps = fakeMcpDeps(home)
    await writeCodexServer(deps, { name: 'fs', transport: 'stdio', command: 'npx', args: ['a'], env: { K: 'v' } })
    let toml = parseToml(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, any>
    expect(toml.mcp_servers.fs).toEqual({ command: 'npx', args: ['a'], env: { K: 'v' } })
    // Switching to a URL removes the stdio-only fields.
    await writeCodexServer(deps, { name: 'fs', transport: 'http', url: 'https://x' })
    toml = parseToml(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, any>
    expect(toml.mcp_servers.fs).toEqual({ url: 'https://x' })
    await removeCodexServer(deps, 'fs')
    toml = parseToml(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, any>
    expect(toml.mcp_servers.fs).toBeUndefined()
    await writeClaudeServer(deps, { name: 'gh', transport: 'stdio', command: 'gh-mcp' })
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.gh).toEqual({ type: 'stdio', command: 'gh-mcp' })
    await expect(writeClaudeServer(deps, { name: 'bad name', transport: 'stdio', command: 'x' })).rejects.toThrow()
  })
})

describe('sync', () => {
  function homes() {
    const root = tmp('sync')
    const claudeHome = join(root, '.claude')
    const codexHome = join(root, '.codex')
    mkdirSync(join(claudeHome, 'skills', 'alpha'), { recursive: true })
    mkdirSync(join(codexHome, 'skills', 'beta'), { recursive: true })
    mkdirSync(join(codexHome, 'skills', '.system', 'internal'), { recursive: true })
    writeFileSync(join(claudeHome, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nA')
    writeFileSync(join(codexHome, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\nB')
    writeFileSync(join(codexHome, 'skills', '.system', 'internal', 'SKILL.md'), 'system')
    writeFileSync(join(claudeHome, 'CLAUDE.md'), 'claude rules')
    writeFileSync(join(codexHome, 'AGENTS.md'), 'codex rules')
    mkdirSync(join(claudeHome, 'commands'))
    writeFileSync(join(claudeHome, 'commands', 'review.md'), 'Review $ARGUMENTS')
    return { root, paths: { claudeHome, codexHome } }
  }

  it('scans differences and skips missing or system items', () => {
    const { root, paths } = homes()
    const project = join(root, 'proj')
    mkdirSync(project)
    const items = scanSync(project, paths, { claude: { a: { command: 'x' } }, codex: { a: { command: 'x' }, b: { url: 'https://b' } } })
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]))
    expect(byKey['instructions:global'].state).toBe('different')
    expect(byKey[`instructions:project:${project}`]).toBeUndefined()
    expect(byKey['skill:alpha'].state).toBe('claude-only')
    expect(byKey['skill:beta'].state).toBe('codex-only')
    expect(items.some((i) => i.name === '.system')).toBe(false)
    expect(byKey['command:review'].state).toBe('claude-only')
    expect(byKey['mcp:a'].state).toBe('same')
    expect(byKey['mcp:b'].state).toBe('codex-only')
    expect(byKey['mcp:a'].newer).toBeUndefined()
  })

  it('applies copies in both directions with safety backups', async () => {
    const { root, paths } = homes()
    const backupRoot = join(root, 'safety')
    const res = await applySync(
      [
        { key: 'instructions:global', direction: 'to-codex' },
        { key: 'skill:alpha', direction: 'to-codex' },
        { key: 'skill:beta', direction: 'to-claude' },
        { key: 'command:review', direction: 'to-codex' },
        { key: 'skill:nope', direction: 'to-codex' }
      ],
      { paths, backupRoot }
    )
    expect(res.applied).toBe(4)
    expect(res.errors).toHaveLength(1)
    expect(readFileSync(join(paths.codexHome, 'AGENTS.md'), 'utf8')).toBe('claude rules')
    expect(readFileSync(join(paths.codexHome, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('alpha')
    expect(readFileSync(join(paths.claudeHome, 'skills', 'beta', 'SKILL.md'), 'utf8')).toContain('beta')
    expect(readFileSync(join(paths.codexHome, 'prompts', 'review.md'), 'utf8')).toBe('Review $ARGUMENTS')
    // The overwritten AGENTS.md was saved first.
    const saved = join(backupRoot, paths.codexHome.replace(/^\//, ''), 'AGENTS.md')
    expect(readFileSync(saved, 'utf8')).toBe('codex rules')
    // Re-copying over an existing skill keeps exactly one copy.
    await applySync([{ key: 'skill:alpha', direction: 'to-codex' }], { paths, backupRoot })
    expect(readdirSync(join(paths.codexHome, 'skills')).filter((n) => n.startsWith('alpha'))).toEqual(['alpha'])
    const after = scanSync(undefined, paths, { claude: {}, codex: {} })
    expect(after.filter((i) => i.state !== 'same')).toHaveLength(0)
  })

  it('plans "sync everything" by strategy', () => {
    const items = [
      { key: 'a', kind: 'skill', name: 'a', state: 'claude-only' },
      { key: 'b', kind: 'skill', name: 'b', state: 'codex-only' },
      { key: 'c', kind: 'instructions', name: 'c', state: 'different', newer: 'codex' },
      { key: 'd', kind: 'mcp', name: 'd', state: 'different' },
      { key: 'e', kind: 'skill', name: 'e', state: 'same' }
    ] as Parameters<typeof planActions>[0]
    expect(planActions(items, 'newest')).toEqual([
      { key: 'a', direction: 'to-codex' },
      { key: 'b', direction: 'to-claude' },
      { key: 'c', direction: 'to-claude' }
    ])
    expect(planActions(items, 'to-codex')).toEqual([
      { key: 'a', direction: 'to-codex' },
      { key: 'c', direction: 'to-codex' },
      { key: 'd', direction: 'to-codex' }
    ])
    expect(planActions(items, 'to-claude').map((a) => a.key)).toEqual(['b', 'c', 'd'])
  })
})

describe('backups', () => {
  function context(root: string): BackupContext {
    const home = join(root, 'home')
    return {
      home,
      claudeDir: join(home, '.claude'),
      claudeJson: join(home, '.claude.json'),
      codexDir: join(root, 'custom-codex-home'),
      duetDir: join(root, 'duet-data'),
      appVersion: '1.0.0-test'
    }
  }

  function seed(ctx: BackupContext) {
    mkdirSync(join(ctx.claudeDir, 'skills', 's1'), { recursive: true })
    mkdirSync(join(ctx.claudeDir, 'projects', '-proj'), { recursive: true })
    mkdirSync(join(ctx.codexDir, 'sessions', '2026', '10'), { recursive: true })
    mkdirSync(join(ctx.duetDir, 'threads'), { recursive: true })
    writeFileSync(join(ctx.claudeDir, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(ctx.claudeDir, 'skills', 's1', 'SKILL.md'), 'skill body')
    writeFileSync(join(ctx.claudeDir, 'projects', '-proj', 'abc.jsonl'), '{"type":"user"}\n')
    writeFileSync(ctx.claudeJson, '{"mcpServers":{}}')
    writeFileSync(join(ctx.codexDir, 'config.toml'), 'model = "x"\n')
    writeFileSync(join(ctx.codexDir, 'auth.json'), '{"secret":true}')
    writeFileSync(join(ctx.codexDir, 'state_5.sqlite'), 'db')
    writeFileSync(join(ctx.codexDir, 'logs_2.sqlite'), 'logs')
    writeFileSync(join(ctx.codexDir, 'sessions', '2026', '10', 'rollout.jsonl'), '{}\n')
    writeFileSync(join(ctx.duetDir, 'threads', 't.json'), '{"meta":{}}')
    writeFileSync(join(ctx.duetDir, 'settings.json'), '{}')
    symlinkSync('s1', join(ctx.claudeDir, 'skills', 'alias'))
  }

  it('maps paths to logical archive names and back safely', () => {
    const ctx = context('/r')
    expect(archiveName('/r/home/.claude/skills/a/SKILL.md', ctx)).toBe('claude/skills/a/SKILL.md')
    expect(archiveName('/r/home/.claude.json', ctx)).toBe('claude-json/.claude.json')
    expect(archiveName('/r/custom-codex-home/config.toml', ctx)).toBe('codex/config.toml')
    expect(archiveName('/elsewhere/x', ctx)).toBeNull()
    expect(restorePath('codex/config.toml', ctx)).toBe('/r/custom-codex-home/config.toml')
    expect(restorePath('codex/../../etc/passwd', ctx)).toBeNull()
    expect(restorePath('claude-json/.bashrc', ctx)).toBeNull()
    expect(restorePath('unknown/x', ctx)).toBeNull()
    expect(setForPath('/r/custom-codex-home/state_5.sqlite', ctx)).toBe('codex-app-state')
    expect(setForPath('/r/custom-codex-home/auth.json', ctx)).toBe('codex-auth')
    expect(setForPath('/r/duet-data/threads/x.json', ctx)).toBe('duet')
  })

  it('creates an archive and restores it onto another machine layout', async () => {
    const src = context(tmp('backup-src'))
    seed(src)
    const sets = describeSets(src)
    expect(sets.find((s) => s.id === 'codex-auth')).toMatchObject({ defaultOn: false, files: 1 })
    expect(sets.find((s) => s.id === 'codex-app-state')).toMatchObject({ files: 1 })
    const outDir = join(src.home, 'Backups')
    let progressCalls = 0
    const info = await createBackup(src, { sets: ['claude-config', 'claude-sessions', 'codex-config', 'codex-sessions', 'duet'], dir: outDir, onProgress: () => progressCalls++ })
    expect(progressCalls).toBeGreaterThan(0)
    expect(info.sets).toHaveLength(5)
    expect(existsSync(info.file)).toBe(true)
    const listed = listBackups(outDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: info.name, files: info.files, sets: info.sets })

    // Restore into a different machine (different home, codex and duet folders).
    const dst = context(tmp('backup-dst'))
    mkdirSync(dst.codexDir, { recursive: true })
    writeFileSync(join(dst.codexDir, 'config.toml'), 'model = "old"\n')
    const result = await restoreBackup(dst, info.file, ['claude-config', 'codex-config', 'duet'], { safetyDir: join(dst.home, 'Backups') })
    expect(result.restored).toBeGreaterThanOrEqual(6)
    expect(readFileSync(join(dst.claudeDir, 'skills', 's1', 'SKILL.md'), 'utf8')).toBe('skill body')
    expect(readFileSync(dst.claudeJson, 'utf8')).toBe('{"mcpServers":{}}')
    expect(readFileSync(join(dst.codexDir, 'config.toml'), 'utf8')).toBe('model = "x"\n')
    expect(readFileSync(join(dst.duetDir, 'threads', 't.json'), 'utf8')).toBe('{"meta":{}}')
    // Sets that weren't chosen stay untouched.
    expect(existsSync(join(dst.claudeDir, 'projects', '-proj', 'abc.jsonl'))).toBe(false)
    expect(existsSync(join(dst.codexDir, 'auth.json'))).toBe(false)
    // The replaced config.toml was saved in a safety backup first.
    expect(result.safetyBackup).toMatch(/before-restore\.tar\.gz$/)
    expect(listBackups(join(dst.home, 'Backups'))).toHaveLength(1)
  })

  it('refuses empty selections', async () => {
    const ctx = context(tmp('backup-empty'))
    await expect(createBackup(ctx, { sets: [], dir: join(ctx.home, 'b') })).rejects.toThrow(/at least one/)
    await expect(createBackup(ctx, { sets: ['claude-config'], dir: join(ctx.home, 'b') })).rejects.toThrow(/empty/)
  })
})

describe('Claude history import', () => {
  it('reads titles from transcripts and converts them to timeline items', () => {
    const dir = tmp('hist')
    const file = join(dir, 'sess-1.jsonl')
    const lines = [
      { type: 'summary', summary: 'Old summary' },
      { type: 'user', uuid: 'u0', sessionId: 'sess-1', cwd: '/proj', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', uuid: 'u1', sessionId: 'sess-1', cwd: '/proj', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:02Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:03Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] } },
      { type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T00:00:04Z', message: { id: 'm1', content: [{ type: 'text', text: 'Done' }] } },
      { type: 'assistant', uuid: 'side', isSidechain: true, message: { id: 'x', content: [{ type: 'text', text: 'subagent noise' }] } },
      { type: 'custom-title', customTitle: 'Bug hunt' }
    ]
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const entry = describeClaudeSession(file)!
    expect(entry).toMatchObject({ provider: 'claude', nativeId: 'sess-1', title: 'Bug hunt', cwd: '/proj', model: 'claude-opus-5-5' })
    const { items, cwd } = parseClaudeTranscript(readFileSync(file, 'utf8'))
    expect(cwd).toBe('/proj')
    expect(items.map((i) => i.kind)).toEqual(['user', 'reasoning', 'assistant', 'tool'])
    const assistant = items.find((i) => i.kind === 'assistant')
    expect(assistant && assistant.kind === 'assistant' && assistant.text).toBe('Looking\n\nDone')
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ title: 'ls', output: 'a\nb', status: 'done' })
  })
})

describe('timeline grouping', () => {
  it('groups tools between messages and places one agent header per turn', () => {
    const items: TimelineItem[] = [
      { kind: 'user', id: 'u', ts: 1, provider: 'claude', text: 'hi', attachments: [] },
      { kind: 'reasoning', id: 'r', ts: 2, provider: 'claude', text: 'thinking' },
      { kind: 'tool', id: 't1', ts: 3, provider: 'claude', tool: 'read', name: 'Read', title: 'a.ts', status: 'done' },
      { kind: 'tool', id: 't2', ts: 4, provider: 'claude', tool: 'edit', name: 'Edit', title: 'a.ts', status: 'done' },
      { kind: 'assistant', id: 'a', ts: 5, provider: 'claude', text: 'done' },
      { kind: 'turn', id: 'tt', ts: 6, provider: 'claude', status: 'completed' },
      { kind: 'switch', id: 's', ts: 7, from: 'claude', to: 'codex' },
      { kind: 'user', id: 'u2', ts: 8, provider: 'codex', text: 'go', attachments: [] },
      { kind: 'assistant', id: 'a2', ts: 9, provider: 'codex', text: 'ok' }
    ]
    const blocks = buildBlocks(items)
    expect(blocks.map((b) => (b.type === 'work' ? `work(${b.entries.length},${b.showHeader})` : `${b.item.kind}${b.showHeader ? '+h' : ''}`))).toEqual(['user', 'work(3,true)', 'assistant', 'turn', 'switch', 'user', 'assistant+h'])
    const work = blocks.find((b) => b.type === 'work')
    expect(work && work.type === 'work' && summarize(work.entries)).toBe('Thought · Read 1 file · Changed 1 file')
  })
})
