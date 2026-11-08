import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { planDocumentSchema, planNodeSchema, type PlanNode, type PlanStatement } from '../src/shared/plans'
import { comparePlans, metricDelta, pairOperators, propertyDifferences } from '../src/renderer/src/plans/comparison'
import { documentInput, snapshotInput } from '../src/renderer/src/plans/comparison-inputs'
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
