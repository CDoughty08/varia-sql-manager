// The object dialogs' behaviour, one definition per dialog: the draft a dialog starts from, the action OK sends (and the
// Script button scripts), and what happens after OK succeeds. ObjectDialogService runs them; ObjectDialog.tsx renders
// their pages (`dialogPages`). It is the plug-in point for later dialogs (Database Properties, Login Properties,
// Backup and Restore): a dialog id and pages in src/shared/actions/catalog.ts, a describe in the backend, a definition
// here, and its pages there. No React here, so the service and its tests stay in Node.
import type { DialogId } from '../../../shared/actions/catalog.ts'
import type { ActionRequest, DeleteTarget } from '../../../shared/actions/schema.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'

/** What a definition builds: the request without its ids, nothing to do, or a problem the dialog shows. */
export type DialogRequest = Omit<ActionRequest, 'connectionId' | 'requestId'> | undefined | { readonly problem: string }
/** What a dialog's success may do to the rest of the workbench. */
export interface DialogEffects {
  /** Reloads the folder the object is listed in (a Databases folder also refreshes the toolbar's database list). */
  refreshListing(): void
}
export interface ObjectDialogDefinition<Model, Draft> {
  readonly dialog: DialogId
  readonly initialDraft: (model: Model, target: ObjectRef) => Draft
  readonly request: (target: ObjectRef, model: Model, draft: Draft) => DialogRequest
  readonly afterSuccess: (effects: DialogEffects) => void
}

/** Delete Object's checkboxes; they apply to databases only. */
export interface DeleteDraft { readonly deleteHistory: boolean; readonly closeConnections: boolean }
export const deleteObjectDefinition: ObjectDialogDefinition<DeleteTarget, DeleteDraft> = {
  dialog: 'deleteObject',
  // SSMS: Delete backup and restore history is checked (greyed for a snapshot); Close existing connections is not.
  initialDraft: (model, target) => ({ deleteHistory: target.kind === 'database' && !model.isSnapshot, closeConnections: false }),
  request: (target, model, draft) => {
    const database = target.kind === 'database'
    return { action: 'delete', target, closeConnections: database && !model.isSnapshot && draft.closeConnections, deleteHistory: database && !model.isSnapshot && draft.deleteHistory }
  },
  afterSuccess: effects => effects.refreshListing()
}

export type DialogModel = DeleteTarget
export type DialogDraft = DeleteDraft
export const dialogDefinitions: { readonly [D in DialogId]: ObjectDialogDefinition<DialogModel, DialogDraft> } = { deleteObject: deleteObjectDefinition }
