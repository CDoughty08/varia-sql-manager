// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ResizableSplit, { SplitSash, type ResizableSplitProps } from '../src/renderer/src/kit/ResizableSplit'
import { PlanPaneSizer } from '../src/renderer/src/plans/PlanPaneSizer'
import {
  clampSplitWidth, dynamicSplitMax, isSplitNarrowStacked, loadSplitWidth, saveSplitWidth, splitStorageKey, splitWidthKey,
  type SplitBounds
} from '../src/renderer/src/kit/resizable-split'
import { stylesheetRules } from './fixtures/css-rules'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: (() => void)[] = []
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  cleanups.splice(0).forEach(cleanup => cleanup())
})

function mountWithRender(element: ReturnType<typeof createElement>): {
  host: HTMLElement
  rerender: (next: ReturnType<typeof createElement>) => void
} {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => { root.render(element) })
  cleanups.unshift(() => {
    act(() => root.unmount())
    host.remove()
  })
  return {
    host,
    rerender: next => { act(() => { root.render(next) }) }
  }
}

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  return mountWithRender(element).host
}

const bounds: SplitBounds = { defaultWidth: 304, minWidth: 252, maxWidth: 480, minOtherWidth: 360 }

function makeProps(overrides: Partial<ResizableSplitProps> = {}): ResizableSplitProps {
  return {
    side: 'left',
    defaultWidth: bounds.defaultWidth,
    minWidth: bounds.minWidth,
    maxWidth: bounds.maxWidth,
    minOtherWidth: bounds.minOtherWidth,
    label: 'Resize steps list',
    railLabel: 'Steps list',
    rail: createElement('div', { className: 'test-rail' }, 'Rail'),
    children: createElement('div', { className: 'test-main' }, 'Main'),
    ...overrides
  }
}

