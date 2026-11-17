// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createDockview, type DockviewApi, type IContentRenderer } from 'dockview-react'
import { OutputYield, yieldingGroup, type Measure } from '../src/renderer/src/output-yield'
import { parseWorkspaceLayout, withGroupShown, type WorkspaceLayout } from '../src/shared/layouts'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

/** The workbench's default arrangement in a real Dockview: Object Explorer left of the editor, the output panels tabbed below it. */
function workbench() {
  const element = document.createElement('div')
  document.body.append(element)
  const api = createDockview(element, { createComponent: (): IContentRenderer => ({ element: document.createElement('div'), init() {} }) })
  cleanups.push(() => { api.dispose(); element.remove() })
  api.layout(1200, 800)
  api.addPanel({ id: 'editor', title: 'Query editor', component: 'workbench' })
  api.addPanel({ id: 'explorer', title: 'Object Explorer', component: 'workbench', initialWidth: 278, position: { referencePanel: 'editor', direction: 'left' } })
  api.addPanel({ id: 'results', title: 'Results', component: 'workbench', initialHeight: 240, position: { referencePanel: 'editor', direction: 'below' } })
  for (const id of ['messages', 'plan']) api.addPanel({ id, title: id, component: 'workbench', inactive: true, position: { referencePanel: 'results', direction: 'within' } })
  api.layout(1200, 800)
  return api
}
/** Boxes from Dockview's own sizes, as happy-dom lays nothing out: groups stack in the editor's column from its top. */
const column = (api: DockviewApi): Measure => element => {
  const editor = api.getPanel('editor')!.group, left = 1200 - editor.api.width
  if (element === editor.element) return { left, right: 1200, top: 0, bottom: editor.api.height }
  const group = api.groups.find(item => item.element === element)!
  if (group.panels.some(panel => panel.id === 'explorer')) return { left: 0, right: left, top: 0, bottom: 800 }
  return { left, right: 1200, top: editor.api.height, bottom: editor.api.height + group.api.height }
}
const results = (api: DockviewApi) => api.getPanel('results')!.group

