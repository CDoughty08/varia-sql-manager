// The SQL Server Agent job document (AG-6a, docs/sql-server-agent.md › Job document): one tab per job and connection, opened from
// Object Explorer's Properties, Job Activity Monitor, Ctrl+Q and the palette, and New Job's tab with its start panel (Blank, or Copy an
// existing job). The describe reads the job and what its sections offer; the draft is edited here; Save sends one `agentJob` action
// that the backend runs as one transaction under the STALE guard, whose refusal opens a field-by-field compare. Problems warn and only
// a missing or too long value stops Save. The header follows the job's state live through the agent.jobs source's watched probe
// (the backend schedules every read) and runs Start, Start at step and Stop through AG-2's verbs. Failures are values in the snapshot.
import { actionLimits, dialogSpecs } from '../../../shared/actions/catalog.ts'
import { noScriptNotice } from '../../../shared/actions/database.ts'
import {
  agentJobChangeCount, agentJobCompare, agentJobFieldSection, agentJobProblems, agentJobSavable, agentJobSave, agentJobTabName, changedAgentJobFields,
  initialAgentJobDraft, rebaseAgentJobDraft, type AgentJobCompareRow, type AgentJobDocumentModel, type AgentJobDraft, type AgentJobField, type AgentJobProblem, type AgentJobSection
} from '../../../shared/actions/agent-job.ts'
import { jobErrorField, type ActionError, type ActionExecuteResult, type ActionRequest } from '../../../shared/actions/schema.ts'
import {
  jobScheduleText, momentOfText, ownsSchedule, refreshPickedSchedules, scheduleFieldsOf, scheduleKey, type AgentScheduleJob, type AgentScheduleRecord, type AgentSchedulesModel, type JobScheduleEntry
} from '../../../shared/actions/agent-schedule.ts'
import { defaultSchedule, msdbTrim, type AgentMoment, type AgentScheduleFields } from '../../../shared/agent/schedule.ts'
import { agentJobsSource, agentWatchedProbe, watchedGoneStatus, watchedServerNow, watchedSlot, type WatchedSample } from '../../../shared/agent/jobs.ts'
import { isStepScriptSubsystem, stepScriptText } from '../../../shared/agent/step-file.ts'
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
import { JobHistoryService } from './JobHistoryService'
import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { addStep, agentStepProblems, deleteStep, initialStepsDraft, moveStep, newStepDraft, newStepKey, undoStepDeletion, withSubsystem, type AgentStepDraft, type AgentStepProblem, type StepDeletion } from '../../../shared/agent/steps.ts'
import { parseSsisCommand, ssisParameterRows, ssisProblems } from '../../../shared/agent/ssis-step.ts'
import type { LanguageParseError } from '../../../shared/agent/parse.ts'
import type { SsisPackageModel, SsisProjectModel } from '../../../shared/ssis/schema.ts'
import { decodeKeptState, encodeKeptState, keptAgentText, sameShape } from '../../../shared/agent/kept.ts'
import type { KeptCustomDocument } from '../services/documents'
import type { QueryDocument } from '../documents'
import { liveConnectionOn } from './kept-documents'
import {
  applyReplace, copiedScheduleKey, createFromCompare, createFromDraft, createFromLimits, createFromProblems, createFromText, jobCopySource, replaceMatches, withCopyScheduleChoice,
  type CopyCompareRow, type CopyScheduleChoice, type JobCopySource, type ReplaceMatch
} from '../../../shared/agent/create-from.ts'
import {
  addSeveralRow, createSeveralLimits, createSeveralText, duplicateSeveralRow, fillSeveralNames, pasteSeveralRows, removeSeveralRow, resetSeveralDifference, severalChecks, severalContext,
  severalEditorDraft, severalLocked, severalRowDraft, startSeveral, withSeveralCell, withSeveralColumn, withSeveralEdited, type SeveralCheck, type SeveralContext, type SeveralResult, type SeveralTable
} from '../../../shared/agent/create-several.ts'

export type JobDocumentPhase = 'loading' | 'loadFailed' | 'choosing' | 'ready' | 'saving'
/** The header's live state from the watched probe: running (with its step), idle, or a job msdb no longer has. */
/** While running, `started` and `now` are the run's start and the server's clock (yyyymmddhhmmss, server time), where readable: History's elapsed time (AG-6d). */
export interface JobLive {
  readonly running: boolean; readonly retrying?: boolean; readonly step?: number; readonly steps?: number; readonly lastOutcome?: number; readonly gone?: boolean
  readonly started?: number; readonly now?: number
}
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
  /** A New Job's STALE re-read of the shared schedules is on its way: Save waits for it, so its picks and message belong to that save. */
  readonly rebasing?: true
  /** Steps (AG-6b): the selected step's key. */
  readonly step?: string
  /** The last delete, for its banner and Undo until Save or Reload. */
  readonly deletion?: StepDeletion
  /** The selected step's Parse: running, or its errors (none: it parsed). */
  readonly parse?: JobStepParse
  /** The selected step's Load from file… (AG-11): main's open dialog is up, or why the file could not be loaded. */
  readonly stepFile?: JobStepFile
  /** The SSIS step's catalog picker: SSISDB's folders, each folder's projects, and the project and package the selected step runs. */
  readonly ssis?: JobSsisPicker
  /** Reopened by hot exit or AutoRecover (AG-6g) and not read since: the model is the one the draft began from. Once its target connects,
   *  the job is read again and the draft put on top (a job changed since opens the compare). */
  readonly restored?: true
  /** Create Job Like This (AG-6e): the job this New Job copies, which Changes from source and Compare with source measure from. */
  readonly source?: JobCopySource
  /** The job Create Job Like This opened this tab to copy, until New Job's describe lands and the copy is read. */
  readonly like?: string
  /** Replace across the copy: the texts, and the preview of the draft revision it was made on with the matches chosen. */
  readonly replace?: JobReplace
  /** Compare with source is open. */
  readonly compareOpen?: true
  /** Create several (AG-6f): the copy turned into a table, one row per new job. The draft stays as the template it was made from. */
  readonly several?: JobSeveral
  /** A Create several row opened in the full editor: the table's document and the row its edits go back to. */
  readonly row?: { readonly table: string; readonly key: string }
}
/** Create several's state: the table, the selected row, the open fill panel, and where Review and create is. */
export interface JobSeveral {
  readonly table: SeveralTable
  readonly selected?: string
  readonly phase: 'table' | 'review' | 'creating' | 'done'
  /** Columns, Paste rows or Fill names, open above the table. */
  readonly panel?: 'columns' | 'paste' | 'fill'
  readonly paste?: string
  readonly pattern?: string
  /** The rows the last Create left out, with why, for the results. */
  readonly skipped?: readonly { readonly key: string; readonly reason: string }[]
  /** Create: the row being sent, of how many. */
  readonly progress?: { readonly at: number; readonly count: number }
  readonly enabling?: true
  readonly notice?: string
}
export interface JobReplace {
  readonly find: string
  readonly with: string
  readonly matchCase: boolean
  readonly preview?: { readonly revision: number; readonly matches: readonly ReplaceMatch[]; readonly more: boolean; readonly chosen: readonly string[] }
}
export interface JobStepFile { readonly key: string; readonly running: boolean; readonly failure?: string }
export interface JobStepParse { readonly key: string; readonly running: boolean; readonly errors?: readonly LanguageParseError[]; readonly truncated?: boolean; readonly failure?: string }
export interface JobSsisPicker {
  readonly folders?: readonly string[]
  readonly projects: Readonly<Record<string, readonly string[]>>
  /** Project describes by `folder\project`, and package describes by `folder\project\package`: browsing the tree never loses the selected
   *  step's, and a late reply only fills its own entry. */
  readonly projectModels: Readonly<Record<string, SsisProjectModel>>
  readonly packageModels: Readonly<Record<string, SsisPackageModel>>
  /** The project the tree has open (`folder\project`); the selected step's when the user has opened none. */
  readonly open?: string
  readonly loading?: string
  readonly error?: string
}
/** The shared schedules a job's Schedules section offers to attach, as one `agentSchedules` describe read them. */
export interface SharedSchedules { readonly state: 'loading' | 'ready' | 'failed'; readonly model?: AgentSchedulesModel; readonly error?: string }
export interface ScheduleJobsRead { readonly state: 'loading' | 'ready' | 'failed'; readonly jobs?: readonly AgentScheduleJob[] }
export interface JobDocumentSnapshot { readonly documents: Readonly<Record<string, JobDocumentState>> }

