import { describe, expect, it, vi } from 'vitest'
import { gestureIds, gestureOptions, type GestureChoice, type GestureId } from '../src/shared/commands/gestures'
import {
  gestureChoiceFromText as parseGestureToken, gestureChoiceText as gestureToken, gestureChoiceTexts, gestureOverrides, withGestureChoice
} from '../src/shared/commands/gesture-choices'
import { gestureErrors, validateGestures } from '../src/shared/commands/gesture-validate'
import { platforms } from '../src/shared/commands/keybindings'
import { readShortcutFile } from '../src/shared/commands/shortcut-schema'
import { GestureService, paneTabTitle, popoutTabTitle } from '../src/renderer/src/core/gestures'

describe('gesture choice tokens', () => {
  it('store a choice as one platform-neutral word and read it back', () => {
    expect([null, [], ['mod'], ['alt'], ['shift', 'ctrl'], ['meta', 'alt', 'mod']].map(choice => gestureToken(choice as GestureChoice))).toEqual(['off', 'none', 'mod', 'alt', 'ctrlShift', 'modAltMeta'])
    for (const token of ['off', 'none', 'mod', 'alt', 'ctrlShift', 'modAltMeta']) expect(gestureToken(parseGestureToken(token)!), token).toBe(token)
    // Only what gestureToken writes: no other order, case, repeat or word.
    for (const token of ['shiftCtrl', 'Ctrl', 'ctrlCtrl', 'hyper', '', 'ctrl+shift']) expect(parseGestureToken(token), token).toBeUndefined()
  })
  it('match what the shortcuts file accepts, so no offered choice is moved to unknown', () => {
    const tokens = gestureChoiceTexts
    for (const id of gestureIds) for (const platform of platforms) for (const choice of gestureOptions(id, platform)) expect(tokens.get(id), id).toContain(gestureToken(choice))
    const read = readShortcutFile({ version: 1, gestures: { 'dock.floatWhileDragging': 'alt', 'dock.toggleFloat': 'meta', 'popout.returnToMain': 'off', 'grid.fitColumn': 'ctrl' } }, { gestures: tokens })
    expect(read.ok && read.file.gestures).toEqual({ 'dock.floatWhileDragging': 'alt', 'dock.toggleFloat': 'meta' })
    // A pointer command cannot be turned off, and a fixed gesture takes no choice: both stay in the file as unknown.
    expect(read.ok && read.file.unknown).toEqual([{ gesture: 'popout.returnToMain', choice: 'off' }, { gesture: 'grid.fitColumn', choice: 'ctrl' }])
  })
  it('apply on each platform only where the gesture offers them there', () => {
    const stored = { 'dock.floatWhileDragging': 'alt', 'dock.toggleFloat': 'meta', 'explorer.peekHover': 'off', 'grid.secondaryClick': 'none', 'later.gesture': 'alt', 'grid.addToSelection': 'shiftCtrl' }
    expect([...gestureOverrides(stored, 'darwin')]).toEqual([['dock.floatWhileDragging', ['alt']], ['dock.toggleFloat', ['meta']], ['explorer.peekHover', null]])
    // ⌘ is macOS's own choice for Toggle Docking: Windows keeps its default.
    expect([...gestureOverrides(stored, 'win32')]).toEqual([['dock.floatWhileDragging', ['alt']], ['explorer.peekHover', null]])
  })
  it('keep only changes in the file', () => {
    const stored = { 'dock.floatWhileDragging': 'alt', 'later.gesture': 'x' }
    expect(withGestureChoice(stored, 'dock.floatWhileDragging', ['ctrl'], 'linux')).toEqual({ 'later.gesture': 'x' })
    expect(withGestureChoice(stored, 'dock.floatWhileDragging', undefined, 'linux')).toEqual({ 'later.gesture': 'x' })
    expect(withGestureChoice(stored, 'explorer.peekHover', null, 'linux')).toEqual({ ...stored, 'explorer.peekHover': 'off' })
    // ⌘ is the default on macOS, so choosing it there stores nothing; Ctrl, the others' default, is not stored either.
    expect(withGestureChoice({ 'dock.toggleFloat': 'shift' }, 'dock.toggleFloat', ['meta'], 'darwin')).toEqual({})
    expect(withGestureChoice({}, 'dock.toggleFloat', [], 'win32')).toEqual({ 'dock.toggleFloat': 'none' })
  })
})

