import { describe, expect, it, vi } from 'vitest'
import { planLimits, type PlanDocument } from '../src/shared/plans'
import { PlanPreparationCache, preparationLimits } from '../src/renderer/src/plans/preparation'
import { LabelPool } from '../src/renderer/src/plans/labels'
import { layoutPlans } from '../src/renderer/src/plans/layout'
import { card, intersects, SpatialIndex } from '../src/renderer/src/plans/geometry'
import { planTopology } from '../src/renderer/src/plans/live-model'
import { loadPlanSources } from '../src/renderer/src/plans/sources'
import { largePlan } from './fixtures/plans/large'

const document: PlanDocument = { version: '', build: '', notices: [], statements: [{ id: 's', text: 'SELECT 1', type: 'SELECT', estimatedCost: null, warnings: [], nodes: [
  { id: 'n', parentId: null, nodeId: '0', physicalOp: 'Scan', logicalOp: 'Scan', object: '', estimatedRows: 1, estimatedCost: null, actualRows: null, elapsedMs: null, cpuMs: null, executions: null, warnings: [], properties: [] }
] }] }
const signal = () => new AbortController().signal
const source = (key = '1:7:0') => ({ key, result: { generation: 1, resultId: 7 }, label: 'Plan', read: vi.fn(async () => '<ShowPlanXML/>') })
const parser = () => vi.fn(async () => ({ ok: true as const, value: document }))

describe('bounded plan preparation', () => {
  it('reuses reads and parses across viewer remounts and streaming appends', async () => {
    const cache = new PlanPreparationCache(), parse = parser(), first = source(), second = source('1:8:0')
    const load = (sources = [first]) => loadPlanSources(sources, parse, signal(), (source, signal) => cache.prepare('tab', source, parse, signal))
    const original = await load()
    expect(await load()).toEqual(original)
    expect((await load([first, second])).statements).toHaveLength(2)
    expect(first.read).toHaveBeenCalledTimes(1)
    expect(second.read).toHaveBeenCalledTimes(1)
    expect(parse).toHaveBeenCalledTimes(2)
    cache.dispose()
  })
  it('shares an in-flight parse and only cancels its read when every viewer leaves', async () => {
    const cache = new PlanPreparationCache(), parse = parser(), input = source()
    let finish!: (xml: string) => void
    input.read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const a = new AbortController(), b = new AbortController()
    const first = cache.prepare('tab', input, parse, a.signal), second = cache.prepare('tab', input, parse, b.signal)
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    a.abort(); finish('xml')
    await rejected
    expect((await second).document).toBe(document)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(cache.stats.pending).toBe(0)
    cache.dispose()
  })
  it('invalidates result releases, generations, revisions and document edits, including late replies', async () => {
    const cache = new PlanPreparationCache(), parse = parser(), input = source()
    const prepare = () => cache.prepare('tab', input, parse, signal())
    await prepare()
    cache.rememberLayout('tab', 'topology', layoutPlans([largePlan(5)]), [input])
    cache.release([{ generation: 2, resultId: 7 }])
    expect(cache.stats.parsed.entries).toBe(1)
    cache.release([input.result])
    expect(cache.stats.parsed.entries).toBe(0)
    expect(cache.layout('tab', 'topology')).toBeUndefined()
    await prepare(); cache.clear(); await prepare()
    expect(parse).toHaveBeenCalledTimes(3)
    await cache.prepare('tab', { ...input, revision: 2 }, parse, signal())
    expect(parse).toHaveBeenCalledTimes(4)
    let changed!: () => void
    const dispose = vi.fn()
    cache.watchDocument('tab', callback => { changed = callback; return { dispose } })
    changed()
    expect(cache.stats.parsed.entries).toBe(0)
    const epoch = cache.epoch
    let finish!: (xml: string) => void
    input.read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = prepare(), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    cache.close('tab'); finish('xml')
    await rejected
    cache.rememberLayout('tab', 'late', layoutPlans([largePlan(1)]), [], epoch)
    expect(cache.stats.parsed.entries).toBe(0)
    expect(cache.stats.layouts.entries).toBe(0)
    expect(dispose).toHaveBeenCalledTimes(1)
    cache.dispose()
  })
  it('bounds entries, node counts, text units and layouts independently from source lifetime', async () => {
    const cache = new PlanPreparationCache(), parse = parser()
    for (let index = 0; index < preparationLimits.entries + 1; index++) await cache.prepare('tab', source(String(index)), parse, signal())
    expect(cache.stats.parsed.entries).toBe(preparationLimits.entries)
    await cache.prepare('tab', source('0'), parse, signal())
    expect(parse).toHaveBeenCalledTimes(preparationLimits.entries + 2)
    const big = { ...document, statements: [{ ...document.statements[0], nodes: Array(10_000).fill(document.statements[0].nodes[0]) }] }
    for (let index = 0; index < 3; index++) await cache.prepare('tab', source('big' + index), async () => ({ ok: true, value: big }), signal())
    expect(cache.stats.parsed.nodes).toBeLessThanOrEqual(preparationLimits.nodes)
    const text = { ...document, notices: ['x'.repeat(preparationLimits.units + 1)] }
    await cache.prepare('tab', source('text'), async () => ({ ok: true, value: text }), signal())
    expect(cache.stats.parsed.units).toBeLessThanOrEqual(preparationLimits.units)
    const layout = layoutPlans([largePlan(10_000)])
    for (let index = 0; index < 40; index++) cache.rememberLayout('tab', String(index), layout, [])
    expect(cache.stats.layouts.nodes).toBeLessThanOrEqual(preparationLimits.layoutNodes)
    expect(cache.stats.layouts.entries).toBeLessThanOrEqual(preparationLimits.layouts)
    cache.dispose()
    expect(cache.stats.parsed.entries).toBe(0)
  })
  it('uses exact ordered topology, omitting counters while distinguishing changed parentage and order', () => {
    const statement = { ...document.statements[0], sourceKey: 'source' }
    const topology = planTopology([statement])
    expect(planTopology([{ ...statement, nodes: statement.nodes.map(n => ({ ...n, actualRows: 100 })) }])).toBe(topology)
    expect(planTopology([{ ...statement, nodes: [...statement.nodes, { ...statement.nodes[0], id: 'child', parentId: 'n' }] }])).not.toBe(topology)
    expect(planTopology([{ ...statement, id: 's:x', nodes: [{ ...statement.nodes[0], id: 'n>parent', parentId: null }] }]))
      .not.toBe(planTopology([{ ...statement, id: 's:x', nodes: [{ ...statement.nodes[0], id: 'n', parentId: 'parent>null' }] }]))
  })
  it('charges cached XML lengths against the combined input budget before parsing the next document', async () => {
    const cache = new PlanPreparationCache(), parse = parser()
    const sources = ['a', 'b', 'c', 'd'].map(key => ({ key, label: key, read: vi.fn(async () => 'x'.repeat(planLimits.characters)) }))
    const load = () => loadPlanSources(sources, parse, signal(), (source, signal, remaining) => cache.prepare('tab', source, parse, signal, remaining))
    expect((await load()).statements).toHaveLength(2)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(sources[3].read).not.toHaveBeenCalled()
    expect((await load()).notices[0]).toContain('combined input budget')
    expect(parse).toHaveBeenCalledTimes(2)
    cache.dispose()
  })
  it('keeps each reader’s combined input budget independent when sharing preparation', async () => {
    const cache = new PlanPreparationCache(), parse = parser(), input = source()
    const small = cache.prepare('tab', input, parse, signal(), 1)
    const rejected = expect(small).rejects.toThrow('combined input budget')
    const large = cache.prepare('tab', input, parse, signal(), 100)
    await rejected
    expect((await large).document).toBe(document)
    expect(input.read).toHaveBeenCalledTimes(1)
    expect(parse).toHaveBeenCalledTimes(1)
    cache.dispose()
  })
})

