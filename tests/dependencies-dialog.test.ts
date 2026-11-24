// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import DependenciesDialog from '../src/renderer/src/explorer/DependenciesDialog'
import { DependenciesService } from '../src/renderer/src/explorer/DependenciesService'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ApiResult } from '../src/shared/contracts'
import type { DependenciesResult } from '../src/shared/explorer/dependencies'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import type { ConnectionLifecycle } from '../src/shared/connection-targets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const connectionId = '00000000-0000-4000-8000-000000000001'
const root = { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' } as const
const rootNode = { id: 7, connectionId, ref: { type: 'object', object: root }, kind: 'table', label: 'dbo.Orders', lost: false } as ExplorerMenuNode
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()) })

async function mount(answer: () => Promise<ApiResult<DependenciesResult>>) {
  const connected = { state: 'connected', handle: { id: connectionId, generation: 1 } } as const
  const connections = { list: [{ id: connectionId, lost: false, lifecycle: connected }] as { id: string; lost: boolean; lifecycle: ConnectionLifecycle }[], listeners: [] as (() => void)[] }
  const live = { getSnapshot: () => connections.list, subscribe: (listener: () => void) => { connections.listeners.push(listener); return () => {} } }
  const api = { explorerDependencies: vi.fn(answer), explorerCancel: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })) }
  const select = vi.fn(), reveal = vi.fn()
  const dependencies = new DependenciesService({ api: api as never, connections: live as never, reveal, peek: vi.fn(), explorer: { menuNode: id => id === 7 ? rootNode : undefined, select, objectNode: vi.fn() as never } })
  const host = document.createElement('div')
  document.body.append(host)
  const view = createRoot(host)
  await act(async () => { view.render(createElement(WorkbenchProvider, { workbench: { dependencies } as unknown as Workbench, children: createElement(DependenciesDialog) })) })
  cleanups.push(() => { act(() => view.unmount()); host.remove(); dependencies.dispose() })
  const change = (lifecycle: ConnectionLifecycle, lost = false) => act(() => { connections.list = [{ id: connectionId, lost, lifecycle }]; for (const listener of connections.listeners) listener() })
  const lose = () => change({ state: 'lost', reason: 'backend-lost' }, true)
  const disconnect = () => change({ state: 'disconnecting', attemptId: 'attempt', handle: connected.handle })
  const rollback = () => change(connected)
  return { dependencies, api, select, reveal, lose, disconnect, rollback }
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const key = (target: Element, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })

describe('View Dependencies dialog', () => {
  it('lets Enter on a failed level’s Retry retry it, not reveal the selection, and keeps focus in the dialog after a click', async () => {
    const failed: ApiResult<DependenciesResult> = { ok: true, value: { items: [], elapsedMs: 1, error: { code: 'TIMEOUT', message: 'Too slow.', retryable: true } } }
    const { dependencies, api, select } = await mount(() => Promise.resolve(failed))
    await act(async () => { dependencies.open(rootNode) })
    await settle()
    const retry = [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')!
    retry.focus()
    await key(retry, 'Enter')
    // The tree's own Enter would have revealed the root (selecting it in Object Explorer) and closed the dialog.
    expect(select).not.toHaveBeenCalled()
    expect(dependencies.current).toBeDefined()
    // Enter's default action clicks the focused button; happy-dom does not, so click it as the browser would.
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click() })
    expect(api.explorerDependencies).toHaveBeenCalledTimes(2)
    expect(document.activeElement?.getAttribute('role')).toBe('tree')
    await settle()
    const tree = document.querySelector('[role="tree"]')!
    await key(tree, 'Enter')
    expect(select).toHaveBeenCalledWith(7, { reveal: true })
  })

  it('keeps the choice and the focus on a radio once the server is lost', async () => {
    const { dependencies, lose } = await mount(() => Promise.resolve({ ok: true, value: { items: [], elapsedMs: 1 } }))
    await act(async () => { dependencies.open(rootNode) })
    await settle()
    const [usedBy, uses] = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    usedBy!.focus()
    await lose()
    expect(usedBy!.disabled).toBe(false)
    expect(usedBy!.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(usedBy)
    await act(async () => { uses!.click() })
    expect(dependencies.current?.direction).toBe('usedBy')
    expect(usedBy!.checked).toBe(true)
  })

  it('keeps radio focus while disconnecting and restores actions without reloading on exact-owner rollback', async () => {
    const { dependencies, api, disconnect, rollback } = await mount(() => Promise.resolve({ ok: true, value: { items: [], elapsedMs: 1 } }))
    await act(async () => { dependencies.open(rootNode) })
    await settle()
    const [usedBy, uses] = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    usedBy!.focus()
    await disconnect()
    expect(usedBy!.disabled).toBe(false)
    expect(usedBy!.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(usedBy)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('The server is disconnecting. Dependency reads are paused.')
    await act(async () => { uses!.click() })
    expect(dependencies.current?.direction).toBe('usedBy')
    expect(api.explorerDependencies).toHaveBeenCalledTimes(1)
    expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Peek')?.disabled).toBe(true)
    await rollback()
    expect(document.activeElement).toBe(usedBy)
    expect(usedBy!.getAttribute('aria-disabled')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Peek')?.disabled).toBe(false)
    expect(api.explorerDependencies).toHaveBeenCalledTimes(1)
    await act(async () => { uses!.click() })
    expect(dependencies.current?.direction).toBe('uses')
    expect(api.explorerDependencies).toHaveBeenCalledTimes(2)
  })

  it('renders selected object facts in a compact FactGrid with click-to-copy and polite status announcement', async () => {
    const writeClipboardText = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const prevVaria = (window as { varia?: unknown }).varia
    ;(window as { varia?: unknown }).varia = { writeClipboardText }
    cleanups.push(() => { (window as { varia?: unknown }).varia = prevVaria })
    const { dependencies } = await mount(() => Promise.resolve({ ok: true, value: { items: [], elapsedMs: 1 } }))
    await act(async () => { dependencies.open(rootNode) })
    await settle()
    const region = document.querySelector('section[aria-label="Selected object"]')!
    expect(region.querySelector('dl.fact-grid.compact')).not.toBeNull()
    const copyName = region.querySelector<HTMLButtonElement>('button[aria-label="Copy Name"]')!
    expect(copyName).not.toBeNull()
    // Root node has no dependencyType, so its copy button is suppressed while Name and Type remain copyable.
    expect(region.querySelector('button[aria-label="Copy Dependency type"]')).toBeNull()
    await act(async () => { copyName.click() })
    await settle()
    expect(writeClipboardText).toHaveBeenCalledWith('dbo.Orders')
    expect(region.querySelector('[role="status"]')?.textContent).toMatch(/^Copied Name/)
  })
})
