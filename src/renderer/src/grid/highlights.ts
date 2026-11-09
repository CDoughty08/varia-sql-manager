import type { ResultHandle } from '../results/ResultClient'

/** The highlight colours, in menu order; a row's colour is 1 + its index here (0: none). Each is drawn by its theme key,
 *  resultsGrid.highlight{Name}Background, through the row class `hl-{name}`. */
export const highlightColors = ['yellow', 'green', 'blue', 'purple', 'red'] as const
export type HighlightColor = typeof highlightColors[number]

/**
 * A grid's highlighted rows in the order one handle shows them (a result's, or a sorted view's): `positions` ascend and
 * `colors[k]` is position k's colour (1-based). The grid finds a row's colour by binary search, so a frame costs
 * O(visible rows × log highlights) and nothing per row in React.
 */
export interface RowHighlights {
  readonly handle: ResultHandle
  readonly positions: Float64Array
  readonly colors: Uint8Array
}

/** Row `row`'s colour in `marks` (1-based), or 0. */
export function colorAt(marks: RowHighlights | undefined, row: number): number {
  if (!marks) return 0
  const positions = marks.positions
  let low = 0, high = positions.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1, value = positions[mid]
    if (value === row) return marks.colors[mid]
    if (value < row) low = mid + 1
    else high = mid - 1
  }
  return 0
}
