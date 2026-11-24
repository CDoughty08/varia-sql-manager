// The SQL Server Agent alert and operator documents and the Operators and notifications grid (AG-7, docs/sql-server-agent.md › Alerts and
// operators): one tab per object (or grid) and connection, opened from Object Explorer's Properties and New › Alert…/Operator…, the job
// document's Alerts section, the palette and the grid. One service class serves the three document kinds, each with its own spec: what its
// describe reads, the draft, "Save · n changes" and the requests Save sends (the alert's or operator's one action, the grid's one agentAlert
// action per changed alert, run one after another). The backend runs each request as one transaction; a refusal is a value in the snapshot.
// Problems warn and only a missing or too long value stops Save. Send test e-mail, Delete operator with Reassign to, Add recommended
// alerts and the counter's current values run here too.
import { actionLimits } from '../../../shared/actions/catalog.ts'
import { noScriptNotice } from '../../../shared/actions/database.ts'
import {
  agentAlertChangeCount, agentAlertProblems, agentAlertSave, agentAlertTabName, initialAgentAlertDraft, recommendedAlertStates, type AgentAlertDocumentModel, type AgentAlertDraft,
  type AgentAlertPreset, type AgentCounterValuesResult, type AgentRecommendedSave
} from '../../../shared/actions/agent-alert.ts'
import {
  agentOperatorChangeCount, agentOperatorProblems, agentOperatorSave, agentOperatorsTabName, agentOperatorTabName, agentOperatorText, initialAgentOperatorDraft,
  matrixChangeCount, matrixChanges, matrixProblems, notifyMatrix, type AgentNotifyMatrix, type AgentOperatorDocumentModel, type AgentOperatorDraft, type AgentOperatorsModel
} from '../../../shared/actions/agent-operator.ts'
import type { ActionDescribeResult, ActionError, ActionExecuteRequest, ActionExecuteResult, ActionScriptRequest, DescribeId } from '../../../shared/actions/schema.ts'
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
import type { CustomDocumentProvider, DocumentService, KeptCustomDocument } from '../services/documents'
import { decodeKeptState, encodeKeptState, keptAgentText, rebaseKeptDraft, sameShape } from '../../../shared/agent/kept.ts'
import type { QueryDocument } from '../documents'
import { liveConnectionOn } from './kept-documents'

export type AgentObjectKind = 'agentAlert' | 'agentOperator' | 'agentOperators'
export type AgentObjectPhase = 'loading' | 'loadFailed' | 'ready' | 'saving'
type Problem = { readonly severity: 'error' | 'warning'; readonly message: string }
type SaveRequest = Extract<ActionExecuteRequest, { action: 'agentAlert' | 'agentOperator' }>
type Unsent<R> = R extends unknown ? Omit<R, 'connectionId' | 'requestId'> : never

/** What one document kind reads, edits and sends. */
export interface AgentObjectSpec<M, D> {
  readonly kind: AgentObjectKind
  readonly noun: string
  readonly dialog: DescribeId
  /** The document's sections, in order (the frame's list). */
  readonly sections: readonly { readonly id: string; readonly title: string }[]
  readonly model: (result: ActionDescribeResult) => M | undefined
  /** Whether the model has its object (false for New Alert and New Operator, whose Save creates it). */
  readonly exists: (model: M) => boolean
  readonly initial: (model: M, preset?: AgentAlertPreset) => D
  readonly changes: (model: M, base: D, draft: D) => number
  readonly problems: (model: M, draft: D) => readonly Problem[]
  readonly requests: (model: M, base: D, draft: D) => Unsent<SaveRequest>[]
  /** The base once the first `done` of a save's requests committed and a later one was refused, so Save resends only the rest. */
  readonly committed?: (model: M, base: D, draft: D, done: number) => D
  /** The object as saved, which the document reads again. */
  readonly saved: (model: M, draft: D, target: ObjectRef) => ObjectRef
  readonly tabName: (target: ObjectRef) => string
  readonly readOnly: (model: M) => string | undefined
}

