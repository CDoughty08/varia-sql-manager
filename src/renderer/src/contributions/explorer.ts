import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { copyName, selectTopRowsScript } from '../../../shared/sql/identifiers'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerNode } from '../menus/targets'
import { refreshPath } from '../services/explorer'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
// An intersection, not Extract: one variant covers both 'database' and 'tablesFolder'.
type Kind<K extends ExplorerNode['kind']> = ExplorerNode & { readonly kind: K }
const nodeOf = <K extends ExplorerNode['kind']>(args: CommandArgs | undefined, kinds: readonly K[]): Kind<K> | undefined => {
  const node = explorerNodeOf(args)
  return node && (kinds as readonly string[]).includes(node.kind) ? node as Kind<K> : undefined
}
const frame = (callback: () => void) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback); else callback() }

/**
 * Object Explorer's commands. Each acts on the node its menu was opened for (`CommandArgs.target`), on a server that is
 * still connected (not lost with a backend restart, even when the backend restarted while the menu was open or the
 * command was waiting); Refresh without a node acts on the focused node, so F5 refreshes what has focus.
 */
export function explorerContribution({ commands, documents, queries, connections, files, explorer, menuTargets }: Pick<Workbench, 'commands' | 'documents' | 'queries' | 'connections' | 'files' | 'explorer' | 'menuTargets'>,
  api: Pick<VariaApi, 'tableColumns' | 'scriptTable' | 'writeClipboardText'>): Disposable {
  const live = (node: { readonly connectionId: string } | undefined) => !!node && connections.isLive(node.connectionId)
  const table = (args?: CommandArgs) => { const node = nodeOf(args, ['table']); return live(node) ? node : undefined }
  const script = async (node: Kind<'table'>) => unwrap(await api.scriptTable(node.connectionId, node.database, node.schema, node.name)).sql
  const focused = (): ExplorerNode | undefined => {
    const hit = typeof document === 'undefined' ? undefined : menuTargets.targetFor(document.activeElement)
    return hit?.target.kind === 'explorer' ? hit.target.node : undefined
  }
  const registrations = [
    commands.register('explorer.refresh', { run: args => explorer.refresh(refreshPath(explorerNodeOf(args) ?? focused())) }),
    commands.register('explorer.newQuery', {
      when: args => live(nodeOf(args, ['server', 'database'])),
      run: args => {
        const node = nodeOf(args, ['server', 'database']), connection = node && connections.get(node.connectionId)
        if (!node || !connection || connection.lost) return
        documents.newQuery('', undefined, connection.id, node.kind === 'database' ? node.database : connection.database)
        // The menu returned focus to the node; the new query's editor may mount only on a later frame.
        frame(() => documents.boundEditor?.focus())
      }
    }),
    // SSMS's script lists the columns, so the query can be trimmed; it runs at once when it can.
    commands.register('explorer.selectTopRows', {
      when: args => !!table(args),
      run: async args => {
        const node = table(args)
        if (!node) return
        const { columns, truncated } = unwrap(await api.tableColumns(node.connectionId, node.database, node.schema, node.name))
        if (!connections.isLive(node.connectionId)) return
        // Not dirty: the menu can always produce it again.
        documents.newQuery(selectTopRowsScript({ database: node.database, schema: node.schema, name: node.name, columns, truncated }), undefined, node.connectionId, node.database, false)
        if (queries.canExecute()) await queries.execute()
      }
    }),
    commands.register('explorer.scriptCreateToNewQuery', {
      when: args => !!table(args),
      run: async args => {
        const node = table(args)
        if (!node) return
        const sql = await script(node)
        if (connections.isLive(node.connectionId)) documents.newQuery(sql, `${node.schema}.${node.name}.sql`, node.connectionId, node.database, true)
      }
    }),
    commands.register('explorer.scriptCreateToFile', { when: args => !!table(args), run: async args => { const node = table(args); if (node) await files.saveCopy(`${node.schema}.${node.name}.sql`, await script(node)) } }),
    commands.register('explorer.scriptCreateToClipboard', { when: args => !!table(args), run: async args => { const node = table(args); if (node) unwrap(await api.writeClipboardText(await script(node))) } }),
    commands.register('explorer.copyName', {
      when: args => live(nodeOf(args, ['server', 'database', 'table', 'serverObject'])),
      run: async args => {
        const node = nodeOf(args, ['server', 'database', 'table', 'serverObject']), connection = node && connections.get(node.connectionId)
        if (node && connection && !connection.lost) unwrap(await api.writeClipboardText(copyName(node, connection)))
      }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
