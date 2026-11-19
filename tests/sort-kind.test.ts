import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResultColumn } from '../src/shared/contracts'
import { backendDescriptorSchema } from '../src/shared/ipc/descriptors'
import { sortKindOf, sortKinds, sqlServerSortKind } from '../src/shared/results/sort-kind'
import { isNumericColumn } from '../src/renderer/src/results/pivot'
import { trackedColumn } from '../src/renderer/src/results/HighlightsService'
import { lengthSortable } from '../src/renderer/src/results/ResultsService'
import { sqlTypeLabel, typeHintChars } from '../src/renderer/src/grid/measure'

// The SQL Server mapping both copies of the factory follow (SortKindChecks.cs reads the same file), and parity: the
// renderer's classifications by sortKind give what their type-name lists gave, for every SQL Server type.
const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'sort-kinds', 'sql-server.json'), 'utf8')) as { types: [string, string][] }
const types = golden.types.map(([type]) => type)

const legacy = {
  typeName: (column: ResultColumn) => column.dataType.split('(')[0].trim().toLowerCase(),
  isNumeric(column: ResultColumn) {
    return column.wire === 'text' && new Set(['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'money', 'smallmoney', 'real', 'float']).has(legacy.typeName(column))
  },
  lengthSortable(column: ResultColumn) {
    if (column.wire === 'binary' || column.collation !== undefined || column.role === 'xml' || column.role === 'json') return true
    const cut = column.dataType.indexOf('(')
    return new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'sysname', 'xml', 'json']).has((cut < 0 ? column.dataType : column.dataType.slice(0, cut)).trim().toLowerCase())
  },
  trackedType(dataType: string) {
    const type = dataType.trim().toLowerCase(), base = type.replace(/\(.*$/, '').trim()
    return new Set(['char', 'varchar', 'nchar', 'nvarchar', 'decimal', 'numeric', 'binary', 'varbinary']).has(base) ? base : type
  }
}

const collation = { lcid: 1033, sortId: 0, codePage: 1252, utf8: false, options: 1 }
/** Every type in every shape a classification looks at, without sortKind (a fake's descriptor) and with the backend's. */
function columns(): ResultColumn[] {
  const all: ResultColumn[] = []
  for (const dataType of types)
    for (const wire of ['text', 'binary'] as const)
      for (const collated of [false, true])
        for (const role of [undefined, 'xml', 'json', 'udt'] as const)
          for (const sent of [false, true])
            all.push({ name: 'c', dataType, wire, nullable: true, ...role ? { role } : {}, ...collated ? { collation } : {}, ...sent ? { sortKind: sqlServerSortKind(dataType) } : {} })
  return all
}

describe('sortKind', () => {
  it('maps every SQL Server type as the backend does', () => {
    expect(golden.types.length).toBeGreaterThan(40)
    for (const [type, kind] of golden.types) expect([type, sqlServerSortKind(type)]).toEqual([type, kind])
    expect(new Set(golden.types.map(([, kind]) => kind))).toEqual(new Set(sortKinds))
  })

  it('reads a sent sortKind before the type name', () => {
    expect(sortKindOf({ dataType: 'INT64', sortKind: 'integer' })).toBe('integer')
    expect(sortKindOf({ dataType: 'INT64' })).toBe('other')
    expect(sortKindOf({ dataType: 'datetime2(7)' })).toBe('datetime')
  })

  it('is an optional descriptor field of the twelve kinds', () => {
    const descriptor = (column: object) => ({
      resultId: 1, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: [{ name: 'a', dataType: 'bit', wire: 'text', nullable: true, ...column }],
      rowsRead: 0, rowsStored: 0, rowsAvailable: 0, bytesStored: 0, truncatedCells: 0, state: 'open', incomplete: false
    })
    expect(backendDescriptorSchema.safeParse(descriptor({})).success).toBe(true)
    for (const sortKind of sortKinds) expect(backendDescriptorSchema.safeParse(descriptor({ sortKind })).success).toBe(true)
    expect(backendDescriptorSchema.safeParse(descriptor({ sortKind: 'guid' })).success).toBe(false)
  })

  it('leaves pivot, length sorts and grid sizing as they were for every SQL Server column', () => {
    for (const column of columns()) {
      expect([column, isNumericColumn(column)]).toEqual([column, legacy.isNumeric(column)])
      expect([column, lengthSortable(column)]).toEqual([column, legacy.lengthSortable(column)])
      const { sortKind: _, ...bare } = column
      expect(typeHintChars(column)).toBe(typeHintChars(bare))
      expect(sqlTypeLabel(column)).toBe(sqlTypeLabel(bare))
    }
  })

  it('leaves highlights matching the same columns across re-runs', () => {
    for (const before of types)
      for (const after of types)
        for (const sent of [false, true]) {
          const kind = (dataType: string) => sent ? { sortKind: sqlServerSortKind(dataType) } : {}
          const found = trackedColumn([{ name: 'x', dataType: after, wire: 'text', nullable: true, ...kind(after) }], { column: 'x', dataType: before, ordinal: 0, ...kind(before) })
          expect([before, after, found === 0]).toEqual([before, after, legacy.trackedType(before) === legacy.trackedType(after)])
        }
  })
})
