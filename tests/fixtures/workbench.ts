import { vi } from 'vitest'
import type { BackendState, ConnectionInfo, ConnectionOptions, DisplayQueryResult, ExplorerChildrenResult, ExplorerNode as WireNode, VariaApi } from '../../src/shared/contracts'
import { folderSpecs, kindSpecs, type FolderId } from '../../src/shared/explorer/catalog'
import type { ExplorerChildrenParams, ObjectRef } from '../../src/shared/explorer/refs'
import type { Platform } from '../../src/shared/commands/keybindings'
import { CommandService } from '../../src/renderer/src/core/commands'
import { ContextKeyService } from '../../src/renderer/src/core/contextkeys'
import { KeybindingService } from '../../src/renderer/src/core/keybindings'
import type { Timers } from '../../src/renderer/src/core/timers'
import { ConnectionService } from '../../src/renderer/src/services/connections'
import { BackendStateService } from '../../src/renderer/src/services/backend'
import { EditorOptionsService } from '../../src/renderer/src/services/editor-options'
import { FileService } from '../../src/renderer/src/services/files'
import { QueryService, type QueryApi } from '../../src/renderer/src/services/queries'
import { TargetService } from '../../src/renderer/src/services/targets'
import { PaneService } from '../../src/renderer/src/services/panes'
import { ExplorerService } from '../../src/renderer/src/explorer/ExplorerService'
import { DatabaseListService } from '../../src/renderer/src/services/database-list'
import { ResultSelectionService } from '../../src/renderer/src/services/result-selection'
import { explorerContribution } from '../../src/renderer/src/contributions/explorer'
import { outputContribution } from '../../src/renderer/src/contributions/output'
import { editorContribution } from '../../src/renderer/src/contributions/editor'
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
import { scriptingContribution } from '../../src/renderer/src/contributions/scripting'
import { ScriptingOptionsService } from '../../src/renderer/src/scripting/ScriptingOptionsService'
import { ScriptingService } from '../../src/renderer/src/scripting/ScriptingService'
import { defaultScriptingOptions } from '../../src/shared/scripting/options'
import { CommandHistory, type HistoryStorage } from '../../src/renderer/src/quickinput/history'
import { QuickInputService, type FocusAdapter } from '../../src/renderer/src/quickinput/QuickInputService'
import { defaultThemePreference } from '../../src/shared/theme/format'
import { resolveBuiltin } from '../../src/shared/theme/resolve'
import { deferred, documentFixture } from './documents'

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
export const queryOutput: DisplayQueryResult = { status: 'completed', resultSets: [], messages: [], recordsAffected: 0, elapsedMs: 1, completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false }

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

/**
 * The renderer's services and every command contribution, wired as createWorkbench does but with fake IPC and a fake
 * shell host, so command enablement can be tested in Node.
 */
