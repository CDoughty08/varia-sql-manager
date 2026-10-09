import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent, type PointerEvent } from 'react'
import type { DisplayQueryResult, DisplayResultSet } from '../../shared/contracts'
import { chordFromEvent, type Platform } from '../../shared/commands/keybindings'
import { useWorkbench } from './core/WorkbenchContext'
import { columnTitle, describeRange, dragSelection, pressSelection, rangeOf, tooLargeToCopy, toTsv, type GridHit } from './grid/selection'

/** `hint` replaces the empty state's advice, for example when the query's connection was lost. `rowsRead` counts the
 *  rows a running script has read so far. */
interface Props { tabId: string; result?: DisplayQueryResult; error?: string; running: boolean; rowsRead?: number; connected: boolean; hint?: string }
type View = 'results' | 'messages'
const initialView = (result?: DisplayQueryResult, error?: string): View => error || result?.error || result?.resultSets.length === 0 ? 'messages' : 'results'
const selectAllChord = (platform: Platform) => platform === 'darwin' ? 'meta+a' : 'ctrl+a'
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Where a press landed: a cell carries its row and column, a row number its row, a header its column. */
function hitOf(target: EventTarget | null): GridHit | undefined {
  const cell = typeof (target as Partial<Element> | null)?.closest === 'function' ? (target as Element).closest<HTMLElement>('td, th') : null
  if (!cell) return undefined
  if (cell.dataset.corner !== undefined) return { kind: 'corner' }
  const row = cell.dataset.row === undefined ? undefined : Number(cell.dataset.row), column = cell.dataset.col === undefined ? undefined : Number(cell.dataset.col)
  if (row !== undefined && column !== undefined) return { kind: 'cell', row, column }
  if (row !== undefined) return { kind: 'row', row }
  return column === undefined ? undefined : { kind: 'column', column }
}

/** One result row; it re-renders only when its selected span or active cell changes. */
const GridRow = memo(function GridRow({ values, row, left, right, active }: { values: DisplayResultSet['rows'][number]; row: number; left: number; right: number; active: number }) {
  return <tr><td className="row-number" data-row={row}>{row + 1}</td>{values.map((value, column) => {
    const className = [column >= left && column <= right ? 'selected' : '', column === active ? 'active-cell' : ''].filter(Boolean).join(' ')
    return <td key={column} data-row={row} data-col={column} className={className || undefined} title={value === null ? 'NULL' : String(value)}>{value === null ? <span className="null-value">NULL</span> : String(value)}</td>
  })}</tr>
})

/**
 * A result set as SSMS shows it: press a cell, a row number, a column header, or the corner to select, Shift to extend,
 * and drag to grow the rectangle; Ctrl+A selects everything and Ctrl+C copies the selection as tab-separated text.
 */
function ResultGrid({ tabId, set, resultIndex }: { tabId: string; set: DisplayResultSet; resultIndex: number }) {
  const { resultSelection, platform, commands } = useWorkbench()
  const selection = useSyncExternalStore(resultSelection.subscribe, () => resultSelection.get(tabId, resultIndex))
  const rows = set.rows.length, columns = set.columns.length
  const range = selection ? rangeOf(selection, rows, columns) : undefined
  const active = selection && rows && columns ? { row: Math.min(Math.max(selection.focus.row, 0), rows - 1), column: Math.min(Math.max(selection.focus.column, 0), columns - 1) } : undefined
  const drag = useRef<{ hit?: GridHit; frame?: number } | null>(null)
  const [status, setStatus] = useState('')
  const summary = range ? describeRange(range) : ''
  useEffect(() => {
    if (!summary) return
    const timer = setTimeout(() => setStatus(summary), 300)
    return () => clearTimeout(timer)
  }, [summary])
  useEffect(() => () => { if (drag.current?.frame !== undefined) cancelAnimationFrame(drag.current.frame) }, [])

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return
    const hit = hitOf(event.target)
    if (!hit) return
    resultSelection.set(tabId, pressSelection(resultSelection.get(tabId), hit, { resultIndex, shift: event.shiftKey, right: event.button === 2, rows, columns }))
    drag.current = event.button === 0 && hit.kind !== 'corner' ? {} : null
  }
  // At most one selection update per frame while dragging over a wide result.
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    if (!(event.buttons & 1)) { drag.current = null; return }
    state.hit = hitOf(event.target) ?? state.hit
    if (state.frame !== undefined) return
    state.frame = requestAnimationFrame(() => {
      state.frame = undefined
      const current = resultSelection.get(tabId, resultIndex)
      if (current && state.hit && drag.current === state) resultSelection.set(tabId, dragSelection(current, state.hit))
    })
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (chordFromEvent(event.nativeEvent, platform) !== selectAllChord(platform)) return
    event.preventDefault()
    resultSelection.selectAll(tabId, resultIndex)
  }
  // Ctrl+C, and Edit › Copy through Electron's copy role, copy the selected cells rather than any page text.
  const copy = (event: ClipboardEvent<HTMLDivElement>) => {
    const current = resultSelection.get(tabId, resultIndex)
    if (!current) return
    let text: string
    try { text = toTsv(set, current, { headers: false, eol: platform === 'win32' ? '\r\n' : '\n' }) }
    catch (error) {
      if (!(error instanceof RangeError)) throw error
      event.preventDefault()
      commands.reportError(tooLargeToCopy)
      return
    }
    if (!text) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', text)
  }
  return <div className="grid-scroll" role="region" tabIndex={0} data-result-grid="" data-output-view="grid" data-tab-id={tabId} data-result-index={resultIndex}
    aria-label={`Result ${resultIndex + 1}, ${plural(rows, 'row')}, ${plural(columns, 'column')}`}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { drag.current = null }} onKeyDown={keyDown} onCopy={copy}>
    <table className="results-grid"><thead><tr><th className="row-number" data-corner="">#</th>{set.columns.map((column, position) => <th key={position} data-col={position}>{columnTitle(column.name)}<small>{column.dataType}</small></th>)}</tr></thead>
      <tbody>{set.rows.map((values, row) => {
        const selected = range && row >= range.top && row <= range.bottom
        return <GridRow key={row} values={values} row={row} left={selected ? range.left : -1} right={selected ? range.right : -2} active={active?.row === row ? active.column : -1} />
      })}</tbody></table>
    <div role="status" className="visually-hidden">{status}</div>
  </div>
}

