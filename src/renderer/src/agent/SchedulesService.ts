// SQL Server Agent's Schedules document (AG-6c, docs/sql-server-agent.md › Schedules document, docs/agent-ui-rethink.md › rx-schedules-doc):
// one tab per connection that replaces SSMS's Manage Schedules dialog. The `agentSchedules` describe reads the shared schedules, the jobs,
// which job uses which (sysadmin) and their usual durations; below sysadmin a schedule's jobs are read when it is selected. The grid's
// Enabled box saves at once; the selected schedule is edited beside the grid (its draft kept per schedule until saved or refreshed away)
// and saved by itself as one `agentSchedule` action under its version guard, with jobs attached or detached in the same transaction.
// New schedule and New › Schedule… edit a draft that Save creates. Delete asks first and never forces: msdb refuses a schedule a job uses.
// Failures are values in the snapshot; nothing throws into React.
import { actionLimits } from '../../../shared/actions/catalog.ts'
import {
  agentSchedulesTabName, momentOfText, ownsSchedule, rebaseScheduleFields, scheduleDraftSave, scheduleFieldsOf, scheduleSaveProblems, type AgentScheduleJob, type AgentScheduleJobChange, type AgentScheduleRecord,
  type AgentScheduleSave, type AgentSchedulesModel
} from '../../../shared/actions/agent-schedule.ts'
import type { ActionError, ActionExecuteResult } from '../../../shared/actions/schema.ts'
import { agentLimits } from '../../../shared/agent/catalog.ts'
import { defaultSchedule, scheduleMatches, scheduleProblems, scheduleSavable, type AgentMoment, type AgentScheduleFields, type ScheduleServer } from '../../../shared/agent/schedule.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { LiveConnection } from '../services/connections'
import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'

export type SchedulesView = 'all' | 'unused' | 'disabled'
/** The key of the new schedule's draft (one at a time); a schedule's own draft is keyed by its id. */
export const newScheduleKey = 'new'
/** A schedule's edits (or the new one's), with the jobs to attach or detach when it is saved. `base` is the schedule as the draft
 *  began from it: its save compares with it and names its guard, so a read since (after another save, or Refresh) never makes the
 *  guard pass over someone else's change. */
export interface ScheduleDraft { readonly base?: AgentScheduleRecord; readonly fields: AgentScheduleFields; readonly jobs: readonly AgentScheduleJobChange[] }
export interface ScheduleJobsRead { readonly state: 'loading' | 'ready' | 'failed'; readonly jobs?: readonly AgentScheduleJob[] }
export interface SchedulesState {
  readonly id: string
  readonly server: string
  readonly phase: 'loading' | 'loadFailed' | 'ready'
  readonly model?: AgentSchedulesModel
  readonly view: SchedulesView
  readonly filter: string
  /** A schedule's id as text, or newScheduleKey. */
  readonly selected?: string
  readonly drafts: Readonly<Record<string, ScheduleDraft>>
  readonly scheduleJobs?: Readonly<Record<number, ScheduleJobsRead>>
  /** A save, an Enabled toggle or a delete on its way (one at a time). */
  readonly busy?: 'saving' | 'toggling' | 'deleting'
  /** Delete's confirmation is showing for the selected schedule. */
  readonly confirmDelete?: boolean
  readonly error?: ActionError
  readonly notice?: string
  readonly revision: number
}
export interface SchedulesSnapshot { readonly documents: Readonly<Record<string, SchedulesState>> }

export interface SchedulesServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'executeObjectAction' | 'cancelObjectActions'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'setDirty' | 'activate' | 'getSnapshot'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  /** Focus the document: its filter, or (`name`) the selected schedule's Name field, where New schedule puts the caret. */
  readonly focus?: (id: string, target?: 'name') => void
  readonly newId?: () => string
}

