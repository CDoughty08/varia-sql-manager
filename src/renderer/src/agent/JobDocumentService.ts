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
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { addStep, agentStepProblems, deleteStep, initialStepsDraft, moveStep, newStepDraft, newStepKey, undoStepDeletion, withSubsystem, type AgentStepDraft, type AgentStepProblem, type StepDeletion } from '../../../shared/agent/steps.ts'
import { parseSsisCommand, ssisParameterRows, ssisProblems } from '../../../shared/agent/ssis-step.ts'
import type { LanguageParseError } from '../../../shared/agent/parse.ts'
import type { SsisPackageModel, SsisProjectModel } from '../../../shared/ssis/schema.ts'

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
  /** Steps (AG-6b): the selected step's key. */
  readonly step?: string
  /** The last delete, for its banner and Undo until Save or Reload. */
  readonly deletion?: StepDeletion
  /** The selected step's Parse: running, or its errors (none: it parsed). */
  readonly parse?: JobStepParse
  /** The SSIS step's catalog picker: SSISDB's folders, each folder's projects, and the project and package the selected step runs. */
  readonly ssis?: JobSsisPicker
}
export interface JobStepParse { readonly key: string; readonly running: boolean; readonly errors?: readonly LanguageParseError[]; readonly truncated?: boolean; readonly failure?: string }
export interface JobSsisPicker {
  readonly folders?: readonly string[]
  readonly projects: Readonly<Record<string, readonly string[]>>
  /** `folder\project` and its describe. */
  readonly project?: { readonly key: string; readonly model: SsisProjectModel }
  /** `folder\project\package` and its describe. */
  readonly package?: { readonly key: string; readonly model: SsisPackageModel }
  readonly loading?: string
  readonly error?: string
  /** The `folder\project\package` the latest loadSsisPackage asked for: a reply to an earlier request is dropped. */
  readonly wanted?: string
}
export interface JobDocumentSnapshot { readonly documents: Readonly<Record<string, JobDocumentState>> }

