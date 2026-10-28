import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { VariaApi } from '../../../shared/contracts'
import { toPlatform, type Platform } from '../../../shared/commands/keybindings'
import { platformLineEnding } from '../../../shared/files/encoding'
import { DocumentService, settingsDocumentOptions } from '../services/documents'
import { QueryService } from '../services/queries'
import { ConnectionService } from '../services/connections'
import { FileService } from '../services/files'
import { RecentFilesService } from '../services/recent-files'
import { RecoveryService } from '../services/recovery'
import { EditorOptionsService } from '../services/editor-options'
import { EditorStatusService } from '../services/editor-status'
import { TargetService } from '../services/targets'
import { BackendStateService } from '../services/backend'
import { ResultClient } from '../results/ResultClient'
import { ResultsService } from '../results/ResultsService'
import { ResultMemoryService } from '../results/memory'
import { documentPage, LiveService } from '../live/LiveService'
import ResultsWorker from '../results/results.worker.ts?worker'
import { GridStats } from '../grid/stats'
import { PaneService } from '../services/panes'
import { ExplorerService } from '../explorer/ExplorerService'
import { DatabaseListService } from '../services/database-list'
import { ResultSelectionService } from '../services/result-selection'
import type { ThemeService } from '../services/theme'
import { queryContribution } from '../contributions/query'
import { filesContribution, watchExternalChanges } from '../contributions/files'
import { editorContribution } from '../contributions/editor'
import { paletteContribution } from '../contributions/palette'
import { themeContribution } from '../contributions/theme'
import { backendContribution } from '../contributions/backend'
import { helpContribution } from '../contributions/help'
import { editContribution } from '../contributions/edit'
import { windowContribution } from '../contributions/window'
import { menusContribution } from '../contributions/menus'
import { explorerContribution } from '../contributions/explorer'
import { outputContribution } from '../contributions/output'
import { scriptingContribution } from '../contributions/scripting'
import { settingsContribution } from '../contributions/settings'
import { editingContribution } from '../contributions/editing'
import { BookmarkService } from '../editor/bookmarks'
import { EditorDialogs } from '../editor/go-to-line'
import { scriptingOptionsFrom } from '../../../shared/settings/catalog'
import type { SettingsService } from '../settings/SettingsService'
import { ScriptingService } from '../scripting/ScriptingService'
import { ObjectActionService } from '../actions/ObjectActionService'
import { ObjectDialogService } from '../dialogs/ObjectDialogService'
import { actionsContribution } from '../contributions/actions'
import { designerContribution } from '../contributions/designer'
import { TableDesignerService } from '../designer/TableDesignerService'
import { ssisContribution } from '../contributions/ssis'
import { SsisOperationsService } from '../ssis/SsisOperationsService'
import { MenuService } from '../menus/MenuService'
import { trackWindowFocus } from '../menus/menubar'
import { MenuTargetService } from '../menus/targets'
import { QuickInputService } from '../quickinput/QuickInputService'
import { CommandService } from './commands'
import { ContextKeyService } from './contextkeys'
import { EventBus } from './events'
import { domFocusAdapter } from './focus'
import { InputModeService } from './input-mode'
import { KeybindingService } from './keybindings'
import { MenuStatePublisher } from './menu-state'
import { modalOpen } from './modal'
import { nextFrame as frame } from './frame'
import type { Disposable } from './types'

