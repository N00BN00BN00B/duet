// Renders build/icon.svg to build/icon.png (1024px) with Electron's own Chromium.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '..', 'build', 'icon.svg'), 'utf8')
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const png = image.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG()
  writeFileSync(join(__dirname, '..', 'build', 'icon.png'), png)
  console.log('wrote build/icon.png', png.length, 'bytes')
  app.quit()
})
