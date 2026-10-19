import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { insertTextFor } from '../../../shared/explorer/refs.ts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, filterable, type ExplorerMenuNode } from '../menus/targets'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const frame = (callback: () => void) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback); else callback() }

/**
 * Object Explorer's commands (Script As's are in contributions/scripting.ts, Select Top, Rename and Delete in contributions/actions.ts). Each acts on the node its context menu was opened for (`CommandArgs.target`; none for the
 * empty area), otherwise on the selected node, so F5, the toolbar, and the palette act on the selection. Nodes must be
 * on a server that is still connected (not lost with a backend restart, even when the backend restarted while the menu
 * was open or the command was waiting).
 */
export function explorerContribution({ commands, documents, connections, explorer }: Pick<Workbench, 'commands' | 'documents' | 'connections' | 'explorer'>,
  api: Pick<VariaApi, 'writeClipboardText'>): Disposable {
  const nodeOf = (args?: CommandArgs): ExplorerMenuNode | undefined => args?.target ? explorerNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
  const live = (node: ExplorerMenuNode | undefined): node is ExplorerMenuNode => !!node && !node.lost && connections.isLive(node.connectionId)
  const queryNode = (args?: CommandArgs) => { const node = nodeOf(args); return live(node) && (node.kind === 'server' || node.kind === 'database') ? node : undefined }
  // From the node's identity, so it works while the node is being reloaded; only a Columns folder needs its loaded rows.
  const copyText = (args?: CommandArgs) => {
    const node = nodeOf(args)
    if (!live(node)) return undefined
    if (node.kind === 'server') return connections.get(node.connectionId)?.server
    return node.kind === 'folder' ? explorer.insertText(node.id) : insertTextFor(node.ref)
  }
  const filterNode = (args?: CommandArgs) => { const node = nodeOf(args); return live(node) && filterable(node) ? node : undefined }
  const registrations = [
    commands.register('explorer.refresh', { run: args => explorer.refresh(nodeOf(args)?.id) }),
    commands.register('explorer.stop', { run: () => explorer.stop() }),
    commands.register('explorer.filter', { when: args => !!filterNode(args), run: args => { const node = filterNode(args); if (node) explorer.openFilter(node.id) } }),
    commands.register('explorer.removeFilter', {
      when: args => !!filterNode(args)?.filtered,
      run: args => { const node = filterNode(args); if (node) explorer.setFilter(node.id, undefined) }
    }),
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
    // A server's name as connected to, or the quoted object name.
    commands.register('explorer.copyName', {
      when: args => copyText(args) !== undefined,
      run: async args => { const text = copyText(args); if (text !== undefined) unwrap(await api.writeClipboardText(text)) }
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
