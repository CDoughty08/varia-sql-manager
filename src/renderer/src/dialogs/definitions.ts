// The object dialogs' behaviour, one definition per dialog: the model its describe answers, the draft a dialog starts
// from, the action OK sends (and the Script button scripts), SSMS's confirmations before it, and what happens after OK
// succeeds. ObjectDialogService runs the modal ones and ObjectDialog.tsx renders their pages (`dialogPages`);
// DatabasePropertiesService runs Database Properties, a document (src/renderer/src/properties). It is the plug-in point
// for later dialogs (Backup and Restore): a dialog id, its surface and pages in
// src/shared/actions/catalog.ts, a describe in the backend, a definition here, and its pages or sections. No React here,
// so the services and their tests stay in Node.
import { databaseStateOf, type DialogId, type ModalDialogId } from '../../../shared/actions/catalog.ts'
import {
  loginDeleteText, loginMessages, loginPropertiesMessages, loginRefusal, mappedUserKept, unlockHandOffLabel, unlockRefusal, type LoginDatabaseRoles, type LoginFacts, type LoginLockFacts, type LoginMessageId, type NewLoginModel,
  type UnlockChoice
} from '../../../shared/actions/logins.ts'
import { promptLimits, type ActionPromptRequest } from '../../../shared/actions/prompts.ts'
import {
  detachDatabaseStepTitle, dropDatabaseStepTitle, dropUserStepTitle, loginPasswordStepTitle, type ActionDescribeResult, type ActionError, type ActionRequest, type ActionStep, type AttachRequest, type AttachServerFacts,
  type CreateLoginRequest, type DatabasePropertiesModel, type DatabaseStateModel, type DeleteTarget, type LoginPropertiesRequest
} from '../../../shared/actions/schema.ts'
import type { FolderId } from '../../../shared/explorer/catalog.ts'
import { displayText, type ExplorerNodeRef, type ObjectRef } from '../../../shared/explorer/refs.ts'
import type { LongRunKind } from '../../../shared/long-runs.ts'
import { clipUnits } from '../actions/ObjectActionService'
import type { ExplorerMenuNode } from '../menus/targets'
import { attachBlocked, attachRequest, initialAttachDraft, type AttachDraft } from './attach-database'
import { afterDatabaseFailure, databaseConfirm, databaseRequest, initialDatabaseDraft, type DatabaseDraft, type DatabaseRequest } from './database-properties'
import {
  initialLoginPropertiesDraft, loginPropertiesFocus, loginPropertiesModelOf, loginPropertiesReadAgain, loginPropertiesRequest, withDatabaseRoles, type LoginPropertiesDraft, type LoginPropertiesModel
} from './login-properties'
import { initialNewLoginDraft, newLoginRequest, newLoginTarget, type NewLoginDraft, type SecretState } from './new-login'

/** A request without its ids. */
export type BuiltRequest = Omit<ActionRequest, 'connectionId' | 'requestId'>
/** What a definition builds: the request, nothing to do, or a problem the dialog shows. */
export type DialogRequest = BuiltRequest | undefined | { readonly problem: string }
/** What a dialog's success may do to the rest of the workbench. */
export interface DialogEffects {
  /** Reloads the folder the object is listed in, or the folder the dialog opened on (a Databases folder also refreshes the
   *  toolbar's database list), selecting `select` once it is listed. */
  refreshListing(select?: ExplorerNodeRef): void
  /** Reloads the server's `folder` (where a new object is listed) and selects `object` in it, when that folder is in the tree. */
  reveal(folder: FolderId, object: ObjectRef): void
  /** Reloads `owner`'s `folder` (a database's Users), when that folder is in the tree; one never listed loads fresh when opened. */
  reload(owner: ObjectRef, folder: FolderId): void
  /** The dialog's database went offline or came online: its Database Properties documents follow. */
  databaseState(offline: boolean): void
  /** A toast with the object actions' notice key, which the next one replaces (Unlock Login's success). */
  notify(message: string): void
}
/** The dialog OK succeeded in. */
export interface DialogSubject { readonly target: ObjectRef; readonly label: string }
/** What the service knows besides the model: Varia's other connections that sign in as the login a login dialog is about (critic
 *  D4-3), by their labels. */
