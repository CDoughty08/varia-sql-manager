import type { editor } from 'monaco-editor'
import type { Workbench } from '../core/workbench'
import type { Disposable } from '../core/types'
import { editorFontFamily } from '../fonts'
import { bindExplorerDrop } from '../explorer/drop'

/** A query editor: an editor group's Monaco instance, with Tools › Options applied and Object Explorer drops bound. */
export interface QueryEditorInstance extends Disposable { readonly instance: editor.IStandaloneCodeEditor }

/** Creates a query editor in `container`. Each editor group has one, which shows the group's active text document. */
export function createQueryEditor(workbench: Pick<Workbench, 'monaco' | 'editorOptions'>, container: HTMLElement): QueryEditorInstance {
  const instance = workbench.monaco.editor.create(container, {
    model: null,
    theme: 'varia',
    // Tools › Options: font size, word wrap, line numbers, drag and drop, current-line highlight. Indentation is the model's.
    ...workbench.editorOptions.monacoOptions(),
    fontFamily: editorFontFamily,
    // Cascadia Code's ligatures would join SQL's <=, <> and != into one glyph.
    fontLigatures: false,
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    padding: { top: 16 },
    // SSMS's indicator margin: bookmarks show there.
    glyphMargin: true,
    // SSMS's Comment Selection writes --SELECT, with no space, and leaves empty lines alone.
    comments: { insertSpace: false, ignoreEmptyLines: true },
    // Quick Find starts from a single-line selection, and looks in a multi-line one, as SSMS's Look in: Selection does.
    // With nothing selected, Quick Find and Replace seed the word after the caret themselves (contributions/editing.ts):
    // Monaco's 'always' would also take the word that ends at the caret.
    find: { autoFindInSelection: 'multiline', seedSearchStringFromSelection: 'selection', loop: true, addExtraSpaceOnTop: false },
    // The workbench's editor menu (MenuService) replaces Monaco's; right-click still moves the caret first.
    contextmenu: false,
    // A middle-drag selects a column on Linux too, as elsewhere. Not a paste guard (standalone Monaco has no selection
    // clipboard): core/primary-selection.ts keeps Linux's PRIMARY selection out.
    selectionClipboard: false,
    // OVR (the Insert key) shows a block caret, as Visual Studio does.
    overtypeCursorStyle: 'block'
  })
  const options = workbench.editorOptions.bindEditor(instance)
  // Object Explorer rows dropped on the editor insert their names.
  const drop = bindExplorerDrop(instance)
  return { instance, dispose: () => { drop.dispose(); options.dispose(); instance.dispose() } }
}
