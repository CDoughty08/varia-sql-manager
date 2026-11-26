// The step command editors' Monaco models, one per step of a job document's draft, kept for the document's life rather than an editor's: List's
// editor and Flow's docked one mount and unmount as the view switches, and a model held only by the editor would take its undo stack with it.
// Keys carry the read's epoch (`${epoch}|${stepKey}`): a save renumbers steps, so a model is never carried from one read to the next.
import type { editor } from 'monaco-editor'

export interface StepModel { readonly model: editor.ITextModel; readonly documentId: string }
const byDocument = new Map<string, Map<string, StepModel>>()

/** The document's models, created on first use. */
export function stepModels(documentId: string): Map<string, StepModel> {
  let models = byDocument.get(documentId)
  if (!models) byDocument.set(documentId, models = new Map())
  return models
}

/** Drops the models of reads before `epoch` (their keys no longer name the same steps). */
export function pruneStepModels(documentId: string, epoch: string): void {
  const models = byDocument.get(documentId)
  if (!models) return
  for (const [key, entry] of models) if (!key.startsWith(`${epoch}|`)) { entry.model.dispose(); models.delete(key) }
}

/** The document closed: its models go. */
export function disposeStepModels(documentId: string): void {
  const models = byDocument.get(documentId)
  if (!models) return
  for (const entry of models.values()) entry.model.dispose()
  byDocument.delete(documentId)
}
