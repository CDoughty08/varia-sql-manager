import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { SqlLanguageService } from '../languages/SqlLanguageService'
import { SqlDiagnosticsService } from '../languages/SqlDiagnosticsService'
import { BigQueryCostService, costOptOut } from '../services/bigquery-cost'
import { CostPromptService } from '../services/bigquery-cost-prompt'
import { languagesContribution } from '../contributions/languages'
import { EditorPeekService } from '../languages/EditorPeekService'
import type { ReloadPins, VariaApi } from '../../../shared/contracts'
import { actsOnTab } from '../../../shared/commands/catalog'
import { toPlatform, type Platform } from '../../../shared/commands/keybindings'
import { platformLineEnding } from '../../../shared/files/encoding'
import { blockPrimaryPaste } from './primary-selection'
import { DocumentService, settingsDocumentOptions, welcomeQueryText } from '../services/documents'
import { QueryService } from '../services/queries'
import { ConnectionService } from '../services/connections'
import { ConnectionTargetService } from '../services/connection-targets'
import { bindStartupReconnect } from '../services/connection-startup'
import { bindConnectionPruning } from '../services/connection-pruning'
import type { StartupReconnectService } from '../services/startup-reconnect'
import { createDisconnectCoordinator } from '../services/disconnect-workbench'
import type { DisconnectCoordinator } from '../services/disconnect'
import { DisconnectPromptService } from '../disconnect/DisconnectPromptService'
import { FileService } from '../services/files'
import { RecentFilesService } from '../services/recent-files'
import { RecoveryService } from '../services/recovery'
import { keptSession, reloadSession, restoreSession } from '../services/session'
import { TabRenameService } from '../services/tab-rename'
import { EditorOptionsService } from '../services/editor-options'
import { ShellOptionsService } from '../services/shell-options'
import { EditorStatusService } from '../services/editor-status'
import { TargetService } from '../services/targets'
import { BackendStateService } from '../services/backend'
import { ResultClient } from '../results/ResultClient'
import { ResultVisibilityService } from '../results/ResultVisibilityService'
import { ResultsService } from '../results/ResultsService'
import { HighlightsService } from '../results/HighlightsService'
import { CompareService } from '../results/CompareService'
import { PivotService } from '../results/PivotService'
import { DerivedJobs } from '../results/derived-jobs'
import { ResultsSearchService } from '../results/search'
import { MemoryUsageService } from '../results/memory'
import { documentOwner, documentPage, eitherHidden, LiveService, mainWindowPage } from '../live/LiveService'
import { QueryPlansService } from '../plans/QueryPlansService'
import { RetainedPlansService } from '../plans/RetainedPlansService'
import { PlanPreparationCache } from '../plans/preparation'
import { ActivityMonitorService } from '../activity/ActivityMonitorService'
import { activityContribution } from '../contributions/activity'
import { searchContribution } from '../contributions/search'
import ResultsWorker from '../results/results.worker.ts?worker'
import { GridStats } from '../grid/stats'
import { PaneService } from '../services/panes'
import { EditorGroupService } from '../services/editor-groups'
import { ExplorerService } from '../explorer/ExplorerService'
import { ServerDropService } from '../editor-groups/server-drop'
import { ExplorerStatusService } from '../explorer/ExplorerStatusService'
import { DatabaseListService } from '../services/database-list'
import { SsisTreeProbe } from '../ssis/SsisTreeProbe'
import { ResultSelectionService } from '../services/result-selection'
import { PeekService } from '../explorer/PeekService'
import { PeekTabService } from '../explorer/PeekTabService'
import type { ThemeService } from '../services/theme'
import { queryContribution } from '../contributions/query'
import { providerSwitchToast, switchModelLanguage } from '../languages/query-language'
import { filesContribution, watchExternalChanges } from '../contributions/files'
import { editorContribution } from '../contributions/editor'
import { paletteContribution } from '../contributions/palette'
import { themeContribution } from '../contributions/theme'
import { backendContribution } from '../contributions/backend'
import { helpContribution } from '../contributions/help'
import { updatesContribution } from '../contributions/updates'
import { UpdateService } from '../updates/UpdateService'
import { ReleaseNotesService } from '../release-notes/ReleaseNotesService'
import { HelpService } from '../help/HelpService'
import { editContribution } from '../contributions/edit'
import { windowContribution } from '../contributions/window'
import { menusContribution } from '../contributions/menus'
import { explorerContribution } from '../contributions/explorer'
import { outputContribution } from '../contributions/output'
import { messagesContribution } from '../contributions/messages'
import { highlightsContribution } from '../contributions/highlights'
import { pivotContribution } from '../contributions/pivot'
import { transposeContribution } from '../contributions/transpose'
import { compareContribution } from '../contributions/compare'
import { scriptingContribution } from '../contributions/scripting'
import { settingsContribution } from '../contributions/settings'
import { editingContribution } from '../contributions/editing'
import { BookmarkService } from '../editor/bookmarks'
import { EditorDialogs } from '../editor/go-to-line'
import { scriptingOptionsFrom } from '../../../shared/settings/catalog'
import type { SettingsService } from '../settings/SettingsService'
import { ScriptingService } from '../scripting/ScriptingService'
import { objectActionNoticeKey, ObjectActionService } from '../actions/ObjectActionService'
import { databaseRenameHooks } from '../actions/database-rename'
import { databaseGoneHandler } from '../dialogs/database-gone'
import { ActionProgressService } from '../actions/ActionProgressService'
import { ObjectDialogService } from '../dialogs/ObjectDialogService'
import { ServerFilePickerService } from '../server-files/ServerFilePickerService'
import { CreateCatalogService } from '../ssis/CreateCatalogService'
import { DependenciesService } from '../explorer/DependenciesService'
import { LongRunService } from '../services/long-runs'
import { actionsContribution } from '../contributions/actions'
import { designerContribution } from '../contributions/designer'
import { notificationsContribution } from '../contributions/notifications'
import { TableDesignerService } from '../designer/TableDesignerService'
import { ssisFocuser } from '../ssis/focus'
import { SsisPropertiesService } from '../ssis/SsisPropertiesService'
import { ssisContribution } from '../contributions/ssis'
import { DatabasePropertiesService } from '../properties/DatabasePropertiesService'
import { TablePropertiesService } from '../properties/TablePropertiesService'
import { NewDatabaseService } from '../new-database/NewDatabaseService'
import { RestoreService } from '../restore/RestoreService'
import { SsisOperationsService } from '../ssis/SsisOperationsService'
import { SearchDetailsService } from '../search/SearchDetailsService'
import { ObjectSearchService } from '../search/ObjectSearchService'
import { MenuService } from '../menus/MenuService'
import { trackWindowFocus } from '../menus/menubar'
import { followReducedMotion, reducedMotionQuery } from '../services/reduced-motion'
import { MenuTargetService } from '../menus/targets'
import { QuickInputService } from '../quickinput/QuickInputService'
import { CommandService } from './commands'
import { NotificationService } from './notifications'
import { ContextKeyService } from './contextkeys'
import { onUnexpectedError } from './errors'
import { EventBus } from './events'
import { domFocusAdapter } from './focus'
import { InputModeService } from './input-mode'
import { KeybindingService } from './keybindings'
import { ProfilePeekService } from '../results/ProfilePeekService'
import { gesturesFor, type GestureService } from './gestures'
import { ShortcutsService } from './ShortcutsService'
import { MenuStatePublisher } from './menu-state'
import { focusHeld, focusWhenDrawn, modalOpen, openModal } from './modal'
import { nextFrame as frame } from './frame'
import { windows } from './windows'
import { peekEditorHasTextFocus } from '../explorer/peek-editor'
import type { Disposable } from './types'

