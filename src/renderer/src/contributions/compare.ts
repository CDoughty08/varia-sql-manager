import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { outputOf } from '../menus/targets'
import { focusedOutput } from './output'

/**
 * Compare… (the picker) and Compare with Previous Result with its Exact Text form (CompareService): the menu's grid, else
 * the focused one. Compare… opens the picker on that Table while another group's Table of the run shares a column with it;
 * Compare with Previous compares it at once with the nearest earlier one. Tables of rows that have every row only: never a
 * Pivot, a comparison, a plan set or a Peek grid. The picker takes the pivot builder's place, so opening it closes the
 * builder (and Pivot… closes the picker).
 */
export function compareContribution({ commands, compare, pivot, results, documents, menuTargets }: Pick<Workbench, 'commands' | 'compare' | 'pivot' | 'results' | 'documents' | 'menuTargets'>): Disposable {
  /** The grid a command names (a menu's), else the focused grid of the tab it names (the toolbar's) or of any tab (the
   *  palette's), else the focused entry of that tab or of the active document: never another tab's grid. */
  const gridOf = (args?: CommandArgs) => {
    if (args?.target) {
      const target = outputOf(args)
      return target?.view === 'grid' && target.entry !== undefined && !target.bare ? { tabId: target.tabId, key: target.entry } : undefined
    }
    const focused = focusedOutput(menuTargets)
    if (focused?.view === 'grid' && focused.entry !== undefined && !focused.bare && (args?.tabId === undefined || focused.tabId === args.tabId)) return { tabId: focused.tabId, key: focused.entry }
    const tabId = args?.tabId ?? documents.getSnapshot().activeId
    const tab = tabId ? results.getSnapshot()[tabId] : undefined
    return tabId && tab && !tab.bare && tab.focused !== undefined ? { tabId, key: tab.focused } : undefined
  }
  const previousOf = (args?: CommandArgs) => { const target = gridOf(args); return target && compare.canCompare(target.tabId, target.key) ? target : undefined }
  const pickerOf = (args?: CommandArgs) => { const target = gridOf(args); return target && compare.canPick(target.tabId, target.key) ? target : undefined }
  const command = (exact: boolean) => ({
    when: (args?: CommandArgs) => !!previousOf(args),
    run: async (args?: CommandArgs) => { const target = previousOf(args); if (target) await compare.compare(target.tabId, target.key, { exact }) }
  })
  const registrations = [
    commands.register('output.compareWithPrevious', command(false)),
    commands.register('output.compareWithPreviousExact', command(true)),
    commands.register('output.compare', {
      when: (args?: CommandArgs) => !!pickerOf(args),
      run: (args?: CommandArgs) => {
        const target = pickerOf(args)
        if (!target) return
        pivot.close(target.tabId)
        results.focusEntry(target.tabId, target.key)
        compare.open(target.tabId, target.key)
        results.setView(target.tabId, 'results')
      }
    })
  ]
  return { dispose: () => { for (const registration of registrations) registration.dispose() } }
}
