// What a grid draws for search in results (results/search.ts): matched cells, the active match, and columns that match or
// are dimmed. GridView paints them as classes on its pooled cells and headers; the text stays a single nodeValue.
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { ResultHandle } from '../results/ResultClient'

/** Values mode: matched cells (`cellKey(row, column)`, rows of `handle`, the order the matches number) and the active one.
 *  Columns mode: each column matched (1) or not (0), and the active one. */
export interface GridMarks {
  readonly handle?: ResultHandle
  readonly cells?: ReadonlySet<number>
  readonly current?: { readonly row: number; readonly column: number }
  readonly columns?: Uint8Array
  readonly currentColumn?: number
}
const stride = wire.page.maxColumns
/** A cell's key in GridMarks.cells: rows below 2^31 and 4,096 columns stay inside safe integers. */
export const cellKey = (row: number, column: number): number => row * stride + column
