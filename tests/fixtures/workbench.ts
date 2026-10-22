import { vi } from 'vitest'
import type { BackendState, ConnectionInfo, ConnectionOptions, ExplorerChildrenResult, ExplorerNode as WireNode, QueryResult, RecentFile, RecoveredDocument, RecoveryEntry, RecoveryWrite, VariaApi } from '../../src/shared/contracts'
import { folderSpecs, kindSpecs, type FolderId } from '../../src/shared/explorer/catalog'
import type { ExplorerChildrenParams, ObjectRef } from '../../src/shared/explorer/refs'
import type { Platform } from '../../src/shared/commands/keybindings'
import { CommandService } from '../../src/renderer/src/core/commands'
import { ContextKeyService } from '../../src/renderer/src/core/contextkeys'
import { InputModeService, type InputModeName, type MonacoInputMode } from '../../src/renderer/src/core/input-mode'
import { KeybindingService } from '../../src/renderer/src/core/keybindings'
import type { Timers } from '../../src/renderer/src/core/timers'
import { ConnectionService } from '../../src/renderer/src/services/connections'
import { BackendStateService } from '../../src/renderer/src/services/backend'
import { EditorOptionsService } from '../../src/renderer/src/services/editor-options'
import { settingsDocumentOptions } from '../../src/renderer/src/services/documents'
import { FileService } from '../../src/renderer/src/services/files'
import { RecentFilesService } from '../../src/renderer/src/services/recent-files'
import { RecoveryService } from '../../src/renderer/src/services/recovery'
import { QueryService, type QueryApi } from '../../src/renderer/src/services/queries'
import { TargetService } from '../../src/renderer/src/services/targets'
import { PaneService } from '../../src/renderer/src/services/panes'
import { ExplorerService } from '../../src/renderer/src/explorer/ExplorerService'
import { DatabaseListService } from '../../src/renderer/src/services/database-list'
import { ResultSelectionService } from '../../src/renderer/src/services/result-selection'
import { ResultsService } from '../../src/renderer/src/results/ResultsService'
import { browserTimers } from '../../src/renderer/src/core/timers'
import { explorerContribution } from '../../src/renderer/src/contributions/explorer'
import { outputContribution } from '../../src/renderer/src/contributions/output'
import { editorContribution } from '../../src/renderer/src/contributions/editor'
import { editingContribution } from '../../src/renderer/src/contributions/editing'
import { BookmarkService } from '../../src/renderer/src/editor/bookmarks'
import { EditorDialogs } from '../../src/renderer/src/editor/go-to-line'
import type { BridgeMonaco } from '../../src/renderer/src/editor/keybinding-bridge'
import { editContribution } from '../../src/renderer/src/contributions/edit'
import { windowContribution } from '../../src/renderer/src/contributions/window'
import { MenuService } from '../../src/renderer/src/menus/MenuService'
import { MenuTargetService } from '../../src/renderer/src/menus/targets'
import { menusContribution } from '../../src/renderer/src/contributions/menus'
import { filesContribution } from '../../src/renderer/src/contributions/files'
import { paletteContribution } from '../../src/renderer/src/contributions/palette'
import { queryContribution } from '../../src/renderer/src/contributions/query'
import { shellContribution, type ShellHost } from '../../src/renderer/src/contributions/shell'
import { themeContribution, type ThemeController } from '../../src/renderer/src/contributions/theme'
import { backendContribution } from '../../src/renderer/src/contributions/backend'
import { helpContribution } from '../../src/renderer/src/contributions/help'
import { scriptingContribution } from '../../src/renderer/src/contributions/scripting'
import { ScriptingService } from '../../src/renderer/src/scripting/ScriptingService'
import { ObjectActionService } from '../../src/renderer/src/actions/ObjectActionService'
import { ObjectDialogService } from '../../src/renderer/src/dialogs/ObjectDialogService'
import { actionsContribution } from '../../src/renderer/src/contributions/actions'
import { settingsContribution } from '../../src/renderer/src/contributions/settings'
import { SettingsService } from '../../src/renderer/src/settings/SettingsService'
import { defaultSettings, scriptingOptionsFrom, type SettingsValues } from '../../src/shared/settings/catalog'
import type { SettingsState } from '../../src/shared/settings/schema'
import { CommandHistory, type HistoryStorage } from '../../src/renderer/src/quickinput/history'
import { QuickInputService, type FocusAdapter } from '../../src/renderer/src/quickinput/QuickInputService'
import { defaultThemePreference } from '../../src/shared/theme/format'
import { resolveBuiltin } from '../../src/shared/theme/resolve'
import { deferred, documentFixture } from './documents'
import { fakeResultClient, summaryOf } from './results'