describe('resizable-split helpers', () => {
  it('prefixes storage keys under varia.split. without double-prefixing', () => {
    expect(splitStorageKey('agent.job.steps')).toBe('varia.split.agent.job.steps')
    expect(splitStorageKey('varia.split.agent.job.steps')).toBe('varia.split.agent.job.steps')
  })

  it('computes dynamic max and clamps widths against minWidth, maxWidth, and minOtherWidth', () => {
    expect(dynamicSplitMax(bounds)).toBe(480)
    expect(dynamicSplitMax(bounds, 1000)).toBe(480)
    expect(dynamicSplitMax(bounds, 700)).toBe(340)
    expect(dynamicSplitMax(bounds, 500)).toBe(252)

    expect(clampSplitWidth(350, bounds, 1000)).toBe(350)
    expect(clampSplitWidth(100, bounds, 1000)).toBe(252)
    expect(clampSplitWidth(600, bounds, 1000)).toBe(480)
    expect(clampSplitWidth(420, bounds, 700)).toBe(340)
    expect(clampSplitWidth(Number.NaN, bounds, 1000)).toBe(304)
    expect(clampSplitWidth(Number.POSITIVE_INFINITY, bounds, 700)).toBe(304)
  })

  it('loads and saves persisted widths safely when storage is empty, corrupt, or throws', () => {
    expect(loadSplitWidth('agent.job.steps', bounds)).toBe(304)
    localStorage.setItem('varia.split.agent.job.steps', 'not-a-number')
    expect(loadSplitWidth('agent.job.steps', bounds)).toBe(304)
    localStorage.setItem('varia.split.agent.job.steps', '   ')
    expect(loadSplitWidth('agent.job.steps', bounds)).toBe(304)
    localStorage.setItem('varia.split.agent.job.steps', '999')
    expect(loadSplitWidth('agent.job.steps', bounds)).toBe(480)

    saveSplitWidth('agent.job.steps', 360.6, bounds)
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('361')
    saveSplitWidth('agent.job.steps', Number.NaN, bounds)
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('361')

    const getSpy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    const setSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    try {
      expect(loadSplitWidth('agent.job.steps', bounds)).toBe(304)
      expect(() => saveSplitWidth('agent.job.steps', 320, bounds)).not.toThrow()
    } finally {
      getSpy.mockRestore()
      setSpy.mockRestore()
    }

    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError') } })
    try {
      expect(loadSplitWidth('agent.job.steps', bounds)).toBe(304)
      expect(() => saveSplitWidth('agent.job.steps', 320, bounds)).not.toThrow()
    } finally {
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    }
  })

  it('steps keyboard width with side polarity, Shift acceleration, and Home reset', () => {
    expect(splitWidthKey(304, 'ArrowRight', 'left', bounds)).toBe(316)
    expect(splitWidthKey(304, 'ArrowLeft', 'left', bounds)).toBe(292)
    expect(splitWidthKey(304, 'ArrowRight', 'left', bounds, undefined, true)).toBe(328)
    expect(splitWidthKey(304, 'ArrowLeft', 'left', bounds, undefined, true)).toBe(280)

    expect(splitWidthKey(304, 'ArrowLeft', 'right', bounds)).toBe(316)
    expect(splitWidthKey(304, 'ArrowRight', 'right', bounds)).toBe(292)
    expect(splitWidthKey(304, 'ArrowLeft', 'right', bounds, undefined, true)).toBe(328)
    expect(splitWidthKey(304, 'ArrowRight', 'right', bounds, undefined, true)).toBe(280)

    expect(splitWidthKey(400, 'Home', 'left', bounds)).toBe(304)
    expect(splitWidthKey(400, 'Home', 'right', bounds, 600)).toBe(252)
    expect(splitWidthKey(304, 'Enter', 'left', bounds)).toBeUndefined()
  })

  it('respects maxShare and extended keyboard options (custom step, homeAction=min, endToMax)', () => {
    const vitalsBounds: SplitBounds = { defaultWidth: 272, minWidth: 200, maxWidth: 440, minOtherWidth: 0, maxShare: 0.48 }
    expect(dynamicSplitMax(vitalsBounds)).toBe(440)
    expect(dynamicSplitMax(vitalsBounds, 900)).toBe(432)
    expect(dynamicSplitMax(vitalsBounds, 700)).toBe(336)
    expect(dynamicSplitMax(vitalsBounds, 300)).toBe(200)
    expect(clampSplitWidth(440, vitalsBounds, 700)).toBe(336)

    const optionsBounds: SplitBounds = { defaultWidth: 224, minWidth: 180, maxWidth: 340, minOtherWidth: 0, maxShare: 0.42 }
    expect(dynamicSplitMax(optionsBounds, 960)).toBe(340)
    expect(dynamicSplitMax(optionsBounds, 640)).toBe(268)

    const planBounds: SplitBounds = { defaultWidth: 220, minWidth: 120, maxWidth: 600, minOtherWidth: 0 }
    expect(splitWidthKey(220, 'ArrowRight', 'left', planBounds, undefined, false, { step: 16 })).toBe(236)
    expect(splitWidthKey(220, 'ArrowRight', 'left', planBounds, undefined, true, { step: 16, shiftStep: 32 })).toBe(252)
    expect(splitWidthKey(220, 'Home', 'left', planBounds, undefined, false, { homeAction: 'min' })).toBe(120)
    expect(splitWidthKey(220, 'End', 'left', planBounds, undefined, false, { endToMax: true })).toBe(600)
    expect(splitWidthKey(220, 'End', 'left', planBounds, undefined, false)).toBeUndefined()
  })

  it('detects narrow stacking threshold', () => {
    expect(isSplitNarrowStacked(undefined, 680)).toBe(false)
    expect(isSplitNarrowStacked(680, 680)).toBe(true)
    expect(isSplitNarrowStacked(681, 680)).toBe(false)
    expect(isSplitNarrowStacked(500, undefined)).toBe(false)
  })
})

