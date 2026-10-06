/** Manual visual pass: every screen in light mode with demo agents (screenshots to $TMPDIR/duet-light). */
import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchDuet } from '../e2e/launch'

test('light mode tour', async () => {
  const out = join(tmpdir(), 'duet-light')
  mkdirSync(out, { recursive: true })
  const { app, page } = await launchDuet({ theme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(out, 'home.png') })
  await page.getByTestId('composer-input').fill('please make a plan and run the tests')
  await page.getByTestId('send-button').click()
  await expect(page.getByTestId('approval-panel')).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: join(out, 'approval.png') })
  await page.getByTestId('approval-allow').click()
  await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('toggle-changes').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, 'thread.png') })
  for (const view of ['mcp', 'sync', 'backups', 'settings', 'history']) {
    await page.getByTestId(`nav-${view}`).click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(out, `${view}.png`) })
  }
  await app.close()
})
