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

/** The request a draft makes. */
export function draftSpec(draft: PivotDraft): PivotSpec {
  return { rows: [...draft.rows], ...(draft.column === undefined ? {} : { column: draft.column }), values: draft.values.map(value => ({ ...value })) }
}

/** What a pivot grid's strip says about it. */
export interface PivotInfo {
  /** The pivoted set's place in the run. */
  readonly source: number
  /** The grid's sort or filters applied (the pivot read its view). */
  readonly viewed: boolean
  readonly rows: number
  readonly rowGroups: number
  readonly rowGroupsShown: number
  readonly columnGroups: number
  readonly columnGroupsShown: number
  readonly approximate: boolean
}

/** The strip: what was pivoted, how many groups, which were left out, and whether long values were grouped by a prefix. */
export function pivotText(info: PivotInfo): string {
  const groups = info.columnGroups > 0
    ? `${formatCount(info.rowGroups)} ${plural(info.rowGroups, 'row group')} × ${formatCount(info.columnGroups)} ${plural(info.columnGroups, 'column group')}`
    : `${formatCount(info.rowGroups)} ${plural(info.rowGroups, 'row group')}`
  const parts = [`Pivot of Result ${info.source + 1}${info.viewed ? ' (as sorted and filtered)' : ''}: ${formatCount(info.rows)} ${plural(info.rows, 'row')} in ${groups}.`]
  if (info.columnGroupsShown < info.columnGroups) parts.push(`Only the first ${formatCount(info.columnGroupsShown)} column groups are shown; each Total still counts every row.`)
  if (info.rowGroupsShown < info.rowGroups) parts.push(`Only the first ${formatCount(info.rowGroupsShown)} row groups are shown.`)
  if (info.approximate) parts.push('Long values were grouped by the part these results keep.')
  return parts.join(' ')
}
