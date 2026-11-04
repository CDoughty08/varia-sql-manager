// The object dialogs' behaviour, one definition per dialog: the model its describe answers, the draft a dialog starts
// from, the action OK sends (and the Script button scripts), SSMS's confirmations before it, and what happens after OK
// succeeds. ObjectDialogService runs the modal ones and ObjectDialog.tsx renders their pages (`dialogPages`);
// DatabasePropertiesService runs Database Properties, a document (src/renderer/src/properties). It is the plug-in point
// for later dialogs (Login Properties, Backup and Restore): a dialog id, its surface and pages in
// src/shared/actions/catalog.ts, a describe in the backend, a definition here, and its pages or sections. No React here,
// so the services and their tests stay in Node.
import { databaseStateOf, type DialogId } from '../../../shared/actions/catalog.ts'
import { loginDeleteText, loginMessages, loginRefusal, mappedUserKept, type NewLoginModel } from '../../../shared/actions/logins.ts'
import { detachDatabaseStepTitle, dropDatabaseStepTitle, dropUserStepTitle, type ActionDescribeResult, type ActionError, type ActionRequest, type ActionStep, type AttachRequest, type AttachServerFacts, type CreateLoginRequest, type DatabasePropertiesModel, type DatabaseStateModel, type DeleteTarget } from '../../../shared/actions/schema.ts'
import type { FolderId } from '../../../shared/explorer/catalog.ts'
import { displayText, type ExplorerNodeRef, type ObjectRef } from '../../../shared/explorer/refs.ts'
import type { LongRunKind } from '../../../shared/long-runs.ts'
import type { ExplorerMenuNode } from '../menus/targets'
import { attachBlocked, attachRequest, initialAttachDraft, type AttachDraft } from './attach-database'
import { afterDatabaseFailure, databaseConfirm, databaseRequest, initialDatabaseDraft, type DatabaseDraft, type DatabaseRequest } from './database-properties'
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
}
/** A question main asks before OK runs: SSMS's Open Connections prompt. */
export type DialogConfirmation = 'openConnections'
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
  /** Whether OK attaches the secret slot's password to the request (New Login's SQL Server authentication). */
  readonly secrets?: (draft: Draft) => boolean
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
  readonly confirm?: (model: Model, request: BuiltRequest) => DialogConfirmation | undefined
  /** The request once the user answered Yes. */
  readonly withConfirmation?: (request: BuiltRequest, confirmation: DialogConfirmation) => BuiltRequest
  /** The model after OK failed, when the failure shows part of it is stale (the same model otherwise). */
  readonly afterFailure?: (model: Model, failure: ActionError) => Model
  /** Why OK cannot run the draft as it is (OK is disabled and says so), or undefined. */
  readonly blocked?: (model: Model, draft: Draft) => string | undefined
  readonly afterSuccess: (effects: DialogEffects, request: BuiltRequest) => void
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

/** The dialogs this module defines: New Database is a document with a service of its own (src/renderer/src/new-database). */
export type DefinedDialogId = Exclude<DialogId, 'newDatabase'>
export interface DialogModels {
  readonly deleteObject: DeleteTarget; readonly databaseProperties: DatabasePropertiesModel; readonly attachDatabase: AttachServerFacts; readonly newLogin: NewLoginModel
  readonly takeOffline: DatabaseStateModel; readonly bringOnline: DatabaseStateModel; readonly detachDatabase: DatabaseStateModel
}
export interface DialogDrafts {
  readonly deleteObject: DeleteDraft; readonly databaseProperties: DatabaseDraft; readonly attachDatabase: AttachDraft; readonly newLogin: NewLoginDraft
  readonly takeOffline: TakeOfflineDraft; readonly bringOnline: BringOnlineDraft; readonly detachDatabase: DetachDraft
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
  detachDatabase: detachDatabaseDefinition
}
/** A dialog's definition over the open dialog's model and draft, which the service keeps paired with its dialog. */
export const definitionOf = (dialog: DefinedDialogId) => dialogDefinitions[dialog] as unknown as ObjectDialogDefinition<DialogModel, DialogDraft>
