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

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const connectionId = '00000000-0000-4000-8000-000000000001'
const root = { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' } as const
const rootNode = { id: 7, connectionId, ref: { type: 'object', object: root }, kind: 'table', label: 'dbo.Orders', lost: false } as ExplorerMenuNode
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()) })

async function mount(answer: () => Promise<ApiResult<DependenciesResult>>) {
  const connections = { list: [{ id: connectionId, lost: false }], listeners: [] as (() => void)[] }
  const live = { getSnapshot: () => connections.list, subscribe: (listener: () => void) => { connections.listeners.push(listener); return () => {} } }
  const api = { explorerDependencies: vi.fn(answer), explorerCancel: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })) }
  const select = vi.fn(), reveal = vi.fn()
  const dependencies = new DependenciesService({ api: api as never, connections: live as never, reveal, peek: vi.fn(), explorer: { menuNode: id => id === 7 ? rootNode : undefined, select, objectNode: vi.fn() as never } })
  const host = document.createElement('div')
  document.body.append(host)
  const view = createRoot(host)
  await act(async () => { view.render(createElement(WorkbenchProvider, { workbench: { dependencies } as unknown as Workbench, children: createElement(DependenciesDialog) })) })
  cleanups.push(() => { act(() => view.unmount()); host.remove(); dependencies.dispose() })
  const lose = () => act(() => { connections.list = [{ id: connectionId, lost: true }]; for (const listener of connections.listeners) listener() })
  return { dependencies, api, select, reveal, lose }
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
})