export interface DialogContext { readonly loginConnections?: readonly string[] }
/** A question main asks before OK runs: SSMS's Open Connections prompt, or one of the action prompts (prompts.ts) with its facts, which
 *  OK passes unless it is answered with the prompt's cancel answer. */
export type DialogConfirmation = 'openConnections' | ActionPromptRequest
export interface ObjectDialogDefinition<Model, Draft> {
  readonly dialog: DialogId
  /** The object a dialog that makes one names as its target (the server for New Login), or undefined where it does not open;
   *  dialogs on an object take the node's own. */
  readonly targetOf?: (node: ExplorerMenuNode) => ObjectRef | undefined
  /** The dialog's part of the describe's answer; undefined when it is missing. */
  readonly modelOf: (result: ActionDescribeResult) => Model | undefined
  readonly initialDraft: (model: Model, target: ObjectRef) => Draft
  /** `secrets` says what the password fields hold, never their values; the request never carries a secret (Script sends it). */
  readonly request: (target: ObjectRef, model: Model, draft: Draft, secrets?: SecretState) => DialogRequest
  /** Whether OK attaches the secret slot's password to `request`, the request it sends (New Login's SQL Server authentication, Login
   *  Properties' new password). A dialog with it has password fields. */
  readonly secrets?: (draft: Draft, request?: BuiltRequest) => boolean
  /** Whether OK attaches the old password too (Login Properties' Specify old password). */
  readonly oldPassword?: (request: BuiltRequest) => boolean
  /** OK's label when it is not "OK" (Unlock's "Continue in Login Properties…"). */
  readonly okLabel?: (draft: Draft) => string | undefined
  /** OK hands over to another dialog on the same node instead of running anything (Unlock's Set a new password…): this one closes
   *  and that one opens with `patch` over its first draft. */
  readonly handOff?: (model: Model, draft: Draft) => { readonly dialog: ModalDialogId; readonly patch: Readonly<Record<string, unknown>> } | undefined
  /** The login User Mapping's read of a database also reads the user of (Login Properties: its own login). */
  readonly rolesLogin?: (target: ObjectRef) => string | undefined
  /** User Mapping's read of a database arrived: the model and draft with what it found (Login Properties' mapped user and roles). */
  readonly lookedUp?: (model: Model, draft: Draft, database: string, value: LoginDatabaseRoles) => { readonly model: Model; readonly draft: Draft }
  /**
   * Whether the action's reply says the database it ran on is gone (Delete: a success, or a reply whose DROP completed before a
   * later step failed or stopped; Detach: a success, or a reply whose sp_detach_db completed before a Stop answered), so its
   * Properties documents turn orphan and the query windows that used it are counted (D3 §8).
   */
  readonly removesDatabase?: (target: ObjectRef, steps: readonly ActionStep[], succeeded: boolean) => boolean
  /** A run that window close, Disconnect and Restart must not stop part way (src/shared/long-runs.ts). */
  readonly longRun?: LongRunKind
  /** The name Script Action to File suggests, when the target has none. */
  readonly fileName?: (draft: Draft) => string
  /** A question to ask before OK sends `request` (never before Script). */
  readonly confirm?: (model: Model, request: BuiltRequest, context: DialogContext) => DialogConfirmation | undefined
  /** The request once the user answered Yes. */
  readonly withConfirmation?: (request: BuiltRequest, confirmation: DialogConfirmation) => BuiltRequest
  /** The model after OK failed, when the failure shows part of it is stale (the same model otherwise). */
  readonly afterFailure?: (model: Model, failure: ActionError) => Model
  /** Why OK cannot run the draft as it is (OK is disabled and says so), or undefined. */
  readonly blocked?: (model: Model, draft: Draft) => string | undefined
  /** After a success: `request` is what OK sent (never with a secret), `subject` the dialog's target and its label, `model` what the
   *  dialog read. */
  readonly afterSuccess: (effects: DialogEffects, request: BuiltRequest, subject: DialogSubject, model: Model, context: DialogContext) => void
  /**
   * After a failure or Stop whose completed steps used up the secret slot (Login Properties' password changed before a later step
   * failed): the model and draft without it, and a note for the message bar. The service then clears the slot and the password fields,
   * so a retry never sends the change again.
   */
  readonly spentSecrets?: (model: Model, draft: Draft, steps: readonly ActionStep[]) => { readonly model: Model; readonly draft: Draft; readonly note: string } | undefined
  /** The databases a partial run's reload reads again for User Mapping (`lookedUp` takes each answer), from the model before it. */
  readonly readAgain?: (model: Model, draft: Draft) => readonly string[]
  /** The id of the field that takes focus once the dialog has read its object, when it is not the dialog itself. */
  readonly initialFocus?: (model: Model, draft: Draft) => string | undefined
  /** After a failure or Stop that left some steps done; reloading the object's listing when absent. */
  readonly afterPartial?: (effects: DialogEffects, request: BuiltRequest) => void
  /** OK runs as soon as the describe answers, with nothing to choose (SSMS's Bring Online). */
  readonly runOnOpen?: true
  /** A success leaves the dialog open on its steps with Close, as SSMS's progress dialogs do, instead of closing it. */
  readonly keepOpen?: true
  /** Folders other than the object's listing that a reply's done steps changed (the Users folders of the databases a login's Delete
   *  dropped users in), which the dialog reconciles where they are loaded, after a success or a partial failure. */
  readonly changedFolders?: (model: Model, steps: readonly ActionStep[]) => ChangedFolders | undefined
  /** Whether the dialog reads its model again after steps completed before a failure or Stop (ObjectDialogService.reload). */
  readonly reloadsAfterPartial?: (target: ObjectRef) => boolean
}
/** A folder kind and the databases whose folder of that kind changed. */
export interface ChangedFolders { readonly folder: FolderId; readonly databases: readonly string[] }