export interface AgentObjectState<M = unknown, D = unknown> {
  readonly id: string
  readonly target: ObjectRef
  readonly server: string
  readonly login?: string
  readonly phase: AgentObjectPhase
  readonly model?: M
  readonly base?: D
  readonly draft?: D
  readonly preset?: AgentAlertPreset
  readonly revision: number
  readonly edits: number
  readonly changes: number
  readonly error?: ActionError
  readonly notice?: string
  /** A side action on its way (Send test e-mail, Delete operator, Add recommended alerts). */
  readonly busy?: string
  /** Saved but not read again yet: Save waits for a read (Reload), so a create or a rename is never sent twice. */
  readonly unread?: boolean
  /** A dialog the grid opens as it shows (Add recommended alerts from the Alerts folder). */
  readonly ask?: 'recommended'
  readonly counters?: { readonly key: string; readonly result?: AgentCounterValuesResult; readonly loading: boolean }
  readonly frame: FrameState
  readonly script: ScriptContent
  readonly scriptRevision?: number
  readonly scriptDatabase?: string
  readonly scriptNotice?: string
  /** Reopened by hot exit or AutoRecover (AG-6g) and not read since: `model` and `base` are the read the draft began from. */
  readonly restored?: true
}
export interface AgentObjectSnapshot<M, D> { readonly documents: Readonly<Record<string, AgentObjectState<M, D>>> }

export interface AgentObjectServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'agentCounterValues' | 'writeClipboardText'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'update' | 'setDirty' | 'activate' | 'getSnapshot' | 'subscribe'> & Partial<Pick<DocumentService, 'openKeptCustom'>> & DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly focus?: (id: string) => void
  readonly timers?: Timers
  readonly newId?: () => string
}

/** "was" for the alert and the operator, "were" for the grid's notifications. */
const was = (noun: string) => noun.endsWith('s') ? 'were' : 'was'
export const agentObjectText = {
  saved: (noun: string) => `The ${noun} ${was(noun)} saved.`,
  created: (noun: string) => `The ${noun} was created.`,
  disconnected: (noun: string) => `The server was disconnected. Reconnect, then Reload the ${noun}.`,
  readFailed: (noun: string) => `The ${noun} could not be read.`,
  savedUnread: (noun: string) => `The ${noun} ${was(noun)} saved, but could not be read again:`,
  saving: (noun: string) => `The ${noun} ${noun.endsWith('s') ? 'are' : 'is'} being saved. Wait for it to finish.`,
  lost: (noun: string) => `The connection closed while the ${noun} ${was(noun)} being saved, so whether ${noun.endsWith('s') ? 'they were' : 'it was'} saved is unknown. Reload to check.`,
  partly: (done: number, total: number) => `${done} of ${total} alerts were saved before one was refused; Save sends the rest.`,
  saveFirst: 'Save or reload the changes first.',
  actionUnread: (noun: string) => `Done, but the ${noun} could not be read again:`,
  lostAction: 'The connection closed while it ran, so whether it took is unknown. Reload to check.',
  reloadFirst: (noun: string) => `Reload the ${noun} before saving again: whether the last save took is not known yet.`,
  recommendedDone: (count: number) => `${count} recommended alert${count === 1 ? ' was' : 's were'} created.`,
  deleted: (name: string) => `Operator ${name} was deleted.`
} as const
/** The name a save leaves: the name read, verbatim (msdb keeps spaces around it), unless the draft renamed it to the trimmed new name. */
const savedName = (read: string | undefined, typed: string) => read !== undefined && read === typed ? read : typed.trim()
const fallback = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: code !== 'NOT_FOUND' })
export const alertSections = [{ id: 'when', title: 'When' }, { id: 'then', title: 'Then' }, { id: 'options', title: 'Options' }] as const
export const operatorSections = [{ id: 'general', title: 'General' }, { id: 'duty', title: 'Pager duty' }, { id: 'notifications', title: 'Notifications' }] as const
export const operatorsSections = [{ id: 'grid', title: 'Notifications' }] as const

// --- The three specs ---------------------------------------------------------------------------------------------------