export interface JobDocumentServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText'>
    & Partial<Pick<VariaApi, 'languageParse' | 'describeSsis' | 'explorerChildren' | 'agentHistoryMessage' | 'openAgentStepScript'>>
  /** Steps' Open in query window (AG-6b): a new query tab on the job's connection, in the step's database. */
  readonly openQuery?: (sql: string, name: string, connectionId: string, database?: string) => void
  /** History's SSIS execution link (AG-13): the SSIS execution messages view on the job's connection. */
  readonly openSsisExecution?: (connectionId: string, executionId: number) => void
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'update' | 'setDirty' | 'activate' | 'getSnapshot' | 'subscribe' | 'close'> & Partial<Pick<DocumentService, 'openKeptCustom'>> & DeliverScriptDeps['documents']
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
  replaced: 'The job was deleted and another job now has its name, so your changes were not saved. Reload opens the new job; your changes are discarded.',
  pickedChanged: 'A schedule you attached was changed or deleted since it was read, so the job was not created. Those still attached now show the server’s version with your edits kept: check them and save again.',
  pickedUnread: (error: string) => `A schedule you attached was changed or deleted since it was read, so the job was not created, and the shared schedules could not be read again: ${error} Save again to retry.`,
  closed: 'The connection is closed.'
} as const
export const jobSections: readonly { readonly id: AgentJobSection; readonly title: string }[] = [
  { id: 'general', title: 'General' }, { id: 'steps', title: 'Steps' }, { id: 'schedules', title: 'Schedules' }, { id: 'notifications', title: 'Notifications' }, { id: 'targets', title: 'Targets' },
  { id: 'alerts', title: 'Alerts' }, { id: 'history', title: 'History' }
]
/** Create Job Like This's first section (AG-6e): it leads the job's sections while the document is a copy. */
export const jobCopySection = 'changes'
const fallback = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: code !== 'STALE' && code !== 'NOT_FOUND' })

