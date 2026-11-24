// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusFacts } from '../src/renderer/src/core/contextkeys'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import CapabilityChips, { type CapabilityItem } from '../src/renderer/src/kit/CapabilityChips'
import FactGrid, { type FactItem } from '../src/renderer/src/kit/FactGrid'
import ObjectInspectorFrame, { ObjectInspectorFrameView, type InspectorTab } from '../src/renderer/src/kit/ObjectInspectorFrame'
import {
  hiddenTabs, inspectorTabKey, offEdgeTabIds, resolveTabShortcutTarget, revealSelectedTab,
  revealSelectedTabOffset, stepScrollDelta, stripClipState, tabShortcutDigit, tabShortcutLabel
} from '../src/renderer/src/kit/object-inspector'
import PropertyField, { FieldHints, FieldHintStrip } from '../src/renderer/src/kit/PropertyField'
import RatioBar, { ratioShares } from '../src/renderer/src/kit/RatioBar'
import { stylesheetRules } from './fixtures/css-rules'
import { workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined, host: HTMLElement | undefined
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  host?.remove()
  host = undefined
  vi.restoreAllMocks()
})

function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root!.render(element) })
  return host
}

function setStripGeometry(strip: HTMLElement, widths: readonly number[], clientWidth: number, scrollLeft = 0) {
  let offset = 0
  const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"][data-inspector-tab]')]
  tabs.forEach((tab, index) => {
    const w = widths[index] ?? 80
    Object.defineProperty(tab, 'offsetLeft', { configurable: true, value: offset })
    Object.defineProperty(tab, 'offsetWidth', { configurable: true, value: w })
    offset += w
  })
  Object.defineProperty(strip, 'clientWidth', { configurable: true, value: clientWidth })
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: offset })
  strip.scrollLeft = scrollLeft
}

describe('object inspector pure tab and overflow logic', () => {
  it('maps shortcut digits 1..8 and 9 for the last tab', () => {
    expect([0, 1, 2, 3].map(i => tabShortcutDigit(i, 4))).toEqual([1, 2, 3, 4])
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => tabShortcutDigit(i, 9))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect([0, 7, 8, 9, 10].map(i => tabShortcutDigit(i, 11))).toEqual([1, 8, undefined, undefined, 9])
    expect([tabShortcutDigit(-1, 5), tabShortcutDigit(5, 5), tabShortcutDigit(0, 0)]).toEqual([undefined, undefined, undefined])
    expect(resolveTabShortcutTarget(0, 5)).toBe(0)
    expect(resolveTabShortcutTarget(7, 5)).toBeUndefined()
    expect(resolveTabShortcutTarget('last', 5)).toBe(4)
    expect(resolveTabShortcutTarget('last', 0)).toBeUndefined()
    expect(tabShortcutLabel(3, 'win32')).toBe('Ctrl+3')
    expect(tabShortcutLabel(9, 'darwin')).toBe('⌘9')
  })

  it('moves roving focus along tabs without wrapping errors', () => {
    const ids = ['overview', 'definition', 'storage', 'columns']
    expect(inspectorTabKey('ArrowRight', ids, 'overview')).toBe('definition')
    expect(inspectorTabKey('ArrowRight', ids, 'columns')).toBe('overview')
    expect(inspectorTabKey('ArrowLeft', ids, 'overview')).toBe('columns')
    expect(inspectorTabKey('Home', ids, 'storage')).toBe('overview')
    expect(inspectorTabKey('End', ids, 'overview')).toBe('columns')
    expect(inspectorTabKey('Enter', ids, 'overview')).toBeUndefined()
    expect(inspectorTabKey('ArrowRight', [], 'overview')).toBeUndefined()
  })

  it('computes clip flags, off-edge tabs, and instant revealSelectedTab without scrolling visible tabs', () => {
    const tabs = [
      { id: 't1', left: 0, width: 100 },
      { id: 't2', left: 100, width: 100 },
      { id: 't3', left: 200, width: 100 },
      { id: 't4', left: 300, width: 100 }
    ]
    const metrics = { scrollLeft: 0, clientWidth: 250, scrollWidth: 400 }
    expect(stripClipState(metrics)).toEqual({ start: false, end: true, overflow: true })
    expect([...offEdgeTabIds(metrics, tabs)]).toEqual(['t3', 't4'])

    // Already completely visible tab: scrollLeft does not change at all.
    expect(revealSelectedTabOffset(metrics, tabs[0])).toBe(0)
    expect(revealSelectedTabOffset(metrics, tabs[1])).toBe(0)
    // Off right edge: reveals with 16 px fade clearance, clamped to maxScroll (150).
    expect(revealSelectedTabOffset(metrics, tabs[2])).toBe(66)
    expect(revealSelectedTabOffset(metrics, tabs[3])).toBe(150)
    // Off left edge: reveals with 16 px fade clearance, clamped to 0.
    expect(revealSelectedTabOffset({ scrollLeft: 150, clientWidth: 250, scrollWidth: 400 }, tabs[1])).toBe(84)
    expect(revealSelectedTabOffset({ scrollLeft: 150, clientWidth: 250, scrollWidth: 400 }, tabs[0])).toBe(0)
    expect(stepScrollDelta(250, 1)).toBe(150)
    expect(stepScrollDelta(100, -1)).toBe(-120)
  })
})

