// @vitest-environment happy-dom
import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import PlanViewer, { type PlanViewerHandle } from '../src/renderer/src/plans/PlanViewer'
import { PlanPreparationCache } from '../src/renderer/src/plans/preparation'
import { layoutPlans, type LayoutStatement } from '../src/renderer/src/plans/layout'
import type { QueryPlanState } from '../src/renderer/src/plans/QueryPlansService'
import type { PlanSource } from '../src/renderer/src/plans/sources'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import { defaultSettings, type BooleanSettingKey } from '../src/shared/settings/catalog'
import type { PlanDocument } from '../src/shared/plans'

const mocks = vi.hoisted(() => ({ canvas: vi.fn(), update: vi.fn(), dispose: vi.fn(), worker: vi.fn(),
  viewerVisibility: undefined as ((visible: boolean) => void) | undefined, canvasVisibility: undefined as ((visible: boolean) => void) | undefined,
  observe: undefined as ((visible: boolean, canvasVisible?: boolean) => void) | undefined }))
vi.mock('../src/renderer/src/plans/PlanCanvas', () => ({ PlanCanvas: class {
  constructor(options: unknown) { mocks.canvas(options) }
  select() {} preferences() {} update = mocks.update; colors() {} dispose = mocks.dispose
} }))
vi.mock('../src/renderer/src/core/windows', () => ({
  observeIntersection: (element: Element, callback: (entries: { isIntersecting: boolean }[]) => void) => {
    const field = element.getAttribute('aria-label') === 'Query plan canvas' ? 'canvasVisibility' : 'viewerVisibility'
    const changed = (visible: boolean) => callback([{ isIntersecting: visible }])
    mocks[field] = changed
    mocks.observe = (visible, canvasVisible = visible) => { mocks.viewerVisibility?.(visible); mocks.canvasVisibility?.(canvasVisible) }
    return { dispose() { if (mocks[field] === changed) mocks[field] = undefined } }
  }, observeResize: () => ({ dispose() {} }), windows: { onDidAdopt: () => ({ dispose() {} }) }
}))

const cache = new PlanPreparationCache(), host = document.createElement('div'), root = createRoot(host)
document.body.append(host)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let generation: ((value: number) => void) | undefined
const workbench = { planPreparation: cache, theme: { getSnapshot: () => theme, subscribe: () => () => {} },
  settings: { getSnapshot: () => settings, subscribe: (listener: () => void) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener) },
    toggle: (key: BooleanSettingKey) => { settings = { values: { ...settings.values, [key]: !settings.values[key] } }; for (const listener of settingsListeners) listener() } },
  resultClient: { backendGeneration: 1, onGeneration: (listener: typeof generation) => { generation = listener; return { dispose() {} } } } } as unknown as Workbench
