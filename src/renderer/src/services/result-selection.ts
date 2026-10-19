import type { Disposable } from '../core/types'
import type { ResultsService } from '../results/ResultsService'
import type { GridSelection } from '../grid/selection'

/**
 * The selected cells of each query's results grids, read and written through the grids' view state in ResultsService,
 * so the output menu and its commands act on the selection the grid shows. A new run and closing the query clear it
 * (ResultsService starts the tab's view state afresh); finishing a run keeps it. A selection belongs to one result set.
 */
export class ResultSelectionService implements Disposable {
  constructor(private readonly results: Pick<ResultsService, 'selection' | 'setSelection' | 'selectAll' | 'clearSelections' | 'viewState'>) {}
  /** The selection in result set `resultIndex`, or without one in the grid that last had focus. */
  get(tabId: string, resultIndex?: number): GridSelection | undefined {
    return this.results.selection(tabId, resultIndex ?? this.results.viewState(tabId).focusedIndex)
  }
  set(tabId: string, selection: GridSelection): void { this.results.setSelection(tabId, selection.resultIndex, selection) }
  selectAll(tabId: string, resultIndex: number): void { this.results.selectAll(tabId, resultIndex) }
  clear(tabId: string): void { this.results.clearSelections(tabId) }
  dispose(): void {}
}