describe('ObjectInspectorFrameView keyboard, overflow, archetypes and Vitals sash', () => {
  const makeTabs = (count = 4): InspectorTab[] => Array.from({ length: count }, (_, i) => ({
    id: `sec-${i + 1}`,
    title: `Section ${i + 1}`,
    layout: i % 2 === 0 ? 'flow' : 'fill',
    count: i === 1 ? 12 : undefined,
    modified: i === 0,
    content: createElement('div', { 'data-pane-body': `sec-${i + 1}` }, `Body ${i + 1}`)
  }))

  it('omits Hero KPIs on peek surface, renders them on full surface, scopes shortcut badges to focus, and omits data-object-inspector on bare view', () => {
    const kpis = [{ id: 'rows', label: 'Rows', value: '12,400', sub: 'est.', ratio: [{ id: 'd', label: 'Data', value: 70 }, { id: 'i', label: 'Index', value: 30 }] }]
    const full = mount(createElement(ObjectInspectorFrameView, {
      id: 'insp', title: 'Sales.Orders', surface: 'full', kpis, tabs: makeTabs(3), activeTab: 'sec-1', onSelectTab: () => {}
    }))
    const frame = () => full.querySelector('.inspector-frame')!
    expect(full.querySelector('.inspector-kpi-strip')).not.toBeNull()
    expect(full.querySelector('.ratio-bar-mini')).not.toBeNull()
    // Bare ObjectInspectorFrameView does not claim data-object-inspector so Ctrl+1..9 still routes to document tabs.
    expect(frame().hasAttribute('data-object-inspector')).toBe(false)
    expect(frame().hasAttribute('data-mod-held')).toBe(false)

    // Holding Ctrl/Cmd while unfocused must NOT reveal shortcut badges on Full surface.
    act(() => {
      root!.render(createElement(ObjectInspectorFrameView, {
        id: 'insp', title: 'Sales.Orders', surface: 'full', modHeld: true, kpis, tabs: makeTabs(3), activeTab: 'sec-1', onSelectTab: () => {}
      }))
    })
    expect(frame().hasAttribute('data-mod-held')).toBe(false)

    // Focusing inside the Full inspector while modHeld is true reveals shortcut badges; blurring hides them again.
    const firstTab = full.querySelector<HTMLButtonElement>('[data-inspector-tab="sec-1"]')!
    act(() => { firstTab.focus() })
    expect(frame().hasAttribute('data-mod-held')).toBe(true)
    const outside = document.createElement('button')
    document.body.append(outside)
    act(() => { outside.focus() })
    expect(frame().hasAttribute('data-mod-held')).toBe(false)
    outside.remove()

    act(() => {
      root!.render(createElement(ObjectInspectorFrameView, {
        id: 'insp', title: 'Sales.Orders', surface: 'peek', kpis, tabs: makeTabs(3), activeTab: 'sec-1', onSelectTab: () => {}
      }))
    })
    expect(full.querySelector('.inspector-kpi-strip')).toBeNull()
    expect(frame().hasAttribute('data-mod-held')).toBe(true)
  })

  it('hides the Vitals rail, sash, and toggle below 680 px container width without mutating open state', () => {
    const observers: (() => void)[] = []
    class StubResizeObserver {
      constructor(cb: () => void) { observers.push(cb) }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    const onOpen = vi.fn()
    const el = mount(createElement(ObjectInspectorFrameView, {
      id: 'insp', title: 'Orders', surface: 'full', tabs: makeTabs(2), activeTab: 'sec-1', onSelectTab: () => {},
      vitals: createElement('div', null, 'Vitals body'), vitalsOpen: true, onVitalsOpenChange: onOpen
    }))
    const split = el.querySelector<HTMLElement>('.inspector-split')!
    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 900 })
    act(() => { observers.forEach(cb => cb()) })
    expect(el.querySelector('.inspector-vitals-rail')).not.toBeNull()
    expect(el.querySelector('.inspector-vitals-toggle')?.getAttribute('title')).toBe('Hide Vitals')

    // Below 680 px, rail, sash and toggle all disappear so no toggle reads "Hide Vitals" while hidden.
    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 640 })
    act(() => { observers.forEach(cb => cb()) })
    expect(el.querySelector('.inspector-vitals-rail')).toBeNull()
    expect(el.querySelector('.inspector-vitals-sash')).toBeNull()
    expect(el.querySelector('.inspector-vitals-toggle')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()

    // Widening back above 680 px restores Vitals and its toggle.
    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 800 })
    act(() => { observers.forEach(cb => cb()) })
    expect(el.querySelector('.inspector-vitals-rail')).not.toBeNull()
    expect(el.querySelector('.inspector-vitals-toggle')?.getAttribute('aria-pressed')).toBe('true')
    vi.unstubAllGlobals()
  })

  it('uses roving tabindex where arrows move focus without selecting lazy tabs, and Enter/Space selects', () => {
    const onSelectTab = vi.fn()
    const el = mount(createElement(ObjectInspectorFrameView, {
      id: 'insp', title: 'Orders', tabs: makeTabs(4), activeTab: 'sec-1', onSelectTab
    }))
    const tablist = el.querySelector<HTMLElement>('[role="tablist"]')!
    expect(tablist.getAttribute('aria-label')).toBe('Object sections')
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map(t => t.tabIndex)).toEqual([0, -1, -1, -1])

    act(() => { tabs[0].focus() })
    act(() => { tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(document.activeElement).toBe(tabs[1])
    expect(tabs.map(t => t.tabIndex)).toEqual([-1, 0, -1, -1])
    // Lazy tabs must NOT fire on arrowing.
    expect(onSelectTab).not.toHaveBeenCalled()

    act(() => { tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(document.activeElement).toBe(tabs[3])
    expect(onSelectTab).not.toHaveBeenCalled()

    act(() => { tabs[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onSelectTab).toHaveBeenCalledWith('sec-4')

    // Space also selects.
    act(() => { tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    expect(onSelectTab).toHaveBeenCalledWith('sec-3')

    // Clicking the already-selected tab does not re-trigger onSelectTab.
    onSelectTab.mockClear()
    act(() => { tabs[0].click() })
    expect(onSelectTab).not.toHaveBeenCalled()
  })

  it('switches cleanly between flow and fill pane archetypes', () => {
    const el = mount(createElement(ObjectInspectorFrameView, {
      id: 'insp', title: 'Orders', tabs: makeTabs(2), activeTab: 'sec-1', onSelectTab: () => {}
    }))
    expect(el.querySelector('[role="tabpanel"]')?.className).toBe('inspector-pane-flow')
    act(() => {
      root!.render(createElement(ObjectInspectorFrameView, {
        id: 'insp', title: 'Orders', tabs: makeTabs(2), activeTab: 'sec-2', onSelectTab: () => {}
      }))
    })
    expect(el.querySelector('[role="tabpanel"]')?.className).toBe('inspector-pane-fill')
  })

  it('handles overflow edge fade, steppers, +N menu with menuitemradio, wheel scroll, and non-scrolling reveal', () => {
    const onSelectTab = vi.fn()
    const el = mount(createElement(ObjectInspectorFrameView, {
      id: 'insp', title: 'Orders', tabs: makeTabs(5), activeTab: 'sec-1', onSelectTab, platform: 'win32'
    }))
    const strip = el.querySelector<HTMLElement>('.inspector-tab-strip')!
    setStripGeometry(strip, [100, 100, 100, 100, 100], 240, 0)
    act(() => { strip.dispatchEvent(new Event('scroll')) })

    const bar = el.querySelector('.inspector-tab-bar')!
    expect(bar.hasAttribute('data-overflow')).toBe(true)
    expect(bar.hasAttribute('data-clip-start')).toBe(false)
    expect(bar.hasAttribute('data-clip-end')).toBe(true)
    expect(hiddenTabs(strip)).toBe(3)

    const leftBtn = el.querySelector<HTMLButtonElement>('[aria-label="Scroll tabs left"]')!
    const rightBtn = el.querySelector<HTMLButtonElement>('[aria-label="Scroll tabs right"]')!
    expect(leftBtn.disabled).toBe(true)
    expect(rightBtn.disabled).toBe(false)

    // Wheel maps deltaY to scrollLeft.
    act(() => { strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true })) })
    expect(strip.scrollLeft).toBe(60)
    expect(bar.hasAttribute('data-clip-start')).toBe(true)

    // Already-visible tab does not scroll on revealSelectedTab.
    strip.scrollLeft = 0
    expect(revealSelectedTab(strip)).toBe(false)
    expect(strip.scrollLeft).toBe(0)

    // +N overflow menu opens with role="menu" and role="menuitemradio".
    const moreBtn = el.querySelector<HTMLButtonElement>('.inspector-tab-more')!
    expect(moreBtn.getAttribute('aria-haspopup')).toBe('menu')
    expect(moreBtn.getAttribute('aria-label')).toContain('3 hidden')
    act(() => { moreBtn.click() })
    const menu = el.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu).not.toBeNull()
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(items).toHaveLength(5)
    expect(items[0].getAttribute('aria-checked')).toBe('true')
    expect(items[4].textContent).toContain('off-edge')
    expect(items[4].textContent).toContain('Ctrl+5')

    // Escape closes and restores focus to moreBtn.
    act(() => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(el.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(moreBtn)

    // Selecting an item from menu calls onSelectTab and closes menu.
    act(() => { moreBtn.click() })
    const fifth = el.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[4]
    act(() => { fifth.click() })
    expect(onSelectTab).toHaveBeenCalledWith('sec-5')
    expect(el.querySelector('[role="menu"]')).toBeNull()

    // Clearing overflow while the menu is open closes the menu cleanly.
    act(() => { moreBtn.click() })
    expect(el.querySelector('[role="menu"]')).not.toBeNull()
    setStripGeometry(strip, [40, 40, 40, 40, 40], 240, 0)
    act(() => { strip.dispatchEvent(new Event('scroll')) })
    expect(bar.hasAttribute('data-overflow')).toBe(false)
    expect(el.querySelector('[role="menu"]')).toBeNull()
  })

  it('recomputes overflow when tabs transition from empty to populated and exposes accessible counts and problem badges', () => {
    const el = mount(createElement(ObjectInspectorFrameView, {
      id: 'insp', title: 'Orders', tabs: [], activeTab: '', onSelectTab: () => {}
    }))
    expect(el.querySelector('.inspector-tab-bar')).toBeNull()

    const richTabs: InspectorTab[] = [
      { id: 'overview', title: 'Overview', layout: 'flow', count: 12, modified: true, content: createElement('div', null, 'Overview') },
      { id: 'storage', title: 'Storage', layout: 'flow', count: 3, countLabel: '3 filegroups', problem: true, content: createElement('div', null, 'Storage') },
      { id: 'indexes', title: 'Indexes', layout: 'fill', content: createElement('div', null, 'Indexes') }
    ]
    act(() => {
      root!.render(createElement(ObjectInspectorFrameView, {
        id: 'insp', title: 'Orders', tabs: richTabs, activeTab: 'overview', onSelectTab: () => {}
      }))
    })
    const strip = el.querySelector<HTMLElement>('.inspector-tab-strip')!
    setStripGeometry(strip, [120, 120, 120], 200, 0)
    act(() => { strip.dispatchEvent(new Event('scroll')) })
    expect(el.querySelector('.inspector-tab-bar')?.hasAttribute('data-overflow')).toBe(true)

    // Without countLabel, the numeric count stays exposed to screen readers; with countLabel, raw count is aria-hidden.
    const overviewTab = el.querySelector<HTMLButtonElement>('[data-inspector-tab="overview"]')!
    expect(overviewTab.querySelector('.inspector-tab-count [aria-hidden="true"]')).toBeNull()
    expect(overviewTab.textContent).toContain('(modified)')

    const storageTab = el.querySelector<HTMLButtonElement>('[data-inspector-tab="storage"]')!
    expect(storageTab.querySelector('.inspector-tab-count [aria-hidden="true"]')?.textContent).toBe('3')
    expect(storageTab.textContent).toContain('3 filegroups')
    expect(storageTab.textContent).toContain('(needs attention)')

    // Overflow menu items carry the same screen-reader state cues.
    act(() => { el.querySelector<HTMLButtonElement>('.inspector-tab-more')!.click() })
    const menuItems = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(menuItems[0].textContent).toContain('(modified)')
    expect(menuItems[1].textContent).toContain('(needs attention)')
  })

  it('supports Vitals sash pointer drag via followPointerDrag, double-click reset, and keyboard resize without clobbering clamped widths', () => {
    const onWidth = vi.fn(), onReset = vi.fn(), onOpen = vi.fn()
    const el = mount(createElement(ObjectInspectorFrameView, {
      id: 'insp', title: 'Orders', surface: 'full', tabs: makeTabs(2), activeTab: 'sec-1', onSelectTab: () => {},
      vitals: createElement('div', null, 'Vitals body'), vitalsOpen: true, vitalsWidth: 272,
      onVitalsWidthChange: onWidth, onVitalsWidthReset: onReset, onVitalsOpenChange: onOpen
    }))
    const sash = el.querySelector<HTMLElement>('[role="separator"]')!
    expect(sash.getAttribute('aria-orientation')).toBe('vertical')
    expect(sash.getAttribute('aria-valuemin')).toBe('200')
    expect(sash.getAttribute('aria-valuenow')).toBe('272')

    // Zero-movement pointer click must not trigger a persistence write.
    sash.setPointerCapture = vi.fn()
    act(() => { sash.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 500, bubbles: true })) })
    act(() => { sash.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 500, bubbles: true })) })
    expect(onWidth).not.toHaveBeenCalled()

    // Keyboard ArrowLeft widens (+16), ArrowRight narrows (-16), Home resets.
    act(() => { sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(onWidth).toHaveBeenLastCalledWith(288)
    act(() => { sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(onWidth).toHaveBeenLastCalledWith(256)
    act(() => { sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    expect(onReset).toHaveBeenCalledTimes(1)

    // Double click resets.
    act(() => { sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(onReset).toHaveBeenCalledTimes(2)

    // Pointer drag left by 30px widens from 272 -> 302 and commits on pointerup.
    act(() => { sash.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, button: 0, clientX: 500, bubbles: true })) })
    act(() => { sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 470, bubbles: true })) })
    expect(el.querySelector<HTMLElement>('.inspector-vitals-rail')?.style.width).toBe('302px')
    act(() => { sash.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, clientX: 470, bubbles: true })) })
    expect(onWidth).toHaveBeenLastCalledWith(302)

    // At the max bound (440), ArrowLeft is a no-op and does not fire onVitalsWidthChange.
    onWidth.mockClear()
    act(() => {
      root!.render(createElement(ObjectInspectorFrameView, {
        id: 'insp', title: 'Orders', surface: 'full', tabs: makeTabs(2), activeTab: 'sec-1', onSelectTab: () => {},
        vitals: createElement('div', null, 'Vitals body'), vitalsOpen: true, vitalsWidth: 440,
        onVitalsWidthChange: onWidth, onVitalsWidthReset: onReset, onVitalsOpenChange: onOpen
      }))
    })
    act(() => { sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(onWidth).not.toHaveBeenCalled()
  })
})

