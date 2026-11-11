import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { planDocumentSchema, planNodeSchema, type PlanNode, type PlanStatement } from '../src/shared/plans'
import { comparePlans, metricDelta, pairOperators, propertyDifferences } from '../src/renderer/src/plans/comparison'
import { comparisonChoices, documentInput, snapshotInput } from '../src/renderer/src/plans/comparison-inputs'
import ComparisonDetails from '../src/renderer/src/plans/ComparisonDetails'
import { RetainedPlansService } from '../src/renderer/src/plans/RetainedPlansService'

const node = (id: string, op = 'Seek', object = 'dbo.T', parentId: string | null = null): PlanNode => planNodeSchema.parse({ id, nodeId: id, physicalOp: op, logicalOp: 'Get', object, parentId, warnings: [], properties: [] })
const statement = (id: string, text = 'SELECT name FROM dbo.T', nodes = [node(id + 'n')], queryHash?: string): PlanStatement => ({ id, text, type: 'SELECT', nodes, queryHash, estimatedCost: null, warnings: [] })
const paired = (pairs: ReturnType<typeof pairOperators>) => pairs.filter(pair => pair.status === 'paired').map(pair => [pair.left!.id, pair.right!.id])

describe('conservative deterministic matching', () => {
  it('pairs exact text across reordering, matches a unique optimizer hash, and leaves materially different SQL separate', () => {
    const left = [statement('a'), statement('b', 'SELECT @p', [], 'hash'), statement('c', 'SELECT unrelated')]
    const right = [statement('d', 'SELECT @q', [], 'hash'), statement('e'), statement('f', 'DELETE dbo.T')]
    expect(comparePlans(left, right).map(pair => [pair.left?.id, pair.right?.id, pair.status])).toEqual([
      ['a', 'e', 'paired'], ['b', 'd', 'paired'], ['c', undefined, 'left-only'], [undefined, 'f', 'right-only']
    ])
    expect(comparePlans(left, right)).toEqual(comparePlans(left, right))
    expect(comparePlans(right, left).filter(p => p.status === 'paired').map(p => [p.right!.id, p.left!.id]).sort()).toEqual([['a', 'e'], ['b', 'd']])
  })
  it('does not pair repeated statements by ordinal, statement ID or repeated query hash', () => {
    const left = [statement('a'), statement('b')], right = [statement('a'), statement('b')]
    expect(comparePlans(left, right).map(p => p.status)).toEqual(['ambiguous', 'ambiguous', 'ambiguous', 'ambiguous'])
    expect(comparePlans([statement('same', 'SELECT 1')], [statement('same', 'SELECT 2')]).every(p => p.status !== 'paired')).toBe(true)
    expect(comparePlans([statement('a', '', [], 'h'), statement('b', '', [], 'h')], [statement('c', '', [], 'h')]).every(p => p.status === 'ambiguous')).toBe(true)
    // SQL whitespace and case inside literals are significant; matching never folds them away.
    expect(comparePlans([statement('a', "SELECT 'a  b'")], [statement('b', "SELECT 'A b'")]).every(p => p.status !== 'paired')).toBe(true)
  })
  it('pairs changed physical operators by unique logical operation/object, preserving structural and property differences', () => {
    const left = [node('parent', 'Filter', '', null), node('seek', 'Index Seek', 'T', 'parent')]
    const right = [node('scan', 'Table Scan', 'T', null), node('other', 'Sort', '', 'scan')]
    const pair = pairOperators(left, right).find(p => p.left?.id === 'seek')!
    expect(pair).toMatchObject({ right: { id: 'scan' }, status: 'paired', structural: true, propertiesChanged: true })
    expect(left[1].parentId).toBe('parent')
  })
  it('leaves ambiguous self joins unpaired, even when runtime counters and NodeIds happen to agree', () => {
    expect(paired(pairOperators([node('0'), node('1')], [node('0'), node('1')]))).toEqual([])
    expect(pairOperators([node('0'), node('1')], [node('0'), node('1')]).every(p => p.status === 'ambiguous')).toBe(true)
  })
  it('disambiguates repeated operators only with uniquely paired parents or predicates', () => {
    const left = [node('p', 'Join', 'A'), node('q', 'Join', 'B'), node('a', 'Seek', 'T', 'p'), node('b', 'Seek', 'T', 'q')]
    const right = [node('r', 'Join', 'B'), node('s', 'Join', 'A'), node('c', 'Seek', 'T', 'r'), node('d', 'Seek', 'T', 's')]
    expect(paired(pairOperators(left, right))).toEqual([['p', 's'], ['q', 'r'], ['a', 'd'], ['b', 'c']])
  })
  it('marks sibling order changes and never uses them to guess repeated siblings', () => {
    const left = [node('a', 'Seek', 'A'), node('b', 'Seek', 'B')], right = [node('c', 'Seek', 'B'), node('d', 'Seek', 'A')]
    expect(pairOperators(left, right).every(p => p.structural)).toBe(true)
  })
  it('does not call renumbered node identities or reordered raw attributes a property change', () => {
    const left = { ...node('a'), properties: [{ name: 'RelOp.NodeId', value: '1' }, { name: 'X', value: 'x' }, { name: 'Y', value: 'y' }] }
    const right = { ...node('b'), properties: [{ name: 'Y', value: 'y' }, { name: 'X', value: 'x' }, { name: 'RelOp.NodeId', value: '20' }] }
    expect(pairOperators([left], [right])[0]).toMatchObject({ status: 'paired', structural: false, propertiesChanged: false })
  })
  it('does not assert a structural move when the paired operators have ambiguous parents', () => {
    const left = [node('p', 'Join', ''), node('q', 'Join', ''), node('a', 'Seek', 'A', 'p')]
    const right = [node('r', 'Join', ''), node('s', 'Join', ''), node('b', 'Seek', 'A', 'r')]
    expect(pairOperators(left, right).find(p => p.left?.id === 'a')).toMatchObject({ status: 'paired', structural: false, structureUnknown: true })
  })
  it('keeps wide 10,000-operator ambiguity linear in output and enforces independent input limits', () => {
    const left = Array.from({ length: 10_000 }, (_, i) => node('l' + i)), right = Array.from({ length: 10_000 }, (_, i) => node('r' + i))
    const result = comparePlans([statement('l', 'SELECT 1', left)], [statement('r', 'SELECT 1', right)])
    expect(result[0].operators).toHaveLength(20_000)
    expect(result[0].operators.every(p => p.status === 'ambiguous')).toBe(true)
    expect(() => comparePlans([statement('x', '', [...left, node('too-many')])], [])).toThrow('limit')
  })
  it('rejects duplicate normalized identities before they can alias lookup scopes or repeat a parent group', () => {
    expect(() => pairOperators([node('same'), node('same')], [])).toThrow('duplicate operator identities')
    expect(() => comparePlans([statement('same', '', []), statement('same', '', [])], [])).toThrow('duplicate statement identities')
    expect(() => comparePlans([statement('a', '', [node('same')]), statement('b', '', [node('same')])], [])).toThrow('duplicate operator identities')
  })
})