export interface JobDocumentServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText'>
    & Partial<Pick<VariaApi, 'languageParse' | 'describeSsis' | 'explorerChildren'>>
  /** Steps' Open in query window (AG-6b): a new query tab on the job's connection, in the step's database. */
  readonly openQuery?: (sql: string, name: string, connectionId: string, database?: string) => void
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
  { id: 'general', title: 'General' }, { id: 'steps', title: 'Steps' }, { id: 'notifications', title: 'Notifications' }, { id: 'targets', title: 'Targets' }, { id: 'alerts', title: 'Alerts' }
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
    return state?.model && state.draft ? agentJobProblems(state.model, state.draft, this.ssisProblems(state)) : []
  }
  /** The steps' problems by step and field, as the Steps section shows them (the header counts them through problems()). */
  stepProblems(id: string): AgentStepProblem[] {
    const state = this.get(id)
    if (!state?.model || !state.draft || state.model.stepsTruncated) return []
    const ssis = this.ssisProblems(state)
    return agentStepProblems(state.draft.steps, { sysadmin: state.model.sysadmin, ...state.model.proxies ? { proxies: state.model.proxies } : {}, ...ssis ? { ssis } : {}, ...state.model.job ? { original: initialStepsDraft(state.model.steps, state.model.job.startStepId) } : {} })
  }
  /** Each SSIS step's required parameters without a value, for the steps whose project and package the picker has read. */
  private ssisProblems(state: JobDocumentState): ReadonlyMap<string, readonly string[]> | undefined {
    const project = state.ssis?.project, packaged = state.ssis?.package
    if (!state.draft || !project || !packaged) return undefined
    const found = new Map<string, readonly string[]>()
    for (const step of state.draft.steps.steps) {
      if (step.subsystem !== 'SSIS') continue
      const command = parseSsisCommand(step.command)
      if (!command || `${command.folder}\\${command.project}` !== project.key || `${project.key}\\${command.package}` !== packaged.key) continue
      const messages = ssisProblems(ssisParameterRows(command, project.model.parameters, packaged.model.parameters))
      if (messages.length) found.set(step.key, messages)
    }
    return found
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

  // --- Steps (AG-6b) ---------------------------------------------------------------------------------------------------

  /** Steps can change: the job is editable and its steps were read whole. */
  canEditSteps(id: string): boolean { return this.canEdit(id) && !this.get(id)?.model?.stepsTruncated }
  /** The step the editor pane shows: the selected one, else the first. */
  selectedStep(id: string): AgentStepDraft | undefined {
    const state = this.get(id), steps = state?.draft?.steps.steps ?? []
    return steps.find(step => step.key === state?.step) ?? steps[0]
  }
  selectStep(id: string, key: string): void {
    const state = this.get(id)
    if (!state?.draft?.steps.steps.some(step => step.key === key) || state.step === key) return
    this.patch(id, { step: key, ...state.parse && state.parse.key !== key ? { parse: undefined } : {} })
  }
  /** Add step: a new step of `subsystem` after the last, selected; T-SQL in master. Its key is never the pending delete's, so Undo still
   *  finds the deleted step missing and puts it back. */
  addStepOf(id: string, subsystem = 'TSQL'): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEditSteps(id) || state.draft.steps.steps.length >= agentLimits.stepsPerJob) return
    const steps = state.draft.steps.steps
    const step = { ...newStepDraft(steps, subsystem), key: newStepKey(state.deletion ? [...steps, state.deletion.deleted] : steps) }
    this.updateDraft(id, { steps: addStep(state.draft.steps, step) })
    this.patch(id, { step: step.key, parse: undefined })
  }
  /** Moves a step to `index` (drag, Move up and Move down); go-to targets follow, being keys. */
  moveStepTo(id: string, key: string, index: number): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEditSteps(id)) return
    const moved = moveStep(state.draft.steps, key, index)
    if (moved !== state.draft.steps) this.updateDraft(id, { steps: moved })
  }
  moveStepBy(id: string, key: string, delta: number): void {
    const at = this.get(id)?.draft?.steps.steps.findIndex(step => step.key === key) ?? -1
    if (at >= 0) this.moveStepTo(id, key, at + delta)
  }
  /** Delete acts on the draft at once: steps that went to it quit reporting failure, the banner says which, and Undo puts it back. */
  deleteStepOf(id: string, key: string): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEditSteps(id)) return
    const result = deleteStep(state.draft.steps, key)
    if (!result) return
    const steps = result.draft.steps
    const next = steps[Math.min(result.deletion.position, steps.length - 1)]
    this.updateDraft(id, { steps: result.draft })
    this.patch(id, { deletion: result.deletion, step: next?.key, parse: undefined })
  }
  undoDeleteStep(id: string): void {
    const state = this.get(id)
    if (!state?.draft || !state.deletion || !this.canEditSteps(id)) return
    const deletion = state.deletion
    this.updateDraft(id, { steps: undoStepDeletion(state.draft.steps, deletion) })
    this.patch(id, { deletion: undefined, step: deletion.deleted.key })
  }
  dismissDeletion(id: string): void { if (this.get(id)?.deletion) this.patch(id, { deletion: undefined }) }
  /** One step's fields; a type change drops what the new type cannot keep. */
  updateStep(id: string, key: string, patch: Partial<Omit<AgentStepDraft, 'key' | 'from'>>): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEditSteps(id)) return
    let changed = false
    const steps = state.draft.steps.steps.map(step => {
      if (step.key !== key) return step
      const typed = patch.subsystem !== undefined ? withSubsystem(step, patch.subsystem) : step
      const { subsystem: _subsystem, ...rest } = patch
      const next = { ...typed, ...rest }
      changed = JSON.stringify(next) !== JSON.stringify(step)
      return next
    })
    if (!changed) return
    this.updateDraft(id, { steps: { ...state.draft.steps, steps } })
    if (state.parse?.key === key && patch.command !== undefined) this.patch(id, { parse: undefined })
  }
  setStartStep(id: string, key: string): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEditSteps(id) || state.draft.steps.startKey === key || !state.draft.steps.steps.some(step => step.key === key)) return
    this.updateDraft(id, { steps: { ...state.draft.steps, startKey: key } })
  }
  /** Parse: ScriptDom's parse of the step's T-SQL in the backend (`language.parse`); nothing runs. */
  async parseStep(id: string, key: string): Promise<void> {
    const step = this.get(id)?.draft?.steps.steps.find(item => item.key === key)
    const parse = this.options.api.languageParse
    if (!step || step.subsystem !== 'TSQL') return
    if (!parse) { this.patch(id, { parse: { key, running: false, failure: 'Parse is not available.' } }); return }
    const text = step.command
    this.patch(id, { parse: { key, running: true } })
    const result = await this.call(() => parse({ text }))
    const current = this.get(id)
    if (this.disposed || !current || current.parse?.key !== key || !current.parse.running) return
    this.patch(id, { parse: result.ok ? { key, running: false, errors: result.value.errors, truncated: result.value.truncated } : { key, running: false, failure: result.error } })
  }
  /** Open in query window: the step's T-SQL in a new query tab on the job's connection and the step's database, to test it there (not as the job). */
  openStepInQuery(id: string, key: string): void {
    const state = this.get(id), connectionId = this.connectionOf(id)
    const step = state?.draft?.steps.steps.find(item => item.key === key)
    if (!step || !connectionId || !this.options.openQuery) return
    this.options.openQuery(step.command, `${step.name || 'Step'}.sql`, connectionId, step.subsystem === 'TSQL' && step.databaseName ? step.databaseName : undefined)
  }

  // --- The SSIS step's catalog picker ------------------------------------------------------------------------------

  private patchSsis(id: string, patch: Partial<JobSsisPicker>): void {
    const ssis = this.get(id)?.ssis ?? { projects: {} }
    const next = { ...ssis, ...patch } as JobSsisPicker & Record<string, unknown>
    for (const name of Object.keys(patch)) if (next[name] === undefined) delete next[name]
    this.patch(id, { ssis: next })
  }
  /** SSISDB's folders, as Object Explorer lists them below the catalog. */
  async loadSsisFolders(id: string): Promise<void> {
    const connectionId = this.connectionOf(id), children = this.options.api.explorerChildren
    if (!connectionId || !children || this.get(id)?.ssis?.folders) return
    this.patchSsis(id, { loading: 'folders', error: undefined })
    const result = await this.call(() => children({ connectionId, requestId: this.newId(), node: { type: 'object', object: { kind: 'ssisCatalog', name: 'SSISDB' } } }))
    if (this.disposed || !this.get(id)) return
    const failure = !result.ok ? result.error : result.value.error?.message
    this.patchSsis(id, failure ? { loading: undefined, error: failure } : { loading: undefined, folders: result.ok ? result.value.nodes.map(node => node.label) : [] })
  }
  async loadSsisProjects(id: string, folder: string): Promise<void> {
    const connectionId = this.connectionOf(id), children = this.options.api.explorerChildren
    if (!connectionId || !children || this.get(id)?.ssis?.projects[folder]) return
    this.patchSsis(id, { loading: folder, error: undefined })
    const result = await this.call(() => children({ connectionId, requestId: this.newId(), node: { type: 'folder', owner: { kind: 'ssisFolder', name: folder }, folder: 'ssisProjects' } }))
    if (this.disposed || !this.get(id)) return
    const failure = !result.ok ? result.error : result.value.error?.message
    const projects = this.get(id)?.ssis?.projects ?? {}
    this.patchSsis(id, failure ? { loading: undefined, error: failure } : { loading: undefined, projects: { ...projects, [folder]: result.ok ? result.value.nodes.map(node => node.label) : [] } })
  }
  /** The project's describe (its packages, parameters and environment references) and the package's (its parameters). */
  async loadSsisPackage(id: string, folder: string, project: string, packageName?: string): Promise<void> {
    const connectionId = this.connectionOf(id), describe = this.options.api.describeSsis
    if (!connectionId || !describe) return
    const projectKey = `${folder}\\${project}`, wanted = `${projectKey}\\${packageName ?? ''}`
    this.patchSsis(id, { wanted })
    const current = () => !this.disposed && this.get(id)?.ssis?.wanted === wanted
    if (this.get(id)?.ssis?.project?.key !== projectKey) {
      this.patchSsis(id, { loading: projectKey, error: undefined })
      const result = await this.call(() => describe({ connectionId, requestId: this.newId(), view: 'project', target: { kind: 'ssisProject', name: project, ssisFolder: folder } }))
      if (!current()) return
      const model = result.ok && result.value.model?.view === 'project' ? result.value.model : undefined
      if (!model) { this.patchSsis(id, { loading: undefined, error: !result.ok ? result.error : result.value.error?.message ?? 'The project could not be read.' }); return }
      this.patchSsis(id, { loading: undefined, project: { key: projectKey, model }, package: undefined })
    }
    if (!packageName) return
    const packageKey = `${projectKey}\\${packageName}`
    if (this.get(id)?.ssis?.package?.key === packageKey) return
    this.patchSsis(id, { loading: packageKey, error: undefined })
    const result = await this.call(() => describe({ connectionId, requestId: this.newId(), view: 'package', target: { kind: 'ssisPackage', name: packageName, ssisFolder: folder, ssisProject: project } }))
    if (!current()) return
    const model = result.ok && result.value.model?.view === 'package' ? result.value.model : undefined
    this.patchSsis(id, model ? { loading: undefined, package: { key: packageKey, model } } : { loading: undefined, error: !result.ok ? result.error : result.value.error?.message ?? 'The package could not be read.' })
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
      notice, script: { state: 'idle', message: noScriptNotice }, scriptRevision: undefined, deletion: undefined, parse: undefined,
      ...current.step && !model.steps.some(step => `s${step.id}` === current.step) ? { step: undefined } : {}
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
      this.patch(id, { phase: 'loading', target, changes: 0, deletion: undefined })
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
    // A pending delete's Undo would bring its step back with the id it was read under, which another session may since have changed.
    this.patch(id, { model: current, draft, stale: undefined, error: undefined, revision: state.revision + 1, edits: state.edits + 1, deletion: undefined })
    this.afterDraft(id)
  }
  /** Discard mine and reload: the job as read now. */
  reloadDiscard(id: string): void {
    const state = this.get(id)
    if (!state?.stale) return
    const { current } = state.stale
    this.patch(id, { model: current, draft: initialAgentJobDraft(current), stale: undefined, error: undefined, revision: state.revision + 1, edits: state.edits + 1, deletion: undefined })
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
  /** The job's connection, which the step editor's language service uses. */
  connectionId(id: string): string | undefined { return this.connectionOf(id) }
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
