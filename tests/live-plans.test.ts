import { describe, expect, it } from 'vitest'
import { planLimits, type LivePlanFrame, type PlanNode } from '../src/shared/plans'
import { liveEventSchema, liveSubscribeParamsSchema } from '../src/shared/live/schema'
import { applyLivePlan, completedPlanStatements, completedPlanView, emptyLivePlan, planTopology, queryPlanStatements } from '../src/renderer/src/plans/live-model'
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
  it('reconciles native SQL text omitted by the live DMV without changing selection or layout', () => {
    const live = applyLivePlan(emptyLivePlan, { ...frame(), document: { ...document, statements: [{ ...document.statements[0], text: '', queryHash: '0x123' }] } })
    const actual = queryPlanStatements(live.statements.map(s => ({ ...s, text: 'SELECT * FROM Data', partial: undefined, sourceKey: 'native', nodes: s.nodes.map(n => ({ ...n, actualRows: 100 })) })))
    const completed = completedPlanStatements(live.statements, actual)
    expect(completed).toHaveLength(1)
    expect(planTopology(completed)).toBe(planTopology(live.statements))
    expect(completed[0]).toMatchObject({ text: 'SELECT * FROM Data', sourceKey: 'native', partial: undefined })
    expect(completed[0].nodes.every(n => n.actualRows === 100)).toBe(true)
  })
  it.each([{ label: 'omitted', text: '' }, { label: 'shortened', text: 'SELECT /* ' + 'x'.repeat(16_374) }])('separates $label SQL using literal expressions and reconciles each completed native plan', ({ text }) => {
    const variant = (literal: number): LivePlanFrame => ({ ...frame(literal), document: { ...document, statements: [
      { ...document.statements[0], text, queryHash: '0x123', nodes: document.statements[0].nodes.map(n => ({ ...n,
        properties: [{ name: 'Const.ConstValue', value: String(literal) }] })) }
    ] } })
    const first = applyLivePlan(emptyLivePlan, variant(1))
    const second = applyLivePlan(first, { ...variant(2), revision: 2 })
    expect(second.statements).toHaveLength(2)
    const actual = queryPlanStatements(second.statements.map((s, i) => ({ ...s, text: text || `SELECT ${i + 1}`, partial: undefined, sourceKey: 'native' })))
    const completed = completedPlanStatements(second.statements, actual)
    expect(completed).toHaveLength(2)
    expect(completed.map(s => s.id)).toEqual(second.statements.map(s => s.id))
    expect(completed.every(s => !s.partial)).toBe(true)
  })
  it('retains an unmatched partial snapshot rather than guessing between repeated native executions', () => {
    const live = applyLivePlan(emptyLivePlan, { ...frame(), document: { ...document, statements: [{ ...document.statements[0], text: '', queryHash: '0x123' }] } })
    const actual = queryPlanStatements(['SELECT * FROM Data WHERE n = 1', 'SELECT * FROM Data WHERE n = 2'].map(text => ({ ...live.statements[0], text, partial: undefined, sourceKey: 'native' })))
    const completed = completedPlanStatements(live.statements, actual)
    expect(completed).toHaveLength(3)
    expect(completed[0].partial).toBe(true)
    expect(completed.slice(1).every(s => !s.partial)).toBe(true)
  })
  it('bounds accumulated statements across repeated batches', () => {
    let model = emptyLivePlan
    for (let iteration = 1; iteration <= 256; iteration++) model = applyLivePlan(model, { ...frame(), iteration, revision: iteration })
    expect(model.statements).toHaveLength(512)
    expect(applyLivePlan(model, { ...frame(), iteration: 257, revision: 257 })).toBe(model)
  })
  it('keeps the combined completed view within its statement limit', () => {
    const source = (index: number, partial: boolean) => ({ ...document.statements[0], id: `${partial}:${index}`, batchNumber: index + (partial ? 1 : 1000),
      sourceKey: partial ? '' : `actual-${index}`, partial, nodes: [] })
    const live = Array.from({ length: planLimits.statements }, (_, i) => source(i, true))
    const actual = Array.from({ length: planLimits.statements }, (_, i) => source(i, false))
    const view = completedPlanView(live, actual)
    expect(view.statements).toEqual(actual)
    expect(view.omitted).toBe(planLimits.statements)
    expect(live).toHaveLength(planLimits.statements)
  })
  it('keeps the combined completed view within its operator limit', () => {
    const source = (index: number, partial: boolean) => {
      const id = `${partial}:${index}`
      return { ...document.statements[0], id, batchNumber: index + (partial ? 1 : 1000), sourceKey: partial ? '' : `actual-${index}`, partial,
        nodes: Array.from({ length: 2000 }, (_, i) => node(id + ':' + i, null, String(i))) }
    }
    const live = Array.from({ length: 3 }, (_, i) => source(i, true))
    const actual = Array.from({ length: 3 }, (_, i) => source(i, false))
    const view = completedPlanView(live, actual)
    expect(view.statements.reduce((sum, s) => sum + s.nodes.length, 0)).toBe(planLimits.nodes)
    expect(view.statements.filter(s => !s.partial)).toEqual(actual)
    expect(view.omitted).toBe(1)
    expect(live).toHaveLength(3)
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
