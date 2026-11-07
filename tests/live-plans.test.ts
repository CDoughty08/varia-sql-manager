import { describe, expect, it } from 'vitest'
import type { LivePlanFrame, PlanNode } from '../src/shared/plans'
import { liveEventSchema, liveSubscribeParamsSchema } from '../src/shared/live/schema'
import { applyLivePlan, completedPlanStatements, emptyLivePlan, planTopology, queryPlanStatements } from '../src/renderer/src/plans/live-model'
import { loadPlanSources } from '../src/renderer/src/plans/sources'

const node = (id: string, parentId: string | null, nodeId: string): PlanNode => ({ id, parentId, nodeId, physicalOp: 'Index Scan', logicalOp: 'Scan', object: '[dbo].[Data]',
  estimatedRows: 10, estimatedCost: 1, actualRows: 1, cpuMs: null, elapsedMs: null, executions: 1, warnings: [], properties: [] })
const document = { version: '1.6', build: '17', notices: [], statements: [
  { id: 's0', statementId: '1', text: 'SELECT * FROM Data', type: 'SELECT', estimatedCost: 1, warnings: [], nodes: [node('s0n1', null, '0'), node('s0n2', 's0n1', '1')] },
  { id: 's1', statementId: '2', text: 'SELECT * FROM Data', type: 'SELECT', estimatedCost: 1, warnings: [], nodes: [node('s1n3', null, '0')] }
] }
const counters = (rows: number) => document.statements.flatMap(s => s.nodes.map(n => ({ id: n.id, rows, cpuMs: null, elapsedMs: rows, executions: 1 })))
const frame = (rows = 1): LivePlanFrame => ({ batch: 1, iteration: 1, revision: 1, document, counters: counters(rows) })

