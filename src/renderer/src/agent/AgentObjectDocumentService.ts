// The proxy and credential documents' common service (AG-8b, docs/sql-server-agent.md › Proxies and credentials): one tab per object and
// connection (or a New tab), a describe that reads the object and its choices, a draft edited here, a Script drawer previewing what Save
// sends, and Save as one action whose secret (a new or changed credential's) comes from the secret slot and goes only in actions.execute.
// A refusal keeps the draft; one on a field shows there. The subclasses say what their model, draft, problems and request are. Failures are
// values in the snapshot. Built on the job document's model (JobDocumentService), without its live header or compare.
import { actionLimits } from '../../../shared/actions/catalog.ts'
import { noScriptNotice } from '../../../shared/actions/database.ts'
import { emptySecretFacts, savable, type SecretFacts } from '../../../shared/actions/agent-proxy.ts'
import type { ActionDescribeResult, ActionError, ActionExecuteResult, ActionRequest, ActionScriptRequest } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { ScriptContent } from '../kit/ScriptDrawer'
import { previewDelayMs } from '../properties/DatabasePropertiesService'
import { deliverScript, type DeliverScriptDeps } from '../scripting/deliver'
import type { LiveConnection } from '../services/connections'
import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import { SecretSlot, type SecretSlotField } from './SecretSlot'
import { decodeKeptState, encodeKeptState, keptAgentText, rebaseKeptDraft, sameShape } from '../../../shared/agent/kept.ts'
import type { KeptCustomDocument } from '../services/documents'
import type { QueryDocument } from '../documents'
import { liveConnectionOn } from './kept-documents'

export type AgentObjectDocumentPhase = 'loading' | 'loadFailed' | 'ready' | 'saving'
export interface AgentObjectDocumentState<Model, Draft> {
  readonly id: string
  /** The object, or the node New opens on until it is saved. */
  readonly target: ObjectRef
  readonly server: string
  readonly login?: string
  readonly phase: AgentObjectDocumentPhase
  readonly model?: Model
  readonly draft?: Draft
  /** What the secret slot holds, never its value. */
  readonly secrets: SecretFacts
  /** Moves each time the slot is emptied while the document stays open, so the password fields remount empty. */
  readonly secretEpoch: number
  /** Moves with every draft change, a read included: which draft the Script preview shows. */
  readonly revision: number
  /** Moves only with the person's edits: what the close prompt compares. */
  readonly edits: number
  readonly changes: number
  readonly error?: ActionError
  readonly notice?: string
  /** A save went through but the object has not been read since (the re-read failed or was dropped): the model is older than the server,
   *  so nothing can change until a read succeeds (a New document would otherwise create the object again). */
  readonly unread?: boolean
  /** New Proxy opened from a subsystem's folder: the subsystem it starts active to. */
  readonly preset?: string
  readonly frame: FrameState
  readonly script: ScriptContent
  readonly scriptRevision?: number
  readonly scriptDatabase?: string
  readonly scriptNotice?: string
  /** Reopened by hot exit or AutoRecover (AG-6g) and not read since: the model is the one the draft began from (its secret was never kept). */
  readonly restored?: true
}
export interface AgentObjectDocumentSnapshot<Model, Draft> { readonly documents: Readonly<Record<string, AgentObjectDocumentState<Model, Draft>>> }

export interface AgentObjectDocumentServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'update' | 'setDirty' | 'activate' | 'getSnapshot' | 'subscribe'> & Partial<Pick<DocumentService, 'openKeptCustom'>> & DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly focus?: (id: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
}

/** Each document's words for its states. */
export interface AgentObjectDocumentText {
  readonly readFailed: string
  readonly saving: string
  readonly disconnected: string
  readonly lost: string
  readonly backendLost: string
  readonly savedUnread: string
  readonly unsaved: string
  /** After a refusal whose save changed the object all the same: says the rest was saved (it follows the refusal's own words). */
  readonly partlySaved: string
}

/** A save the draft asks for: the request without its connection, request id and secret, and whether it sends the slot's secret. */
type RequestBody<T> = T extends unknown ? Omit<T, 'connectionId' | 'requestId'> : never
export interface AgentObjectSave { readonly request: RequestBody<ActionRequest>; readonly secret: boolean }

const fallback = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: code !== 'STALE' && code !== 'NOT_FOUND' })
/** The facts a secret field would have once typed: Script never sends a secret, so it previews the save as if one were. */
const typedSecret: SecretFacts = { secret: 'set', matches: true, wellFormed: true, tooLong: false }

