// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import PlanComparison from '../src/renderer/src/plans/PlanComparison'
import type { PlanNavigation } from '../src/renderer/src/plans/PlanViewer'
import { PlanPreparationCache } from '../src/renderer/src/plans/preparation'
import { RetainedPlansService } from '../src/renderer/src/plans/RetainedPlansService'
import { comparePlans } from '../src/renderer/src/plans/comparison'
import type { PlanDocument, PlanStatement } from '../src/shared/plans'
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }

const viewers = vi.hoisted(() => ({ navigation: [] as (PlanNavigation | undefined)[], scopes: [] as (string | undefined)[] }))
vi.mock('../src/renderer/src/plans/PlanViewer', () => ({ default: (props: { navigation?: PlanNavigation; identity: string; scope?: string }) => {
  viewers.navigation[props.identity.endsWith(':Left') ? 0 : 1] = props.navigation
  viewers.scopes[props.identity.endsWith(':Left') ? 0 : 1] = props.scope
  return createElement('div', { 'aria-label': props.identity })
} }))

class MatchingWorker {
  static instances: MatchingWorker[] = []
  data?: { left: PlanStatement[]; right: PlanStatement[] }
  onmessage?: (event: { data: unknown }) => void
  terminated = false
  constructor() { MatchingWorker.instances.push(this) }
  postMessage(data: MatchingWorker['data']) { this.data = data }
  terminate() { this.terminated = true }
  complete() {
    const pairs = comparePlans(this.data!.left, this.data!.right).map(p => ({ ...p, left: p.left?.id, right: p.right?.id,
      operators: p.operators.map(op => ({ ...op, left: op.left?.id, right: op.right?.id })) }))
    this.onmessage?.({ data: { ok: true, pairs } })
  }
}
const model: PlanDocument = { version: '', build: '', notices: [], statements: [{ id: 's', text: 'SELECT 1', type: 'SELECT', estimatedCost: 1, warnings: [], nodes: [
  { id: 'n', nodeId: '0', parentId: null, physicalOp: 'Scan', logicalOp: 'Get', object: 'T', estimatedRows: 1, estimatedCost: 1, actualRows: 0, cpuMs: 0, elapsedMs: 0, executions: 1, warnings: [], properties: [] }
] }] }
let root: Root, host: HTMLDivElement, cache: PlanPreparationCache, history: RetainedPlansService, parse: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn<() => void>>
const docState = { documents: [{ id: 'a', name: 'a.sqlplan', kind: 'sqlplan', dirty: false }, { id: 'b', name: 'b.sqlplan', kind: 'sqlplan', dirty: true }], busy: false, activeId: 'a' }
const click = (name: string) => act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === name)!.click())
async function render(show = true, active = true) {
  const workbench = { retainedPlans: history, planPreparation: cache,
    documents: { getSnapshot: () => docState, subscribe: () => () => {}, get: (id: string) => docState.documents.find(d => d.id === id), isFilling: () => false,
      getModel: (id: string) => ({ getValue: () => '<' + id + '/>', getValueLength: () => 4, getVersionId: () => 1 }) }, files: { open: vi.fn() } } as unknown as Workbench
  await act(async () => root.render(createElement(WorkbenchProvider, { workbench, children: show ? createElement(PlanComparison, { close, active }) : null })))
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  cache = new PlanPreparationCache(); history = new RetainedPlansService(); close = vi.fn()
  MatchingWorker.instances = []; viewers.navigation = []; viewers.scopes = []
  parse = vi.fn(async () => ({ ok: true, value: model }))
  Object.assign(window, { varia: { parsePlan: parse } })
  vi.stubGlobal('Worker', MatchingWorker)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); cache.dispose(); history.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('links only conservative counterparts and camera events, supports independent views, and releases matching/scopes on close', async () => {
  await render(); await click('Compare selected plans')
  const worker = MatchingWorker.instances[0]
  await act(async () => worker.complete())
  expect(host.textContent).toContain('1 paired operators')
  await act(async () => viewers.navigation[0]!.select!('a:n'))
  expect(viewers.navigation.map(n => n?.selected)).toEqual(['a:n', 'b:n'])
  const camera = { x: 20, y: -40, scale: 0.5 }
  await act(async () => viewers.navigation[0]!.cameraChanged!(camera))
  expect(viewers.navigation.map(n => n?.camera)).toEqual([camera, camera])
  const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  await act(async () => checkbox.click())
  const independent = { x: 70, y: 80, scale: 1 }
  await act(async () => viewers.navigation[1]!.cameraChanged!(independent))
  expect(viewers.navigation.map(n => n?.camera)).toEqual([camera, independent])
  await act(async () => checkbox.click())
  expect(viewers.navigation.map(n => n?.camera)).toEqual([independent, independent])
  await click('Close comparison'); expect(close).toHaveBeenCalledOnce()
  await render(false)
  expect(worker.terminated).toBe(true)
  expect(cache.stats.parsed.entries).toBe(0); expect(cache.stats.layouts.entries).toBe(0)
})

