// The object dialogs' behaviour, one definition per dialog: the model its describe answers, the draft a dialog starts
// from, the action OK sends (and the Script button scripts), SSMS's confirmations before it, and what happens after OK
// succeeds. ObjectDialogService runs the modal ones and ObjectDialog.tsx renders their pages (`dialogPages`);
// DatabasePropertiesService runs Database Properties, a document (src/renderer/src/properties). It is the plug-in point
// for later dialogs (Login Properties, Backup and Restore): a dialog id, its surface and pages in
// src/shared/actions/catalog.ts, a describe in the backend, a definition here, and its pages or sections. No React here,
// so the services and their tests stay in Node.
import type { DialogId } from '../../../shared/actions/catalog.ts'
import type { ActionDescribeResult, ActionError, ActionRequest, DatabasePropertiesModel, DatabaseStateModel, DeleteTarget } from '../../../shared/actions/schema.ts'
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
  /** The dialog's database went offline or came online: its Database Properties documents follow. */
  databaseState(offline: boolean): void
}
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
  readonly afterSuccess: (effects: DialogEffects) => void
  /** Why OK cannot run with this draft (the footer says it, and OK is disabled), or undefined. */
  readonly blocked?: (model: Model, draft: Draft) => string | undefined
  /** OK runs as soon as the describe answers, with nothing to choose (SSMS's Bring Online). */
  readonly runOnOpen?: true
  /** A success leaves the dialog open on its steps with Close, as SSMS's progress dialogs do, instead of closing it. */
  readonly keepOpen?: true
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

const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
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

export interface DialogModels { readonly deleteObject: DeleteTarget; readonly databaseProperties: DatabasePropertiesModel; readonly takeOffline: DatabaseStateModel; readonly bringOnline: DatabaseStateModel }
export interface DialogDrafts { readonly deleteObject: DeleteDraft; readonly databaseProperties: DatabaseDraft; readonly takeOffline: TakeOfflineDraft; readonly bringOnline: BringOnlineDraft }
export type DialogModel = DialogModels[DialogId]
export type DialogDraft = DialogDrafts[DialogId]
export const dialogDefinitions: { readonly [D in DialogId]: ObjectDialogDefinition<DialogModels[D], DialogDrafts[D]> } = {
  deleteObject: deleteObjectDefinition,
  databaseProperties: databasePropertiesDefinition,
  takeOffline: takeOfflineDefinition,
  bringOnline: bringOnlineDefinition
}
/** A dialog's definition over the open dialog's model and draft, which the service keeps paired with its dialog. */
export const definitionOf = (dialog: DialogId) => dialogDefinitions[dialog] as unknown as ObjectDialogDefinition<DialogModel, DialogDraft>
