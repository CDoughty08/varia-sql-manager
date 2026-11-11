// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import AboutDialog from '../src/renderer/src/about/AboutDialog'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { CommandService } from '../src/renderer/src/core/commands'
import { UpdateService } from '../src/renderer/src/updates/UpdateService'
import { contextRecord } from '../src/shared/commands/context-keys'
import { windows } from '../src/renderer/src/core/windows'
import type { UpdateState } from '../src/shared/updates'
import { updatesApi } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const base = { currentVersion: '0.8.0', kind: 'nsis', enabled: true } as const
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()); vi.restoreAllMocks() })

async function mount(initial: UpdateState = { ...base, status: 'idle' }) {
  const host = document.createElement('div'), origin = document.createElement('button')
  document.body.append(origin, host)
  origin.focus()
  const api = updatesApi(initial), updates = new UpdateService(api), focusActive = vi.fn()
  const commands = new CommandService({ state: () => {
    const state = updates.getSnapshot()
    return contextRecord('win32', { updateBusy: ['checking', 'downloading', 'preparing'].includes(state.status), updateAvailable: state.status === 'available' && state.size !== undefined, updateReady: state.status === 'ready' })
  }, modalOpen: () => !!document.querySelector('[aria-modal="true"]') })
  const runs = {
    'help.checkForUpdates': vi.fn(), 'help.downloadUpdate': vi.fn(), 'help.restartToUpdate': vi.fn(),
    'help.releaseNotes': vi.fn(), 'help.openProject': vi.fn(), 'help.reportIssue': vi.fn()
  }
  for (const [id, run] of Object.entries(runs)) commands.register(id as keyof typeof runs, { run })
  const workbench = { commands, updates, platform: 'win32', documents: { focusActive }, context: { subscribe: () => () => {} } } as unknown as Workbench
  const writeClipboardText = vi.fn<(text: string) => Promise<{ ok: boolean }>>(async () => ({ ok: true })), closed = vi.fn()
  const original = Object.getOwnPropertyDescriptor(window, 'varia')
  Object.defineProperty(window, 'varia', { configurable: true, value: { writeClipboardText } })
  function Harness() {
    const [open, setOpen] = useState(true)
    return open ? createElement(AboutDialog, { onClose: () => { closed(); setOpen(false) } }) : null
  }
  const root = createRoot(host)
  await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(Harness) })) })
  cleanups.push(() => {
    act(() => { root.unmount() }); updates.dispose(); commands.dispose(); origin.remove(); host.remove()
    if (original) Object.defineProperty(window, 'varia', original)
    else Reflect.deleteProperty(window, 'varia')
  })
  const button = (label: string) => {
    const found = [...host.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
    if (!found) throw new Error(`Missing button: ${label}`)
    return found
  }
  return { host, origin, api, updates, commands, runs, button, closed, writeClipboardText }
}

describe('About dialog', () => {
  it('opens without a SQL backend, performs no update check on mount, and returns focus on Escape', async () => {
    const view = await mount()
    expect(view.host.textContent).toContain('Version 0.8.0')
    expect(view.api.checkForUpdates).not.toHaveBeenCalled()
    expect(view.runs['help.checkForUpdates']).not.toHaveBeenCalled()
    const dialog = view.host.querySelector<HTMLElement>('[role="dialog"]')!
    act(() => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(view.closed).toHaveBeenCalledTimes(1)
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(view.origin)
  })
  it('runs its own buttons through command preconditions while keeping the modal open', async () => {
    const view = await mount()
    expect(await view.commands.execute('help.checkForUpdates', undefined, 'menu')).toBe(false)
    await act(async () => { view.button('Check for Updates').click() })
    expect(view.runs['help.checkForUpdates']).toHaveBeenCalledTimes(1)
    expect(view.host.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => { view.button('Project on GitHub').click(); view.button('Report an Issue').click(); view.button('Release Notes').click() })
    expect(view.runs['help.openProject']).toHaveBeenCalledTimes(1)
    expect(view.runs['help.reportIssue']).toHaveBeenCalledTimes(1)
    expect(view.runs['help.releaseNotes']).toHaveBeenCalledTimes(1)
  })
  it('brings the originating popout forward when closing', async () => {
    const popoutDocument = document.implementation.createHTMLDocument(), raised = vi.fn(), focused = vi.fn()
    Object.defineProperty(popoutDocument, 'defaultView', { value: { closed: false, focus: raised } })
    const origin = popoutDocument.createElement('button')
    popoutDocument.body.append(origin)
    vi.spyOn(origin, 'focus').mockImplementation(focused)
    vi.spyOn(windows, 'activeElement').mockReturnValue(origin)
    const view = await mount()
    await act(async () => { view.button('Done').click() })
    expect(raised).toHaveBeenCalledTimes(1)
    expect(focused).toHaveBeenCalledTimes(1)
    expect(raised.mock.invocationCallOrder[0]).toBeLessThan(focused.mock.invocationCallOrder[0]!)
  })
  it('follows update pushes from download through preparation without offering Restart early', async () => {
    const view = await mount()
    const action = view.button('Check for Updates')
    action.focus()
    act(() => { view.api.pushUpdate({ ...base, status: 'checking', manual: true }) })
    expect(view.button('Update in progress')).toBe(action)
    expect(document.activeElement).toBe(action)
    expect(action.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { action.click() })
    expect(view.runs['help.checkForUpdates']).not.toHaveBeenCalled()
    act(() => { view.api.pushUpdate({ ...base, status: 'downloading', version: '0.9.0', received: 42, total: 100 }) })
    expect(view.host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42')
    const announcement = () => view.host.querySelector('[aria-label="Application updates"] [role="status"]')?.textContent
    const before = announcement()
    act(() => { view.api.pushUpdate({ ...base, status: 'downloading', version: '0.9.0', received: 43, total: 100 }) })
    expect(announcement()).toBe(before)
    act(() => { view.api.pushUpdate({ ...base, status: 'preparing', version: '0.9.0' }) })
    expect(view.host.textContent).toContain('Preparing update…')
    expect(() => view.button('Restart to Update')).toThrow()
    act(() => { view.api.pushUpdate({ ...base, status: 'ready', version: '0.9.0' }) })
    expect(view.button('Restart to Update').disabled).toBe(false)
    expect(document.activeElement).toBe(view.button('Restart to Update'))
  })
  it('closes before dispatching Restart, so the normal close/unsaved-work flow is not blocked', async () => {
    const view = await mount({ ...base, status: 'ready', version: '0.9.0' })
    view.runs['help.restartToUpdate'].mockImplementation(() => { expect(view.host.querySelector('[aria-modal="true"]')).toBeNull() })
    await act(async () => { view.button('Restart to Update').click() })
    expect(view.closed).toHaveBeenCalledTimes(1)
    expect(view.runs['help.restartToUpdate']).toHaveBeenCalledTimes(1)
  })
  it('copies the current support details through main and reports a refused clipboard write', async () => {
    const view = await mount()
    await act(async () => { view.button('Copy Version Details').click() })
    expect(view.writeClipboardText.mock.calls[0]?.[0]).toContain('Varia SQL Manager 0.8.0')
    expect(view.host.textContent).toContain('Details copied.')
    view.writeClipboardText.mockResolvedValueOnce({ ok: false })
    await act(async () => { view.button('Copy Version Details').click() })
    expect(view.host.textContent).toContain('The details could not be copied.')
    act(() => { view.api.pushUpdate({ ...base, status: 'upToDate', checkedAt: 1 }) })
    expect(view.host.textContent).not.toContain('Details copied.')
  })
})
