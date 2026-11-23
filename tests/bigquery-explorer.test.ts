import { describe, expect, it } from 'vitest'
import { bigQueryFieldPathMax, bigQueryFieldText, bigQueryPath, isBigQueryFieldPath, isBigQueryName, quoteBigQuery } from '../src/shared/bigquery/names'
import { bigQueryMaxColumnFacts, bigQueryMaxDefinition, bigQueryPreviewTargetSchema, bigQueryPropertiesLimits, bigQueryPropertiesRequestSchema, bigQueryPropertiesSchema, type BigQueryProperties, type BigQuerySchemaField } from '../src/shared/bigquery/objects'
import { decodeControl, encodeControl } from '../src/shared/ipc/wire/msgpack'
import { validateRequest, validateResult } from '../src/main/validation'
import { optionsAllow } from '../src/shared/ipc/methods'

// BigQuery's Object Explorer names and requests (docs/bigquery.md, Object Explorer); BqNames (C#) checks the same rules again.
const hostile = ['a`b', 'a\\b', 'a.b', 'a\nb', 'a;b', 'a"b', '']
const uuid = '9b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e'

describe('BigQuery names', () => {
  it('keeps each kind to its rule and refuses what could leave a quoted identifier', () => {
    expect(isBigQueryName('project', 'varia-alpha')).toBe(true)
    expect(isBigQueryName('project', 'example.com:varia-alpha')).toBe(true)
    expect(isBigQueryName('project', 'Varia_Alpha')).toBe(false)
    expect(isBigQueryName('dataset', 'sales_2024')).toBe(true)
    expect(isBigQueryName('dataset', 'sales-2024')).toBe(false)
    expect(isBigQueryName('table', 'Ünïcode table-1')).toBe(true)
    expect(isBigQueryName('column', "a&b%c=d+e:f'g<h>i#j|k")).toBe(true)
    for (const kind of ['dataset', 'table', 'routine', 'model', 'column'] as const)
      for (const name of hostile) expect(isBigQueryName(kind, name), `${kind} ${JSON.stringify(name)}`).toBe(false)
  })

  it('bounds lengths, a table in UTF-8 bytes', () => {
    expect(isBigQueryName('table', 'a'.repeat(1024))).toBe(true)
    expect(isBigQueryName('table', 'é'.repeat(513))).toBe(false)
    expect(isBigQueryName('routine', 'a'.repeat(257))).toBe(false)
    expect(isBigQueryName('column', 'a'.repeat(301))).toBe(false)
    expect(bigQueryFieldPathMax).toBe(15 * 300 + 14)
    expect(isBigQueryFieldPath(Array(15).fill('a').join('.'))).toBe(true)
    expect(isBigQueryFieldPath(Array(16).fill('a').join('.'))).toBe(false)
    expect(isBigQueryFieldPath('a..b')).toBe(false)
  })

  it('quotes paths and field paths with backticks, escaping as GoogleSQL reads them', () => {
    expect(quoteBigQuery('a`b\\c')).toBe('`a\\`b\\\\c`')
    expect(bigQueryPath('varia-alpha', 'sales', 'my table')).toBe('`varia-alpha.sales.my table`')
    expect(bigQueryFieldText('address.geo.lat')).toBe('`address`.`geo`.`lat`')
  })
})

