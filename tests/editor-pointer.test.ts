import { describe, expect, it } from 'vitest'
import { afterPointer } from '../src/renderer/src/editor-groups/pointer'

describe('afterPointer', () => {
  it('waits for the pointer to go up, and for a blur when the release never comes', () => {
    const target = new EventTarget(), ran: string[] = [], later: (() => void)[] = []
    const pointer = afterPointer(target, run => { later.push(run) })
    // Nothing held: at once.
    pointer.then(() => ran.push('now'))
    expect(ran).toEqual(['now'])
    // Held: after the release, once Dockview has handled it.
    target.dispatchEvent(new Event('pointerdown'))
    pointer.then(() => ran.push('released'))
    expect(pointer.held()).toBe(true)
    expect(ran).toEqual(['now'])
    target.dispatchEvent(new Event('pointerup'))
    expect(pointer.held()).toBe(false)
    later.splice(0).forEach(run => run())
    expect(ran).toEqual(['now', 'released'])
    // The window lost focus mid-press: the blur ends the hold.
    target.dispatchEvent(new Event('pointerdown'))
    pointer.then(() => ran.push('blurred'))
    target.dispatchEvent(new Event('blur'))
    later.splice(0).forEach(run => run())
    expect(ran).toEqual(['now', 'released', 'blurred'])
    // Disposed: a waiting run is dropped and events are no longer heard.
    target.dispatchEvent(new Event('pointerdown'))
    pointer.then(() => ran.push('dropped'))
    pointer.dispose()
    target.dispatchEvent(new Event('pointerup'))
    expect(later).toEqual([])
    expect(pointer.held()).toBe(true)
  })
  it('keeps the hold through an element’s blur, which a capture listener on the window hears too', () => {
    // As the window: its capture listeners see events aimed at elements inside it, whose target is that element.
    const listeners = new Map<string, (event: Event) => void>()
    const window = { addEventListener: (name: string, listener: (event: Event) => void) => { listeners.set(name, listener) }, removeEventListener: () => {} }
    const editor = {}, ran: string[] = []
    const pointer = afterPointer(window as unknown as EventTarget, run => run())
    const fire = (name: string, target: object) => listeners.get(name)!({ type: name, target } as unknown as Event)
    fire('pointerdown', editor)
    pointer.then(() => ran.push('docked'))
    // The float moves an editor, which blurs it: the drag goes on.
    fire('blur', editor)
    expect(pointer.held()).toBe(true)
    expect(ran).toEqual([])
    // The window itself loses focus: the hold ends.
    fire('blur', window)
    expect(pointer.held()).toBe(false)
    expect(ran).toEqual(['docked'])
  })
})
