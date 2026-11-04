import { actionLimits, actionMenuReasons, actionMenuState, objectActionSpecs, unknownOutcomeMessage, type ActionState, type ActionTarget, type ObjectAction } from '../../../shared/actions/catalog.ts'
import { loginGreyedMessage, loginMessages, loginNameRefusal, loginRefusal, loginSubtypes, loginVerbs, type LoginFacts, type LoginSubtype, type LoginVerb } from '../../../shared/actions/logins.ts'
import { loginConnectionsText, promptLimits, promptTabFacts } from '../../../shared/actions/prompts.ts'
import type { ActionExecuteResult, DatabaseIdentity, RenameDatabaseFacts } from '../../../shared/actions/schema.ts'
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
import type { DatabaseRenameHooks } from './database-rename'

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
   * The command banner (a failed action's message, sp_rename's caution, a login's other Varia connections), `clear` to take
   * back one message the Rename box reported once the box closes, and, for what finished as asked but is worth knowing, an
   * information notice (a login's sessions that stay connected).
   */
  readonly report: { error(message: string): void; warning(message: string): void; clear(message: string): void; notice(message: string): void }
  /** Tools › Options › SQL Server Object Explorer › Commands: Select Top <n> Rows. */
  readonly selectTopCount: () => number
  /** A database's rename (D3c): Varia's query windows in it, and what follows the new name. Without it the prompt counts none and nothing follows. */
  readonly databases?: DatabaseRenameHooks
  /** A toast: the logins whose default database a rename took away. */
  readonly notify?: (notice: { readonly severity: 'info' | 'warning'; readonly message: string }) => void
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
const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
export const renameMessages = {
  running: (label: string, verb: StateVerb = 'rename') => `${verb === 'rename' ? 'A rename of' : 'An action on'} ${label} is already running. Wait for it, or stop it in the status bar.`,
  /** The status bar's step while a database's rename reads who is using it (its describe), which Stop cancels. */
  reading: 'Reading the database',
  /** The status bar's step while SINGLE_USER WITH ROLLBACK IMMEDIATE closes the other connections. */
  closing: 'Closing connections',
  /** The status bar's step while Rename When Free waits for the other connections to go, which can last until Stop. */
  waiting: 'Waiting for connections to close',
  /** A login whose default database was renamed away gets 4064 when it connects without naming a database (Learn). */
  loginsDefaulting: (logins: number, database: string) =>
    `${count(logins, 'login has', 'logins have')} ${database} as ${logins === 1 ? 'its' : 'their'} default database, which no longer exists under that name. ${logins === 1 ? 'It cannot' : 'They cannot'} connect without naming a database until ${logins === 1 ? 'its default is' : 'their defaults are'} changed.`,
  stoppedUnknown: 'The rename was stopped, but SQL Server did not confirm it in time, so whether it completed is unknown. Refresh Object Explorer to check.'
} as const
/** The toast key of an action's notice: a newer one takes the older one's place rather than stacking up. */
export const objectActionNoticeKey = 'objectActions.notice'
/** What a login's Disable, Enable and Rename say (D4b): Varia's notes, recalled rather than SSMS's, which says nothing. */
export const loginActionMessages = {
  disabled: (label: string, sessions: number | undefined) => `Disabled the login ${label}.` + (sessions ? sessions === 1 ? ' Its open session stays connected.' : ` Its ${sessions.toLocaleString('en-US')} open sessions stay connected.` : ''),
  // ENABLE leaves a DENY CONNECT SQL in place (D4 P18): the notice says so, as a fact (Login Properties › Status, D2c, will lift it).
  enabled: (label: string, connectDenied: boolean) => `Enabled the login ${label}.` + (connectDenied ? ' Permission to connect is still denied.' : ''),
  renamed: (label: string, newName: string) => `Renamed the login ${label} to ${newName}. Database users mapped to it keep their names.`,
  stoppedUnknown: (verb: 'disable' | 'enable') => `The ${verb} was stopped, but SQL Server did not confirm it in time, so whether it completed is unknown. Refresh Object Explorer to check.`,
  /** The status bar's step while Disable or Enable reads the login's facts, before it asks or runs. */
  reading: 'Reading the login',
  /** A second Disable or Enable while the first one waits for its prompt. */
  asking: (label: string) => `An action on ${label} is waiting for your answer.`,
  /** What Varia's other connections that sign in as the login cannot do afterwards (critic D4-3). */
  disableConnections: 'cannot reconnect while it is disabled',
  renameConnections: 'cannot reconnect under the old name',
  unavailable: { disable: 'Select an enabled login in Object Explorer.', enable: 'Select a disabled login in Object Explorer.' }
} as const
const verbTitle = { rename: 'Rename', disable: 'Disable', enable: 'Enable' } as const satisfies { readonly [V in StateVerb]: string }
const isLoginSubtype = (subtype: string | undefined): subtype is LoginSubtype => (loginSubtypes as readonly string[]).includes(subtype ?? '')
const isLoginVerb = (action: ObjectAction): action is ObjectAction & LoginVerb => (loginVerbs as readonly string[]).includes(action)
const sameText = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
const connectionLabel = (connection: Pick<LiveConnection, 'displayName' | 'server'>) => connection.displayName ? `${connection.displayName} (${connection.server})` : connection.server
/** `text` in at most `max` UTF-16 units, as zod counts them, ending in … when cut, never inside a surrogate pair. */
export function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ''
  for (const character of text) { if (out.length + character.length > max - 1) break; out += character }
  return out + '…'
}
/**
 * Varia's other live connections to a connection's server that sign in as `login`, by their labels (critic D4-3): renderer data
 * only, compared without case as SQL Server compares names by default. At most `promptLimits.connections`. Disable's and Rename's
 * warnings and Delete Object's (D4c) name them.
 */
export function otherLoginConnections(all: readonly LiveConnection[], connectionId: string, login: string | undefined): string[] {
  const server = all.find(connection => connection.id === connectionId)?.server
  const labels = all.filter(connection => connection.id !== connectionId && !connection.lost && sameText(connection.server, server) && sameText(connection.login, login))
    .map(connection => clipUnits(connectionLabel(connection), promptLimits.connectionName))
  return [...new Set(labels)].slice(0, promptLimits.connections)
}
const maxNewName = 400
/** The rename step's title in a reply (the backend's ActionService.StepTitle for MODIFY NAME and sp_rename). */
export const renameStepTitle = 'Rename'
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const objectOf = (node: Pick<ExplorerMenuNode, 'ref'>): ObjectRef | undefined => node.ref.type === 'object' ? node.ref.object : undefined
const promptCount = (value: number) => Math.min(Math.max(0, Math.trunc(value)), promptLimits.count)
/** What a database's rename sends after its describe and prompt: the database read, and whether to close the connections. */
interface DatabaseRenamePlan { readonly identity: DatabaseIdentity; readonly closeConnections: boolean; readonly facts: RenameDatabaseFacts }

interface Job { readonly connectionId: string; readonly requestId: string; readonly verb: StateVerb; readonly label: string; readonly newName?: string; step?: string; dropped: boolean; stopped: boolean; visible: boolean; timer?: unknown }
/** How a state job ended: the backend's answer, unless the job was dropped (its server went) or the call threw. */
interface TrackedJob<T> { readonly result?: ApiResult<T>; readonly thrown?: unknown; readonly dropped: boolean; readonly stopped: boolean }
export type StateJobOutcome = TrackedJob<ActionExecuteResult>

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
  /** Nodes whose login action is reading its facts or asking, before its job starts: a second request is told why it waits. */
  private readonly preparing = new Set<number>()
  /** The message the Rename box reported for its name, which the banner shows only while the box stays open. */
  private boxError: string | undefined
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
  /** Whether `action` can run on `node` now: its kind and subtype offer it, on its row or its folder, and its server is live. */
  canRun(action: ObjectAction, node: ExplorerMenuNode | undefined): node is ExplorerMenuNode {
    // A folder action (Databases › Attach… and Restore Database…) runs on its folder, and on object rows only where it places itself
    // on them (`rows`: a database's Tasks › Restore › Database…); actionMenuState says which rows enable it.
    const { folder, rows } = objectActionSpecs[action]
    const placed = (node: ExplorerMenuNode) => folder ? node.ref.type === 'folder' && node.ref.folder === folder || !!rows && node.ref.type === 'object' : node.ref.type === 'object'
    return !!node && !node.lost && placed(node) && actionMenuState(node)[action] === 'enabled' && this.isLive(node.connectionId)
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

  /**
   * Why `action` is greyed for the node, so a key that reaches a greyed action, and the palette's greyed row, can say why: a
   * login's greyed verb (a Windows group's Disable, SQL Server's own logins, an Entra login's Rename) as logins.ts words it, or
   * the database's state (the catalogue's rule reason) as "<Action> is unavailable: <reason>". Undefined when nothing greys it.
   */
  unavailable(action: ObjectAction, node: ExplorerMenuNode | undefined): string | undefined {
    if (!node || node.lost || node.ref.type !== 'object' || !this.isLive(node.connectionId) || actionMenuState(node)[action] !== 'disabled') return undefined
    const subtype = objectOf(node)?.kind === 'login' ? node.subtype : undefined
    if (isLoginSubtype(subtype) && isLoginVerb(action)) return loginMessages[loginGreyedMessage(subtype, action)]
    const reason = actionMenuReasons(node)[action]
    return reason ? `${objectActionSpecs[action].menuTitle ?? objectActionSpecs[action].title} is unavailable: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : undefined
  }

  /** F2 or Rename: the node's label becomes the Rename box. */
  beginRename(node: ExplorerMenuNode): void {
    if (!this.canRun('rename', node) || !this.options.explorer.beginRename(node.id)) throw new Error('This object cannot be renamed.')
  }
  /** Escape, or a box that went away: nothing is sent, and the box's own refusal leaves the banner with it. */
  cancelRename(): void {
    if (this.boxError !== undefined) { this.options.report.clear(this.boxError); this.boxError = undefined }
    this.options.explorer.endRename()
  }
  /** Keeps the Rename box open with why its name cannot be sent, until the box closes. */
  private refuseName(message: string): false {
    this.boxError = message
    this.options.report.error(message)
    return false
  }

  /**
   * Enter or leaving the box. An unchanged or empty name ends it silently; an invalid one reports why and keeps the box
   * (false). Otherwise the box ends and the rename runs; on success the listing folder is reconciled, with the new name selected.
   */
  async commitRename(node: ExplorerMenuNode, text: string): Promise<boolean> {
    const object = objectOf(node)
    if (!object || text === '' || text === object.name) { this.cancelRename(); return true }
    const parsed = ident.safeParse(text)
    if (!parsed.success) return this.refuseName(parsed.error.issues[0]?.message ?? 'The name is not valid.')
    // SQL Server would answer 15021, which does not say why; the backend repeats the rule from the login's type.
    const badName = object.kind === 'login' && isLoginSubtype(node.subtype) ? loginNameRefusal(node.subtype, text) : undefined
    if (badName) return this.refuseName(loginMessages[badName])
    this.cancelRename()
    if (this.disposed || !this.isLive(node.connectionId)) return true
    const characters = [...displayText(text)]
    const newName = characters.length > maxNewName ? characters.slice(0, maxNewName - 1).join('') + '…' : characters.join('')
    const folder = this.options.explorer.listingFolderOf(node.id)
    // Read before the rename: a connection that signs in as the login keeps its old name.
    const others = object.kind === 'login' ? this.loginConnections(node.connectionId, object.name) : []
    let plan: DatabaseRenamePlan | undefined
    // A database's rename is one job from Enter: its describe and prompt run under it, so the status bar shows it with Stop (which
    // cancels the describe by the job's request id) and a second rename meanwhile is refused as a running one is.
    const outcome = await this.runStateJob(node, 'rename', newName, async requestId => {
      if (object.kind === 'database') {
        plan = await this.prepareDatabaseRename(node, object, requestId)
        if (!plan || !this.running(requestId)) return undefined
        this.setJobStep(requestId, plan.closeConnections ? renameMessages.closing : plan.facts.sessions !== 0 ? renameMessages.waiting : undefined)
      }
      return this.options.api.executeObjectAction({ action: 'rename', connectionId: node.connectionId, requestId, target: object, newName: text, ...plan ? { closeConnections: plan.closeConnections, identity: plan.identity } : {} })
    })
    if (!outcome) return true
    const { result, thrown, dropped, stopped } = outcome
    if (thrown !== undefined) { if (!dropped) this.options.report.error(thrown instanceof Error ? thrown.message : 'The rename failed.'); return true }
    if (dropped || this.disposed || !result) return true
    if (!result.ok) {
      // A Stop the backend could not confirm in time; otherwise CANCELLED is a disconnect, which drops the job first.
      if (result.code === 'CANCELLED') { if (stopped) this.options.report.error(renameMessages.stoppedUnknown); return true }
      this.options.report.error(result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? unknownOutcomeMessage : `Rename failed for ${node.label}: ${result.error}`)
      return true
    }
    // A database's MODIFY NAME can complete before a later step fails or is stopped (its access not restored): it has the new name.
    const error = result.value.error
    const renamed = !error || (object.kind === 'database' && result.value.steps.some(step => !step.compensates && step.status === 'done' && step.title === renameStepTitle))
    if (error && !renamed) {
      // Stop cancelled the statement in SQL Server, so the object keeps its name, as the label already shows; a stopped database
      // rename that undid its SINGLE_USER says so.
      if (error.code === 'CANCELLED' && !result.value.steps.some(step => step.compensates)) return true
      this.options.report.error(`Rename failed for ${node.label}: ${error.message}`)
      return true
    }
    if (folder !== undefined) this.options.explorer.reconcile(folder, { select: { type: 'object', object: { ...object, name: text } } })
    if (object.kind === 'database' && object.name !== undefined) this.databaseRenamed(node.connectionId, object.name, text, plan?.facts, result.value.identity)
    if (error) { this.options.report.error(`${node.label} was renamed to ${newName}, but: ${error.message}`); return true }
    if (object.kind === 'login') {
      this.options.report.notice(loginActionMessages.renamed(displayText(object.name ?? ''), newName))
      if (others.length) this.options.report.warning(loginConnectionsText(others, loginActionMessages.renameConnections))
      return true
    }
    // sp_rename's caution is a warning; MODIFY NAME's "The database name 'x' has been set." only confirms the rename.
    const caution = object.kind === 'database' ? '' : result.value.messages.join(' ')
    if (caution) this.options.report.warning(object.kind === 'table' ? caution : `${caution} ${moduleRenameNote}`)
    return true
  }

  /**
   * A login's Disable or Enable (D4b). It reads the login's facts in the backend's own connection (the loginFacts
   * describe) and refuses by logins.ts' rules (the login this connection uses, SQL Server's own, a Windows group, the
   * permissions); Disable then asks, naming the sessions that stay connected, the service that runs as the login, a
   * sysadmin member and Varia's other connections that sign in as it. Reading the facts and the statement each run as a
   * status-bar job with Stop ("Disabling AppUser: Reading the login…"), and a second request for the login says why it waits;
   * on success the listing folder is reconciled, so the row's badge and chip follow, and a notice says what changed.
   */
  async changeLoginState(node: ExplorerMenuNode, verb: 'disable' | 'enable'): Promise<void> {
    const object = objectOf(node)
    if (!this.canRun(verb, node) || object?.kind !== 'login' || object.name === undefined) throw new Error(loginActionMessages.unavailable[verb])
    const running = this.jobs.get(node.id)
    if (running) { this.options.report.error(renameMessages.running(running.label, running.verb)); return }
    if (this.preparing.has(node.id)) { this.options.report.error(loginActionMessages.asking(node.label)); return }
    this.preparing.add(node.id)
    let facts: LoginFacts
    try {
      const described = await this.describeLogin(node, object, verb)
      if (!described) return
      facts = described
      const refused = loginRefusal(facts, verb)
      if (refused) { this.options.report.error(loginMessages[refused]); return }
      if (verb === 'disable' && !await this.confirmDisable(node, object.name, facts)) return
    } finally { this.preparing.delete(node.id) }
    if (this.disposed || !this.isLive(node.connectionId)) return
    const folder = this.options.explorer.listingFolderOf(node.id)
    // The statement is for the principal these facts describe: one that has taken the name since is refused before any DDL.
    const loginIdentity = facts.sid && facts.created ? { loginIdentity: { sid: facts.sid, created: facts.created } } : {}
    const outcome = await this.runStateJob(node, verb, undefined, requestId => this.options.api.executeObjectAction({ action: verb, connectionId: node.connectionId, requestId, target: object, ...loginIdentity }))
    const value = this.succeeded(node, verb, outcome)
    if (!value) return
    if (folder !== undefined) this.options.explorer.reconcile(folder, { select: node.ref })
    const label = displayText(object.name)
    this.options.report.notice(verb === 'disable' ? loginActionMessages.disabled(label, value.sessions ?? facts.sessions) : loginActionMessages.enabled(label, facts.connectDenied))
  }

  /**
   * The login's facts as the backend's preflight reads them, read as the verb's status-bar job, or undefined after reporting
   * why not; nothing is said when the server went or Stop ended the read.
   */
  private async describeLogin(node: ExplorerMenuNode, object: ObjectRef, verb: 'disable' | 'enable'): Promise<LoginFacts | undefined> {
    const tracked = await this.trackJob(node, verb, undefined, loginActionMessages.reading,
      requestId => this.options.api.describeObject({ connectionId: node.connectionId, requestId, dialog: 'loginFacts', target: object }))
    if (!tracked || tracked.dropped || tracked.stopped || this.disposed || !this.isLive(node.connectionId)) return undefined
    const { result, thrown } = tracked
    if (thrown !== undefined || !result) { this.options.report.error(thrown instanceof Error ? thrown.message : 'The login could not be read.'); return undefined }
    if (!result.ok) { this.options.report.error(result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? result.error : `Could not read ${node.label}: ${result.error}`); return undefined }
    if (result.value.error || !result.value.login) { this.options.report.error(result.value.error?.message ?? `Could not read ${node.label}.`); return undefined }
    return result.value.login
  }

  /** Disable's native confirmation (prompts.ts disableLogin): true only for Disable, never for Cancel, Escape or a failed box. */
  private async confirmDisable(node: ExplorerMenuNode, login: string, facts: LoginFacts): Promise<boolean> {
    const connections = this.loginConnections(node.connectionId, login)
    const answer = await this.options.api.confirmAction({ prompt: 'disableLogin', facts: {
      login, sysadmin: facts.sysadmin, ...facts.sessions !== undefined ? { sessions: Math.min(facts.sessions, promptLimits.count) } : {},
      ...facts.service ? { service: clipUnits(facts.service, promptLimits.service) } : {}, ...connections.length ? { connections } : {}
    } })
    if (!answer.ok) { this.options.report.error(answer.error); return false }
    return answer.value === 'disable' && !this.disposed && this.isLive(node.connectionId)
  }

  private loginConnections(connectionId: string, login: string | undefined): string[] { return otherLoginConnections(this.options.connections.getSnapshot(), connectionId, login) }

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
   * A database's rename reads its facts first (actions.describe renameDatabase): the preflight's refusal, the database read, and
   * who is using it. With no other session it runs at once, as before; otherwise main's prompt (critic A13) asks whether to close
   * the connections (rolling back their open transactions, which it counts and names for Varia's own windows, A7), to wait for them
   * with Stop, or to cancel. It runs under the rename's job (`requestId`): the describe goes out with that id, so Stop and a
   * disconnect cancel it, and a Stop meanwhile ends the rename quietly. Undefined: refused, failed, cancelled or stopped, already reported.
   */
  private async prepareDatabaseRename(node: ExplorerMenuNode, object: ObjectRef, requestId: string): Promise<DatabaseRenamePlan | undefined> {
    const { connectionId } = node, database = object.name!
    const fail = (message: string) => { if (this.running(requestId)) this.options.report.error(`Rename failed for ${node.label}: ${message}`) }
    this.setJobStep(requestId, renameMessages.reading)
    let described
    try { described = await this.options.api.describeObject({ connectionId, requestId, dialog: 'renameDatabase', target: object }) }
    catch (thrown) { fail(thrown instanceof Error ? thrown.message : 'The database could not be read.'); return undefined }
    if (!this.running(requestId)) return undefined
    if (!described.ok) { fail(described.error); return undefined }
    const facts = described.value.renameDatabase
    if (described.value.error || !facts) { fail(described.value.error?.message ?? 'The database could not be read.'); return undefined }
    if (facts.sessions === 0) return { identity: facts.identity, closeConnections: false, facts }
    this.setJobStep(requestId, undefined)
    let tabs: { readonly count: number; readonly withTransactions: readonly string[] } = { count: 0, withTransactions: [] }
    try { if (this.options.databases) tabs = await this.options.databases.tabs(connectionId, database, facts.connections) } catch (thrown) { onUnexpectedError(thrown) }
    if (!this.running(requestId)) return undefined
    let answer
    try {
      answer = await this.options.api.confirmAction({
        prompt: 'renameDatabase',
        facts: {
          database, ...facts.sessions !== undefined ? { sessions: promptCount(facts.sessions) } : {}, ...facts.withTransaction !== undefined ? { transactions: promptCount(facts.withTransaction) } : {},
          tabs: promptCount(tabs.count), ...promptTabFacts(tabs.withTransactions), canClose: facts.canClose
        }
      })
    } catch (thrown) { fail(thrown instanceof Error ? thrown.message : 'The confirmation failed.'); return undefined }
    if (!answer.ok) { fail(answer.error); return undefined }
    if (answer.value === 'cancel' || !this.running(requestId)) return undefined
    return { identity: facts.identity, closeConnections: answer.value === 'closeAndRename', facts }
  }
  /**
   * After SQL Server renamed a database: query windows, connections opened in it and Database Properties follow the new name (with
   * its identity under it, `identity`), and a toast names the logins whose default it was.
   */
  private databaseRenamed(connectionId: string, database: string, newName: string, facts: RenameDatabaseFacts | undefined, identity: DatabaseIdentity | undefined): void {
    try { this.options.databases?.renamed(connectionId, database, newName, facts?.connections, identity) } catch (thrown) { onUnexpectedError(thrown) }
    if (facts?.loginsDefaulting) this.options.notify?.({ severity: 'warning', message: renameMessages.loginsDefaulting(facts.loginsDefaulting, displayText(database)) })
  }

  /**
   * Runs a state action on a node as a status-bar job: at most one per node (a second is refused with a message, and
   * undefined), shown with Stop after `statusDelayMs`, and dropped (cancelled in the backend) if its server goes. `run`
   * sends the request with the job's request id. A rename (and D3c's rename after its Open Connections prompt) and a
   * login's Disable and Enable (D4b) run through it; `setJobStep` names a later step.
   */
  runStateJob(node: ExplorerMenuNode, verb: StateVerb, newName: string | undefined, run: (requestId: string) => Promise<ApiResult<ActionExecuteResult> | undefined>): Promise<StateJobOutcome | undefined> {
    return this.trackJob(node, verb, newName, undefined, run)
  }
  /**
   * A status-bar job around any request the backend can cancel by its request id, starting at `step` (a login's facts). `run`
   * answers undefined when it ended before sending anything (a database rename's prompt cancelled), which is no result.
   */
  private async trackJob<T>(node: ExplorerMenuNode, verb: StateVerb, newName: string | undefined, step: string | undefined, run: (requestId: string) => Promise<ApiResult<T> | undefined>): Promise<TrackedJob<T> | undefined> {
    const object = objectOf(node)
    if (this.disposed || !object || !this.isLive(node.connectionId)) return undefined
    const running = this.jobs.get(node.id)
    if (running) { this.options.report.error(renameMessages.running(running.label, running.verb)); return undefined }
    const job: Job = { connectionId: node.connectionId, requestId: this.newId(), verb, label: scriptObjectLabel(object), ...newName !== undefined ? { newName } : {}, ...step ? { step } : {}, dropped: false, stopped: false, visible: false }
    job.timer = this.timers.setTimeout(() => { if (this.jobs.get(node.id) === job) { job.visible = true; this.changed() } }, actionLimits.statusDelayMs)
    this.jobs.set(node.id, job)
    this.changed()
    try { const result = await run(job.requestId); return { ...result ? { result } : {}, dropped: job.dropped, stopped: job.stopped } }
    catch (thrown) { return { thrown: thrown ?? new Error('The action failed.'), dropped: job.dropped, stopped: job.stopped } }
    finally { this.finish(node.id, job) }
  }
  /** The step a running job is on, as the status bar says it ("Closing connections"); undefined goes back to the verb alone. */
  setJobStep(requestId: string, step: string | undefined): void {
    for (const job of this.jobs.values()) if (job.requestId === requestId && job.step !== step) { job.step = step; this.changed() }
  }

  /** Whether the job with this request id still runs: not stopped, nor dropped with its server, nor the service disposed. */
  private running(requestId: string): boolean {
    if (this.disposed) return false
    for (const job of this.jobs.values()) if (job.requestId === requestId) return !job.stopped && !job.dropped && this.isLive(job.connectionId)
    return false
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
