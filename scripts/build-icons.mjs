import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const electron = require('electron')
const res = spawnSync(electron, ['scripts/render-icon.cjs'], { stdio: 'inherit' })
process.exit(res.status ?? 1)
