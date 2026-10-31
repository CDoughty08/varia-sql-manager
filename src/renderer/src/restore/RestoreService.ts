import { actionLimits } from '../../../shared/actions/catalog.ts'
import { restoreMessages, restoreSections, restoreSetIdPattern, type RestoreModel, type RestoreSource } from '../../../shared/actions/restore.ts'
import type { ActionError } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { ScriptContent } from '../kit/ScriptDrawer'
import { deliverScript, type DeliverScriptDeps } from '../scripting/deliver'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import { draftPlan, initialDraft, restoreRequest, sourceDatabase, tailLogPossible, type RestoreDraft, type RestoreFacts } from './model'

/** loading (the server and msdb's databases) → ready, or loadFailed; the sets and files load beside it as the source changes. */
export type RestorePhase = 'loading' | 'ready' | 'loadFailed'
export type RestoreLoad = 'idle' | 'loading' | 'ready' | 'failed'
export type RestoreSubDialog = 'devices' | 'timeline'
export interface RestoreState {
  readonly id: string
  readonly server: string
  readonly login?: string
  readonly phase: RestorePhase
  readonly facts: RestoreFacts
  /** The source's sets, and the plan's full backup's files. */
  readonly sets: RestoreLoad
  readonly files: RestoreLoad
  readonly draft?: RestoreDraft
  readonly dialog?: RestoreSubDialog
  readonly error?: ActionError
  /** Moves with every draft and facts change: which draft the Script preview shows. */
  readonly revision: number
  readonly frame: FrameState
  readonly script: ScriptContent
  readonly scriptRevision?: number
  readonly scriptNotice?: string
}
export interface RestoreSnapshot { readonly documents: Readonly<Record<string, RestoreState>> }

export interface RestoreServiceOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'cancelObjectActions' | 'writeClipboardText'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate'> & DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly focusEditor?: () => void
  readonly focus?: (id: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
  readonly now?: () => Date
}

export const restoreServiceMessages = {
  disconnected: 'The server was disconnected. Reconnect, or open Restore Database again on a connected server.',
  readFailed: 'The backups could not be read.',
  noScript: 'Choose what to restore to script it.'
} as const
/** How long the Script preview waits after the last change, so typing sends one request. */
export const restorePreviewDelayMs = 300
const error = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: true })
const emptyFacts: RestoreFacts = { historyDatabases: [], sets: [], setsTruncated: false, files: [] }
const uuid = /^[0-9a-f]{8}-/

/**
 * Restore Database as a document (D1e): one tab per open, its General, Files and Options pages as sections, the Select
 * backup devices and Backup Timeline sub-dialogs, and the Script drawer, which shows what the restore will run. It reads
 * through actions.describe and scripts through actions.script; nothing runs a restore until D1f adds OK, so no menu item,
 * command or palette entry opens it (critic A17): only the test hook does. Failures are values in the snapshot.
 */
