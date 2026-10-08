import { app, BrowserWindow, ipcMain, Menu, dialog, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BackendClient } from './backend-client'
import { validateRequest } from './validation'
import { SqlFileStore, maxSqlFileBytes } from './sql-files'
import { LayoutStore } from './layout-store'
import { ConnectionStore } from './connection-store'
import { userInfo } from 'node:os'
import { connectionProfileInputSchema } from '../shared/connections'
import { parseWorkspaceLayout } from '../shared/layouts'
import type { ApiResult, RpcMethod, RpcMethods, WorkbenchCommand } from '../shared/contracts'
import { fileShortcut, menuShortcut } from '../shared/shortcuts'

const here = dirname(fileURLToPath(import.meta.url))
const rendererFile = join(here, '../renderer/index.html')
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
let mainWindow: BrowserWindow | null = null
let backend: BackendClient
const files = new SqlFileStore()
let closeApproved = false
let openMenu: Menu | null = null
let layouts: LayoutStore
// Renderer lifecycle: exit confirmation needs a live workbench that has subscribed to commands.
let rendererLoaded = false
let rendererReady = false
let rendererUnresponsive = false
// Tests use their own profile so layout checks never modify the user's workspace preferences.
if (process.env.VARIA_SMOKE_TEST === '1' && process.env.VARIA_TEST_USER_DATA) app.setPath('userData', process.env.VARIA_TEST_USER_DATA)
// A second instance would overwrite this instance's layouts and connection library.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

function command(value: WorkbenchCommand): void { mainWindow?.webContents.send('varia:command', value) }

function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false
  const senderUrl = event.senderFrame?.url
  try { return !!senderUrl && (developmentUrl ? new URL(senderUrl).origin === new URL(developmentUrl).origin : senderUrl === pathToFileURL(rendererFile).href) }
  catch { return false }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? fallback
  return error instanceof Error ? error.message : fallback
}

function handle<T>(channel: string, action: (value: unknown) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, value: unknown): Promise<ApiResult<T>> => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC sender.' }
    try { return { ok: true, value: await action(value) } }
    catch (error) { return { ok: false, error: errorMessage(error, 'The operation failed.') } }
  })
}

/** A reloaded or crashed renderer can no longer address its sessions, so end them with the backend process. */
function resetRendererState(): void {
  rendererReady = false
  openMenu = null
  backend?.restart()
  files.clear()
}

function rendererCanConfirm(window: BrowserWindow): boolean {
  return rendererReady && !rendererUnresponsive && !window.webContents.isCrashed()
}

function createWindow(): void {
  // Lifecycle state belongs to one window; on macOS a forced close keeps the app running for the next window.
  closeApproved = false
  rendererLoaded = false
  rendererReady = false
  rendererUnresponsive = false
  mainWindow = new BrowserWindow({
    title: 'Varia SQL Manager', width: 1440, height: 960, minWidth: 1024, minHeight: 700,
    backgroundColor: '#11151c', show: process.env.VARIA_SMOKE_TEST !== '1',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 10 } } : { titleBarOverlay: { color: '#181f2a', symbolColor: '#d9e1ec', height: 34 } }),
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: process.env.VARIA_SMOKE_TEST !== '1' }
  })
  const window = mainWindow, contents = window.webContents
  if (process.platform !== 'darwin') {
    mainWindow.setAutoHideMenuBar(false)
    mainWindow.setMenuBarVisibility(false)
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (input.control && !input.alt && !input.meta) {
        const action = fileShortcut(input.key, input.shift)
        if (action) { event.preventDefault(); command(action); return }
      }
      if (input.control || input.meta || input.shift) return
      const key = input.key.toLowerCase()
      const menu = input.alt ? menuShortcut(key) : undefined
      if (menu || (key === 'f10' && !input.alt)) {
        event.preventDefault()
        mainWindow?.webContents.send('varia:menu-focus', menu ?? null)
      }
    })
  }
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', event => event.preventDefault())
  // Monaco's context-menu Paste reads the clipboard; every other permission stays denied.
  contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(requester === mainWindow?.webContents && 'isMainFrame' in details && details.isMainFrame && (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'))
  })
  contents.session.webRequest.onHeadersReceived((details, callback) => {
    const connect = developmentUrl ? `${new URL(developmentUrl).origin} ws://127.0.0.1:* ws://localhost:*` : "'self'"
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [
      `default-src 'self'; script-src 'self'${developmentUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src ${connect}; object-src 'none'; frame-src 'none'; base-uri 'none'`
    ] } })
  })
  contents.on('did-finish-load', () => { rendererLoaded = true })
  // will-navigate cancels navigation elsewhere, so only a same-URL main-frame navigation is a reload (menu, Ctrl+R, or dev HMR).
  contents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument && rendererLoaded && details.url === contents.getURL()) resetRendererState()
  })
  // The renderer blocks unload only while queries are unsaved or servers are connected.
  contents.on('will-prevent-unload', event => {
    if (closeApproved) { event.preventDefault(); return }
    const choice = dialog.showMessageBoxSync(window, { type: 'warning', title: 'Reload workbench', message: 'Reload Varia SQL Manager?', detail: 'Unsaved queries will be lost. Connections are closed and uncommitted transactions are rolled back.', buttons: ['Reload', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true })
    if (choice === 0) event.preventDefault()
  })
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || window.isDestroyed()) return
    resetRendererState()
    void dialog.showMessageBox(window, { type: 'error', title: 'Workbench stopped', message: 'The workbench stopped unexpectedly.', detail: 'Unsaved queries were lost. Connections were closed and uncommitted transactions were rolled back.', buttons: ['Reload', 'Close'], defaultId: 0, cancelId: 1, noLink: true }).then(({ response }) => {
      if (window.isDestroyed()) return
      if (response === 0) window.reload()
      else { closeApproved = true; window.close() }
    })
  })
  window.on('unresponsive', () => { rendererUnresponsive = true })
  window.on('responsive', () => { rendererUnresponsive = false })
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(rendererFile)
  window.on('close', event => {
    if (closeApproved) return
    if (rendererCanConfirm(window)) { event.preventDefault(); command('window.close'); return }
    // A crashed, hung, or unmounted workbench cannot run the unsaved-query prompts, so never trap the user.
    if (rendererUnresponsive && dialog.showMessageBoxSync(window, { type: 'warning', title: 'Workbench not responding', message: 'Close Varia SQL Manager?', detail: 'The workbench is not responding. Unsaved queries will be lost.', buttons: ['Close', 'Wait'], defaultId: 1, cancelId: 1, noLink: true }) !== 0) { event.preventDefault(); return }
    closeApproved = true
  })
  // A closed window can no longer address its sessions (macOS keeps the app running after the last window closes).
  window.on('closed', () => { mainWindow = null; resetRendererState() })
}

