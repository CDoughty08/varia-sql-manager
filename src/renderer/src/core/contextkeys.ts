import type { BackendStatus, RecentFile } from '../../../shared/contracts'
import { contextRecord, type ContextKeys } from '../../../shared/commands/context-keys'
import type { Platform } from '../../../shared/commands/keybindings'
import { isSsisDocumentKind } from '../../../shared/ssis/catalog.ts'
import { documentProvider, isQueryDocument, isTextDocument } from '../documents'
import type { DocumentSnapshot } from '../services/documents'
import type { EditorGroupSnapshot } from '../services/editor-groups'
import type { BookmarkSnapshot } from '../editor/bookmarks'
import type { EditorOptions } from '../services/editor-options'
import { isOutputPane, outputPaneIds } from '../../../shared/layouts'
import type { PaneVisibility } from '../services/panes'
import { windows } from './windows'
import type { ShellOptions } from '../services/shell-options'
import type { QuerySnapshot } from '../services/queries'
import type { RecoverySnapshot } from '../services/recovery'
import type { BackendSnapshot } from '../services/backend'
import type { LiveConnection } from '../services/connections'
import { isLiveConnection } from '../services/connection-availability'
import type { ExplorerContextState } from '../explorer/ExplorerService'
import type { InputModeSnapshot } from './input-mode'
import type { NotificationSnapshot } from './notifications'
import type { UpdateState } from '../../../shared/updates'
import { onUnexpectedError } from './errors'
import { peekEditorAttribute } from '../explorer/peek-editor'
import type { Disposable, ExternalStore } from './types'
import type { SettingsValues } from '../../../shared/settings/catalog'

export interface FocusFacts {
  readonly editorFocus: boolean; readonly editorTextFocus: boolean; readonly inputFocus: boolean; readonly activePanel: 'explorer' | 'editor' | 'output' | ''; readonly outputGridFocus: boolean; readonly liveGridFocus: boolean
  readonly searchHitsFocus: boolean; readonly planOutlineFocus: boolean
  readonly designerFocus: boolean; readonly queryBarFocus: boolean; readonly activityMonitorFocus: boolean; readonly documentTabFocus: boolean
  readonly peekFocus: boolean; readonly peekTabFocus: boolean; readonly peekEditorFocus: boolean
  readonly messagesFocus: boolean; readonly resultsFocus: boolean; readonly explorerFocus: boolean; readonly explorerTypeAhead: boolean; readonly optionsDialogFocus: boolean
}
/** A table designer's state for its commands: TableDesignerService publishes one per open designer. */
export interface DesignerKeys { readonly editable: boolean; readonly rowSelected: boolean; readonly keyRemovable: boolean }
export interface DesignerContextState { readonly byDocument: Readonly<Record<string, DesignerKeys>>; readonly saving: boolean }
/** A Database Properties document's state for its verbs: DatabasePropertiesService publishes one per open document. */
export interface PropertiesKeys { readonly changed: boolean; readonly applicable: boolean; readonly applying: boolean; readonly refreshable: boolean }
export interface PropertiesContextState { readonly byDocument: Readonly<Record<string, PropertiesKeys>> }
/** A New Database document's state for its verbs: NewDatabaseService publishes one per open document. */
export interface NewDatabaseKeys { readonly creatable: boolean; readonly creating: boolean }
export interface NewDatabaseContextState { readonly byDocument: Readonly<Record<string, NewDatabaseKeys>> }
/** A Restore Database document's state for its verbs: RestoreService publishes one per open document. */
export interface RestoreKeys { readonly runnable: boolean; readonly running: boolean; readonly refreshable: boolean }
export interface RestoreContextState { readonly byDocument: Readonly<Record<string, RestoreKeys>> }
/** An Activity Monitor's state for its commands: ActivityMonitorService publishes one per open monitor. */
export interface ActivityContextState { readonly byDocument: Readonly<Record<string, { readonly paused: boolean; readonly split: boolean }>> }
/** An Integration Services Operations document's state for its commands: SsisOperationsService publishes one per document. */
export interface SsisOperationsKeys { readonly stoppable: boolean; readonly paused: boolean; readonly refreshable: boolean; readonly pausable: boolean }
export interface SsisOperationsContextState { readonly byDocument: Readonly<Record<string, SsisOperationsKeys>> }
/** A Job History document's state for its commands: JobHistoryService publishes one per document. */
export interface JobHistoryKeys {
  readonly paused: boolean; readonly refreshable: boolean; readonly pausable: boolean; readonly selected: boolean
  readonly openResults: boolean; readonly reattach: boolean; readonly openSql: boolean; readonly rerun: boolean; readonly cancel: boolean
}
export interface JobHistoryContextState { readonly byDocument: Readonly<Record<string, JobHistoryKeys>> }
/** The parts of a DOM element and of the editor that `focusFacts` reads, so tests can pass plain objects. */
export interface FocusElement { matches(selector: string): boolean; closest(selector: string): { getAttribute(name: string): string | null } | null }
export interface FocusEditor<E> { getContainerDomNode(): { contains(node: E): boolean }; getId?(): string; hasTextFocus(): boolean }

