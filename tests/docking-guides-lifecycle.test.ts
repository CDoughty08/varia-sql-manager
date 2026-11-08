// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel, PositionResolverArgs } from 'dockview-react'
import { DockingGuides } from '../src/renderer/src/docking-guides'
import { GestureService } from '../src/renderer/src/core/gestures'

const cleanups: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers() })

function fixture() {
  const root = document.createElement('div'), element = document.createElement('div')
  root.append(element); document.body.append(root)
  const rect = { x: 0, y: 0, width: 800, height: 600 }
  root.getBoundingClientRect = element.getBoundingClientRect = () => DOMRect.fromRect(rect)
  const moveTo = vi.fn(), source = { id: 'query-1', api: { moveTo } } as unknown as IDockviewPanel
  const group = { element, panels: [source, { id: 'query-2' }], api: { location: { type: 'grid' }, isVisible: true } } as unknown as DockviewGroupPanel
  let dragPanel: Parameters<DockviewApi['onWillDragPanel']>[0] = () => {}
  let willDrop: Parameters<DockviewApi['onWillDrop']>[0] = () => {}
  let willShow: Parameters<DockviewApi['onWillShowOverlay']>[0] = () => {}
  const disposable = () => ({ dispose() {} })
  const api = {
    groups: [group], getPanel: () => source, addFloatingGroup: vi.fn(), addGroup: vi.fn(() => group), updateOptions: vi.fn(),
    onWillDragPanel: (listener: typeof dragPanel) => { dragPanel = listener; return disposable() },
    onWillDragGroup: disposable, onWillShowOverlay: (listener: typeof willShow) => { willShow = listener; return disposable() },
    onWillDrop: (listener: typeof willDrop) => { willDrop = listener; return disposable() }
  }
  const beforeFloat = vi.fn(), failed = vi.fn(), ended = vi.fn()
  const guides = new DockingGuides(api as unknown as DockviewApi, root, beforeFloat, failed, new GestureService('win32'), undefined, ended)
  cleanups.push(() => { guides.dispose(); root.remove() })
  const layer = document.querySelector<HTMLElement>('.docking-guides')!
  const preview = layer.querySelector<HTMLElement>('.docking-preview')!
  const pointer = (type: string, buttons = 1, clientX = 400, clientY = 300) => new PointerEvent(type, { bubbles: true, pointerId: 1, clientX, clientY, buttons })
  const start = (x = 400, y = 300) => dragPanel({ panel: source, nativeEvent: pointer('pointerdown', 1, x, y) } as Parameters<typeof dragPanel>[0])
  const drop = (destination = group, kind = 'content', position = 'center', x = 400, y = 300) => {
    const preventDefault = vi.fn()
    willDrop({ nativeEvent: pointer('pointerup', 0, x, y), group: destination, kind, position, preventDefault } as unknown as Parameters<typeof willDrop>[0])
    return preventDefault
  }
  const overlay = (destination = group, kind = 'content') => {
    const preventDefault = vi.fn()
    willShow({ nativeEvent: pointer('pointermove'), group: destination, kind, position: 'center', preventDefault } as unknown as Parameters<typeof willShow>[0])
    return preventDefault
  }
  const resolve = () => guides.resolve({ event: pointer('pointerup', 0), zones: new Set(['center']), x: 400, y: 276, width: 800, height: 576 } as PositionResolverArgs)
  return { root, group, source, moveTo, guides, api, beforeFloat, failed, ended, layer, preview, pointer, start, drop, overlay, resolve }
}

