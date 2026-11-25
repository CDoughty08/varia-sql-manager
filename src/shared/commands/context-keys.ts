import type { Platform } from './keybindings'
import { comparisons, parseWhen, referencedKeys, type ContextRecord } from './when'
import { actionContextKey, objectActions, objectActionSpecs, type ActionContextKey } from '../actions/catalog.ts'
import { folderIds, nodeKinds, nodeStatuses, serverEngines } from '../explorer/catalog.ts'
import { scriptAsTitleKeys, scriptVerbContextKey, scriptVerbs, scriptVerbSpecs, type ScriptVerbContextKey } from '../scripting/catalog.ts'
import { ssisVerbContextKey, ssisVerbs, ssisVerbSpecs, type SsisVerbContextKey } from '../ssis/catalog.ts'
import { providerIds } from '../providers.ts'
import { agentRoleValues } from '../agent/profile.ts'

/**
 * `static` keys never change while the app runs, `state` keys come from service snapshots, `focus` keys from the
 * focused element, and `target` keys from the item a context menu opens for. Preconditions and toggled state may use
 * only static and state keys, so menus, the toolbar, and the palette agree on enablement wherever focus is; keybinding
 * `when` clauses may use static, state, and focus keys; context-menu placements may use static, state, and target keys.
 */
export type ContextKeyScope = 'static' | 'state' | 'focus' | 'target'
interface Declared { readonly scope: Exclude<ContextKeyScope, 'target'>; readonly description: string; readonly menu?: undefined }
/** A target key describes one kind of context-menu target, so it may appear only in that context menu's placements. */
interface DeclaredTarget { readonly scope: 'target'; readonly description: string; readonly menu: 'explorer.context' | 'explorer.tools' | 'output.context' | 'dockTab.context' | 'documentTab.context' | 'search.hit.context' }
export type ContextKeyDeclaration =
  | ({ readonly type: 'boolean' } & (Declared | DeclaredTarget))
  | ({ readonly type: 'enum'; readonly values: readonly string[] } & (Declared | DeclaredTarget))

const verbStates = ['', 'disabled', 'enabled'] as const
interface VerbKeyDeclaration { readonly type: 'enum'; readonly scope: 'state'; readonly values: typeof verbStates; readonly description: string }
/** One key per Script As verb, from `scriptMenuState` of the selection. */
const scriptVerbKeys = Object.fromEntries(scriptVerbs.map(verb => [scriptVerbContextKey(verb), {
  type: 'enum', scope: 'state', values: verbStates,
  description: `How the selected Object Explorer node offers Script as › ${scriptVerbSpecs[verb].name} To: 'enabled', 'disabled' (shown greyed), or '' (not offered). Keep it out of keybinding \`when\` clauses.`
}])) as { readonly [K in ScriptVerbContextKey]: VerbKeyDeclaration }
/** One key per object action (Select Top, Rename, Delete), from `actionMenuState` of the selection. */
const actionKeys = Object.fromEntries(objectActions.map(action => [actionContextKey(action), {
  type: 'enum', scope: 'state', values: verbStates,
  description: `How the selected Object Explorer node offers ${objectActionSpecs[action].title}: 'enabled', 'disabled' (shown greyed), or '' (not offered). Keep it out of keybinding \`when\` clauses.`
}])) as { readonly [K in ActionContextKey]: VerbKeyDeclaration }
/** One key per SSIS verb (Folder Properties, …), from `ssisVerbMenuState` of the selection. */
const ssisVerbKeys = Object.fromEntries(ssisVerbs.map(verb => [ssisVerbContextKey(verb), {
  type: 'enum', scope: 'state', values: verbStates,
  description: `How the selected Object Explorer node offers ${ssisVerbSpecs[verb].title}: 'enabled', 'disabled' (shown greyed), or '' (not offered). Keep it out of keybinding \`when\` clauses.`
}])) as { readonly [K in SsisVerbContextKey]: VerbKeyDeclaration }

