import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { preparePlan } from '../src/main/plan-request'
import { validateRequest, validateResult } from '../src/main/validation'
import { maxQueryPlanDocuments, planLimits, type PlanStatement, type PlanNode } from '../src/shared/plans'
import { card, SpatialIndex, fit, intersects, union, viewport, zoomAt } from '../src/renderer/src/plans/geometry'
import { layoutPlans } from '../src/renderer/src/plans/layout'
import { findOperators } from '../src/renderer/src/plans/PlanViewer'
import { recoveryWriteSchema } from '../src/main/recovery-store'
import { saveFileSchema } from '../src/main/sql-files'
import { loadPlanSources, orderPlanEntries } from '../src/renderer/src/plans/sources'

const node = (id: string, parentId: string | null = null): PlanNode => ({ id, parentId, nodeId: id, physicalOp: 'Index Scan', logicalOp: 'Scan', object: '[dbo].[Orders]',
  estimatedRows: 10, estimatedCost: 0.1, actualRows: null, elapsedMs: null, cpuMs: null, executions: null, warnings: [], properties: [] })
const statement = (id: string, nodes: PlanNode[]): PlanStatement => ({ id, text: 'SELECT 1', type: 'SELECT', estimatedCost: 0.1, warnings: [], nodes })

describe('execution plans', () => {
  it('interleaves plan sources by batch, repetition, and known event position', () => {
    const entries = [[6, 3, 1], [4, 1, 2], [5, 1, 1], [7, 0, 0], [1, 1, 1], [2, 1, 1], [3, 1, 2]]
      .map(([resultId, batchNumber, iteration]) => ({ descriptor: { resultId, batchNumber, iteration } }))
    const ids = (order?: number[]) => orderPlanEntries(entries, order).map(entry => entry.descriptor.resultId)
    expect(ids([1, 5, 2, 3, 4, 6, 7])).toEqual([1, 5, 2, 3, 4, 6, 7])
    expect(ids()).toEqual([5, 1, 2, 4, 3, 6, 7])
  })
  it('keeps valid sources beside a failed source and scopes repeated node ids by source document', async () => {
    const document = { version: '', build: '', notices: [], statements: [statement('s', [node('root'), node('child', 'root')])] }
    const sources = ['first', 'broken', 'last'].map(key => ({ key, label: key, read: async () => key }))
    const result = await loadPlanSources(sources, async xml => xml === 'broken' ? { ok: false, error: 'Truncated plan.' } : { ok: true, value: document }, new AbortController().signal)
    expect(result.statements).toHaveLength(2)
    expect(result.statements.map(entry => entry.nodes[0].id)).toEqual(['first:root', 'last:root'])
    expect(result.statements[1].nodes[1].parentId).toBe('last:root')
    expect(result.notices[0]).toContain('broken: Truncated plan.')
  })
  it('stops loading after cancellation and reports a single invalid source without a misleading graph', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(loadPlanSources([{ key: 'x', label: 'x', read: async () => '' }], async () => { throw new Error('Must not parse') }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(loadPlanSources([{ key: 'x', label: 'x', read: async () => '' }], async () => ({ ok: false, error: 'Invalid XML' }), new AbortController().signal)).rejects.toThrow('Invalid XML')
  })
  it('graphs the first 64 documents and preserves their source keys for opening XML', async () => {
    const read: number[] = []
    const sources = Array.from({ length: maxQueryPlanDocuments + 2 }, (_, index) => ({
      key: `plan-${index}`, label: String(index), read: async () => { read.push(index); return String(index) }
    }))
    const document = { version: '', build: '', notices: [], statements: [statement('s', [node('root')])] }
    const result = await loadPlanSources(sources, async () => ({ ok: true, value: document }), new AbortController().signal)
    expect(read).toEqual(Array.from({ length: maxQueryPlanDocuments }, (_, index) => index))
    expect(result.statements).toHaveLength(maxQueryPlanDocuments)
    expect(result.statements.at(-1)).toMatchObject({ id: 'plan-63:s', sourceKey: 'plan-63' })
    expect(result.notices[0]).toContain('Choose an XML source to open any retained plan.')
  })
  it('allows large plans to save and recover while retaining ordinary SQL document limits', () => {
    const content = 'x'.repeat(5_000_001)
    const save = { name: 'large.sqlplan', content, saveAs: true }
    expect(saveFileSchema.safeParse({ ...save, kind: 'sqlplan' }).success).toBe(true)
    expect(saveFileSchema.safeParse({ ...save, kind: 'sql' }).success).toBe(false)
    const recovery = { id: crypto.randomUUID(), name: 'large.sqlplan', kind: 'sqlplan', eol: 'lf', text: content }
    expect(recoveryWriteSchema.safeParse(recovery).success).toBe(true)
    expect(recoveryWriteSchema.safeParse({ ...recovery, kind: 'sql' }).success).toBe(false)
  })
  it('compresses Unicode plan XML below the request frame cap and rejects wire fields from renderers', async () => {
    const xml = readFileSync('tests/fixtures/plans/multiple.sqlplan', 'utf8')
    const request = await preparePlan(xml)
    expect(request.encoding).toBe('gzip')
    expect(gunzipSync(Buffer.from(request.xml, 'base64')).toString('utf8')).toBe(xml)
    expect(validateRequest('plans.parse', { xml })).toEqual({ xml })
    expect(() => validateRequest('plans.parse', request)).toThrow('Invalid request')
    expect(() => validateRequest('plans.parse', { xml: 'x'.repeat(planLimits.characters + 1) })).toThrow('Invalid request')
    await expect(preparePlan('')).rejects.toThrow('limited')
  })
  it('normalizes omitted null fields without inventing runtime measurements', () => {
    const minimal = { id: 'n', nodeId: '0', physicalOp: 'Future operator', logicalOp: '', object: '', warnings: [], properties: [] }
    const value = validateResult('plans.parse', { version: '', build: '', notices: [], statements: [{ id: 's', text: '', type: '', warnings: [], nodes: [minimal] }] }) as { statements: PlanStatement[] }
    expect(value.statements[0].nodes[0]).toMatchObject({ parentId: null, actualRows: null, elapsedMs: null })
  })
  it('zooms about the pointer, clamps extremes and fits bounds on both axes', () => {
    const before = { x: -10, y: 35, scale: 0.8 }, after = zoomAt(before, 130, 200, 2)
    expect((130 - before.x) / before.scale).toBeCloseTo((130 - after.x) / after.scale)
    expect((200 - before.y) / before.scale).toBeCloseTo((200 - after.y) / after.scale)
    expect(zoomAt(before, 0, 0, 100).scale).toBe(3)
    const bounds = { x: 500, y: 800, width: 1000, height: 400 }
    const camera = fit(bounds, 800, 600), area = viewport(camera, 800, 600)
    expect(area.x).toBeLessThanOrEqual(bounds.x)
    expect(area.y).toBeLessThanOrEqual(bounds.y)
    expect(area.x + area.width).toBeGreaterThanOrEqual(bounds.x + bounds.width)
    expect(area.y + area.height).toBeGreaterThanOrEqual(bounds.y + bounds.height)
  })
  it('spatially indexes 10,000 nodes including edges that cross the viewport', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => ({ id: i, x: i % 100 * 100, y: Math.floor(i / 100) * 80, width: 60, height: 40 }))
    const crossing = { id: -1, x: -100, y: 10, width: 20_000, height: 1 }, area = { x: 300, y: 0, width: 70, height: 60 }
    const index = new SpatialIndex([...items, crossing])
    expect(index.query(area).map(item => item.id).sort()).toEqual([3, -1].sort())
    expect(new SpatialIndex([]).query(area)).toEqual([])
    expect(union([]).width).toBe(1)
  })
  it('lays out multiple statements in one non-overlapping world with roots left of inputs', async () => {
    const statements = [statement('s1', [node('a'), node('b', 'a'), node('c', 'a')]), statement('s2', [node('d')])]
    const layout = layoutPlans(statements)
    expect(layout.nodes).toHaveLength(4)
    expect(layout.edges).toHaveLength(2)
    expect(layout.edges.every(edge => edge.points.length >= 2)).toBe(true)
    expect(layout.bounds.width).toBe(2 * card.width + card.layerGap + 2 * card.padding)
    expect(layout.bounds.height).toBeLessThan(300)
    expect(intersects(layout.statements[0], layout.statements[1])).toBe(false)
    expect(layout.nodes.find(node => node.id === 'b')!.x).toBeGreaterThan(layout.nodes.find(node => node.id === 'a')!.x)
    for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) expect(intersects(layout.nodes[i], layout.nodes[j])).toBe(false)
  })
  it('searches operators, objects and warnings across all statements', () => {
    const scan = node('a'), warning = { ...node('b'), physicalOp: 'Sort', object: '', warnings: ['SpillToTempDb'] }
    const plans = [statement('s1', [scan]), statement('s2', [warning])]
    expect(findOperators(plans, 'orders', false).map(match => match.node.id)).toEqual(['a'])
    expect(findOperators(plans, 'spill', false).map(match => match.statement)).toEqual([1])
    expect(findOperators(plans, '', true).map(match => match.node.id)).toEqual(['b'])
  })
})
