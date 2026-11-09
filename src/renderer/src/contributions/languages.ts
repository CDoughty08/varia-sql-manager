import type { Workbench } from '../core/workbench'
import type { Disposable } from '../core/types'
import { isQueryDocument } from '../documents'

type LanguageWorkbench = Pick<Workbench, 'commands' | 'documents' | 'connections'> & { readonly sqlLanguage: Pick<Workbench['sqlLanguage'], 'refreshCache'> }

/** Refresh metadata for the chosen query while keeping its execution session and unsaved SQL. */
export function languagesContribution({ commands, documents, connections, sqlLanguage }: LanguageWorkbench): Disposable {
  const target = (id?: string) => documents.get(id ?? documents.getSnapshot().activeId)
  return commands.register('edit.refreshIntelliSense', {
    when: args => { const document = target(args?.tabId); return isQueryDocument(document) && !!document?.connectionId && connections.isLive(document.connectionId) },
    unavailable: () => 'Connect this query before refreshing its IntelliSense cache.',
    run: async args => { const document = target(args?.tabId); if (document) await sqlLanguage.refreshCache(document.id) }
  })
}
