// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DialogFooter from '../src/renderer/src/kit/DialogFooter'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

function mount(element: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(element) })
  cleanup = () => {
    act(() => { root.unmount() })
    host.remove()
  }
  return {
    host,
    rerender(next: React.ReactElement) {
      act(() => { root.render(next) })
    }
  }
}

describe('DialogFooter', () => {
  it('renders leading, status and trailing slots inside .connection-footer.dialog-footer', () => {
    const { host } = mount(
      createElement(DialogFooter, {
        leading: createElement('button', { type: 'button' }, 'Reset Page'),
        status: createElement('span', null, '1 setting pending'),
        trailing: createElement(
          Fragment,
          null,
          createElement('button', { type: 'button' }, 'Apply'),
          createElement('button', { type: 'submit' }, 'OK'),
          createElement('button', { type: 'button' }, 'Cancel')
        )
      })
    )
    const footer = host.querySelector('.connection-footer.dialog-footer')
    expect(footer).not.toBeNull()
    expect(footer?.textContent).toContain('Reset Page')
    expect(footer?.textContent).toContain('1 setting pending')
    expect([...footer!.querySelectorAll('button')].map(btn => btn.textContent)).toEqual(['Reset Page', 'Apply', 'OK', 'Cancel'])
  })

  it('replaces footer actions in-place and auto-focuses Keep Editing during confirmation', () => {
    const onKeep = vi.fn(), onDiscard = vi.fn()
    const trailing = createElement(
      Fragment,
      null,
      createElement('button', { type: 'button' }, 'Apply'),
      createElement('button', { type: 'submit' }, 'OK'),
      createElement('button', { type: 'button' }, 'Cancel')
    )
    const view = mount(
      createElement(DialogFooter, {
        leading: createElement('button', { type: 'button' }, 'Reset Page'),
        trailing
      })
    )
    expect(view.host.querySelectorAll('button')).toHaveLength(4)

    view.rerender(
      createElement(DialogFooter, {
        leading: createElement('button', { type: 'button' }, 'Reset Page'),
        trailing,
        confirm: { message: 'You have 2 unsaved changes. Discard changes?', onKeep, onDiscard }
      })
    )

    const footer = view.host.querySelector('.connection-footer.dialog-footer.is-confirming')
    expect(footer?.getAttribute('role')).toBe('alert')
    expect(footer?.textContent).toContain('You have 2 unsaved changes. Discard changes?')
    const buttons = [...view.host.querySelectorAll('button')]
    expect(buttons.map(btn => btn.textContent)).toEqual(['Keep Editing', 'Discard Changes'])
    expect(document.activeElement).toBe(buttons[0])

    buttons[0].click()
    buttons[1].click()
    expect(onKeep).toHaveBeenCalledTimes(1)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })
})
