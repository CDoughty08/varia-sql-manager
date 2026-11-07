import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockPrimaryPaste, type PrimaryPasteTarget } from '../src/renderer/src/core/primary-selection'

/** A window stand-in: a plain EventTarget with the timers the guard takes from its window. */
const fakeWindow = () => Object.assign(new EventTarget(), { setTimeout: globalThis.setTimeout }) as unknown as PrimaryPasteTarget & EventTarget
const pointer = (type: string, button: number, buttons = 0) => Object.assign(new Event(type, { cancelable: true }), { button, buttons })
const nextTask = () => new Promise(resolve => setTimeout(resolve))

describe('PRIMARY selection paste', () => {
  it('cancels only middle-button changes, pointerup and chorded pointermove included, and only on Linux', () => {
    const target = fakeWindow()
    const guard = blockPrimaryPaste(target, 'linux')
    // A cancelled pointerdown leaves no mouseup, and a chorded press or release comes as a pointermove with the middle button.
    for (const type of ['mouseup', 'pointerup', 'pointermove']) {
      const middle = pointer(type, 1), left = pointer(type, 0), none = pointer(type, -1), down = pointer(type.replace(/up|move/, 'down'), 1, 4)
      for (const event of [middle, left, none, down]) target.dispatchEvent(event)
      expect([middle.defaultPrevented, left.defaultPrevented, none.defaultPrevented, down.defaultPrevented], type).toEqual([true, false, false, false])
    }
    const chordedPress = pointer('pointermove', 1, 5)
    target.dispatchEvent(chordedPress)
    expect(chordedPress.defaultPrevented).toBe(true)
    guard.dispose()
    for (const type of ['mouseup', 'pointerup', 'pointermove']) {
      const after = pointer(type, 1)
      target.dispatchEvent(after)
      expect(after.defaultPrevented, type).toBe(false)
    }
    for (const platform of ['win32', 'darwin'] as const) {
      const other = fakeWindow()
      blockPrimaryPaste(other, platform)
      for (const type of ['pointerdown', 'mouseup', 'pointerup', 'pointermove', 'paste']) {
        const event = pointer(type, 1, type === 'pointerdown' ? 4 : 0)
        other.dispatchEvent(event)
        expect(event.defaultPrevented, platform + ' ' + type).toBe(false)
      }
    }
  })
  it('hides a paste while the middle button is held or in a middle-button release\'s task from every other listener, and no other paste', async () => {
    const target = fakeWindow(), seen: string[] = []
    const guard = blockPrimaryPaste(target, 'linux')
    target.addEventListener('paste', () => seen.push('paste'), { capture: true })
    const paste = () => { const event = new Event('paste', { cancelable: true }); target.dispatchEvent(event); return event.defaultPrevented }
    // The Paste role's paste: no middle button in its task.
    expect(paste()).toBe(false)
    // A release Blink pastes after, whichever of its events reaches the window.
    for (const type of ['auxclick', 'mouseup', 'pointerup', 'pointermove']) {
      await nextTask()
      target.dispatchEvent(pointer(type, 1))
      expect(paste(), type).toBe(true)
    }
    await nextTask()
    expect(paste()).toBe(false)
    // A press that a page script keeps every release event from reaching the window: still held until an event shows the
    // button up, and for the rest of that event's task.
    target.dispatchEvent(pointer('pointerdown', 1, 4))
    await nextTask()
    expect(paste()).toBe(true)
    target.dispatchEvent(pointer('pointermove', -1, 0))
    expect(paste()).toBe(true)
    await nextTask()
    expect(paste()).toBe(false)
    // A chorded press holds it too; a new press before the last one's release clears keeps it held.
    target.dispatchEvent(pointer('pointermove', 1, 5))
    target.dispatchEvent(pointer('pointermove', -1, 1))
    target.dispatchEvent(pointer('pointerdown', 1, 5))
    await nextTask()
    expect(paste()).toBe(true)
    target.dispatchEvent(pointer('pointerup', 0, 0))
    await nextTask()
    // Left-button events mark nothing.
    target.dispatchEvent(pointer('auxclick', 0))
    target.dispatchEvent(pointer('pointerdown', 0, 1))
    expect(paste()).toBe(false)
    expect(seen).toEqual(['paste', 'paste', 'paste', 'paste'])
    guard.dispose()
  })
  it('guards the main window and every popout', () => {
    const workbench = readFileSync(join('src', 'renderer', 'src', 'core', 'workbench.ts'), 'utf8')
    expect(workbench.match(/blockPrimaryPaste\(window, platform\)/g)).toHaveLength(1)
    // attachWindow: each popout window while it is open.
    expect(workbench).toMatch(/attachWindow: target => \{\n\s+const attached = \[[^\]]*blockPrimaryPaste\(target, platform\)/)
    // Not a paste guard (standalone Monaco has no selection clipboard): Linux's middle-drag selects a column, as elsewhere.
    expect(readFileSync(join('src', 'renderer', 'src', 'editor', 'create-editor.ts'), 'utf8')).toMatch(/selectionClipboard: false/)
  })
})
