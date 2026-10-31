import { actionLimits } from '../../../shared/actions/catalog.ts'
import { restoreMessages, restoreSections, restoreSetIdPattern, type RestoreModel, type RestoreSource } from '../../../shared/actions/restore.ts'
import type { RestoreRequest } from '../../../shared/actions/restore-schema.ts'
import type { ActionError, ActionExecuteResult, ActionStep, RestoredDatabase } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { displayText, type ExplorerNodeRef } from '../../../shared/explorer/refs.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'
import type { RestoreContextState, RestoreKeys } from '../core/contextkeys'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { ScriptContent } from '../kit/ScriptDrawer'
import { deliverScript, type DeliverScriptDeps } from '../scripting/deliver'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import { destinationOf, draftPlan, initialDraft, restoreRequest, sourceDatabase, sourceSets, tailLogPossible, type RestoreDraft, type RestoreFacts } from './model'
import { confirmLines, outcomeOf, plannedSteps, type PlannedStep, type RunOutcome } from './run'

/** loading (the server and msdb's databases) → ready, or loadFailed; the sets and files load beside it as the source changes. */
export type RestorePhase = 'loading' | 'ready' | 'loadFailed'
export type RestoreLoad = 'idle' | 'loading' | 'ready' | 'failed'
export type RestoreSubDialog = 'devices' | 'timeline'
/**
 * A restore's run (D1f): checking (the server read again, this window's queries asked about their transactions) → confirm,
 * when a fact calls for it (owner decision 4) → running → done, failed, stopped or unknown (the backend or the server was lost).
 */
export type RestoreRunPhase = 'checking' | 'confirm' | 'running' | RunOutcome
export interface RestoreRun {
  readonly phase: RestoreRunPhase
  /** The destination as the request named it. */
  readonly database: string
  /** Whether it existed at the check: a Stop then asks first, and Varia never drops it (owner decision 5). */
  readonly existed: boolean
  readonly replace: boolean
  readonly planned: readonly PlannedStep[]
  /** The confirm bar's lines (phase confirm). */
  readonly confirm?: readonly string[]
  readonly requestId?: string
  readonly startedAt?: number
  readonly endedAt?: number
  /** Stop over a database that existed asks first, in the document (critic A11c). */
  readonly stopConfirm?: boolean
  /** Stop was sent: the reply waits for SQL Server to end the statement and the cleanup to run. */
  readonly stopping?: boolean
  readonly steps?: readonly ActionStep[]
  readonly error?: ActionError
  /** The destination as the run left it (critic A12), or absent when no database has its name any more. */
  readonly restored?: RestoredDatabase
}
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
  /** The Databases folder it was opened from, reconciled after a run. */
  readonly folderNodeId?: number
  readonly run?: RestoreRun
  /** Why Restore could not start after the server was read again (the choices no longer form a restore). */
  readonly runNotice?: string
  /** Why a window close, Disconnect or Restart was just refused while this restore runs. */
  readonly refusal?: string
}
/** The tab's title: "Restore Database - <destination>", or "Restore Database" before there is one. */
export const restoreTabTitle = (destination: string | undefined) => destination ? `Restore Database - ${displayText(destination)}` : 'Restore Database'

export interface RestoreSnapshot { readonly documents: Readonly<Record<string, RestoreState>> }

export interface RestoreServiceOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate'> & DeliverScriptDeps['documents'] & Partial<Pick<DocumentService, 'subscribe' | 'update'>>
  readonly files: DeliverScriptDeps['files']
  readonly connections: ExternalStore<readonly LiveConnection[]>
  /** A restore is a long run: while it runs, closing the window, disconnecting its server and Restart are refused. */
  readonly longRuns?: { begin(run: { readonly kind: 'restore'; readonly connectionId: string; readonly server: string; refused?(message: string): void }): Disposable }
  /** The STATS progress of the run's steps (ActionProgressService). */
  readonly progress?: { track(requestId: string): boolean; forget(requestId: string): void }
  /** Object Explorer: the Databases folder is reconciled once the run ends (owner decision 9), the database selected. */
  readonly explorer?: { reconcile(nodeId: number, options?: { readonly select?: ExplorerNodeRef }): void }
  /** This window's queries in the destination that closing connections would roll back (critic A7). */
  readonly transactions?: { transactionTabs(connectionId: string, database: string): Promise<string[]> }
  readonly focusEditor?: () => void
  readonly focus?: (id: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
  readonly now?: () => Date
}