export const alertSpec: AgentObjectSpec<AgentAlertDocumentModel, AgentAlertDraft> = {
  kind: 'agentAlert', noun: 'alert', dialog: 'agentAlert', sections: alertSections,
  model: result => result.agentAlertDocument,
  exists: model => model.alert !== undefined,
  initial: (model, preset) => initialAgentAlertDraft(model, preset),
  changes: (model, base, draft) => model.alert ? agentAlertChangeCount(base, draft) : draft.name.trim() ? 1 : 0,
  problems: agentAlertProblems,
  requests: (model, _base, draft) => {
    const save = agentAlertSave(model, draft)
    if (!save) return []
    const alert = model.alert
    return [alert ? { action: 'agentAlert', target: { kind: 'agentAlert', name: alert.name }, agentObjectId: alert.id, agentAlert: save } : { action: 'agentAlert', target: { kind: 'agent' }, agentAlert: save }]
  },
  saved: (model, draft) => ({ kind: 'agentAlert', name: savedName(model.alert?.name, draft.name) }),
  tabName: target => agentAlertTabName(target.kind === 'agentAlert' ? target.name : undefined),
  readOnly: model => model.readOnly
}
export const operatorSpec: AgentObjectSpec<AgentOperatorDocumentModel, AgentOperatorDraft> = {
  kind: 'agentOperator', noun: 'operator', dialog: 'agentOperator', sections: operatorSections,
  model: result => result.agentOperatorDocument,
  exists: model => model.operator !== undefined,
  initial: model => initialAgentOperatorDraft(model),
  changes: (model, base, draft) => model.operator ? agentOperatorChangeCount(base, draft) : draft.name.trim() ? 1 : 0,
  problems: agentOperatorProblems,
  requests: (model, _base, draft) => {
    const save = agentOperatorSave(model, draft)
    if (!save) return []
    const operator = model.operator
    return [operator ? { action: 'agentOperator', target: { kind: 'agentOperator', name: operator.name }, agentObjectId: operator.id, agentOperator: save } : { action: 'agentOperator', target: { kind: 'agent' }, agentOperator: save }]
  },
  saved: (model, draft) => ({ kind: 'agentOperator', name: savedName(model.operator?.name, draft.name) }),
  tabName: target => agentOperatorTabName(target.kind === 'agentOperator' ? target.name : undefined),
  readOnly: model => model.readOnly
}
export const operatorsSpec: AgentObjectSpec<AgentOperatorsModel, AgentNotifyMatrix> = {
  kind: 'agentOperators', noun: 'notifications', dialog: 'agentOperators', sections: operatorsSections,
  model: result => result.agentOperators,
  exists: () => true,
  initial: model => notifyMatrix(model),
  changes: (model, base, draft) => matrixChangeCount(model, base, draft),
  problems: matrixProblems,
  committed: (model, base, draft, done) => {
    const next = new Map(base)
    for (const { alert } of matrixChanges(model, base, draft).slice(0, done)) next.set(alert.name, new Map(draft.get(alert.name) ?? []))
    return next
  },
  requests: (model, base, draft) => matrixChanges(model, base, draft).map(({ alert, changes }) => ({ action: 'agentAlert', target: { kind: 'agentAlert', name: alert.name }, agentObjectId: alert.id, agentAlert: { notifications: changes } })),
  saved: (_model, _draft, target) => target,
  tabName: () => agentOperatorsTabName,
  readOnly: model => model.readOnly
}

/** One document kind's tabs. */
export class AlertOperatorDocumentService<M, D> extends SnapshotStore<AgentObjectSnapshot<M, D>> implements Disposable, CustomDocumentProvider {
  readonly kind: AgentObjectKind
  readonly inSaveAll = false
  private readonly newId: () => string
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
  private disposed = false

  constructor(readonly spec: AgentObjectSpec<M, D>, private readonly options: AgentObjectServiceOptions) {
    super({ documents: {} })
    this.kind = spec.kind
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timers = options.timers ?? browserTimers
    this.registration = options.documents.registerProvider(this)
    const changed = () => { try { this.connectionsChanged(); this.readRestored() } catch (failure) { onUnexpectedError(failure) } }
    this.unsubscribe = [options.connections.subscribe(changed), options.documents.subscribe(changed)]
  }

  get(id: string): AgentObjectState<M, D> | undefined { return this.getSnapshot().documents[id] }

