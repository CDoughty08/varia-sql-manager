// Electron's main for the document frame fixture (scripts/document-frame-smoke.mjs): one hidden, sandboxed window on the
// page the suite built, which needs no preload and reaches nothing outside itself.
const { app, BrowserWindow, Menu } = require('electron')
const { join } = require('node:path')

// The suite's own profile, so Chromium's caches never land in another app's.
if (process.env.VARIA_TEST_USER_DATA) app.setPath('userData', process.env.VARIA_TEST_USER_DATA)

// No menu bar: Electron's default one would arrive after the first layout and shorten the page under the checks.
Menu.setApplicationMenu(null)
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.loadFile(join(process.env.VARIA_FRAME_FIXTURE_DIR, 'index.html'), { query: Object.fromEntries(new URLSearchParams(process.env.VARIA_FRAME_FIXTURE_QUERY ?? '')) })
})
app.on('window-all-closed', () => app.quit())
