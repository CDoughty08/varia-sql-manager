// How a result column's values compare, engine-neutrally. The backend's ColumnTypes.SortKindOf sets `sortKind` on every
// descriptor column; this mirrors it for columns that arrive without one (descriptors built in tests and fakes, records
// from before the field), so the renderer classifies only through `sortKindOf`. tests/fixtures/sort-kinds/sql-server.json
// pins both copies.
import type { ResultColumn } from '../contracts'

export const sortKinds = ['integer', 'decimal', 'float', 'boolean', 'date', 'time', 'datetime', 'timestamp', 'binary', 'text', 'json', 'other'] as const
export type SortKind = typeof sortKinds[number]

const sqlServer: Readonly<Record<string, SortKind>> = {
  tinyint: 'integer', smallint: 'integer', int: 'integer', bigint: 'integer',
  decimal: 'decimal', numeric: 'decimal', money: 'decimal', smallmoney: 'decimal',
  real: 'float', float: 'float',
  bit: 'boolean',
  date: 'date',
  time: 'time',
  datetime: 'datetime', datetime2: 'datetime', smalldatetime: 'datetime',
  // The one instant with a zone. SQL Server's own timestamp type is rowversion, bytes.
  datetimeoffset: 'timestamp',
  binary: 'binary', varbinary: 'binary', image: 'binary', timestamp: 'binary', rowversion: 'binary',
  char: 'text', varchar: 'text', nchar: 'text', nvarchar: 'text', text: 'text', ntext: 'text', sysname: 'text',
  // Documents: sorted by their text and sized by length.
  xml: 'json', json: 'json'
}

/** A type name without its size or precision ("decimal(18,2)" is decimal), in lower case (ColumnTypes.BaseName). */
export function baseTypeName(dataType: string): string {
  const cut = dataType.indexOf('(')
  return (cut < 0 ? dataType : dataType.slice(0, cut)).trim().toLowerCase()
}

/** A SQL Server type's sort kind (ColumnTypes.SortKindOf): uniqueidentifier, sql_variant and CLR types are `other`. */
export function sqlServerSortKind(dataType: string): SortKind {
  const base = baseTypeName(dataType)
  return Object.hasOwn(sqlServer, base) ? sqlServer[base] : 'other'
}

/** A column's sort kind: the backend's, or the SQL Server mapping of its type when the descriptor has none. */
export function sortKindOf(column: Pick<ResultColumn, 'dataType' | 'sortKind'>): SortKind {
  return column.sortKind ?? sqlServerSortKind(column.dataType)
}