export const restoreServiceMessages = {
  disconnected: 'The server was disconnected. Reconnect, or open Restore Database again on a connected server.',
  readFailed: 'The backups could not be read.',
  noScript: 'Choose what to restore to script it.',
  /** A close of the tab while it restores. */
  running: 'A restore is running. Stop it first, or wait for it to finish.',
  /** No answer: the backend or the server went away while the restore ran. */
  unknown: 'The connection was lost while the restore ran, so how far it got is not known. Check the database\'s state in Object Explorer.'
} as const
/** How long the Script preview waits after the last change, so typing sends one request. */
export const restorePreviewDelayMs = 300
const error = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: true })
const emptyFacts: RestoreFacts = { historyDatabases: [], sets: [], setsTruncated: false, files: [] }
const uuid = /^[0-9a-f]{8}-/
/** Run phases in which the choices may not change and nothing else may run. */
const busyRun = (run: RestoreRun | undefined): boolean => run?.phase === 'checking' || run?.phase === 'running'

/**
 * Restore Database as a document: one tab per open, its General, Files and Options pages as sections, the Select backup
 * devices and Backup Timeline sub-dialogs, and the Script drawer, which shows what the restore will run (D1e). Restore (D1f)
 * reads the server again, asks in the document when a fact calls for it, then runs `actions.execute`'s restore as a long run
 * with its steps and STATS progress; Stop cancels it in SQL Server (asking first over a database that existed), and the
 * reply lists the steps, the cleanup and the database's state. The Databases folder's Restore Database… and a database's
 * Tasks › Restore › Database… open it. Failures are values in the snapshot.
 */
