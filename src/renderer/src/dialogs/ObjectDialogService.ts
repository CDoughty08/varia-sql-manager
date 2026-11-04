import { actionLimits, dialogSpecs, dialogTitle, isCreateAction, isKindDialogAction, isModalDialog, isServerAction, objectActionSpecs, unknownOutcomeMessage, type ModalDialogId, type PageId } from '../../../shared/actions/catalog.ts'
import { noScriptNotice } from '../../../shared/actions/database.ts'
import { loginDatabaseRolesDescribe, loginLimits, type LoginDatabaseRoles, type NewLoginModel } from '../../../shared/actions/logins.ts'
import { actionPrompts, promptTabFacts } from '../../../shared/actions/prompts.ts'
import type { ActionDescribeRequest, ActionDescribeResult, ActionError, ActionExecuteResult, ActionRequest, ActionStep, DatabaseFileRef, DatabaseStateModel, DeleteTarget } from '../../../shared/actions/schema.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { FolderId } from '../../../shared/explorer/catalog.ts'
import type { ExplorerNodeRef, ObjectRef } from '../../../shared/explorer/refs.ts'
import type { LongRunKind } from '../../../shared/long-runs.ts'
import { wellFormed } from '../../../shared/ssis/schema.ts'
import type { ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { otherLoginConnections } from '../actions/ObjectActionService'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import { deliverScript, type DeliverScriptDeps } from '../scripting/deliver'
import { scriptFileName, scriptObjectLabel } from '../scripting/ScriptingService'
import type { LiveConnection } from '../services/connections'
import type { ServerFilePick } from '../server-files/ServerFilePickerService'
import { filePathsText } from './database-gone'
import { definitionOf, type BuiltRequest, type DialogConfirmation, type DialogContext, type DialogDraft, type DialogEffects, type DialogModel } from './definitions'
import { emptySecrets, mappable, type SecretState } from './new-login'

/**
 * loading → ready, or loadFailed; OK → (confirming →) executing → closed (`succeeded` for a dialog that stays open on its
 * steps), or failed (or stopped); a lost server → disconnected. Check Again reads the object again (`loading` with the model kept).
 */
export type DialogPhase = 'loading' | 'ready' | 'loadFailed' | 'confirming' | 'scripting' | 'executing' | 'succeeded' | 'failed' | 'stopped' | 'disconnected'
export interface OpenObjectDialog {
  /** Changes with every dialog, so the frame remounts. */
  readonly id: number
  readonly dialog: ModalDialogId
  readonly connectionId: string
  /** The tree node it was opened for, which focus returns to. */
  readonly nodeId: number
  /** It was opened on a folder (Databases › Attach…): the folder is its listing, and `target` is the folder's server. */
  readonly folder?: boolean
  readonly target: ObjectRef
  /** The object as Object Explorer shows it. */
  readonly label: string
  /** The title bar: "Delete Object", "Database Properties - AppData". */
  readonly title: string
  /** The Connection box: the server as connected to and the login. */
  readonly server: string
  readonly login?: string
  readonly page: PageId
  readonly phase: DialogPhase
  readonly model?: DialogModel
  readonly draft?: DialogDraft
  readonly error?: ActionError
  readonly steps?: readonly ActionStep[]
  /** An info line for the message bar (a script delivered, informational messages). */
  readonly notice?: string
  /** Delete Object on a database: Varia's query tabs whose session holds an open transaction there (A7), named as `promptTabFacts` bounds them. */
  readonly tabsWithTransactions?: readonly string[]
  readonly moreTabsWithTransactions?: number
  /** What the password fields hold (never their values), for dialogs with any (`definition.secrets`). */
  readonly secretState?: SecretState
  /** Why a window close, Disconnect or Restart was just refused while the dialog's long run runs: the dialog covers the banner. */
  readonly refusal?: string
  /** User Mapping's reads of the databases selected so far (`loadDatabaseRoles`), by database name. */
  readonly databaseRoles?: ReadonlyMap<string, DatabaseRolesLookup>
  /** Delete Object on a login: Varia's other connections that sign in as it (critic D4-3), by their labels. */
  readonly loginConnections?: readonly string[]
  /** Counts the times the secret slot was emptied while the dialog stayed open (`spentSecrets`): the password fields, which keep their
   *  text themselves, remount on it and come back empty. */
  readonly secretEpoch?: number
}
/** One database's roles, guest state and schemas, as User Mapping reads them when its row is selected. */
export type DatabaseRolesLookup = { readonly state: 'loading' } | { readonly state: 'ready'; readonly value: LoginDatabaseRoles } | { readonly state: 'failed'; readonly error: ActionError }
/**
 * A database an action removed (D3 §8): the server as connected to, so its Properties documents can say where it was. A
 * detached one (D3b) carries the files it left on the server (`filesKept`, possibly none listed), which a deleted one never has.
 */
export interface DatabaseGone { readonly connectionId: string; readonly server: string; readonly database: string; readonly filesKept?: readonly DatabaseFileRef[] }
export interface ObjectDialogSnapshot { readonly open?: OpenObjectDialog }
export interface ObjectDialogServiceOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText' | 'confirmOpenConnections' | 'confirmAction'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly explorer: {
    listingFolderOf(nodeId: number): number | undefined
    reconcile(nodeId: number, options?: { readonly select?: ExplorerNodeRef }): void
    /** The tree's node for a server's folder, if it has been listed. */
    folderNode?(connectionId: string, owner: ObjectRef, folder: FolderId): number | undefined
  }
  /** The server file picker a dialog's Add… and "…" buttons open (Attach Databases). */
  readonly serverFiles?: { pick(request: ServerFilePick): Promise<string | undefined> }
  /** The long-run registry: a dialog whose definition names a kind (Attach, New Login) registers its run while OK runs, so
   *  closing the window, disconnecting its server and Restart are refused meanwhile. */
  readonly longRuns?: { begin(run: { readonly kind: LongRunKind; readonly connectionId: string; readonly server: string; refused?(message: string): void }): Disposable }
  readonly documents: DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly focusEditor?: () => void
  /** A database a dialog took offline or brought online (DatabasePropertiesService follows it). */
  readonly databaseState?: (connectionId: string, database: string, offline: boolean) => void
  readonly newId?: () => string
  /** A success notice (Unlock Login's), as the object actions' toast; none without it. */
  readonly notify?: (message: string) => void
  /** An action removed a database: its Properties documents turn orphan and a toast counts the query windows that used it. */
  readonly databaseGone?: (gone: DatabaseGone) => void
  /** The names of the open query tabs among these ids (query session ids), in tab order: Delete Object names those its describe found
   *  holding an open transaction in the database (A7), whatever database each tab is in. */
  readonly tabNames?: (ids: readonly string[]) => readonly string[]
}