/** Delete Object's checkboxes: the first two apply to databases only, the last to logins only. */
export interface DeleteDraft { readonly deleteHistory: boolean; readonly closeConnections: boolean; readonly dropMappedUsers: boolean }
/** The mapped users a login's Delete may drop: those it lists that are not kept (they own a schema or role, or their database is read-only). */
export const droppableUsers = (model: DeleteTarget) => (model.mappings?.users ?? []).filter(user => !mappedUserKept(user))
/**
 * Why Delete Object greys the option to drop the mapped users, or undefined when it offers it: no user is mapped, more are mapped
 * than it lists (the backend refuses those), every one listed is kept, or the login's sessions cannot be counted (the backend
 * refuses that too: a session would fail the login's DROP after its users were gone).
 */
export const dropMappedUsersNote = (model: DeleteTarget): string | undefined => {
  const mapped = model.mappings?.mapped ?? 0, listed = model.mappings?.users.length ?? 0
  if (mapped === 0) return loginDeleteText.noneToDrop
  if (mapped > listed) return loginDeleteText.tooMany
  if (droppableUsers(model).length === 0) return loginDeleteText.allKept
  if (model.login?.sessions === undefined) return loginDeleteText.sessionsUncounted
  return undefined
}
/** Whether Delete Object offers to drop the mapped users: nothing greys it (dropMappedUsersNote). */
export const canDropMappedUsers = (model: DeleteTarget): boolean => !!model.mappings && dropMappedUsersNote(model) === undefined
/** Why Delete Object greys OK for a login: the protected-principal rules (logins.ts) over the facts it read (own, sa, system, permissions). */
export const loginDeleteRefusal = (model: DeleteTarget): string | undefined => {
  const refused = model.login && loginRefusal(model.login, 'delete')
  return refused ? loginMessages[refused] : undefined
}
/** Whether Delete Object can close the database's connections: not for a snapshot, nor where the describe says why not (Managed Instance cannot set SINGLE_USER; an offline database has none). */
export const canCloseConnections = (model: DeleteTarget): boolean => !model.isSnapshot && !model.closeConnectionsNote
const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
/** Varia's query tabs whose session holds an open transaction in the database, as `promptTabFacts` bounds them. */
export interface TabTransactions { readonly tabsWithTransactions?: readonly string[]; readonly moreTabsWithTransactions?: number }
/**
 * What Close existing connections rolls back (A7): how many sessions hold an open transaction, and which of Varia's query
 * windows. Where the option is greyed (Managed Instance, an offline database, a snapshot) it names no option the user cannot
 * choose and only counts them.
 */
