// The SQL Server Agent job document (AG-6a, docs/sql-server-agent.md › Job document): one tab per job and connection, opened from
// Object Explorer's Properties, Job Activity Monitor, Ctrl+Q and the palette, and New Job's tab with its start panel (Blank, or Copy an
// existing job). The describe reads the job and what its sections offer; the draft is edited here; Save sends one `agentJob` action
// that the backend runs as one transaction under the STALE guard, whose refusal opens a field-by-field compare. Problems warn and only
// a missing or too long value stops Save. The header follows the job's state live through the agent.jobs source's watched probe
// (the backend schedules every read) and runs Start, Start at step and Stop through AG-2's verbs. Failures are values in the snapshot.
import { actionLimits, dialogSpecs } from '../../../shared/actions/catalog.ts'
import { noScriptNotice } from '../../../shared/actions/database.ts'
import {
  agentJobChangeCount, agentJobCompare, agentJobFieldSection, agentJobProblems, agentJobSavable, agentJobSave, agentJobTabName, changedAgentJobFields, copiedAgentJobDraft,
  initialAgentJobDraft, rebaseAgentJobDraft, type AgentJobCompareRow, type AgentJobDocumentModel, type AgentJobDraft, type AgentJobField, type AgentJobProblem, type AgentJobSection
} from '../../../shared/actions/agent-job.ts'
import type { ActionError, ActionExecuteResult, ActionRequest } from '../../../shared/actions/schema.ts'
import {
  jobScheduleText, momentOfText, ownsSchedule, refreshPickedSchedules, scheduleFieldsOf, scheduleKey, type AgentScheduleJob, type AgentScheduleRecord, type AgentSchedulesModel, type JobScheduleEntry
} from '../../../shared/actions/agent-schedule.ts'
import { defaultSchedule, type AgentMoment, type AgentScheduleFields } from '../../../shared/agent/schedule.ts'
import { agentJobsSource, agentWatchedProbe, watchedGoneStatus, watchedSlot, type WatchedSample } from '../../../shared/agent/jobs.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import { liveProbes } from '../../../shared/live/catalog.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { ScriptContent } from '../kit/ScriptDrawer'
import type { LiveHandle, LiveService } from '../live/LiveService'
import { previewDelayMs } from '../properties/DatabasePropertiesService'
import { deliverScript, type DeliverScriptDeps } from '../scripting/deliver'
import type { LiveConnection } from '../services/connections'
import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'

export type JobDocumentPhase = 'loading' | 'loadFailed' | 'choosing' | 'ready' | 'saving'
/** The header's live state from the watched probe: running (with its step), idle, or a job msdb no longer has. */
export interface JobLive { readonly running: boolean; readonly retrying?: boolean; readonly step?: number; readonly steps?: number; readonly lastOutcome?: number; readonly gone?: boolean }
/** A STALE refusal: the job as read now, the compare, and the conflicts the user chose the server's value for. */
export interface JobStale { readonly current: AgentJobDocumentModel; readonly rows: readonly AgentJobCompareRow[]; readonly keepServer: readonly AgentJobField[] }

export interface JobDocumentState {
  readonly id: string
  /** The job, or the SQL Server Agent node for New Job until it is saved. */
  readonly target: ObjectRef
  readonly server: string
  readonly login?: string
  readonly phase: JobDocumentPhase
  readonly model?: AgentJobDocumentModel
  readonly draft?: AgentJobDraft
  /** Moves with every draft change, a read included: which draft the Script preview shows. */
  readonly revision: number
  /** Moves only with the person's edits: what the close prompt compares. */
  readonly edits: number
  /** "Save · n changes". */
  readonly changes: number
  readonly error?: ActionError
  readonly notice?: string
  readonly stale?: JobStale
  readonly live?: JobLive
  /** A Start or Stop on its way. */
  readonly verb?: 'starting' | 'stopping'
  /** Copy an existing job is reading the job it copies. */
  readonly copying?: string
  readonly frame: FrameState
  readonly script: ScriptContent
  readonly scriptRevision?: number
  readonly scriptDatabase?: string
  readonly scriptNotice?: string
  /** The Schedules section (AG-6c): the entry or shared schedule (`pick:<id>`) shown beside the list, the search, the shared schedules as read
   *  (once, when the section first asks), and one schedule's jobs where the login cannot read every link (below sysadmin). */
  readonly scheduleSelected?: string
  readonly scheduleSearch?: string
  readonly shared?: SharedSchedules
  readonly scheduleJobs?: Readonly<Record<number, ScheduleJobsRead>>
}
/** The shared schedules a job's Schedules section offers to attach, as one `agentSchedules` describe read them. */
export interface SharedSchedules { readonly state: 'loading' | 'ready' | 'failed'; readonly model?: AgentSchedulesModel; readonly error?: string }
export interface ScheduleJobsRead { readonly state: 'loading' | 'ready' | 'failed'; readonly jobs?: readonly AgentScheduleJob[] }
export interface JobDocumentSnapshot { readonly documents: Readonly<Record<string, JobDocumentState>> }