export const contextKeys = {
  isMac: { type: 'boolean', scope: 'static', description: 'The app runs on macOS.' },
  isWindows: { type: 'boolean', scope: 'static', description: 'The app runs on Windows.' },
  isLinux: { type: 'boolean', scope: 'static', description: 'The app runs on Linux or another platform treated like it.' },
  editorFocus: { type: 'boolean', scope: 'focus', description: 'Focus is in the query editor, including its find widget.' },
  editorTextFocus: { type: 'boolean', scope: 'focus', description: "The query editor's text has focus." },
  inputFocus: { type: 'boolean', scope: 'focus', description: 'Focus is on an input, text area, select, or editable element other than the editor text. The find widget\'s inputs count.' },
  textInputFocus: { type: 'boolean', scope: 'focus', description: '`editorTextFocus || inputFocus || peekEditorFocus`: focus is where keys type or move a caret.' },
  activePanel: { type: 'enum', scope: 'focus', values: ['explorer', 'editor', 'output', ''], description: "The pane that holds focus: Object Explorer, the query editor, an output panel (Results, Messages or Execution plan), or '' for none." },
  outputGridFocus: { type: 'boolean', scope: 'focus', description: "Focus is in a results grid (a query's, or a live view's with Query Output's menu), which copies its selected cells rather than text." },
  liveGridFocus: { type: 'boolean', scope: 'focus', description: "Focus is in a live view's grid (an Activity Monitor pane's, Integration Services Operations', BigQuery Job History's), with Query Output's menu or its owner's own." },
  messagesFocus: { type: 'boolean', scope: 'focus', description: "Focus is in a Messages view; activePanel is then 'output'." },
  resultsFocus: { type: 'boolean', scope: 'focus', description: "Focus is in the Results pane (either layout) or its overflow picker; activePanel is then 'output', except in the picker." },
  searchHitsFocus: { type: 'boolean', scope: 'focus', description: "Focus is on a Search Objects result (the Search Objects tab's or Object Explorer's search), whose Copy copies the object's name." },
  planOutlineFocus: { type: 'boolean', scope: 'focus', description: "Focus is in an execution plan's operator outline, whose Copy copies the selected operator." },
  explorerFocus: { type: 'boolean', scope: 'focus', description: "Focus is in Object Explorer's tree (a row's inline rename box included), not its search box, toolbar or Peek card; activePanel is then 'explorer'." },
  explorerTypeAhead: { type: 'boolean', scope: 'focus', description: "Object Explorer's tree is collecting a type-ahead name, so Space types a space rather than peeking." },
  optionsDialogFocus: { type: 'boolean', scope: 'focus', description: 'Focus is in the Options dialog.' },
  designerFocus: { type: 'boolean', scope: 'focus', description: "Focus is in the active table designer; activePanel is then 'editor'." },
  queryBarFocus: { type: 'boolean', scope: 'focus', description: "Focus is in the active query's bar (Execute, Cancel and its server and database lists); activePanel is then 'editor'." },
  agentStepsFocus: { type: 'boolean', scope: 'focus', description: "Focus is in a SQL Server Agent job document's Steps section (its list or the selected step's fields, but not its command editor, whose Monaco keeps Alt+Up/Down)." },
  activityMonitorFocus: { type: 'boolean', scope: 'focus', description: "Focus is in the active Activity Monitor; activePanel is then 'editor'." },
  documentTabFocus: { type: 'boolean', scope: 'focus', description: "Focus is on a document tab in the strip, or in its rename box; activePanel is then 'editor'." },
  peekFocus: { type: 'boolean', scope: 'focus', description: "Focus is in Object Explorer's Peek card, which floats outside every pane (activePanel is then '')." },
  peekTabFocus: { type: 'boolean', scope: 'focus', description: "Focus is in the active Peek tab; activePanel is then 'editor'." },
  peekEditorFocus: { type: 'boolean', scope: 'focus', description: "Focus is in Peek's read-only definition editor (a card's or a Peek tab's), its find widget included. It is not the query editor: editorFocus and editorTextFocus stay false, so query commands (Execute, Parse and the rest) leave it alone." },
  objectInspectorFocus: { type: 'boolean', scope: 'focus', description: 'Focus is inside a unified object inspector (Peek card, Peek tab or Properties document), so Ctrl+1 to Ctrl+9 (⌘1 to ⌘9 on macOS) jump between its sections.' },
  quickInputVisible: { type: 'boolean', scope: 'state', description: 'The command palette or a picker is open.' },
  backendStatus: { type: 'enum', scope: 'state', values: ['starting', 'ready', 'unresponsive', 'restarting', 'failed', 'stopped', ''], description: "The SQL backend's state; '' before the workbench has heard from main." },
  backendReady: { type: 'boolean', scope: 'state', description: "`backendStatus == 'ready'`." },
  hasActiveDocument: { type: 'boolean', scope: 'state', description: 'A query is open.' },
  activeDocumentProvider: {
    type: 'enum', scope: 'state', values: ['', ...providerIds],
    description: "The engine of the active document (`src/shared/providers.ts`): 'sqlserver' or 'bigquery', or '' with no document open. A command's `providers` is checked against it, except an Object Explorer command's, one run on an Object Explorer node or search result, and one that finds its own object (`commandProviderKey`)."
  },
  activeDocumentIsText: { type: 'boolean', scope: 'state', description: 'The active document has text in the editor: a query or a value opened from the results, not a table designer, Database Properties, SSIS properties or an Activity Monitor.' },
  activeDocumentIsDesigner: { type: 'boolean', scope: 'state', description: 'The active document is a table designer.' },
  activeDocumentIsSsis: { type: 'boolean', scope: 'state', description: 'The active document is the properties of an SSIS Catalog folder, project, package or environment.' },
  activeDocumentIsSsisOperations: { type: 'boolean', scope: 'state', description: "The active document is Integration Services: the catalog's operations, a package's runs or a run's page." },
  ssisPlace: { type: 'enum', scope: 'state', values: ['list', 'package', 'execution', ''], description: 'What the active Integration Services document shows: list, package or execution (empty outside it).' },
  ssisCanGoBack: { type: 'boolean', scope: 'state', description: 'The active Integration Services document has a place to go Back to.' },
  ssisCanGoForward: { type: 'boolean', scope: 'state', description: 'The active Integration Services document has a place to go Forward to.' },
  activeDocumentIsJobActivity: { type: 'boolean', scope: 'state', description: "The active document is SQL Server Agent's Job Activity Monitor." },
  activeDocumentIsAgentJob: { type: 'boolean', scope: 'state', description: 'The active document is a SQL Server Agent job (Job Properties, or New Job).' },
  activeDocumentIsAgentAlert: { type: 'boolean', scope: 'state', description: 'The active document is a SQL Server Agent alert (Alert Properties, or New Alert).' },
  activeDocumentIsAgentOperator: { type: 'boolean', scope: 'state', description: 'The active document is a SQL Server Agent operator (Operator Properties, or New Operator).' },
  activeDocumentIsAgentOperators: { type: 'boolean', scope: 'state', description: "The active document is SQL Server Agent's Operators and notifications grid." },
  activeDocumentIsAgentProxy: { type: 'boolean', scope: 'state', description: 'The active document is a SQL Server Agent proxy (Proxy Account Properties, or New Proxy).' },
  activeDocumentIsCredential: { type: 'boolean', scope: 'state', description: 'The active document is a credential (Credential Properties, or New Credential).' },
  activeDocumentIsLogViewer: { type: 'boolean', scope: 'state', description: "The active document is SQL Server Agent's Log File Viewer (job history)." },
  activeDocumentIsJobHistory: { type: 'boolean', scope: 'state', description: 'The active document is BigQuery Job History.' },
  jobHistoryPaused: { type: 'boolean', scope: 'state', description: 'The active Job History document is paused (Pause): it reads nothing until resumed.' },
  jobHistoryRefreshable: { type: 'boolean', scope: 'state', description: 'The active Job History document reads its jobs, or stopped on a failure that Refresh may get past.' },
  jobHistoryPausable: { type: 'boolean', scope: 'state', description: 'The active Job History document has not stopped, so Pause applies.' },
  jobHistoryJobSelected: { type: 'boolean', scope: 'state', description: 'A job is selected in the active Job History document and its connection is live.' },
  jobHistoryCanOpenResults: { type: 'boolean', scope: 'state', description: "The job selected in Job History is a finished query job of the connection's principal (Open Results)." },
  jobHistoryCanReattach: { type: 'boolean', scope: 'state', description: "The job selected in Job History is a running or pending top-level query job of the connection's principal (Re-attach)." },
  jobHistoryCanOpenSql: { type: 'boolean', scope: 'state', description: 'The job selected in Job History is a query job whose SQL BigQuery shows (Open SQL in New Tab).' },
  jobHistoryCanRerun: { type: 'boolean', scope: 'state', description: 'The job selected in Job History is a top-level query job whose SQL BigQuery shows (Re-run).' },
  jobHistoryCanCancel: { type: 'boolean', scope: 'state', description: 'The job selected in Job History is running or pending, no cancel of it is on its way, and BigQuery has not refused cancelling other users\' jobs on this connection.' },
  activeDocumentIsAgentSchedules: { type: 'boolean', scope: 'state', description: "The active document is SQL Server Agent's Schedules document (Manage Schedules)." },
  activeDocumentIsAgentOverview: { type: 'boolean', scope: 'state', description: "The active document is SQL Server Agent's overview and health checks (Agent Overview)." },
  ssisOperationStoppable: { type: 'boolean', scope: 'state', description: 'The operation selected in the active Integration Services Operations document is an execution or validation that is running or pending, and no stop of it is on its way.' },
  ssisOperationsPaused: { type: 'boolean', scope: 'state', description: 'The active Integration Services Operations document is paused (Pause): it reads nothing until resumed.' },
  ssisOperationsRefreshable: { type: 'boolean', scope: 'state', description: 'The active Integration Services Operations document reads the catalog, or stopped on a failure that Refresh may get past (not a missing catalog).' },
  ssisOperationsPausable: { type: 'boolean', scope: 'state', description: 'The active Integration Services Operations document has not stopped, so Pause applies.' },
  designerEditable: { type: 'boolean', scope: 'state', description: "The active table designer has loaded, is not saving or saved, and its server is connected." },
  designerSaving: { type: 'boolean', scope: 'state', description: 'A table designer is saving its table (Stop cancels it).' },
  designerRowSelected: { type: 'boolean', scope: 'state', description: 'The active table designer has a column selected.' },
  designerPrimaryKeyRemovable: { type: 'boolean', scope: 'state', description: "Every column selected in the active table designer is a primary key column, so Remove Primary Key replaces Set Primary Key." },
  activeDocumentIsProperties: { type: 'boolean', scope: 'state', description: 'The active document is Database Properties.' },
  activeDocumentIsTableProperties: { type: 'boolean', scope: 'state', description: 'The active document is Table Properties.' },
  propertiesChanged: { type: 'boolean', scope: 'state', description: 'The active Database Properties or Table Properties document has changes that are not applied yet.' },
  propertiesApplicable: { type: 'boolean', scope: 'state', description: 'The active Database Properties or Table Properties document can apply its changes now: it has loaded and has changes, nothing runs in it, it does not need reading again, and its server is connected.' },
  propertiesApplying: { type: 'boolean', scope: 'state', description: 'The active Database Properties or Table Properties document is applying its changes (Stop cancels them in SQL Server).' },
  propertiesRefreshable: { type: 'boolean', scope: 'state', description: 'The active Database Properties or Table Properties document can read the database or table again: its server is connected, nothing runs in it, and it has no changes that are not applied.' },
  activeDocumentIsNewDatabase: { type: 'boolean', scope: 'state', description: 'The active document is New Database.' },
  newDatabaseCreatable: { type: 'boolean', scope: 'state', description: 'The active New Database document can create its database now: it has read the server, nothing runs in it, and its server is connected.' },
  newDatabaseCreating: { type: 'boolean', scope: 'state', description: 'The active New Database document is creating its database (Stop cancels it in SQL Server).' },
  activeDocumentIsRestore: { type: 'boolean', scope: 'state', description: 'The active document is Restore Database.' },
  restoreRunnable: { type: 'boolean', scope: 'state', description: 'The active Restore Database document can restore now: it has read the backups, its choices form a restore, nothing runs in it, and its server is connected.' },
  restoreRunning: { type: 'boolean', scope: 'state', description: 'The active Restore Database document is restoring (Stop cancels the running statement in SQL Server).' },
  restoreRefreshable: { type: 'boolean', scope: 'state', description: 'The active Restore Database document can read the server and the backups again: nothing runs in it and its server is connected.' },
  activeDocumentIsActivityMonitor: { type: 'boolean', scope: 'state', description: 'The active document is an Activity Monitor.' },
  activeDocumentIsPeek: { type: 'boolean', scope: 'state', description: 'The active document is a Peek tab.' },
  activityPaused: { type: 'boolean', scope: 'state', description: 'The active Activity Monitor is paused: it runs no SQL until Resume.' },
  activitySplit: { type: 'boolean', scope: 'state', description: 'The active Activity Monitor shows two panes (Split View).' },
  activeDocumentIsQuery: { type: 'boolean', scope: 'state', description: 'The active document is a query, not an XML, JSON, or execution plan value opened from the results.' },
  multipleDocuments: { type: 'boolean', scope: 'state', description: 'Two or more queries are open.' },
  multipleEditorGroups: { type: 'boolean', scope: 'state', description: 'The query editor shows two or more editor groups (split or floating).' },
  activeDocumentFloating: { type: 'boolean', scope: 'state', description: "The active document's editor group floats over the editor area." },
  documentBusy: { type: 'boolean', scope: 'state', description: 'A document task is in progress: opening, saving, or closing a query, or changing its connection.' },
  hasConnection: { type: 'boolean', scope: 'state', description: 'At least one server is connected (lost connections do not count).' },
  activeDocumentConnected: { type: 'boolean', scope: 'state', description: "The active query's server is connected and its connection was not lost." },
  hasLostConnection: { type: 'boolean', scope: 'state', description: 'A remembered server is disconnected or was lost and has not been reconnected or removed.' },
  activeConnectionLost: { type: 'boolean', scope: 'state', description: "The active query's remembered server is disconnected or was lost." },
  queryRunning: { type: 'boolean', scope: 'state', description: 'The active query is running.' },
  includeActualPlan: { type: 'boolean', scope: 'state', description: 'The active query will capture actual execution plans.' },
  includeLivePlan: { type: 'boolean', scope: 'state', description: 'The active query will show live execution plans.' },
  includeClientStatistics: { type: 'boolean', scope: 'state', description: 'The active query will collect client statistics.' },
  hasResults: { type: 'boolean', scope: 'state', description: 'The active query has results (result sets or captured execution plans), and they were not closed (Close Results) or lost with a run the SQL backend stopped.' },
  hasResultSets: { type: 'boolean', scope: 'state', description: 'The active query has a result set a grid shows (rows, a Pivot, a plan set or a comparison), not closed or lost with a run the SQL backend stopped. Captured execution plans alone do not count.' },
  multipleResults: { type: 'boolean', scope: 'state', description: 'The active query has two or more results or comparisons to step through (the results pane takes the browser tab keys only then).' },
  anyDocumentConnected: { type: 'boolean', scope: 'state', description: "Some open query's server is connected." },
  outputPaneVisible: { type: 'boolean', scope: 'state', description: 'An output panel (Results, Messages or Execution plan) is open and showing: its tab is selected, and no other panel is maximized.' },
  panelTabsVisible: { type: 'boolean', scope: 'state', description: 'Window › Panel Tabs is on: a panel alone in its dock group shows its tab.' },
  editorWordWrap: { type: 'boolean', scope: 'state', description: 'Word wrap is on in the query editor.' },
  editorWhitespace: { type: 'boolean', scope: 'state', description: 'View White Space is on in the query editor.' },
  editorLineNumbers: { type: 'boolean', scope: 'state', description: 'Line numbers show in the query editor.' },
  resultsWhitespaceSpaces: { type: 'boolean', scope: 'state', description: 'The results grid marks spaces and tabs (Show Spaces and Tabs in Results).' },
  resultsWhitespaceAll: { type: 'boolean', scope: 'state', description: 'The results grid marks every white space character, line breaks included (Show All White Space in Results).' },
  resultsSortTextChars: { type: 'boolean', scope: 'state', description: 'Sorted results grids order text columns by their length in characters (Sort Text by Length in Characters).' },
  resultsSortTextBytes: { type: 'boolean', scope: 'state', description: 'Sorted results grids order text and binary columns by their length in bytes (Sort Text by Length in Bytes).' },
  resultsColumnProfile: { type: 'boolean', scope: 'state', description: 'The column profile panel shows beside the results (Show Column Profile).' },
  resultsProfileSelectedOnly: { type: 'boolean', scope: 'state', description: 'The column profile lists only the selected columns (Column Profile: Selected Columns Only).' },
  resultsGridTransposed: { type: 'boolean', scope: 'state', description: "The results grid that last had the focus in the active query is drawn transposed (Transpose Results); in a results grid's own menu, that grid is." },
  resultsTabs: { type: 'boolean', scope: 'state', description: 'Results show as tabs, one at a time, rather than stacked (Show Results as Tabs).' },
  resultsRowSize: { type: 'boolean', scope: 'state', description: 'A bar behind each row number shows the row\'s size (Show Row Size in Results).' },
  hasBookmarks: { type: 'boolean', scope: 'state', description: 'An open document has a bookmark.' },
  activeDocumentHasBookmarks: { type: 'boolean', scope: 'state', description: 'The active document has a bookmark.' },
  anyDocumentDirty: { type: 'boolean', scope: 'state', description: 'Some open document has unsaved changes.' },
  editorOvertype: { type: 'boolean', scope: 'state', description: 'The editor is in overtype mode (OVR): typing replaces the character after the caret.' },
  hasRecentFiles: { type: 'boolean', scope: 'state', description: 'File › Recent Files lists at least one file.' },
  hasRecoveryFiles: { type: 'boolean', scope: 'state', description: 'AutoRecover kept queries that an earlier run or an earlier workbench did not save, and they were neither recovered nor discarded.' },
  updateBusy: { type: 'boolean', scope: 'state', description: 'An update check or download is running, or a downloaded release is being unpacked.' },
  updateAvailable: { type: 'boolean', scope: 'state', description: 'A newer release that this copy can install waits for Help › Download Update (Automatically download updates is off).' },
  updateReady: { type: 'boolean', scope: 'state', description: 'A newer release was downloaded and verified: Help › Restart to Update installs it.' },
  explorerHasSelection: { type: 'boolean', scope: 'state', description: 'A node is selected in Object Explorer (a loading, error, or progress row is not a node).' },
  explorerSelectionProvider: {
    type: 'enum', scope: 'state', values: ['', ...providerIds],
    description: "The engine of the server the selected Object Explorer node is on: 'sqlserver' or 'bigquery', or '' with no selection. The `providers` of an Object Explorer command, and of any command run on an Object Explorer node or a search result (whose arguments stand the object's engine in), is checked against it (`commandProviderKey`). Keep it out of keybinding `when` clauses."
  },
  explorerSelectionKind: {
    type: 'enum', scope: 'state', values: ['', 'folder', ...nodeKinds],
    description: "The kind of the selected Object Explorer node: 'folder', an object kind from `src/shared/explorer/catalog.ts`, or '' for none. Keep it out of keybinding `when` clauses."
  },
  explorerSelectionFolder: {
    type: 'enum', scope: 'state', values: ['', ...folderIds],
    description: "The selected Object Explorer folder's id from `src/shared/explorer/catalog.ts`, or '' when the selection is not a folder. Keep it out of keybinding `when` clauses."
  },
  explorerSelectionFilterable: { type: 'boolean', scope: 'state', description: 'The selected Object Explorer node is a folder that Filter Settings can filter.' },
  explorerSelectionFiltered: { type: 'boolean', scope: 'state', description: 'The selected Object Explorer folder has a filter.' },
  explorerSelectionInsertable: { type: 'boolean', scope: 'state', description: 'The selected Object Explorer node has a name to copy: a server, an object, or a fully loaded Columns folder.' },
  explorerSelectionStatus: {
    type: 'enum', scope: 'state', values: ['', ...nodeStatuses],
    description: "The selected Object Explorer node's status badge from `src/shared/explorer/catalog.ts` ('disabled' for a disabled login, 'unavailable' for an offline database), or '' for none. Keep it out of keybinding `when` clauses."
  },
  explorerSelectionServerEngine: {
    type: 'enum', scope: 'state', values: ['', ...serverEngines],
    description: "The kind of server the selected Object Explorer node is on: 'box' (SQL Server), 'managedInstance' or 'cloud' (Azure SQL Database and the other cloud editions), or '' with no selection. Keep it out of keybinding `when` clauses."
  },
  explorerSelectionServerLinux: { type: 'boolean', scope: 'state', description: 'The selected Object Explorer node is on SQL Server on Linux.' },
  explorerScriptTitle: {
    type: 'enum', scope: 'state', values: ['', ...scriptAsTitleKeys],
    description: "The selected Object Explorer node's Script submenu title key from `src/shared/scripting/catalog.ts` ('table' shows Script Table as), or '' when it has none. Keep it out of keybinding `when` clauses."
  },
  ...scriptVerbKeys,
  explorerSelectionModifiable: { type: 'boolean', scope: 'state', description: 'The selected Object Explorer node offers Modify: a T-SQL stored procedure, function, or trigger.' },
  explorerSelectionPeekable: { type: 'boolean', scope: 'state', description: 'The selected Object Explorer node is of a kind Peek describes (`peekKinds` in `src/shared/explorer/peek.ts` or `bigQueryPropertyKinds` in `src/shared/bigquery/objects.ts`).' },
  explorerSelectionDependencies: { type: 'boolean', scope: 'state', description: 'The selected Object Explorer node offers View Dependencies (`dependencyKinds` in `src/shared/explorer/dependencies.ts`).' },
  explorerSelectionAgentRole: {
    type: 'enum', scope: 'state', values: ['', ...agentRoleValues],
    description: "The login's SQL Server Agent role on the server of the selected Object Explorer node, when that node is an Agent node (`agentRoleOf` in `src/shared/agent/profile.ts`): 'sysadmin', 'operator', 'reader', 'user', 'none', 'unknown' while `agent.profile` is being read, or 'profileFailed' when it failed; '' for any other node. Keep it out of keybinding `when` clauses."
  },
  ...actionKeys,
  ...ssisVerbKeys,
  explorerLoading: { type: 'boolean', scope: 'state', description: 'Object Explorer is loading or waiting to load nodes.' },
  explorerGroupBySchema: { type: 'boolean', scope: 'state', description: "Object Explorer groups each database's objects by schema (Group by Schema)." },
  scriptingRunning: { type: 'boolean', scope: 'state', description: 'A Script As request is running.' },
  hasNotifications: { type: 'boolean', scope: 'state', description: 'A notification toast is showing or waiting to show.' },
  explorerNode: {
    type: 'enum', scope: 'target', menu: 'explorer.context', values: ['background', 'folder', ...nodeKinds, ''],
    description: "The kind of Object Explorer node the menu is for: 'folder', an object kind from `src/shared/explorer/catalog.ts`, or 'background' for the empty area below the servers."
  },
  explorerServerLost: { type: 'boolean', scope: 'target', menu: 'explorer.context', description: 'The menu is for a disconnected server, including a connection lost when the SQL backend restarted.' },
  explorerFolderFilterable: { type: 'boolean', scope: 'target', menu: 'explorer.context', description: 'The menu is for an Object Explorer folder that Filter Settings can filter.' },
  explorerFolderFiltered: { type: 'boolean', scope: 'target', menu: 'explorer.context', description: 'The menu is for an Object Explorer folder that has a filter.' },
  explorerFolder: {
    type: 'enum', scope: 'target', menu: 'explorer.context', values: ['', ...folderIds],
    description: "The id of the Object Explorer folder the menu is for, from `src/shared/explorer/catalog.ts` ('tables' offers New › Table…), or '' for anything else."
  },
  explorerNodePeekable: { type: 'boolean', scope: 'target', menu: 'explorer.context', description: 'The menu is for an Object Explorer node of a kind Peek describes (`peekKinds` in `src/shared/explorer/peek.ts` or `bigQueryPropertyKinds` in `src/shared/bigquery/objects.ts`).' },
  explorerNodeDependencies: { type: 'boolean', scope: 'target', menu: 'explorer.context', description: 'The menu is for an Object Explorer node that offers View Dependencies (`dependencyKinds` in `src/shared/explorer/dependencies.ts`).' },
  explorerFolderInsertable: { type: 'boolean', scope: 'target', menu: 'explorer.context', description: 'The menu is for a Columns folder whose columns have all loaded, so Copy Name copies their list.' },
  explorerNodeNameless: { type: 'boolean', scope: 'target', menu: 'explorer.context', description: 'The menu is for an Object Explorer node other than a server or folder whose kind has no name to copy (its `insert` style is `none`, such as an Agent error log), so Copy Name is hidden.' },
  explorerNodeStatus: {
    type: 'enum', scope: 'target', menu: 'explorer.context', values: ['', ...nodeStatuses],
    description: "The status badge of the Object Explorer node the menu is for ('disabled', 'unavailable', 'readOnly' or 'noAccess'), or '' for none."
  },
  explorerServerEngine: {
    type: 'enum', scope: 'target', menu: 'explorer.context', values: ['', ...serverEngines],
    description: "The kind of server the Object Explorer node the menu is for is on: 'box', 'managedInstance' or 'cloud', or '' for the empty area."
  },
  explorerServerLinux: { type: 'boolean', scope: 'target', menu: 'explorer.context', description: 'The menu is for a node on SQL Server on Linux.' },
  explorerProvider: {
    type: 'enum', scope: 'target', menu: 'explorer.context', values: ['', ...providerIds],
    description: "The engine of the server the Object Explorer node the menu is for is on: 'sqlserver' or 'bigquery', or '' for the empty area. Items whose `providers` lack it are left out."
  },
  explorerBigQueryProjectRole: {
    type: 'enum', scope: 'target', menu: 'explorer.context', values: ['', 'billing', 'starred', 'session'],
    description: "The role of the BigQuery project node the menu is for: 'billing', 'starred', or 'session' (shown for this session only), or '' for any other node."
  },
  agentRole: {
    type: 'enum', scope: 'target', menu: 'explorer.context', values: ['', ...agentRoleValues],
    description: "The login's SQL Server Agent role on the server of the Object Explorer node the menu is for, when that node is an Agent node: 'sysadmin', 'operator', 'reader', 'user', 'none', 'unknown' (not read yet) or 'profileFailed'; '' for any other node."
  },
  outputView: { type: 'enum', scope: 'target', menu: 'output.context', values: ['grid', 'messages', 'live', ''], description: "The Query Output view the menu is for: a results grid, the messages, or a grid with its own source: a live view's (an Activity Monitor pane) or a local table's (a Peek list)." },
  outputGridTransposable: { type: 'boolean', scope: 'target', menu: 'output.context', description: "The menu is for a results grid that can be drawn transposed: a query's rows or a pivot, not a comparison or a plan set." },
  outputGridBare: { type: 'boolean', scope: 'target', menu: 'output.context', description: "The menu is for a results grid drawn bare (Peek's rows): Pivot, Compare and the close commands are not offered for it." },
  outputLiveFilterable: { type: 'boolean', scope: 'target', menu: 'output.context', description: "The live view's grid the menu is for filters some columns by value at its source (its headers have funnels)." },
  outputLiveRows: { type: 'enum', scope: 'target', menu: 'output.context', values: ['session', ''], description: "What the rows of the live view's grid the menu is for are: 'session' for an Activity Monitor pane of sessions (Details and Kill Process act on its active row), else ''." },
  outputLiveSortable: { type: 'boolean', scope: 'target', menu: 'output.context', description: "The live view's grid the menu is for sorts (its table is a snapshot, not a log that keeps arrival order)." },
  pane: { type: 'enum', scope: 'target', menu: 'dockTab.context', values: ['explorer', 'editor', 'results', 'messages', 'plan', 'statistics', ''], description: "The panel the menu is for (from its tab or its ⋯ button): Object Explorer, the query editor, Results, Messages, Execution plan, or Client Statistics." },
  paneFloating: { type: 'boolean', scope: 'target', menu: 'dockTab.context', description: 'The panel the menu is for is floating.' },
  panePopout: { type: 'boolean', scope: 'target', menu: 'dockTab.context', description: 'The panel the menu is for is in a window of its own (Move into New Window).' },
  explorerToolsLost: { type: 'boolean', scope: 'target', menu: 'explorer.tools', description: 'The selected Object Explorer server in the ⋯ menu is disconnected or lost.' },
  explorerToolsFloating: { type: 'boolean', scope: 'target', menu: 'explorer.tools', description: 'Object Explorer is floating when its ⋯ menu opens.' },
  explorerToolsPopout: { type: 'boolean', scope: 'target', menu: 'explorer.tools', description: 'Object Explorer is in a window of its own when its ⋯ menu opens.' },
  documentTabFloating: { type: 'boolean', scope: 'target', menu: 'documentTab.context', description: "The document tab the menu is for is in a floating editor group." },
  searchHitSchema: { type: 'boolean', scope: 'target', menu: 'search.hit.context', description: 'The Search Objects result the menu is for is in a schema (itself, or its parent for a column, key or trigger), so it has schema-qualified and fully qualified names.' },
  searchHitBigQuery: { type: 'boolean', scope: 'target', menu: 'search.hit.context', description: 'The Search Objects result the menu is for is a BigQuery object, whose full name is its backtick-quoted path rather than a bracketed one.' },
  resultsGridComparison: { type: 'boolean', scope: 'state', description: "The results grid that last had the focus in the active query is a comparison (Compare); in a results grid's own menu, that grid is." },
  comparisonInputsOpen: { type: 'boolean', scope: 'state', description: "Both results that comparison compared are still open, so its toolbar and commands can change it; while one is closed they are unavailable." },
  outputGridComparison: { type: 'boolean', scope: 'target', menu: 'output.context', description: "The menu is for a comparison's results grid." },
  comparisonExactText: { type: 'boolean', scope: 'state', description: "That comparison compares text exactly: values that differ only by case or trailing spaces count as changed (its Exact text toggle)." },
  comparisonOneRow: { type: 'boolean', scope: 'state', description: "That comparison shows one row per entry (its Layout is One row)." },
  comparisonChangesOnly: { type: 'boolean', scope: 'state', description: "That comparison shows only its changed, added and removed rows (its Rows choice is Changes only)." },
  comparisonRowHasPartner: { type: 'boolean', scope: 'state', description: "That comparison's active row is a removed or added row with a possible match (? in its row header), so Go to Possible Match can select it; false until the row's change marker has loaded. In a results grid's own menu, the row it was opened on." }
} as const satisfies Record<string, ContextKeyDeclaration>