export function rollbackNote(model: DeleteTarget, tabs: TabTransactions): string {
  const named = tabs.tabsWithTransactions ?? [], more = tabs.moreTabsWithTransactions ?? 0
  return [
    model.withTransaction ? `${count(model.withTransaction, 'session has an open transaction', 'sessions have open transactions')}${canCloseConnections(model) ? ', which Close existing connections rolls back' : ''}.` : '',
    named.length ? `Varia's query windows with an open transaction: ${named.map(name => displayText(name)).join(', ')}${more > 0 ? ` and ${more.toLocaleString('en-US')} more` : ''}.` : ''
  ].filter(Boolean).join(' ')
}
/** The ids of the notes that describe Close existing connections: why it is greyed, and what it rolls back. */
export const closeDescription = (model: DeleteTarget, rollback: string): string | undefined =>
  [model.closeConnectionsNote ? 'delete-object-close-note' : '', rollback ? 'delete-object-rollback-note' : ''].filter(Boolean).join(' ') || undefined
export const deleteObjectDefinition: ObjectDialogDefinition<DeleteTarget, DeleteDraft> = {
  dialog: 'deleteObject',
  modelOf: result => result.deleteTarget,
  // SSMS: Delete backup and restore history is checked (greyed for a snapshot); Close existing connections is not.
  // SSMS deletes a login and leaves its users orphaned; Varia offers to delete them too, unchecked (D4 owner question 3).
  initialDraft: (model, target) => ({ deleteHistory: target.kind === 'database' && !model.isSnapshot, closeConnections: false, dropMappedUsers: false }),
  request: (target, model, draft) => {
    const database = target.kind === 'database'
    const request = { action: 'delete', target, closeConnections: database && canCloseConnections(model) && draft.closeConnections, deleteHistory: database && !model.isSnapshot && draft.deleteHistory } as const
    // The login the dialog read: the backend refuses one that has taken the name since, whose facts the dialog never showed.
    return target.kind === 'login' && model.login
      ? { ...request, dropMappedUsers: canDropMappedUsers(model) && draft.dropMappedUsers, loginIdentity: { sid: model.login.sid, created: model.login.created } }
      : request
  },
  removesDatabase: (target, steps, succeeded) => target.kind === 'database' && (succeeded || steps.some(step => step.status === 'done' && !step.compensates && step.title === dropDatabaseStepTitle)),
  afterSuccess: effects => effects.refreshListing(),
  blocked: model => loginDeleteRefusal(model),
  // A login's Delete that dropped users and then failed or stopped: the list shows who is still mapped.
  reloadsAfterPartial: target => target.kind === 'login',
  // Once a user was dropped, the Users folders of every database the dialog listed a droppable user in: a step's detail is clipped
  // display text, so it is not matched back to its database, and reconciling an unchanged folder changes nothing.
  changedFolders: (model, steps) => {
    if (!steps.some(step => step.status === 'done' && step.title === dropUserStepTitle)) return undefined
    const databases = [...new Set(droppableUsers(model).map(user => user.database))]
    return databases.length ? { folder: 'users', databases } : undefined
  }
}

const isProperties = (request: BuiltRequest): request is DatabaseRequest => request.action === 'properties'
/** Database Properties: only changed values; Yes to Open Connections writes WITH ROLLBACK IMMEDIATE. */
export const databasePropertiesDefinition: ObjectDialogDefinition<DatabasePropertiesModel, DatabaseDraft> = {
  dialog: 'databaseProperties',
  modelOf: result => result.databaseProperties,
  initialDraft: model => initialDatabaseDraft(model),
  request: databaseRequest,
  confirm: (model, request) => isProperties(request) ? databaseConfirm(model, request) : undefined,
  withConfirmation: request => isProperties(request) ? { ...request, closeConnections: true } : request,
  afterFailure: afterDatabaseFailure,
  // The Databases listing shows Read-Only and Single User in its sublabels.
  afterSuccess: effects => effects.refreshListing()
}

/** New Login (D2a, D2b): opens on a SQL Server's Security or Logins folder or a login, and on success reloads Logins and selects the
 *  new login there, and reloads each mapped database's Users folder that the tree has listed, as after a failure or Stop that
 *  left the login created (a mapping that did not complete shows no user, which the reload shows). A SQL Server login's password
 *  goes only with OK. */
