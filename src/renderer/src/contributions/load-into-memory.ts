import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { outputOf } from '../menus/targets'
import { focusedOutput } from './output'

/**
 * Load Result into Memory: reads a windowed BigQuery result of a finished run into result memory, in place
 * (ResultsService.loadIntoMemory). It acts on the menu's grid, else the focused one, else (from the toolbar's ⋯ or the
 * palette) the grid that last had the focus in the named or active query tab. Run while that result loads, it does nothing:
 * the grid's strip offers Stop.
 */
export function loadIntoMemoryContribution({ commands, results, documents, menuTargets }: Pick<Workbench, 'commands' | 'results' | 'documents' | 'menuTargets'>): Disposable {
  const targetOf = (args?: CommandArgs) => {
    const target = outputOf(args) ?? (args?.tabId || args?.target ? undefined : focusedOutput(menuTargets))
    if (args?.target && !target) return undefined
    if (target) return target.view === 'grid' && target.entry !== undefined && results.canLoadIntoMemory(target.tabId, target.entry) ? { tabId: target.tabId, key: target.entry } : undefined
    const tabId = args?.tabId ?? documents.getSnapshot().activeId
    const focused = tabId ? results.focusedEntry(tabId) : undefined
    return tabId && focused && results.canLoadIntoMemory(tabId, focused.key) ? { tabId, key: focused.key } : undefined
  }
  return commands.register('output.loadIntoMemory', {
    when: (args?: CommandArgs) => !!targetOf(args),
    run: async (args?: CommandArgs) => {
      const target = targetOf(args)
      if (!target) return
      const refused = await results.loadIntoMemory(target.tabId, target.key)
      if (refused) results.announce(target.tabId, refused)
    }
  })
}

/**
 * Load Sample…: opens Load sample's dialog (docs/bigquery.md, Load a sample) for a windowed BigQuery result of a finished run,
 * the same target Load Result into Memory takes. Its grid's strip offers it too when the result is too large to load.
 */
export function loadSampleContribution({ commands, results, documents, menuTargets, sampleDialog }: Pick<Workbench, 'commands' | 'results' | 'documents' | 'menuTargets' | 'sampleDialog'>): Disposable {
  const targetOf = (args?: CommandArgs) => {
    const target = outputOf(args) ?? (args?.tabId || args?.target ? undefined : focusedOutput(menuTargets))
    if (args?.target && !target) return undefined
    if (target) return target.view === 'grid' && target.entry !== undefined && results.canLoadSample(target.tabId, target.entry) ? { tabId: target.tabId, key: target.entry } : undefined
    const tabId = args?.tabId ?? documents.getSnapshot().activeId
    const focused = tabId ? results.focusedEntry(tabId) : undefined
    return tabId && focused && results.canLoadSample(tabId, focused.key) ? { tabId, key: focused.key } : undefined
  }
  return commands.register('output.loadSample', {
    when: (args?: CommandArgs) => !!targetOf(args),
    run: (args?: CommandArgs) => {
      const target = targetOf(args)
      if (target) sampleDialog.open(target.tabId, target.key)
    }
  })
}
