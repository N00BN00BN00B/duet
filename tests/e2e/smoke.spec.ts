import { test, expect } from '@playwright/test'
import { launchDuet } from './launch'

test('app boots to the home screen', async () => {
  const { app, page } = await launchDuet()
  await expect(page.getByTestId('home-view')).toBeVisible()
  await page.screenshot({ path: 'test-results/shots/01-home-dark.png' })
  await app.close()
})
