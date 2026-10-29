import { actionLimits, dialogSpecs, dialogTitle } from '../../../shared/actions/catalog.ts'
import { noScriptNotice } from '../../../shared/actions/database.ts'
import type { ActionError, ActionExecuteResult, ActionRequest, ActionStep, DatabasePropertiesModel } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { databaseChanged, draftErrors, settledDraft, type DatabaseDraft } from '../dialogs/database-properties'
import { databasePropertiesDefinition, type BuiltRequest } from '../dialogs/definitions'
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

/**
 * loading → ready, or loadFailed; Apply: ready → (confirming →) applying → loading (read again) → ready. A failure, Stop
 * or a lost server leaves it ready with the error; Refresh reads the database again.
 */
export type PropertiesPhase = 'loading' | 'ready' | 'loadFailed' | 'confirming' | 'applying'
export interface PropertiesState {
  /** The document's id. */
  readonly id: string
  readonly target: ObjectRef
  /** The database as Object Explorer shows it. */
  readonly label: string
  /** The server as connected to, and the login, for the header's location. */
  readonly server: string
  readonly login?: string
  /** The Databases folder it was opened from, which Apply reloads (its sublabels show Read-Only and Single User). */
  readonly listingFolder?: number
  readonly phase: PropertiesPhase
  readonly model?: DatabasePropertiesModel
  readonly draft?: DatabaseDraft
  /** Moves with every draft change, a read included: which draft the Script preview shows. */
  readonly revision: number
  /**
   * Moves only with the person's edits (and Discard Changes): the revision the close prompt and a window close compare, so
   * a read that completes meanwhile is not taken for a change nobody has seen.
   */
  readonly edits: number
  /** The draft differs from what the database has. */
  readonly changed: boolean
  /** Whether the last Apply completed is unknown (the server or backend went, or Stop got no answer): Apply waits for a Refresh. */
  readonly stale: boolean
  readonly error?: ActionError
  /** An info line: the changes applied, a script delivered. */
  readonly notice?: string
  readonly steps?: readonly ActionStep[]
  readonly frame: FrameState
  /** What the Script drawer shows, and the revision it was made for. */
  readonly script: ScriptContent
  readonly scriptRevision?: number
  /** The database a new query window opens the script in (the backend's answer: master for database actions). */
  readonly scriptDatabase?: string
  readonly scriptNotice?: string
}
export interface PropertiesSnapshot { readonly documents: Readonly<Record<string, PropertiesState>> }

export interface DatabasePropertiesServiceOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText' | 'confirmOpenConnections'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'update' | 'setDirty' | 'activate' | 'getSnapshot' | 'subscribe'> & DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly explorer: { listingFolderOf(nodeId: number): number | undefined; reconcile(nodeId: number): void }
  readonly focusEditor?: () => void
  /** Focuses a document's view (the app's DOM); tests leave it out. */
  readonly focus?: (id: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
}

export const propertiesMessages = {
  applied: 'The changes were applied.',
  disconnected: 'The server was disconnected. Reconnect, or connect to it again and choose Properties on this database, to read it again.',
  // Whether an Apply ran is unknown: the fields lock and Refresh waits for a clean draft, so the way out is Discard Changes, then Refresh.
  /** Stop, when the backend could not confirm in time that SQL Server ended the statement. */
  stopped: 'The changes were stopped, but SQL Server did not confirm it in time, so whether they were applied is unknown. Discard Changes, then Refresh to read the database again.',
  stale: 'Whether the last changes were applied is unknown. Discard Changes, then Refresh to read the database again before applying more.',
  /** The server's connection went while the changes were being applied. */
  connectionLost: 'The server was disconnected while the changes were being applied, so whether they were applied is unknown. Reconnect, or connect to it again and choose Properties on this database, then Discard Changes and Refresh.',
  backendLost: 'The SQL backend stopped while the changes were being applied, so whether they were applied is unknown. Discard Changes, then Refresh to read the database again.',
  /** Apply ran, but reading the database again failed: said before the read's error, so the Apply is never taken for a failure. */
  appliedUnread: 'The changes were applied, but the database could not be read again:',
  applying: 'The changes are being applied. Stop them, or wait for them to finish.',
  readFailed: 'The database could not be read.'
} as const
/** How long the Script preview waits after the last edit before it asks the backend, so typing sends one request. */
export const previewDelayMs = 300
const sections = dialogSpecs.databaseProperties.pages
const error = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: true })
const definition = databasePropertiesDefinition

