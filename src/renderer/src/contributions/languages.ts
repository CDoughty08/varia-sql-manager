import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { Workbench } from '../core/workbench'
import type { Disposable } from '../core/types'
import { isQueryDocument } from '../documents'
import { triggerEditorAction } from '../editor/actions'
import { definitionMessages } from '../languages/definition'
import { registerPeekCardEscape, type DefinitionMode } from '../languages/EditorPeekService'

type LanguageWorkbench = Pick<Workbench, 'commands' | 'documents' | 'connections'> & {
  readonly sqlLanguage: Pick<Workbench['sqlLanguage'], 'refreshCache'>
  readonly monaco?: { readonly editor: Pick<typeof Monaco.editor, 'getEditors'> & Partial<Pick<typeof Monaco.editor, 'registerCommand' | 'addKeybindingRules'>> }
  readonly editorPeek?: Pick<Workbench['editorPeek'], 'run' | 'closeCard'>
}

/**
 * Refresh metadata for the chosen query while keeping its execution session and unsaved SQL; Go To Definition (F12), Peek
 * Definition (Alt+F12) and Open Definition in Peek Tab for the SQL editor that has focus: a query tab's, or Peek's read-only
 * one (`EditorPeekService` has the rules). Escape in the editor Peek's card is beside closes the card.
 */
export function languagesContribution({ commands, documents, connections, sqlLanguage, monaco, editorPeek }: LanguageWorkbench): Disposable {
  const target = (id?: string) => documents.get(id ?? documents.getSnapshot().activeId)
  const refresh = commands.register('edit.refreshIntelliSense', {
    when: args => { const document = target(args?.tabId); return isQueryDocument(document) && !!document?.connectionId && connections.isLive(document.connectionId) },
    unavailable: () => 'Connect this query before refreshing its IntelliSense cache.',
    run: async args => { const document = target(args?.tabId); if (document) await sqlLanguage.refreshCache(document.id) }
  })
  const next = commands.register('edit.nextSqlIssue', { run: () => triggerEditorAction(documents, 'editor.action.marker.next') })
  const previous = commands.register('edit.previousSqlIssue', { run: () => triggerEditorAction(documents, 'editor.action.marker.prev') })
  // The editor with focus (its text, or its find widget), whichever window and view it is in: Monaco tracks every instance.
  // The editor's menu needs nothing more: MenuService runs a chosen command once focus is back where the menu took it from.
  const focused = () => {
    const editor = monaco?.editor.getEditors?.().find(editor => editor.hasWidgetFocus())
    const model = editor?.getModel(), position = editor?.getPosition()
    return editor && model && position && model.getLanguageId() === 'sql' ? { editor, model, position } : undefined
  }
  const definition = (mode: DefinitionMode) => async () => { const place = focused(); if (place && editorPeek) await editorPeek.run(mode, place) }
  const registrations = [
    commands.register('edit.goToDefinition', { when: () => !!focused(), unavailable: () => definitionMessages.unavailable, run: definition('script') }),
    commands.register('edit.peekDefinition', { when: () => !!focused(), unavailable: () => definitionMessages.unavailable, run: definition('card') }),
    commands.register('edit.openPeekTab', { when: () => !!focused(), unavailable: () => definitionMessages.unavailable, run: definition('tab') })
  ]
  const editorApi = monaco?.editor
  if (editorPeek && editorApi?.registerCommand && editorApi.addKeybindingRules) {
    registrations.push(registerPeekCardEscape({ editor: { registerCommand: editorApi.registerCommand, addKeybindingRules: editorApi.addKeybindingRules } }, editorPeek))
  }
  return { dispose: () => { refresh.dispose(); next.dispose(); previous.dispose(); for (const registration of registrations) registration.dispose() } }
}