describe('output yield', () => {
  it('hides the output group below the editor and restores it at its size', () => {
    const api = workbench(), yielding = new OutputYield(column(api))
    // The user resized the output to 300 px.
    results(api).api.setSize({ height: 300 })
    expect(results(api).api.height).toBe(300)
    const group = yielding.yieldSpace(api)
    expect(group?.id).toBe(results(api).id)
    expect(results(api).api.isVisible).toBe(false)
    expect(api.getPanel('editor')!.group.api.height).toBe(800)
    // Already hidden: nothing more to do.
    expect(yielding.yieldSpace(api)).toBeUndefined()
    expect(yielding.restore(api)).toBe(true)
    expect(results(api).api.isVisible).toBe(true)
    expect(results(api).api.height).toBe(300)
    expect(api.getPanel('editor')!.group.api.height).toBe(500)
    expect(yielding.restore(api)).toBe(false)
  })

  it('saves the layout with the output shown at its size while it is hidden', () => {
    const api = workbench(), yielding = new OutputYield(column(api))
    results(api).api.setSize({ height: 260 })
    const before = parseWorkspaceLayout(api.toJSON() as WorkspaceLayout)
    yielding.yieldSpace(api)
    const hidden = parseWorkspaceLayout(api.toJSON() as WorkspaceLayout)
    expect(JSON.stringify(hidden)).toContain('"visible":false')
    // What is persisted is the layout from before the yield, so the yield writes nothing.
    expect(yielding.saved(hidden)).toEqual(before)
    // A layout saved while hidden and loaded again shows the output at its size.
    api.fromJSON(yielding.saved(hidden), { reuseExistingPanels: true })
    api.layout(1200, 800)
    expect(results(api).api.isVisible).toBe(true)
    expect(results(api).api.height).toBe(260)
  })

  it('keeps output panels the user moved, floated or showed', () => {
    const api = workbench()
    // Tabbed with the editor: no group of output panels only.
    const tabbed = workbench()
    tabbed.getPanel('results')!.api.moveTo({ group: tabbed.getPanel('editor')!.group })
    tabbed.getPanel('messages')!.api.moveTo({ group: tabbed.getPanel('editor')!.group })
    tabbed.getPanel('plan')!.api.moveTo({ group: tabbed.getPanel('editor')!.group })
    expect(yieldingGroup(tabbed, column(tabbed))).toBeUndefined()
    // Floating.
    const floating = workbench()
    floating.addFloatingGroup(floating.getPanel('results')!.group)
    expect(yieldingGroup(floating, column(floating))).toBeUndefined()
    // Docked right of the editor, not below it.
    const beside: Measure = element => element === api.getPanel('editor')!.group.element ? { left: 278, right: 900, top: 0, bottom: 800 } : { left: 900, right: 1200, top: 0, bottom: 800 }
    expect(yieldingGroup(api, beside)).toBeUndefined()
    // Shown again by the user while hidden: no longer restored or re-hidden by this yield.
    const yielding = new OutputYield(column(api))
    const group = yielding.yieldSpace(api)!
    group.api.setVisible(true)
    yielding.release(group.id)
    expect(yielding.groupId).toBeUndefined()
    expect(yielding.restore(api)).toBe(false)
  })

  it('shows a hidden group again when a command moves another panel into it', () => {
    const api = workbench(), yielding = new OutputYield(column(api))
    const group = yielding.yieldSpace(api)!
    // Only output panels: nothing to do.
    expect(yielding.check(api)).toBe(false)
    expect(group.api.isVisible).toBe(false)
    // Tab with Results moves the query editor into the hidden group, which would hide every document with it.
    api.getPanel('editor')!.api.moveTo({ group })
    expect(yielding.check(api)).toBe(true)
    expect(api.getPanel('editor')!.group.api.isVisible).toBe(true)
    expect(yielding.groupId).toBeUndefined()
  })

  it('shows a hidden group again when an output panel moves into it, or a docked group comes or goes', () => {
    // A floating Messages panel tabbed with Results (Tab with Results) while the output is hidden.
    const api = workbench(), yielding = new OutputYield(column(api))
    api.addFloatingGroup(api.getPanel('messages')!)
    const group = yielding.yieldSpace(api)!
    expect(yielding.check(api)).toBe(false)
    api.getPanel('messages')!.api.moveTo({ group })
    expect(yielding.check(api)).toBe(true)
    expect(group.api.isVisible).toBe(true)
    // A panel docked at the bottom while the output is hidden adds a docked group.
    const other = workbench(), second = new OutputYield(column(other))
    other.addFloatingGroup(other.getPanel('plan')!)
    second.yieldSpace(other)
    other.getPanel('plan')!.group.api.moveTo({ position: 'bottom' })
    expect(second.check(other)).toBe(true)
    expect(results(other).api.isVisible).toBe(true)
  })

  it('leaves an output group with another group below it, which would take its space instead of the editor', () => {
    const api = workbench()
    // [editor, output, Object Explorer] in one column: the boxes Dockview would lay out.
    const stacked: Measure = element => {
      const editor = api.getPanel('editor')!.group
      if (element === editor.element) return { left: 0, right: 1200, top: 0, bottom: 400 }
      if (element === results(api).element) return { left: 0, right: 1200, top: 400, bottom: 600 }
      return { left: 0, right: 1200, top: 600, bottom: 800 }
    }
    expect(yieldingGroup(api, stacked)).toBeUndefined()
    expect(yieldingGroup(api, column(api))?.id).toBe(results(api).id)
  })

  it('takes the shown size back from the sibling Dockview gave it to', () => {
    // A column of three: editor, output, and Object Explorer below them. Hiding the output gives its space to the last
    // visible sibling, Object Explorer, and the saved layout must take it back from there.
    const element = document.createElement('div')
    document.body.append(element)
    const api = createDockview(element, { createComponent: (): IContentRenderer => ({ element: document.createElement('div'), init() {} }) })
    cleanups.push(() => { api.dispose(); element.remove() })
    api.layout(1200, 800)
    api.addPanel({ id: 'editor', title: 'Query editor', component: 'workbench' })
    api.addPanel({ id: 'results', title: 'Results', component: 'workbench', position: { referencePanel: 'editor', direction: 'below' } })
    api.addPanel({ id: 'explorer', title: 'Object Explorer', component: 'workbench', position: { referencePanel: 'results', direction: 'below' } })
    api.layout(1200, 800)
    // The editor stays the largest, so taking the space from the largest sibling would be wrong.
    api.getPanel('editor')!.group.api.setSize({ height: 500 })
    const before = parseWorkspaceLayout(api.toJSON() as WorkspaceLayout), group = results(api)
    group.api.setVisible(false)
    expect(withGroupShown(parseWorkspaceLayout(api.toJSON() as WorkspaceLayout), group.id)).toEqual(before)
  })

  it('shows only the named group', () => {
    const layout = { grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { id: '1', views: ['editor'] }, size: 500 }, { type: 'leaf', data: { id: '2', views: ['results'] }, size: 300, visible: false }, { type: 'leaf', data: { id: '3', views: ['explorer'] }, size: 300, visible: false }] }, width: 800, height: 800, orientation: 'VERTICAL' }, panels: {} } as unknown as WorkspaceLayout
    const nodes = (withGroupShown(layout, '2').grid.root as unknown as { data: { visible?: boolean }[] }).data
    expect(nodes.map(node => node.visible)).toEqual([undefined, undefined, false])
    // The editor gives back the space it was given.
    expect(nodes.map(node => (node as { size?: number }).size)).toEqual([200, 300, 300])
    // The input is not changed.
    expect((layout.grid.root as unknown as { data: { visible?: boolean }[] }).data[1].visible).toBe(false)
  })
})
