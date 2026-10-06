import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchDuet, type Launched } from './launch'

const SHOTS = 'test-results/shots'
mkdirSync(SHOTS, { recursive: true })

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

async function send(page: Page, text: string) {
  const input = page.getByTestId('composer-input')
  await input.click()
  await input.fill(text)
  await page.getByTestId('send-button').click()
}

async function waitIdle(page: Page) {
  await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30_000 })
}

function seedHome(home: string) {
  // A Claude session transcript and some config so History / MCP / Sync have data.
  const project = join(home, 'Projects', 'demo-app')
  const slug = project.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(home, '.claude', 'projects', slug)
  mkdirSync(dir, { recursive: true })
  const sid = '11111111-2222-3333-4444-555555555555'
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: sid, cwd: project, timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'Add a dark mode toggle to the settings page' } },
    { type: 'assistant', uuid: 'a1', sessionId: sid, cwd: project, timestamp: '2026-10-01T10:00:05.000Z', message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Sure — I added a toggle in `Settings.tsx`.' }, { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: `${project}/Settings.tsx`, old_string: 'const a = 1', new_string: 'const a = 2' } }] } },
    { type: 'user', uuid: 'u2', sessionId: sid, cwd: project, timestamp: '2026-10-01T10:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
    { type: 'custom-title', customTitle: 'Dark mode toggle', sessionId: sid }
  ]
  writeFileSync(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } } } }, null, 2))
  mkdirSync(join(home, '.claude', 'skills', 'release-notes'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes\n---\nUse bullet points.\n')
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Rules\n- Be concise\n')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-demo"\n\n[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\n')
}

