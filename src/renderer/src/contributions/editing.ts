import type { editor } from 'monaco-editor'
import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { defaultRules, type Platform, type ResolvedRule } from '../../../shared/commands/keybindings'
import { focusedEditor } from '../editor/actions'
import { caretFindSeed } from '../editor/find-seed'
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
 * The part of Monaco's FindController the find commands use: the current search text, and setting it as Monaco's own
 * seeding does (escaped under regular expressions).
 */
interface SearchStringController { getState(): { readonly searchString: string }; setSearchString(searchString: string): void }

/**
 * The find commands that start from the word at the caret, with their Monaco actions: Quick Find and Quick Replace
 * always, Find Next and Previous only while there is no search text yet, as if Ctrl+F had seeded it first.
 */
const seededFindActions = [
  ['edit.find', 'actions.find', 'always'], ['edit.replace', 'editor.action.startFindReplaceAction', 'always'],
  ['edit.findNext', 'editor.action.nextMatchFindAction', 'whenEmpty'], ['edit.findPrevious', 'editor.action.previousMatchFindAction', 'whenEmpty']
] as const
/**
 * Their keys (Ctrl+F, Ctrl+H, F3, Shift+F3; ⌘F, ⌥⌘F, ⌘G, ⇧⌘G, F3, ⇧F3), which Monaco dispatches, run them in editor text
 * instead of Monaco's actions, so the keys seed as the menus and the palette do. In the find widget Monaco's own actions
 * still have them.
 */
const seededFindRules = (platform: Platform): ResolvedRule[] => defaultRules(platform).filter(rule => seededFindActions.some(([id]) => id === rule.command))

/**
 * SSMS's editing commands in the query editor: Quick Find and Replace, Find Next and Previous, Go To Line, Edit ›
 * Advanced's case, indent and View White Space commands, Bookmarks, and IntelliSense's snippets. Each acts on the bound
 * editor, focused first; with no editor or document it does nothing. Varia's own editor chords reach Monaco through the
 * keybinding bridge.
 */
export function editingContribution(workbench: Pick<Workbench, 'commands' | 'documents' | 'editorOptions' | 'bookmarks' | 'editorDialogs' | 'quickInput' | 'platform'>, monaco: BridgeMonaco): Disposable {
  const { commands, documents, editorOptions, bookmarks, editorDialogs, quickInput } = workbench
  const withEditor = (run: (target: editor.IStandaloneCodeEditor, model: editor.ITextModel) => void) => () => {
    const target = focusedEditor(documents), model = target?.getModel()
    if (target && model) run(target, model)
  }
  // With nothing selected, the find box takes the word the caret is at the start of or inside (caretFindSeed), or keeps
  // its text; Monaco seeds from a single-line selection itself (seedSearchStringFromSelection: 'selection'). The word is
  // set after the action starts: Monaco creates the find widget then, synchronously, and a new widget does not read a
  // search text set before it. Monaco focuses and selects the find box a microtask later, so typing replaces the word;
  // Find Next and Previous search for it then, after the find model starts (they await the find clipboard first).
  const seededFind = (action: string, when: 'always' | 'whenEmpty') => withEditor((target, model) => {
    const controller = target.getContribution('editor.contrib.findController') as unknown as Partial<SearchStringController> | null
    const selection = target.getSelection()
    const empty = typeof controller?.getState === 'function' && controller.getState().searchString === ''
    const seed = selection && (when === 'always' || empty) ? caretFindSeed(model, selection) : undefined
    target.trigger('menu', action, null)
    if (seed !== undefined && typeof controller?.setSearchString === 'function') controller.setSearchString(seed)
  })
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
    registerEditorBridge(monaco, commands, workbench.platform, seededFindRules(workbench.platform)),
    ...seededFindActions.map(([id, action, when]) => commands.register(id, { run: seededFind(action, when) })),
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