const noFocus: FocusFacts = { editorFocus: false, editorTextFocus: false, inputFocus: false, activePanel: '', outputGridFocus: false, liveGridFocus: false, searchHitsFocus: false, planOutlineFocus: false, designerFocus: false, queryBarFocus: false, activityMonitorFocus: false, documentTabFocus: false, peekFocus: false, peekTabFocus: false, peekEditorFocus: false,
  messagesFocus: false, resultsFocus: false, explorerFocus: false, explorerTypeAhead: false, optionsDialogFocus: false }
const panels: ReadonlySet<string> = new Set(['explorer', 'editor'])

/** Focus keys for editor text and owned widgets, including widgets hosted outside the editor container. */
export function focusFacts<E extends FocusElement>(element: E | null, editor: FocusEditor<E> | undefined): FocusFacts {
  if (!element) return noFocus
  const editorTextFocus = !!editor?.hasTextFocus()
  // Monaco defers widget blur; ownership of the browser's focused element is current when its next key arrives.
  const editorId = editor?.getId?.()
  const editorFocus = editorTextFocus || !!editor?.getContainerDomNode().contains(element) ||
    !!editorId && element.closest('[data-query-editor-id]')?.getAttribute('data-query-editor-id') === editorId
  const inputFocus = !editorTextFocus && (element.matches('input, textarea, select') || !!element.closest('[contenteditable]:not([contenteditable="false"])'))
  // DockWorkspace marks each pane host, and the mark moves with floating groups.
  const pane = element.closest('[data-pane]')?.getAttribute('data-pane') ?? ''
  const tree = element.closest('[data-explorer-tree]')
  return {
    editorFocus, editorTextFocus, inputFocus, activePanel: isOutputPane(pane) ? 'output' : panels.has(pane) ? pane as FocusFacts['activePanel'] : editorFocus ? 'editor' : '', outputGridFocus: !!element.closest('[data-result-grid]') || !!element.closest('[data-output-view="live"]'),
    // Any live view's grid (LiveGridPane marks its frame), with Query Output's menu or its owner's own (Job History).
    liveGridFocus: !!element.closest('[data-live-probe]'),
    searchHitsFocus: !!element.closest('[data-search-hits]'), planOutlineFocus: !!element.closest('[data-plan-outline]'),
    designerFocus: !!element.closest('[data-designer]'), queryBarFocus: !!element.closest('[data-query-bar]'), activityMonitorFocus: !!element.closest('[data-activity-monitor]'),
    documentTabFocus: !!element.closest('[data-document-tab]'), peekFocus: !!element.closest('[data-peek-card]'), peekTabFocus: !!element.closest('[data-peek-tab]'), peekEditorFocus: !!element.closest(`[${peekEditorAttribute}]`), messagesFocus: !!element.closest('[data-output-view="messages"]'),
    // The Results pane (not its Messages strip, which takes the query keys as the Messages pane does), or its overflow
    // picker, which is drawn over the page outside any pane.
    resultsFocus: (pane === 'results' && !element.closest('[data-messages-strip]') && !element.closest('[data-output-view="messages"]')) || !!element.closest('[data-results-picker]'),
    // The tree marks itself while type-ahead collects a name (ExplorerTree), so Space types rather than peeks.
    explorerFocus: !!tree, explorerTypeAhead: tree?.getAttribute('data-type-ahead') != null, optionsDialogFocus: !!element.closest('[data-options-dialog]')
  }
}

