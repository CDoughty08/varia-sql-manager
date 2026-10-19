import type { editor } from 'monaco-editor'
import type { DocumentService } from '../services/documents'

/**
 * The query editor, focused, for a command to act on, or undefined when no editor or document is bound. Menus restore
 * focus before running a command, so focusing again is cheap, and it puts the caret back for a palette run.
 */
export function focusedEditor(documents: Pick<DocumentService, 'boundEditor'>): editor.IStandaloneCodeEditor | undefined {
  const target = documents.boundEditor
  if (!target?.getModel()) return undefined
  target.focus()
  return target
}

/** Runs a Monaco action in the query editor, as its key would. */
export function triggerEditorAction(documents: Pick<DocumentService, 'boundEditor'>, action: string): void {
  focusedEditor(documents)?.trigger('menu', action, null)
}