type Declarations = typeof contextKeys
export type ContextKey = keyof Declarations
export type ContextKeyValue<K extends ContextKey> = Declarations[K] extends { readonly values: readonly (infer V)[] } ? V : boolean
export type ContextKeys = { readonly [K in ContextKey]: ContextKeyValue<K> }
type KeysOfScope<S extends ContextKeyScope> = { [K in ContextKey]: Declarations[K]['scope'] extends S ? K : never }[ContextKey]
export type StateKeys = Pick<ContextKeys, KeysOfScope<'static' | 'state'>>
export type FocusKeys = Pick<ContextKeys, KeysOfScope<'focus'>>
export type TargetKeys = Pick<ContextKeys, KeysOfScope<'target'>>

export const contextKeyNames = Object.keys(contextKeys) as ContextKey[]
export const isContextKey = (value: string): value is ContextKey => Object.hasOwn(contextKeys, value)
const declaration = (key: ContextKey): ContextKeyDeclaration => contextKeys[key]
/** The context menu a target key belongs to; undefined for every other scope. */
export const targetKeyMenu = (key: ContextKey): DeclaredTarget['menu'] | undefined => declaration(key).menu
export const keysOfScope = (...scopes: ContextKeyScope[]): ContextKey[] => contextKeyNames.filter(key => scopes.includes(declaration(key).scope))
/** Every value a key can take, for enumerating contexts: both booleans, or the enum's values. */
export const contextKeyValues = (key: ContextKey): readonly (boolean | string)[] => { const info = declaration(key); return info.type === 'enum' ? info.values : [false, true] }

