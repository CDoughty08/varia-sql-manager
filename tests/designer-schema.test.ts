import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { actionDescribeSchema, actionRequestSchema } from '../src/shared/actions/schema'
import { designerLimits, systemTypes } from '../src/shared/designer/catalog'
import { canonicalNumber, createTableSchema, designProblems, tableDesignSchema, tempTableMessage, type DesignColumn, type TableDesign } from '../src/shared/designer/schema'
import { defaultType, formatTypeText, parseTypeText, typeProblem } from '../src/shared/designer/type-text'

const id = { seed: '1', increment: '1' }
const column = (name: string, system: string, extra: Partial<DesignColumn> & Record<string, unknown> = {}): DesignColumn => ({ name, type: { system }, allowNulls: true, ...extra })
const design = (...columns: DesignColumn[]): TableDesign => ({ schema: 'dbo', name: 'T', columns, primaryKey: [] })
const good: TableDesign = { schema: 'dbo', name: 'Orders', columns: [column('Id', 'int', { allowNulls: false, identity: id }), { name: 'Name', type: { system: 'nvarchar', length: 50 }, allowNulls: true }], primaryKey: [0] }
const request = (value: unknown) => ({ action: 'createTable', connectionId: crypto.randomUUID(), requestId: crypto.randomUUID(), target: { kind: 'database', name: 'AppData' }, design: value })

describe('data type text', () => {
  it('parses any case and spacing and formats SSMS\'s form', () => {
    const cases: [string, string][] = [
      ['nvarchar(50)', 'nvarchar(50)'], ['NVARCHAR ( max )', 'nvarchar(MAX)'], ['varchar(MAX)', 'varchar(MAX)'], ['decimal(18,0)', 'decimal(18, 0)'], ['decimal( 18 , 2 )', 'decimal(18, 2)'],
      ['numeric(5)', 'numeric(5, 0)'], ['int', 'int'], ['  Int  ', 'int'], ['datetime2', 'datetime2(7)'], ['time(0)', 'time(0)'], ['nchar', 'nchar(10)'], ['vector(1998)', 'vector(1998)'], ['char(8000)', 'char(8000)']
    ]
    for (const [text, formatted] of cases) {
      const parsed = parseTypeText(text)
      expect('type' in parsed ? formatTypeText(parsed.type) : parsed.problem, text).toBe(formatted)
    }
  })
  it('refuses what SQL Server refuses, and json and vector before SQL Server 2025', () => {
    for (const text of ['nchar(max)', 'char(8001)', 'nvarchar(4001)', 'decimal(39,0)', 'decimal(5,6)', 'time(8)', 'vector(0)', 'vector(1999)', 'int(4)', 'varchar(0)', 'varchar(-1)', 'varchar(1.5)',
      'varchar2(10)', 'nvarchar(50', 'decimal(1,2,3)', 'datetime2(1,2)', '', 'dbo.MyType', 'nvarchar(50) NOT NULL']) {
      expect('problem' in parseTypeText(text), text).toBe(true)
    }
    expect('problem' in parseTypeText('json', 16)).toBe(true)
    expect('problem' in parseTypeText('vector(3)', 16)).toBe(true)
    expect('type' in parseTypeText('json', 17)).toBe(true)
    expect(typeProblem({ system: 'varchar', length: 10, max: true })).toBeDefined()
  })
  it('gives every listed type its defaults', () => {
    for (const spec of systemTypes) expect(typeProblem(defaultType(spec)), spec.name).toBeUndefined()
  })
})