export interface ContextInputs {
  readonly platform: Platform
  /** SQL Server Agent's release gate (`agentEnabled`): main's VARIA_AGENT_PREVIEW=1, fixed for the run. */
  readonly agentEnabled?: boolean
  readonly focus?: FocusFacts
  readonly documents: DocumentSnapshot
  readonly queries: QuerySnapshot
  readonly connections: readonly Pick<LiveConnection, 'id' | 'lost' | 'targetId' | 'lifecycle' | 'inExplorer'>[]
  readonly quickInputVisible: boolean
  readonly wordWrap: boolean
  /** View White Space and line numbers in the query editor; without them, those keys are false. */
  readonly whitespace?: boolean
  readonly lineNumbers?: boolean
  /** How the results grid shows white space (queryResults.grid.whitespace); without it, its keys are false. */
  readonly resultsWhitespace?: SettingsValues['queryResults.grid.whitespace']
  /** How sorted grids order text (queryResults.grid.sortText); without it, its keys are false. */
  readonly resultsSortText?: SettingsValues['queryResults.grid.sortText']
  /** Whether the column profile panel and the row-size bar show (queryResults.grid.columnProfile, queryResults.grid.rowSize). */
  readonly resultsColumnProfile?: boolean
  readonly resultsProfileSelectedOnly?: boolean
  readonly resultsRowSize?: boolean
  /** Whether results show as tabs (queryResults.grid.layout). */
  readonly resultsLayout?: SettingsValues['queryResults.grid.layout']
  /** Bookmarks per open document (`BookmarkService`). */
  readonly bookmarks?: Readonly<Record<string, number>>
  readonly backendStatus: BackendStatus | ''
  readonly panes?: PaneVisibility
  /** Window › Panel Tabs. */
  readonly panelTabs?: boolean
  /** The Object Explorer selection's keys; without them, those keys are false or ''. */
  readonly explorer?: ExplorerContextState
  /** The tabs with results to close (`ResultsService.context`): result sets or captured plans. */
  readonly results?: Readonly<Record<string, true>>
  /** The tabs with a result set a grid can show (`ResultsService.resultSets`). */
  readonly resultSets?: Readonly<Record<string, true>>
  /** The tabs with two or more results or comparisons (`ResultsService.steppable`). */
  readonly resultsSteppable?: Readonly<Record<string, true>>
  /** The tabs whose focused results grid is drawn transposed (`ResultsService.turned`). */
  readonly resultsTurned?: Readonly<Record<string, unknown>>
  /** The tabs whose focused results grid is a comparison, and whether its inputs are open (`ResultsService.comparing`). */
  readonly resultsComparing?: Readonly<Record<string, { readonly inputsOpen: boolean }>>
  readonly comparisonToggles?: Readonly<Record<string, { readonly exact: boolean; readonly oneRow: boolean; readonly changesOnly: boolean; readonly partner?: boolean }>>
  readonly scriptingRunning?: boolean
  /** The editor types over text (OVR). */
  readonly overtype?: boolean
  /** File › Recent Files lists something. */
  readonly recentFiles?: boolean
  /** AutoRecover has queries to offer. */
  readonly recoveryFiles?: boolean
  /** The table designers' keys; without them, those keys are false. */
  readonly designer?: DesignerContextState
  /** The Database Properties documents' keys; without them, those keys are false. */
  readonly properties?: PropertiesContextState
  /** The Table Properties documents' keys, which share the properties keys. */
  readonly tableProperties?: PropertiesContextState
  /** The New Database documents' keys; without them, those keys are false. */
  readonly newDatabase?: NewDatabaseContextState
  /** The Restore Database documents' keys; without them, those keys are false. */
  readonly restore?: RestoreContextState
  /** A toast is showing or waiting (`hasNotifications`). */
  readonly notifications?: boolean
  /** The update check's state; without it, the update keys are false. */
  readonly update?: UpdateState
  /** The Activity Monitors' keys; without them, those keys are false. */
  readonly activity?: ActivityContextState
  /** The Integration Services Operations documents' keys; without them, those keys are false. */
  readonly ssis?: SsisOperationsContextState
  /** The Job History documents' keys; without them, those keys are false. */
  readonly jobHistory?: JobHistoryContextState
  /** The editor groups; without them, the documents are one group. */
  readonly editorGroups?: EditorGroupSnapshot
}
/** Every context key from service snapshots and focus facts; without focus, the focus keys are false or ''. */
export function computeContextKeys(inputs: ContextInputs): ContextKeys {
  const { documents, connections } = inputs, focus = inputs.focus ?? noFocus
  const active = documents.documents.find(document => document.id === documents.activeId)
  const connected = isLiveConnection
  const offline = (connection: ContextInputs['connections'][number]) => !!connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'disconnected' || connection.lifecycle.state === 'lost')
  const activeConnection = active?.connectionId ? connections.find(connection => connection.id === active.connectionId) : undefined
  const rememberedConnection = activeConnection ?? (active?.targetId ? connections.find(connection => connection.targetId === active.targetId) : undefined)
  const designer = active ? inputs.designer?.byDocument[active.id] : undefined, monitor = active ? inputs.activity?.byDocument[active.id] : undefined
  const properties = active ? inputs.properties?.byDocument[active.id] ?? inputs.tableProperties?.byDocument[active.id] : undefined
  const newDatabase = active ? inputs.newDatabase?.byDocument[active.id] : undefined
  const restore = active ? inputs.restore?.byDocument[active.id] : undefined
  const operations = active ? inputs.ssis?.byDocument[active.id] : undefined
  const history = active ? inputs.jobHistory?.byDocument[active.id] : undefined
  const groups = inputs.editorGroups?.groups ?? [], activeGroup = active ? groups.find(group => group.documents.includes(active.id)) : undefined
  return contextRecord(inputs.platform, {
    agentEnabled: !!inputs.agentEnabled,
    ...focus, textInputFocus: focus.editorTextFocus || focus.inputFocus || focus.peekEditorFocus,
    quickInputVisible: inputs.quickInputVisible, backendStatus: inputs.backendStatus, backendReady: inputs.backendStatus === 'ready', editorWordWrap: inputs.wordWrap,
    editorWhitespace: !!inputs.whitespace, editorLineNumbers: !!inputs.lineNumbers,
    resultsWhitespaceSpaces: inputs.resultsWhitespace === 'spaces', resultsWhitespaceAll: inputs.resultsWhitespace === 'all',
    resultsSortTextChars: inputs.resultsSortText === 'chars', resultsSortTextBytes: inputs.resultsSortText === 'bytes',
    resultsColumnProfile: !!inputs.resultsColumnProfile, resultsProfileSelectedOnly: !!inputs.resultsProfileSelectedOnly, resultsRowSize: !!inputs.resultsRowSize, resultsTabs: inputs.resultsLayout === 'tabs', resultsGridTransposed: !!active && !!inputs.resultsTurned?.[active.id],
    resultsGridComparison: !!active && !!inputs.resultsComparing?.[active.id], comparisonInputsOpen: !!active && !!inputs.resultsComparing?.[active.id]?.inputsOpen,
    comparisonExactText: !!active && !!inputs.comparisonToggles?.[active.id]?.exact, comparisonOneRow: !!active && !!inputs.comparisonToggles?.[active.id]?.oneRow, comparisonChangesOnly: !!active && !!inputs.comparisonToggles?.[active.id]?.changesOnly,
    comparisonRowHasPartner: !!active && !!inputs.comparisonToggles?.[active.id]?.partner,
    hasBookmarks: Object.values(inputs.bookmarks ?? {}).some(count => count > 0), activeDocumentHasBookmarks: !!active && (inputs.bookmarks?.[active.id] ?? 0) > 0,
    anyDocumentDirty: documents.documents.some(document => document.dirty), editorOvertype: !!inputs.overtype, hasRecentFiles: !!inputs.recentFiles, hasRecoveryFiles: !!inputs.recoveryFiles,
    // A query's engine follows its connection; every other document is SQL Server's.
    hasActiveDocument: !!active, activeDocumentProvider: documentProvider(active), activeDocumentIsQuery: isQueryDocument(active), activeDocumentIsText: isTextDocument(active), activeDocumentIsDesigner: active?.kind === 'tableDesigner', activeDocumentIsSsis: isSsisDocumentKind(active?.kind),
    activeDocumentIsProperties: active?.kind === 'databaseProperties', propertiesChanged: !!properties?.changed, propertiesApplicable: !!properties?.applicable, propertiesApplying: !!properties?.applying,
    propertiesRefreshable: !!properties?.refreshable, activeDocumentIsTableProperties: active?.kind === 'tableProperties',
    activeDocumentIsNewDatabase: active?.kind === 'newDatabase', newDatabaseCreatable: !!newDatabase?.creatable, newDatabaseCreating: !!newDatabase?.creating,
    activeDocumentIsRestore: active?.kind === 'restoreDatabase', restoreRunnable: !!restore?.runnable, restoreRunning: !!restore?.running, restoreRefreshable: !!restore?.refreshable,
    activeDocumentIsActivityMonitor: active?.kind === 'activityMonitor', activeDocumentIsPeek: active?.kind === 'peek', activityPaused: !!monitor?.paused, activitySplit: !!monitor?.split,
    activeDocumentIsJobActivity: active?.kind === 'agentJobActivity', activeDocumentIsAgentJob: active?.kind === 'agentJob', activeDocumentIsAgentProxy: active?.kind === 'agentProxy', activeDocumentIsCredential: active?.kind === 'credential',
    activeDocumentIsLogViewer: active?.kind === 'agentLogViewer',
    activeDocumentIsSsisOperations: active?.kind === 'ssisOperations', ssisOperationStoppable: !!operations?.stoppable, ssisOperationsPaused: !!operations?.paused, ssisOperationsRefreshable: !!operations?.refreshable, ssisOperationsPausable: !!operations?.pausable,
    activeDocumentIsJobHistory: active?.kind === 'bigQueryJobs', jobHistoryPaused: !!history?.paused, jobHistoryRefreshable: !!history?.refreshable, jobHistoryPausable: !!history?.pausable,
    jobHistoryJobSelected: !!history?.selected, jobHistoryCanOpenResults: !!history?.openResults, jobHistoryCanReattach: !!history?.reattach, jobHistoryCanOpenSql: !!history?.openSql,
    jobHistoryCanRerun: !!history?.rerun, jobHistoryCanCancel: !!history?.cancel,
    designerEditable: !!designer?.editable, designerRowSelected: !!designer?.rowSelected, designerPrimaryKeyRemovable: !!designer?.keyRemovable, designerSaving: !!inputs.designer?.saving, multipleDocuments: documents.documents.length > 1, multipleEditorGroups: groups.length > 1,
    activeDocumentFloating: !!activeGroup?.floating, documentBusy: documents.busy,
    hasConnection: connections.some(connected), hasLostConnection: connections.some(connection => connection.inExplorer !== false && offline(connection)),
    activeDocumentConnected: !!activeConnection && connected(activeConnection), activeConnectionLost: !!rememberedConnection && offline(rememberedConnection),
    anyDocumentConnected: documents.documents.some(document => isQueryDocument(document) && !!document.connectionId && connections.some(connection => connection.id === document.connectionId && connected(connection))),
    queryRunning: !!active && !!inputs.queries[active.id]?.running, hasResults: !!active && !!inputs.results?.[active.id], hasResultSets: !!active && !!inputs.resultSets?.[active.id], multipleResults: !!active && !!inputs.resultsSteppable?.[active.id], outputPaneVisible: !!inputs.panes && outputPaneIds.some(id => inputs.panes![id]), panelTabsVisible: !!inputs.panelTabs, ...inputs.explorer,
    includeActualPlan: isQueryDocument(active) && !!active?.includeActualPlan,
    includeLivePlan: isQueryDocument(active) && !!active?.includeLivePlan,
    includeClientStatistics: isQueryDocument(active) && !!active?.includeClientStatistics,
    scriptingRunning: !!inputs.scriptingRunning, hasNotifications: !!inputs.notifications,
    updateBusy: inputs.update?.status === 'checking' || inputs.update?.status === 'downloading' || inputs.update?.status === 'preparing', updateReady: inputs.update?.status === 'ready',
    updateAvailable: inputs.update?.status === 'available' && inputs.update.size !== undefined
  })
}

