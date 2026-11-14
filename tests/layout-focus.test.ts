// @vitest-environment happy-dom
// Switching the results layout while a grid of the pane had the focus (OutputPane's useLayoutFocus): the grid the other
// layout draws for the focused view takes it back. Whether a grid had it is read at the switch, so a grid removed some
// other way (a re-run, Close Results) leaves nothing behind for a later switch to act on.
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useLayoutFocus } from '../src/renderer/src/results/OutputPane'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined, container: HTMLElement | undefined
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
})

/** A pane whose layout draws one grid per key given, under the key `layout` (as each layout is a component of its own). */
function Pane({ tabs, grids }: { tabs: boolean; grids: readonly string[] }) {
  const { mainRef } = useLayoutFocus(tabs, () => 'e2')
  return createElement('div', { ref: mainRef, className: 'results-main' },
    createElement('div', { key: tabs ? 'tabs' : 'stack' }, grids.map(key => createElement('div', { key, 'data-result-grid': '', 'data-result-entry': key, tabIndex: 0 }))))
}

function harness() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const draw = (tabs: boolean, grids: readonly string[]) => act(() => { root!.render(createElement(Pane, { tabs, grids })) })
  const grid = (key: string) => container!.querySelector<HTMLElement>(`[data-result-entry="${key}"]`)!
  return { draw, grid }
}

describe('the focus across a results layout switch', () => {
  it('goes to the focused view\'s grid in the other layout when a grid of the pane had it', () => {
    const { draw, grid } = harness()
    draw(true, ['e2'])
    grid('e2').focus()
    draw(false, ['e1', 'e2'])
    expect(document.activeElement).toBe(grid('e2'))
  })

  it('stays where it was when no grid of the pane had it at the switch, even if one had it before', () => {
    const { draw, grid } = harness()
    draw(true, ['e2'])
    grid('e2').focus()
    // The grid goes some other way (a re-run): the focus falls to the page, and a later switch is not this grid's.
    draw(true, [])
    expect(document.activeElement).toBe(document.body)
    draw(false, ['e1', 'e2'])
    expect(document.activeElement).toBe(document.body)
  })

  it('waits for the grid to be drawn, and gives up once the user does something else', () => {
    const { draw, grid } = harness()
    draw(true, ['e2'])
    grid('e2').focus()
    draw(false, ['e1'])
    expect(document.activeElement).toBe(document.body)
    // The stack mounts the focused view's grid a frame later.
    draw(false, ['e1', 'e2'])
    return Promise.resolve().then(() => {
      expect(document.activeElement).toBe(grid('e2'))
      // A second switch, then a click elsewhere before the grid comes: the focus is the user's.
      draw(true, [])
      const other = document.createElement('button')
      document.body.append(other)
      act(() => { other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
      draw(true, ['e2'])
      return Promise.resolve().then(() => {
        expect(document.activeElement).not.toBe(grid('e2'))
        other.remove()
      })
    })
  })
})