/** A password field of an object dialog. Their values live only in the service's secret slot, never in its snapshot. The old
 *  password is Login Properties' (Specify old password). */
export type SecretField = 'password' | 'confirm' | 'oldPassword'

export const dialogMessages = {
  disconnected: 'The server was disconnected.',
  /** Stop, when the backend could not confirm in time that SQL Server ended the statement. */
  stopped: 'The action was stopped, but SQL Server did not confirm it in time, so whether it completed is unknown. Refresh Object Explorer to check.',
  busy: 'Wait for the action to finish, or stop it first.'
} as const
const error = (code: ActionError['code'], message: string): ActionError => ({ code, message, retryable: true })

/**
 * The modal object dialogs (SSMS's Delete Object; Database Properties is a document, DatabasePropertiesService): at most one open. Opening describes the
 * object in the backend; OK builds the definition's request and executes it, closing on success; the Script button
 * scripts the same request to a new query, a file or the clipboard and leaves the dialog open, as SSMS does. Stop
 * cancels a running action in SQL Server. Failures are values in the snapshot; nothing throws into React.
 */
export class ObjectDialogService extends SnapshotStore<ObjectDialogSnapshot> implements Disposable {
  private readonly newId: () => string
  private readonly unsubscribe: () => void
  private dialogs = 0
  /** The request in flight (describe, script or execute), so Stop and a disconnect can cancel it. */
  private request?: { readonly id: string; readonly dialog: number }
  /** User Mapping's read in flight, apart from `request`: OK and Script run while it reads, and Stop never cancels it. */
  private lookup?: { readonly id: string; readonly dialog: number; readonly database: string }
  /** A page's own describes (Attach's Add, a path check), which Close and a disconnect cancel. */
  private readonly extra = new Set<string>()
  private disposed = false
  /** The open dialog's password fields (New Login's Password and Confirm password): never published, cleared when the dialog
   *  closes, opens anew, succeeds or loses its server, and on dispose. Only ok() reads them. */
  private readonly secrets = new Map<SecretField, string>()
  /** The error showProblem put up, so an edit that resolves it can take it down. */
  private problem?: ActionError
  /** The tree node the open dialog was opened for, which a hand-off (Unlock's Set a new password…) opens the next dialog on. */
  private node?: ExplorerMenuNode
  /** What a hand-off sets over the next dialog's first draft (Login Properties: Login is locked out cleared), by that dialog's id. */
  private patch?: { readonly dialog: number; readonly value: Readonly<Record<string, unknown>> }