export interface ContextKeyOptions {
  readonly platform: Platform
  /** SQL Server Agent's release gate (`agentEnabled`, `window.varia.agentPreview`); fixed for the run, so not a store. */
  readonly agentEnabled?: boolean
  readonly documents: ExternalStore<DocumentSnapshot>
  readonly queries: ExternalStore<QuerySnapshot>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly backend: ExternalStore<BackendSnapshot>
  readonly editorOptions: ExternalStore<EditorOptions>
  /** Settings read by keys of their own (`resultsWhitespaceSpaces`, `resultsWhitespaceAll`, `resultsSortTextChars`, `resultsSortTextBytes`, `resultsColumnProfile`, `resultsProfileSelectedOnly`, `resultsRowSize`, `resultsTabs`). */
  readonly settings?: ExternalStore<{ readonly values: SettingsValues }>
  readonly quickInput?: ExternalStore<{ readonly visible: boolean }>
  readonly panes?: ExternalStore<PaneVisibility>
  /** The shell's layout options (`panelTabsVisible`). */
  readonly shell?: ExternalStore<ShellOptions>
  readonly explorer?: ExternalStore<ExplorerContextState>
  readonly results?: ExternalStore<Readonly<Record<string, true>>>
  /** The tabs with a result set a grid can show (`hasResultSets`). */
  readonly resultSets?: ExternalStore<Readonly<Record<string, true>>>
  /** The tabs with two or more results or comparisons (`multipleResults`). */
  readonly resultsSteppable?: ExternalStore<Readonly<Record<string, true>>>
  /** The tabs whose focused results grid is drawn transposed (`resultsGridTransposed`). */
  readonly resultsTurned?: ExternalStore<Readonly<Record<string, unknown>>>
  /** The tabs whose focused results grid is a comparison (`resultsGridComparison`, `comparisonInputsOpen`). */
  readonly resultsComparing?: ExternalStore<Readonly<Record<string, { readonly inputsOpen: boolean }>>>
  /** The state of each tab's focused comparison (`comparisonExactText`, `comparisonOneRow`, `comparisonChangesOnly`,
   *  `comparisonRowHasPartner`). */
  readonly comparisonToggles?: ExternalStore<Readonly<Record<string, { readonly exact: boolean; readonly oneRow: boolean; readonly changesOnly: boolean; readonly partner?: boolean }>>>
  /** Whether a Script As request is running (`scriptingRunning`). */
  readonly scripting?: ExternalStore<boolean>
  readonly bookmarks?: ExternalStore<BookmarkSnapshot>
  /** Insert or overtype (`editorOvertype`). */
  readonly inputMode?: ExternalStore<InputModeSnapshot>
  /** File › Recent Files (`hasRecentFiles`). */
  readonly recentFiles?: ExternalStore<readonly RecentFile[]>
  /** What AutoRecover offers (`hasRecoveryFiles`). */
  readonly recovery?: ExternalStore<RecoverySnapshot>
  /** The table designers' keys. */
  readonly designer?: ExternalStore<DesignerContextState>
  /** The Database Properties documents' keys. */
  readonly properties?: ExternalStore<PropertiesContextState>
  /** The Table Properties documents' keys. */
  readonly tableProperties?: ExternalStore<PropertiesContextState>
  readonly newDatabase?: ExternalStore<NewDatabaseContextState>
  /** The Restore Database documents' keys. */
  readonly restore?: ExternalStore<RestoreContextState>
  /** The toasts (`hasNotifications`). */
  readonly notifications?: ExternalStore<NotificationSnapshot>
  /** Help › Check for Updates (`updateBusy`, `updateAvailable`, `updateReady`). */
  readonly updates?: ExternalStore<UpdateState>
  /** The Activity Monitors' keys. */
  readonly activity?: ExternalStore<ActivityContextState>
  /** The Integration Services Operations documents' keys. */
  readonly ssis?: ExternalStore<SsisOperationsContextState>
  /** The Job History documents' keys. */
  readonly jobHistory?: ExternalStore<JobHistoryContextState>
  /** The editor groups (`multipleEditorGroups`, `activeDocumentFloating`). */
  readonly editorGroups?: ExternalStore<EditorGroupSnapshot>
  readonly editor?: () => FocusEditor<Element> | undefined
  readonly activeElement?: () => Element | null
}