export const connectionInfo = (id: string, generation = 1): ConnectionInfo => ({ id, server: `${id}.example`, database: 'master', serverVersion: '17.0', generation })
/** What the Connect dialog passes with a connection, password included: the connection service must drop it. */
export const connectionOptions: ConnectionOptions = { server: 'server.example', database: 'master', authentication: 'sql', username: 'reader', password: 'never-keep-this', trustServerCertificate: false }
export const readyBackend = (generation = 1): BackendState => ({ status: 'ready', generation, pid: 100 + generation, runtime: '.NET 10.0.0', platform: 'test' })
/** The backend half of VariaApi, with `push` standing in for main's state pushes. */
export function backendApi(initial: BackendState = { status: 'starting', generation: 1 }) {
  const listeners = new Set<(state: BackendState) => void>()
  // Like main, the request answers with the latest state, so a push made before it settles is not undone: the answer is
  // read when it arrives, not when it is asked for.
  let current = initial
  return {
    getBackendState: vi.fn<VariaApi['getBackendState']>(async () => { await Promise.resolve(); return { ok: true, value: current } }),
    onBackendState: vi.fn<VariaApi['onBackendState']>(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }),
    restartBackend: vi.fn<VariaApi['restartBackend']>(async () => ({ ok: true, value: true })),
    push: (state: BackendState) => { current = state; listeners.forEach(listener => listener(state)) },
    listeners
  }
}
/**
 * Object Explorer's answers in the fixture: a server's three folders; Databases with its two subfolders and AppData;
 * AppData's Tables; Tables with dbo.Orders, which has Columns (Id, CustomerName); Security with Logins, which lists sa.
 * Anything else is empty.
 */
export function explorerAnswer(params: ExplorerChildrenParams): ExplorerChildrenResult {
  const folder = (owner: ObjectRef, id: FolderId): WireNode => ({ ref: { type: 'folder', owner, folder: id }, label: folderSpecs[id].label, icon: 'folder', hasChildren: true })
  const object = (value: ObjectRef, label: string, hasChildren: boolean): WireNode => ({ ref: { type: 'object', object: value }, label, icon: kindSpecs[value.kind].icon, hasChildren })
  const owner = params.node.type === 'object' ? params.node.object : params.node.owner
  const nodes: WireNode[] = params.node.type === 'object'
    ? params.node.object.kind === 'server' ? [folder(owner, 'databases'), folder(owner, 'serverSecurity'), folder(owner, 'serverObjects')]
      : params.node.object.kind === 'database' ? [folder(owner, 'tables')] : params.node.object.kind === 'table' ? [folder(owner, 'columns')] : []
    : params.node.folder === 'databases' ? [folder(owner, 'systemDatabases'), folder(owner, 'databaseSnapshots'), object({ kind: 'database', name: 'AppData' }, 'AppData', true)]
      : params.node.folder === 'tables' ? [object({ kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }, 'dbo.Orders', true)]
        : params.node.folder === 'serverSecurity' ? [folder(owner, 'logins')]
          : params.node.folder === 'logins' ? [object({ kind: 'login', name: 'sa' }, 'sa', false)]
            : params.node.folder === 'columns' ? ['Id', 'CustomerName'].map(name => object({ kind: 'column', database: owner.database, parent: { kind: 'table', schema: owner.schema!, name: owner.name! }, name }, name, false)) : []
  return { nodes, total: nodes.length, elapsedMs: 1 }
}
export const queryOutput: QueryResult = summaryOf([], { recordsAffected: 0, elapsedMs: 1 })