it('ignores a stale matching reply after swapping, and clears selection', async () => {
  await render(); await click('Compare selected plans')
  const old = MatchingWorker.instances[0]
  await click('Swap plans')
  expect(old.terminated).toBe(true)
  const current = MatchingWorker.instances[1]
  await act(async () => old.complete())
  expect(host.textContent).not.toContain('1 paired operators')
  await act(async () => current.complete())
  await act(async () => viewers.navigation[0]!.select!('b:n'))
  expect(viewers.navigation.map(n => n?.selected)).toEqual(['b:n', 'a:n'])
})

it('clears the other selection for an ambiguous operator instead of inventing a counterpart', async () => {
  parse.mockResolvedValue({ ok: true, value: { ...model, statements: [{ ...model.statements[0], nodes: [model.statements[0].nodes[0],
    { ...model.statements[0].nodes[0], id: 'repeat1', object: 'Repeated' }, { ...model.statements[0].nodes[0], id: 'repeat2', object: 'Repeated' }
  ] }] } })
  await render(); await click('Compare selected plans')
  await act(async () => MatchingWorker.instances[0].complete())
  expect(host.textContent).toContain('4 ambiguous entries')
  await act(async () => viewers.navigation[0]!.select!('a:n'))
  expect(viewers.navigation.map(n => n?.selected)).toEqual(['a:n', 'b:n'])
  await act(async () => viewers.navigation[0]!.select!('a:repeat1'))
  expect(viewers.navigation.map(n => n?.selected)).toEqual(['a:repeat1', ''])
})