export interface JobDocumentServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'update' | 'setDirty' | 'activate' | 'getSnapshot' | 'subscribe'> & DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly live?: Pick<LiveService, 'open'>
  readonly focus?: (id: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
}

export const jobDocumentText = {
  saved: 'The job was saved.',
  created: 'The job was created.',
  started: 'Start requested. SQL Server Agent runs the job.',
  stopped: 'Stop requested.',
  disconnected: 'The server was disconnected. Reconnect, then Reload the job.',
  readFailed: 'The job could not be read.',
  savedUnread: 'The job was saved, but it could not be read again:',
  saving: 'The job is being saved. Wait for it to finish.',
  lost: 'The connection closed while the job was being saved, so whether it was saved is unknown. Reload the job to check.',
  backendLost: 'The SQL backend stopped while the job was being saved, so whether it was saved is unknown. Reload the job to check.',
  copyFailed: 'The job to copy could not be read:',
  replaced: 'The job was deleted and another job now has its name, so your changes were not saved. Reload opens the new job; your changes are discarded.'
} as const
export const jobSections: readonly { readonly id: AgentJobSection; readonly title: string }[] = [
  { id: 'general', title: 'General' }, { id: 'schedules', title: 'Schedules' }, { id: 'notifications', title: 'Notifications' }, { id: 'targets', title: 'Targets' }, { id: 'alerts', title: 'Alerts' }
]
const fallback = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: code !== 'STALE' && code !== 'NOT_FOUND' })

/** The header's state out of a watched slot. */
export function jobLive(sample: WatchedSample | undefined): JobLive | undefined {
  if (!sample || sample.status === undefined) return undefined
  if (sample.status === watchedGoneStatus) return { running: false, gone: true }
  const running = [1, 2, 3, 7].includes(sample.status)
  return { running, ...running ? { step: sample.step || undefined, steps: sample.steps || undefined, retrying: sample.status === 3 } : {}, ...sample.lastOutcome !== undefined ? { lastOutcome: sample.lastOutcome } : {} }
}

