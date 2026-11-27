// Electron main for the ResizableSplit screenshot/smoke fixture (AP-1).
const { app, BrowserWindow, Menu } = require('electron')
const { join } = require('node:path')

if (process.env.VARIA_TEST_USER_DATA) app.setPath('userData', process.env.VARIA_TEST_USER_DATA)

Menu.setApplicationMenu(null)
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.loadFile(join(process.env.VARIA_SPLIT_FIXTURE_DIR, 'index.html'), {
    query: Object.fromEntries(new URLSearchParams(process.env.VARIA_SPLIT_FIXTURE_QUERY ?? ''))
  })
})
app.on('window-all-closed', () => app.quit())
