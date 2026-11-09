import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { triggerEditorAction } from '../editor/actions'

// Monaco actions behind the Edit menu's editor commands. Monaco keeps dispatching their keys; the catalogue only labels
// them. Quick Find and Quick Replace choose their search text first, so they are editing commands (contributions/editing.ts).
const editorActions = [
  ['edit.toggleLineComment', 'editor.action.commentLine'], ['edit.commentLines', 'editor.action.addCommentLine'], ['edit.uncommentLines', 'editor.action.removeCommentLine']
] as const

/**
 * Query editor commands: the Monaco action wrappers, word wrap, insert or overtype, moving between open queries in tab
 * order (each editor group's tabs in turn), and the editor groups' splits and moves (docs/editor-groups.md).
 */
export function editorContribution({ commands, documents, editorOptions, editorGroups, inputMode, tabRename }: Pick<Workbench, 'commands' | 'documents' | 'editorOptions' | 'editorGroups' | 'inputMode' | 'tabRename'>): Disposable {
  const step = (delta: 1 | -1) => {
    const { documents: list, activeId } = documents.getSnapshot()
    if (list.length < 2) return
    const index = Math.max(0, list.findIndex(document => document.id === activeId))
    const next = list[(index + delta + list.length) % list.length].id, fromTab = editorGroups.focusedDocument() !== undefined
    documents.activate(next)
    if (fromTab) editorGroups.focusTab(next)
  }
  // The query tab menu, or a key pressed on a focused tab, names its tab (`tabId`); otherwise the active document. The moved
  // tab stays the one shown, in its own group.
  const tab = (tabId: string | undefined) => tabId ?? documents.getSnapshot().activeId
  const move = (tabId: string | undefined, delta: 1 | -1) => editorGroups.moveInGroup(tab(tabId), delta)
  const canMove = (tabId: string | undefined, delta: 1 | -1) => editorGroups.canMoveInGroup(tab(tabId), delta)
  // Split needs another tab in the document's own group, which the precondition (two documents anywhere) cannot see.
  const unsplittable = (id: string) => editorGroups.groupOf(id)?.documents.length === 1 ? 'Open a second query in its editor group first.' : undefined
  const registrations = [
    ...editorActions.map(([id, action]) => commands.register(id, { run: () => triggerEditorAction(documents, action) })),
    commands.register('editor.toggleWordWrap', { run: () => editorOptions.toggleWordWrap() }),
    // Disabled when a Monaco upgrade took away what the toggle relies on.
    commands.register('editor.toggleOvertype', { when: () => inputMode.getSnapshot().available, run: () => inputMode.toggle() }),
    commands.register('document.next', { run: () => step(1) }),
    commands.register('document.previous', { run: () => step(-1) }),
    commands.register('document.moveLeft', { when: context => canMove(context?.tabId, -1), run: context => move(context?.tabId, -1) }),
    commands.register('document.moveRight', { when: context => canMove(context?.tabId, 1), run: context => move(context?.tabId, 1) }),
    commands.register('editor.splitRight', { when: context => editorGroups.canSplit(tab(context?.tabId)), unavailable: context => unsplittable(tab(context?.tabId)), run: context => editorGroups.split(tab(context?.tabId), 'right') }),
    commands.register('editor.splitDown', { when: context => editorGroups.canSplit(tab(context?.tabId)), unavailable: context => unsplittable(tab(context?.tabId)), run: context => editorGroups.split(tab(context?.tabId), 'down') }),
    commands.register('editor.moveToNextGroup', { when: context => editorGroups.canMoveToGroup(tab(context?.tabId), 1), run: context => editorGroups.moveToGroup(tab(context?.tabId), 1) }),
    commands.register('editor.moveToPreviousGroup', { when: context => editorGroups.canMoveToGroup(tab(context?.tabId), -1), run: context => editorGroups.moveToGroup(tab(context?.tabId), -1) }),
    commands.register('editor.focusNextGroup', { run: () => editorGroups.focusGroup(1) }),
    commands.register('editor.focusPreviousGroup', { run: () => editorGroups.focusGroup(-1) }),
    commands.register('editor.joinGroups', { run: () => editorGroups.join() }),
    commands.register('editor.increaseTabRows', { when: context => editorGroups.canChangeTabRows(tab(context?.tabId), 1), run: context => editorGroups.changeTabRows(tab(context?.tabId), 1) }),
    commands.register('editor.decreaseTabRows', { when: context => editorGroups.canChangeTabRows(tab(context?.tabId), -1), run: context => editorGroups.changeTabRows(tab(context?.tabId), -1) }),
    commands.register('editor.float', { when: context => editorGroups.canFloat(tab(context?.tabId)), run: context => editorGroups.float(tab(context?.tabId)) }),
    commands.register('editor.dock', { when: context => editorGroups.isFloating(tab(context?.tabId)), run: context => editorGroups.dock(tab(context?.tabId)) }),
    // The tab menu names its tab; F2 renames the focused tab (it runs only while one has focus); the palette, the active one.
    commands.register('document.rename', { when: context => !!documents.get(tab(context?.tabId)), run: context => { tabRename.start(tab(context?.tabId)) } })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
