import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { windows } from '../core/windows'
import { focusResultGrid } from '../grid/ResultGrid'
import { outputOf } from '../menus/targets'
import { compareSources, fallbackText, type CompareChange } from '../results/CompareService'
import { slotOf } from '../results/ResultsService'
import { focusedOutput } from './output'

/**
 * Compare… (the picker) and Compare with Previous Result with its Exact Text form (CompareService): the menu's grid, else
 * the focused one. Compare… opens the picker on that Table while another group's Table of the run shares a column with it;
 * Compare with Previous compares it at once with the nearest earlier one. Tables of rows that have every row only: never a
 * Pivot, a comparison, a plan set or a Peek grid. The picker is a popover beside what opened it: the toolbar's Compare
 * button (which passes itself as `anchor`), else the grid it opens on.
 */
export function compareContribution({ commands, compare, results, documents, menuTargets, panes }: Pick<Workbench, 'commands' | 'compare' | 'results' | 'documents' | 'menuTargets' | 'panes'>): Disposable {
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
  // The popover is drawn in the Results panel, so it is offered only while that panel shows: opened unseen, it would wait
  // there and take the focus when the panel came back.
  const pickerOf = (args?: CommandArgs) => { const target = panes.getSnapshot().results ? gridOf(args) : undefined; return target && compare.canPick(target.tabId, target.key) ? target : undefined }
  /** The grid's comparison, with its state (its change in flight's, while one runs). */
  const comparisonOf = (args?: CommandArgs) => {
    const target = gridOf(args), slot = target ? slotOf(results.getSnapshot()[target.tabId], target.key) : undefined
    const state = target && slot?.view === 'comparison' ? compare.stateOf(target.tabId, slot.entry) : undefined
    return target && slot && state ? { ...target, slot, state } : undefined
  }
  const closedOf = (args?: CommandArgs) => { const target = comparisonOf(args); return target ? compare.closedReason(target.tabId, target.key) : undefined }
  // A change runs the comparison again: never while one of its inputs is closed (D10, which `unavailable` says).
  const changeable = (args?: CommandArgs) => { const target = comparisonOf(args); return target && compare.closedReason(target.tabId, target.key) === undefined ? target : undefined }
  const change = (of: (state: NonNullable<ReturnType<typeof comparisonOf>>['state']) => CompareChange) => ({
    when: (args?: CommandArgs) => !!changeable(args),
    unavailable: (args?: CommandArgs) => closedOf(args),
    run: async (args?: CommandArgs) => {
      const target = changeable(args)
      if (!target) return
      const outcome = await compare.replace(target.tabId, target.key, of(target.state))
      if (outcome && 'key' in outcome && outcome.key !== target.key) results.focusEntry(target.tabId, outcome.key)
    }
  })
  const goTo = (side: 0 | 1) => {
    const inputOf = (args?: CommandArgs) => { const target = comparisonOf(args); const entry = target ? compareSources(results.getSnapshot()[target.tabId], target.slot.sources)[side]?.entry : undefined; return target && entry !== undefined ? { tabId: target.tabId, key: entry } : undefined }
    return {
      when: (args?: CommandArgs) => !!inputOf(args),
      unavailable: (args?: CommandArgs) => { const target = comparisonOf(args); const source = target ? compareSources(results.getSnapshot()[target.tabId], target.slot.sources)[side] : undefined; return source && source.entry === undefined ? `${source.name} is closed` : undefined },
      run: (args?: CommandArgs) => {
        const input = inputOf(args)
        if (!input) return
        results.focusEntry(input.tabId, input.key)
        results.setView(input.tabId, 'results')
        if (typeof document !== 'undefined') focusResultGrid(windows.activeElement()?.ownerDocument ?? document, input.tabId, input.key)
      }
    }
  }
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
        results.focusEntry(target.tabId, target.key)
        compare.open(target.tabId, target.key, args?.anchor ? 'toolbar' : 'grid')
        results.setView(target.tabId, 'results')
      }
    }),
    // The focused comparison's toolbar controls, for More results tools and the palette (a narrow pane folds them there).
    commands.register('output.compareMatch', {
      // Drawn in the Results panel, it is offered only while that panel shows (as Compare is).
      when: args => panes.getSnapshot().results && !!changeable(args),
      unavailable: args => closedOf(args),
      run: args => {
        const target = panes.getSnapshot().results ? changeable(args) : undefined
        if (!target) return
        results.setView(target.tabId, 'results')
        compare.openMatchMenu(target.tabId, target.key, 'more')
      }
    }),
    commands.register('output.compareChangesOnly', change(state => ({ context: state.context === 0 ? -1 : 0 }))),
    commands.register('output.compareOneRow', {
      ...change(state => ({ layout: state.layout === 'entry' ? 'unified' : 'entry' })),
      when: args => { const target = changeable(args); return !!target && !(target.state.fallback && target.state.layout === 'unified') },
      unavailable: args => closedOf(args) ?? (comparisonOf(args)?.state.fallback ? fallbackText : undefined)
    }),
    commands.register('output.compareExactText', change(state => ({ exact: !state.exact }))),
    commands.register('output.compareSwapSides', change(() => ({ swap: true }))),
    commands.register('output.compareGoToOld', goTo(0)),
    commands.register('output.compareGoToNew', goTo(1))
  ]
  return { dispose: () => { for (const registration of registrations) registration.dispose() } }
}
