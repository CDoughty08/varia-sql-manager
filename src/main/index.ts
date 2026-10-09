import { app, BrowserWindow, clipboard, ipcMain, Menu, dialog, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BackendClient } from './backend-client'
import { validateRequest } from './validation'
import { SqlFileStore, maxSqlFileBytes } from './sql-files'
import { LayoutStore } from './layout-store'
import { ConnectionStore } from './connection-store'
import { AppearanceService, windowChromeFor } from './appearance'
import { applicationMenuTemplate, type ApplicationMenuActions } from './application-menu'
import { NativeMenuBridge } from './native-menu'
import { runRole } from './window-roles'
import { ContextMenuPopups } from './context-menu'
import { menuStyleArgument, menuStyleFor } from '../shared/menu-style'
import { userInfo } from 'node:os'
import { connectionProfileInputSchema } from '../shared/connections'
import { parseWorkspaceLayout } from '../shared/layouts'
import type { ApiResult, RpcMethod, RpcMethods } from '../shared/contracts'
import type { CommandId } from '../shared/commands/catalog'
import { sanitizeLabel } from '../shared/theme/format'
import type { ResolvedTheme, ThemeState } from '../shared/theme/types'

const here = dirname(fileURLToPath(import.meta.url))
const rendererFile = join(here, '../renderer/index.html')
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const maxClipboardText = 8_388_608
let mainWindow: BrowserWindow | null = null
let backend: BackendClient
const files = new SqlFileStore()
let closeApproved = false
// The title bar starts active, so a window that never gets OS focus (smoke tests) keeps the active colors.
let windowActive = true
let layouts: LayoutStore
let appearance: AppearanceService
// The palette's theme picker shows themes before one is chosen; the window chrome follows the shown theme.
let previewTheme: ResolvedTheme | null = null
let previewSeq = 0
// Renderer lifecycle: exit confirmation needs a live workbench that has subscribed to commands.
let rendererLoaded = false
let rendererReady = false
let rendererUnresponsive = false
// Native context menus on macOS; smoke tests may choose either style on any platform.
const menuStyle = menuStyleFor(process.platform, process.env)
const contextMenus = new ContextMenuPopups<BrowserWindow>({ style: menuStyle, platform: process.platform, build: template => Menu.buildFromTemplate(template) })
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

// Ids come from main's compiled catalogue; the renderer checks them again before executing.
function command(id: CommandId): void { mainWindow?.webContents.send('varia:command', id) }

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
  menuBridge.reset()
  contextMenus.close()
  endPreview()
  backend?.restart()
  files.clear()
}

function rendererCanConfirm(window: BrowserWindow): boolean {
  return rendererReady && !rendererUnresponsive && !window.webContents.isCrashed()
}

const menuActions: ApplicationMenuActions = {
  command,
  isChecked: id => menuBridge.isChecked(id),
  // A failed choice leaves Electron's radio item checked, so the menu is rebuilt from the unchanged state.
  setTheme: patch => { chooseTheme(patch).catch(error => { void appearance.notify(errorMessage(error, 'The theme could not be changed.')); buildMenu() }) },
  // The menu has no other way to report a failure, so it becomes the theme notice; the messages are fixed sentences.
  createTheme: () => {
    appearance.createStarterTheme().then(path => shell.showItemInFolder(path), error => { void appearance.notify(errorMessage(error, 'The custom theme could not be created.')) })
  },
  openThemesFolder: () => { openThemesFolder().catch(error => { void appearance.notify(errorMessage(error, 'The themes folder could not be opened.')) }) },
  reloadThemes: () => { void appearance.reload() }
}

// The renderer owns enablement and checkboxes; it sends them on varia:menu-state and every rebuild re-applies them.
const menuBridge = new NativeMenuBridge({
  build: () => Menu.buildFromTemplate(applicationMenuTemplate({ theme: appearance.state }, menuActions, process.platform)),
  install: menu => Menu.setApplicationMenu(menu)
})

function buildMenu(): void {
  menuBridge.rebuild()
}

/** Shared by the menu and the notice's button; the notice shows the IPC error itself, so only the menu notifies. */
async function openThemesFolder(): Promise<void> {
  const failure = await shell.openPath(await appearance.ensureFolder())
  if (failure) throw new Error('The themes folder could not be opened: ' + sanitizeLabel(failure, 200))
}

function applyWindowChrome(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  const chrome = windowChromeFor(previewTheme ?? appearance.state.active, { active: windowActive })
  window.setBackgroundColor(chrome.backgroundColor)
  if (process.platform !== 'darwin') {
    try { window.setTitleBarOverlay(chrome.overlay) } catch { /* Cosmetic; some window managers reject overlay updates. */ }
  }
}

/** Drops any preview, including one still being resolved, and shows the active theme's chrome again. */
function endPreview(): void {
  previewSeq++
  if (!previewTheme) return
  previewTheme = null
  applyWindowChrome()
}

/** A choice ends the preview only once it has applied, so the chrome never flashes the previous theme in between. */
async function chooseTheme(value: unknown): Promise<ThemeState> {
  previewSeq++
  try { return await appearance.setPreference(value) } finally { endPreview() }
}

