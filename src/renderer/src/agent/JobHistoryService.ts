// The job document's History section and live run view (AG-6d, docs/sql-server-agent.md › Job document › History): one agent.history view
// per job document, with its one job checked and its usual durations asked for, opened when the section first shows and paused by the
// live service while the document is hidden or the section collapsed. The backend reads and groups the runs on its own schedule; this keeps
// what the section draws: the newest runs, the selected run (the newest until the person picks one) and its rows, the failed step with its
// whole message (agent.historyMessage when the grid's copy is cut), and the usual durations. Failures are values; nothing throws into React.
import type { VariaApi } from '../../../shared/contracts'
import { agentLimits, runStatuses } from '../../../shared/agent/catalog.ts'
import { agentHistoryProbe, agentHistorySource, historyRunKeyText, parseHistoryRunKey, type HistoryRunKey } from '../../../shared/agent/history.ts'
import {
  durationSeconds, failedStep, jobHistoryArgs, jobHistoryLimits, sameRun, ssisExecutionQuery, type JobHistoryRun, type JobHistoryStep, type JobUsual
} from '../../../shared/agent/job-history.ts'
import { liveProbes } from '../../../shared/live/catalog.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { LiveHandle, LiveOwner, LiveService, LiveTable } from '../live/LiveService'

const historySpec = liveProbes[agentHistoryProbe]
const columnsOf = (table: number) => Object.fromEntries(historySpec.tables![table].columns.map((column, index) => [column.id, index])) as Record<string, number>
const runColumns = columnsOf(0), stepColumns = columnsOf(1), usualColumns = columnsOf(3)

/** The whole message of the step the detail shows: its row's instance, and the text, its read on the way, or why it failed. */
export interface JobHistoryMessage { readonly instance: number; readonly state: 'reading' | 'ready' | 'failed'; readonly text?: string }
export interface JobHistoryState {
  readonly jobId: string
  readonly failedOnly: boolean
  /** The newest runs that pass the filter, at most jobHistoryLimits.listRuns; `more` when the job has more. */
  readonly runs: readonly JobHistoryRun[]
  readonly more: boolean
  /** The newest runs whatever the filter (the last read with no filter), for the sparkline. */
  readonly spark: readonly JobHistoryRun[]
  /** A sample has arrived. */
  readonly loaded: boolean
  readonly selected?: HistoryRunKey
  /** The person picked the selected run, so it no longer follows the newest. */
  readonly pinned: boolean
  /** The selected run's rows (step 0 the job outcome row), and the run they belong to. */
  readonly steps: readonly JobHistoryStep[]
  readonly stepsFor?: string
  /** The run has more rows than the section reads (jobHistoryLimits.messageRows): a step's many retries. */
  readonly stepsCut?: boolean
  /** The row whose message the detail shows (its instance), and that message. */
  readonly step?: number
  readonly message?: JobHistoryMessage
  readonly usual?: JobUsual
  readonly notice?: string
}
export interface JobHistorySnapshot { readonly documents: Readonly<Record<string, JobHistoryState>> }

export interface JobHistoryServiceOptions {
  readonly api: Partial<Pick<VariaApi, 'agentHistoryMessage' | 'writeClipboardText'>>
  readonly live?: Pick<LiveService, 'open'>
  /** The document's connection while it is usable, else undefined. */
  readonly connectionOf: (id: string) => string | undefined
  /** Whether the section shows: the document is the active one and its History section is open. */
  readonly visible: (id: string) => boolean
  /** Tells when connectionOf or visible may have changed. */
  readonly subscribe: (listener: () => void) => () => void
  readonly newId: () => string
  /** A new query tab on the connection (an SSIS step's execution messages; never run by itself). */
  readonly openQuery?: (sql: string, name: string, connectionId: string, database?: string) => void
}

export const jobHistoryText = {
  denied: "This login cannot read SQL Server Agent's job history: msdb grants it to sysadmin and to members of SQLAgentUserRole, SQLAgentReaderRole and SQLAgentOperatorRole.",
  failed: 'The job history could not be read.',
  messageFailed: 'The whole message could not be read; the start of it is shown.',
  copied: 'Copied the message.'
} as const

