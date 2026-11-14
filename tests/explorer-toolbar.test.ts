// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { ExplorerToolbar } from '../src/renderer/src/explorer/ExplorerPane'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren() })

async function toolbar() {
  const workbench = {
    commands: { isEnabled: () => true, onDidChangeHandlers: () => ({ dispose() {} }) },
    context: { subscribe: () => () => {} },
    keybindings: { getRevision: () => 0, subscribe: () => () => {}, lookup: () => undefined }
  } as unknown as Workbench
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  cleanups.push(() => act(() => root.unmount()))
  const draw = async (offline: boolean) => act(async () => root.render(createElement(WorkbenchProvider, { workbench, children: createElement(ExplorerToolbar, { tools: [
    { id: 'connection.connect', icon: 'plug', label: 'Connect' },
    offline ? { id: 'connection.reconnect', icon: 'plug', label: 'Reconnect' } : { id: 'connection.disconnect', icon: 'debug-disconnect', label: 'Disconnect' }
  ] }) })))
  await draw(false)
  return { container, draw }
}

describe('Explorer toolbar connection lifecycle', () => {
  it('keeps the toolbar focus in its connection slot when Disconnect becomes Reconnect', async () => {
    const { container, draw } = await toolbar()
    const disconnect = container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect"]')!
    await act(async () => disconnect.focus())
    expect(document.activeElement).toBe(disconnect)
    await draw(true)
    expect(document.activeElement).toBe(container.querySelector('button[aria-label="Reconnect"]'))
    await draw(false)
    expect(document.activeElement).toBe(container.querySelector('button[aria-label="Disconnect"]'))
  })
  it('leaves focus where the user moved it while the connection state changed', async () => {
    const { container, draw } = await toolbar()
    const input = document.body.appendChild(document.createElement('input'))
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Disconnect"]')!.focus(); input.focus() })
    await draw(true)
    expect(document.activeElement).toBe(input)
  })
})
