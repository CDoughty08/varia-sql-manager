import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { insertTextFor } from '../../../shared/explorer/refs.ts'
import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, filterable, type ExplorerMenuNode } from '../menus/targets'
import { windows } from '../core/windows'

const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const frame = (callback: () => void) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback); else callback() }

/**
 * Object Explorer's commands (Script As's are in contributions/scripting.ts, Select Top, Rename and Delete in contributions/actions.ts). Each acts on the node its context menu was opened for (`CommandArgs.target`; none for the
 * empty area), otherwise on the selected node, so F5, the toolbar, and the palette act on the selection. Nodes must be
 * on a server that is still connected (not lost with a backend restart, even when the backend restarted while the menu
 * was open or the command was waiting).
 */
export function explorerContribution({ commands, documents, connections, explorer, explorerStatus, settings, peek, peekTabs }: Pick<Workbench, 'commands' | 'documents' | 'connections' | 'explorer'>
  & { explorerStatus?: Pick<Workbench['explorerStatus'], 'refresh'>; settings?: Pick<Workbench['settings'], 'toggle'>; peek?: Pick<Workbench['peek'], 'canPeek' | 'peek' | 'getSnapshot' | 'close' | 'refresh'>
    peekTabs?: Pick<Workbench['peekTabs'], 'canOpen' | 'open' | 'view'> },
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
    // Refresh also samples the server's live status at once, so its chips match the reloaded rows.
    commands.register('explorer.refresh', { run: args => { const node = nodeOf(args); explorer.refresh(node?.id); explorerStatus?.refresh(node?.connectionId) } }),
    commands.register('explorer.stop', { run: () => explorer.stop() }),
    commands.register('explorer.filter', { when: args => !!filterNode(args), run: args => { const node = filterNode(args); if (node) explorer.openFilter(node.id) } }),
    commands.register('explorer.removeFilter', {
      when: args => !!filterNode(args)?.filtered,
      run: args => { const node = filterNode(args); if (node) explorer.setFilter(node.id, undefined) }
    }),
    commands.register('explorer.collapseAll', { run: () => explorer.collapseAll() }),
    // The setting is the state: ExplorerService follows it, and its context key checks the button and the palette entry.
    commands.register('explorer.groupBySchema', { when: () => !!settings, run: () => settings?.toggle('objectExplorer.groupBySchema') }),
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
    // The context menu's Peek focuses the card; Alt+F12 and the palette open it on the selection, focused too.
    commands.register('explorer.peek', {
      when: args => !!peek?.canPeek(nodeOf(args)),
      run: args => peek?.peek(nodeOf(args), args?.target ? 'menu' : 'keyboard')
    }),
    // Open Peek as Tab: the open card's object (on the tab it shows, and the card closes), otherwise the node a menu, a Ctrl+click
    // or the selection names.
    commands.register('explorer.openPeekTab', {
      when: args => !args?.target && !!peek?.getSnapshot().open || !!peekTabs?.canOpen(nodeOf(args)),
      run: args => {
        const card = args?.target ? undefined : peek?.getSnapshot().open
        if (card) { peek?.close(); peekTabs?.open(card.node, card.tab) } else peekTabs?.open(nodeOf(args))
      }
    }),
    // F5 in the card refreshes the card; elsewhere it refreshes the active Peek tab.
    commands.register('peek.refresh', {
      when: () => !!peek?.getSnapshot().open || !!peekTabs?.view(documents.getSnapshot().activeId),
      run: () => {
        const inCard = typeof document !== 'undefined' && !!windows.activeElement()?.closest('[data-peek-card]')
        if (inCard || !peekTabs?.view(documents.getSnapshot().activeId)) peek?.refresh()
        else peekTabs.view(documents.getSnapshot().activeId)?.refresh()
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
