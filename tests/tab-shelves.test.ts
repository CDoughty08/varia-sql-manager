// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DockviewGroupPanel } from 'dockview-react'
import { GestureService } from '../src/renderer/src/core/gestures'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { QueryTab } from '../src/renderer/src/documents'
import { TabShelfLayout, type ShelfState } from '../src/renderer/src/editor-groups/TabShelves'

class TestStore<T> extends SnapshotStore<T> {
  set(value: T): void { this.publish(value) }
}

const frames = new Map<number, FrameRequestCallback>()
const observers: { notify(): void; disconnect: ReturnType<typeof vi.fn> }[] = []
const layouts: TabShelfLayout[] = []
let nextFrame = 0

function flushFrames(): void {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(performance.now())
}

function fixture(pinnedCount = 6, unpinnedCount = 6) {
  const tabs: QueryTab[] = [
    ...Array.from({ length: pinnedCount }, (_, index) => ({ id: `p${index + 1}`, name: `Pinned ${index + 1}`, pinned: true, dirty: false, savedVersionId: 1, database: '' })),
    ...Array.from({ length: unpinnedCount }, (_, index) => ({ id: `q${index + 1}`, name: `Query ${index + 1}`, dirty: false, savedVersionId: 1, database: '' }))
  ]
  const documents = new TestStore(tabs), tabRename = new TestStore({ id: '' }), theme = new TestStore(0)
  const element = document.createElement('div'), header = document.createElement('div'), list = document.createElement('div'), content = document.createElement('div')
  const size = { width: 570, height: 864 }
  header.className = 'dv-tabs-and-actions-container'
  element.append(header, content)
  header.append(list)
  list.style.setProperty('--varia-bar', '36px')
  Object.defineProperty(list, 'clientWidth', { get: () => size.width })
  Object.defineProperty(element, 'clientHeight', { get: () => size.height })
  list.getBoundingClientRect = () => new DOMRect(20, 100, size.width, parseFloat(list.style.height) || 36)
  const nodes = new Map(tabs.map(tab => {
    const node = document.createElement('div'), content = document.createElement('div')
    node.className = 'dv-tab'
    node.tabIndex = -1
    node.setAttribute('role', 'tab')
    content.dataset.tabId = tab.id
    node.append(content)
    list.append(node)
    return [tab.id, node] as const
  }))
  document.body.append(element)
  const activeListeners = new Set<() => void>()
  const panels = tabs.map(tab => ({ id: tab.id }))
  const group = {
    element, header: { element: header }, model: { tabsListElement: list }, panels,
    activePanel: panels[0], relayout: vi.fn(),
    api: { onDidActivePanelChange: (listener: () => void) => {
      activeListeners.add(listener)
      return { dispose: () => activeListeners.delete(listener) }
    } }
  }
  const keybindings = { controlWheelGesture: 1 as number | undefined }
  const workbench = {
    documents: { get: (id: string) => documents.getSnapshot().find(tab => tab.id === id), subscribe: documents.subscribe },
    tabRename, theme, keybindings, gestures: new GestureService('win32')
  } as unknown as Workbench
  const changed = vi.fn<(shelves: ShelfState[]) => void>()
  const layout = new TabShelfLayout(group as unknown as DockviewGroupPanel, workbench, changed)
  layouts.push(layout)
  const shelves = () => changed.mock.lastCall![0]
  const shelf = (pinned: boolean) => shelves().find(value => value.pinned === pinned)!
  const visible = (pinned: boolean) => tabs.filter(tab => !!tab.pinned === pinned && !nodes.get(tab.id)!.hasAttribute('data-tab-overflow')).map(tab => tab.id)
  const wheel = (y: number, deltaY: number, options: WheelEventInit = {}, target = list) => {
    const input = { bubbles: true, cancelable: true, ctrlKey: true, clientX: 40, clientY: 100 + y, deltaY, ...options }
    const event = new WheelEvent('wheel', input)
    // Happy DOM's WheelEvent omits the MouseEvent fields that Chromium supplies.
    Object.defineProperties(event, {
      ctrlKey: { value: input.ctrlKey }, clientX: { value: input.clientX }, clientY: { value: input.clientY }
    })
    target.dispatchEvent(event)
    return event
  }
  return {
    tabs, documents, tabRename, theme, element, list, header, content, nodes, group, keybindings, layout, changed, size, shelves, shelf, visible, wheel,
    activate(id: string) {
      group.activePanel = panels.find(panel => panel.id === id)!
      activeListeners.forEach(listener => listener())
    },
    resize(width: number, height: number) {
      size.width = width
      size.height = height
      observers.forEach(observer => observer.notify())
      flushFrames()
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    readonly disconnect = vi.fn()
    constructor(notify: () => void) { observers.push({ notify, disconnect: this.disconnect }) }
    observe(): void {}
  })
})

