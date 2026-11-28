import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { completeFromIndex } from '../src/shared/completion/complete'
import { definitionFromIndex, IndexUnavailableError } from '../src/shared/completion/definition'
import { escapeMarkdown, hoverFromIndex, sqlObjectMarkdown } from '../src/shared/completion/hover'
import { LookupCache, lookupCacheLimits } from '../src/shared/completion/lookup-cache'
import type { CompletionItem, CompletionSite, IndexLookup, ScopeSource } from '../src/shared/completion/model'
import { googleSqlDialect, quoteGoogleSqlName } from '../src/shared/googlesql/dialect'
import { readGoogleSqlCompletion, readGoogleSqlHover, readGoogleSqlStatementSources } from '../src/shared/googlesql/scope'
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
  { name: 'zrec', type: 'STRUCT', record: true }, { name: 'zrec.alpha', type: 'STRING' }, { name: 'zrec.beta', type: 'STRING' },
  { name: 'zitems', type: 'ARRAY<STRUCT>', record: true }, { name: 'zitems.sku', type: 'STRING' }, { name: 'zitems.qty', type: 'INT64' }]
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
  'varia-wide': { lab: { ...Object.fromEntries(['wide', 'wide2', 'wide3', 'wide4'].map(name => [name, { kind: 'bqTable', columns: wideColumns }])),
    // Wide, but within one answer's share: it comes back whole.
    whole: { kind: 'bqTable', columns: wideColumns.slice(0, 1900) } } }
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
    expect(read('SELECT * FROM sales.orders |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM sales.orders o |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(read('SELECT * FROM sales.orders AS o |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(read('SELECT * FROM sales.orders a JOIN sales.daily |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: true })
    expect(read('SELECT * FROM sales.orders a JOIN sales.daily d |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: true })
    expect(read('SELECT * FROM sales.orders a JOIN sales.daily d ON a.id = d.n, sales.orders |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM (SELECT 1) |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM (SELECT 1) s |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(read("SELECT * FROM a.b FOR SYSTEM_TIME AS OF TIMESTAMP '2024-01-01' |").site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read("SELECT * FROM a.b FOR SYSTEM_TIME AS OF '2024-01-01' |").site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read("SELECT * FROM a.b FOR SYSTEM_TIME AS OF TIMESTAMP '2024-01-01' x |").site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(read('SELECT * FROM a.b FOR |').site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME |').site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS |').site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF |').site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF TIMESTAMP |').site).toEqual({ kind: 'expression' })
    const stAliased = read("SELECT * FROM a.b FOR SYSTEM_TIME AS OF TIMESTAMP '2024-01-01' t WHERE t.|")
    expect(stAliased.site).toEqual({ kind: 'member', qualifier: ['t'] })
    expect(stAliased.scope.sources[0]?.name).toBe('t')
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP() - INTERVAL 1 DAY |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP() - INTERVAL 1 DAY TO |').site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP() - INTERVAL 1 DAY TO SECOND |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    const stIntervalRangeAliased = read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP() - INTERVAL 1 DAY TO SECOND t |')
    expect(stIntervalRangeAliased.site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(stIntervalRangeAliased.scope.sources[0]?.name).toBe('t')
    const stIntervalAliased = read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP() - INTERVAL 1 DAY t |')
    expect(stIntervalAliased.site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(stIntervalAliased.scope.sources[0]?.name).toBe('t')
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CASE |').site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CASE x |').site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CASE @mode |').site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CASE WHEN TRUE THEN CURRENT_TIMESTAMP() END |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CASE x WHEN 1 THEN CURRENT_TIMESTAMP() END |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    const stCaseAliased = read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CASE WHEN TRUE THEN CURRENT_TIMESTAMP() END t |')
    expect(stCaseAliased.site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(stCaseAliased.scope.sources[0]?.name).toBe('t')
    const stCaseWhere = read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CASE WHEN TRUE THEN CURRENT_TIMESTAMP() END t WHERE t.|')
    expect(stCaseWhere.site).toEqual({ kind: 'member', qualifier: ['t'] })
    expect(stCaseWhere.scope.sources[0]?.name).toBe('t')
    const stSimpleCaseWhere = read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CASE x WHEN 1 THEN CURRENT_TIMESTAMP() END t WHERE t.|')
    expect(stSimpleCaseWhere.site).toEqual({ kind: 'member', qualifier: ['t'] })
    expect(stSimpleCaseWhere.scope.sources[0]?.name).toBe('t')
    const stNestedCaseWhere = read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF CASE WHEN TRUE THEN CASE WHEN FALSE THEN CURRENT_TIMESTAMP() ELSE CURRENT_TIMESTAMP() END END t WHERE t.|')
    expect(stNestedCaseWhere.site).toEqual({ kind: 'member', qualifier: ['t'] })
    expect(stNestedCaseWhere.scope.sources[0]?.name).toBe('t')
    expect(read('SELECT * FROM `CASE` |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    const stBeforeJoin = read('SELECT * FROM a.b FOR SYSTEM_TIME AS OF | JOIN c ON a.b.id = c.id')
    expect(stBeforeJoin.site).toEqual({ kind: 'expression' })
    expect(names(stBeforeJoin.scope.sources)).toEqual(['b=a.b', 'c=c'])
    expect(read('SELECT * FROM UNNEST([1]) WITH OFFSET |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM UNNEST([1]) u WITH OFFSET |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM UNNEST([1]) WITH OFFSET pos |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(read("SELECT * FROM a.b PIVOT(SUM(x) FOR y IN ('a')) |").site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read("SELECT * FROM a.b PIVOT(SUM(x) FOR y IN ('a')) p |").site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(read('SELECT * FROM a.b UNPIVOT(v FOR k IN (c1, c2)) |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read("SELECT * FROM a.b PIVOT(SUM(|) FOR y IN ('a'))").site).toEqual({ kind: 'expression' })
    expect(read('SELECT * FROM a JOIN b USING (id) |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(read('MERGE target USING source |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false, mergeUsing: true })
    expect(read('MERGE target USING source s |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false, mergeUsing: true })
    expect(read('SELECT * FROM my-proj-2 |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM `example.com:my-proj |').site).toEqual({ kind: 'none' })
    expect(read('SELECT * FROM t FOR SYSTEM_TIME AS OF col1 + col2 |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM t TABLESAMPLE |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    const dashedFirst = read('SELECT * FROM m|y-proj-2')
    expect(dashedFirst.site).toEqual({ kind: 'object', qualifier: [] })
    expect(dashedFirst.word).toEqual({ start: 14, end: 23, typed: 'm', quoted: false })
    const dashedAfterFirstDash = read('SELECT * FROM my-|proj-2')
    expect(dashedAfterFirstDash.site).toEqual({ kind: 'object', qualifier: [] })
    expect(dashedAfterFirstDash.word).toEqual({ start: 14, end: 23, typed: 'my-', quoted: false })
    const dashedAfterSecondDash = read('SELECT * FROM my-proj-|2')
    expect(dashedAfterSecondDash.site).toEqual({ kind: 'object', qualifier: [] })
    expect(dashedAfterSecondDash.word).toEqual({ start: 14, end: 23, typed: 'my-proj-', quoted: false })
    const dashedSpaceAfterDash = read('SELECT * FROM my-| proj')
    expect(dashedSpaceAfterDash.site).toEqual({ kind: 'object', qualifier: [] })
    expect(dashedSpaceAfterDash.word).toEqual({ start: 14, end: 17, typed: 'my-', quoted: false })
    expect(read('SELECT * FROM sales.orders AS |').site).toEqual({ kind: 'none' })
    expect(read('SELECT x AS |').site).toEqual({ kind: 'none' })
    expect(read('SELECT CAST(x AS |').site).toEqual({ kind: 'castType' })
    expect(read('SELECT SAFE_CAST(x AS |').site).toEqual({ kind: 'castType' })
    expect(read('|').site).toEqual({ kind: 'statementStart' })
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
    // WITH RECURSIVE exposes the CTE to its own body (and nested CTEs/subqueries inside it), not just the outer query.
    const rec = read('WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT r.| FROM r) SELECT * FROM r')
    expect(rec.scope.ctes.map(entry => entry.name)).toEqual(['r'])
    expect(rec.scope.sources).toEqual([expect.objectContaining({ kind: 'cte', name: 'r', cte: 'r', shape: { columns: ['n'], stars: [] } })])
    const nestedRec = read('WITH RECURSIVE r AS (WITH helper AS (SELECT * FROM r) SELECT 1 AS n UNION ALL SELECT h.| FROM helper h) SELECT * FROM r')
    expect(nestedRec.scope.sources).toEqual([expect.objectContaining({
      kind: 'cte', name: 'h', cte: 'helper',
      shape: { columns: [], stars: [expect.objectContaining({ kind: 'cte', cte: 'r', shape: { columns: ['n'], stars: [] } })] }
    })])
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
    expect(first.items.some(item => item.filterText === 'c2499' && item.label === 's0.c2499')).toBe(true)
    expect(second.items.filter(item => item.filterText === 'c2499').map(item => item.label)).toEqual(['w59.c2499', 'again.c2499'])
  })

  it('reads a dot after a project id that ends in digits', () => {
    expect(read('SELECT * FROM my-project-123456.|').site).toEqual({ kind: 'object', qualifier: ['my-project-123456'] })
  })

  it('reads unquoted digit-starting dataset and table segments after a dot in object sites without breaking numbers', () => {
    const numOnly = read('SELECT * FROM my-proj.123|')
    expect(numOnly.site).toEqual({ kind: 'object', qualifier: ['my-proj'] })
    expect(numOnly.word).toEqual({ start: 22, end: 25, typed: '123', quoted: false })

    const afterNumDot = read('SELECT * FROM my-proj.456.|')
    expect(afterNumDot.site).toEqual({ kind: 'object', qualifier: ['my-proj', '456'] })
    expect(afterNumDot.word).toEqual({ start: 26, end: 26, typed: '', quoted: false })

    const numWord = read('SELECT * FROM my-proj.2024_sales|')
    expect(numWord.site).toEqual({ kind: 'object', qualifier: ['my-proj'] })
    expect(numWord.word).toEqual({ start: 22, end: 32, typed: '2024_sales', quoted: false })

    const midNumWord = read('SELECT * FROM my-proj.20|24_sales')
    expect(midNumWord.site).toEqual({ kind: 'object', qualifier: ['my-proj'] })
    expect(midNumWord.word).toEqual({ start: 22, end: 32, typed: '20', quoted: false })

    const afterNumWordDot = read('SELECT * FROM my-proj.2024_sales.|')
    expect(afterNumWordDot.site).toEqual({ kind: 'object', qualifier: ['my-proj', '2024_sales'] })
    expect(afterNumWordDot.word).toEqual({ start: 33, end: 33, typed: '', quoted: false })

    const twoNumSegments = read('SELECT * FROM my-proj.123.456|')
    expect(twoNumSegments.site).toEqual({ kind: 'object', qualifier: ['my-proj', '123'] })
    expect(twoNumSegments.word).toEqual({ start: 26, end: 29, typed: '456', quoted: false })

    const numDashed = read('SELECT * FROM my-proj.123-prod|')
    expect(numDashed.site).toEqual({ kind: 'object', qualifier: ['my-proj'] })
    expect(numDashed.word).toEqual({ start: 22, end: 30, typed: '123-prod', quoted: false })

    expect(read('SELECT * FROM my-proj.123 |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM my-proj.2024_sales |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM my-proj.2024_sales d |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    const sourceRead = read('SELECT o.| FROM my-proj.2024_sales.orders o')
    expect(sourceRead.site).toEqual({ kind: 'member', qualifier: ['o'] })
    expect(names(sourceRead.scope.sources)).toEqual(['o=my-proj.2024_sales.orders'])
    const hoverRead = at('SELECT * FROM my-proj.2024_sales.ord|ers')
    expect(readGoogleSqlHover(hoverRead.text, hoverRead.offset)).toMatchObject({ parts: ['my-proj', '2024_sales', 'orders'], at: 2, object: true })

    // Numeric literals and non-object digit expressions stay non-completable.
    for (const sql of ['SELECT 1.5|', 'SELECT .5|', 'SELECT 123|', 'WHERE a = 123|', 'SELECT a.123|', 'SELECT a.456.|', 'SELECT a.2024_sales|', 'SELECT a-1.5|', 'SELECT a-1.5| FROM t', 'SELECT a-1.|5', 'SELECT t.x - 1.5| FROM t', 'SELECT 10-2.5|', 'SELECT -1.5|', 'WHERE a = 1-2.5|']) {
      expect(read(sql).site, sql).toEqual({ kind: 'none' })
    }
  })

  it('reads unquoted digit-starting segments after a dashed project ending in digits without breaking subtraction', () => {
    const typingDataset = read('SELECT * FROM my-project-123456.2024_sales|')
    expect(typingDataset.site).toEqual({ kind: 'object', qualifier: ['my-project-123456'] })
    expect(typingDataset.word).toEqual({ start: 32, end: 42, typed: '2024_sales', quoted: false })

    const midDataset = read('SELECT * FROM my-project-123456.20|24_sales')
    expect(midDataset.site).toEqual({ kind: 'object', qualifier: ['my-project-123456'] })
    expect(midDataset.word).toEqual({ start: 32, end: 42, typed: '20', quoted: false })

    const digitOnlyDataset = read('SELECT * FROM my-project-123456.2024|')
    expect(digitOnlyDataset.site).toEqual({ kind: 'object', qualifier: ['my-project-123456'] })
    expect(digitOnlyDataset.word).toEqual({ start: 32, end: 36, typed: '2024', quoted: false })

    const afterDatasetDot = read('SELECT * FROM my-project-123456.2024_sales.|')
    expect(afterDatasetDot.site).toEqual({ kind: 'object', qualifier: ['my-project-123456', '2024_sales'] })
    expect(afterDatasetDot.word).toEqual({ start: 43, end: 43, typed: '', quoted: false })

    const afterDigitOnlyDot = read('SELECT * FROM my-project-123456.2024.|')
    expect(afterDigitOnlyDot.site).toEqual({ kind: 'object', qualifier: ['my-project-123456', '2024'] })

    const tableSeg = read('SELECT * FROM my-project-123456.2024_sales.orders|')
    expect(tableSeg.site).toEqual({ kind: 'object', qualifier: ['my-project-123456', '2024_sales'] })
    expect(tableSeg.word).toEqual({ start: 43, end: 49, typed: 'orders', quoted: false })

    const threeDigitChain = read('SELECT * FROM my-project-123456.2024.345|')
    expect(threeDigitChain.site).toEqual({ kind: 'object', qualifier: ['my-project-123456', '2024'] })
    expect(threeDigitChain.word).toEqual({ start: 37, end: 40, typed: '345', quoted: false })

    const dashedDigitDataset = read('SELECT * FROM my-proj.123-456.789|')
    expect(dashedDigitDataset.site).toEqual({ kind: 'object', qualifier: ['my-proj', '123-456'] })
    expect(dashedDigitDataset.word).toEqual({ start: 30, end: 33, typed: '789', quoted: false })

    const memberAfter = read('SELECT o.| FROM my-project-123456.2024_sales.orders o')
    expect(memberAfter.site).toEqual({ kind: 'member', qualifier: ['o'] })
    expect(names(memberAfter.scope.sources)).toEqual(['o=my-project-123456.2024_sales.orders'])

    const fullSql = 'SELECT * FROM my-project-123456.2024_sales.orders'
    expect(readGoogleSqlStatementSources(fullSql, fullSql.length)).toEqual([
      { kind: 'object', name: 'orders', parts: ['my-project-123456', '2024_sales', 'orders'], span: { start: 14, end: 49 } }
    ])

    const hoverOrders = at('SELECT * FROM my-project-123456.2024_sales.ord|ers')
    expect(readGoogleSqlHover(hoverOrders.text, hoverOrders.offset)).toMatchObject({ parts: ['my-project-123456', '2024_sales', 'orders'], at: 2, object: true })
    const hoverDataset = at('SELECT * FROM my-project-123456.2024_sal|es.orders')
    expect(readGoogleSqlHover(hoverDataset.text, hoverDataset.offset)).toMatchObject({ parts: ['my-project-123456', '2024_sales', 'orders'], at: 1, object: true })

    // Subtraction `a-1.5` never fabricates hover or spurious statement sources.
    expect(readGoogleSqlHover('SELECT a-1.5 FROM t', 'SELECT a-'.length)).toBeUndefined()
    expect(readGoogleSqlHover('SELECT a-1.5 FROM t', 'SELECT a-1.'.length)).toBeUndefined()
    expect(names(readGoogleSqlStatementSources('SELECT a-1.5 FROM t', 'SELECT a-1.5 FROM t'.length))).toEqual(['t=t'])
  })

  it('completes dashed identifiers with -<digits><letters> and scientific-like datasets without breaking aliases or arithmetic', async () => {
    // [Medium 1] -<digits><letters> mid-segment and end-of-segment in object sites.
    expect(read('SELECT * FROM gcp-123abc|')).toMatchObject({
      site: { kind: 'object', qualifier: [] },
      word: { start: 14, end: 24, typed: 'gcp-123abc', quoted: false }
    })
    expect(read('SELECT * FROM gcp-123a|bc')).toMatchObject({
      site: { kind: 'object', qualifier: [] },
      word: { start: 14, end: 24, typed: 'gcp-123a', quoted: false }
    })
    expect(read('SELECT * FROM gcp-123a|bc-def')).toMatchObject({
      site: { kind: 'object', qualifier: [] },
      word: { start: 14, end: 28, typed: 'gcp-123a', quoted: false }
    })
    expect(read('SELECT * FROM gcp-123-456abc|')).toMatchObject({
      site: { kind: 'object', qualifier: [] },
      word: { start: 14, end: 28, typed: 'gcp-123-456abc', quoted: false }
    })
    expect(read('SELECT * FROM my-proj.123-456_tbl|')).toMatchObject({
      site: { kind: 'object', qualifier: ['my-proj'] },
      word: { start: 22, end: 33, typed: '123-456_tbl', quoted: false }
    })

    // End-to-end project completion for `gcp-123a` / `gcp-123abc` returns project item, not afterFromTable keywords.
    const gcpLookup: IndexLookup = async requests => requests.map(request => request.path.length === 0
      ? { state: 'ready', path: [], truncated: false, items: [{ name: 'gcp-123abc', kind: 'bqProject' }] }
      : { state: 'ready', path: [...request.path], truncated: false, items: [] })
    expect((await complete('SELECT * FROM gcp-123a|', gcpLookup)).labels('container')).toEqual(['gcp-123abc'])
    expect((await complete('SELECT * FROM gcp-123abc|', gcpLookup)).labels('container')).toEqual(['gcp-123abc'])

    // hasFromAlias after trailing space on dashed -<digits><letters> segments vs real aliases.
    for (const sql of [
      'SELECT * FROM gcp-123abc |',
      'SELECT * FROM my-proj-123_tbl |',
      'SELECT * FROM my-proj.123-456_tbl |',
      'SELECT * FROM my-proj-1.2024_01-2b |'
    ]) {
      expect(read(sql).site, sql).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
      expect((await complete(sql)).labels('keyword'), sql).toContain('AS')
    }
    expect(read('SELECT * FROM gcp-123abc t |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
    expect(read('SELECT * FROM my-proj.tbl AS t |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })

    // Non-object arithmetic / expression sites must not turn into object or member sites.
    expect(read('SELECT a-1.|').site).toEqual({ kind: 'none' })
    expect(read('SELECT a-1.b|').site).toEqual({ kind: 'none' })
    expect(read('SELECT a-1abc.b| FROM t').site).toEqual({ kind: 'none' })
    expect(read('SELECT t.x-1abc| FROM t').site).toEqual({ kind: 'expression' })
    expect(read('SELECT gcp-123abc| FROM t').site).toEqual({ kind: 'expression' })

    // [Low 1] Scientific-notation-like segment after a dashed-digit project (`my-project-123456.2024e1`).
    expect(read('SELECT * FROM my-project-123456.2024e1|')).toMatchObject({
      site: { kind: 'object', qualifier: ['my-project-123456'] },
      word: { start: 32, end: 38, typed: '2024e1', quoted: false }
    })
    expect(read('SELECT * FROM my-project-123456.2024e1.|')).toMatchObject({
      site: { kind: 'object', qualifier: ['my-project-123456', '2024e1'] },
      word: { start: 39, end: 39, typed: '', quoted: false }
    })
    expect(read('SELECT * FROM my-project-123456.2024e10|')).toMatchObject({
      site: { kind: 'object', qualifier: ['my-project-123456'] },
      word: { start: 32, end: 39, typed: '2024e10', quoted: false }
    })
    expect(read('SELECT * FROM my-project-123456.2024E2|')).toMatchObject({
      site: { kind: 'object', qualifier: ['my-project-123456'] },
      word: { start: 32, end: 38, typed: '2024E2', quoted: false }
    })
    expect(read('SELECT * FROM my-project-123456.e1|')).toMatchObject({
      site: { kind: 'object', qualifier: ['my-project-123456'] },
      word: { start: 32, end: 34, typed: 'e1', quoted: false }
    })
    const sciSql = 'SELECT * FROM my-project-123456.2024e1.orders'
    expect(readGoogleSqlStatementSources(sciSql, sciSql.length)).toEqual([
      { kind: 'object', name: 'orders', parts: ['my-project-123456', '2024e1', 'orders'], span: { start: 14, end: 45 } }
    ])
    const sciHover = at('SELECT * FROM my-project-123456.2024e1.ord|ers')
    expect(readGoogleSqlHover(sciHover.text, sciHover.offset)).toMatchObject({
      parts: ['my-project-123456', '2024e1', 'orders'],
      at: 2,
      object: true
    })

    // Scientific-notation arithmetic negatives stay non-completable with no spurious hover or sources.
    for (const sql of ['SELECT a-1.5e2|', 'SELECT a-1.5e2| FROM t', 'SELECT 10-2.5e1|']) {
      expect(read(sql).site, sql).toEqual({ kind: 'none' })
    }
    expect(readGoogleSqlHover('SELECT a-1.5e2 FROM t', 'SELECT a-1.'.length)).toBeUndefined()
    expect(names(readGoogleSqlStatementSources('SELECT a-1.5e2 FROM t', 'SELECT a-1.5e2 FROM t'.length))).toEqual(['t=t'])
  })

  it('reads per-segment backticked dotted paths across FROM, JOIN, DML, WITH, subqueries, completion, and hover', async () => {
    const mixedPaths = [
      { sql: 'SELECT t.| FROM my_proj.my_ds.`my-table` t', expectedSource: 't=my_proj.my_ds.my-table', expectedParts: ['my_proj', 'my_ds', 'my-table'] },
      { sql: 'SELECT t.| FROM `my-proj`.`my_ds`.`my-table` t', expectedSource: 't=my-proj.my_ds.my-table', expectedParts: ['my-proj', 'my_ds', 'my-table'] },
      { sql: 'SELECT t.| FROM `my-project-123456`.`2024e1`.orders t', expectedSource: 't=my-project-123456.2024e1.orders', expectedParts: ['my-project-123456', '2024e1', 'orders'] },
      { sql: 'SELECT t.| FROM my_proj.`2024_sales`.orders t', expectedSource: 't=my_proj.2024_sales.orders', expectedParts: ['my_proj', '2024_sales', 'orders'] },
      { sql: 'SELECT t.| FROM `example.com:my-proj-1`.2024e1.`orders` t', expectedSource: 't=example.com:my-proj-1.2024e1.orders', expectedParts: ['example.com:my-proj-1', '2024e1', 'orders'] },
      { sql: 'SELECT t.| FROM my_proj.2024.`my-table` t', expectedSource: 't=my_proj.2024.my-table', expectedParts: ['my_proj', '2024', 'my-table'] }
    ]
    for (const entry of mixedPaths) {
      const reading = read(entry.sql)
      expect(reading.site, entry.sql).toEqual({ kind: 'member', qualifier: ['t'] })
      expect(names(reading.scope.sources), entry.sql).toEqual([entry.expectedSource])
      const bareSql = entry.sql.replace('t.|', '*').replace(/ t$/, '')
      expect(readGoogleSqlStatementSources(bareSql, bareSql.length), bareSql).toMatchObject([{ kind: 'object', parts: entry.expectedParts }])
    }

    // End-to-end completion & hover on per-segment backticked paths (`varia-alpha`.staging.`raw-events`).
    const mixedMember = await complete('SELECT t.| FROM `varia-alpha`.staging.`raw-events` t')
    expect(mixedMember.labels('column')).toEqual(['payload'])
    const mixedHover = at('SELECT t.pay|load FROM `varia-alpha`.staging.`raw-events` t')
    expect(await hoverFromIndex(readGoogleSqlHover(mixedHover.text, mixedHover.offset)!, dialect, fakeLookup())).toMatchObject({
      markdown: expect.stringContaining('payload')
    })

    // JOIN, UPDATE, DELETE, MERGE, WITH CTE, and subquery variants preserve full per-segment backticked paths and aliases.
    expect(names(read('SELECT s.| FROM `varia-alpha`.sales.orders o JOIN `varia-alpha`.staging.`raw-events` s ON o.id = s.|').scope.sources))
      .toEqual(['o=varia-alpha.sales.orders', 's=varia-alpha.staging.raw-events'])
    expect(names(read('UPDATE my_proj.my_ds.`my-table` t SET t.| = 1').scope.sources)).toEqual(['t=my_proj.my_ds.my-table'])
    expect(names(read('DELETE FROM my_proj.my_ds.`my-table` t WHERE t.| = 1').scope.sources)).toEqual(['t=my_proj.my_ds.my-table'])
    expect(names(read('MERGE my_proj.my_ds.`my-table` t USING `varia-alpha`.staging.`raw-events` s ON t.| = s.payload').scope.sources))
      .toEqual(['t=my_proj.my_ds.my-table', 's=varia-alpha.staging.raw-events'])
    expect(names(read('WITH c AS (SELECT t.| FROM my_proj.my_ds.`my-table` t) SELECT * FROM c').scope.sources))
      .toEqual(['t=my_proj.my_ds.my-table'])
    expect(names(read('SELECT * FROM (SELECT t.| FROM my_proj.my_ds.`my-table` t)').scope.sources))
      .toEqual(['t=my_proj.my_ds.my-table', ':derived'])
    expect(read('SELECT * FROM my_proj.my_ds.`my-table` |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM my_proj.my_ds.`my-table` t |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })
  })

  it('suppresses ON and USING after CROSS JOIN and NATURAL JOIN while keeping them on other joins', async () => {
    for (const sql of [
      'SELECT * FROM a CROSS JOIN b |',
      'SELECT * FROM a NATURAL JOIN b |',
      'SELECT * FROM a NATURAL LEFT JOIN b |',
      'SELECT * FROM a NATURAL LEFT OUTER JOIN b |',
      'SELECT * FROM a JOIN b ON a.id = b.id CROSS JOIN c |'
    ]) {
      const reading = read(sql)
      expect(reading.site, sql).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
      const labels = (await complete(sql)).labels('keyword')
      expect(labels, sql).not.toContain('ON')
      expect(labels, sql).not.toContain('USING')
      expect(labels, sql).toContain('WHERE')
    }
    for (const sql of [
      'SELECT * FROM a JOIN b |',
      'SELECT * FROM a INNER JOIN b |',
      'SELECT * FROM a LEFT JOIN b |',
      'SELECT * FROM a RIGHT JOIN b |',
      'SELECT * FROM a FULL OUTER JOIN b |',
      'SELECT * FROM a CROSS JOIN b JOIN c |'
    ]) {
      const reading = read(sql)
      expect(reading.site, sql).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: true })
      const labels = (await complete(sql)).labels('keyword')
      expect(labels, sql).toContain('ON')
      expect(labels, sql).toContain('USING')
    }
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

  it('escapes standalone carriage returns in Markdown, appends CTE >40 col footer, and includes project tier/namesOnly on table alias hover', async () => {
    expect(escapeMarkdown('line1\rline2\r\nline3\nline4')).toBe('line1 line2 line3 line4')

    const cols = Array.from({ length: 45 }, (_, i) => `${i + 1} AS c${i + 1}`).join(', ')
    const cteHoverPos = at(`WITH wide AS (SELECT ${cols}) SELECT * FROM wi|de`)
    const cteHover = await hoverFromIndex(readGoogleSqlHover(cteHoverPos.text, cteHoverPos.offset)!, dialect, fakeLookup())
    expect(cteHover?.markdown).toContain('and 5 more columns')

    const aliasHoverPos = at('SELECT |o.id FROM sales.orders o')
    const tierLookup = fakeLookup()
    const aliasHover = await hoverFromIndex(readGoogleSqlHover(aliasHoverPos.text, aliasHoverPos.offset)!, dialect, async requests => {
      const answers = await tierLookup(requests)
      return answers?.map(ans => ans.path.length === 0
        ? { ...ans, items: ans.items.map(item => ({ ...item, tier: 'billing' as const })) }
        : ans)
    })
    expect(aliasHover?.markdown).toContain('**orders** · Table · Billing')
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
    // Exact boundary: an object at hop 65 (past starHops = 64) still marks incomplete and budget-cuts so a shallower read of w0 re-reads it.
    const chain65 = 'WITH ' + Array.from({ length: 65 }, (_, index) => `w${index} AS (SELECT * FROM ${index ? `w${index - 1}` : 'sales.orders'})`).join(', ')
    const atHop65 = await complete(`${chain65} SELECT | FROM w64`)
    expect(atHop65.incomplete).toBe(true)
    const hop65WithShallow = await complete(`${chain65} SELECT | FROM w64, w0`)
    expect(hop65WithShallow.incomplete).toBe(true)
    expect(hop65WithShallow.labels('column')).toContain('customer')
    const timed = performance.now()
    const bare = 'SELECT c24| FROM `varia-wide.lab.wide` w' + ', UNNEST(zrec) u'.repeat(11000)
    await complete(bare)
    // A dbt-style diamond (each WITH query joins the two before it) past the star budget, and a deep one named thousands of times.
    const diamond = 'WITH c0 AS (SELECT * FROM sales.orders), c1 AS (SELECT * FROM sales.orders), ' + Array.from({ length: 98 }, (_, index) => `c${index + 2} AS (SELECT * FROM c${index + 1} JOIN c${index} USING (id))`).join(', ') + ' SELECT | FROM c99'
    expect((await complete(diamond)).labels('column')).toContain('customer')
    const deep = 'WITH ' + Array.from({ length: 70 }, (_, index) => `c${index} AS (SELECT * FROM ${index ? `c${index - 1}` : 'sales.orders'})`).join(', ') + ' SELECT cu| FROM ' + Array.from({ length: 10000 }, (_, index) => `c69 x${index}`).join(', ')
    await complete(deep)
    expect(performance.now() - timed).toBeLessThan(3000)
  })

  it('bounds the work of a web of WITH queries over a wide table, nearest listed first, and says the list is cut short', async () => {
    // A table that comes back whole: only the cap can make the list incomplete.
    const wide = '`varia-wide.lab.whole`'
    const web = 'WITH ' + Array.from({ length: 522 }, (_, index) => `c${index} AS (SELECT * FROM ${wide} w${Array.from({ length: Math.min(8, index) }, (_, back) => `, c${index - 1 - back} a${back}`).join('')})`).join(', ') + ' SELECT c00| FROM c521'
    const timed = performance.now()
    const list = await complete(web)
    expect(performance.now() - timed).toBeLessThan(3000)
    expect(list.labels('column')).toContain('c0000')
    expect(list.incomplete).toBe(true)
    // UNNESTs past the cap over a table that was not cut short leave the list final.
    const plain = await complete('SELECT cu| FROM sales.orders o, `varia-wide.lab.wide` w' + Array.from({ length: 18 }, (_, index) => `, UNNEST(o.items) u${index}`).join(''))
    expect(plain.incomplete).toBe(false)
    // Thousands of UNNESTs through a WITH query of many named columns count against the cap too.
    const named = Array.from({ length: 20000 }, (_, index) => `x${index}`).join(', ')
    const unnests = `WITH c AS (SELECT ${named} FROM sales.orders) SELECT q| FROM \`varia-wide.lab.wide\` w, c` + Array.from({ length: 6000 }, (_, index) => `, UNNEST(c.ab) u${index}`).join('')
    const started = performance.now()
    expect((await complete(unnests)).incomplete).toBe(true)
    expect(performance.now() - started).toBeLessThan(2000)
    // A member list whose source the cap cut is not final, though every answer came back whole.
    const copies = Array.from({ length: 600 }, (_, index) => `c0 a${index}`).join(', ')
    const member = await complete(`WITH c0 AS (SELECT * FROM \`varia-wide.lab.whole\`), c1 AS (SELECT * FROM ${copies}) SELECT items.| FROM c1, sales.orders o`)
    expect(member.incomplete).toBe(true)
    // A second ask (one typed letter beside a table cut short) lists what the first did: it has a cap of its own.
    const web80 = 'WITH ' + Array.from({ length: 80 }, (_, index) => `c${index} AS (SELECT * FROM \`varia-wide.lab.whole\` w${Array.from({ length: Math.min(8, index) }, (_, back) => `, c${index - 1 - back} a${back}`).join('')})`).join(', ')
    expect((await complete(`${web80} SELECT x.c| FROM c79 x, \`varia-wide.lab.wide\` z`)).labels('column').length).toBeGreaterThanOrEqual(1900)
  })

  it('follows a long chain of UNNESTs, each reading the last, without overflowing', async () => {
    const chain = (count: number) => Array.from({ length: count }, (_, index) => `, UNNEST(${index ? `u${index - 1}.zz` : 'o.items'}) u${index}`).join('')
    const member = await complete(`SELECT u2999.| FROM sales.orders o${chain(3000)}`)
    expect(member.incomplete).toBe(true)
    expect((await complete(`SELECT u0.| FROM sales.orders o${chain(3000)}`)).labels()).toEqual(['sku', 'qty'])
    const text = `SELECT u2999.q FROM sales.orders o${chain(3000)}`
    expect(await hoverFromIndex(readGoogleSqlHover(text, 'SELECT u2999.'.length)!, dialect, fakeLookup())).toBeUndefined()
  })

  it('reads a star repeated over many sources, and many dotted FROM items, in bounded time', async () => {
    const stars = `WITH c AS (SELECT ${Array(10000).fill('*').join(',')} FROM ${Array(20000).fill('sales.orders').join(',')}) SELECT | FROM c`
    const dotted = 'SELECT | FROM sales.orders o0' + ', x.y z'.repeat(35000)
    const timed = performance.now()
    const read = readGoogleSqlCompletion(stars, stars.indexOf('| FROM c'))
    expect(read.scope.ctes[0].shape.stars.length).toBeLessThanOrEqual(20000)
    expect((await complete(stars)).labels('column')).toContain('customer')
    await complete(dotted)
    expect(performance.now() - timed).toBeLessThan(3000)
  })

  it('reads huge FROM lists, quoted paths and qualified stars without throwing, in bounded time', async () => {
    const timed = performance.now()
    const many = 'SELECT  FROM ' + 'a,'.repeat(124000) + 'a'
    expect(readGoogleSqlCompletion(many, 7).scope.sources.length).toBe(124001)
    expect(readGoogleSqlHover(many, many.length - 1)).toBeDefined()
    const path = '`' + 'a.'.repeat(124000) + 'a`'
    for (const text of [`SELECT * FROM (SELECT ${path}) q WHERE `, `SELECT * FROM UNNEST(${path}) WHERE `, `SELECT * FROM x.${path} WHERE `]) expect(() => readGoogleSqlCompletion(text, text.length)).not.toThrow()
    const qualified = `WITH c AS (SELECT ${Array(30000).fill('zz.*').join(', ')} FROM ${Array.from({ length: 10000 }, (_, index) => `t a${index}`).join(', ')}) SELECT  FROM c`
    readGoogleSqlCompletion(qualified, qualified.length - ' FROM c'.length)
    expect(performance.now() - timed).toBeLessThan(3000)
  })

  it('bounds UNNESTs and stars nested together, and says a bare name past a cut source is not final', async () => {
    const levels = Array.from({ length: 256 }, (_, index) => {
      const k = index + 1
      return [`a${k}_0 AS (SELECT * FROM UNNEST(c${k - 1}.items))`, ...[1, 2, 3].map(step => `a${k}_${step} AS (SELECT * FROM a${k}_${step - 1})`)].join(', ')
    }).join(', ')
    const froms = Array.from({ length: 256 }, (_, index) => `a${256 - index}_3 c${256 - index}`).join(', ')
    const text = `WITH ${levels} SELECT | FROM ${froms}, sales.orders c0`
    const list = await complete(text)
    expect(list.incomplete).toBe(true)
    const member = await complete(text.replace('SELECT | FROM', 'SELECT c256.| FROM'))
    expect(member.incomplete).toBe(true)
    const chain = Array.from({ length: 300 }, (_, index) => `, UNNEST(u${index + 1}.items) u${index}`).join('')
    expect((await complete(`SELECT b.| FROM UNNEST(items) b${chain}, sales.orders u300`)).incomplete).toBe(true)
  })

  it('says the list is not final when an UNNEST\'s prefix went unasked', async () => {
    const dropped = await complete('SELECT al| FROM `varia-wide.lab.wide` w, UNNEST(w.nope1) a, UNNEST(w.nope2) b, UNNEST(w.nope3) c, UNNEST(w.zrec) d')
    expect(dropped.incomplete).toBe(true)
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

  it('scopes nested CTEs lexically (inner shadows outer, inner does not leak to outer FROM) and preserves case-distinct BigQuery tables', async () => {
    // Inner CTE x shadows outer CTE x inside the subquery.
    const inner = await complete('WITH x AS (SELECT 1 AS outer_col) SELECT * FROM (WITH x AS (SELECT 2 AS inner_col) SELECT x.| FROM x)')
    expect(inner.labels('column')).toEqual(['inner_col'])
    // CTE declared inside another CTE does not leak as an outer FROM candidate.
    const outerFrom = await complete('WITH a AS (WITH inner_cte AS (SELECT 1 AS c) SELECT * FROM inner_cte) SELECT * FROM |')
    expect(outerFrom.labels('cte')).toEqual(['a'])
    // Outer x containing a nested WITH x still resolves to outer_col in the outer query.
    const outerRef = await complete('WITH x AS (SELECT 1 AS outer_col FROM (WITH x AS (SELECT 2 AS inner_col) SELECT * FROM x)) SELECT x.| FROM x')
    expect(outerRef.labels('column')).toEqual(['outer_col'])
    // Case-distinct BigQuery tables (Orders and orders) both appear in completion.
    const caseDistinct: IndexLookup = async requests => requests.map(request => request.path.join('.') === 'varia-alpha.sales'
      ? { path: request.path, state: 'ready', items: [{ kind: 'bqTable', name: 'Orders' }, { kind: 'bqTable', name: 'orders' }], truncated: false }
      : { path: request.path, state: 'ready', items: [], truncated: false })
    const tables = await complete('SELECT * FROM sales.or|', caseDistinct)
    expect(tables.labels('table')).toEqual(['Orders', 'orders'])
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

  it('scopes clause keywords for afterFromTable, castType and statementStart without TABLE or ABORT hijack', async () => {
    const afterTable = await complete('SELECT * FROM sales.orders |')
    expect(afterTable.labels('keyword')).toEqual(expect.arrayContaining(['AS', 'WHERE', 'JOIN', 'LEFT JOIN', 'TABLESAMPLE', 'ORDER BY']))
    expect(afterTable.labels('keyword')).not.toEqual(expect.arrayContaining(['TABLE', 'ABORT', 'INT64', 'SELECT', 'ON']))
    // Typing `t` after a table offers TABLESAMPLE (never TABLE) while keeping `t` safe for alias use.
    const typingT = await complete('SELECT * FROM `varia-alpha.sales.orders` t|')
    expect(typingT.labels('keyword')).toContain('TABLESAMPLE')
    expect(typingT.labels('keyword')).not.toContain('TABLE')
    // Once an alias is present, AS is omitted; inside JOIN without ON/USING, ON and USING are offered.
    const aliased = await complete('SELECT * FROM sales.orders o |')
    expect(aliased.labels('keyword')).not.toContain('AS')
    const joined = await complete('SELECT * FROM sales.orders o JOIN sales.daily |')
    expect(joined.labels('keyword')).toEqual(expect.arrayContaining(['AS', 'ON', 'USING', 'WHERE']))
    const usingDone = await complete('SELECT * FROM sales.orders o JOIN sales.daily USING (id) |')
    expect(usingDone.labels('keyword')).toEqual(expect.arrayContaining(['WHERE', 'JOIN', 'ORDER BY']))
    expect(usingDone.labels('keyword')).not.toEqual(expect.arrayContaining(['AS', 'ON', 'USING']))
    const cast = await complete('SELECT CAST(x AS |')
    expect(cast.labels('keyword')).toEqual(expect.arrayContaining(['INT64', 'STRING', 'ARRAY', 'STRUCT']))
    expect(cast.labels('keyword')).not.toContain('WHERE')
    const start = await complete('|')
    expect(start.labels('keyword')).toEqual(expect.arrayContaining(['SELECT', 'WITH', 'INSERT', 'CREATE']))
    expect(start.labels('keyword')).not.toContain('WHERE')
    const mergeUsing = await complete('MERGE target USING source |')
    expect(mergeUsing.labels('keyword')).toEqual(['AS', 'ON'])
    const mergeUsingAliased = await complete('MERGE target USING source s |')
    expect(mergeUsingAliased.labels('keyword')).toEqual(['ON'])
  })

  it('preserves domain-scoped projects and escapes backticks/backslashes inside quoted identifiers', async () => {
    const domain = read('SELECT * FROM `example.com:my-proj.my_ds.my_tbl` |')
    expect(domain.scope.sources[0]).toMatchObject({ kind: 'object', parts: ['example.com:my-proj', 'my_ds', 'my_tbl'] })
    expect(read('SELECT * FROM `example.com:my-proj.my_ds.|').site).toEqual({ kind: 'object', qualifier: ['example.com:my-proj', 'my_ds'] })
    expect(read('SELECT * FROM `example.com:my-proj.|').site).toEqual({ kind: 'object', qualifier: ['example.com:my-proj'] })
    const colonBoundary = read('SELECT * FROM `example.com:|`')
    expect(colonBoundary.site).toEqual({ kind: 'object', qualifier: [] })
    expect(colonBoundary.word.typed).toBe('example.com:')
    const unclosedSpace = read('SELECT * FROM `example.com:my-| WHERE x = 1')
    expect(unclosedSpace.site).toEqual({ kind: 'object', qualifier: [] })
    expect(unclosedSpace.word).toMatchObject({ start: 15, end: 30, typed: 'example.com:my-', quoted: true })
    const unclosedWithRest = at('SELECT * FROM `example.com:my-|proj WHERE 1=1')
    const unclosedWithRestRead = readGoogleSqlCompletion(unclosedWithRest.text, unclosedWithRest.offset)
    expect(unclosedWithRestRead.site).toEqual({ kind: 'object', qualifier: [] })
    expect(unclosedWithRestRead.word).toMatchObject({ start: 15, end: 34, typed: 'example.com:my-', quoted: true })
    expect(unclosedWithRest.text.slice(unclosedWithRestRead.word.start, unclosedWithRestRead.word.end)).toBe('example.com:my-proj')
    const hovered = at('SELECT * FROM `example.com:my-proj.my_ds.my_t|bl`')
    expect(readGoogleSqlHover(hovered.text, hovered.offset)).toMatchObject({ parts: ['example.com:my-proj', 'my_ds', 'my_tbl'], at: 2, object: true })
    const hoveredOpen = at('SELECT * FROM `example.com:my-|proj WHERE 1=1')
    expect(readGoogleSqlHover(hoveredOpen.text, hoveredOpen.offset)).toMatchObject({ parts: ['example.com:my-proj'], at: 0, object: true })

    const quotedLog: LanguageLookupPath[][] = []
    const quotedLookup: IndexLookup = async requests => {
      quotedLog.push([...requests])
      const all = [{ name: 'a`b', kind: 'bqTable' }, { name: 'c\\d', kind: 'bqTable' }]
      return requests.map(request => ({
        state: 'ready',
        path: [...request.path],
        truncated: false,
        items: all.filter(item => keeps(request, item.name))
      }))
    }
    const list = await complete('SELECT * FROM `varia-alpha.sales.a|`', quotedLookup)
    expect(list.item('a`b')?.insertText).toBe('a\\`b')
    const partialTick = await complete('SELECT * FROM `varia-alpha.sales.a\\`|', quotedLookup)
    expect(quotedLog.at(-1)?.[0].prefix).toBe('a`')
    expect(partialTick.item('a`b')?.insertText).toBe('a\\`b')
    const partialSlash = await complete('SELECT * FROM `varia-alpha.sales.c\\\\|', quotedLookup)
    expect(quotedLog.at(-1)?.[0].prefix).toBe('c\\')
    expect(partialSlash.item('c\\d')?.insertText).toBe('c\\\\d')
  })

  it('suggests date-sharded wildcards ahead of the latest concrete shard and respects typed prefixes', async () => {
    const shardedLookup: IndexLookup = async requests => requests.map(request => {
      if (request.path.join('.') === 'varia-alpha.analytics') {
        const all: LanguageLookupItem[] = [
          { name: 'events_20261124', kind: 'bqTable', shards: { prefix: 'events_', count: 328, first: '20260101', last: '20261124' } },
          { name: 'events_summary', kind: 'bqTable' }
        ]
        return { state: 'ready', path: [...request.path], truncated: false, items: all.filter(item => keeps(request, item.name)) }
      }
      return { state: 'ready', path: [...request.path], truncated: false, items: [] }
    })

    const ev = await complete('SELECT * FROM analytics.ev|', shardedLookup)
    expect(ev.labels('table')).toEqual(['events_*', 'events_20261124', 'events_summary'])
    expect(ev.item('events_*')).toMatchObject({
      insertText: '`events_*`',
      detail: 'Wildcard · 328 shards, 20260101–20261124',
      filterText: 'events_*'
    })
    expect(ev.item('events_20261124')).toMatchObject({
      insertText: 'events_20261124',
      detail: 'Latest shard · 328 shards, 20260101–20261124'
    })
    expect(ev.item('events_*')!.sortText < ev.item('events_20261124')!.sortText).toBe(true)

    // Inside backticks, wildcard inserts without nested backticks.
    const quoted = await complete('SELECT * FROM `varia-alpha.analytics.ev|`', shardedLookup)
    expect(quoted.item('events_*')?.insertText).toBe('events_*')

    // Concrete shard prefix drops the non-matching wildcard while keeping the concrete shard.
    const concrete = await complete('SELECT * FROM analytics.events_2026|', shardedLookup)
    expect(concrete.labels('table')).toEqual(['events_20261124'])

    // Empty shard date bounds omit the date range without a dangling separator.
    const noRangeLookup: IndexLookup = async requests => requests.map(request => request.path.join('.') === 'varia-alpha.analytics'
      ? { state: 'ready', path: [...request.path], truncated: false, items: [{ name: 'logs_20261124', kind: 'bqTable', shards: { prefix: 'logs_', count: 3, first: '', last: '' } }] }
      : { state: 'ready', path: [...request.path], truncated: false, items: [] })
    const noRange = await complete('SELECT * FROM analytics.lo|', noRangeLookup)
    expect(noRange.item('logs_*')?.detail).toBe('Wildcard · 3 shards')
    expect(noRange.item('logs_20261124')?.detail).toBe('Latest shard · 3 shards')
  })

  it('auto-injects BigQuery pseudo-columns (_TABLE_SUFFIX, _PARTITIONTIME/_PARTITIONDATE, _FILE_NAME) without leaking into SELECT *', async () => {
    const pseudoLookup: IndexLookup = async requests => requests.map(request => {
      const key = request.path.join('.')
      if (key === 'varia-alpha.analytics.events_*' || key === 'varia-alpha.analytics.events_20261124') {
        return {
          state: 'ready',
          path: ['varia-alpha', 'analytics', 'events_20261124'],
          truncated: false,
          object: { name: 'events_20261124', kind: 'bqTable', detailed: true, shards: { prefix: 'events_', count: 30, first: '20261026', last: '20261124' } },
          items: [{ name: 'event_id', kind: 'bqColumn', type: 'STRING' }]
        }
      }
      if (key === 'varia-alpha.analytics.ingest_logs') {
        return {
          state: 'ready',
          path: [...request.path],
          truncated: false,
          object: { name: 'ingest_logs', kind: 'bqTable', detailed: true, partitioning: 'DAY on _PARTITIONTIME' },
          items: [{ name: 'message', kind: 'bqColumn', type: 'STRING' }]
        }
      }
      if (key === 'varia-alpha.analytics.gcs_ext' || key === 'varia-alpha.analytics.gcs_ext_*') {
        return {
          state: 'ready',
          path: [...request.path],
          truncated: false,
          object: { name: 'gcs_ext', kind: 'bqExternalTable', detailed: true },
          items: [{ name: 'raw_line', kind: 'bqColumn', type: 'STRING' }]
        }
      }
      return { state: 'ready', path: [...request.path], truncated: false, items: [] }
    })

    // Wildcard table gets _TABLE_SUFFIX (both backticked and unquoted wildcard syntax).
    const wildcard = await complete('SELECT * FROM `varia-alpha.analytics.events_*` e WHERE _T|', pseudoLookup)
    expect(wildcard.item('_TABLE_SUFFIX')).toMatchObject({ kind: 'column', detail: 'STRING · Pseudo-column · e' })
    const unquotedWildcard = await complete('SELECT e.| FROM analytics.events_* e', pseudoLookup)
    expect(unquotedWildcard.labels()).toEqual(['event_id', '_TABLE_SUFFIX'])
    expect(read('SELECT * FROM analytics.events_* |').site).toEqual({ kind: 'afterFromTable', hasAlias: false, inJoin: false })
    expect(read('SELECT * FROM analytics.events_* e |').site).toEqual({ kind: 'afterFromTable', hasAlias: true, inJoin: false })

    // Concrete shard does NOT get _TABLE_SUFFIX.
    const concrete = await complete('SELECT e.| FROM analytics.events_20261124 e', pseudoLookup)
    expect(concrete.labels()).toEqual(['event_id'])

    // Ingestion-time partitioned table gets _PARTITIONTIME and _PARTITIONDATE; column-partitioned `orders` does not.
    const ingest = await complete('SELECT l.| FROM analytics.ingest_logs l', pseudoLookup)
    expect(ingest.labels()).toEqual(['message', '_PARTITIONTIME', '_PARTITIONDATE'])
    expect(ingest.item('_PARTITIONTIME')?.detail).toBe('TIMESTAMP · Pseudo-column')
    expect(ingest.item('_PARTITIONDATE')?.detail).toBe('DATE · Pseudo-column')
    expect((await complete('SELECT o.| FROM sales.orders o')).labels()).not.toContain('_PARTITIONTIME')

    // External table gets _FILE_NAME (never _TABLE_SUFFIX, even with a wildcard-shaped name).
    const ext = await complete('SELECT x.| FROM analytics.gcs_ext x', pseudoLookup)
    expect(ext.labels()).toEqual(['raw_line', '_FILE_NAME'])
    expect(ext.item('_FILE_NAME')?.detail).toBe('STRING · Pseudo-column')
    const extWild = await complete('SELECT x.| FROM analytics.gcs_ext_* x', pseudoLookup)
    expect(extWild.labels()).toEqual(['raw_line', '_FILE_NAME'])

    // SELECT * in a CTE does not expand pseudo-columns.
    const cte = await complete('WITH c AS (SELECT * FROM analytics.events_*) SELECT c.| FROM c', pseudoLookup)
    expect(cte.labels()).toEqual(['event_id'])
  })

  it('qualifies ambiguous columns shared across joined sources while keeping unique columns bare', async () => {
    const joinLookup: IndexLookup = async requests => requests.map(request => {
      const key = request.path.join('.')
      if (key === 'varia-alpha.sales.customers') {
        return {
          state: 'ready',
          path: [...request.path],
          truncated: false,
          object: { name: 'customers', kind: 'bqTable', detailed: true },
          items: [
            { name: 'id', kind: 'bqColumn', type: 'INT64', nullable: false },
            { name: 'email', kind: 'bqColumn', type: 'STRING' }
          ]
        }
      }
      return answer(request)
    })

    const joined = await complete('SELECT id| FROM sales.orders o JOIN sales.customers c ON o.id = c.id', joinLookup)
    const idItems = joined.items.filter(item => item.filterText === 'id')
    expect(idItems.map(item => item.label)).toEqual(['o.id', 'c.id'])
    expect(idItems[0]).toMatchObject({ insertText: 'o.id', filterText: 'id', detail: 'INT64 · REQUIRED · orders' })
    expect(idItems[1]).toMatchObject({ insertText: 'c.id', filterText: 'id', detail: 'INT64 · REQUIRED · customers' })
    expect(idItems[0].sortText < idItems[1].sortText).toBe(true)
    // Unique columns stay unqualified.
    expect(joined.item('customer')).toMatchObject({ insertText: 'customer', detail: 'STRING · o' })
    expect(joined.item('email')).toMatchObject({ insertText: 'email', detail: 'STRING · c' })

    // Self-join qualifies every shared column under both aliases.
    const selfJoin = await complete('SELECT | FROM sales.orders a JOIN sales.orders b ON a.id = b.id')
    expect(selfJoin.items.filter(item => item.filterText === 'id').map(item => item.label)).toEqual(['a.id', 'b.id'])

    // Duplicate column names emitted by a single CTE/subquery do not trigger false ambiguous join qualification.
    const dupSingle = await complete('WITH j AS (SELECT o.id, d.id FROM sales.orders o JOIN sales.daily d ON TRUE) SELECT id| FROM j')
    expect(dupSingle.items.filter(item => item.filterText === 'id').map(item => item.label)).toEqual(['id'])
  })

  it('blocks direct field completion on ARRAY<STRUCT> with an UNNEST hint and ranks ARRAY columns first inside UNNEST()', async () => {
    const direct = await complete('SELECT o.items.| FROM sales.orders o')
    expect(direct.labels()).toEqual(['UNNEST(o.items)'])
    expect(direct.item('UNNEST(o.items)')).toMatchObject({
      insertText: 'UNNEST(o.items)',
      detail: 'ARRAY<STRUCT> · use UNNEST',
      additionalDeleteSpan: { start: 'SELECT '.length, end: 'SELECT o.items.'.length }
    })
    expect(direct.item('UNNEST(o.items)')?.filterText).toContain('sku')
    expect(direct.item('UNNEST(o.items)')?.documentation).toContain('sku')

    // Scalar arrays render their actual type (e.g. ARRAY<STRING>) instead of ARRAY<STRUCT>.
    const scalarArr = await complete('SELECT o.tags.| FROM sales.orders o')
    expect(scalarArr.labels()).toEqual(['UNNEST(o.tags)'])
    expect(scalarArr.item('UNNEST(o.tags)')?.detail).toBe('ARRAY<STRING> · use UNNEST')
    expect(scalarArr.item('UNNEST(o.tags)')?.documentation).toContain('`ARRAY<STRING>`')

    // Wide-table narrowing still blocks ARRAY<STRUCT> direct field access (aliased, typed, and bare).
    expect((await complete('SELECT w.zitems.| FROM `varia-wide.lab.wide` w')).labels()).toEqual(['UNNEST(w.zitems)'])
    expect((await complete('SELECT w.zitems.sk| FROM `varia-wide.lab.wide` w')).labels()).toEqual(['UNNEST(w.zitems)'])
    expect((await complete('SELECT zitems.| FROM `varia-wide.lab.wide`')).labels()).toEqual(['UNNEST(zitems)'])

    // Quoted member access blocks invalid fields without injecting UNNEST(...) inside backticks.
    expect((await complete('SELECT o.items.`sk|` FROM sales.orders o')).items).toEqual([])
    expect((await complete('SELECT `o.items.|` FROM sales.orders o')).items).toEqual([])

    // Chained access past an ARRAY<STRUCT> is also blocked with the array target.
    const chained = await complete('SELECT o.items.sku.| FROM sales.orders o')
    expect(chained.labels()).toEqual(['UNNEST(o.items)'])

    // Inside UNNEST(|), ARRAY columns rank ahead of scalar columns, aliases, functions and keywords.
    expect(read('SELECT * FROM sales.orders o, UNNEST(|)').site).toEqual({ kind: 'unnestArg' })
    const unnestBare = await complete('SELECT * FROM sales.orders o, UNNEST(|)')
    const colOrder = unnestBare.items.filter(item => item.kind === 'column').sort((a, b) => a.sortText.localeCompare(b.sortText)).map(item => item.label)
    expect(colOrder.slice(0, 2)).toEqual(['items', 'tags'])
    expect(unnestBare.item('items')!.sortText < unnestBare.item('id')!.sortText).toBe(true)
    expect(unnestBare.item('tags')!.sortText < unnestBare.item('customer')!.sortText).toBe(true)

    // Inside UNNEST(o.|), ARRAY columns on `o` also rank ahead of scalar columns; UNNEST(o.items.|) blocks without double-UNNEST.
    const unnestMember = await complete('SELECT * FROM sales.orders o, UNNEST(o.|)')
    const memberOrder = [...unnestMember.items].sort((a, b) => a.sortText.localeCompare(b.sortText)).map(item => item.label)
    expect(memberOrder.slice(0, 2)).toEqual(['items', 'tags'])
    expect((await complete('SELECT * FROM sales.orders o, UNNEST(o.items.|)')).items).toEqual([])
  })

  it('completes smart GoogleSQL context sites: CAST, date parts, @@system_vars, INFORMATION_SCHEMA, and function call snippets', async () => {
    // CAST / SAFE_CAST types + ARRAY<>/STRUCT<>/RANGE<> snippets (respecting `<` ahead).
    const cast = await complete('SELECT CAST(total AS |)')
    expect(cast.labels()).toHaveLength(25)
    expect(cast.item('INT64')).toMatchObject({ detail: 'Type', insertText: 'INT64' })
    expect(cast.item('ARRAY')).toMatchObject({ detail: 'ARRAY<T>', insertText: 'ARRAY<$0>', insertTextIsSnippet: true })
    expect(cast.item('STRUCT')).toMatchObject({ detail: 'STRUCT<...>', insertText: 'STRUCT<$0>', insertTextIsSnippet: true })
    expect(cast.item('RANGE')).toMatchObject({ detail: 'RANGE<T>', insertText: 'RANGE<$0>', insertTextIsSnippet: true })
    expect((await complete('SELECT CAST(total AS ARR|<INT64>)')).item('ARRAY')).toMatchObject({ insertText: 'ARRAY' })
    expect((await complete('SELECT CAST(total AS ARR|<INT64>)')).item('ARRAY')?.insertTextIsSnippet).toBeUndefined()
    expect(read('SELECT CAST(total AS ARRAY<|>)').site).toEqual({ kind: 'castType' })
    expect(read('SELECT CAST((total + 1) AS |)').site).toEqual({ kind: 'castType' })

    // EXTRACT and *_TRUNC / *_DIFF date parts per function (and not inside unclosed array literals).
    expect(read('SELECT EXTRACT(| FROM placed) FROM sales.orders').site).toEqual({ kind: 'datePart', functionName: 'EXTRACT' })
    expect(read('SELECT EXTRACT(YE| FROM placed) FROM sales.orders').site).toEqual({ kind: 'datePart', functionName: 'EXTRACT' })
    expect(read('SELECT EXTRACT(YEAR | FROM placed) FROM sales.orders').site).toEqual({ kind: 'expression' })
    expect(read('SELECT DATE_TRUNC(placed, |) FROM sales.orders').site).toEqual({ kind: 'datePart', functionName: 'DATE_TRUNC' })
    expect(read('SELECT DATE_TRUNC([d1, d2][OFFSET(0)], |)').site).toEqual({ kind: 'datePart', functionName: 'DATE_TRUNC' })
    expect(read('SELECT DATE_TRUNC(d, [1, |])').site).toEqual({ kind: 'expression' })
    expect(read('SELECT SAFE.DATE_TRUNC(placed, MO|) FROM sales.orders').site).toEqual({ kind: 'datePart', functionName: 'DATE_TRUNC' })
    expect(read('SELECT TIMESTAMP_TRUNC(placed, DAY, |) FROM sales.orders').site).toEqual({ kind: 'expression' })
    expect(read('SELECT DATE_DIFF(d1, d2, |)').site).toEqual({ kind: 'datePart', functionName: 'DATE_DIFF' })
    expect(read('SELECT TIME_TRUNC(t, |)').site).toEqual({ kind: 'datePart', functionName: 'TIME_TRUNC' })
    expect(read('SELECT TIME_DIFF(t1, t2, |)').site).toEqual({ kind: 'datePart', functionName: 'TIME_DIFF' })
    expect(read('SELECT DATETIME_TRUNC(dt, |)').site).toEqual({ kind: 'datePart', functionName: 'DATETIME_TRUNC' })
    expect(read('SELECT DATETIME_DIFF(dt1, dt2, |)').site).toEqual({ kind: 'datePart', functionName: 'DATETIME_DIFF' })
    expect(read('SELECT TIMESTAMP_DIFF(ts1, ts2, |)').site).toEqual({ kind: 'datePart', functionName: 'TIMESTAMP_DIFF' })

    const dateTruncParts = await complete('SELECT DATE_TRUNC(placed, |) FROM sales.orders')
    expect(dateTruncParts.labels()).toEqual(['DAY', 'WEEK', 'ISOWEEK', 'MONTH', 'QUARTER', 'YEAR', 'ISOYEAR'])
    expect(dateTruncParts.labels()).not.toContain('HOUR')
    const timeTruncParts = await complete('SELECT TIME_TRUNC(t, |)')
    expect(timeTruncParts.labels()).toEqual(['MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR'])
    expect(timeTruncParts.item('HOUR')?.detail).toBe('Time part')
    const extractParts = await complete('SELECT EXTRACT(| FROM placed) FROM sales.orders')
    expect(extractParts.labels()).toEqual(expect.arrayContaining(['YEAR', 'MONTH', 'DAY', 'DAYOFWEEK', 'HOUR', 'DATE', 'TIME']))

    // @@ system variables (top-level and dotted namespaces); single `@` and triple `@@@` stay quiet.
    expect(read('SELECT @|').site).toEqual({ kind: 'none' })
    expect(read('SELECT @@@|').site).toEqual({ kind: 'none' })
    expect(read('SELECT @@|')).toMatchObject({ site: { kind: 'systemVar' }, word: { start: 7, end: 9, typed: '@@' } })
    expect(read('SELECT @@proj|')).toMatchObject({ site: { kind: 'systemVar' }, word: { start: 7, end: 13, typed: '@@proj' } })
    expect(read('SELECT @@script.|')).toMatchObject({ site: { kind: 'systemVar', qualifier: ['script'] }, word: { typed: '' } })
    expect(read('SELECT @@script.by|')).toMatchObject({ site: { kind: 'systemVar', qualifier: ['script'] }, word: { typed: 'by' } })

    const sysAll = await complete('SELECT @@|')
    expect(sysAll.labels()).toEqual(expect.arrayContaining(['@@project_id', '@@dataset_id', '@@script.bytes_billed', '@@time_zone', '@@error.message']))
    expect(sysAll.item('@@project_id')).toMatchObject({ insertText: '@@project_id', detail: 'STRING · Read-only' })
    const sysScript = await complete('SELECT @@script.|')
    expect(sysScript.labels()).toContain('bytes_billed')
    expect(sysScript.labels()).not.toContain('@@project_id')
    expect(sysScript.item('bytes_billed')?.insertText).toBe('bytes_billed')
    const sysError = await complete('SELECT @@error.|')
    expect(sysError.labels()).toEqual(expect.arrayContaining(['message', 'stack_trace', 'statement_text']))

    // INFORMATION_SCHEMA views: dataset scope vs region scope vs unqualified.
    expect(read('SELECT * FROM sales.INFORMATION_SCHEMA.|').site).toEqual({ kind: 'infoSchema', qualifier: ['sales'] })
    expect(read('SELECT * FROM `varia-alpha.region-us`.INFORMATION_SCHEMA.|').site).toEqual({ kind: 'infoSchema', qualifier: ['varia-alpha', 'region-us'] })
    expect(read('SELECT * FROM `varia-alpha.region-us.INFORMATION_SCHEMA.JO|`').site).toEqual({ kind: 'infoSchema', qualifier: ['varia-alpha', 'region-us'] })

    const dsInfo = await complete('SELECT * FROM sales.INFORMATION_SCHEMA.|')
    expect(dsInfo.labels('view')).toEqual(expect.arrayContaining(['TABLES', 'COLUMNS', 'COLUMN_FIELD_PATHS', 'PARTITIONS', 'VIEWS', 'ROUTINES']))
    expect(dsInfo.item('PARTITIONS')?.detail).toBe('Dataset view')
    for (const regionOnly of ['JOBS_BY_PROJECT', 'SCHEMATA', 'TABLE_STORAGE', 'TABLE_STORAGE_TIMELINE', 'SEARCH_INDEXES', 'SEARCH_INDEX_COLUMNS', 'VECTOR_INDEXES', 'OBJECT_PRIVILEGES']) {
      expect(dsInfo.labels('view'), regionOnly).not.toContain(regionOnly)
    }

    const regionInfo = await complete('SELECT * FROM `varia-alpha.region-us`.INFORMATION_SCHEMA.|')
    expect(regionInfo.labels('view')).toEqual(expect.arrayContaining(['JOBS_BY_PROJECT', 'SCHEMATA', 'TABLES', 'COLUMNS', 'TABLE_STORAGE', 'TABLE_STORAGE_TIMELINE', 'SEARCH_INDEXES', 'VECTOR_INDEXES', 'OBJECT_PRIVILEGES']))
    expect(regionInfo.labels('view')).not.toContain('PARTITIONS')
    expect(regionInfo.item('JOBS_BY_PROJECT')?.detail).toBe('Region view')
    expect(regionInfo.item('OBJECT_PRIVILEGES')?.detail).toBe('Region view')

    const bareInfo = await complete('SELECT * FROM INFORMATION_SCHEMA.|')
    expect(bareInfo.labels('view')).toEqual(expect.arrayContaining(['TABLES', 'JOBS_BY_PROJECT']))
    expect(bareInfo.item('TABLES')!.sortText < bareInfo.item('JOBS_BY_PROJECT')!.sortText).toBe(true)

    // Non-niladic functions & routines insert NAME($0) + triggerParameterHints; niladic and paren-ahead stay bare.
    const expr = await complete('SELECT | FROM sales.orders')
    expect(expr.item('DATE_TRUNC')).toMatchObject({ insertText: 'DATE_TRUNC($0)', insertTextIsSnippet: true, triggerParameterHints: true })
    expect(expr.item('CURRENT_TIMESTAMP')).toMatchObject({ insertText: 'CURRENT_TIMESTAMP' })
    expect(expr.item('CURRENT_TIMESTAMP')?.insertTextIsSnippet).toBeUndefined()
    expect(expr.item('CURRENT_DATE')?.triggerParameterHints).toBeUndefined()

    const existingCall = await complete('SELECT DATE_TR|(placed, DAY) FROM sales.orders')
    expect(existingCall.item('DATE_TRUNC')).toMatchObject({ insertText: 'DATE_TRUNC' })
    expect(existingCall.item('DATE_TRUNC')?.insertTextIsSnippet).toBeUndefined()
    expect(existingCall.item('DATE_TRUNC')?.triggerParameterHints).toBeUndefined()

    const namespaced = await complete('SELECT NET.|')
    expect(namespaced.item('HOST')).toMatchObject({ insertText: 'HOST($0)', insertTextIsSnippet: true, triggerParameterHints: true })
    const routineCall = await complete('CALL sales.|')
    expect(routineCall.item('to_cents')).toMatchObject({ insertText: 'to_cents($0)', insertTextIsSnippet: true, triggerParameterHints: true })
    const routineParenAhead = await complete('CALL sales.to_c|(10)')
    expect(routineParenAhead.item('to_cents')).toMatchObject({ insertText: 'to_cents' })
    expect(routineParenAhead.item('to_cents')?.insertTextIsSnippet).toBeUndefined()
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

  it('supports 3-level BigQuery hover: Project (tier & counts), Dataset (location & counts), and Table (description & nested STRUCT field counts)', async () => {
    const richLookup: IndexLookup = async requests => requests.map(request => {
      const key = request.path.join('.')
      if (key === '') {
        const all: LanguageLookupItem[] = [
          { name: 'varia-alpha', kind: 'bqProject', tier: 'billing' },
          { name: 'dw-shared', kind: 'bqProject', tier: 'starred' },
          { name: 'org-raw', kind: 'bqProject', tier: 'discovered', namesOnly: true, detail: 'names' }
        ]
        const filtered = request.prefix ? all.filter(i => request.exact ? i.name === request.prefix : i.name.startsWith(request.prefix!)) : all
        return { state: 'ready', path: [], items: filtered, truncated: false }
      }
      if (key === 'dw-shared') {
        const all: LanguageLookupItem[] = [
          { name: 'gold', kind: 'bqDataset', detail: 'US' },
          { name: 'silver', kind: 'bqDataset', detail: 'EU' }
        ]
        const filtered = request.prefix ? all.filter(i => request.exact ? i.name === request.prefix : i.name.startsWith(request.prefix!)) : all
        return { state: 'ready', path: ['dw-shared'], items: filtered, truncated: false }
      }
      if (key === 'org-raw') return { state: 'partial', path: ['org-raw'], items: [{ name: 'landing', kind: 'bqDataset' }], truncated: false }
      if (key === 'dw-shared.gold') {
        return {
          state: 'ready', path: ['dw-shared', 'gold'], truncated: false,
          items: [
            { name: 'orders', kind: 'bqTable' },
            { name: 'customers', kind: 'bqTable' },
            { name: 'daily_view', kind: 'bqView' },
            { name: 'to_cents', kind: 'bqRoutine' }
          ]
        }
      }
      if (key === 'dw-shared.gold.orders') {
        return {
          state: 'ready', path: ['dw-shared', 'gold', 'orders'], truncated: false,
          object: {
            name: 'orders', kind: 'bqTable', detailed: true, rows: 1_234_567, bytes: 5 * 1024 ** 3,
            partitioning: 'DAY on placed', clustering: 'customer_id',
            description: 'Core ecommerce order ledger | updated hourly.'
          },
          items: [
            { name: 'id', kind: 'bqColumn', type: 'INT64', nullable: false },
            { name: 'address', kind: 'bqColumn', type: 'STRUCT', subtype: 'struct', nullable: true },
            { name: 'address.city', kind: 'bqColumn', type: 'STRING', nullable: true },
            { name: 'address.state', kind: 'bqColumn', type: 'STRING', nullable: true },
            { name: 'address.geo', kind: 'bqColumn', type: 'GEOGRAPHY', nullable: true }
          ]
        }
      }
      return { state: 'absent', path: [...request.path], items: [], truncated: false }
    })

    const hoverRich = async (source: string) => {
      const { text, offset } = at(source)
      const found = readGoogleSqlHover(text, offset)
      return found && hoverFromIndex(found, dialect, richLookup)
    }

    // Level 1: Project hover (★ Starred + discovered names-only)
    const projHover = await hoverRich('SELECT * FROM `dw-sh|ared.gold.orders`')
    expect(projHover?.markdown).toContain('**dw\\-shared** · ★ Starred project')
    expect(projHover?.markdown).toContain('2 datasets')
    expect(projHover?.markdown).toContain('gold, silver')
    expect(projHover?.markdown).toContain('Ctrl\\+Shift\\+R')

    const cappedProjHover = await hoverRich('SELECT * FROM `org-r|aw.landing.events`')
    expect(cappedProjHover?.markdown).toContain('**org\\-raw** · Discovered project')
    expect(cappedProjHover?.markdown).toContain('Names only (memory cap)')
    expect(cappedProjHover?.markdown).toContain('Star in Object Explorer')

    // Unknown project returns undefined
    expect(await hoverRich('SELECT * FROM `no-such-pr|oj.ds.tbl`')).toBeUndefined()

    // Level 2: Dataset hover (location + counts by kind)
    const dsHover = await hoverRich('SELECT * FROM `dw-shared.go|ld.orders`')
    expect(dsHover?.markdown).toContain('**gold** · Dataset · US · ★ Starred')
    expect(dsHover?.markdown).toContain('2 tables · 1 view · 1 routine')
    expect(dsHover?.markdown).toContain('orders, customers, daily\\_view, to\\_cents')

    // Level 3: Table hover (PR #738 tier + escaped description + nested STRUCT field count summary)
    const tblHover = await hoverRich('SELECT * FROM `dw-shared.gold.ord|ers`')
    expect(tblHover?.markdown).toContain('**orders** · Table · ★ Starred')
    expect(tblHover?.markdown).toContain('Core ecommerce order ledger \\| updated hourly\\.')
    expect(tblHover?.markdown).toContain('| address | STRUCT · 3 fields: city, state, geo |')
    expect(tblHover?.markdown).not.toContain('address\\.city')
  })

  it('formats SQL Server IndexLookup summaries with PK/UK/Identity markers, indexes, and foreign keys', () => {
    const md = sqlObjectMarkdown(
      ['SalesDB', 'dbo', 'Orders'],
      { name: 'Orders', kind: 'table', detailed: true },
      [
        { name: 'OrderId', kind: 'column', type: 'int', nullable: false, detail: 'PK · IDENTITY' },
        { name: 'CustomerId', kind: 'column', type: 'int', nullable: false, detail: 'FK' },
        { name: 'Code|1', kind: 'column', type: 'nvarchar(40)', nullable: false, detail: 'UK' },
        { name: 'PK_Orders', kind: 'key', subtype: 'primary', detail: '(OrderId)' },
        { name: 'UQ_Orders_Code', kind: 'key', subtype: 'unique', detail: '(Code|1)' },
        { name: 'IX_Orders_Customer', kind: 'index', subtype: 'nonclustered', detail: '(CustomerId)' },
        { name: 'FK_Orders_Customers', kind: 'foreignKey', subtype: 'outgoing', detail: '(CustomerId) → dbo.Customers(Id)' },
        { name: 'FK_Lines_Orders', kind: 'foreignKey', subtype: 'incoming', detail: 'dbo.OrderLines(OrderId) → (OrderId)' }
      ],
      false
    )
    expect(md).toContain('**dbo\\.Orders** · Table')
    expect(md).toContain('\\[SalesDB\\]\\.\\[dbo\\]\\.\\[Orders\\]')
    expect(md).toContain('PK \\(OrderId\\)')
    expect(md).toContain('1 unique key')
    expect(md).toContain('1 index')
    expect(md).toContain('| OrderId | int · NOT NULL · PK · IDENTITY |')
    expect(md).toContain('| Code\\|1 | nvarchar\\(40\\) · NOT NULL · UK |')
    expect(md).toContain('**Keys & Indexes**')
    expect(md).toContain('**Foreign Keys**')
    expect(md).toContain('→ \\(CustomerId\\) → dbo\\.Customers\\(Id\\)')
    expect(md).toContain('← dbo\\.OrderLines\\(OrderId\\) → \\(OrderId\\)')
  })
})

describe('Go To Definition from the index', () => {
  const definition = async (source: string, defaults = dialect) => {
    const { text, offset } = at(source)
    const found = readGoogleSqlHover(text, offset)
    return found && definitionFromIndex(found, defaults, fakeLookup())
  }
  const daily = { path: ['varia-alpha', 'sales', 'daily'], kind: 'bqView' }

  it('finds a view where a table is written, through the default project and dataset as completion does', async () => {
    expect(await definition('SELECT * FROM dai|ly')).toMatchObject(daily)
    expect(await definition('SELECT * FROM sales.da|ily d')).toMatchObject(daily)
    expect(await definition('SELECT * FROM `varia-alpha.sales.da|ily`')).toMatchObject(daily)
    expect(await definition('SELECT * FROM varia-alpha.sales.dai|ly')).toMatchObject(daily)
    const numericProjectLookup: IndexLookup = async requests => requests.map(request => {
      const key = request.path.join('.')
      if (key === 'my-project-123456.2024_sales.orders') {
        return { state: 'ready', path: [...request.path], truncated: false, items: [], object: { name: 'orders', kind: 'bqTable', detailed: false } }
      }
      if (key === 'my-project-123456.2024_sales') return { state: 'ready', path: [...request.path], truncated: false, items: [{ name: 'orders', kind: 'bqTable' }] }
      if (key === 'my-project-123456') return { state: 'ready', path: [...request.path], truncated: false, items: [{ name: '2024_sales', kind: 'bqDataset' }] }
      return { state: 'ready', path: [...request.path], truncated: false, items: [] }
    })
    const numericProj = at('SELECT * FROM my-project-123456.2024_sales.ord|ers')
    expect(await definitionFromIndex(readGoogleSqlHover(numericProj.text, numericProj.offset)!, dialect, numericProjectLookup)).toMatchObject({
      path: ['my-project-123456', '2024_sales', 'orders'],
      kind: 'bqTable'
    })
    expect(await definition('SELECT * FROM census.peo|ple', googleSqlDialect({ project: 'varia-beta' }))).toMatchObject({ path: ['varia-beta', 'census', 'people'], kind: 'bqTable' })
    // Without a default dataset a bare name names nothing.
    expect(await definition('SELECT * FROM dai|ly', googleSqlDialect({ project: 'varia-alpha' }))).toBeUndefined()
    expect(await definition('SELECT * FROM sales.nob|ody')).toBeUndefined()
  })

  it('finds a routine where it is called, never a built-in function or a table called as one', async () => {
    expect(await definition('SELECT sales.to_ce|nts(price) FROM sales.orders')).toMatchObject({ path: ['varia-alpha', 'sales', 'to_cents'], kind: 'bqRoutine', subtype: 'scalar' })
    expect(await definition('SELECT COU|NT(*) FROM sales.orders')).toBeUndefined()
    expect(await definition('SELECT NET.HO|ST(url) FROM sales.orders')).toBeUndefined()
    expect(await definition('SELECT sales.dai|ly(1) FROM sales.orders')).toBeUndefined()
  })

  it('goes from an alias or a column to its object, and finds nothing for a WITH query', async () => {
    expect(await definition('SELECT |d.day FROM sales.daily d')).toMatchObject(daily)
    expect(await definition('SELECT d.d|ay FROM sales.daily d')).toMatchObject(daily)
    expect(await definition('SELECT d|ay FROM sales.daily')).toMatchObject(daily)
    expect(await definition('WITH daily AS (SELECT 1 AS x) SELECT * FROM dai|ly')).toBeUndefined()
    expect(await definition('SELECT x.|a FROM (SELECT 1 AS a) x')).toBeUndefined()
  })

  it('tells an index that could not answer from one that holds no such object', async () => {
    const { text, offset } = at('SELECT * FROM dai|ly')
    await expect(definitionFromIndex(readGoogleSqlHover(text, offset)!, dialect, async () => undefined)).rejects.toBeInstanceOf(IndexUnavailableError)
    const column = at('SELECT d.d|ay FROM sales.daily d')
    await expect(definitionFromIndex(readGoogleSqlHover(column.text, column.offset)!, dialect, async () => undefined)).rejects.toBeInstanceOf(IndexUnavailableError)
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

  it('drops stale in-flight answers when clear() runs before ask() resolves', async () => {
    let resolveAsk!: (value: LanguageLookupResult) => void
    let calls = 0
    const cache = new LookupCache(async () => {
      calls++
      if (calls === 1) return new Promise<LanguageLookupResult>(resolve => { resolveAsk = resolve })
      return result([answer({ path: ['varia-alpha', 'sales'] })])
    })
    const pending = cache.lookup([{ path: ['varia-alpha', 'sales'] }])
    cache.clear()
    resolveAsk(result([answer({ path: ['varia-alpha', 'sales'], prefix: '' })]))
    expect(await pending).toBeDefined()
    expect(cache.index).toBeUndefined()
    // Next lookup must hit ask() again rather than serving the pre-clear answer.
    await cache.lookup([{ path: ['varia-alpha', 'sales'] }])
    expect(calls).toBe(2)
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

    // F2 item and object metadata extensions & strict zod bounds.
    const projectItem = { name: 'varia-alpha', kind: 'bqProject', tier: 'billing', namesOnly: true, partial: false }
    const datasetItem = { name: 'sales', kind: 'bqDataset', partial: true }
    const tableItem = {
      name: 'orders', kind: 'bqTable', description: 'd'.repeat(4096), partial: false,
      rows: 0, bytes: 1024, partitioning: 'DAY on placed', clustering: 'customer'
    }
    const richObject = {
      name: 'orders', kind: 'bqTable', detailed: true, rows: 123, bytes: 456,
      partitioning: 'DAY on placed', clustering: 'customer', signature: '()', description: 'd'.repeat(4096),
      columnsCut: true, modified: '2026-01-01T00:00:00Z'
    }
    expect(languageLookupResultSchema.safeParse({
      index: 'ready',
      answers: [{ state: 'ready', path: ['varia-alpha', 'sales', 'orders'], items: [projectItem, datasetItem, tableItem], truncated: false, object: richObject }]
    }).success).toBe(true)

    const validResult = (items: unknown[], object?: unknown) => languageLookupResultSchema.safeParse({
      index: 'ready',
      answers: [{ state: 'ready', path: [], items, truncated: false, ...(object ? { object } : {}) }]
    }).success
    expect(validResult([{ name: 'p', kind: 'bqProject', tier: 'public' }])).toBe(false)
    expect(validResult([{ name: 'p', kind: 'bqProject', namesOnly: 'yes' }])).toBe(false)
    expect(validResult([{ name: 'p', kind: 'bqProject', partial: 1 }])).toBe(false)
    expect(validResult([{ name: 't', kind: 'bqTable', rows: -1 }])).toBe(false)
    expect(validResult([{ name: 't', kind: 'bqTable', bytes: 1.5 }])).toBe(false)
    expect(validResult([{ name: 't', kind: 'bqTable', partitioning: 'p'.repeat(4097) }])).toBe(false)
    expect(validResult([{ name: 't', kind: 'bqTable', clustering: 'c'.repeat(4097) }])).toBe(false)
    expect(validResult([{ name: 't', kind: 'bqTable', extra: true }])).toBe(false)
    expect(validResult([item], { name: 'orders', kind: 'bqTable', detailed: true, description: 'd'.repeat(4097) })).toBe(false)
    expect(validResult([item], { name: 'orders', kind: 'bqTable', detailed: true, rows: -1 })).toBe(false)
    expect(validResult([item], { name: 'orders', kind: 'bqTable', detailed: true, extra: true })).toBe(false)
  })

  it('handles every CompletionSite contract variant in completeFromIndex', async () => {
    const emptyScope = { sources: [], ctes: [] }
    const emptyWord = { start: 0, end: 0, typed: '', quoted: false }
    const sites: CompletionSite[] = [
      { kind: 'afterFromTable', hasAlias: false, inJoin: true },
      { kind: 'statementStart' },
      { kind: 'castType' },
      { kind: 'datePart', functionName: 'DATE_TRUNC' },
      { kind: 'systemVar', qualifier: ['script'] },
      { kind: 'infoSchema', qualifier: ['varia-alpha', 'sales'] },
      { kind: 'joinCondition', clause: 'on' },
      { kind: 'unnestArg' }
    ]
    for (const site of sites) {
      const list = await completeFromIndex({ site, scope: emptyScope, word: emptyWord }, dialect, async () => [])
      expect(list.incomplete).toBe(false)
      if (site.kind === 'systemVar') expect(list.items.some(entry => entry.label === 'bytes_billed')).toBe(true)
      else if (site.kind === 'infoSchema') expect(list.items.some(entry => entry.label === 'TABLES')).toBe(true)
      else expect(list.items.some(entry => entry.kind === 'keyword')).toBe(true)
    }
  })

  it('keeps its limits in step with the backend’s EditorLookupLimits', () => {
    const source = readFileSync('backend/Varia.Backend/Search/EditorLookup.cs', 'utf8')
    const declared = /class EditorLookupLimits\s*\{\s*public const int ([^;]+);/.exec(source)![1]
    const limits = Object.fromEntries(declared.split(',').map(entry => entry.split('=').map(part => part.trim())).map(([name, value]) => [name, Number(value)]))
    expect(limits).toEqual({ Requests: languageLookupLimits.requests, Segments: languageLookupLimits.segments, SegmentChars: languageLookupLimits.segmentChars,
      PrefixChars: languageLookupLimits.prefixChars, Items: languageLookupLimits.items, DefaultItems: languageLookupLimits.defaultItems, TotalItems: languageLookupLimits.totalItems,
      TotalBytes: languageLookupLimits.totalBytes })
  })
})
