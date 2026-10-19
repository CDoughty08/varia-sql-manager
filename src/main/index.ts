import { app, BrowserWindow, clipboard, ipcMain, Menu, MessageChannelMain, dialog, nativeTheme, powerMonitor, shell, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from 'electron'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BackendSupervisor } from './backend/supervisor'
import { BackendError } from './backend/errors'
import { backendSpawnSpec } from './backend/spawn-spec'
import { installTestHooks, type BackendTestHooks, type RendererLossSource } from './backend/test-hooks'
import { ResultsPortHost, supervisorResults } from './backend/results-port'
import { ExplorerRequests } from './backend/explorer-requests'
import { ResultsJobHost, supervisorJobs } from './results-jobs'
import { ScriptingRequests } from './backend/scripting-requests'
import { dialogQueue } from './dialog-queue'
import { sanitizeFileName } from './file-names'
import { validateRequest, validateResult } from './validation'
import { SqlFileStore, fileKinds, reloadPromptSchema, saveDocument, saveFileSchema } from './sql-files'
import { openRecentEntry, RecentFilesStore, systemRecentDocuments } from './recent-files-store'
import { deliverLaunchFiles as deliverWaiting, droppedPathsSchema, fileArguments, LaunchQueue, maxLaunchFiles, secondInstanceSchema, type SecondInstanceData } from './launch-files'
import { recentFilesMenuModel } from '../shared/files/recent'
import { legacyCodePage } from './text-encoding'
import { LayoutStore } from './layout-store'
import { ConnectionStore } from './connection-store'
import { SettingsStore } from './settings-store'
import { RecoveryStore, recoveryDiscardSchema, recoveryTakeSchema, recoveryWriteSchema, retentionDays } from './recovery-store'
import { lossDetails } from '../shared/files/recovery'
import { commandTitle } from '../shared/settings/catalog'
import { AppearanceService, windowChromeFor } from './appearance'
import { applicationMenuTemplate, type ApplicationMenuActions } from './application-menu'
import { NativeMenuBridge } from './native-menu'
import { runRole, UserActivation } from './window-roles'
import { closeAction, mergeCloseIntent, type CloseIntent } from './close-intent'
import { processAlive, RendererWatchdog } from './renderer-watchdog'
import { ContextMenuPopups } from './context-menu'
import { menuStyleArgument, menuStyleFor } from '../shared/menu-style'
import { contentSecurityPolicy } from '../shared/csp'
import { userInfo } from 'node:os'
import { connectionProfileInputSchema } from '../shared/connections'
import { parseWorkspaceLayout } from '../shared/layouts'
import { sessionPrompt, sessionPromptRequestSchema } from '../shared/sessions'
import type { ApiResult, OpenedFiles, OpenSqlFile, QueryResult, RecoveredDocument, ReloadAnswer, RpcMethod, RpcMethods } from '../shared/contracts'
import { memoryEventSchema } from '../shared/ipc/port-messages'
import { explorerCancelParamsSchema } from '../shared/explorer/schema.ts'
import { scriptCancelSchema } from '../shared/scripting/schema.ts'
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
let resultsJobs: ResultsJobHost | undefined
// Test seams (fake backend, liveness override, __variaTest, the renderer test-mode flag) exist only in unpackaged smoke runs.
const testSeams = process.env.VARIA_SMOKE_TEST === '1' && !app.isPackaged
let testHooks: BackendTestHooks | undefined
// How long a reload waits for Chromium to see a renderer only the watchdog saw go before the page gets a new window.
const lostRendererGraceMs = 5000
// The ANSI code page is read when a file needs it: the system locale is known only once the app is ready.
const files = new SqlFileStore({ legacyLabel: () => legacyCodePage(app.getSystemLocale()) })
// Main's file dialogs and prompts, one at a time: a dialog asked for while another is open waits for it. A renderer reset
// drops those not yet shown, and `rendererGeneration` tells a handler whose dialog was open then that its page is gone.
const oneDialog = dialogQueue()
let rendererGeneration = 0
// The generation of the page the main frame shows. A reload's reset moves `rendererGeneration` as navigation starts, but
// the page being replaced runs until the next one commits, and what it sends then (an AutoRecover write) is still its own.
let pageGeneration = 0
// Restart SQL Backend while one is pending (a double-click on the banner's Restart) shares it.
let restarting: Promise<boolean> | undefined
// The answer to "Workbench not responding", while it waits or shows; repeated closes share it.
let unresponsivePrompt: Promise<void> | undefined
// The user chose Reload in the reload prompt: the next unload is allowed.
let reloadApproved = false
let closeApproved = false
// Main asked the page to close (a quit or the window's close button) and the page has not said that its close ended
// without closing. A page that reloads or crashes first cannot finish it, so it goes to the next page.
let closePending = false
// Whether that close is a quit or only the window's (which on macOS leaves the app running).
let closeIntent: CloseIntent | undefined
/** The app is quitting (before-quit went ahead), so a closed window needs no new backend. */
let quitting = false
let backendStopped = false
// The title bar starts active, so a window that never gets OS focus (smoke tests) keeps the active colors.
let windowActive = true
// The user's last click or key press in the window: the page may run Paste only just after one.
let userActivation = new UserActivation()
let layouts: LayoutStore
let appearance: AppearanceService
// Tests use their own profile so layout checks never modify the user's workspace preferences.
if (process.env.VARIA_SMOKE_TEST === '1' && process.env.VARIA_TEST_USER_DATA) app.setPath('userData', process.env.VARIA_TEST_USER_DATA)
// Tools › Options. Constructing it reads nothing; code that acts on a value awaits load(), and current() is for menu titles.
const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), join(app.getPath('userData'), 'scripting-options.json'))
// File › Recent Files. macOS's Dock menu follows it, except in smoke runs, which must not add to the user's.
const systemRecent = process.env.VARIA_SMOKE_TEST === '1' ? undefined : systemRecentDocuments(process.platform, app)
const recent = new RecentFilesStore(join(app.getPath('userData'), 'recent-files.json'), systemRecent ? { system: systemRecent } : {})
// AutoRecover's copies of unsaved queries, user-only, in the profile; see recovery-store.ts.
const recovery = new RecoveryStore(join(app.getPath('userData'), 'AutoRecover'))
/** The crash, hang and reload prompts' details for `generation`'s page: AutoRecover's wording once it kept that page's
 *  queries. A page has records only after a write, which waited for settings, so `current()` holds the loaded values. */
