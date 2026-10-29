import type { BackendStatus, RecentFile } from '../../../shared/contracts'
import { contextRecord, type ContextKeys } from '../../../shared/commands/context-keys'
import type { Platform } from '../../../shared/commands/keybindings'
import { isQueryDocument, isTextDocument } from '../documents'
import type { DocumentSnapshot } from '../services/documents'
import type { BookmarkSnapshot } from '../editor/bookmarks'
import type { EditorOptions } from '../services/editor-options'
import type { PaneVisibility } from '../services/panes'
import type { ShellOptions } from '../services/shell-options'
import type { QuerySnapshot } from '../services/queries'
import type { RecoverySnapshot } from '../services/recovery'
import type { BackendSnapshot } from '../services/backend'
import type { LiveConnection } from '../services/connections'
import type { ExplorerContextState } from '../explorer/ExplorerService'
import type { InputModeSnapshot } from './input-mode'
import type { NotificationSnapshot } from './notifications'
import { onUnexpectedError } from './errors'
import type { Disposable, ExternalStore } from './types'

export interface FocusFacts {
  readonly editorFocus: boolean; readonly editorTextFocus: boolean; readonly inputFocus: boolean; readonly activePanel: 'explorer' | 'editor' | 'output' | ''; readonly outputGridFocus: boolean
  readonly designerFocus: boolean; readonly queryBarFocus: boolean; readonly activityMonitorFocus: boolean
}
/** A table designer's state for its commands: TableDesignerService publishes one per open designer. */
export interface DesignerKeys { readonly editable: boolean; readonly rowSelected: boolean; readonly keyRemovable: boolean }
export interface DesignerContextState { readonly byDocument: Readonly<Record<string, DesignerKeys>>; readonly saving: boolean }
/** A Database Properties document's state for its verbs: DatabasePropertiesService publishes one per open document. */
export interface PropertiesKeys { readonly changed: boolean; readonly applicable: boolean; readonly applying: boolean; readonly refreshable: boolean }
export interface PropertiesContextState { readonly byDocument: Readonly<Record<string, PropertiesKeys>> }
/** An Activity Monitor's state for its commands: ActivityMonitorService publishes one per open monitor. */
export interface ActivityContextState { readonly byDocument: Readonly<Record<string, { readonly paused: boolean; readonly split: boolean }>> }
/** The parts of a DOM element and of the editor that `focusFacts` reads, so tests can pass plain objects. */
export interface FocusElement { matches(selector: string): boolean; closest(selector: string): { getAttribute(name: string): string | null } | null }
export interface FocusEditor<E> { getContainerDomNode(): { contains(node: E): boolean }; hasTextFocus(): boolean }

const noFocus: FocusFacts = { editorFocus: false, editorTextFocus: false, inputFocus: false, activePanel: '', outputGridFocus: false, designerFocus: false, queryBarFocus: false, activityMonitorFocus: false }
const panels: ReadonlySet<string> = new Set(['explorer', 'editor', 'output'])

/** Focus keys for the focused element. The find widget is inside the editor, so its inputs give editorFocus and inputFocus. */
export function focusFacts<E extends FocusElement>(element: E | null, editor: FocusEditor<E> | undefined): FocusFacts {
  if (!element) return noFocus
  const editorTextFocus = !!editor?.hasTextFocus()
  const editorFocus = editorTextFocus || !!editor?.getContainerDomNode().contains(element)
  const inputFocus = !editorTextFocus && (element.matches('input, textarea, select') || !!element.closest('[contenteditable]:not([contenteditable="false"])'))
  // DockWorkspace marks each pane host, and the mark moves with floating groups.
  const pane = element.closest('[data-pane]')?.getAttribute('data-pane') ?? ''
  return {
    editorFocus, editorTextFocus, inputFocus, activePanel: panels.has(pane) ? pane as FocusFacts['activePanel'] : '', outputGridFocus: !!element.closest('[data-result-grid]'),
    designerFocus: !!element.closest('[data-designer]'), queryBarFocus: !!element.closest('[data-query-bar]'), activityMonitorFocus: !!element.closest('[data-activity-monitor]')
  }
}