/** The header's state out of a watched slot. */
export function jobLive(sample: WatchedSample | undefined, now?: number): JobLive | undefined {
  if (!sample || sample.status === undefined) return undefined
  if (sample.status === watchedGoneStatus) return { running: false, gone: true }
  const running = [1, 2, 3, 7].includes(sample.status)
  return {
    running, ...running ? { step: sample.step || undefined, steps: sample.steps || undefined, retrying: sample.status === 3 } : {},
    ...running && sample.started && now ? { started: sample.started, now } : {}, ...sample.lastOutcome !== undefined ? { lastOutcome: sample.lastOutcome } : {}
  }
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
  /** Create several's columns, built once per table from its template. */
  private readonly contexts = new Map<string, { readonly template: AgentJobDraft; readonly context: SeveralContext }>()
  private disposed = false
  /** The History section of each job document (AG-6d). */
  readonly history: JobHistoryService

  constructor(private readonly options: JobDocumentServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.registration = options.documents.registerProvider(this)
    const changed = () => { try { this.connectionsChanged(); this.readRestored() } catch (failure) { onUnexpectedError(failure) } }
    this.unsubscribe = [options.connections.subscribe(changed), options.documents.subscribe(changed)]
    // History (AG-6d): its view runs while the document shows with History open.
    this.history = new JobHistoryService({
      api: options.api, ...options.live ? { live: options.live } : {}, ...options.openSsisExecution ? { openSsisExecution: options.openSsisExecution } : {}, newId: this.newId, connectionOf: id => this.live(id) ? this.connectionOf(id) : undefined,
      visible: id => this.historyShows(id),
      subscribe: listener => { const a = options.connections.subscribe(listener), b = options.documents.subscribe(listener), c = this.subscribe(listener); return () => { a(); b(); c() } }
    })
  }

  get(id: string): JobDocumentState | undefined { return this.getSnapshot().documents[id] }
  /** The document is the active one and its History section is open. */
  private historyShows(id: string): boolean { return this.options.documents.getSnapshot().activeId === id && !!this.get(id) && !this.get(id)!.frame.collapsed.includes('history') }

  /** A job's document: brought forward if open on this connection, otherwise a tab opens at once, loading. */
  openJob(connectionId: string, name: string): string {
    const connection = this.connection(connectionId)
    const existing = Object.values(this.getSnapshot().documents).find(state => state.target.kind === 'agentJob' && state.target.name === name && this.connectionOf(state.id) === connectionId && this.targetBindings.matchesConnection(state.id, connectionId))
    if (existing) { this.options.documents.activate(existing.id); return existing.id }
    return this.create(connection, { kind: 'agentJob', name })
  }
  /** New Job: a tab with the start panel (Blank, or Copy an existing job); nothing is created until Save. */
  newJob(connectionId: string): string { return this.create(this.connection(connectionId), { kind: 'agent' }) }
  /** Create Job Like This (AG-6e): New Job's tab, filled from `name`'s describe once New Job's own lands, with Changes from source first. */
  createLike(connectionId: string, name: string): string { return this.create(this.connection(connectionId), { kind: 'agent' }, name) }
  private connection(connectionId: string): LiveConnection {
    if (this.disposed) throw new Error('The job document is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    return connection
  }
  private create(connection: LiveConnection, target: ObjectRef, like?: string): string {
    const document = this.options.documents.openCustom('agentJob', agentJobTabName(target.kind === 'agentJob' ? target.name : undefined), connection.id, 'msdb')
    this.targetBindings.bind(document.id, connection.id)
    this.put({
      id: document.id, target, server: connection.displayName || connection.server, ...connection.login ? { login: connection.login } : {}, phase: 'loading', revision: 0, edits: 0, changes: 0,
      frame: initialFrameState(jobSections), script: { state: 'idle', message: noScriptNotice }, ...like ? { like, copying: like } : {}
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
    const draft = createFromDraft(source, current.model.login, current.model.sysadmin)
    // Changes from source comes first and is where the copy opens (AG-6e).
    this.patch(id, { phase: 'ready', copying: undefined, draft, revision: current.revision + 1, edits: current.edits + 1, source: jobCopySource(source), replace: undefined, compareOpen: undefined,
      frame: { ...current.frame, section: jobCopySection } })
    this.afterDraft(id)
  }

  // --- Editing -------------------------------------------------------------------------------------------------------

  canEdit(id: string): boolean {
    const state = this.get(id)
    return !!state?.model && !!state.draft && state.phase === 'ready' && !state.model.readOnly && !state.stale && !this.rowPaused(id)
  }
  updateDraft(id: string, patch: Partial<AgentJobDraft>): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEdit(id)) return
    const draft = { ...state.draft, ...patch }
    const errorField = jobErrorField(state.error)
    const fieldError = errorField && changedAgentJobFields(state.draft, draft).includes(errorField)
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
    return state?.model && state.draft ? [...agentJobProblems(state.model, state.draft, this.ssisProblems(state)), ...state.source ? createFromProblems(state.source) : []] : []
  }
  /** The steps' problems by step and field, as the Steps section shows them (the header counts them through problems()). */
  stepProblems(id: string): AgentStepProblem[] {
    const state = this.get(id)
    if (!state?.model || !state.draft || state.model.stepsTruncated) return []
    const ssis = this.ssisProblems(state)
    return agentStepProblems(state.draft.steps, { sysadmin: state.model.sysadmin, ...state.model.proxies ? { proxies: state.model.proxies } : {}, ...ssis ? { ssis } : {}, ...state.model.job ? { original: initialStepsDraft(state.model.steps, state.model.job.startStepId) } : {} })
  }
  /** Each SSIS step's required parameters without a value, for the steps whose project and package the picker has read. */
  private ssisProblems(state: JobDocumentState, draft = state.draft): ReadonlyMap<string, readonly string[]> | undefined {
    const ssis = state.ssis
    if (!draft || !ssis) return undefined
    const found = new Map<string, readonly string[]>()
    for (const step of draft.steps.steps) {
      if (step.subsystem !== 'SSIS') continue
      const command = parseSsisCommand(step.command)
      const project = command && ssis.projectModels[`${command.folder}\\${command.project}`], packaged = command && ssis.packageModels[`${command.folder}\\${command.project}\\${command.package}`]
      if (!command || !project || !packaged) continue
      const messages = ssisProblems(ssisParameterRows(command, project.parameters, packaged.parameters))
      if (messages.length) found.set(step.key, messages)
    }
    return found
  }
  /** Each section with an error or warning on it, or a save error landed on one of its fields. */
  problemSections(id: string): Set<AgentJobSection> {
    const state = this.get(id)
    const sections = new Set(this.problems(id).map(problem => agentJobFieldSection[problem.field]))
    const errorField = jobErrorField(state?.error)
    if (errorField) sections.add(agentJobFieldSection[errorField])
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
    // A Create several row's full editor: its edits go straight back to the row, so the tab holds nothing unsaved of its own.
    if (state.row && this.syncRow(id)) { this.patch(id, { changes: 0 }); this.options.documents.setDirty(id, false); this.schedulePreview(id); return }
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
    // A refused file's message belongs to the step it was refused for, as Parse's does (a running load stays, and drops its answer itself).
    this.patch(id, { step: key, ...state.parse && state.parse.key !== key ? { parse: undefined } : {}, ...state.stepFile && !state.stepFile.running && state.stepFile.key !== key ? { stepFile: undefined } : {} })
  }
  /** Add step: a new step of `subsystem` after the last, selected; T-SQL in master. Its key is never the pending delete's, so Undo still
   *  finds the deleted step missing and puts it back. */
  addStepOf(id: string, subsystem = 'TSQL'): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEditSteps(id) || state.draft.steps.steps.length >= agentLimits.stepsPerJob) return
    const steps = state.draft.steps.steps
    const step = { ...newStepDraft(steps, subsystem), key: newStepKey(state.deletion ? [...steps, state.deletion.deleted] : steps) }
    this.updateDraft(id, { steps: addStep(state.draft.steps, step) })
    this.patch(id, { step: step.key, parse: undefined, ...state.stepFile?.running ? {} : { stepFile: undefined } })
  }
  /** Moves a step to `index` (drag, Move up and Move down); go-to targets follow, being keys. */
  moveStepTo(id: string, key: string, index: number): void {
    const state = this.get(id)
    if (!state?.draft || !this.canEditSteps(id)) return
    const moved = moveStep(state.draft.steps, key, index)
    if (moved === state.draft.steps) return
    // The step shown by default (the first, none picked) stays shown as it moves, rather than whichever step becomes first.
    const shown = this.selectedStep(id)?.key
    this.updateDraft(id, { steps: moved })
    if (shown && state.step !== shown) this.patch(id, { step: shown })
  }
  moveStepBy(id: string, key: string, delta: number): void {
    const at = this.get(id)?.draft?.steps.steps.findIndex(step => step.key === key) ?? -1
    if (at >= 0) this.moveStepTo(id, key, at + delta)
  }
  /** Move Step Up and Move Step Down (AG-10, Alt+Up and Alt+Down): the selected step can move one place that way. */
  canMoveSelectedStep(id: string, delta: -1 | 1): boolean {
    const steps = this.get(id)?.draft?.steps.steps ?? [], selected = this.selectedStep(id)
    const at = selected ? steps.indexOf(selected) : -1
    return this.canEditSteps(id) && at >= 0 && at + delta >= 0 && at + delta < steps.length
  }
  moveSelectedStep(id: string, delta: -1 | 1): void {
    const selected = this.selectedStep(id)
    if (selected && this.canMoveSelectedStep(id, delta)) this.moveStepBy(id, selected.key, delta)
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
    this.patch(id, { deletion: result.deletion, step: next?.key, parse: undefined, ...state.stepFile?.running ? {} : { stepFile: undefined } })
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
    if (state.stepFile?.key === key && !state.stepFile.running && (patch.command !== undefined || patch.subsystem !== undefined)) this.patch(id, { stepFile: undefined })
  }
  /** Load from file… (AG-11, SSMS's Open… on a CmdExec or PowerShell step): main's open dialog and read (`openAgentStepScript`). Resolves the
   *  file's text for the step's editor to put in as one undoable edit, or undefined when cancelled, refused (said under the command) or when
   *  another step was selected, the step's type changed or the job was read again while the dialog was up (a popout's dialog is not modal
   *  to it), so the text never lands in a step the user is not looking at. */
  async loadStepScript(id: string, key: string): Promise<string | undefined> {
    const state = this.get(id), step = state?.draft?.steps.steps.find(item => item.key === key), open = this.options.api.openAgentStepScript
    if (!state || !step || !isStepScriptSubsystem(step.subsystem) || !this.canEditSteps(id) || state.stepFile?.running) return
    if (!open) { this.patch(id, { stepFile: { key, running: false, failure: stepScriptText.unavailable } }); return }
    const subsystem = step.subsystem, model = state.model
    // This load's own entry: a re-read clears it, and a later load's entry is another object, so an answer that comes back after either
    // (a popout's dialogs queue in main) touches nothing.
    const started: JobStepFile = { key, running: true }
    this.patch(id, { stepFile: started })
    const result = await this.call(() => open(subsystem))
    const current = this.get(id)
    if (this.disposed || !current || current.stepFile !== started) return
    const now = current.draft?.steps.steps.find(item => item.key === key)
    // Still the step the user is looking at, as it was: otherwise the answer, a refusal included, goes nowhere.
    const same = current.model === model && now?.subsystem === subsystem && this.selectedStep(id)?.key === key
    if (!result.ok) { this.patch(id, { stepFile: same ? { key, running: false, failure: result.error } : undefined }); return }
    // Edit rights lost meanwhile (a save still running, the job gone stale): said, so the choice does not vanish without a word.
    const locked = result.value !== null && same && !this.canEditSteps(id)
    this.patch(id, { stepFile: locked ? { key, running: false, failure: stepScriptText.locked } : undefined })
    if (result.value === null || !same || !this.canEditSteps(id)) return
    return result.value
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
    const ssis = this.get(id)?.ssis ?? { projects: {}, projectModels: {}, packageModels: {} }
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
  async loadSsisPackage(id: string, folder: string, project: string, packageName?: string, browse = false): Promise<void> {
    const connectionId = this.connectionOf(id), describe = this.options.api.describeSsis
    if (!connectionId || !describe) return
    const projectKey = `${folder}\\${project}`
    if (browse) this.patchSsis(id, { open: projectKey })
    if (!this.get(id)?.ssis?.projectModels[projectKey]) {
      this.patchSsis(id, { loading: projectKey, error: undefined })
      const result = await this.call(() => describe({ connectionId, requestId: this.newId(), view: 'project', target: { kind: 'ssisProject', name: project, ssisFolder: folder } }))
      if (this.disposed || !this.get(id)) return
      const model = result.ok && result.value.model?.view === 'project' ? result.value.model : undefined
      if (!model) { this.patchSsis(id, { loading: undefined, error: !result.ok ? result.error : result.value.error?.message ?? 'The project could not be read.' }); return }
      this.patchSsis(id, { loading: undefined, projectModels: { ...this.get(id)?.ssis?.projectModels, [projectKey]: model } })
    }
    if (!packageName) return
    const packageKey = `${projectKey}\\${packageName}`
    if (this.get(id)?.ssis?.packageModels[packageKey]) return
    this.patchSsis(id, { loading: packageKey, error: undefined })
    const result = await this.call(() => describe({ connectionId, requestId: this.newId(), view: 'package', target: { kind: 'ssisPackage', name: packageName, ssisFolder: folder, ssisProject: project } }))
    if (this.disposed || !this.get(id)) return
    const model = result.ok && result.value.model?.view === 'package' ? result.value.model : undefined
    this.patchSsis(id, model ? { loading: undefined, packageModels: { ...this.get(id)?.ssis?.packageModels, [packageKey]: model } } : { loading: undefined, error: !result.ok ? result.error : result.value.error?.message ?? 'The package could not be read.' })
  }

  // --- Reading -------------------------------------------------------------------------------------------------------

  canReload(id: string): boolean {
    const state = this.get(id)
    // Create several's table and its rows' editors are not a job msdb has: a read would start them over as a blank New Job.
    return !!state && this.live(id) && state.phase !== 'saving' && state.phase !== 'loading' && !state.copying && !state.several && !state.row
  }
  /** Reload: the job read again; the draft's changes go (the tab's close prompt is the guard for unsaved work). */
  reload(id: string): void {
    if (!this.canReload(id)) return
    this.patch(id, { phase: 'loading', error: undefined, notice: undefined, stale: undefined })
    void this.describe(id)
  }
  /** With `kept` (a reopened document's first read, AG-6g), the user's draft is put on the job as read now rather than replaced. */
  private async describe(id: string, notice?: string, followed = false, kept?: { readonly model: AgentJobDocumentModel; readonly draft: AgentJobDraft }): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return
    const requestId = this.begin(id, 'describe')
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: 'agentJob', target: state.target }))
    if (!this.end(id, requestId)) return
    const failure = !result.ok ? fallback('SQL_ERROR', result.error) : result.value.error
    const model = result.ok ? result.value.agentJobDocument : undefined
    if (failure?.code === 'NOT_FOUND' && !followed && await this.followRename(id)) return this.describe(id, notice, true, kept)
    const current = this.get(id)
    if (!current) return
    if (failure || !model) {
      const shown = failure ?? fallback('NOT_FOUND', jobDocumentText.readFailed)
      this.patch(id, { phase: current.model ? 'ready' : 'loadFailed', ...current.like ? { like: undefined, copying: undefined } : {}, error: notice ? { ...shown, message: `${jobDocumentText.savedUnread} ${shown.message}` } : shown })
      return
    }
    if (kept) { this.restoreOn(id, kept, model); return }
    const create = !model.job
    const like = create ? current.like : undefined
    this.patch(id, {
      phase: create ? 'choosing' : 'ready', model, draft: create ? undefined : initialAgentJobDraft(model), revision: current.revision + 1, changes: 0, error: undefined, stale: undefined,
      notice, script: { state: 'idle', message: noScriptNotice }, scriptRevision: undefined, deletion: undefined, parse: undefined, stepFile: undefined,
      step: this.stepFollowing(current, model.steps.map(step => ({ key: `s${step.id}`, name: step.name }))),
      // The shared schedules and their jobs are read again when the section next asks: a save may have changed them.
      ...this.restartScheduleReads(id), scheduleSelected: undefined,
      // A read starts the document over: a copy's source and its Replace and Compare go with the draft (AG-6e).
      source: undefined, replace: undefined, compareOpen: undefined, like: undefined,
      ...current.frame.section === jobCopySection ? { frame: { ...current.frame, section: jobSections[0]!.id } } : {}
    })
    this.options.documents.setDirty(id, false)
    if (like) void this.startCopy(id, like)
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
    if (state.several || this.rowLinked(id)) return false
    return !state.rebasing && (!state.model.job || state.changes > 0) && agentJobSavable(this.problems(id))
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
    // A new job has no version of its own: only an attached schedule's guard can refuse it. Its pick is read again and moved onto the
    // schedules as they are now (Reload would discard the new job), so the next Save names their versions. The message, set once that
    // read lands, says what moved or why nothing did; it names no field, so moving the picks does not clear it.
    if (!state.model.job) {
      this.patch(id, { phase: 'ready', error: { code: refusal.code, retryable: refusal.retryable, message: refusal.message }, ...this.restartScheduleReads(id) })
      if (this.ensureShared(id, true, refusal)) { if (this.get(id)?.shared?.state === 'loading') this.patch(id, { rebasing: true }) }
      else this.patch(id, { error: { code: refusal.code, retryable: refusal.retryable, message: jobDocumentText.pickedUnread(jobDocumentText.closed) } })
      return
    }
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
    this.patch(id, { model: current, draft, stale: undefined, error: undefined, revision: state.revision + 1, edits: state.edits + 1, deletion: undefined, parse: undefined, stepFile: undefined,
      step: this.stepFollowing(state, draft.steps.steps), ...this.restartScheduleReads(id) })
    this.afterDraft(id)
    // Picked schedules take their guards from the shared schedules as read now, as the job's own schedules just did; Save waits for it.
    if (this.ensureShared(id, true) && this.get(id)?.shared?.state === 'loading') this.patch(id, { rebasing: true })
  }
  /** Discard mine and reload: the job as read now. */
  reloadDiscard(id: string): void {
    const state = this.get(id)
    if (!state?.stale) return
    const { current } = state.stale
    const draft = initialAgentJobDraft(current)
    this.patch(id, { model: current, draft, stale: undefined, error: undefined, revision: state.revision + 1, edits: state.edits + 1, deletion: undefined, parse: undefined, stepFile: undefined,
      step: this.stepFollowing(state, draft.steps.steps), ...this.restartScheduleReads(id) })
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
      const next = jobLive(watchedSlot(watched.metrics!, 0), watchedServerNow(watched.metrics!))
      const state = this.get(id)
      if (!state || JSON.stringify(next) === JSON.stringify(state.live)) return
      // The server clock alone moves every sample: it redraws the document only while History shows its elapsed time.
      const moved = JSON.stringify({ ...next, now: undefined }) !== JSON.stringify({ ...state.live, now: undefined })
      if (!moved && !this.historyShows(id)) return
      this.patch(id, { live: next })
      // A step ended or the run did: History, while it shows, reads it now rather than at its next sample (event-driven, not a timer); hidden, it
      // stays paused and samples afresh when it shows again.
      if (moved && this.historyShows(id) && (next?.step !== state.live?.step || next?.running !== state.live?.running)) this.history.refresh(id)
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

  canClose(id: string): string | undefined {
    const state = this.get(id)
    return state?.phase === 'saving' ? jobDocumentText.saving : state?.several?.phase === 'creating' || state?.several?.enabling ? createSeveralText.busy : undefined
  }

  // --- Hot exit and AutoRecover (AG-6g) --------------------------------------------------------------------------------

  /** The job's unsaved state: the target, the read the draft began from and the draft. Nothing without a draft (New Job's start panel). */
  keep(id: string): string | undefined {
    const state = this.get(id)
    // A Create several table is not kept (its rows are not a job's draft): the close asks, as for other custom tabs.
    if (!state?.model || !state.draft || state.several) return undefined
    return encodeKeptState({ version: 1, kind: 'agentJob', target: state.target, server: state.server, ...state.login ? { login: state.login } : {}, model: state.model, draft: state.draft })
  }
  /** A kept job reopened disconnected on its target; it reads the job again once the target connects. */
  reopenKept(kept: KeptCustomDocument): QueryDocument {
    if (this.disposed) throw new Error('The job document is not available.')
    const value = decodeKeptState(kept.state, 'agentJob')
    const model = value?.model as unknown as AgentJobDocumentModel | undefined
    const draft = value?.draft as AgentJobDraft | undefined
    if (!value || !model || !draft || !Array.isArray(model.steps) || !sameShape(initialAgentJobDraft(model), draft) || !Array.isArray(draft.steps?.steps) || !Array.isArray(draft.schedules)) throw new Error(keptAgentText.unreadable(kept.name))
    if (!this.options.documents.openKeptCustom) throw new Error(keptAgentText.unreadable(kept.name))
    const document = this.options.documents.openKeptCustom('agentJob', agentJobTabName(value.target.kind === 'agentJob' ? value.target.name : undefined), kept.database ?? 'msdb', kept.targetId)
    if (kept.targetId) this.targetBindings.bindTarget(document.id, kept.targetId)
    this.put({
      id: document.id, target: value.target, server: value.server, ...value.login ? { login: value.login } : {}, phase: 'ready', model, draft, revision: 1, edits: 0, changes: 0, restored: true,
      error: fallback('CONNECTION_LOST', keptAgentText.restored('job', value.server)), frame: initialFrameState(jobSections), script: { state: 'idle', message: noScriptNotice }
    })
    this.afterDraft(document.id)
    this.options.documents.setDirty(document.id, true)
    const live = liveConnectionOn(this.options.connections, this.options.targetIdOf, kept.targetId)
    if (live) this.options.documents.update(document.id, { connectionId: live })
    return document
  }
  attachesOnReconnect(id: string): boolean { return !!this.get(id)?.restored }
  /** Reopened documents whose target is now connected read their job again, keeping the draft. */
  private readRestored(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (!state.restored || !state.model || !state.draft || !this.live(state.id) || this.requests.has(state.id)) continue
      const kept = { model: state.model, draft: state.draft }
      this.patch(state.id, { phase: 'loading', restored: undefined, error: undefined, notice: undefined })
      void this.describe(state.id, undefined, false, kept).finally(() => {
        // A read the connection's loss dropped leaves the document as kept, to read again at the next connect; a read the server refused
        // (the job is gone, say) shows its error over the kept draft.
        const after = this.get(state.id)
        if (after && after.model === kept.model && !after.stale && !this.live(state.id)) this.patch(state.id, { restored: true, ...after.phase === 'loading' ? { phase: 'ready' as const } : {} })
      })
    }
  }
  /** The kept draft on the job as read now: a job changed since opens the compare (Reload and keep my changes, or discard them). */
  private restoreOn(id: string, kept: { readonly model: AgentJobDocumentModel; readonly draft: AgentJobDraft }, now: AgentJobDocumentModel): void {
    const current = this.get(id)
    if (!current) return
    const opened = kept.model.job, read = now.job
    const changed = !!opened && !!read && (opened.version !== read.version || opened.modified !== read.modified)
    if (changed) {
      this.patch(id, { phase: 'ready', model: kept.model, draft: kept.draft, stale: { current: now, rows: agentJobCompare(kept.model, now, kept.draft), keepServer: [] }, error: fallback('STALE', keptAgentText.jobChanged), revision: current.revision + 1 })
    } else {
      const draft = rebaseAgentJobDraft(kept.model, now, kept.draft)
      this.patch(id, { phase: 'ready', model: now, draft, notice: keptAgentText.reread('job'), error: undefined, revision: current.revision + 1, step: this.stepFollowing(current, draft.steps.steps), ...this.restartScheduleReads(id) })
    }
    this.afterDraft(id)
    if (now.job) this.follow(id, now.job.jobId)
  }
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
    this.history.closed(id)
    this.contexts.delete(id)
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
    this.history.dispose()
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
  ensureShared(id: string, rebase = false, stale?: ActionError): boolean {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId || !this.live(id)) return false
    if (state.shared?.state === 'loading' || state.shared?.state === 'ready') return true
    this.patch(id, { shared: { state: 'loading' } })
    const generation = this.scheduleGeneration(id)
    void this.scheduleRead(id, { connectionId, dialog: 'agentSchedules', target: { kind: 'agent' } }).then(result => {
      if (!this.get(id) || this.scheduleGeneration(id) !== generation) return
      const model = result.ok ? result.value.agentSchedules : undefined
      const error = !result.ok ? result.error : result.value.error?.message
      this.patch(id, { shared: model && !error ? { state: 'ready', model } : { state: 'failed', error: error ?? jobScheduleText.listFailed }, rebasing: undefined })
      const draft = this.get(id)?.draft
      let gone = 0
      if (rebase && model && !error && draft) {
        const schedules = refreshPickedSchedules(draft.schedules, model.schedules, !model.truncated)
        if (schedules !== draft.schedules) {
          this.updateDraft(id, { schedules })
          // Not applied when the document cannot be edited now: then nothing left, and nothing is said.
          gone = this.get(id)?.draft !== draft ? draft.schedules.length - schedules.length : 0
          if (gone && !stale) this.patch(id, { notice: jobScheduleText.pickedGone(gone) })
        }
      }
      // A New Job's STALE: the banner shows the error, not a notice, so what the read found goes in its message.
      if (stale) {
        const message = model && !error ? `${jobDocumentText.pickedChanged}${gone ? ` ${jobScheduleText.pickedGone(gone)}` : ''}` : jobDocumentText.pickedUnread(error ?? jobScheduleText.listFailed)
        this.patch(id, { error: { code: stale.code, retryable: stale.retryable, message } })
      }
    })
    return true
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
  private restartScheduleReads(id: string): Pick<JobDocumentState, 'shared' | 'scheduleJobs' | 'rebasing'> {
    this.cancel([...this.scheduleReads.get(id) ?? []])
    this.scheduleReads.get(id)?.clear()
    this.scheduleGenerations.set(id, this.scheduleGeneration(id) + 1)
    return { shared: undefined, scheduleJobs: undefined, rebasing: undefined }
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
    this.setSchedules(id, [...draft.schedules, { key, fields: defaultSchedule(this.now(id).date, msdbTrim(name).slice(0, 128)) }], key)
    this.patch(id, { scheduleSearch: '' })
  }
  /** Attach a shared schedule: added to the job when it is saved, guarded by the version the pick read. */
  attachSchedule(id: string, record: AgentScheduleRecord): void {
    const draft = this.get(id)?.draft
    // Without a guard (its version unread) an attach could not be sent.
    if (!draft || !this.canEdit(id) || record.version === undefined || !record.modified || draft.schedules.some(entry => entry.id === record.id && !entry.remove)) return
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
  /** Whether an entry can leave the job: a new or picked one always; one of the job's own for sysadmin (who sees every schedule, and
   *  sp_detach_schedule has no version guard, so a versions read cut short at its row cap does not matter), else only when its version
   *  was read, since msdb's sp_detach_schedule finds the schedule through sysschedules_localserver_view, which hides another login's
   *  below SQLAgentReaderRole. */
  canDetachSchedule(id: string, entry: JobScheduleEntry): boolean {
    if (entry.id === undefined || entry.attached || this.get(id)?.model?.sysadmin) return true
    const record = this.scheduleRecord(id, entry)
    return record?.version !== undefined && !!record.modified
  }
  removeSchedule(id: string, key: string): void {
    const draft = this.get(id)?.draft
    const entry = draft?.schedules.find(item => item.key === key)
    if (!draft || !entry || !this.canDetachSchedule(id, entry)) return
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
    if (!draft || !entry || !this.canEdit(id) || !this.canDetachSchedule(id, entry)) return
    const record = this.scheduleRecord(id, entry)
    // A copy's source schedule copied here takes the key Changes from source reads its Copy choice by (AG-6e).
    const sourced = entry.id !== undefined && !!this.get(id)?.source?.model.schedules?.some(item => item.id === entry.id) && !draft.schedules.some(item => item.key === copiedScheduleKey(entry.id!))
    const copy: JobScheduleEntry = { key: sourced ? copiedScheduleKey(entry.id!) : `n:${this.newId()}`, fields: { ...entry.fields, name: jobScheduleText.copyName(record?.name ?? entry.fields.name) } }
    const rest = entry.attached ? draft.schedules.filter(item => item !== entry) : draft.schedules.map(item => item === entry ? { key: item.key, id: item.id, fields: record ? scheduleFieldsOf(record) : item.fields, remove: 'detach' as const } : item)
    this.setSchedules(id, [...rest, copy], copy.key)
  }

  // --- Create Job Like This (AG-6e): Changes from source, Replace across the copy, Compare with source ------------------------

  /** Replace across the copy's texts; a change drops the preview, which belongs to the texts it was made with. */
  setReplace(id: string, patch: Partial<Pick<JobReplace, 'find' | 'with' | 'matchCase'>>): void {
    const state = this.get(id)
    if (!state?.source) return
    const replace = { find: '', with: '', matchCase: false, ...state.replace, ...patch }
    this.patch(id, { replace: { find: replace.find.slice(0, createFromLimits.replaceChars), with: replace.with.slice(0, createFromLimits.replaceChars), matchCase: replace.matchCase } })
  }
  /** Preview: every match of the find text across the copy, each chosen until unticked. Nothing changes until Replace. */
  previewReplace(id: string): void {
    const state = this.get(id)
    if (!state?.source || !state.draft || !state.replace?.find || !this.canEdit(id)) return
    const { matches, more } = replaceMatches(state.draft, state.replace.find, { matchCase: state.replace.matchCase })
    this.patch(id, { replace: { ...state.replace, preview: { revision: state.revision, matches, more, chosen: matches.map(match => match.id) } }, notice: undefined })
  }
  toggleReplaceMatch(id: string, matchId: string): void {
    const state = this.get(id), preview = state?.replace?.preview
    if (!state?.replace || !preview || !preview.matches.some(match => match.id === matchId)) return
    const chosen = preview.chosen.includes(matchId) ? preview.chosen.filter(item => item !== matchId) : [...preview.chosen, matchId]
    this.patch(id, { replace: { ...state.replace, preview: { ...preview, chosen } } })
  }
  /** Whether the preview still matches the copy (no edit since it was made). */
  replacePreviewCurrent(id: string): boolean {
    const state = this.get(id)
    return !!state?.replace?.preview && state.replace.preview.revision === state.revision
  }
  /** Replace: the chosen matches, applied to the copy as it was previewed; an edit since asks for a new preview instead. */
  applyReplace(id: string): void {
    const state = this.get(id), replace = state?.replace, preview = replace?.preview
    if (!state?.draft || !replace || !preview || !this.canEdit(id)) return
    if (!this.replacePreviewCurrent(id)) { this.patch(id, { replace: { find: replace.find, with: replace.with, matchCase: replace.matchCase }, notice: createFromText.replaceStale }); return }
    const draft = applyReplace(state.draft, replace.find, replace.with, new Set(preview.chosen), { matchCase: replace.matchCase })
    const count = preview.chosen.length
    this.patch(id, { replace: { find: replace.find, with: replace.with, matchCase: replace.matchCase } })
    if (draft !== state.draft) this.updateDraft(id, { name: draft.name, steps: draft.steps, schedules: draft.schedules })
    this.patch(id, { notice: createFromText.applied(count) })
  }
  /** A source schedule's Share, Copy or Leave out. */
  setCopySchedule(id: string, scheduleId: number, choice: CopyScheduleChoice): void {
    const state = this.get(id), records = state?.source?.model.schedules ?? []
    const read = records.find(item => item.id === scheduleId)
    // Share names the schedule's version: the shared schedules as last read (a New Job's STALE reads them again), else the source's describe.
    const record = (state?.shared?.state === 'ready' ? state.shared.model?.schedules.find(item => item.id === scheduleId) : undefined) ?? read
    if (!state?.draft || !read || !record || !this.canEdit(id)) return
    const schedules = withCopyScheduleChoice(state.draft.schedules, records, record, choice)
    if (schedules !== state.draft.schedules) this.updateDraft(id, { schedules })
  }
  /** Sysadmin keeps the source's owner (msdb lets only sysadmin give a job to another login). */
  keepSourceOwner(id: string): void {
    const state = this.get(id)
    if (!state?.source || !state.model?.sysadmin) return
    this.updateDraft(id, { owner: state.source.base.owner })
  }
  toggleCompare(id: string): void {
    const state = this.get(id)
    if (state?.source) this.patch(id, { compareOpen: state.compareOpen ? undefined : true })
  }
  /** Compare with source: every difference between the copy and the job it copies. */
  compareRows(id: string): CopyCompareRow[] {
    const state = this.get(id)
    return state?.source && state.draft ? createFromCompare(state.source, state.draft, state.model?.proxies ?? state.source.model.proxies ?? []) : []
  }

  // --- Create several (AG-6f): the copy as a table, one row per new job, each created by New Job's save ------------------------

  /** Create several…: the copy as Changes from source left it becomes the template of a table with one row; the tab is renamed. */
  createSeveral(id: string): void {
    const state = this.get(id)
    if (!state?.source || !state.draft || !state.model || state.several || state.row || !this.canEdit(id)) return
    const context = this.severalContextOf(id, state.draft)!
    this.patch(id, { several: { table: startSeveral(context), selected: 'r1', phase: 'table' }, notice: undefined, error: undefined, compareOpen: undefined })
    this.options.documents.update(id, { name: createSeveralText.tab })
    this.options.documents.setDirty(id, true)
  }
  /** The table's columns and template, built once per table. */
  severalContextOf(id: string, template = this.get(id)?.several?.table.template): SeveralContext | undefined {
    const state = this.get(id)
    if (!state?.source || !state.model || !template) return undefined
    const cached = this.contexts.get(id)
    if (cached?.template === template) return cached.context
    const context = severalContext(state.source, template, state.model)
    this.contexts.set(id, { template, context })
    return context
  }
  /** The table can change: it shows (not under review or being created) and the job may be created by this login. */
  canEditSeveral(id: string): boolean {
    const state = this.get(id)
    return !!state?.several && state.several.phase === 'table' && !state.several.enabling && !!state.model && !state.model.readOnly
  }
  private patchSeveral(id: string, patch: Partial<JobSeveral>): void {
    const several = this.get(id)?.several
    if (!several) return
    const next = { ...several, ...patch } as JobSeveral & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.patch(id, { several: next })
    // Unsaved work is the rows not created yet: the close prompt asks only while there are some.
    this.options.documents.setDirty(id, next.table.rows.some(row => !severalLocked(row)))
  }
  private editTable(id: string, change: (table: SeveralTable, context: SeveralContext) => SeveralTable, patch: Partial<JobSeveral> = {}): void {
    const several = this.get(id)?.several, context = this.severalContextOf(id)
    if (!several || !context || !this.canEditSeveral(id)) return
    const table = change(several.table, context)
    if (table !== several.table || Object.keys(patch).length) this.patchSeveral(id, { table, notice: undefined, ...patch })
  }
  setSeveralCell(id: string, key: string, columnId: string, value: string): void { this.editTable(id, (table, context) => withSeveralCell(context, table, key, columnId, value), { selected: key }) }
  selectSeveralRow(id: string, key: string | undefined): void {
    const several = this.get(id)?.several
    if (several && several.selected !== key && (!key || several.table.rows.some(row => row.key === key))) this.patchSeveral(id, { selected: key })
  }
  addSeveralRow(id: string): void {
    const several = this.get(id)?.several
    if (!several) return
    const full = several.table.rows.length >= createSeveralLimits.rows
    this.editTable(id, table => addSeveralRow(table), full ? { notice: createSeveralText.tooMany } : { selected: `r${several.table.next}` })
  }
  duplicateSeveralRow(id: string, key: string): void {
    const several = this.get(id)?.several
    if (!several) return
    const full = several.table.rows.length >= createSeveralLimits.rows
    this.editTable(id, table => duplicateSeveralRow(table, key), full ? { notice: createSeveralText.tooMany } : { selected: `r${several.table.next}` })
  }
  removeSeveralRow(id: string, key: string): void {
    const several = this.get(id)?.several
    if (!several) return
    const at = several.table.rows.findIndex(row => row.key === key)
    this.editTable(id, table => removeSeveralRow(table, key))
    const rows = this.get(id)?.several?.table.rows ?? []
    if (several.selected === key && !rows.some(row => row.key === key)) this.patchSeveral(id, { selected: rows[Math.min(at, rows.length - 1)]?.key })
  }
  setSeveralColumn(id: string, columnId: string, shown: boolean): void { this.editTable(id, (table, context) => withSeveralColumn(context, table, columnId, shown)) }
  /** Opens Columns, Paste rows or Fill names above the table (or closes it, given the open one). */
  toggleSeveralPanel(id: string, panel: NonNullable<JobSeveral['panel']>): void {
    const several = this.get(id)?.several
    if (several && this.canEditSeveral(id)) this.patchSeveral(id, { panel: several.panel === panel ? undefined : panel })
  }
  setSeveralPaste(id: string, text: string): void { if (this.get(id)?.several) this.patchSeveral(id, { paste: text.slice(0, createSeveralLimits.pasteChars) }) }
  setSeveralPattern(id: string, pattern: string): void { if (this.get(id)?.several) this.patchSeveral(id, { pattern: pattern.slice(0, createSeveralLimits.patternChars) }) }
  /** Paste rows: the panel's text (or several lines pasted into a cell) as new rows, one tab-separated cell per visible column. */
  pasteSeveral(id: string, text = this.get(id)?.several?.paste ?? ''): void {
    const several = this.get(id)?.several
    if (!several || !this.canEditSeveral(id)) return
    const pasted = pasteSeveralRows(several.table, text)
    if (!pasted.added && !pasted.cut) return
    this.patchSeveral(id, { table: pasted.table, panel: undefined, paste: undefined, notice: createSeveralText.pasted(pasted.added, pasted.cut), selected: pasted.table.rows.at(-1)?.key })
  }
  fillSeveralNames(id: string): void {
    const pattern = this.get(id)?.several?.pattern ?? ''
    if (pattern.trim()) this.editTable(id, (table, context) => fillSeveralNames(context, table, pattern), { panel: undefined })
  }
  resetSeveral(id: string, key: string, differenceId: string): void { this.editTable(id, (table, context) => resetSeveralDifference(context, table, key, differenceId)) }
  /** Each row's checks: duplicate and existing names, cells that cannot be used and New Job's own errors block it; warnings do not. */
  severalChecks(id: string): ReadonlyMap<string, SeveralCheck> {
    const state = this.get(id), context = this.severalContextOf(id)
    return state?.several && context ? severalChecks(context, state.several.table, draft => this.ssisProblems(state, draft)) : new Map()
  }
  /** The SSIS packages the rows run (`folder\project\package`): the table reads each once, so required parameters without a value show. */
  severalPackages(id: string): readonly string[] {
    const state = this.get(id), context = this.severalContextOf(id)
    if (!state?.several || !context) return []
    const paths = new Set<string>()
    for (const row of state.several.table.rows) {
      if (severalLocked(row)) continue
      for (const step of severalRowDraft(context, row).draft.steps.steps) {
        const command = step.subsystem === 'SSIS' ? parseSsisCommand(step.command) : undefined
        if (command) paths.add(`${command.folder}\\${command.project}\\${command.package}`)
      }
    }
    return [...paths]
  }

  /** Open full editor: the row as an unsaved job tab with every section, whose edits go back to the row (brought forward when already open). */
  openSeveralRow(id: string, key: string): string | undefined {
    const state = this.get(id), context = this.severalContextOf(id), connectionId = this.connectionOf(id)
    const row = state?.several?.table.rows.find(item => item.key === key)
    if (!state?.several || !state.model || !state.source || !context || !row || severalLocked(row) || !connectionId || !this.canEditSeveral(id)) return undefined
    const open = Object.values(this.getSnapshot().documents).find(item => item.row?.table === id && item.row.key === key)
    if (open) { this.options.documents.activate(open.id); return open.id }
    const at = state.several.table.rows.indexOf(row) + 1
    const draft = severalEditorDraft(context, row).draft
    const document = this.options.documents.openCustom('agentJob', createSeveralText.editorTab(at, draft.name || 'New Job'), connectionId, 'msdb')
    this.targetBindings.bind(document.id, connectionId)
    this.put({
      id: document.id, target: { kind: 'agent' }, server: state.server, ...state.login ? { login: state.login } : {}, phase: 'ready', model: state.model, draft, revision: 1, edits: 0, changes: 0,
      frame: initialFrameState(jobSections), script: { state: 'idle', message: noScriptNotice }, source: state.source, row: { table: id, key }, ...state.ssis ? { ssis: state.ssis } : {}
    })
    this.options.documents.setDirty(document.id, false)
    return document.id
  }
  /** Whether a full editor still belongs to its row: the table has it and it is not created. */
  rowLinked(id: string): boolean {
    const link = this.get(id)?.row, several = link ? this.get(link.table)?.several : undefined
    const row = several?.table.rows.find(item => item.key === link!.key)
    return !!row && !severalLocked(row)
  }
  /** A linked editor whose table is under review, creating or showing results: the row cannot change until Back to the table. */
  rowPaused(id: string): boolean {
    const link = this.get(id)?.row
    return !!link && this.rowLinked(id) && this.get(link.table)?.several?.phase !== 'table'
  }
  /** The row's number in its table, for the editor's banner and tab. */
  rowNumber(id: string): number | undefined {
    const link = this.get(id)?.row
    const at = link ? this.get(link.table)?.several?.table.rows.findIndex(item => item.key === link.key) ?? -1 : -1
    return at >= 0 ? at + 1 : undefined
  }
  /** The full editor's draft onto its row; false when the row cannot take it (the editor is then a copy of its own). */
  private syncRow(id: string): boolean {
    const state = this.get(id), link = state?.row
    if (!state?.draft || !link || !this.rowLinked(id) || this.rowPaused(id)) return false
    const several = this.get(link.table)!.several!
    this.patchSeveral(link.table, { table: withSeveralEdited(several.table, link.key, state.draft), selected: link.key })
    const at = this.rowNumber(id)
    if (at) this.options.documents.update(id, { name: createSeveralText.editorTab(at, state.draft.name || 'New Job') })
    return true
  }
  /** Back to the table: the table's tab comes forward and the editor closes (its edits are on the row already). */
  backToTable(id: string): void {
    const link = this.get(id)?.row
    if (!link || !this.get(link.table)) return
    this.options.documents.activate(link.table)
    if (this.rowLinked(id)) this.options.documents.close(id).catch(onUnexpectedError)
  }

  /** Review and create: what each row sends, and the rows left out with why. Nothing is sent yet. */
  reviewSeveral(id: string): void {
    if (this.canEditSeveral(id) && this.live(id)) this.patchSeveral(id, { phase: 'review', panel: undefined, notice: undefined })
  }
  /** Back to the table from the review or the results: rows not created stay to fix and retry; created rows are locked. */
  severalToTable(id: string): void {
    const several = this.get(id)?.several
    if (several && (several.phase === 'review' || several.phase === 'done') && !several.enabling) this.patchSeveral(id, { phase: 'table', notice: undefined, skipped: undefined })
  }
  /** Create: each row with no blocking problem, one after another, each its own `agentJob` save (New Job's sp_add_job in one transaction)
   *  with its own result. A lost connection stops the rest: whether the row on its way was created is unknown. */
  async createSeveralJobs(id: string): Promise<void> {
    const state = this.get(id), context = this.severalContextOf(id), connectionId = this.connectionOf(id)
    if (!state?.several || state.several.phase !== 'review' || !state.model || !context || !connectionId || !this.live(id)) return
    const checks = this.severalChecks(id)
    const open = state.several.table.rows.filter(row => !severalLocked(row))
    const blocked = (key: string) => (checks.get(key)?.blocking.length ?? 0) > 0
    const sending = open.filter(row => !blocked(row.key))
    const skipped = open.filter(row => blocked(row.key)).map(row => ({ key: row.key, reason: checks.get(row.key)!.blocking[0]! }))
    this.patch(id, { error: undefined })
    this.patchSeveral(id, { phase: 'creating', skipped, progress: { at: 0, count: sending.length } })
    let stopped = false
    for (const [index, row] of sending.entries()) {
      this.patchSeveral(id, { progress: { at: index + 1, count: sending.length } })
      const result: SeveralResult = stopped ? { state: 'notSent', message: createSeveralText.stopped } : await this.createRow(id, connectionId, state.model, severalRowDraft(context, row).draft)
      if (!this.get(id)?.several) return
      if (result.state === 'unknown' || result.state === 'notSent') stopped = true
      const table = this.get(id)!.several!.table
      this.patchSeveral(id, { table: { ...table, rows: table.rows.map(item => item.key === row.key ? { ...item, result } : item) } })
    }
    this.patchSeveral(id, { phase: 'done', progress: undefined })
  }
  private async createRow(id: string, connectionId: string, model: AgentJobDocumentModel, draft: AgentJobDraft): Promise<SeveralResult> {
    const save = agentJobSave(model, draft)
    if (!save) return { state: 'failed', message: 'There is nothing to send.' }
    if (!this.live(id) || this.connectionOf(id) !== connectionId) return { state: 'notSent', message: createSeveralText.closed }
    const requestId = this.begin(id, 'save')
    const result = await this.call(() => this.options.api.executeObjectAction({ action: 'agentJob', connectionId, requestId, target: { kind: 'agent' }, agentJob: save }))
    if (!this.end(id, requestId)) return { state: 'unknown', message: createSeveralText.lost }
    if (result.ok && !result.value.error) return { state: 'created', name: save.name ?? draft.name.trim(), enabled: draft.enabled }
    if (!result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST')) return { state: 'unknown', message: createSeveralText.lost }
    return { state: 'failed', message: result.ok ? result.value.error!.message : result.error }
  }
  /** Enable the created jobs saved disabled: New Job's describe lists every job with its id, then each is enabled on its own (AG-2's verb). */
  async enableSeveralCreated(id: string): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    const disabled = state?.several?.table.rows.filter(row => row.result?.state === 'created' && !row.result.enabled) ?? []
    if (!state?.several || state.several.phase !== 'done' || state.several.enabling || !disabled.length || !connectionId || !this.live(id)) return
    this.patchSeveral(id, { enabling: true, notice: undefined })
    const listed = await this.call(() => this.options.api.describeObject({ connectionId, requestId: this.newId(), dialog: 'agentJob', target: { kind: 'agent' } }))
    const jobs = listed.ok && !listed.value.error ? listed.value.agentJobDocument : undefined
    const failure = !listed.ok ? listed.error : listed.value.error?.message
    let enabled = 0
    for (const row of disabled) {
      if (!this.get(id)?.several) return
      const name = row.result?.state === 'created' ? row.result.name : ''
      const at = jobs?.jobs?.findIndex(item => item === name) ?? -1
      const jobId = at >= 0 ? jobs?.jobIds?.[at] : undefined
      let error = failure ?? (jobId ? undefined : 'The job is no longer listed.')
      if (jobId) {
        const result = await this.call(() => this.options.api.executeObjectAction({ action: 'enable', connectionId, requestId: this.newId(), target: { kind: 'agentJob', name }, agentIdentity: { jobId } }))
        error = !result.ok ? result.error : result.value.error?.message
      }
      if (!error) enabled++
      const result: SeveralResult = { state: 'created', name, enabled: !error, ...error ? { enableError: error } : {} }
      const table = this.get(id)!.several!.table
      this.patchSeveral(id, { table: { ...table, rows: table.rows.map(item => item.key === row.key ? { ...item, result } : item) } })
    }
    this.patchSeveral(id, { enabling: undefined, notice: enabled ? createSeveralText.enabled(enabled) : undefined })
  }
  /** A row's job name as it would be created (the grey name when none was typed), for the details, the review and the results. */
  severalRowName(id: string, key: string): string {
    const row = this.get(id)?.several?.table.rows.find(item => item.key === key), context = this.severalContextOf(id)
    return row && context ? severalRowDraft(context, row).draft.name.trim() || 'New Job' : ''
  }
  /** A created row's Open: the new job's own document. */
  openSeveralCreated(id: string, name: string): void {
    const connectionId = this.connectionOf(id)
    if (!connectionId) return
    try { this.openJob(connectionId, name) } catch (failure) { this.patchSeveral(id, { notice: failure instanceof Error ? failure.message : 'The job could not be opened.' }) }
  }
  /** Close, from the results: the table's tab closes (the close prompt asks while rows are not created). */
  closeSeveral(id: string): void { this.options.documents.close(id).catch(onUnexpectedError) }

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
  /** The selected step's key among `steps` after a read or a rebase re-keyed them: the step of the same name (step numbers move), else none. */
  private stepFollowing(state: JobDocumentState, steps: readonly { readonly key: string; readonly name: string }[]): string | undefined {
    const name = state.step === undefined ? undefined : state.draft?.steps.steps.find(step => step.key === state.step)?.name.trim().toUpperCase()
    return name === undefined ? undefined : steps.find(step => step.name.trim().toUpperCase() === name)?.key
  }
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
      else this.patch(state.id, { phase: state.model ? state.draft ? 'ready' : 'choosing' : 'loadFailed', copying: undefined, like: undefined, error: fallback('CONNECTION_LOST', jobDocumentText.disconnected) })
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
