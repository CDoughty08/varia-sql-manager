import { actionLimits, actionMenuState, unknownOutcomeMessage, type ActionState, type ActionTarget, type ObjectAction } from '../../../shared/actions/catalog.ts'
import { loginMessages, loginNameRefusal, loginRefusal, loginSubtypes, type LoginFacts, type LoginSubtype } from '../../../shared/actions/logins.ts'
import { loginConnectionsText, promptLimits } from '../../../shared/actions/prompts.ts'
import type { ActionDescribeResult, ActionExecuteResult } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { displayText, type ExplorerNodeRef, type ObjectRef } from '../../../shared/explorer/refs.ts'
import { ident } from '../../../shared/explorer/schema.ts'
import { selectTopRowsScript } from '../../../shared/sql/identifiers'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import { scriptObjectLabel } from '../scripting/ScriptingService'
import type { LiveConnection } from '../services/connections'

export interface ObjectActionServiceOptions {
  readonly api: Pick<VariaApi, 'tableColumns' | 'executeObjectAction' | 'cancelObjectActions' | 'describeObject' | 'confirmAction'>
  readonly explorer: {
    beginRename(nodeId: number): boolean
    endRename(): void
    listingFolderOf(nodeId: number): number | undefined
    reconcile(nodeId: number, options?: { readonly select?: ExplorerNodeRef }): void
  }
  readonly documents: { newQuery(sql: string, name: string | undefined, connectionId: string, database: string, unsaved: boolean): unknown }
  readonly queries: { canExecute(): boolean; execute(): Promise<unknown> }
  readonly connections: ExternalStore<readonly LiveConnection[]>
  /**
   * The command banner (a failed action's message, sp_rename's caution, a login's other Varia connections) and, for what
   * finished as asked but is worth knowing, an information notice (a login's sessions that stay connected).
   */
  readonly report: { error(message: string): void; warning(message: string): void; notice(message: string): void }
  /** Tools › Options › SQL Server Object Explorer › Commands: Select Top <n> Rows. */
  readonly selectTopCount: () => number
  readonly timers?: Timers
  readonly newId?: () => string
}

/** The actions that run on a tree node as a status-bar job: a rename, and a login's Disable and Enable. */
export type StateVerb = 'rename' | 'disable' | 'enable'
/**
 * A running state action, shown in the status bar with Stop once it has run for `actionLimits.statusDelayMs`: its verb,
 * the object as the tree names it, a rename's new name, and the step it is on when it has several (a rename that closes
 * connections first says "Closing connections").
 */
export interface StateJob { readonly id: string; readonly verb: StateVerb; readonly label: string; readonly newName?: string; readonly step?: string; readonly visible: boolean; readonly stopping: boolean }
export interface ObjectActionSnapshot { readonly jobs: readonly StateJob[] }
const verbText: { readonly [V in StateVerb]: { readonly running: string; readonly noun: string } } = {
  rename: { running: 'Renaming', noun: 'rename' }, disable: { running: 'Disabling', noun: 'disable' }, enable: { running: 'Enabling', noun: 'enable' }
}
/** What the status bar says for a job, and its Stop button's accessible name. */
export function stateJobText(job: Pick<StateJob, 'verb' | 'label' | 'newName' | 'step' | 'stopping'>): { readonly text: string; readonly stop: string } {
  const { running, noun } = verbText[job.verb], what = job.label + (job.newName !== undefined ? ` to ${job.newName}` : '')
  return { text: job.stopping ? `Stopping the ${noun} of ${what}…` : job.step ? `${running} ${what}: ${job.step}…` : `${running} ${what}…`, stop: `Stop ${noun}` }
}
/**
 * The status bar's segment for the visible state jobs: the first job's text, and the name of the one Stop, which stops
 * them all, so it names them all: "Stop rename" for one, "Stop 2 renames", or "Stop 2 actions" when their verbs differ.
 */
export function stateJobsText(jobs: readonly Pick<StateJob, 'verb' | 'label' | 'newName' | 'step' | 'stopping'>[]): { readonly text: string; readonly stop: string } | undefined {
  const first = jobs[0]
  if (!first) return undefined
  const { text, stop } = stateJobText({ ...first, stopping: jobs.every(job => job.stopping) })
  if (jobs.length === 1) return { text, stop }
  return { text, stop: jobs.every(job => job.verb === first.verb) ? `Stop ${jobs.length} ${verbText[first.verb].noun}s` : `Stop ${jobs.length} actions` }
}