  /** An object's document (or the grid, target the Agent node): brought forward if open on this connection, otherwise a tab opens, loading. */
  open(connectionId: string, target: ObjectRef): string {
    const connection = this.connection(connectionId)
    const existing = Object.values(this.getSnapshot().documents).find(state => state.target.kind === target.kind && state.target.name === target.name && this.connectionOf(state.id) === connectionId
      && this.targetBindings.matchesConnection(state.id, connectionId) && (target.kind !== 'agent' || this.kind === 'agentOperators'))
    if (existing) { this.options.documents.activate(existing.id); return existing.id }
    return this.create(connection, target)
  }
  /** New Alert or New Operator: nothing is created until Save. A new alert may carry a job (the job document's New alert for this job). */
  openNew(connectionId: string, preset?: AgentAlertPreset): string { return this.create(this.connection(connectionId), { kind: 'agent' }, preset) }
  private connection(connectionId: string): LiveConnection {
    if (this.disposed) throw new Error(`The ${this.spec.noun} document is not available.`)
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    return connection
  }
  private create(connection: LiveConnection, target: ObjectRef, preset?: AgentAlertPreset): string {
    const document = this.options.documents.openCustom(this.kind, this.spec.tabName(target), connection.id, 'msdb')
    this.targetBindings.bind(document.id, connection.id)
    this.put({
      id: document.id, target, server: connection.displayName || connection.server, ...connection.login ? { login: connection.login } : {}, phase: 'loading', revision: 0, edits: 0, changes: 0,
      ...preset ? { preset } : {}, frame: initialFrameState(this.spec.sections), script: { state: 'idle', message: noScriptNotice }
    })
    void this.describe(document.id)
    return document.id
  }

  // --- Editing ---------------------------------------------------------------------------------------------------------

  canEdit(id: string): boolean {
    const state = this.get(id)
    // Unread (saved, not read again): the draft is what was saved, so edits wait for Reload rather than count against the old read.
    return !!state?.model && state.draft !== undefined && state.phase === 'ready' && !this.spec.readOnly(state.model) && !state.busy && !state.unread
  }
  updateDraft(id: string, update: (draft: D) => D): void {
    const state = this.get(id)
    if (state?.draft === undefined || !this.canEdit(id)) return
    const draft = update(state.draft)
    this.patch(id, { draft, revision: state.revision + 1, edits: state.edits + 1, notice: undefined, error: undefined })
    this.afterDraft(id)
  }
  problems(id: string): readonly Problem[] {
    const state = this.get(id)
    return state?.model && state.draft !== undefined ? this.spec.problems(state.model, state.draft) : []
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
    if (!state?.model || state.draft === undefined || state.base === undefined) return
    const changes = this.spec.changes(state.model, state.base, state.draft)
    this.patch(id, { changes })
    this.options.documents.setDirty(id, this.spec.exists(state.model) ? changes > 0 : true)
    this.schedulePreview(id)
  }

  // --- Reading ---------------------------------------------------------------------------------------------------------