export const schedulesText = {
  readFailed: "The schedules could not be read.",
  lost: 'The connection closed; whether the change was saved is unknown. Refresh to check.',
  disconnected: 'The connection is closed. Reconnect, then Refresh.',
  saved: (name: string) => `Saved ${name}.`,
  created: (name: string) => `Created ${name}.`,
  deleted: (name: string) => `Deleted ${name}.`,
  enabled: (name: string, on: boolean) => `${on ? 'Enabled' : 'Disabled'} ${name}.`,
  savedUnread: 'Saved, but the schedules could not be read again:',
  inUse: (count: number) => `${count === 1 ? 'A job uses' : `${count} jobs use`} it: detach ${count === 1 ? 'it' : 'them'} first, or keep the schedule. Varia never forces a delete.`,
  deleteConfirm: (name: string) => `Delete the schedule ${name}? It cannot be undone.`,
  readOnly: (owner: string | undefined) => `Owned by ${owner ?? 'another login'}: only its owner and sysadmin can change it.`,
  unchangeable: 'Varia could not read this schedule\'s version, so it cannot change it.',
  truncated: `Only the first ${agentLimits.listRows} schedules are listed.`,
  unusedNote: 'Unused counts every job, including jobs you cannot see.',
  staleJobs: 'Someone changed a job you chose after it was read, so nothing was created. The jobs are read again: check them, then create again.',
  newPending: 'Finish or discard the new schedule first.',
  staleKept: 'Someone changed this schedule or one of its jobs after it was read, so nothing was saved. It now shows their change with yours on top: check it, then save again.',
  copyName: (name: string) => `${name} (copy)`.slice(0, agentLimits.nameChars)
} as const

const sameGuard = (a: AgentScheduleRecord, b: AgentScheduleRecord) => a.version === b.version && a.modified === b.modified
const fallback = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: code !== 'STALE' && code !== 'NOT_FOUND' })
/** The schedules a view and filter show, in the read's order. */
export function visibleSchedules(model: AgentSchedulesModel | undefined, view: SchedulesView, filter: string): readonly AgentScheduleRecord[] {
  const rows = (model?.schedules ?? []).filter(record => view === 'all' || (view === 'unused' ? record.jobCount === 0 : !record.enabled))
  if (!filter.trim()) return rows
  const jobNames = jobNamesBySchedule(model)
  const words = filter.trim().toLowerCase()
  return rows.filter(record => scheduleMatches(record, filter) || (jobNames.get(record.id) ?? []).some(name => name.toLowerCase().includes(words)))
}
/** Which jobs use each schedule, by name, where the read has the links (sysadmin). */
function jobNamesBySchedule(model: AgentSchedulesModel | undefined): Map<number, string[]> {
  const out = new Map<number, string[]>()
  if (!model?.links || !model.jobs) return out
  const names = new Map(model.jobs.map(job => [job.id.toLowerCase(), job.name]))
  for (const link of model.links) {
    const name = names.get(link.jobId.toLowerCase())
    if (name !== undefined) out.set(link.scheduleId, [...out.get(link.scheduleId) ?? [], name])
  }
  return out
}

/** The local clock, which stands in for the server's before the first read. */
function localMoment(): AgentMoment {
  const date = new Date()
  return { date: date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate(), time: date.getHours() * 10_000 + date.getMinutes() * 100 + date.getSeconds() }
}

/**
 * The Schedules documents (custom document kind 'agentSchedules'): Manage Schedules on the Jobs folder and the palette opens it, New ›
 * Schedule… on the Agent node opens it with a new schedule in its editor. One per connection.
 */
