// @vitest-environment happy-dom
import { act, createElement, createRef, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, expect, it, vi } from 'vitest'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import PlanViewer, { type PlanNavigation, type PlanViewerHandle, type PlanViewerProps } from '../src/renderer/src/plans/PlanViewer'
import { PlanPreparationCache } from '../src/renderer/src/plans/preparation'
import { layoutPlans, type LayoutStatement } from '../src/renderer/src/plans/layout'
import type { SourceStatement } from '../src/renderer/src/plans/sources'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import { defaultSettings, type BooleanSettingKey } from '../src/shared/settings/catalog'

const mocks = vi.hoisted(() => {
  let release = () => {}
  const imported = new Promise<void>(resolve => { release = resolve })
  return { canvas: vi.fn(), imported, release: () => release(), visibility: new Set<(visible: boolean) => void>() }
})
// The first import of the canvas module stays pending until a test releases it.
vi.mock('../src/renderer/src/plans/PlanCanvas', async () => {
  await mocks.imported
  return { PlanCanvas: class { constructor(options: unknown) { mocks.canvas(options) } select() {} preferences() {} update() {} colors() {} dispose() {} restoreCamera() {} } }
})
vi.mock('../src/renderer/src/core/windows', () => ({
  observeIntersection: (_element: Element, callback: (entries: { isIntersecting: boolean }[]) => void) => {
    const changed = (visible: boolean) => callback([{ isIntersecting: visible }])
    mocks.visibility.add(changed)
    return { dispose() { mocks.visibility.delete(changed) } }
  }, observeResize: () => ({ dispose() {} }), windows: { onDidAdopt: () => ({ dispose() {} }) }
}))
vi.stubGlobal('Worker', class {
  onmessage?: (event: { data: unknown }) => void
  postMessage(statements: LayoutStatement[]) { queueMicrotask(() => this.onmessage?.({ data: { ok: true, layout: layoutPlans(statements) } })) }
  terminate() {}
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const cache = new PlanPreparationCache(), theme = { active: resolveBuiltin('dark') }
let settings = { values: { ...defaultSettings } }
const settingsListeners = new Set<() => void>()
const workbench = { planPreparation: cache, theme: { getSnapshot: () => theme, subscribe: () => () => {} },
  settings: { getSnapshot: () => settings, subscribe: (listener: () => void) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener) },
    toggle: (key: BooleanSettingKey) => { settings = { values: { ...settings.values, [key]: !settings.values[key] } }; for (const listener of settingsListeners) listener() } },
  resultClient: { backendGeneration: 1, onGeneration: () => ({ dispose() {} }) } } as unknown as Workbench

const operator = (id: string, parentId: string | null, physicalOp: string) => ({ id, parentId, nodeId: id, physicalOp, logicalOp: physicalOp, object: '', estimatedRows: 1, estimatedCost: null, actualRows: null,
  elapsedMs: null, cpuMs: null, executions: null, warnings: [], properties: [] })
const statement = (id: string, nodes: ReturnType<typeof operator>[]) => ({ id, type: 'SELECT', text: '', estimatedCost: null, warnings: [], sourceKey: 'document', nodes }) as unknown as SourceStatement
// A chain of 120 operators: every operator but the last is a branch, and the outline needs virtual scrolling.
const chain = () => Array.from({ length: 120 }, (_, index) => operator('n' + index, index ? 'n' + (index - 1) : null, 'Operator ' + index))
const prepared = () => ({ statements: [statement('s1', chain()), statement('s2', [operator('other', null, 'Other scan')])], notices: [] })

const mounted: { unmount(): void; host: HTMLElement }[] = []
function mount() {
  const host = document.createElement('div'), root = createRoot(host)
  document.body.append(host)
  mounted.push({ host, unmount: () => root.unmount() })
  const render = (...viewers: Partial<PlanViewerProps>[]) => act(async () => root.render(createElement(WorkbenchProvider, { workbench,
    children: viewers.map((props, index) => createElement(PlanViewer, { key: index, sources: [], identity: 'view' + index, transient: true, compact: true, ...props })) })))
  return { host, render }
}
afterAll(async () => { await act(async () => { for (const entry of mounted) entry.unmount() }); for (const entry of mounted) entry.host.remove(); cache.dispose(); vi.unstubAllGlobals() })
const button = (host: Element, text: string) => Array.from(host.querySelectorAll('button')).find(entry => entry.textContent === text)!
/** happy-dom has no layout: give the outline a 320px viewport (ten rows) and a real scroll offset. */
function viewport(tree: HTMLElement) {
  let top = 0
  Object.defineProperty(tree, 'clientHeight', { get: () => tree.closest('[hidden]') ? 0 : 320 })
  Object.defineProperty(tree, 'scrollTop', { get: () => tree.closest('[hidden]') ? 0 : top, set: (value: number) => { top = value } })
}

it('creates a lazily imported canvas with the Row flow and Minimap preferences current at that moment', async () => {
  const { host, render } = mount()
  await render({ prepared: prepared() })
  await act(async () => { for (const changed of [...mocks.visibility]) changed(true) })
  expect(mocks.canvas).not.toHaveBeenCalled()
  expect(settings.values['queryResults.plan.rowFlow'] && settings.values['queryResults.plan.minimap']).toBe(true)
  await act(async () => { button(host, 'Row flow').click(); button(host, 'Minimap').click() })
  expect(button(host, 'Row flow').getAttribute('aria-pressed')).toBe('false')
  expect(button(host, 'Minimap').getAttribute('aria-pressed')).toBe('false')
  await act(async () => { mocks.release(); await mocks.imported })
  await vi.waitFor(() => expect(mocks.canvas).toHaveBeenCalledTimes(1))
  expect(mocks.canvas.mock.lastCall?.[0]).toMatchObject({ rowFlow: false, minimap: false })
  await act(async () => { button(host, 'Row flow').click(); button(host, 'Minimap').click() })
})