function lossDetailsFor(generation: number) {
  const values = settings.current()
  return lossDetails({ enabled: values['environment.autoRecover.enabled'], minutes: values['environment.autoRecover.intervalMinutes'], saved: recovery.hasRecords(generation) })
}
/** A command's title with its setting filled in (Select Top <n> Rows), from validated settings only. */
const menuTitle = (id: CommandId, title: string) => commandTitle(id, settings.current(), title)
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
  style: menuStyle, platform: process.platform, userCanAct: () => !!mainWindow?.isFocused() || userActivation.recent(), build: template => Menu.buildFromTemplate(template),
  title: (id, title) => menuTitle(id, title)
})
// Files named on the command line, from a second instance, by macOS (open-file) or by a drop, until the page takes them.
const launchFiles = new LaunchQueue()
const commandLineFiles = (argv: readonly string[], cwd: string) => fileArguments(argv, { cwd, defaultApp: !!process.defaultApp })
const ownFiles = commandLineFiles(process.argv, process.cwd())
launchFiles.add(ownFiles)
// A second instance would overwrite this instance's layouts and connection library, so it hands its files to this one
// as additional data (which Chromium passes on as it was, while it may reorder the command line) and quits.
const primaryInstance = app.requestSingleInstanceLock({ files: ownFiles } satisfies SecondInstanceData)
if (!primaryInstance) app.quit()
app.on('second-instance', (_event, argv, workingDirectory, data) => {
  const handed = secondInstanceSchema.safeParse(data)
  launchFiles.add(handed.success ? handed.data.files : commandLineFiles(argv, workingDirectory))
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  deliverLaunchFiles()
})
// macOS opens documents through the app (a double-click in Finder, a drop on the Dock icon), even before it is ready.
let started = false
app.on('open-file', (event, path) => {
  event.preventDefault()
  launchFiles.add([path])
  if (started && !mainWindow) createWindow()
  else deliverLaunchFiles()
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

/** A backend failure keeps its code and, for a failed connection, its details (never the connection string or password). */
function failure(error: unknown, fallback: string): ApiResult<never> {
  if (!(error instanceof BackendError)) return { ok: false, error: errorMessage(error, fallback) }
  return { ok: false, error: errorMessage(error, fallback), code: error.code, ...(error.details ? { details: error.details } : {}) }
}

function handle<T>(channel: string, action: (value: unknown) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, value: unknown): Promise<ApiResult<T>> => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC sender.' }
    try { return { ok: true, value: await action(value) } }
    catch (error) { return failure(error, 'The operation failed.') }
  })
}

/** A reloaded or crashed renderer can no longer address its sessions, so end them with the backend process. Without
 *  `relaunch` (the app is quitting) no new backend starts. */
function resetRendererState(relaunch = true): void {
  rendererReady = false
  reloadApproved = false
  rendererGeneration++
  oneDialog.reset()
  menuBridge.reset()
  contextMenus.close()
  endPreview()
  resultsPort?.reset()
  resultsJobs?.reset()
  void (relaunch ? backend?.restart('reload') : backend?.stop())
  files.clear()
}

/** A dialog the page asked for, on the window, in turn. If the page reloads or crashes before the user answers, the
 *  answer is `cancelled`: that page is gone, and what it asked for must not happen for the next one. A message box is
 *  `abortable`: it gets a signal, and the reset closes it then, so the crash prompt and the next page's dialogs do not
 *  wait behind it (a file chooser cannot be closed from main). */