export interface Workbench extends Disposable {
  readonly platform: Platform
  readonly monaco: typeof Monaco
  readonly events: EventBus
  readonly commands: CommandService
  readonly context: ContextKeyService
  readonly keybindings: KeybindingService
  /** Pointer gestures' modifiers (src/shared/commands/gestures.ts); handlers ask it instead of reading ctrlKey and the rest. */
  readonly gestures: GestureService
  readonly menuState: MenuStatePublisher
  readonly menus: MenuService
  /** What context menus are for: components register their elements with `useMenuTarget`. */
  readonly menuTargets: MenuTargetService
  readonly quickInput: QuickInputService
  readonly documents: DocumentService
  readonly sqlLanguage: SqlLanguageService
  readonly sqlDiagnostics: SqlDiagnosticsService
  /** BigQuery tabs' estimates, dry-run diagnostics and cost prompts (docs/bigquery.md, Cost). */
  readonly bigQueryCost: BigQueryCostService
  readonly costPrompts: CostPromptService
  readonly queries: QueryService
  readonly connections: ConnectionService
  readonly connectionTargets: ConnectionTargetService
  readonly connectionReady: Promise<void>
  readonly startupReconnect: StartupReconnectService
  readonly disconnectCoordinator: DisconnectCoordinator
  readonly disconnectPrompts: DisconnectPromptService
  readonly backend: BackendStateService
  /** Stored query results, read through the results worker. */
  readonly resultClient: ResultClient
  /** Which results' grids are shown in any window, for the backend (results.visibility). */
  readonly resultVisibility: ResultVisibilityService
  /** Each query tab's results: its result sets, Messages, view state, and copy jobs. */
  readonly results: ResultsService
  /** Rows highlighted in each query tab's grids, found again by identity after sorts and re-runs. */
  readonly highlights: HighlightsService
  readonly compare: CompareService
  /** The window's places for pivot builds and comparisons: four run at once, and a busy backend is asked again. */
  readonly derivedJobs: DerivedJobs
  readonly pivot: PivotService
  /** Search in results: each tab's search box, its matches (found in the backend) and column-name matches. */
  readonly resultsSearch: ResultsSearchService
  /** What the backend holds for results, for the status bar. */
  readonly resultMemory: MemoryUsageService
  readonly indexMemory: MemoryUsageService
  /** Live views (Activity Monitor, SSIS monitoring): their subscriptions, pauses while hidden, and history. */
  readonly live: LiveService
  readonly queryPlans: QueryPlansService
  readonly retainedPlans: RetainedPlansService
  readonly planPreparation: PlanPreparationCache
  /** Test mode only: the grids' frame times and counters (`window.__variaGrid`). */
  readonly gridStats?: GridStats
  readonly files: FileService
  /** File › Recent Files, as main last sent it. */
  readonly recentFiles: RecentFilesService
  /** AutoRecover: copies of unsaved queries, and the Recover dialog for those an earlier run or page left. */
  readonly recovery: RecoveryService
  readonly reloadPins: () => ReloadPins | undefined
  readonly targets: TargetService
  readonly editorOptions: EditorOptionsService
  readonly shellOptions: ShellOptionsService
  /** Edit › Bookmarks: each open query's bookmarks, for this session. */
  readonly bookmarks: BookmarkService
  /** The query editor's dialogs (Go To Line). */
  readonly editorDialogs: EditorDialogs
  /** The editor caret's Ln, Col and Ch and the line ending, for the IDE status bar. */
  readonly editorStatus: EditorStatusService
  /** Insert or overtype (the Insert key). */
  readonly inputMode: InputModeService
  /** Rename Tab's inline edit in the document strip. */
  readonly tabRename: TabRenameService
  /** A server or database dragged from Object Explorer onto a query's tab or editor (docs/connections-explorer.md). */
  readonly serverDrop: ServerDropService
  /** The query editor's editor groups (docs/editor-groups.md). */
  readonly editorGroups: EditorGroupService
  readonly panes: PaneService
  /** Object Explorer's tree: its nodes, loads, selection, and context keys. */
  readonly explorer: ExplorerService
  /** Object Explorer's live status chips: one background live view per connected server while the pane shows. */
  readonly explorerStatus: ExplorerStatusService
  /** The SSIS Catalog's live tree: one catalog probe per connection whose SSISDB node is open, reconciling what changed. */
  readonly ssisTree: SsisTreeProbe
  /** The databases of each connected server, for the toolbar's database picker. */
  readonly databaseList: DatabaseListService
  /** The cells selected in each query's results grid. */
  readonly resultSelection: ResultSelectionService
  /** Tools › Options: the settings main stores, which the services apply, and the Options dialog. */
  readonly settings: SettingsService
  /** The user's keyboard and mouse shortcuts main stores; each change applies to the keys, labels, menus, the editor bridge and gestures. */
  readonly shortcuts: ShortcutsService
  /** Script As requests: their status, cancellation, and destinations. */
  readonly scripting: ScriptingService
  /** Object Explorer's Peek card: the object it shows and its reads. */
  readonly peek: PeekService
  /** Peek promoted to document tabs: each tab's view. */
  readonly peekTabs: PeekTabService
  /** The column profile's Ctrl+hover peek at the selected columns: the tab whose panel peeks. */
  readonly profilePeek: ProfilePeekService
  /** Go To and Peek Definition in SQL editors: F12's script, the card at a name (Alt+F12, Ctrl+hover), a Peek tab (Ctrl+click). */
  readonly editorPeek: EditorPeekService
  /** Object Explorer's Select Top, Rename and the other object actions. */
  readonly actions: ObjectActionService
  /** The latest STATS progress of the long object actions (restore, backup) this window runs, by request id. */
  readonly actionProgress: ActionProgressService
  /** The object dialog that is open (Delete Object), its requests and its phase. */
  readonly dialogs: ObjectDialogService
  /** The server file picker (Locate Backup File, Locate Database Files, Locate Folder) that a dialog's "…" button opens. */
  readonly serverFiles: ServerFilePickerService
  /** Integration Services Catalogs › Create Catalog…: its dialog, the server's setup and the create request. */
  readonly ssisCatalog: CreateCatalogService
  /** The long runs (Create Catalog, a restore): they refuse a window close, a Disconnect of their server and Restart. */
  readonly longRuns: LongRunService
  /** Object Explorer › View Dependencies: its dialog and the tree it reads one level at a time. */
  readonly dependencies: DependenciesService
  /** The table designers (New › Table…): their designs, saves and prompts. */
  readonly designers: TableDesignerService
  /** The SSIS Catalog's properties documents (Folder, Project, Package and Environment Properties). */
  readonly ssisProperties: SsisPropertiesService
  /** Database Properties documents: their drafts, Apply, Script previews and frames. */
  readonly properties: DatabasePropertiesService
  /** Table Properties documents: their drafts, Apply in one transaction, Script previews and frames. */
  readonly tableProperties: TablePropertiesService
  /** New Database documents (D1b): their designs, OK as a long run, Script previews and frames. */
  readonly newDatabase: NewDatabaseService
  /** Restore Database documents: read, Script (D1e) and run with Stop (D1f), opened from the Databases folder and a database's Tasks › Restore. */
  readonly restore: RestoreService
  /** The Activity Monitors: one per connection, each a live view of its server. */
  readonly activity: ActivityMonitorService
  /** Integration Services Operations (Active Operations, All Executions…): each connection's document, filters and Stop Operation. */
  readonly operations: SsisOperationsService
  /** Search Objects: each connected server's object index (built in the backend) and the Search Objects tabs. */
  readonly objectSearch: ObjectSearchService
  /** The Search Objects tabs' details pane: the selected hit's properties and definition. */
  readonly searchDetails: SearchDetailsService
  readonly theme: ThemeService
  /** Toasts for work that finished out of sight, such as a save whose query is not the active document. */
  readonly notifications: NotificationService
  /** Help › Check for Updates, as main reports it. */
  readonly updates: UpdateService
  readonly releaseNotes: ReleaseNotesService
  readonly help: HelpService
  /**
   * Makes a popout window a full part of the workbench while it is open: its keys reach `KeybindingService`, its right-clicks
   * and presses `MenuService`, and its focus counts as the user's window (`windows`).
   */
  attachWindow(target: Window): Disposable
  /** Tools › Options and Help › About open in dialog windows of their own (popouts/DialogWindow.tsx); unit tests' workbenches leave it out. */
  readonly dialogWindows?: boolean
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
export function createWorkbench(api: VariaApi, monaco: typeof Monaco, theme: ThemeService, settings: SettingsService, shortcuts?: ShortcutsService): Workbench {
  const platform = toPlatform(api.platform)
  // Normally loaded before the workbench (start.tsx), so the first key already follows the user's shortcuts.
  const userShortcuts = shortcuts ?? new ShortcutsService({ api: api.shortcuts, platform })
  const connectionTargets = new ConnectionTargetService()
  let connectionRestored!: () => void
  const connectionReady = new Promise<void>(resolve => { connectionRestored = resolve })
  const events = new EventBus(), connections = new ConnectionService(connectionTargets), editorOptions = new EditorOptionsService(settings), shellOptions = new ShellOptionsService(settings), panes = new PaneService()
  // Group by Schema follows its setting (the toolbar button and the palette flip it).
  const groupBySchema = { get: () => settings.get('objectExplorer.groupBySchema'), subscribe: settings.subscribe }
  // Smoke runs (followSystemMotion) reduce motion whenever their emulated media asks, whatever the setting says; they
  // re-read the media after each emulateMedia (scripts/fixtures/smoke.mjs).
  const reducedMotion = followReducedMotion(document.documentElement, { enabled: () => api.followSystemMotion || settings.get('environment.reduceMotionWithSystem'), subscribe: settings.subscribe,
    media: typeof matchMedia === 'function' ? matchMedia(reducedMotionQuery) : undefined })
  if (api.testMode) Object.assign(window, { __variaMotion: { refresh: () => reducedMotion.refresh() } })
  const explorer = new ExplorerService({ api, connections, events, schedule: nextFrame, groupBySchema, targets: connectionTargets, agentEnabled: api.agentPreview }), databaseList = new DatabaseListService(api, connections, events)
  const backend = new BackendStateService(api, connections)
  const notifications = new NotificationService()
  const updates = new UpdateService(api)
  const documents = new DocumentService((text, uri, language) => monaco.editor.createModel(text, language, monaco.Uri.parse(uri)), api, events, callback => { frame(callback) },
    { ...settingsDocumentOptions(() => settings.getSnapshot().values), newLineEnding: platformLineEnding(platform), server: id => connections.get(id)?.server, target: id => targets.targetForConnection(id),
      provider: id => { const connection = connections.get(id); return connection ? connection.providerId ?? 'sqlserver' : undefined },
      setLanguage: (model, language) => switchModelLanguage(monaco, model, language),
      providerChanged: document => notifications.notify(providerSwitchToast(document)) })
  const editorStatus = new EditorStatusService(callback => { frame(callback) }), inputMode = new InputModeService()
  const sqlLanguage = new SqlLanguageService(monaco, api, documents, connections, backend)
  const sqlDiagnostics = new SqlDiagnosticsService(monaco, sqlLanguage, documents, connections,
    { enabled: () => settings.get('textEditor.sql.errorChecking'), subscribe: listener => settings.subscribe(listener) }, backend)
  const refreshDocuments = settings.subscribe(() => documents.refreshOptions())
  const bookmarks = new BookmarkService(documents, events), editorDialogs = new EditorDialogs(), tabRename = new TabRenameService(documents)
  const editorGroups = new EditorGroupService(documents)
  // Closing the active document shows the next one in its own editor group.
  const closeSuccessor = documents.useCloseSuccessor(id => editorGroups.successor(id))
  const resultClient = new ResultClient({ api, createWorker: () => new ResultsWorker(), window, schedule: callback => { frame(callback) } })
  // The main window's visibility, for live views and result visibility alike.
  const mainPage = eitherHidden(documentPage(document), mainWindowPage(api))
  const resultVisibility = new ResultVisibilityService({
    send: params => api.setResultVisibility(params), generation: () => resultClient.backendGeneration, onGeneration: listener => resultClient.onGeneration(listener),
    onBackendState: listener => api.onBackendState(listener), backendState: () => api.getBackendState(), onLayout: listener => panes.subscribe(listener), mainPage, mainWindow: window
  })
  const retainedPlans = new RetainedPlansService()
  const results = new ResultsService({ client: resultClient, api, events, documents, retainedPlans, frame: callback => { frame(callback) }, sortText: () => settings.get('queryResults.grid.sortText'),
    // Sorted grids follow Sort text by as it changes, from the toolbar, the palette or Options.
    onSortTextChange: listener => settings.subscribe(listener) })
  const highlights = new HighlightsService(results)
  // The window's places for derived results built in the backend, shared by Pivot builds and comparisons: four at once.
  const derivedJobs = new DerivedJobs()
  // Each counts the other's new results in flight against a run's 1,000.
  const compare: CompareService = new CompareService(results, { jobs: derivedJobs, adding: tabId => pivot.adding(tabId) })
  // A shown Pivot rebuilds by itself when its Table's filters change; what is shown depends on the results' layout.
  const pivot: PivotService = new PivotService(results, {
    jobs: derivedJobs, adding: tabId => compare.adding(tabId),
    follow: {
      layout: () => settings.get('queryResults.grid.layout'), resultsShowing: () => panes.getSnapshot().results,
      onLayout: listener => { const a = settings.subscribe(listener), b = panes.subscribe(listener); return () => { a(); b() } }
    }
  })
  const resultsSearch = new ResultsSearchService({ results })
  const resultMemory = new MemoryUsageService(resultClient, 'results', events)
  const indexMemory = new MemoryUsageService(resultClient, 'index')
  // The backend caps live views per server it reaches; a typed name is the closest this side knows.
  const live = new LiveService({ client: resultClient, settings, page: mainPage, schedule: callback => { frame(callback) }, serverOf: id => connections.get(id)?.server.trim().toLowerCase() })
  const explorerStatus = new ExplorerStatusService({ live, connections, panes, settings, schedule: callback => { frame(callback) }, agent: api.agentPreview })
  // A database's menu follows its live state (Take Offline greys once a sample shows it offline), not only its listing.
  const explorerRuntime = explorer.useStatus(explorerStatus)
  const ssisTree = new SsisTreeProbe({ explorer, live, settings, events, explorerVisible: { visible: () => panes.getSnapshot().explorer, subscribe: panes.subscribe, popout: () => panes.location('explorer') === 'window' } })
  const gridStats = api.testMode ? new GridStats() : undefined
  const queries = new QueryService(documents, api, id => connections.get(id), events, results, undefined, undefined, () => settings.getSnapshot().values, retainedPlans)
  const costPrompts = new CostPromptService()
  // The saved choice is read after the service exists, so it re-renders the chips once a choice is known.
  let costChoiceChanged = () => {}
  const bigQueryCost = new BigQueryCostService({ api, documents, connections, settings, events, monaco, ask: (request, signal, stillAsks) => costPrompts.ask(request, signal, stillAsks), optOut: costOptOut(api, () => costChoiceChanged()) })
  costChoiceChanged = () => bigQueryCost.optOutChanged()
  queries.setCostGate((tabId, sql, origin, signal) => bigQueryCost.beforeExecute(tabId, sql, origin, signal))
  const queryPlans = new QueryPlansService(live, documents, queries, panes, results)
  const planPreparation = new PlanPreparationCache()
  const planReleases = resultClient.onRelease(keys => planPreparation.release(keys))
  const planGenerations = resultClient.onGeneration(() => planPreparation.clear())
  const planEvents = events.subscribe(event => {
    if (event.type === 'documents.closed') planPreparation.close(event.tabId)
    if (event.type === 'query.started') planPreparation.forgetScope(event.tabId)
  })
  const files = new FileService(documents, queries, api, {
    autoReload: () => settings.getSnapshot().values['environment.documents.autoReload'],
    // The strict workspace keeps target identity and intent, never passwords or runtime transport/session handles.
    hotExit: (final = true) => {
      if (!api.hotExit) return
      const pinnedOnly = !settings.getSnapshot().values['environment.documents.hotExit']
      if (!pinnedOnly || documents.getSnapshot().documents.some(tab => tab.pinned) || connectionTargets.getSnapshot().length)
        return keptSession(documents, id => connections.get(id)?.server, { pinnedOnly, groups: editorGroups, connectionTargets, explorerExpansion: () => explorer.savedExpansion(), assertConnectionsReady: () => connections.assertCheckpointReady(final) })
    }
  })
  const recentFiles = new RecentFilesService(api)
  const recovery = new RecoveryService({
    api, documents, files, settings, warn: message => commands.reportWarning(message),
    server: id => { const connection = connections.get(id); return connection ? connection.displayName || connection.server : undefined }
  })
  const resultSelection = new ResultSelectionService(results)
  const targets = new TargetService(documents, queries, connections, files, connectionTargets)
  const serverDrop = new ServerDropService({ documents, queries, targets, connections })
  const targetIdOf = (connectionId: string) => targets.targetForConnection(connectionId)
  const focus = domFocusAdapter(documents)
  const quickInput = new QuickInputService(focus)
  // Every Script As request carries the Scripting page's options.
  const scriptingOptions = { getSnapshot: () => ({ options: scriptingOptionsFrom(settings.getSnapshot().values) }), subscribe: settings.subscribe }
  // A document focuses itself once drawn, unless a dialog, the palette or a menu has focus by then (focusWhenDrawn).
  const focusLater = (focus: () => void) => focusWhenDrawn(nextFrame, focus)
  const scripting = new ScriptingService({ api, documents, files, connections, options: scriptingOptions, focusEditor: () => focusLater(() => documents.focusActive()) })
  // The column profile's Ctrl+hover peek at the selected columns; the key dispatcher below feeds it held keys.
  const profilePeek = new ProfilePeekService({ gestures: gesturesFor(platform) })
  // Object Explorer's Peek on Hover modifier arms the peek cursor and a press over a resting row; releasing either one
  // (Object Explorer's or the query editor's, as remapped) forgets a pending hover.
  const peek = new PeekService({ api, connections, scriptingOptions, platform, results, gestures: gesturesFor(platform),
    hoverModifier: key => gesturesFor(platform).isModifierKey('explorer.peekHover', key) || gesturesFor(platform).isModifierKey('editor.peekHover', key) })
  const serverFiles = new ServerFilePickerService({ api, connections })
  const longRuns = new LongRunService({ api })
  const disconnectPrompts = new DisconnectPromptService()
  const disconnectCoordinator = createDisconnectCoordinator({
    connectionTargets, documents, queries, files, longRuns, api, prompts: disconnectPrompts,
    detached: (targetId, handle) => targets.detached(targetId, handle),
    closeQueries: plan => files.closeDisconnectedQueries(plan, approved => documents.closeDisconnectedQueries(approved))
  })
  const startup = bindStartupReconnect({ api, connections, documents, targets, backend, settings, ready: connectionReady })
  const connectionPruning = bindConnectionPruning({ registry: connectionTargets, documents, api, ready: connectionReady })
  const dialogs = new ObjectDialogService({
    api, connections, explorer, documents, files, serverFiles, longRuns, focusEditor: () => focusLater(() => documents.focusActive()),
    // Database Properties documents of a database a dialog took offline or brought online follow it.
    databaseState: (connectionId, database, offline) => properties.databaseStateChanged(connectionId, database, offline),
    databaseGone: gone => databaseGone(gone), tabNames: ids => queries.tabNames(ids),
    notify: message => notifications.notify({ severity: 'info', message, key: objectActionNoticeKey })
  })
  const ssisCatalog = new CreateCatalogService({ api, connections, explorer, longRuns })
  const designers = new TableDesignerService({
    api, documents, files, connections, explorer, targetIdOf,
    focus: id => focusLater(() => document.querySelector<HTMLElement>(`[data-designer="${CSS.escape(id)}"] [data-designer-focus]`)?.focus())
  })
  // Focus goes to the document's current section in its list, else to its first button (Refresh), once its first read
  // has drawn them.
  const ssisFocus = ssisFocuser({ get: id => ssisProperties.get(id), subscribe: listener => ssisProperties.subscribe(listener) }, {
    root: id => document.querySelector<HTMLElement>(`[data-ssis-document="${CSS.escape(id)}"]`), activeElement: () => document.activeElement, body: () => document.body,
    focusHeld, frame
  })
  const ssisProperties = new SsisPropertiesService({ api, documents, connections, targetIdOf, focus: id => ssisFocus.focus(id) })
  const properties = new DatabasePropertiesService({
    api, documents, files, connections, explorer, targetIdOf, focusEditor: () => focusLater(() => documents.focusActive()), close: id => { void files.close(id) },
    // The current section's item in the list: one tab stop, from which the keys move through the sections.
    focus: id => focusLater(() => document.querySelector<HTMLElement>(`[data-properties="${CSS.escape(id)}"] .document-nav-item[tabindex="0"]`)?.focus())
  })
  const tableProperties = new TablePropertiesService({
    api, documents, files, connections, targetIdOf,
    focus: id => focusLater(() => document.querySelector<HTMLElement>(`[data-table-properties="${CSS.escape(id)}"] .document-nav-item[tabindex="0"]`)?.focus())
  })
  const newDatabase = new NewDatabaseService({
    api, documents, files, connections, explorer, longRuns, serverFiles, targetIdOf, focusEditor: () => focusLater(() => documents.focusActive()),
    // The database name, once the first read has drawn it; until then the document's first section in its list.
    focus: id => focusLater(() => {
      const root = document.querySelector<HTMLElement>(`[data-new-database="${CSS.escape(id)}"]`)
      const name = root?.querySelector<HTMLElement>('[data-new-database-focus]:not(:disabled)')
      ;(name ?? root?.querySelector<HTMLElement>('.document-nav-item[tabindex="0"]'))?.focus()
    })
  })
  // Before Restore Database, whose runs track their STATS progress in it.
  const actionProgress = new ActionProgressService(api)
  const restore = new RestoreService({
    api, documents, files, connections, longRuns, progress: actionProgress, explorer, transactions: queries, targetIdOf, focusEditor: () => focusLater(() => documents.focusActive()),
    focus: id => focusLater(() => document.querySelector<HTMLElement>(`[data-restore="${CSS.escape(id)}"] .document-nav-item[tabindex="0"]`)?.focus())
  })
  // A database Delete or Detach removed: its Properties documents turn orphan and a toast counts the query windows left on it
  // (D3 §8); a detached one's toast offers Copy paths for its files.
  const databaseGone = databaseGoneHandler({
    documents, properties, notify: toast => { notifications.notify(toast) },
    copy: text => { void api.writeClipboardText(text).then(result => { if (!result.ok) commands.reportWarning(result.error) }, onUnexpectedError) }
  })
  const activity = new ActivityMonitorService({
    api, documents, connections, live, targetIdOf, owner: id => documentOwner(id, documents, panes, editorGroups), settings: () => settings.getSnapshot().values,
    focus: id => focusLater(() => document.querySelector<HTMLElement>(`[data-activity-monitor="${CSS.escape(id)}"] [data-activity-focus]`)?.focus())
  })
  const operations = new SsisOperationsService({
    api, documents, panes, groups: editorGroups, live, connections, settings, targetIdOf,
    focus: id => focusLater(() => document.querySelector<HTMLElement>(`[data-ssis-operations="${CSS.escape(id)}"] [role="grid"]`)?.focus())
  })
  const objectSearch = new ObjectSearchService({
    api, documents, connections, settings, targetIdOf, agentEnabled: api.agentPreview,
    focus: id => focusLater(() => document.querySelector<HTMLElement>(`[data-object-search="${CSS.escape(id)}"] [data-object-search-focus]`)?.focus())
  })
  const peekTabs = new PeekTabService({
    peek, documents, connections, targetIdOf,
    focus: id => focusLater(() => document.querySelector<HTMLElement>(`[data-peek-tab="${CSS.escape(id)}"] [role="tab"][aria-selected="true"]`)?.focus())
  })
  const editorPeek = new EditorPeekService({ sqlLanguage, connections, scripting, peek, peekTabs })
  // A dependency is shown as Search Objects' Reveal shows a hit; a failed walk says why in the command banner.
  const dependencies = new DependenciesService({
    api, connections, explorer,
    reveal: (connectionId, hit) => { void objectSearch.reveal(explorer, connectionId, hit).then(outcome => { if (!outcome.ok && !outcome.cancelled) commands.reportError(outcome.message) }, onUnexpectedError) },
    peek: node => { peekTabs.open(node) }
  })
  const releaseNotes = new ReleaseNotesService(documents, () => updates.getSnapshot().currentVersion,
    id => focusLater(() => {
      const target = document.querySelector<HTMLElement>(`[data-release-notes="${CSS.escape(id)}"] [aria-label="Release version"]`)
      if (!target) return
      if (windows.active() !== window) window.focus()
      target.focus()
    }))
  const help = new HelpService(documents, id => focusLater(() => {
    const root = document.querySelector<HTMLElement>(`[data-help-document="${CSS.escape(id)}"]`)
    const target = root?.querySelector<HTMLElement>('[data-help-focus]') ?? root?.querySelector<HTMLElement>('button')
    if (!target || documents.getSnapshot().activeId !== id) return
    if (windows.active() !== window) window.focus()
    target.focus()
  }))
  const searchDetails = new SearchDetailsService({ api, peek, connections, searches: objectSearch, scriptingOptions })
  const context = new ContextKeyService({
    platform,
    agentEnabled: api.agentPreview,
    settings,
    documents,
    queries,
    connections,
    backend,
    editorOptions,
    panes,
    shell: shellOptions,
    quickInput: quickInput.visibility,
    explorer: explorer.context,
    results: results.context,
    resultSets: results.resultSets,
    resultsSteppable: results.steppable,
    resultsTurned: results.turned,
    scripting: scripting.running,
    bookmarks,
    inputMode,
    recentFiles,
    recovery,
    designer: designers.context,
    properties: properties.context,
    tableProperties: tableProperties.context,
    newDatabase: newDatabase.context,
    restore: restore.context,
    notifications,
    updates,
    activity: activity.context,
    ssis: operations.context,
    editorGroups,
    editor: () => documents.boundEditor
  })
  const commands = new CommandService({ state: () => context.getState(), modalOpen })
  const stopConnectionBindings = api.onConnectionBindingsChanged(update => { if (connections.bindingsChanged(update) && update.warning) commands.reportWarning(update.warning) })
  const menuTargets = new MenuTargetService({ editor: () => {
    const editor = documents.boundEditor, tabId = documents.getSnapshot().activeId
    return editor && tabId ? { container: editor.getContainerDomNode(), tabId } : undefined
  } })
  // Menus label items with keys and the dispatcher routes keys to the menus; neither looks the other up before both exist.
  const menus = new MenuService({ platform, commands, context, keybindings: { lookup: id => keybindings.lookup(id) }, theme, recentFiles, settings: () => settings.getSnapshot().values, focus, modalOpen,
    findWidgetFocused: () => !!windows.activeElement()?.closest('.monaco-editor .find-widget'),
    menubarRect: id => document.getElementById('menubar-' + id)?.getBoundingClientRect(), targets: menuTargets, editorCaret: () => editorCaret(documents, monaco),
    modalContains: element => openModal()?.contains(element) ?? false, style: api.menuStyle, api })
  const keybindings = new KeybindingService({ platform, commands, context, modalOpen, menus,
    keyArgs: command => { const tabId = actsOnTab(command) ? editorGroups.focusedDocument() : undefined; return tabId ? { tabId } : undefined }, // Peek's editor waits for a chord's second key after Ctrl+K as a query's does (folding works there; the bridge's chords do not).
    editorHasTextFocus: () => (documents.boundEditor?.hasTextFocus() ?? false) || peekEditorHasTextFocus(windows.activeElement()),
    editorContains: target => target instanceof Node && !!documents.boundEditor?.getContainerDomNode().contains(target),
    keyDown: event => { peek.keyDown(event.key, event.repeat); profilePeek.keyDown(event.key, event.repeat) },
    keyUp: event => { peek.keyUp(event.key); profilePeek.keyUp(event.key) }, blur: () => { peek.blur(); profilePeek.blur() } })
  const shortcutsBinding = userShortcuts.bind({ keybindings, gestures: gesturesFor(platform) })
  if (!shortcuts) void userShortcuts.load()
  const menuState = new MenuStatePublisher({ commands, context, send: state => api.setMenuState(state) })
  const actions = new ObjectActionService({
    api, explorer, documents, queries, connections, selectTopCount: () => settings.get('objectExplorer.selectTopRows'),
    report: { error: message => commands.reportError(message), warning: message => commands.reportWarning(message), clear: message => commands.clearError(message), notice: message => notifications.notify({ severity: 'info', message, key: objectActionNoticeKey }) },
    databases: databaseRenameHooks({ documents, queries, connections, targets, properties }),
    notify: notice => { notifications.notify(notice) }
  })
  const cleanup = events.subscribe(event => { if (event.type === 'documents.closed') queries.forget(event.tabId) })
  let disposed = false
  const reloadPins = (): ReloadPins | undefined => {
    if (!api.hotExit) return
    return reloadSession(documents, id => connections.get(id)?.server, {
      restoreQueries: settings.get('environment.documents.hotExit'), recoveryId: id => recovery.copyId(id), groups: editorGroups, connectionTargets, explorerExpansion: () => explorer.savedExpansion(), assertConnectionsReady: () => connections.assertCheckpointReady()
    })
  }
  const workbench: Workbench = {
    reloadPins,
    platform,
    monaco,
    events,
    commands,
    context,
    keybindings,
    gestures: gesturesFor(platform),
    menuState,
    menus,
    menuTargets,
    quickInput,
    documents,
    sqlLanguage,
    sqlDiagnostics,
    bigQueryCost,
    costPrompts,
    queries,
    connections,
    backend,
    resultClient,
    connectionTargets,
    connectionReady,
    startupReconnect: startup.scheduler,
    disconnectPrompts,
    disconnectCoordinator,
    resultVisibility,
    results,
    highlights,
    compare,
    derivedJobs,
    pivot,
    resultsSearch,
    resultMemory,
    indexMemory,
    live,
    queryPlans,
    retainedPlans,
    planPreparation,
    ...gridStats ? { gridStats } : {},
    files,
    recentFiles,
    recovery,
    targets,
    editorOptions,
    shellOptions,
    bookmarks,
    editorDialogs,
    editorStatus,
    inputMode,
    tabRename,
    serverDrop,
    editorGroups,
    panes,
    explorer,
    explorerStatus,
    ssisTree,
    databaseList,
    resultSelection,
    settings,
    shortcuts: userShortcuts,
    scripting,
    peek,
    peekTabs,
    profilePeek,
    editorPeek,
    actions,
    actionProgress,
    dialogs,
    serverFiles,
    ssisCatalog,
    longRuns,
    dependencies,
    designers,
    ssisProperties,
    properties,
    tableProperties,
    newDatabase,
    restore,
    activity,
    operations,
    objectSearch,
    searchDetails,
    theme,
    notifications,
    updates,
    releaseNotes,
    help,
    dialogWindows: true,
    attachWindow: target => {
      const attached = [windows.add(target), keybindings.attach(target), menus.attach(target), blockPrimaryPaste(target, platform), trackWindowFocus(target, target.document.documentElement), reducedMotion.watch(target)]
      return { dispose: () => attached.forEach(item => item.dispose()) }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      stopConnectionBindings()
      startup.dispose()
      connectionPruning.dispose()
      disconnectPrompts.dispose()
      // Before the documents close: a page that unloads leaves its AutoRecover copies to be offered.
      recovery.dispose()
      // Hiding the quick input first aborts its loads and ends any theme preview before the services they use go away.
      listeners.forEach(listener => listener.dispose()); menus.dispose(); quickInput.dispose(); menuState.dispose(); keybindings.dispose()
      contributions.forEach(contribution => contribution.dispose())
      cleanup.dispose()
      refreshDocuments()
      closeSuccessor.dispose()
      commands.dispose()
      context.dispose()
      files.dispose()
      recentFiles.dispose()
      queryPlans.dispose()
      retainedPlans.dispose()
      planReleases.dispose(); planGenerations.dispose(); planEvents.dispose(); planPreparation.dispose()
      queries.dispose()
      highlights.dispose()
      compare.dispose()
      pivot.dispose()
      resultsSearch.dispose()
      // Before the results: each tab's view releases its Top rows there (the card's are released with it below, or by the results).
      peekTabs.dispose()
      results.dispose()
      resultMemory.dispose()
      indexMemory.dispose()
      actionProgress.dispose()
      // Before the live views: its documents' views and stops are cancelled while the service still runs them.
      // Before Search Objects and Peek, whose reads its details pane shares.
      searchDetails.dispose()
      objectSearch.dispose()
      operations.dispose()
      // Before the live views: each monitor disposes its own; then the client, while the port is still there.
      activity.dispose()
      // Before the client: its views cancel their subscriptions while the port is still there.
      ssisTree.dispose()
      explorerRuntime.dispose()
      explorerStatus.dispose()
      live.dispose()
      resultVisibility.dispose()
      resultClient.dispose()
      // Before the documents: its prompts resolve as Cancel and its requests are cancelled while their tabs still exist.
      designers.dispose()
      ssisFocus.dispose()
      ssisProperties.dispose()
      properties.dispose()
      tableProperties.dispose()
      newDatabase.dispose()
      restore.dispose()
      sqlDiagnostics.dispose()
      bigQueryCost.dispose()
      costPrompts.dispose()
      sqlLanguage.dispose()
      documents.dispose()
      backend.dispose()
      explorer.dispose()
      databaseList.dispose()
      scripting.dispose()
      actions.dispose()
      dialogs.dispose()
      serverFiles.dispose()
      ssisCatalog.dispose()
      dependencies.dispose()
      longRuns.dispose()
      connections.dispose()
      connectionTargets.dispose()
      editorOptions.dispose()
      shellOptions.dispose()
      bookmarks.dispose()
      editorDialogs.dispose()
      editorStatus.dispose()
      inputMode.dispose()
      panes.dispose()
      editorGroups.dispose()
      resultSelection.dispose()
      peek.dispose()
      profilePeek.dispose()
      settings.dispose()
      shortcutsBinding.dispose()
      userShortcuts.dispose()
      notifications.dispose()
      releaseNotes.dispose()
      help.dispose()
      updates.dispose()
      theme.dispose()
      events.dispose()
    }
  }
  const contributions = [
    queryContribution(workbench, api),
    filesContribution(workbench, api),
    editorContribution(workbench),
    editingContribution(workbench, monaco),
    languagesContribution(workbench),
    editContribution(workbench, api),
    windowContribution(workbench, api, reloadPins),
    menusContribution(workbench),
    explorerContribution(workbench, api),
    outputContribution(workbench, api),
    messagesContribution(workbench),
    highlightsContribution(workbench),
    compareContribution(workbench),
    pivotContribution(workbench),
    transposeContribution(workbench),
    paletteContribution(workbench),
    themeContribution(workbench, api),
    backendContribution(workbench),
    helpContribution(workbench, api),
    updatesContribution(workbench, api),
    scriptingContribution(workbench),
    actionsContribution(workbench),
    designerContribution(workbench),
    ssisContribution(workbench),
    activityContribution(workbench),
    searchContribution(workbench, api),
    settingsContribution(workbench),
    notificationsContribution(workbench)
  ]
  // Capture on window runs before Monaco's own listeners and React's handlers.
  const listeners = [
    keybindings.attach(window),
    menus.attach(window),
    // On Linux a middle-click would paste the PRIMARY selection outside the gated Paste role.
    blockPrimaryPaste(window, platform),
    trackWindowFocus(window, document.documentElement),
    reducedMotion,
    watchExternalChanges(window, files, () => settings.getSnapshot().values['environment.documents.detectExternalChanges'])
  ]
  // SettingsService.create started the load: services use the defaults until main's settings arrive. A warning about the
  // file, or a failed load, shows in the command banner, including one from before the workbench existed.
  settings.setReporter((message, kind) => kind === 'warning' ? commands.reportWarning(message) : commands.reportError(message))
  userShortcuts.setReporter((message, kind) => kind === 'warning' ? commands.reportWarning(message) : commands.reportError(message))
  // The tabs the last close kept (hot exit), else the welcome query; what an earlier run or page left unsaved is offered
  // once the workbench is up.
  const welcome = () => { if (!disposed) documents.create('SQLQuery1.sql', welcomeQueryText, 'master') }
  if (api.hotExit) void restoreSession({ api, documents, files, groups: editorGroups, connectionTargets, resumeRecovery: (tabId, id) => recovery.resume(tabId, id), otherwise: welcome })
    .catch(() => {}).then(() => { connectionRestored(); if (!disposed) void recovery.start() })
  else { welcome(); connectionRestored(); void recovery.start() }
  return workbench
}
