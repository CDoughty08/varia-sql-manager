import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { outputOf } from '../menus/targets'
import { focusedOutput } from './output'

/**
 * Compare with Previous Result and its Exact Text form (CompareService): the menu's grid, else the focused one, against the
 * run's result before it, once both have every row.
 */
export function compareContribution({ commands, compare, menuTargets }: Pick<Workbench, 'commands' | 'compare' | 'menuTargets'>): Disposable {
  const targetOf = (args?: CommandArgs) => {
    const target = outputOf(args) ?? (args?.target ? undefined : focusedOutput(menuTargets))
    return target?.view === 'grid' && target.entry !== undefined && compare.canCompare(target.tabId, target.entry) ? { tabId: target.tabId, key: target.entry } : undefined
  }
  const command = (exact: boolean) => ({
    when: (args?: CommandArgs) => !!targetOf(args),
    run: async (args?: CommandArgs) => { const target = targetOf(args); if (target) await compare.compare(target.tabId, target.key, { exact }) }
  })
  const registrations = [commands.register('output.compareWithPrevious', command(false)), commands.register('output.compareWithPreviousExact', command(true))]
  return { dispose: () => { for (const registration of registrations) registration.dispose() } }
}