describe('ordered tree layout', () => {
  it.each(['wide', 'balanced', 'chain'] as const)('places every operator and edge of a 10,000-node %s tree without overlaps', shape => {
    const statement = largePlan(10_000, shape), layout = layoutPlans([statement]), index = new SpatialIndex(layout.nodes)
    expect(layout.nodes).toHaveLength(10_000)
    expect(layout.edges).toHaveLength(9_999)
    const nodes = new Map(layout.nodes.map(node => [node.id, node]))
    for (const node of statement.nodes) {
      const placed = nodes.get(node.id)!
      expect(index.query({ x: placed.x + 1, y: placed.y + 1, width: placed.width - 2, height: placed.height - 2 })).toEqual([placed])
      if (node.parentId) expect(placed.x - nodes.get(node.parentId)!.x).toBe(card.width + card.layerGap)
    }
    for (const edge of layout.edges) {
      expect(edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
      expect(edge.points[0].x).toBeLessThan(edge.points.at(-1)!.x)
    }
  })
  it('preserves SQL child order with unsorted ids, out-of-order parents, forests and empty statements', () => {
    const statement = { id: 's', nodes: [{ id: 'z', parentId: 'root' }, { id: 'a', parentId: 'root' }, { id: 'root', parentId: null }, { id: 'forest', parentId: null }] }
    const layout = layoutPlans([statement, { id: 'empty', nodes: [] }])
    expect(layout.nodes[0].y).toBeLessThan(layout.nodes[1].y)
    expect(layout.nodes[1].y).toBeLessThan(layout.nodes[3].y)
    expect(intersects(layout.statements[0], layout.statements[1])).toBe(false)
    expect(layoutPlans([]).nodes).toEqual([])
  })
  it.each([
    [{ id: 'a', parentId: 'missing' }], [{ id: 'a', parentId: 'a' }],
    [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], [{ id: 'a', parentId: null }, { id: 'a', parentId: null }]
  ])('rejects invalid graphs instead of silently losing edges: %j', (...nodes) => {
    expect(() => layoutPlans([{ id: 'invalid', nodes }])).toThrow()
  })
})

it('keeps label sprites attached to identities when visible query order changes and destroys surplus textures', () => {
  let created = 0
  const destroyed: number[] = [], pool = new LabelPool(() => ++created, () => {}, value => destroyed.push(value), 2)
  pool.begin()
  const original = new Map(['a:op', 'a:caption', 'b:op', 'section:s'].map(key => [key, pool.get(key)]))
  pool.end(); pool.begin()
  expect(pool.get('b:op')).toBe(original.get('b:op'))
  expect(pool.get('section:s')).toBe(original.get('section:s'))
  pool.get('new:op'); pool.end()
  expect(pool.stats).toEqual({ active: 3, spare: 2 })
  pool.begin(); expect(pool.end()).toBe(3)
  expect(pool.stats).toEqual({ active: 0, spare: 2 })
  expect(destroyed).toHaveLength(3)
  pool.dispose()
  expect(new Set(destroyed).size).toBe(created)
})
