import { actionLimits, dialogSpecs, dialogTitle, isModalDialog, unknownOutcomeMessage, type ModalDialogId, type PageId } from '../../../shared/actions/catalog.ts'
import { noScriptNotice } from '../../../shared/actions/database.ts'
import { loginDatabaseRolesDescribe, loginLimits, type LoginDatabaseRoles, type NewLoginModel } from '../../../shared/actions/logins.ts'
import { promptTabFacts } from '../../../shared/actions/prompts.ts'
import type { ActionError, ActionExecuteResult, ActionRequest, ActionStep, DeleteTarget } from '../../../shared/actions/schema.ts'
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
import { definitionOf, type BuiltRequest, type DialogDraft, type DialogEffects, type DialogModel } from './definitions'
import { emptySecrets, mappable, type SecretState } from './new-login'

/** loading → ready, or loadFailed; OK → (confirming →) executing → closed, or failed (or stopped); a lost server → disconnected. */
export type DialogPhase = 'loading' | 'ready' | 'loadFailed' | 'confirming' | 'scripting' | 'executing' | 'failed' | 'stopped' | 'disconnected'
export interface OpenObjectDialog {
  /** Changes with every dialog, so the frame remounts. */
  readonly id: number
  readonly dialog: ModalDialogId
  readonly connectionId: string
  /** The tree node it was opened for, which focus returns to. */
  readonly nodeId: number
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
  /** What the password fields hold (never their values), for dialogs with any (`definition.secrets`). */
  readonly secretState?: SecretState
  /** Why a window close, Disconnect or Restart was just refused while the dialog's long run runs: the dialog covers the banner. */
  readonly refusal?: string
  /** User Mapping's reads of the databases selected so far (`loadDatabaseRoles`), by database name. */
  readonly databaseRoles?: ReadonlyMap<string, DatabaseRolesLookup>
  /** Delete Object on a database: Varia's query tabs whose session holds an open transaction there (A7), named as `promptTabFacts` bounds them. */
  readonly tabsWithTransactions?: readonly string[]
  readonly moreTabsWithTransactions?: number
  /** Delete Object on a login: Varia's other connections that sign in as it (critic D4-3), by their labels. */
  readonly loginConnections?: readonly string[]
}
/** One database's roles, guest state and schemas, as User Mapping reads them when its row is selected. */
export type DatabaseRolesLookup = { readonly state: 'loading' } | { readonly state: 'ready'; readonly value: LoginDatabaseRoles } | { readonly state: 'failed'; readonly error: ActionError }
/** A database an action removed (D3 §8): the server as connected to, so its Properties documents can say where it was. */
export interface DatabaseGone { readonly connectionId: string; readonly server: string; readonly database: string }
export interface ObjectDialogSnapshot { readonly open?: OpenObjectDialog }
export interface ObjectDialogServiceOptions {
  readonly api: Pick<VariaApi, 'describeObject' | 'scriptObjectAction' | 'executeObjectAction' | 'cancelObjectActions' | 'writeClipboardText' | 'confirmOpenConnections'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly explorer: {
    listingFolderOf(nodeId: number): number | undefined
    reconcile(nodeId: number, options?: { readonly select?: ExplorerNodeRef }): void
    /** The tree's node for a server's folder, if it has been listed. */
    folderNode?(connectionId: string, owner: ObjectRef, folder: FolderId): number | undefined
    /** The loaded folders of a kind under these databases (ExplorerService.loadedFolders), which an action's other changes reload. */
    loadedFolders?(connectionId: string, folder: FolderId, databases: readonly string[]): readonly number[]
  }
  /** New Login is a long run: while it runs, closing the window, disconnecting its server and Restart are refused. */
  readonly longRuns?: { begin(run: { readonly kind: LongRunKind; readonly connectionId: string; readonly server: string; refused?(message: string): void }): Disposable }
  readonly documents: DeliverScriptDeps['documents']
  readonly files: DeliverScriptDeps['files']
  readonly focusEditor?: () => void
  readonly newId?: () => string
  /** An action removed a database: its Properties documents turn orphan and a toast counts the query windows that used it. */
  readonly databaseGone?: (gone: DatabaseGone) => void
  /** The names of the open query tabs among these ids (query session ids), in tab order: Delete Object names those its describe found
   *  holding an open transaction in the database (A7), whatever database each tab is in. */
  readonly tabNames?: (ids: readonly string[]) => readonly string[]
  /** A success notice (Unlock Login's), as the object actions' toast; none without it. */
  readonly notify?: (message: string) => void
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
  /** Why OK cannot run for the open dialog's model (its definition's `unavailable`), or undefined. */
  unavailable(open: OpenObjectDialog | undefined = this.current): string | undefined {
    return open?.model ? definitionOf(open.dialog).unavailable?.(open.model, open.draft) : undefined
  }

