import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerMenuNode } from '../menus/targets'

/**
 * Object Explorer's object actions (src/shared/actions/catalog.ts): Select Top 1000 Rows, Rename and Delete. Each acts
 * on the node its menu was opened for, otherwise on the selected node (F2, Delete, the palette), on a live server.
 */
export function actionsContribution({ commands, explorer, actions, dialogs }: Pick<Workbench, 'commands' | 'explorer' | 'actions' | 'dialogs'>): Disposable {
  const nodeOf = (args?: CommandArgs): ExplorerMenuNode | undefined => args?.target ? explorerNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
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
    })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