describe('shortened fields are never complete evidence', () => {
  const long = 'SELECT N\'' + 'x'.repeat(16_373) + '…'
  it('does not pair statements on text the parser shortened, and still pairs them on a complete unique hash', () => {
    const cut = (id: string, hash?: string): PlanStatement => ({ ...statement(id, long, [node(id + 'n')], hash), textShortened: true })
    const different = comparePlans([cut('a', '0x1111111111111111')], [cut('b', '0x2222222222222222')])
    expect(different.map(pair => pair.status)).toEqual(['left-only', 'right-only'])
    expect(different[0].reason).toContain('shortened')
    expect(comparePlans([cut('a')], [cut('b')]).every(pair => pair.status !== 'paired')).toBe(true)
    // One complete side is not enough: its text only equals the other side's retained prefix.
    expect(comparePlans([cut('a')], [statement('b', long)]).every(pair => pair.status !== 'paired')).toBe(true)
    expect(comparePlans([cut('a', '0x1111111111111111')], [cut('b', '0x1111111111111111')])[0]).toMatchObject({ status: 'paired', reason: 'Unique query hash and type (optimizer identity)' })
    expect(comparePlans([statement('a', long)], [statement('b', long)])[0]).toMatchObject({ status: 'paired', reason: 'Unique exact statement text and type' })
  })
  it('does not pair operators on shortened identity or predicates, and reports agreeing shortened properties as unverified', () => {
    const cutObject = (id: string) => ({ ...node(id, 'Seek', 'dbo.' + 't'.repeat(507) + '…'), identityShortened: true })
    expect(pairOperators([cutObject('a')], [cutObject('b')]).map(pair => pair.status)).toEqual(['left-only', 'right-only'])
    const cutDetails = (id: string) => ({ ...node(id), detailsShortened: true, properties: [{ name: 'Predicate', value: 'x'.repeat(1023) + '…' }] })
    expect(pairOperators([cutDetails('a')], [cutDetails('b')])[0]).toMatchObject({ status: 'paired', reason: 'Unique physical/logical operator and object', propertiesChanged: false, propertiesUnverified: true })
    expect(pairOperators([cutDetails('a')], [{ ...cutDetails('b'), properties: [] }])[0]).toMatchObject({ propertiesChanged: true })
    expect(pairOperators([node('a')], [node('b')])[0]).not.toHaveProperty('propertiesUnverified')
    expect(planNodeSchema.parse(cutDetails('a')).detailsShortened).toBe(true)
  })
  it('never calls shortened parameter values or statement text the same, while complete values still compare exactly', () => {
    const diagnostics = (compiledValue: string, runtimeValue: string) => ({ degreeOfParallelism: null, memoryGrant: [{ name: 'Future', value: compiledValue }], warnings: [], missingIndexes: [],
      parameters: [{ name: '@p', dataType: 'nvarchar(max)', compiledValue, runtimeValue }] })
    const cut = 'N\'' + 'x'.repeat(4093) + '…', whole = 'y'.repeat(5000)
    const render = (left: PlanStatement, right: PlanStatement) => renderToStaticMarkup(createElement(ComparisonDetails, { leftStatement: left, rightStatement: right }))
    const row = (html: string, name: string) => html.slice(html.indexOf(name), html.indexOf('</tr>', html.indexOf(name)))
    const shortenedSide = (id: string): PlanStatement => ({ ...statement(id, long), textShortened: true, detailsShortened: true, diagnostics: diagnostics(cut, whole) })
    const html = render(shortenedSide('l'), shortenedSide('r'))
    for (const name of ['Statement text', 'Parameter @p · compiled', 'Memory grant · Future']) {
      expect(row(html, name)).toContain('equality unverified'); expect(row(html, name)).not.toContain('>Same<')
    }
    // Complete retained values in the same statement are exact, even where only the comparison view shortens their display.
    expect(row(html, 'Parameter @p · runtime')).toContain('shortened in comparison; inspect frozen XML')
    expect(row(html, 'Parameter @p · runtime')).toContain('>Same<')
    expect(row(html, 'Parameter @p · type')).toContain('>Same<')
    // A list in a shortened owner may have lost entries.
    expect(row(html, 'Warning attributes')).toContain('equality unverified')
    expect(row(html, 'Parameter availability')).toContain('equality unverified')
    const complete = render({ ...statement('l', whole), diagnostics: diagnostics(whole, whole) }, { ...statement('r', whole), diagnostics: diagnostics(whole, whole) })
    for (const name of ['Statement text', 'Parameter @p · compiled', 'Warning attributes']) expect(row(complete, name)).toContain('>Same<')
    expect(complete).not.toContain('equality unverified')
    expect(row(render(shortenedSide('l'), { ...shortenedSide('r'), diagnostics: diagnostics(cut + 'B', whole) }), 'Parameter @p · compiled')).toContain('Changed / availability differs')
  })
})

