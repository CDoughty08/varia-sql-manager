import { describe, expect, it } from 'vitest'
import { defaultRules, platforms, type Platform } from '../src/shared/commands/keybindings'
import { gridKeyAction, pageStep, type GridAction } from '../src/renderer/src/grid/keyboard'

interface Modifiers { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean; mod?: boolean; isComposing?: boolean }
/** A keydown as Chromium reports it; `mod` is Ctrl on Windows and Linux and ⌘ on macOS. */
const key = (platform: Platform, keyValue: string, code: string, m: Modifiers = {}) => ({
  key: keyValue, code, shiftKey: !!m.shift, altKey: !!m.alt, isComposing: !!m.isComposing,
  ctrlKey: !!m.ctrl || (!!m.mod && platform !== 'darwin'), metaKey: !!m.meta || (!!m.mod && platform === 'darwin')
})
const move = (to: string, extend = false): GridAction => ({ type: 'move', move: to, extend } as GridAction)
const arrows = [['ArrowUp', 'up', 'firstRow'], ['ArrowDown', 'down', 'lastRow'], ['ArrowLeft', 'left', 'firstColumn'], ['ArrowRight', 'right', 'lastColumn']] as const

describe('grid keys', () => {
  it('map every grid key of the design on every platform', () => {
    for (const platform of platforms) {
      const action = (keyValue: string, code: string, m?: Modifiers) => gridKeyAction(key(platform, keyValue, code, m), platform)
      for (const [name, one, edge] of arrows) {
        expect(action(name, name), `${platform} ${name}`).toEqual(move(one))
        expect(action(name, name, { shift: true })).toEqual(move(one, true))
        // Ctrl+arrow (⌘+arrow on macOS) goes to that edge; with Shift it extends there.
        expect(action(name, name, { mod: true })).toEqual(move(edge))
        expect(action(name, name, { mod: true, shift: true })).toEqual(move(edge, true))
      }
      expect([action('Home', 'Home'), action('End', 'End'), action('Home', 'Home', { shift: true }), action('End', 'End', { shift: true })])
        .toEqual([move('firstColumn'), move('lastColumn'), move('firstColumn', true), move('lastColumn', true)])
      expect([action('Home', 'Home', { mod: true }), action('End', 'End', { mod: true }), action('Home', 'Home', { mod: true, shift: true }), action('End', 'End', { mod: true, shift: true })])
        .toEqual([move('firstCell'), move('lastCell'), move('firstCell', true), move('lastCell', true)])
      expect([action('PageUp', 'PageUp'), action('PageDown', 'PageDown'), action('PageUp', 'PageUp', { shift: true }), action('PageDown', 'PageDown', { shift: true })])
        .toEqual([move('pageUp'), move('pageDown'), move('pageUp', true), move('pageDown', true)])
      expect(action(' ', 'Space', { shift: true })).toEqual({ type: 'selectRows' })
      // Ctrl+Space on every platform: ⌃Space on macOS.
      expect(action(' ', 'Space', { ctrl: true })).toEqual({ type: 'selectColumns' })
      expect(action('Enter', 'Enter')).toEqual({ type: 'open' })
      expect(action('Escape', 'Escape')).toEqual({ type: 'escape' })
      expect(action('a', 'KeyA', { mod: true })).toEqual({ type: 'selectAll' })
      expect(action('c', 'KeyC', { mod: true })).toEqual({ type: 'copy' })
    }
  })
  it('leave other keys to the browser and the workbench', () => {
    for (const platform of platforms) {
      const action = (keyValue: string, code: string, m?: Modifiers) => gridKeyAction(key(platform, keyValue, code, m), platform)
      const ignored = [
        // Previous and Next Query, Ctrl+Tab, Tab (the browser moves focus), and catalogue commands.
        action('PageUp', 'PageUp', { ctrl: true }), action('PageDown', 'PageDown', { ctrl: true }), action('PageDown', 'PageDown', { mod: true, shift: true }),
        action('Tab', 'Tab', { ctrl: true }), action('Tab', 'Tab'), action('Tab', 'Tab', { shift: true }),
        action('c', 'KeyC', { mod: true, shift: true }), action('s', 'KeyS', { mod: true }), action('F6', 'F6'), action('F10', 'F10', { shift: true }), action('r', 'KeyR', { mod: true }),
        // Alt combinations, typing, IME composition, and modifiers alone.
        action('ArrowDown', 'ArrowDown', { alt: true }), action('Enter', 'Enter', { alt: true }), action('x', 'KeyX'), action(' ', 'Space'),
        action('ArrowDown', 'ArrowDown', { isComposing: true }), action('Shift', 'ShiftLeft', { shift: true }), action('Enter', 'Enter', { shift: true })
      ]
      expect(ignored, platform).toEqual(ignored.map(() => undefined))
    }
    // Ctrl+arrows and Ctrl+A on macOS are not ⌘: Mission Control and the line start belong to the system.
    expect(gridKeyAction(key('darwin', 'ArrowLeft', 'ArrowLeft', { ctrl: true }), 'darwin')).toBeUndefined()
    expect(gridKeyAction(key('darwin', 'a', 'KeyA', { ctrl: true }), 'darwin')).toBeUndefined()
    expect(gridKeyAction(key('win32', 'a', 'KeyA', { meta: true }), 'win32')).toBeUndefined()
  })
  it('agree with the catalogue: Copy and Select All are the native rules the grid serves itself', () => {
    for (const platform of platforms) {
      const native = defaultRules(platform).filter(rule => rule.native && (rule.command === 'output.copy' || rule.command === 'output.selectAll'))
      expect(native.map(rule => rule.command).sort(), platform).toEqual(['output.copy', 'output.selectAll'])
      for (const rule of native) {
        const [modifiers, letter] = [rule.chords[0].split('+').slice(0, -1), rule.chords[0].split('+').at(-1)!]
        const event = { key: letter, code: 'Key' + letter.toUpperCase(), ctrlKey: modifiers.includes('ctrl'), shiftKey: modifiers.includes('shift'), altKey: modifiers.includes('alt'), metaKey: modifiers.includes('meta') }
        expect(gridKeyAction(event, platform), `${platform} ${rule.command}`).toEqual({ type: rule.command === 'output.copy' ? 'copy' : 'selectAll' })
      }
    }
  })
  it('page by the rows the body shows less one, at least one', () => {
    expect(pageStep(600)).toBe(29)
    expect(pageStep(619)).toBe(29)
    expect(pageStep(620)).toBe(30)
    expect(pageStep(30)).toBe(1)
    expect(pageStep(0)).toBe(1)
  })
})