/** sp_rename leaves a module's definition text with its old name, as SQL Server does. */
export const moduleRenameNote = 'The definition text keeps the old name; script the object with CREATE OR ALTER to update it.'
export const renameMessages = {
  running: (label: string, verb: StateVerb = 'rename') => `${verb === 'rename' ? 'A rename of' : 'An action on'} ${label} is already running. Wait for it, or stop it in the status bar.`,
  stoppedUnknown: 'The rename was stopped, but SQL Server did not confirm it in time, so whether it completed is unknown. Refresh Object Explorer to check.'
} as const
/** The toast key of an action's notice: a newer one takes the older one's place rather than stacking up. */
export const objectActionNoticeKey = 'objectActions.notice'
/** What a login's Disable, Enable and Rename say (D4b): Varia's notes, recalled rather than SSMS's, which says nothing. */
export const loginActionMessages = {
  disabled: (label: string, sessions: number | undefined) => `Disabled the login ${label}.` + (sessions ? ` ${sessions === 1 ? '1 session connected as it stays' : `${sessions.toLocaleString('en-US')} sessions connected as it stay`} connected.` : ''),
  // ENABLE leaves a DENY CONNECT SQL in place (D4 P18), which Login Properties › Status lifts.
  enabled: (label: string, connectDenied: boolean) => `Enabled the login ${label}.` + (connectDenied ? ' Permission to connect is still denied.' : ''),
  renamed: 'Database users mapped to this login keep their names.',
  stoppedUnknown: (verb: 'disable' | 'enable') => `The ${verb} was stopped, but SQL Server did not confirm it in time, so whether it completed is unknown. Refresh Object Explorer to check.`,
  /** What Varia's other connections that sign in as the login cannot do afterwards (critic D4-3). */
  disableConnections: 'cannot reconnect while it is disabled',
  renameConnections: 'cannot reconnect under the old name',
  unavailable: { disable: 'Select an enabled login in Object Explorer.', enable: 'Select a disabled login in Object Explorer.' }
} as const
const verbTitle = { rename: 'Rename', disable: 'Disable', enable: 'Enable' } as const satisfies { readonly [V in StateVerb]: string }
const isLoginSubtype = (subtype: string | undefined): subtype is LoginSubtype => (loginSubtypes as readonly string[]).includes(subtype ?? '')
const sameText = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
const connectionLabel = (connection: Pick<LiveConnection, 'displayName' | 'server'>) => connection.displayName ? `${connection.displayName} (${connection.server})` : connection.server
const maxNewName = 400
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const objectOf = (node: Pick<ExplorerMenuNode, 'ref'>): ObjectRef | undefined => node.ref.type === 'object' ? node.ref.object : undefined

interface Job { readonly connectionId: string; readonly requestId: string; readonly verb: StateVerb; readonly label: string; readonly newName?: string; step?: string; dropped: boolean; stopped: boolean; visible: boolean; timer?: unknown }
/** How a state job ended: the backend's answer, unless the job was dropped (its server went) or the call threw. */
export interface StateJobOutcome { readonly result?: ApiResult<ActionExecuteResult>; readonly thrown?: unknown; readonly dropped: boolean; readonly stopped: boolean }

/**
 * Object Explorer's actions in the renderer: Select Top 1000 Rows for tables and views, and inline Rename (Delete and
 * the other dialogs are ObjectDialogService's). A rename runs at once, as SSMS's does, with no confirmation; its
 * failure goes to the command banner and the label shows the old name again. DDL waits for locks without a timeout, as
 * SSMS's does, so a rename that runs for a moment appears in the status bar with Stop, which cancels it in SQL Server.
 * At most one rename is in flight per node; a server that disconnects drops its renames and cancels them in the backend.
 * A login's Disable and Enable (D4b) run the same way, after the login's facts and, for Disable, a native confirmation.
 */
