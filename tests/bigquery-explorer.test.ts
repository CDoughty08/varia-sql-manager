import { describe, expect, it } from 'vitest'
import { bigQueryFieldPathMax, bigQueryFieldText, bigQueryPath, isBigQueryFieldPath, isBigQueryName, quoteBigQuery } from '../src/shared/bigquery/names'
import { bigQueryMaxColumnFacts, bigQueryMaxDefinition, bigQueryPreviewTargetSchema, bigQueryPropertiesRequestSchema, bigQueryPropertiesSchema } from '../src/shared/bigquery/objects'
import { validateRequest } from '../src/main/validation'
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
})