function QueryOutput({ tabId, result, error, running, rowsRead, connected, hint }: Props) {
  const { platform } = useWorkbench()
  const [view, setView] = useState<View>(() => initialView(result, error))
  const [index, setIndex] = useState(0)
  // Reset while rendering (not in an effect) so a new result never paints with the previous selection first.
  const [shown, setShown] = useState({ tabId, result, error })
  if (shown.tabId !== tabId || shown.result !== result || shown.error !== error) {
    setShown({ tabId, result, error })
    setIndex(0)
    setView(initialView(result, error))
  }
  // Messages and the plan keep text selection; Ctrl+A selects only their text, not the whole window.
  const selectText = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (chordFromEvent(event.nativeEvent, platform) !== selectAllChord(platform)) return
    event.preventDefault()
    event.currentTarget.ownerDocument.getSelection()?.selectAllChildren(event.currentTarget)
  }, [platform])
  const failure = error ?? result?.error?.message
  const set = result?.resultSets[index]
  const status = result?.status ?? 'completed'
  const statusText = status === 'failed' ? 'Failed' : status === 'cancelled' ? 'Cancelled' : status === 'timedOut' ? 'Timed out' : 'Completed'
  const resultLabel = (position: number) => {
    const item = result!.resultSets[position]
    const name = item.kind === 'executionPlan' ? 'XML plan' : 'Result ' + (position + 1)
    return item.batchNumber ? name + ' · Batch ' + item.batchNumber + (item.iteration && item.iteration > 1 ? ' / repeat ' + item.iteration : '') : name
  }
  return <section className="output-panel" aria-label="Query output">
    <div className="output-toolbar">
      <div>
        <button className={view === 'results' ? 'active' : ''} onClick={() => setView('results')}>Results{result && <span>{result.resultSets.length}</span>}</button>
        <button className={view === 'messages' ? 'active' : ''} onClick={() => setView('messages')}>Messages{failure ? <span className="error-count">!</span> : !!result?.messages.length && <span>{result.messages.length}</span>}</button>
      </div>
      {result && <small>{statusText} · {result.elapsedMs} ms · {result.resultSets.reduce((sum, item) => sum + item.rows.length, 0)} rows{result.totalBatches > 1 ? ' · ' + result.completedBatches + '/' + result.totalBatches + ' batches' : ''}</small>}
    </div>
    {view === 'messages' && (result || failure) ? <div className="messages" role="region" tabIndex={0} data-output-view="messages" data-tab-id={tabId} data-result-index={0} aria-label="Messages" onKeyDown={selectText}>
      {!!result?.messages.length && <pre>{result.messages.join('\n')}</pre>}
      {failure && <pre role="alert" className="query-error">{result?.error?.batchNumber ? 'Batch ' + result.error.batchNumber + ', repetition ' + result.error.iteration + '\n' : ''}{failure}</pre>}
      {result && <pre>{!result.messages.length && !failure ? 'Command completed successfully.\n' : ''}{result.recordsAffected >= 0 ? result.recordsAffected + ' total rows affected.\n' : ''}{statusText} in {result.elapsedMs} ms.</pre>}
    </div> : view === 'results' && result ? <>
      {result.resultSets.length > 1 && <div className="result-selector">{result.resultSets.map((_, position) => <button key={position} className={index === position ? 'active' : ''} onClick={() => setIndex(position)}>{resultLabel(position)}</button>)}</div>}
      {set ? <>
        {set.kind === 'executionPlan' ? <div className="plan-output" role="region" tabIndex={0} data-output-view="plan" data-tab-id={tabId} data-result-index={index} aria-label="XML plan" onKeyDown={selectText}><pre className="plan-xml">{set.rows.map(row => String(row[0] ?? '')).join('\n')}</pre></div>
          : <ResultGrid key={`${tabId}:${index}`} tabId={tabId} set={set} resultIndex={index} />}
        {set.truncated && <div className="truncation">Output truncated by display limits. See Messages.</div>}
        {set.incomplete && <div className="truncation">This result is incomplete because an error, cancellation, or timeout stopped it. See Messages.</div>}
      </> : <div className="output-empty">{statusText}.{result.recordsAffected >= 0 ? ' ' + result.recordsAffected + ' rows affected.' : ''}</div>}
    </> : <div className="output-empty"><strong>{running ? 'Your query is running…' + (rowsRead === undefined ? '' : ' ' + rowsRead.toLocaleString('en-US') + (rowsRead === 1 ? ' row' : ' rows')) : 'Query results'}</strong><p>{hint ?? (connected ? 'Execute a query to view results and messages.' : 'Connect this query to a server to execute it.')}</p></div>}
  </section>
}

export default memo(QueryOutput)