/** The job documents' History sections, keyed by the document's id (JobDocumentService owns this and closes each with its document). */
export class JobHistoryService extends SnapshotStore<JobHistorySnapshot> implements Disposable {
  private readonly views = new Map<string, { readonly jobId: string; readonly handle: LiveHandle; readonly stop: () => void }>()
  private readonly reads = new Map<string, number>()
  // Samples read since All or Failed changed: one taken with the args before may still arrive, and nothing says which args a sample had.
  private readonly settling = new Map<string, number>()
  // Sections shown while their connection was not usable: each opens its view when the connection is back.
  private readonly pending = new Map<string, string>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly options: JobHistoryServiceOptions) {
    super({ documents: {} })
    this.unsubscribe = options.subscribe(() => {
      for (const [id, jobId] of [...this.pending]) if (options.connectionOf(id)) { this.pending.delete(id); this.attach(id, jobId) }
    })
  }

  get(id: string): JobHistoryState | undefined { return this.getSnapshot().documents[id] }
  handle(id: string): LiveHandle | undefined { return this.views.get(id)?.handle }
  available(): boolean { return !!this.options.live }

  /** Opens the section's view of `jobId` the first time the section shows (again for another job id: a re-created job). */
  attach(id: string, jobId: string): void {
    const live = this.options.live, job = jobId.toLowerCase()
    if (!live || this.disposed || this.views.get(id)?.jobId === job) return
    // Another job (a re-created one): its view and what it read go, so nothing of the old job shows while this one waits for a connection.
    if (this.views.has(id)) { this.views.get(id)!.stop(); this.views.delete(id); this.reads.delete(id); this.settling.delete(id); this.put(id, fresh(job)) }
    const connectionId = this.options.connectionOf(id)
    if (!connectionId) { this.pending.set(id, job); return }
    this.pending.delete(id)
    let ended = false
    const owner: LiveOwner = {
      key: 'agent-job-history:' + id, visible: () => this.options.visible(id), connectionId: () => this.options.connectionOf(id), closed: () => ended,
      subscribe: listener => this.options.subscribe(listener)
    }
    this.put(id, fresh(job))
    const handle = live.open({ connectionId, source: agentHistorySource, args: jobHistoryArgs(job), probes: [{ probe: agentHistoryProbe, intervalMs: historySpec.intervalMs.default }] }, owner)
    const ticks = handle.onTick(({ tick }) => {
      if (tick.samples.some(sample => sample.probe === agentHistoryProbe)) void this.read(id).catch(onUnexpectedError)
    })
    this.views.set(id, { jobId: job, handle, stop: () => { ended = true; ticks.dispose(); handle.dispose() } })
  }

  /** How the view failed, for the section to say in place of its runs. */
  ended(id: string): { readonly code?: string; readonly message: string } | undefined {
    const snapshot = this.views.get(id)?.handle.getSnapshot()
    const probe = snapshot?.probes[agentHistoryProbe]?.error
    const code = snapshot?.status === 'ended' ? snapshot.ended?.code ?? snapshot.error?.code : probe?.code
    if (!code && snapshot?.status !== 'ended') return undefined
    if (snapshot?.status === 'ended' && snapshot.ended && snapshot.ended.ended !== 'failed') return undefined
    return { ...code ? { code } : {}, message: code === 'PERMISSION_DENIED' ? jobHistoryText.denied : probe?.message ?? snapshot?.ended?.message ?? snapshot?.error?.message ?? jobHistoryText.failed }
  }
  refresh(id: string): void { this.views.get(id)?.handle.refresh() }

  /** All or Failed runs. */
  setFailedOnly(id: string, failedOnly: boolean): void {
    const state = this.get(id)
    if (!state || state.failedOnly === failedOnly) return
    this.patch(id, { failedOnly, pinned: false })
    this.settling.set(id, 0)
    this.sendArgs(id)
  }
  /** The person picks a run: it stays selected while it is listed. */
  selectRun(id: string, key: HistoryRunKey): void {
    const state = this.get(id)
    if (!state) return
    if (sameRun(state.selected, key)) { if (!state.pinned) this.patch(id, { pinned: true }); return }
    this.patch(id, { selected: key, pinned: true, steps: [], stepsFor: undefined, stepsCut: undefined, step: undefined, message: undefined, notice: undefined })
    this.sendArgs(id)
  }
  /** Shows a row's whole message in the detail. */
  selectStep(id: string, instance: number): void {
    const state = this.get(id)
    const row = state?.steps.find(step => step.instance === instance)
    if (!state || !row || state.step === instance) return
    this.patch(id, { step: instance, message: undefined, notice: undefined })
    void this.readMessage(id, row).catch(onUnexpectedError)
  }
  /** The detail's message as the section shows it: the whole one once read, else the grid's copy. */
  messageText(id: string): string | undefined {
    const state = this.get(id)
    const row = state?.steps.find(step => step.instance === state.step)
    if (!state || !row) return undefined
    return state.message?.instance === row.instance && state.message.text !== undefined ? state.message.text : row.message
  }
  async copyMessage(id: string): Promise<void> {
    const text = this.messageText(id)
    if (text === undefined || !this.options.api.writeClipboardText) return
    const step = this.get(id)?.step
    const result = await this.options.api.writeClipboardText(text)
    // Said under the message copied only: not under another step or run picked meanwhile.
    if (this.get(id) && this.get(id)!.step === step && this.get(id)!.message !== undefined) this.patch(id, { notice: result.ok ? jobHistoryText.copied : result.error })
  }

  /** An SSIS step's execution: its catalog messages in a new query window, in SSISDB (not run). */
  openSsisExecution(id: string, executionId: number): void {
    const connectionId = this.options.connectionOf(id)
    if (!connectionId || !this.options.openQuery) return
    this.options.openQuery(ssisExecutionQuery(executionId), `SSIS execution ${executionId}.sql`, connectionId, 'SSISDB')
  }
  /** The document's connection is usable now. */
  connected(id: string): boolean { return !!this.options.connectionOf(id) }
  canOpenQuery(id: string): boolean { return !!this.options.openQuery && !!this.options.connectionOf(id) }

  closed(id: string): void {
    this.views.get(id)?.stop()
    this.views.delete(id)
    this.pending.delete(id)
    this.reads.delete(id)
    this.settling.delete(id)
    if (this.get(id)) this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.pending.clear()
    for (const view of this.views.values()) view.stop()
    this.views.clear()
    this.clearListeners()
  }

  // --- Reading the samples ---------------------------------------------------------------------------------------------

  private sendArgs(id: string): void {
    const state = this.get(id), view = this.views.get(id)
    if (!state || !view) return
    // Set while disconnected too (a reconnect subscribes with them); a refresh samples now, which only regroups the last read.
    view.handle.setArgs(jobHistoryArgs(state.jobId, { failedOnly: state.failedOnly, ...state.selected ? { run: state.selected } : {} }))
    if (this.options.connectionOf(id)) view.handle.refresh()
  }

  /** After each sample: the runs, the selected run's rows and the usual durations; then the selection follows the newest run unless pinned. */
  private async read(id: string): Promise<void> {
    const handle = this.views.get(id)?.handle
    if (!handle) return
    const read = (this.reads.get(id) ?? 0) + 1
    this.reads.set(id, read)
    const [runTable, stepTable, usualTable] = [handle.table(agentHistoryProbe, 0), handle.table(agentHistoryProbe, 1), handle.table(agentHistoryProbe, 3)]
    const [runCells, stepCells, usualCells] = await Promise.all([
      cells(runTable, 0, jobHistoryLimits.listRuns), cells(stepTable, 1, jobHistoryLimits.messageRows), cells(usualTable, 3, historySpec.tables![3].rowCap ?? 1001)
    ])
    const state = this.get(id)
    if (this.reads.get(id) !== read || !state || this.disposed) return
    const runs = runCells.rows.map(cell => runOf(cell)).filter((run): run is JobHistoryRun => !!run)
    // After a change of filter: under Failed, a run that did not fail is from a sample taken before, so it is dropped. Under All, the
    // sparkline waits for a sample with a run that did not fail, or the second one, since only failed runs may be a sample from before.
    let sparkReady = !state.failedOnly
    const settling = this.settling.get(id)
    if (settling !== undefined) {
      const unfailed = runs.some(run => run.tone !== 'error')
      if (state.failedOnly && unfailed) return
      if (state.failedOnly || unfailed || settling >= 1) this.settling.delete(id)
      else { this.settling.set(id, settling + 1); sparkReady = false }
    }
    const steps = stepCells.rows.map(cell => stepOf(cell))
    const usual = usualOf(usualCells.rows)
    const listed = (key: HistoryRunKey | undefined) => !!key && runs.some(run => sameRun(run.key, key))
    // Follow the newest run (the running one while the job runs) unless the person picked one that is still listed.
    const keep = state.pinned && listed(state.selected)
    const selected = keep ? state.selected : runs[0]?.key
    // No run before and none now is no change (else an empty history would ask for a new sample after every sample).
    const changed = selected || state.selected ? !sameRun(selected, state.selected) : false
    const stepsFor = state.selected ? historyRunKeyText(state.selected) : undefined
    // The rows are the selected run's only when they hold its key row: a sample taken before a change of run lists the run before.
    const ownRows = !changed && !!state.selected && steps.some(step => step.instance === state.selected!.instance)
    const next: Partial<JobHistoryState> = {
      runs, more: runCells.total > runs.length, loaded: true, usual, pinned: keep,
      ...sparkReady ? { spark: runs } : {},
      ...changed ? { selected, steps: [], stepsFor: undefined, stepsCut: undefined, step: undefined, message: undefined, notice: undefined } : ownRows ? { steps, stepsFor, stepsCut: stepCells.total > steps.length } : {}
    }
    this.patch(id, next)
    if (changed) { this.sendArgs(id); return }
    if (!ownRows) return
    // A run's detail opens with its failed step's message; a step the person chose stays while the run lists it.
    const current = this.get(id)!
    const chosen = current.step !== undefined && steps.some(step => step.instance === current.step) ? current.step : failedStep(steps)?.instance
    if (chosen === undefined) { if (current.step !== undefined) this.patch(id, { step: undefined, message: undefined }); return }
    if (chosen !== current.step) { this.patch(id, { step: chosen, message: undefined }); void this.readMessage(id, steps.find(step => step.instance === chosen)!).catch(onUnexpectedError) }
  }

  /** The whole message, where the grid's copy was cut; the grid's copy otherwise. */
  private async readMessage(id: string, row: JobHistoryStep): Promise<void> {
    const state = this.get(id), connectionId = this.options.connectionOf(id), api = this.options.api.agentHistoryMessage
    if (!state) return
    const cut = row.message.length >= agentLimits.gridMessageChars && row.message.endsWith('…')
    if (!cut) { this.patch(id, { message: { instance: row.instance, state: 'ready', text: row.message } }); return }
    // Cut, with no way to read the rest now: the start of it shows, said as such.
    if (!connectionId || !api) { this.patch(id, { message: { instance: row.instance, state: 'failed' } }); return }
    this.patch(id, { message: { instance: row.instance, state: 'reading' } })
    let message: JobHistoryMessage
    try {
      const result = await api({ connectionId, requestId: this.options.newId(), jobId: state.jobId, instanceId: row.instance })
      message = result.ok && result.value.message !== undefined ? { instance: row.instance, state: 'ready', text: result.value.message } : { instance: row.instance, state: 'failed' }
    } catch { message = { instance: row.instance, state: 'failed' } }
    if (this.get(id)?.step === row.instance) this.patch(id, { message })
  }

  private put(id: string, state: JobHistoryState): void { this.publish({ documents: { ...this.getSnapshot().documents, [id]: state } }) }
  private patch(id: string, patch: Partial<JobHistoryState>): void {
    const state = this.get(id)
    if (state) this.put(id, { ...state, ...patch })
  }
}