describe('table design schema', () => {
  it('accepts SSMS\'s designs at the limits', () => {
    expect(tableDesignSchema.safeParse(good).success).toBe(true)
    const wide = { ...design(...Array.from({ length: designerLimits.columns }, (_, index) => column('c' + index, 'int', { allowNulls: false }))), primaryKey: Array.from({ length: 32 }, (_, index) => index) }
    expect(tableDesignSchema.safeParse(wide).success).toBe(true)
    expect(tableDesignSchema.safeParse(design(column('a', 'decimal', { type: { system: 'decimal', precision: 38, scale: 0 }, allowNulls: false, identity: { seed: '-' + '9'.repeat(38), increment: '-1' } }))).success).toBe(true)
    expect(actionRequestSchema.safeParse(request(good)).success).toBe(true)
    expect(createTableSchema.safeParse(request(good)).success).toBe(true)
  })
  it('refuses what the backend refuses, with the same bounds', () => {
    const invalid: [string, unknown][] = [
      ['1,025 columns', design(...Array.from({ length: 1025 }, (_, index) => column('c' + index, 'int')))], ['no columns', design()],
      ['a 129-unit name', { ...good, name: 't'.repeat(129) }], ['U+0000', { ...good, schema: 'd\u0000bo' }], ['an empty column name', design(column('', 'int'))],
      ['a column twice', design(column('a', 'int'), column('a', 'bit'))], ['two identities', design(column('a', 'int', { allowNulls: false, identity: id }), column('b', 'int', { allowNulls: false, identity: id }))],
      ['an identity on varchar', design({ name: 'a', type: { system: 'varchar', length: 10 }, allowNulls: false, identity: id })],
      ['a nullable identity', design(column('a', 'int', { identity: id }))], ['an increment of 0', design(column('a', 'int', { allowNulls: false, identity: { seed: '1', increment: '-000' } }))],
      ['a 39-digit seed', design(column('a', 'int', { allowNulls: false, identity: { seed: '9'.repeat(39), increment: '1' } }))], ['two timestamps', design(column('a', 'timestamp'), column('b', 'timestamp'))],
      ['a key out of range', { ...good, primaryKey: [2] }], ['a key column twice', { ...good, primaryKey: [0, 0] }], ['a nullable key column', { ...good, primaryKey: [1] }],
      ['33 key columns', { ...design(...Array.from({ length: 33 }, (_, index) => column('c' + index, 'int', { allowNulls: false }))), primaryKey: Array.from({ length: 33 }, (_, index) => index) }],
      ['max false', design({ name: 'a', type: { system: 'varchar', length: 10, max: false }, allowNulls: true })], ['an unknown member', { ...good, collation: 'Latin1_General_CI_AS' }],
      ['an unknown column member', design({ ...column('a', 'int'), default: '0' } as DesignColumn)], ['an unknown type member', design({ name: 'a', type: { system: 'int', collation: 'x' } as never, allowNulls: true })],
      ['a temporary table', { ...good, name: '#T' }], ['a global temporary table', { ...good, name: '##T' }], ['columns differing only in trailing spaces', design(column('a', 'int'), column('a  ', 'int'))],
      ['a seed before a line break', design(column('a', 'int', { allowNulls: false, identity: { seed: '12\n', increment: '1' } }))],
      ['an increment before a line break', design(column('a', 'int', { allowNulls: false, identity: { seed: '1', increment: '1\n' } }))]
    ]
    for (const [name, value] of invalid) expect(tableDesignSchema.safeParse(value).success, name).toBe(false)
    expect(actionRequestSchema.safeParse({ ...request(good), target: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'T' } }).success).toBe(false)
    expect(actionRequestSchema.safeParse({ ...request(good), newName: 'x' }).success).toBe(false)
  })
  it('names the cell each problem is about, so the grid marks it', () => {
    const problems = designProblems({ ...design(column('a', 'int'), column('a', 'varchar', { identity: id })), primaryKey: [0] })
    expect(designProblems(design(column('v', 'varchar', { type: { system: 'varchar', length: 10 }, allowNulls: false, identity: id }))).map(problem => problem.property)).toEqual(['identity'])
    expect(problems.map(problem => [problem.column, problem.property])).toEqual([[1, 'name'], [1, 'dataType'], [1, 'allowNulls'], [0, 'allowNulls']])
    expect(designProblems(design(column('j', 'json')), 16)[0]).toMatchObject({ column: 0, property: 'dataType' })
    expect(canonicalNumber('-0')).toBe('0')
    expect(canonicalNumber('-007')).toBe('-7')
  })
  it('compares column names as the database\'s catalog collation does, and refuses # table names', () => {
    const twins = design(column('Id', 'int'), column('ID', 'int'), column('café', 'int'), column('cafe', 'int'))
    const twice = (comparison?: { caseSensitive: boolean; accentSensitive: boolean }) => designProblems(twins, 17, comparison).filter(problem => problem.property === 'name').map(problem => problem.column)
    // Main and the backend know no collation: SQL Server decides (2705) and the save rolls back.
    expect(twice()).toEqual([])
    expect(twice({ caseSensitive: true, accentSensitive: true })).toEqual([])
    expect(twice({ caseSensitive: false, accentSensitive: true })).toEqual([1])
    expect(twice({ caseSensitive: false, accentSensitive: false })).toEqual([1, 3])
    expect(designProblems({ ...good, name: '##Orders' })).toEqual([{ property: 'tableName', message: tempTableMessage }])
    expect(designProblems({ ...good, name: 'Orders#' })).toEqual([])
    expect(designProblems({ ...good, schema: '#s' })).toEqual([])
  })
  it('keeps the largest design under the 4 MiB request body and its script under the query limit', () => {
    const name = (index: number) => (index.toString().padStart(4, '0') + ']'.repeat(124))
    const largest: TableDesign = {
      schema: ']'.repeat(128), name: ']'.repeat(128), primaryKey: Array.from({ length: 32 }, (_, index) => index),
      columns: Array.from({ length: designerLimits.columns }, (_, index) => ({ name: name(index), type: { system: 'uniqueidentifier' }, allowNulls: false, ...index === 0 ? {} : {} }))
    }
    expect(tableDesignSchema.safeParse(largest).success).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(request(largest))).length).toBeLessThan(4 * 1024 * 1024)
    // Each column's script line: a tab, the bracketed name (]] doubled), the type and NOT NULL, a comma and a line break;
    // then the key's lines, the prologue and the rest, well under 2,000 characters.
    const lines = largest.columns.reduce((sum, value) => sum + 1 + value.name.length * 2 + 2 + ' uniqueidentifier NOT NULL,\r\n'.length, 0) + 32 * (1 + 258 + 3)
    expect(lines + 4 * (2 * 258 + 1) + 2_000).toBeLessThan(designerLimits.scriptChars)
  })
  it('accepts the fixture designs the .NET goldens script', () => {
    const cases = JSON.parse(readFileSync('tests/fixtures/designer/cases.json', 'utf8')).cases as { id: string; design: TableDesign }[]
    for (const item of cases) expect(tableDesignSchema.safeParse(item.design).success, item.id).toBe(true)
  })
  it('describes a database for the table designer, SQL Server\'s own included, and nothing else', () => {
    const describe = (target: unknown) => actionDescribeSchema.safeParse({ connectionId: crypto.randomUUID(), requestId: crypto.randomUUID(), dialog: 'tableDesigner', target }).success
    expect(describe({ kind: 'database', name: 'master' })).toBe(true)
    expect(describe({ kind: 'table', database: 'AppData', schema: 'dbo', name: 'T' })).toBe(false)
    expect(describe({ kind: 'database' })).toBe(false)
  })
})
