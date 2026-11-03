// The object dialogs' behaviour, one definition per dialog: the model its describe answers, the draft a dialog starts
// from, the action OK sends (and the Script button scripts), SSMS's confirmations before it, and what happens after OK
// succeeds. ObjectDialogService runs the modal ones and ObjectDialog.tsx renders their pages (`dialogPages`);
// DatabasePropertiesService runs Database Properties, a document (src/renderer/src/properties). It is the plug-in point
// for later dialogs (Login Properties, Backup and Restore): a dialog id, its surface and pages in
// src/shared/actions/catalog.ts, a describe in the backend, a definition here, and its pages or sections. No React here,
// so the services and their tests stay in Node.
import type { DialogId } from '../../../shared/actions/catalog.ts'
import { loginMessages, unlockRefusal, type LoginFacts, type LoginLockFacts, type UnlockMode } from '../../../shared/actions/logins.ts'
import type { ActionDescribeResult, ActionError, ActionRequest, DatabasePropertiesModel, DeleteTarget } from '../../../shared/actions/schema.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import { afterDatabaseFailure, databaseConfirm, databaseRequest, initialDatabaseDraft, type DatabaseDraft, type DatabaseRequest } from './database-properties'

/** A request without its ids. */
export type BuiltRequest = Omit<ActionRequest, 'connectionId' | 'requestId'>
/** What a definition builds: the request, nothing to do, or a problem the dialog shows. */
export type DialogRequest = BuiltRequest | undefined | { readonly problem: string }
/** What a dialog's success may do to the rest of the workbench. */
export interface DialogEffects {
  /** Reloads the folder the object is listed in (a Databases folder also refreshes the toolbar's database list). */
  refreshListing(): void
  /** A toast with the object actions' notice key, which the next one replaces. */
  notify(message: string): void
}
/** The dialog OK succeeded in. */
export interface DialogSubject { readonly target: ObjectRef; readonly label: string }
/** A question main asks before OK runs: SSMS's Open Connections prompt. */
export type DialogConfirmation = 'openConnections'
export interface ObjectDialogDefinition<Model, Draft> {
  readonly dialog: DialogId
  /** The dialog's part of the describe's answer; undefined when it is missing. */
  readonly modelOf: (result: ActionDescribeResult) => Model | undefined
  readonly initialDraft: (model: Model, target: ObjectRef) => Draft
  readonly request: (target: ObjectRef, model: Model, draft: Draft) => DialogRequest
  /** A question to ask before OK sends `request` (never before Script). */
  readonly confirm?: (model: Model, request: BuiltRequest) => DialogConfirmation | undefined
  /** The request once the user answered Yes. */
  readonly withConfirmation?: (request: BuiltRequest, confirmation: DialogConfirmation) => BuiltRequest
  /** The model after OK failed, when the failure shows part of it is stale (the same model otherwise). */
  readonly afterFailure?: (model: Model, failure: ActionError) => Model
  /** Why OK cannot run for this model, shown on the page; OK is greyed while it is set, and Script stays available. */
  readonly unavailable?: (model: Model) => string | undefined
  readonly afterSuccess: (effects: DialogEffects, subject: DialogSubject) => void
}

/** Delete Object's checkboxes; they apply to databases only. */
export interface DeleteDraft { readonly deleteHistory: boolean; readonly closeConnections: boolean }
export const deleteObjectDefinition: ObjectDialogDefinition<DeleteTarget, DeleteDraft> = {
  dialog: 'deleteObject',
  modelOf: result => result.deleteTarget,
  // SSMS: Delete backup and restore history is checked (greyed for a snapshot); Close existing connections is not.
  initialDraft: (model, target) => ({ deleteHistory: target.kind === 'database' && !model.isSnapshot, closeConnections: false }),
  request: (target, model, draft) => {
    const database = target.kind === 'database'
    return { action: 'delete', target, closeConnections: database && !model.isSnapshot && draft.closeConnections, deleteHistory: database && !model.isSnapshot && draft.deleteHistory }
  },
  afterSuccess: effects => effects.refreshListing()
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

/** Unlock Login (D4d): the login preflight's facts and its lock-out state, as the unlockLogin describe read them. */
export interface UnlockModel { readonly login: LoginFacts; readonly lock: LoginLockFacts }
/** How to unlock. Keeping the password is the only way until Login Properties (D2c) adds Set a new password, its default. */
export interface UnlockDraft { readonly mode: UnlockMode }
export const unlockSuccessNotice = (label: string) => `Unlocked the login ${label}. Its password history was cleared.`
export const unlockLoginDefinition: ObjectDialogDefinition<UnlockModel, UnlockDraft> = {
  dialog: 'unlockLogin',
  modelOf: result => result.login && result.lock ? { login: result.login, lock: result.lock } : undefined,
  initialDraft: () => ({ mode: 'keepPassword' }),
  // The identity binds OK to the login this dialog read: one renamed, dropped or replaced since is refused, not unlocked.
  request: (target, model, draft) => ({ action: 'unlock', target, mode: draft.mode, ...(model.login.sid && model.login.created ? { loginIdentity: { sid: model.login.sid, created: model.login.created } } : {}) }),
  unavailable: model => { const id = unlockRefusal(model.login, model.lock); return id ? loginMessages[id] : undefined },
  // Unlocked meanwhile (by its owner's new password, or another admin): the page says so and OK greys, as on a fresh open.
  afterFailure: (model, failure) => failure.code === 'NOT_SUPPORTED' && failure.message === loginMessages.notLocked ? { ...model, lock: { ...model.lock, locked: false } } : model,
  // The Logins folder's row and its status come from the reconciled listing.
  afterSuccess: (effects, subject) => { effects.refreshListing(); effects.notify(unlockSuccessNotice(subject.label)) }
}

export interface DialogModels { readonly deleteObject: DeleteTarget; readonly databaseProperties: DatabasePropertiesModel; readonly unlockLogin: UnlockModel }
export interface DialogDrafts { readonly deleteObject: DeleteDraft; readonly databaseProperties: DatabaseDraft; readonly unlockLogin: UnlockDraft }
export type DialogModel = DialogModels[DialogId]
export type DialogDraft = DialogDrafts[DialogId]
export const dialogDefinitions: { readonly [D in DialogId]: ObjectDialogDefinition<DialogModels[D], DialogDrafts[D]> } = {
  deleteObject: deleteObjectDefinition,
  databaseProperties: databasePropertiesDefinition,
  unlockLogin: unlockLoginDefinition
}
/** A dialog's definition over the open dialog's model and draft, which the service keeps paired with its dialog. */
export const definitionOf = (dialog: DialogId) => dialogDefinitions[dialog] as unknown as ObjectDialogDefinition<DialogModel, DialogDraft>
