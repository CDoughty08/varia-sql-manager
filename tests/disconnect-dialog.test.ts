// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import DisconnectDialog from '../src/renderer/src/disconnect/DisconnectDialog'
import { DisconnectPromptService, type DisconnectPromptRequest } from '../src/renderer/src/disconnect/DisconnectPromptService'
import { windows } from '../src/renderer/src/core/windows'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const request: DisconnectPromptRequest = { targetId: 'target-a', name: 'Production', tabs: [
  { id: 'query-a', name: 'Deployment.sql', dirty: true, running: false },
  { id: 'query-b', name: 'Report.sql', dirty: false, running: true }
] }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()); vi.restoreAllMocks() })

async function mount() {
  const service = new DisconnectPromptService(), host = document.createElement('div'), origin = document.createElement('button')
  document.body.append(origin, host)
  origin.focus()
  const root = createRoot(host)
  await act(async () => { root.render(createElement(DisconnectDialog, { service })) })
  let result!: ReturnType<DisconnectPromptService['request']>
  await act(async () => { result = service.request(request) })
  cleanups.push(() => { act(() => { service.dispose(); root.unmount() }); origin.remove(); host.remove() })
  const dialog = () => document.querySelector<HTMLDivElement>('[role="dialog"]')!
  const button = (name: string) => [...dialog().querySelectorAll('button')].find(item => item.textContent === name)!
  const press = (key: string, target: HTMLElement = dialog(), shiftKey = false) => act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
  })
  return { service, origin, result, dialog, button, press }
}

describe('disconnect prompt service', () => {
  it('serializes immutable requests and rejects a stale dialog answer', async () => {
    const service = new DisconnectPromptService()
    const first = service.request(request), initial = service.getSnapshot()!
    const second = service.request({ ...request, targetId: 'target-b', name: 'Development' })
    expect(service.getSnapshot()).toBe(initial)
    expect(Object.isFrozen(initial.tabs[0])).toBe(true)
    expect(service.answer(initial.promptId, 'keep-tabs')).toBe(true)
    expect(await first).toBe('keep-tabs')
    const next = service.getSnapshot()!
    expect(next.name).toBe('Development')
    expect(service.answer(initial.promptId, 'close-query-tabs')).toBe(false)
    expect(service.getSnapshot()).toBe(next)
    service.answer(next.promptId, 'cancel')
    expect(await second).toBe('cancel')
    service.dispose()
  })
  it('resolves active, queued and later requests to Cancel when disposed', async () => {
    const service = new DisconnectPromptService()
    const first = service.request(request), second = service.request(request)
    service.dispose()
    expect(service.getSnapshot()).toBeUndefined()
    expect(await Promise.all([first, second, service.request(request)])).toEqual(['cancel', 'cancel', 'cancel'])
  })
})

describe('disconnect dialog', () => {
  it('names affected tabs and explains unsaved work, sessions, retained results and cancellation uncertainty', async () => {
    const view = await mount(), text = view.dialog().textContent!
    expect(text).toContain('Deployment.sql — unsaved changes')
    expect(text).toContain('Report.sql — running')
    expect(text).toContain('each tab’s database, connection target and completed results')
    expect(text).toContain('previous SQL session')
    expect(text).toContain('Custom-document drafts stay open')
    expect(text).toContain('Transactions are never committed automatically')
    expect(text).toContain('outcome unknown')
    expect(text).toContain('completed statements may already have taken effect')
  })
  it.each(['Escape', 'Enter'])('focuses Cancel, cancels safely on %s and restores origin focus', async key => {
    const view = await mount()
    expect(document.activeElement).toBe(view.button('Cancel'))
    view.press(key)
    expect(await view.result).toBe('cancel')
    expect(view.dialog()).toBeNull()
    expect(document.activeElement).toBe(view.origin)
  })
  it.each([
    ['Disconnect and Keep Tabs', 'keep-tabs'], ['Disconnect and Close Query Tabs', 'close-query-tabs']
  ] as const)('returns the explicit %s choice', async (label, answer) => {
    const view = await mount()
    await act(async () => { view.button(label).click() })
    expect(await view.result).toBe(answer)
    expect(view.dialog()).toBeNull()
  })
  it('traps keyboard focus among its three choices', async () => {
    const view = await mount()
    for (const button of view.dialog().querySelectorAll('button')) vi.spyOn(button, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    view.press('Tab', view.button('Cancel'))
    expect(document.activeElement).toBe(view.button('Disconnect and Keep Tabs'))
    view.press('Tab', view.button('Disconnect and Keep Tabs'), true)
    expect(document.activeElement).toBe(view.button('Cancel'))
  })
  it('keeps Cancel focused for the next queued prompt and returns to the original focus after both', async () => {
    const view = await mount()
    let next!: ReturnType<DisconnectPromptService['request']>
    await act(async () => { next = view.service.request({ ...request, name: 'Development' }); view.button('Cancel').click() })
    expect(view.dialog().textContent).toContain('Disconnect Development?')
    expect(document.activeElement).toBe(view.button('Cancel'))
    await act(async () => { view.button('Cancel').click() })
    expect(await next).toBe('cancel')
    expect(document.activeElement).toBe(view.origin)
  })
  it('brings the originating popout forward before returning focus', async () => {
    const popout = document.implementation.createHTMLDocument(), raised = vi.fn(), focused = vi.fn()
    Object.defineProperty(popout, 'defaultView', { value: { closed: false, focus: raised } })
    const origin = popout.createElement('button')
    popout.body.append(origin)
    vi.spyOn(origin, 'focus').mockImplementation(focused)
    vi.spyOn(windows, 'activeElement').mockReturnValue(origin)
    const view = await mount()
    await act(async () => { view.button('Cancel').click() })
    expect(raised).toHaveBeenCalledTimes(1)
    expect(focused).toHaveBeenCalledTimes(1)
    expect(raised.mock.invocationCallOrder[0]).toBeLessThan(focused.mock.invocationCallOrder[0]!)
  })
})
