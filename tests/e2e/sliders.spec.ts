import { test, expect } from '@playwright/test'
import type { ModelOption, ProviderStatus } from '../../src/shared/types'
import { launchDuet, type Launched } from './launch'

const claudeModels: ModelOption[] = [
  { id: 'fake-haiku', label: 'Haiku', description: 'Fastest for quick answers' },
  { id: 'fake-sonnet', label: 'Sonnet', description: 'Efficient for routine tasks' },
  { id: 'fake-opus', label: 'Opus', description: 'Best for everyday, complex tasks', isDefault: true, efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'fake-fable', label: 'Fable', description: 'Most capable for your hardest tasks' }
]

async function publishModels(ctx: Launched, models: ModelOption[]) {
  const status: ProviderStatus = { id: 'claude', installed: true, loggedIn: true, models, defaultModel: 'fake-opus', limits: [], checkedAt: Date.now() }
  await ctx.app.evaluate(({ BrowserWindow }, status) => {
    BrowserWindow.getAllWindows()[0].webContents.send('duet:event', { type: 'provider-status', status })
  }, status)
}

test.describe('slider regression checks', () => {
  let ctx: Launched
  test.beforeEach(async () => { ctx = await launchDuet() })
  test.afterEach(async () => {
    await ctx.app.close()
    expect(ctx.errors).toEqual([])
  })

  test('hover, Escape and switching to a shorter model ladder keep the window working', async () => {
    const { page } = ctx
    await publishModels(ctx, claudeModels)
    await page.getByTestId('model-menu').click()
    const slider = page.getByTestId('model-slider').getByRole('slider')
    const box = (await slider.boundingBox())!
    await page.mouse.move(box.x + box.width - 14, box.y + 15)
    await expect(page.getByTestId('model-ladder').getByText('Fable', { exact: true }).first()).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Meta+2')
    await expect(page.getByTestId('switch-codex')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('model-menu').click()
    await expect(page.getByTestId('model-ladder')).toContainText('GPT (demo)')
    // Refresh the provider while its preview is live, shrinking from four stops to two.
    await page.keyboard.press('Meta+1')
    await expect(slider).toHaveAttribute('aria-valuemax', '3')
    const updated = (await slider.boundingBox())!
    await page.mouse.move(updated.x + updated.width - 14, updated.y + 15)
    await publishModels(ctx, claudeModels.filter((m) => /haiku|opus/.test(m.id)))
    await expect(slider).toHaveAttribute('aria-valuemax', '1')
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await slider.focus()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await expect(slider).toBeFocused()
    await expect(page.getByTestId('model-menu')).toContainText('Opus')
  })

  test('the knob follows dragging immediately and keyboard input clears mouse previews', async () => {
    const { page } = ctx
    await page.getByTestId('effort-menu').click()
    const slider = page.getByTestId('effort-slider').getByRole('slider')
    const box = (await slider.boundingBox())!
    const x = box.x + 14 + (box.width - 28) * 0.65
    await page.mouse.move(box.x + 14, box.y + 15)
    await page.mouse.down()
    await page.mouse.move(x, box.y + 15)
    await expect(slider).toHaveAttribute('data-dragging', 'true')
    const knob = slider.locator('[data-slider-knob]')
    expect(await knob.evaluate((el) => getComputedStyle(el).transitionProperty)).not.toContain('left')
    const knobBox = (await knob.boundingBox())!
    expect(Math.abs(knobBox.x + knobBox.width / 2 - x)).toBeLessThan(2)
    await page.mouse.up()
    await expect(page.getByTestId('effort-menu')).toContainText('High')
    const after = (await slider.boundingBox())!
    expect(Math.abs(after.y - box.y)).toBeLessThan(1)
    await slider.press('ArrowLeft')
    await expect(page.getByTestId('effort-menu')).toContainText('Medium')
    await expect(page.getByTestId('effort-popover').getByText('Medium', { exact: true })).toBeVisible()
    await expect(slider).toHaveAttribute('aria-describedby', /.+/)
    await expect(page.getByRole('button', { name: 'About effort' })).toBeVisible()
  })

  test('a single effort can be selected by clicking and returned to Auto', async () => {
    const { page } = ctx
    await publishModels(ctx, claudeModels.map((m) => m.id === 'fake-opus' ? { ...m, efforts: ['high'], defaultEffort: 'high' } : m))
    await page.getByTestId('effort-menu').click()
    const slider = page.getByTestId('effort-slider').getByRole('slider')
    await expect(slider).toHaveAttribute('aria-valuemax', '0')
    await slider.click()
    await expect(page.getByTestId('effort-menu')).toContainText('High')
    await page.getByTestId('effort-auto').click()
    await expect(page.getByTestId('effort-menu')).toContainText('Auto')
    await expect(slider).toHaveAttribute('aria-valuetext', /automatic/)
  })
})