/**
 * Database Properties as a document (U1 D2): one non-modal tab per database and connection, its pages as sections. The
 * draft and every request live here, so the tab can be switched away from and back; the view only renders it. Apply is
 * SSMS's OK that keeps the document open: it runs only what changed (after SSMS's Open Connections question when it
 * applies), then reads the database again. The Script drawer previews that script while it is open. It is the
 * DocumentService's provider for 'databaseProperties' documents: Save (Ctrl+S, the close prompt) applies. Failures are
 * values in the snapshot; nothing throws into React.
 */
export class DatabasePropertiesService extends SnapshotStore<PropertiesSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'databaseProperties' as const
  /** Save All leaves it out: Apply is DDL on the server, run only from its own document, where its Stop is. */
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly timers: Timers
  private readonly registration: Disposable
  private readonly unsubscribe: (() => void)[]
  private readonly contextStore = new (class extends SnapshotStore<PropertiesContextState> { set(value: PropertiesContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {} })
  /** Each document's request in flight (describe or apply), so Stop, a close and a disconnect can cancel it. */
  private readonly requests = new Map<string, { readonly id: string; readonly kind: 'describe' | 'apply'; dropped: boolean }>()
  /** Each document's Script preview request, apart from the others: a preview never holds Apply back. */
  private readonly previews = new Map<string, string>()
  private readonly previewTimers = new Map<string, unknown>()
  /** Each preview in flight by its request id, so one that a newer preview replaces can resolve to the newer one's script. */
  private readonly previewRuns = new Map<string, Promise<string | undefined>>()
  private readonly applies = new Map<string, Promise<boolean>>()
  private disposed = false

  constructor(private readonly options: DatabasePropertiesServiceOptions) {
    super({ documents: {} })
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.registration = options.documents.registerProvider(this)
    this.unsubscribe = [
      options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } }),
      // A reconnect moves a document to the new connection (TargetService.retarget), which can make Apply and Refresh possible again.
      options.documents.subscribe(() => { try { this.publishContext() } catch (failure) { onUnexpectedError(failure) } })
    ]
  }

  get context(): ExternalStore<PropertiesContextState> { return this.contextStore }
  get(id: string): PropertiesState | undefined { return this.getSnapshot().documents[id] }

  /** Properties on a database node: its document comes forward if open, otherwise a tab opens at once, loading. */
  open(node: ExplorerMenuNode): string {
    if (this.disposed) throw new Error('Database Properties is not available.')
    const target = node.ref.type === 'object' && node.ref.object.kind === 'database' ? node.ref.object : undefined
    const connection = this.options.connections.getSnapshot().find(item => item.id === node.connectionId && !item.lost)
    if (!target) throw new Error('Select a database in Object Explorer.')
    if (!connection) throw new Error('Connect to the server first.')
    const documents = Object.values(this.getSnapshot().documents).filter(state => state.target.name === target.name)
    const existing = documents.find(state => this.connectionOf(state.id) === node.connectionId)
    if (existing) { this.options.documents.activate(existing.id); return existing.id }
    // A document whose server was disconnected (or lost) is the one Properties on that database brings back, moved to the
    // new connection: connecting again makes a new connection, and nothing else would ever move it there.
    const orphan = documents.find(state => !this.live(state.id) && this.follows(state.id, connection.server))
    if (orphan) { this.rebind(orphan.id, connection); return orphan.id }
    const label = scriptObjectLabel(target)
    const document = this.options.documents.openCustom('databaseProperties', dialogTitle('databaseProperties', label), connection.id, target.name ?? 'master')
    const listingFolder = this.options.explorer.listingFolderOf(node.id)
    this.put({
      id: document.id, target, label, server: connection.server, ...connection.login ? { login: connection.login } : {}, ...listingFolder === undefined ? {} : { listingFolder },
      phase: 'loading', revision: 0, edits: 0, changed: false, stale: false, frame: initialFrameState(sections), script: { state: 'idle', message: noScriptNotice }
    })
    void this.describe(document.id)
    return document.id
  }

  // --- Editing -------------------------------------------------------------------------------------------------------

  /** Whether the fields take edits now: loaded, nothing running, not waiting for a Refresh, a database that can change. */
  canEdit(id: string): boolean {
    const state = this.get(id)
    return !!state?.model && !!state.draft && state.phase === 'ready' && !state.stale && !state.model.readOnlyReason
  }
  updateDraft(id: string, patch: Partial<DatabaseDraft>): void {
    const state = this.get(id)
    if (!state?.model || !state.draft || !this.canEdit(id)) return
    const draft = settledDraft(state.model, { ...state.draft, ...patch }, state.target), changed = databaseChanged(state.model, draft)
    this.patch(id, { draft, changed, revision: state.revision + 1, edits: state.edits + 1, notice: undefined, ...state.error?.code === 'NOT_SUPPORTED' ? { error: undefined } : {} })
    this.options.documents.setDirty(id, changed)
    this.schedulePreview(id)
  }
  canDiscard(id: string): boolean {
    const state = this.get(id)
    return !!state?.model && !!state.draft && state.changed && state.phase !== 'applying' && state.phase !== 'confirming'
  }
  /**
   * Discard Changes: the draft goes back to what was read. While the last outcome is unknown, or the database read is gone
   * from its name, its message stays, since Refresh is still to come.
   */
  discard(id: string): void {
    const state = this.get(id)
    if (!state?.model || !state.draft || state.phase === 'applying' || state.phase === 'confirming') return
    this.patch(id, { draft: definition.initialDraft(state.model, state.target), changed: false, revision: state.revision + 1, edits: state.edits + 1, ...state.stale || state.error?.code === 'NOT_FOUND' ? {} : { error: undefined }, notice: undefined, steps: undefined })
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

  // --- Reading -------------------------------------------------------------------------------------------------------

  /** Refresh: reads the database again; refused while something runs or the draft has changes (Discard them first). */
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
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'databaseProperties', target: state.target }))
    if (!this.end(id, requestId)) return
    const failure = !result.ok ? error('SQL_ERROR', result.error) : result.value.error
    const model = result.ok ? definition.modelOf(result.value) : undefined
    if (failure || !model) {
      // A document that had loaded keeps what it showed, read-only until a Refresh succeeds. After an Apply (`notice`), the
      // message says first that the changes ran, so a read that fails is not taken for an Apply that failed.
      const shown = failure ?? error('NOT_FOUND', propertiesMessages.readFailed)
      this.patch(id, { phase: this.get(id)?.model ? 'ready' : 'loadFailed', error: notice ? { ...shown, message: `${propertiesMessages.appliedUnread} ${shown.message}` } : shown, ...this.get(id)?.model ? { stale: true } : {} })
      return
    }
    const current = this.get(id)!
    this.patch(id, {
      phase: 'ready', model, draft: definition.initialDraft(model, current.target), changed: false, stale: false, revision: current.revision + 1, error: undefined,
      ...notice ? { notice } : {}, script: { state: 'idle', message: noScriptNotice }, scriptRevision: undefined
    })
    this.options.documents.setDirty(id, false)
    this.schedulePreview(id, 0)
  }

  // --- Apply, Stop ---------------------------------------------------------------------------------------------------

  /** Whether Apply can run now: loaded with changes, nothing running, not stale, its server connected. */
  canApply(id: string): boolean {
    const state = this.get(id)
    return !!state && state.phase === 'ready' && state.changed && !state.stale && this.live(id) && !state.model?.readOnlyReason
  }
  /** Apply (and File › Save, the close prompt's Save): one at a time per document; resolves true once the changes ran. */
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
    if (state.stale) { this.patch(id, { error: error('CONNECTION_LOST', propertiesMessages.stale) }); this.show(id); return false }
    if (!this.live(id)) { this.patch(id, { error: error('CONNECTION_LOST', propertiesMessages.disconnected) }); this.show(id); return false }
    if (state.phase !== 'ready') return false
    let built: BuiltRequest | undefined | { readonly problem: string } = definition.request(state.target, state.model, state.draft)
    if (!built) return true
    if ('problem' in built) { this.patch(id, { error: error('NOT_SUPPORTED', built.problem) }); this.show(id); return false }
    const confirmation = definition.confirm?.(state.model, built)
    if (confirmation) {
      // Main's message box; a failure, a close or a lost server meanwhile counts as No, and No sends nothing.
      this.patch(id, { phase: 'confirming', error: undefined, notice: undefined })
      this.show(id)
      const answer = await this.call(() => this.options.api.confirmOpenConnections())
      if (this.disposed || this.get(id)?.phase !== 'confirming') return false
      if (!answer.ok || !answer.value || !this.live(id)) { this.patch(id, { phase: 'ready' }); return false }
      built = definition.withConfirmation?.(built, confirmation) ?? built
    }
    const connectionId = this.connectionOf(id)!
    const revision = this.get(id)!.revision
    const requestId = this.begin(id, 'apply'), request = this.requests.get(id)
    this.patch(id, { phase: 'applying', error: undefined, notice: undefined, steps: undefined })
    const result = await this.call(() => this.options.api.executeObjectAction({ ...built, connectionId, requestId } as ActionRequest))
    if (this.requests.get(id)?.id === requestId) this.requests.delete(id)
    this.publishContext()
    // A disconnect while it ran has already said that the outcome is unknown.
    if (this.disposed || !this.get(id) || request?.dropped) return false
    state = this.get(id)!
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    if (value && !value.error) {
      this.refreshListing(state)
      // The draft is what the database now has; reading it again replaces the model.
      this.patch(id, { phase: 'loading', steps: value.steps, changed: false })
      this.options.documents.setDirty(id, false)
      await this.describe(id, propertiesMessages.applied)
      return true
    }
    // Steps that completed before a failure or Stop changed the database, so the listing shows what is there now.
    const partial = !!value?.steps.some(step => step.status === 'done')
    if (partial) this.refreshListing(state)
    if (value?.error?.code === 'CANCELLED') { this.patch(id, { phase: 'ready', error: value.error, steps: value.steps, ...partial ? { stale: true } : {} }); return false }
    if (!result.ok && result.code === 'CANCELLED') { this.patch(id, { phase: 'ready', stale: true, error: error('CANCELLED', propertiesMessages.stopped) }); return false }
    const lost = !result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST')
    const lostMessage = !result.ok && result.code === 'BACKEND_LOST' ? propertiesMessages.backendLost : propertiesMessages.connectionLost
    const failure = value?.error ?? (lost ? error('CONNECTION_LOST', lostMessage) : error('SQL_ERROR', result.ok ? 'The changes could not be applied.' : result.error))
    const model = definition.afterFailure?.(state.model!, failure) ?? state.model!
    this.patch(id, { phase: 'ready', error: failure, model, ...value ? { steps: value.steps } : {}, ...partial || lost ? { stale: true } : {} })
    this.show(id)
    // SSMS counts other connections when OK is pressed: when nothing ran and the fresh model needs the question this Apply
    // did not ask, it is asked at once rather than on the next Apply.
    if (!confirmation && model !== state.model && !partial && revision === this.get(id)?.revision) {
      const again = definition.request(state.target, model, state.draft!)
      if (again && !('problem' in again) && definition.confirm?.(model, again)) return this.runApply(id)
    }
    return false
  }
  /** Stop: cancels the running Apply in SQL Server; the document says what completed when the answer comes. */
  stop(id: string): void {
    const request = this.requests.get(id)
    if (request?.kind === 'apply') this.cancel([request.id])
  }

  // --- Script ----------------------------------------------------------------------------------------------------------

  /**
   * One of the drawer's ways out: the whole script of the current changes, made again if the preview is behind. Its own
   * script stands for the latest edit, so the preview that edit scheduled is not sent too; a preview a later edit starts
   * meanwhile replaces it, and the delivery takes that one's script. When none comes, the drawer says why.
   */
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
      const notice = await deliverScript({ destination, text, database: this.get(id)?.scriptDatabase ?? 'master', connectionId, fileName: scriptFileName(current.target) }, this.options)
      this.patch(id, { scriptNotice: notice })
    } catch (failure) { this.patch(id, { scriptNotice: failure instanceof Error ? failure.message : 'The script could not be delivered.' }) }
  }
  private schedulePreview(id: string, delay = previewDelayMs): void {
    const state = this.get(id)
    if (!state?.frame.scriptOpen || state.scriptRevision === state.revision && state.script.state !== 'failed') return
    const pending = this.previewTimers.get(id)
    if (pending !== undefined) this.timers.clearTimeout(pending)
    this.previewTimers.set(id, this.timers.setTimeout(() => { this.previewTimers.delete(id); void this.preview(id) }, delay))
  }
  private clearPreviewTimer(id: string): void {
    const pending = this.previewTimers.get(id)
    if (pending !== undefined) this.timers.clearTimeout(pending)
    this.previewTimers.delete(id)
  }
  /** The drawer's script when it is the current draft's. */
  private currentScript(id: string): string | undefined {
    const state = this.get(id)
    return state?.script.state === 'ready' && state.scriptRevision === state.revision ? state.script.text : undefined
  }
  /**
   * Scripts the current draft into the drawer; resolves to its text, or undefined when there is none. A preview that a
   * newer one replaces resolves to the newer one's text, so a delivery waiting on it gets the latest script.
   */
  private preview(id: string): Promise<string | undefined> {
    const started: { requestId?: string } = {}
    const run = this.runPreview(id, started)
    const requestId = started.requestId
    if (requestId) {
      this.previewRuns.set(requestId, run)
      const forget = () => { this.previewRuns.delete(requestId) }
      void run.then(forget, forget)
    }
    return run
  }
  private async runPreview(id: string, started: { requestId?: string }): Promise<string | undefined> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state?.model || !state.draft || !connectionId) return undefined
    const revision = state.revision
    const built = definition.request(state.target, state.model, state.draft)
    if (!built) { this.patch(id, { script: { state: 'idle', message: noScriptNotice }, scriptRevision: revision }); return undefined }
    if ('problem' in built) { this.patch(id, { script: { state: 'idle', message: built.problem }, scriptRevision: revision }); return undefined }
    if (!this.live(id)) { this.patch(id, { script: { state: 'failed', error: { message: propertiesMessages.disconnected, code: 'CONNECTION_LOST' } }, scriptRevision: revision }); return undefined }
    const previous = this.previews.get(id)
    if (previous) this.cancel([previous])
    const requestId = started.requestId = this.newId()
    this.previews.set(id, requestId)
    this.patch(id, { script: { state: 'loading' } })
    const result = await this.call(() => this.options.api.scriptObjectAction({ ...built, connectionId, requestId } as ActionRequest))
    const newer = this.previews.get(id)
    // Replaced by a newer preview: its script, once it comes. None in flight: the drawer's script if a newer one has come
    // and is current, otherwise nothing (a close or a disconnect dropped it).
    if (newer !== requestId) return newer ? this.previewRuns.get(newer) ?? undefined : this.currentScript(id)
    this.previews.delete(id)
    if (this.disposed || !this.get(id)) return undefined
    const failure = !result.ok ? { message: result.error, ...result.code ? { code: result.code } : {} } : result.value.error ? { message: result.value.error.message, code: result.value.error.code } : undefined
    const text = result.ok ? result.value.text : undefined
    if (failure || text === undefined) { this.patch(id, { script: { state: 'failed', error: failure ?? { message: 'No script was produced.' } }, scriptRevision: revision }); return undefined }
    this.patch(id, { script: { state: 'ready', text }, scriptRevision: revision, scriptDatabase: result.ok ? result.value.database : undefined })
    // Edits while it ran: the preview catches up.
    if (this.get(id)?.revision !== revision) this.schedulePreview(id)
    return text
  }

  // --- CustomDocumentProvider ----------------------------------------------------------------------------------------

  /** File › Save and the close prompt's Save: the document comes forward first, so its progress and Stop show while it applies. */
  save(id: string): Promise<boolean> { this.show(id); return this.apply(id) }
  canClose(id: string): string | undefined { const phase = this.get(id)?.phase; return phase === 'applying' || phase === 'confirming' ? propertiesMessages.applying : undefined }
  revision(id: string): number { return this.get(id)?.edits ?? 0 }
  focus(id: string): void { this.options.focus?.(id) }
  /** A document stays with its server, as its title names it: a reconnect moves it only to a connection to that server. */
  follows(id: string, server: string): boolean { const state = this.get(id); return !!state && state.server.trim().toLowerCase() === server.trim().toLowerCase() }
  closed(id: string): void {
    const request = this.requests.get(id), preview = this.previews.get(id), timer = this.previewTimers.get(id)
    this.cancel([request?.id, preview].filter((value): value is string => !!value))
    this.requests.delete(id)
    this.previews.delete(id)
    if (timer !== undefined) this.timers.clearTimeout(timer)
    this.previewTimers.delete(id)
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

  /** The fields' problems by option key ('owner' for the owner), which also mark their sections in the list. */
  errors(id: string): Map<string, string> {
    const state = this.get(id)
    return state?.model && state.draft ? draftErrors(state.model, state.draft, state.target) : new Map()
  }
  private refreshListing(state: PropertiesState): void {
    if (state.listingFolder === undefined) return
    try { this.options.explorer.reconcile(state.listingFolder) } catch (failure) { onUnexpectedError(failure) }
  }
  /** Only the active document renders: a close prompt's Save applies in the background, and one that needs the person comes forward. */
  private show(id: string): void { if (this.options.documents.getSnapshot().activeId !== id) this.options.documents.activate(id) }
  private patch(id: string, patch: Partial<PropertiesState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as PropertiesState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: PropertiesState): void {
    this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } })
    this.publishContext()
  }
  private publishContext(): void {
    const byDocument: Record<string, PropertiesKeys> = {}
    for (const state of Object.values(this.getSnapshot().documents)) {
      byDocument[state.id] = { changed: state.changed, applicable: this.canApply(state.id), applying: state.phase === 'applying', refreshable: this.canRefresh(state.id) }
    }
    // Only a change reaches the context keys: every document change (a dirty mark, a tab switch) comes through here.
    const current = this.contextStore.getSnapshot().byDocument
    const same = Object.keys(byDocument).length === Object.keys(current).length && Object.entries(byDocument).every(([id, keys]) => {
      const was = current[id]
      return !!was && was.changed === keys.changed && was.applicable === keys.applicable && was.applying === keys.applying && was.refreshable === keys.refreshable
    })
    if (!same) this.contextStore.set({ byDocument })
  }
  /**
   * Moves a document whose connection went to a new connection to its server, and brings it forward. A clean one reads
   * the database again, as Properties always shows what is there now; one with changes, or whose last Apply has an
   * unknown outcome, keeps them and its message until Discard Changes and Refresh.
   */
  private rebind(id: string, connection: LiveConnection): void {
    this.options.documents.update(id, { connectionId: connection.id })
    const state = this.get(id)
    if (!state) return
    // The login can differ from the one it was read with; a message that only said the server went no longer applies.
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
  /** Whether an answer still matters: its document is open and the request was not dropped. */
  private end(id: string, requestId: string): boolean {
    const request = this.requests.get(id)
    if (request?.id === requestId) this.requests.delete(id)
    return !this.disposed && !!this.get(id) && request?.id === requestId && !request.dropped
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
  }
  /** A server that disconnects: a running Apply's outcome is unknown, a read fails, and their requests are cancelled. */
  private connectionsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (this.live(state.id)) continue
      const request = this.requests.get(state.id), preview = this.previews.get(state.id)
      if (preview) { this.previews.delete(state.id); this.cancel([preview]); this.patch(state.id, { script: { state: 'failed', error: { message: propertiesMessages.disconnected, code: 'CONNECTION_LOST' } } }) }
      if (state.phase === 'confirming') this.patch(state.id, { phase: 'ready' })
      if (!request || request.dropped) continue
      request.dropped = true
      this.requests.delete(state.id)
      this.cancel([request.id])
      if (request.kind === 'apply') this.patch(state.id, { phase: 'ready', stale: true, error: error('CONNECTION_LOST', propertiesMessages.connectionLost) })
      else this.patch(state.id, { phase: state.model ? 'ready' : 'loadFailed', error: error('CONNECTION_LOST', propertiesMessages.disconnected), ...state.model ? { stale: true } : {} })
    }
    this.publishContext()
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
