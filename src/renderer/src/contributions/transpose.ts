import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { outputOf } from '../menus/targets'
import { focusedOutput } from './output'

/**
 * Transpose, Transpose Selected Rows and Transpose Using Column as Headers (TransposeService): the menu's grid, else the
 * focused one, else (from the results toolbar or the palette) the grid that last had the focus in the named or active
 * query tab. They are offered once the run has ended and the grid's rows have all loaded; Selected Rows needs rows
 * selected, and Using Column as Headers names the columns by the active cell's column.
 */
export function transposeContribution({ commands, transpose, results, documents, menuTargets }: Pick<Workbench, 'commands' | 'transpose' | 'results' | 'documents' | 'menuTargets'>): Disposable {
  const targetOf = (args?: CommandArgs) => {
    const target = outputOf(args) ?? (args?.tabId || args?.target ? undefined : focusedOutput(menuTargets))
    if (args?.target && !target) return undefined
    const found = target ? target.view === 'grid' ? { tabId: target.tabId, index: target.resultIndex } : undefined : (() => {
      const tabId = args?.tabId ?? documents.getSnapshot().activeId
      const tab = tabId ? results.getSnapshot()[tabId] : undefined
      return tabId && tab && tab.sets.length > 0 ? { tabId, index: results.viewState(tabId).focusedIndex } : undefined
    })()
    return found && transpose.canTranspose(found.tabId, found.index) ? found : undefined
  }
  const registrations = [
    commands.register('output.transpose', {
      when: (args?: CommandArgs) => !!targetOf(args),
      run: async (args?: CommandArgs) => { const target = targetOf(args); if (target) await transpose.transpose(target.tabId, target.index) }
    }),
    commands.register('output.transposeSelectedRows', {
      when: (args?: CommandArgs) => { const target = targetOf(args); return !!target && transpose.selectedRows(target.tabId, target.index) !== undefined },
      run: async (args?: CommandArgs) => { const target = targetOf(args); if (target) await transpose.transpose(target.tabId, target.index, { selected: true }) }
    }),
    commands.register('output.transposeWithHeaders', {
      when: (args?: CommandArgs) => { const target = targetOf(args); return !!target && transpose.activeColumn(target.tabId, target.index) !== undefined },
      run: async (args?: CommandArgs) => {
        const target = targetOf(args)
        const header = target && transpose.activeColumn(target.tabId, target.index)
        if (target && header !== undefined) await transpose.transpose(target.tabId, target.index, { header })
      }
    })
  ]
  return { dispose: () => { for (const registration of registrations) registration.dispose() } }
}
