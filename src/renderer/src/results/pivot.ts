// The pivot's pure parts (results PR 7): which aggregates suit a column, the panel's draft and its request, and the strip a
// pivot grid shows. PivotService runs it; PivotPanel draws the draft.
import type { PivotAggregate, PivotValueSpec, ResultColumn } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { PivotSpec } from './ResultClient'
import { formatCount, plural } from './status'

/** The aggregates in the panel's order, with their names (as a spreadsheet's value field settings name them). */
export const pivotAggregates: readonly { readonly aggregate: PivotAggregate; readonly label: string }[] = [
  { aggregate: 'count', label: 'Count' },
  { aggregate: 'countDistinct', label: 'Distinct Count' },
  { aggregate: 'sum', label: 'Sum' },
  { aggregate: 'avg', label: 'Average' },
  { aggregate: 'min', label: 'Min' },
  { aggregate: 'max', label: 'Max' }
]

const typeName = (column: ResultColumn) => column.dataType.split('(')[0].trim().toLowerCase()
const numericTypes = new Set(['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'money', 'smallmoney', 'real', 'float'])

/** Whether SUM and AVG take a column: exact and approximate numerics, not bit (ResultPivoter.IsNumeric in C#). */
export function isNumericColumn(column: ResultColumn): boolean {
  return column.wire === 'text' && numericTypes.has(typeName(column))
}

/** Whether a value of `aggregate` may use `column` (undefined: the rows, which only Count counts). */
export function aggregateFits(aggregate: PivotAggregate, column: ResultColumn | undefined): boolean {
  if (!column) return aggregate === 'count'
  return aggregate === 'sum' || aggregate === 'avg' ? isNumericColumn(column) : true
}

/** A value's name, as the pivot's columns name it (PivotOutput.Label in C#). */
export function valueLabel(value: PivotValueSpec, columns: readonly ResultColumn[]): string {
  const name = value.column === undefined ? '' : columns[value.column]?.name || '(No column name)'
  if (value.column === undefined) return 'Count of rows'
  const label = pivotAggregates.find(item => item.aggregate === value.aggregate)?.label ?? value.aggregate
  return `${label} of ${name}`
}

/** The panel's draft: what the next pivot groups by and computes. */
export interface PivotDraft { readonly rows: readonly number[]; readonly column?: number; readonly values: readonly PivotValueSpec[] }
export const emptyDraft: PivotDraft = { rows: [], values: [{ aggregate: 'count' }] }

/** Columns a pivot may use: every column but a diff's tone. */
export function pivotColumns(columns: readonly ResultColumn[]): number[] {
  return columns.flatMap((column, index) => column.role === 'tone' ? [] : [index])
}

/** The draft kept to what `columns` allows: columns that exist and are not hidden, distinct row columns, a column group that
 *  is not one of them, and values whose aggregates fit their columns (one that no longer fits becomes Count). */
export function fitDraft(draft: PivotDraft, columns: readonly ResultColumn[]): PivotDraft {
  const usable = new Set(pivotColumns(columns))
  const rows = [...new Set(draft.rows.filter(column => usable.has(column)))].slice(0, wire.pivot.maxRowFields)
  const column = draft.column !== undefined && usable.has(draft.column) && !rows.includes(draft.column) ? draft.column : undefined
  const values = draft.values.slice(0, wire.pivot.maxValues).map(value => {
    if (value.column === undefined || !usable.has(value.column)) return { aggregate: 'count' as const }
    return aggregateFits(value.aggregate, columns[value.column]) ? { aggregate: value.aggregate, column: value.column } : { aggregate: 'count' as const, column: value.column }
  })
  return { rows, ...(column === undefined ? {} : { column }), values: values.length ? values : emptyDraft.values }
}

/** The draft's columns moved to where `to` has them by name, for a draft made against `from` (a re-run whose query now
 *  returns its columns in another order, or another set): a column `to` lacks drops out when the draft is fitted. */
export function remapDraft(draft: PivotDraft, from: readonly ResultColumn[], to: readonly ResultColumn[]): PivotDraft {
  // A name several columns share (SELECT a.Id, b.Id) maps by its place among them: the second Id to the second Id.
  const move = (index: number): number => {
    const name = from[index]?.name
    if (name === undefined || to[index]?.name === name) return index
    let nth = 0
    for (let i = 0; i < index; i++) if (from[i].name === name) nth++
    for (let i = 0; i < to.length; i++) if (to[i].name === name && nth-- === 0) return i
    return -1
  }
  return {
    rows: draft.rows.map(move),
    ...(draft.column === undefined ? {} : { column: move(draft.column) }),
    values: draft.values.map(value => value.column === undefined ? value : { ...value, column: move(value.column) })
  }
}

/** The most column groups a pivot with `rows` row columns and `values` values can have: 256, fewer when they would pass a
 *  page's 4,096 columns (ResultPivoter.ColumnGroupLimit in C#). */
export function columnGroupLimit(rows: number, values: number): number {
  return Math.min(wire.pivot.maxColumnGroups, Math.floor((wire.page.maxColumns - rows) / Math.max(values, 1)) - 1)
}

/** The panel's count of the rows a pivot reads: the grid's view's when it shows one (its filters apply), else all stored. */
export function pivotFacts(rowsStored: number, viewRows: number | undefined): string {
  const rows = viewRows ?? rowsStored
  return `${formatCount(rows)} ${plural(rows, 'row')}${viewRows === undefined ? '' : ' as sorted and filtered'}`
}

/** The request a draft makes. */
export function draftSpec(draft: PivotDraft): PivotSpec {
  return { rows: [...draft.rows], ...(draft.column === undefined ? {} : { column: draft.column }), values: draft.values.map(value => ({ ...value })) }
}

/** What a pivot grid's strip says about it. */
export interface PivotInfo {
  /** The pivoted entry's key (ResultsService). */
  readonly source: string
  /** The pivoted set's name, as its caption shows it ("Result 2", "Pivot of Result 1"). */
  readonly sourceLabel: string
  /** The grid's sort or filters applied (the pivot read its view). */
  readonly viewed: boolean
  readonly rows: number
  readonly rowGroups: number
  readonly columnGroups: number
  readonly approximate: boolean
}

/** A pivot grid's strip: what was pivoted, then what its highlights say, if anything. */
export function pivotStrip(info: PivotInfo, highlight: string | undefined): string {
  return highlight ? `${pivotText(info)} ${highlight}` : pivotText(info)
}

/** The strip: what was pivoted, how many groups, and whether long values were grouped by a prefix. */
export function pivotText(info: PivotInfo): string {
  const groups = info.columnGroups > 0
    ? `${formatCount(info.rowGroups)} ${plural(info.rowGroups, 'row group')} × ${formatCount(info.columnGroups)} ${plural(info.columnGroups, 'column group')}`
    : `${formatCount(info.rowGroups)} ${plural(info.rowGroups, 'row group')}`
  const parts = [`Pivot of ${info.sourceLabel}${info.viewed ? ' (as sorted and filtered)' : ''}: ${formatCount(info.rows)} ${plural(info.rows, 'row')} in ${groups}.`]
  if (info.approximate) parts.push('Long values were grouped by the part these results keep.')
  return parts.join(' ')
}