describe('ResizableSplit component', () => {
  it('renders left and right pane order and vertical separator ARIA attributes', () => {
    const leftHost = mount(createElement(ResizableSplit, makeProps({ side: 'left', id: 'split-left' })))
    const leftChildren = [...leftHost.querySelector('.varia-split')!.children]
    expect(leftChildren.map(el => el.className)).toEqual(['varia-split-rail', 'varia-sash', 'varia-split-main'])
    const leftRail = leftHost.querySelector<HTMLElement>('.varia-split-rail')!
    expect(leftRail.getAttribute('role')).toBe('region')
    expect(leftRail.getAttribute('aria-label')).toBe('Steps list')
    expect(leftRail.style.width).toBe('304px')

    const unlabeledHost = mount(createElement(ResizableSplit, makeProps({ railLabel: undefined })))
    const unlabeledRail = unlabeledHost.querySelector('.varia-split-rail')!
    expect(unlabeledRail.hasAttribute('role')).toBe(false)
    expect(unlabeledRail.hasAttribute('aria-label')).toBe(false)

    const emptyLabelHost = mount(createElement(ResizableSplit, makeProps({ railLabel: '' })))
    const emptyLabelRail = emptyLabelHost.querySelector('.varia-split-rail')!
    expect(emptyLabelRail.hasAttribute('role')).toBe(false)
    expect(emptyLabelRail.hasAttribute('aria-label')).toBe(false)

    const sash = leftHost.querySelector('.varia-sash')!
    expect(sash.getAttribute('role')).toBe('separator')
    expect(sash.getAttribute('aria-orientation')).toBe('vertical')
    expect(sash.getAttribute('aria-label')).toBe('Resize steps list')
    expect(sash.getAttribute('aria-valuemin')).toBe('252')
    expect(sash.getAttribute('aria-valuemax')).toBe('480')
    expect(sash.getAttribute('aria-valuenow')).toBe('304')
    expect(sash.getAttribute('tabindex')).toBe('0')
    expect(sash.getAttribute('title')).toBe('Drag to resize · Double-click to reset (304 px)')

    const rightHost = mount(createElement(ResizableSplit, makeProps({ side: 'right' })))
    const rightChildren = [...rightHost.querySelector('.varia-split')!.children]
    expect(rightChildren.map(el => el.className)).toEqual(['varia-split-main', 'varia-sash', 'varia-split-rail'])
  })

  it('persists and restores widths across remounts in self-persisted mode and resets on Home and double-click', () => {
    localStorage.setItem('varia.split.agent.job.steps', '360')
    const host = mount(createElement(ResizableSplit, makeProps({ storageKey: 'agent.job.steps' })))
    const sash = host.querySelector<HTMLElement>('.varia-sash')!
    expect(sash.getAttribute('aria-valuenow')).toBe('360')

    act(() => {
      sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(sash.getAttribute('aria-valuenow')).toBe('372')
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('372')

    act(() => {
      sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }))
    })
    expect(sash.getAttribute('aria-valuenow')).toBe('348')
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('348')

    // Remount restores persisted width.
    const remounted = mount(createElement(ResizableSplit, makeProps({ storageKey: 'agent.job.steps' })))
    expect(remounted.querySelector('.varia-sash')?.getAttribute('aria-valuenow')).toBe('348')

    const remountSash = remounted.querySelector<HTMLElement>('.varia-sash')!
    act(() => {
      remountSash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(remountSash.getAttribute('aria-valuenow')).toBe('304')
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('304')

    act(() => {
      remountSash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(remountSash.getAttribute('aria-valuenow')).toBe('316')

    act(() => {
      remountSash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(remountSash.getAttribute('aria-valuenow')).toBe('304')
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('304')
  })

  it('prefers controlled width over storageKey and invokes onWidthChange/onWidthReset without mutating localStorage', () => {
    localStorage.setItem('varia.split.agent.job.steps', '410')
    const onWidthChange = vi.fn()
    const onWidthReset = vi.fn()
    const host = mount(createElement(ResizableSplit, makeProps({
      side: 'right',
      storageKey: 'agent.job.steps',
      width: 280,
      onWidthChange,
      onWidthReset
    })))
    const sash = host.querySelector<HTMLElement>('.varia-sash')!
    expect(sash.getAttribute('aria-valuenow')).toBe('280')

    act(() => {
      sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }))
    })
    expect(onWidthChange).toHaveBeenCalledWith(304)
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('410')

    act(() => {
      sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onWidthReset).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('410')
  })

  it('handles pointer drag, pointercancel, lostpointercapture, zero-movement click, and non-primary buttons', () => {
    const onWidthChange = vi.fn()
    const host = mount(createElement(ResizableSplit, makeProps({
      side: 'left',
      width: 300,
      onWidthChange
    })))
    const sash = host.querySelector<HTMLElement>('.varia-sash')!
    sash.setPointerCapture = vi.fn()

    // Non-primary button does nothing.
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 2, pointerId: 1, clientX: 300, bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(false)
    expect(onWidthChange).not.toHaveBeenCalled()

    // Zero-movement click does not trigger onWidthChange.
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2, clientX: 300, bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(true)
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 2, clientX: 300, bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(false)
    expect(onWidthChange).not.toHaveBeenCalled()

    // Left-button drag commits on pointerup.
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 3, clientX: 300, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 350, bubbles: true }))
    })
    expect(sash.getAttribute('aria-valuenow')).toBe('350')
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 3, clientX: 350, bubbles: true }))
    })
    expect(onWidthChange).toHaveBeenCalledWith(350)

    // pointercancel cleanly ends drag and stops tracking later pointermoves.
    onWidthChange.mockClear()
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 4, clientX: 300, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 4, clientX: 330, bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(true)
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 4, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 4, clientX: 390, bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(false)
    expect(onWidthChange).toHaveBeenCalledWith(330)

    // lostpointercapture cleanly ends drag.
    onWidthChange.mockClear()
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 5, clientX: 300, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 5, clientX: 320, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 5, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 5, clientX: 390, bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(false)
    expect(onWidthChange).toHaveBeenCalledWith(320)
  })

  it('clamps dynamically to minOtherWidth via ResizeObserver without overwriting wider persisted width on click or pinned arrow', () => {
    const observers: (() => void)[] = []
    class StubResizeObserver {
      constructor(cb: () => void) { observers.push(cb) }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    localStorage.setItem('varia.split.agent.job.steps', '440')

    const host = mount(createElement(ResizableSplit, makeProps({ storageKey: 'agent.job.steps' })))
    const split = host.querySelector<HTMLElement>('.varia-split')!
    const sash = host.querySelector<HTMLElement>('.varia-sash')!
    sash.setPointerCapture = vi.fn()

    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 700 })
    act(() => { observers.forEach(cb => cb()) })

    expect(sash.getAttribute('aria-valuemax')).toBe('340')
    expect(sash.getAttribute('aria-valuenow')).toBe('340')
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('440')

    // Zero-move click and pinned ArrowRight must not overwrite 440 in localStorage.
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 340, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: 340, bubbles: true }))
      sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('440')

    // Widening restores the wider persisted width.
    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 1000 })
    act(() => { observers.forEach(cb => cb()) })
    expect(sash.getAttribute('aria-valuemax')).toBe('480')
    expect(sash.getAttribute('aria-valuenow')).toBe('440')
  })

  it('stacks below narrowStackWidth without mutating persisted width and supports railOpen', () => {
    const observers: (() => void)[] = []
    class StubResizeObserver {
      constructor(cb: () => void) { observers.push(cb) }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    localStorage.setItem('varia.split.agent.job.steps', '380')

    const host = mount(createElement(ResizableSplit, makeProps({ storageKey: 'agent.job.steps', narrowStackWidth: 680 })))
    const split = host.querySelector<HTMLElement>('.varia-split')!
    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 640 })
    act(() => { observers.forEach(cb => cb()) })

    expect(split.getAttribute('data-stacked')).toBe('true')
    expect(host.querySelector('.varia-sash')).toBeNull()
    expect((host.querySelector('.varia-split-rail') as HTMLElement).style.width).toBe('')
    expect(localStorage.getItem('varia.split.agent.job.steps')).toBe('380')

    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 900 })
    act(() => { observers.forEach(cb => cb()) })
    expect(split.hasAttribute('data-stacked')).toBe(false)
    expect(host.querySelector('.varia-sash')?.getAttribute('aria-valuenow')).toBe('380')

    const closedHost = mount(createElement(ResizableSplit, makeProps({ railOpen: false })))
    expect(closedHost.querySelector('.varia-split-rail')).toBeNull()
    expect(closedHost.querySelector('.varia-sash')).toBeNull()
    expect(closedHost.querySelector('.varia-split-main')).not.toBeNull()
  })

  it('clears transient drag state when railOpen becomes false or container stacks mid-drag', () => {
    const observers: (() => void)[] = []
    class StubResizeObserver {
      constructor(cb: () => void) { observers.push(cb) }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver)

    const onWidthChange = vi.fn()
    const { host, rerender } = mountWithRender(createElement(ResizableSplit, makeProps({
      side: 'left',
      width: 300,
      narrowStackWidth: 680,
      railOpen: true,
      onWidthChange
    })))
    const split = host.querySelector<HTMLElement>('.varia-split')!
    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 900 })
    act(() => { observers.forEach(cb => cb()) })

    let sash = host.querySelector<HTMLElement>('.varia-sash')!
    sash.setPointerCapture = vi.fn()
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 10, clientX: 300, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 10, clientX: 360, bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(true)
    expect(sash.getAttribute('aria-valuenow')).toBe('360')

    // Closing the rail mid-drag unmounts the sash and clears transient dragWidth before reopen.
    rerender(createElement(ResizableSplit, makeProps({
      side: 'left',
      width: 300,
      narrowStackWidth: 680,
      railOpen: false,
      onWidthChange
    })))
    expect(host.querySelector('.varia-sash')).toBeNull()

    rerender(createElement(ResizableSplit, makeProps({
      side: 'left',
      width: 300,
      narrowStackWidth: 680,
      railOpen: true,
      onWidthChange
    })))
    sash = host.querySelector<HTMLElement>('.varia-sash')!
    expect(sash.hasAttribute('data-dragging')).toBe(false)
    expect(sash.getAttribute('aria-valuenow')).toBe('300')
    expect(onWidthChange).not.toHaveBeenCalled()

    // Stacking below narrowStackWidth mid-drag also clears transient dragWidth before widening back.
    sash.setPointerCapture = vi.fn()
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 11, clientX: 300, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 11, clientX: 350, bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(true)
    expect(sash.getAttribute('aria-valuenow')).toBe('350')

    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 640 })
    act(() => { observers.forEach(cb => cb()) })
    expect(split.getAttribute('data-stacked')).toBe('true')
    expect(host.querySelector('.varia-sash')).toBeNull()

    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 900 })
    act(() => { observers.forEach(cb => cb()) })
    sash = host.querySelector<HTMLElement>('.varia-sash')!
    expect(sash.hasAttribute('data-dragging')).toBe(false)
    expect(sash.getAttribute('aria-valuenow')).toBe('300')
    expect(onWidthChange).not.toHaveBeenCalled()
  })

  it('preserves DOM node identity across railOpen and stacked transitions for left and right sides', () => {
    const observers: (() => void)[] = []
    class StubResizeObserver {
      constructor(cb: () => void) { observers.push(cb) }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver)

    for (const side of ['left', 'right'] as const) {
      const { host, rerender } = mountWithRender(createElement(ResizableSplit, makeProps({
        side,
        narrowStackWidth: 680,
        railOpen: true
      })))
      const split = host.querySelector<HTMLElement>('.varia-split')!
      Object.defineProperty(split, 'clientWidth', { configurable: true, value: 900 })
      act(() => { observers.forEach(cb => cb()) })

      const initialMain = host.querySelector<HTMLElement>('.test-main')!
      const initialRail = host.querySelector<HTMLElement>('.test-rail')!
      expect(initialMain).not.toBeNull()
      expect(initialRail).not.toBeNull()

      // Toggling railOpen true -> false -> true preserves .test-main DOM node identity.
      rerender(createElement(ResizableSplit, makeProps({
        side,
        narrowStackWidth: 680,
        railOpen: false
      })))
      expect(host.querySelector('.test-rail')).toBeNull()
      expect(host.querySelector('.test-main')).toBe(initialMain)

      rerender(createElement(ResizableSplit, makeProps({
        side,
        narrowStackWidth: 680,
        railOpen: true
      })))
      expect(host.querySelector('.test-main')).toBe(initialMain)
      const reopenedRail = host.querySelector<HTMLElement>('.test-rail')!
      expect(reopenedRail).not.toBeNull()

      // Crossing narrowStackWidth (false -> true -> false) preserves both .test-main and .test-rail DOM nodes.
      Object.defineProperty(split, 'clientWidth', { configurable: true, value: 640 })
      act(() => { observers.forEach(cb => cb()) })
      expect(split.getAttribute('data-stacked')).toBe('true')
      expect(host.querySelector('.varia-sash')).toBeNull()
      expect(host.querySelector('.test-main')).toBe(initialMain)
      expect(host.querySelector('.test-rail')).toBe(reopenedRail)

      Object.defineProperty(split, 'clientWidth', { configurable: true, value: 900 })
      act(() => { observers.forEach(cb => cb()) })
      expect(split.hasAttribute('data-stacked')).toBe(false)
      expect(host.querySelector('.varia-sash')).not.toBeNull()
      expect(host.querySelector('.test-main')).toBe(initialMain)
      expect(host.querySelector('.test-rail')).toBe(reopenedRail)
    }
  })
})

