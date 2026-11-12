import type { Disposable } from '../core/types'
import type { EntryKey, ResultsService } from '../results/ResultsService'
import type { GridSelection } from '../grid/selection'

/**
 * The selected cells of each query's results grids, read and written through the grids' view state in ResultsService,
 * so the output menu and its commands act on the selection the grid shows. A new run and closing the query clear it
 * (ResultsService starts the tab's view state afresh); finishing a run keeps it. A selection belongs to one result set.
 */
export class ResultSelectionService implements Disposable {
  constructor(private readonly results: Pick<ResultsService, 'selection' | 'setSelection' | 'selectAll' | 'clearSelections' | 'focusedEntry'>) {}
  /** The selection in the result with the entry key, or without one in the grid that last had focus. */
  get(tabId: string, entry?: EntryKey): GridSelection | undefined {
    const key = entry ?? this.results.focusedEntry(tabId)?.key
    return key === undefined ? undefined : this.results.selection(tabId, key)
  }
  set(tabId: string, selection: GridSelection): void { this.results.setSelection(tabId, selection.entry, selection) }
  selectAll(tabId: string, entry: EntryKey): void { this.results.selectAll(tabId, entry) }
  clear(tabId: string): void { this.results.clearSelections(tabId) }
  dispose(): void {}
}
