import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { searchHitNames, type SearchHitNames } from '../../../shared/explorer/search.ts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, searchHitOf } from '../menus/targets'
import { explorerSearchId, type FocusedHit } from '../search/ObjectSearchService'
import { revealHit } from '../search/hit-actions'
import { serverItems } from './query'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }

/**
 * Search Objects' commands. Search Objects opens a tab on the server whose Object Explorer menu runs it (a database's menu
 * narrows nothing yet: the tab searches the whole server); from anywhere else it searches all servers when several are
 * connected, else the one. Rebuild Search Index rebuilds the index of the server its menu or tab is on (every server, from an
 * All servers tab), else the active document's or the selected node's, else the one picked; Stop Indexing stops every running build. A result's Reveal and Copy commands act on the result its menu was opened for, else the
 * selected result of the list that has focus, on a live server.
 */
export function searchContribution(workbench: Pick<Workbench, 'commands' | 'objectSearch' | 'documents' | 'connections' | 'explorer' | 'quickInput'>, api: Pick<VariaApi, 'writeClipboardText'>): Disposable {
  const { commands, objectSearch, documents, connections, explorer, quickInput } = workbench
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
  const hitOf = (args?: CommandArgs): FocusedHit | undefined => {
    const target = searchHitOf(args)
    const hit = target ? { searchId: target.searchId, connectionId: target.node.connectionId, index: target.index, hit: target.hit } : args?.target ? undefined : objectSearch.focusedHit()
    return hit && connections.isLive(hit.connectionId) ? hit : undefined
  }
  const copy = (id: 'search.copyName' | 'search.copySchemaName' | 'search.copyQualifiedName' | 'search.copyBracketedName', pick: (names: SearchHitNames) => string | undefined) => {
    const text = (args?: CommandArgs) => { const hit = hitOf(args); return hit ? pick(searchHitNames(hit.hit.object)) || undefined : undefined }
    return commands.register(id, { when: args => text(args) !== undefined, run: async args => { const value = text(args); if (value !== undefined) unwrap(await api.writeClipboardText(value)) } })
  }
  const registrations = [
    commands.register('search.revealHit', {
      when: args => !!hitOf(args),
      run: args => {
        const hit = hitOf(args)
        if (!hit) return
        objectSearch.pickHit(hit.searchId, hit.hit)
        revealHit(workbench, hit.connectionId, hit.hit, hit.searchId === explorerSearchId)
      }
    }),
    copy('search.copyName', names => names.name),
    copy('search.copySchemaName', names => names.schema),
    copy('search.copyQualifiedName', names => names.qualified),
    copy('search.copyBracketedName', names => names.bracketed),
    commands.register('explorer.searchObjects', {
      run: args => {
        const node = explorerNodeOf(args), choices = connections.live()
        if (node || choices.length < 2) { withServer('Select a server to search', id => { objectSearch.open(id) })(args); return }
        try { objectSearch.open(undefined, undefined, true) } catch (error) { commands.reportError(error instanceof Error ? error.message : 'Search Objects could not open.') }
      }
    }),
    commands.register('explorer.focusSearch', { run: () => { void commands.execute('window.explorer', undefined, 'toolbar'); objectSearch.focusPane() } }),
    commands.register('explorer.rebuildIndex', {
      run: args => {
        const tab = objectSearch.getSnapshot().documents[documents.getSnapshot().activeId]
        if (!explorerNodeOf(args) && tab?.allServers) { for (const connection of connections.live()) objectSearch.build(connection.id); return }
        withServer('Select a server to index', id => objectSearch.build(id))(args)
      }
    }),
    commands.register('explorer.stopIndexing', {
      when: () => Object.values(objectSearch.getSnapshot().indexes).some(entry => entry.requestId),
      run: () => objectSearch.stopAll()
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
