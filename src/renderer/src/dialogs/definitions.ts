// The object dialogs' behaviour, one definition per dialog: the model its describe answers, the draft a dialog starts
// from, the action OK sends (and the Script button scripts), SSMS's confirmations before it, and what happens after OK
// succeeds. ObjectDialogService runs the modal ones and ObjectDialog.tsx renders their pages (`dialogPages`);
// DatabasePropertiesService runs Database Properties, a document (src/renderer/src/properties). It is the plug-in point
// for later dialogs (Login Properties, Backup and Restore): a dialog id, its surface and pages in
// src/shared/actions/catalog.ts, a describe in the backend, a definition here, and its pages or sections. No React here,
// so the services and their tests stay in Node.
import type { DialogId } from '../../../shared/actions/catalog.ts'
import { loginDeleteText, loginMessages, loginRefusal, mappedUserKept, unlockRefusal, type LoginFacts, type LoginLockFacts, type NewLoginModel, type UnlockMode } from '../../../shared/actions/logins.ts'
import {
  dropDatabaseStepTitle, dropUserStepTitle, type ActionDescribeResult, type ActionError, type ActionRequest, type ActionStep, type CreateLoginRequest, type DatabasePropertiesModel, type DeleteTarget
} from '../../../shared/actions/schema.ts'
import type { FolderId } from '../../../shared/explorer/catalog.ts'
import { displayText, type ObjectRef } from '../../../shared/explorer/refs.ts'
import type { LongRunKind } from '../../../shared/long-runs.ts'
import type { ExplorerMenuNode } from '../menus/targets'
import { afterDatabaseFailure, databaseConfirm, databaseRequest, initialDatabaseDraft, type DatabaseDraft, type DatabaseRequest } from './database-properties'
import { initialNewLoginDraft, newLoginRequest, newLoginTarget, type NewLoginDraft, type SecretState } from './new-login'

/** A request without its ids. */
export type BuiltRequest = Omit<ActionRequest, 'connectionId' | 'requestId'>
/** What a definition builds: the request, nothing to do, or a problem the dialog shows. */
export type DialogRequest = BuiltRequest | undefined | { readonly problem: string }
/** What a dialog's success may do to the rest of the workbench. */
export interface DialogEffects {
  /** Reloads the folder the object is listed in (a Databases folder also refreshes the toolbar's database list). */
  refreshListing(): void
  /** Reloads the server's `folder` (where a new object is listed) and selects `object` in it, when that folder is in the tree. */
  reveal(folder: FolderId, object: ObjectRef): void
  /** Reloads `owner`'s `folder` (a database's Users), when that folder is in the tree; one never listed loads fresh when opened. */
  reload(owner: ObjectRef, folder: FolderId): void
  /** A toast with the object actions' notice key, which the next one replaces. */
  notify(message: string): void
}
/** The dialog OK succeeded in. */
export interface DialogSubject { readonly target: ObjectRef; readonly label: string }
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
  /** A run that window close, Disconnect and Restart must not stop part way (src/shared/long-runs.ts). */
  readonly longRun?: LongRunKind
  /**
   * Whether the action's reply says the database it ran on is gone (Delete: a success, or a reply whose DROP completed before a
   * later step failed or stopped), so its Properties documents turn orphan and the query windows that used it are counted (D3 §8).
   */
  readonly removesDatabase?: (target: ObjectRef, steps: readonly ActionStep[], succeeded: boolean) => boolean
  /** The name Script Action to File suggests, when the target has none. */
  readonly fileName?: (draft: Draft) => string
  /** A question to ask before OK sends `request` (never before Script). */
  readonly confirm?: (model: Model, request: BuiltRequest) => DialogConfirmation | undefined
  /** The request once the user answered Yes. */
  readonly withConfirmation?: (request: BuiltRequest, confirmation: DialogConfirmation) => BuiltRequest
  /** The model after OK failed, when the failure shows part of it is stale (the same model otherwise). */
  readonly afterFailure?: (model: Model, failure: ActionError) => Model
  /** Why OK cannot run for this model and draft, shown on the page; OK is greyed while it is set, and Script stays available. */
  readonly unavailable?: (model: Model, draft?: Draft) => string | undefined
  /** After a success: `request` is what OK sent (never with a secret), `subject` the dialog's target and its label. */
  readonly afterSuccess: (effects: DialogEffects, request: BuiltRequest, subject: DialogSubject) => void
  /** After a failure or Stop that left some steps done; reloading the object's listing when absent. */
  readonly afterPartial?: (effects: DialogEffects, request: BuiltRequest) => void
  /** Why OK is greyed (the protected-principal rules' refusal of a login), shown on the page; Script still works. */
  readonly blocked?: (model: Model) => string | undefined
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
/** Unlock Login (D4d): the login preflight's facts and its lock-out state, as the unlockLogin describe read them. */
export interface UnlockModel { readonly login: LoginFacts; readonly lock: LoginLockFacts }
/** How to unlock: none until the user chooses (owner decision 9: keeping the password, which clears its history, is never the
 *  default). Keeping it is the only way until Login Properties (D2c) adds Set a new password, which is then the default. */