export interface ContextInputs {
  readonly platform: Platform
  readonly focus?: FocusFacts
  readonly documents: DocumentSnapshot
  readonly queries: QuerySnapshot
  readonly connections: readonly Pick<LiveConnection, 'id' | 'lost'>[]
  readonly quickInputVisible: boolean
  readonly wordWrap: boolean
  /** View White Space and line numbers in the query editor; without them, those keys are false. */
  readonly whitespace?: boolean
  readonly lineNumbers?: boolean
  /** Bookmarks per open document (`BookmarkService`). */
  readonly bookmarks?: Readonly<Record<string, number>>
  readonly backendStatus: BackendStatus | ''
  readonly panes?: PaneVisibility
  /** Window › Panel Tabs. */
  readonly panelTabs?: boolean
  /** The Object Explorer selection's keys; without them, those keys are false or ''. */
  readonly explorer?: ExplorerContextState
  /** The tabs with results to save or close (`ResultsService.context`). */
  readonly results?: Readonly<Record<string, true>>
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
  /** A toast is showing or waiting (`hasNotifications`). */
  readonly notifications?: boolean
  /** The Activity Monitors' keys; without them, those keys are false. */
  readonly activity?: ActivityContextState
}
/** Every context key from service snapshots and focus facts; without focus, the focus keys are false or ''. */
export function computeContextKeys(inputs: ContextInputs): ContextKeys {
  const { documents, connections } = inputs, focus = inputs.focus ?? noFocus
  const active = documents.documents.find(document => document.id === documents.activeId)
  const activeConnection = active?.connectionId ? connections.find(connection => connection.id === active.connectionId) : undefined
  const designer = active ? inputs.designer?.byDocument[active.id] : undefined, monitor = active ? inputs.activity?.byDocument[active.id] : undefined
  const properties = active ? inputs.properties?.byDocument[active.id] : undefined
  return contextRecord(inputs.platform, {
    ...focus, textInputFocus: focus.editorTextFocus || focus.inputFocus,
    quickInputVisible: inputs.quickInputVisible, backendStatus: inputs.backendStatus, backendReady: inputs.backendStatus === 'ready', editorWordWrap: inputs.wordWrap,
    editorWhitespace: !!inputs.whitespace, editorLineNumbers: !!inputs.lineNumbers,
    hasBookmarks: Object.values(inputs.bookmarks ?? {}).some(count => count > 0), activeDocumentHasBookmarks: !!active && (inputs.bookmarks?.[active.id] ?? 0) > 0,
    anyDocumentDirty: documents.documents.some(document => document.dirty), editorOvertype: !!inputs.overtype, hasRecentFiles: !!inputs.recentFiles, hasRecoveryFiles: !!inputs.recoveryFiles,
    hasActiveDocument: !!active, activeDocumentIsQuery: isQueryDocument(active), activeDocumentIsText: isTextDocument(active), activeDocumentIsDesigner: active?.kind === 'tableDesigner',
    activeDocumentIsProperties: active?.kind === 'databaseProperties', propertiesChanged: !!properties?.changed, propertiesApplicable: !!properties?.applicable, propertiesApplying: !!properties?.applying,
    propertiesRefreshable: !!properties?.refreshable,
    activeDocumentIsActivityMonitor: active?.kind === 'activityMonitor', activityPaused: !!monitor?.paused, activitySplit: !!monitor?.split,
    designerEditable: !!designer?.editable, designerRowSelected: !!designer?.rowSelected, designerPrimaryKeyRemovable: !!designer?.keyRemovable, designerSaving: !!inputs.designer?.saving, multipleDocuments: documents.documents.length > 1, documentBusy: documents.busy,
    hasConnection: connections.some(connection => !connection.lost), hasLostConnection: connections.some(connection => connection.lost),
    activeDocumentConnected: !!activeConnection && !activeConnection.lost, activeConnectionLost: !!activeConnection?.lost,
    anyDocumentConnected: documents.documents.some(document => isQueryDocument(document) && !!document.connectionId && connections.some(connection => connection.id === document.connectionId && !connection.lost)),
    queryRunning: !!active && !!inputs.queries[active.id]?.running, hasResults: !!active && !!inputs.results?.[active.id], outputPaneVisible: !!inputs.panes?.output, panelTabsVisible: !!inputs.panelTabs, ...inputs.explorer,
    scriptingRunning: !!inputs.scriptingRunning, hasNotifications: !!inputs.notifications
  })
}