const revealLogin = (effects: DialogEffects, request: BuiltRequest) => {
  const { login, mappings } = request as Partial<Pick<CreateLoginRequest, 'login' | 'mappings'>>
  if (login) effects.reveal('logins', { kind: 'login', name: login.name })
  for (const mapping of mappings ?? []) effects.reload({ kind: 'database', name: mapping.database }, 'users')
}
export const newLoginDefinition: ObjectDialogDefinition<NewLoginModel, NewLoginDraft> = {
  dialog: 'newLogin',
  targetOf: newLoginTarget,
  modelOf: result => result.newLogin,
  initialDraft: model => initialNewLoginDraft(model),
  request: newLoginRequest,
  secrets: draft => draft.auth === 'sql',
  longRun: 'newLogin',
  fileName: draft => (draft.name || 'Login') + '.sql',
  afterSuccess: revealLogin,
  afterPartial: revealLogin
}

const isAttach = (request: BuiltRequest): request is Omit<AttachRequest, 'connectionId' | 'requestId'> => request.action === 'attach'
/** Attach Databases (Databases › Attach…): the describe answers the server's facts (logins for Owner, the default data
 *  folder Add… opens in); the rows are the page's, and each Add… describes one .mdf (attach-database.ts). */
export const attachDatabaseDefinition: ObjectDialogDefinition<AttachServerFacts, AttachDraft> = {
  dialog: 'attachDatabase',
  modelOf: result => result.attachDatabase?.server,
  initialDraft: () => initialAttachDraft(),
  request: (_target, _model, draft) => attachRequest(draft),
  blocked: (_model, draft) => attachBlocked(draft),
  longRun: 'attach',
  // The Databases folder lists the attached databases; the first is selected, as a new database is.
  afterSuccess: (effects, request) => {
    const first = isAttach(request) ? request.databases[0]?.name : undefined
    effects.refreshListing(first === undefined ? undefined : { type: 'object', object: { kind: 'database', name: first } })
  }
}

/** Take Database Offline's one choice: SSMS's Drop All Active Connections, cleared. */
export interface TakeOfflineDraft { readonly dropConnections: boolean }
/** SET OFFLINE without a termination clause waits for every other session to leave, so OK waits for nothing: with sessions
 *  in the database and Drop All Active Connections cleared, it is disabled (unknown sessions do not disable it). */
export function takeOfflineBlocked(model: DatabaseStateModel, draft: TakeOfflineDraft): string | undefined {
  if (draft.dropConnections || !model.sessions) return undefined
  return `${count(model.sessions, 'session is', 'sessions are')} connected: check Drop All Active Connections, or Check Again once ${model.sessions === 1 ? 'it leaves' : 'they leave'}.`
}
export const takeOfflineDefinition: ObjectDialogDefinition<DatabaseStateModel, TakeOfflineDraft> = {
  dialog: 'takeOffline',
  modelOf: result => result.databaseState,
  initialDraft: () => ({ dropConnections: false }),
  request: (target, model, draft) => ({ action: 'takeOffline', target, dropConnections: draft.dropConnections, identity: model.identity }),
  blocked: takeOfflineBlocked,
  keepOpen: true,
  // The Databases listing shows "(Offline)" in the sublabel; Database Properties of the database turns read-only.
  afterSuccess: effects => { effects.refreshListing(); effects.databaseState(true) }
}
/** Bring Database Online has nothing to choose. */
export type BringOnlineDraft = Readonly<Record<never, never>>
export const bringOnlineDefinition: ObjectDialogDefinition<DatabaseStateModel, BringOnlineDraft> = {
  dialog: 'bringOnline',
  modelOf: result => result.databaseState,
  initialDraft: () => ({}),
  request: (target, model) => ({ action: 'bringOnline', target, identity: model.identity }),
  runOnOpen: true,
  keepOpen: true,
  afterSuccess: effects => { effects.refreshListing(); effects.databaseState(false) }
}

/** Detach Database's choices: the grid's Drop Connections and Update Statistics (cleared, as in SSMS), and the box a database that
 *  is not online asks for on a Windows server (critic A27: Detach while offline, or Detach anyway in EMERGENCY). */