describe('focus-scoped Ctrl+1..9 commands and context keys', () => {
  it('routes consecutive mod+1..9 to the focused ObjectInspectorFrame even when switching unmounts the focused panel', async () => {
    const fixture = workbenchFixture({ platform: 'win32', activeElement: () => document.activeElement })
    try {
      fixture.documents.create('Query1.sql', 'SELECT 1', 'master')
      fixture.documents.create('Query2.sql', 'SELECT 2', 'master')
      const [q1, q2] = fixture.documents.getSnapshot().documents.map(d => d.id)
      fixture.documents.activate(q1)

      // Distinct keyed panels force React to unmount the focused child on tab switch.
      const tabs: InspectorTab[] = Array.from({ length: 10 }, (_, i) => ({
        id: `t${i + 1}`, title: `Tab ${i + 1}`, layout: 'flow',
        content: createElement('div', { key: `panel-${i + 1}` },
          createElement('button', { type: 'button', id: `btn-${i + 1}` }, `Inside ${i + 1}`))
      }))
      const selected: string[] = []
      function Harness() {
        const [active, setActive] = useState('t1')
        return createElement(WorkbenchProvider, {
          workbench: fixture as unknown as Workbench,
          children: createElement('div', { 'data-peek-card': '' },
            createElement(ObjectInspectorFrame, {
              id: 'peek-insp', title: 'Orders', surface: 'peek', tabs, activeTab: active,
              onSelectTab: id => { selected.push(id); setActive(id) }
            }))
        })
      }
      const el = mount(createElement(Harness))
      const insideBtn = el.querySelector<HTMLButtonElement>('#btn-1')!
      act(() => { insideBtn.focus() })

      // Focus facts set both objectInspectorFocus and peekFocus cleanly.
      const facts = focusFacts(insideBtn, undefined)
      expect(facts.objectInspectorFocus).toBe(true)
      expect(facts.peekFocus).toBe(true)

      // Ctrl+3 inside inspector switches inspector to Tab 3, NOT query tab, and rescues focus onto Tab 3.
      act(() => {
        fixture.keybindings.handleKeyDown(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, cancelable: true }))
      })
      await Promise.resolve()
      expect(selected).toEqual(['t3'])
      expect(fixture.documents.getSnapshot().activeId).toBe(q1)
      expect(document.activeElement).toBe(el.querySelector('[data-inspector-tab="t3"]'))
      expect(focusFacts(document.activeElement, undefined).objectInspectorFocus).toBe(true)

      // Consecutive Ctrl+9 still routes to the inspector and jumps to last tab (t10).
      act(() => {
        fixture.keybindings.handleKeyDown(new KeyboardEvent('keydown', { key: '9', ctrlKey: true, cancelable: true }))
      })
      await Promise.resolve()
      expect(selected).toEqual(['t3', 't10'])
      expect(fixture.documents.getSnapshot().activeId).toBe(q1)

      // Focus outside inspector: Ctrl+2 switches to Query 2.
      const outside = document.createElement('button')
      document.body.append(outside)
      act(() => { outside.focus() })
      expect(focusFacts(outside, undefined).objectInspectorFocus).toBe(false)
      act(() => {
        fixture.keybindings.handleKeyDown(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, cancelable: true }))
      })
      await Promise.resolve()
      expect(fixture.documents.getSnapshot().activeId).toBe(q2)
      outside.remove()
    } finally {
      fixture.dispose()
    }
  })

  it('lets Ctrl+1..9 route to document tabs when focus is inside an unconnected ObjectInspectorFrameView', async () => {
    const fixture = workbenchFixture({ platform: 'win32', activeElement: () => document.activeElement })
    try {
      fixture.documents.create('Query1.sql', 'SELECT 1', 'master')
      fixture.documents.create('Query2.sql', 'SELECT 2', 'master')
      const [q1, q2] = fixture.documents.getSnapshot().documents.map(d => d.id)
      fixture.documents.activate(q1)
      const onSelectTab = vi.fn()
      const el = mount(createElement(ObjectInspectorFrameView, {
        id: 'bare-insp', title: 'Orders',
        tabs: [
          { id: 't1', title: 'Overview', layout: 'flow', content: createElement('button', { type: 'button', id: 'bare-btn' }, 'Inside') },
          { id: 't2', title: 'Storage', layout: 'flow', content: createElement('div', null, 'Storage') }
        ],
        activeTab: 't1', onSelectTab
      }))
      const btn = el.querySelector<HTMLButtonElement>('#bare-btn')!
      act(() => { btn.focus() })
      expect(focusFacts(btn, undefined).objectInspectorFocus).toBe(false)
      act(() => {
        fixture.keybindings.handleKeyDown(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, cancelable: true }))
      })
      await Promise.resolve()
      expect(onSelectTab).not.toHaveBeenCalled()
      expect(fixture.documents.getSnapshot().activeId).toBe(q2)
    } finally {
      fixture.dispose()
    }
  })
})

