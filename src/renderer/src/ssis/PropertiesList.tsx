import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { typeScale } from '../../../shared/theme/metrics'
import { nextFrame } from '../core/frame'

/**
 * A list's column. `width` is in characters; a column without one is wide and shares what is left (values,
 * descriptions). `masked` marks the rows whose value is a sensitive one the catalog never returns.
 */
export interface ListColumn<T> { readonly title: string; readonly value: (row: T) => string; readonly width?: number; readonly masked?: (row: T) => boolean }
/** The rows [start, end) a list draws. */
export interface ListWindow { readonly start: number; readonly end: number }

/** What an empty value and a sensitive one say to a screen reader, where the page draws a dash and stars. */
export const noneLabel = 'None'
export const maskedLabel = 'Sensitive value, not shown'
/** What a sensitive parameter or variable shows: the catalog never returns its value, and Varia never reads it. */
export const sensitiveMask = '********'

/** Rows drawn before the first measure, beyond those in view, and the block the window snaps to. */
export const listLimits = { initialRows: 64, overscan: 24, block: 32, wideMin: 20 } as const
// One row's height before a row has been measured: a line of sm text, 3 px padding above and below, and one collapsed
// 1 px border (styles.css, .object-dialog-grid). Each measure replaces it, and later lists start from the measured one.
let pitchEstimate = typeScale.sm.line + 7

/**
 * The rows a list draws: those in its scroller's view and `overscan` more on each side, snapped outward to blocks, so
 * scrolling draws again only every `block` rows. `top` is where the list's first row would be, relative to the top of
 * the scroller's view (negative once scrolled past), and `viewport` the view's height, both in px.
 */
export function listWindow(count: number, pitch: number, top: number, viewport: number): ListWindow {
  if (count <= 0 || !(pitch > 0) || !Number.isFinite(top) || !Number.isFinite(viewport)) return { start: 0, end: Math.min(count, listLimits.initialRows) }
  const { overscan, block } = listLimits
  const first = Math.floor(-top / pitch) - overscan, last = Math.ceil((viewport - top) / pitch) + overscan
  const start = Math.min(count, Math.max(0, Math.floor(first / block) * block))
  return { start, end: Math.min(count, Math.max(start, Math.ceil(last / block) * block)) }
}

/** A value as a cell shows it: a dash for an empty one and stars for a sensitive one, each named for screen readers. */
export function listValue(value: string, masked = false): ReactNode {
  if (masked) return <><span aria-hidden="true">{sensitiveMask}</span><span className="visually-hidden">{maskedLabel}</span></>
  if (value === '') return <span className="ssis-properties-none"><span aria-hidden="true">—</span><span className="visually-hidden">{noneLabel}</span></span>
  return value
}

/**
 * The nearest ancestor that scrolls vertically: the document frame's column of sections. The list's own box scrolls only
 * sideways, but its overflow-x makes its overflow-y compute to auto as well, so the search starts above it.
 */
function scroller(table: HTMLElement): HTMLElement | undefined {
  for (let parent = table.parentElement?.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return parent
  }
  return undefined
}

interface Props<T> { readonly label: string; readonly rows: readonly T[]; readonly columns: readonly ListColumn<T>[]; readonly rowKey: (row: T, index: number) => string; readonly text: (value: string) => string }

/**
 * A read-only list of up to ssisLimits.rows rows held in the renderer (a project's packages, parameters and references,
 * an environment's variables). It is not GridView, which views the results worker's pages: it is a table that draws only
 * the rows near its scroller's view, with spacers for the rest, so a list at the cap costs what one screen of rows costs
 * however often its tab is shown again. Rows are one line high (a long value is cut; its tooltip has it whole), so every
 * row has the same height and the spacers keep the column's scroll height exact. Screen readers hear the whole list's
 * size from aria-rowcount and each row's place from aria-rowindex.
 */
export default function PropertiesList<T>({ label, rows, columns, rowKey, text }: Props<T>) {
  const table = useRef<HTMLTableElement>(null)
  const [view, setView] = useState(() => ({ pitch: pitchEstimate, ...listWindow(rows.length, pitchEstimate, 0, Number.NaN) }))
  const count = rows.length
  useLayoutEffect(() => {
    const element = table.current, column = element && scroller(element)
    if (!element || !column) return
    let cancel: (() => void) | undefined
    // Reads the drawn rows' pitch and where the list sits in the view, then draws the rows near it.
    const measure = () => {
      cancel = undefined
      const body = element.tBodies[0]
      if (!body) return
      const drawn = body.querySelectorAll<HTMLElement>('tr[aria-rowindex]')
      const measured = drawn.length > 1 ? (drawn[drawn.length - 1].getBoundingClientRect().top - drawn[0].getBoundingClientRect().top) / (drawn.length - 1) : drawn[0]?.getBoundingClientRect().height ?? 0
      if (measured > 0) pitchEstimate = measured
      const pitch = measured > 0 ? measured : pitchEstimate
      const next = listWindow(count, pitch, body.getBoundingClientRect().top - column.getBoundingClientRect().top - column.clientTop, column.clientHeight)
      setView(current => next.start === current.start && next.end === current.end && Math.abs(pitch - current.pitch) < 0.01 ? current : { pitch, ...next })
    }
    const schedule = () => { cancel ??= nextFrame(measure) }
    measure()
    column.addEventListener('scroll', schedule, { passive: true })
    const resized = new ResizeObserver(schedule)
    resized.observe(column)
    return () => { cancel?.(); column.removeEventListener('scroll', schedule); resized.disconnect() }
  }, [count])
  const { start, end, pitch } = view
  const minWidth = columns.reduce((sum, column) => sum + (column.width ?? listLimits.wideMin), 0)
  const spacer = (rows: number) => <tr className="ssis-properties-spacer" aria-hidden="true"><td colSpan={columns.length} style={{ height: rows * pitch }} /></tr>
  return <div className="ssis-properties-table">
    <table ref={table} className="object-dialog-grid" aria-label={label} aria-rowcount={count + 1} style={{ minWidth: `${minWidth}ch` }}>
      <colgroup>{columns.map(column => <col key={column.title} style={column.width === undefined ? undefined : { width: `${column.width}ch` }} />)}</colgroup>
      <thead><tr aria-rowindex={1}>{columns.map(column => <th key={column.title} scope="col">{column.title}</th>)}</tr></thead>
      <tbody>
        {start > 0 && spacer(start)}
        {rows.slice(start, end).map((row, offset) => <tr key={rowKey(row, start + offset)} aria-rowindex={start + offset + 2}>{columns.map(column => {
          const value = column.value(row), masked = column.masked?.(row) ?? false
          return <td key={column.title} title={masked ? maskedLabel : value}><bdi>{listValue(masked ? '' : text(value), masked)}</bdi></td>
        })}</tr>)}
        {end < count && spacer(count - end)}
      </tbody>
    </table>
  </div>
}