export interface DetachDraft { readonly dropConnections: boolean; readonly updateStatistics: boolean; readonly detachOffline: boolean }
/** Detach's words for a database state, as the backend's DetachStateWords writes them in its notes and refusals. */
export function detachStateWords(state: number): string {
  switch (databaseStateOf(state)) {
    case 'offline': return 'offline'
    case 'emergency': return 'in EMERGENCY mode'
    case 'offlineSecondary': return 'an offline secondary'
    default: return 'not online'
  }
}
/** The box a database that is not online asks for on Windows (the backend's DetachConfirmLabel). */
export const detachConfirmLabel = (state: number): string => databaseStateOf(state) === 'offline' ? 'Detach while offline' : 'Detach anyway'
/**
 * Why Update Statistics cannot run (the backend's DetachStatisticsRefusal): sp_detach_db's sp_updatestats raises 15635 on a
 * read-only, standby or EMERGENCY database, and SQL Server detaches it all the same, and 942 on an offline one, which aborts it.
 */
export function detachStatisticsBlocked(model: Pick<DatabaseStateModel, 'state' | 'readOnly' | 'standby'>): string | undefined {
  if (databaseStateOf(model.state) !== 'online') return `Update Statistics cannot run while the database is ${detachStateWords(model.state)}.`
  if (model.readOnly || model.standby) return 'Update Statistics cannot run on a read-only or standby database.'
  return undefined
}
/**
 * Why OK waits (SSMS's Not ready): sp_detach_db refuses a database other sessions use (3703), so sessions with Drop Connections
 * cleared block it, as SSMS's Message counts them; so do what SQL Server refuses anyway (replication, a snapshot, an availability
 * group, mirroring), and a database that is not online on Windows until its box is checked. Unknown sessions do not block.
 */
export function detachBlocked(model: DatabaseStateModel, draft: DetachDraft): string | undefined {
  const blocking = model.warnings.find(warning => warning.blocking)
  if (blocking) return blocking.text
  if (model.confirmOffline && !draft.detachOffline) return `The database is ${detachStateWords(model.state)}: check ${detachConfirmLabel(model.state)}, or bring it online first.`
  if (draft.dropConnections || !model.sessions) return undefined
  return `${count(model.sessions, 'session is', 'sessions are')} connected: check Drop Connections, or Check Again once ${model.sessions === 1 ? 'it leaves' : 'they leave'}.`
}
export const detachDatabaseDefinition: ObjectDialogDefinition<DatabaseStateModel, DetachDraft> = {
  dialog: 'detachDatabase',
  modelOf: result => result.databaseState,
  initialDraft: () => ({ dropConnections: false, updateStatistics: false, detachOffline: false }),
  // Update Statistics goes cleared where it cannot run, whatever the draft holds (the page disables it there).
  request: (target, model, draft) => ({
    action: 'detach', target, dropConnections: draft.dropConnections, updateStatistics: draft.updateStatistics && !detachStatisticsBlocked(model), identity: model.identity,
    ...model.confirmOffline ? { detachOffline: draft.detachOffline } : {}
  }),
  blocked: detachBlocked,
  keepOpen: true,
  removesDatabase: (target, steps, succeeded) => target.kind === 'database' && (succeeded || steps.some(step => step.status === 'done' && !step.compensates && step.title === detachDatabaseStepTitle)),
  // The Databases listing loses the database; its Properties documents are orphaned (removesDatabase).
  afterSuccess: effects => effects.refreshListing()
}

/** Unlock Login (D4d): the login preflight's facts and its lock-out state, as the unlockLogin describe read them. */
export interface UnlockModel { readonly login: LoginFacts; readonly lock: LoginLockFacts }
/** How to unlock (owner decision 9): Set a new password… (SSMS's way, handed over to Login Properties, D2c) is the default; keeping
 *  the password, which clears its history, is chosen only by the user. */
export interface UnlockDraft { readonly mode?: UnlockChoice }
export const unlockChooseMode = 'Choose how to unlock the login.'
export const unlockSuccessNotice = (label: string) => `Unlocked the login ${label}. Its password history was cleared.`
/** Why a choice cannot unlock this login, or undefined: the login's rules for Unlock, then for a new password a login that is never
 *  locked out or is not now (it unlocks a login that must change its password too), and for keeping it unlockRefusal's rules. */