/**
 * Main's half of settings: `getSettings` answers the stored state, and `updateSettings` merges a patch (null resets),
 * bumps the revision and pushes the new state to `onSettingsChanged` listeners, as main does.
 */
export function settingsApi(seed: Partial<SettingsValues> = {}) {
  const listeners = new Set<(state: SettingsState) => void>()
  let state: SettingsState = { revision: 1, values: { ...defaultSettings, ...seed } }
  return {
    getSettings: vi.fn<VariaApi['getSettings']>(async () => ({ ok: true, value: state })),
    updateSettings: vi.fn<VariaApi['updateSettings']>(async patch => {
      const values: Record<string, unknown> = { ...state.values }
      for (const [key, value] of Object.entries(patch)) values[key] = value ?? defaultSettings[key as keyof SettingsValues]
      state = { revision: state.revision + 1, values: values as SettingsValues }
      listeners.forEach(listener => listener(state))
      return { ok: true, value: state }
    }),
    onSettingsChanged: vi.fn<VariaApi['onSettingsChanged']>(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }),
    get state() { return state }
  }
}
/** Main's half of Recent Files: `push` stands in for main's pushes; opening an entry opens nothing unless a test says so. */
export function recentFilesApi(initial: RecentFile[] = []) {
  const listeners = new Set<(files: RecentFile[]) => void>()
  return {
    recentFiles: vi.fn<VariaApi['recentFiles']>(async () => ({ ok: true, value: initial })),
    onRecentFiles: vi.fn<VariaApi['onRecentFiles']>(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }),
    openRecentFile: vi.fn<VariaApi['openRecentFile']>(async () => ({ ok: true, value: { files: [], errors: [] } })),
    clearRecentFiles: vi.fn<VariaApi['clearRecentFiles']>(async () => { listeners.forEach(listener => listener([])); return { ok: true, value: undefined } }),
    pushRecent: (files: RecentFile[]) => { listeners.forEach(listener => listener(files)) }
  }
}
/**
 * Main's half of AutoRecover, in memory: `written` holds this page's copies by id, `offered` what an earlier page or run
 * left, which `take` hands over (its text is `-- <name>` unless `texts` says otherwise) and `discard` deletes.
 */
export function recoveryApi(offered: RecoveryEntry[] = []) {
  const written = new Map<string, RecoveryWrite>(), texts = new Map<string, Partial<RecoveredDocument>>()
  const state = { offered: [...offered] }
  return {
    writeRecovery: vi.fn<VariaApi['writeRecovery']>(async record => { written.set(record.id, record); return { ok: true, value: undefined } }),
    discardRecovery: vi.fn<VariaApi['discardRecovery']>(async ids => {
      for (const id of ids) written.delete(id)
      state.offered = state.offered.filter(entry => !ids.includes(entry.id))
      return { ok: true, value: undefined }
    }),
    listRecovery: vi.fn<VariaApi['listRecovery']>(async () => ({ ok: true, value: state.offered })),
    takeRecovery: vi.fn<VariaApi['takeRecovery']>(async id => {
      const entry = state.offered.find(item => item.id === id)
      if (!entry) return { ok: false, error: 'This query is no longer offered for recovery.' }
      state.offered = state.offered.filter(item => item.id !== id)
      return { ok: true, value: { text: `-- ${entry.name}`, name: entry.name, kind: entry.kind, eol: 'crlf', ...texts.get(id) } }
    }),
    written, texts, recoveryState: state
  }
}
/** Storage backed by a Map, for the command history. */
export function memoryStorage(initial: Record<string, string> = {}): HistoryStorage & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}
/** Focus as a variable: `capture` returns `focused`, and `restore` sets it and records the call. */
export function fakeFocus(initial: unknown = 'editor') {
  const state = { focused: initial, restored: [] as unknown[] }
  const adapter: FocusAdapter = { capture: () => state.focused, restore: target => { state.focused = target; state.restored.push(target) } }
  return { adapter, state }
}
/** Timers that run only when the test says so; `advance` runs every timer due by then, in order. */
export function manualTimers() {
  let now = 0, next = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timers: Timers = { setTimeout: (callback, ms) => { pending.set(next, { at: now + ms, callback }); return next++ }, clearTimeout: handle => { pending.delete(handle as number) } }
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      pending.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = until
  }
  return { timers, pending, advance }
}