export abstract class AgentObjectDocumentService<Model, Draft, Field extends string> extends SnapshotStore<AgentObjectDocumentSnapshot<Model, Draft>> implements Disposable, CustomDocumentProvider {
  readonly inSaveAll = false
  protected readonly newId: () => string
  private readonly timers: Timers
  private readonly registration: Disposable
  private readonly unsubscribe: (() => void)[]
  private readonly requests = new Map<string, { readonly id: string; readonly kind: 'describe' | 'save'; readonly connectionId?: string; dropped: boolean }>()
  /** The connection each reopened document last tried its first read on (AG-6g), so a failed read is tried again only on a new connection. */
  private readonly rereadOn = new Map<string, string>()
  private readonly previews = new Map<string, string>()
  private readonly previewTimers = new Map<string, unknown>()
  private readonly saving = new Map<string, Promise<boolean>>()
  private readonly targetBindings: CustomDocumentTargets
  private readonly slot = new SecretSlot()
  private disposed = false

  protected abstract readonly dialog: 'agentProxy' | 'credential'
  protected abstract readonly text: AgentObjectDocumentText
  protected abstract readonly sectionIds: readonly { readonly id: string; readonly title: string }[]
  /** The tab's name for a target (New until saved). */
  protected abstract tabName(target: ObjectRef): string
  /** Whether a target is an existing object (else New's node). */
  protected abstract existing(target: ObjectRef): boolean
  protected abstract modelOf(result: ActionDescribeResult): Model | undefined
  /** Whether the model holds an object (else New). */
  protected abstract hasObject(model: Model): boolean
  protected abstract initialDraft(model: Model, state: AgentObjectDocumentState<Model, Draft>): Draft
  protected abstract changedFields(base: Draft, draft: Draft): readonly Field[]
  protected abstract draftProblems(model: Model, draft: Draft, secrets: SecretFacts): readonly { readonly field: Field; readonly severity: 'error' | 'warning'; readonly message: string }[]
  protected abstract changeCount(model: Model, draft: Draft): number
  protected abstract buildSave(model: Model, draft: Draft): AgentObjectSave | undefined
  /** The object's target once saved (its name as the server keeps it). */
  protected abstract savedTarget(state: AgentObjectDocumentState<Model, Draft>, save: AgentObjectSave): ObjectRef
  protected abstract savedNotice(created: boolean, secret: boolean): string
  /** Why the object cannot change (the document opens read-only), if it cannot. */
  protected abstract readOnly(model: Model): string | undefined

  constructor(protected readonly options: AgentObjectDocumentServiceOptions, readonly kind: 'agentProxy' | 'credential') {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.registration = options.documents.registerProvider(this)
    const changed = () => { try { this.connectionsChanged(); this.readRestored() } catch (failure) { onUnexpectedError(failure) } }
    this.unsubscribe = [options.connections.subscribe(changed), options.documents.subscribe(changed)]
  }

  get(id: string): AgentObjectDocumentState<Model, Draft> | undefined { return this.getSnapshot().documents[id] }
  /** For tests: whether any document's password fields hold a value. */
  get holdsSecrets(): boolean { return this.slot.holdsSecrets }