it('reveals a host-linked selection in the virtual outline and the graph without emitting a selection', async () => {
  const { host, render } = mount()
  const selected = vi.fn(), select = vi.fn(), controller = createRef<PlanViewerHandle>(), content = prepared()
  const props = (navigation: PlanNavigation): Partial<PlanViewerProps> => ({ prepared: content, controllerRef: controller, onSelectionChanged: selected, navigation: { select, ...navigation } })
  await render(props({ selected: '' }))
  const tree = host.querySelector<HTMLElement>('[role="tree"]')!
  viewport(tree)
  await render(props({ selected: 'n90' }))
  // The counterpart row is scrolled into the ten-row viewport, mounted, selected and exposed to assistive technology.
  expect(tree.scrollTop).toBe(91 * 32 - 320)
  const row = host.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')!
  expect(row.textContent).toContain('Operator 90')
  expect(tree.getAttribute('aria-activedescendant')).toBe(row.id)
  expect(controller.current?.getSelectedOperator()).toBe('n90')
  // A collapsed ancestor of the next linked selection is expanded again.
  const item = (text: string) => Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(entry => entry.textContent?.includes(text))!
  await render(props({ selected: 'n85' }))
  await act(async () => button(host, 'Collapse inputs').click())
  expect(item('Operator 85').getAttribute('aria-expanded')).toBe('false')
  // Remote updates never echo. The local Collapse click above legitimately reported its selection to the host.
  expect(selected).not.toHaveBeenCalled()
  select.mockClear()
  await render(props({ selected: 'n88' }))
  expect(item('Operator 85').getAttribute('aria-expanded')).toBe('true')
  expect(item('Operator 88').getAttribute('aria-selected')).toBe('true')
  // A selection made while the outline is hidden is revealed when the outline returns.
  await act(async () => button(host, 'Outline').click())
  await render(props({ selected: 'n5' }))
  await act(async () => button(host, 'Outline').click())
  expect(tree.scrollTop).toBe(5 * 32)
  expect(tree.getAttribute('aria-activedescendant')).toBe(item('Operator 5').id)
  // Another statement's operator switches the outline to that statement.
  await render(props({ selected: 'other' }))
  expect(item('Other scan').getAttribute('aria-selected')).toBe('true')
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Plan statement"]')!.value).toBe('s2')
  // Remote updates never echo: no selection event and no host callback.
  expect(selected).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
  // A host echoing a local selection leaves no reveal behind: filtering afterwards returns the outline to the top.
  await render(props({ selected: 'n100' }))
  await act(async () => item('Operator 99').click())
  expect(select).toHaveBeenCalledExactlyOnceWith('n99')
  await render(props({ selected: 'n99' }))
  expect(tree.scrollTop).toBeGreaterThan(0)
  await act(async () => {
    const find = host.querySelector<HTMLInputElement>('[aria-label="Find plan operators"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(find, 'Operator 9')
    find.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Operator 9 and 90 to 99 match; the selected Operator 99 is the eleventh row, just below the viewport.
  expect(host.querySelector('[role="status"].plan-outline-summary')?.textContent).toContain('11 matching')
  expect(tree.scrollTop).toBe(0)
  await act(async () => { if (!settings.values['queryResults.plan.outline']) button(host, 'Outline').click() })
})

it('clears a linked selection through selectOperator and echoes between two viewers without looping', async () => {
  const { host, render } = mount()
  const controllers = [createRef<PlanViewerHandle>(), createRef<PlanViewerHandle>()], events: string[][] = [[], []], content = prepared()
  // Each viewer forwards its selection to its peer, as a host linking two views of the same plan would.
  const linked = (index: number, peer: RefObject<PlanViewerHandle | null>): Partial<PlanViewerProps> => ({ prepared: content, controllerRef: controllers[index],
    onSelectionChanged: id => { events[index].push(id); peer.current?.selectOperator(id) } })
  await render(linked(0, controllers[1]), linked(1, controllers[0]))
  const views = Array.from(host.querySelectorAll<HTMLElement>('.plan-viewer'))
  await act(async () => views[0].querySelector<HTMLElement>('[role="treeitem"]')!.click())
  expect(controllers.map(entry => entry.current?.getSelectedOperator())).toEqual(['n0', 'n0'])
  expect(events).toEqual([['n0'], ['n0']])
  // Choosing a statement clears the source viewer's operator; the forwarded '' clears the peer too.
  await act(async () => { const statements = views[0].querySelector<HTMLSelectElement>('[aria-label="Plan statement"]')!; statements.value = 's2'; statements.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(controllers.map(entry => entry.current?.getSelectedOperator())).toEqual(['', ''])
  expect(events).toEqual([['n0', ''], ['n0', '']])
  expect(views[1].querySelector('[role="treeitem"][aria-selected="true"]')).toBeNull()
  // Unknown non-empty ids are still ignored, and clearing an empty selection changes nothing.
  await act(async () => controllers[1].current?.selectOperator('n3'))
  await act(async () => { controllers[1].current?.selectOperator('unknown'); controllers[0].current?.selectOperator('unknown') })
  expect(controllers.map(entry => entry.current?.getSelectedOperator())).toEqual(['n3', 'n3'])
  await act(async () => { controllers[1].current?.selectOperator(''); controllers[1].current?.selectOperator('') })
  expect(controllers.map(entry => entry.current?.getSelectedOperator())).toEqual(['', ''])
  expect(events).toEqual([['n0', '', 'n3', ''], ['n0', '', 'n3', '']])
})