export interface Workbench extends Disposable {
  readonly platform: Platform
  readonly monaco: typeof Monaco
  readonly events: EventBus
  readonly commands: CommandService
  readonly context: ContextKeyService
  readonly keybindings: KeybindingService
  readonly menuState: MenuStatePublisher
  readonly menus: MenuService
  /** What context menus are for: components register their elements with `useMenuTarget`. */
  readonly menuTargets: MenuTargetService
  readonly quickInput: QuickInputService
  readonly documents: DocumentService
  readonly queries: QueryService
  readonly connections: ConnectionService
  readonly backend: BackendStateService
  /** Stored query results, read through the results worker. */
  readonly resultClient: ResultClient
  /** Each query tab's results: its result sets, Messages, view state, and copy jobs. */
  readonly results: ResultsService
  /** What the backend holds for results, for the status bar. */
  readonly resultMemory: ResultMemoryService
  /** Live views (Activity Monitor, SSIS monitoring): their subscriptions, pauses while hidden, and history. */
  readonly live: LiveService
  /** Test mode only: the grids' frame times and counters (`window.__variaGrid`). */
  readonly gridStats?: GridStats
  readonly files: FileService
  /** File › Recent Files, as main last sent it. */
  readonly recentFiles: RecentFilesService
  /** AutoRecover: copies of unsaved queries, and the Recover dialog for those an earlier run or page left. */
  readonly recovery: RecoveryService
  readonly targets: TargetService
  readonly editorOptions: EditorOptionsService
  /** Edit › Bookmarks: each open query's bookmarks, for this session. */
  readonly bookmarks: BookmarkService
  /** The query editor's dialogs (Go To Line). */
  readonly editorDialogs: EditorDialogs
  /** The editor caret's Ln, Col and Ch and the line ending, for the IDE status bar. */
  readonly editorStatus: EditorStatusService
  /** Insert or overtype (the Insert key). */
  readonly inputMode: InputModeService
  readonly panes: PaneService
  /** Object Explorer's tree: its nodes, loads, selection, and context keys. */
  readonly explorer: ExplorerService
  /** The databases of each connected server, for the toolbar's database picker. */
  readonly databaseList: DatabaseListService
  /** The cells selected in each query's results grid. */
  readonly resultSelection: ResultSelectionService
  /** Tools › Options: the settings main stores, which the services apply, and the Options dialog. */
  readonly settings: SettingsService
  /** Script As requests: their status, cancellation, and destinations. */
  readonly scripting: ScriptingService
  /** Object Explorer's Select Top, Rename and the other object actions. */
  readonly actions: ObjectActionService
  /** The object dialog that is open (Delete Object), its requests and its phase. */
  readonly dialogs: ObjectDialogService
  /** The table designers (New › Table…): their designs, saves and prompts. */
  readonly designers: TableDesignerService
  /** Integration Services Operations (Active Operations, All Executions…): each connection's document, filters and Stop Operation. */
  readonly operations: SsisOperationsService
  readonly theme: ThemeService
}
/**
 * The next animation frame, or 50 ms when frames are throttled: a hidden window (the smoke tests') gets one a second,
 * which would hold every Object Explorer update back that long.
 */
