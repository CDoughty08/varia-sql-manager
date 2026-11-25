import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import { actionLimits, dialogTitle } from '../../../shared/actions/catalog.ts'
import { noScriptNotice } from '../../../shared/actions/database.ts'
import type { ActionError, ActionExecuteResult, ActionRequest, ActionStep } from '../../../shared/actions/schema.ts'
import type { TablePropertiesModel } from '../../../shared/actions/tables.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { NodeSubtype } from '../../../shared/explorer/catalog.ts'
import { peekLimits, type PeekList } from '../../../shared/explorer/peek.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import { scriptMenuState, type ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { defaultScriptingOptions, type ScriptingOptions } from '../../../shared/scripting/options.ts'
import { selectTopRowsScript } from '../../../shared/sql/identifiers'
import { addPropertyRow, initialTableDraft, patchPropertyRow, tableChanged, tableConfirmation, tableErrors, tableRequest, type ExtendedPropertyRow, type TableDraft } from '../dialogs/table-properties'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { PropertiesContextState, PropertiesKeys } from '../core/contextkeys'
import type { Disposable, ExternalStore } from '../core/types'
import { copyableDefinition, peekMessages, type PeekDefinition, type PeekDependencies, type PeekPart, type PeekResults, type PeekRows } from '../explorer/PeekService'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { ScriptContent } from '../kit/ScriptDrawer'
import type { ExplorerMenuNode } from '../menus/targets'
import { deliverScript, type DeliverScriptDeps } from '../scripting/deliver'
import { scriptFileName, scriptObjectLabel } from '../scripting/ScriptingService'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import { previewDelayMs, type PropertiesPhase } from './DatabasePropertiesService'
import { isTableInspectorTab, type TableInspectorTabId } from './table-fields'

export interface TableCatalogLists {
  readonly columns?: PeekList
  readonly tableObjects?: PeekList
}

export interface TablePropertiesState {
  readonly id: string
  readonly target: ObjectRef
  readonly subtype?: NodeSubtype
  /** The table as Object Explorer shows it (schema.name). */
  readonly label: string
  readonly server: string
  readonly login?: string
  readonly phase: PropertiesPhase
  readonly model?: TablePropertiesModel
  readonly draft?: TableDraft
  /** Moves with every draft change, a read included: which draft the Script preview shows. */
  readonly revision: number
  /** Moves only with the person's edits (and Discard Changes): what the close prompt compares. */
  readonly edits: number
  readonly changed: boolean
  /** Whether the last Apply completed is unknown (the server or backend went, or Stop got no answer): Apply waits for a Refresh. */
  readonly stale: boolean
  readonly error?: ActionError
  readonly notice?: string
  readonly steps?: readonly ActionStep[]
  readonly frame: FrameState
  /** Active canonical inspector tab; lazy-loaded tabs only query SQL Server when activated. */
  readonly activeTab: TableInspectorTabId
  readonly definition?: PeekPart<PeekDefinition>
  readonly definitionEpoch: number
  readonly catalog?: PeekPart<TableCatalogLists>
  readonly dependencies?: PeekPart<PeekDependencies>
  readonly preview?: PeekPart<PeekRows>
  readonly script: ScriptContent
  readonly scriptRevision?: number
  readonly scriptDatabase?: string
  readonly scriptNotice?: string
}
export interface TablePropertiesSnapshot { readonly documents: Readonly<Record<string, TablePropertiesState>> }

type LazyApi = Partial<Pick<VariaApi,
  'explorerPeek' | 'explorerPeekDependencies' | 'explorerCancel' | 'scriptObjects' | 'cancelScripting' | 'tableColumns' | 'execute' | 'closeQuerySession'
>>

export interface TablePropertiesServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText' | 'confirmAction'> & LazyApi
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'update' | 'setDirty' | 'activate' | 'getSnapshot' | 'subscribe' | 'newQuery'>
  readonly files: DeliverScriptDeps['files']
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly scriptingOptions?: ExternalStore<{ readonly options: ScriptingOptions }>
  readonly results?: PeekResults
  readonly focus?: (id: string) => void
  readonly focusEditor?: () => void
  readonly timers?: Timers
  readonly newId?: () => string
}

export const tablePropertiesMessages = {
  applied: 'The changes were applied.',
  disconnected: 'The server was disconnected. Reconnect, or connect to it again and choose Properties on this table, to read it again.',
  stopped: 'The changes were stopped, but SQL Server did not confirm it in time, so whether they were applied is unknown. Discard Changes, then Refresh to read the table again.',
  stale: 'Whether the last changes were applied is unknown. Discard Changes, then Refresh to read the table again before applying more.',
  connectionLost: 'The server was disconnected while the changes were being applied, so whether they were applied is unknown. Reconnect, or connect to it again and choose Properties on this table, then Discard Changes and Refresh.',
  backendLost: 'The SQL backend stopped while the changes were being applied, so whether they were applied is unknown. Discard Changes, then Refresh to read the table again.',
  appliedUnread: 'The changes were applied, but the table could not be read again:',
  applying: 'The changes are being applied. Stop them, or wait for them to finish.',
  readFailed: 'The table could not be read.'
} as const

const error = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: true })

interface LazyRequests {
  definition?: string
  catalog?: string
  dependencies?: string
}

