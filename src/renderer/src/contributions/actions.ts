import { actionServes } from '../../../shared/actions/catalog.ts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerMenuNode } from '../menus/targets'
import { newLoginTarget } from '../dialogs/new-login'

/**
 * Object Explorer's object actions (src/shared/actions/catalog.ts): Select Top 1000 Rows, Rename, Delete, Properties, and
 * Tasks › Take Offline and Bring Online, and Integration Services Catalogs › Create Catalog… (S9a), and Security › New ›
 * Login… (D2a). Each acts on the node its menu was opened for, otherwise on the selected node (F2, Delete, the palette), on a
 * live server. The Database Properties document's verbs (Apply, Discard Changes, Refresh, Stop) and the restore documents'
 * (Restore, Stop, Refresh) come from the same catalogue. Databases › Attach… (D1d) opens on the folder, and Restore Database…
 * and Restore Files and Filegroups… on the Databases folder or as a database's Tasks › Restore › Database… and Files and
 * Filegroups….
 */
export function actionsContribution({ commands, explorer, actions, dialogs, properties, newDatabase, restore, documents, ssisCatalog, connections }: Pick<Workbench, 'commands' | 'explorer' | 'actions' | 'dialogs' | 'properties' | 'newDatabase' | 'restore' | 'documents' | 'ssisCatalog' | 'connections'>): Disposable {
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
  // New Login: a live SQL Server's Security or Logins folder, or a login on it.
  const loginsOf = (node: ExplorerMenuNode | undefined): node is ExplorerMenuNode => !!node && !node.lost && !!newLoginTarget(node)
    && connections.getSnapshot().some(connection => connection.id === node.connectionId && !connection.lost)
  // New Database… on the Databases folder or a database of a live SQL Server box (the menu hides it on Azure and Managed Instance).
  const databases = (node: ExplorerMenuNode | undefined): node is ExplorerMenuNode => !!node && !node.lost && !!node.engine && actionServes('createDatabase', node.engine)
    && (node.ref.type === 'folder' ? node.ref.folder === 'databases' : node.ref.type === 'object' && node.ref.object.kind === 'database')
    && connections.getSnapshot().some(connection => connection.id === node.connectionId && !connection.lost)
  const newDatabaseOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return newDatabase.get(id) ? id : undefined }
  const onNew = (when: (id: string) => boolean, run: (id: string) => unknown) => ({
    when: (args?: CommandArgs) => { const id = newDatabaseOf(args); return !!id && when(id) },
    run: async (args?: CommandArgs) => { const id = newDatabaseOf(args); if (id && when(id)) await run(id) }
  })
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
    commands.register('explorer.attachDatabase', {
      when: args => actions.canRun('attach', nodeOf(args)) && !dialogs.current,
      run: args => { const node = nodeOf(args); if (node) dialogs.open('attachDatabase', node) }
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
    // Tasks › Take Offline and Bring Online (D3a): small modal dialogs; Bring Online runs as it opens.
    commands.register('explorer.takeOffline', {
      when: args => actions.canRun('takeOffline', nodeOf(args)) && !dialogs.current,
      run: args => { const node = nodeOf(args); if (node) dialogs.open('takeOffline', node) }
    }),
    commands.register('explorer.bringOnline', {
      when: args => actions.canRun('bringOnline', nodeOf(args)) && !dialogs.current,
      run: args => { const node = nodeOf(args); if (node) dialogs.open('bringOnline', node) }
    }),
    // Tasks › Detach… (D3b): a modal dialog that stays open on its steps.
    commands.register('explorer.detachDatabase', {
      when: args => actions.canRun('detach', nodeOf(args)) && !dialogs.current,
      run: args => { const node = nodeOf(args); if (node) dialogs.open('detachDatabase', node) }
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
    ...(['explorer.newLogin', 'explorer.newLoginOnSecurity'] as const).map(id => commands.register(id, {
      when: args => loginsOf(nodeOf(args)) && !dialogs.current && !ssisCatalog.current,
      run: args => { const node = nodeOf(args); if (loginsOf(node)) dialogs.open('newLogin', node) }
    })),
    // A database's menu places New Database… as a command of its own (ServerActionSpec.nodePlace); both open the same document.
    ...(['explorer.newDatabase', 'explorer.newDatabaseOnDatabase'] as const).map(id => commands.register(id, {
      when: args => databases(nodeOf(args)),
      run: args => {
        const node = nodeOf(args)
        if (!databases(node)) return
        newDatabase.open(node)
        // The menu returned focus to the tree; the document's name field mounts once the server was read.
        documents.focusActive()
      }
    })),
    commands.register('newDatabase.ok', onNew(id => newDatabase.canCreate(id), id => newDatabase.create(id))),
    commands.register('newDatabase.cancel', onNew(id => newDatabase.get(id)?.phase !== 'creating', id => documents.close(id))),
    commands.register('newDatabase.stop', onNew(id => newDatabase.get(id)?.phase === 'creating', id => newDatabase.stop(id))),
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
