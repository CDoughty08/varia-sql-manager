import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { outputOf } from '../menus/targets'
import { pivotGroup } from '../results/PivotService'
import { focusedOutput } from './output'

/**
 * Pivot… (PivotService): opens the pivot builder on the group of the menu's grid, else the focused one, else (from the
 * results toolbar or the palette) on the group the builder follows in the named or active query tab. It is offered once
 * the run has ended: for a grid, when it shows a group's Table or its Pivot (which edits that Pivot: it is always read from
 * the Table); from the toolbar or the palette, while some group can be pivoted. Never for a comparison, a plan set or a
 * Peek grid, so no pivot is made of anything but a Table.
 */
export function pivotContribution({ commands, pivot, results, documents, menuTargets }: Pick<Workbench, 'commands' | 'pivot' | 'results' | 'documents' | 'menuTargets'>): Disposable {
  /** The tab, and the grid when the command names one (`key`). Undefined when it names something Pivot does not act on. */
  const targetOf = (args?: CommandArgs): { tabId: string; key?: string } | undefined => {
    const target = outputOf(args) ?? (args?.tabId || args?.target ? undefined : focusedOutput(menuTargets))
    if (args?.target && !target) return undefined
    if (target) return target.view === 'grid' && target.entry !== undefined && !target.bare ? { tabId: target.tabId, key: target.entry } : undefined
    const tabId = args?.tabId ?? documents.getSnapshot().activeId
    return tabId ? { tabId } : undefined
  }
  const offered = (target: { tabId: string; key?: string } | undefined): target is { tabId: string; key?: string } => {
    const tab = target ? results.getSnapshot()[target.tabId] : undefined
    if (!target || !tab || tab.bare || tab.status === 'running' || tab.status === 'closed') return false
    return target.key !== undefined ? !!pivotGroup(tab, target.key) : tab.groups.some(group => !!pivotGroup(tab, group.table.key))
  }
  const registration = commands.register('output.pivot', {
    when: (args?: CommandArgs) => offered(targetOf(args)),
    run: (args?: CommandArgs) => {
      const target = targetOf(args)
      if (!offered(target)) return
      // A grid the command names is the one the builder follows from now on.
      if (target.key !== undefined) results.focusEntry(target.tabId, target.key)
      pivot.open(target.tabId, target.key ?? results.getSnapshot()[target.tabId]?.focused)
      results.setView(target.tabId, 'results')
    }
  })
  return registration
}