export class RestoreService extends SnapshotStore<RestoreSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'restoreDatabase' as const
  readonly inSaveAll = false
  readonly saves = false
  private readonly newId: () => string
  private readonly timers: Timers
  private readonly now: () => Date
  private readonly registration: Disposable
  private readonly unsubscribe: (() => void)[]
  /** Each document's reads in flight, by what they read, so a newer read or a close cancels the older one. */
  private readonly reads = new Map<string, Map<'server' | 'sets' | 'files', string>>()
  private readonly previews = new Map<string, string>()
  private readonly previewTimers = new Map<string, unknown>()
  /** The request a confirm bar waits on, by document. */
  private readonly pending = new Map<string, RestoreRequest>()
  private readonly contextStore = new (class extends SnapshotStore<RestoreContextState> { set(value: RestoreContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {} })
  private disposed = false

  constructor(private readonly options: RestoreServiceOptions) {
    super({ documents: {} })
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.now = options.now ?? (() => new Date())
    this.registration = options.documents.registerProvider(this)
    this.unsubscribe = [
      options.connections.subscribe(() => { try { this.connectionsChanged(); this.publishContext() } catch (failure) { onUnexpectedError(failure) } }),
      // A reconnect moves the document to the new connection (TargetService.retarget), which can make Restore possible again.
      ...options.documents.subscribe ? [options.documents.subscribe(() => { try { this.publishContext() } catch (failure) { onUnexpectedError(failure) } })] : []
    ]
  }

  get context(): ExternalStore<RestoreContextState> { return this.contextStore }
  get(id: string): RestoreState | undefined { return this.getSnapshot().documents[id] }

  /** Opens a Restore Database document on a connection, its source the database (when msdb has backups of it); `folderNodeId` is the Databases folder to reconcile after a run. */
  open(connectionId: string, database?: string, folderNodeId?: number): string {
    if (this.disposed) throw new Error('Restore Database is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost)
    if (!connection) throw new Error('Connect to the server first.')
    const document = this.options.documents.openCustom('restoreDatabase', restoreTabTitle(database), connection.id, 'master')
    this.put({
      id: document.id, server: connection.server, ...connection.login ? { login: connection.login } : {}, phase: 'loading', facts: emptyFacts, sets: 'idle', files: 'idle', revision: 0,
      frame: initialFrameState(restoreSections), script: { state: 'idle', message: restoreServiceMessages.noScript }, ...folderNodeId !== undefined ? { folderNodeId } : {}
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
    const plan = draftPlan(state.draft, state.facts), sets = sourceSets(state.draft, state.facts)
    const full = sets.find(set => set.id === plan.ids[0] && set.type === 'full') ?? sets.find(set => set.type === 'full' && !set.problem)
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

  /** The server's facts again (its databases, their sessions and files), keeping the sets and the draft; undefined when it was dropped. */
  private async readServer(id: string): Promise<ActionError | 'read' | undefined> {
    const model = await this.read(id, 'server', { kind: 'history' })
    const state = this.get(id)
    if (!state || model === undefined) return undefined
    if ('code' in model) return model
    const facts: RestoreFacts = { ...state.facts, ...model.server ? { server: model.server } : {}, historyDatabases: model.historyDatabases ?? state.facts.historyDatabases }
    this.patch(id, { facts, revision: state.revision + 1 })
    return 'read'
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
    if (!state?.draft || state.phase !== 'ready' || busyRun(state.run)) return
    // A confirm bar asks about the choices it was shown for: a change withdraws it.
    if (state.run?.phase === 'confirm') this.dropConfirm(id)
    let draft: RestoreDraft = { ...state.draft, ...patch }
    for (const key of Object.keys(patch) as (keyof RestoreDraft)[]) if (patch[key] === undefined) delete (draft as Partial<Record<keyof RestoreDraft, unknown>>)[key]
    const reread = (patch.database !== undefined && patch.database !== state.draft.database) || (patch.source !== undefined && patch.source !== state.draft.source)
      || (patch.devices !== undefined && patch.devices.join('\n') !== state.draft.devices.join('\n'))
    // Another database on the media: its own sets, so the plan starts again and the destination follows it as it follows a new source.
    const rechosen = !reread && patch.deviceDatabase !== undefined && patch.deviceDatabase !== sourceDatabase(state.draft, state.facts)
    if (reread || rechosen) {
      const following = state.draft.destination === sourceDatabase(state.draft, state.facts)
      draft = { ...draft, restoreAs: {}, ...following && draft.source === 'database' ? { destination: draft.database } : {} }
      if (reread) delete (draft as { deviceDatabase?: unknown }).deviceDatabase
      delete (draft as { manual?: unknown }).manual
      delete (draft as { stopAt?: unknown }).stopAt
      if (rechosen && following) draft = { ...draft, destination: sourceDatabase(draft, state.facts) }
    }
    if (patch.destination !== undefined || reread || rechosen) draft = { ...draft, tailLog: tailLogPossible(draft, state.facts) && (patch.tailLog ?? true) }
    this.patch(id, { draft, revision: (this.get(id)?.revision ?? state.revision) + 1, scriptNotice: undefined, runNotice: undefined })
    if (reread) void this.loadSets(id)
    else { this.schedulePreview(id); void this.loadFiles(id) }
  }
  openDialog(id: string, dialog: RestoreSubDialog | undefined): void {
    const state = this.get(id)
    if (!state || state.dialog === dialog || (dialog && (state.phase !== 'ready' || busyRun(state.run)))) return
    this.patch(id, { dialog })
  }
  setFrame(id: string, frame: FrameState): void {
    const state = this.get(id)
    if (!state || state.frame === frame) return
    const opened = frame.scriptOpen && !state.frame.scriptOpen
    this.patch(id, { frame })
    if (opened) this.schedulePreview(id, 0)
  }
  /** Whether Refresh can read again: nothing runs in the document, and its server is connected. */
  canRefresh(id: string): boolean {
    const state = this.get(id)
    return !!state && !this.disposed && state.phase !== 'loading' && !busyRun(state.run) && this.live(id)
  }
  /** Reads the server and the source again, keeping the draft. */
  refresh(id: string): void {
    if (!this.canRefresh(id)) return
    if (this.get(id)?.run?.phase === 'confirm') this.dropConfirm(id)
    const state = this.get(id)!
    if (!state.draft) { this.patch(id, { phase: 'loading', error: undefined }); void this.start(id); return }
    this.patch(id, { facts: { ...state.facts, filesFor: undefined }, runNotice: undefined })
    void this.loadSets(id)
  }

  // --- Run ------------------------------------------------------------------------------------------------------------

  /** Whether Restore can start: the backups are read, the choices form a restore, nothing runs in the document, and its server is connected. */
  canRun(id: string): boolean {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state?.draft || !connectionId || this.disposed || state.phase !== 'ready' || state.sets !== 'ready' || state.files === 'loading' || busyRun(state.run) || !this.live(id)) return false
    return !('problem' in restoreRequest(state.draft, state.facts, { connectionId, requestId: 'check' }))
  }
  isRunning(id: string): boolean { return this.get(id)?.run?.phase === 'running' }

  /**
   * Restore (SSMS's OK): reads the server again, so the confirm bar and the backend's preflight see the databases as they are,
   * and this window's queries in the destination when it closes connections; then asks in the document when a fact calls for
   * it (owner decision 4), else runs at once.
   */
  async run(id: string): Promise<void> {
    if (!this.canRun(id)) return
    this.dropConfirm(id)
    const first = this.get(id)!
    this.patch(id, { run: { phase: 'checking', database: first.draft!.destination, existed: false, replace: first.draft!.replace, planned: [] }, runNotice: undefined, error: undefined })
    const read = await this.readServer(id)
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state?.draft || state.run?.phase !== 'checking' || !connectionId) return
    if (read !== 'read') { this.patch(id, { run: undefined, ...read ? { error: read } : {} }); return }
    const request = restoreRequest(state.draft, state.facts, { connectionId, requestId: this.newId() })
    if ('problem' in request) { this.patch(id, { run: undefined, runNotice: request.problem }); return }
    const destination = destinationOf(state.facts, state.draft.destination)
    let tabs: string[] = []
    if (destination && state.draft.closeConnections && this.options.transactions) {
      try { tabs = await this.options.transactions.transactionTabs(connectionId, destination.name) } catch (failure) { onUnexpectedError(failure) }
    }
    const current = this.get(id)
    if (!current?.draft || current.run?.phase !== 'checking' || current.revision !== state.revision) return
    const run: RestoreRun = { phase: 'checking', database: request.target.name, existed: !!request.identity, replace: request.restore.replace, planned: plannedSteps(request) }
    const lines = confirmLines(current.draft, current.facts, { tabs })
    if (lines.length === 0) { await this.execute(id, request, run); return }
    this.pending.set(id, request)
    this.patch(id, { run: { ...run, phase: 'confirm', confirm: lines } })
  }
  /** The confirm bar's Restore. */
  async confirmRun(id: string): Promise<void> {
    const state = this.get(id), request = this.pending.get(id)
    if (state?.run?.phase !== 'confirm' || !request) return
    this.pending.delete(id)
    if (!this.live(id)) { this.patch(id, { run: undefined, error: error('CONNECTION_LOST', restoreServiceMessages.disconnected) }); return }
    await this.execute(id, request, state.run)
  }
  /** The confirm bar's Cancel, or Escape: nothing runs. */
  cancelRun(id: string): void {
    if (this.get(id)?.run?.phase === 'confirm') this.dropConfirm(id)
  }
  /** Stop: over a database that existed it asks first (Keep restoring is the default); otherwise it cancels at once. */
  stop(id: string): void {
    const run = this.get(id)?.run
    if (run?.phase !== 'running' || run.stopping || run.stopConfirm) return
    if (run.existed) { this.patch(id, { run: { ...run, stopConfirm: true } }); return }
    this.sendStop(id)
  }
  /** The Stop question's answer: Stop cancels the restore in SQL Server; Keep restoring leaves it running. */
  answerStop(id: string, stop: boolean): void {
    const run = this.get(id)?.run
    if (run?.phase !== 'running' || !run.stopConfirm) return
    this.patch(id, { run: { ...run, stopConfirm: undefined } })
    if (stop) this.sendStop(id)
  }
  private sendStop(id: string): void {
    const run = this.get(id)?.run
    if (run?.phase !== 'running' || !run.requestId || run.stopping) return
    this.patch(id, { run: { ...run, stopping: true, stopConfirm: undefined } })
    this.cancel([run.requestId])
  }
  private dropConfirm(id: string): void {
    this.pending.delete(id)
    const state = this.get(id)
    if (state?.run?.phase === 'confirm' || state?.run?.phase === 'checking') this.patch(id, { run: undefined })
  }

  /** Runs the restore as a long run with its progress tracked, then shows how it ended and reconciles the Databases folder. */
  private async execute(id: string, request: RestoreRequest, run: RestoreRun): Promise<void> {
    const state = this.get(id)
    if (!state) return
    const requestId = request.requestId
    this.options.progress?.track(requestId)
    this.patch(id, { run: { ...run, phase: 'running', requestId, startedAt: this.now().getTime(), confirm: undefined }, dialog: undefined })
    const longRun = this.options.longRuns?.begin({ kind: 'restore', connectionId: request.connectionId, server: state.server, refused: refusal => this.patch(id, { refusal }) })
    let result: ApiResult<ActionExecuteResult>
    try { result = await this.call(() => this.options.api.executeObjectAction(request)) } finally {
      longRun?.dispose()
      this.options.progress?.forget(requestId)
    }
    const current = this.get(id)
    if (this.disposed || !current?.run || current.run.requestId !== requestId) return
    const lost = !result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST')
    const value = result.ok ? result.value : undefined
    const failure = lost ? error('CONNECTION_LOST', restoreServiceMessages.unknown)
      : value ? value.error : error(!result.ok && result.code === 'CANCELLED' ? 'CANCELLED' : 'SQL_ERROR', result.ok ? 'The restore failed.' : result.error)
    this.patch(id, {
      refusal: undefined,
      run: {
        ...current.run, phase: outcomeOf(failure, lost), endedAt: this.now().getTime(), stopping: undefined, stopConfirm: undefined,
        ...value ? { steps: value.steps } : {}, ...failure ? { error: failure } : {}, ...value?.restored ? { restored: value.restored } : {}
      }
    })
    // The tree is reconciled once the run ends (owner decision 9), with the database selected when it is there.
    if (current.folderNodeId !== undefined) {
      try { this.options.explorer?.reconcile(current.folderNodeId, value?.restored ? { select: { type: 'object', object: { kind: 'database', name: request.target.name } } } : {}) } catch (failure) { onUnexpectedError(failure) }
    }
    if (!lost && this.live(id)) void this.readServer(id)
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
  /** A tab whose restore runs stays open: closing it would leave the run without its Stop and its outcome. */
  canClose(id: string): string | undefined { return this.isRunning(id) ? restoreServiceMessages.running : undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(id: string, server: string): boolean { const state = this.get(id); return !!state && state.server.trim().toLowerCase() === server.trim().toLowerCase() }
  closed(id: string): void {
    const run = this.get(id)?.run
    this.cancel([...this.reads.get(id)?.values() ?? [], ...this.previews.has(id) ? [this.previews.get(id)!] : [], ...run?.phase === 'running' && run.requestId ? [run.requestId] : []])
    this.reads.delete(id)
    this.previews.delete(id)
    this.pending.delete(id)
    const timer = this.previewTimers.get(id)
    if (timer !== undefined) this.timers.clearTimeout(timer)
    this.previewTimers.delete(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
    this.publishContext()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel([...this.reads.values()].flatMap(slots => [...slots.values()]).concat([...this.previews.values()]))
    for (const timer of this.previewTimers.values()) this.timers.clearTimeout(timer)
    this.reads.clear()
    this.previews.clear()
    this.previewTimers.clear()
    this.pending.clear()
    this.registration.dispose()
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.contextStore.clear()
    this.clearListeners()
  }

  private patch(id: string, patch: Partial<RestoreState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as RestoreState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: RestoreState): void {
    const before = this.getSnapshot().documents[state.id]?.draft?.destination
    this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } })
    // The tab names the destination, as SSMS's window title does, also when it opened from the Databases folder with none.
    const destination = state.draft?.destination
    if (destination !== undefined && destination !== before && this.options.documents.get(state.id)) this.options.documents.update?.(state.id, { name: restoreTabTitle(destination) })
    this.publishContext()
  }
  private publishContext(): void {
    if (this.disposed) return
    const byDocument: Record<string, RestoreKeys> = {}
    for (const state of Object.values(this.getSnapshot().documents)) byDocument[state.id] = { runnable: this.canRun(state.id), running: this.isRunning(state.id), refreshable: this.canRefresh(state.id) }
    const current = this.contextStore.getSnapshot().byDocument
    const same = Object.keys(byDocument).length === Object.keys(current).length && Object.entries(byDocument).every(([id, keys]) => {
      const was = current[id]
      return !!was && was.runnable === keys.runnable && was.running === keys.running && was.refreshable === keys.refreshable
    })
    if (!same) this.contextStore.set({ byDocument })
  }
  private connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
  private live(id: string): boolean {
    const connectionId = this.connectionOf(id)
    return !!connectionId && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
  }
  /** A server that disconnects: its reads and preview are cancelled and say so, and a confirm bar is withdrawn; Refresh reads again once it is back. */
  private connectionsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (this.live(state.id)) continue
      if (state.run?.phase === 'confirm' || state.run?.phase === 'checking') this.dropConfirm(state.id)
      const slots = this.reads.get(state.id), preview = this.previews.get(state.id)
      const pending = [...slots?.values() ?? [], ...preview ? [preview] : []]
      if (pending.length === 0) continue
      this.reads.delete(state.id)
      this.previews.delete(state.id)
      this.cancel(pending)
      const lost = error('CONNECTION_LOST', restoreServiceMessages.disconnected)
      const current = this.get(state.id)!
      this.patch(state.id, {
        error: lost, ...current.phase === 'loading' ? { phase: 'loadFailed' } : {}, ...current.sets === 'loading' ? { sets: 'failed' } : {}, ...current.files === 'loading' ? { files: 'failed' } : {},
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