describe('SplitSash and PlanPaneSizer consolidation', () => {
  it('supports disabled SplitSash with aria-disabled, no tooltip, and no drag/keyboard/double-click callbacks', () => {
    const onCommit = vi.fn(), onReset = vi.fn(), onDragPreview = vi.fn()
    const host = mount(createElement(SplitSash, {
      className: 'connect-splitter',
      side: 'left',
      label: 'Resize saved connections list',
      value: 320,
      bounds: { defaultWidth: 320, minWidth: 220, maxWidth: 460, minOtherWidth: 440 },
      containerWidth: 900,
      step: 16,
      shiftStep: 32,
      disabled: true,
      onDragPreview,
      onCommit,
      onReset
    }))
    const sash = host.querySelector<HTMLElement>('.varia-sash.connect-splitter')!
    expect(sash.getAttribute('aria-disabled')).toBe('true')
    expect(sash.hasAttribute('title')).toBe(false)
    sash.setPointerCapture = vi.fn()
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 320, bubbles: true }))
      sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(false)
    expect(onDragPreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect(onReset).not.toHaveBeenCalled()
  })

  it('aborts an active drag immediately when disabled flips true->false without resuming or committing, and ignores zero-move clicks for onDragPreview', () => {
    const onCommit = vi.fn(), onDragPreview = vi.fn(), onDragCancel = vi.fn()
    const baseProps = {
      className: 'connect-splitter',
      side: 'left' as const,
      label: 'Resize saved connections list',
      value: 320,
      bounds: { defaultWidth: 320, minWidth: 220, maxWidth: 460, minOtherWidth: 440 },
      containerWidth: 760,
      revertOnCancel: true,
      onDragPreview,
      onDragCancel,
      onCommit
    }
    const { host, rerender } = mountWithRender(createElement(SplitSash, { ...baseProps, disabled: false }))
    const sash = host.querySelector<HTMLElement>('.varia-sash.connect-splitter')!
    const releasePointerCapture = vi.fn()
    sash.setPointerCapture = vi.fn()
    sash.hasPointerCapture = vi.fn(() => true)
    sash.releasePointerCapture = releasePointerCapture

    // Zero-movement click must not invoke onDragPreview or onCommit.
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 320, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: 320, bubbles: true }))
    })
    expect(onDragPreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()

    // Start dragging and move, then disable mid-drag.
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2, clientX: 320, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 280, bubbles: true }))
    })
    expect(sash.hasAttribute('data-dragging')).toBe(true)
    expect(onDragPreview).toHaveBeenLastCalledWith(280)

    rerender(createElement(SplitSash, { ...baseProps, disabled: true }))
    expect(sash.hasAttribute('data-dragging')).toBe(false)
    expect(releasePointerCapture).toHaveBeenCalledWith(2)
    expect(onDragPreview).toHaveBeenLastCalledWith(undefined)
    expect(onDragCancel).toHaveBeenCalledWith(320)
    expect(onCommit).not.toHaveBeenCalled()

    // Re-enabling before pointerup must NOT resume or commit the aborted drag.
    onDragPreview.mockClear(); onDragCancel.mockClear(); onCommit.mockClear()
    rerender(createElement(SplitSash, { ...baseProps, disabled: false }))
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 260, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 2, clientX: 260, bubbles: true }))
    })
    expect(onDragPreview).not.toHaveBeenCalled()
    expect(onDragCancel).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('routes PlanPaneSizer keyboard (Arrow/Shift+Arrow/Home/End), focusOnPointerDown, double-click reset, drag commit, and cancel/lostcapture revert through SplitSash', () => {
    const resize = vi.fn(), commit = vi.fn()
    const host = mount(createElement(PlanPaneSizer, {
      name: 'properties',
      value: 260,
      minimum: 140,
      defaultWidth: 260,
      reverse: true,
      resize,
      commit
    }))
    const sash = host.querySelector<HTMLElement>('.varia-sash.plan-pane-sizer')!
    expect(sash.getAttribute('aria-label')).toBe('Resize plan properties')
    expect(sash.getAttribute('aria-valuemin')).toBe('140')
    expect(sash.getAttribute('aria-valuemax')).toBe('600')
    expect(sash.getAttribute('aria-valuenow')).toBe('260')

    // Reverse polarity: ArrowLeft widens (+16), Shift+ArrowLeft (+32), Home -> min (140), End -> 600.
    act(() => { sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(resize).toHaveBeenLastCalledWith(276)
    expect(commit).toHaveBeenLastCalledWith(276)

    act(() => { sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true })) })
    expect(resize).toHaveBeenLastCalledWith(292)
    expect(commit).toHaveBeenLastCalledWith(292)

    act(() => { sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    expect(commit).toHaveBeenLastCalledWith(140)

    act(() => { sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(commit).toHaveBeenLastCalledWith(600)

    // Double-click resets to defaultWidth (260).
    act(() => { sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(resize).toHaveBeenLastCalledWith(260)
    expect(commit).toHaveBeenLastCalledWith(260)

    // Drag cancelled via pointercancel focuses sash and reverts to start width without committing.
    resize.mockClear(); commit.mockClear()
    sash.setPointerCapture = vi.fn()
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 9, clientX: 500, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 460, bubbles: true }))
    })
    expect(document.activeElement).toBe(sash)
    expect(resize).toHaveBeenLastCalledWith(300)
    expect(commit).not.toHaveBeenCalled()
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9, bubbles: true }))
    })
    expect(resize).toHaveBeenLastCalledWith(260)
    expect(commit).not.toHaveBeenCalled()

    // Drag cancelled via lostpointercapture also reverts to start width without committing.
    resize.mockClear(); commit.mockClear()
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 11, clientX: 500, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 11, clientX: 450, bubbles: true }))
    })
    expect(resize).toHaveBeenLastCalledWith(310)
    act(() => {
      sash.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 11, bubbles: true }))
    })
    expect(resize).toHaveBeenLastCalledWith(260)
    expect(commit).not.toHaveBeenCalled()

    // Completed pointer drag commits final width.
    resize.mockClear(); commit.mockClear()
    act(() => {
      sash.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 10, clientX: 500, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointermove', { pointerId: 10, clientX: 470, bubbles: true }))
      sash.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 10, clientX: 470, bubbles: true }))
    })
    expect(resize).toHaveBeenLastCalledWith(290)
    expect(commit).toHaveBeenLastCalledWith(290)
  })
})

describe('ResizableSplit CSS invariants', () => {
  const rules = stylesheetRules()
  const decl = (selector: string, property: string, at: readonly string[] = []) =>
    rules.filter(rule => rule.selector === selector && rule.at.join(' ') === at.join(' '))
      .flatMap(rule => rule.declarations)
      .find(declaration => declaration.property === property)?.value

  it('sets touch-action: none, disabled cursor, and forced-colors visibility on .varia-sash', () => {
    expect(decl('.varia-sash', 'touch-action')).toBe('none')
    expect(decl('.varia-sash[aria-disabled="true"]', 'cursor')).toBe('default')
    expect(decl('.varia-sash::after', 'background', ['@media (forced-colors: active)'])).toBe('CanvasText')
    expect(decl('.varia-sash:not([aria-disabled="true"]):hover::after, .varia-sash[data-dragging]::after, .varia-sash:focus-visible::after', 'background', ['@media (forced-colors: active)'])).toBe('Highlight')
    expect(decl('.plan-body:has(.plan-sql-view) > .plan-outline', 'border-right', ['@media (forced-colors: active)'])).toBe('1px solid CanvasText')
  })
})