describe('live execution plans', () => {
  it('uses parser ids for counters while keeping SQL statement and node identity stable', () => {
    const baseline = applyLivePlan(emptyLivePlan, frame())
    const next = applyLivePlan(baseline, { ...frame(23), document: undefined })
    expect(planTopology(next.statements)).toBe(planTopology(baseline.statements))
    expect(next.statements.map(s => s.id)).toEqual([expect.stringMatching(/^b1i1s1t.+:0$/), expect.stringMatching(/^b1i1s2t.+:0$/)])
    expect(next.statements[0].nodes[1].parentId).toBe(next.statements[0].nodes[0].id)
    expect(next.statements.flatMap(s => s.nodes).every(n => n.actualRows === 23 && n.liveActivity)).toBe(true)
    const idle = applyLivePlan(next, { ...frame(23), document: undefined })
    expect(idle.statements.flatMap(s => s.nodes).every(n => !n.liveActivity)).toBe(true)
  })
  it('rejects counter frames without their matching topology revision or GO position', () => {
    const before = applyLivePlan(emptyLivePlan, frame())
    for (const bad of [{ revision: 2 }, { batch: 2 }, { iteration: 2 }])
      expect(applyLivePlan(before, { ...frame(2), ...bad, document: undefined })).toBe(before)
  })
  it('retains earlier batches and separates identical SQL in GO repetitions', () => {
    const before = applyLivePlan(emptyLivePlan, frame())
    const next = applyLivePlan(before, { ...frame(30), iteration: 2, revision: 2 })
    expect(next.statements).toHaveLength(4)
    expect(new Set(next.statements.map(s => s.id)).size).toBe(4)
    expect(next.statements[0].nodes[0].liveActivity).toBe(false)
    expect(next.statements[2].nodes[0].actualRows).toBe(30)
  })
  it('matches actual single-statement documents back to the live batch without changing topology or selected ids', async () => {
    const live = applyLivePlan(emptyLivePlan, frame())
    const sources = document.statements.map((_, i) => ({ key: 'actual-' + i, label: 'Actual', batchNumber: 1, iteration: 1, read: async () => String(i) }))
    const parsed = await loadPlanSources(sources, async xml => ({ ok: true, value: { ...document, statements: [{ ...document.statements[Number(xml)], id: 's0', nodes: document.statements[Number(xml)].nodes.map(n => ({ ...n, actualRows: 100 })) }] } }), new AbortController().signal)
    const actual = queryPlanStatements(parsed.statements)
    const completed = completedPlanStatements(live.statements, actual)
    expect(planTopology(completed)).toBe(planTopology(live.statements))
    expect(completed[1].nodes[0].actualRows).toBe(100)
    expect(completed[1].sourceKey).toBe('actual-1')
    expect(completed.every(s => !s.partial)).toBe(true)
  })
  it('keeps a cancelled statement explicitly partial beside captured completed statements', () => {
    const live = applyLivePlan(emptyLivePlan, frame())
    const actual = { ...live.statements[0], partial: undefined, sourceKey: 'captured' }
    const complete = completedPlanStatements(live.statements, [actual])
    expect(complete[0]).toBe(actual)
    expect(complete[1].partial).toBe(true)
  })
  it('retains previously sampled statements when SQL Server returns only the next active statement in the same batch', () => {
    const first = applyLivePlan(emptyLivePlan, { ...frame(), document: { ...document, statements: [document.statements[0]] } })
    const next = applyLivePlan(first, { ...frame(), revision: 2, document: { ...document, statements: [document.statements[1]] } })
    expect(next.statements.map(s => s.statementId)).toEqual(['1', '2'])
    const later = applyLivePlan(next, { ...frame(30), revision: 2, document: undefined })
    expect(later.statements[0].nodes[0].actualRows).toBe(1)
    expect(later.statements[1].nodes[0].actualRows).toBe(30)
  })
  it('keeps distinct SQL with reused statement ids and query hashes separate through final capture', () => {
    const variant = (text: string, rows: number): LivePlanFrame => ({ ...frame(rows), document: { ...document, statements: [
      { ...document.statements[0], statementId: '1', queryHash: '0x123', text }
    ] } })
    const first = applyLivePlan(emptyLivePlan, variant('SELECT * FROM Data WHERE n = 1', 10))
    const second = applyLivePlan(first, { ...variant('SELECT * FROM Data WHERE n = 2', 20), revision: 2 })
    expect(second.statements).toHaveLength(2)
    expect(second.statements.map(s => s.nodes[0].actualRows)).toEqual([10, 20])
    const actual = queryPlanStatements(second.statements.map(s => ({ ...s, partial: undefined, sourceKey: 'actual', nodes: s.nodes.map(n => ({ ...n, actualRows: 100 })) })))
    const complete = completedPlanStatements(second.statements, actual)
    expect(complete).toHaveLength(2)
    expect(complete.map(s => s.id)).toEqual(second.statements.map(s => s.id))
    expect(complete.every(s => !s.partial)).toBe(true)
  })
  it('bounds accumulated statements across repeated batches', () => {
    let model = emptyLivePlan
    for (let iteration = 1; iteration <= 256; iteration++) model = applyLivePlan(model, { ...frame(), iteration, revision: iteration })
    expect(model.statements).toHaveLength(512)
    expect(applyLivePlan(model, { ...frame(), iteration: 257, revision: 257 })).toBe(model)
  })
  it('validates the live source query identity and prevents plan payloads on unrelated probes', () => {
    const subscriptionId = crypto.randomUUID(), connectionId = crypto.randomUUID()
    const params = { subscriptionId, connectionId, source: 'query.plan', args: { queryId: crypto.randomUUID() }, probes: [{ probe: 'query.plan.operators', intervalMs: 1000 }] }
    expect(liveSubscribeParamsSchema.safeParse(params).success).toBe(true)
    expect(liveSubscribeParamsSchema.safeParse({ ...params, args: { queryId: '52' } }).success).toBe(false)
    const sample = { probe: 'query.plan.operators', costMs: 1, effectiveIntervalMs: 1000, plan: frame() }
    const event = { type: 'live.tick', seq: 1, sampledAt: Date.now(), samples: [sample] }
    expect(liveEventSchema.safeParse(event).success).toBe(true)
    expect(liveEventSchema.safeParse({ ...event, samples: [{ ...sample, probe: 'activity.overview' }] }).success).toBe(false)
  })
})