  /** Opens `dialog` for an Object Explorer node and describes it; refused while another dialog is open. `patch` goes over its first
   *  draft (a hand-off's). */
  open(dialog: ModalDialogId, node: ExplorerMenuNode, patch?: Readonly<Record<string, unknown>>): void {
    if (this.disposed) return
    if (!isModalDialog(dialog)) throw new Error('That dialog opens as a document.')
    if (this.current) throw new Error('Close the open dialog first.')
    const definition = definitionOf(dialog)
    const target = definition.targetOf ? definition.targetOf(node) : node.ref.type === 'object' ? node.ref.object : undefined
    const connection = this.options.connections.getSnapshot().find(item => item.id === node.connectionId && !item.lost)
    if (!target || !connection) throw new Error('Connect to the server first.')
    const label = scriptObjectLabel(target)
    const open: OpenObjectDialog = {
      id: ++this.dialogs, dialog, connectionId: node.connectionId, nodeId: node.id, target, label, title: dialogTitle(dialog, label), server: connection.server,
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
  updateDraft(patch: Partial<DialogDraft>): void {
    const open = this.current
    if (open?.draft && open.phase !== 'executing' && open.phase !== 'disconnected') this.update(open, { draft: { ...open.draft, ...patch } })
    this.recheckProblem()
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
    if (open.phase === 'disconnected' || open.phase === 'loadFailed' || !open.model || !open.draft) { this.close(); return }
    const definition = definitionOf(open.dialog)
    // The frame greys OK and the page says why; Enter must not run it either.
    if (definition.unavailable?.(open.model, open.draft)) return
    const handOff = definition.handOff?.(open.model, open.draft)
    if (handOff) { this.handOver(handOff); return }
    let built = definition.request(open.target, open.model, open.draft, open.secretState ?? emptySecrets)
    if (!built) { this.close(); return }
    if ('problem' in built) { this.showProblem(open, built.problem); return }
    // OK is greyed then; Enter still reaches here, and nothing is sent.
    const blocked = definition.blocked?.(open.model)
    if (blocked) { this.update(open, { error: error('NOT_SUPPORTED', blocked) }); return }
    const confirmation = definition.confirm?.(open.model, built)
    if (confirmation) {
      // Main's message box; a failure or a dialog that closed meanwhile counts as No, and No sends nothing.
      this.update(open, { phase: 'confirming', error: undefined, notice: undefined })
      const answer = await this.call(() => this.options.api.confirmOpenConnections())
      // Cancel, a lost server or a disposed service while the box was up: nothing runs.
      if (this.disposed || this.current?.id !== open.id || this.current.phase !== 'confirming') return
      if (!answer.ok || !answer.value) { this.update(open, { phase: 'ready' }); return }
      built = definition.withConfirmation?.(built, confirmation) ?? built
    }
    const requestId = this.begin(open)
    this.update(open, { phase: 'executing', error: undefined, notice: undefined, steps: undefined })
    const sent: BuiltRequest = built, draft = open.draft
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
      const gone = { connectionId: open.connectionId, server: open.server, database: open.target.name }
      try { this.options.databaseGone?.(gone) } catch (failure) { onUnexpectedError(failure) }
    }
    if (value && !value.error) {
      this.secrets.clear()
      this.cancelLookup()
      this.publish({})
      try { definition.afterSuccess(this.effects(open), sent, { target: open.target, label: open.label }) } catch (failure) { onUnexpectedError(failure) }
      this.reconcileChanged(open, open.model, value.steps)
      return
    }
    // Steps that completed before a failure or Stop changed the object (a database dropped, then its history step
    // stopped), so the listing shows what is there now; a dialog that creates an object shows it where it is listed.
    const partial = !!value?.steps.some(step => step.status === 'done')
    if (partial) {
      const effects = this.effects(open)
      try { if (definition.afterPartial) definition.afterPartial(effects, sent); else effects.refreshListing() } catch (failure) { onUnexpectedError(failure) }
      this.reconcileChanged(open, open.model, value!.steps)
    }
    // Stop: the backend answers once SQL Server has ended the statement, saying what completed before it.
    if (value?.error?.code === 'CANCELLED') { this.update(open, { phase: 'stopped', error: value.error, steps: value.steps }); if (partial) this.reload(open); return }
    if (!result.ok && result.code === 'CANCELLED') { this.update(open, { phase: 'stopped', error: error('CANCELLED', dialogMessages.stopped) }); return }
    const failure = value?.error ?? (!result.ok && (result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST') ? error('CONNECTION_LOST', unknownOutcomeMessage) : error('SQL_ERROR', result.ok ? 'The action failed.' : result.error))
    const model = definition.afterFailure?.(open.model, failure) ?? open.model
    this.update(open, { phase: 'failed', error: failure, model, ...(value ? { steps: value.steps } : {}) })
    if (partial) { this.reload(open); return }
    // SSMS counts other connections when OK is pressed: when nothing ran and the fresh model needs the question this OK
    // did not ask, it is asked at once rather than on the next OK.
    if (!confirmation && model !== open.model && !value?.steps.some(step => step.status === 'done') && definition.confirm?.(model, built)) await this.ok()
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
    this.publish({})
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.secrets.clear()
    if (this.request) this.cancel([this.request.id])
    this.request = undefined
    this.cancelLookup()
    this.disposed = true
    this.unsubscribe()
    this.clearListeners()
  }

  private async describe(open: OpenObjectDialog): Promise<void> {
    const requestId = this.begin(open)
    const result = await this.call(() => this.options.api.describeObject({ connectionId: open.connectionId, requestId, dialog: open.dialog, target: open.target }))
    if (!this.end(open, requestId)) return
    const failure = !result.ok ? error('SQL_ERROR', result.error) : result.value.error
    const definition = definitionOf(open.dialog)
    const model = result.ok ? definition.modelOf(result.value) : undefined
    if (failure || !model) { this.update(open, { phase: 'loadFailed', error: failure ?? error('NOT_FOUND', 'The object could not be read.') }); return }
    const patch = this.patch?.dialog === open.id ? this.patch.value : undefined
    this.patch = undefined
    this.update(open, { phase: 'ready', model, draft: { ...definition.initialDraft(model, open.target), ...patch } as DialogDraft })
    if (open.dialog === 'deleteObject' && open.target.kind === 'database') this.nameTabTransactions(open, (model as DeleteTarget).transactionTabs ?? [])
    if (open.dialog === 'deleteObject' && open.target.kind === 'login') {
      const labels = otherLoginConnections(this.options.connections.getSnapshot(), open.connectionId, open.target.name)
      if (labels.length) this.update(open, { loginConnections: labels })
    }
  }
  /**
   * Reads the model again once steps completed before a failure or Stop changed what the page lists (definition.reloadsAfterPartial:
   * a login's Delete that dropped users and then failed would go on listing them as mapped). The failure and its steps stay shown;
   * a read that fails keeps the old model, and an answer that comes once OK runs again is dropped.
   */
  private reload(open: OpenObjectDialog): void {
    const definition = definitionOf(open.dialog)
    if (!definition.reloadsAfterPartial?.(open.target)) return
    void (async () => {
      const requestId = this.begin(open)
      const result = await this.call(() => this.options.api.describeObject({ connectionId: open.connectionId, requestId, dialog: open.dialog, target: open.target }))
      if (!this.end(open, requestId)) return
      const current = this.current
      const model = result.ok && !result.value.error ? definition.modelOf(result.value) : undefined
      if (model && current && (current.phase === 'failed' || current.phase === 'stopped')) this.update(current, { model })
    })().catch(onUnexpectedError)
  }
  /** Reloads the loaded folders a reply's done steps changed besides the listing (definition.changedFolders). */
  private reconcileChanged(open: OpenObjectDialog, model: DialogModel | undefined, steps: readonly ActionStep[]): void {
    try {
      const changed = model && definitionOf(open.dialog).changedFolders?.(model, steps)
      if (!changed) return
      for (const folder of this.options.explorer.loadedFolders?.(open.connectionId, changed.folder, changed.databases) ?? []) this.options.explorer.reconcile(folder)
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
  private refreshListing(open: OpenObjectDialog): void {
    const folder = this.options.explorer.listingFolderOf(open.nodeId)
    if (folder !== undefined) this.options.explorer.reconcile(folder)
  }
  private effects(open: OpenObjectDialog): DialogEffects {
    return {
      refreshListing: () => this.refreshListing(open), reveal: (folder, object) => this.reveal(open, folder, object), reload: (owner, folder) => this.reloadFolder(open, owner, folder),
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
    // An action that was running may or may not have finished.
    this.update(open, { phase: 'disconnected', error: error('CONNECTION_LOST', open.phase === 'executing' ? unknownOutcomeMessage : dialogMessages.disconnected) })
  }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += actionLimits.cancelIds) {
      try { void this.options.api.cancelObjectActions(ids.slice(start, start + actionLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
