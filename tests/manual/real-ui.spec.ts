/**
 * Drives the real app UI with the real Claude Code and Codex CLIs (manual run only):
 *   DUET_REAL_UI=1 npx playwright test tests/manual/real-ui.spec.ts --config tests/manual/playwright.config.ts
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Real-account screenshots can contain emails and local paths, so they stay out of the repo.
const SHOTS = process.env.DUET_REAL_SHOTS ?? join(tmpdir(), 'duet-real-shots')

test('real agents: chat, switch, history, MCP, settings', async () => {
  test.setTimeout(600_000)
  mkdirSync(SHOTS, { recursive: true })
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'duet-real-')))
  const userData = join(root, 'userdata')
  const project = join(root, 'demo-site')
  mkdirSync(userData, { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'index.html'), '<!doctype html><title>Demo</title><h1>Hello</h1>\n')
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ onboarded: true, theme: 'dark', projects: [project], defaultModels: { claude: 'haiku', codex: process.env.DUET_LIVE_CODEX_MODEL ?? 'gpt-5.6-luna' }, defaultEfforts: { codex: 'low' }, defaultAccess: 'ask', backupDir: join(root, 'backups') }))
  const app = await electron.launch({ args: [resolve(__dirname, '../..')], env: { ...process.env, DUET_USER_DATA: userData } as Record<string, string> })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="home-view"]')
  // Wait for both agents to report in.
  await expect(page.getByText(/Claude.*(Max|Pro|Team|ready|v\d)/i).first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${SHOTS}/01-home.png` })

  const input = page.getByTestId('composer-input')
  await input.fill('In one short sentence, what is index.html in this folder? Read it first.')
  await page.getByTestId('send-button').click()
  await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 180_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOTS}/02-claude-reply.png` })

  await page.getByTestId('switch-codex').click()
  await input.fill('What did Claude just tell me about the file? Answer in under 15 words.')
  await page.getByTestId('send-button').click()
  await expect(page.getByTestId('timeline')).toContainText('Switched to Codex')
  await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 240_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOTS}/03-codex-reply.png` })

  await page.getByTestId('nav-history').click()
  await expect(page.locator('[data-testid="history-row"]').first()).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: `${SHOTS}/04-history.png` })
  await page.getByRole('radio', { name: /Codex/ }).click()
  await expect(page.locator('[data-testid="history-row"]').first()).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: `${SHOTS}/05-history-codex.png` })

  await page.getByTestId('nav-mcp').click()
  await expect(page.locator('[data-testid="mcp-row"]').first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/06-mcp.png` })

  await page.getByTestId('nav-sync').click()
  await expect(page.locator('[data-testid="sync-row"]').first()).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: `${SHOTS}/07-sync.png` })

  await page.getByTestId('nav-backups').click()
  await expect(page.getByTestId('backup-set-claude-sessions')).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: `${SHOTS}/08-backups.png` })

  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('agent-card-codex')).toBeVisible()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${SHOTS}/09-settings.png` })
  await app.close()
})