const theme = { active: resolveBuiltin('dark') }
let settings = { values: { ...defaultSettings } }
const settingsListeners = new Set<() => void>()
const model: PlanDocument = { version: '', build: '', notices: [], statements: [{ id: 's', type: 'SELECT', text: '', estimatedCost: null, warnings: [], nodes: [
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
const controller = createRef<PlanViewerHandle>()
const selectedEvents: string[] = []
async function render(sources: PlanSource[] | null, visible = true, live?: QueryPlanState) {
  await act(async () => root.render(createElement(WorkbenchProvider, { workbench, children: sources ? createElement(PlanViewer, { sources, identity: 'doc', scope: 'doc', visible, live, controllerRef: controller,
    onSelectionChanged: id => { selectedEvents.push(id); controller.current?.selectOperator(id) } }) : null })))
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
  expect(Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Statement SQL')!.disabled).toBe(true)
  const camera = { x: 25, y: 30, scale: 0.8 }
  await act(async () => mocks.canvas.mock.calls[0][0].cameraChanged(camera))
  expect(controller.current?.getCamera()).toEqual(camera)
  controller.current!.getCamera()!.x = 100
  expect(controller.current?.getCamera()?.x).toBe(25)
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
  expect(mocks.canvas.mock.lastCall?.[0].camera).toEqual(camera)
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
  await render(null)
  cache.clear()
  const priorWorkers = mocks.worker.mock.calls.length, priorCanvases = mocks.canvas.mock.calls.length
  await render([input])
  await act(async () => mocks.observe?.(true, false))
  expect(parse).toHaveBeenCalledTimes(6)
  expect(host.querySelector('[role="treeitem"]')?.textContent).toContain('Scan')
  expect(mocks.worker).toHaveBeenCalledTimes(priorWorkers)
  expect(mocks.canvas).toHaveBeenCalledTimes(priorCanvases)
  await render(null)
  cache.clear()
  // A hidden input stays searchable and selecting it expands its ancestors. The projected layout
  // must still address the original model indices, including after Graph/XML-style unmounts.
  const nodes = model.statements[0].nodes
  nodes.push({ ...nodes[0], id: 'child', parentId: 'n', nodeId: '1', physicalOp: 'Hidden input' })
  await render([input])
  await act(async () => mocks.observe?.(true))
  await act(async () => host.querySelector<HTMLElement>('[role="treeitem"]')!.click())
  expect(controller.current?.getSelectedOperator()).toBe('document:n')
  expect(selectedEvents.filter(id => id === 'document:n')).toHaveLength(1)
  const button = (text: string) => Array.from(host.querySelectorAll('button')).find(button => button.textContent === text)!
  await act(async () => button('Collapse inputs').click())
  expect(mocks.canvas.mock.lastCall?.[0].layout.nodes).toHaveLength(1)
  expect(host.querySelector('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false')
  await act(async () => Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(row => row.textContent?.includes('Hidden input'))!.click())
  expect(mocks.canvas.mock.lastCall?.[0].layout.nodes).toHaveLength(2)
  await act(async () => controller.current?.selectOperator('document:n'))
  expect(controller.current?.getSelectedOperator()).toBe('document:n')
  await act(async () => controller.current?.selectOperator('unavailable'))
  expect(controller.current?.getSelectedOperator()).toBe('document:n')
  await act(async () => controller.current?.selectOperator('document:child'))
  expect(host.querySelector('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
  // A display:none outline reports zero scroll; reopening it must use the saved visible offset.
  const outlineTree = host.querySelector<HTMLElement>('[role="tree"]')!
  let actualScroll = 0
  Object.defineProperty(outlineTree, 'clientHeight', { get: () => settings.values['queryResults.plan.outline'] ? 16 : 0 })
  Object.defineProperty(outlineTree, 'scrollTop', { get: () => settings.values['queryResults.plan.outline'] ? actualScroll : 0, set: value => { actualScroll = value as number } })
  await act(async () => { outlineTree.scrollTop = 32; outlineTree.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await act(async () => button('Outline').click())
  await act(async () => outlineTree.dispatchEvent(new Event('scroll', { bubbles: true })))
  await act(async () => button('Outline').click())
  expect(outlineTree.scrollTop).toBe(32)
  await act(async () => button('Collapse inputs').click()) // leaf selection cannot collapse
  await act(async () => host.querySelector<HTMLElement>('[role="treeitem"]')!.click())
  await act(async () => button('Collapse inputs').click())
  await render(null)
  await render([input])
  await act(async () => mocks.observe?.(true))
  expect(host.querySelector('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false')
  expect(mocks.canvas.mock.lastCall?.[0].layout.nodes).toHaveLength(1)
  await render(null)
  nodes.pop(); cache.clear()
  vi.stubGlobal('Worker', class { constructor() { throw new Error('Worker creation refused') } })
  await render([input])
  await act(async () => mocks.observe?.(true))
  expect(host.textContent).toContain('operator outline and XML source are available')
  expect(host.querySelector('[role="treeitem"]')?.textContent).toContain('Scan')
})
