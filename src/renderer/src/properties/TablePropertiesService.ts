import { actionLimits, dialogSpecs, dialogTitle } from '../../../shared/actions/catalog.ts'
import { noScriptNotice } from '../../../shared/actions/database.ts'
import type { ActionError, ActionExecuteResult, ActionRequest, ActionStep } from '../../../shared/actions/schema.ts'
import type { TablePropertiesModel } from '../../../shared/actions/tables.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { addPropertyRow, initialTableDraft, patchPropertyRow, tableChanged, tableConfirmation, tableErrors, tableRequest, type ExtendedPropertyRow, type TableDraft } from '../dialogs/table-properties'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { PropertiesContextState, PropertiesKeys } from '../core/contextkeys'
import type { Disposable, ExternalStore } from '../core/types'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { ScriptContent } from '../kit/ScriptDrawer'
import type { ExplorerMenuNode } from '../menus/targets'
import { deliverScript, type DeliverScriptDeps } from '../scripting/deliver'
import { scriptFileName, scriptObjectLabel } from '../scripting/ScriptingService'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import { previewDelayMs, type PropertiesPhase } from './DatabasePropertiesService'

export interface TablePropertiesState {
  readonly id: string
  readonly target: ObjectRef
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
  readonly script: ScriptContent
  readonly scriptRevision?: number
  readonly scriptDatabase?: string
  readonly scriptNotice?: string
}
export interface TablePropertiesSnapshot { readonly documents: Readonly<Record<string, TablePropertiesState>> }

export interface TablePropertiesServiceOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText' | 'confirmAction'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'update' | 'setDirty' | 'activate' | 'getSnapshot' | 'subscribe'> & DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly focus?: (id: string) => void
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
const sections = dialogSpecs.tableProperties.pages
const error = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: true })

/**
 * Table Properties as a document: one tab per table and connection, SSMS's pages as sections. Apply runs only what changed, in
 * one transaction (the backend's), after a native question when it turns change tracking off; a failure or Stop rolls it all
 * back, so nothing is left half done unless the outcome itself is unknown. Then it reads the table again. The Script drawer
 * previews the script. It is the DocumentService's provider for 'tableProperties' documents: Save applies.
 */