interface PreviewRun {
  readonly key: string
  readonly queryId: string
  session: boolean
}

/**
 * Table Properties as a unified inspector document: one tab per table and connection, canonical tabs (Overview, Definition,
 * Storage & Layout, Columns, Indexes & Keys, Dependencies, Permissions & RLS, Extended Properties, Preview Rows), with
 * lazy-loaded read-only tabs so opening Table Properties adds zero extra SQL round-trips. Apply runs only what changed in
 * one transaction, after a native question when turning change tracking off. It is DocumentService's provider for
 * 'tableProperties' documents: Save applies.
 */
export class TablePropertiesService extends SnapshotStore<TablePropertiesSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'tableProperties' as const
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly timers: Timers
  private readonly registration: Disposable
  private readonly unsubscribe: (() => void)[]
  private readonly contextStore = new (class extends SnapshotStore<PropertiesContextState> { set(value: PropertiesContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {} })
  private readonly requests = new Map<string, { readonly id: string; readonly kind: 'describe' | 'apply'; readonly connectionId?: string; dropped: boolean }>()
  private readonly lazyRequests = new Map<string, LazyRequests>()
  private readonly previewRuns = new Map<string, PreviewRun>()
  private readonly previews = new Map<string, string>()
  private readonly previewTimers = new Map<string, unknown>()
  private readonly applies = new Map<string, Promise<boolean>>()
  private rows = 0
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false

  constructor(private readonly options: TablePropertiesServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.registration = options.documents.registerProvider(this)
    this.unsubscribe = [
      options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } }),
      options.documents.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } })
    ]
    if (options.scriptingOptions) {
      let optionsKey = JSON.stringify(options.scriptingOptions.getSnapshot().options)
      this.unsubscribe.push(options.scriptingOptions.subscribe(() => {
        try {
          const next = JSON.stringify(options.scriptingOptions!.getSnapshot().options)
          if (next === optionsKey) return
          optionsKey = next
          this.scriptingOptionsChanged()
        } catch (failure) { onUnexpectedError(failure) }
      }))
    }
  }

  get context(): ExternalStore<PropertiesContextState> { return this.contextStore }
  get(id: string): TablePropertiesState | undefined { return this.getSnapshot().documents[id] }

  /** Properties on a table node: its document comes forward if open (switching to `tab` if specified), otherwise opens at once. */
  open(node: ExplorerMenuNode, tab?: TableInspectorTabId): string {
    if (this.disposed) throw new Error('Table Properties is not available.')
    const target = node.ref.type === 'object' && node.ref.object.kind === 'table' ? node.ref.object : undefined
    const connection = this.options.connections.getSnapshot().find(item => item.id === node.connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!target) throw new Error('Select a table in Object Explorer.')
    if (!connection) throw new Error('Connect to the server first.')
    const same = (state: TablePropertiesState) => state.target.database === target.database && state.target.schema === target.schema && state.target.name === target.name
    const documents = Object.values(this.getSnapshot().documents).filter(same)
    // Only a document bound to this connection's exact target is this table's; a handle id alone never proves it.
    const existing = documents.find(state => this.connectionOf(state.id) === node.connectionId && this.targetBindings.matchesConnection(state.id, node.connectionId))
    if (existing) {
      this.options.documents.activate(existing.id)
      if (tab) this.selectTab(existing.id, tab)
      return existing.id
    }
    // Reopening Properties can reuse a disconnected draft only after the registry proves the exact original target.
    const orphan = documents.find(state => !this.live(state.id) && this.targetBindings.matchesConnection(state.id, connection.id))
    if (orphan) {
      this.rebind(orphan.id, connection, tab)
      return orphan.id
    }
    const label = scriptObjectLabel(target)
    const initialTab: TableInspectorTabId = tab ?? 'overview'
    const document = this.options.documents.openCustom('tableProperties', dialogTitle('tableProperties', label), connection.id, target.database ?? 'master')
    this.targetBindings.bind(document.id, connection.id)
    this.put({
      id: document.id, target, ...(node.subtype !== undefined ? { subtype: node.subtype } : {}), label, server: connection.server, ...connection.login ? { login: connection.login } : {},
      phase: 'loading', revision: 0, edits: 0, changed: false, stale: false,
      frame: initialFrameState([{ id: initialTab }]), activeTab: initialTab, definitionEpoch: 0,
      script: { state: 'idle', message: noScriptNotice }
    })
    void this.describe(document.id)
    // Only load a read-only catalog tab immediately when promoted directly onto it; opening Overview adds zero extra SQL round-trips.
    if (isLazyTab(initialTab)) this.ensureTabLoaded(document.id, initialTab)
    return document.id
  }

  // --- Tabs & lazy read-only catalog loading -------------------------------------------------------------------------

  /** Selects an inspector tab, triggering its lazy catalog/script/preview query only on activation. */
  selectTab(id: string, tab: TableInspectorTabId): void {
    const state = this.get(id)
    if (!state || !isTableInspectorTab(tab)) return
    if (state.activeTab !== tab || state.frame.section !== tab) {
      this.patch(id, { activeTab: tab, frame: { ...state.frame, section: tab } })
    }
    if (isLazyTab(tab)) this.ensureTabLoaded(id, tab)
  }

  /** Retries a failed lazy tab read (or loads it if unloaded). */
  retryTab(id: string, tab: TableInspectorTabId): void {
    if (!this.get(id) || !isLazyTab(tab)) return
    this.ensureTabLoaded(id, tab)
  }

  /** Whether the document is currently bound to a live connection. */
  isConnected(id: string): boolean { return this.live(id) }

  /** Copies the loaded CREATE TABLE definition script to the clipboard; returns true when written. */
  async copyDefinition(id: string): Promise<boolean> {
    const definition = this.get(id)?.definition
    if (definition?.status !== 'ready' || !copyableDefinition(definition.value.text)) return false
    const result = await this.options.api.writeClipboardText(definition.value.text)
    if (!result.ok) throw new Error(result.error)
    return true
  }

  /** Opens the loaded CREATE TABLE definition script in a new query tab (unconnected if the server disconnected). */
  openDefinitionInQuery(id: string): void {
    const state = this.get(id), connectionId = this.live(id) ? this.connectionOf(id) : undefined
    const text = state?.definition?.status === 'ready' ? state.definition.value.text : undefined
    if (!state || text === undefined) return
    this.options.documents.newQuery(text, undefined, connectionId, state.target.database ?? 'master', false)
    this.options.focusEditor?.()
  }

  // --- Editing -------------------------------------------------------------------------------------------------------

  canEdit(id: string): boolean {
    const state = this.get(id)
    return !!state?.model && !!state.draft && state.phase === 'ready' && !state.stale && !state.model.readOnlyReason
  }
  updateDraft(id: string, patch: Partial<TableDraft>): void {
    const state = this.get(id)
    if (!state?.draft) return
    this.setDraft(id, { ...state.draft, ...patch })
  }
  /** Extended Properties' New: an empty row, whose name field the view focuses. Returns its key. */
  addProperty(id: string): string | undefined {
    const state = this.get(id)
    if (!state?.draft || !this.canEdit(id) || state.model?.extendedPropertiesTruncated) return undefined
    const key = `new-${++this.rows}`
    this.setDraft(id, addPropertyRow(state.draft, key))
    return key
  }
  patchProperty(id: string, key: string, patch: Partial<Pick<ExtendedPropertyRow, 'name' | 'value' | 'removed'>>): void {
    const state = this.get(id)
    if (!state?.draft) return
    this.setDraft(id, patchPropertyRow(state.draft, key, patch))
  }
  private setDraft(id: string, draft: TableDraft): void {
    const state = this.get(id)
    if (!state?.model || !state.draft || !this.canEdit(id)) return
    const changed = tableChanged(state.model, draft)
    this.patch(id, { draft, changed, revision: state.revision + 1, edits: state.edits + 1, notice: undefined, ...state.error?.code === 'NOT_SUPPORTED' ? { error: undefined } : {} })
    this.options.documents.setDirty(id, changed)
    this.schedulePreview(id)
  }
  canDiscard(id: string): boolean {
    const state = this.get(id)
    return !!state?.model && !!state.draft && state.changed && state.phase !== 'applying' && state.phase !== 'confirming'
  }
  discard(id: string): void {
    const state = this.get(id)
    if (!state?.model || !state.draft || state.phase === 'applying' || state.phase === 'confirming') return
    this.patch(id, { draft: initialTableDraft(state.model), changed: false, revision: state.revision + 1, edits: state.edits + 1, ...state.stale || state.error?.code === 'NOT_FOUND' ? {} : { error: undefined }, notice: undefined, steps: undefined })
    this.options.documents.setDirty(id, false)
    this.schedulePreview(id)
  }
  setFrame(id: string, frame: FrameState): void {
    const state = this.get(id)
    if (!state || state.frame === frame) return
    const opened = frame.scriptOpen && !state.frame.scriptOpen
    const nextTab = isTableInspectorTab(frame.section) ? frame.section : state.activeTab
    this.patch(id, { frame, activeTab: nextTab })
    if (opened) this.schedulePreview(id, 0)
  }
  errors(id: string): Map<string, string> {
    const state = this.get(id)
    return state?.model && state.draft ? tableErrors(state.model, state.draft) : new Map()
  }

  // --- Reading -------------------------------------------------------------------------------------------------------

  refresh(id: string): void {
    if (!this.canRefresh(id)) return
    this.resetLazyTabs(id, false)
    this.patch(id, { phase: 'loading', error: undefined, notice: undefined, steps: undefined })
    void this.describe(id)
    const state = this.get(id)
    if (state && isLazyTab(state.activeTab)) this.ensureTabLoaded(id, state.activeTab)
  }
  canRefresh(id: string): boolean {
    const state = this.get(id)
    return !!state && this.live(id) && (state.phase === 'ready' || state.phase === 'loadFailed') && !state.changed
  }
  private async describe(id: string, notice?: string): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return
    const requestId = this.begin(id, 'describe')
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'tableProperties', target: state.target }))
    if (!this.end(id, requestId)) return
    const failure = !result.ok ? error('SQL_ERROR', result.error) : result.value.error
    const model = result.ok ? result.value.tableProperties : undefined
    if (failure || !model) {
      const shown = failure ?? error('NOT_FOUND', tablePropertiesMessages.readFailed)
      this.patch(id, { phase: this.get(id)?.model ? 'ready' : 'loadFailed', error: notice ? { ...shown, message: `${tablePropertiesMessages.appliedUnread} ${shown.message}` } : shown, ...this.get(id)?.model ? { stale: true } : {} })
      return
    }
    const current = this.get(id)!
    const nonScriptable = model.ledger?.dropped || model.ledger?.type === 'LEDGER_HISTORY_TABLE'
    if (nonScriptable && (current.definition?.status === 'loading' || current.definition?.status === 'error')) {
      const lazy = this.lazyRequests.get(id)
      if (lazy?.definition) {
        const scriptId = lazy.definition
        delete lazy.definition
        this.cancelScript([scriptId])
      }
    }
    this.patch(id, {
      phase: 'ready', model, draft: initialTableDraft(model), changed: false, stale: false, revision: current.revision + 1, error: undefined,
      ...notice ? { notice } : {}, script: { state: 'idle', message: noScriptNotice }, scriptRevision: undefined,
      ...(nonScriptable && (current.definition?.status === 'loading' || current.definition?.status === 'error')
        ? { definition: { status: 'ready', value: {} }, definitionEpoch: current.definitionEpoch + 1 } : {})
    })
    this.options.documents.setDirty(id, false)
    this.schedulePreview(id, 0)
  }

  // --- Apply, Stop ---------------------------------------------------------------------------------------------------

  canApply(id: string): boolean {
    const state = this.get(id)
    return !!state && state.phase === 'ready' && state.changed && !state.stale && this.live(id) && !state.model?.readOnlyReason
  }
  apply(id: string): Promise<boolean> {
    const running = this.applies.get(id)
    if (running) return running
    const promise = this.runApply(id).catch(failure => { onUnexpectedError(failure); return false }).finally(() => { this.applies.delete(id); this.publishContext() })
    this.applies.set(id, promise)
    return promise
  }
  private async runApply(id: string): Promise<boolean> {
    let state = this.get(id)
    if (!state?.model || !state.draft) return false
    if (!state.changed) return true
    if (state.stale) { this.patch(id, { error: error('CONNECTION_LOST', tablePropertiesMessages.stale) }); this.show(id); return false }
    if (!this.live(id)) { this.patch(id, { error: error('CONNECTION_LOST', tablePropertiesMessages.disconnected) }); this.show(id); return false }
    if (state.phase !== 'ready') return false
    const built = tableRequest(state.target, state.model, state.draft)
    if (!built) return true
    if ('problem' in built) { this.patch(id, { error: error('NOT_SUPPORTED', built.problem) }); this.show(id); return false }
    const confirmation = tableConfirmation(state.model, built)
    if (confirmation) {
      // Main's message box; a failure, a close or a lost server meanwhile counts as Cancel, and Cancel sends nothing.
      this.patch(id, { phase: 'confirming', error: undefined, notice: undefined })
      this.show(id)
      const answer = await this.call(() => this.options.api.confirmAction(confirmation))
      if (this.disposed || this.get(id)?.phase !== 'confirming') return false
      if (!answer.ok || answer.value !== 'apply' || !this.live(id)) { this.patch(id, { phase: 'ready' }); return false }
    }
    const connectionId = this.connectionOf(id)!
    const requestId = this.begin(id, 'apply'), request = this.requests.get(id)
    this.patch(id, { phase: 'applying', error: undefined, notice: undefined, steps: undefined })
    const result = await this.call(() => this.options.api.executeObjectAction({ ...built, connectionId, requestId } as ActionRequest))
    if (this.requests.get(id)?.id === requestId) this.requests.delete(id)
    this.publishContext()
    if (this.disposed || !this.get(id) || request?.dropped) return false
    if (this.connectionOf(id) !== connectionId || !this.live(id)) {
      this.patch(id, { phase: 'ready', stale: true, error: error('CONNECTION_LOST', tablePropertiesMessages.connectionLost) })
      return false
    }
    state = this.get(id)!
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    if (value && !value.error) {
      this.invalidateDefinition(id)
      this.patch(id, { phase: 'loading', steps: value.steps, changed: false })
      this.options.documents.setDirty(id, false)
      await this.describe(id, tablePropertiesMessages.applied)
      if (this.get(id)?.activeTab === 'definition' && this.live(id)) this.loadDefinition(id)
      return true
    }
    // One transaction: a failure or a Stop that SQL Server confirmed rolled every statement back, so the table is as it was read.
    if (value?.error) { this.patch(id, { phase: 'ready', error: value.error, steps: value.steps }); this.show(id); return false }
    if (!result.ok && result.code === 'CANCELLED') { this.patch(id, { phase: 'ready', stale: true, error: error('CANCELLED', tablePropertiesMessages.stopped) }); return false }
    const lost = !result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST')
    const failure = lost ? error('CONNECTION_LOST', !result.ok && result.code === 'BACKEND_LOST' ? tablePropertiesMessages.backendLost : tablePropertiesMessages.connectionLost)
      : error('SQL_ERROR', result.ok ? 'The changes could not be applied.' : result.error)
    this.patch(id, { phase: 'ready', error: failure, ...lost ? { stale: true } : {} })
    this.show(id)
    return false
  }
  stop(id: string): void {
    const request = this.requests.get(id)
    if (request?.kind === 'apply') this.cancel([request.id])
  }

  // --- Script ----------------------------------------------------------------------------------------------------------

  async deliver(id: string, destination: ScriptDestination): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return
    let text = this.currentScript(id)
    if (text === undefined) {
      this.clearPreviewTimer(id)
      text = await this.preview(id)
    }
    const current = this.get(id)
    if (!current || this.disposed) return
    if (text === undefined) {
      const script = current.script
      this.patch(id, { scriptNotice: script.state === 'failed' ? script.error.message : script.state === 'idle' ? script.message : 'No script was produced.' })
      return
    }
    try {
      const notice = await deliverScript({ destination, text, database: current.scriptDatabase ?? current.target.database ?? 'master', connectionId, fileName: scriptFileName(current.target) }, this.options)
      this.patch(id, { scriptNotice: notice })
    } catch (failure) { this.patch(id, { scriptNotice: failure instanceof Error ? failure.message : 'The script could not be delivered.' }) }
  }
  private schedulePreview(id: string, delay = previewDelayMs): void {
    const state = this.get(id)
    if (!state?.frame.scriptOpen || state.scriptRevision === state.revision && state.script.state !== 'failed') return
    this.clearPreviewTimer(id)
    this.previewTimers.set(id, this.timers.setTimeout(() => { this.previewTimers.delete(id); void this.preview(id) }, delay))
  }
  private clearPreviewTimer(id: string): void {
    const pending = this.previewTimers.get(id)
    if (pending !== undefined) this.timers.clearTimeout(pending)
    this.previewTimers.delete(id)
  }
  private currentScript(id: string): string | undefined {
    const state = this.get(id)
    return state?.script.state === 'ready' && state.scriptRevision === state.revision ? state.script.text : undefined
  }
  private async preview(id: string): Promise<string | undefined> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state?.model || !state.draft || !connectionId) return undefined
    const revision = state.revision
    const built = tableRequest(state.target, state.model, state.draft)
    if (!built) { this.patch(id, { script: { state: 'idle', message: noScriptNotice }, scriptRevision: revision }); return undefined }
    if ('problem' in built) { this.patch(id, { script: { state: 'idle', message: built.problem }, scriptRevision: revision }); return undefined }
    if (!this.live(id)) { this.patch(id, { script: { state: 'failed', error: { message: tablePropertiesMessages.disconnected, code: 'CONNECTION_LOST' } }, scriptRevision: revision }); return undefined }
    const previous = this.previews.get(id)
    if (previous) this.cancel([previous])
    const requestId = this.newId()
    this.previews.set(id, requestId)
    this.patch(id, { script: { state: 'loading' } })
    const result = await this.call(() => this.options.api.scriptObjectAction({ ...built, connectionId, requestId } as ActionRequest))
    // A newer preview replaced this one: its answer is the drawer's.
    if (this.previews.get(id) !== requestId) return undefined
    this.previews.delete(id)
    if (this.disposed || !this.get(id) || this.connectionOf(id) !== connectionId || !this.live(id)) return undefined
    const failure = !result.ok ? { message: result.error, ...result.code ? { code: result.code } : {} } : result.value.error ? { message: result.value.error.message, code: result.value.error.code } : undefined
    const text = result.ok ? result.value.text : undefined
    if (failure || text === undefined) { this.patch(id, { script: { state: 'failed', error: failure ?? { message: 'No script was produced.' } }, scriptRevision: revision }); return undefined }
    this.patch(id, { script: { state: 'ready', text }, scriptRevision: revision, scriptDatabase: result.ok ? result.value.database : undefined })
    if (this.get(id)?.revision !== revision) this.schedulePreview(id)
    return text
  }

  // --- CustomDocumentProvider ----------------------------------------------------------------------------------------

  save(id: string): Promise<boolean> { this.show(id); return this.apply(id) }
  canClose(id: string): string | undefined { const phase = this.get(id)?.phase; return phase === 'applying' || phase === 'confirming' ? tablePropertiesMessages.applying : undefined }
  revision(id: string): number { return this.get(id)?.edits ?? 0 }
  focus(id: string): void { this.options.focus?.(id) }
  /** Legacy server-name reassociation is refused; reconnect callers must supply durable identity. */
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  closed(id: string): void {
    this.targetBindings.forget(id)
    const request = this.requests.get(id), preview = this.previews.get(id)
    this.cancel([request?.id, preview].filter((value): value is string => !!value))
    this.cancelLazyRequests(id)
    this.releasePreview(id)
    this.requests.delete(id)
    this.previews.delete(id)
    this.clearPreviewTimer(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
    this.publishContext()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.targetBindings.clear()
    this.cancel([...this.requests.values()].map(request => request.id).concat([...this.previews.values()]))
    for (const id of [...this.lazyRequests.keys()]) this.cancelLazyRequests(id)
    for (const id of [...this.previewRuns.keys()]) this.releasePreview(id)
    for (const timer of this.previewTimers.values()) this.timers.clearTimeout(timer)
    this.requests.clear()
    this.previews.clear()
    this.previewTimers.clear()
    this.registration.dispose()
    this.unsubscribe.forEach(unsubscribe => unsubscribe())
    this.clearListeners()
    this.contextStore.clear()
  }

  // --- Lazy read-only tab internals ----------------------------------------------------------------------------------

  private ensureTabLoaded(id: string, tab: LazyTab): void {
    if (this.disposed) return
    switch (tab) {
      case 'definition': this.loadDefinition(id); break
      case 'columns':
      case 'indexes': this.loadCatalog(id); break
      case 'dependencies': this.loadDependencies(id); break
      case 'preview': this.loadPreviewRows(id); break
    }
  }

  private lazyOf(id: string): LazyRequests {
    let entry = this.lazyRequests.get(id)
    if (!entry) { entry = {}; this.lazyRequests.set(id, entry) }
    return entry
  }

  private isScriptableTable(state: TablePropertiesState): boolean {
    if (state.model?.ledger?.dropped || state.model?.ledger?.type === 'LEDGER_HISTORY_TABLE') return false
    return scriptMenuState({ kind: 'table', ...(state.subtype !== undefined ? { subtype: state.subtype } : {}) }).verbs.create === 'enabled'
  }

  private loadDefinition(id: string): void {
    const state = this.get(id)
    if (!state || (state.definition && state.definition.status !== 'error')) return
    if (!this.isScriptableTable(state)) {
      this.patch(id, { definition: { status: 'ready', value: {} }, definitionEpoch: state.definitionEpoch + 1 })
      return
    }
    const connectionId = this.connectionOf(id)
    if (!connectionId || !this.live(id)) {
      this.patch(id, { definition: { status: 'error', message: peekMessages.notConnected } })
      return
    }
    const scriptObjects = this.options.api.scriptObjects
    if (!scriptObjects) {
      this.patch(id, { definition: { status: 'error', message: 'Definition scripting is unavailable.' } })
      return
    }
    const lazy = this.lazyOf(id)
    if (lazy.definition) this.cancelScript([lazy.definition])
    const requestId = this.newId()
    lazy.definition = requestId
    this.patch(id, { definition: { status: 'loading' } })
    const options = this.options.scriptingOptions?.getSnapshot().options ?? defaultScriptingOptions
    void this.call(() => scriptObjects({ connectionId, requestId, targets: [state.target], verb: 'create', options })).then(result => {
      if (this.lazyRequests.get(id)?.definition !== requestId) return
      delete this.lazyRequests.get(id)!.definition
      if (this.disposed || !this.get(id) || this.connectionOf(id) !== connectionId || !this.live(id)) return
      const current = this.get(id)!
      if (!result.ok || result.value.error) {
        const message = result.ok ? result.value.error?.message ?? 'Could not script the table.' : result.error
        this.patch(id, { definition: { status: 'error', message } })
        return
      }
      this.patch(id, {
        definition: { status: 'ready', value: result.value.text === undefined ? {} : { text: result.value.text } },
        definitionEpoch: current.definitionEpoch + 1
      })
    }).catch(onUnexpectedError)
  }

  private loadCatalog(id: string): void {
    const state = this.get(id)
    if (!state || (state.catalog && state.catalog.status !== 'error')) return
    const connectionId = this.connectionOf(id)
    if (!connectionId || !this.live(id)) {
      this.patch(id, { catalog: { status: 'error', message: peekMessages.notConnected } })
      return
    }
    const explorerPeek = this.options.api.explorerPeek
    if (!explorerPeek) {
      this.patch(id, { catalog: { status: 'error', message: 'Catalog details are unavailable.' } })
      return
    }
    const lazy = this.lazyOf(id)
    if (lazy.catalog) this.cancelExplorer([lazy.catalog])
    const requestId = this.newId()
    lazy.catalog = requestId
    this.patch(id, { catalog: { status: 'loading' } })
    void this.call(() => explorerPeek({ connectionId, requestId, target: state.target })).then(result => {
      if (this.lazyRequests.get(id)?.catalog !== requestId) return
      delete this.lazyRequests.get(id)!.catalog
      if (this.disposed || !this.get(id) || this.connectionOf(id) !== connectionId || !this.live(id)) return
      if (!result.ok || result.value.error) {
        const message = result.ok ? result.value.error?.message ?? 'Could not read catalog details.' : result.error
        this.patch(id, { catalog: { status: 'error', message } })
        return
      }
      this.patch(id, {
        catalog: { status: 'ready', value: { columns: result.value.lists?.columns, tableObjects: result.value.lists?.tableObjects } }
      })
    }).catch(onUnexpectedError)
  }

  private loadDependencies(id: string): void {
    const state = this.get(id)
    if (!state || (state.dependencies && state.dependencies.status !== 'error')) return
    const connectionId = this.connectionOf(id)
    if (!connectionId || !this.live(id)) {
      this.patch(id, { dependencies: { status: 'error', message: peekMessages.notConnected } })
      return
    }
    const explorerPeekDependencies = this.options.api.explorerPeekDependencies
    if (!explorerPeekDependencies) {
      this.patch(id, { dependencies: { status: 'error', message: 'Dependencies are unavailable.' } })
      return
    }
    const lazy = this.lazyOf(id)
    if (lazy.dependencies) this.cancelExplorer([lazy.dependencies])
    const requestId = this.newId()
    lazy.dependencies = requestId
    this.patch(id, { dependencies: { status: 'loading' } })
    void this.call(() => explorerPeekDependencies({ connectionId, requestId, target: state.target })).then(result => {
      if (this.lazyRequests.get(id)?.dependencies !== requestId) return
      delete this.lazyRequests.get(id)!.dependencies
      if (this.disposed || !this.get(id) || this.connectionOf(id) !== connectionId || !this.live(id)) return
      if (!result.ok || result.value.error) {
        const message = result.ok ? result.value.error?.message ?? 'Could not read dependencies.' : result.error
        this.patch(id, { dependencies: { status: 'error', message } })
        return
      }
      this.patch(id, {
        dependencies: {
          status: 'ready',
          value: {
            uses: result.value.uses, usesTruncated: !!result.value.usesTruncated,
            usedBy: result.value.usedBy, usedByTruncated: !!result.value.usedByTruncated
          }
        }
      })
    }).catch(onUnexpectedError)
  }

  private loadPreviewRows(id: string): void {
    const state = this.get(id)
    if (!state || (state.preview && state.preview.status !== 'error')) return
    const connectionId = this.connectionOf(id)
    if (!connectionId || !this.live(id)) {
      this.patch(id, { preview: { status: 'error', message: peekMessages.notConnected } })
      return
    }
    const { results, api } = this.options
    const { database, schema, name } = state.target
    if (!results || !api.tableColumns || !api.execute || database === undefined || schema === undefined || name === undefined) {
      this.patch(id, { preview: { status: 'error', message: peekMessages.rowsUnavailable } })
      return
    }
    this.releasePreview(id)
    const run: PreviewRun = { key: this.newId(), queryId: this.newId(), session: false }
    this.previewRuns.set(id, run)
    this.patch(id, { preview: { status: 'loading' } })
    results.begin(run.key, run.queryId, undefined, { bare: true })
    void (async () => {
      const columns = await this.call(() => api.tableColumns!(connectionId, database, schema, name))
      if (this.previewRuns.get(id) !== run || this.disposed) return
      if (this.connectionOf(id) !== connectionId || !this.live(id)) {
        this.releasePreview(id)
        this.patch(id, { preview: { status: 'error', message: peekMessages.notConnected } })
        return
      }
      const listed = columns.ok ? columns.value : { columns: [], truncated: true }
      const sql = selectTopRowsScript({ database, schema, name, columns: listed.columns, truncated: listed.truncated }, peekLimits.rows)
      run.session = true
      const response = await this.call(() => api.execute!({
        connectionId, sessionId: run.key, database, sql, queryId: run.queryId, maxRows: peekLimits.rows,
        timeoutSeconds: Math.ceil(peekLimits.budgetMs / 1000), maxResultSets: 1
      }))
      this.endPreviewSession(run)
      const summary = response.ok ? response.value : undefined
      await results.finish(run.key, run.queryId, response.ok ? { summary } : { error: response.error, ...(response.code ? { code: response.code } : {}) })
      if (this.previewRuns.get(id) !== run || this.disposed) return
      if (this.connectionOf(id) !== connectionId || !this.live(id)) {
        this.releasePreview(id)
        this.patch(id, { preview: { status: 'error', message: peekMessages.notConnected } })
        return
      }
      if (summary?.resultSets.length) {
        this.patch(id, { preview: { status: 'ready', value: { key: run.key } } })
        return
      }
      this.releasePreview(id)
      const message = !response.ok ? response.error : summary?.error?.message ?? summary?.messages.find(entry => entry.kind === 'error')?.text ?? peekMessages.noResult
      this.patch(id, { preview: { status: 'error', message } })
    })().catch(onUnexpectedError)
  }

  private invalidateDefinition(id: string): void {
    const lazy = this.lazyRequests.get(id)
    if (lazy?.definition) {
      const requestId = lazy.definition
      delete lazy.definition
      this.cancelScript([requestId])
    }
    if (this.get(id)?.definition !== undefined) this.patch(id, { definition: undefined })
  }

  private resetLazyTabs(id: string, reloadActive: boolean): void {
    this.cancelLazyRequests(id)
    this.releasePreview(id)
    this.patch(id, { definition: undefined, catalog: undefined, dependencies: undefined, preview: undefined })
    const state = this.get(id)
    if (reloadActive && state && isLazyTab(state.activeTab)) this.ensureTabLoaded(id, state.activeTab)
  }

  private scriptingOptionsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (state.definition === undefined) continue
      this.invalidateDefinition(state.id)
      if (state.activeTab === 'definition' && this.live(state.id)) this.loadDefinition(state.id)
    }
  }

  private cancelLazyRequests(id: string): void {
    const lazy = this.lazyRequests.get(id)
    if (!lazy) return
    this.lazyRequests.delete(id)
    const explorer = [lazy.catalog, lazy.dependencies].filter((value): value is string => !!value)
    if (explorer.length) this.cancelExplorer(explorer)
    if (lazy.definition) this.cancelScript([lazy.definition])
  }

  private releasePreview(id: string): void {
    const run = this.previewRuns.get(id)
    if (!run) return
    this.previewRuns.delete(id)
    this.endPreviewSession(run)
    try { this.options.results?.release(run.key) } catch (failure) { onUnexpectedError(failure) }
  }

  private endPreviewSession(run: PreviewRun): void {
    if (!run.session) return
    run.session = false
    if (this.options.api.closeQuerySession) void this.options.api.closeQuerySession(run.key).catch(() => {})
  }

  private cancelExplorer(ids: readonly string[]): void {
    const cancel = this.options.api.explorerCancel
    if (!cancel || !ids.length) return
    try { void cancel(ids).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
  }

  private cancelScript(ids: readonly string[]): void {
    const cancel = this.options.api.cancelScripting
    if (!cancel || !ids.length) return
    try { void cancel(ids).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
  }

  // --- Internals -----------------------------------------------------------------------------------------------------

  private show(id: string): void { if (this.options.documents.getSnapshot().activeId !== id) this.options.documents.activate(id) }
  private patch(id: string, patch: Partial<TablePropertiesState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as TablePropertiesState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: TablePropertiesState): void {
    this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } })
    this.publishContext()
  }
  private publishContext(): void {
    const byDocument: Record<string, PropertiesKeys> = {}
    for (const state of Object.values(this.getSnapshot().documents)) {
      byDocument[state.id] = { changed: state.changed, applicable: this.canApply(state.id), applying: state.phase === 'applying', refreshable: this.canRefresh(state.id) }
    }
    const current = this.contextStore.getSnapshot().byDocument
    const same = Object.keys(byDocument).length === Object.keys(current).length && Object.entries(byDocument).every(([id, keys]) => {
      const was = current[id]
      return !!was && was.changed === keys.changed && was.applicable === keys.applicable && was.applying === keys.applying && was.refreshable === keys.refreshable
    })
    if (!same) this.contextStore.set({ byDocument })
  }
  private rebind(id: string, connection: LiveConnection, tab?: TableInspectorTabId): void {
    this.options.documents.update(id, { connectionId: connection.id })
    const state = this.get(id)
    if (!state) return
    const nextTab = tab && isTableInspectorTab(tab) ? tab : state.activeTab
    this.patch(id, {
      login: connection.login,
      ...(nextTab !== state.activeTab || state.frame.section !== nextTab ? { activeTab: nextTab, frame: { ...state.frame, section: nextTab } } : {}),
      ...!state.stale && state.error?.code === 'CONNECTION_LOST' ? { error: undefined } : {}
    })
    this.options.documents.activate(id)
    if (this.canRefresh(id)) this.refresh(id)
    else if (isLazyTab(nextTab)) this.ensureTabLoaded(id, nextTab)
  }
  private connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
  private live(id: string): boolean {
    const connectionId = this.connectionOf(id)
    return this.targetBindings.matchesConnection(id, connectionId) && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }
  private begin(id: string, kind: 'describe' | 'apply'): string {
    const requestId = this.newId()
    this.requests.set(id, { id: requestId, kind, connectionId: this.connectionOf(id), dropped: false })
    return requestId
  }
  private end(id: string, requestId: string): boolean {
    const request = this.requests.get(id)
    if (request?.id === requestId) this.requests.delete(id)
    return !this.disposed && !!this.get(id) && request?.id === requestId && !request.dropped && request.connectionId === this.connectionOf(id) && this.live(id)
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
  }
  private connectionsChanged(): void {
    const gone = <T>(part: PeekPart<T> | undefined): PeekPart<T> | undefined => part && part.status === 'loading' ? { status: 'error', message: peekMessages.notConnected } : part
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (this.live(state.id)) continue
      this.cancelLazyRequests(state.id)
      this.releasePreview(state.id)
      const lazyPatch: Partial<TablePropertiesState> = {
        ...(state.definition?.status === 'loading' ? { definition: gone(state.definition) } : {}),
        ...(state.catalog?.status === 'loading' ? { catalog: gone(state.catalog) } : {}),
        ...(state.dependencies?.status === 'loading' ? { dependencies: gone(state.dependencies) } : {}),
        ...(state.preview && (state.preview.status !== 'error' || state.preview.message !== peekMessages.notConnected) ? { preview: { status: 'error', message: peekMessages.notConnected } } : {})
      }
      if (Object.keys(lazyPatch).length > 0) this.patch(state.id, lazyPatch)
      const request = this.requests.get(state.id), preview = this.previews.get(state.id)
      if (preview) { this.previews.delete(state.id); this.cancel([preview]); this.patch(state.id, { script: { state: 'failed', error: { message: tablePropertiesMessages.disconnected, code: 'CONNECTION_LOST' } } }) }
      if (state.phase === 'confirming') this.patch(state.id, { phase: 'ready' })
      if (!request || request.dropped) continue
      request.dropped = true
      this.requests.delete(state.id)
      this.cancel([request.id])
      if (request.kind === 'apply') this.patch(state.id, { phase: 'ready', stale: true, error: error('CONNECTION_LOST', tablePropertiesMessages.connectionLost) })
      else this.patch(state.id, { phase: state.model ? 'ready' : 'loadFailed', error: error('CONNECTION_LOST', tablePropertiesMessages.disconnected), ...state.model ? { stale: true } : {} })
    }
    this.publishContext()
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}

type LazyTab = 'definition' | 'columns' | 'indexes' | 'dependencies' | 'preview'
const isLazyTab = (tab: TableInspectorTabId): tab is LazyTab =>
  tab === 'definition' || tab === 'columns' || tab === 'indexes' || tab === 'dependencies' || tab === 'preview'
