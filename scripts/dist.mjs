// Builds the macOS app outside iCloud-synced folders (File Provider metadata breaks codesign),
// then copies the finished DMG and zip into ./release.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = join(tmpdir(), 'duet-release')
rmSync(out, { recursive: true, force: true })
execFileSync('npx', ['electron-builder', '--mac', '--arm64', `-c.directories.output=${out}`, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
})
mkdirSync('release', { recursive: true })
for (const file of readdirSync(out)) {
  if (/\.(dmg|zip)$/.test(file)) copyFileSync(join(out, file), join('release', file))
}
console.log(`\nApp bundle: ${join(out, 'mac-arm64', 'Duet.app')}\nInstallers: ./release`)