export class RestoreService extends SnapshotStore<RestoreSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'restoreDatabase' as const
  readonly inSaveAll = false
  readonly saves = false
  private readonly newId: () => string
  private readonly timers: Timers
  private readonly now: () => Date
  private readonly registration: Disposable
  private readonly unsubscribe: () => void
  /** Each document's reads in flight, by what they read, so a newer read or a close cancels the older one. */
  private readonly reads = new Map<string, Map<'server' | 'sets' | 'files', string>>()
  private readonly previews = new Map<string, string>()
  private readonly previewTimers = new Map<string, unknown>()
  private disposed = false

  constructor(private readonly options: RestoreServiceOptions) {
    super({ documents: {} })
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.now = options.now ?? (() => new Date())
    this.registration = options.documents.registerProvider(this)
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } })
  }

  get(id: string): RestoreState | undefined { return this.getSnapshot().documents[id] }

  /** Opens a Restore Database document on a connection, its source the database (when msdb has backups of it). */
  open(connectionId: string, database?: string): string {
    if (this.disposed) throw new Error('Restore Database is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost)
    if (!connection) throw new Error('Connect to the server first.')
    const document = this.options.documents.openCustom('restoreDatabase', database ? `Restore Database - ${displayText(database)}` : 'Restore Database', connection.id, 'master')
    this.put({
      id: document.id, server: connection.server, ...connection.login ? { login: connection.login } : {}, phase: 'loading', facts: emptyFacts, sets: 'idle', files: 'idle', revision: 0,
      frame: initialFrameState(restoreSections), script: { state: 'idle', message: restoreServiceMessages.noScript }
    })
    void this.start(document.id, database)
    return document.id
  }

  // --- Reading --------------------------------------------------------------------------------------------------------

  private async start(id: string, database?: string): Promise<void> {
    const model = await this.read(id, 'server', { kind: 'history' })
    const state = this.get(id)
    if (!state || model === undefined) return
    if ('code' in model) { this.patch(id, { phase: 'loadFailed', error: model }); return }
    const historyDatabases = model.historyDatabases ?? []
    const chosen = database ?? historyDatabases[0] ?? ''
    const facts: RestoreFacts = { ...emptyFacts, ...model.server ? { server: model.server } : {}, historyDatabases }
    const draft = initialDraft(chosen, facts, this.now())
    this.patch(id, { phase: 'ready', facts, draft: { ...draft, tailLog: tailLogPossible(draft, facts) }, error: undefined, revision: state.revision + 1 })
    if (chosen) void this.loadSets(id)
  }

  /** The source's sets (msdb's history, or the devices' headers), then the plan's full backup's files. */
  private async loadSets(id: string): Promise<void> {
    const state = this.get(id), wanted = state?.draft
    if (!state || !wanted) return
    const source: RestoreSource | undefined = wanted.source === 'database' ? (wanted.database ? { kind: 'history', database: wanted.database } : undefined)
      : wanted.devices.length > 0 ? { kind: 'devices', devices: wanted.devices } : undefined
    if (!source) { this.patch(id, { sets: 'idle', files: 'idle', facts: { ...state.facts, sets: [], setsTruncated: false, files: [], filesFor: undefined }, revision: state.revision + 1 }); return }
    this.patch(id, { sets: 'loading', error: undefined })
    const model = await this.read(id, 'sets', source)
    const current = this.get(id)
    if (!current?.draft || model === undefined) return
    if ('code' in model) { this.patch(id, { sets: 'failed', error: model, facts: { ...current.facts, sets: [], setsTruncated: false, files: [], filesFor: undefined }, revision: current.revision + 1 }); return }
    const facts: RestoreFacts = { ...current.facts, ...source.kind === 'history' && model.server ? { server: model.server } : {}, sets: model.sets ?? [], setsTruncated: !!model.setsTruncated, files: [], filesFor: undefined }
    // Device: the destination follows the database the backups are of, unless the person typed one.
    const before = sourceDatabase(current.draft, current.facts)
    let draft = current.draft
    if (draft.source === 'device' && (!draft.destination || draft.destination === before)) draft = { ...draft, destination: sourceDatabase(draft, facts) }
    draft = { ...draft, tailLog: tailLogPossible(draft, facts) }
    this.patch(id, { sets: 'ready', facts, draft, revision: current.revision + 1, ...facts.sets.length === 0 ? { error: error('NOT_FOUND', source.kind === 'history' ? restoreMessages.noHistory : restoreMessages.noSets) } : {} })
    void this.loadFiles(id)
  }

  /** The files of the plan's full backup, for the Files page: msdb's record of a history set, or FILELISTONLY on the media. */
  private async loadFiles(id: string): Promise<void> {
    const state = this.get(id)
    if (!state?.draft) return
    const plan = draftPlan(state.draft, state.facts)
    const full = state.facts.sets.find(set => set.id === plan.ids[0] && set.type === 'full') ?? state.facts.sets.find(set => set.type === 'full' && !set.problem)
    if (!full || full.id === state.facts.filesFor) return
    const source: RestoreSource = uuid.test(full.id) && restoreSetIdPattern.test(full.id) ? { kind: 'historyFiles', setId: full.id } : { kind: 'mediaFiles', devices: full.devices, file: full.position }
    this.patch(id, { files: 'loading' })
    const model = await this.read(id, 'files', source)
    const current = this.get(id)
    if (!current || model === undefined) return
    if ('code' in model) { this.patch(id, { files: 'failed', error: model }); return }
    this.patch(id, { files: 'ready', facts: { ...current.facts, files: model.files ?? [], filesFor: full.id }, revision: current.revision + 1 })
    this.schedulePreview(id)
  }

  /** One describe: its model, a failure as a value, or undefined when a newer read, a close or a disconnect dropped it. */
  private async read(id: string, slot: 'server' | 'sets' | 'files', restore: RestoreSource): Promise<RestoreModel | ActionError | undefined> {
    const connectionId = this.connectionOf(id)
    if (!connectionId || !this.live(id)) return error('CONNECTION_LOST', restoreServiceMessages.disconnected)
    const slots = this.reads.get(id) ?? new Map<'server' | 'sets' | 'files', string>()
    this.reads.set(id, slots)
    const previous = slots.get(slot)
    if (previous) this.cancel([previous])
    const requestId = this.newId()
    slots.set(slot, requestId)
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'restoreDatabase', target: { kind: 'server' }, restore }))
    if (this.disposed || !this.get(id) || this.reads.get(id)?.get(slot) !== requestId) return undefined
    slots.delete(slot)
    if (!result.ok) return error(result.code === 'CONNECTION_LOST' || result.code === 'BACKEND_LOST' ? 'CONNECTION_LOST' : 'SQL_ERROR', result.error)
    if (result.value.error) return result.value.error
    return result.value.restore ?? error('SQL_ERROR', restoreServiceMessages.readFailed)
  }

  // --- Editing --------------------------------------------------------------------------------------------------------

  /** A change to the draft. A new source database reads its sets, and the destination follows it as SSMS's does. */
  updateDraft(id: string, patch: Partial<RestoreDraft>): void {
    const state = this.get(id)
    if (!state?.draft || state.phase !== 'ready') return
    let draft: RestoreDraft = { ...state.draft, ...patch }
    for (const key of Object.keys(patch) as (keyof RestoreDraft)[]) if (patch[key] === undefined) delete (draft as Partial<Record<keyof RestoreDraft, unknown>>)[key]
    const reread = (patch.database !== undefined && patch.database !== state.draft.database) || (patch.source !== undefined && patch.source !== state.draft.source)
      || (patch.devices !== undefined && patch.devices.join('\n') !== state.draft.devices.join('\n'))
    if (reread) {
      const following = state.draft.destination === sourceDatabase(state.draft, state.facts)
      draft = { ...draft, manual: undefined, stopAt: undefined, restoreAs: {}, ...following && draft.source === 'database' ? { destination: draft.database } : {} }
      delete (draft as { manual?: unknown }).manual
      delete (draft as { stopAt?: unknown }).stopAt
    }
    if (patch.destination !== undefined || reread) draft = { ...draft, tailLog: tailLogPossible(draft, state.facts) && (patch.tailLog ?? true) }
    this.patch(id, { draft, revision: state.revision + 1, scriptNotice: undefined })
    if (reread) void this.loadSets(id)
    else { this.schedulePreview(id); if (patch.manual !== undefined || patch.stopAt !== undefined || 'stopAt' in patch) void this.loadFiles(id) }
  }
  openDialog(id: string, dialog: RestoreSubDialog | undefined): void {
    const state = this.get(id)
    if (!state || state.dialog === dialog || (dialog && state.phase !== 'ready')) return
    this.patch(id, { dialog })
  }
  setFrame(id: string, frame: FrameState): void {
    const state = this.get(id)
    if (!state || state.frame === frame) return
    const opened = frame.scriptOpen && !state.frame.scriptOpen
    this.patch(id, { frame })
    if (opened) this.schedulePreview(id, 0)
  }
  /** Reads the server and the source again, keeping the draft. */
  refresh(id: string): void {
    const state = this.get(id)
    if (!state || state.phase === 'loading') return
    if (!state.draft) { this.patch(id, { phase: 'loading', error: undefined }); void this.start(id); return }
    this.patch(id, { facts: { ...state.facts, filesFor: undefined } })
    void this.loadSets(id)
  }

  // --- Script ---------------------------------------------------------------------------------------------------------

  /** The drawer's ways out: the current script, made again when the preview is behind. */
  async deliver(id: string, destination: ScriptDestination): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return
    const text = state.script.state === 'ready' && state.scriptRevision === state.revision ? state.script.text : await this.preview(id)
    const current = this.get(id)
    if (!current || this.disposed) return
    if (text === undefined) { this.patch(id, { scriptNotice: current.script.state === 'failed' ? current.script.error.message : current.script.state === 'idle' ? current.script.message : 'No script was produced.' }); return }
    try {
      const notice = await deliverScript({ destination, text, database: 'master', connectionId, fileName: `Restore ${current.draft?.destination || 'Database'}.sql` }, this.options)
      this.patch(id, { scriptNotice: notice })
    } catch (failure) { this.patch(id, { scriptNotice: failure instanceof Error ? failure.message : 'The script could not be delivered.' }) }
  }
  private schedulePreview(id: string, delay = restorePreviewDelayMs): void {
    const state = this.get(id)
    if (!state?.frame.scriptOpen || (state.scriptRevision === state.revision && state.script.state !== 'failed')) return
    const pending = this.previewTimers.get(id)
    if (pending !== undefined) this.timers.clearTimeout(pending)
    this.previewTimers.set(id, this.timers.setTimeout(() => { this.previewTimers.delete(id); void this.preview(id) }, delay))
  }
  private async preview(id: string): Promise<string | undefined> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state?.draft || !connectionId) return undefined
    const revision = state.revision
    const previous = this.previews.get(id)
    if (previous) { this.previews.delete(id); this.cancel([previous]) }
    if (!this.live(id)) { this.patch(id, { script: { state: 'failed', error: { message: restoreServiceMessages.disconnected, code: 'CONNECTION_LOST' } }, scriptRevision: revision }); return undefined }
    const requestId = this.newId()
    const request = restoreRequest(state.draft, state.facts, { connectionId, requestId })
    if ('problem' in request) { this.patch(id, { script: { state: 'idle', message: request.problem }, scriptRevision: revision }); return undefined }
    this.previews.set(id, requestId)
    this.patch(id, { script: { state: 'loading' } })
    const result = await this.call(() => this.options.api.scriptObjectAction(request))
    if (this.previews.get(id) !== requestId || this.disposed || !this.get(id)) return undefined
    this.previews.delete(id)
    const failure = !result.ok ? { message: result.error, ...result.code ? { code: result.code } : {} } : result.value.error ? { message: result.value.error.message, code: result.value.error.code } : undefined
    const text = result.ok ? result.value.text : undefined
    if (failure || text === undefined) { this.patch(id, { script: { state: 'failed', error: failure ?? { message: 'No script was produced.' } }, scriptRevision: revision }); return undefined }
    this.patch(id, { script: { state: 'ready', text }, scriptRevision: revision })
    if (this.get(id)?.revision !== revision) this.schedulePreview(id)
    return text
  }

  // --- Document provider ----------------------------------------------------------------------------------------------

  save(): Promise<boolean> { return Promise.resolve(false) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(id: string, server: string): boolean { const state = this.get(id); return !!state && state.server.trim().toLowerCase() === server.trim().toLowerCase() }
  closed(id: string): void {
    this.cancel([...this.reads.get(id)?.values() ?? [], ...this.previews.has(id) ? [this.previews.get(id)!] : []])
    this.reads.delete(id)
    this.previews.delete(id)
    const timer = this.previewTimers.get(id)
    if (timer !== undefined) this.timers.clearTimeout(timer)
    this.previewTimers.delete(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel([...this.reads.values()].flatMap(slots => [...slots.values()]).concat([...this.previews.values()]))
    for (const timer of this.previewTimers.values()) this.timers.clearTimeout(timer)
    this.reads.clear()
    this.previews.clear()
    this.previewTimers.clear()
    this.registration.dispose()
    this.unsubscribe()
    this.clearListeners()
  }

  private patch(id: string, patch: Partial<RestoreState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as RestoreState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: RestoreState): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
  private connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
  private live(id: string): boolean {
    const connectionId = this.connectionOf(id)
    return !!connectionId && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
  }
  /** A server that disconnects: its reads and preview are cancelled and say so; Refresh reads again once it is back. */
  private connectionsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (this.live(state.id)) continue
      const slots = this.reads.get(state.id), preview = this.previews.get(state.id)
      const pending = [...slots?.values() ?? [], ...preview ? [preview] : []]
      if (pending.length === 0) continue
      this.reads.delete(state.id)
      this.previews.delete(state.id)
      this.cancel(pending)
      const lost = error('CONNECTION_LOST', restoreServiceMessages.disconnected)
      this.patch(state.id, {
        error: lost, ...state.phase === 'loading' ? { phase: 'loadFailed' } : {}, ...state.sets === 'loading' ? { sets: 'failed' } : {}, ...state.files === 'loading' ? { files: 'failed' } : {},
        ...preview ? { script: { state: 'failed', error: { message: lost.message, code: lost.code } } } : {}
      })
    }
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