function nextFrame(callback: () => void): void {
  let done = false
  const run = () => { if (!done) { done = true; callback() } }
  requestAnimationFrame(run)
  setTimeout(run, 50)
}
/** The query editor's caret line in window coordinates, scrolled into view first: keyboard-opened editor menus open below it. */
function editorCaret(documents: DocumentService, monaco: typeof Monaco) {
  const editor = documents.boundEditor, position = editor?.getPosition()
  if (!editor || !position) return undefined
  editor.revealPosition(position, monaco.editor.ScrollType.Immediate)
  editor.render()
  const caret = editor.getScrolledVisiblePosition(position), box = editor.getContainerDomNode().getBoundingClientRect()
  if (!caret) return undefined
  const left = box.left + caret.left, top = box.top + caret.top
  return { left, top, right: left, bottom: top + caret.height }
}
export function createWorkbench(api: VariaApi, monaco: typeof Monaco, theme: ThemeService, settings: SettingsService): Workbench {
  const platform = toPlatform(api.platform)
  const events = new EventBus(), connections = new ConnectionService(), editorOptions = new EditorOptionsService(settings), panes = new PaneService()
  const explorer = new ExplorerService({ api, connections, events, schedule: nextFrame }), databaseList = new DatabaseListService(api, connections, events)
  const backend = new BackendStateService(api, connections)
  const documents = new DocumentService((text, uri, language) => monaco.editor.createModel(text, language, monaco.Uri.parse(uri)), api, events, callback => { frame(callback) },
    { ...settingsDocumentOptions(() => settings.getSnapshot().values), newLineEnding: platformLineEnding(platform) })
  const editorStatus = new EditorStatusService(callback => { frame(callback) }), inputMode = new InputModeService()
  const refreshDocuments = settings.subscribe(() => documents.refreshOptions())
  const bookmarks = new BookmarkService(documents, events), editorDialogs = new EditorDialogs()
  const resultClient = new ResultClient({ api, createWorker: () => new ResultsWorker(), window, schedule: callback => { frame(callback) } })
  const results = new ResultsService({ client: resultClient, api, events, documents, frame: callback => { frame(callback) } })
  const resultMemory = new ResultMemoryService(resultClient, events)
  const live = new LiveService({ client: resultClient, settings, page: documentPage(document), schedule: callback => { frame(callback) } })
  const gridStats = api.testMode ? new GridStats() : undefined
  const queries = new QueryService(documents, api, id => connections.get(id), events, results, undefined, undefined, () => settings.getSnapshot().values)
  const files = new FileService(documents, queries, api, { autoReload: () => settings.getSnapshot().values['environment.documents.autoReload'] })
  const recentFiles = new RecentFilesService(api)
  const recovery = new RecoveryService({
    api, documents, files, settings, warn: message => commands.reportWarning(message),
    server: id => { const connection = connections.get(id); return connection ? connection.displayName || connection.server : undefined }
  })
  const resultSelection = new ResultSelectionService(results)
  const targets = new TargetService(documents, queries, connections, files)
  const focus = domFocusAdapter(documents)
  const quickInput = new QuickInputService(focus)
  // Every Script As request carries the Scripting page's options.
  const scriptingOptions = { getSnapshot: () => ({ options: scriptingOptionsFrom(settings.getSnapshot().values) }), subscribe: settings.subscribe }
  // A throttled frame (a hidden or background window) can come after a dialog opened; the dialog keeps focus then.
  const scripting = new ScriptingService({ api, documents, files, connections, options: scriptingOptions, focusEditor: () => nextFrame(() => { if (!modalOpen()) documents.focusActive() }) })
  const dialogs = new ObjectDialogService({ api, connections, explorer, documents, files, focusEditor: () => nextFrame(() => { if (!modalOpen()) documents.focusActive() }) })
  const designers = new TableDesignerService({
    api, documents, files, connections, explorer,
    focus: id => nextFrame(() => { if (!modalOpen()) document.querySelector<HTMLElement>(`[data-designer="${CSS.escape(id)}"] [data-designer-focus]`)?.focus() })
  })
  const operations = new SsisOperationsService({
    api, documents, panes, live, connections, settings,
    focus: id => nextFrame(() => { if (!modalOpen()) document.querySelector<HTMLElement>(`[data-ssis-operations="${CSS.escape(id)}"] [role="grid"]`)?.focus() })
  })
  const context = new ContextKeyService({
    platform,
    documents,
    queries,
    connections,
    backend,
    editorOptions,
    panes,
    quickInput: quickInput.visibility,
    explorer: explorer.context,
    results: results.context,
    scripting: scripting.running,
    bookmarks,
    inputMode,
    recentFiles,
    recovery,
    designer: designers.context,
    ssis: operations.context,
    editor: () => documents.boundEditor
  })
  const commands = new CommandService({ state: () => context.getState(), modalOpen })
  const menuTargets = new MenuTargetService({ editor: () => {
    const editor = documents.boundEditor, tabId = documents.getSnapshot().activeId
    return editor && tabId ? { container: editor.getContainerDomNode(), tabId } : undefined
  } })
  // Menus label items with keys and the dispatcher routes keys to the menus; neither looks the other up before both exist.
  const menus = new MenuService({ platform, commands, context, keybindings: { lookup: id => keybindings.lookup(id) }, theme, recentFiles, settings: () => settings.getSnapshot().values, focus, modalOpen,
    findWidgetFocused: () => !!document.activeElement?.closest('.monaco-editor .find-widget'),
    menubarRect: id => document.getElementById('menubar-' + id)?.getBoundingClientRect(), targets: menuTargets, editorCaret: () => editorCaret(documents, monaco),
    modalContains: element => [...document.querySelectorAll('[aria-modal="true"]')].at(-1)?.contains(element) ?? false, style: api.menuStyle, api })
  const keybindings = new KeybindingService({ platform, commands, context, modalOpen, menus, editorHasTextFocus: () => documents.boundEditor?.hasTextFocus() ?? false,
    editorContains: target => target instanceof Node && !!documents.boundEditor?.getContainerDomNode().contains(target) })
  const menuState = new MenuStatePublisher({ commands, context, send: state => api.setMenuState(state) })
  const actions = new ObjectActionService({
    api, explorer, documents, queries, connections, selectTopCount: () => settings.get('objectExplorer.selectTopRows'),
    report: { error: message => commands.reportError(message), warning: message => commands.reportWarning(message) }
  })
  const cleanup = events.subscribe(event => { if (event.type === 'documents.closed') queries.forget(event.tabId) })
  let disposed = false
  const workbench: Workbench = {
    platform,
    monaco,
    events,
    commands,
    context,
    keybindings,
    menuState,
    menus,
    menuTargets,
    quickInput,
    documents,
    queries,
    connections,
    backend,
    resultClient,
    results,
    resultMemory,
    live,
    ...gridStats ? { gridStats } : {},
    files,
    recentFiles,
    recovery,
    targets,
    editorOptions,
    bookmarks,
    editorDialogs,
    editorStatus,
    inputMode,
    panes,
    explorer,
    databaseList,
    resultSelection,
    settings,
    scripting,
    actions,
    dialogs,
    designers,
    operations,
    theme,
    dispose: () => {
      if (disposed) return
      disposed = true
      // Before the documents close: a page that unloads leaves its AutoRecover copies to be offered.
      recovery.dispose()
      // Hiding the quick input first aborts its loads and ends any theme preview before the services they use go away.
      listeners.forEach(listener => listener.dispose()); menus.dispose(); quickInput.dispose(); menuState.dispose(); keybindings.dispose()
      contributions.forEach(contribution => contribution.dispose())
      cleanup.dispose()
      refreshDocuments()
      commands.dispose()
      context.dispose()
      files.dispose()
      recentFiles.dispose()
      queries.dispose()
      results.dispose()
      resultMemory.dispose()
      // Before the live views: its documents' views and stops are cancelled while the service still runs them.
      operations.dispose()
      // Before the client: its views cancel their subscriptions while the port is still there.
      live.dispose()
      resultClient.dispose()
      // Before the documents: its prompts resolve as Cancel and its requests are cancelled while their tabs still exist.
      designers.dispose()
      documents.dispose()
      backend.dispose()
      explorer.dispose()
      databaseList.dispose()
      scripting.dispose()
      actions.dispose()
      dialogs.dispose()
      connections.dispose()
      editorOptions.dispose()
      bookmarks.dispose()
      editorDialogs.dispose()
      editorStatus.dispose()
      inputMode.dispose()
      panes.dispose()
      resultSelection.dispose()
      settings.dispose()
      theme.dispose()
      events.dispose()
    }
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
    paletteContribution(workbench),
    themeContribution(workbench, api),
    backendContribution(workbench),
    helpContribution(workbench, api),
    scriptingContribution(workbench),
    actionsContribution(workbench),
    designerContribution(workbench),
    ssisContribution(workbench),
    settingsContribution(workbench)
  ]
  // Capture on window runs before Monaco's own listeners and React's handlers.
  const listeners = [
    keybindings.attach(window),
    menus.attach(window),
    trackWindowFocus(window, document.documentElement),
    watchExternalChanges(window, files, () => settings.getSnapshot().values['environment.documents.detectExternalChanges'])
  ]
  // SettingsService.create started the load: services use the defaults until main's settings arrive. A warning about the
  // file, or a failed load, shows in the command banner, including one from before the workbench existed.
  settings.setReporter((message, kind) => kind === 'warning' ? commands.reportWarning(message) : commands.reportError(message))
  documents.create('SQLQuery1.sql', '-- Connect this query to a server and press F5 to execute.\n\nSELECT\n    @@SERVERNAME AS server_name,\n    DB_NAME() AS database_name,\n    SYSDATETIME() AS server_time;\n', 'master')
  // What an earlier run or page left unsaved is offered once the workbench is up.
  void recovery.start()
  return workbench
}