export class TablePropertiesService extends SnapshotStore<TablePropertiesSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'tableProperties' as const
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly timers: Timers
  private readonly registration: Disposable
  private readonly unsubscribe: (() => void)[]
  private readonly contextStore = new (class extends SnapshotStore<PropertiesContextState> { set(value: PropertiesContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {} })
  private readonly requests = new Map<string, { readonly id: string; readonly kind: 'describe' | 'apply'; dropped: boolean }>()
  private readonly previews = new Map<string, string>()
  private readonly previewTimers = new Map<string, unknown>()
  private readonly applies = new Map<string, Promise<boolean>>()
  private rows = 0
  private disposed = false

  constructor(private readonly options: TablePropertiesServiceOptions) {
    super({ documents: {} })
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.registration = options.documents.registerProvider(this)
    this.unsubscribe = [
      options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } }),
      options.documents.subscribe(() => { try { this.publishContext() } catch (failure) { onUnexpectedError(failure) } })
    ]
  }

  get context(): ExternalStore<PropertiesContextState> { return this.contextStore }
  get(id: string): TablePropertiesState | undefined { return this.getSnapshot().documents[id] }

  /** Properties on a table node: its document comes forward if open, otherwise a tab opens at once, loading. */
  open(node: ExplorerMenuNode): string {
    if (this.disposed) throw new Error('Table Properties is not available.')
    const target = node.ref.type === 'object' && node.ref.object.kind === 'table' ? node.ref.object : undefined
    const connection = this.options.connections.getSnapshot().find(item => item.id === node.connectionId && !item.lost)
    if (!target) throw new Error('Select a table in Object Explorer.')
    if (!connection) throw new Error('Connect to the server first.')
    const same = (state: TablePropertiesState) => state.target.database === target.database && state.target.schema === target.schema && state.target.name === target.name
    const documents = Object.values(this.getSnapshot().documents).filter(same)
    const existing = documents.find(state => this.connectionOf(state.id) === node.connectionId)
    if (existing) { this.options.documents.activate(existing.id); return existing.id }
    const orphan = documents.find(state => !this.live(state.id) && this.follows(state.id, connection.server))
    if (orphan) { this.rebind(orphan.id, connection); return orphan.id }
    const label = scriptObjectLabel(target)
    const document = this.options.documents.openCustom('tableProperties', dialogTitle('tableProperties', label), connection.id, target.database ?? 'master')
    this.put({
      id: document.id, target, label, server: connection.server, ...connection.login ? { login: connection.login } : {},
      phase: 'loading', revision: 0, edits: 0, changed: false, stale: false, frame: initialFrameState(sections), script: { state: 'idle', message: noScriptNotice }
    })
    void this.describe(document.id)
    return document.id
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
    this.patch(id, { frame })
    if (opened) this.schedulePreview(id, 0)
  }
  errors(id: string): Map<string, string> {
    const state = this.get(id)
    return state?.model && state.draft ? tableErrors(state.model, state.draft) : new Map()
  }

  // --- Reading -------------------------------------------------------------------------------------------------------

  refresh(id: string): void {
    if (!this.canRefresh(id)) return
    this.patch(id, { phase: 'loading', error: undefined, notice: undefined, steps: undefined })
    void this.describe(id)
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
    this.patch(id, {
      phase: 'ready', model, draft: initialTableDraft(model), changed: false, stale: false, revision: current.revision + 1, error: undefined,
      ...notice ? { notice } : {}, script: { state: 'idle', message: noScriptNotice }, scriptRevision: undefined
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
    state = this.get(id)!
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    if (value && !value.error) {
      this.patch(id, { phase: 'loading', steps: value.steps, changed: false })
      this.options.documents.setDirty(id, false)
      await this.describe(id, tablePropertiesMessages.applied)
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
    if (this.disposed || !this.get(id)) return undefined
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
  follows(id: string, server: string): boolean { const state = this.get(id); return !!state && state.server.trim().toLowerCase() === server.trim().toLowerCase() }
  closed(id: string): void {
    const request = this.requests.get(id), preview = this.previews.get(id)
    this.cancel([request?.id, preview].filter((value): value is string => !!value))
    this.requests.delete(id)
    this.previews.delete(id)
    this.clearPreviewTimer(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
    this.publishContext()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel([...this.requests.values()].map(request => request.id).concat([...this.previews.values()]))
    for (const timer of this.previewTimers.values()) this.timers.clearTimeout(timer)
    this.requests.clear()
    this.previews.clear()
    this.previewTimers.clear()
    this.registration.dispose()
    this.unsubscribe.forEach(unsubscribe => unsubscribe())
    this.clearListeners()
    this.contextStore.clear()
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
  private rebind(id: string, connection: LiveConnection): void {
    this.options.documents.update(id, { connectionId: connection.id })
    const state = this.get(id)
    if (!state) return
    this.patch(id, { login: connection.login, ...!state.stale && state.error?.code === 'CONNECTION_LOST' ? { error: undefined } : {} })
    this.options.documents.activate(id)
    if (this.canRefresh(id)) this.refresh(id)
  }
  private connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
  private live(id: string): boolean {
    const connectionId = this.connectionOf(id)
    return !!connectionId && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }
  private begin(id: string, kind: 'describe' | 'apply'): string {
    const requestId = this.newId()
    this.requests.set(id, { id: requestId, kind, dropped: false })
    return requestId
  }
  private end(id: string, requestId: string): boolean {
    const request = this.requests.get(id)
    if (request?.id === requestId) this.requests.delete(id)
    return !this.disposed && !!this.get(id) && request?.id === requestId && !request.dropped
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
  }
  private connectionsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (this.live(state.id)) continue
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
