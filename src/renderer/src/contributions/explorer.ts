import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { insertTextFor } from '../../../shared/explorer/refs.ts'
import { selectTopRowsScript } from '../../../shared/sql/identifiers'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerMenuNode } from '../menus/targets'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const frame = (callback: () => void) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback); else callback() }
interface TableName { readonly connectionId: string; readonly database: string; readonly schema: string; readonly name: string }

/**
 * Object Explorer's commands. Each acts on the node its context menu was opened for (`CommandArgs.target`; none for the
 * empty area), otherwise on the selected node, so F5, the toolbar, and the palette act on the selection. Nodes must be
 * on a server that is still connected (not lost with a backend restart, even when the backend restarted while the menu
 * was open or the command was waiting).
 */
export function explorerContribution({ commands, documents, queries, connections, files, explorer }: Pick<Workbench, 'commands' | 'documents' | 'queries' | 'connections' | 'files' | 'explorer'>,
  api: Pick<VariaApi, 'tableColumns' | 'scriptTable' | 'writeClipboardText'>): Disposable {
  const nodeOf = (args?: CommandArgs): ExplorerMenuNode | undefined => args?.target ? explorerNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
  const live = (node: ExplorerMenuNode | undefined): node is ExplorerMenuNode => !!node && !node.lost && connections.isLive(node.connectionId)
  const table = (args?: CommandArgs): TableName | undefined => {
    const node = nodeOf(args), object = node?.ref.type === 'object' ? node.ref.object : undefined
    return live(node) && object?.kind === 'table' && object.database !== undefined && object.schema !== undefined && object.name !== undefined
      ? { connectionId: node.connectionId, database: object.database, schema: object.schema, name: object.name } : undefined
  }
  const queryNode = (args?: CommandArgs) => { const node = nodeOf(args); return live(node) && (node.kind === 'server' || node.kind === 'database') ? node : undefined }
  // From the node's identity, so it works while the node is being reloaded; only a Columns folder needs its loaded rows.
  const copyText = (args?: CommandArgs) => {
    const node = nodeOf(args)
    if (!live(node)) return undefined
    if (node.kind === 'server') return connections.get(node.connectionId)?.server
    return node.kind === 'folder' ? explorer.insertText(node.id) : insertTextFor(node.ref)
  }
  const script = async (name: TableName) => unwrap(await api.scriptTable(name.connectionId, name.database, name.schema, name.name)).sql
  const registrations = [
    commands.register('explorer.refresh', { run: args => explorer.refresh(nodeOf(args)?.id) }),
    commands.register('explorer.stop', { run: () => explorer.stop() }),
    commands.register('explorer.collapseAll', { run: () => explorer.collapseAll() }),
    commands.register('explorer.newQuery', {
      when: args => !!queryNode(args),
      run: args => {
        const node = queryNode(args), connection = node && connections.get(node.connectionId)
        if (!node || !connection) return
        const database = node.ref.type === 'object' && node.ref.object.kind === 'database' ? node.ref.object.name : undefined
        documents.newQuery('', undefined, connection.id, database ?? connection.database)
        // The menu returned focus to the tree; the new query's editor may mount only on a later frame.
        frame(() => documents.boundEditor?.focus())
      }
    }),
    // SSMS's script lists the columns, so the query can be trimmed; it runs at once when it can.
    commands.register('explorer.selectTopRows', {
      when: args => !!table(args),
      run: async args => {
        const name = table(args)
        if (!name) return
        const { columns, truncated } = unwrap(await api.tableColumns(name.connectionId, name.database, name.schema, name.name))
        if (!connections.isLive(name.connectionId)) return
        // Not dirty: the menu can always produce it again.
        documents.newQuery(selectTopRowsScript({ ...name, columns, truncated }), undefined, name.connectionId, name.database, false)
        if (queries.canExecute()) await queries.execute()
      }
    }),
    commands.register('explorer.scriptCreateToNewQuery', {
      when: args => !!table(args),
      run: async args => {
        const name = table(args)
        if (!name) return
        const sql = await script(name)
        if (connections.isLive(name.connectionId)) documents.newQuery(sql, `${name.schema}.${name.name}.sql`, name.connectionId, name.database, true)
      }
    }),
    commands.register('explorer.scriptCreateToFile', { when: args => !!table(args), run: async args => { const name = table(args); if (name) await files.saveCopy(`${name.schema}.${name.name}.sql`, await script(name)) } }),
    commands.register('explorer.scriptCreateToClipboard', { when: args => !!table(args), run: async args => { const name = table(args); if (name) unwrap(await api.writeClipboardText(await script(name))) } }),
    // A server's name as connected to, or the quoted object name.
    commands.register('explorer.copyName', {
      when: args => copyText(args) !== undefined,
      run: async args => { const text = copyText(args); if (text !== undefined) unwrap(await api.writeClipboardText(text)) }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
