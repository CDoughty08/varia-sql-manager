// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { PinnedServerRow } from '../src/renderer/src/explorer/ExplorerRow'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); document.body.replaceChildren() })

async function pinned(edge: 'top' | 'bottom', overflow = false) {
  const workbench = workbenchFixture(), host = document.body.appendChild(document.createElement('div'))
  workbench.api.push(readyBackend())
  const attempt = workbench.connections.beginConnect(connectionOptions, 1)!
  const info = connectionInfo(crypto.randomUUID())
  const authentication = { principal: { provider: 'sqlServer' as const, authentication: 'sql' as const, id: 'sid:fixture' } }
  workbench.connections.accept(info, connectionOptions, attempt.operation.targetId, authentication, attempt)
  const node = workbench.explorer.settle().rows.nodes.find(node => node?.parent === 0)!
  workbench.connect(connectionInfo('another-server'))
  workbench.explorer.select(workbench.explorer.settle().rows.nodes.find(value => value?.parent === 0 && value.id !== node.id)!.id)
  const invoker = document.body.appendChild(document.createElement('button'))
  invoker.setAttribute('popovertarget', `more:${edge}`)
  const dismiss = vi.fn()
  if (overflow) { host.id = `more:${edge}`; host.setAttribute('popover', 'auto'); host.hidePopover = dismiss }
  const theme = { ...workbench.theme, getSnapshot: () => workbench.theme.state, subscribe: () => () => {}, accent: () => undefined }
  const renderer = { ...workbench, theme } as unknown as Workbench, root = createRoot(host), jump = vi.fn()
  await act(async () => root.render(createElement(WorkbenchProvider, { workbench: renderer,
    children: createElement(PinnedServerRow, { node, edge, current: false, active: false, color: undefined, menu: overflow, jump }) })))
  cleanups.push(() => { act(() => root.unmount()); workbench.dispose() })
  const button = host.querySelector<HTMLButtonElement>('button')!, label = button.querySelector('.oe-label')!
  return { workbench, button, label, node, invoker, dismiss, jump, targetId: attempt.operation.targetId }
}

describe('pinned Explorer node menus', () => {
  it.each(['top', 'bottom'] as const)('gives a %s shortcut its canonical full menu without jumping or changing selection', async edge => {
    const { workbench, button, label, node, jump } = await pinned(edge)
    const selected = workbench.explorer.getSnapshot().selected
    const hit = workbench.menuTargets.targetFor(label)!
    expect(hit.target).toEqual({ kind: 'explorer', node: workbench.explorer.menuNode(node.id) })
    expect(hit.focus).toBe(button)
    const expected = workbench.menus.resolve('explorer.context', { kind: 'explorer', node: workbench.explorer.menuNode(node.id)! })
    expect(workbench.menus.resolve('explorer.context', hit.target)).toEqual(expected)
    expect(expected).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'command', id: 'connection.disconnect', enabled: true }),
      expect.objectContaining({ kind: 'command', id: 'connection.disconnectAndRemove', enabled: true })
    ]))
    expect(workbench.menus.openForElement(button, { keyboard: true })).toBe(true)
    expect(workbench.menus.controller.view.levels[0].items).toEqual(expected)
    expect(workbench.explorer.getSnapshot().selected).toBe(selected)
    expect(jump).not.toHaveBeenCalled()
  })

  it.each(['top', 'bottom'] as const)('dismisses the %s overflow before its full context menu and restores its invoker', async edge => {
    const { workbench, button, label, invoker, dismiss, jump } = await pinned(edge, true)
    const hit = workbench.menuTargets.targetFor(label)!
    expect(dismiss).toHaveBeenCalledOnce()
    expect(hit.target.kind).toBe('explorer')
    expect(hit.focus).toBe(invoker)
    expect(workbench.menus.openForElement(button, { keyboard: true })).toBe(true)
    expect(document.activeElement).toBe(invoker)
    expect(jump).not.toHaveBeenCalled()
  })

  it('reads current connection state when the menu opens instead of using the shortcut render snapshot', async () => {
    const { workbench, label, node } = await pinned('top')
    await act(async () => workbench.connections.markLostBefore(2))
    const hit = workbench.menuTargets.targetFor(label)!
    expect(hit.target).toMatchObject({ kind: 'explorer', node: { id: node.id, lost: true } })
    expect(workbench.menus.resolve('explorer.context', hit.target)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'command', id: 'connection.reconnect', enabled: true }),
      expect.objectContaining({ kind: 'command', id: 'connection.removeFromExplorer', enabled: true })
    ]))
  })

  it('keeps canonical enabled and checked states through disconnect and reconnect transitions', async () => {
    const { workbench, label, node, targetId } = await pinned('bottom')
    const parity = () => {
      const hit = workbench.menuTargets.targetFor(label)!
      expect(hit.target).toEqual({ kind: 'explorer', node: workbench.explorer.menuNode(node.id) })
      const menu = workbench.menus.resolve('explorer.context', hit.target)
      expect(menu).toEqual(workbench.menus.resolve('explorer.context', { kind: 'explorer', node: workbench.explorer.menuNode(node.id)! }))
      return menu
    }
    parity()
    let operation: ReturnType<typeof workbench.connectionTargets.beginDisconnect>
    await act(async () => { operation = workbench.connectionTargets.beginDisconnect(targetId, crypto.randomUUID()) })
    expect(operation!).toBeDefined()
    expect(parity()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'connection.reconnect', enabled: false }),
      expect.objectContaining({ id: 'connection.removeFromExplorer', enabled: false })
    ]))
    await act(async () => { workbench.connectionTargets.completeDisconnect(operation!) })
    expect(parity()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'connection.reconnect', enabled: true })]))
    await act(async () => { workbench.connectionTargets.beginConnect(targetId, 1, crypto.randomUUID()) })
    expect(parity()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'connection.reconnect', enabled: false })]))
  })
})
