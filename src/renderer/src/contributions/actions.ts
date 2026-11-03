import { actionServes } from '../../../shared/actions/catalog.ts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerMenuNode } from '../menus/targets'
import { newLoginTarget } from '../dialogs/new-login'

/**
 * Object Explorer's object actions (src/shared/actions/catalog.ts): Select Top 1000 Rows, Rename, Delete, Properties, and
 * Tasks › Take Offline and Bring Online, and Integration Services Catalogs › Create Catalog… (S9a), and Security › New ›
 * Login… (D2a). Each acts
 * on the node its menu was opened for, otherwise on the selected node (F2, Delete, the palette), on a live server. The
 * Database Properties document's verbs (Apply, Discard Changes, Refresh, Stop) come from the same catalogue. Databases ›
 * Attach… (D1d) opens on the folder.
 */
export function actionsContribution({ commands, explorer, actions, dialogs, properties, newDatabase, documents, ssisCatalog, connections }: Pick<Workbench, 'commands' | 'explorer' | 'actions' | 'dialogs' | 'properties' | 'newDatabase' | 'documents' | 'ssisCatalog' | 'connections'>): Disposable {
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
    commands.register('databaseProperties.stop', on(id => properties.get(id)?.phase === 'applying', id => properties.stop(id)))
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