function pageDialog<T>(show: (window: BrowserWindow, signal?: AbortSignal) => Promise<T>, cancelled: T, abortable = false): Promise<T> {
  const asked = rendererGeneration
  return oneDialog(signal => mainWindow && !mainWindow.isDestroyed() ? show(mainWindow, signal) : Promise.resolve(cancelled), cancelled, abortable)
    .then(answer => asked === rendererGeneration ? answer : cancelled)
}

/** Visual Studio's Save of Read-Only File, for a plain Save. Cancel, and a page that reloads meanwhile, save nothing. */
async function askReadOnly(path: string): Promise<'saveAs' | 'overwrite' | 'cancel'> {
  const { response } = await pageDialog((window, signal) => dialog.showMessageBox(window, {
    type: 'warning', title: 'Save of Read-Only File', message: `The file ${path} cannot be saved because it is write-protected.`,
    detail: 'You can either save the file in a different location or Varia SQL Manager can attempt to remove the write-protection and overwrite the file in its current location.',
    buttons: ['Save As…', 'Overwrite', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true, signal
  }), { response: 2, checkboxChecked: false }, true)
  return response === 0 ? 'saveAs' : response === 1 ? 'overwrite' : 'cancel'
}

/** A file read in the ANSI code page is saved only as Unicode, and only once the user agrees. */
async function askUnicode(name: string, codePage: string): Promise<boolean> {
  const { response } = await pageDialog((window, signal) => dialog.showMessageBox(window, {
    type: 'question', title: 'Save as Unicode', message: `${name} was read as ${codePage}.`,
    detail: 'Varia SQL Manager saves only Unicode. Save it as UTF-8 with a byte order mark, which SSMS and other tools read correctly?',
    buttons: ['Save as UTF-8', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true, signal
  }), { response: 1, checkboxChecked: false }, true)
  return response === 0
}

/** File changed, before a Save replaces a change another program made to the file. */
async function askChanged(path: string): Promise<boolean> {
  const { response } = await pageDialog((window, signal) => dialog.showMessageBox(window, {
    type: 'warning', title: 'File changed', message: `The file ${path} was changed outside Varia SQL Manager.`, detail: 'Saving replaces those changes with this query.',
    buttons: ['Save', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, signal
  }), { response: 1, checkboxChecked: false }, true)
  return response === 0
}

/** Why a file did not open, in a sentence rather than the system's wording, which repeats the path. */
function openError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' ? 'The file does not exist.' : code === 'EACCES' || code === 'EPERM' ? 'Access to the file was denied.' : errorMessage(error, 'The file could not be opened.')
}

/**
 * Reads and registers files main was handed, never ones the page named: absolute paths to regular files, folders
 * skipped without a word, and each opened file put first in Recent Files. What fails is reported as "name: reason".
 */
async function openPaths(paths: readonly string[]): Promise<OpenedFiles> {
  const opened: OpenSqlFile[] = [], errors: string[] = []
  for (const path of paths.slice(0, maxLaunchFiles)) {
    try {
      const file = await openPath(path)
      if (file) opened.push(file)
    } catch (error) { errors.push(openFailure(path, error)) }
  }
  return { files: opened, errors }
}
/** One file main was handed, read as Open reads it and put first in Recent Files; undefined for a folder. */
async function openPath(path: string): Promise<OpenSqlFile | undefined> {
  if (!isAbsolute(path)) throw new Error('The path is not absolute.')
  if ((await stat(path)).isDirectory()) return undefined
  const file = await files.read(path)
  void recent.add(file.path).catch(() => {})
  return file
}
const openFailure = (path: string, error: unknown) => `${basename(path)}: ${openError(error)}`.slice(0, 600)

function sendOpened(opened: OpenedFiles): void {
  if (mainWindow && !mainWindow.isDestroyed() && (opened.files.length || opened.errors.length)) mainWindow.webContents.send('varia:files-opened', opened)
}

/** Opens the files waiting for the page, once it is ready. */
function deliverLaunchFiles(): void {
  deliverWaiting(launchFiles, { ready: () => rendererReady && !!mainWindow, generation: () => rendererGeneration, open: openPaths, send: sendOpened })
}

/** Items shown in recently used file lists; the default while settings.json cannot be read. */
const recentCount = async () => (await settings.load().catch(() => ({ values: settings.current() }))).values['environment.recentFiles.count']
async function recentFiles() {
  await recent.load()
  return recent.list(await recentCount())
}
function publishRecentFiles(): void {
  void recentFiles().then(list => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('varia:recent-files-changed', list) }, () => {})
}
/** A Recent Files entry: opened as an Open would; a file that is gone offers to leave the list, and any other failure says why. */
function openRecent(id: string): Promise<OpenedFiles> {
  return openRecentEntry(recent, id, {
    open: openPath, describe: openFailure,
    askRemove: async path => (await pageDialog((window, signal) => dialog.showMessageBox(window, {
      type: 'warning', title: 'Recent Files', message: `${basename(path)} cannot be opened.`, detail: `${path} no longer exists. Remove it from the Recent Files list?`,
      buttons: ['Remove', 'Keep'], defaultId: 0, cancelId: 1, noLink: true, signal
    }), { response: 1, checkboxChecked: false }, true)).response === 0
  })
}

/** Asks the page to close, as the window's close button and a quit do; the request outlives a reload or crash. */
function requestClose(intent: CloseIntent): void {
  closePending = true
  closeIntent = mergeCloseIntent(closeIntent, intent)
  command('window.close')
}

/** Restarting closes every connection and rolls back open transactions, so main asks first when there are any. The
 *  connections are counted when the prompt's turn comes (another dialog may be open first), and a request made while
 *  one is pending shares its answer, so a double-click restarts once. */
function restartBackend(): Promise<boolean> {
  restarting ??= (async () => {
    try {
      if (backend.connectionCount() > 0) {
        const { response } = await pageDialog((window, signal) => {
          const count = backend.connectionCount()
          return count === 0 ? Promise.resolve({ response: 0 }) : dialog.showMessageBox(window, { type: 'warning', title: 'Restart SQL backend', message: 'Restart the SQL backend?', detail: count === 1 ? 'The connection closes and uncommitted transactions are rolled back.' : `All ${count} connections close and uncommitted transactions are rolled back.`, buttons: ['Restart', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, signal })
        }, { response: 1 }, true)
        if (response !== 0) return false
      }
      await backend.restart('manual')
      return true
    } finally { restarting = undefined }
  })()
  return restarting
}

/** Closing while the workbench does not respond skips its unsaved-query prompts, so main asks first, after any open
 *  dialog. A workbench that recovered by then is asked to close as usual instead. Close goes on with a quit if one was
 *  under way. */
function confirmUnresponsiveClose(window: BrowserWindow, quit: boolean): void {
  unresponsivePrompt ??= oneDialog(async () => window.isDestroyed() ? { response: 1 } : !rendererUnresponsive ? { response: -1 }
    : dialog.showMessageBox(window, { type: 'warning', title: 'Workbench not responding', message: 'Close Varia SQL Manager?', detail: lossDetailsFor(pageGeneration).unresponsive, buttons: ['Close', 'Wait'], defaultId: 1, cancelId: 1, noLink: true }),
  { response: 1 }).then(({ response }) => {
    if (window.isDestroyed() || response === 1) return
    if (response === 0) closeApproved = true
    if (quit) app.quit()
    else window.close()
  }, () => {}).finally(() => { unresponsivePrompt = undefined })
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
  reloadThemes: () => { void appearance.reload() },
  // The macOS menu bar's Recent Files: main opens the file and hands it to the page, as it does a drop.
  openRecent: id => { if (rendererReady) openRecent(id).then(sendOpened, error => sendOpened({ files: [], errors: [errorMessage(error, 'The file could not be opened.')] })) },
  clearRecent: () => { void recent.clear().catch(() => {}) }
}

// The renderer owns enablement and checkboxes; it sends them on varia:menu-state and every rebuild re-applies them.
const menuBridge = new NativeMenuBridge({
  build: () => Menu.buildFromTemplate(applicationMenuTemplate({
    theme: appearance.state, title: menuTitle, recentFiles: recentFilesMenuModel(recent.list(settings.current()['environment.recentFiles.count']), process.platform)
  }, menuActions, process.platform)),
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

/** `bounds` and `maximized` place a window that replaces one whose renderer was lost. */
function createWindow(place: { bounds?: Rectangle; maximized?: boolean } = {}): void {
  // Lifecycle state belongs to one window; on macOS a forced close keeps the app running for the next window.
  closeApproved = false
  closePending = false
  closeIntent = undefined
  windowActive = true
  rendererLoaded = false
  rendererReady = false
  rendererUnresponsive = false
  const chrome = appearance.windowChrome()
  mainWindow = new BrowserWindow({
    title: 'Varia SQL Manager', width: 1440, height: 960, ...place.bounds, minWidth: 1024, minHeight: 700,
    backgroundColor: chrome.backgroundColor, show: process.env.VARIA_SMOKE_TEST !== '1',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 10 } } : { titleBarOverlay: { ...chrome.overlay, height: 34 } }),
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: process.env.VARIA_SMOKE_TEST !== '1', additionalArguments: [menuStyleArgument(menuStyle), ...(testSeams ? ['--varia-test-mode'] : [])],
      // Every build has developer tools, as VS Code does; the page keeps its sandbox, isolation and CSP under them.
      devTools: true }
  })
  const window = mainWindow, contents = window.webContents
  if (place.maximized) window.maximize()
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
  // Production pages also carry this policy in a <meta> (electron.vite.config.ts).
  const policy = contentSecurityPolicy(developmentUrl)
  contents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } })
  })
  contents.on('did-finish-load', () => { rendererLoaded = true })
  // will-navigate cancels navigation elsewhere, so only a same-URL main-frame navigation is a reload (View › Reload Window, the palette, or dev HMR).
  contents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument && rendererLoaded && details.url === contents.getURL()) resetRendererState()
  })
  contents.on('did-navigate', () => { pageGeneration = rendererGeneration })
  // The renderer blocks unload only while queries are unsaved or servers are connected. This reload waits; the prompt
  // takes its turn after any open dialog, and Reload starts it again, allowed this time.
  contents.on('will-prevent-unload', event => {
    if (closeApproved || reloadApproved) { reloadApproved = false; event.preventDefault(); return }
    const generation = rendererGeneration
    void oneDialog(signal => window.isDestroyed() ? Promise.resolve({ response: 1 }) : dialog.showMessageBox(window, { type: 'warning', title: 'Reload workbench', message: 'Reload Varia SQL Manager?', detail: lossDetailsFor(pageGeneration).reload, buttons: ['Reload', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, signal }),
      { response: 1 }, true).then(({ response }) => {
      if (response !== 0 || window.isDestroyed() || generation !== rendererGeneration) return
      reloadApproved = true
      // Once the page has finished cancelling this unload (a round trip to it): a reload asked for before then is dropped.
      void contents.executeJavaScript('0').catch(() => {}).then(() => { if (!window.isDestroyed() && generation === rendererGeneration) contents.reload() })
    }, () => {})
  })
  // A lost renderer, from Chromium's report or the watchdog's (when Chromium cannot see it go), is handled once; the
  // next page's navigation starts a new renderer to watch. The prompt waits for any open dialog (a Save dialog the page
  // asked for just before it stopped); the reset drops those it asked for that were not shown yet.
  let rendererLost = false
  const lost = (source: RendererLossSource) => {
    // A window that is closing loses its renderer on purpose.
    const handled = !rendererLost && !window.isDestroyed() && !(source === 'watchdog' && (closeApproved || quitting))
    testHooks?.rendererLoss(source, handled)
    if (!handled) return
    rendererLost = true
    // This reset is the crash's: the reload that follows must not reset (restart the backend) again. It would spawn the
    // backend while Chromium launches the new renderer, and on Windows the backend then inherits that renderer's channel
    // handle, so Chromium never sees the new renderer die and its crash leaves the window frozen.
    rendererLoaded = false
    const lostPage = pageGeneration
    resetRendererState()
    void oneDialog(() => window.isDestroyed() ? Promise.resolve({ response: -1 }) : dialog.showMessageBox(window, { type: 'error', title: 'Workbench stopped', message: 'The workbench stopped unexpectedly.', detail: lossDetailsFor(lostPage).stopped, buttons: ['Reload', 'Close'], defaultId: 0, cancelId: 1, noLink: true }),
      { response: -1 }).then(({ response }) => {
      if (window.isDestroyed()) return
      if (response === 0) reloadLostRenderer(window)
      else if (response === 1) { closeApproved = true; window.close() }
    }, () => {})
  }
  contents.on('render-process-gone', (_event, details) => { if (details.reason !== 'clean-exit') lost('event') })
  const watchdog = new RendererWatchdog(contents, { alive: processAlive, gone: () => lost('watchdog') })
  contents.on('did-start-navigation', details => {
    if (!details.isMainFrame || details.isSameDocument) return
    rendererLost = false
    testHooks?.navigationStarted()
  })
  window.on('unresponsive', () => { rendererUnresponsive = true })
  window.on('responsive', () => { rendererUnresponsive = false })
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(rendererFile)
  window.on('close', event => {
    // A renderer only the watchdog saw go would never answer the unload Chromium sends it, so the window goes at once.
    if (rendererLost && !contents.isCrashed()) {
      closeApproved = true
      event.preventDefault()
      setImmediate(() => { if (!window.isDestroyed()) window.destroy() })
      return
    }
    if (closeApproved) return
    if (rendererCanConfirm(window)) { event.preventDefault(); requestClose('window'); return }
    // A crashed, hung, or unmounted workbench cannot run the unsaved-query prompts, so never trap the user. A hung one
    // is asked about first; the close (and a quit under way) waits for the answer.
    if (rendererUnresponsive) {
      event.preventDefault()
      confirmUnresponsiveClose(window, quitting)
      quitting = false
      return
    }
    closeApproved = true
  })
  // A closed window can no longer address its sessions. Only macOS keeps the app running after its last window closes,
  // so only there does a later window need a new backend.
  // A window replaced after its renderer was lost has already been reset.
  window.on('closed', () => {
    watchdog.stop()
    if (mainWindow !== window) return
    mainWindow = null
    resetRendererState(process.platform === 'darwin' && !quitting)
  })
}

