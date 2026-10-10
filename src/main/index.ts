import { app, BrowserWindow, clipboard, ipcMain, Menu, MessageChannelMain, dialog, nativeTheme, powerMonitor, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BackendSupervisor } from './backend/supervisor'
import { BackendError } from './backend/errors'
import { backendSpawnSpec } from './backend/spawn-spec'
import { installTestHooks } from './backend/test-hooks'
import { ResultsPortHost, supervisorResults } from './backend/results-port'
import { ExplorerRequests } from './backend/explorer-requests'
import { validateRequest } from './validation'
import { SqlFileStore, maxSqlFileBytes } from './sql-files'
import { LayoutStore } from './layout-store'
import { ConnectionStore } from './connection-store'
import { AppearanceService, windowChromeFor } from './appearance'
import { applicationMenuTemplate, type ApplicationMenuActions } from './application-menu'
import { NativeMenuBridge } from './native-menu'
import { runRole, UserActivation } from './window-roles'
import { ContextMenuPopups } from './context-menu'
import { menuStyleArgument, menuStyleFor } from '../shared/menu-style'
import { userInfo } from 'node:os'
import { connectionProfileInputSchema } from '../shared/connections'
import { parseWorkspaceLayout } from '../shared/layouts'
import type { ApiResult, QueryResult, RpcMethod, RpcMethods } from '../shared/contracts'
import { memoryEventSchema } from '../shared/ipc/port-messages'
import { explorerCancelParamsSchema } from '../shared/explorer/schema.ts'
import type { CommandId } from '../shared/commands/catalog'
import { sanitizeLabel } from '../shared/theme/format'
import type { ResolvedTheme, ThemeState } from '../shared/theme/types'

const here = dirname(fileURLToPath(import.meta.url))
const rendererFile = join(here, '../renderer/index.html')
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const maxClipboardText = 8_388_608
let mainWindow: BrowserWindow | null = null
let backend: BackendSupervisor
let resultsPort: ResultsPortHost | undefined
// Test seams (fake backend, liveness override, __variaTest, the renderer test-mode flag) exist only in unpackaged smoke runs.
const testSeams = process.env.VARIA_SMOKE_TEST === '1' && !app.isPackaged
const files = new SqlFileStore()
let closeApproved = false
/** The app is quitting (before-quit went ahead), so a closed window needs no new backend. */
let quitting = false
let backendStopped = false
// The title bar starts active, so a window that never gets OS focus (smoke tests) keeps the active colors.
let windowActive = true
// The user's last click or key press in the window: the page may run Paste only just after one.
let userActivation = new UserActivation()
let layouts: LayoutStore
let appearance: AppearanceService
// The palette's theme picker shows themes before one is chosen; the window chrome follows the shown theme.
let previewTheme: ResolvedTheme | null = null
let previewSeq = 0
// Renderer lifecycle: exit confirmation needs a live workbench that has subscribed to commands.
let rendererLoaded = false
let rendererReady = false
let rendererUnresponsive = false
// Native context menus on macOS; smoke tests may choose either style on any platform. Either condition shows one: a
// right-click on an inactive macOS window does not focus it but is input, and VoiceOver's VO+Shift+M is no input but
// comes from the focused window. Hidden smoke windows are never focused, so their menus need a click or key: no bypass.
const menuStyle = menuStyleFor(process.platform, process.env)
const contextMenus = new ContextMenuPopups<BrowserWindow>({
  style: menuStyle, platform: process.platform, userCanAct: () => !!mainWindow?.isFocused() || userActivation.recent(), build: template => Menu.buildFromTemplate(template)
})
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

/** A reloaded or crashed renderer can no longer address its sessions, so end them with the backend process. Without
 *  `relaunch` (the app is quitting) no new backend starts. */
function resetRendererState(relaunch = true): void {
  rendererReady = false
  menuBridge.reset()
  contextMenus.close()
  endPreview()
  resultsPort?.reset()
  void (relaunch ? backend?.restart('reload') : backend?.stop())
  files.clear()
}

