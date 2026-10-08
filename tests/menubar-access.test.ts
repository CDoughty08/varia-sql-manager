import { describe, expect, it, vi } from 'vitest'
import type { Platform } from '../src/shared/commands/keybindings'
import { MenubarAccess, trackWindowFocus, type AltKeyEvent } from '../src/renderer/src/menus/menubar'

type FakeKey = AltKeyEvent & { prevented: boolean }
function key(value: string, modifiers: { ctrl?: boolean; shift?: boolean; meta?: boolean; repeat?: boolean; altGraph?: boolean } = {}): FakeKey {
  const event: FakeKey = {
    key: value, ctrlKey: !!modifiers.ctrl, shiftKey: !!modifiers.shift, metaKey: !!modifiers.meta, repeat: !!modifiers.repeat, prevented: false,
    getModifierState: name => name === 'AltGraph' && !!modifiers.altGraph, preventDefault: () => { event.prevented = true }
  }
  return event
}
/** Presses and releases Alt with `between` in the middle; returns whether the release completed a tap. */
function tap(access: MenubarAccess, between: (access: MenubarAccess) => void = () => {}, down = key('Alt'), up = key('Alt')) {
  access.noteKeyDown(down)
  between(access)
  return { fired: access.noteKeyUp(up), down, up }
}

describe('bare Alt', () => {
  it.each(['win32', 'linux'] as Platform[])('completes a clean tap on %s, marks both halves handled, and shows access keys while Alt is down', platform => {
    const access = new MenubarAccess(platform), held: boolean[] = []
    access.subscribe(() => held.push(access.getSnapshot().altHeld))
    const { fired, down, up } = tap(access, current => expect(current.getSnapshot().altHeld).toBe(true))
    expect([fired, down.prevented, up.prevented]).toEqual([true, true, true])
    expect(held).toEqual([true, false])
    // Each tap stands alone.
    expect(access.noteKeyUp(key('Alt'))).toBe(false)
    expect(tap(access).fired).toBe(true)
  })
  it('is cancelled by another key, a pointer press, or the window losing focus in between', () => {
    const access = new MenubarAccess('win32')
    for (const between of [(current: MenubarAccess) => current.noteKeyDown(key('z')), (current: MenubarAccess) => current.noteKeyDown(key('Tab')), (current: MenubarAccess) => current.disarm()]) {
      const { fired, up } = tap(access, between)
      expect(fired).toBe(false)
      // A cancelled release is left alone: Alt+Tab and Alt+click keep their default behaviour.
      expect(up.prevented).toBe(false)
      expect(access.getSnapshot().altHeld).toBe(false)
    }
  })
  it('ignores Alt with Ctrl, Shift, Meta, or AltGr, and auto-repeat', () => {
    const access = new MenubarAccess('linux')
    for (const down of [key('Alt', { ctrl: true }), key('Alt', { shift: true }), key('Alt', { meta: true }), key('Alt', { altGraph: true }), key('AltGraph')]) {
      expect(tap(access, undefined, down).fired, JSON.stringify(down)).toBe(false)
      expect(down.prevented).toBe(false)
    }
    // Holding Alt down until it repeats is not a tap.
    expect(tap(access, current => current.noteKeyDown(key('Alt', { repeat: true }))).fired).toBe(false)
    // Releasing another key does nothing.
    access.noteKeyDown(key('Alt'))
    expect(access.noteKeyUp(key('Shift'))).toBe(false)
    expect(access.noteKeyUp(key('Alt'))).toBe(true)
  })
  it('does nothing on macOS, which has no in-window menubar', () => {
    const access = new MenubarAccess('darwin')
    const { fired, down, up } = tap(access)
    expect([fired, down.prevented, up.prevented, access.getSnapshot().altHeld]).toEqual([false, false, false, false])
  })
  it('stops notifying once disposed', () => {
    const access = new MenubarAccess('win32'), listener = vi.fn()
    access.subscribe(listener)
    access.dispose()
    access.noteKeyDown(key('Alt'))
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('window focus', () => {
  it('starts active and follows focus and blur until disposed', () => {
    const listeners = new Map<string, () => void>()
    const target = { addEventListener: vi.fn((type: string, listener: () => void) => { listeners.set(type, listener) }), removeEventListener: vi.fn((type: string) => { listeners.delete(type) }) }
    const root = { dataset: {} as DOMStringMap }
    const tracking = trackWindowFocus(target as unknown as Window, root)
    expect(root.dataset.windowFocus).toBe('active')
    listeners.get('blur')!()
    expect(root.dataset.windowFocus).toBe('inactive')
    listeners.get('focus')!()
    expect(root.dataset.windowFocus).toBe('active')
    tracking.dispose()
    expect(listeners.size).toBe(0)
  })
})