describe('delta and diagnostic availability', () => {
  it('defines measured zeros, a zero baseline, subtraction direction, invalid values and overflow', () => {
    expect(metricDelta(0, 0)).toMatchObject({ absolute: 0, percent: 0, zeroBaseline: false })
    expect(metricDelta(0, 10)).toMatchObject({ absolute: 10, percent: undefined, zeroBaseline: true })
    expect(metricDelta(10, 0)).toMatchObject({ absolute: -10, percent: -100 })
    for (const missing of [null, undefined, NaN, Infinity, -1]) expect(metricDelta(missing, 0)).toEqual({ left: undefined, right: 0, zeroBaseline: false })
    expect(metricDelta(Number.MIN_VALUE, Number.MAX_VALUE).percent).toBeUndefined()
  })
  it('does not synthesize missing properties and preserves measured empty strings and duplicate property names', () => {
    expect(propertyDifferences([{ name: 'x', value: '' }, { name: 'x', value: '2' }], [{ name: 'x', value: '' }])).toEqual([
      { name: 'x', left: '', right: '', changed: false }, { name: 'x', left: '2', right: undefined, changed: true }
    ])
  })
  it('renders estimates, aggregate scopes, grants and compiled/runtime availability without worker/execution multiplication', () => {
    const model = planDocumentSchema.parse({ version: '', build: '', notices: [], statements: [{ ...statement('s'), diagnostics: {
      degreeOfParallelism: 4, memoryGrant: [{ name: 'GrantedMemory', value: '0' }, { name: 'GrantWaitTime', value: '2' }], warnings: [], missingIndexes: [],
      parameters: [{ name: '@p', dataType: 'int', compiledValue: '0', runtimeValue: '' }]
    } }] })
    const left = { ...node('l'), actualRows: 20, executions: 8, cpuMs: 0, estimatedRows: 2, diagnostics: {
      estimatedExecutions: 5, parallel: true, estimatedExecutionMode: 'Row', predicates: [], outputColumns: [], warnings: [], spills: [], threads: [], runtimeDetailsAvailable: true
    } }
    const html = renderToStaticMarkup(createElement(ComparisonDetails, { left, right: node('r'), leftStatement: model.statements[0], rightStatement: statement('r') }))
    expect(html).toContain('Estimated total rows</th><td>10</td>')
    expect(html).toContain('CPU (ms, summed threads)</th><td>0</td><td>Unavailable</td>')
    expect(html).toContain('GrantedMemory (KiB)'); expect(html).toContain('GrantWaitTime (ms)')
    expect(html).toContain('Parameter @p · runtime</th><td>(empty value)</td><td>Unavailable')
    expect(html).toContain('not wall time'); expect(html).toContain('no per-execution or per-worker normalization')
  })
  it('escapes saved XML diagnostic text', () => {
    const html = renderToStaticMarkup(createElement(ComparisonDetails, { left: { ...node('l'), object: '<img src=x onerror=alert(1)>' } }))
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img')
  })
  it('bounds displayed diagnostic text while comparing complete retained property values', () => {
    const text = 'x'.repeat(100_000)
    const html = renderToStaticMarkup(createElement(ComparisonDetails, {
      left: { ...node('l'), properties: [{ name: 'Long property', value: text }] }, right: { ...node('r'), properties: [{ name: 'Long property', value: text + 'changed' }] }
    }))
    expect(html).toContain('shortened in comparison; inspect frozen XML')
    expect(html).toContain('Changed / availability differs')
    expect(html.length).toBeLessThan(20_000)
  })
})

