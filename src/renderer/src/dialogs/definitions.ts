// The object dialogs' behaviour, one definition per dialog: the model its describe answers, the draft a dialog starts
// from, the action OK sends (and the Script button scripts), SSMS's confirmations before it, and what happens after OK
// succeeds. ObjectDialogService runs the modal ones and ObjectDialog.tsx renders their pages (`dialogPages`);
// DatabasePropertiesService runs Database Properties, a document (src/renderer/src/properties). It is the plug-in point
// for later dialogs (Login Properties, Backup and Restore): a dialog id, its surface and pages in
// src/shared/actions/catalog.ts, a describe in the backend, a definition here, and its pages or sections. No React here,
// so the services and their tests stay in Node.
import type { DialogId } from '../../../shared/actions/catalog.ts'
import { loginDeleteText, loginMessages, loginRefusal, mappedUserKept } from '../../../shared/actions/logins.ts'
import { dropDatabaseStepTitle, dropUserStepTitle, type ActionDescribeResult, type ActionError, type ActionRequest, type ActionStep, type DatabasePropertiesModel, type DeleteTarget } from '../../../shared/actions/schema.ts'
import type { FolderId } from '../../../shared/explorer/catalog.ts'
import { displayText, type ObjectRef } from '../../../shared/explorer/refs.ts'
import { afterDatabaseFailure, databaseConfirm, databaseRequest, initialDatabaseDraft, type DatabaseDraft, type DatabaseRequest } from './database-properties'

/** A request without its ids. */
export type BuiltRequest = Omit<ActionRequest, 'connectionId' | 'requestId'>
/** What a definition builds: the request, nothing to do, or a problem the dialog shows. */
export type DialogRequest = BuiltRequest | undefined | { readonly problem: string }
/** What a dialog's success may do to the rest of the workbench. */
export interface DialogEffects {
  /** Reloads the folder the object is listed in (a Databases folder also refreshes the toolbar's database list). */
  refreshListing(): void
}
/** A question main asks before OK runs: SSMS's Open Connections prompt. */
export type DialogConfirmation = 'openConnections'
export interface ObjectDialogDefinition<Model, Draft> {
  readonly dialog: DialogId
  /** The dialog's part of the describe's answer; undefined when it is missing. */
  readonly modelOf: (result: ActionDescribeResult) => Model | undefined
  readonly initialDraft: (model: Model, target: ObjectRef) => Draft
  readonly request: (target: ObjectRef, model: Model, draft: Draft) => DialogRequest
  /**
   * Whether the action's reply says the database it ran on is gone (Delete: a success, or a reply whose DROP completed before a
   * later step failed or stopped), so its Properties documents turn orphan and the query windows that used it are counted (D3 §8).
   */
  readonly removesDatabase?: (target: ObjectRef, steps: readonly ActionStep[], succeeded: boolean) => boolean
  /** A question to ask before OK sends `request` (never before Script). */
  readonly confirm?: (model: Model, request: BuiltRequest) => DialogConfirmation | undefined
  /** The request once the user answered Yes. */
  readonly withConfirmation?: (request: BuiltRequest, confirmation: DialogConfirmation) => BuiltRequest
  /** The model after OK failed, when the failure shows part of it is stale (the same model otherwise). */
  readonly afterFailure?: (model: Model, failure: ActionError) => Model
  readonly afterSuccess: (effects: DialogEffects) => void
  /** Why OK is greyed (the protected-principal rules' refusal of a login), shown on the page; Script still works. */
  readonly blocked?: (model: Model) => string | undefined
  /** Folders other than the object's listing that a reply's done steps changed (the Users folders of the databases a login's Delete
   *  dropped users in), which the dialog reconciles where they are loaded, after a success or a partial failure. */
  readonly changedFolders?: (model: Model, steps: readonly ActionStep[]) => ChangedFolders | undefined
}
/** A folder kind and the databases whose folder of that kind changed. */
export interface ChangedFolders { readonly folder: FolderId; readonly databases: readonly string[] }

/** Delete Object's checkboxes: the first two apply to databases only, the last to logins only. */
export interface DeleteDraft { readonly deleteHistory: boolean; readonly closeConnections: boolean; readonly dropMappedUsers: boolean }
/** The mapped users a login's Delete may drop: those it lists that are not kept (they own a schema or role, or their database is read-only). */
export const droppableUsers = (model: DeleteTarget) => (model.mappings?.users ?? []).filter(user => !mappedUserKept(user))
/** Whether Delete Object offers to drop the mapped users: some it may drop, and no more mapped than it lists (the backend refuses those). */
export const canDropMappedUsers = (model: DeleteTarget): boolean => droppableUsers(model).length > 0 && (model.mappings?.mapped ?? 0) <= (model.mappings?.users.length ?? 0)
/** Why the option is greyed though users are mapped: more are mapped than the dialog lists. */
export const dropMappedUsersNote = (model: DeleteTarget): string | undefined => (model.mappings?.mapped ?? 0) > (model.mappings?.users.length ?? 0) ? loginDeleteText.tooMany : undefined
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

export interface DialogModels { readonly deleteObject: DeleteTarget; readonly databaseProperties: DatabasePropertiesModel }
export interface DialogDrafts { readonly deleteObject: DeleteDraft; readonly databaseProperties: DatabaseDraft }
export type DialogModel = DialogModels[DialogId]
export type DialogDraft = DialogDrafts[DialogId]
export const dialogDefinitions: { readonly [D in DialogId]: ObjectDialogDefinition<DialogModels[D], DialogDrafts[D]> } = {
  deleteObject: deleteObjectDefinition,
  databaseProperties: databasePropertiesDefinition
}
/** A dialog's definition over the open dialog's model and draft, which the service keeps paired with its dialog. */
export const definitionOf = (dialog: DialogId) => dialogDefinitions[dialog] as unknown as ObjectDialogDefinition<DialogModel, DialogDraft>
