// The object dialogs' behaviour, one definition per dialog: the model its describe answers, the draft a dialog starts
// from, the action OK sends (and the Script button scripts), SSMS's confirmations before it, and what happens after OK
// succeeds. ObjectDialogService runs the modal ones and ObjectDialog.tsx renders their pages (`dialogPages`);
// DatabasePropertiesService runs Database Properties, a document (src/renderer/src/properties). It is the plug-in point
// for later dialogs (Login Properties, Backup and Restore): a dialog id, its surface and pages in
// src/shared/actions/catalog.ts, a describe in the backend, a definition here, and its pages or sections. No React here,
// so the services and their tests stay in Node.
import type { DialogId } from '../../../shared/actions/catalog.ts'
import type { ActionDescribeResult, ActionError, ActionRequest, AttachRequest, AttachServerFacts, DatabasePropertiesModel, DeleteTarget } from '../../../shared/actions/schema.ts'
import type { ExplorerNodeRef, ObjectRef } from '../../../shared/explorer/refs.ts'
import type { LongRunKind } from '../../../shared/long-runs.ts'
import { attachBlocked, attachRequest, initialAttachDraft, type AttachDraft } from './attach-database'
import { afterDatabaseFailure, databaseConfirm, databaseRequest, initialDatabaseDraft, type DatabaseDraft, type DatabaseRequest } from './database-properties'

/** A request without its ids. */
export type BuiltRequest = Omit<ActionRequest, 'connectionId' | 'requestId'>
/** What a definition builds: the request, nothing to do, or a problem the dialog shows. */
export type DialogRequest = BuiltRequest | undefined | { readonly problem: string }
/** What a dialog's success may do to the rest of the workbench. */
export interface DialogEffects {
  /** Reloads the folder the object is listed in, or the folder the dialog opened on (a Databases folder also refreshes the
   *  toolbar's database list), selecting `select` once it is listed. */
  refreshListing(select?: ExplorerNodeRef): void
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
  /** Why OK cannot run the draft as it is (OK is disabled and says so), or undefined. */
  readonly blocked?: (model: Model, draft: Draft) => string | undefined
  /** A long run (src/shared/long-runs.ts): registered while OK runs, so closing the window and disconnecting wait for it. */
  readonly longRun?: LongRunKind
  readonly afterSuccess: (effects: DialogEffects, request: BuiltRequest) => void
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

export interface DialogModels { readonly deleteObject: DeleteTarget; readonly databaseProperties: DatabasePropertiesModel; readonly attachDatabase: AttachServerFacts }
export interface DialogDrafts { readonly deleteObject: DeleteDraft; readonly databaseProperties: DatabaseDraft; readonly attachDatabase: AttachDraft }
export type DialogModel = DialogModels[DialogId]
export type DialogDraft = DialogDrafts[DialogId]
export const dialogDefinitions: { readonly [D in DialogId]: ObjectDialogDefinition<DialogModels[D], DialogDrafts[D]> } = {
  deleteObject: deleteObjectDefinition,
  databaseProperties: databasePropertiesDefinition,
  attachDatabase: attachDatabaseDefinition
}
/** A dialog's definition over the open dialog's model and draft, which the service keeps paired with its dialog. */
export const definitionOf = (dialog: DialogId) => dialogDefinitions[dialog] as unknown as ObjectDialogDefinition<DialogModel, DialogDraft>