test.describe.serial('Duet end-to-end (demo agents)', () => {
  let ctx: Launched

  test.beforeAll(async () => {
    ctx = await launchDuet({ seed: seedHome })
  })

  test.afterAll(async () => {
    await ctx?.app.close()
  })

  test.afterEach(async () => {
    // The browser panel's demo page can't reach localhost; everything else must be clean.
    const unexpected = ctx.errors.filter((e) => !/ERR_CONNECTION_REFUSED|net::ERR_/.test(e))
    expect(unexpected, unexpected.join('\n')).toEqual([])
  })

  test('chat with Claude streams a reply', async () => {
    const { page } = ctx
    await send(page, 'Hello from the automated suite')
    await expect(page.getByTestId('thread-title')).toHaveText('Hello from the automated suite')
    await expect(page.getByTestId('timeline')).toContainText('You said', { timeout: 20_000 })
    await waitIdle(page)
    await expect(page.getByTestId('timeline')).toContainText('Claude here')
    await expect(page.locator('[data-testid="thread-row"]')).toHaveCount(1)
    await shot(page, '02-thread-claude')
  })

  test('approval flow: allow a command', async () => {
    const { page } = ctx
    await send(page, 'please run the tests')
    await expect(page.getByTestId('approval-panel')).toBeVisible({ timeout: 20_000 })
    await shot(page, '03-approval')
    await page.getByTestId('approval-allow').click()
    await expect(page.getByTestId('approval-panel')).toBeHidden()
    await waitIdle(page)
    await expect(page.getByTestId('timeline')).toContainText('Approved')
    await expect(page.getByTestId('timeline')).toContainText('Ran 1 command')
  })

  test('approval flow: deny a command', async () => {
    const { page } = ctx
    await send(page, 'run it again')
    await expect(page.getByTestId('approval-panel')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('approval-deny').click()
    await waitIdle(page)
    await expect(page.getByTestId('timeline')).toContainText('won’t run the tests')
    await expect(page.getByTestId('timeline')).toContainText('Declined')
  })

  test('switching to Codex hands off the conversation', async () => {
    const { page } = ctx
    await page.getByTestId('switch-codex').click()
    await expect(page.locator('html')).toHaveAttribute('data-provider', 'codex')
    await send(page, 'continue and edit the answer constant')
    await expect(page.getByTestId('timeline')).toContainText('Switched to Codex')
    await expect(page.getByTestId('timeline')).toContainText('Picking up from Claude', { timeout: 20_000 })
    await waitIdle(page)
    await expect(page.getByTestId('timeline')).toContainText('Changed 1 file')
    await shot(page, '04-switched-to-codex')
    // And back to Claude: only the Codex part is handed back.
    await page.keyboard.press('Meta+1')
    await expect(page.locator('html')).toHaveAttribute('data-provider', 'claude')
    await send(page, 'thanks, what did codex change?')
    await expect(page.getByTestId('timeline')).toContainText('Switched to Claude')
    await expect(page.getByTestId('timeline')).toContainText('Picking up from Codex', { timeout: 20_000 })
    await waitIdle(page)
  })

  test('stop interrupts a running turn', async () => {
    const { page } = ctx
    await send(page, 'please run a long command')
    await expect(page.getByTestId('approval-panel')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('stop-button').click()
    await waitIdle(page)
    await expect(page.getByTestId('timeline')).toContainText('Stopped')
  })

  test('a follow-up typed while the agent works is queued and sent afterwards', async () => {
    const { page } = ctx
    await send(page, 'please run the suite once more')
    await expect(page.getByTestId('approval-panel')).toBeVisible({ timeout: 20_000 })
    const input = page.getByTestId('composer-input')
    await input.fill('and then summarize the results')
    await page.getByTestId('queue-button').click()
    await expect(page.getByTestId('queued-message')).toContainText('summarize the results')
    await expect(input).toHaveValue('')
    await page.getByTestId('approval-allow').click()
    // The queued message goes out by itself once the first turn ends.
    await expect(page.getByTestId('timeline')).toContainText('You said: “and then summarize the results”', { timeout: 20_000 })
    await expect(page.getByTestId('queued-message')).toBeHidden()
    await waitIdle(page)
  })

  test('image attachment via paste reaches the agent', async () => {
    const { page } = ctx
    await page.getByTestId('composer-input').click()
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 48
      const g = canvas.getContext('2d')!
      g.fillStyle = '#d97757'
      g.fillRect(0, 0, 64, 48)
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'))
      const file = new File([blob], 'swatch.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const ta = document.querySelector('[data-testid="composer-input"]')!
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await expect(page.getByTestId('composer').locator('img')).toHaveCount(1, { timeout: 10_000 })
    await send(page, 'what color is this?')
    await expect(page.getByTestId('timeline')).toContainText('1 attachment: ', { timeout: 20_000 })
    await waitIdle(page)
    await expect(page.getByTestId('timeline').locator('img')).not.toHaveCount(0)
  })

  test('panels: changes, browser and terminal open', async () => {
    const { page } = ctx
    await page.getByTestId('toggle-changes').click()
    await expect(page.getByTestId('changes-panel')).toBeVisible()
    await page.getByTestId('toggle-browser').click()
    await expect(page.getByTestId('browser-panel')).toBeVisible()
    await page.getByTestId('browser-url').fill('data:text/html,<h1 style="font-family:sans-serif">Hello from the Duet browser</h1>')
    await page.getByTestId('browser-url').press('Enter')
    await page.waitForTimeout(800)
    await page.getByTestId('toggle-terminal').click()
    await expect(page.getByTestId('terminal-drawer')).toBeVisible()
    // Real shell through node-pty: type a command and read it back from xterm.
    await page.waitForTimeout(1200)
    await page.locator('[data-testid="terminal-drawer"] .xterm').click()
    await page.keyboard.type('echo duet-$((40+2))-ok')
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="terminal-drawer"] .xterm-rows')).toContainText('duet-42-ok', { timeout: 15_000 })
    await shot(page, '05-panels')
    await page.getByTestId('toggle-terminal').click()
    await page.getByTestId('toggle-browser').click()
    await expect(page.getByTestId('right-panel')).toBeHidden()
  })

  test('command palette opens threads and actions', async () => {
    const { page } = ctx
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('palette')).toBeVisible()
    await shot(page, '06-palette')
    await page.keyboard.type('MCP')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('mcp-view')).toBeVisible()
  })

  test('MCP: lists both agents and copies a server across', async () => {
    const { page, home } = ctx
    await expect(page.locator('[data-testid="mcp-row"]')).toHaveCount(2)
    await shot(page, '07-mcp')
    await page.getByTestId('mcp-sync-all').click()
    await expect(page.getByText('Added github to Codex')).toBeVisible({ timeout: 10_000 })
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain('github')
    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(claude.mcpServers.figma.url).toBe('https://mcp.figma.com/mcp')
  })

  test('MCP: add a server to both agents', async () => {
    const { page, home } = ctx
    await page.getByTestId('mcp-add').click()
    await page.getByPlaceholder('github', { exact: true }).fill('filesystem')
    await page.getByPlaceholder('npx', { exact: true }).fill('npx')
    await page.getByPlaceholder('-y @modelcontextprotocol/server-github').fill('-y @modelcontextprotocol/server-filesystem "/tmp/my files"')
    await page.getByRole('button', { name: 'Save server' }).click()
    await expect(page.locator('[data-testid="mcp-row"]')).toHaveCount(3, { timeout: 10_000 })
    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(claude.mcpServers.filesystem.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp/my files'])
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain('filesystem')
  })

  test('Sync: copies instructions and skills to Codex', async () => {
    const { page, home } = ctx
    await page.getByTestId('nav-sync').click()
    await expect(page.getByTestId('sync-view')).toBeVisible()
    await expect(page.locator('[data-testid="sync-row"]').first()).toBeVisible()
    await shot(page, '08-sync')
    await page.getByTestId('sync-everything').click()
    await page.getByRole('button', { name: /^Sync \d+ item/ }).click()
    await expect(page.getByText(/Synced \d+ item/)).toBeVisible({ timeout: 15_000 })
    expect(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8')).toContain('Be concise')
    expect(existsSync(join(home, '.codex', 'skills', 'release-notes', 'SKILL.md'))).toBe(true)
  })

  test('Backups: create a backup archive', async () => {
    const { page, home } = ctx
    await page.getByTestId('nav-backups').click()
    await expect(page.getByTestId('backups-view')).toBeVisible()
    await expect(page.getByTestId('backup-set-claude-config')).toBeVisible()
    await page.getByTestId('backup-create').click()
    await expect(page.locator('[data-testid="backup-row"]')).toHaveCount(1, { timeout: 30_000 })
    await shot(page, '09-backups')
    const files = readdirSync(join(home, 'Duet Backups'))
    expect(files.some((f) => f.endsWith('.tar.gz'))).toBe(true)
    expect(files.some((f) => f.endsWith('.json'))).toBe(true)
  })

  test('Backups: restore brings files back and keeps a safety copy', async () => {
    const { page, home } = ctx
    // Change a file that is in the backup, then restore it.
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'edited after backup\n')
    await page.locator('[data-testid="backup-row"]').first().getByRole('button', { name: 'Restore…' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Restore from backup')
    // Leave Duet's own data alone so the app doesn't restart mid-test.
    await dialog.getByText('Duet', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(page.getByText(/Restored \d+ files/)).toBeVisible({ timeout: 30_000 })
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain('Be concise')
    await expect(page.locator('[data-testid="backup-row"]')).toHaveCount(2)
    await expect(page.getByText('before restore')).toBeVisible()
  })

  test('History: imports a Claude session and continues it', async () => {
    const { page } = ctx
    await page.getByTestId('nav-history').click()
    await expect(page.getByTestId('history-view')).toBeVisible()
    await expect(page.locator('[data-testid="history-row"]')).toHaveCount(1)
    await shot(page, '10-history')
    await page.getByTestId('history-open').click()
    await expect(page.getByTestId('thread-title')).toHaveText('Dark mode toggle')
    await expect(page.getByTestId('timeline')).toContainText('Add a dark mode toggle')
    await expect(page.getByTestId('timeline')).toContainText('Settings.tsx')
    await page.getByTestId('switch-codex').click()
    await send(page, 'Codex, take it from here')
    await expect(page.getByTestId('timeline')).toContainText('Picking up from Claude', { timeout: 20_000 })
    await waitIdle(page)
  })

  test('Settings and light theme', async () => {
    const { page } = ctx
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('settings-view')).toBeVisible()
    await expect(page.getByTestId('agent-card-claude')).toBeVisible()
    await shot(page, '11-settings')
    await page.getByRole('radio', { name: 'Light' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.locator('[data-testid="thread-row"]').first().click()
    await shot(page, '12-thread-light')
    await page.getByTestId('nav-settings').click()
    await page.getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('threads persist across restarts', async () => {
    const { app, userData, home } = ctx
    await app.close()
    const index = JSON.parse(readFileSync(join(userData, 'threads', 'index.json'), 'utf8'))
    expect(index.length).toBe(2)
    ctx = await launchDuet({ reuse: { home, userData } })
    await expect(ctx.page.locator('[data-testid="thread-row"]')).toHaveCount(2)
    await ctx.page.locator('[data-testid="thread-row"]').filter({ hasText: 'Hello from the automated suite' }).click()
    await expect(ctx.page.getByTestId('timeline')).toContainText('Picking up from Codex')
    await expect(ctx.page.getByTestId('timeline')).toContainText('Switched to Codex')
  })
})
