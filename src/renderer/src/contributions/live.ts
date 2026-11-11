import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { liveGridOf, type LiveGridControls } from '../menus/targets'

/**
 * A live grid's context menu (liveGrid.context): each item acts on the grid the menu was opened for, at its active cell's
 * column (a right-click selects the cell first, as in a results grid). Without a menu target they do nothing: the grid
 * serves its own keys.
 */
export function liveGridContribution({ commands }: Pick<Workbench, 'commands'>): Disposable {
  const on = (run: (grid: LiveGridControls) => void, when?: (grid: LiveGridControls) => boolean) => ({
    when: (args?: CommandArgs) => { const grid = liveGridOf(args); return !!grid && (!when || when(grid)) },
    run: (args?: CommandArgs) => { const grid = liveGridOf(args); if (grid && (!when || when(grid))) run(grid) }
  })
  const column = (act: (grid: LiveGridControls, column: number) => void, when?: (grid: LiveGridControls, column: number) => boolean) => on(grid => {
    const at = grid.activeColumn()
    if (at !== undefined) act(grid, at)
  }, grid => { const at = grid.activeColumn(); return at !== undefined && (!when || when(grid, at)) })
  const registrations = [
    commands.register('liveGrid.copy', on(grid => grid.copy(false))),
    commands.register('liveGrid.copyWithHeaders', on(grid => grid.copy(true))),
    commands.register('liveGrid.selectAll', on(grid => grid.selectAll())),
    commands.register('liveGrid.sortAscending', column((grid, at) => grid.sort(at, false), grid => grid.sortable)),
    commands.register('liveGrid.sortDescending', column((grid, at) => grid.sort(at, true), grid => grid.sortable)),
    commands.register('liveGrid.clearSort', on(grid => grid.sort(undefined), grid => grid.sortable)),
    commands.register('liveGrid.filterColumnValues', column((grid, at) => grid.filterColumn(at), (grid, at) => grid.canFilter(at))),
    commands.register('liveGrid.fitColumn', column((grid, at) => grid.fitColumn(at))),
    commands.register('liveGrid.saveAs', on(grid => grid.save()))
  ]
  return { dispose: () => { for (const registration of registrations) registration.dispose() } }
}