  /** An object's document: brought forward if open on this connection, otherwise a tab opens at once, loading. */
  protected openTarget(connectionId: string, target: ObjectRef, preset?: string): string {
    const connection = this.connection(connectionId)
    if (this.existing(target)) {
      const open = Object.values(this.getSnapshot().documents).find(state => state.target.kind === target.kind && state.target.name === target.name && this.connectionOf(state.id) === connectionId
        && this.targetBindings.matchesConnection(state.id, connectionId))
      if (open) { this.options.documents.activate(open.id); return open.id }
    }
    const document = this.options.documents.openCustom(this.kind, this.tabName(target), connection.id, this.kind === 'agentProxy' ? 'msdb' : 'master')
    this.targetBindings.bind(document.id, connection.id)
    this.put({
      id: document.id, target, server: connection.displayName || connection.server, ...connection.login ? { login: connection.login } : {}, phase: 'loading', secrets: emptySecretFacts, secretEpoch: 0,
      revision: 0, edits: 0, changes: 0, ...preset ? { preset } : {}, frame: initialFrameState(this.sectionIds), script: { state: 'idle', message: noScriptNotice }
    })
    void this.describe(document.id)
    return document.id
  }
  private connection(connectionId: string): LiveConnection {
    if (this.disposed) throw new Error('The document is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    return connection
  }

  // --- Editing -------------------------------------------------------------------------------------------------------

  canEdit(id: string): boolean {
    const state = this.get(id)
    return !!state?.model && !!state.draft && state.phase === 'ready' && !state.unread && !this.readOnly(state.model)
  }
  updateDraft(id: string, patch: Partial<Draft>): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEdit(id)) return
    const draft = { ...state.draft, ...patch }
    const field = state.error?.field as Field | undefined
    const fieldError = field !== undefined && this.changedFields(state.draft, draft).includes(field)
    this.patch(id, { draft, revision: state.revision + 1, edits: state.edits + 1, notice: undefined, ...fieldError ? { error: undefined } : {} })
    this.afterDraft(id)
  }
  /** A password field changed: its value goes to the slot; the snapshot learns only what it is. */
  setSecret(id: string, field: SecretSlotField, value: string): void {
    const state = this.get(id)
    if (!state || state.phase === 'saving' || this.disposed) return
    const secrets = this.slot.set(id, field, value)
    const current = state.secrets
    if (current.secret === secrets.secret && current.matches === secrets.matches && current.wellFormed === secrets.wellFormed && current.tooLong === secrets.tooLong) return
    this.patch(id, { secrets, edits: state.edits + 1 })
    this.afterDraft(id)
  }
  problems(id: string) {
    const state = this.get(id)
    return state?.model && state.draft ? this.draftProblems(state.model, state.draft, state.secrets) : []
  }
  setFrame(id: string, frame: FrameState): void {
    const state = this.get(id)
    if (!state || state.frame === frame) return
    const opened = frame.scriptOpen && !state.frame.scriptOpen
    this.patch(id, { frame })
    if (opened) this.schedulePreview(id, 0)
  }
  private afterDraft(id: string): void {
    const state = this.get(id)
    if (!state?.model || !state.draft) return
    const changes = this.changeCount(state.model, state.draft)
    this.patch(id, { changes })
    this.options.documents.setDirty(id, this.hasObject(state.model) ? changes > 0 || state.secrets.secret === 'set' : true)
    this.schedulePreview(id)
  }

  // --- Reading -------------------------------------------------------------------------------------------------------

  canReload(id: string): boolean {
    const state = this.get(id)
    return !!state && this.live(id) && state.phase !== 'saving' && state.phase !== 'loading'
  }
  /** Reload: the object read again; the draft's changes and typed secrets go (the tab's close prompt is the guard for unsaved work). */
  reload(id: string): void {
    if (!this.canReload(id)) return
    this.emptySlot(id)
    this.patch(id, { phase: 'loading', error: undefined, notice: undefined })
    void this.describe(id)
  }
  /** With `kept` (a reopened document's first read, AG-6g), the user's draft is put on the object as read now rather than replaced. */
  private async describe(id: string, notice?: string, kept?: { readonly model: Model; readonly draft: Draft }): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return
    const requestId = this.begin(id, 'describe')
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: this.dialog, target: state.target }))
    if (!this.end(id, requestId)) return
    const current = this.get(id)
    if (!current) return
    const failure = !result.ok ? fallback('SQL_ERROR', result.error) : result.value.error
    const model = result.ok ? this.modelOf(result.value) : undefined
    if (failure || !model) {
      const shown = failure ?? fallback('NOT_FOUND', this.text.readFailed)
      this.patch(id, { phase: current.model ? 'ready' : 'loadFailed', error: notice ? { ...shown, message: `${this.text.savedUnread} ${shown.message}` } : shown })
      return
    }
    if (kept) {
      const rebased = rebaseKeptDraft(this.initialDraft(kept.model, current), this.initialDraft(model, current), kept.draft)
      this.patch(id, { phase: 'ready', model, draft: rebased.draft, revision: current.revision + 1, error: undefined, unread: undefined, notice: rebased.conflicts.length ? keptAgentText.conflicts(this.noun) : keptAgentText.reread(this.noun) })
      this.afterDraft(id)
      return
    }
    // A read that replaces the draft (Reload) ends a reopened document's wait for its first read too.
    this.rereadOn.delete(id)
    this.patch(id, { phase: 'ready', model, draft: this.initialDraft(model, current), revision: current.revision + 1, changes: 0, error: undefined, unread: undefined, restored: undefined, notice, script: { state: 'idle', message: noScriptNotice }, scriptRevision: undefined })
    this.options.documents.setDirty(id, !this.hasObject(model))
    this.schedulePreview(id, 0)
  }

  // --- Save ----------------------------------------------------------------------------------------------------------

  canSave(id: string): boolean {
    const state = this.get(id)
    if (!state?.model || !state.draft || state.restored || !this.canEdit(id) || !this.live(id)) return false
    return (!this.hasObject(state.model) || state.changes > 0) && savable(this.problems(id)) && !!this.buildSave(state.model, state.draft)
  }
  save(id: string): Promise<boolean> {
    const running = this.saving.get(id)
    if (running) return running
    this.show(id)
    const promise = this.runSave(id).catch(failure => { onUnexpectedError(failure); return false }).finally(() => this.saving.delete(id))
    this.saving.set(id, promise)
    return promise
  }
  private async runSave(id: string): Promise<boolean> {
    const state = this.get(id)
    if (!state?.model || !state.draft) return false
    if (!this.live(id)) { this.patch(id, { error: fallback('CONNECTION_LOST', this.text.disconnected) }); return false }
    if (state.restored) { this.patch(id, { error: fallback('SQL_ERROR', keptAgentText.notReread(this.noun)) }); return false }
    if (!this.canSave(id)) return false
    const built = this.buildSave(state.model, state.draft)
    if (!built) return true
    const connectionId = this.connectionOf(id)!
    const requestId = this.begin(id, 'save'), request = this.requests.get(id)
    this.patch(id, { phase: 'saving', error: undefined, notice: undefined })
    // The secret leaves the slot only here, in the one request that sends it.
    const secrets = built.secret ? { secrets: { secret: this.slot.value(id) } } : {}
    const result = await this.call(() => this.options.api.executeObjectAction({ ...built.request, ...secrets, connectionId, requestId } as ActionRequest))
    if (this.requests.get(id)?.id === requestId) this.requests.delete(id)
    if (this.disposed || !this.get(id) || request?.dropped) return false
    if (this.connectionOf(id) !== connectionId || !this.live(id)) { this.patch(id, { phase: 'ready', error: fallback('CONNECTION_LOST', this.text.lost) }); return false }
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    if (value && !value.error) {
      const created = !this.hasObject(state.model)
      const target = this.savedTarget(state, built)
      this.emptySlot(id)
      this.patch(id, { phase: 'loading', target, changes: 0, unread: true })
      this.options.documents.setDirty(id, false)
      this.options.documents.update(id, { name: this.tabName(target) })
      await this.describe(id, this.savedNotice(created, built.secret))
      return true
    }
    // The proxy's principal grants and revokes run after its transaction commits (msdb's principal check dooms one): when that step is
    // refused, the rest was saved, so the document reads the object again and keeps the refusal. Otherwise a refusal rolled everything back,
    // so the object is as it was read and the draft (and typed secret) stay.
    if (value?.error && this.partlySaved(value)) {
      const target = this.savedTarget(state, built)
      this.emptySlot(id)
      this.patch(id, { phase: 'loading', target, changes: 0, unread: true })
      this.options.documents.setDirty(id, false)
      this.options.documents.update(id, { name: this.tabName(target) })
      await this.describe(id)
      // A failed re-read keeps its own words too: the document then shows the model read before the save.
      const reread = this.get(id)?.error
      this.patch(id, { error: { ...value.error, message: `${value.error.message} ${this.text.partlySaved}${reread ? ` ${this.text.savedUnread} ${reread.message}` : ''}` } })
      return false
    }
    if (value?.error) { this.patch(id, { phase: 'ready', error: value.error }); return false }
    const lost = !result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST')
    this.patch(id, { phase: 'ready', error: lost ? fallback('CONNECTION_LOST', !result.ok && result.code === 'BACKEND_LOST' ? this.text.backendLost : this.text.lost) : fallback('SQL_ERROR', result.ok ? this.text.unsaved : result.error) })
    return false
  }
  /** Whether a refused save changed the object all the same, so the document reads it again: by default when a step was done. */
  protected partlySaved(result: ActionExecuteResult): boolean { return result.steps.some(step => step.status === 'done') }
  /** Empties a document's password fields (a credential that will not be sent after all). */
  protected forgetSecret(id: string): void {
    this.emptySlot(id)
    this.afterDraft(id)
  }
  private emptySlot(id: string): void {
    const state = this.get(id)
    if (!state) return
    this.slot.clear(id)
    if (state.secrets !== emptySecretFacts || this.slot.holdsSecrets) this.patch(id, { secrets: emptySecretFacts, secretEpoch: state.secretEpoch + 1 })
  }

  // --- Script ----------------------------------------------------------------------------------------------------------

  async deliver(id: string, destination: ScriptDestination): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return
    let text = this.currentScript(id)
    if (text === undefined) { this.clearPreviewTimer(id); text = await this.preview(id) }
    const current = this.get(id)
    if (!current || this.disposed) return
    if (text === undefined) {
      const script = current.script
      this.patch(id, { scriptNotice: script.state === 'failed' ? script.error.message : script.state === 'idle' ? script.message : 'No script was produced.' })
      return
    }
    try {
      const name = this.tabName(current.target)
      const notice = await deliverScript({ destination, text, database: current.scriptDatabase ?? 'master', connectionId, fileName: `${name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}.sql` }, this.options)
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
    if (!state || !connectionId) return undefined
    const revision = state.revision
    // Script never carries the secret (it writes <secret>), so a secret not typed yet does not stop the preview.
    const built = state.model && state.draft && savable(this.draftProblems(state.model, state.draft, typedSecret)) ? this.buildSave(state.model, state.draft) : undefined
    if (!built) { this.patch(id, { script: { state: 'idle', message: noScriptNotice }, scriptRevision: revision }); return undefined }
    if (!this.live(id)) { this.patch(id, { script: { state: 'failed', error: { message: this.text.disconnected, code: 'CONNECTION_LOST' } }, scriptRevision: revision }); return undefined }
    const previous = this.previews.get(id)
    if (previous) this.cancel([previous])
    const requestId = this.newId()
    this.previews.set(id, requestId)
    this.patch(id, { script: { state: 'loading' } })
    const result = await this.call(() => this.options.api.scriptObjectAction({ ...built.request, connectionId, requestId } as ActionScriptRequest))
    if (this.previews.get(id) !== requestId) return undefined
    this.previews.delete(id)
    if (this.disposed || !this.get(id) || this.connectionOf(id) !== connectionId) return undefined
    const failure = !result.ok ? { message: result.error, ...result.code ? { code: result.code } : {} } : result.value.error ? { message: result.value.error.message, code: result.value.error.code } : undefined
    const text = result.ok ? result.value.text : undefined
    if (failure || text === undefined) { this.patch(id, { script: { state: 'failed', error: failure ?? { message: 'No script was produced.' } }, scriptRevision: revision }); return undefined }
    this.patch(id, { script: { state: 'ready', text }, scriptRevision: revision, scriptDatabase: result.ok ? result.value.database : undefined })
    if (this.get(id)?.revision !== revision) this.schedulePreview(id)
    return text
  }

  // --- CustomDocumentProvider ----------------------------------------------------------------------------------------

  canClose(id: string): string | undefined { return this.get(id)?.phase === 'saving' ? this.text.saving : undefined }

  // --- Hot exit and AutoRecover (AG-6g) --------------------------------------------------------------------------------

  private get noun(): string { return this.kind === 'agentProxy' ? 'proxy' : 'credential' }
  /** The object's unsaved state: the target, the read the draft began from and the draft. Never the secret slot's value. */
  keep(id: string): string | undefined {
    const state = this.get(id)
    if (!state?.model || !state.draft) return undefined
    return encodeKeptState({ version: 1, kind: this.kind, target: state.target, server: state.server, ...state.login ? { login: state.login } : {}, model: state.model, draft: state.draft, ...state.preset ? { extra: { preset: state.preset } } : {} })
  }
  /** A kept document reopened disconnected on its target, its password fields empty; it reads the object again once the target connects. */
  reopenKept(kept: KeptCustomDocument): QueryDocument {
    if (this.disposed || !this.options.documents.openKeptCustom) throw new Error(keptAgentText.unreadable(kept.name))
    const value = decodeKeptState(kept.state, this.kind)
    const preset = typeof value?.extra?.['preset'] === 'string' ? value.extra['preset'].slice(0, 128) : undefined
    const model = value?.model as Model | undefined, draft = value?.draft as Draft | undefined
    let shaped = false
    try { shaped = !!value && !!model && draft !== undefined && sameShape(this.initialDraft(model, { preset } as AgentObjectDocumentState<Model, Draft>), draft) } catch { shaped = false }
    if (!value || !model || draft === undefined || !shaped) throw new Error(keptAgentText.unreadable(kept.name))
    const document = this.options.documents.openKeptCustom(this.kind, this.tabName(value.target), kept.database ?? (this.kind === 'agentProxy' ? 'msdb' : 'master'), kept.targetId)
    if (kept.targetId) this.targetBindings.bindTarget(document.id, kept.targetId)
    this.put({
      id: document.id, target: value.target, server: value.server, ...value.login ? { login: value.login } : {}, phase: 'ready', model, draft, secrets: emptySecretFacts, secretEpoch: 0,
      revision: 1, edits: 0, changes: 0, ...preset ? { preset } : {}, restored: true, error: fallback('CONNECTION_LOST', keptAgentText.restored(this.noun, value.server)),
      frame: initialFrameState(this.sectionIds), script: { state: 'idle', message: noScriptNotice }
    })
    this.afterDraft(document.id)
    this.options.documents.setDirty(document.id, true)
    const live = liveConnectionOn(this.options.connections, this.options.targetIdOf, kept.targetId)
    if (live) this.options.documents.update(document.id, { connectionId: live })
    return document
  }
  attachesOnReconnect(id: string): boolean { return !!this.get(id)?.restored }
  /** Reopened documents whose target is now connected read their object again, keeping the draft. */
  private readRestored(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const connectionId = this.options.documents.get(state.id)?.connectionId
      if (!state.restored || !state.model || state.draft === undefined || !connectionId || !this.live(state.id) || this.requests.has(state.id) || this.rereadOn.get(state.id) === connectionId) continue
      this.rereadOn.set(state.id, connectionId)
      const kept = { model: state.model, draft: state.draft }
      this.patch(state.id, { phase: 'loading', restored: undefined, error: undefined, notice: undefined })
      void this.describe(state.id, undefined, kept).finally(() => {
        // A read that did not land (the connection lost, or a refusal or failure while connected) leaves the document as kept: Save
        // waits, since the draft is still on last session's read, and the next connection reads again.
        const after = this.get(state.id)
        if (after && after.model === kept.model) this.patch(state.id, { restored: true, ...after.phase === 'loading' ? { phase: 'ready' as const } : {} })
        else this.rereadOn.delete(state.id)
      })
    }
  }
  revision(id: string): number { return this.get(id)?.edits ?? 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  closed(id: string): void {
    this.targetBindings.forget(id)
    this.slot.clear(id)
    const request = this.requests.get(id), preview = this.previews.get(id)
    this.cancel([request?.id, preview].filter((value): value is string => !!value))
    this.requests.delete(id)
    this.previews.delete(id)
    this.clearPreviewTimer(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.slot.clearAll()
    this.targetBindings.clear()
    this.cancel([...this.requests.values()].map(request => request.id).concat([...this.previews.values()]))
    for (const timer of this.previewTimers.values()) this.timers.clearTimeout(timer)
    this.requests.clear()
    this.previews.clear()
    this.previewTimers.clear()
    this.registration.dispose()
    this.unsubscribe.forEach(unsubscribe => unsubscribe())
    this.clearListeners()
  }

  // --- Internals -----------------------------------------------------------------------------------------------------

  private show(id: string): void { if (this.options.documents.getSnapshot().activeId !== id) this.options.documents.activate(id) }
  protected patch(id: string, patch: Partial<AgentObjectDocumentState<Model, Draft>>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as AgentObjectDocumentState<Model, Draft> & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: AgentObjectDocumentState<Model, Draft>): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
  protected connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
  live(id: string): boolean {
    const connectionId = this.connectionOf(id)
    return this.targetBindings.matchesConnection(id, connectionId) && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }
  private begin(id: string, kind: 'describe' | 'save'): string {
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
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (this.live(state.id)) continue
      const request = this.requests.get(state.id), preview = this.previews.get(state.id)
      if (preview) { this.previews.delete(state.id); this.cancel([preview]) }
      if (!request || request.dropped) continue
      request.dropped = true
      this.requests.delete(state.id)
      this.cancel([request.id])
      if (request.kind === 'save') this.patch(state.id, { phase: 'ready', error: fallback('CONNECTION_LOST', this.text.lost) })
      else this.patch(state.id, { phase: state.model ? 'ready' : 'loadFailed', error: fallback('CONNECTION_LOST', this.text.disconnected) })
    }
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
