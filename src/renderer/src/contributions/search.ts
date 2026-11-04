import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf } from '../menus/targets'
import { serverItems } from './query'

/**
 * Search Objects' commands. Search Objects opens a tab on the server whose Object Explorer menu runs it (a database's menu
 * narrows nothing yet: the tab searches the whole server), else the active document's server, else the selected node's,
 * else the one live connection or the one picked from several. Rebuild Search Index rebuilds that server's index; Stop
 * Indexing stops every running build.
 */
export function searchContribution({ commands, objectSearch, documents, connections, explorer, quickInput }: Pick<Workbench, 'commands' | 'objectSearch' | 'documents' | 'connections' | 'explorer' | 'quickInput'>): Disposable {
  const live = (id: string | undefined) => id !== undefined && connections.isLive(id) ? id : undefined
  const target = (args?: CommandArgs): string | undefined => {
    const node = explorerNodeOf(args)
    if (node) return node.lost ? undefined : live(node.connectionId)
    const tab = objectSearch.getSnapshot().documents[documents.getSnapshot().activeId]
    return live(tab?.connectionId) ?? live(documents.active?.connectionId) ?? live(explorer.menuNode(explorer.getSnapshot().selected)?.connectionId)
  }
  const withServer = (placeholder: string, run: (connectionId: string) => void) => (args?: CommandArgs) => {
    const report = (error: unknown) => commands.reportError(error instanceof Error ? error.message : 'Search Objects could not open.')
    const go = (id: string) => { try { run(id) } catch (error) { report(error) } }
    const connectionId = target(args)
    if (connectionId) return go(connectionId)
    const choices = connections.live()
    if (choices.length === 1) return go(choices[0].id)
    if (!choices.length) return report(new Error('Connect to a server to search its objects.'))
    quickInput.show({ ariaLabel: placeholder, placeholder, noun: 'servers', items: serverItems(choices), onDidAccept: item => go(item.id) })
  }
  const registrations = [
    commands.register('explorer.searchObjects', { run: withServer('Select a server to search', id => { objectSearch.open(id) }) }),
    commands.register('explorer.rebuildIndex', { run: withServer('Select a server to index', id => objectSearch.build(id)) }),
    commands.register('explorer.stopIndexing', {
      when: () => Object.values(objectSearch.getSnapshot().indexes).some(entry => entry.requestId),
      run: () => objectSearch.stopAll()
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