export const staticContextKeys = (platform: Platform): Pick<ContextKeys, 'isMac' | 'isWindows' | 'isLinux'> =>
  ({ isMac: platform === 'darwin', isWindows: platform === 'win32', isLinux: platform === 'linux' })

const defaultBase = (platform: Platform): Record<string, boolean | string> => {
  const record: Record<string, boolean | string> = Object.create(null)
  for (const key of contextKeyNames) { const info = declaration(key); record[key] = info.type === 'enum' ? '' : false }
  Object.assign(record, staticContextKeys(platform))
  return record
}
const baseRecordByPlatform: Readonly<Record<Platform, Record<string, boolean | string>>> = {
  win32: defaultBase('win32'), linux: defaultBase('linux'), darwin: defaultBase('darwin')
}

/**
 * A complete context record with no prototype (so `__proto__` is an ordinary key): every key at its default (false, or
 * the enum's '' value), then the platform's static keys, then `values`.
 */
export function contextRecord(platform: Platform, values: Partial<ContextKeys> = {}): ContextRecord & ContextKeys {
  const record: Record<string, boolean | string> = Object.assign(Object.create(null), baseRecordByPlatform[platform])
  for (const key of Object.keys(values)) if (isContextKey(key) && values[key] !== undefined) record[key] = values[key]!
  return record as ContextRecord & ContextKeys
}

/**
 * Problems with a when clause: syntax, keys that are not declared or are outside `scopes`, and comparisons whose literal
 * the key can never hold (a string for a boolean key, or a value outside an enum).
 */
export function whenProblems(source: string, scopes: readonly ContextKeyScope[]): string[] {
  let ast
  try { ast = parseWhen(source) } catch (error) { return [`"${source}": ${error instanceof Error ? error.message : String(error)}`] }
  const problems: string[] = []
  for (const key of referencedKeys(ast)) {
    if (!isContextKey(key)) problems.push(`"${source}": unknown context key "${key}"`)
    else if (!scopes.includes(declaration(key).scope)) problems.push(`"${source}": ${declaration(key).scope} key "${key}" is not allowed here`)
  }
  for (const { key, value } of comparisons(ast)) {
    if (!isContextKey(key)) continue
    if (!contextKeyValues(key).includes(value)) problems.push(`"${source}": "${key}" is never ${JSON.stringify(value)}`)
  }
  return problems
}
