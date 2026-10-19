import type { editor } from 'monaco-editor'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { focusedEditor, triggerEditorAction } from '../editor/actions'
import { registerEditorBridge, type BridgeMonaco } from '../editor/keybinding-bridge'
import { snippetById, snippets, type Snippet } from '../editor/snippets'
import { applyTextOp, caseEdits, checkSelectionSize, indentEdits, type TextSelection } from '../editor/text-ops'
import type { QuickPickItem } from '../quickinput/QuickInputService'

/** The part of Monaco's SnippetController2 that inserts a snippet, typed here because Monaco does not export it. */
interface SnippetInserter { insert(template: string, options?: { undoStopBefore?: boolean; undoStopAfter?: boolean; adjustWhitespace?: boolean }): void }
function snippetController(target: editor.IStandaloneCodeEditor): SnippetInserter {
  const controller = target.getContribution('snippetController2') as unknown as SnippetInserter | null
  if (typeof controller?.insert !== 'function') throw new Error('Snippets are unavailable.')
  return controller
}

/**
 * SSMS's editing commands in the query editor: Find Next and Previous, Go To Line, Edit › Advanced's case, indent and
 * View White Space commands, Bookmarks, and IntelliSense's snippets. Each acts on the bound editor, focused first; with
 * no editor or document it does nothing. Varia's own editor chords reach Monaco through the keybinding bridge.
 */
export function editingContribution(workbench: Pick<Workbench, 'commands' | 'documents' | 'editorOptions' | 'bookmarks' | 'editorDialogs' | 'quickInput' | 'platform'>, monaco: BridgeMonaco): Disposable {
  const { commands, documents, editorOptions, bookmarks, editorDialogs, quickInput } = workbench
  const withEditor = (run: (target: editor.IStandaloneCodeEditor, model: editor.ITextModel) => void) => () => {
    const target = focusedEditor(documents), model = target?.getModel()
    if (target && model) run(target, model)
  }
  const selections = (target: editor.IStandaloneCodeEditor): TextSelection[] => target.getSelections() ?? []
  const changeCase = (mode: 'upper' | 'lower') => withEditor((target, model) =>
    applyTextOp(target, mode === 'upper' ? 'varia.makeUppercase' : 'varia.makeLowercase', caseEdits(model, selections(target), mode)))
  // The indent unit is the model's: Options' Tabs page sets it on every model.
  const indent = (mode: 'increase' | 'decrease') => withEditor((target, model) => {
    const { indentSize, insertSpaces } = model.getOptions()
    applyTextOp(target, mode === 'increase' ? 'varia.increaseIndent' : 'varia.decreaseIndent', indentEdits(model, selections(target), { indentSize, insertSpaces }, mode))
  })
  const goToLine = withEditor((target, model) => {
    const tabId = documents.getSnapshot().activeId
    editorDialogs.openGoToLine({ tabId, lineCount: model.getLineCount(), line: target.getPosition()?.lineNumber ?? 1 })
  })
  /** The snippet picker: Insert Snippet lists the expansions by category, Surround With the surround snippets. */
  const pickSnippet = (kind: Snippet['kind']) => withEditor((target, model) => {
    snippetController(target)
    if (kind === 'surround') checkSelectionSize(model, selections(target))
    const tabId = documents.getSnapshot().activeId
    const items: QuickPickItem[] = snippets.filter(snippet => snippet.kind === kind).map(snippet => ({
      id: snippet.id, label: snippet.title, description: snippet.description, icon: 'symbol-snippet', keywords: [snippet.category],
      ...kind === 'expansion' ? { group: snippet.category } : {}
    }))
    const placeholder = kind === 'expansion' ? 'Insert Snippet: type to filter by name or category' : 'Surround With:'
    // Ranked as the palette ranks commands, so "create table" picks Create Table; an empty filter lists the categories in order.
    quickInput.show({
      ariaLabel: kind === 'expansion' ? 'Insert Snippet' : 'Surround With', placeholder, noun: 'snippets', items,
      onDidAccept: item => {
        // Only into the query the picker was opened for, if the editor still shows it; focus is back in it by now.
        const snippet = snippetById(item.id), current = documents.boundEditor
        if (!snippet || !current?.getModel() || current.getModel() !== documents.getModel(tabId)) return
        current.focus()
        snippetController(current).insert(snippet.body, { undoStopBefore: true, undoStopAfter: true })
      }
    })
  })
  const registrations = [
    registerEditorBridge(monaco, commands, workbench.platform),
    commands.register('edit.findNext', { run: () => triggerEditorAction(documents, 'editor.action.nextMatchFindAction') }),
    commands.register('edit.findPrevious', { run: () => triggerEditorAction(documents, 'editor.action.previousMatchFindAction') }),
    commands.register('edit.goToLine', { run: goToLine }),
    commands.register('edit.makeUppercase', { run: changeCase('upper') }),
    commands.register('edit.makeLowercase', { run: changeCase('lower') }),
    commands.register('edit.increaseIndent', { run: indent('increase') }),
    commands.register('edit.decreaseIndent', { run: indent('decrease') }),
    commands.register('editor.toggleWhitespace', { run: () => editorOptions.toggleWhitespace() }),
    commands.register('editor.toggleLineNumbers', { run: () => editorOptions.toggleLineNumbers() }),
    commands.register('edit.toggleBookmark', { run: () => { focusedEditor(documents); bookmarks.toggle() } }),
    commands.register('edit.nextBookmark', { run: () => bookmarks.go(1, 'all') }),
    commands.register('edit.previousBookmark', { run: () => bookmarks.go(-1, 'all') }),
    commands.register('edit.nextBookmarkInDocument', { run: () => bookmarks.go(1, 'document') }),
    commands.register('edit.previousBookmarkInDocument', { run: () => bookmarks.go(-1, 'document') }),
    commands.register('edit.clearBookmarks', { run: () => { bookmarks.clear(); focusedEditor(documents) } }),
    commands.register('edit.insertSnippet', { run: pickSnippet('expansion') }),
    commands.register('edit.surroundWith', { run: pickSnippet('surround') })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
