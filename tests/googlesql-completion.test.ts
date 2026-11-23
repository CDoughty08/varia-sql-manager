import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { completeFromIndex } from '../src/shared/completion/complete'
import { escapeMarkdown, hoverFromIndex } from '../src/shared/completion/hover'
import { LookupCache, lookupCacheLimits } from '../src/shared/completion/lookup-cache'
import type { CompletionItem, IndexLookup, ScopeSource } from '../src/shared/completion/model'
import { googleSqlDialect, quoteGoogleSqlName } from '../src/shared/googlesql/dialect'
import { readGoogleSqlCompletion, readGoogleSqlHover } from '../src/shared/googlesql/scope'
import { languageLookupLimits, languageLookupRequestSchema, languageLookupResultSchema, type LanguageLookupAnswer, type LanguageLookupItem, type LanguageLookupPath, type LanguageLookupResult } from '../src/shared/language-lookup'

/** `|` marks the caret. */
function at(source: string): { text: string; offset: number } {
  const offset = source.indexOf('|')
  return { text: source.slice(0, offset) + source.slice(offset + 1), offset }
}
const read = (source: string) => { const { text, offset } = at(source); return readGoogleSqlCompletion(text, offset) }
const names = (sources: readonly ScopeSource[]) => sources.map(source => source.kind === 'object' ? `${source.name}=${source.parts.join('.')}` : `${source.name ?? ''}:${source.kind}`)

// A fake index with the backend's language.lookup semantics (EditorLookup.cs): projects, datasets, objects, columns by field path.
interface FakeObject { kind: string; subtype?: string; rows?: number; bytes?: number; partitioning?: string; clustering?: string; signature?: string; columns?: { name: string; type: string; nullable?: boolean; description?: string; record?: boolean }[] }
const wideColumns = [...Array.from({ length: 2500 }, (_, index) => ({ name: `c${String(index).padStart(4, '0')}`, type: 'INT64' })),
  { name: 'zrec', type: 'STRUCT', record: true }, { name: 'zrec.alpha', type: 'STRING' }, { name: 'zrec.beta', type: 'STRING' }]
const index: Record<string, Record<string, Record<string, FakeObject>>> = {
  'varia-alpha': {
    sales: {
      orders: {
        kind: 'bqTable', rows: 1234567, bytes: 5368709120, partitioning: 'DAY on placed', clustering: 'customer, region',
        columns: [
          { name: 'id', type: 'INT64', nullable: false }, { name: 'customer', type: 'STRING', description: 'Who | ordered' }, { name: 'tags', type: 'ARRAY<STRING>' },
          { name: 'placed', type: 'TIMESTAMP' }, { name: 'address', type: 'STRUCT', record: true }, { name: 'address.city', type: 'STRING', description: 'The city.' },
          { name: 'address.geo', type: 'STRUCT', record: true }, { name: 'address.geo.lat', type: 'FLOAT64' }, { name: 'items', type: 'ARRAY<STRUCT>', record: true },
          { name: 'items.sku', type: 'STRING' }, { name: 'items.qty', type: 'INT64' }, { name: 'select', type: 'STRING' }
        ]
      },
      daily: { kind: 'bqView', columns: [{ name: 'day', type: 'DATE' }, { name: 'n', type: 'INT64' }] },
      to_cents: { kind: 'bqRoutine', subtype: 'scalar', signature: '(x NUMERIC) RETURNS INT64' }
    },
    staging: { 'raw-events': { kind: 'bqTable', columns: [{ name: 'payload', type: 'JSON' }] } }
  },
  'varia-beta': { census: { people: { kind: 'bqTable', columns: [{ name: 'name', type: 'STRING' }] } } },
  // A table wider than one answer's share.
  'varia-wide': { lab: Object.fromEntries(['wide', 'wide2', 'wide3', 'wide4'].map(name => [name, { kind: 'bqTable', columns: wideColumns }])) }
}
const keeps = (request: LanguageLookupPath, name: string) => request.exact ? name.toLowerCase() === request.prefix!.toLowerCase() : name.toLowerCase().startsWith((request.prefix ?? '').toLowerCase())
function answer(request: LanguageLookupPath): LanguageLookupAnswer {
  const limit = request.limit ?? languageLookupLimits.defaultItems
  const cut = (items: LanguageLookupItem[]) => ({ items: items.slice(0, limit), truncated: items.length > limit })
  const [project, dataset, name] = request.path
  if (request.path.length === 0) return { state: 'ready', path: [], ...cut(Object.keys(index).filter(item => keeps(request, item)).map(item => ({ name: item, kind: 'bqProject' }))) }
  const datasets = index[project]
  if (!datasets) return { state: 'absent', path: [...request.path], items: [], truncated: false }
  if (request.path.length === 1) return { state: 'ready', path: [project], ...cut(Object.keys(datasets).filter(item => keeps(request, item)).map(item => ({ name: item, kind: 'bqDataset' }))) }
  const objects = datasets[dataset]
  if (!objects) return { state: 'absent', path: [...request.path], items: [], truncated: false }
  if (request.path.length === 2) return { state: 'ready', path: [project, dataset], ...cut(Object.entries(objects).filter(([item]) => keeps(request, item)).map(([item, object]) => ({ name: item, kind: object.kind, ...object.subtype ? { subtype: object.subtype } : {}, ...object.signature ? { detail: object.signature } : {} }))) }
  const object = objects[name]
  if (!object) return { state: 'ready', path: [project, dataset], items: [], truncated: false }
  const { columns = [], kind, subtype, ...facts } = object
  return {
    state: 'ready', path: [project, dataset, name], object: { name, kind, ...subtype ? { subtype } : {}, detailed: true, ...facts },
    ...cut(columns.filter(column => keeps(request, column.name)).map(column => ({ name: column.name, kind: 'bqColumn', type: column.type, nullable: column.nullable ?? true,
      ...column.record ? { subtype: 'struct' } : {}, ...request.details && column.description ? { description: column.description } : {} })))
  }
}
function fakeLookup(log: LanguageLookupPath[][] = []): IndexLookup {
  return async requests => { log.push([...requests]); return requests.map(answer) }
}
const dialect = googleSqlDialect({ project: 'varia-alpha', dataset: 'sales' })
async function complete(source: string, lookup = fakeLookup()) {
  const list = await completeFromIndex(read(source), dialect, lookup)
  return { ...list, labels: (kind?: CompletionItem['kind']) => list.items.filter(item => !kind || item.kind === kind).map(item => item.label), item: (label: string) => list.items.find(item => item.label === label) }
}