export interface UnlockDraft { readonly mode?: UnlockMode }
export const unlockChooseMode = 'Choose how to unlock the login.'
export const unlockSuccessNotice = (label: string) => `Unlocked the login ${label}. Its password history was cleared.`
export const unlockLoginDefinition: ObjectDialogDefinition<UnlockModel, UnlockDraft> = {
  dialog: 'unlockLogin',
  modelOf: result => result.login && result.lock ? { login: result.login, lock: result.lock } : undefined,
  initialDraft: () => ({}),
  // The identity binds OK to the login this dialog read: one renamed, dropped or replaced since is refused, not unlocked.
  // OK waits for a choice (unavailable); Script, which runs nothing, shows the only way there is before one.
  request: (target, model, draft) => ({ action: 'unlock', target, mode: draft.mode ?? 'keepPassword', ...(model.login.sid && model.login.created ? { loginIdentity: { sid: model.login.sid, created: model.login.created } } : {}) }),
  unavailable: (model, draft) => { const id = unlockRefusal(model.login, model.lock); return id ? loginMessages[id] : draft?.mode ? undefined : unlockChooseMode },
  // Unlocked meanwhile (by its owner's new password, or another admin): the page says so and OK greys, as on a fresh open.
  afterFailure: (model, failure) => failure.code === 'NOT_SUPPORTED' && failure.message === loginMessages.notLocked ? { ...model, lock: { ...model.lock, locked: false } } : model,
  // The Logins folder's row and its status come from the reconciled listing.
  afterSuccess: (effects, _request, subject) => { effects.refreshListing(); effects.notify(unlockSuccessNotice(subject.label)) }
}
export interface DialogModels { readonly deleteObject: DeleteTarget; readonly databaseProperties: DatabasePropertiesModel; readonly newLogin: NewLoginModel; readonly unlockLogin: UnlockModel }
export interface DialogDrafts { readonly deleteObject: DeleteDraft; readonly databaseProperties: DatabaseDraft; readonly newLogin: NewLoginDraft; readonly unlockLogin: UnlockDraft }
export type DialogModel = DialogModels[DialogId]
export type DialogDraft = DialogDrafts[DialogId]
export const dialogDefinitions: { readonly [D in DialogId]: ObjectDialogDefinition<DialogModels[D], DialogDrafts[D]> } = {
  deleteObject: deleteObjectDefinition,
  databaseProperties: databasePropertiesDefinition,
  newLogin: newLoginDefinition,
  unlockLogin: unlockLoginDefinition
}
/** A dialog's definition over the open dialog's model and draft, which the service keeps paired with its dialog. */
export const definitionOf = (dialog: DialogId) => dialogDefinitions[dialog] as unknown as ObjectDialogDefinition<DialogModel, DialogDraft>