  canReload(id: string): boolean {
    const state = this.get(id)
    return !!state && this.live(id) && state.phase !== 'saving' && state.phase !== 'loading' && !state.busy
  }
  reload(id: string): void {
    if (!this.canReload(id)) return
    this.patch(id, { phase: 'loading', error: undefined, notice: undefined })
    void this.describe(id)
  }
  /** With `kept` (a reopened document's first read, AG-6g), the user's draft is put on the object as read now rather than replaced. */
  private async describe(id: string, notice?: string, after: 'save' | 'action' = 'save', kept?: { readonly model: M; readonly base: D; readonly draft: D }): Promise<void> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return
    const requestId = this.begin(id, 'describe')
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId, dialog: this.spec.dialog, target: state.target }))
    if (!this.end(id, requestId)) return
    const failure = !result.ok ? fallback('SQL_ERROR', result.error) : result.value.error
    const model = result.ok ? this.spec.model(result.value) : undefined
    const current = this.get(id)
    if (!current) return
    if (failure || !model) {
      const shown = failure ?? fallback('NOT_FOUND', agentObjectText.readFailed(this.spec.noun))
      this.patch(id, { phase: current.model ? 'ready' : 'loadFailed', error: notice ? { ...shown, message: `${after === 'save' ? agentObjectText.savedUnread(this.spec.noun) : agentObjectText.actionUnread(this.spec.noun)} ${shown.message}` } : shown })
      return
    }
    const base = this.spec.initial(model)
    if (kept) {
      // A new object's draft began from its preset's blank; an existing one's from the read (or, for the grid, what a partial save committed).
      const from = this.spec.exists(kept.model) ? kept.base : this.spec.initial(kept.model, current.preset)
      const rebased = rebaseKeptDraft(from, this.spec.exists(model) ? base : this.spec.initial(model, current.preset), kept.draft)
      this.patch(id, { phase: 'ready', model, base, draft: rebased.draft, revision: current.revision + 1, unread: false, error: undefined,
        notice: rebased.conflicts.length ? keptAgentText.conflicts(this.spec.noun) : keptAgentText.reread(this.spec.noun) })
      this.afterDraft(id)
      return
    }
    const draft = this.spec.exists(model) ? base : this.spec.initial(model, current.preset)
    // A read that replaces the draft (Reload) ends a reopened document's wait for its first read too.
    this.rereadOn.delete(id)
    this.patch(id, { phase: 'ready', model, base, draft, revision: current.revision + 1, changes: 0, unread: false, restored: undefined, error: undefined, notice, script: { state: 'idle', message: noScriptNotice }, scriptRevision: undefined })
    // New Alert and New Operator stay clean until their first edit, as New Job does, so closing an untouched one asks nothing.
    this.options.documents.setDirty(id, false)
    this.schedulePreview(id, 0)
  }

  // --- Saving ----------------------------------------------------------------------------------------------------------

  canSave(id: string): boolean {
    const state = this.get(id)
    if (!state?.model || state.draft === undefined || state.unread || state.restored || !this.canEdit(id) || !this.live(id)) return false
    const problems = this.problems(id)
    return (!this.spec.exists(state.model) || state.changes > 0) && !problems.some(problem => problem.severity === 'error')
  }
  save(id: string): Promise<boolean> {
    const running = this.saving.get(id)
    if (running) return running
    this.show(id)
    const promise = this.runSave(id).catch(failure => { onUnexpectedError(failure); return false }).finally(() => this.saving.delete(id))
    this.saving.set(id, promise)
    return promise
  }
  private built(state: AgentObjectState<M, D>): Unsent<SaveRequest>[] {
    return state.model && state.draft !== undefined && state.base !== undefined ? this.spec.requests(state.model, state.base, state.draft) : []
  }
  private async runSave(id: string): Promise<boolean> {
    const state = this.get(id)
    if (!state?.model || state.draft === undefined) return false
    if (this.spec.exists(state.model) && state.changes === 0) return true
    if (!this.live(id)) { this.patch(id, { error: fallback('CONNECTION_LOST', agentObjectText.disconnected(this.spec.noun)) }); return false }
    if (!this.canSave(id)) {
      const blocker = state.unread ? agentObjectText.reloadFirst(this.spec.noun) : state.restored ? keptAgentText.notReread(this.spec.noun) : this.problems(id).find(problem => problem.severity === 'error')?.message
      if (blocker) this.patch(id, { error: fallback('SQL_ERROR', blocker) })
      return false
    }
    const built = this.built(state)
    if (!built.length) return true
    const connectionId = this.connectionOf(id)!
    this.patch(id, { phase: 'saving', error: undefined, notice: undefined })
    let done = 0
    for (const request of built) {
      const requestId = this.begin(id, 'save'), entry = this.requests.get(id)
      const result = await this.call(() => this.options.api.executeObjectAction({ ...request, connectionId, requestId } as ActionExecuteRequest))
      if (this.requests.get(id)?.id === requestId) this.requests.delete(id)
      if (this.disposed || !this.get(id) || entry?.dropped) return false
      if (this.connectionOf(id) !== connectionId || !this.live(id)) { this.lostMidSave(id, done); return false }
      const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
      const failure = value?.error ?? (!result.ok ? fallback(result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? 'CONNECTION_LOST' : 'SQL_ERROR', result.error) : undefined)
      // The backend's CONNECTION_LOST (and IPC's lost replies) mean the outcome is unknown, as when the connection is seen closing here.
      if (failure?.code === 'CONNECTION_LOST') { this.lostMidSave(id, done); return false }
      if (failure) {
        const message = done > 0 ? `${failure.message} ${agentObjectText.partly(done, built.length)}` : failure.message
        const latest = this.get(id)!
        if (done > 0 && this.spec.committed && latest.model && latest.base !== undefined && latest.draft !== undefined) {
          const base = this.spec.committed(latest.model, latest.base, latest.draft, done)
          this.patch(id, { base, changes: this.spec.changes(latest.model, base, latest.draft) })
          this.options.documents.setDirty(id, this.get(id)!.changes > 0)
        }
        this.patch(id, { phase: 'ready', error: { ...failure, message } })
        return false
      }
      done++
    }
    const created = !this.spec.exists(state.model)
    const target = this.spec.saved(state.model, state.draft, state.target)
    this.patch(id, { phase: 'loading', target, changes: 0, unread: true, preset: undefined })
    this.options.documents.setDirty(id, false)
    this.options.documents.update(id, { name: this.spec.tabName(target) })
    await this.describe(id, created ? agentObjectText.created(this.spec.noun) : agentObjectText.saved(this.spec.noun))
    return true
  }

  /** The connection closed during a save: what it committed is unknown, so the draft waits for Reload (`unread`) and is never sent again as is. */
  private lostMidSave(id: string, done: number): void {
    const state = this.get(id)
    if (!state) return
    if (done > 0 && this.spec.committed && state.model && state.base !== undefined && state.draft !== undefined) this.patch(id, { base: this.spec.committed(state.model, state.base, state.draft, done) })
    this.patch(id, { phase: 'ready', unread: true, error: fallback('CONNECTION_LOST', agentObjectText.lost(this.spec.noun)) })
  }

  // --- Side actions ----------------------------------------------------------------------------------------------------

  /** Runs one action beside Save (it is not part of the draft) and reads the document again after it. */
  async runAction(id: string, busy: string, request: Unsent<ActionExecuteRequest>, done: string): Promise<boolean> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId || !this.live(id) || state.busy || state.phase !== 'ready') return false
    // Delete and Add recommended alerts change what the draft shows, so they wait for unsaved changes; Send test e-mail changes nothing.
    if (state.changes > 0 && request.action !== 'notifyOperator') { this.patch(id, { error: fallback('SQL_ERROR', agentObjectText.saveFirst) }); return false }
    this.patch(id, { busy, error: undefined, notice: undefined })
    const result = await this.call(() => this.options.api.executeObjectAction({ ...request, connectionId, requestId: this.newId() } as ActionExecuteRequest))
    if (this.disposed || !this.get(id)) return false
    // A side action whose connection closed may have run: say so as a save's loss does, not as a refusal.
    const lost = !result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST')
    const failure = !result.ok ? fallback(lost ? 'CONNECTION_LOST' : 'SQL_ERROR', lost ? agentObjectText.lostAction : result.error) : result.value.error
    this.patch(id, { busy: undefined, ...failure ? { error: failure } : {} })
    if (failure) return false
    // A draft with changes (only Send test e-mail runs beside them) keeps them; the read waits for Reload.
    if (this.get(id)!.changes === 0) { this.patch(id, { phase: 'loading' }); await this.describe(id, done, 'action') }
    else this.patch(id, { notice: done })
    return true
  }
  /** Send test e-mail to a saved operator, through SQL Server Agent's own Database Mail profile (sysadmin). */
  sendTest(id: string, operator: { readonly id: number; readonly name: string }): Promise<boolean> {
    return this.runAction(id, 'Sending a test e-mail…', { action: 'notifyOperator', target: { kind: 'agentOperator', name: operator.name }, agentObjectId: operator.id }, agentOperatorText.testSent(operator.name))
  }
  /** Delete operator, its notifications moved to another operator or dropped. */
  deleteOperator(id: string, operator: { readonly id: number; readonly name: string }, reassignTo?: string): Promise<boolean> {
    return this.runAction(id, `Deleting ${operator.name}…`, {
      action: 'delete', target: { kind: 'agentOperator', name: operator.name }, closeConnections: false, deleteHistory: false, agentObjectId: operator.id, ...reassignTo ? { reassignTo } : {}
    }, agentObjectText.deleted(operator.name))
  }
  /** Add recommended alerts: the chosen ones created at once, each notifying the one operator. */
  addRecommended(id: string, save: AgentRecommendedSave): Promise<boolean> {
    return this.runAction(id, 'Creating the recommended alerts…', { action: 'addRecommendedAlerts', target: { kind: 'agent' }, agentRecommended: save }, agentObjectText.recommendedDone(save.alerts.length))
  }
  /** Opens (or clears) a dialog the document draws: the grid's Add recommended alerts. */
  setAsk(id: string, ask: 'recommended' | undefined): void { if (this.get(id)) this.patch(id, { ask }) }
  /** The alert or operator names on a server, for Open Alert… and Open Operator… from the palette (the grid's describe). */
  async names(connectionId: string, kind: 'agentAlert' | 'agentOperator', signal?: AbortSignal): Promise<string[]> {
    const result = await this.call(() => this.options.api.describeObject({ connectionId, requestId: this.newId(), dialog: 'agentOperators', target: { kind: 'agent' } }))
    if (signal?.aborted) return []
    if (!result.ok) throw new Error(result.error)
    if (result.value.error) throw new Error(result.value.error.message)
    const model = result.value.agentOperators
    return kind === 'agentAlert' ? (model?.alerts ?? []).map(alert => alert.name) : (model?.operators ?? []).map(operator => operator.name)
  }
  /** The recommended set with whether the server has each one already (the grid's alerts). */
  recommended(id: string) {
    const model = this.get(id)?.model as Partial<AgentOperatorsModel> | undefined
    return recommendedAlertStates(model?.alerts ?? [])
  }
  /** The current values of the alert's counter (agent.counterValues): read on demand, never on a timer. */
  async readCounter(id: string, object: string, counter: string): Promise<void> {
    const connectionId = this.connectionOf(id)
    if (!connectionId || !this.live(id) || !object.trim() || !counter.trim()) return
    const key = `${object}|${counter}`
    this.patch(id, { counters: { key, loading: true } })
    const result = await this.call(() => this.options.api.agentCounterValues({ connectionId, requestId: this.newId(), object: object.trim(), counter: counter.trim() }))
    if (this.disposed || this.get(id)?.counters?.key !== key) return
    this.patch(id, { counters: { key, loading: false, result: result.ok ? result.value : { elapsedMs: 0, error: fallback('SQL_ERROR', result.error) } } })
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
      const name = (current.target.name ?? this.spec.tabName(current.target)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)
      const notice = await deliverScript({ destination, text, database: current.scriptDatabase ?? 'msdb', connectionId, fileName: `${name}.sql` }, this.options)
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
  /** The script of what Save sends: each request's, one after another. */
  private async preview(id: string): Promise<string | undefined> {
    const state = this.get(id), connectionId = this.connectionOf(id)
    if (!state || !connectionId) return undefined
    const revision = state.revision
    const built = state.draft !== undefined && !this.problems(id).some(problem => problem.severity === 'error') ? this.built(state) : []
    if (!built.length) { this.patch(id, { script: { state: 'idle', message: noScriptNotice }, scriptRevision: revision }); return undefined }
    if (!this.live(id)) { this.patch(id, { script: { state: 'failed', error: { message: agentObjectText.disconnected(this.spec.noun), code: 'CONNECTION_LOST' } }, scriptRevision: revision }); return undefined }
    const previous = this.previews.get(id)
    if (previous) this.cancel([previous])
    this.patch(id, { script: { state: 'loading' } })
    const texts: string[] = []
    let database: string | undefined
    for (const request of built) {
      const requestId = this.newId()
      this.previews.set(id, requestId)
      const result = await this.call(() => this.options.api.scriptObjectAction({ ...request, connectionId, requestId } as ActionScriptRequest))
      if (this.previews.get(id) !== requestId) return undefined
      if (this.disposed || !this.get(id) || this.connectionOf(id) !== connectionId) return undefined
      const failure = !result.ok ? { message: result.error, ...result.code ? { code: result.code } : {} } : result.value.error ? { message: result.value.error.message, code: result.value.error.code } : undefined
      const text = result.ok ? result.value.text : undefined
      if (failure || text === undefined) { this.previews.delete(id); this.patch(id, { script: { state: 'failed', error: failure ?? { message: 'No script was produced.' } }, scriptRevision: revision }); return undefined }
      texts.push(text)
      database = result.ok ? result.value.database : database
    }
    this.previews.delete(id)
    const text = texts.join('\n')
    this.patch(id, { script: { state: 'ready', text }, scriptRevision: revision, ...database ? { scriptDatabase: database } : {} })
    if (this.get(id)?.revision !== revision) this.schedulePreview(id)
    return text
  }

  // --- The document's life ---------------------------------------------------------------------------------------------

  // --- Hot exit and AutoRecover (AG-6g) --------------------------------------------------------------------------------

  /** The document's unsaved state: the target, the read the draft began from (with its base) and the draft. */
  keep(id: string): string | undefined {
    const state = this.get(id)
    if (!state?.model || state.draft === undefined || state.base === undefined) return undefined
    return encodeKeptState({ version: 1, kind: this.kind, target: state.target, server: state.server, ...state.login ? { login: state.login } : {}, model: state.model, draft: state.draft,
      extra: { base: state.base, ...state.preset ? { preset: state.preset } : {} } })
  }
  /** A kept document reopened disconnected on its target; it reads its object again once the target connects. */
  reopenKept(kept: KeptCustomDocument): QueryDocument {
    if (this.disposed || !this.options.documents.openKeptCustom) throw new Error(keptAgentText.unreadable(kept.name))
    const value = decodeKeptState(kept.state, this.kind)
    const model = value?.model as M | undefined, draft = value?.draft as D | undefined, base = value?.extra?.['base'] as D | undefined
    const preset = value?.extra?.['preset'] as AgentAlertPreset | undefined
    let shaped = false
    try { shaped = !!model && draft !== undefined && base !== undefined && sameShape(this.spec.initial(model), draft) && sameShape(this.spec.initial(model), base) && (preset === undefined || (typeof preset === 'object' && preset !== null)) } catch { shaped = false }
    if (!value || !model || draft === undefined || base === undefined || !shaped) throw new Error(keptAgentText.unreadable(kept.name))
    const document = this.options.documents.openKeptCustom(this.kind, this.spec.tabName(value.target), kept.database ?? 'msdb', kept.targetId)
    if (kept.targetId) this.targetBindings.bindTarget(document.id, kept.targetId)
    this.put({
      id: document.id, target: value.target, server: value.server, ...value.login ? { login: value.login } : {}, phase: 'ready', model, base, draft, revision: 1, edits: 0, changes: 0,
      ...preset ? { preset } : {}, restored: true, error: fallback('CONNECTION_LOST', keptAgentText.restored(this.spec.noun, value.server)),
      frame: initialFrameState(this.spec.sections), script: { state: 'idle', message: noScriptNotice }
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
      if (!state.restored || !state.model || state.draft === undefined || state.base === undefined || !connectionId || !this.live(state.id) || this.requests.has(state.id) || this.rereadOn.get(state.id) === connectionId) continue
      this.rereadOn.set(state.id, connectionId)
      const kept = { model: state.model, base: state.base, draft: state.draft }
      this.patch(state.id, { phase: 'loading', restored: undefined, error: undefined, notice: undefined })
      void this.describe(state.id, undefined, 'save', kept).finally(() => {
        // A read that did not land (the connection lost, or a refusal or failure while connected) leaves the document as kept: Save
        // waits, since the draft is still on last session's read, and the next connection reads again.
        const after = this.get(state.id)
        if (after && after.model === kept.model) this.patch(state.id, { restored: true, ...after.phase === 'loading' ? { phase: 'ready' as const } : {} })
        else this.rereadOn.delete(state.id)
      })
    }
  }

  canClose(id: string): string | undefined { return this.get(id)?.phase === 'saving' ? agentObjectText.saving(this.spec.noun) : undefined }
  revision(id: string): number { return this.get(id)?.edits ?? 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  closed(id: string): void {
    this.targetBindings.forget(id)
    this.rereadOn.delete(id)
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

  private show(id: string): void { if (this.options.documents.getSnapshot().activeId !== id) this.options.documents.activate(id) }
  private patch(id: string, patch: Partial<AgentObjectState<M, D>>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as AgentObjectState<M, D> & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: AgentObjectState<M, D>): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
  connectionOf(id: string): string | undefined { return this.options.documents.get(id)?.connectionId }
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
      if (request.kind === 'save') this.lostMidSave(state.id, 0)
      else this.patch(state.id, { phase: state.model ? 'ready' : 'loadFailed', error: fallback('CONNECTION_LOST', agentObjectText.disconnected(this.spec.noun)) })
    }
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
export type AlertDocumentService = AlertOperatorDocumentService<AgentAlertDocumentModel, AgentAlertDraft>
export type OperatorDocumentService = AlertOperatorDocumentService<AgentOperatorDocumentModel, AgentOperatorDraft>
export type OperatorsDocumentService = AlertOperatorDocumentService<AgentOperatorsModel, AgentNotifyMatrix>