export class ObjectActionService extends SnapshotStore<ObjectActionSnapshot> implements Disposable {
  private readonly jobs = new Map<number, Job>()
  /** Nodes whose login action is reading its facts or asking, before its job starts: a second one waits for it. */
  private readonly preparing = new Set<number>()
  private readonly timers: Timers
  private readonly newId: () => string
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly options: ObjectActionServiceOptions) {
    super({ jobs: [] })
    this.timers = options.timers ?? browserTimers
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (error) { onUnexpectedError(error) } })
  }

  /** Each action's state for a node: what the context keys say for the selection. */
  state(target: ActionTarget | undefined): Readonly<Record<ObjectAction, ActionState>> { return actionMenuState(target) }
  /** Whether `action` is enabled for the node now: its kind and subtype offer it, and its server is live. */
  canRun(action: ObjectAction, node: ExplorerMenuNode | undefined): node is ExplorerMenuNode {
    return !!node && !node.lost && node.ref.type === 'object' && actionMenuState(node)[action] === 'enabled' && this.isLive(node.connectionId)
  }

  /** SSMS's Select Top N Rows: the columns, one per line, in a new unmarked query on the object's database, run at once. */
  async selectTop(node: ExplorerMenuNode): Promise<void> {
    const object = objectOf(node)
    if (!this.canRun('selectTop', node) || !object?.database || object.schema === undefined || object.name === undefined) throw new Error('Select a table or view in Object Explorer.')
    const name = { connectionId: node.connectionId, database: object.database, schema: object.schema, name: object.name }
    const { columns, truncated } = unwrap(await this.options.api.tableColumns(name.connectionId, name.database, name.schema, name.name))
    if (!this.isLive(name.connectionId)) return
    // Not dirty: the menu can always produce it again.
    this.options.documents.newQuery(selectTopRowsScript({ ...name, columns, truncated }, this.options.selectTopCount()), undefined, name.connectionId, name.database, false)
    if (this.options.queries.canExecute()) await this.options.queries.execute()
  }

  /** F2 or Rename: the node's label becomes the Rename box. */
  beginRename(node: ExplorerMenuNode): void {
    if (!this.canRun('rename', node) || !this.options.explorer.beginRename(node.id)) throw new Error('This object cannot be renamed.')
  }
  /** Escape, or a box that went away: nothing is sent. */
  cancelRename(): void { this.options.explorer.endRename() }

  /**
   * Enter or leaving the box. An unchanged or empty name ends it silently; an invalid one reports why and keeps the box
   * (false). Otherwise the box ends and the rename runs; on success the listing folder is reconciled, with the new name selected.
   */
  async commitRename(node: ExplorerMenuNode, text: string): Promise<boolean> {
    const object = objectOf(node)
    if (!object || text === '' || text === object.name) { this.cancelRename(); return true }
    const parsed = ident.safeParse(text)
    if (!parsed.success) { this.options.report.error(parsed.error.issues[0]?.message ?? 'The name is not valid.'); return false }
    // SQL Server would answer 15021, which does not say why; the backend repeats the rule from the login's type.
    const badName = object.kind === 'login' && isLoginSubtype(node.subtype) ? loginNameRefusal(node.subtype, text) : undefined
    if (badName) { this.options.report.error(loginMessages[badName]); return false }
    this.cancelRename()
    if (this.disposed || !this.isLive(node.connectionId)) return true
    const characters = [...displayText(text)]
    const newName = characters.length > maxNewName ? characters.slice(0, maxNewName - 1).join('') + '…' : characters.join('')
    const folder = this.options.explorer.listingFolderOf(node.id)
    // Read before the rename: a connection that signs in as the login keeps its old name.
    const others = object.kind === 'login' ? this.loginConnections(node.connectionId, object.name) : []
    const outcome = await this.runStateJob(node, 'rename', newName, requestId => this.options.api.executeObjectAction({ action: 'rename', connectionId: node.connectionId, requestId, target: object, newName: text }))
    const value = this.succeeded(node, 'rename', outcome)
    if (!value) return true
    if (folder !== undefined) this.options.explorer.reconcile(folder, { select: { type: 'object', object: { ...object, name: text } } })
    if (object.kind === 'login') {
      this.options.report.notice(loginActionMessages.renamed)
      if (others.length) this.options.report.warning(loginConnectionsText(others, loginActionMessages.renameConnections))
      return true
    }
    // sp_rename's caution is a warning; MODIFY NAME's "The database name 'x' has been set." only confirms the rename.
    const caution = object.kind === 'database' ? '' : value.messages.join(' ')
    if (caution) this.options.report.warning(object.kind === 'table' ? caution : `${caution} ${moduleRenameNote}`)
    return true
  }

  /**
   * A login's Disable or Enable (D4b). It reads the login's facts in the backend's own connection (the loginFacts
   * describe) and refuses by logins.ts' rules (the login this connection uses, SQL Server's own, a Windows group, the
   * permissions); Disable then asks, naming the sessions that stay connected, the service that runs as the login, a
   * sysadmin member and Varia's other connections that sign in as it. The statement runs as a status-bar job with Stop;
   * on success the listing folder is reconciled, so the row's badge and chip follow, and a notice says what changed.
   */
  async changeLoginState(node: ExplorerMenuNode, verb: 'disable' | 'enable'): Promise<void> {
    const object = objectOf(node)
    if (!this.canRun(verb, node) || object?.kind !== 'login' || object.name === undefined) throw new Error(loginActionMessages.unavailable[verb])
    const running = this.jobs.get(node.id)
    if (running) { this.options.report.error(renameMessages.running(running.label, running.verb)); return }
    if (this.preparing.has(node.id)) return
    this.preparing.add(node.id)
    let facts: LoginFacts
    try {
      const described = await this.describeLogin(node, object)
      if (!described) return
      facts = described
      const refused = loginRefusal(facts, verb)
      if (refused) { this.options.report.error(loginMessages[refused]); return }
      if (verb === 'disable' && !await this.confirmDisable(node, object.name, facts)) return
    } finally { this.preparing.delete(node.id) }
    if (this.disposed || !this.isLive(node.connectionId)) return
    const folder = this.options.explorer.listingFolderOf(node.id)
    const outcome = await this.runStateJob(node, verb, undefined, requestId => this.options.api.executeObjectAction({ action: verb, connectionId: node.connectionId, requestId, target: object }))
    const value = this.succeeded(node, verb, outcome)
    if (!value) return
    if (folder !== undefined) this.options.explorer.reconcile(folder, { select: node.ref })
    const label = displayText(object.name)
    this.options.report.notice(verb === 'disable' ? loginActionMessages.disabled(label, value.sessions ?? facts.sessions) : loginActionMessages.enabled(label, facts.connectDenied))
  }

  /** The login's facts as the backend's preflight reads them, or undefined after reporting why not (or when the server went). */
  private async describeLogin(node: ExplorerMenuNode, object: ObjectRef): Promise<LoginFacts | undefined> {
    let result: ApiResult<ActionDescribeResult>
    try { result = await this.options.api.describeObject({ connectionId: node.connectionId, requestId: this.newId(), dialog: 'loginFacts', target: object }) }
    catch (error) { if (this.isLive(node.connectionId)) this.options.report.error(error instanceof Error ? error.message : 'The login could not be read.'); return undefined }
    if (this.disposed || !this.isLive(node.connectionId)) return undefined
    if (!result.ok) { this.options.report.error(result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? result.error : `Could not read ${node.label}: ${result.error}`); return undefined }
    if (result.value.error || !result.value.login) { this.options.report.error(result.value.error?.message ?? `Could not read ${node.label}.`); return undefined }
    return result.value.login
  }

  /** Disable's native confirmation (prompts.ts disableLogin): true only for Disable, never for Cancel, Escape or a failed box. */
  private async confirmDisable(node: ExplorerMenuNode, login: string, facts: LoginFacts): Promise<boolean> {
    const connections = this.loginConnections(node.connectionId, login)
    const answer = await this.options.api.confirmAction({ prompt: 'disableLogin', facts: {
      login, sysadmin: facts.sysadmin, ...facts.sessions !== undefined ? { sessions: Math.min(facts.sessions, promptLimits.count) } : {},
      ...facts.service ? { service: facts.service.slice(0, promptLimits.service) } : {}, ...connections.length ? { connections } : {}
    } })
    if (!answer.ok) { this.options.report.error(answer.error); return false }
    return answer.value === 'disable' && !this.disposed && this.isLive(node.connectionId)
  }

  /**
   * Varia's other live connections to the node's server that sign in as `login`, by their labels (critic D4-3): renderer
   * data only, compared without case as SQL Server compares names by default. At most `promptLimits.connections`.
   */
  private loginConnections(connectionId: string, login: string | undefined): string[] {
    const all = this.options.connections.getSnapshot(), server = all.find(connection => connection.id === connectionId)?.server
    const labels = all.filter(connection => connection.id !== connectionId && !connection.lost && sameText(connection.server, server) && sameText(connection.login, login))
      .map(connection => [...connectionLabel(connection)].slice(0, promptLimits.connectionName).join(''))
    return [...new Set(labels)].slice(0, promptLimits.connections)
  }

  /**
   * A state job's outcome: the backend's reply when the action ran, or undefined after reporting why not. A dropped job
   * (its server went) and a Stop SQL Server confirmed say nothing; a Stop it did not confirm, or a lost backend or
   * connection, says the outcome is unknown.
   */
  private succeeded(node: ExplorerMenuNode, verb: StateVerb, outcome: StateJobOutcome | undefined): ActionExecuteResult | undefined {
    if (!outcome) return undefined
    const { result, thrown, dropped, stopped } = outcome, failed = `${verbTitle[verb]} failed for ${node.label}`
    if (thrown !== undefined) { if (!dropped) this.options.report.error(thrown instanceof Error ? thrown.message : `${failed}.`); return undefined }
    if (dropped || this.disposed || !result) return undefined
    if (!result.ok) {
      // A Stop the backend could not confirm in time; otherwise CANCELLED is a disconnect, which drops the job first.
      if (result.code === 'CANCELLED') { if (stopped) this.options.report.error(verb === 'rename' ? renameMessages.stoppedUnknown : loginActionMessages.stoppedUnknown(verb)); return undefined }
      this.options.report.error(result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? unknownOutcomeMessage : `${failed}: ${result.error}`)
      return undefined
    }
    // Stop cancelled the statement in SQL Server, so nothing changed, as the tree already shows.
    if (result.value.error?.code === 'CANCELLED') return undefined
    if (result.value.error) { this.options.report.error(`${failed}: ${result.value.error.message}`); return undefined }
    return result.value
  }

  /**
   * Runs a state action on a node as a status-bar job: at most one per node (a second is refused with a message, and
   * undefined), shown with Stop after `statusDelayMs`, and dropped (cancelled in the backend) if its server goes. `run`
   * sends the request with the job's request id. A rename (and D3c's rename after its Open Connections prompt) and a
   * login's Disable and Enable (D4b) run through it; `setJobStep` names a later step.
   */
  async runStateJob(node: ExplorerMenuNode, verb: StateVerb, newName: string | undefined, run: (requestId: string) => Promise<ApiResult<ActionExecuteResult>>): Promise<StateJobOutcome | undefined> {
    const object = objectOf(node)
    if (this.disposed || !object || !this.isLive(node.connectionId)) return undefined
    const running = this.jobs.get(node.id)
    if (running) { this.options.report.error(renameMessages.running(running.label, running.verb)); return undefined }
    const job: Job = { connectionId: node.connectionId, requestId: this.newId(), verb, label: scriptObjectLabel(object), ...newName !== undefined ? { newName } : {}, dropped: false, stopped: false, visible: false }
    job.timer = this.timers.setTimeout(() => { if (this.jobs.get(node.id) === job) { job.visible = true; this.changed() } }, actionLimits.statusDelayMs)
    this.jobs.set(node.id, job)
    this.changed()
    try { return { result: await run(job.requestId), dropped: job.dropped, stopped: job.stopped } }
    catch (thrown) { return { thrown: thrown ?? new Error('The action failed.'), dropped: job.dropped, stopped: job.stopped } }
    finally { this.finish(node.id, job) }
  }
  /** The step a running job is on, as the status bar says it ("Closing connections"); undefined goes back to the verb alone. */
  setJobStep(requestId: string, step: string | undefined): void {
    for (const job of this.jobs.values()) if (job.requestId === requestId && job.step !== step) { job.step = step; this.changed() }
  }

  /** The status bar's Stop: cancels the jobs in SQL Server; each answers when its statement has ended. */
  stopJobs(requestIds: readonly string[]): void {
    const wanted = new Set(requestIds), ids: string[] = []
    for (const job of this.jobs.values()) {
      if (!wanted.has(job.requestId) || job.stopped || job.dropped) continue
      job.stopped = true
      ids.push(job.requestId)
    }
    if (!ids.length) return
    this.changed()
    this.cancel(ids)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.drop([...this.jobs.keys()])
    this.clearListeners()
  }

  private isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }
  /** A disconnected or lost server's jobs: their outcome is dropped, and the backend is told to stop them. */
  private connectionsChanged(): void {
    this.drop([...this.jobs].filter(([, job]) => !this.isLive(job.connectionId)).map(([key]) => key))
  }
  private finish(key: number, job: Job): void {
    this.timers.clearTimeout(job.timer)
    if (this.jobs.get(key) !== job) return
    this.jobs.delete(key)
    this.changed()
  }
  private drop(keys: readonly number[]): void {
    const ids: string[] = []
    for (const key of keys) {
      const job = this.jobs.get(key)
      if (!job || job.dropped) continue
      job.dropped = true
      this.timers.clearTimeout(job.timer)
      this.jobs.delete(key)
      if (!job.stopped) ids.push(job.requestId)
    }
    if (keys.length && !this.disposed) this.changed()
    this.cancel(ids)
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (error) { onUnexpectedError(error) }
    }
  }
  private changed(): void {
    this.publish({ jobs: [...this.jobs.values()].map(job => ({ id: job.requestId, verb: job.verb, label: job.label, ...job.newName !== undefined ? { newName: job.newName } : {}, ...job.step ? { step: job.step } : {}, visible: job.visible, stopping: job.stopped })) })
  }
}
