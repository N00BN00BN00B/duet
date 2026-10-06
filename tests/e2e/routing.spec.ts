import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { launchDuet } from './launch'
import type { DuetApi } from '../../src/shared/api'

test('connect providers, create and edit a route, choose it, and remove it', async () => {
  const combos: Record<string, any> = {}
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const path = req.url ?? ''
    const models = [{ id: 'google/gemini-test' }, { id: 'ollama/qwen-test' }, ...Object.keys(combos).map((id) => ({ id: `combo/${id}` }))]
    if (path === '/v1/models') return res.end(JSON.stringify({ data: models }))
    if (path === '/v1/catalog') return res.end(JSON.stringify({ models: [{ slug: 'google/gemini-test', display_name: 'Gemini Test', input_modalities: ['text', 'image'] }] }))
    if (path.startsWith('/api/combos')) {
      if (req.headers['x-opencodex-api-key'] !== 'test-admin') { res.statusCode = 401; return res.end('{}') }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(Buffer.from(c))
        const { id, combo } = JSON.parse(Buffer.concat(chunks).toString())
        combos[id] = combo
      }
      if (req.method === 'DELETE') delete combos[new URL(path, 'http://localhost').searchParams.get('id')!]
      return res.end(JSON.stringify({ combos: Object.entries(combos).map(([id, combo]) => ({ id, model: `combo/${id}`, ...combo })) }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const ctx = await launchDuet()
  const page = ctx.page
  try {
    // Playwright forces --use-mock-keychain and --password-store=basic. Substitute
    // an ephemeral encryptor only in this throwaway test process; production keeps
    // Electron's OS-backed storage. Credential persistence is covered by unit tests.
    await ctx.app.evaluate(({ safeStorage }) => {
      const { randomBytes, createCipheriv, createDecipheriv } = process.getBuiltinModule('node:crypto')
      const key = randomBytes(32)
      safeStorage.isEncryptionAvailable = () => true
      safeStorage.encryptString = (value: string) => {
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
      }
      safeStorage.decryptString = (value: Buffer) => {
        const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
        cipher.setAuthTag(value.subarray(12, 28))
        return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
      }
    })
    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('routing-settings')
    await settings.locator('summary').click()
    await page.getByLabel('Routing server address').fill(endpoint)
    await page.getByLabel('Routing admin key', { exact: true }).fill('test-admin')
    await page.getByTestId('routing-connect').click()
    await expect(settings).toContainText('2 models')
    await page.getByRole('switch', { name: 'Enable provider models' }).click()
    await page.getByTestId('routing-new-route').click()
    await page.getByLabel('Route name', { exact: true }).fill('daily')
    await page.getByLabel('Route target 1', { exact: true }).selectOption('google/gemini-test')
    await page.getByRole('button', { name: 'Add target', exact: true }).click()
    await page.getByLabel('Route target 2', { exact: true }).selectOption('ollama/qwen-test')
    await page.getByRole('button', { name: 'Save route', exact: true }).click()
    await expect(page.getByTestId('routing-route')).toContainText('daily')
    expect(combos.daily.strategy).toBe('failover')
    await page.getByTestId('routing-route').getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Routing strategy', { exact: true }).selectOption('round-robin')
    await page.getByLabel('Target 1 weight', { exact: true }).fill('3')
    await page.getByRole('button', { name: 'Save route', exact: true }).click()
    await expect(page.getByTestId('routing-route')).toContainText('Weighted distribution')
    expect(combos.daily.targets[0].weight).toBe(3)
    await page.getByTestId('new-thread').click()
    await page.getByTestId('model-menu').click()
    await page.getByPlaceholder('Search models', { exact: true }).fill('combo/daily')
    await page.getByTestId('model-option').first().click()
    await expect(page.getByTestId('model-menu')).toContainText('combo/daily')
    const defaults = await page.evaluate(() => (window as unknown as { duet: DuetApi }).duet.settings.get())
    expect(Object.values(defaults.defaultModels)).toContain('router:combo/daily')
    await page.getByTestId('nav-settings').click()
    await page.getByRole('button', { name: 'Remove route daily' }).click()
    await expect(page.getByTestId('routing-route')).toHaveCount(0)
    expect(ctx.errors.filter((e) => !/ERR_CONNECTION_REFUSED|net::ERR_/.test(e))).toEqual([])
    await page.screenshot({ path: 'test-results/shots/routing-settings.png' })
  } finally {
    await ctx.app.close()
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) })
  }
})