  constructor(private readonly options: ObjectDialogServiceOptions) {
    super({})
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.unsubscribe = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } })
  }

  get current(): OpenObjectDialog | undefined { return this.getSnapshot().open }

  /** Opens `dialog` for an Object Explorer node and describes it; refused while another dialog is open. A folder's action
   *  (Attach) opens on its folder, with the folder's server as the target. `patch` goes over its first draft (a hand-off's). */
  open(dialog: ModalDialogId, node: ExplorerMenuNode, patch?: Readonly<Record<string, unknown>>): void {
    if (this.disposed) return
    if (!isModalDialog(dialog)) throw new Error('That dialog opens as a document.')
    if (this.current) throw new Error('Close the open dialog first.')
    const definition = definitionOf(dialog)
    // A folder's action (Attach) opens on its folder and targets the folder's server; a create action (New Login) names its own
    // target; any other acts on its node's object.
    const action = dialogSpecs[dialog].action
    const folder = isServerAction(action) || isCreateAction(action) || isKindDialogAction(action) ? undefined : objectActionSpecs[action].folder
    const target = definition.targetOf ? definition.targetOf(node)
      : node.ref.type === 'object' ? (folder ? undefined : node.ref.object) : folder && node.ref.folder === folder ? node.ref.owner : undefined
    const connection = this.options.connections.getSnapshot().find(item => item.id === node.connectionId && !item.lost)
    if (!target || !connection) throw new Error('Connect to the server first.')
    const label = folder ? connection.server : scriptObjectLabel(target)
    const open: OpenObjectDialog = {
      id: ++this.dialogs, dialog, connectionId: node.connectionId, nodeId: node.id, ...folder ? { folder: true } : {}, target, label, title: dialogTitle(dialog, label), server: connection.server,
      ...(connection.login ? { login: connection.login } : {}), page: dialogSpecs[dialog].pages[0].id, phase: 'loading', ...(definition.secrets ? { secretState: emptySecrets } : {})
    }
    this.secrets.clear()
    this.node = node
    this.patch = patch ? { dialog: open.id, value: patch } : undefined
    this.publish({ open })
    void this.describe(open)
  }
  setPage(page: PageId): void {
    const open = this.current
    if (open && dialogSpecs[open.dialog].pages.some(item => item.id === page)) this.update(open, { page })
  }
  /** Changes the draft, from a patch or from the draft as it is now (a page's async step, Attach's Add, reads the latest). */
  updateDraft(patch: Partial<DialogDraft> | ((draft: DialogDraft) => Partial<DialogDraft>)): void {
    const open = this.current
    if (!open?.draft || open.phase === 'executing' || open.phase === 'disconnected' || open.phase === 'succeeded') return
    this.update(open, { draft: { ...open.draft, ...typeof patch === 'function' ? patch(open.draft) : patch } as DialogDraft })
    this.recheckProblem()
  }
  /** Why OK cannot run now with the dialog's draft (its definition's `blocked`: Attach's missing data file, Take Offline's
   *  sessions), beside OK, which it disables; none once the dialog cannot run anything. */
  blockedReason(open: OpenObjectDialog | undefined = this.current): string | undefined {
    return open?.model && open.draft && open.phase !== 'succeeded' && open.phase !== 'loadFailed' && open.phase !== 'disconnected' ? definitionOf(open.dialog).blocked?.(open.model, open.draft) : undefined
  }
  /** Check Again: reads the object again, keeping the draft, as SSMS counts connections when its dialog opens. */
  reload(): void {
    const open = this.current
    if (!open || !open.model || (open.phase !== 'ready' && open.phase !== 'failed' && open.phase !== 'stopped')) return
    this.update(open, { phase: 'loading', error: undefined, notice: undefined })
    void this.describe(open)
  }
  /** A password field changed: its value goes to the secret slot, and the snapshot learns only whether it is empty, matches its
   *  confirmation and is well formed. Ignored while OK runs, after the server is lost, or in a dialog without password fields. */
  setSecret(field: SecretField, value: string): void {
    const open = this.current
    if (!open?.secretState || open.phase === 'executing' || open.phase === 'disconnected') return
    if (value) this.secrets.set(field, value)
    else this.secrets.delete(field)
    const password = this.secrets.get('password') ?? ''
    const secretState: SecretState = {
      password: password ? 'set' : 'empty', matches: password === (this.secrets.get('confirm') ?? ''), wellFormed: wellFormed(password), tooLong: password.length > loginLimits.password
    }
    const current = open.secretState
    if (current.password !== secretState.password || current.matches !== secretState.matches || current.wellFormed !== secretState.wellFormed || current.tooLong !== secretState.tooLong) this.update(open, { secretState })
    this.recheckProblem()
  }
  /**
   * User Mapping selected a database: reads its roles, whether guest can connect and its schemas, once per dialog (again after a
   * failure), as SSMS's InitializeRoleMembership does when a row is selected. A read still running for another database is
   * cancelled and forgotten, so moving through the grid never queues reads behind the read gates.
   */
  loadDatabaseRoles(database: string): void {
    const open = this.current
    if (!open?.model || open.phase === 'loadFailed' || open.phase === 'disconnected' || !dialogSpecs[open.dialog].pages.some(page => page.id === 'userMapping')) return
    // A database that cannot be mapped (offline, or closed to this login) is not read: its page says why instead.
    const listed = (open.model as NewLoginModel).databases.find(item => item.name === database)
    if (listed && !mappable(listed)) return
    const known = open.databaseRoles?.get(database)
    if (known && known.state !== 'failed') return
    const stale = this.lookup
    let lookups = new Map(open.databaseRoles ?? [])
    if (stale) {
      this.lookup = undefined
      this.cancel([stale.id])
      if (stale.dialog === open.id) lookups.delete(stale.database)
    }
    const requestId = this.newId()
    this.lookup = { id: requestId, dialog: open.id, database }
    lookups = lookups.set(database, { state: 'loading' })
    this.update(open, { databaseRoles: lookups })
    void this.readDatabaseRoles(open, database, requestId)
  }
  /** Reads one database for User Mapping; Login Properties' read names its login, whose user and roles there it reads too, and the
   *  definition takes them into its model and draft (`lookedUp`). */
  private async readDatabaseRoles(open: OpenObjectDialog, database: string, requestId: string): Promise<void> {
    const definition = definitionOf(open.dialog), login = definition.rolesLogin?.(open.target)
    const result = await this.call(() => this.options.api.describeObject({
      connectionId: open.connectionId, requestId, dialog: loginDatabaseRolesDescribe, target: { kind: 'database', name: database }, ...(login !== undefined ? { login } : {})
    }))
    if (this.lookup?.id !== requestId) return
    this.lookup = undefined
    const current = this.current
    if (this.disposed || current?.id !== open.id || current.phase === 'disconnected') return
    const value = result.ok ? result.value.loginDatabaseRoles : undefined
    const failure = !result.ok ? error('SQL_ERROR', result.error) : result.value.error ?? (value ? undefined : error('NOT_FOUND', 'The database could not be read.'))
    const looked = !failure && value && current.model && current.draft && definition.lookedUp ? definition.lookedUp(current.model, current.draft, database, value) : undefined
    this.update(current, {
      databaseRoles: new Map(current.databaseRoles ?? []).set(database, failure || !value ? { state: 'failed', error: failure! } : { state: 'ready', value }),
      ...(looked ? { model: looked.model, draft: looked.draft } : {})
    })
  }
  private cancelLookup(): void {
    if (this.lookup) this.cancel([this.lookup.id])
    this.lookup = undefined
  }

  /** The server file picker for the open dialog's server (Attach's Add… and "…"): the chosen path, or undefined. */
  async pickServerFile(request: Omit<ServerFilePick, 'connectionId'>): Promise<string | undefined> {
    const open = this.current
    if (!open || !this.options.serverFiles || open.phase === 'executing' || open.phase === 'disconnected') return undefined
    const path = await this.options.serverFiles.pick({ ...request, connectionId: open.connectionId })
    return this.current?.id === open.id && this.current.phase !== 'disconnected' ? path : undefined
  }

  /**
   * A describe beyond the dialog's first, for its page (Attach's Add reads one .mdf; a typed path is checked with the server
   * file picker's `exists`): on the dialog's server and target. Its answer, or undefined when the dialog closed or its server
   * went meanwhile; Close and a disconnect cancel it in the backend.
   */
  async describeMore(request: Pick<ActionDescribeRequest, 'attach' | 'files'> & { readonly dialog?: ActionDescribeRequest['dialog'] }): Promise<ApiResult<ActionDescribeResult> | undefined> {
    const open = this.current
    if (!open || this.disposed || open.phase === 'disconnected') return undefined
    const requestId = this.newId()
    this.extra.add(requestId)
    const result = await this.call(() => this.options.api.describeObject({ connectionId: open.connectionId, requestId, dialog: request.dialog ?? open.dialog, target: open.target,
      ...request.attach ? { attach: request.attach } : {}, ...request.files ? { files: request.files } : {} }))
    this.extra.delete(requestId)
    const current = this.current
    return !this.disposed && current?.id === open.id && current.phase !== 'disconnected' ? result : undefined
  }
  /** For tests: whether the secret slot holds a value, which only an open dialog's password fields put there. */
  get holdsSecrets(): boolean { return this.secrets.size > 0 }

  /** The Script button: the action's script to `destination`; the dialog stays open. */
  async script(destination: ScriptDestination): Promise<void> {
    const open = this.current
    if (!open || !open.model || !open.draft || (open.phase !== 'ready' && open.phase !== 'failed' && open.phase !== 'stopped')) return
    const definition = definitionOf(open.dialog)
    const built = definition.request(open.target, open.model, open.draft, open.secretState ?? emptySecrets)
    // As SSMS says when nothing changed in a properties dialog.
    if (!built) { this.update(open, { error: undefined, notice: noScriptNotice }); return }
    if ('problem' in built) { this.showProblem(open, built.problem); return }
    const requestId = this.begin(open)
    this.update(open, { phase: 'scripting', error: undefined, notice: undefined })
    const result = await this.call(() => this.options.api.scriptObjectAction({ ...built, connectionId: open.connectionId, requestId } as ActionRequest))
    if (!this.end(open, requestId)) return
    const failure = !result.ok ? error('SQL_ERROR', result.error) : result.value.error
    if (failure || !result.ok || result.value.text === undefined) { this.update(open, { phase: 'ready', error: failure ?? error('SQL_ERROR', 'No script was produced.') }); return }
    try {
      const notice = await deliverScript({ destination, text: result.value.text, database: result.value.database, connectionId: open.connectionId, fileName: definition.fileName?.(open.draft) ?? scriptFileName(open.target) }, this.options)
      this.update(open, { phase: 'ready', ...(notice ? { notice } : {}) })
    } catch (failure) { this.update(open, { phase: 'ready', error: error('SQL_ERROR', failure instanceof Error ? failure.message : 'The script could not be delivered.') }) }
  }

  /** OK: nothing to do closes; otherwise the action runs, and success closes and runs the definition's afterSuccess. */
  async ok(): Promise<void> {
    const open = this.current
    if (!open || open.phase === 'executing' || open.phase === 'scripting' || open.phase === 'loading' || open.phase === 'confirming') return
    if (open.phase === 'disconnected' || open.phase === 'loadFailed' || open.phase === 'succeeded' || !open.model || !open.draft) { this.close(); return }
    const definition = definitionOf(open.dialog)
    // A hand-off (Unlock's Set a new password…) runs nothing here: unless OK is blocked, this dialog closes and the next one opens.
    const handOff = definition.handOff?.(open.model, open.draft)
    if (handOff) { if (!this.blockedReason(open)) this.handOver(handOff); return }
    let built = definition.request(open.target, open.model, open.draft, open.secretState ?? emptySecrets)
    if (!built) { this.close(); return }
    // A draft's own problem (Attach: a data file not found) shows in the message bar; a definition's other reasons (Take Offline:
    // sessions still connected) keep OK disabled with the reason beside it, so Enter does nothing either.
    if ('problem' in built) { this.showProblem(open, built.problem); return }
    if (this.blockedReason(open)) return
    const context = this.context(open)
    const confirmation = definition.confirm?.(open.model, built, context)
    if (confirmation) {
      // Main's message box; a failure or a dialog that closed meanwhile counts as No, and No sends nothing.
      this.update(open, { phase: 'confirming', error: undefined, notice: undefined })
      const answer = await this.confirmed(confirmation)
      // Cancel, a lost server or a disposed service while the box was up: nothing runs.
      if (this.disposed || this.current?.id !== open.id || this.current.phase !== 'confirming') return
      if (!answer) { this.update(open, { phase: 'ready' }); return }
      if (confirmation === 'openConnections') built = definition.withConfirmation?.(built, confirmation) ?? built
    }
    const requestId = this.begin(open)
    this.update(open, { phase: 'executing', error: undefined, notice: undefined, steps: undefined })
    const sent: BuiltRequest = built, draft = open.draft
    // A long run (Attach, New Login): closing the window, disconnecting its server and Restart are refused until it ends, and
    // the dialog, which covers the command banner, says so.
    const run = definition.longRun ? this.options.longRuns?.begin({ kind: definition.longRun, connectionId: open.connectionId, server: open.server, refused: refusal => this.update(open, { refusal }) }) : undefined
    let result: ApiResult<ActionExecuteResult>
    try {
      // The passwords join only this request, read from the slot as it is sent; the request object is not kept.
      const attach = !!definition.secrets?.(draft, sent), old = attach && !!definition.oldPassword?.(sent)
      result = await this.call(() => this.options.api.executeObjectAction({
        ...sent, ...(attach ? { secrets: { password: this.secrets.get('password') ?? '', ...(old ? { oldPassword: this.secrets.get('oldPassword') ?? '' } : {}) } } : {}),
        connectionId: open.connectionId, requestId
      } as ActionRequest))
    } finally { run?.dispose(); this.update(open, { refusal: undefined }) }
    if (!this.end(open, requestId)) return
    const value: ActionExecuteResult | undefined = result.ok ? result.value : undefined
    if (value && definition.removesDatabase?.(open.target, value.steps, !value.error) && open.target.name !== undefined) {
      const gone = { connectionId: open.connectionId, server: open.server, database: open.target.name, ...open.dialog === 'detachDatabase' ? { filesKept: value.filesKept ?? [] } : {} }
      try { this.options.databaseGone?.(gone) } catch (failure) { onUnexpectedError(failure) }
    }
    if (value && !value.error) {
      this.secrets.clear()
      this.cancelLookup()
      // SQL Server's informational messages (a database left SINGLE_USER) stay readable in a dialog that stays open.
      if (definition.keepOpen) this.update(open, { phase: 'succeeded', steps: value.steps, ...(value.messages.length ? { notice: value.messages.join(' ') } : {}) })
      else this.publish({})
      try { definition.afterSuccess(this.effectsOf(open), sent, { target: open.target, label: open.label }, open.model, context) } catch (failure) { onUnexpectedError(failure) }
      this.reconcileChanged(open, open.model, value.steps)
      return
    }
    // Steps that completed before a failure or Stop changed the object (a database dropped, then its history step
    // stopped), so the listing shows what is there now; so may a step Stop reached after SQL Server finished it (an attach). A
    // dialog that creates an object shows it where it is listed.
    const partial = !!value?.steps.some(step => step.status === 'done' || step.status === 'cancelled')
    if (partial) {
      const effects = this.effectsOf(open)
      try { if (definition.afterPartial) definition.afterPartial(effects, sent); else effects.refreshListing() } catch (failure) { onUnexpectedError(failure) }
      this.reconcileChanged(open, open.model, value!.steps)
    }
    // Completed steps that used the secret slot (Login Properties' password change): a retry must not send it again.
    const spent = partial ? this.spend(open, value!.steps) : undefined
    const withNote = (failure: ActionError): ActionError => spent ? { ...failure, message: failure.message + ' ' + spent.note } : failure
    // Stop: the backend answers once SQL Server has ended the statement, saying what completed before it.
    if (value?.error?.code === 'CANCELLED') { this.update(open, { phase: 'stopped', error: withNote(value.error), steps: value.steps, ...spent?.patch }); if (partial) this.reloadAfterPartial(open); return }
    if (!result.ok && result.code === 'CANCELLED') { this.update(open, { phase: 'stopped', error: error('CANCELLED', dialogMessages.stopped) }); return }
    const failure = value?.error ?? (!result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST') ? error('CONNECTION_LOST', unknownOutcomeMessage) : error('SQL_ERROR', result.ok ? 'The action failed.' : result.error))
    const model = spent?.patch.model ?? definition.afterFailure?.(open.model, failure) ?? open.model
    this.update(open, { phase: 'failed', error: withNote(failure), ...(value ? { steps: value.steps } : {}), ...spent?.patch, model })
    if (partial) { this.reloadAfterPartial(open); return }
    // SSMS counts other connections when OK is pressed: when nothing ran and the fresh model needs the question this OK
    // did not ask, it is asked at once rather than on the next OK.
    if (!confirmation && model !== open.model && !value?.steps.some(step => step.status === 'done') && definition.confirm?.(model, built, this.context(open))) await this.ok()
  }

  /** Main's box for a confirmation: Open Connections' Yes, or any action prompt answer but its cancel one. A failure counts as No. */
  private async confirmed(confirmation: DialogConfirmation): Promise<boolean> {
    if (confirmation === 'openConnections') {
      const answer = await this.call(() => this.options.api.confirmOpenConnections())
      return answer.ok && answer.value
    }
    const answer = await this.call(() => this.options.api.confirmAction(confirmation))
    return answer.ok && answer.value !== actionPrompts[confirmation.prompt].cancelAnswer
  }
  /** What a definition knows besides its model: Varia's other connections that sign in as a login target, as they are now. */
  private context(open: OpenObjectDialog): DialogContext {
    if (open.target.kind !== 'login') return {}
    const labels = otherLoginConnections(this.options.connections.getSnapshot(), open.connectionId, open.target.name)
    return labels.length ? { loginConnections: labels } : {}
  }
  /** After a partial run whose done steps used the secret slot: empties the slot and the password fields (`secretEpoch` remounts
   *  them), and takes the definition's model and draft; the note joins the failure. */
  private spend(open: OpenObjectDialog, steps: readonly ActionStep[]): { readonly patch: Partial<OpenObjectDialog> & { readonly model: DialogModel }; readonly note: string } | undefined {
    const spent = open.model && open.draft ? definitionOf(open.dialog).spentSecrets?.(open.model, open.draft, steps) : undefined
    if (!spent) return undefined
    this.secrets.clear()
    return { note: spent.note, patch: { model: spent.model, draft: spent.draft, secretState: emptySecrets, secretEpoch: (open.secretEpoch ?? 0) + 1 } }
  }

  /** Detach Database's Copy paths: the files that stay on the server, one path per line, to the clipboard; the message bar says how it went. */
  async copyPaths(): Promise<void> {
    const open = this.current
    const files = open?.dialog === 'detachDatabase' ? (open.model as DatabaseStateModel | undefined)?.files ?? [] : []
    if (!open || files.length === 0) return
    const result = await this.call(() => this.options.api.writeClipboardText(filePathsText(files)))
    if (this.disposed || this.current?.id !== open.id) return
    if (result.ok) this.update(open, { notice: files.length === 1 ? 'Copied 1 path.' : `Copied ${files.length.toLocaleString('en-US')} paths.` })
    else this.update(open, { error: error('SQL_ERROR', result.error) })
  }

  /** Stop: cancels the running action in SQL Server; the dialog reports Stopped, with what completed, when its answer comes. */
  stop(): void {
    const open = this.current, request = this.request
    if (!open || !request || request.dialog !== open.id) return
    this.cancel([request.id])
  }

  /** A hand-off: this dialog closes and the next opens on the same node, with the patch over its first draft. */
  private handOver(next: { readonly dialog: ModalDialogId; readonly patch: Readonly<Record<string, unknown>> }): void {
    const node = this.node
    if (!node || !this.close()) return
    try { this.open(next.dialog, node, next.patch) } catch (failure) { onUnexpectedError(failure) }
  }

  /** Cancel or Escape. Refused while an action runs (Stop first); returns whether the dialog closed. */
  close(): boolean {
    const open = this.current
    if (!open) return true
    if (open.phase === 'executing') return false
    if (this.request?.dialog === open.id) { this.cancel([this.request.id]); this.request = undefined }
    this.cancelLookup()
    this.secrets.clear()
    this.cancelExtra()
    this.publish({})
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.secrets.clear()
    if (this.request) this.cancel([this.request.id])
    this.request = undefined
    this.cancelLookup()
    this.cancelExtra()
    this.disposed = true
    this.unsubscribe()
    this.clearListeners()
  }

  private async describe(open: OpenObjectDialog): Promise<void> {
    // `open` is the dialog as it was when the read began: with a model only for Check Again.
    const requestId = this.begin(open)
    const result = await this.call(() => this.options.api.describeObject({ connectionId: open.connectionId, requestId, dialog: open.dialog, target: open.target }))
    if (!this.end(open, requestId)) return
    const failure = !result.ok ? error('SQL_ERROR', result.error) : result.value.error
    const definition = definitionOf(open.dialog)
    const model = result.ok ? definition.modelOf(result.value) : undefined
    if (failure || !model) { this.update(open, { phase: 'loadFailed', error: failure ?? error('NOT_FOUND', 'The object could not be read.') }); return }
    // Check Again keeps what the user chose; a hand-off's patch goes over the first draft.
    const patch = this.patch?.dialog === open.id ? this.patch.value : undefined
    this.patch = undefined
    this.update(open, { phase: 'ready', model, draft: open.draft ?? { ...definition.initialDraft(model, open.target), ...patch } as DialogDraft })
    if (open.dialog === 'deleteObject' && open.target.kind === 'database') this.nameTabTransactions(open, (model as DeleteTarget).transactionTabs ?? [])
    if (definition.runOnOpen && !open.model) await this.ok()
    if (open.dialog === 'deleteObject' && open.target.kind === 'login') {
      const labels = this.context(open).loginConnections
      if (labels) this.update(open, { loginConnections: labels })
    }
  }
  /**
   * Reads the model again once steps completed before a failure or Stop changed what the page lists (definition.reloadsAfterPartial:
   * a login's Delete that dropped users and then failed would go on listing them as mapped). The failure and its steps stay shown;
   * a read that fails keeps the old model, and an answer that comes once OK runs again is dropped.
   */
  private reloadAfterPartial(open: OpenObjectDialog): void {
    const definition = definitionOf(open.dialog)
    if (!definition.reloadsAfterPartial?.(open.target)) return
    void (async () => {
      const requestId = this.begin(open)
      const result = await this.call(() => this.options.api.describeObject({ connectionId: open.connectionId, requestId, dialog: open.dialog, target: open.target }))
      if (!this.end(open, requestId)) return
      const current = this.current
      const model = result.ok && !result.value.error ? definition.modelOf(result.value) : undefined
      if (!model || !current || (current.phase !== 'failed' && current.phase !== 'stopped')) return
      // The fresh describe holds nothing User Mapping read (roles, users past its scan): those databases are read again, one at a time,
      // and until each answers, its changed rows count as not read, so OK refuses rather than dropping their changes.
      const again = current.model && current.draft ? definition.readAgain?.(current.model, current.draft) ?? [] : []
      const roles = new Map(current.databaseRoles ?? [])
      for (const database of again) roles.delete(database)
      this.update(current, { model, ...(again.length ? { databaseRoles: roles } : {}) })
      for (const database of again) {
        const now = this.current
        // A database the user selected meanwhile is read by that selection; one left out while it reads stays unread until selected.
        if (this.disposed || now?.id !== open.id || (now.phase !== 'failed' && now.phase !== 'stopped') || now.databaseRoles?.has(database) || this.lookup) continue
        const lookupId = this.newId()
        this.lookup = { id: lookupId, dialog: open.id, database }
        this.update(now, { databaseRoles: new Map(now.databaseRoles ?? []).set(database, { state: 'loading' }) })
        await this.readDatabaseRoles(now, database, lookupId)
      }
    })().catch(onUnexpectedError)
  }
  /** Reloads the folders a reply's done steps changed besides the listing (definition.changedFolders), where the tree has listed them. */
  private reconcileChanged(open: OpenObjectDialog, model: DialogModel | undefined, steps: readonly ActionStep[]): void {
    try {
      const changed = model && definitionOf(open.dialog).changedFolders?.(model, steps)
      if (!changed) return
      for (const database of changed.databases) this.reloadFolder(open, { kind: 'database', name: database }, changed.folder)
    } catch (failure) { onUnexpectedError(failure) }
  }
  /** Names Varia's query tabs whose session the describe found holding an open transaction in the database (A7). */
  private nameTabTransactions(open: OpenObjectDialog, ids: readonly string[]): void {
    const names = ids.length && this.options.tabNames ? this.options.tabNames(ids) : []
    if (names.length) this.update(open, promptTabFacts(names))
  }
  private async call<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
  }
  private begin(open: OpenObjectDialog): string {
    const id = this.newId()
    this.request = { id, dialog: open.id }
    return id
  }
  /** Whether the answer still matters: its dialog is open and not disconnected. */
  private end(open: OpenObjectDialog, requestId: string): boolean {
    if (this.request?.id === requestId) this.request = undefined
    const current = this.current
    return !this.disposed && current?.id === open.id && current.phase !== 'disconnected'
  }
  private update(open: OpenObjectDialog, patch: Partial<OpenObjectDialog>): void {
    const current = this.current
    if (this.disposed || current?.id !== open.id) return
    const next = { ...current, ...patch } as OpenObjectDialog & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.publish({ open: next })
  }
  /** A problem OK or Script found in the draft: shown until an edit resolves it (recheckProblem) or the next OK or Script. */
  private showProblem(open: OpenObjectDialog, message: string): void {
    const shown = error('NOT_SUPPORTED', message)
    this.problem = shown
    this.update(open, { error: shown })
  }
  /** After an edit: a problem the draft showed goes once the draft no longer has it (a server's error stays until the next OK). */
  private recheckProblem(): void {
    const open = this.current
    if (!open?.error || open.error !== this.problem || !open.model || !open.draft) return
    const built = definitionOf(open.dialog).request(open.target, open.model, open.draft, open.secretState ?? emptySecrets)
    if (built && 'problem' in built && built.problem === open.error.message) return
    this.problem = undefined
    this.update(open, { error: undefined })
  }
  /** Reloads the folder the object is listed in, or the folder the dialog opened on, selecting `select` once it is listed. */
  private refreshListing(open: OpenObjectDialog, select?: ExplorerNodeRef): void {
    const folder = open.folder ? open.nodeId : this.options.explorer.listingFolderOf(open.nodeId)
    if (folder === undefined) return
    if (select) this.options.explorer.reconcile(folder, { select })
    else this.options.explorer.reconcile(folder)
  }
  private cancelExtra(): void {
    if (!this.extra.size) return
    this.cancel([...this.extra])
    this.extra.clear()
  }
  /** What a definition's afterSuccess and afterPartial may do for this dialog. */
  private effectsOf(open: OpenObjectDialog): DialogEffects {
    return {
      refreshListing: select => this.refreshListing(open, select),
      reveal: (folder, object) => this.reveal(open, folder, object),
      reload: (owner, folder) => this.reloadFolder(open, owner, folder),
      databaseState: offline => { if (open.target.kind === 'database' && open.target.name !== undefined) this.options.databaseState?.(open.connectionId, open.target.name, offline) },
      notify: message => this.options.notify?.(message)
    }
  }
  /** Reloads the server's folder a new object is listed in and selects it there; a folder never listed loads fresh when opened. */
  private reveal(open: OpenObjectDialog, folder: FolderId, object: ObjectRef): void {
    const node = this.options.explorer.folderNode?.(open.connectionId, { kind: 'server' }, folder)
    if (node !== undefined) this.options.explorer.reconcile(node, { select: { type: 'object', object } })
  }
  /** Reloads an owner's folder (a database's Users) when the tree has listed it. */
  private reloadFolder(open: OpenObjectDialog, owner: ObjectRef, folder: FolderId): void {
    const node = this.options.explorer.folderNode?.(open.connectionId, owner, folder)
    if (node !== undefined) this.options.explorer.reconcile(node)
  }
  /** A server that disconnects leaves only Close; its request is cancelled. */
  private connectionsChanged(): void {
    const open = this.current
    if (!open || open.phase === 'disconnected' || this.options.connections.getSnapshot().some(item => item.id === open.connectionId && !item.lost)) return
    if (this.request?.dialog === open.id) { this.cancel([this.request.id]); this.request = undefined }
    this.cancelLookup()
    this.secrets.clear()
    this.cancelExtra()
    // An action that was running may or may not have finished.
    this.update(open, { phase: 'disconnected', error: error('CONNECTION_LOST', open.phase === 'executing' ? unknownOutcomeMessage : dialogMessages.disconnected) })
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