const fresh = (jobId: string): JobHistoryState => ({ jobId, failedOnly: false, runs: [], more: false, spark: [], loaded: false, pinned: false, steps: [] })
/** The first `limit` rows of a table as cell texts, with how many it has. */
async function cells(table: LiveTable | undefined, index: number, limit: number): Promise<{ readonly rows: readonly ((column: string) => string)[]; readonly total: number }> {
  if (!table) return { rows: [], total: 0 }
  const total = table.descriptor.rowsAvailable, count = Math.min(total, limit)
  const columns = historySpec.tables![index].columns.length
  const names = index === 0 ? runColumns : index === 1 ? stepColumns : usualColumns
  const window = count ? await table.handle.getWindow(0, count, { colStart: 0, colEnd: columns, display: false }) : { count: 0, text: [] as string[] }
  return { total, rows: Array.from({ length: window.count }, (_, row) => (column: string) => window.text[row * columns + names[column]] ?? '') }
}
// The live tables give success no tone (src/shared/live/catalog.ts liveTones), so a Succeeded run or step gets it here, for its glyph and pill.
const succeededLabel = runStatuses.find(status => status.code === 1)!.label
const toneOf = (tone: string, outcome: string) => tone || (outcome === succeededLabel ? 'success' : '')
function runOf(cell: (column: string) => string): JobHistoryRun | undefined {
  const key = parseHistoryRunKey(cell('runKey'))
  if (!key) return undefined
  const seconds = durationSeconds(cell('runDuration'))
  return { key, started: cell('runDate'), outcome: cell('runOutcome'), ...seconds !== undefined ? { seconds } : {}, duration: cell('runDuration'), message: cell('runMessage'), tone: toneOf(cell('runTone'), cell('runOutcome')) }
}
function stepOf(cell: (column: string) => string): JobHistoryStep {
  const seconds = durationSeconds(cell('stepDuration'))
  return {
    instance: Number(cell('stepInstance')), stepId: Number(cell('stepId')), name: cell('stepName'), outcome: cell('stepOutcome'), started: cell('stepStarted'),
    ...seconds !== undefined ? { seconds } : {}, duration: cell('stepDuration'), retries: Number(cell('stepRetries')) || 0, message: cell('stepMessage'), tone: toneOf(cell('stepTone'), cell('stepOutcome'))
  }
}
function usualOf(rows: readonly ((column: string) => string)[]): JobUsual | undefined {
  if (!rows.length) return undefined
  const bySteps: Record<number, number> = {}
  let runs = 0
  for (const cell of rows) {
    const step = Number(cell('usualStep')), seconds = Number(cell('usualSeconds'))
    if (!Number.isInteger(step) || !Number.isFinite(seconds) || cell('usualSeconds') === '') continue
    bySteps[step] = seconds
    if (step === 0) runs = Number(cell('usualRuns')) || 0
  }
  return { bySteps, ...bySteps[0] !== undefined ? { job: bySteps[0] } : {}, runs }
}