describe('docking guide drag cleanup', () => {
  it.each(['pointermove', 'keyup'])('keeps the compass hidden when %s arrives between release and the deferred drop cleanup', signal => {
    const f = fixture()
    f.start()
    expect(f.layer.hidden).toBe(false)
    expect(f.preview.hidden).toBe(false)
    f.root.dispatchEvent(f.pointer('pointerup', 0))
    // Dockview still needs the resolver until its window-level release handler commits the drop.
    expect(f.resolve()).toEqual({ position: 'center', edge: false })
    if (signal === 'pointermove') f.root.dispatchEvent(f.pointer('pointermove', 0))
    else document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }))
    expect(f.layer.hidden).toBe(true)
    expect(f.preview.hidden).toBe(true)
    f.drop()
    vi.runAllTimers()
    expect(f.layer.hidden).toBe(true)
    expect(f.preview.hidden).toBe(true)
    expect(f.resolve()).toBeNull()
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
  })

  it('hears a release targeted at the window, as Dockview does', () => {
    const f = fixture()
    f.start()
    window.dispatchEvent(f.pointer('pointerup', 0))
    f.drop()
    vi.runAllTimers()
    expect(f.layer.hidden).toBe(true)
    f.root.dispatchEvent(f.pointer('pointermove'))
    expect(f.layer.hidden).toBe(true)
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
  })

  it('clears an abandoned drag when the next pointer move has no button held', () => {
    const f = fixture()
    f.start()
    f.root.dispatchEvent(f.pointer('pointermove', 0))
    expect(f.layer.hidden).toBe(true)
    expect(f.resolve()).toBeNull()
    expect(f.preview.hidden).toBe(true)
    vi.runAllTimers()
    expect(f.beforeFloat).not.toHaveBeenCalled()
  })

  it.each(['pointercancel', 'blur', 'Escape'])('cancels on %s without floating the tab or showing the compass again', signal => {
    const f = fixture()
    f.start()
    if (signal === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: signal, bubbles: true }))
    else window.dispatchEvent(signal === 'pointercancel' ? f.pointer(signal, 0) : new Event(signal))
    f.root.dispatchEvent(f.pointer('pointermove'))
    vi.runAllTimers()
    expect(f.layer.hidden).toBe(true)
    expect(f.resolve()).toBeNull()
    expect(f.beforeFloat).not.toHaveBeenCalled()
    expect(f.ended).toHaveBeenCalledOnce()
    // Dockview can still deliver a queued native drop after our drag was cancelled.
    expect(f.overlay()).toHaveBeenCalledOnce()
    expect(f.drop()).toHaveBeenCalledOnce()
  })

  it('does not let a previous release clear a new drag of the same tab', () => {
    const f = fixture()
    f.start()
    f.root.dispatchEvent(f.pointer('pointerup', 0))
    f.start()
    vi.runAllTimers()
    expect(f.layer.hidden).toBe(false)
    expect(f.resolve()).toEqual({ position: 'center', edge: false })
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
  })

  it('floats an undocked tab once after release and clears the overlay', () => {
    const f = fixture()
    f.start(200, 200)
    f.root.dispatchEvent(f.pointer('pointerup', 0, 200, 200))
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(f.api.addFloatingGroup).toHaveBeenCalledOnce()
    expect(f.layer.hidden).toBe(true)
    expect(f.failed).not.toHaveBeenCalled()
  })

  it('clears the overlay even when the fallback move fails', () => {
    const f = fixture(), error = new Error('Cannot float')
    f.api.addFloatingGroup.mockImplementation(() => { throw error })
    f.start(200, 200)
    f.root.dispatchEvent(f.pointer('pointerup', 0, 200, 200))
    vi.runAllTimers()
    expect(f.failed).toHaveBeenCalledWith(error)
    expect(f.layer.hidden).toBe(true)
    expect(f.resolve()).toBeNull()
  })

  it('disposes a pending release without running a fallback move', () => {
    const f = fixture()
    f.start()
    f.root.dispatchEvent(f.pointer('pointerup', 0))
    f.guides.dispose()
    vi.runAllTimers()
    expect(document.querySelector('.docking-guides')).toBeNull()
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
  })

  it.each(['content', 'tab'])('rejects an overlapping source’s %s target and docks into the group shown by the compass', kind => {
    const f = fixture()
    const covering = { element: f.root, panels: [f.source], api: { location: { type: 'floating' }, isVisible: true } } as unknown as DockviewGroupPanel
    f.group.panels.splice(0, 1)
    f.api.groups.push(covering)
    f.start()
    expect(f.overlay(covering, kind)).toHaveBeenCalledOnce()
    f.root.dispatchEvent(f.pointer('pointerup', 0))
    expect(f.drop(covering, kind)).toHaveBeenCalledOnce()
    vi.runAllTimers()
    expect(f.moveTo).toHaveBeenCalledExactlyOnceWith({ group: f.group, position: 'center' })
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
    expect(f.layer.hidden).toBe(true)
    expect(f.preview.hidden).toBe(true)
  })

  it('leaves a native drop into the compass’s destination to Dockview', () => {
    const f = fixture()
    f.start()
    expect(f.overlay()).not.toHaveBeenCalled()
    f.root.dispatchEvent(f.pointer('pointerup', 0))
    expect(f.drop()).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(f.moveTo).not.toHaveBeenCalled()
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
  })

  it('docks at the workspace edge when an overlap prevents Dockview from receiving the guide drop', () => {
    const f = fixture()
    f.start(472, 300)
    f.root.dispatchEvent(f.pointer('pointerup', 0, 472, 300))
    vi.runAllTimers()
    expect(f.api.addGroup).toHaveBeenCalledExactlyOnceWith({ direction: 'right' })
    expect(f.moveTo).toHaveBeenCalledExactlyOnceWith({ group: f.group, position: 'center' })
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
  })

  it.each(['pointermove', 'pointerup', 'pointercancel'])('ignores %s from a different pointer while a tab is held', type => {
    const f = fixture()
    f.start()
    window.dispatchEvent(new PointerEvent(type, { pointerId: 2, clientX: 400, clientY: 300, buttons: 0 }))
    vi.runAllTimers()
    expect(f.layer.hidden).toBe(false)
    expect(f.moveTo).not.toHaveBeenCalled()
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
  })

  it('uses the release point instead of a stale guide hit when no final move was delivered', () => {
    const f = fixture()
    f.start()
    f.root.dispatchEvent(f.pointer('pointerup', 0, 200, 200))
    expect(f.drop(f.group, 'content', 'center', 200, 200)).toHaveBeenCalledOnce()
    vi.runAllTimers()
    expect(f.moveTo).not.toHaveBeenCalled()
    expect(f.api.addFloatingGroup).toHaveBeenCalledOnce()
  })

  it('rejects Dockview’s stale side when the release lands on a different guide', () => {
    const f = fixture()
    f.start(436, 300)
    f.root.dispatchEvent(f.pointer('pointerup', 0))
    expect(f.drop(f.group, 'content', 'right')).toHaveBeenCalledOnce()
    vi.runAllTimers()
    expect(f.moveTo).toHaveBeenCalledExactlyOnceWith({ group: f.group, position: 'center' })
    expect(f.api.addFloatingGroup).not.toHaveBeenCalled()
  })

  it('notifies the workspace after Dockview handles the release, and on a missed-release recovery', () => {
    const f = fixture()
    f.start()
    expect(f.ended).not.toHaveBeenCalled()
    f.root.dispatchEvent(f.pointer('pointerup', 0))
    f.drop()
    expect(f.ended).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(f.ended).toHaveBeenCalledOnce()
    f.start()
    f.root.dispatchEvent(f.pointer('pointermove', 0))
    expect(f.ended).toHaveBeenCalledTimes(2)
  })

  it('uses the visible floating destination after an older window is brought in front of a newer one', () => {
    const f = fixture()
    const upperElement = document.createElement('div'), lowerElement = document.createElement('div')
    f.root.append(upperElement, lowerElement)
    upperElement.getBoundingClientRect = lowerElement.getBoundingClientRect = f.root.getBoundingClientRect
    const upper = { element: upperElement, panels: [{ id: 'upper' }], api: { location: { type: 'floating' }, isVisible: true } } as unknown as DockviewGroupPanel
    const lower = { element: lowerElement, panels: [{ id: 'lower' }], api: { location: { type: 'floating' }, isVisible: true } } as unknown as DockviewGroupPanel
    f.api.groups.push(upper, lower)
    // Dockview raises a focused window's z-index without changing the groups' creation order.
    const original = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [upperElement, lowerElement, f.root] })
    cleanups.push(() => { if (original) Object.defineProperty(document, 'elementsFromPoint', original); else Reflect.deleteProperty(document, 'elementsFromPoint') })
    f.start()
    expect(f.overlay(upper)).not.toHaveBeenCalled()
    f.root.dispatchEvent(f.pointer('pointerup', 0))
    vi.runAllTimers()
    expect(f.moveTo).toHaveBeenCalledExactlyOnceWith({ group: upper, position: 'center' })
  })
})
