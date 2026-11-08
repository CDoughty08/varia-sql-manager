import { describe, expect, it } from 'vitest'
import type { PlanNode } from '../src/shared/plans'
import { operatorIcon, revealAncestors, rowFlow, visibleOperators } from '../src/renderer/src/plans/presentation'
import { locateXml, targetAtXmlOffset, xmlLocations } from '../src/renderer/src/plans/navigation'
import { layoutPlans } from '../src/renderer/src/plans/layout'
import { card } from '../src/renderer/src/plans/geometry'
import { svgIcons } from '../src/shared/icons'

const node: PlanNode = { id: 'a', parentId: null, nodeId: '0', physicalOp: 'Scan', logicalOp: '', object: '', estimatedRows: 12, estimatedCost: null, actualRows: null, elapsedMs: null, cpuMs: null, executions: null, warnings: [], properties: [] }
const ns = 'http://schemas.microsoft.com/sqlserver/2004/07/showplan'

describe('canvas row flow and icons', () => {
  it('distinguishes observed zero, per-execution estimates, totals, unavailable and partial live values', () => {
    expect(rowFlow(node)).toMatchObject({ kind: 'estimated', label: 'Est. 12 rows/exec' })
    expect(rowFlow({ ...node, actualRows: 0 })).toMatchObject({ kind: 'actual', label: 'Actual 0 rows', width: 1 })
    expect(rowFlow({ ...node, actualRows: 0 }, true)).toMatchObject({ kind: 'partial', label: 'Live partial 0 rows' })
    expect(rowFlow(node, true)).toMatchObject({ kind: 'partial', label: 'Live partial Unavailable rows' })
    expect(rowFlow({ ...node, estimatedRows: null })).toMatchObject({ kind: 'unavailable', label: 'Rows unavailable' })
    expect(rowFlow({ ...node, executions: 1 })).toMatchObject({ kind: 'unavailable', width: 1 })
    expect(rowFlow({ ...node, diagnostics: { estimatedExecutions: 3 } as PlanNode['diagnostics'] })).toMatchObject({ label: 'Est. 36 rows' })
    expect(rowFlow({ ...node, actualRows: 1e300 }).width).toBe(6)
  })
  it('uses registered recognizable operator families and a fallback for unknown operators', () => {
    const operators = ['Index Seek', 'Table Scan', 'Hash Match Join', 'Nested Loops', 'Sort', 'Stream Aggregate', 'Filter', 'Parallelism', 'Compute Scalar', 'Table Spool', 'Future Operator']
    expect(new Set(operators.map(op => operatorIcon(op))).size).toBe(10)
    for (const op of operators) expect(svgIcons[operatorIcon(op)].path).toBeTruthy()
    expect(operatorIcon('Hash Match', 'Aggregate')).toBe('plan-aggregate')
    expect(operatorIcon('Hash Match', 'Inner Join')).toBe('plan-join')
  })
})

describe('subtree projection', () => {
  const nodes = [node, { ...node, id: 'b', parentId: 'a' }, { ...node, id: 'c', parentId: 'b' }, { ...node, id: 'd', parentId: 'a' }]
  const statements = [{ id: 's', sourceKey: 'source', text: '', type: '', estimatedCost: null, warnings: [], nodes }]
  it('leaves source models untouched and reveals only the selected hidden operator’s ancestors', () => {
    const collapsed = new Set(['a', 'b', 'd'])
    expect([...visibleOperators(statements, collapsed)]).toEqual(['a'])
    const revealed = revealAncestors('c', new Map(nodes.map(n => [n.id, n.parentId])), collapsed)
    expect([...revealed]).toEqual(['d'])
    expect(visibleOperators(statements, revealed).size).toBe(4)
    expect(collapsed.size).toBe(3)
    expect(statements[0].nodes).toBe(nodes)
  })
  it('keeps source indices across hidden inputs and compacts irregular contours', () => {
    const layout = layoutPlans([{ id: 's', nodes: [nodes[0], { ...nodes[3], index: 3 }] }])
    expect(layout.nodes[1]).toMatchObject({ id: 'd', index: 3 })
    expect(layout.edges[0]).toMatchObject({ childId: 'd', index: 3 })
    const parents = [null, '0', '1', '1', '0', '4', '5', '6', '6']
    const irregular = layoutPlans([{ id: 'irregular', nodes: parents.map((parentId, i) => ({ id: String(i), parentId })) }])
    expect(irregular.bounds.height).toBeLessThan(card.heading + card.padding + card.height * 4 + card.nodeGap * 3)
  })
})

describe('accurate source navigation', () => {
  const xml = `<p:ShowPlanXML xmlns:p="${ns}"><!-- <p:StmtSimple><p:RelOp NodeId="99"/></p:StmtSimple> --><p:StmtSimple StatementId="1" StatementText="a &gt; b"><p:RelOp NodeId="0"><![CDATA[<p:RelOp NodeId="99"/>]]><Other xmlns="foreign"><RelOp NodeId="99"/></Other><p:RelOp NodeId="1"/></p:RelOp><p:StmtSimple StatementId="1"><p:RelOp NodeId="0"/></p:StmtSimple><p:RelOp NodeId="2"/></p:StmtSimple><p:StmtSimple StatementId="1"><p:RelOp NodeId="0"/></p:StmtSimple></p:ShowPlanXML>`
  it('uses source statement and operator ordinals even with repeated NodeId, nested statements and namespace prefixes', () => {
    const locations = xmlLocations(xml)
    expect(locations.map(l => l.target)).toEqual([
      { statement: 0 }, { statement: 0, operator: 0, nodeId: '0' }, { statement: 0, operator: 1, nodeId: '1' },
      { statement: 1 }, { statement: 1, operator: 0, nodeId: '0' }, { statement: 0, operator: 2, nodeId: '2' },
      { statement: 2 }, { statement: 2, operator: 0, nodeId: '0' }
    ])
    const target = { statement: 2, operator: 0, nodeId: '0' }, location = locateXml(xml, target)!
    expect(xml.slice(location.start, location.openEnd)).toBe('<p:RelOp NodeId="0"/>')
    expect(targetAtXmlOffset(xml, location.start + 5)).toEqual(target)
    expect(locateXml(xml, { ...target, nodeId: '1' })).toBeUndefined()
    expect(targetAtXmlOffset(xml, 0)).toBeUndefined()
  })
  it('bounds a navigation scan of incomplete edited XML and accepts quoted angle brackets', () => {
    expect(xmlLocations('<broken attr="' + '<broken'.repeat(100_000))).toEqual([])
    const quoted = `<ShowPlanXML xmlns="${ns}"><StmtSimple StatementText="x > y"><RelOp NodeId="1" /></StmtSimple></ShowPlanXML>`
    expect(locateXml(quoted, { statement: 0, operator: 0, nodeId: '1' })).toBeDefined()
  })
  it('does not confuse SQL literals with namespace or NodeId attributes', () => {
    const text = `<ShowPlanXML xmlns="${ns.replace('http', '&#104;ttp')}"><StmtSimple StatementText="SELECT ' xmlns='foreign' NodeId='9' '"><RelOp Other=" NodeId='8'" NodeId="&#48;" /></StmtSimple><StmtSimple><RelOp NodeId="0" /></StmtSimple></ShowPlanXML>`
    const location = locateXml(text, { statement: 0, operator: 0, nodeId: '0' })!
    expect(text.slice(location.start, location.openEnd)).toContain('NodeId="&#48;"')
    expect(xmlLocations(text).map(location => location.target.statement)).toEqual([0, 0, 1, 1])
  })
})
