import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerMenuNode } from '../menus/targets'

/**
 * Object Explorer's object actions (src/shared/actions/catalog.ts): Select Top 1000 Rows, Rename, Delete and Properties, and
 * Integration Services Catalogs › Create Catalog… (S9a). Each acts
 * on the node its menu was opened for, otherwise on the selected node (F2, Delete, the palette), on a live server. The
 * Database Properties document's verbs (Apply, Discard Changes, Refresh, Stop) come from the same catalogue.
 */
export function actionsContribution({ commands, explorer, actions, dialogs, properties, documents, ssisCatalog, connections }: Pick<Workbench, 'commands' | 'explorer' | 'actions' | 'dialogs' | 'properties' | 'documents' | 'ssisCatalog' | 'connections'>): Disposable {
  // The verbs act on the document whose header runs them (`tabId`), else the active one.
  const propertiesOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return properties.get(id) ? id : undefined }
  const on = (when: (id: string) => boolean, run: (id: string) => unknown) => ({
    when: (args?: CommandArgs) => { const id = propertiesOf(args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = propertiesOf(args); if (id && when(id)) await run(id) }
  })
  const nodeOf = (args?: CommandArgs): ExplorerMenuNode | undefined => args?.target ? explorerNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
  // Integration Services Catalogs on a live server; the dialog itself says when the server cannot have a catalog.
  const catalogs = (node: ExplorerMenuNode | undefined): node is ExplorerMenuNode => !!node && !node.lost && node.folder === 'integrationServicesCatalogs'
    && connections.getSnapshot().some(connection => connection.id === node.connectionId && !connection.lost)
  const registrations = [
    // SSMS's script lists the columns, so the query can be trimmed; it runs at once when it can.
    commands.register('explorer.selectTopRows', {
      when: args => actions.canRun('selectTop', nodeOf(args)),
      run: async args => { const node = nodeOf(args); if (node) await actions.selectTop(node) }
    }),
    commands.register('explorer.rename', {
      when: args => actions.canRun('rename', nodeOf(args)),
      run: args => { const node = nodeOf(args); if (node) actions.beginRename(node) }
    }),
    commands.register('explorer.delete', {
      when: args => actions.canRun('delete', nodeOf(args)) && !dialogs.current,
      run: args => { const node = nodeOf(args); if (node) dialogs.open('deleteObject', node) }
    }),
    commands.register('explorer.properties', {
      when: args => actions.canRun('properties', nodeOf(args)) && !dialogs.current,
      run: args => {
        const node = nodeOf(args)
        if (!node) return
        properties.open(node)
        // The menu returned focus to the tree; the document's section list mounts on a later frame.
        documents.focusActive()
      }
    }),
    commands.register('explorer.createCatalog', {
      when: args => catalogs(nodeOf(args)) && !dialogs.current && !ssisCatalog.current,
      run: args => { const node = nodeOf(args); if (catalogs(node)) ssisCatalog.open(node) }
    }),
    commands.register('databaseProperties.apply', on(id => properties.canApply(id), id => properties.apply(id))),
    commands.register('databaseProperties.discard', on(id => properties.canDiscard(id), id => properties.discard(id))),
    commands.register('databaseProperties.refresh', on(id => properties.canRefresh(id), id => properties.refresh(id))),
    commands.register('databaseProperties.stop', on(id => properties.get(id)?.phase === 'applying', id => properties.stop(id)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