app.whenReady().then(() => {
  if (!primaryInstance) return
  const root = app.getAppPath()
  backend = app.isPackaged
    ? new BackendClient(join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'Varia.Backend.exe' : 'Varia.Backend'), [], root)
    : new BackendClient('dotnet', [join(root, 'backend/Varia.Backend/bin', process.env.VARIA_SMOKE_TEST === '1' ? 'Release' : 'Debug', 'net10.0/Varia.Backend.dll')], root)
  backend.start()
  layouts = new LayoutStore(join(app.getPath('userData'), 'workspace-layouts.json'))
  const connectionStore = new ConnectionStore(join(app.getPath('userData'), 'connections.json'))
  ipcMain.on('varia:commands-ready', (event, ready: unknown) => { if (trusted(event)) rendererReady = ready === true })
  handle('varia:connections-load', async () => ({ ...await connectionStore.load(), windowsIdentity: process.platform === 'win32' ? [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join('\\') : userInfo().username }))
  handle('varia:connections-save', value => connectionStore.save(connectionProfileInputSchema.parse(value)))
  handle('varia:connections-remove', value => connectionStore.remove(z.uuid().parse(value)))
  handle('varia:layouts-load', () => layouts.load())
  handle('varia:layouts-save', value => layouts.save(value))
  handle('varia:layout-import', async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, { title: 'Load workspace layout', filters: [{ name: 'Varia layout', extensions: ['json'] }], properties: ['openFile'] })
    return selection.canceled || !selection.filePaths[0] ? null : layouts.import(selection.filePaths[0])
  })
  handle('varia:layout-export', async value => {
    const layout = parseWorkspaceLayout(value)
    const selection = await dialog.showSaveDialog(mainWindow!, { title: 'Save workspace layout', defaultPath: join(app.getPath('documents'), 'workspace.varia-layout.json'), filters: [{ name: 'Varia layout', extensions: ['json'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] })
    if (selection.canceled || !selection.filePath) return false
    await layouts.export(selection.filePath, layout)
    return true
  })
  handle('varia:menu-popup', async value => {
    const options = z.object({ menu: z.enum(['file', 'edit', 'view', 'window']), x: z.number().int().min(0).max(32767), y: z.number().int().min(0).max(32767) }).strict().parse(value)
    const menu = Menu.getApplicationMenu()?.getMenuItemById('menu.' + options.menu)?.submenu
    if (!menu || !mainWindow) throw new Error('The application menu is unavailable.')
    const window = mainWindow
    const bounds = window.getContentBounds()
    const zoom = window.webContents.getZoomFactor()
    openMenu?.closePopup(window)
    await new Promise<void>(resolve => {
      openMenu = menu
      menu.popup({ window, x: Math.min(bounds.width - 1, Math.round(options.x * zoom)), y: Math.min(bounds.height - 1, Math.round(options.y * zoom)), callback: () => {
        if (openMenu === menu) openMenu = null
        resolve()
      } })
    })
  })
  ipcMain.handle('varia:request', async (event, method: string, params: unknown): Promise<ApiResult<unknown>> => {
    if (!trusted(event)) {
      return { ok: false, error: 'Untrusted IPC sender.' }
    }
    try {
      const validated = validateRequest(method, params)
      const seconds = method === 'query.execute' ? (validated as RpcMethods['query.execute']['params']).timeoutSeconds : method === 'connections.connect' ? (validated as RpcMethods['connections.connect']['params']).advanced?.connectTimeout ?? 15 : undefined
      const timeout = seconds === undefined ? 45_000 : seconds === 0 ? 0 : (seconds + 30) * 1000
      const result = await backend.request(method as RpcMethod, validated as never, timeout)
      if (method === 'connections.connect') {
        try { await connectionStore.remember(validated as RpcMethods['connections.connect']['params']) }
        catch { (result as RpcMethods['connections.connect']['result']).historyWarning = 'Connected successfully, but recent connections could not be saved.' }
      }
      return { ok: true, value: result }
    } catch (error) { return { ok: false, error: errorMessage(error, 'Backend request failed.') } }
  })
  handle('varia:files-open', async () => {
    const selected = await dialog.showOpenDialog(mainWindow!, { title: 'Open SQL query', filters: [{ name: 'SQL files', extensions: ['sql'] }, { name: 'Text files', extensions: ['txt'] }], properties: ['openFile', 'multiSelections'] })
    if (selected.canceled) return []
    return Promise.all(selected.filePaths.map(path => files.read(path)))
  })
  handle('varia:files-save', async value => {
    const options = z.object({ fileId: z.uuid().optional(), name: z.string().min(1).max(512), content: z.string().max(maxSqlFileBytes), saveAs: z.boolean() }).strict().parse(value)
    let selectedPath: string | undefined
    if (!options.fileId || options.saveAs) {
      const safeName = basename(options.name.replace(/[\\/:*?"<>|]/g, '_'))
      const selection = await dialog.showSaveDialog(mainWindow!, { title: 'Save SQL query', defaultPath: options.fileId ? files.get(options.fileId).path : join(app.getPath('documents'), safeName), filters: [{ name: 'SQL files', extensions: ['sql'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] })
      if (selection.canceled || !selection.filePath) return null
      selectedPath = selection.filePath
    }
    return files.save(options.content, options.fileId, selectedPath)
  })
  handle('varia:files-release', value => { files.release(z.uuid().parse(value)) })
  handle('varia:confirm-close', async value => {
    const name = z.string().min(1).max(512).parse(value)
    const response = await dialog.showMessageBox(mainWindow!, { type: 'question', title: 'Unsaved query', message: `Save changes to ${name}?`, buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, noLink: true })
    return (['save', 'discard', 'cancel'] as const)[response.response]
  })
  ipcMain.handle('varia:close-window', event => {
    if (!trusted(event)) return
    closeApproved = true
    app.quit()
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { id: 'menu.file', label: 'File', submenu: [
      { id: 'file.new', label: 'New Query', accelerator: 'CmdOrCtrl+N', click: () => command('file.new') },
      { id: 'file.open', label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => command('file.open') },
      { id: 'file.save', label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => command('file.save') },
      { id: 'file.saveAs', label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => command('file.saveAs') },
      { type: 'separator' },
      { id: 'file.close', label: 'Close Query', accelerator: 'CmdOrCtrl+W', click: () => command('file.close') },
      { type: 'separator' }, { role: 'quit' }
    ] },
    { id: 'menu.edit', label: 'Edit', submenu: [
      { id: 'edit.undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => command('edit.undo') },
      { id: 'edit.redo', label: 'Redo', accelerator: process.platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Y', registerAccelerator: false, click: () => command('edit.redo') },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ] },
    { id: 'menu.view', label: 'View', submenu: [
      { id: 'layout.save', label: 'Save Layout…', click: () => command('layout.save') },
      { id: 'layout.load', label: 'Load Layout…', click: () => command('layout.load') },
      { id: 'layout.reset', label: 'Reset Layout', click: () => command('layout.reset') },
      { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }
    ] },
    { id: 'menu.window', label: 'Window', submenu: [
      { id: 'window.explorer', label: 'Object Explorer', click: () => command('window.explorer') },
      { id: 'window.editor', label: 'Query Editor', click: () => command('window.editor') },
      { id: 'window.output', label: 'Query Output', click: () => command('window.output') },
      { type: 'separator' },
      { label: 'Save Window Layout…', click: () => command('layout.save') },
      { label: 'Load Window Layout…', click: () => command('layout.load') },
      { label: 'Reset Window Layout', click: () => command('layout.reset') }
    ] }
  ]))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(error => { dialog.showErrorBox('Varia startup failed', error instanceof Error ? error.message : 'Unknown error'); app.quit() })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (!closeApproved && mainWindow && !mainWindow.isDestroyed() && rendererCanConfirm(mainWindow)) { event.preventDefault(); command('window.close') }
})
// A window can still cancel the quit (e.g. 'Wait' for a hung workbench), so the backend stops only once quitting is certain.
app.on('will-quit', () => { backend?.stop() })