/** A stand-in for Monaco's InputMode, which every editor in a page shares, so tests never change the real one. */
export function fakeInputMode(): MonacoInputMode {
  const listeners = new Set<(mode: InputModeName) => void>()
  const target: MonacoInputMode = {
    _inputMode: 'insert', _onDidChangeInputMode: { fire: mode => listeners.forEach(listener => listener(mode)) }, getInputMode: () => target._inputMode,
    onDidChangeInputMode: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } }
  }
  return target
}
/**
 * The renderer's services and every command contribution, wired as createWorkbench does but with fake IPC and a fake
 * shell host, so command enablement can be tested in Node.
 */
export function workbenchFixture(options: { platform?: Platform; modal?: () => boolean; storage?: HistoryStorage; timers?: Timers; settings?: Partial<SettingsValues>; recovery?: RecoveryEntry[] } = {}) {
  // Settings apply to documents as createWorkbench applies them; `settings` exists before the first document does.
  const doc = documentFixture(settingsDocumentOptions(() => settings.getSnapshot().values))
  /** What query.session.state answers for each tab's session: its @@TRANCOUNT, or 'unchecked'; a tab without one has no session. */
  const sessionStates = new Map<string, number | 'unchecked'>()
  const api = {
    ...doc.api,
    execute: vi.fn<QueryApi['execute']>(async () => ({ ok: true, value: queryOutput })),
    copyResults: vi.fn<VariaApi['copyResults']>(async () => ({ ok: true, value: { rows: 0, bytes: 0, truncatedCells: 0, partial: false } })),
    saveResults: vi.fn<VariaApi['saveResults']>(async () => ({ ok: true, value: null })),
    cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(async () => ({ ok: true, value: { cancelled: true } })),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(() => () => {}),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } })),
    openSqlFiles: vi.fn<VariaApi['openSqlFiles']>(async () => ({ ok: true, value: [] })),
    releaseSqlFile: vi.fn<VariaApi['releaseSqlFile']>(async () => ({ ok: true, value: undefined })),
    confirmClose: vi.fn<VariaApi['confirmClose']>(async () => ({ ok: true, value: 'discard' })),
    closeWindow: vi.fn<VariaApi['closeWindow']>(async () => {}),
    closeWindowCancelled: vi.fn<VariaApi['closeWindowCancelled']>(),
    // Nothing to ask unless a test says otherwise; answers Cancel when asked.
    confirmSessions: vi.fn<VariaApi['confirmSessions']>(async () => ({ ok: true, value: 'cancel' })),
    querySessionState: vi.fn<VariaApi['querySessionState']>(async sessionId => {
      const state = sessionStates.get(sessionId)
      return state === undefined ? { ok: false, error: 'This query has no open SQL session.', code: 'SESSION_CLOSED' } : { ok: true, value: state === 'unchecked' ? { transactionCount: 0, checked: false } : { transactionCount: state, checked: true } }
    }),
    databases: vi.fn<VariaApi['databases']>(async () => ({ ok: true, value: [] })),
    previewTheme: vi.fn<VariaApi['previewTheme']>(async () => ({ ok: true, value: null })),
    setThemePreference: vi.fn<VariaApi['setThemePreference']>(async () => ({ ok: false, error: 'Not in this fixture.' })),
    createCustomTheme: vi.fn<VariaApi['createCustomTheme']>(async () => ({ ok: true, value: undefined })),
    runRole: vi.fn<VariaApi['runRole']>(async () => ({ ok: true, value: undefined })),
    clearEntraTokenCache: vi.fn<VariaApi['clearEntraTokenCache']>(async () => ({ ok: true, value: true })),
    writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(async () => ({ ok: true, value: undefined })),
    revealSqlFile: vi.fn<VariaApi['revealSqlFile']>(async () => ({ ok: true, value: undefined })),
    tableColumns: vi.fn<VariaApi['tableColumns']>(async () => ({ ok: true, value: { columns: [{ name: 'Id', dataType: 'int' }, { name: 'CustomerName', dataType: 'nvarchar' }], truncated: false } })),
    explorerChildren: vi.fn<VariaApi['explorerChildren']>(async params => ({ ok: true, value: explorerAnswer(params) })),
    explorerCancel: vi.fn<VariaApi['explorerCancel']>(async requestIds => ({ ok: true, value: { cancelled: requestIds.length } })),
    // A script naming the object and verb, from the object's database (master for databases and server objects).
    scriptObjects: vi.fn<VariaApi['scriptObjects']>(async params => {
      const [object] = params.targets
      return { ok: true, value: { text: `-- ${params.verb} ${[object.schema, object.name].filter(Boolean).join('.')}`, database: object.database ?? 'master', warnings: [], commands: 1, elapsedMs: 1 } }
    }),
    cancelScripting: vi.fn<VariaApi['cancelScripting']>(async requestIds => ({ ok: true, value: { cancelled: requestIds.length } })),
    // Delete Object's row for the object; actions succeed with one done step.
    describeObject: vi.fn<VariaApi['describeObject']>(async params => ({
      ok: true, value: { deleteTarget: { name: [params.target.schema, params.target.name].filter(Boolean).join('.'), type: kindSpecs[params.target.kind].title, owner: 'dbo', warnings: [], dependentsTruncated: false }, elapsedMs: 1 }
    })),
    scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(async params => ({ ok: true, value: { text: `-- ${params.action} ${params.target.name}`, database: params.target.database ?? 'master', warnings: [] } })),
    executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(async () => ({ ok: true, value: { steps: [{ status: 'done' }], messages: [], elapsedMs: 1 } })),
    cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async requestIds => ({ ok: true, value: { cancelled: requestIds.length } })),
    checkSqlFiles: vi.fn<VariaApi['checkSqlFiles']>(async () => ({ ok: true, value: [] })),
    reloadSqlFile: vi.fn<VariaApi['reloadSqlFile']>(async () => ({ ok: false, error: 'Not in this fixture.' })),
    confirmReload: vi.fn<VariaApi['confirmReload']>(async () => ({ ok: true, value: 'no' })),
    ...recentFilesApi(),
    ...recoveryApi(options.recovery),
    ...settingsApi(options.settings),
    ...backendApi()
  }
  const { documents, events } = doc
  // Seeded values apply at once, as if main had answered before the workbench was created.
  const settings = new SettingsService(api, { ...defaultSettings, ...options.settings })
  settings.subscribe(() => documents.refreshOptions())
  const connections = new ConnectionService(), editorOptions = new EditorOptionsService(settings), panes = new PaneService()
  const bookmarks = new BookmarkService(documents, events), editorDialogs = new EditorDialogs()
  // Monaco's command and keybinding registries, for the editor chords the bridge registers.
  const monaco = { editor: { registerCommand: vi.fn<BridgeMonaco['editor']['registerCommand']>(() => ({ dispose: vi.fn() })), addKeybindingRules: vi.fn<BridgeMonaco['editor']['addKeybindingRules']>(() => ({ dispose: vi.fn() })) } }
  const explorer = new ExplorerService({ api, connections, events, schedule: callback => callback(), ...(options.timers ? { timers: options.timers } : {}) })
  const databaseList = new DatabaseListService(api, connections, events)
  const backend = new BackendStateService(api, connections)
  const resultClient = fakeResultClient()
  const results = new ResultsService({ client: resultClient, api, events, documents, frame: callback => callback(), timers: options.timers ?? browserTimers, newId: () => crypto.randomUUID() })
  const queries = new QueryService(documents, api, id => connections.get(id), events, results, undefined, undefined, () => settings.getSnapshot().values)
  const files = new FileService(documents, queries, api, { autoReload: () => settings.getSnapshot().values['environment.documents.autoReload'] })
  const recentFiles = new RecentFilesService(api)
  // AutoRecover's timer runs only when a test advances it.
  const recoveryTimers = manualTimers()
  const recovery = new RecoveryService({ api, documents, files, settings, warn: message => commands.reportWarning(message), timers: recoveryTimers.timers, server: id => connections.get(id)?.server })
  const resultSelection = new ResultSelectionService(results)
  const targets = new TargetService(documents, queries, connections, files)
  const platform = options.platform ?? 'win32', focus = fakeFocus()
  const quickInput = new QuickInputService(focus.adapter, options.timers)
  const focused = { panel: '' as '' | 'explorer' | 'editor' | 'output' }
  // The focused element is a stand-in whose pane is `focused.panel`, so tests can put focus in Object Explorer.
  const activeElement = () => focused.panel ? { matches: () => false, closest: (selector: string) => selector === '[data-pane]' ? { getAttribute: () => focused.panel } : null } as unknown as Element : null
  settings.setReporter((message, kind) => kind === 'warning' ? commands.reportWarning(message) : commands.reportError(message))
  const scriptingOptions = { getSnapshot: () => ({ options: scriptingOptionsFrom(settings.getSnapshot().values) }), subscribe: settings.subscribe }
  const focusEditor = vi.fn()
  const scripting = new ScriptingService({ api, documents, files, connections, options: scriptingOptions, focusEditor, schedule: callback => callback(), ...(options.timers ? { timers: options.timers } : {}) })
  const dialogs = new ObjectDialogService({ api, connections, explorer, documents, files, focusEditor })
  const inputMode = new InputModeService(fakeInputMode())
  const context = new ContextKeyService({
    platform,
    documents,
    queries,
    connections,
    backend,
    editorOptions,
    inputMode,
    panes,
    quickInput: quickInput.visibility,
    explorer: explorer.context,
    results: results.context,
    scripting: scripting.running,
    bookmarks,
    recentFiles,
    recovery,
    activeElement
  })
  const commands = new CommandService({ state: () => context.getState(), modalOpen: options.modal })
  const actions = new ObjectActionService({
    api, explorer, documents, queries, connections, selectTopCount: () => settings.get('objectExplorer.selectTopRows'),
    report: { error: message => commands.reportError(message), warning: message => commands.reportWarning(message) }, ...(options.timers ? { timers: options.timers } : {})
  })
  const keybindings = new KeybindingService({ platform, commands, context, modalOpen: options.modal ?? (() => false), editorHasTextFocus: () => false })
  const host: ShellHost = {
    disconnect: vi.fn(async () => {}), reveal: vi.fn(), manageLayouts: vi.fn(), resetLayout: vi.fn(), flushLayout: vi.fn(async () => {}), showConnect: vi.fn(), reconnect: vi.fn(), closePane: vi.fn(),
    paneLocation: vi.fn<ShellHost['paneLocation']>(() => 'grid'), floatPane: vi.fn(), dockPane: vi.fn()
  }
  const history = new CommandHistory(options.storage ?? memoryStorage())
  // tests/theme-picker.test.ts drives a real ThemeService; here the theme commands only need somewhere to go.
  const theme: ThemeController = {
    state: { revision: 0, preference: defaultThemePreference, active: resolveBuiltin('dark'), fallback: false, themes: [], problems: [], problemsOmitted: 0, noticeId: 0 },
    preview: vi.fn(), endPreview: vi.fn(), receive: vi.fn(), reload: vi.fn(async () => {}), openFolder: vi.fn(async () => {})
  }
  // The menus over these services: resolution, enablement, and activation, without the DOM.
  const menuTargets = new MenuTargetService({ commandEnabled: () => true })
  const menus = new MenuService({ platform, commands, context, keybindings, theme, recentFiles, settings: () => settings.getSnapshot().values, focus: focus.adapter, modalOpen: options.modal ?? (() => false), timers: options.timers, targets: menuTargets })
  const workbench = {
    platform,
    commands,
    context,
    documents,
    queries,
    files,
    recentFiles,
    recovery,
    editorOptions,
    bookmarks,
    editorDialogs,
    inputMode,
    connections,
    backend,
    targets,
    quickInput,
    keybindings,
    events,
    theme,
    panes,
    menus,
    explorer,
    databaseList,
    menuTargets,
    resultSelection,
    results,
    settings,
    scripting,
    actions,
    dialogs
  }
  const contributions = [
    queryContribution(workbench, api),
    filesContribution(workbench, api),
    editorContribution(workbench),
    editingContribution(workbench, monaco),
    editContribution(workbench, api),
    windowContribution(workbench, api),
    menusContribution(workbench),
    explorerContribution(workbench, api),
    outputContribution(workbench, api),
    shellContribution(workbench, host),
    paletteContribution(workbench, history),
    themeContribution(workbench, api, options.timers),
    backendContribution(workbench),
    helpContribution(workbench, api),
    scriptingContribution(workbench),
    actionsContribution(workbench),
    settingsContribution(workbench)
  ]
  /** Starts a query on the active document that stays running until `finish` is called. */
  const startQuery = () => {
    const pending = deferred<Awaited<ReturnType<QueryApi['execute']>>>()
    api.execute.mockReturnValueOnce(pending.promise)
    const running = queries.execute()
    return { finish: async () => { pending.resolve({ ok: true, value: queryOutput }); await running } }
  }
  /** Connects a server as the Connect dialog would. */
  const connect = (info: ConnectionInfo) => connections.add(info, connectionOptions)
  const dispose = () => {
    recovery.dispose()
    menus.dispose()
    quickInput.dispose()
    contributions.forEach(contribution => contribution.dispose())
    commands.dispose()
    context.dispose()
    files.dispose()
    recentFiles.dispose()
    queries.dispose()
    resultSelection.dispose()
    results.dispose()
    explorer.dispose()
    databaseList.dispose()
    scripting.dispose()
    actions.dispose()
    dialogs.dispose()
    bookmarks.dispose()
    editorDialogs.dispose()
    settings.dispose()
    documents.dispose()
    backend.dispose()
  }
  return {
    ...doc,
    api,
    connections,
    backend,
    editorOptions,
    bookmarks,
    editorDialogs,
    monaco,
    panes,
    explorer,
    databaseList,
    resultSelection,
    results,
    resultClient,
    settings,
    scripting,
    actions,
    dialogs,
    focusEditor,
    queries,
    files,
    recentFiles,
    recovery,
    recoveryTimers,
    targets,
    context,
    commands,
    keybindings,
    menus,
    menuTargets,
    quickInput,
    focus: focus.state,
    focused,
    history,
    host,
    theme,
    startQuery,
    connect,
    dispose,
    sessionStates
  }
}
/** The contract name sibling tests use: the workbench fixture, with `settings` seeding the stored values. */
export const createTestWorkbench = workbenchFixture
