import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface Launched {
  app: ElectronApplication
  page: Page
  home: string
  userData: string
  project: string
  /** Uncaught page errors and console errors seen so far. */
  errors: string[]
}

/** Starts Duet with demo agents and a throwaway home folder so tests never touch real data. */
export async function launchDuet(opts: { onboarded?: boolean; theme?: 'dark' | 'light'; seed?: (home: string) => void; reuse?: { home: string; userData: string } } = {}): Promise<Launched> {
  const root = opts.reuse ? '' : mkdtempSync(join(tmpdir(), 'duet-e2e-'))
  const home = opts.reuse?.home ?? join(root, 'home')
  const userData = opts.reuse?.userData ?? join(root, 'userdata')
  const project = join(home, 'Projects', 'demo-app')
  if (!opts.reuse) {
    mkdirSync(project, { recursive: true })
    mkdirSync(userData, { recursive: true })
    writeFileSync(join(project, 'README.md'), '# Demo app\n')
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ onboarded: opts.onboarded ?? true, theme: opts.theme ?? 'dark', projects: [project], backupDir: join(home, 'Duet Backups'), notifications: false })
    )
    opts.seed?.(home)
  }
  // DUET_E2E_EXECUTABLE points at a packaged Duet.app binary to test the shipped build.
  const packaged = process.env.DUET_E2E_EXECUTABLE
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged, args: [] } : { args: [resolve(__dirname, '../..')] }),
    env: {
      ...process.env,
      HOME: home,
      DUET_FAKE_PROVIDERS: '1',
      DUET_E2E: '1',
      DUET_FAKE_SPEED: '3',
      DUET_USER_DATA: userData,
      ELECTRON_ENABLE_LOGGING: '0'
    } as Record<string, string>
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  await page.setViewportSize({ width: 1380, height: 880 }).catch(() => undefined)
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 })
  return { app, page, home, userData, project, errors }
}
