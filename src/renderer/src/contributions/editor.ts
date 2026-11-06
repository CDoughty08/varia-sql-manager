import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { triggerEditorAction } from '../editor/actions'

// Monaco actions behind the Edit menu's editor commands. Monaco keeps dispatching their keys; the catalogue only labels
// them. Quick Find and Quick Replace choose their search text first, so they are editing commands (contributions/editing.ts).
const editorActions = [
  ['edit.toggleLineComment', 'editor.action.commentLine'], ['edit.commentLines', 'editor.action.addCommentLine'], ['edit.uncommentLines', 'editor.action.removeCommentLine']
] as const

/** Query editor commands: the Monaco action wrappers, word wrap, insert or overtype, and moving between open queries in tab-strip order. */
export function editorContribution({ commands, documents, editorOptions, inputMode, tabRename }: Pick<Workbench, 'commands' | 'documents' | 'editorOptions' | 'inputMode' | 'tabRename'>,
  focusedTab: () => string | undefined = () => undefined): Disposable {
  const renameTarget = (args?: CommandArgs) => args?.tabId ?? focusedTab() ?? documents.getSnapshot().activeId
  const step = (delta: 1 | -1) => {
    const { documents: list, activeId } = documents.getSnapshot()
    if (list.length < 2) return
    const index = Math.max(0, list.findIndex(document => document.id === activeId))
    documents.activate(list[(index + delta + list.length) % list.length].id)
  }
  // The query tab menu names its tab (`tabId`); keys move the active one. The moved tab stays the one shown.
  const move = (tabId: string | undefined, delta: 1 | -1) => {
    const { documents: list, activeId } = documents.getSnapshot(), id = tabId ?? activeId
    const index = list.findIndex(document => document.id === id)
    if (index >= 0) documents.move(id, index + delta)
  }
  const canMove = (tabId: string | undefined, delta: 1 | -1) => {
    const { documents: list, activeId } = documents.getSnapshot(), index = list.findIndex(document => document.id === (tabId ?? activeId))
    const target = list[index + delta]
    return index >= 0 && !!target && !!target.pinned === !!list[index].pinned
  }
  const registrations = [
    ...editorActions.map(([id, action]) => commands.register(id, { run: () => triggerEditorAction(documents, action) })),
    commands.register('editor.toggleWordWrap', { run: () => editorOptions.toggleWordWrap() }),
    // Disabled when a Monaco upgrade took away what the toggle relies on.
    commands.register('editor.toggleOvertype', { when: () => inputMode.getSnapshot().available, run: () => inputMode.toggle() }),
    commands.register('document.next', { run: () => step(1) }),
    commands.register('document.previous', { run: () => step(-1) }),
    commands.register('document.moveLeft', { when: context => canMove(context?.tabId, -1), run: context => move(context?.tabId, -1) }),
    commands.register('document.moveRight', { when: context => canMove(context?.tabId, 1), run: context => move(context?.tabId, 1) }),
    // F2 targets the focused tab, which pinning can move without selecting it. The tab menu names its target.
    commands.register('document.rename', { when: context => !!documents.get(renameTarget(context)), run: context => { tabRename.start(renameTarget(context)) } })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