it('cancels both pending readers when input selection changes, and prevents late parse results from restoring comparison caches', async () => {
  const waiting = deferred<{ ok: true; value: PlanDocument }>()
  parse.mockImplementation(() => waiting.promise)
  await render(); await click('Compare selected plans')
  expect(parse).toHaveBeenCalledTimes(2)
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Left comparison input"]')!
  await act(async () => { select.value = 'document:b'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => waiting.resolve({ ok: true, value: model }))
  expect(MatchingWorker.instances).toHaveLength(0)
  expect(cache.stats.parsed.entries).toBe(0)
  expect(host.textContent).not.toContain('Preparing comparison')
})

it('closing while unary parses are pending releases inputs and ignores later responses', async () => {
  const waiting = deferred<{ ok: true; value: PlanDocument }>()
  parse.mockImplementation(() => waiting.promise)
  await render(); await click('Compare selected plans'); await render(false)
  await act(async () => waiting.resolve({ ok: true, value: model }))
  expect(MatchingWorker.instances).toHaveLength(0); expect(cache.stats.parsed.entries).toBe(0)
})

it('swapping while loads are pending joins the two parses already in flight and matches only the new ordering', async () => {
  const waiting = deferred<{ ok: true; value: PlanDocument }>()
  parse.mockImplementation(() => waiting.promise)
  await render(); await click('Compare selected plans'); await click('Swap plans'); await click('Swap plans'); await click('Swap plans')
  expect(parse).toHaveBeenCalledTimes(2)
  expect(cache.stats.pending).toBe(2)
  await act(async () => waiting.resolve({ ok: true, value: model }))
  expect(parse).toHaveBeenCalledTimes(2)
  expect(MatchingWorker.instances).toHaveLength(1)
  const worker = MatchingWorker.instances[0]
  expect(worker.data!.left[0].id).toBe('b:s'); expect(worker.data!.right[0].id).toBe('a:s')
  await act(async () => worker.complete())
  expect(cache.stats.parsed.entries).toBe(2)
})

it('bounds preparation time and releases scopes before late unary replies settle', async () => {
  vi.useFakeTimers()
  const waiting = deferred<{ ok: true; value: PlanDocument }>()
  parse.mockImplementation(() => waiting.promise)
  await render(); await click('Compare selected plans')
  await act(async () => vi.advanceTimersByTime(35_000))
  expect(host.textContent).toContain('exceeded 35 seconds')
  await act(async () => waiting.resolve({ ok: true, value: model }))
  expect(MatchingWorker.instances).toHaveLength(0); expect(cache.stats.parsed.entries).toBe(0)
})

it('clears stale preparation errors when a hidden comparison is shown and prepared again', async () => {
  await render(); await click('Compare selected plans')
  await act(async () => MatchingWorker.instances[0].onmessage?.({ data: { ok: false, error: 'Previous matching failure' } }))
  expect(host.textContent).toContain('Previous matching failure')
  await render(true, false); await render(true, true)
  await act(async () => MatchingWorker.instances.at(-1)!.complete())
  expect(host.textContent).not.toContain('Previous matching failure')
  expect(host.textContent).toContain('1 paired operators')
})

it('swapping a finished comparison reuses both parsed inputs and their layouts, and reverses the sides', async () => {
  await render(); await click('Compare selected plans')
  await act(async () => MatchingWorker.instances[0].complete())
  expect(parse).toHaveBeenCalledTimes(2)
  const before = [...viewers.scopes] as string[]
  expect(new Set(before).size).toBe(2)
  cache.rememberLayout(before[0], 'topology', { nodes: [], edges: [] } as never, [])
  await click('Swap plans')
  expect(MatchingWorker.instances[0].terminated).toBe(true)
  const worker = MatchingWorker.instances[1]
  expect(worker.data!.left[0].id).toBe('b:s'); expect(worker.data!.right[0].id).toBe('a:s')
  await act(async () => worker.complete())
  expect(parse).toHaveBeenCalledTimes(2)
  expect(viewers.scopes).toEqual([before[1], before[0]])
  expect(cache.layout(before[0], 'topology')).toBeDefined()
  expect(cache.stats.parsed.entries).toBe(2)
})

it('comparing again replaces the inputs: the previous preparations and layouts are released and both inputs parse afresh', async () => {
  await render(); await click('Compare selected plans')
  await act(async () => MatchingWorker.instances[0].complete())
  const before = [...viewers.scopes] as string[]
  cache.rememberLayout(before[0], 'topology', { nodes: [], edges: [] } as never, [])
  await click('Swap plans'); await click('Compare selected plans')
  await act(async () => MatchingWorker.instances.at(-1)!.complete())
  expect(parse).toHaveBeenCalledTimes(4)
  expect(cache.layout(before[0], 'topology')).toBeUndefined()
  expect(cache.stats.parsed.entries).toBe(2)
  expect(viewers.scopes.some(scope => before.includes(scope!))).toBe(false)
})

it('tells apart open documents that share a name before either is acquired', async () => {
  const original = docState.documents
  docState.documents = [{ id: 'a', name: 'query.sqlplan', kind: 'sqlplan', dirty: false, file: { path: 'C:\\plans\\before\\query.sqlplan' } },
    { id: 'b', name: 'query.sqlplan', kind: 'sqlplan', dirty: false, file: { path: 'C:\\plans\\after\\query.sqlplan' } }] as unknown as typeof original
  try {
    await render()
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Left comparison input"]')!
    expect(Array.from(select.options, option => option.textContent)).toEqual(['Document · query.sqlplan · C:\\plans\\before', 'Document · query.sqlplan · C:\\plans\\after'])
    expect(select.getAttribute('aria-description')).toBe('C:\\plans\\before\\query.sqlplan')
    expect(select.options[1].title).toBe('C:\\plans\\after\\query.sqlplan')
  } finally { docState.documents = original }
})
