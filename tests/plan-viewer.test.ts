// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import PlanViewer from '../src/renderer/src/plans/PlanViewer'
import { PlanPreparationCache } from '../src/renderer/src/plans/preparation'
import { layoutPlans, type LayoutStatement } from '../src/renderer/src/plans/layout'
import type { QueryPlanState } from '../src/renderer/src/plans/QueryPlansService'
import type { PlanSource } from '../src/renderer/src/plans/sources'
import { resolveBuiltin } from '../src/shared/theme/resolve'

const mocks = vi.hoisted(() => ({ canvas: vi.fn(), update: vi.fn(), dispose: vi.fn(), worker: vi.fn(), observe: undefined as ((visible: boolean) => void) | undefined }))
vi.mock('../src/renderer/src/plans/PlanCanvas', () => ({ PlanCanvas: class {
  constructor(options: unknown) { mocks.canvas(options) }
  select() {} update = mocks.update; colors() {} dispose = mocks.dispose
} }))
vi.mock('../src/renderer/src/core/windows', () => ({
  observeIntersection: (_: unknown, callback: (entries: { isIntersecting: boolean }[]) => void) => {
    mocks.observe = visible => callback([{ isIntersecting: visible }])
    return { dispose() {} }
  }, observeResize: () => ({ dispose() {} }), windows: { onDidAdopt: () => ({ dispose() {} }) }
}))

const cache = new PlanPreparationCache(), host = document.createElement('div'), root = createRoot(host)
document.body.append(host)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let generation: ((value: number) => void) | undefined
const workbench = { planPreparation: cache, theme: { getSnapshot: () => theme, subscribe: () => () => {} },
  resultClient: { backendGeneration: 1, onGeneration: (listener: typeof generation) => { generation = listener; return { dispose() {} } } } } as unknown as Workbench
const theme = { active: resolveBuiltin('dark') }
const model = { version: '', build: '', notices: [], statements: [{ id: 's', type: 'SELECT', text: '', estimatedCost: null, warnings: [], nodes: [
  { id: 'n', parentId: null, nodeId: '0', physicalOp: 'Scan', logicalOp: 'Scan', object: '', estimatedRows: 1, estimatedCost: null, actualRows: null, elapsedMs: null, cpuMs: null, executions: null, warnings: [], properties: [] }
] }] }
const parse = vi.fn(async () => ({ ok: true, value: model }))
Object.assign(window, { varia: { parsePlan: parse } })
vi.stubGlobal('Worker', class {
  onmessage?: (event: { data: unknown }) => void
  constructor() { mocks.worker() }
  postMessage(statements: LayoutStatement[]) { queueMicrotask(() => this.onmessage?.({ data: { ok: true, layout: layoutPlans(statements) } })) }
  terminate() {}
})
const input: PlanSource = { key: 'document', revision: 1, label: 'Plan', read: vi.fn(async () => '<ShowPlanXML/>') }
async function render(sources: PlanSource[] | null, visible = true, live?: QueryPlanState) {
  await act(async () => root.render(createElement(WorkbenchProvider, { workbench, children: sources ? createElement(PlanViewer, { sources, identity: 'doc', scope: 'doc', visible, live }) : null })))
}
afterEach(async () => { await act(async () => root.unmount()); cache.dispose(); host.remove(); vi.unstubAllGlobals() })

it('does no hidden preparation, reuses parsed plans and layout on remount, and preserves incremental counters', async () => {
  await render([input], false)
  await act(async () => mocks.observe?.(true))
  expect(parse).not.toHaveBeenCalled()
  expect(mocks.worker).not.toHaveBeenCalled()
  expect(mocks.canvas).not.toHaveBeenCalled()
  await render([input])
  expect(parse).toHaveBeenCalledTimes(1)
  expect(mocks.worker).toHaveBeenCalledTimes(1)
  expect(mocks.canvas).toHaveBeenCalledTimes(1)
  // A GPU retry must recreate Pixi even when the layout cache returns the identical object.
  await act(async () => (mocks.canvas.mock.calls[0][0] as { failed(): void }).failed())
  await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Retry plan viewer')!.click())
  expect(mocks.canvas).toHaveBeenCalledTimes(2)
  expect(parse).toHaveBeenCalledTimes(1)
  expect(mocks.worker).toHaveBeenCalledTimes(1)
  await render(null)
  await render([input])
  await act(async () => mocks.observe?.(true))
  expect(parse).toHaveBeenCalledTimes(1)
  expect(input.read).toHaveBeenCalledTimes(1)
  expect(mocks.worker).toHaveBeenCalledTimes(1)
  const next = { ...input, key: 'appended' }
  await render([input, next])
  expect(parse).toHaveBeenCalledTimes(2)
  expect(input.read).toHaveBeenCalledTimes(2) // same reader, called for the newly appended source only
  const workers = mocks.worker.mock.calls.length
  await render([input, next])
  expect(mocks.worker).toHaveBeenCalledTimes(workers)
  await render(null)
  const live: QueryPlanState = { queryId: 'query', running: true, note: '', model: { revision: 1, batch: 1, iteration: 1, counterIds: new Map(),
    statements: model.statements.map(s => ({ ...s, sourceKey: 'live' })) } }
  await render([], true, live)
  await act(async () => mocks.observe?.(true))
  const liveWorkers = mocks.worker.mock.calls.length, liveCanvases = mocks.canvas.mock.calls.length
  await render([], true, { ...live, model: { ...live.model, statements: live.model.statements.map(s => ({ ...s, nodes: s.nodes.map(n => ({ ...n, actualRows: 123 })) })) } })
  expect(mocks.worker).toHaveBeenCalledTimes(liveWorkers)
  expect(mocks.canvas).toHaveBeenCalledTimes(liveCanvases)
  expect(mocks.update.mock.lastCall?.[0][0].nodes[0].actualRows).toBe(123)
  await render(null)
  await render([input, next])
  await act(async () => mocks.observe?.(true))
  cache.clear()
  await act(async () => generation?.(2))
  expect(parse).toHaveBeenCalledTimes(4)
  await render(null)
  await render([{ ...input, revision: 2 }])
  await act(async () => mocks.observe?.(true))
  expect(parse).toHaveBeenCalledTimes(5)
})