export function unlockChoiceRefusal(model: UnlockModel, choice: UnlockChoice): LoginMessageId | undefined {
  if (choice === 'keepPassword') return unlockRefusal(model.login, model.lock)
  return loginRefusal(model.login, 'unlock') ?? (model.login.type !== 'S' || model.login.policyChecked !== true ? 'unlockNoPolicy' : !model.lock.locked ? 'notLocked' : undefined)
}
/** Why Unlock's OK cannot run: the chosen way's refusal (the page shows the login's own as a warning), else no choice made yet. */
export const unlockBlocked = (model: UnlockModel, draft: UnlockDraft): string | undefined => {
  const id = unlockChoiceRefusal(model, draft.mode ?? 'keepPassword')
  return id ? loginMessages[id] : draft.mode ? undefined : unlockChooseMode
}
export const unlockLoginDefinition: ObjectDialogDefinition<UnlockModel, UnlockDraft> = {
  dialog: 'unlockLogin',
  modelOf: result => result.login && result.lock ? { login: result.login, lock: result.lock } : undefined,
  // A new password unlocks every login keeping the password can, and more (one that must change it), so it is always the default.
  initialDraft: () => ({ mode: 'setPassword' }),
  // The identity binds OK to the login this dialog read: one renamed, dropped or replaced since is refused, not unlocked.
  // Set a new password… sends nothing here (Login Properties does), so Script has nothing to script for it.
  request: (target, model, draft) => draft.mode === 'setPassword' ? undefined
    : { action: 'unlock', target, mode: 'keepPassword', ...(model.login.sid && model.login.created ? { loginIdentity: { sid: model.login.sid, created: model.login.created } } : {}) },
  blocked: unlockBlocked,
  okLabel: draft => draft.mode === 'setPassword' ? unlockHandOffLabel : undefined,
  // Login Properties opens on General with Login is locked out cleared, so a new password is all it asks for.
  handOff: (_model, draft) => draft.mode === 'setPassword' ? { dialog: 'loginProperties', patch: { locked: false } } : undefined,
  // Unlocked meanwhile (by its owner's new password, or another admin): the page says so and OK greys, as on a fresh open.
  afterFailure: (model, failure) => failure.code === 'NOT_SUPPORTED' && failure.message === loginMessages.notLocked ? { ...model, lock: { ...model.lock, locked: false } } : model,
  // The Logins folder's row and its status come from the reconciled listing.
  afterSuccess: (effects, request) => { effects.refreshListing(); effects.notify(unlockSuccessNotice(request.target.name ?? '')) }
}
/** Login Properties (D2c): what differs from its describe; a new password goes only with OK, the old one with it when Specify old
 *  password is checked. Success and a partial failure reload Logins (the row's status and detail) and each changed database's Users. */
const loginChangesOf = (request: BuiltRequest) => request.action === 'loginProperties' ? (request as Partial<Pick<LoginPropertiesRequest, 'loginChanges'>>).loginChanges : undefined
const refreshLogin = (effects: DialogEffects, request: BuiltRequest) => {
  effects.refreshListing()
  for (const mapping of loginChangesOf(request)?.mappings ?? []) effects.reload({ kind: 'database', name: mapping.database }, 'users')
}
/**
 * Status' Disabled or Deny (D2c) asks as the Disable verb does (owner decisions 4 and 7) when someone would be locked out: sessions
 * connected as the login, a service that runs as it, or Varia's other connections that sign in as it. SSMS asks nothing; with none of
 * those, neither does Varia.
 */
export function loginStatusConfirm(model: LoginPropertiesModel, request: BuiltRequest, context: DialogContext): DialogConfirmation | undefined {
  const changes = loginChangesOf(request), name = (request as { readonly target?: ObjectRef }).target?.name
  if (!changes || name === undefined || (changes.enabled !== false && changes.connect !== 'deny')) return undefined
  const { login } = model, connections = context.loginConnections ?? [], sessions = login.sessions ?? 0
  if (!login.service && !connections.length && sessions <= 0) return undefined
  return { prompt: 'disableLogin', facts: {
    login: name, sysadmin: login.sysadmin, ...sessions > 0 ? { sessions: Math.min(sessions, promptLimits.count) } : {}, ...login.service ? { service: clipUnits(login.service, promptLimits.service) } : {},
    ...connections.length ? { connections: [...connections] } : {}, ...changes.enabled === false ? {} : { deny: true as const }
  } }
}
/** After OK changed the password of a login Varia's connections sign in as (this one, or others): they keep working with the new one
 *  (the backend gave it to them), and a password Varia remembers for them is out of date. */
