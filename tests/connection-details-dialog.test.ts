// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ConnectionDetailsDialog from '../src/renderer/src/ConnectionDetailsDialog'
import { connectionDetailsSchema, type ConnectionDetails } from '../src/shared/connection-targets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()) })
async function mount(current: ConnectionDetails, selected: ConnectionDetails) {
  const origin = document.createElement('button'), host = document.createElement('div')
  document.body.append(origin, host)
  origin.focus()
  const chosen = vi.fn(), root = createRoot(host)
  function Harness() {
    const [open, setOpen] = useState(true)
    return open ? createElement(ConnectionDetailsDialog, { current, selected, server: 'sql.example', database: 'Sales', account: 'reader', onChoose: choice => { chosen(choice); setOpen(false) } }) : null
  }
  await act(async () => { root.render(createElement(Harness)) })
  cleanups.push(() => { act(() => root.unmount()); origin.remove(); host.remove() })
  return { origin, host, chosen }
}
const current = connectionDetailsSchema.parse({ displayName: 'Current name', environment: 'Production', color: '#336699' })
describe('connection details confirmation', () => {
  it('shows only changed fields with common destination/account and explicit effects', async () => {
    const view = await mount(current, { ...current, displayName: 'Selected name', autoReconnect: 'off' })
    expect(view.host.querySelector('h2')?.textContent).toBe('Use selected connection details?')
    expect([...view.host.querySelectorAll('tbody th')].map(cell => cell.textContent)).toEqual(['Name', 'Startup reconnect'])
    expect(view.host.textContent).toContain('sql.example · Sales · reader')
    expect(view.host.textContent).toContain('attached query badges')
    expect(view.host.textContent).toContain('explicit Disconnect stays respected')
    expect(view.chosen).not.toHaveBeenCalled()
    expect(document.activeElement?.textContent).toBe('Use Selected Details')
  })
  it.each([['Use Selected Details', 'selected'], ['Keep Current Details', 'current'], ['Cancel', 'cancel']] as const)('returns %s without submitting the connection picker', async (button, choice) => {
    const view = await mount(current, { ...current, environment: 'Staging' })
    act(() => { [...view.host.querySelectorAll('button')].find(value => value.textContent === button)!.click() })
    expect(view.chosen).toHaveBeenCalledExactlyOnceWith(choice)
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(view.origin)
  })
  it('Escape cancels and traps tab focus inside the review', async () => {
    const view = await mount(current, { ...current, color: '#abcdef' })
    const dialog = view.host.querySelector<HTMLElement>('[role="dialog"]')!
    act(() => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(view.chosen).toHaveBeenCalledExactlyOnceWith('cancel')
    expect(document.activeElement).toBe(view.origin)
  })
  it('removes the picker inert state before returning focus on Cancel', async () => {
    const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
    let show!: () => void
    function Harness() {
      const [open, setOpen] = useState(false)
      show = () => setOpen(true)
      return createElement('div', null,
        createElement('button', { inert: open }, 'Picker'),
        open ? createElement(ConnectionDetailsDialog, { current, selected: { ...current, autoReconnect: 'off' }, server: 'sql.example', database: 'Sales', onChoose: () => setOpen(false) }) : null)
    }
    await act(async () => root.render(createElement(Harness)))
    cleanups.push(() => { act(() => root.unmount()); host.remove() })
    const picker = host.querySelector<HTMLButtonElement>('button')!
    picker.focus()
    await act(async () => show())
    expect(picker.inert).toBe(true)
    const inertOnFocus: boolean[] = [], focus = picker.focus.bind(picker)
    picker.focus = options => { inertOnFocus.push(picker.inert); focus(options) }
    act(() => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click() })
    expect(inertOnFocus).toEqual([false])
    expect(document.activeElement).toBe(picker)
  })
})
