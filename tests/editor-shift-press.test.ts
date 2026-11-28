// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { dockviewOwnPress, plainShiftPress } from '../src/renderer/src/editor-groups/shift-press'

/**
 * A Dockview-shaped editor area inside the workbench's own Dockview panel: a docked group and a floating one, each with a
 * tab, its strip's empty space and a document.
 */
function area() {
  const panel = document.createElement('div'), root = document.createElement('div')
  panel.className = 'dv-content-container'
  root.innerHTML = `
    <div data-group="grid"><div class="dv-tab"><div data-tab-id="q1"><span class="name">Query 1</span><button class="tab-close"></button><button class="tab-pin"></button><input class="tab-rename"></div></div><div class="dv-void-container"></div><div class="dv-content-container"><div class="text"></div></div></div>
    <div data-group="floating"><div class="dv-tab"><div data-tab-id="q2"><span class="name">Query 2</span></div></div><div class="dv-void-container"></div><div class="dv-content-container"><div class="cell"></div></div></div>`
  panel.append(root)
  document.body.append(panel)
  const chosen: string[] = [], heard: { prevented: boolean; own: boolean }[] = []
  // As Dockview: its own listeners sit on the elements and skip a press already prevented, or one marked as its own.
  root.addEventListener('pointerdown', event => { heard.push({ prevented: event.defaultPrevented, own: (event as unknown as Record<string, unknown>)[dockviewOwnPress] === true }) })
  const guard = plainShiftPress(root, { docked: element => element.closest('[data-group]')?.getAttribute('data-group') === 'grid', choose: id => chosen.push(id) })
  const press = (selector: string, init: PointerEventInit = {}) => {
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...init })
    root.querySelector(selector)!.dispatchEvent(event)
    return event.defaultPrevented
  }
  return { root, chosen, heard, guard, press }
}

/** The ES module build Vite bundles into the renderer (the package's `module` entry). */
const dockviewBundle = () => {
  const manifest = createRequire(import.meta.url).resolve('dockview-core/package.json')
  return readFileSync(join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).module), 'utf8')
}

afterEach(() => { document.body.innerHTML = '' })

describe('plainShiftPress', () => {
  it('stops Dockview floating a query tab on a Shift-press, and chooses the tab instead', () => {
    const { chosen, heard, press } = area()
    expect(press('[data-group="grid"] .name', { shiftKey: true })).toBe(true)
    expect(press('[data-group="floating"] .name', { shiftKey: true })).toBe(true)
    expect(chosen).toEqual(['q1', 'q2'])
    expect(heard).toEqual([{ prevented: true, own: false }, { prevented: true, own: false }])
  })
  it('keeps a floating document’s Shift-press from moving its float, and leaves the press itself alone', () => {
    const { chosen, heard, press } = area()
    // The text or results take the press as their own (Shift+click extends a selection); only the float's move is skipped.
    expect(press('[data-group="floating"] .cell', { shiftKey: true })).toBe(false)
    expect(press('[data-group="grid"] .text', { shiftKey: true })).toBe(false)
    expect(press('[data-group="floating"] .cell')).toBe(false)
    expect(heard).toEqual([{ prevented: false, own: true }, { prevented: false, own: true }, { prevented: false, own: false }])
    expect(chosen).toEqual([])
  })
  it('pins the mark and the float’s Shift move to the Dockview the app bundles', () => {
    const bundle = dockviewBundle()
    expect(bundle).toContain(`QUASI_PREVENT_DEFAULT_KEY = "${dockviewOwnPress}"`)
    // The overlay's content listener: a Shift-press moves the float unless prevented or marked.
    expect(bundle).toMatch(/if \(quasiDefaultPrevented\(event\)\) return;\s*if \(event\.shiftKey\) track\(this\.options\.content, event\.pointerId\);/)
    // Its only readers are the float's two move listeners (the title bar's and the content's): a new one would change what
    // the mark does to a document's press.
    expect(bundle.match(/\(quasiDefaultPrevented\(/g)).toHaveLength(2)
  })
  it('stops a docked strip floating its group, but leaves a floating strip, which keeps Dockview’s group drag', () => {
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
