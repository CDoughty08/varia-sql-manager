// The PR6 results table, fed through the new path: the summary arrives with descriptors, then each set's rows are read
// as windows and materialised under today's display limits. PR7 replaces this with the virtualized grid.
import type { ApiResult, DisplayQueryResult, DisplayResultSet, QueryEvent, QueryOptions, QueryResult, VariaApi } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { ResultClient } from './ResultClient'
import { FLAG_NULL, FLAG_OVER_BUDGET, FLAG_TRUNCATED } from './worker-protocol'

/** Today's display limits for the results table. */
export const legacyLimits = { rows: 1000, resultSets: 10, cells: 100_000, characters: 4_000_000, cellCharacters: 16_384, planCharacters: 2_097_152 } as const
export const truncatedSuffix = '… [cell truncated]'
const displayLimitsNote = 'Results were truncated by display limits. Display limits do not stop script execution.'
type Results = Pick<ResultClient, 'open' | 'onQueryEvent' | 'applySummary' | 'release'>

/**
 * Runs a script and materialises its results as the old table expects them. `onProgress` receives the rows read so far
 * across the script's result sets. A read that fails keeps the rows already read and says so in Messages.
 */
export async function legacyExecute(api: Pick<VariaApi, 'execute'>, results: Results, options: QueryOptions, onProgress?: (rowsRead: number) => void): Promise<ApiResult<DisplayQueryResult>> {
  const rowsRead = new Map<number, number>()
  const subscription = results.onQueryEvent(options.queryId, (event: QueryEvent) => {
    if (event.type === 'progress') for (const item of event.results) rowsRead.set(item.resultId, item.rowsRead)
    else if (event.type === 'resultSet.opened' || event.type === 'resultSet.closed') rowsRead.set(event.descriptor.resultId, event.descriptor.rowsRead)
    else return
    let total = 0
    for (const value of rowsRead.values()) total += value
    onProgress?.(total)
  })
  let response: ApiResult<QueryResult>
  try { response = await api.execute({ ...options, maxRows: legacyLimits.rows, maxResultSets: legacyLimits.resultSets }) }
  finally { subscription.dispose() }
  if (!response.ok) return response
  const summary = response.value
  results.applySummary(summary)
  const messages = [...summary.messages]
  const resultSets: DisplayResultSet[] = []
  let cells = 0, characters = 0, budgetHit = false, failure: string | undefined
  for (const descriptor of summary.resultSets) {
    const rows: (string | null)[][] = []
    const width = descriptor.columns.length
    const maxCellChars = descriptor.kind === 'executionPlan' ? legacyLimits.planCharacters : legacyLimits.cellCharacters
    let setHit = false
    if (failure === undefined) {
      const handle = results.open(descriptor)
      try {
        for (let first = 0; first < descriptor.rowsAvailable;) {
          const fit = Math.min(descriptor.rowsAvailable - first, Math.floor((legacyLimits.cells - cells) / width), wire.worker.windowRows)
          if (fit <= 0 || characters >= legacyLimits.characters) { setHit = true; break }
          const window = await handle.getWindow(first, fit, { maxCellChars, textBudget: legacyLimits.characters - characters })
          if (window.count === 0) break
          for (let r = 0; r < window.count && !setHit; r++) {
            const row: (string | null)[] = []
            for (let c = 0; c < width; c++) {
              const flags = window.flags[r * width + c]
              if ((flags & FLAG_OVER_BUDGET) !== 0) { setHit = true; break }
              const text = window.text[r * width + c]
              row.push((flags & FLAG_NULL) !== 0 ? null : (flags & FLAG_TRUNCATED) !== 0 ? text + truncatedSuffix : text)
              characters += text.length
            }
            if (!setHit) { rows.push(row); cells += width }
          }
          first += window.count
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : 'The results could not be read.'
        setHit = true
      } finally { handle.dispose() }
    } else setHit = true
    budgetHit ||= setHit && failure === undefined
    resultSets.push({
      columns: descriptor.columns.map(column => ({ name: column.name, dataType: column.dataType })), rows,
      truncated: descriptor.truncated !== undefined || descriptor.truncatedCells > 0 || setHit, incomplete: descriptor.incomplete,
      batchNumber: descriptor.batchNumber, iteration: descriptor.iteration, kind: descriptor.kind
    })
  }
  // The table keeps its own copy, so the backend's memory is released at once.
  if (summary.resultSets.length > 0) await results.release(summary.resultSets).catch(() => {})
  if (budgetHit && !messages.includes(displayLimitsNote)) messages.push(displayLimitsNote)
  if (failure !== undefined) messages.push('Some rows could not be loaded: ' + failure)
  const { resultSets: _descriptors, budget: _budget, discardedResultSets: _discarded, ...rest } = summary
  return { ok: true, value: { ...rest, messages, resultSets } }
}
