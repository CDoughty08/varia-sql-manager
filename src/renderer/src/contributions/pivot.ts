import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { outputOf } from '../menus/targets'
import { focusedOutput } from './output'

/**
 * Pivot… (PivotService): opens the pivot panel on the menu's grid, else the focused one, else (from the results toolbar or
 * the palette) the grid that last had the focus in the named or active query tab. It is offered once the run has ended.
 */
export function pivotContribution({ commands, pivot, results, documents, menuTargets }: Pick<Workbench, 'commands' | 'pivot' | 'results' | 'documents' | 'menuTargets'>): Disposable {
  const targetOf = (args?: CommandArgs) => {
    const target = outputOf(args) ?? (args?.tabId || args?.target ? undefined : focusedOutput(menuTargets))
    if (args?.target && !target) return undefined
    if (target) return target.view === 'grid' ? { tabId: target.tabId, index: target.resultIndex } : undefined
    const tabId = args?.tabId ?? documents.getSnapshot().activeId
    const tab = tabId ? results.getSnapshot()[tabId] : undefined
    if (!tabId || !tab || tab.sets.length === 0) return undefined
    return { tabId, index: results.viewState(tabId).focusedIndex }
  }
  const registration = commands.register('output.pivot', {
    when: (args?: CommandArgs) => {
      const target = targetOf(args)
      const tab = target ? results.getSnapshot()[target.tabId] : undefined
      return !!target && !!tab && tab.status !== 'running' && tab.status !== 'closed'
    },
    run: (args?: CommandArgs) => {
      const target = targetOf(args)
      if (!target) return
      pivot.open(target.tabId, target.index)
      results.setView(target.tabId, 'results')
    }
  })
  return registration
}