describe('GoogleSQL scope reader', () => {
  it('reads FROM and JOIN sources with their aliases, and the caret\'s site', () => {
    const select = read('SELECT | FROM sales.orders o JOIN `varia-alpha.sales.daily` AS d ON o.id = d.n')
    expect(select.site).toEqual({ kind: 'expression' })
    expect(names(select.scope.sources)).toEqual(['o=sales.orders', 'd=varia-alpha.sales.daily'])
    expect(read('SELECT o.| FROM sales.orders o').site).toEqual({ kind: 'member', qualifier: ['o'] })
    expect(read('SELECT o.address.ci| FROM sales.orders o').site).toEqual({ kind: 'member', qualifier: ['o', 'address'] })
    expect(read('SELECT * FROM sales.orders o JOIN sales.daily d ON o.id = d.|').site).toEqual({ kind: 'member', qualifier: ['d'] })
    expect(read('SELECT * FROM orders, daily WHERE |').scope.sources.map(source => source.name)).toEqual(['orders', 'daily'])
  })

  it('tells table names from aliases, keywords and text that completes nothing', () => {
    expect(read('SELECT * FROM |').site).toEqual({ kind: 'object', qualifier: [] })
    expect(read('SELECT * FROM sales.or|').site).toEqual({ kind: 'object', qualifier: ['sales'] })
    expect(read('SELECT * FROM `varia-alpha`.sales.|').site).toEqual({ kind: 'object', qualifier: ['varia-alpha', 'sales'] })
    expect(read('SELECT * FROM sales.orders, |').site).toEqual({ kind: 'object', qualifier: [] })
    expect(read('SELECT * FROM a JOIN |').site).toEqual({ kind: 'object', qualifier: [] })
    expect(read('UPDATE |').site.kind).toBe('object')
    expect(read('INSERT INTO sales.|').site).toEqual({ kind: 'object', qualifier: ['sales'] })
    expect(read('SELECT * FROM sales.orders |').site).toEqual({ kind: 'keyword' })
    expect(read('SELECT * FROM sales.orders AS |').site).toEqual({ kind: 'none' })
    expect(read('SELECT x AS |').site).toEqual({ kind: 'none' })
    expect(read('SELECT CAST(x AS |').site).toEqual({ kind: 'keyword' })
    expect(read('|').site).toEqual({ kind: 'keyword' })
    for (const text of ['SELECT \'ab|\'', 'SELECT 1 -- note |', 'SELECT 1 # note |', 'SELECT /* a | */ 1', 'SELECT 12|', 'SELECT @par|', 'SELECT """a\n|']) expect(read(text).site, text).toEqual({ kind: 'none' })
  })

  it('completes inside backticks with the dotted path before the caret, replacing only the part under it', () => {
    const open = read('SELECT * FROM `varia-alpha.sa|')
    expect(open.site).toEqual({ kind: 'object', qualifier: ['varia-alpha'] })
    expect(open.word).toMatchObject({ typed: 'sa', quoted: true })
    const closed = at('SELECT * FROM `varia-alpha.sa|les.orders`')
    const inside = readGoogleSqlCompletion(closed.text, closed.offset)
    expect(inside.word).toMatchObject({ typed: 'sa', quoted: true })
    expect(closed.text.slice(inside.word.start, inside.word.end)).toBe('sales')
  })

  it('reads WITH queries, subqueries and UNNEST, and their columns', () => {
    const cte = read('WITH recent AS (SELECT id, customer AS who, COUNT(*) n, o.placed FROM sales.orders o) SELECT | FROM recent r')
    expect(names(cte.scope.sources)).toEqual(['r:cte'])
    expect(cte.scope.ctes[0]).toMatchObject({ name: 'recent', shape: { columns: ['id', 'who', 'n', 'placed'], stars: [] } })
    const star = read('WITH a AS (SELECT * FROM sales.daily), b AS (SELECT a.*, 1 AS one FROM a) SELECT | FROM b')
    expect(star.scope.ctes.map(entry => entry.name)).toEqual(['a', 'b'])
    expect(names(star.scope.ctes[0].shape.stars)).toEqual(['daily=sales.daily'])
    expect(star.scope.ctes[1].shape.columns).toEqual(['one'])
    const derived = read('SELECT s.| FROM (SELECT id, placed AS at FROM sales.orders) AS s')
    expect(derived.scope.sources[0]).toMatchObject({ kind: 'derived', name: 's', shape: { columns: ['id', 'at'] } })
    const unnest = read('SELECT item.| FROM sales.orders o, UNNEST(o.items) AS item WITH OFFSET pos')
    expect(unnest.scope.sources[1]).toEqual({ kind: 'unnest', name: 'item', path: ['o', 'items'] })
  })

  it('scopes a position to its block: subqueries see outer sources, a WITH body and other set operations do not', () => {
    expect(names(read('SELECT * FROM sales.orders o WHERE EXISTS (SELECT 1 FROM sales.daily d WHERE d.day = |)').scope.sources)).toEqual(['d=sales.daily', 'o=sales.orders'])
    expect(names(read('WITH a AS (SELECT | FROM sales.daily) SELECT * FROM sales.orders').scope.sources)).toEqual(['daily=sales.daily'])
    expect(names(read('SELECT id FROM sales.orders UNION ALL SELECT | FROM sales.daily').scope.sources)).toEqual(['daily=sales.daily'])
    expect(names(read('SELECT 1 FROM sales.orders; SELECT | FROM sales.daily').scope.sources)).toEqual(['daily=sales.daily'])
    expect(names(read('SELECT | FROM sales.orders; SELECT 1 FROM sales.daily').scope.sources)).toEqual(['orders=sales.orders'])
  })

  it('reads FROM inside a call as an argument, and a comma after a join condition as the next table', () => {
    expect(read('SELECT EXTRACT(YEAR FROM |) FROM sales.orders').site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM sales.orders t WHERE EXTRACT(DATE FROM t.|) > x').site).toEqual({ kind: 'member', qualifier: ['t'] })
    const { text, offset } = at('SELECT EXTRACT(YEAR FROM pl|aced) FROM sales.orders')
    expect(readGoogleSqlHover(text, offset)?.object).toBe(false)
    expect(read('SELECT * FROM a LEFT JOIN b ON a.x = b.x, |').site).toEqual({ kind: 'object', qualifier: [] })
    expect(read('SELECT * FROM a JOIN b USING (x), |').site).toEqual({ kind: 'object', qualifier: [] })
    expect(read('SELECT * FROM a JOIN b ON a.x = b.x AND |').site).toEqual({ kind: 'expression' })
  })

  it('keeps an alias after time travel and TABLESAMPLE, and joins a dashed project written without backticks', () => {
    expect(names(read('SELECT x.| FROM t FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) AS x').scope.sources)).toEqual(['x=t'])
    expect(names(read("SELECT x.| FROM t FOR SYSTEM_TIME AS OF TIMESTAMP '2024-01-01' AS x").scope.sources)).toEqual(['x=t'])
    expect(names(read('SELECT x.| FROM t AS x TABLESAMPLE SYSTEM (10 PERCENT)').scope.sources)).toEqual(['x=t'])
    expect(names(read('SELECT x.| FROM t TABLESAMPLE SYSTEM (10 PERCENT) AS x').scope.sources)).toEqual(['x=t'])
    expect(names(read('SELECT | FROM my-proj-2.sales.orders o').scope.sources)).toEqual(['o=my-proj-2.sales.orders'])
    expect(read('SELECT * FROM my-proj.sales.|').site).toEqual({ kind: 'object', qualifier: ['my-proj', 'sales'] })
    expect(read('SELECT * FROM my-proj-2.sales.|').site).toEqual({ kind: 'object', qualifier: ['my-proj-2', 'sales'] })
  })

  it('ends an unclosed backtick name at the first space', () => {
    const { text, offset } = at('SELECT * FROM `varia-alpha.sales.| WHERE x = 1')
    const reading = readGoogleSqlCompletion(text, offset)
    expect(reading.word).toMatchObject({ start: offset, end: offset, quoted: true })
    expect(reading.site).toEqual({ kind: 'object', qualifier: ['varia-alpha', 'sales'] })
  })

  it('lets a WITH query see only the ones before it, so one may read the table it shadows', () => {
    const shadow = read('WITH orders AS (SELECT * FROM orders), daily AS (SELECT | FROM daily) SELECT 1')
    expect(names(shadow.scope.sources)).toEqual(['daily=daily'])
    expect(shadow.scope.ctes.map(cte => cte.name)).toEqual(['orders'])
    // Inside its own body, `orders` is the table it shadows.
    const own = read('WITH orders AS (SELECT | FROM orders) SELECT * FROM orders')
    expect(names(own.scope.sources)).toEqual(['orders=orders'])
    expect(own.scope.ctes).toEqual([])
  })

  it('reads the implicit array join of an earlier item, and an INSERT target only in its column list', () => {
    const implicit = read('SELECT it.| FROM sales.orders o, o.items AS it')
    expect(names(implicit.scope.sources)).toEqual(['o=sales.orders', 'it:unnest'])
    expect(names(read('INSERT INTO sales.daily (day) SELECT | FROM sales.orders').scope.sources)).toEqual(['orders=sales.orders'])
    expect(names(read('INSERT INTO sales.daily (|) SELECT 1').scope.sources)).toEqual(['daily=sales.daily'])
  })

  it('completes and hovers a dashed project written without backticks where a table goes, and nowhere else', () => {
    const typing = read('SELECT * FROM my-pr|')
    expect(typing.site).toEqual({ kind: 'object', qualifier: [] })
    expect(typing.word).toMatchObject({ start: 'SELECT * FROM '.length, typed: 'my-pr' })
    expect(read('SELECT * FROM my-proj-|').word.typed).toBe('my-proj-')
    expect(read('SELECT price-disc| FROM t').site).toEqual({ kind: 'expression' })
    const { text, offset } = at('SELECT * FROM my-proj.sales.ord|ers')
    expect(readGoogleSqlHover(text, offset)).toMatchObject({ parts: ['my-proj', 'sales', 'orders'], at: 2, object: true })
    const onProject = at('SELECT * FROM my-pr|oj.sales.orders')
    expect(readGoogleSqlHover(onProject.text, onProject.offset)).toMatchObject({ parts: ['my-proj', 'sales', 'orders'], at: 0, object: true })
    const subtraction = at('SELECT price-di|sc FROM t')
    expect(readGoogleSqlHover(subtraction.text, subtraction.offset)).toMatchObject({ parts: ['disc'], object: false })
  })

  it('reads text with many FROMs and long WITH chains without slowing down or overflowing', async () => {
    const started = performance.now()
    const froms = 'SELECT 1 ' + 'FROM a '.repeat(30000)
    readGoogleSqlCompletion(froms, froms.length)
    expect(performance.now() - started).toBeLessThan(2000)
    const chain = Array.from({ length: 3000 }, (_, index) => `a${index} AS (SELECT * FROM ${index ? `a${index - 1}` : 'sales.orders'})`)
    const text = `WITH ${chain.join(', ')} SELECT  FROM a2999`
    const offset = text.indexOf('SELECT  FROM') + 'SELECT '.length
    const list = await completeFromIndex(readGoogleSqlCompletion(text, offset), dialect, fakeLookup())
    expect(list.items.length).toBeGreaterThan(0)
    const near = Array.from({ length: 3 }, (_, index) => `a${index} AS (SELECT * FROM ${index ? `a${index - 1}` : 'sales.orders'})`)
    const short = `WITH ${near.join(', ')} SELECT  FROM a2`
    const columns = await completeFromIndex(readGoogleSqlCompletion(short, short.indexOf('  FROM') + 1), dialect, fakeLookup())
    expect(columns.items.filter(item => item.kind === 'column').map(item => item.label)).toContain('customer')
    // The chain's completion itself stays quick, and so do many sources of one wide table.
    const timed = performance.now()
    await completeFromIndex(readGoogleSqlCompletion(text, offset), dialect, fakeLookup())
    const many = 'SELECT  FROM ' + Array.from({ length: 1000 }, () => '`varia-wide.lab.wide`').join(', ')
    await completeFromIndex(readGoogleSqlCompletion(many, 'SELECT '.length), dialect, fakeLookup())
    expect(performance.now() - timed).toBeLessThan(3000)
  })

  it('reads subqueries and WITH queries over a wide table without work growing with its width squared', async () => {
    const wide = '`varia-wide.lab.wide`'
    const subqueries = 'SELECT c24 FROM ' + Array.from({ length: 200 }, (_, index) => `(SELECT * FROM ${wide}) s${index}`).join(', ')
    const chain = 'WITH ' + Array.from({ length: 60 }, (_, index) => `w${index} AS (SELECT * FROM ${index ? `w${index - 1}` : wide})`).join(', ') + ' SELECT c24 FROM w59, w59 AS again'
    const timed = performance.now()
    const first = await completeFromIndex(readGoogleSqlCompletion(subqueries, 'SELECT c24'.length), dialect, fakeLookup())
    const second = await completeFromIndex(readGoogleSqlCompletion(chain, chain.indexOf('SELECT c24') + 'SELECT c24'.length), dialect, fakeLookup())
    expect(performance.now() - timed).toBeLessThan(3000)
    expect(first.items.some(item => item.label === 'c2499')).toBe(true)
    expect(second.items.some(item => item.label === 'c2499')).toBe(true)
  })

  it('reads a dot after a project id that ends in digits', () => {
    expect(read('SELECT * FROM my-project-123456.|').site).toEqual({ kind: 'object', qualifier: ['my-project-123456'] })
  })

  it('reads deeply nested subqueries in bounded time and without overflowing', () => {
    const depth = 3000
    const text = 'SELECT '.padEnd(7) + '* FROM ('.repeat(depth) + 'SELECT id FROM t' + ') q'.repeat(depth)
    const started = performance.now()
    expect(() => readGoogleSqlCompletion(text, 7)).not.toThrow()
    expect(() => readGoogleSqlCompletion(text, text.indexOf('id'))).not.toThrow()
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('reads the targets of UPDATE, DELETE, MERGE and INSERT', () => {
    expect(names(read('UPDATE sales.orders SET |').scope.sources)).toEqual(['orders=sales.orders'])
    expect(names(read('UPDATE sales.orders o SET x = 1 FROM sales.daily d WHERE |').scope.sources)).toEqual(['o=sales.orders', 'd=sales.daily'])
    expect(names(read('DELETE FROM sales.orders WHERE |').scope.sources)).toEqual(['orders=sales.orders'])
    expect(names(read('MERGE sales.orders t USING sales.daily s ON t.|').scope.sources)).toEqual(['t=sales.orders', 's=sales.daily'])
    expect(names(read('INSERT INTO sales.orders (|').scope.sources)).toEqual(['orders=sales.orders'])
  })

  it('reads hover\'s name chain, the part under the caret and whether it names a table', () => {
    const table = at('SELECT * FROM `varia-alpha.sales.or|ders` o')
    expect(readGoogleSqlHover(table.text, table.offset)).toMatchObject({ parts: ['varia-alpha', 'sales', 'orders'], at: 2, object: true })
    const column = at('SELECT o.address.ci|ty FROM sales.orders o')
    expect(readGoogleSqlHover(column.text, column.offset)).toMatchObject({ parts: ['o', 'address', 'city'], at: 2, object: false })
    const call = at('SELECT CO|UNT(*) FROM sales.orders')
    expect(readGoogleSqlHover(call.text, call.offset)).toMatchObject({ parts: ['COUNT'], object: false, scope: { sources: [] } })
    const text = at("SELECT 'or|ders'")
    expect(readGoogleSqlHover(text.text, text.offset)).toBeUndefined()
  })
})

describe('completion from the index', () => {
  it('lists the scope\'s columns, its aliases, functions and keywords in an expression, without nested fields', async () => {
    const list = await complete('SELECT | FROM sales.orders o JOIN daily d ON TRUE')
    expect(list.labels('column')).toEqual(expect.arrayContaining(['id', 'customer', 'address', 'items', 'day', 'n']))
    expect(list.labels('column')).not.toContain('address.city')
    expect(list.labels('alias')).toEqual(['o', 'd'])
    expect(list.labels('function')).toContain('COUNT')
    expect(list.labels('keyword')).toContain('SELECT')
    expect(list.item('id')).toMatchObject({ detail: 'INT64 · REQUIRED · o' })
    expect(list.item('select')?.insertText).toBe('`select`')
    // Columns sort ahead of functions and keywords.
    expect(list.item('id')!.sortText < list.item('COUNT')!.sortText && list.item('COUNT')!.sortText < list.item('SELECT')!.sortText).toBe(true)
  })

  it('lists an alias\'s columns and a STRUCT\'s fields after dots, and UNNEST\'s element fields', async () => {
    expect((await complete('SELECT o.| FROM sales.orders o')).labels()).toEqual(['id', 'customer', 'tags', 'placed', 'address', 'items', 'select'])
    expect((await complete('SELECT o.address.| FROM sales.orders o')).labels()).toEqual(['city', 'geo'])
    expect((await complete('SELECT address.geo.| FROM sales.orders')).labels()).toEqual(['lat'])
    expect((await complete('SELECT item.| FROM sales.orders o, UNNEST(o.items) AS item')).labels()).toEqual(['sku', 'qty'])
    expect((await complete('SELECT nobody.| FROM sales.orders o')).items).toEqual([])
  })

  it('lists WITH queries\' and subqueries\' columns, expanding * from the index', async () => {
    const cte = await complete('WITH a AS (SELECT * FROM sales.daily), b AS (SELECT a.*, 1 AS one FROM a) SELECT b.| FROM b')
    expect(cte.labels()).toEqual(['one', 'day', 'n'])
    expect((await complete('SELECT s.| FROM (SELECT id, placed AS at FROM sales.orders) s')).labels()).toEqual(['id', 'at'])
  })

  it('lists the columns of a table a WITH query of the same name reads, and of the table it joins', async () => {
    const list = await complete('WITH orders AS (SELECT * FROM orders o JOIN daily d ON o.id = d.n) SELECT | FROM orders')
    expect(list.labels('column')).toEqual(expect.arrayContaining(['id', 'customer', 'day', 'n']))
  })

  it('lists an array\'s fields when UNNEST names it after itself, and asks again by prefix for a table wider than its share', async () => {
    expect((await complete('SELECT items.| FROM sales.orders o, UNNEST(o.items) AS items')).labels()).toEqual(['sku', 'qty'])
    const log: LanguageLookupPath[][] = []
    const wide = await complete('SELECT c24| FROM `varia-wide.lab.wide` w', fakeLookup(log))
    expect(wide.labels('column')).toContain('c2499')
    expect(log.at(-1)?.[0]).toMatchObject({ path: ['varia-wide', 'lab', 'wide'], prefix: 'c24' })
    const member = await complete('SELECT w.c249| FROM `varia-wide.lab.wide` w')
    expect(member.labels('column')).toContain('c2499')
    // A STRUCT past the share, with or without an alias, with or without a typed field.
    expect((await complete('SELECT zrec.| FROM `varia-wide.lab.wide`')).labels()).toEqual(['alpha', 'beta'])
    expect((await complete('SELECT zrec.a| FROM `varia-wide.lab.wide`')).labels()).toEqual(['alpha'])
    expect((await complete('SELECT w.zrec.| FROM `varia-wide.lab.wide` w')).labels()).toEqual(['alpha', 'beta'])
    // Only the table cut short is asked again by prefix: the other keeps its whole list (the editor filters it).
    const both: LanguageLookupPath[][] = []
    const joined = await complete('SELECT id| FROM `varia-wide.lab.wide` w JOIN sales.orders o ON TRUE', fakeLookup(both))
    expect(joined.labels('column')).toEqual(expect.arrayContaining(['customer', 'placed']))
    expect(both.at(-1)?.find(request => request.path.at(-1) === 'orders')?.prefix).toBeUndefined()
    expect(both.at(-1)?.find(request => request.path.at(-1) === 'wide')?.prefix).toBe('id')
  })

  it('asks a wide table again through UNNEST, WITH queries and subqueries, and not for a function namespace', async () => {
    const unnest = await complete('SELECT al| FROM `varia-wide.lab.wide` w, UNNEST(w.zrec) AS i')
    expect(unnest.labels('column')).toContain('alpha')
    expect(unnest.incomplete).toBe(false)
    expect((await complete('WITH c AS (SELECT * FROM `varia-wide.lab.wide`) SELECT c.zr| FROM c')).labels('column')).toEqual(['zrec'])
    expect((await complete('SELECT s.zr| FROM (SELECT * FROM `varia-wide.lab.wide`) s')).labels('column')).toEqual(['zrec'])
    expect((await complete('SELECT i.| FROM `varia-wide.lab.wide` w, UNNEST(w.zrec) i')).labels()).toEqual(['alpha', 'beta'])
    const log: LanguageLookupPath[][] = []
    expect((await complete('SELECT SAFE.| FROM `varia-wide.lab.wide`', fakeLookup(log))).items.length).toBeGreaterThan(0)
    expect(log).toHaveLength(1)
    // An UNNEST of a bare name past the share, and many UNNESTs over several wide tables beside a narrow one.
    expect((await complete('SELECT al| FROM `varia-wide.lab.wide`, UNNEST(zrec) AS i')).labels('column')).toContain('alpha')
    expect((await complete('SELECT i.al| FROM `varia-wide.lab.wide`, UNNEST(zrec) i')).labels('column')).toContain('alpha')
    const many = await complete('SELECT id| FROM `varia-wide.lab.wide` a, `varia-wide.lab.wide2` b, `varia-wide.lab.wide3` c, `varia-wide.lab.wide4` d, UNNEST(a.zrec) u1, UNNEST(b.zrec) u2, UNNEST(c.zrec) u3, sales.orders o')
    expect(many.labels('column')).toContain('customer')
  })

  it('keeps a WITH query cut short deep in a chain from standing for it nearer the top, and reads many bare UNNESTs quickly', async () => {
    const chain = 'WITH ' + Array.from({ length: 70 }, (_, index) => `w${index} AS (SELECT * FROM ${index ? `w${index - 1}` : 'sales.orders'})`).join(', ') + ' SELECT  FROM w69, w5'
    expect((await complete(chain.replace('SELECT  FROM', 'SELECT | FROM'))).labels('column')).toContain('customer')
    const timed = performance.now()
    const bare = 'SELECT c24| FROM `varia-wide.lab.wide` w' + ', UNNEST(zrec) u'.repeat(11000)
    await complete(bare)
    expect(performance.now() - timed).toBeLessThan(3000)
  })

  it('lists an UNNEST alias\'s element fields beside the table it reads', async () => {
    expect((await complete('SELECT | FROM sales.orders o, UNNEST(o.items) AS it')).labels('column')).toEqual(expect.arrayContaining(['customer', 'sku', 'qty']))
    expect((await complete('WITH r AS (SELECT * FROM sales.orders) SELECT | FROM r, UNNEST(r.items) AS it')).labels('column')).toEqual(expect.arrayContaining(['sku', 'qty']))
  })

  it('never sends a path segment the lookup would refuse, so the other sources still answer', async () => {
    const log: LanguageLookupPath[][] = []
    const list = await complete('SELECT | FROM sales.orders o JOIN `varia-alpha.sales.` x ON TRUE', fakeLookup(log))
    expect(list.labels('column')).toContain('customer')
    expect(log.flat().every(request => request.path.every(segment => segment.length > 0))).toBe(true)
    expect((await complete('SELECT * FROM `varia-alpha..|', fakeLookup(log))).items.filter(item => item.kind !== 'cte')).toEqual([])
    expect(log.flat().every(request => languageLookupRequestSchema.safeParse({ connectionId: '8f2d5e1a-3c4b-4d6e-9f0a-1b2c3d4e5f60', requests: [request] }).success)).toBe(true)
  })

  it('lists projects, datasets and objects for a table name, nearest first, quoting names that need it', async () => {
    const log: LanguageLookupPath[][] = []
    const list = await complete('WITH recent AS (SELECT 1) SELECT * FROM |', fakeLookup(log))
    expect(log[0].map(request => request.path)).toEqual([['varia-alpha', 'sales'], ['varia-alpha'], []])
    expect(list.labels()).toEqual(['recent', 'orders', 'daily', 'to_cents', 'sales', 'staging', 'varia-alpha', 'varia-beta', 'varia-wide'])
    expect(list.item('varia-alpha')).toMatchObject({ kind: 'container', insertText: '`varia-alpha`', detail: 'Project' })
    expect(list.item('daily')).toMatchObject({ kind: 'view', detail: 'View' })
    expect(list.item('to_cents')).toMatchObject({ kind: 'routine', detail: 'Function (x NUMERIC) RETURNS INT64' })
    expect((await complete('SELECT * FROM staging.|')).item('raw-events')?.insertText).toBe('`raw-events`')
    expect((await complete('SELECT * FROM `varia-alpha.staging.r|')).item('raw-events')?.insertText).toBe('raw-events')
    expect((await complete('SELECT * FROM `varia-beta`.|')).labels()).toEqual(['census'])
    expect((await complete('SELECT * FROM `varia-beta`.census.|')).labels()).toEqual(['people'])
  })

  it('narrows table names by what is typed, and says when the index has more', async () => {
    const log: LanguageLookupPath[][] = []
    await complete('SELECT * FROM sales.or|', fakeLookup(log))
    expect(log[0]).toEqual([{ path: ['varia-alpha', 'sales'], prefix: 'or', limit: languageLookupLimits.defaultItems }, { path: ['sales'], prefix: 'or', limit: languageLookupLimits.defaultItems }])
    const truncated: IndexLookup = async requests => requests.map(request => ({ ...answer(request), truncated: true }))
    expect((await complete('SELECT * FROM |', truncated)).incomplete).toBe(true)
  })

  it('still offers keywords and functions when the index cannot answer, and asks again', async () => {
    const list = await complete('SELECT | FROM sales.orders', async () => undefined)
    expect(list.labels('column')).toEqual([])
    expect(list.labels('keyword')).toContain('FROM')
    expect(list.incomplete).toBe(true)
  })

  it('lists a function namespace\'s members, and any function after SAFE.', async () => {
    expect((await complete('SELECT NET.|')).labels()).toContain('HOST')
    expect((await complete('SELECT SAFE.|')).labels()).toContain('ABS')
    expect((await complete('SELECT * FROM sales.orders WHERE |')).labels('keyword')).toContain('AND')
  })
})

describe('hover from the index', () => {
  const hover = async (source: string) => { const { text, offset } = at(source); const found = readGoogleSqlHover(text, offset); return found && hoverFromIndex(found, dialect, fakeLookup()) }

  it('summarises a table: kind, path, rows, size, layout and columns', async () => {
    const found = await hover('SELECT * FROM sales.or|ders')
    expect(found?.markdown).toContain('**orders** · Table')
    expect(found?.markdown).toContain('1,234,567 rows · 5.0 GiB · Partitioned by DAY on placed · Clustered by customer, region')
    expect(found?.markdown).toContain('| id | INT64 REQUIRED |')
    expect(found?.markdown).not.toContain('address\\.city')
    expect(await hover('SELECT * FROM o|rders o')).toMatchObject({ markdown: expect.stringContaining('**orders**') })
    expect(await hover('SELECT |o.id FROM sales.orders o')).toMatchObject({ markdown: expect.stringContaining('**orders** · Table') })
  })

  it('shows a column\'s or field\'s type and description, escaped', async () => {
    const field = await hover('SELECT o.address.ci|ty FROM sales.orders o')
    expect(field?.markdown).toContain('**address\\.city** STRING')
    expect(field?.markdown).toContain('The city\\.')
    expect((await hover('SELECT custo|mer FROM sales.orders'))?.markdown).toContain('Who \\| ordered')
    expect((await hover('SELECT i|d FROM sales.orders'))?.markdown).toContain('REQUIRED')
  })

  it('shows a function\'s signatures, and nothing for an unknown name', async () => {
    expect((await hover('SELECT COU|NT(*) FROM sales.orders'))?.markdown).toContain('**COUNT**')
    expect(await hover('SELECT nob|ody FROM sales.orders')).toBeUndefined()
    expect((await hover('WITH abc AS (SELECT * FROM sales.daily) SELECT * FROM a|bc'))?.markdown).toContain('- day')
  })

  it('escapes every Markdown character in names', () => {
    expect(escapeMarkdown('a|b*c_[d](e)`f`')).toBe('a\\|b\\*c\\_\\[d\\]\\(e\\)\\`f\\`')
  })
})

describe('GoogleSQL dialect', () => {
  it('quotes names that are not plain words or are reserved, escaping backslashes and backticks', () => {
    expect(quoteGoogleSqlName('orders')).toBe('orders')
    expect(quoteGoogleSqlName('my-proj')).toBe('`my-proj`')
    expect(quoteGoogleSqlName('select')).toBe('`select`')
    expect(quoteGoogleSqlName('a`b\\')).toBe('`a\\`b\\\\`')
  })

  it('fills in the billing project and default dataset, and has no path for a bare name without a dataset', () => {
    expect(dialect.objectPath(['orders'])).toEqual(['varia-alpha', 'sales', 'orders'])
    expect(dialect.objectPath(['staging', 't'])).toEqual(['varia-alpha', 'staging', 't'])
    expect(dialect.objectPath(['p', 'd', 't'])).toEqual(['p', 'd', 't'])
    expect(googleSqlDialect({ project: 'p' }).objectPath(['t'])).toBeUndefined()
    expect(googleSqlDialect({ project: 'p' }).containers([]).map(container => container.path)).toEqual([['p'], []])
  })
})

describe('language.lookup cache', () => {
  const result = (answers: LanguageLookupAnswer[], indexState: LanguageLookupResult['index'] = 'ready'): LanguageLookupResult => ({ index: indexState, answers })
  it('answers a longer prefix of a whole answer without asking again, and asks again after a cut one or its time', async () => {
    let now = 0
    const asked: LanguageLookupPath[][] = []
    const cache = new LookupCache(async requests => { asked.push(requests); return result(requests.map(answer)) }, () => now)
    await cache.lookup([{ path: ['varia-alpha', 'sales'], prefix: 'o' }])
    const longer = await cache.lookup([{ path: ['varia-alpha', 'sales'], prefix: 'OR' }])
    expect(asked).toHaveLength(1)
    expect(longer?.[0].items.map(item => item.name)).toEqual(['orders'])
    // A details request is not answered by one without.
    await cache.lookup([{ path: ['varia-alpha', 'sales', 'orders'], details: true, prefix: 'c' }])
    expect(asked).toHaveLength(2)
    now = lookupCacheLimits.ttlMs + 1
    await cache.lookup([{ path: ['varia-alpha', 'sales'], prefix: 'or' }])
    expect(asked).toHaveLength(3)
    let cutAsks = 0
    const cut = new LookupCache(async requests => { cutAsks++; return result(requests.map(request => ({ ...answer(request), truncated: true }))) })
    await cut.lookup([{ path: [], prefix: 'v' }])
    expect(await cut.lookup([{ path: [], prefix: 'va' }])).toBeDefined()
    expect(cutAsks).toBe(2)
    // The editor that asked reaches the backend call, so a failure shows on its own tab.
    const callers: (string | undefined)[] = []
    const tagged = new LookupCache(async (requests, caller) => { callers.push(caller); return result(requests.map(answer)) })
    await tagged.lookup([{ path: [] }], 'tab-a')
    await tagged.lookup([{ path: ['varia-alpha'] }], 'tab-b')
    expect(callers).toEqual(['tab-a', 'tab-b'])
  })

  it('keeps nothing from an index that is still building, and only asks for what it lacks', async () => {
    const asked: LanguageLookupPath[][] = []
    const cache = new LookupCache(async requests => { asked.push(requests); return result(requests.map(answer), 'building') })
    await cache.lookup([{ path: [] }])
    await cache.lookup([{ path: [] }])
    expect(asked).toHaveLength(2)
    expect(cache.index).toBe('building')
    const ready = new LookupCache(async requests => { asked.push(requests); return result(requests.map(answer)) })
    asked.length = 0
    await ready.lookup([{ path: [] }])
    await ready.lookup([{ path: [] }, { path: ['varia-alpha'] }])
    expect(asked.map(requests => requests.map(request => request.path))).toEqual([[[]], [['varia-alpha']]])
  })
})

describe('language.lookup contract', () => {
  it('bounds requests and answers', () => {
    const connectionId = '8f2d5e1a-3c4b-4d6e-9f0a-1b2c3d4e5f60'
    expect(languageLookupRequestSchema.safeParse({ connectionId, requests: [{ path: ['p', 'd', 't'], prefix: 'a', limit: 10 }] }).success).toBe(true)
    expect(languageLookupRequestSchema.safeParse({ connectionId, requests: [{ path: ['p', 'd', 't', 'x'] }] }).success).toBe(false)
    expect(languageLookupRequestSchema.safeParse({ connectionId, requests: [{ path: [], exact: true }] }).success).toBe(false)
    expect(languageLookupRequestSchema.safeParse({ connectionId, requests: Array.from({ length: languageLookupLimits.requests + 1 }, () => ({ path: [] })) }).success).toBe(false)
    expect(languageLookupRequestSchema.safeParse({ connectionId, requests: [{ path: [''] }] }).success).toBe(false)
    const item = { name: 'x', kind: 'bqColumn' }
    expect(languageLookupResultSchema.safeParse({ index: 'ready', answers: [{ state: 'ready', path: [], items: [item], truncated: false }] }).success).toBe(true)
    const many = Array.from({ length: 3 }, () => ({ state: 'ready', path: [], items: Array.from({ length: languageLookupLimits.items }, () => item), truncated: true }))
    expect(languageLookupResultSchema.safeParse({ index: 'ready', answers: many }).success).toBe(false)
  })

  it('keeps its limits in step with the backend’s EditorLookupLimits', () => {
    const source = readFileSync('backend/Varia.Backend/Search/EditorLookup.cs', 'utf8')
    const declared = /class EditorLookupLimits\s*\{\s*public const int ([^;]+);/.exec(source)![1]
    const limits = Object.fromEntries(declared.split(',').map(entry => entry.split('=').map(part => part.trim())).map(([name, value]) => [name, Number(value)]))
    expect(limits).toEqual({ Requests: languageLookupLimits.requests, Segments: languageLookupLimits.segments, SegmentChars: languageLookupLimits.segmentChars,
      PrefixChars: languageLookupLimits.prefixChars, Items: languageLookupLimits.items, DefaultItems: languageLookupLimits.defaultItems, TotalItems: languageLookupLimits.totalItems })
  })
})