describe('FactGrid, CapabilityChips, RatioBar and FieldHintStrip clearing', () => {
  it('renders FactGrid with copy via window.varia.writeClipboardText, polite status announcement, links and em-dash empty values', async () => {
    const writeClipboardText = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const onLink = vi.fn()
    const facts: FactItem[] = [
      { id: 'schema', label: 'Schema', value: 'Sales', mono: true },
      { id: 'parent', label: 'Table', value: 'Sales.Orders', onLink },
      { id: 'empty', label: 'Description', value: '' }
    ]
    const el = mount(createElement(FactGrid, { facts, onCopy: writeClipboardText }))
    const rows = [...el.querySelectorAll('.fact-grid-row')]
    expect(rows).toHaveLength(3)
    expect(rows[0].querySelector('.fact-grid-val')?.classList.contains('mono')).toBe(true)
    expect(rows[2].querySelector('.fact-grid-val')?.textContent).toBe('—')
    // Empty row has no copy button.
    expect(rows[2].querySelector('.fact-grid-copy')).toBeNull()

    // Link button fires callback.
    act(() => { rows[1].querySelector<HTMLButtonElement>('.fact-grid-link')!.click() })
    expect(onLink).toHaveBeenCalledTimes(1)

    // Copy button writes clipboard and announces in polite live status region.
    await act(async () => { rows[0].querySelector<HTMLButtonElement>('.fact-grid-copy')!.click(); await Promise.resolve() })
    expect(writeClipboardText).toHaveBeenCalledWith('Sales')
    const status = el.querySelector('[role="status"]')!
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toContain('Copied Schema')

    // Missing clipboard API does not falsely announce copied.
    act(() => { root!.render(createElement(FactGrid, { key: 'no-api', facts })) })
    await act(async () => { el.querySelector<HTMLButtonElement>('.fact-grid-copy')!.click(); await Promise.resolve() })
    expect(el.querySelector('[role="status"]')?.textContent).toBe('')

    // Unmounting while a clipboard write promise is pending cancels any timer scheduling cleanly.
    let finishCopy!: (value: { ok: true; value: undefined }) => void
    const pendingCopy = vi.fn(() => new Promise<{ ok: true; value: undefined }>(resolve => { finishCopy = resolve }))
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    act(() => { root!.render(createElement(FactGrid, { facts, onCopy: pendingCopy })) })
    act(() => { el.querySelector<HTMLButtonElement>('.fact-grid-copy')!.click() })
    setTimeoutSpy.mockClear()
    act(() => { root!.unmount() })
    root = undefined
    await act(async () => { finishCopy({ ok: true, value: undefined }); await Promise.resolve() })
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('toggles CapabilityChips between Notable (n/m) and All (m)', () => {
    const items: CapabilityItem[] = [
      { id: 'sv', label: 'System-versioned', notable: true, tone: 'accent' },
      { id: 'part', label: 'Partitioned', value: '12', notable: true, tone: 'success' },
      { id: 'repl', label: 'Replicated', notable: false },
      { id: 'mem', label: 'Memory-optimized', notable: false }
    ]
    const el = mount(createElement(CapabilityChips, { items }))
    expect(el.querySelectorAll('.cap-chip')).toHaveLength(2)
    const toggle = el.querySelector<HTMLButtonElement>('.cap-chips-toggle')!
    expect(toggle.textContent).toBe('Notable (2/4)')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    act(() => { toggle.click() })
    expect(el.querySelectorAll('.cap-chip')).toHaveLength(4)
    expect(toggle.textContent).toBe('All (4)')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    act(() => { toggle.click() })
    expect(el.querySelectorAll('.cap-chip')).toHaveLength(2)
  })

  it('normalizes RatioBar shares and supports card, flat and mini modes', () => {
    expect(ratioShares([{ value: 75 }, { value: 25 }])).toEqual([75, 25])
    expect(ratioShares([{ value: -5 }, { value: Number.NaN }, { value: 0 }])).toEqual([0, 0, 0])

    const el = mount(createElement('div', null,
      createElement(RatioBar, { title: 'Storage', totalLabel: '100 MB', segments: [{ id: 'a', label: 'Data', value: 80, displayValue: '80 MB' }, { id: 'b', label: 'Index', value: 20, displayValue: '20 MB' }] }),
      createElement(RatioBar, { flat: true, segments: [{ id: 'a', label: 'Active', value: 60 }, { id: 'b', label: 'Long-Term', value: 40, series: 3 }] }),
      createElement(RatioBar, { mini: true, segments: [{ id: 'a', label: 'Data', value: 50 }, { id: 'b', label: 'Index', value: 50 }] })
    ))
    expect(el.querySelectorAll('.ratio-bar')).toHaveLength(2)
    expect(el.querySelector('.ratio-bar.flat')).not.toBeNull()
    expect(el.querySelector('.ratio-bar-mini')).not.toBeNull()
    expect(el.querySelector('.ratio-bar.flat .ratio-bar-seg[data-series="3"]')).not.toBeNull()
  })

  it('clears FieldHintStrip on pointer leave, blur, and tab change', () => {
    function Harness() {
      const [tab, setTab] = useState('overview')
      return createElement(FieldHints, {
        resetKey: tab,
        children: createElement(ObjectInspectorFrameView, {
          id: 'hint-insp', title: 'Table', activeTab: tab, onSelectTab: setTab,
          hint: createElement(FieldHintStrip),
          tabs: [
            { id: 'overview', title: 'Overview', layout: 'flow', content: createElement(PropertyField, { id: 'lock', label: 'Lock Escalation', description: 'Controls lock granularity.', children: createElement('input', { id: 'lock' }) }) },
            { id: 'storage', title: 'Storage', layout: 'flow', content: createElement('div', null, 'Storage') }
          ]
        })
      })
    }
    const el = mount(createElement(Harness))
    const input = el.querySelector<HTMLInputElement>('#lock')!
    const field = el.querySelector<HTMLElement>('.property-field')!
    const hint = () => el.querySelector('.field-hint')?.textContent ?? ''

    expect(hint()).toBe('')
    act(() => { field.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(hint()).toContain('Lock Escalation')
    act(() => { field.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    expect(hint()).toBe('')

    // Focus shows hint; pointer leave on the split only clears hovered hints, never the focused hint.
    act(() => { input.focus() })
    expect(hint()).toContain('Controls lock granularity.')
    const split = el.querySelector<HTMLElement>('.inspector-split')!
    act(() => { split.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    expect(hint()).toContain('Controls lock granularity.')

    // Switching tabs clears it immediately even before blur.
    const storageTab = el.querySelector<HTMLButtonElement>('[data-inspector-tab="storage"]')!
    act(() => { storageTab.click() })
    expect(hint()).toBe('')
  })

  it('upholds single-scroller, no smooth strip scroll, narrow hide <=680px, touch-action, property alignment, and forced-colors CSS invariants', () => {
    const rules = stylesheetRules()
    const decls = (selector: string, at = '') => rules.filter(r => r.selector === selector && r.at.join(' ') === at).flatMap(r => r.declarations)
    expect(decls('.inspector-tab-strip').some(d => d.property === 'scroll-behavior')).toBe(false)
    expect(decls('.inspector-tab-strip').find(d => d.property === 'position')?.value).toBe('relative')
    expect(decls('.inspector-pane-flow').find(d => d.property === 'overflow-y')?.value).toBe('auto')
    expect(decls('.inspector-pane-flow').find(d => d.property === 'overflow-x')?.value).toBe('hidden')
    expect(decls('.inspector-pane-fill').find(d => d.property === 'overflow')?.value).toBe('hidden')
    expect(decls('.inspector-pane-flow .property-field').find(d => d.property === 'grid-template-columns')?.value).toBe('minmax(156px, 28%) minmax(0, 1fr)')
    expect(decls('.inspector-pane-flow .property-field').find(d => d.property === 'column-gap')?.value).toBe('0')
    expect(decls('.inspector-vitals-sash').find(d => d.property === 'touch-action')?.value).toBe('none')
    expect(decls('.inspector-vitals-rail, .inspector-vitals-sash, .inspector-vitals-toggle', '@container inspector-frame (max-width: 680px)').find(d => d.property === 'display')?.value).toBe('none')
    expect(decls('.inspector-tab[aria-selected="true"]', '@media (forced-colors: active)').find(d => d.property === 'border-bottom-color')?.value).toBe('Highlight')
    expect(decls('.ratio-bar-seg, .ratio-bar-swatch', '@media (forced-colors: active)').find(d => d.property === 'forced-color-adjust')?.value).toBe('none')
    expect(decls('.ratio-bar-seg[data-series="2"], .ratio-bar-swatch[data-series="2"]', '@media (forced-colors: active)').some(d => d.property === 'background')).toBe(true)
  })
})