const passwordNotice = (effects: DialogEffects, request: BuiltRequest, subject: DialogSubject, model: LoginPropertiesModel, context: DialogContext) => {
  refreshLogin(effects, request)
  if (loginChangesOf(request)?.password && (model.login.own || (context.loginConnections?.length ?? 0) > 0)) effects.notify(loginPropertiesMessages.connectionsPassword(subject.label))
}
export const loginPropertiesDefinition: ObjectDialogDefinition<LoginPropertiesModel, LoginPropertiesDraft> = {
  dialog: 'loginProperties',
  modelOf: loginPropertiesModelOf,
  initialDraft: initialLoginPropertiesDraft,
  request: loginPropertiesRequest,
  secrets: (_draft, request) => !!(request && loginChangesOf(request)?.password),
  oldPassword: request => !!loginChangesOf(request)?.password?.oldPassword,
  longRun: 'loginProperties',
  fileName: draft => (draft.name || 'Login') + '.sql',
  // SQL Server's own logins open, as in SSMS, but never change; every page says why.
  blocked: model => model.login.subtype === 'system' ? loginMessages.system : undefined,
  confirm: loginStatusConfirm,
  rolesLogin: target => target.name,
  lookedUp: withDatabaseRoles,
  afterSuccess: passwordNotice,
  afterPartial: refreshLogin,
  // Steps that completed before a failure changed the login: the pages show it as it is now, and User Mapping reads its databases again.
  reloadsAfterPartial: () => true,
  readAgain: loginPropertiesReadAgain,
  // The password changed before a later step failed: a retry must not send it again (with the old password, now wrong, it fails 15151).
  spentSecrets: (model, draft, steps) => steps.some(step => step.title === loginPasswordStepTitle && step.status === 'done')
    ? {
      model: model.lock?.locked ? { ...model, lock: { ...model.lock, locked: false } } : model,
      draft: { ...draft, specifyOld: model.login.own && !model.login.canAlter, locked: false },
      note: loginPropertiesMessages.passwordApplied
    }
    : undefined,
  initialFocus: loginPropertiesFocus
}

/** The dialogs this module defines: New Database is a document with a service of its own (src/renderer/src/new-database). */
export type DefinedDialogId = Exclude<DialogId, 'newDatabase'>
export interface DialogModels {
  readonly deleteObject: DeleteTarget; readonly databaseProperties: DatabasePropertiesModel; readonly attachDatabase: AttachServerFacts; readonly newLogin: NewLoginModel
  readonly takeOffline: DatabaseStateModel; readonly bringOnline: DatabaseStateModel; readonly detachDatabase: DatabaseStateModel; readonly unlockLogin: UnlockModel
  readonly loginProperties: LoginPropertiesModel
}
export interface DialogDrafts {
  readonly deleteObject: DeleteDraft; readonly databaseProperties: DatabaseDraft; readonly attachDatabase: AttachDraft; readonly newLogin: NewLoginDraft
  readonly takeOffline: TakeOfflineDraft; readonly bringOnline: BringOnlineDraft; readonly detachDatabase: DetachDraft; readonly unlockLogin: UnlockDraft
  readonly loginProperties: LoginPropertiesDraft
}
export type DialogModel = DialogModels[DefinedDialogId]
export type DialogDraft = DialogDrafts[DefinedDialogId]
export const dialogDefinitions: { readonly [D in DefinedDialogId]: ObjectDialogDefinition<DialogModels[D], DialogDrafts[D]> } = {
  deleteObject: deleteObjectDefinition,
  databaseProperties: databasePropertiesDefinition,
  attachDatabase: attachDatabaseDefinition,
  newLogin: newLoginDefinition,
  takeOffline: takeOfflineDefinition,
  bringOnline: bringOnlineDefinition,
  detachDatabase: detachDatabaseDefinition,
  unlockLogin: unlockLoginDefinition,
  loginProperties: loginPropertiesDefinition
}
/** A dialog's definition over the open dialog's model and draft, which the service keeps paired with its dialog. */
export const definitionOf = (dialog: DefinedDialogId) => dialogDefinitions[dialog] as unknown as ObjectDialogDefinition<DialogModel, DialogDraft>
