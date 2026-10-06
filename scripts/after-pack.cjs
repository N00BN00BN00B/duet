// Ad-hoc signs the macOS bundle so Gatekeeper sees one consistent app (no certificate or keychain needed).
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { readdirSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // Native debug symbols can contain the developer's absolute home/build paths. Strip before
  // signing, including node-pty's fallback prebuilds, then fail packaging if a home path remains.
  const pty = join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty')
  const stripNative = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stripNative(path)
      else if (entry.name.endsWith('.node') || entry.name === 'spawn-helper') {
        // Only Mach-O files: node-pty also distributes Linux and Windows prebuilds.
        const magic = readFileSync(path).readUInt32BE(0)
        if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) continue
        execFileSync('strip', ['-S', path])
        if (readFileSync(path).includes(Buffer.from(homedir() + '/'))) throw new Error(`Private build path remains in ${entry.name}`)
      }
    }
  }
  stripNative(pty)
  execFileSync('xattr', ['-cr', app])
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
