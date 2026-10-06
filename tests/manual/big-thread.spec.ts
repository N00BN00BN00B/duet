/** Manual perf check: import the newest real Codex thread and time rendering (read-only for real data). */
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('large imported thread renders quickly', async () => {
  test.setTimeout(300_000)
  const userData = mkdtempSync(join(tmpdir(), 'duet-big-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ onboarded: true, theme: 'dark', notifications: false }))
  const app = await electron.launch({ args: [resolve(__dirname, '../..')], env: { ...process.env, DUET_USER_DATA: userData, DUET_E2E: '1' } as Record<string, string> })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('[data-testid="home-view"]')
  await page.getByTestId('nav-history').click()
  await page.getByRole('radio', { name: /Codex/ }).click()
  await expect(page.locator('[data-testid="history-row"]').first()).toBeVisible({ timeout: 60_000 })
  const t0 = Date.now()
  await page.locator('[data-testid="history-open"]').first().click()
  await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 60_000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline"] > div > div').length > 10)
  const openMs = Date.now() - t0
  const blocks = await page.evaluate(() => document.querySelectorAll('[data-testid="timeline"] > div > div').length)
  // Scroll through the whole thread.
  const t1 = Date.now()
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(700, 400)
    await page.mouse.wheel(0, -1500)
    await page.waitForTimeout(16)
  }
  const scrollMs = Date.now() - t1
  const shots = join(tmpdir(), 'duet-real-shots')
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'big-thread.png') })
  console.log(`opened in ${openMs}ms, ${blocks} blocks, 20 scroll steps in ${scrollMs}ms, errors: ${errors.length}`)
  expect(errors).toEqual([])
  expect(openMs).toBeLessThan(8000)
  await app.close()
})