/** Restarting closes every connection and rolls back open transactions, so main asks first when there are any. */
async function restartBackend(): Promise<boolean> {
  const count = backend.connectionCount()
  const window = mainWindow
  if (count > 0 && window && !window.isDestroyed()) {
    const { response } = await dialog.showMessageBox(window, { type: 'warning', title: 'Restart SQL backend', message: 'Restart the SQL backend?', detail: count === 1 ? 'The connection closes and uncommitted transactions are rolled back.' : `All ${count} connections close and uncommitted transactions are rolled back.`, buttons: ['Restart', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true })
    if (response !== 0) return false
  }
  await backend.restart('manual')
  return true
}

function rendererCanConfirm(window: BrowserWindow): boolean {
  return rendererReady && !rendererUnresponsive && !window.webContents.isCrashed()
}

const menuActions: ApplicationMenuActions = {
  command,
  isChecked: id => menuBridge.isChecked(id),
  pageHasKeyFocus: () => !!mainWindow?.isFocused() && !mainWindow.webContents.isDevToolsFocused(),
  sendActionToFirstResponder: action => Menu.sendActionToFirstResponder(action),
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
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: process.env.VARIA_SMOKE_TEST !== '1', additionalArguments: [menuStyleArgument(menuStyle), ...(testSeams ? ['--varia-test-mode'] : [])] }
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
  const activation = userActivation = new UserActivation()
  contents.on('input-event', (_event, input) => activation.note(input.type))
  // The page may write the clipboard but has no permission to read it: it reads only through the Paste role, which runs
  // within a second of a click or key, and its copies go through main. Every other permission stays denied.
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
  // will-navigate cancels navigation elsewhere, so only a same-URL main-frame navigation is a reload (View › Reload Window, the palette, or dev HMR).
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
    if (rendererUnresponsive && dialog.showMessageBoxSync(window, { type: 'warning', title: 'Workbench not responding', message: 'Close Varia SQL Manager?', detail: 'The workbench is not responding. Unsaved queries will be lost.', buttons: ['Close', 'Wait'], defaultId: 1, cancelId: 1, noLink: true }) !== 0) { quitting = false; event.preventDefault(); return }
    closeApproved = true
  })
  // A closed window can no longer address its sessions. Only macOS keeps the app running after its last window closes,
  // so only there does a later window need a new backend.
  window.on('closed', () => { mainWindow = null; resetRendererState(process.platform === 'darwin' && !quitting) })
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  const root = app.getAppPath()
  // Smoke tests shorten the silence that counts as unresponsive; PING then runs often enough for a healthy backend.
  const livenessMs = testSeams ? Number(process.env.VARIA_BACKEND_LIVENESS_MS) : NaN
  const liveness = Number.isInteger(livenessMs) && livenessMs >= 200 ? { unresponsiveMs: livenessMs, limits: { pingMs: Math.floor(livenessMs / 4) } } : {}
  backend = new BackendSupervisor(backendSpawnSpec({ packaged: app.isPackaged, root, resourcesPath: process.resourcesPath, platform: process.platform, smokeTest: process.env.VARIA_SMOKE_TEST === '1', env: process.env }), {
    appVersion: app.getVersion(),
    // Frame kinds, ids and lengths only; never bodies.
    trace: !app.isPackaged && process.env.VARIA_IPC_TRACE === '1' ? line => console.error(line) : undefined,
    power: powerMonitor,
    onGlobalEvent: event => {
      const memory = memoryEventSchema.safeParse(event)
      if (memory.success) resultsPort?.memory(memory.data.usedBytes, memory.data.globalBytes)
    },
    ...liveness
  })
  const results = resultsPort = new ResultsPortHost({ backend: supervisorResults(backend), createChannel: () => new MessageChannelMain() })
  const explorerRequests = new ExplorerRequests(backend)
  backend.onState(state => {
    results.backendState(state)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('varia:backend-state', state)
  })
  if (testSeams) installTestHooks(backend, results)
  backend.start()
  layouts = new LayoutStore(join(app.getPath('userData'), 'workspace-layouts.json'))
  const connectionStore = new ConnectionStore(join(app.getPath('userData'), 'connections.json'))
  // The window's first paint uses the chosen theme; initialize() gives up waiting after 1.5 s and applies late results live.
  appearance = new AppearanceService({ userData: app.getPath('userData'), nativeTheme })
  await appearance.initialize()
  appearance.onDidChange(applyAppearance)
  nativeTheme.on('updated', () => appearance.systemChanged())
  handle('varia:backend-state-get', () => backend.state)
  handle('varia:backend-restart', () => restartBackend())
  // The port reaches only the trusted main frame; its messages are validated by ResultsPortHost.
  ipcMain.handle('varia:results-port-open', (event): ApiResult<void> => {
    if (!trusted(event) || !event.senderFrame) return { ok: false, error: 'Untrusted IPC sender.' }
    try { results.open(event.senderFrame); return { ok: true, value: undefined } }
    catch (error) { return { ok: false, error: errorMessage(error, 'The results connection could not be opened.') } }
  })
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
  // Paste needs the focused window (smoke-test windows are hidden, so never focused) and a click or key just before.
  handle('varia:run-role', value => {
    const window = mainWindow
    if (window) runRole(value, window, () => (window.isFocused() || process.env.VARIA_SMOKE_TEST === '1') && userActivation.recent())
  })
  handle('varia:context-menu', value => { if (!mainWindow) throw new Error('The window is unavailable.'); return contextMenus.show(value, mainWindow) })
  ipcMain.handle('varia:request', async (event, method: string, params: unknown): Promise<ApiResult<unknown>> => {
    if (!trusted(event)) {
      return { ok: false, error: 'Untrusted IPC sender.' }
    }
    try {
      const validated = validateRequest(method, params)
      // A script's events reach the results worker; its results become readable by this renderer.
      const queryId = method === 'query.execute' ? (validated as RpcMethods['query.execute']['params']).queryId : undefined
      // An Object Explorer load is registered before it is sent, so varia:explorer-cancel can always find it.
      const load = method === 'explorer.children' ? explorerRequests.begin((validated as RpcMethods['explorer.children']['params']).requestId) : undefined
      let result: unknown
      try {
        result = await backend.request(method as RpcMethod, validated as never, queryId !== undefined ? { onEvent: queryEvent => results.queryEvent(queryId, queryEvent) } : load ? { onSent: load.sent } : {})
      } finally { load?.end() }
      if (queryId !== undefined) results.own((result as QueryResult).resultSets)
      if (method === 'connections.connect') {
        try { await connectionStore.remember(validated as RpcMethods['connections.connect']['params']) }
        catch { (result as RpcMethods['connections.connect']['result']).historyWarning = 'Connected successfully, but recent connections could not be saved.' }
      }
      return { ok: true, value: result }
    } catch (error) { return { ok: false, error: errorMessage(error, 'Backend request failed.'), ...(error instanceof BackendError ? { code: error.code } : {}) } }
  })
  handle('varia:explorer-cancel', value => ({ cancelled: explorerRequests.cancel(explorerCancelParamsSchema.parse(value).requestIds) }))
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
  // Write only (the page's one path to clipboard contents is the Paste role, gated above); the length is bounded like
  // a full results grid copy.
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
  if (!closeApproved && mainWindow && !mainWindow.isDestroyed() && rendererCanConfirm(mainWindow)) { event.preventDefault(); command('window.close'); return }
  quitting = true
})
// A window can still cancel the quit (e.g. 'Wait' for a hung workbench), so the backend stops only once quitting is
// certain. Electron exits as soon as will-quit returns, so the exit waits for the bounded stop (stdin end, 2 s, then
// kill): a backend that cannot act on EOF would otherwise outlive the app, holding its sessions and their locks.
app.on('will-quit', event => {
  if (backendStopped || !backend) return
  event.preventDefault()
  // Every window is closed: a relaunch during the wait must start a new instance, not be handed to this one and dropped.
  app.releaseSingleInstanceLock()
  void backend.stop().finally(() => { backendStopped = true; app.exit(0) })
})
