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
})
