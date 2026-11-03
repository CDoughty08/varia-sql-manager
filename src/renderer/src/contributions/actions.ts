import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerMenuNode } from '../menus/targets'

/**
 * Object Explorer's object actions (src/shared/actions/catalog.ts): Select Top 1000 Rows, Rename, Delete, Properties,
 * Restore Database… and Restore Files and Filegroups… (the Databases folder's, and a database's Tasks › Restore › Database… and
 * Files and Filegroups…), and Integration Services Catalogs › Create Catalog… (S9a). Each acts on the node its menu was opened
 * for, otherwise on the selected node (F2, Delete, the palette), on a live server. The Database Properties document's verbs
 * (Apply, Discard Changes, Refresh, Stop) and the restore documents' (Restore, Stop, Refresh) come from the same catalogue.
 */
export function actionsContribution({ commands, explorer, actions, dialogs, properties, restore, documents, ssisCatalog, connections }: Pick<Workbench, 'commands' | 'explorer' | 'actions' | 'dialogs' | 'properties' | 'restore' | 'documents' | 'ssisCatalog' | 'connections'>): Disposable {
  // The verbs act on the document whose header runs them (`tabId`), else the active one.
  const propertiesOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return properties.get(id) ? id : undefined }
  const on = (when: (id: string) => boolean, run: (id: string) => unknown) => ({
    when: (args?: CommandArgs) => { const id = propertiesOf(args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = propertiesOf(args); if (id && when(id)) await run(id) }
  })
  const restoreOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return restore.get(id) ? id : undefined }
  const onRestore = (when: (id: string) => boolean, run: (id: string) => unknown) => ({
    when: (args?: CommandArgs) => { const id = restoreOf(args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = restoreOf(args); if (id && when(id)) await run(id) }
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
    // The Databases folder opens it with no source chosen (msdb's first database with backups); a database, with itself as the source.
    ...(['explorer.restoreDatabase', 'explorer.tasks.restoreDatabase'] as const).map(id => commands.register(id, {
      when: args => actions.canRun('restore', nodeOf(args)),
      run: args => {
        const node = nodeOf(args)
        if (!node) return
        const database = node.ref.type === 'object' ? node.ref.object.name : undefined
        restore.open(node.connectionId, database, node.ref.type === 'folder' ? node.id : explorer.listingFolderOf(node.id))
        documents.focusActive()
      }
    })),
    // Restore Files and Filegroups… (D1g): from a database, its files; from the Databases folder, the first user database msdb has backups of.
    ...(['explorer.restoreFiles', 'explorer.tasks.restoreFiles'] as const).map(id => commands.register(id, {
      when: args => actions.canRun('restoreFiles', nodeOf(args)),
      run: args => {
        const node = nodeOf(args)
        if (!node) return
        const database = node.ref.type === 'object' ? node.ref.object.name : undefined
        restore.open(node.connectionId, database, node.ref.type === 'folder' ? node.id : explorer.listingFolderOf(node.id), 'files')
        documents.focusActive()
      }
    })),
    commands.register('explorer.createCatalog', {
      when: args => catalogs(nodeOf(args)) && !dialogs.current && !ssisCatalog.current,
      run: args => { const node = nodeOf(args); if (catalogs(node)) ssisCatalog.open(node) }
    }),
    commands.register('databaseProperties.apply', on(id => properties.canApply(id), id => properties.apply(id))),
    commands.register('databaseProperties.discard', on(id => properties.canDiscard(id), id => properties.discard(id))),
    commands.register('databaseProperties.refresh', on(id => properties.canRefresh(id), id => properties.refresh(id))),
    commands.register('databaseProperties.stop', on(id => properties.get(id)?.phase === 'applying', id => properties.stop(id))),
    commands.register('restoreDatabase.run', onRestore(id => restore.canRun(id), id => restore.run(id))),
    commands.register('restoreDatabase.stop', onRestore(id => restore.isRunning(id), id => restore.stop(id))),
    commands.register('restoreDatabase.refresh', onRestore(id => restore.canRefresh(id), id => restore.refresh(id)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