/**
 * Context keys computed on read from service snapshots (and, for `get`, from the focused element), so nothing mirrored
 * can go stale. Listeners hear state changes, never focus changes.
 */
export class ContextKeyService implements Disposable {
  private listeners = new Set<() => void>()
  private cache?: { readonly inputs: readonly unknown[]; readonly keys: ContextKeys }
  private readonly unsubscribe: (() => void)[]
  constructor(private readonly options: ContextKeyOptions) {
    this.unsubscribe = [options.documents, options.queries, options.connections, options.backend, options.editorOptions, options.quickInput, options.panes, options.explorer, options.results, options.resultSets, options.resultsSteppable, options.resultsTurned, options.resultsComparing, options.scripting, options.bookmarks, options.inputMode, options.recentFiles, options.recovery, options.designer, options.shell, options.properties, options.tableProperties, options.newDatabase, options.restore, options.notifications, options.updates, options.activity, options.ssis, options.jobHistory, options.editorGroups, options.settings, options.comparisonToggles].flatMap(store => store ? [store.subscribe(() => this.changed())] : [])
  }
  private inputs(focus?: FocusFacts): ContextInputs {
    const { options } = this, editor = options.editorOptions.getSnapshot()
    return {
      platform: options.platform, agentEnabled: options.agentEnabled, focus, documents: options.documents.getSnapshot(), queries: options.queries.getSnapshot(), connections: options.connections.getSnapshot(),
      quickInputVisible: !!options.quickInput?.getSnapshot().visible, wordWrap: editor.wordWrap, whitespace: editor.whitespace, lineNumbers: editor.lineNumbers, resultsWhitespace: options.settings?.getSnapshot().values['queryResults.grid.whitespace'], resultsSortText: options.settings?.getSnapshot().values['queryResults.grid.sortText'], resultsColumnProfile: options.settings?.getSnapshot().values['queryResults.grid.columnProfile'], resultsProfileSelectedOnly: options.settings?.getSnapshot().values['queryResults.grid.columnProfileSelectedOnly'], resultsRowSize: options.settings?.getSnapshot().values['queryResults.grid.rowSize'], resultsLayout: options.settings?.getSnapshot().values['queryResults.grid.layout'], bookmarks: options.bookmarks?.getSnapshot().counts, backendStatus: options.backend.getSnapshot().state.status,
      panes: options.panes?.getSnapshot(), panelTabs: options.shell?.getSnapshot().panelTabs, explorer: options.explorer?.getSnapshot(), results: options.results?.getSnapshot(), resultSets: options.resultSets?.getSnapshot(), resultsSteppable: options.resultsSteppable?.getSnapshot(), resultsTurned: options.resultsTurned?.getSnapshot(), resultsComparing: options.resultsComparing?.getSnapshot(), comparisonToggles: options.comparisonToggles?.getSnapshot(), scriptingRunning: options.scripting?.getSnapshot(),
      overtype: options.inputMode?.getSnapshot().mode === 'overtype', recentFiles: !!options.recentFiles?.getSnapshot().length,
      recoveryFiles: !!options.recovery?.getSnapshot().entries.length, designer: options.designer?.getSnapshot(), properties: options.properties?.getSnapshot(), tableProperties: options.tableProperties?.getSnapshot(), newDatabase: options.newDatabase?.getSnapshot(), restore: options.restore?.getSnapshot(),
      notifications: !!options.notifications && options.notifications.getSnapshot().visible.length > 0, update: options.updates?.getSnapshot(), activity: options.activity?.getSnapshot(), ssis: options.ssis?.getSnapshot(), jobHistory: options.jobHistory?.getSnapshot(), editorGroups: options.editorGroups?.getSnapshot()
    }
  }
  /** Static and state keys, for enablement: focus keys are false or ''. Cached until a snapshot changes. */
  getState(): ContextKeys {
    const { options } = this
    const inputs = [options.documents.getSnapshot(), options.queries.getSnapshot(), options.connections.getSnapshot(), options.backend.getSnapshot(), options.editorOptions.getSnapshot(), options.quickInput?.getSnapshot(), options.panes?.getSnapshot(), options.explorer?.getSnapshot(), options.results?.getSnapshot(), options.resultSets?.getSnapshot(), options.resultsSteppable?.getSnapshot(), options.resultsTurned?.getSnapshot(), options.resultsComparing?.getSnapshot(), options.scripting?.getSnapshot(), options.bookmarks?.getSnapshot(), options.inputMode?.getSnapshot(), options.recentFiles?.getSnapshot(), options.recovery?.getSnapshot(), options.designer?.getSnapshot(), options.shell?.getSnapshot(), options.properties?.getSnapshot(), options.tableProperties?.getSnapshot(), options.newDatabase?.getSnapshot(), options.restore?.getSnapshot(), options.notifications?.getSnapshot(), options.updates?.getSnapshot(), options.activity?.getSnapshot(), options.ssis?.getSnapshot(), options.jobHistory?.getSnapshot(), options.editorGroups?.getSnapshot(), options.settings?.getSnapshot(), options.comparisonToggles?.getSnapshot()]
    if (this.cache?.inputs.every((value, index) => value === inputs[index])) return this.cache.keys
    const keys = computeContextKeys(this.inputs())
    this.cache = { inputs, keys }
    return keys
  }
  /** Every key, focus included, for keybinding `when` clauses. */
  get(): ContextKeys {
    // The focused element of the window the user is in (a popout's, when one has focus).
    const element = this.options.activeElement ? this.options.activeElement() : typeof document === 'undefined' ? null : windows.activeElement()
    return computeContextKeys(this.inputs(focusFacts(element, this.options.editor?.())))
  }
  private changed(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { onUnexpectedError(error) }
    }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  dispose(): void { this.unsubscribe.forEach(unsubscribe => unsubscribe()); this.listeners.clear() }
}