describe('immutable comparison inputs', () => {
  it('gives colliding selector choices distinct bounded labels and leaves unique ones unchanged', () => {
    const doc = (id: string, name: string, path?: string, dirty = false) => ({ id, name, dirty, kind: 'sqlplan', file: path ? { path } : undefined })
    const deep = '/srv/' + 'nested/'.repeat(40)
    const labels = comparisonChoices([], [doc('d1', 'query.sqlplan', '/work/before/query.sqlplan'), doc('d2', 'query.sqlplan', '/work/after/query.sqlplan'),
      doc('d3', 'other.sqlplan', '/work/after/other.sqlplan'), doc('u-000001', 'Plan.sqlplan'), doc('u-000002', 'Plan.sqlplan'),
      doc('l1', 'long.sqlplan', deep + 'a/long.sqlplan'), doc('l2', 'long.sqlplan', deep + 'b/long.sqlplan'), { ...doc('q', 'query.sql'), kind: 'sql' }]).map(choice => choice.label)
    expect(labels.slice(0, 5)).toEqual(['Document · query.sqlplan · /work/before', 'Document · query.sqlplan · /work/after', 'Document · other.sqlplan',
      'Document · Plan.sqlplan · not saved · #000001', 'Document · Plan.sqlplan · not saved · #000002'])
    expect(new Set(labels).size).toBe(7)
    expect(labels.every(label => label.length < 160)).toBe(true)
    expect(labels[5].endsWith('/a')).toBe(true)
    // Same folder and the same identifier tail still end up distinct.
    expect(new Set(comparisonChoices([], [doc('x-same', 'p.sqlplan', '/w/p.sqlplan'), doc('y-same', 'p.sqlplan', '/w/p.sqlplan')]).map(choice => choice.label)).size).toBe(2)
  })
  it('separates retained snapshots that share a name, batch and second by their millisecond', async () => {
    const history = new RetainedPlansService()
    for (const startedAt of [1_700_000_000_123, 1_700_000_000_456]) await history.capture({ executionId: 'run' + startedAt, tabId: 'doc', name: 'query', connectionId: 'connection', database: 'master', sql: 'SELECT 1', startLine: 1,
      sqlScope: 'document', startedAt, includeActualPlan: false, includeLivePlan: false, estimateMode: 'session' }, { status: 'completed', endedAt: startedAt + 1 },
    [{ key: 'source' + startedAt, label: 'Plan', captureType: 'estimated', batchNumber: 1, iteration: 1, incomplete: false, read: async () => ({ text: '<plan/>', truncated: false }) }])
    const choices = comparisonChoices(history.getSnapshot().entries, [])
    history.dispose()
    expect(choices).toHaveLength(2)
    expect(new Set(choices.map(choice => choice.label)).size).toBe(2)
    expect(choices.map(choice => /\+(\d{3}) ms/.exec(choice.label)?.[1]).sort()).toEqual(['123', '456'])
    expect(choices[0].detail).toContain('master')
  })
  it('freezes edited document XML and revision across save, further edits and source close', async () => {
    let xml = '<original/>', revision = 3
    const source = { id: 'doc', name: 'plan.sqlplan', dirty: true, file: { path: 'plan.sqlplan' } }
    const input = documentInput(source, { getValue: () => xml, getValueLength: () => xml.length, getVersionId: () => revision })
    xml = '<changed/>'; revision++; source.dirty = false; source.file.path = 'saved.sqlplan'
    expect(await input.source.read(new AbortController().signal)).toBe('<original/>')
    expect(input.document).toEqual({ id: 'doc', revision: 3, file: 'plan.sqlplan', dirty: true })
    expect(input.provenance).toContain('Capture type, estimation mode and execution status unavailable')
    expect(input.provenance).toContain('Unsaved edits included')
  })
  it('keeps actual/estimate/session/outcome and incomplete/truncated provenance after history removal', async () => {
    const history = new RetainedPlansService()
    await history.capture({ executionId: 'run', tabId: 'doc', name: 'query', connectionId: 'connection', database: 'master', sql: 'SELECT 1', startLine: 1,
      sqlScope: 'document', startedAt: 1, includeActualPlan: false, includeLivePlan: false, estimateMode: 'session' }, { status: 'cancelled', endedAt: 2 },
    [{ key: 'source', label: 'Plan', captureType: 'estimated', batchNumber: 2, iteration: 3, incomplete: true, read: async () => ({ text: '<original/>', truncated: true }) }])
    const input = snapshotInput(history.getSnapshot().entries[0])
    history.clear(true); history.dispose()
    expect(input.provenance).toContain('Estimated · Query session · cancelled · Partial execution · Incomplete document · Truncated XML · Batch 2, repetition 3')
    expect(await input.source.read(new AbortController().signal)).toBe('<original/>')
    expect(input.source.key).toBe('source')
  })
})
