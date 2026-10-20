import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { explorerNodeOf, type ExplorerMenuNode } from '../menus/targets'

const frame = (callback: () => void) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback); else callback() }

/**
 * New › Table… and the table designer's commands (src/shared/designer/catalog.ts). New Table acts on the Tables folder
 * its menu was opened for, else the selected one, on a live server; the designer's commands act on the designer whose
 * toolbar or menu runs them (`tabId`), else the active document.
 */
export function designerContribution({ commands, explorer, designers, documents, connections }: Pick<Workbench, 'commands' | 'explorer' | 'designers' | 'documents' | 'connections'>): Disposable {
  const tablesFolder = (args?: CommandArgs): ExplorerMenuNode | undefined => {
    const node = args?.target ? explorerNodeOf(args) : explorer.menuNode(explorer.getSnapshot().selected)
    return node && node.kind === 'folder' && node.folder === 'tables' && !node.lost && node.ref.type === 'folder' && node.ref.owner.kind === 'database' && connections.isLive(node.connectionId) ? node : undefined
  }
  const designerOf = (args?: CommandArgs): string | undefined => { const id = args?.tabId ?? documents.getSnapshot().activeId; return designers.get(id) ? id : undefined }
  const editing = (args?: CommandArgs) => { const id = designerOf(args); return id && designers.canEdit(id) ? id : undefined }
  const on = (action: (id: string) => void) => ({ when: (args?: CommandArgs) => !!editing(args), run: (args?: CommandArgs) => { const id = editing(args); if (id) action(id) } })
  const registrations = [
    commands.register('explorer.newTable', {
      when: args => !!tablesFolder(args),
      run: args => {
        const node = tablesFolder(args)
        if (!node) return
        designers.open(node)
        // The menu returned focus to the tree; the designer's grid mounts on a later frame.
        frame(() => documents.focusActive())
      }
    }),
    commands.register('tableDesigner.setPrimaryKey', on(id => designers.setPrimaryKey(id))),
    commands.register('tableDesigner.removePrimaryKey', on(id => designers.removePrimaryKey(id))),
    commands.register('tableDesigner.insertColumn', on(id => designers.insertColumn(id))),
    commands.register('tableDesigner.deleteColumn', on(id => designers.deleteColumns(id))),
    commands.register('tableDesigner.generateChangeScript', { when: args => { const id = editing(args); return !!id && designers.canSubmit(id) }, run: async args => { const id = editing(args); if (id) await designers.generateScript(id) } }),
    commands.register('tableDesigner.properties', { when: args => !!designerOf(args), run: args => { const id = designerOf(args); if (id) designers.toggleProperties(id) } }),
    commands.register('tableDesigner.stop', { when: () => designers.anySaving, run: args => designers.stop(designerOf(args)) })
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
