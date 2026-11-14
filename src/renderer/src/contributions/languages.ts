import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { Workbench } from '../core/workbench'
import type { Disposable } from '../core/types'
import { isQueryDocument } from '../documents'
import { triggerEditorAction } from '../editor/actions'
import { definitionNode, definitionMessages, definitionLabel } from '../languages/definition'
import { scriptMenuState } from '../../../shared/scripting/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'

type LanguageWorkbench = Pick<Workbench, 'commands' | 'documents' | 'connections'> & {
  readonly sqlLanguage: Pick<Workbench['sqlLanguage'], 'refreshCache'> & Partial<Pick<Workbench['sqlLanguage'], 'definition'>>
  readonly monaco?: { readonly editor: Pick<typeof Monaco.editor, 'getEditors'> }
  readonly scripting?: Pick<Workbench['scripting'], 'run' | 'inform'>
  readonly peekTabs?: Pick<Workbench['peekTabs'], 'open'>
}

/**
 * Refresh metadata for the chosen query while keeping its execution session and unsaved SQL; Go To Definition (F12) and Peek
 * Definition (Alt+F12) for the SQL editor that has focus: a query tab's, or Peek's read-only one. F12 scripts the object as
 * CREATE to a new query (Script As, as SSMS does), Alt+F12 opens it in a Peek tab. A name that resolves to nothing, or a
 * lookup that fails, is a quiet status-bar notice, never an error banner.
 */
export function languagesContribution({ commands, documents, connections, sqlLanguage, monaco, scripting, peekTabs }: LanguageWorkbench): Disposable {
  const target = (id?: string) => documents.get(id ?? documents.getSnapshot().activeId)
  const refresh = commands.register('edit.refreshIntelliSense', {
    when: args => { const document = target(args?.tabId); return isQueryDocument(document) && !!document?.connectionId && connections.isLive(document.connectionId) },
    unavailable: () => 'Connect this query before refreshing its IntelliSense cache.',
    run: async args => { const document = target(args?.tabId); if (document) await sqlLanguage.refreshCache(document.id) }
  })
  const next = commands.register('edit.nextSqlIssue', { run: () => triggerEditorAction(documents, 'editor.action.marker.next') })
  const previous = commands.register('edit.previousSqlIssue', { run: () => triggerEditorAction(documents, 'editor.action.marker.prev') })
  // The editor with focus (its text, or its find widget), whichever window and view it is in: Monaco tracks every instance.
  // Failing that, the SQL editor that last had it, while it exists: the editor's own menu holds the focus when its Go To
  // Definition is clicked, and the keys themselves only fire in an editor (their when clause).
  let last: Monaco.editor.ICodeEditor | undefined
  const focused = () => {
    const editors = monaco?.editor.getEditors?.() ?? []
    const editor = editors.find(editor => editor.hasWidgetFocus()) ?? (last && editors.includes(last) ? last : undefined)
    const model = editor?.getModel(), position = editor?.getPosition()
    if (!editor || !model || !position || model.getLanguageId() !== 'sql') return undefined
    last = editor
    return { model, position }
  }
  const definition = async (mode: 'script' | 'peek') => {
    const at = focused()
    if (!at || !sqlLanguage.definition || !scripting) return
    const word = at.model.getWordAtPosition(at.position)?.word
    let found
    try { found = await sqlLanguage.definition(at.model, at.position) }
    catch (error) { scripting.inform(definitionMessages.failed(error instanceof Error ? error.message : undefined)); return }
    if (found === undefined) return
    if (found === null || !connections.isLive(found.connectionId)) { scripting.inform(definitionMessages.notFound(word === undefined ? undefined : displayText(word))); return }
    const node = definitionNode(found)
    if (mode === 'peek') {
      if (!peekTabs?.open(node)) scripting.inform(definitionMessages.notPeekable(definitionLabel(found)))
      return
    }
    if (scriptMenuState({ kind: node.kind, ...node.subtype ? { subtype: node.subtype } : {} }).verbs.create !== 'enabled') {
      scripting.inform(definitionMessages.notScriptable(definitionLabel(found)))
      return
    }
    try { await scripting.run('create', 'newQuery', node) }
    catch (error) { scripting.inform(definitionMessages.failed(error instanceof Error ? error.message : undefined)) }
  }
  const goTo = commands.register('edit.goToDefinition', { when: () => !!focused(), unavailable: () => definitionMessages.unavailable, run: () => definition('script') })
  const peek = commands.register('edit.peekDefinition', { when: () => !!focused(), unavailable: () => definitionMessages.unavailable, run: () => definition('peek') })
  return { dispose: () => { last = undefined; refresh.dispose(); next.dispose(); previous.dispose(); goTo.dispose(); peek.dispose() } }
}