/**
 * Chromium starts a new renderer only once it has seen the old one go. When only the watchdog saw it (a process that
 * inherited the renderer's channel still holds it open), a reload would go to the dead renderer and leave the window
 * frozen, so main waits for Chromium to notice (the holder is usually a backend generation, which the reset ended) and
 * otherwise opens the workbench in a new window where this one was.
 */
function reloadLostRenderer(window: BrowserWindow): void {
  const contents = window.webContents
  if (contents.isCrashed()) { window.reload(); return }
  const seen = () => { clearTimeout(timer); setImmediate(() => { if (!window.isDestroyed()) window.reload() }) }
  const timer = setTimeout(() => {
    contents.off('render-process-gone', seen)
    if (window.isDestroyed()) return
    const bounds = window.getNormalBounds(), maximized = window.isMaximized(), pending = closePending, intent = closeIntent
    createWindow({ bounds, maximized })
    // A close the lost page could not finish goes to the new one.
    closePending = pending
    closeIntent = intent
    window.destroy()
  }, lostRendererGraceMs)
  contents.once('render-process-gone', seen)
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  const root = app.getAppPath()
  // Smoke tests shorten the silence that counts as unresponsive; PING then runs often enough for a healthy backend.
  const livenessMs = testSeams ? Number(process.env.VARIA_BACKEND_LIVENESS_MS) : NaN
  const liveness = Number.isInteger(livenessMs) && livenessMs >= 200 ? { unresponsiveMs: livenessMs, limits: { pingMs: Math.floor(livenessMs / 4) } } : {}
  backend = new BackendSupervisor(backendSpawnSpec({ packaged: app.isPackaged, root, resourcesPath: process.resourcesPath, platform: process.platform, smokeTest: process.env.VARIA_SMOKE_TEST === '1', env: process.env, locale: app.getSystemLocale() }), {
    appVersion: app.getVersion(),
    // Frame kinds, ids and lengths only; never bodies.
    trace: !app.isPackaged && process.env.VARIA_IPC_TRACE === '1' ? line => console.error(line) : undefined,
    power: powerMonitor,
    onGlobalEvent: (event, generation) => {
      const memory = memoryEventSchema.safeParse(event)
      if (memory.success) resultsPort?.memory(generation, memory.data)
    },
    ...liveness
  })
  const results = resultsPort = new ResultsPortHost({ backend: supervisorResults(backend), createChannel: () => new MessageChannelMain() })
  const explorerRequests = new ExplorerRequests(backend)
  // Read early, but never awaited before the window: the renderer waits at most 1.5 s for it.
  const loaded = settings.load()
  loaded.catch(() => {})
  // AutoRecover's copies older than Keep AutoRecover information for go before the page can list them; with settings
  // unreadable, or a retention reset because settings.json was invalid, nothing is deleted under a retention the user
  // may have changed.
  void recovery.purge(retentionDays(settings))
  settings.onDidChange(state => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('varia:settings-changed', state)
    buildMenu()
    // Items shown in recently used file lists may have changed.
    publishRecentFiles()
  })
  void recent.load()
  recent.onDidChange(() => { buildMenu(); publishRecentFiles() })
  const jobs = resultsJobs = new ResultsJobHost({
    backend: supervisorJobs(backend), owns: (generation, resultId) => results.owns(generation, resultId), platform: process.platform,
    writeClipboard: text => clipboard.writeText(text), documentsDir: () => app.getPath('documents'),
    showSaveDialog: options => pageDialog<{ canceled: boolean; filePath?: string }>(window => dialog.showSaveDialog(window, options), { canceled: true }),
    progress: progress => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('varia:results-job', progress) },
    // While settings.json cannot be read, Options cannot open either, so the defaults apply.
    exportHeaders: async () => (await settings.load().catch(() => ({ values: settings.current() }))).values['queryResults.grid.includeColumnHeaders']
  })
  const scriptingRequests = new ScriptingRequests(backend)
  backend.onState(state => {
    results.backendState(state)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('varia:backend-state', state)
  })
  if (testSeams) testHooks = installTestHooks(backend, results)
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
  ipcMain.on('varia:commands-ready', (event, ready: unknown) => {
    if (!trusted(event)) return
    rendererReady = ready === true
    // A close or quit that the previous page could not finish (it reloaded or crashed first) goes to this one; a page
    // whose close is already under way shares it.
    if (rendererReady && closePending) command('window.close')
    deliverLaunchFiles()
  })
  // The preload's drop listener sends the paths of files dropped on the window: trusted drops only, which page script
  // can neither make nor read paths from.
  ipcMain.on('varia:files-dropped', (event, value: unknown) => {
    if (!trusted(event)) return
    const dropped = droppedPathsSchema.safeParse(value)
    if (!dropped.success) return
    launchFiles.add(dropped.data.filter(path => isAbsolute(path)))
    deliverLaunchFiles()
  })
  // Only the live page can end a close: a page being unloaded (not ready since the reset) may still report its own.
  ipcMain.on('varia:close-cancelled', event => { if (trusted(event) && rendererReady) { closePending = false; closeIntent = undefined } })
  // Invalid payloads are dropped: the menu keeps its last valid state, and every command re-checks enablement when it runs.
  ipcMain.on('varia:menu-state', (event, state: unknown) => { if (trusted(event)) menuBridge.applyState(state) })
  handle('varia:connections-load', async () => ({ ...await connectionStore.load(), windowsIdentity: process.platform === 'win32' ? [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join('\\') : userInfo().username }))
  handle('varia:connections-save', value => connectionStore.save(connectionProfileInputSchema.parse(value)))
  handle('varia:connections-remove', value => connectionStore.remove(z.uuid().parse(value)))
  handle('varia:settings-get', () => settings.load({ showsWarning: true }))
  handle('varia:settings-update', value => settings.update(value))
  handle('varia:layouts-load', () => layouts.load())
  handle('varia:layouts-save', value => layouts.save(value))
  handle('varia:layout-import', async () => {
    const selection = await pageDialog(window => dialog.showOpenDialog(window, { title: 'Load workspace layout', filters: [{ name: 'Varia layout', extensions: ['json'] }], properties: ['openFile'] }), { canceled: true, filePaths: [] })
    return selection.canceled || !selection.filePaths[0] ? null : layouts.import(selection.filePaths[0])
  })
  handle('varia:layout-export', async value => {
    const layout = parseWorkspaceLayout(value)
    const selection = await pageDialog(window => dialog.showSaveDialog(window, { title: 'Save workspace layout', defaultPath: join(app.getPath('documents'), 'workspace.varia-layout.json'), filters: [{ name: 'Varia layout', extensions: ['json'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] }), { canceled: true, filePath: '' })
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
      // An Object Explorer load or a script is registered before it is sent, so its cancel channel can always find it.
      const cancellable = method === 'explorer.children' ? explorerRequests : method === 'scripting.script' ? scriptingRequests : undefined
      const load = cancellable?.begin((validated as RpcMethods['explorer.children' | 'scripting.script']['params']).requestId)
      let result: unknown
      try {
        result = await backend.request(method as RpcMethod, validated as never, queryId !== undefined ? { onEvent: queryEvent => results.queryEvent(queryId, queryEvent) } : load ? { onSent: load.sent } : {})
      } finally { load?.end() }
      result = validateResult(method as RpcMethod, result)
      if (queryId !== undefined) results.own((result as QueryResult).resultSets)
      if (method === 'connections.connect') {
        try { await connectionStore.remember(validated as RpcMethods['connections.connect']['params']) }
        catch { (result as RpcMethods['connections.connect']['result']).historyWarning = 'Connected successfully, but recent connections could not be saved.' }
      }
      return { ok: true, value: result }
    } catch (error) { return failure(error, 'Backend request failed.') }
  })
  handle('varia:explorer-cancel', value => ({ cancelled: explorerRequests.cancel(explorerCancelParamsSchema.parse(value).requestIds) }))
  // Copy and Save Results As: the renderer names a result it owns; the backend formats the text, main writes the
  // clipboard or chooses the file, and only the file's name goes back.
  handle('varia:results-copy', value => jobs.copy(value))
  handle('varia:results-save', value => jobs.save(value))
  handle('varia:results-job-cancel', value => jobs.cancel(value))
  handle('varia:scripting-cancel', value => ({ cancelled: scriptingRequests.cancel(scriptCancelSchema.parse(value).requestIds) }))
  handle('varia:files-open', async () => {
    const selected = await pageDialog(window => dialog.showOpenDialog(window, { title: 'Open SQL query', filters: [{ name: 'SQL files', extensions: ['sql'] }, { name: 'Text files', extensions: ['txt'] }], properties: ['openFile', 'multiSelections'] }), { canceled: true, filePaths: [] })
    if (selected.canceled) return []
    if (selected.filePaths.length > maxLaunchFiles) throw new Error(`Select at most ${maxLaunchFiles} files at a time.`)
    const opened = await Promise.all(selected.filePaths.map(path => files.read(path)))
    for (const file of opened) void recent.add(file.path).catch(() => {})
    return opened
  })
  handle('varia:files-save', async value => {
    const options = saveFileSchema.parse(value), kind = fileKinds[options.kind ?? 'sql']
    // While settings.json cannot be read, Options cannot open either, so the defaults apply.
    const values = (await settings.load().catch(() => ({ values: settings.current() }))).values
    const encoding = values['environment.documents.saveWithSpecificEncoding'] ? values['environment.documents.saveEncoding'] : undefined
    let before: string | undefined
    try { before = options.fileId ? files.get(options.fileId).path : undefined } catch { /* saveDocument reports it. */ }
    const saved = await saveDocument(files, options, encoding, {
      readOnly: askReadOnly, changed: askChanged, unicode: askUnicode,
      saveDialog: async registeredPath => {
        const defaultPath = registeredPath ?? join(app.getPath('documents'), sanitizeFileName(options.name))
        const selection = await pageDialog(window => dialog.showSaveDialog(window, { title: kind.title, defaultPath, filters: kind.filters, properties: ['showOverwriteConfirmation', 'createDirectory'] }), { canceled: true, filePath: '' })
        return selection.canceled || !selection.filePath ? undefined : selection.filePath
      }
    }, values['environment.documents.detectExternalChanges'])
    // Saved under a new name: Recent Files lists it, as Visual Studio's does.
    if (saved && saved.path !== before) void recent.add(saved.path).catch(() => {})
    return saved
  })
  handle('varia:files-check', () => files.check())
  handle('varia:files-reload', value => files.reload(z.uuid().parse(value)))
  // Visual Studio's question, naming the file by main's registration; the "All" answers apply to the rest of one check.
  handle('varia:confirm-reload', async value => {
    const { fileId, dirty, more } = reloadPromptSchema.parse(value), path = files.get(fileId).path
    const answers: ReloadAnswer[] = more ? ['yes', 'yesToAll', 'no', 'noToAll'] : ['yes', 'no']
    const no = more ? 2 : 1
    const { response } = await pageDialog((window, signal) => dialog.showMessageBox(window, {
      type: 'question', title: 'File changed', message: path,
      detail: dirty ? 'This file has been modified outside of the source editor. Do you want to reload it and lose the changes made in the source editor?' : 'This file has been modified outside of the source editor. Do you want to reload it?',
      buttons: more ? ['Yes', 'Yes to All', 'No', 'No to All'] : ['Yes', 'No'], defaultId: 0, cancelId: no, noLink: true, signal
    }), { response: no, checkboxChecked: false }, true)
    return answers[response] ?? 'no'
  })
  // AutoRecover. Main adds the path from its own registration of the query's file; nothing is written while AutoRecover is
  // off (settings that cannot be read leave it on, as Options shows), or once the window is closing.
  handle('varia:recovery-write', async value => {
    const request = recoveryWriteSchema.parse(value), generation = pageGeneration
    const values = (await settings.load().catch(() => ({ values: settings.current() }))).values
    if (!values['environment.autoRecover.enabled'] || closeApproved) return
    let path: string | undefined
    try { path = request.fileId ? files.get(request.fileId).path : undefined } catch { /* Released: kept without a file. */ }
    await recovery.write({ ...request, ...path ? { path } : {} }, generation)
  })
  handle('varia:recovery-discard', value => recovery.discard(recoveryDiscardSchema.parse(value).ids, pageGeneration))
  handle('varia:recovery-list', () => recovery.list(pageGeneration))
  handle('varia:recovery-take', async (value): Promise<RecoveredDocument> => {
    const generation = pageGeneration, record = await recovery.take(recoveryTakeSchema.parse(value).id, generation)
    const file = record.path && generation === rendererGeneration ? await files.register(record.path) : undefined
    return { text: record.text, name: record.name, kind: record.kind, eol: record.eol, ...file ? { file } : {} }
  })
  handle('varia:recent-files', () => recentFiles())
  handle('varia:recent-files-open', value => openRecent(z.uuid().parse(value)))
  handle('varia:recent-files-clear', () => recent.clear())
  handle('varia:files-release', value => { files.release(z.uuid().parse(value)) })
  handle('varia:files-reveal', value => { shell.showItemInFolder(files.get(z.uuid().parse(value)).path) })
  // Write only (the page's one path to clipboard contents is the Paste role, gated above); the length is bounded like
  // a full results grid copy.
  handle('varia:clipboard-write', value => { clipboard.writeText(z.string().max(maxClipboardText).parse(value)) })
  handle('varia:confirm-close', async value => {
    const name = z.string().min(1).max(512).parse(value)
    const response = await pageDialog((window, signal) => dialog.showMessageBox(window, { type: 'question', title: 'Unsaved query', message: `Save changes to ${name}?`, buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, noLink: true, signal }), { response: 2, checkboxChecked: false }, true)
    return (['save', 'discard', 'cancel'] as const)[response.response]
  })
  // Open transactions and running queries in sessions about to end. Main writes the prompt from validated facts, and a page
  // that reloads or crashes while it is open gets Cancel (its sessions ended with it), so a dead page cannot hold it open.
  handle('varia:confirm-sessions', async value => {
    const prompt = sessionPrompt(sessionPromptRequestSchema.parse(value))
    if (!prompt) return 'proceed'
    const { response } = await pageDialog((window, signal) => dialog.showMessageBox(window, { type: 'warning', title: prompt.title, message: prompt.message, detail: prompt.detail, buttons: prompt.buttons.map(button => button.label), defaultId: prompt.defaultId, cancelId: prompt.cancelId, noLink: true, signal }), { response: prompt.cancelId, checkboxChecked: false }, true)
    return prompt.buttons[response]?.answer ?? 'cancel'
  })
  // The page has handled every unsaved query. On macOS a window close leaves the app running, as macOS apps do.
  ipcMain.handle('varia:close-window', async event => {
    if (!trusted(event)) return
    closeApproved = true
    // Every query was saved or discarded, so AutoRecover's copies of this page's go, before the app can exit.
    await recovery.discardOwned(pageGeneration).catch(() => {})
    if (closeAction(process.platform, closeIntent) === 'closeWindow') mainWindow?.close()
    else app.quit()
  })
  buildMenu()
  createWindow()
  started = true
  // The full catalogue only feeds the menu, so it loads after the window is on its way.
  void appearance.scan()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(error => { dialog.showErrorBox('Varia startup failed', error instanceof Error ? error.message : 'Unknown error'); app.quit() })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (!closeApproved && mainWindow && !mainWindow.isDestroyed() && rendererCanConfirm(mainWindow)) { event.preventDefault(); requestClose('quit'); return }
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
