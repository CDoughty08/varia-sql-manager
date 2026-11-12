import type { CommandArgs, Disposable } from '../core/types'
import type { Workbench } from '../core/workbench'
import { columnTitle } from '../grid/selection'
import { outputOf } from '../menus/targets'
import { entryOf } from '../results/ResultsService'
import { focusedOutput } from './output'

/** The picker's row for "Row N" headers; a column's row has its index as id. */
const rowNumbers = 'rows'

/**
 * Transpose Results, Transpose Selected Rows, Transpose Using Column as Headers and Choose Headers: they set how a grid is
 * drawn (ResultsService.setOrientation) and store nothing. They act on the menu's grid, else the focused one, else (from
 * the results toolbar or the palette) the grid that last had the focus in the named or active query tab, when it can be
 * drawn transposed: a query's rows or a pivot, also while its rows still arrive. Selected Rows needs rows selected; Using
 * Column as Headers takes the menu's column, else the active cell's.
 */
export function transposeContribution({ commands, results, documents, menuTargets, quickInput }: Pick<Workbench, 'commands' | 'results' | 'documents' | 'menuTargets' | 'quickInput'>): Disposable {
  const targetOf = (args?: CommandArgs) => {
    const target = outputOf(args) ?? (args?.tabId || args?.target ? undefined : focusedOutput(menuTargets))
    if (args?.target && !target) return undefined
    const found = target ? target.view === 'grid' && target.entry !== undefined ? { tabId: target.tabId, key: target.entry, column: target.column } : undefined : (() => {
      const tabId = args?.tabId ?? documents.getSnapshot().activeId
      const focused = tabId ? results.focusedEntry(tabId) : undefined
      return tabId && focused ? { tabId, key: focused.key, column: undefined } : undefined
    })()
    const set = found && entryOf(results.getSnapshot()[found.tabId]?.sets, found.key)
    // A menu opened on a result the entry no longer shows acts on nothing.
    const current = !target?.result || (set?.descriptor.generation === target.result.generation && set.descriptor.resultId === target.result.resultId)
    return found && set && current && results.canTranspose(found.tabId, found.key) ? { ...found, set } : undefined
  }
  /** The column Using Column as Headers takes: the menu's, else the active cell's, when it is one of the result's own. */
  const headerOf = (target: NonNullable<ReturnType<typeof targetOf>>) => {
    const column = target.column ?? results.selection(target.tabId, target.key)?.active.column
    const columns = target.set.descriptor.columns
    return column !== undefined && Number.isInteger(column) && column >= 0 && column < columns.length && columns[column].role !== 'tone' ? column : undefined
  }
  const registrations = [
    commands.register('output.transpose', {
      when: (args?: CommandArgs) => !!targetOf(args),
      run: (args?: CommandArgs) => {
        const target = targetOf(args)
        if (target) results.setOrientation(target.tabId, target.key, { transposed: !results.orientation(target.tabId, target.key).transposed })
      }
    }),
    commands.register('output.transposeSelectedRows', {
      when: (args?: CommandArgs) => { const target = targetOf(args); return !!target && results.canKeepSelectedRows(target.tabId, target.key) },
      run: (args?: CommandArgs) => {
        const target = targetOf(args)
        if (!target) return
        const { tabId, key } = target
        // The grid turns once the view of the kept rows is built: turned at once, it would draw every row of the result (up
        // to the cap) for a moment. Only this command's own view turns it: one that fails says so and changes nothing, and
        // so does one another sort or filter replaced meanwhile. A grid already transposed stays as the user leaves it. More
        // rows than Keep Selected Rows takes says so and filters nothing.
        const turn = results.orientation(tabId, key).transposed ? undefined : () => { results.setOrientation(tabId, key, { transposed: true }) }
        results.keepSelectedRows(tabId, key, turn)
      }
    }),
    commands.register('output.transposeWithHeaders', {
      when: (args?: CommandArgs) => { const target = targetOf(args); return !!target && headerOf(target) !== undefined },
      run: (args?: CommandArgs) => {
        const target = targetOf(args), headerColumn = target && headerOf(target)
        if (target && headerColumn !== undefined) results.setOrientation(target.tabId, target.key, { transposed: true, headerColumn })
      }
    }),
    commands.register('output.transposeChooseHeaders', {
      when: (args?: CommandArgs) => !!targetOf(args),
      run: (args?: CommandArgs) => {
        const target = targetOf(args)
        if (!target) return
        const { tabId, key } = target, now = results.orientation(tabId, key)
        quickInput.show({
          ariaLabel: 'Using Column as Headers', placeholder: 'Select the column whose values head the transposed columns', noun: 'columns', sort: 'none',
          activeId: now.transposed && now.headerColumn !== undefined ? String(now.headerColumn) : rowNumbers,
          items: [
            { id: rowNumbers, label: 'Row number', description: 'Row 1, Row 2, …' },
            ...target.set.descriptor.columns.flatMap((column, index) => column.role === 'tone' ? [] : [{ id: String(index), label: columnTitle(column.name), description: column.dataType }])
          ],
          ...args?.anchor ? { anchor: args.anchor } : {},
          // The entry may have been closed, or the query run again, while the list was open: the service then refuses.
          onDidAccept: item => { results.setOrientation(tabId, key, { transposed: true, headerColumn: item.id === rowNumbers ? null : Number(item.id) }) }
        })
      }
    })
  ]
  return { dispose: () => { for (const registration of registrations) registration.dispose() } }
}