describe('BigQuery Object Explorer requests', () => {
  it('validates Preview Rows targets and refuses them for SQL Server', () => {
    expect(bigQueryPreviewTargetSchema.safeParse({ project: 'varia-alpha', dataset: 'sales', table: 'orders' }).success).toBe(true)
    expect(bigQueryPreviewTargetSchema.safeParse({ project: 'varia-alpha', dataset: 'sales', table: 'or`ders' }).success).toBe(false)
    expect(bigQueryPreviewTargetSchema.safeParse({ project: 'varia-alpha', dataset: 'sales', table: 'orders', extra: 1 }).success).toBe(false)
    const preview = { project: 'varia-alpha', dataset: 'sales', table: 'orders' }
    expect(optionsAllow('query.execute', 'bigquery', { preview })).toBe(true)
    expect(optionsAllow('query.execute', 'sqlserver', { preview })).toBe(false)
  })

  it('validates bigquery.properties for table-like kinds and routines, and bounds its answer', () => {
    const request = { connectionId: uuid, requestId: uuid, kind: 'bqView', project: 'varia-alpha', dataset: 'sales', name: 'daily' }
    expect(() => validateRequest('bigquery.properties', request)).not.toThrow()
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, kind: 'bqRoutine', name: 'to_cents' }).success).toBe(true)
    // A routine name is checked by the routine rule (letters, digits and underscores), a table name by the table rule.
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, kind: 'bqRoutine', name: 'daily view' }).success).toBe(false)
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, name: 'daily view' }).success).toBe(true)
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, kind: 'bqModel' }).success).toBe(false)
    expect(bigQueryPropertiesRequestSchema.safeParse({ ...request, name: 'a\\b' }).success).toBe(false)
    const facts = { name: 'daily', type: 'view', elapsedMs: 3, groups: [{ title: 'Table', facts: [{ label: 'Type', value: 'view' }] }] }
    expect(bigQueryPropertiesSchema.safeParse(facts).success).toBe(true)
    expect(bigQueryPropertiesSchema.safeParse({ ...facts, groups: [{ title: 'Table', facts: [{ label: 'Description', value: 'x'.repeat(2001) }] }] }).success).toBe(false)
    const detailed = { ...facts, definition: 'SELECT 1', columns: [{ name: 'day', type: 'DATE', description: 'The day.' }, { name: 'n', type: 'INT64' }] }
    expect(bigQueryPropertiesSchema.safeParse(detailed).success).toBe(true)
    expect(bigQueryPropertiesSchema.safeParse({ ...detailed, definition: 'x'.repeat(bigQueryMaxDefinition + 1) }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...detailed, columns: Array.from({ length: bigQueryMaxColumnFacts + 1 }, (_, i) => ({ name: 'c' + i, type: 'INT64' })) }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...detailed, columns: [{ name: 'day', type: 'DATE', description: 'x'.repeat(1025) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...detailed, columnsCut: false }).success).toBe(false)
  })

  it('accepts structured BigQuery properties through MessagePack and rejects over-limit or malformed payloads', () => {
    const nest = (levels: number): BigQuerySchemaField => {
      let node: BigQuerySchemaField = { name: `l${levels}`, type: 'INT64' }
      for (let i = levels - 1; i >= 1; i--) node = { name: `l${i}`, type: 'STRUCT', mode: 'REPEATED', fields: [node] }
      return node
    }
    const rich: BigQueryProperties = {
      name: 'orders',
      type: 'table',
      elapsedMs: 12,
      groups: [{ title: 'Table', facts: [{ label: 'Type', value: 'table' }] }],
      fullName: 'varia-alpha.sales.orders',
      location: 'US',
      description: 'Orders placed online.',
      createdUtc: '2023-11-14 22:13:20 UTC',
      modifiedUtc: '2023-11-15 22:13:20 UTC',
      storage: { rows: 1_234_567, logicalBytes: Number.MAX_SAFE_INTEGER, longTermLogicalBytes: 0, physicalBytes: 1_073_741_824 },
      layout: { partitioning: 'DAY on placed', requirePartitionFilter: true, clustering: ['customer', 'region'] },
      columns: [{ name: 'id', type: 'INT64', description: 'Primary identifier' }],
      schema: [
        { name: 'id', type: 'INT64', mode: 'REQUIRED', description: 'Primary identifier' },
        nest(bigQueryPropertiesLimits.schemaDepth)
      ],
      schemaTruncated: false,
      labels: [{ key: 'env', value: 'prod' }, { key: 'empty_ok', value: '' }],
      definition: 'SELECT 1',
      definitionTruncated: false
    }
    expect(bigQueryPropertiesSchema.safeParse(rich).success).toBe(true)
    // A 7-level nested schema tree inside { result } must round-trip within protocol v2's 16-container depth limit.
    const decoded = decodeControl(encodeControl({ result: rich })) as { result: unknown }
    expect(validateResult('bigquery.properties', decoded.result)).toEqual(rich)

    // Depth over schemaDepth (7), even with an empty fields array on level 7, is rejected.
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [nest(bigQueryPropertiesLimits.schemaDepth + 1)] }).success).toBe(false)
    let level7EmptyFields: BigQuerySchemaField = { name: 'l7', type: 'STRUCT', fields: [] }
    for (let i = 6; i >= 1; i--) level7EmptyFields = { name: `l${i}`, type: 'STRUCT', fields: [level7EmptyFields] }
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [level7EmptyFields] }).success).toBe(false)

    // Total field count over 10,000 is rejected both flat and nested.
    const flatTooMany = Array.from({ length: bigQueryPropertiesLimits.schemaFields + 1 }, (_, i) => ({ name: `c${i}`, type: 'STRING' }))
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: flatTooMany }).success).toBe(false)
    const nestedTooMany = Array.from({ length: 100 }, (_, i) => ({
      name: `s${i}`, type: 'STRUCT',
      fields: Array.from({ length: 100 }, (_, j) => ({ name: `f${j}`, type: 'INT64' }))
    }))
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: nestedTooMany }).success).toBe(false)

    // String length, array length, storage count and strictness bounds.
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: '', type: 'STRING' }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a'.repeat(301), type: 'STRING' }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a', type: 'T'.repeat(65) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a', type: 'STRING', mode: 'M'.repeat(33) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a', type: 'STRING', description: 'd'.repeat(2001) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: Array.from({ length: 65 }, (_, i) => ({ key: `k${i}`, value: 'v' })) }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: [{ key: '', value: 'v' }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: [{ key: 'k'.repeat(129), value: 'v' }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: [{ key: 'k', value: 'v'.repeat(257) }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, layout: { clustering: Array.from({ length: 17 }, (_, i) => `c${i}`) } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, storage: { rows: -1 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, storage: { logicalBytes: 1.5 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, storage: { physicalBytes: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, definition: 'x'.repeat(bigQueryPropertiesLimits.definitionChars + 1) }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, unknown: true }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, storage: { rows: 1, extra: 2 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, layout: { requirePartitionFilter: true, extra: 2 } }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, labels: [{ key: 'a', value: 'b', extra: 1 }] }).success).toBe(false)
    expect(bigQueryPropertiesSchema.safeParse({ ...rich, schema: [{ name: 'a', type: 'STRING', extra: 1 }] }).success).toBe(false)
  })
})