afterEach(() => {
  layouts.splice(0).forEach(layout => layout.dispose())
  frames.clear()
  observers.length = 0
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('editor group tab shelves', () => {
  it('adds and removes rows independently over pinned and unpinned tabs, while ordinary wheel input remains unhandled', () => {
    const view = fixture()
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    expect(view.wheel(18, 40).defaultPrevented).toBe(true)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([2, 1])
    view.wheel(90, 40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([2, 2])
    view.wheel(90, -40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([2, 1])
    view.wheel(18, -40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    expect(view.wheel(18, 80, { ctrlKey: false }).defaultPrevented).toBe(false)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
  })

  it('accumulates high-resolution wheel input and normalizes line and page deltas', () => {
    const view = fixture()
    for (let count = 0; count < 3; count++) view.wheel(18, 10)
    expect(view.shelf(true).rows).toBe(1)
    view.wheel(18, 10)
    expect(view.shelf(true).rows).toBe(2)
    view.wheel(18, -2, { deltaMode: 1 })
    expect(view.shelf(true).rows).toBe(1)
    view.wheel(18, 1, { deltaMode: 2 })
    expect(view.shelf(true).rows).toBe(2)
    expect(view.shelf(false).rows).toBe(1)
  })

  it('keeps row counts local to the editor group receiving the wheel event', () => {
    const first = fixture(), second = fixture()
    first.wheel(18, 40)
    expect(first.shelves().map(shelf => shelf.rows)).toEqual([2, 1])
    expect(second.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    second.wheel(54, 40)
    expect(first.shelves().map(shelf => shelf.rows)).toEqual([2, 1])
    expect(second.shelves().map(shelf => shelf.rows)).toEqual([1, 2])
  })

  it('caps both shelves after resize and restores the requested rows when room returns', () => {
    const view = fixture()
    view.layout.setRows(true, 100)
    view.layout.setRows(false, 100)
    expect(view.shelves().map(shelf => [shelf.rows, shelf.limit])).toEqual([[3, 3], [3, 3]])
    expect(view.header.style.height).toBe('216px')
    view.resize(570, 288)
    expect(view.shelves().map(shelf => [shelf.rows, shelf.limit])).toEqual([[2, 2], [2, 2]])
    expect(view.list.style.height).toBe('144px')
    view.resize(1034, 864)
    expect(view.shelves().map(shelf => [shelf.rows, shelf.limit])).toEqual([[2, 2], [2, 2]])
    view.resize(570, 864)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([3, 3])
    view.resize(570, 72)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    expect(view.group.relayout).toHaveBeenCalled()
  })

  it('uses compact controls in narrow groups so their reserved space does not overlap the tabs', () => {
    const view = fixture()
    for (const width of [240, 337, 338, 100]) {
      view.resize(width, 864)
      const compact = width < 338, reserved = compact ? 32 : 106
      expect(view.shelves().map(shelf => shelf.compact)).toEqual([compact, compact])
      for (const node of view.nodes.values()) {
        if (node.hasAttribute('data-tab-overflow')) continue
        expect(parseFloat(node.style.left) + parseFloat(node.style.width)).toBeLessThanOrEqual(width - reserved)
      }
    }
    view.resize(240, 864)
    expect(view.nodes.get('p1')!.style.width).toBe('208px')
    view.layout.setRows(true, 2)
    view.layout.setRows(false, 3)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([2, 3])
  })

  it('keeps the selected and renamed tabs visible without reordering or reparenting native tabs', () => {
    const view = fixture()
    const order = view.group.panels.map(panel => panel.id), nativeOrder = [...view.list.children]
    view.activate('p5')
    view.tabRename.set({ id: 'p6' })
    expect(view.visible(true)).toEqual(['p5', 'p6'])
    expect(view.shelf(true).hidden.map(tab => tab.id)).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(view.group.panels.map(panel => panel.id)).toEqual(order)
    expect([...view.list.children]).toEqual(nativeOrder)
    for (const node of view.nodes.values()) expect(node.parentElement).toBe(view.list)
    expect(view.nodes.get('p5')!.style.left).toBe('0px')
    expect(view.nodes.get('p6')!.style.left).toBe('232px')
    expect(view.list.classList.contains('dv-tabs-container--wrap')).toBe(true)
  })

  it('prioritizes the selected tab over stale focus and the rename box over selection in a one-column group', () => {
    const view = fixture()
    view.resize(338, 864)
    view.nodes.get('p1')!.focus()
    view.activate('p5')
    expect(view.visible(true)).toEqual(['p5'])
    view.tabRename.set({ id: 'p6' })
    expect(view.visible(true)).toEqual(['p6'])
    expect(view.group.panels.map(panel => panel.id)).toEqual(view.tabs.map(tab => tab.id))
  })

  it('keeps a promoted drag destination in place while the native pointer press activates the source tab', async () => {
    const view = fixture()
    view.activate('p6')
    const source = view.nodes.get('p1')!, destination = view.nodes.get('p6')!
    const targetPosition = [destination.style.left, destination.style.top]
    expect(view.visible(true)).toEqual(['p1', 'p6'])
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }))
    // Dockview activates a pressed tab before its native drag begins.
    view.activate('p1')
    view.documents.set([...view.tabs])
    flushFrames()
    expect(view.visible(true)).toEqual(['p1', 'p6'])
    expect([destination.style.left, destination.style.top]).toEqual(targetPosition)
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }))
    // The native drop handler still sees the same target until the release event finishes.
    expect(view.visible(true)).toEqual(['p1', 'p6'])
    await Promise.resolve()
    flushFrames()
    // Chromium may run a microtask checkpoint between native pointerup listeners, before the drop has committed.
    expect(view.visible(true)).toEqual(['p1', 'p6'])
    await vi.waitFor(() => { flushFrames(); expect(view.visible(true)).toEqual(['p1', 'p2']) })
    expect(view.group.panels.map(panel => panel.id)).toEqual(view.tabs.map(tab => tab.id))
  })

  it.each(['pointercancel', 'blur'])('releases the pinned drag layout after %s', async release => {
    const view = fixture()
    view.activate('p6')
    view.nodes.get('p1')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }))
    view.activate('p1')
    expect(view.visible(true)).toEqual(['p1', 'p6'])
    if (release === 'blur') {
      const owner = view.list.ownerDocument.defaultView!, event = new Event('blur')
      // Match Chromium's window-blur target identity for the shared helper's window-only blur guard.
      Object.defineProperty(event, 'target', { value: owner })
      owner.dispatchEvent(event)
    }
    else document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, isPrimary: true }))
    await Promise.resolve()
    flushFrames()
    expect(view.visible(true)).toEqual(['p1', 'p6'])
    await vi.waitFor(() => { flushFrames(); expect(view.visible(true)).toEqual(['p1', 'p2']) })
    view.activate('p5')
    expect(view.visible(true)).toEqual(['p1', 'p5'])
  })

  it('keeps normal selection promotion available after a secondary tab press', () => {
    const view = fixture()
    view.activate('p6')
    view.nodes.get('p1')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, pointerId: 1, isPrimary: true }))
    view.activate('p1')
    expect(view.visible(true)).toEqual(['p1', 'p2'])
  })

  it('keeps a stationary wheel gesture on its original shelf until Control is released and pressed again', () => {
    const view = fixture()
    view.layout.setRows(true, 3)
    view.layout.setRows(false, 3)
    // The pointer begins in the third pinned row. After it collapses, the unpinned shelf moves under that same point.
    view.wheel(90, -40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([2, 3])
    view.wheel(90, -40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 3])
    view.keybindings.controlWheelGesture = (view.keybindings.controlWheelGesture ?? 0) + 1
    view.wheel(90, -40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 2])
  })

  it('retargets the wheel to the section under the pointer when it moves', () => {
    const view = fixture()
    view.layout.setRows(true, 3)
    view.layout.setRows(false, 3)
    view.wheel(90, -40)
    view.wheel(90, -40, { clientX: 41 })
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([2, 2])
  })

  it('continues collapsing a single shelf after the stationary pointer is over the editor content', () => {
    const view = fixture(6, 0)
    view.layout.setRows(true, 3)
    view.wheel(90, -40)
    expect(view.shelf(true).rows).toBe(2)
    expect(view.wheel(90, -40, {}, view.content).defaultPrevented).toBe(true)
    expect(view.shelf(true).rows).toBe(1)
    view.keybindings.controlWheelGesture = (view.keybindings.controlWheelGesture ?? 0) + 1
    expect(view.wheel(90, 40, {}, view.content).defaultPrevented).toBe(false)
    expect(view.shelf(true).rows).toBe(1)
  })

  it('continues collapsing the lower shelf outside the header and gives editor wheel input back when the pointer moves', () => {
    const view = fixture()
    view.layout.setRows(false, 3)
    view.wheel(126, -40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 2])
    expect(view.wheel(126, -40, {}, view.content).defaultPrevented).toBe(true)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    expect(view.wheel(127, 40, {}, view.content).defaultPrevented).toBe(false)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
  })

  it('keeps overflow rectangles below every visible header row so native wrapped drag targets exclude them', () => {
    const view = fixture()
    view.activate('p6')
    expect(view.visible(true)).toEqual(['p1', 'p6'])
    for (const node of view.nodes.values()) {
      if (node.hasAttribute('data-tab-overflow')) expect(parseFloat(node.style.top)).toBeGreaterThan(view.size.height)
      else expect(parseFloat(node.style.top)).toBeLessThan(parseFloat(view.list.style.height))
    }
    view.resize(570, 288)
    for (const node of view.nodes.values()) {
      if (node.hasAttribute('data-tab-overflow')) expect(parseFloat(node.style.top)).toBeGreaterThan(view.size.height)
    }
  })

  it('promotes an overflow tab reached by native focus and prevents a scrolled header from hiding its controls', () => {
    const view = fixture(), overflow = view.nodes.get('p6')!
    expect(overflow.hasAttribute('data-tab-overflow')).toBe(true)
    expect(parseFloat(overflow.style.left)).toBeGreaterThan(view.size.width)
    overflow.focus()
    expect(document.activeElement).toBe(overflow)
    expect(view.visible(true)).toEqual(['p1', 'p6'])
    expect(overflow.hasAttribute('data-tab-overflow')).toBe(false)
    expect(overflow.parentElement).toBe(view.list)
    view.list.scrollLeft = 900
    view.list.scrollTop = 60
    view.list.dispatchEvent(new Event('scroll'))
    expect([view.list.scrollLeft, view.list.scrollTop]).toEqual([0, 0])
  })

  it('disconnects its subscriptions, queued layout and native listeners when its group goes away', () => {
    const view = fixture()
    view.documents.set([...view.tabs])
    expect(frames.size).toBe(1)
    view.layout.dispose()
    expect(frames.size).toBe(0)
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
    const updates = view.changed.mock.calls.length
    view.activate('p6')
    view.documents.set([])
    view.tabRename.set({ id: 'p5' })
    view.theme.set(1)
    flushFrames()
    expect(view.wheel(18, 40).defaultPrevented).toBe(false)
    expect(view.changed).toHaveBeenCalledTimes(updates)
  })
})