export class JobDocumentService extends SnapshotStore<JobDocumentSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'agentJob' as const
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly timers: Timers
  private readonly registration: Disposable
  private readonly unsubscribe: (() => void)[]
  private readonly requests = new Map<string, { readonly id: string; readonly kind: 'describe' | 'save' | 'copy'; readonly connectionId?: string; dropped: boolean }>()
  /** The Schedules section's reads (shared schedules, one schedule's jobs), apart from the document's own so neither drops the other. */
  private readonly scheduleReads = new Map<string, Set<string>>()
  /** Bumped whenever the Schedules section's reads start over, so a read that answers after it is dropped. */
  private readonly scheduleGenerations = new Map<string, number>()
  private readonly previews = new Map<string, string>()
  private readonly previewTimers = new Map<string, unknown>()
  private readonly saving = new Map<string, Promise<boolean>>()
  private readonly views = new Map<string, { readonly jobId: string; readonly stop: () => void; readonly handle: LiveHandle }>()
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false

  constructor(private readonly options: JobDocumentServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.registration = options.documents.registerProvider(this)
    this.unsubscribe = [options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } })]
  }

  get(id: string): JobDocumentState | undefined { return this.getSnapshot().documents[id] }

  /** A job's document: brought forward if open on this connection, otherwise a tab opens at once, loading. */
  openJob(connectionId: string, name: string): string {
    const connection = this.connection(connectionId)
    const existing = Object.values(this.getSnapshot().documents).find(state => state.target.kind === 'agentJob' && state.target.name === name && this.connectionOf(state.id) === connectionId && this.targetBindings.matchesConnection(state.id, connectionId))
    if (existing) { this.options.documents.activate(existing.id); return existing.id }
    return this.create(connection, { kind: 'agentJob', name })
  }
  /** New Job: a tab with the start panel (Blank, or Copy an existing job); nothing is created until Save. */
  newJob(connectionId: string): string { return this.create(this.connection(connectionId), { kind: 'agent' }) }
  private connection(connectionId: string): LiveConnection {
    if (this.disposed) throw new Error('The job document is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    return connection
  }
  private create(connection: LiveConnection, target: ObjectRef): string {
    const document = this.options.documents.openCustom('agentJob', agentJobTabName(target.kind === 'agentJob' ? target.name : undefined), connection.id, 'msdb')
    this.targetBindings.bind(document.id, connection.id)
    this.put({
      id: document.id, target, server: connection.displayName || connection.server, ...connection.login ? { login: connection.login } : {}, phase: 'loading', revision: 0, edits: 0, changes: 0,
      frame: initialFrameState(jobSections), script: { state: 'idle', message: noScriptNotice }
    })
    void this.describe(document.id)
    return document.id
  }

  /** The jobs msdb lets the login see on a connection, for Open Job's pick (New Job's describe lists them). */
  async jobNames(connectionId: string, signal?: AbortSignal): Promise<readonly string[]> {
    this.connection(connectionId)
    const requestId = this.newId()
    const abort = () => this.cancel([requestId])
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'agentJob', target: { kind: 'agent' } }))
      if (!result.ok) throw new Error(result.error)
      if (result.value.error) throw new Error(result.value.error.message)
      return result.value.agentJobDocument?.jobs ?? []
    } finally { signal?.removeEventListener('abort', abort) }
  }

  // --- New Job's start panel -----------------------------------------------------------------------------------------

  /** Blank: New Job's defaults (owner the login, [Uncategorized (Local)], enabled). */
  startBlank(id: string): void {
    const state = this.get(id)
    if (state?.phase !== 'choosing' || !state.model) return
    this.patch(id, { phase: 'ready', draft: initialAgentJobDraft(state.model), revision: state.revision + 1, error: undefined })
    this.afterDraft(id)
  }
  /** Copy an existing job: its General and Notifications as the new job's, named "Copy of …". */
  async startCopy(id: string, name: string): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (state?.phase !== 'choosing' || !state.model || !connectionId) return
    const requestId = this.begin(id, 'copy')
    this.patch(id, { copying: name, error: undefined })
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'agentJob', target: { kind: 'agentJob', name } }))
    if (!this.end(id, requestId)) return
    const current = this.get(id)!
    // Blank was chosen while the copy was read: the user's blank draft stands.
    if (current.phase !== 'choosing') { this.patch(id, { copying: undefined }); return }
    const source = result.ok ? result.value.agentJobDocument : undefined
    const failure = !result.ok ? fallback('SQL_ERROR', result.error) : result.value.error
    if (failure || !source || !current.model) {
      const shown = failure ?? fallback('NOT_FOUND', jobDocumentText.readFailed)
      this.patch(id, { copying: undefined, error: { ...shown, message: `${jobDocumentText.copyFailed} ${shown.message}` } })
      return
    }
    const draft = copiedAgentJobDraft(source, current.model.login, current.model.sysadmin)
    this.patch(id, { phase: 'ready', copying: undefined, draft, revision: current.revision + 1, edits: current.edits + 1 })
    this.afterDraft(id)
  }

  // --- Editing -------------------------------------------------------------------------------------------------------

  canEdit(id: string): boolean {
    const state = this.get(id)
    return !!state?.model && !!state.draft && state.phase === 'ready' && !state.model.readOnly && !state.stale
  }
  updateDraft(id: string, patch: Partial<AgentJobDraft>): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEdit(id)) return
    const draft = { ...state.draft, ...patch }
    const fieldError = state.error?.field && changedAgentJobFields(state.draft, draft).includes(state.error.field)
    this.patch(id, { draft, revision: state.revision + 1, edits: state.edits + 1, notice: undefined, ...fieldError ? { error: undefined } : {} })
    this.afterDraft(id)
  }
  /** Alerts' Remove (and its undo): the alert stops running this job when the job is saved. */
  toggleAlert(id: string, alertId: number): void {
    const state = this.get(id)
    if (!state?.draft || !state.model?.alertsEditable) return
    const removed = state.draft.removeAlerts.includes(alertId)
    this.updateDraft(id, { removeAlerts: removed ? state.draft.removeAlerts.filter(item => item !== alertId) : [...state.draft.removeAlerts, alertId] })
  }
  problems(id: string): AgentJobProblem[] {
    const state = this.get(id)
    return state?.model && state.draft ? agentJobProblems(state.model, state.draft) : []
  }
  /** Each section with an error or warning on it, or a save error landed on one of its fields. */
  problemSections(id: string): Set<AgentJobSection> {
    const state = this.get(id)
    const sections = new Set(this.problems(id).map(problem => agentJobFieldSection[problem.field]))
    if (state?.error?.field) sections.add(agentJobFieldSection[state.error.field])
    return sections
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
    const changes = state.model.job ? agentJobChangeCount(initialAgentJobDraft(state.model), state.draft) : state.draft.name.trim() ? 1 : 0
    this.patch(id, { changes })
    this.options.documents.setDirty(id, state.model.job ? changes > 0 : state.phase === 'ready')
    this.schedulePreview(id)
  }

  // --- Reading -------------------------------------------------------------------------------------------------------

  canReload(id: string): boolean {
    const state = this.get(id)
    return !!state && this.live(id) && state.phase !== 'saving' && state.phase !== 'loading' && !state.copying
  }
  /** Reload: the job read again; the draft's changes go (the tab's close prompt is the guard for unsaved work). */
  reload(id: string): void {
    if (!this.canReload(id)) return
    this.patch(id, { phase: 'loading', error: undefined, notice: undefined, stale: undefined })
    void this.describe(id)
  }
  private async describe(id: string, notice?: string, followed = false): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return
    const requestId = this.begin(id, 'describe')
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'agentJob', target: state.target }))
    if (!this.end(id, requestId)) return
    const failure = !result.ok ? fallback('SQL_ERROR', result.error) : result.value.error
    const model = result.ok ? result.value.agentJobDocument : undefined
    if (failure?.code === 'NOT_FOUND' && !followed && await this.followRename(id)) return this.describe(id, notice, true)
    const current = this.get(id)
    if (!current) return
    if (failure || !model) {
      const shown = failure ?? fallback('NOT_FOUND', jobDocumentText.readFailed)
      this.patch(id, { phase: current.model ? 'ready' : 'loadFailed', error: notice ? { ...shown, message: `${jobDocumentText.savedUnread} ${shown.message}` } : shown })
      return
    }
    const create = !model.job
    this.patch(id, {
      phase: create ? 'choosing' : 'ready', model, draft: create ? undefined : initialAgentJobDraft(model), revision: current.revision + 1, changes: 0, error: undefined, stale: undefined,
      notice, script: { state: 'idle', message: noScriptNotice }, scriptRevision: undefined,
      // The shared schedules and their jobs are read again when the section next asks: a save may have changed them.
      ...this.restartScheduleReads(id), scheduleSelected: undefined
    })
    this.options.documents.setDirty(id, false)
    if (model.job) this.follow(id, model.job.jobId)
    this.schedulePreview(id, 0)
  }

  /** A job the document read is not found by its name: finds it by its id among the jobs msdb lists (New Job's describe) and, when another
   *  name has it, points the document and its tab there. False when the job is gone, or the read failed or was overtaken. */
  private async followRename(id: string): Promise<boolean> {
    const state = this.get(id), connectionId = this.connectionOf(id), jobId = state?.model?.job?.jobId
    if (!state || !connectionId || !jobId) return false
    const requestId = this.begin(id, 'describe')
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'agentJob', target: { kind: 'agent' } }))
    if (!this.end(id, requestId) || !result.ok || result.value.error) return false
    const listed = result.value.agentJobDocument
    const index = listed?.jobIds?.findIndex(item => item.toLowerCase() === jobId.toLowerCase()) ?? -1
    const name = index >= 0 ? listed?.jobs?.[index] : undefined
    if (name === undefined || (state.target.kind === 'agentJob' && state.target.name === name)) return false
    this.patch(id, { target: { kind: 'agentJob', name } })
    this.options.documents.update(id, { name: agentJobTabName(name) })
    return true
  }

  // --- Save ----------------------------------------------------------------------------------------------------------

  canSave(id: string): boolean {
    const state = this.get(id)
    if (!state?.model || !state.draft || !this.canEdit(id) || !this.live(id)) return false
    return (!state.model.job || state.changes > 0) && agentJobSavable(this.problems(id))
  }
  save(id: string): Promise<boolean> {
    const running = this.saving.get(id)
    if (running) return running
    this.show(id)
    const promise = this.runSave(id).catch(failure => { onUnexpectedError(failure); return false }).finally(() => this.saving.delete(id))
    this.saving.set(id, promise)
    return promise
  }
  private request(state: JobDocumentState): Omit<Extract<ActionRequest, { action: 'agentJob' }>, 'connectionId' | 'requestId'> | undefined {
    if (!state.model || !state.draft) return undefined
    const save = agentJobSave(state.model, state.draft)
    if (!save) return undefined
    const job = state.model.job
    return job ? { action: 'agentJob', target: { kind: 'agentJob', name: job.name }, agentIdentity: { jobId: job.jobId }, agentJob: save } : { action: 'agentJob', target: { kind: 'agent' }, agentJob: save }
  }
  private async runSave(id: string): Promise<boolean> {
    const state = this.get(id)
    if (!state?.model || !state.draft) return false
    if (state.model.job && state.changes === 0) return true
    if (!this.live(id)) { this.patch(id, { error: fallback('CONNECTION_LOST', jobDocumentText.disconnected) }); return false }
    if (!this.canSave(id)) return false
    const built = this.request(state)
    if (!built) return true
    const connectionId = this.connectionOf(id)!
    const requestId = this.begin(id, 'save'), request = this.requests.get(id)
    this.patch(id, { phase: 'saving', error: undefined, notice: undefined })
    const result = await this.call(() => this.options.api.executeObjectAction({ ...built, connectionId, requestId }))
    if (this.requests.get(id)?.id === requestId) this.requests.delete(id)
    if (this.disposed || !this.get(id) || request?.dropped) return false
    if (this.connectionOf(id) !== connectionId || !this.live(id)) { this.patch(id, { phase: 'ready', error: fallback('CONNECTION_LOST', jobDocumentText.lost) }); return false }
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    if (value && !value.error) {
      const created = !state.model.job
      // The name as msdb keeps it: the save trims it, as sp_add_job and sp_update_job do.
      const target: ObjectRef = { kind: 'agentJob', name: built.agentJob.name ?? state.model.job?.name ?? state.draft.name.trim() }
      this.patch(id, { phase: 'loading', target, changes: 0 })
      this.options.documents.setDirty(id, false)
      this.options.documents.update(id, { name: agentJobTabName(target.name) })
      await this.describe(id, created ? jobDocumentText.created : jobDocumentText.saved)
      return true
    }
    // STALE, or NOT_FOUND (the job is not under the name it was read by: renamed or deleted since): the compare re-reads it, following a
    // rename by its id, and keeps the draft either way.
    if (value?.error?.code === 'STALE' || (value?.error?.code === 'NOT_FOUND' && !value.error.field && state.model.job)) { await this.compare(id, value.error); return false }
    // One transaction: a refusal rolled every call back, so the job is as it was read.
    if (value?.error) { this.patch(id, { phase: 'ready', error: value.error }); return false }
    const lost = !result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST')
    this.patch(id, { phase: 'ready', error: lost ? fallback('CONNECTION_LOST', !result.ok && result.code === 'BACKEND_LOST' ? jobDocumentText.backendLost : jobDocumentText.lost) : fallback('SQL_ERROR', result.ok ? 'The job could not be saved.' : result.error) })
    return false
  }
  /** STALE: the job as it is now, and the compare of what each side changed since the document opened. */
  private async compare(id: string, refusal: ActionError, followed = false): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state?.model || !state.draft || !connectionId) return
    const requestId = this.begin(id, 'describe')
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'agentJob', target: state.target }))
    if (!this.end(id, requestId)) return
    // Renamed elsewhere: the compare reads the job under its new name and lists Name as the server's change.
    if (result.ok && result.value.error?.code === 'NOT_FOUND' && !followed && await this.followRename(id)) return this.compare(id, refusal, true)
    const current = result.ok && !result.value.error ? result.value.agentJobDocument : undefined
    const latest = this.get(id)
    if (!latest) return
    // Deleted and created again under the same name: not the job the draft edits, so no compare; Reload reads the new one.
    const replaced = !!current?.job && !!latest.model?.job && current.job.jobId.toLowerCase() !== latest.model.job.jobId.toLowerCase()
    if (!current?.job || !latest.model || !latest.draft || replaced) {
      // The job is gone (or unreadable) since: the refusal says so; the draft stays for a Reload.
      this.patch(id, { phase: 'ready', error: replaced ? fallback('NOT_FOUND', jobDocumentText.replaced) : result.ok && result.value.error ? result.value.error : refusal })
      return
    }
    this.patch(id, { phase: 'ready', error: refusal, stale: { current, rows: agentJobCompare(latest.model, current, latest.draft), keepServer: [] } })
  }
  /** A conflict's choice: the server's value, or the user's (the default). */
  chooseServer(id: string, field: AgentJobField, server: boolean): void {
    const stale = this.get(id)?.stale
    if (!stale) return
    const keep = new Set(stale.keepServer)
    if (server) keep.add(field)
    else keep.delete(field)
    this.patch(id, { stale: { ...stale, keepServer: [...keep] } })
  }
  /** Reload and keep my changes: the job as read now with the user's edits on top (conflicts as chosen); Save is still the user's. */
  reloadKeep(id: string): void {
    const state = this.get(id)
    if (!state?.stale || !state.model || !state.draft) return
    const { current, keepServer } = state.stale
    const draft = rebaseAgentJobDraft(state.model, current, state.draft, new Set(keepServer))
    this.patch(id, { model: current, draft, stale: undefined, error: undefined, revision: state.revision + 1, edits: state.edits + 1, ...this.restartScheduleReads(id) })
    this.afterDraft(id)
    // Picked schedules take their guards from the shared schedules as read now, as the job's own schedules just did.
    this.ensureShared(id, true)
  }
  /** Discard mine and reload: the job as read now. */
  reloadDiscard(id: string): void {
    const state = this.get(id)
    if (!state?.stale) return
    const { current } = state.stale
    this.patch(id, { model: current, draft: initialAgentJobDraft(current), stale: undefined, error: undefined, revision: state.revision + 1, edits: state.edits + 1, ...this.restartScheduleReads(id) })
    this.afterDraft(id)
  }

  // --- Start, Start at step, Stop --------------------------------------------------------------------------------------

  canStart(id: string): boolean {
    const state = this.get(id)
    return !!state?.model?.job && this.live(id) && !state.verb && !state.live?.running && state.phase !== 'loading' && state.phase !== 'loadFailed'
  }
  canStop(id: string): boolean {
    const state = this.get(id)
    return !!state?.model?.job && this.live(id) && !state.verb && !!state.live?.running
  }
  /** Start (from the job's Start step), or once at `stepName` (sp_start_job @step_name; the Start step is not changed). */
  async start(id: string, stepName?: string): Promise<void> {
    if (!this.canStart(id)) return
    await this.verb(id, 'starting', connectionId => {
      const job = this.get(id)!.model!.job!
      return this.options.api.executeObjectAction({ action: 'startJob', connectionId, requestId: this.newId(), target: { kind: 'agentJob', name: job.name }, agentIdentity: { jobId: job.jobId }, ...stepName ? { stepName } : {} })
    }, jobDocumentText.started)
  }
  async stop(id: string): Promise<void> {
    if (!this.canStop(id)) return
    await this.verb(id, 'stopping', connectionId => {
      const job = this.get(id)!.model!.job!
      return this.options.api.executeObjectAction({ action: 'stopJob', connectionId, requestId: this.newId(), target: { kind: 'agentJob', name: job.name }, agentIdentity: { jobId: job.jobId } })
    }, jobDocumentText.stopped)
  }
  private async verb(id: string, verb: 'starting' | 'stopping', send: (connectionId: string) => Promise<ApiResult<ActionExecuteResult>>, done: string): Promise<void> {
    const connectionId = this.connectionOf(id)
    if (!connectionId) return
    this.patch(id, { verb, notice: undefined, ...this.get(id)?.error?.field ? {} : { error: undefined } })
    const result = await this.call(() => send(connectionId))
    if (this.disposed || !this.get(id)) return
    const failure = !result.ok ? fallback('SQL_ERROR', result.error) : result.value.error
    this.patch(id, { verb: undefined, ...failure ? { error: failure } : { notice: done } })
    if (!failure) this.views.get(id)?.handle.refresh()
  }
  /** The steps Start at step offers, in order. */
  steps(id: string) { return this.get(id)?.model?.steps ?? [] }

  // --- The header's live state ---------------------------------------------------------------------------------------

  private follow(id: string, jobId: string): void {
    const live = this.options.live
    const current = this.views.get(id)
    if (!live || current?.jobId === jobId.toLowerCase()) return
    current?.stop()
    this.views.delete(id)
    const connectionId = this.connectionOf(id)
    if (!connectionId) return
    let ended = false
    const owner = {
      key: 'agent-job:' + id, visible: () => this.options.documents.getSnapshot().activeId === id,
      connectionId: () => this.live(id) ? this.connectionOf(id) : undefined, closed: () => ended,
      subscribe: (listener: () => void) => { const a = this.options.connections.subscribe(listener), b = this.options.documents.subscribe(listener); return () => { a(); b() } }
    }
    const handle = live.open({ connectionId, source: agentJobsSource, args: { watch: [jobId] }, probes: [{ probe: agentWatchedProbe, intervalMs: liveProbes[agentWatchedProbe].intervalMs.default }] }, owner)
    const ticks = handle.onTick(({ tick }) => {
      const watched = tick.samples.find(sample => sample.probe === agentWatchedProbe && sample.metrics)
      if (!watched) return
      const next = jobLive(watchedSlot(watched.metrics!, 0))
      const state = this.get(id)
      if (!state || JSON.stringify(next) === JSON.stringify(state.live)) return
      this.patch(id, { live: next })
    })
    this.views.set(id, { jobId: jobId.toLowerCase(), handle, stop: () => { ended = true; ticks.dispose(); handle.dispose() } })
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
      const name = current.draft?.name || 'New Job'
      const notice = await deliverScript({ destination, text, database: current.scriptDatabase ?? 'msdb', connectionId, fileName: `${name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}.sql` }, this.options)
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
    const built = state.draft && agentJobSavable(this.problems(id)) ? this.request(state) : undefined
    if (!built) { this.patch(id, { script: { state: 'idle', message: noScriptNotice }, scriptRevision: revision }); return undefined }
    if (!this.live(id)) { this.patch(id, { script: { state: 'failed', error: { message: jobDocumentText.disconnected, code: 'CONNECTION_LOST' } }, scriptRevision: revision }); return undefined }
    const previous = this.previews.get(id)
    if (previous) this.cancel([previous])
    const requestId = this.newId()
    this.previews.set(id, requestId)
    this.patch(id, { script: { state: 'loading' } })
    const result = await this.call(() => this.options.api.scriptObjectAction({ ...built, connectionId, requestId }))
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

  canClose(id: string): string | undefined { return this.get(id)?.phase === 'saving' ? jobDocumentText.saving : undefined }
  revision(id: string): number { return this.get(id)?.edits ?? 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  closed(id: string): void {
    this.restartScheduleReads(id)
    this.scheduleReads.delete(id)
    this.scheduleGenerations.delete(id)
    this.targetBindings.forget(id)
    const request = this.requests.get(id), preview = this.previews.get(id)
    this.cancel([request?.id, preview].filter((value): value is string => !!value))
    this.requests.delete(id)
    this.previews.delete(id)
    this.clearPreviewTimer(id)
    this.views.get(id)?.stop()
    this.views.delete(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.targetBindings.clear()
    this.cancel([...this.requests.values()].map(request => request.id).concat([...this.previews.values()]))
    for (const timer of this.previewTimers.values()) this.timers.clearTimeout(timer)
    for (const view of this.views.values()) view.stop()
    this.views.clear()
    this.requests.clear()
    this.previews.clear()
    this.previewTimers.clear()
    this.registration.dispose()
    this.unsubscribe.forEach(unsubscribe => unsubscribe())
    this.clearListeners()
  }

  // --- The Schedules section (AG-6c) ----------------------------------------------------------------------------------

  /** The server's clock as the describe read it (the local clock before any read). */
  now(id: string): AgentMoment {
    const read = this.get(id)?.model?.now
    const moment = read ? momentOfText(read) : undefined
    if (moment) return moment
    const date = new Date()
    return { date: date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate(), time: date.getHours() * 10_000 + date.getMinutes() * 100 + date.getSeconds() }
  }
  /** Whether the login may change a schedule (its owner, or sysadmin) and Varia read the version a guarded save names. */
  canChangeSchedule(id: string, record: AgentScheduleRecord | undefined): boolean {
    const model = this.get(id)?.model
    if (!model || !record) return true
    return record.version !== undefined && !!record.modified && (model.sysadmin || ownsSchedule(record, model.login))
  }
  /** The record an entry was read as: the job's schedule, or a picked one as the pick read it; undefined for a new one. */
  scheduleRecord(id: string, entry: JobScheduleEntry): AgentScheduleRecord | undefined {
    if (entry.id === undefined) return undefined
    return entry.attached ? entry.base : this.get(id)?.model?.schedules?.find(record => record.id === entry.id)
  }
  selectSchedule(id: string, key: string | undefined): void {
    const state = this.get(id)
    if (!state || state.scheduleSelected === key) return
    this.patch(id, { scheduleSelected: key })
    const picked = key?.startsWith('pick:') ? Number(key.slice(5)) : undefined
    if (picked) this.ensureScheduleJobs(id, picked)
  }
  setScheduleSearch(id: string, text: string): void {
    if (!this.get(id)) return
    this.patch(id, { scheduleSearch: text })
    this.ensureShared(id)
  }
  /** The shared schedules, read once per open (a save and Reload read them again). `rebase` (Reload and keep my changes) moves picked
   *  schedules onto what this read finds. */
  ensureShared(id: string, rebase = false): void {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId || state.shared?.state === 'loading' || state.shared?.state === 'ready' || !this.live(id)) return
    this.patch(id, { shared: { state: 'loading' } })
    const generation = this.scheduleGeneration(id)
    void this.scheduleRead(id, { connectionId, dialog: 'agentSchedules', target: { kind: 'agent' } }).then(result => {
      if (!this.get(id) || this.scheduleGeneration(id) !== generation) return
      const model = result.ok ? result.value.agentSchedules : undefined
      const error = !result.ok ? result.error : result.value.error?.message
      this.patch(id, { shared: model && !error ? { state: 'ready', model } : { state: 'failed', error: error ?? jobScheduleText.listFailed } })
      const draft = this.get(id)?.draft
      if (rebase && model && !error && draft) {
        const schedules = refreshPickedSchedules(draft.schedules, model.schedules)
        if (schedules !== draft.schedules) this.updateDraft(id, { schedules })
      }
    })
  }
  /** One schedule's jobs, where the shared read has no links (below sysadmin): read once per schedule; a failed read is tried again next time. */
  ensureScheduleJobs(id: string, scheduleId: number): void {
    const state = this.get(id), connectionId = this.connectionOf(id)
    const read = state?.scheduleJobs?.[scheduleId]
    if (!state || !connectionId || state.shared?.model?.links || (read && read.state !== 'failed') || !this.live(id)) return
    this.patch(id, { scheduleJobs: { ...state.scheduleJobs, [scheduleId]: { state: 'loading' } } })
    const generation = this.scheduleGeneration(id)
    void this.scheduleRead(id, { connectionId, dialog: 'agentSchedules', target: { kind: 'agent' }, schedule: scheduleId }).then(result => {
      const current = this.get(id)
      if (!current || this.scheduleGeneration(id) !== generation) return
      const jobs = result.ok && !result.value.error ? result.value.agentSchedules?.scheduleJobs : undefined
      this.patch(id, { scheduleJobs: { ...current.scheduleJobs, [scheduleId]: jobs ? { state: 'ready', jobs } : { state: 'failed' } } })
    })
  }
  private scheduleGeneration(id: string): number { return this.scheduleGenerations.get(id) ?? 0 }
  /** Starts the Schedules section's reads over: cancels those on their way, drops what they would answer and forgets what was read. */
  private restartScheduleReads(id: string): Pick<JobDocumentState, 'shared' | 'scheduleJobs'> {
    this.cancel([...this.scheduleReads.get(id) ?? []])
    this.scheduleReads.get(id)?.clear()
    this.scheduleGenerations.set(id, this.scheduleGeneration(id) + 1)
    return { shared: undefined, scheduleJobs: undefined }
  }
  private async scheduleRead(id: string, request: { readonly connectionId: string; readonly dialog: 'agentSchedules'; readonly target: ObjectRef; readonly schedule?: number }) {
    const requestId = this.newId()
    const reads = this.scheduleReads.get(id) ?? new Set<string>()
    reads.add(requestId)
    this.scheduleReads.set(id, reads)
    try { return await this.call(() => this.options.api.describeObject({ ...request, requestId })) } finally { reads.delete(requestId) }
  }
  private setSchedules(id: string, schedules: readonly JobScheduleEntry[], selected?: string): void {
    this.updateDraft(id, { schedules })
    if (selected !== undefined && this.get(id)?.draft?.schedules === schedules) this.patch(id, { scheduleSelected: selected })
  }
  /** New schedule (named from the search when it has text): SSMS's defaults, edited in place and created when the job is saved. */
  newSchedule(id: string, name = ''): void {
    const draft = this.get(id)?.draft
    if (!draft || !this.canEdit(id)) return
    const key = `n:${this.newId()}`
    this.setSchedules(id, [...draft.schedules, { key, fields: defaultSchedule(this.now(id).date, name.trim().slice(0, 128)) }], key)
    this.patch(id, { scheduleSearch: '' })
  }
  /** Attach a shared schedule: added to the job when it is saved, guarded by the version the pick read. */
  attachSchedule(id: string, record: AgentScheduleRecord): void {
    const draft = this.get(id)?.draft
    if (!draft || !this.canEdit(id) || draft.schedules.some(entry => entry.id === record.id && !entry.remove)) return
    const kept = draft.schedules.filter(entry => entry.id !== record.id)
    const key = scheduleKey(record.id)
    // A schedule removed from this job and picked again is the job's own once more.
    const own = draft.schedules.find(entry => entry.id === record.id && !entry.attached)
    this.setSchedules(id, own ? draft.schedules.map(entry => entry === own ? { ...entry, remove: undefined } as JobScheduleEntry : entry)
      : [...kept, { key, id: record.id, attached: true, base: record, fields: scheduleFieldsOf(record) }], key)
  }
  updateSchedule(id: string, key: string, fields: AgentScheduleFields): void {
    const draft = this.get(id)?.draft
    if (!draft) return
    this.updateDraft(id, { schedules: draft.schedules.map(entry => entry.key === key ? { ...entry, fields } : entry) })
  }
  /** Remove: the job's own schedule is marked (detach by default) with Undo until Save; a new or picked one simply goes. */
  removeSchedule(id: string, key: string): void {
    const draft = this.get(id)?.draft
    const entry = draft?.schedules.find(item => item.key === key)
    if (!draft || !entry) return
    if (entry.id === undefined || entry.attached) { this.setSchedules(id, draft.schedules.filter(item => item !== entry), ''); return }
    this.updateDraft(id, { schedules: draft.schedules.map(item => item === entry ? { ...item, remove: 'detach' } : item) })
  }
  setRemoveMode(id: string, key: string, mode: 'detach' | 'delete'): void {
    const draft = this.get(id)?.draft
    if (!draft) return
    this.updateDraft(id, { schedules: draft.schedules.map(item => item.key === key && item.remove ? { ...item, remove: mode } : item) })
  }
  undoRemove(id: string, key: string): void {
    const draft = this.get(id)?.draft
    if (!draft) return
    this.updateDraft(id, { schedules: draft.schedules.map(item => item.key === key ? { key: item.key, ...item.id !== undefined ? { id: item.id } : {}, fields: item.fields } : item) })
  }
  /** Copy for this job only: the shared schedule is detached as read (any edit to it moves to the copy) and the copy, new and this job's alone, takes its place. */
  copySchedule(id: string, key: string): void {
    const draft = this.get(id)?.draft
    const entry = draft?.schedules.find(item => item.key === key)
    if (!draft || !entry || !this.canEdit(id)) return
    const record = this.scheduleRecord(id, entry)
    const copy: JobScheduleEntry = { key: `n:${this.newId()}`, fields: { ...entry.fields, name: jobScheduleText.copyName(record?.name ?? entry.fields.name) } }
    const rest = entry.attached ? draft.schedules.filter(item => item !== entry) : draft.schedules.map(item => item === entry ? { key: item.key, id: item.id, fields: record ? scheduleFieldsOf(record) : item.fields, remove: 'detach' as const } : item)
    this.setSchedules(id, [...rest, copy], copy.key)
  }

  // --- Internals -----------------------------------------------------------------------------------------------------

  private show(id: string): void { if (this.options.documents.getSnapshot().activeId !== id) this.options.documents.activate(id) }
  private patch(id: string, patch: Partial<JobDocumentState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as JobDocumentState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: JobDocumentState): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
  private connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
  live(id: string): boolean {
    const connectionId = this.connectionOf(id)
    return this.targetBindings.matchesConnection(id, connectionId) && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }
  private begin(id: string, kind: 'describe' | 'save' | 'copy'): string {
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
      // The header's view stays open: its owner's connectionId() pauses it while the connection is lost and resumes it after a reconnect.
      const request = this.requests.get(state.id), preview = this.previews.get(state.id)
      if (preview) { this.previews.delete(state.id); this.cancel([preview]) }
      if (state.live) this.patch(state.id, { live: undefined })
      if (!request || request.dropped) continue
      request.dropped = true
      this.requests.delete(state.id)
      this.cancel([request.id])
      if (request.kind === 'save') this.patch(state.id, { phase: 'ready', error: fallback('CONNECTION_LOST', jobDocumentText.lost) })
      else this.patch(state.id, { phase: state.model ? state.draft ? 'ready' : 'choosing' : 'loadFailed', copying: undefined, error: fallback('CONNECTION_LOST', jobDocumentText.disconnected) })
    }
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
/** The sections' titles as the catalogue names them (Steps, Schedules and History are later lanes). */
export const jobDocumentPages = dialogSpecs.agentJob.pages