/** Native chrome, the renderer, and the menu follow every published theme state; nothing reloads. */
function applyAppearance(state: ThemeState): void {
  applyWindowChrome()
  const window = mainWindow
  if (window && !window.isDestroyed()) window.webContents.send('varia:theme-changed', state)
  buildMenu()
}

function createWindow(): void {
  // Lifecycle state belongs to one window; on macOS a forced close keeps the app running for the next window.
  closeApproved = false
  windowActive = true
  rendererLoaded = false
  rendererReady = false
  rendererUnresponsive = false
  const chrome = appearance.windowChrome()
  mainWindow = new BrowserWindow({
    title: 'Varia SQL Manager', width: 1440, height: 960, minWidth: 1024, minHeight: 700,
    backgroundColor: chrome.backgroundColor, show: process.env.VARIA_SMOKE_TEST !== '1',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 10 } } : { titleBarOverlay: { ...chrome.overlay, height: 34 } }),
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: process.env.VARIA_SMOKE_TEST !== '1', additionalArguments: [menuStyleArgument(menuStyle)] }
  })
  const window = mainWindow, contents = window.webContents
  if (process.platform !== 'darwin') {
    // The application menu stays hidden: the renderer draws the title-bar menus and handles F10 and Alt itself.
    mainWindow.setAutoHideMenuBar(false)
    mainWindow.setMenuBarVisibility(false)
    const activate = (active: boolean) => { windowActive = active; applyWindowChrome() }
    window.on('focus', () => activate(true))
    window.on('blur', () => activate(false))
  }
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', event => event.preventDefault())
  // The page never reads the clipboard (Paste is Electron's role, and copies the renderer makes go through main); every other permission stays denied.
  contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(requester === mainWindow?.webContents && 'isMainFrame' in details && details.isMainFrame && permission === 'clipboard-sanitized-write')
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

app.whenReady().then(async () => {
  if (!primaryInstance) return
  const root = app.getAppPath()
  backend = app.isPackaged
    ? new BackendClient(join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'Varia.Backend.exe' : 'Varia.Backend'), [], root)
    : new BackendClient('dotnet', [join(root, 'backend/Varia.Backend/bin', process.env.VARIA_SMOKE_TEST === '1' ? 'Release' : 'Debug', 'net10.0/Varia.Backend.dll')], root)
  backend.start()
  layouts = new LayoutStore(join(app.getPath('userData'), 'workspace-layouts.json'))
  const connectionStore = new ConnectionStore(join(app.getPath('userData'), 'connections.json'))
  // The window's first paint uses the chosen theme; initialize() gives up waiting after 1.5 s and applies late results live.
  appearance = new AppearanceService({ userData: app.getPath('userData'), nativeTheme })
  await appearance.initialize()
  appearance.onDidChange(applyAppearance)
  nativeTheme.on('updated', () => appearance.systemChanged())
  handle('varia:theme-state', () => appearance.state)
  handle('varia:theme-set', value => chooseTheme(value))
  // Results that arrive after a later preview, a choice, or a renderer reset are dropped.
  handle('varia:theme-preview', async value => {
    const seq = ++previewSeq
    const theme = await appearance.preview(value)
    if (seq === previewSeq) { previewTheme = theme; applyWindowChrome() }
    return theme
  })
  handle('varia:themes-reload', () => appearance.reload())
  handle('varia:themes-open-folder', () => openThemesFolder())
  handle('varia:themes-create', async () => { shell.showItemInFolder(await appearance.createStarterTheme()) })
  ipcMain.on('varia:commands-ready', (event, ready: unknown) => { if (trusted(event)) rendererReady = ready === true })
  // Invalid payloads are dropped: the menu keeps its last valid state, and every command re-checks enablement when it runs.
  ipcMain.on('varia:menu-state', (event, state: unknown) => { if (trusted(event)) menuBridge.applyState(state) })
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
  // Custom menus and the palette run Electron's roles on the trusted window: a fixed set of window methods, never quit.
  handle('varia:run-role', value => { if (mainWindow) runRole(value, mainWindow) })
  handle('varia:context-menu', value => { if (!mainWindow) throw new Error('The window is unavailable.'); return contextMenus.show(value, mainWindow) })
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
  handle('varia:files-reveal', value => { shell.showItemInFolder(files.get(z.uuid().parse(value)).path) })
  // Write only: there is no clipboard read, and the length is bounded like a full results grid copy.
  handle('varia:clipboard-write', value => { clipboard.writeText(z.string().max(maxClipboardText).parse(value)) })
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
  buildMenu()
  createWindow()
  // The full catalogue only feeds the menu, so it loads after the window is on its way.
  void appearance.scan()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(error => { dialog.showErrorBox('Varia startup failed', error instanceof Error ? error.message : 'Unknown error'); app.quit() })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (!closeApproved && mainWindow && !mainWindow.isDestroyed() && rendererCanConfirm(mainWindow)) { event.preventDefault(); command('window.close') }
})
// A window can still cancel the quit (e.g. 'Wait' for a hung workbench), so the backend stops only once quitting is certain.
app.on('will-quit', () => { backend?.stop() })