export interface ContextKeyOptions {
  readonly platform: Platform
  readonly documents: ExternalStore<DocumentSnapshot>
  readonly queries: ExternalStore<QuerySnapshot>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly backend: ExternalStore<BackendSnapshot>
  readonly editorOptions: ExternalStore<EditorOptions>
  readonly quickInput?: ExternalStore<{ readonly visible: boolean }>
  readonly panes?: ExternalStore<PaneVisibility>
  /** The shell's layout options (`panelTabsVisible`). */
  readonly shell?: ExternalStore<ShellOptions>
  readonly explorer?: ExternalStore<ExplorerContextState>
  readonly results?: ExternalStore<Readonly<Record<string, true>>>
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
  /** The toasts (`hasNotifications`). */
  readonly notifications?: ExternalStore<NotificationSnapshot>
  /** The Activity Monitors' keys. */
  readonly activity?: ExternalStore<ActivityContextState>
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
    this.unsubscribe = [options.documents, options.queries, options.connections, options.backend, options.editorOptions, options.quickInput, options.panes, options.explorer, options.results, options.scripting, options.bookmarks, options.inputMode, options.recentFiles, options.recovery, options.designer, options.shell, options.properties, options.notifications, options.activity].flatMap(store => store ? [store.subscribe(() => this.changed())] : [])
  }
  private inputs(focus?: FocusFacts): ContextInputs {
    const { options } = this, editor = options.editorOptions.getSnapshot()
    return {
      platform: options.platform, focus, documents: options.documents.getSnapshot(), queries: options.queries.getSnapshot(), connections: options.connections.getSnapshot(),
      quickInputVisible: !!options.quickInput?.getSnapshot().visible, wordWrap: editor.wordWrap, whitespace: editor.whitespace, lineNumbers: editor.lineNumbers, bookmarks: options.bookmarks?.getSnapshot().counts, backendStatus: options.backend.getSnapshot().state.status,
      panes: options.panes?.getSnapshot(), panelTabs: options.shell?.getSnapshot().panelTabs, explorer: options.explorer?.getSnapshot(), results: options.results?.getSnapshot(), scriptingRunning: options.scripting?.getSnapshot(),
      overtype: options.inputMode?.getSnapshot().mode === 'overtype', recentFiles: !!options.recentFiles?.getSnapshot().length,
      recoveryFiles: !!options.recovery?.getSnapshot().entries.length, designer: options.designer?.getSnapshot(), properties: options.properties?.getSnapshot(),
      notifications: !!options.notifications && options.notifications.getSnapshot().visible.length > 0, activity: options.activity?.getSnapshot()
    }
  }
  /** Static and state keys, for enablement: focus keys are false or ''. Cached until a snapshot changes. */
  getState(): ContextKeys {
    const { options } = this
    const inputs = [options.documents.getSnapshot(), options.queries.getSnapshot(), options.connections.getSnapshot(), options.backend.getSnapshot(), options.editorOptions.getSnapshot(), options.quickInput?.getSnapshot(), options.panes?.getSnapshot(), options.explorer?.getSnapshot(), options.results?.getSnapshot(), options.scripting?.getSnapshot(), options.bookmarks?.getSnapshot(), options.inputMode?.getSnapshot(), options.recentFiles?.getSnapshot(), options.recovery?.getSnapshot(), options.designer?.getSnapshot(), options.shell?.getSnapshot(), options.properties?.getSnapshot(), options.notifications?.getSnapshot(), options.activity?.getSnapshot()]
    if (this.cache?.inputs.every((value, index) => value === inputs[index])) return this.cache.keys
    const keys = computeContextKeys(this.inputs())
    this.cache = { inputs, keys }
    return keys
  }
  /** Every key, focus included, for keybinding `when` clauses. */
  get(): ContextKeys {
    const element = this.options.activeElement ? this.options.activeElement() : typeof document === 'undefined' ? null : document.activeElement
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
