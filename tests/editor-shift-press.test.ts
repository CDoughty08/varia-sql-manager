// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { plainShiftPress } from '../src/renderer/src/editor-groups/shift-press'

/** A Dockview-shaped editor area: a docked group and a floating one, each with a tab and its strip's empty space. */
function area() {
  const root = document.createElement('div')
  root.innerHTML = `
    <div data-group="grid"><div class="dv-tab"><div data-tab-id="q1"><span class="name">Query 1</span><button class="tab-close"></button><button class="tab-pin"></button><input class="tab-rename"></div></div><div class="dv-void-container"></div></div>
    <div data-group="floating"><div class="dv-tab"><div data-tab-id="q2"><span class="name">Query 2</span></div></div><div class="dv-void-container"></div></div>`
  document.body.append(root)
  const chosen: string[] = [], heard: { prevented: boolean }[] = []
  // As Dockview: its own listeners sit on the elements and skip a press already prevented.
  root.addEventListener('pointerdown', event => { heard.push({ prevented: event.defaultPrevented }) })
  const guard = plainShiftPress(root, { docked: element => element.closest('[data-group]')?.getAttribute('data-group') === 'grid', choose: id => chosen.push(id) })
  const press = (selector: string, init: PointerEventInit = {}) => {
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...init })
    root.querySelector(selector)!.dispatchEvent(event)
    return event.defaultPrevented
  }
  return { root, chosen, heard, guard, press }
}

afterEach(() => { document.body.innerHTML = '' })

describe('plainShiftPress', () => {
  it('stops Dockview floating a query tab on a Shift-press, and chooses the tab instead', () => {
    const { chosen, heard, press } = area()
    expect(press('[data-group="grid"] .name', { shiftKey: true })).toBe(true)
    expect(press('[data-group="floating"] .name', { shiftKey: true })).toBe(true)
    expect(chosen).toEqual(['q1', 'q2'])
    expect(heard.every(event => event.prevented)).toBe(true)
  })
  it('stops a docked strip floating its group, but leaves a floating strip, which a Shift-drag moves', () => {
    const { chosen, press } = area()
    expect(press('[data-group="grid"] .dv-void-container', { shiftKey: true })).toBe(true)
    expect(press('[data-group="floating"] .dv-void-container', { shiftKey: true })).toBe(false)
    expect(chosen).toEqual([])
  })
  it('leaves plain presses, other buttons\' choice, and the tab\'s own controls alone', () => {
    const { chosen, press } = area()
    expect(press('[data-group="grid"] .name')).toBe(false)
    expect(press('[data-group="grid"] .name', { ctrlKey: true })).toBe(false)
    // A Shift+right-click floats nothing either, but chooses nothing: Dockview chooses only on the primary button.
    expect(press('[data-group="grid"] .name', { shiftKey: true, button: 2 })).toBe(true)
    for (const control of ['.tab-close', '.tab-pin', '.tab-rename']) expect(press(`[data-group="grid"] ${control}`, { shiftKey: true })).toBe(false)
    expect(chosen).toEqual([])
  })
  it('stops listening once disposed', () => {
    const { chosen, guard, press } = area()
    guard.dispose()
    expect(press('[data-group="grid"] .name', { shiftKey: true })).toBe(false)
    expect(chosen).toEqual([])
  })
})
