import type { editor } from 'monaco-editor'
import type { Workbench } from '../core/workbench'
import type { Disposable } from '../core/types'
import { editorFontFamily } from '../fonts'
import { bindExplorerDrop } from '../explorer/drop'

/** A query editor: an editor group's Monaco instance, with Tools › Options applied and Object Explorer drops bound. */
export interface QueryEditorInstance extends Disposable { readonly instance: editor.IStandaloneCodeEditor; contains(target: Node | null): boolean; setVisible(visible: boolean): void }

/**
 * What sets a query editor that only shows text (Peek's definition) apart from an editor group's: everything else (Tools ›
 * Options, the font, Find, the `varia` theme, and the SQL language features every model gets) is the same.
 */
export interface QueryEditorUse {
  /**
   * Read-only, with the words Monaco shows when the user tries to type: no Object Explorer drops, and Tab moves focus, as in
   * any read-only field, so a dialog's focus loop still works.
   */
  readonly readOnly?: { readonly message: string }
  /** A card's editor: less padding and no indicator margin (bookmarks live only in query documents). */
  readonly compact?: boolean
  /** The accessible name of the editor's text. */
  readonly ariaLabel?: string
  /** A Monaco context key set on this editor alone, so Monaco keybindings (Varia's chord bridge) can leave it out. */
  readonly contextKey?: string
  /** Whether its body-level widget host hides with the Query editor pane (default); Peek's card floats outside every pane. */
  readonly inEditorPane?: boolean
}

/**
 * Creates a query editor in `container`. Each editor group has one, which shows the group's active text document; Peek has
 * one per card or tab, read-only (`use`).
 */
export function createQueryEditor(workbench: Pick<Workbench, 'monaco' | 'editorOptions' | 'panes'>, container: HTMLElement, use: QueryEditorUse = {}): QueryEditorInstance {
  const readOnly = use.readOnly
  // Dockview clips panel contents and floats create stacking contexts. Keep Monaco's widgets in the document that
  // owns this editor, outside those ancestors; fixed positioning lets Monaco constrain them to the window's edges.
  const overflow = container.ownerDocument.createElement('div')
  overflow.className = 'monaco-editor editor-overflow-widgets'
  container.ownerDocument.body.appendChild(overflow)
  const instance = workbench.monaco.editor.create(container, {
    model: null,
    theme: 'varia',
    overflowWidgetsDomNode: overflow,
    fixedOverflowWidgets: true,
    // Tools › Options: font size, word wrap, line numbers, drag and drop, current-line highlight. Indentation is the model's.
    ...workbench.editorOptions.monacoOptions(),
    fontFamily: editorFontFamily,
    // Cascadia Code's ligatures would join SQL's <=, <> and != into one glyph.
    fontLigatures: false,
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    padding: { top: use.compact ? 4 : 16 },
    // SSMS's indicator margin: bookmarks show there.
    glyphMargin: !use.compact,
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
    overtypeCursorStyle: 'block',
    ...readOnly ? { readOnly: true, readOnlyMessage: { value: readOnly.message }, tabFocusMode: true } : {},
    ...use.ariaLabel ? { ariaLabel: use.ariaLabel } : {}
  })
  overflow.setAttribute('data-query-editor-id', instance.getId())
  const options = workbench.editorOptions.bindEditor(instance)
  // The external host needs Monaco's current theme/high-contrast classes too, including after a new model replaces
  // its view. Observe just that view's class attribute, never the editor's changing text DOM.
  const classes = new MutationObserver(() => syncClasses())
  const syncClasses = () => { overflow.className = `${instance.getDomNode()?.className ?? 'monaco-editor'} editor-overflow-widgets` }
  const watchClasses = () => {
    classes.disconnect()
    const view = instance.getDomNode()
    if (view) classes.observe(view, { attributes: true, attributeFilter: ['class'] })
    syncClasses()
  }
  const model = instance.onDidChangeModel(watchClasses)
  watchClasses()
  // Closing or tabbing away from the outer Query Editor keeps its inner groups mounted. The body-level host must
  // follow that pane too, since it no longer inherits the editor container's visibility.
  let visible = true
  const syncVisibility = () => { overflow.hidden = !visible || (use.inEditorPane !== false && !workbench.panes.getSnapshot().editor) }
  const visibility = workbench.panes.subscribe(syncVisibility)
  syncVisibility()
  // Object Explorer rows dropped on the editor insert their names, where it takes text.
  const drop = readOnly ? undefined : bindExplorerDrop(instance)
  if (use.contextKey) instance.createContextKey(use.contextKey, true)
  return { instance, contains: target => container.contains(target) || overflow.contains(target), setVisible: value => { visible = value; syncVisibility() },
    dispose: () => { visibility(); drop?.dispose(); options.dispose(); model.dispose(); classes.disconnect(); instance.dispose(); overflow.remove() } }
}