describe('gesture validation', () => {
  it('finds nothing wrong with the defaults or with any one choice the catalogue offers', () => {
    for (const platform of platforms) {
      expect(validateGestures(platform, new Map()), platform).toEqual([])
      for (const id of gestureIds) for (const choice of gestureOptions(id, platform)) {
        expect(gestureErrors(validateGestures(platform, new Map([[id, choice]]))), `${id} = ${gestureToken(choice)} on ${platform}`).toEqual([])
      }
    }
  })
  it('refuses two gestures that one press would start in the same place', () => {
    // Shift+click already extends the selection in the grid and the table designer.
    const problems = validateGestures('win32', new Map<GestureId, GestureChoice>([['grid.addToSelection', ['shift']]]))
    expect(problems).toEqual([{ id: 'grid.addToSelection', other: 'grid.extendSelection', severity: 'error', code: 'clash', message: 'Shift+Click already does Extend Selection in Results Grid: one press would do both.' }])
    // A gesture with no modifier fires under any held modifier, so it also clashes with one that has some.
    expect(validateGestures('win32', new Map<GestureId, GestureChoice>([['grid.addToSelection', []]])).map(problem => problem.other)).toEqual(['grid.extendSelection'])
    // Different places or actions never clash, and a gesture turned off clashes with nothing.
    expect(validateGestures('win32', new Map<GestureId, GestureChoice>([['dock.toggleFloat', []], ['popout.returnToMain', []]]))).toEqual([])
    expect(validateGestures('win32', new Map<GestureId, GestureChoice>([['grid.addToSelection', null]]))).toEqual([])
  })
  it('warns where the desktop usually takes a modifier first', () => {
    const alt = new Map<GestureId, GestureChoice>([['dock.floatWhileDragging', ['alt']], ['grid.addToSelection', ['alt']]])
    expect(validateGestures('linux', alt).map(problem => [problem.id, problem.severity, problem.code])).toEqual([['grid.addToSelection', 'warning', 'linuxAlt'], ['dock.floatWhileDragging', 'warning', 'linuxAlt']])
    expect(validateGestures('win32', alt)).toEqual([])
    // Hovering presses nothing, so no window manager starts a move.
    expect(validateGestures('linux', new Map<GestureId, GestureChoice>([['explorer.peekHover', ['alt']]]))).toEqual([])
    // macOS: Control+double-click is a right-click (a file from another build could ask for it); Control-drag still works.
    expect(validateGestures('darwin', new Map<GestureId, GestureChoice>([['dock.toggleFloat', ['ctrl']]])).map(problem => problem.code)).toEqual(['macControlClick'])
    expect(validateGestures('darwin', new Map<GestureId, GestureChoice>([['dock.floatWhileDragging', ['ctrl']]]))).toEqual([])
  })
})

describe('GestureService remaps', () => {
  it('reads the file\'s gestures, tells subscribers once per change, and refreshes the tooltips', () => {
    const service = new GestureService('linux'), listener = vi.fn()
    service.subscribe(listener)
    service.setModifiers({ 'dock.floatWhileDragging': 'alt', 'popout.returnToMain': 'none' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(service.matches('dock.floatWhileDragging', { altKey: true })).toBe(true)
    expect(service.matches('popout.returnToMain', {})).toBe(true)
    expect(paneTabTitle(service)).toBe('Drag to dock; Alt-drag to float; Ctrl-double-click to toggle docking')
    expect(popoutTabTitle(service)).toBe('Drag onto the main window to dock it there; double-click to move it back')
    // The same choices again change nothing.
    service.setModifiers(new Map<GestureId, GestureChoice>([['dock.floatWhileDragging', ['alt']], ['popout.returnToMain', []]]))
    expect(listener).toHaveBeenCalledTimes(1)
    // Float while dragging, turned off, leaves the tooltip.
    service.setModifiers({ 'dock.floatWhileDragging': 'off' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(paneTabTitle(service)).toBe('Drag to dock; Ctrl-double-click to toggle docking')
    service.setModifiers({})
    expect(paneTabTitle(service)).toBe('Drag to dock; Ctrl-drag to float; Ctrl-double-click to toggle docking')
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
