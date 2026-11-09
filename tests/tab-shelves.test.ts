// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DockviewGroupPanel } from 'dockview-react'
import { GestureService } from '../src/renderer/src/core/gestures'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { QueryTab } from '../src/renderer/src/documents'
import { TabShelfLayout, type ShelfFeedback, type ShelfState } from '../src/renderer/src/editor-groups/TabShelves'

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

function fixture(pinnedCount = 6, unpinnedCount = 6, restoredRows = { pinned: 1, unpinned: 1 }) {
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
    id: 'g1',
    element, header: { element: header }, model: { tabsListElement: list }, panels,
    activePanel: panels[0], relayout: vi.fn(),
    api: { onDidActivePanelChange: (listener: () => void) => {
      activeListeners.add(listener)
      return { dispose: () => activeListeners.delete(listener) }
    } }
  }
  const keybindings = { controlWheelGesture: 1 as number | undefined }
  const storedRows = { ...restoredRows }
  const rowListeners = new Set<() => void>()
  const editorGroups = {
    getTabRows: vi.fn((_group: string) => ({ ...storedRows })),
    setTabRows: vi.fn((_group: string, rows: { pinned: number; unpinned: number }) => { Object.assign(storedRows, rows); rowListeners.forEach(listener => listener()) }),
    subscribe: vi.fn((listener: () => void) => { rowListeners.add(listener); return () => rowListeners.delete(listener) }),
    registerTabRows: vi.fn((_group: string, _adjust: (pinned: boolean, delta: 1 | -1) => void, _canAdjust?: (pinned: boolean, delta: 1 | -1) => boolean) => ({ dispose: vi.fn() }))
  }
  const workbench = {
    editorGroups,
    documents: { get: (id: string) => documents.getSnapshot().find(tab => tab.id === id), subscribe: documents.subscribe },
    tabRename, theme, keybindings, gestures: new GestureService('win32')
  } as unknown as Workbench
  const changed = vi.fn<(shelves: ShelfState[]) => void>()
  const feedback = vi.fn<(value: ShelfFeedback | undefined) => void>()
  const layout = new TabShelfLayout(group as unknown as DockviewGroupPanel, workbench, changed, feedback)
  layouts.push(layout)
  const shelves = () => changed.mock.lastCall![0]
  const shelf = (pinned: boolean) => shelves().find(value => value.pinned === pinned)!
  const visible = (pinned: boolean) => tabs.filter(tab => !!tab.pinned === pinned && !nodes.get(tab.id)!.hasAttribute('data-tab-overflow')).map(tab => tab.id)
  const wheel = (y: number, deltaY: number, options: WheelEventInit = {}, target: HTMLElement = list) => {
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
    tabs, documents, tabRename, theme, element, list, header, content, nodes, group, keybindings, editorGroups, storedRows, layout, changed, feedback, size, shelves, shelf, visible, wheel,
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('editor group tab shelves', () => {
  it('adds and removes rows independently over pinned and unpinned tabs, while ordinary wheel input only scrolls', () => {
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
    expect(view.wheel(18, 80, { ctrlKey: false }).defaultPrevented).toBe(true)
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

  it('scrolls every one-row tab horizontally without affecting the other shelf or native tab order', () => {
    const view = fixture(6, 32), original = [...view.list.children]
    expect(view.shelves().map(shelf => shelf.hidden.length)).toEqual([0, 0])
    expect(view.visible(false)).toHaveLength(32)
    const pinnedLeft = view.nodes.get('p1')!.style.left
    expect(view.wheel(54, 0, { ctrlKey: false, deltaX: 285 }).defaultPrevented).toBe(true)
    expect(view.nodes.get('q1')!.style.left).toBe('-285px')
    expect(view.nodes.get('p1')!.style.left).toBe(pinnedLeft)
    view.wheel(54, 0, { ctrlKey: false, deltaX: 1_000_000 })
    const last = view.nodes.get('q32')!
    expect(parseFloat(last.style.left) + parseFloat(last.style.width)).toBe(view.size.width)
    view.wheel(54, 0, { ctrlKey: false, deltaX: 1_000_000 })
    expect(parseFloat(last.style.left) + parseFloat(last.style.width)).toBe(view.size.width)
    view.wheel(54, 0, { ctrlKey: false, deltaX: -1_000_000 })
    expect(view.nodes.get('q1')!.style.left).toBe('0px')
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    expect([...view.list.children]).toEqual(original)
    for (const node of view.nodes.values()) expect(node.parentElement).toBe(view.list)
  })

  it('scrolls an activated, focused or renamed one-row tab into view without swapping slots', () => {
    const view = fixture(0, 32)
    const onScreen = (id: string) => {
      const node = view.nodes.get(id)!, left = parseFloat(node.style.left)
      expect(left).toBeGreaterThanOrEqual(0)
      expect(left + parseFloat(node.style.width)).toBeLessThanOrEqual(view.size.width)
    }
    view.activate('q32')
    onScreen('q32')
    view.resize(338, 864)
    onScreen('q32')
    view.resize(570, 864)
    view.nodes.get('q1')!.focus({ preventScroll: true })
    onScreen('q1')
    view.tabRename.set({ id: 'q20' })
    onScreen('q20')
    expect(view.shelf(false).hidden).toEqual([])
    expect(view.group.panels.map(panel => panel.id)).toEqual(view.tabs.map(tab => tab.id))
    expect(parseFloat(view.nodes.get('q21')!.style.left) - parseFloat(view.nodes.get('q20')!.style.left)).toBe(285)
  })

  it.each([false, true])('reveals an inactive one-row shelf\'s focused tab without selecting it (pinned: %s)', pinned => {
    const view = fixture(12, 12), active = pinned ? 'q1' : 'p1', focused = pinned ? 'p12' : 'q12'
    view.activate(active)
    const node = view.nodes.get(focused)!
    expect(parseFloat(node.style.left)).toBeGreaterThan(view.size.width)
    // Menus return focus to their context tab without choosing its document.
    node.focus({ preventScroll: true })
    expect(document.activeElement).toBe(node)
    expect(view.group.activePanel.id).toBe(active)
    expect(parseFloat(node.style.left)).toBeGreaterThanOrEqual(0)
    expect(parseFloat(node.style.left) + parseFloat(node.style.width)).toBeLessThanOrEqual(view.size.width)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
  })

  it.each([false, true])('reveals a partially clipped tab after its pointer press ends (already active: %s)', async alreadyActive => {
    const view = fixture(0, 32), source = view.nodes.get('q3')!
    if (alreadyActive) {
      view.activate('q3')
      source.focus({ preventScroll: true })
      view.wheel(18, 0, { ctrlKey: false, deltaX: -100 })
    } else view.wheel(18, 0, { ctrlKey: false, deltaX: 100 })
    const pressedLeft = source.style.left
    expect(parseFloat(source.style.left) + parseFloat(source.style.width)).toBeGreaterThan(view.size.width)
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }))
    source.focus({ preventScroll: true })
    view.activate('q3')
    // A press must not move native drag targets before Dockview finishes its release handlers.
    expect(source.style.left).toBe(pressedLeft)
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }))
    expect(source.style.left).toBe(pressedLeft)
    await vi.waitFor(() => {
      flushFrames()
      expect(parseFloat(source.style.left)).toBeGreaterThanOrEqual(0)
      expect(parseFloat(source.style.left) + parseFloat(source.style.width)).toBeLessThanOrEqual(view.size.width)
    })
    expect(document.activeElement).toBe(source)
    expect(view.group.activePanel.id).toBe('q3')
  })

  it('reserves the final multirow cell for the exact number of omitted tabs', () => {
    const view = fixture(0, 32)
    view.layout.setRows(false, 3)
    expect(view.visible(false)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5'])
    expect(view.shelf(false).hidden.map(tab => tab.id)).toEqual(view.tabs.slice(5).map(tab => tab.id))
    expect(view.shelf(false).hidden).toHaveLength(27)
    view.activate('q32')
    expect(view.visible(false)).toEqual(['q1', 'q2', 'q3', 'q4', 'q32'])
    expect(view.shelf(false).hidden).toHaveLength(27)
    expect(new Set([...view.visible(false), ...view.shelf(false).hidden.map(tab => tab.id)]).size).toBe(32)
    view.layout.setRows(false, 1)
    expect(view.visible(false)).toHaveLength(32)
    expect(view.shelf(false).hidden).toEqual([])
    const selected = view.nodes.get('q32')!
    expect(parseFloat(selected.style.left)).toBeGreaterThanOrEqual(0)
    expect(parseFloat(selected.style.left) + parseFloat(selected.style.width)).toBeLessThanOrEqual(view.size.width)
  })

  it('keeps overflow reachable in a narrow one-column stack and removes it once every tab fits', () => {
    const view = fixture(0, 6)
    view.resize(100, 864)
    view.layout.setRows(false, 2)
    expect(view.visible(false)).toEqual(['q1'])
    expect(view.shelf(false).hidden).toHaveLength(5)
    view.activate('q6')
    expect(view.visible(false)).toEqual(['q6'])
    view.resize(1392, 864)
    expect(view.shelf(false).rows).toBe(1)
    expect(view.shelf(false).hidden).toEqual([])
  })

  it('expands the unpinned stack independently when there is only one pinned tab', () => {
    const view = fixture(1, 32)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    view.wheel(54, 40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 2])
    view.wheel(54, 40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 3])
    view.wheel(54, -40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 2])
  })

  it.each([false, true])('expands every tab in a short group without limiting the other shelf (stack pinned: %s)', pinned => {
    const view = pinned ? fixture(32, 1) : fixture(1, 32)
    view.resize(570, 72)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    for (let row = 2; row <= 16; row++) view.wheel(pinned ? 18 : 54, 40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual(pinned ? [16, 1] : [1, 16])
    expect(view.shelves().reduce((height, shelf) => height + shelf.height, 0)).toBe(612)
    expect(parseFloat(view.header.style.height)).toBe(72)
    expect(view.shelf(pinned).hidden).toEqual([])
    expect(view.shelf(pinned).limit).toBe(16)
    view.wheel(pinned ? 18 : 54, 40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual(pinned ? [16, 1] : [1, 16])
  })

  it('keeps both requested stack heights when their header is taller than the editor group', () => {
    const view = fixture(32, 32)
    view.layout.setRows(true, 12)
    view.layout.setRows(false, 16)
    view.resize(570, 72)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([12, 16])
    expect(view.shelves().reduce((height, shelf) => height + shelf.height, 0)).toBe(1008)
    expect(parseFloat(view.header.style.height)).toBe(72)
    expect(view.shelf(false).hidden).toEqual([])
    view.resize(570, 864)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([12, 16])
  })

  it('scrolls a full-height stack vertically so every expanded tab remains reachable', () => {
    const view = fixture(0, 32)
    view.resize(338, 72)
    view.layout.setRows(false, 32)
    expect(view.shelf(false).rows).toBe(32)
    expect(view.shelf(false).hidden).toEqual([])
    expect(parseFloat(view.header.style.height)).toBe(72)
    expect(view.wheel(18, 1_000_000, { ctrlKey: false }).defaultPrevented).toBe(true)
    expect(view.shelf(false).scrollTop).toBe(1080)
    const last = view.nodes.get('q32')!
    expect(parseFloat(last.style.top)).toBeGreaterThanOrEqual(0)
    expect(parseFloat(last.style.top) + parseFloat(last.style.height)).toBeLessThanOrEqual(72)
    view.wheel(18, -1_000_000, { ctrlKey: false })
    expect(view.shelf(false).scrollTop).toBe(0)
    expect(view.nodes.get('q1')!.style.top).toBe('0px')
    expect(view.shelf(false).rows).toBe(32)
  })

  it.each([
    ['horizontal', 120, 1, 0, -120],
    ['vertical', 1, 120, 120, 0]
  ] as const)('uses the dominant %s trackpad axis over a one-row shelf beside an oversized stack', (_axis, deltaX, deltaY, scrollTop, left) => {
    const view = fixture(6, 32)
    view.resize(338, 72)
    view.layout.setRows(false, 32)
    expect(view.wheel(18, deltaY, { ctrlKey: false, deltaX }).defaultPrevented).toBe(true)
    expect(view.shelf(true).scrollTop).toBe(scrollTop)
    expect(parseFloat(view.nodes.get('p1')!.style.left)).toBe(left)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 32])
  })

  it('scrolls selected, focused and renamed tabs into a tall stack viewport', () => {
    const view = fixture(0, 32)
    view.resize(338, 72)
    view.layout.setRows(false, 32)
    const onScreen = (id: string) => {
      const node = view.nodes.get(id)!, top = parseFloat(node.style.top)
      expect(top).toBeGreaterThanOrEqual(0)
      expect(top + parseFloat(node.style.height)).toBeLessThanOrEqual(72)
    }
    view.activate('q32')
    onScreen('q32')
    view.nodes.get('q1')!.focus({ preventScroll: true })
    onScreen('q1')
    view.tabRename.set({ id: 'q20' })
    onScreen('q20')
  })

  it('keeps the selected row visible when a tall stack viewport shrinks without changing width', () => {
    const view = fixture(0, 32)
    view.resize(338, 216)
    view.layout.setRows(false, 32)
    view.activate('q32')
    const selected = view.nodes.get('q32')!
    expect(parseFloat(selected.style.top) + parseFloat(selected.style.height)).toBeLessThanOrEqual(216)
    view.resize(338, 72)
    expect(view.shelf(false).rows).toBe(32)
    expect(parseFloat(selected.style.top)).toBeGreaterThanOrEqual(0)
    expect(parseFloat(selected.style.top) + parseFloat(selected.style.height)).toBeLessThanOrEqual(72)
  })

  it('keeps a focused inactive tab visible when a tab move changes its row', () => {
    const view = fixture(0, 32)
    view.resize(338, 72)
    view.layout.setRows(false, 32)
    const focused = view.nodes.get('q3')!
    focused.focus({ preventScroll: true })
    expect(view.group.activePanel.id).toBe('q1')
    expect(parseFloat(focused.style.top) + parseFloat(focused.style.height)).toBeLessThanOrEqual(72)
    const index = view.group.panels.findIndex(panel => panel.id === 'q3')
    view.group.panels.splice(index + 1, 0, view.group.panels.splice(index, 1)[0])
    view.documents.set([...view.tabs])
    flushFrames()
    expect(document.activeElement).toBe(focused)
    expect(parseFloat(focused.style.top)).toBeGreaterThanOrEqual(0)
    expect(parseFloat(focused.style.top) + parseFloat(focused.style.height)).toBeLessThanOrEqual(72)
  })

  it('keeps a focused inactive tab visible when a move crosses a one-row horizontal viewport', () => {
    const view = fixture(0, 32), focused = view.nodes.get('q3')!
    focused.focus({ preventScroll: true })
    expect(view.group.activePanel.id).toBe('q1')
    expect(parseFloat(focused.style.left) + parseFloat(focused.style.width)).toBeLessThanOrEqual(view.size.width)
    const index = view.group.panels.findIndex(panel => panel.id === 'q3')
    view.group.panels.splice(index + 1, 0, view.group.panels.splice(index, 1)[0])
    view.documents.set([...view.tabs])
    flushFrames()
    expect(document.activeElement).toBe(focused)
    expect(parseFloat(focused.style.left)).toBeGreaterThanOrEqual(0)
    expect(parseFloat(focused.style.left) + parseFloat(focused.style.width)).toBeLessThanOrEqual(view.size.width)
  })

  it('restores both saved heights and keeps the requested values when tabs fit fewer rows', () => {
    const view = fixture(32, 32, { pinned: 4, unpinned: 7 })
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([4, 7])
    expect(view.editorGroups.getTabRows).toHaveBeenCalledWith('g1')
    expect(view.editorGroups.setTabRows).not.toHaveBeenCalled()
    view.resize(7424, 72)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    expect(view.storedRows).toEqual({ pinned: 4, unpinned: 7 })
    view.layout.setRows(false, 2)
    expect(view.editorGroups.setTabRows).not.toHaveBeenCalled()
    view.resize(570, 72)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([4, 7])
    view.documents.set(view.tabs.filter(tab => tab.id === 'p1' || tab.id === 'q1'))
    flushFrames()
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    expect(view.storedRows).toEqual({ pinned: 4, unpinned: 7 })
    view.documents.set(view.tabs)
    flushFrames()
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([4, 7])
  })

  it('saves wheel and context-menu height changes and reports directional menu availability', () => {
    const view = fixture(1, 32)
    const [, adjust, canAdjust] = view.editorGroups.registerTabRows.mock.calls[0]
    expect(canAdjust).toBeTypeOf('function')
    expect(canAdjust!(true, 1)).toBe(false)
    expect(canAdjust!(true, -1)).toBe(false)
    expect(canAdjust!(false, 1)).toBe(true)
    expect(canAdjust!(false, -1)).toBe(false)
    view.wheel(54, 40)
    expect(view.storedRows).toEqual({ pinned: 1, unpinned: 2 })
    expect(view.editorGroups.setTabRows).toHaveBeenLastCalledWith('g1', { pinned: 1, unpinned: 2 })
    adjust(false, 1)
    expect(view.storedRows).toEqual({ pinned: 1, unpinned: 3 })
    expect(canAdjust!(false, -1)).toBe(true)
    view.layout.setRows(false, 16)
    expect(canAdjust!(false, 1)).toBe(false)
    expect(canAdjust!(false, -1)).toBe(true)
  })

  it('applies restored preferences published after the layout is registered', () => {
    const view = fixture(32, 32)
    view.editorGroups.setTabRows('g1', { pinned: 3, unpinned: 5 })
    flushFrames()
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([3, 5])
  })

  it('briefly reports row changes and restarts the dismissal timer after the latest gesture', () => {
    vi.useFakeTimers()
    const view = fixture(0, 6)
    view.wheel(18, 40)
    expect(view.feedback).toHaveBeenLastCalledWith(expect.objectContaining({ pinned: false, message: '2 rows' }))
    vi.advanceTimersByTime(1000)
    view.wheel(18, 40)
    expect(view.feedback).toHaveBeenLastCalledWith(expect.objectContaining({ pinned: false, message: '3 rows' }))
    vi.advanceTimersByTime(1000)
    expect(view.feedback).toHaveBeenLastCalledWith(expect.objectContaining({ message: '3 rows' }))
    vi.advanceTimersByTime(400)
    expect(view.feedback).toHaveBeenLastCalledWith(undefined)
  })

  it('explains natural tab-count bounds and clears the feedback timer on disposal', () => {
    vi.useFakeTimers()
    const view = fixture(1, 6)
    view.wheel(18, 40)
    expect(view.feedback).toHaveBeenLastCalledWith(expect.objectContaining({ pinned: true, message: 'All tabs fit in one row' }))
    view.wheel(18, -40)
    expect(view.feedback).toHaveBeenLastCalledWith(expect.objectContaining({ pinned: true, message: 'Minimum stack height · 1 row' }))
    view.layout.setRows(false, 3)
    view.layout.setRows(false, 4)
    expect(view.feedback).toHaveBeenLastCalledWith(expect.objectContaining({ pinned: false, message: 'All tabs fit · 3 rows' }))
    view.layout.dispose()
    const reports = view.feedback.mock.calls.length
    vi.advanceTimersByTime(2000)
    expect(view.feedback).toHaveBeenCalledTimes(reports)
  })

  it.each([
    ['vertical', 120, { ctrlKey: false }],
    ['horizontal', 0, { ctrlKey: false, deltaX: 120 }],
    ['Control', 120, { ctrlKey: true }]
  ] as const)('leaves %s wheel input inside an overflow list to that list', (_name, delta, options) => {
    const view = fixture(32, 32)
    view.layout.setRows(true, 2)
    const popup = document.createElement('div'), choice = document.createElement('button')
    popup.className = 'query-shelf-overflow'
    popup.setAttribute('popover', 'auto')
    popup.append(choice)
    view.list.append(popup)
    // The upper shelf's top-layer list overlaps the lower single-row shelf. A cached Control gesture must not own it.
    view.wheel(90, -40)
    const before = [...view.nodes.values()].map(node => [node.style.left, node.style.top])
    expect(view.wheel(90, delta, options, choice).defaultPrevented).toBe(false)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([2, 1])
    expect([...view.nodes.values()].map(node => [node.style.left, node.style.top])).toEqual(before)
  })

  it('retargets a stationary Ctrl-wheel gesture after pin membership changes', () => {
    const view = fixture(6, 32)
    view.layout.setRows(true, 2)
    view.wheel(54, -40)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 1])
    view.documents.set(view.tabs.map((tab, index) => index < 5 ? { ...tab, pinned: false } : tab))
    flushFrames()
    expect(view.wheel(54, 40).defaultPrevented).toBe(true)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([1, 2])
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

  it('caps rows only when every tab fits and restores the requested rows after a width change', () => {
    const view = fixture()
    view.layout.setRows(true, 100)
    view.layout.setRows(false, 100)
    expect(view.shelves().map(shelf => [shelf.rows, shelf.limit])).toEqual([[3, 3], [3, 3]])
    expect(view.header.style.height).toBe('216px')
    view.resize(570, 288)
    expect(view.shelves().map(shelf => [shelf.rows, shelf.limit])).toEqual([[3, 3], [3, 3]])
    expect(view.list.style.height).toBe('216px')
    view.resize(1034, 864)
    expect(view.shelves().map(shelf => [shelf.rows, shelf.limit])).toEqual([[2, 2], [2, 2]])
    view.resize(570, 864)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([3, 3])
    view.resize(570, 72)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([3, 3])
    expect(view.header.style.height).toBe('72px')
    expect(view.group.relayout).toHaveBeenCalled()
  })

  it('uses the whole shelf width for tabs, including narrow groups', () => {
    const view = fixture()
    for (const width of [240, 337, 338, 100]) {
      view.resize(width, 864)
      expect(view.nodes.get('p1')!.style.left).toBe('0px')
      expect(view.nodes.get('p1')!.style.width).toBe(`${width}px`)
      expect(view.shelves().every(shelf => shelf.hidden.length === 0)).toBe(true)
    }
    view.resize(240, 864)
    expect(view.nodes.get('p1')!.style.width).toBe('240px')
    view.layout.setRows(true, 2)
    view.layout.setRows(false, 3)
    expect(view.shelves().map(shelf => shelf.rows)).toEqual([2, 3])
  })

  it('keeps the selected and renamed tabs visible without reordering or reparenting native tabs', () => {
    const view = fixture()
    view.layout.setRows(true, 2)
    const order = view.group.panels.map(panel => panel.id), nativeOrder = [...view.list.children]
    view.activate('p5')
    view.tabRename.set({ id: 'p6' })
    expect(view.visible(true)).toEqual(['p1', 'p5', 'p6'])
    expect(view.shelf(true).hidden.map(tab => tab.id)).toEqual(['p2', 'p3', 'p4'])
    expect(view.group.panels.map(panel => panel.id)).toEqual(order)
    expect([...view.list.children]).toEqual(nativeOrder)
    for (const node of view.nodes.values()) expect(node.parentElement).toBe(view.list)
    expect(view.nodes.get('p5')!.style.left).toBe('285px')
    expect(view.nodes.get('p6')!.style.left).toBe('0px')
    expect(view.list.classList.contains('dv-tabs-container--wrap')).toBe(true)
  })

  it('prioritizes the selected tab over stale focus and the rename box over selection in a one-column group', () => {
    const view = fixture()
    view.resize(338, 864)
    view.layout.setRows(true, 2)
    view.nodes.get('p1')!.focus()
    view.activate('p5')
    expect(view.visible(true)).toEqual(['p5'])
    view.tabRename.set({ id: 'p6' })
    expect(view.visible(true)).toEqual(['p6'])
    expect(view.group.panels.map(panel => panel.id)).toEqual(view.tabs.map(tab => tab.id))
  })

  it('keeps a promoted drag destination in place while the native pointer press activates the source tab', async () => {
    const view = fixture()
    view.resize(338, 864)
    view.layout.setRows(true, 3)
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
    view.resize(338, 864)
    view.layout.setRows(true, 3)
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
    view.resize(338, 864)
    view.layout.setRows(true, 3)
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
    view.resize(338, 864)
    view.layout.setRows(true, 3)
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

  it('keeps omitted native drag rectangles below the entire content of an oversized stack', () => {
    const view = fixture(32, 32)
    view.resize(338, 72)
    view.layout.setRows(true, 20)
    view.layout.setRows(false, 18)
    const contentHeight = view.shelves().reduce((height, shelf) => height + shelf.height, 0)
    expect(contentHeight).toBe(1368)
    expect(parseFloat(view.header.style.height)).toBe(72)
    for (const node of view.nodes.values()) {
      if (node.hasAttribute('data-tab-overflow')) expect(parseFloat(node.style.top)).toBeGreaterThan(contentHeight)
    }
  })

  it('promotes an overflow tab reached by native focus and prevents native scroll from displacing the shelf', () => {
    const view = fixture(), overflow = view.nodes.get('p6')!
    view.resize(338, 864)
    view.layout.setRows(true, 3)
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