export function workbenchFixture(options: { platform?: Platform; modal?: () => boolean; storage?: HistoryStorage; timers?: Timers } = {}) {
  const doc = documentFixture()
  const api = {
    ...doc.api,
    execute: vi.fn<QueryApi['execute']>(async () => ({ ok: true, value: queryOutput })),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } })),
    openSqlFiles: vi.fn<VariaApi['openSqlFiles']>(async () => ({ ok: true, value: [] })),
    releaseSqlFile: vi.fn<VariaApi['releaseSqlFile']>(async () => ({ ok: true, value: undefined })),
    confirmClose: vi.fn<VariaApi['confirmClose']>(async () => ({ ok: true, value: 'discard' })),
    closeWindow: vi.fn<VariaApi['closeWindow']>(async () => {}),
    databases: vi.fn<VariaApi['databases']>(async () => ({ ok: true, value: [] })),
    previewTheme: vi.fn<VariaApi['previewTheme']>(async () => ({ ok: true, value: null })),
    setThemePreference: vi.fn<VariaApi['setThemePreference']>(async () => ({ ok: false, error: 'Not in this fixture.' })),
    createCustomTheme: vi.fn<VariaApi['createCustomTheme']>(async () => ({ ok: true, value: undefined })),
    runRole: vi.fn<VariaApi['runRole']>(async () => ({ ok: true, value: undefined })),
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
    getScriptingOptions: vi.fn<VariaApi['getScriptingOptions']>(async () => ({ ok: true, value: { options: defaultScriptingOptions } })),
    setScriptingOptions: vi.fn<VariaApi['setScriptingOptions']>(async options => ({ ok: true, value: options })),
    ...backendApi()
  }
  const { documents, events } = doc
  const connections = new ConnectionService(), editorOptions = new EditorOptionsService(), panes = new PaneService()
  const explorer = new ExplorerService({ api, connections, events, schedule: callback => callback(), ...(options.timers ? { timers: options.timers } : {}) })
  const databaseList = new DatabaseListService(api, connections, events)
  const backend = new BackendStateService(api, connections)
  const queries = new QueryService(documents, api, id => connections.get(id), events)
  const files = new FileService(documents, queries, api)
  const resultSelection = new ResultSelectionService(events)
  const targets = new TargetService(documents, queries, connections, files, api)
  const platform = options.platform ?? 'win32', focus = fakeFocus()
  const quickInput = new QuickInputService(focus.adapter, options.timers)
  const focused = { panel: '' as '' | 'explorer' | 'editor' | 'output' }
  // The focused element is a stand-in whose pane is `focused.panel`, so tests can put focus in Object Explorer.
  const activeElement = () => focused.panel ? { matches: () => false, closest: (selector: string) => selector === '[data-pane]' ? { getAttribute: () => focused.panel } : null } as unknown as Element : null
  const scriptingOptions = new ScriptingOptionsService(api, message => commands.reportError(message))
  const focusEditor = vi.fn()
  const scripting = new ScriptingService({ api, documents, files, connections, options: scriptingOptions, focusEditor, schedule: callback => callback(), ...(options.timers ? { timers: options.timers } : {}) })
  const context = new ContextKeyService({ platform, documents, queries, connections, backend, editorOptions, panes, quickInput: quickInput.visibility, explorer: explorer.context, scripting: scripting.running, activeElement })
  const commands = new CommandService({ state: () => context.getState(), modalOpen: options.modal })
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
  const menus = new MenuService({ platform, commands, context, keybindings, theme, focus: focus.adapter, modalOpen: options.modal ?? (() => false), timers: options.timers, targets: menuTargets })
  const workbench = { platform, commands, context, documents, queries, files, editorOptions, connections, backend, targets, quickInput, keybindings, events, theme, panes, menus, explorer, databaseList, menuTargets, resultSelection, scriptingOptions, scripting }
  const contributions = [queryContribution(workbench, api), filesContribution(workbench, api), editorContribution(workbench), editContribution(workbench, api), windowContribution(workbench, api),
    menusContribution(workbench), explorerContribution(workbench, api), outputContribution(workbench, api), shellContribution(workbench, host), paletteContribution(workbench, history),
    themeContribution(workbench, api, options.timers), backendContribution(workbench), scriptingContribution(workbench)]
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
    menus.dispose(); quickInput.dispose(); contributions.forEach(contribution => contribution.dispose()); commands.dispose(); context.dispose(); files.dispose(); queries.dispose(); resultSelection.dispose()
    explorer.dispose(); databaseList.dispose(); scripting.dispose(); scriptingOptions.dispose(); documents.dispose(); backend.dispose()
  }
  return { ...doc, api, connections, backend, editorOptions, panes, explorer, databaseList, resultSelection, scriptingOptions, scripting, focusEditor, queries, files, targets, context, commands, keybindings, menus, menuTargets, quickInput, focus: focus.state, focused, history, host, theme, startQuery, connect, dispose }
}