export class SchedulesService extends SnapshotStore<SchedulesSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'agentSchedules' as const
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly registration: Disposable
  private readonly stopConnections: () => void
  private readonly requests = new Map<string, Set<string>>()
  /** Bumped by each read of the schedules, which forgets their jobs: a jobs read from before it is dropped. */
  private readonly generations = new Map<string, number>()
  /** Each document's latest schedules read: an older one that answers later is dropped. */
  private readonly reads = new Map<string, number>()
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false

  constructor(private readonly options: SchedulesServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.registration = options.documents.registerProvider(this)
    this.stopConnections = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } })
  }

  get(id: string | undefined): SchedulesState | undefined { return id === undefined ? undefined : this.getSnapshot().documents[id] }

  // --- Opening ---------------------------------------------------------------------------------------------------------

  /** Manage Schedules: the connection's Schedules document, brought forward if open. With `create`, a new schedule in its editor. */
  open(connectionId: string, create = false): string {
    if (this.disposed) throw new Error('The Schedules document is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    const existing = Object.values(this.getSnapshot().documents).find(state => this.connectionOf(state.id) === connectionId && this.targetBindings.matchesConnection(state.id, connectionId))
    if (existing) {
      this.options.documents.activate(existing.id)
      if (create) this.newSchedule(existing.id)
      return existing.id
    }
    const document = this.options.documents.openCustom('agentSchedules', agentSchedulesTabName, connection.id, 'msdb')
    this.targetBindings.bind(document.id, connection.id)
    this.put({ id: document.id, server: connection.displayName || connection.server, phase: 'loading', view: 'all', filter: '', drafts: {}, revision: 0 })
    if (create) this.newSchedule(document.id)
    void this.describe(document.id)
    return document.id
  }

  // --- Reading ---------------------------------------------------------------------------------------------------------

  canRefresh(id: string): boolean { const state = this.get(id); return !!state && this.live(id) && state.phase !== 'loading' && !state.busy }
  /** Refresh: the schedules read again; drafts stay (a save then meets the version guard), except those of schedules that are gone. */
  refresh(id: string): void {
    if (!this.canRefresh(id)) return
    this.patch(id, { phase: 'loading', error: undefined, notice: undefined })
    void this.describe(id)
  }
  private async describe(id: string, notice?: string, select?: string): Promise<void> {
    const connectionId = this.connectionOf(id)
    if (!this.get(id) || !connectionId) return
    // Only the latest read lands: one started before a later one (a Refresh and then a toggle's read) is dropped.
    const read = (this.reads.get(id) ?? 0) + 1
    this.reads.set(id, read)
    const result = await this.request(id, requestId => this.options.api.describeObject({ connectionId, requestId, dialog: 'agentSchedules', target: { kind: 'agent' } }))
    const current = this.get(id)
    if (!current || !result || this.reads.get(id) !== read) return
    const model = result.ok && !result.value.error ? result.value.agentSchedules : undefined
    if (!model) {
      const error = !result.ok ? fallback('SQL_ERROR', result.error) : result.value.error ?? fallback('SQL_ERROR', schedulesText.readFailed)
      this.patch(id, { phase: current.model ? 'ready' : 'loadFailed', error: notice ? { ...error, message: `${schedulesText.savedUnread} ${error.message}` } : error })
      return
    }
    const ids = new Set(model.schedules.map(record => String(record.id)))
    const drafts = Object.fromEntries(Object.entries(current.drafts).filter(([key]) => key === newScheduleKey || ids.has(key)))
    const selected = select ?? (current.selected === newScheduleKey || (current.selected && ids.has(current.selected)) ? current.selected : undefined)
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.patch(id, { phase: 'ready', model, drafts, selected, scheduleJobs: undefined, error: undefined, notice, revision: current.revision + 1 })
    this.dirtyChanged(id)
    // Opened on a new schedule: its Name is drawn only once the first read is in, so the caret goes there now, and an untouched draft
    // made from the local date moves to the server's (its start date and weekday).
    if (!current.model && selected === newScheduleKey) {
      const draft = drafts[newScheduleKey], local = defaultSchedule(localMoment().date)
      if (draft && !draft.jobs.length && JSON.stringify(draft.fields) === JSON.stringify(local) && local.activeStartDate !== this.now(id).date) {
        this.patch(id, { drafts: { ...drafts, [newScheduleKey]: { ...draft, fields: defaultSchedule(this.now(id).date) } } })
      }
      this.options.focus?.(id, 'name')
    }
    if (selected && selected !== newScheduleKey) this.ensureScheduleJobs(id, Number(selected))
  }
  /** One schedule's jobs, where the read has no links (below sysadmin): read once per schedule and read. */
  ensureScheduleJobs(id: string, scheduleId: number): void {
    const state = this.get(id), connectionId = this.connectionOf(id)
    const read = state?.scheduleJobs?.[scheduleId]
    if (!state?.model || !connectionId || state.model.links || (read && read.state !== 'failed') || !this.live(id)) return
    this.patch(id, { scheduleJobs: { ...state.scheduleJobs, [scheduleId]: { state: 'loading' } } })
    const generation = this.generations.get(id) ?? 0
    void this.request(id, requestId => this.options.api.describeObject({ connectionId, requestId, dialog: 'agentSchedules', target: { kind: 'agent' }, schedule: scheduleId })).then(result => {
      const current = this.get(id)
      if (!current || !result || (this.generations.get(id) ?? 0) !== generation) return
      const jobs = result.ok && !result.value.error ? result.value.agentSchedules?.scheduleJobs : undefined
      this.patch(id, { scheduleJobs: { ...current.scheduleJobs, [scheduleId]: jobs ? { state: 'ready', jobs } : { state: 'failed' } } })
    })
  }

  // --- What the view asks --------------------------------------------------------------------------------------------

  /** The server's clock as read (the local clock before any read). */
  now(id: string): AgentMoment {
    const read = this.get(id)?.model?.now
    const moment = read ? momentOfText(read) : undefined
    return moment ?? localMoment()
  }
  /** What the schedules read says about idle schedules: the platform and whether an idle CPU condition is set. */
  server(id: string): ScheduleServer {
    const model = this.get(id)?.model
    return model ? { platform: model.platform, ...model.idleDefined !== undefined ? { idleDefined: model.idleDefined } : {} } : {}
  }
  record(id: string, key: string | undefined): AgentScheduleRecord | undefined {
    if (!key || key === newScheduleKey) return undefined
    return this.get(id)?.model?.schedules.find(record => String(record.id) === key)
  }
  /** Why the login cannot change a schedule (not its owner and not sysadmin, or no version read), or undefined. */
  readOnly(id: string, record: AgentScheduleRecord | undefined): string | undefined {
    const model = this.get(id)?.model
    if (!model || !record) return undefined
    if (record.version === undefined || !record.modified) return schedulesText.unchangeable
    return model.sysadmin || ownsSchedule(record, model.login) ? undefined : schedulesText.readOnly(record.owner)
  }
  /** The selected schedule's draft, or its fields as read. */
  draft(id: string, key: string | undefined = this.get(id)?.selected): ScheduleDraft | undefined {
    const state = this.get(id)
    if (!state || !key) return undefined
    const own = state.drafts[key]
    if (own) return own
    const record = this.record(id, key)
    return record ? { base: record, fields: scheduleFieldsOf(record), jobs: [] } : undefined
  }
  /** The jobs that use a schedule as read (sysadmin's links, else that schedule's own read), or undefined while unknown. */
  jobsOf(id: string, scheduleId: number): readonly AgentScheduleJob[] | undefined {
    const state = this.get(id), model = state?.model
    if (!model) return undefined
    if (model.links) {
      const ids = new Set(model.links.filter(link => link.scheduleId === scheduleId).map(link => link.jobId.toLowerCase()))
      return (model.jobs ?? []).filter(job => ids.has(job.id.toLowerCase()))
    }
    return state?.scheduleJobs?.[scheduleId]?.jobs
  }
  /** Whether the login may attach a schedule to a job or detach it: msdb lets only the job's owner and sysadmin (14377, 14391), even
   *  where SQLAgentReaderRole lists every job. */
  canChangeJob(id: string, job: Pick<AgentScheduleJob, 'owner'>): boolean {
    const model = this.get(id)?.model
    return !!model && (model.sysadmin || job.owner.toLowerCase() === model.login.toLowerCase())
  }
  /** The selected schedule's jobs after its draft's attaches and detaches. */
  draftJobs(id: string): readonly AgentScheduleJob[] {
    const state = this.get(id), key = state?.selected, draft = this.draft(id)
    if (!state || !key || !draft) return []
    const read = key === newScheduleKey ? [] : this.jobsOf(id, Number(key)) ?? []
    const detached = new Set(draft.jobs.filter(job => !job.attach).map(job => job.jobId.toLowerCase()))
    const attached = draft.jobs.filter(job => job.attach).map(job => this.job(id, job.jobId)).filter((job): job is AgentScheduleJob => !!job)
    return [...read.filter(job => !detached.has(job.id.toLowerCase())), ...attached]
  }
  private job(id: string, jobId: string): AgentScheduleJob | undefined {
    const lower = jobId.toLowerCase()
    return this.get(id)?.model?.jobs?.find(job => job.id.toLowerCase() === lower) ?? Object.values(this.get(id)?.scheduleJobs ?? {}).flatMap(read => read.jobs ?? []).find(job => job.id.toLowerCase() === lower)
  }
  /** The save the selected schedule's draft makes, or undefined when it changes nothing. */
  pendingSave(id: string): AgentScheduleSave | undefined {
    const state = this.get(id), key = state?.selected
    if (!state || !key) return undefined
    const draft = state.drafts[key]
    if (!draft) return undefined
    const record = this.record(id, key)
    if (key !== newScheduleKey && !record) return undefined
    return scheduleDraftSave(key === newScheduleKey ? undefined : draft.base ?? record, draft.fields, draft.jobs)
  }
  changes(id: string): number {
    const save = this.pendingSave(id)
    if (!save) return 0
    if (save.op === 'create') return 1
    return (save.name !== undefined ? 1 : 0) + (save.enabled !== undefined ? 1 : 0) + (save.timing !== undefined ? 1 : 0) + (save.jobs?.length ?? 0)
  }
  canSave(id: string): boolean {
    const state = this.get(id), save = this.pendingSave(id), draft = this.draft(id)
    if (!state || !save || !draft || state.busy || !this.live(id) || state.phase !== 'ready') return false
    if (save.op !== 'create' && this.readOnly(id, this.record(id, state.selected))) return false
    return scheduleSavable(scheduleProblems(draft.fields, this.now(id), this.server(id))) && scheduleSaveProblems(save).length === 0
  }
  /** File › Save and the palette's Save Schedule: any changed draft, whichever is selected. */
  canSaveAll(id: string): boolean {
    const state = this.get(id)
    return !!state && !state.busy && this.live(id) && state.phase === 'ready' && this.isDirty(id)
  }
  canDelete(id: string): boolean {
    const state = this.get(id), record = this.record(id, state?.selected)
    return !!state && !!record && !state.busy && this.live(id) && state.phase === 'ready' && !this.readOnly(id, record)
  }
  isDirty(id: string): boolean {
    const state = this.get(id)
    return !!state && Object.keys(state.drafts).some(key => this.draftChanged(id, key))
  }
  private draftChanged(id: string, key: string): boolean {
    const draft = this.get(id)?.drafts[key]
    if (!draft) return false
    if (key === newScheduleKey) return true
    const record = this.record(id, key)
    return !!record && !!scheduleDraftSave(draft.base ?? record, draft.fields, draft.jobs)
  }

  // --- Editing ---------------------------------------------------------------------------------------------------------

  setView(id: string, view: SchedulesView): void { if (this.get(id)) this.patch(id, { view }) }
  setFilter(id: string, filter: string): void { if (this.get(id)) this.patch(id, { filter: filter.slice(0, agentLimits.nameChars) }) }
  select(id: string, key: string | undefined): void {
    const state = this.get(id)
    if (!state || state.selected === key) return
    this.patch(id, { selected: key, confirmDelete: undefined, error: undefined })
    if (key && key !== newScheduleKey) this.ensureScheduleJobs(id, Number(key))
  }
  /** New schedule: SSMS's defaults (or a copy of `from` for Duplicate), edited beside the grid and created by Save. */
  newSchedule(id: string, from?: AgentScheduleFields): void {
    const state = this.get(id)
    if (!state || state.busy) return
    if (state.drafts[newScheduleKey]) { this.patch(id, { selected: newScheduleKey, confirmDelete: undefined, notice: schedulesText.newPending }); this.options.focus?.(id, 'name'); return }
    const fields = from ? { ...from, name: schedulesText.copyName(from.name) } : defaultSchedule(this.now(id).date)
    this.patch(id, { drafts: { ...state.drafts, [newScheduleKey]: { fields, jobs: [] } }, selected: newScheduleKey, confirmDelete: undefined, error: undefined, notice: undefined })
    this.dirtyChanged(id)
    this.options.focus?.(id, 'name')
  }
  duplicate(id: string): void {
    const draft = this.draft(id)
    if (draft) this.newSchedule(id, draft.fields)
  }
  /** Drops the selected schedule's unsaved edits (the new one's draft goes). */
  discard(id: string): void {
    const state = this.get(id), key = state?.selected
    if (!state || !key || !state.drafts[key]) return
    const { [key]: _gone, ...drafts } = state.drafts
    this.patch(id, { drafts, selected: key === newScheduleKey ? undefined : key, error: undefined })
    this.dirtyChanged(id)
  }
  update(id: string, fields: AgentScheduleFields): void {
    const state = this.get(id), key = state?.selected, draft = this.draft(id)
    if (!state || !key || !draft || state.busy) return
    this.patch(id, { drafts: { ...state.drafts, [key]: { ...draft, fields } } })
    this.dirtyChanged(id)
  }
  /** Attach a job (guarded by its version) or detach one, when the selected schedule is saved; a second click takes the change back. */
  toggleJob(id: string, jobId: string, attach: boolean): void {
    const state = this.get(id), key = state?.selected, draft = this.draft(id)
    const job = this.job(id, jobId)
    if (!state || !key || !draft || !job || state.busy || !this.canChangeJob(id, job)) return
    const lower = jobId.toLowerCase()
    const pending = draft.jobs.find(item => item.jobId.toLowerCase() === lower)
    const jobs = pending ? draft.jobs.filter(item => item !== pending) : [...draft.jobs, { jobId: job.id, version: job.version, attach }].slice(0, agentLimits.scheduleJobChanges)
    this.patch(id, { drafts: { ...state.drafts, [key]: { ...draft, jobs } } })
    this.dirtyChanged(id)
  }

  // --- Saving ----------------------------------------------------------------------------------------------------------

  /** File › Save and the close prompt's Save: every changed draft in turn, the selected one first, each selected while it saves so
   *  a refusal shows on it. Stops at the first that does not save. */
  async save(id: string): Promise<boolean> {
    const tried = new Set<string>()
    for (;;) {
      const state = this.get(id)
      if (!state) return false
      const key = state.selected && !tried.has(state.selected) && this.draftChanged(id, state.selected) ? state.selected
        : Object.keys(state.drafts).find(item => !tried.has(item) && this.draftChanged(id, item))
      if (!key) return true
      tried.add(key)
      this.select(id, key)
      if (!await this.saveSelected(id)) return false
    }
  }
  /** The Save button: the selected schedule's draft as one guarded `agentSchedule` action, then the schedules read again. */
  async saveSelected(id: string): Promise<boolean> {
    const state = this.get(id), save = this.pendingSave(id)
    if (!state || !save) return true
    if (!this.canSave(id)) return false
    const key = state.selected!
    const name = save.name ?? this.record(id, key)?.name ?? ''
    const outcome = await this.execute(id, 'saving', save)
    if (!outcome) {
      if ((save.op === 'update' || save.op === 'create') && this.get(id)?.error?.code === 'STALE') await this.keepStale(id, key)
      return false
    }
    const current = this.get(id)
    if (!current) return false
    const { [key]: _saved, ...drafts } = current.drafts
    this.patch(id, { drafts })
    this.dirtyChanged(id)
    // A created schedule is selected once read: the newest of that name (sp_add_schedule allows duplicates).
    await this.describe(id, save.op === 'create' ? schedulesText.created(name) : schedulesText.saved(name), save.op === 'create' ? undefined : key)
    if (save.op === 'create') {
      const created = this.get(id)?.model?.schedules.filter(record => record.name === name).sort((a, b) => b.id - a.id)[0]
      if (created) this.select(id, String(created.id))
    }
    return true
  }
  /** The grid's Enabled box: saved at once (enable or disable, guarded), whatever the schedule's draft holds. */
  async setEnabled(id: string, scheduleId: number, enabled: boolean): Promise<void> {
    const state = this.get(id), record = state?.model?.schedules.find(item => item.id === scheduleId)
    if (!state || !record || state.busy || !this.live(id) || this.readOnly(id, record) || record.enabled === enabled) return
    const save: AgentScheduleSave = { op: enabled ? 'enable' : 'disable', schedule: { id: record.id, version: record.version!, modified: record.modified! } }
    if (!await this.execute(id, 'toggling', save)) return
    await this.describe(id, schedulesText.enabled(record.name, enabled))
    // The draft's own Enabled follows, so the toggle is not undone by the next Save, and a draft begun from the schedule as toggled
    // moves onto it: this toggle is not someone else's change.
    const current = this.get(id), key = String(scheduleId), draft = current?.drafts[key], now = this.record(id, key)
    if (!current || !draft) return
    const followed = draft.base && sameGuard(draft.base, record) && now
    this.patch(id, { drafts: { ...current.drafts, [key]: { ...draft, ...followed ? { base: now } : {}, fields: { ...draft.fields, enabled } } } })
    this.dirtyChanged(id)
  }
  /** After a STALE save: the schedules read again and the draft moved onto the schedule as read now, keeping the user's changes, with
   *  each job change guarded by the job's version as read now. The next Save is the user's. */
  private async keepStale(id: string, key: string): Promise<void> {
    const error = this.get(id)?.error
    await this.describe(id)
    const current = this.get(id), draft = current?.drafts[key], record = this.record(id, key)
    if (!current || !error) return
    const jobs = draft?.jobs.map(change => ({ ...change, version: this.job(id, change.jobId)?.version ?? change.version })) ?? []
    // A new schedule's STALE can only be a chosen job's version: those are read again.
    if (draft && key === newScheduleKey) { this.patch(id, { drafts: { ...current.drafts, [key]: { ...draft, jobs } }, error: { ...error, message: schedulesText.staleJobs } }); return }
    if (!draft?.base || !record) { this.patch(id, { error }); return }
    this.patch(id, { drafts: { ...current.drafts, [key]: { base: record, fields: rebaseScheduleFields(draft.base, record, draft.fields), jobs } }, error: { ...error, message: schedulesText.staleKept } })
    this.dirtyChanged(id)
  }
  askDelete(id: string): void { if (this.canDelete(id)) this.patch(id, { confirmDelete: true, error: undefined }) }
  cancelDelete(id: string): void { if (this.get(id)?.confirmDelete) this.patch(id, { confirmDelete: undefined }) }
  /** Delete, after its confirmation: sp_delete_schedule without @force_delete, so one a job uses is refused (IN_USE) and kept. */
  async confirmDelete(id: string): Promise<boolean> {
    const state = this.get(id), record = this.record(id, state?.selected)
    if (!state?.confirmDelete || !record || !this.canDelete(id)) return false
    this.patch(id, { confirmDelete: undefined })
    const outcome = await this.execute(id, 'deleting', { op: 'delete', schedule: { id: record.id, version: record.version!, modified: record.modified! } })
    if (!outcome) return false
    const current = this.get(id)
    if (!current) return false
    const { [String(record.id)]: _gone, ...drafts } = current.drafts
    this.patch(id, { drafts, selected: undefined })
    this.dirtyChanged(id)
    await this.describe(id, schedulesText.deleted(record.name))
    return true
  }
  private async execute(id: string, busy: NonNullable<SchedulesState['busy']>, save: AgentScheduleSave): Promise<boolean> {
    const connectionId = this.connectionOf(id)
    if (!connectionId || !this.live(id)) { this.patch(id, { error: fallback('CONNECTION_LOST', schedulesText.disconnected) }); return false }
    this.patch(id, { busy, error: undefined, notice: undefined })
    const result = await this.request(id, requestId => this.options.api.executeObjectAction({ action: 'agentSchedule', connectionId, requestId, target: { kind: 'agent' }, agentSchedule: save }))
    if (!this.get(id)) return false
    this.patch(id, { busy: undefined })
    if (!result) { this.patch(id, { error: fallback('CONNECTION_LOST', schedulesText.lost) }); return false }
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    if (value && !value.error) return true
    if (value?.error) {
      const record = save.schedule ? this.get(id)?.model?.schedules.find(item => item.id === save.schedule!.id) : undefined
      this.patch(id, { error: value.error.code === 'IN_USE' && record ? { ...value.error, message: schedulesText.inUse(record.jobCount) } : value.error })
      return false
    }
    const lost = !result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST')
    this.patch(id, { error: lost ? fallback('CONNECTION_LOST', schedulesText.lost) : fallback('SQL_ERROR', !result.ok ? result.error : 'The schedule could not be saved.') })
    return false
  }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  /** Unsaved drafts close through Save / Don't Save (the document is dirty); only a save under way refuses. */
  canClose(id: string): string | undefined { return this.get(id)?.busy ? 'The Schedules document is saving. Wait for the save to finish.' : undefined }
  revision(id: string): number { return this.get(id)?.revision ?? 0 }
  /** The tab's focus: a new schedule's Name, else the filter. */
  focus(id: string): void { this.options.focus?.(id, this.get(id)?.selected === newScheduleKey ? 'name' : undefined) }
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  closed(id: string): void {
    this.cancel([...this.requests.get(id) ?? []])
    this.requests.delete(id)
    this.generations.delete(id)
    this.reads.delete(id)
    this.targetBindings.forget(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.targetBindings.clear()
    this.cancel([...this.requests.values()].flatMap(set => [...set]))
    this.requests.clear()
    this.registration.dispose()
    this.stopConnections()
    this.clearListeners()
  }

  // --- Internals -------------------------------------------------------------------------------------------------------

  private dirtyChanged(id: string): void { if (this.get(id)) this.options.documents.setDirty(id, this.isDirty(id)) }
  private patch(id: string, patch: Partial<SchedulesState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as SchedulesState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: SchedulesState): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
  private connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
  live(id: string): boolean {
    const connectionId = this.connectionOf(id)
    return this.targetBindings.matchesConnection(id, connectionId) && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }
  /** One request of a document: undefined when the document closed or its connection changed or was lost meanwhile. */
  private async request<T>(id: string, send: (requestId: string) => Promise<ApiResult<T>>): Promise<ApiResult<T> | undefined> {
    const requestId = this.newId(), connectionId = this.connectionOf(id)
    const set = this.requests.get(id) ?? new Set<string>()
    set.add(requestId)
    this.requests.set(id, set)
    let result: ApiResult<T>
    try { result = await send(requestId) } catch (failure) { result = { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } } finally { set.delete(requestId) }
    // A write whose connection went is unknown either way (the caller says so); a read is simply dropped.
    if (this.disposed || !this.get(id) || this.connectionOf(id) !== connectionId || !this.live(id)) return undefined
    return result
  }
  private connectionsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      if (this.live(state.id)) continue
      const pending = [...this.requests.get(state.id) ?? []]
      if (pending.length) { this.cancel(pending); this.requests.get(state.id)?.clear() }
      if (state.phase === 'loading') this.patch(state.id, { phase: state.model ? 'ready' : 'loadFailed', error: fallback('CONNECTION_LOST', schedulesText.disconnected) })
    }
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
