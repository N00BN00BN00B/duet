import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchDuet, type Launched } from './launch'

const SHOTS = 'test-results/shots'
mkdirSync(SHOTS, { recursive: true })

/** Lets hover and selection transitions settle so screenshots show the final state. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** Two Claude Code sessions (with token usage) and a Claude output style to import. */
function seed(home: string) {
  const project = join(home, 'Projects', 'demo-app')
  const dir = join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const session = (sid: string, title: string, ask: string, answer: string, minutesAgo: number) => {
    const at = (offset: number) => new Date(now - minutesAgo * 60_000 + offset * 1000).toISOString()
    const lines = [
      { type: 'user', uuid: `${sid}-u1`, sessionId: sid, cwd: project, timestamp: at(0), message: { role: 'user', content: ask } },
      { type: 'assistant', uuid: `${sid}-a1`, sessionId: sid, cwd: project, timestamp: at(5), requestId: 'req_1', message: { id: `msg_${sid}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: answer }], usage: { input_tokens: 1200, output_tokens: 300 } } },
      { type: 'custom-title', customTitle: title, sessionId: sid }
    ]
    writeFileSync(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  session('11111111-2222-3333-4444-555555555555', 'Dark mode toggle', 'Add a dark mode toggle to the settings page', 'Sure — I added a toggle in Settings.tsx.', 30)
  session('66666666-7777-8888-9999-000000000000', 'Fix flaky login test', 'The login test fails sometimes', 'It waited on a timer; I made it wait for the request instead.', 90)
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'Concise' }))
}

async function send(page: Page, text: string) {
  const input = page.getByTestId('composer-input')
  await input.click()
  await input.fill(text)
  await page.getByTestId('send-button').click()
}

const settingsOf = (page: Page) => page.evaluate(() => (window as unknown as { duet: { settings: { get: () => Promise<Record<string, any>> } } }).duet.settings.get()) // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.serial('Duet 2: look, commands, sync, usage, command line', () => {
  let ctx: Launched

  test.beforeAll(async () => {
    ctx = await launchDuet({ seed })
  })

  test.afterAll(async () => {
    await ctx?.app.close()
  })

  test.afterEach(async () => {
    const unexpected = ctx.errors.filter((e) => !/ERR_CONNECTION_REFUSED|net::ERR_/.test(e))
    expect(unexpected, unexpected.join('\n')).toEqual([])
  })

  test('home: a calm start, and a project picker with general chats', async () => {
    const { page } = ctx
    await expect(page.getByTestId('home-view')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Good|Working late/)
    await page.getByTestId('project-picker').click()
    await expect(page.getByRole('menuitem', { name: /General chat/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /Open a folder/ })).toBeVisible()
    await page.getByRole('menuitem', { name: /General chat/ }).click()
    await expect(page.getByTestId('project-picker')).toContainText('General chat (no project)')
    await page.getByTestId('project-picker').click()
    await page.getByRole('menuitem', { name: /demo-app/ }).click()
    await expect(page.getByTestId('project-picker')).toContainText('demo-app')
    await shot(page, '20-home')
  })

  test('commands menu lists Duet and agent commands, and /theme designs a theme', async () => {
    const { page } = ctx
    const input = page.getByTestId('composer-input')
    await input.click()
    await input.fill('/')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('/theme')
    await expect(menu).toContainText('/usage')
    await expect(menu).toContainText('/compact') // from the agent
    await shot(page, '21-commands')
    await input.fill('/usa')
    await expect(page.getByTestId('command-option').first()).toContainText('/usage')
    await input.press('Enter')
    await expect(page.getByTestId('usage-view')).toBeVisible()
    await page.getByTestId('new-thread').click()
    await input.click()
    await input.fill('/theme deep space with stars')
    await input.press('Enter')
    await expect(page.getByText(/applied \(by Claude\)/)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('html')).toHaveAttribute('data-effect', 'stars')
    await expect(page.getByTestId('background-effect')).toBeAttached()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-effect', 'none')
  })

  test('Customize: presets, describe a look, edit it, personality', async () => {
    const { page } = ctx
    await page.getByTestId('nav-customize').click()
    await expect(page.getByTestId('customize-view')).toBeVisible()
    await page.getByRole('button', { name: 'Use Midnight' }).click()
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())).toBe('#0d1017')
    await page.getByTestId('theme-prompt').fill('dark gradient with a wave effect')
    await page.getByTestId('theme-generate').click()
    await expect(page.locator('html')).toHaveAttribute('data-effect', 'wave', { timeout: 15_000 })
    await shot(page, '22-customize-wave')
    const made = (await settingsOf(page)).customThemes.at(-1)
    await page.getByTestId('theme-card').filter({ hasText: made.name }).hover()
    await page.getByRole('button', { name: `Edit ${made.name}` }).click()
    const editor = page.getByTestId('theme-editor')
    await expect(editor).toBeVisible()
    await editor.getByRole('button', { name: 'Aurora', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-effect', 'aurora')
    await editor.getByRole('button', { name: 'Save theme' }).click()
    await expect.poll(async () => (await settingsOf(page)).customThemes.find((t: { id: string }) => t.id === made.id)?.background.effect).toBe('aurora')
    await page.getByTestId('personality-friendly').click()
    await expect.poll(async () => (await settingsOf(page)).personality.preset).toBe('friendly')
    await page.getByTestId('personality-import').click()
    await expect(page.getByText('Codex now uses Claude Code · Concise.')).toBeVisible()
    expect((await settingsOf(page)).personality).toMatchObject({ preset: 'concise', providers: ['codex'], importedFrom: 'Claude Code · Concise' })
    await page.getByRole('button', { name: 'Use Graphite' }).click()
  })

  test('Usage shows both limits and what Claude Code used', async () => {
    const { page } = ctx
    await page.getByTestId('nav-usage').click()
    await expect(page.getByTestId('limits-claude')).toContainText('5-hour')
    await expect(page.getByTestId('limits-codex')).toContainText('Weekly')
    // The two seeded Claude Code sessions: 2 × (1200 in + 300 out).
    await expect(page.getByTestId('usage-totals')).toContainText('3.0k', { timeout: 20_000 })
    await shot(page, '23-usage')
  })

  test('chat sync puts Claude Code chats in the sidebar and opens them on demand', async () => {
    const { page, userData } = ctx
    await page.getByTestId('new-thread').click()
    await page.getByTestId('home-sync').click()
    await expect(page.getByText(/Synced chats: 2 new/)).toBeVisible({ timeout: 20_000 })
    const rows = page.locator('[data-testid="thread-row"]')
    await expect(rows.filter({ hasText: 'Claude · Fix flaky login test' })).toHaveCount(1)
    const lazyId = await rows.filter({ hasText: 'Fix flaky login test' }).getAttribute('data-thread-id')
    expect(existsSync(join(userData, 'threads', `${lazyId}.json`))).toBe(false) // nothing copied yet
    await rows.filter({ hasText: 'Dark mode toggle' }).click()
    await expect(page.getByTestId('timeline')).toContainText('I added a toggle in Settings.tsx', { timeout: 15_000 })
    await expect(page.getByTestId('thread-title')).toHaveText('Dark mode toggle')
    expect((await settingsOf(page)).chatSync).toBe('auto')
  })

  test('duet:// links draft a prompt, and send it only with the secret', async () => {
    const { page, app, userData, project } = ctx
    const open = (url: string) => app.evaluate(async (_electron, link) => (globalThis as unknown as { __duetOpenUrl: (u: string) => Promise<void> }).__duetOpenUrl(link), url)
    await open(`duet://open?cwd=${encodeURIComponent(project)}&prompt=${encodeURIComponent('draft from a web page')}&send=1`)
    await expect(page.getByTestId('home-view')).toBeVisible()
    await expect(page.getByTestId('composer-input')).toHaveValue('draft from a web page')
    await page.getByTestId('composer-input').fill('')
    const token = readFileSync(join(userData, 'cli-token'), 'utf8').trim()
    await open(`duet://open?cwd=${encodeURIComponent(project)}&prompt=${encodeURIComponent('sent from the terminal')}&send=1&token=${token}`)
    await expect(page.getByTestId('thread-title')).toHaveText('sent from the terminal')
    await expect(page.getByTestId('timeline')).toContainText('You said: “sent from the terminal”', { timeout: 20_000 })
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 20_000 })
  })

  test('effort and model sliders: drag, click and keys', async () => {
    const { page } = ctx
    /** Where stop `i` of `n` sits on a slider track (the knob's centre runs 14px in from each end). */
    const stopX = async (testId: string, i: number, n: number) => {
      const box = (await page.getByTestId(testId).getByRole('slider').boundingBox())!
      return { x: box.x + 14 + (i / (n - 1)) * (box.width - 28), y: box.y + box.height / 2 }
    }
    const button = page.getByTestId('effort-menu')
    await button.click()
    const slider = page.getByTestId('effort-slider').getByRole('slider')
    await expect(slider).toBeFocused()
    await expect(page.getByTestId('effort-popover')).toContainText('Auto')
    // Keys: End jumps to the top level.
    await page.keyboard.press('End')
    await expect(button).toContainText('Max')
    await expect(slider).toHaveAttribute('aria-valuetext', 'Max')
    // Drag the knob from Max down to High (demo Opus: low, medium, high, max).
    const from = await stopX('effort-slider', 3, 4)
    const to = await stopX('effort-slider', 2, 4)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, to.y, { steps: 4 })
    await expect(page.getByTestId('effort-popover')).toContainText('High') // previewed while dragging
    await page.mouse.move(to.x + 3, to.y, { steps: 4 })
    await page.mouse.up()
    await expect(button).toContainText('High')
    await shot(page, '25-effort')
    // A click lands on the nearest stop; Auto hands the choice back to the model.
    const low = await stopX('effort-slider', 0, 4)
    await page.mouse.click(low.x + 4, low.y)
    await expect(button).toContainText('Low')
    await page.getByTestId('effort-auto').click()
    await expect(button).toContainText('Auto')
    await expect(slider).toHaveAttribute('aria-valuetext', /automatic/)
    await page.keyboard.press('Escape')

    const models = page.getByTestId('model-menu')
    await models.click()
    await expect(page.getByTestId('model-ladder')).toContainText('Faster')
    await expect(page.getByTestId('model-slider')).toContainText('Haiku')
    await expect(page.getByTestId('model-slider-recommended')).toBeVisible()
    const haiku = await stopX('model-slider', 0, 2)
    await page.mouse.click(haiku.x, haiku.y)
    await expect(models).toContainText('Haiku (demo)')
    await shot(page, '26-models')
    const opus = await stopX('model-slider', 1, 2)
    await page.mouse.click(opus.x, opus.y)
    await expect(models).toContainText('Opus (demo)')
    await expect(page.getByTestId('model-option')).toHaveCount(4)
    await expect(page.getByTestId('model-option').first()).toContainText('Smarts')
    await page.keyboard.press('Escape')
  })

  test('command line installs into the chosen folder and comes off again', async () => {
    const { page, home } = ctx
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('cli-install').click()
    await expect(page.getByText(/Installed — try/)).toBeVisible()
    const script = join(home, 'bin-test', 'duet')
    expect(readFileSync(script, 'utf8')).toContain('Installed by Duet')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByText('Removed the duet command.')).toBeVisible()
    expect(existsSync(script)).toBe(false)
  })

  test('storage shows sizes and cleans up safely', async () => {
    const { page } = ctx
    await expect(page.getByText('Attachments & pictures')).toBeVisible()
    await page.getByTestId('storage-clean').click()
    await expect(page.getByText(/Nothing to clean up|Moved \d+ files/).first()).toBeVisible()
    await shot(page, '24-settings')
  })
})

test('onboarding walks through agents, chats and a look', async () => {
  const { app, page } = await launchDuet({ onboarded: false, seed })
  try {
    await expect(page.getByTestId('onboarding')).toBeVisible()
    await page.getByTestId('onboarding-next').click()
    await expect(page.getByTestId('onboarding')).toContainText('Connect your agents')
    await expect(page.getByTestId('onboarding')).toContainText('Connected')
    await page.getByTestId('onboarding-next').click()
    await expect(page.getByTestId('onboarding')).toContainText('Bring your chats along')
    await page.getByTestId('onboarding-next').click()
    await expect(page.getByTestId('onboarding')).toContainText('Make it yours')
    await page.getByTestId('onboarding').getByRole('button', { name: /Midnight/ }).click()
    await page.getByTestId('onboarding-next').click()
    await expect(page.getByTestId('onboarding')).toContainText("You're set")
    await page.getByTestId('onboarding-next').click()
    await expect(page.getByTestId('onboarding')).toBeHidden()
    const settings = await settingsOf(page)
    expect(settings).toMatchObject({ onboarded: true, chatSync: 'auto', darkTheme: 'midnight' })
    await expect(page.locator('[data-testid="thread-row"]')).toHaveCount(2, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
