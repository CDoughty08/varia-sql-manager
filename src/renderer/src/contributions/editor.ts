import type { Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { triggerEditorAction } from '../editor/actions'

// Monaco actions behind the Edit menu's editor commands. Monaco keeps dispatching their keys; the catalogue only labels them.
const editorActions = [
  ['edit.find', 'actions.find'], ['edit.replace', 'editor.action.startFindReplaceAction'], ['edit.toggleLineComment', 'editor.action.commentLine'],
  ['edit.commentLines', 'editor.action.addCommentLine'], ['edit.uncommentLines', 'editor.action.removeCommentLine']
] as const

/** Query editor commands: the Monaco action wrappers, word wrap, and moving between open queries in tab-strip order. */
export function editorContribution({ commands, documents, editorOptions }: Pick<Workbench, 'commands' | 'documents' | 'editorOptions'>): Disposable {
  const step = (delta: 1 | -1) => {
    const { documents: list, activeId } = documents.getSnapshot()
    if (list.length < 2) return
    const index = Math.max(0, list.findIndex(document => document.id === activeId))
    documents.activate(list[(index + delta + list.length) % list.length].id)
  }
  const registrations = [
    ...editorActions.map(([id, action]) => commands.register(id, { run: () => triggerEditorAction(documents, action) })),
    commands.register('editor.toggleWordWrap', { run: () => editorOptions.toggleWordWrap() }),
    commands.register('document.next', { run: () => step(1) }),
    commands.register('document.previous', { run: () => step(-1) })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
