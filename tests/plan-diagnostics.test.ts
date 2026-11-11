import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { planDocumentSchema, planNodeSchema, operatorDiagnosticsSchema } from '../src/shared/plans'
import { discrepancyLabel, estimatedTotalRows, formatPlanMetric, rankOperators, rowComparison } from '../src/renderer/src/plans/diagnostics'
import { PlanProperties } from '../src/renderer/src/plans/PlanProperties'

const diagnostic = operatorDiagnosticsSchema.parse({ estimatedExecutions: 5, parallel: true, estimatedExecutionMode: 'Row', predicates: [], outputColumns: [], warnings: [], spills: [], threads: [], runtimeDetailsAvailable: true })
const node = (id: string, cpu: number | null = null) => planNodeSchema.parse({ id, nodeId: id, physicalOp: 'Seek', logicalOp: 'Seek', object: '', estimatedRows: 2, cpuMs: cpu, actualRows: 10, executions: 10, warnings: [], properties: [], diagnostics: diagnostic })

describe('plan diagnostics', () => {
  it('compares totals using estimated repeated executions without multiplying for parallel workers', () => {
    expect(rowComparison(node('a'))).toEqual({ estimatedTotal: 10, factor: 1, direction: 'match' })
    expect(estimatedTotalRows({ ...node('a'), actualRows: null })).toBe(10)
    expect(discrepancyLabel({ ...node('a'), actualRows: 100 })).toBe('10× underestimate')
    expect(rowComparison({ ...node('a'), diagnostics: undefined })).toBeUndefined()
    expect(rowComparison({ ...node('a'), actualRows: null })).toBeUndefined()
  })
  it('defines zero estimates, zero actual rows and both-zero comparisons', () => {
    expect(discrepancyLabel({ ...node('a'), estimatedRows: 0 })).toBe('∞× underestimate')
    expect(discrepancyLabel({ ...node('a'), actualRows: 0 })).toBe('∞× overestimate')
    expect(discrepancyLabel({ ...node('a'), actualRows: 0, estimatedRows: 0 })).toBe('1× match')
  })
  it('formats tiny magnitudes symmetrically and keeps a true zero unsigned', () => {
    expect(formatPlanMetric(0.00001)).toBe('1.00e-5')
    expect(formatPlanMetric(-0.00001)).toBe('-1.00e-5')
    expect(formatPlanMetric(0)).toBe('0'); expect(formatPlanMetric(-0)).toBe('0')
    expect(formatPlanMetric(-0.5)).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(-0.5))
    expect(formatPlanMetric(null)).toBe('Unavailable')
  })
  it('ranks available measurements including zeros with stable ties and excludes unavailable metrics', () => {
    const matches = [node('missing'), node('zero', 0), node('high', 20), node('tie', 20)].map(node => ({ node }))
    expect(rankOperators(matches, 'cpu').map(m => m.node.id)).toEqual(['high', 'tie', 'zero'])
    expect(rankOperators(matches, 'plan')).toEqual(matches)
    expect(rankOperators(matches, 'elapsed')).toEqual([])
    expect(rankOperators([{ node: { ...node('match'), actualRows: 10 } }, { node: { ...node('zero'), actualRows: 0 } }, { node: { ...node('inf'), estimatedRows: 0 } }], 'rows').map(m => m.node.id)).toEqual(['zero', 'inf', 'match'])
  })
  it('keeps old normalized plans valid without synthesizing unavailable diagnostics', () => {
    const parsed = planDocumentSchema.parse({ version: '1.0', build: '', statements: [{ id: 's', text: '', type: '', warnings: [], nodes: [{ ...node('old'), diagnostics: undefined }] }], notices: [] })
    expect(parsed.statements[0].nodes[0].diagnostics).toBeUndefined()
    const markup = renderToStaticMarkup(createElement(PlanProperties, { statement: { ...parsed.statements[0], sourceKey: 'old' }, node: parsed.statements[0].nodes[0] }))
    expect(markup).toContain('Unavailable')
    expect(markup).toContain('Costs are optimizer estimates')
    expect(markup).toContain('Detailed data unavailable in this view')
    expect(markup).not.toContain('None reported in this XML')
  })
  it('renders untrusted details as text and exposes unavailable parameter values explicitly', () => {
    const entry = node('a')
    entry.diagnostics!.predicates = [{ kind: 'Residual', comparison: '', columns: [], expressions: ['<img src=x onerror=alert(1)>'] }]
    const statement = planDocumentSchema.parse({ version: '', build: '', notices: [], statements: [{ id: 's', text: '', type: '', warnings: [], nodes: [], diagnostics: {
      degreeOfParallelism: 0, memoryGrant: [], warnings: [], missingIndexes: [], parameters: [{ name: '@p', dataType: 'int', compiledValue: '(0)', runtimeValue: null }]
    } }] }).statements[0]
    const markup = renderToStaticMarkup(createElement(PlanProperties, { statement: { ...statement, sourceKey: 'a' }, node: entry }))
    expect(markup).toContain('&lt;img')
    expect(markup).not.toContain('<img')
    expect(markup).toContain('Runtime value</dt><dd>Unavailable')
    expect(markup).toContain('Degree of parallelism</dt><dd>0')
  })
})
