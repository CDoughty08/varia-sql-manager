// @vitest-environment happy-dom
import { act, createElement, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TabRenameBox from '../src/renderer/src/TabRenameBox'
import { TabRenameService } from '../src/renderer/src/services/tab-rename'
import { documentFixture } from './fixtures/documents'

const cleanups: (() => void)[] = []
let frames: FrameRequestCallback[]
beforeEach(() => {
  frames = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
})
afterEach(async () => {
  await act(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
  vi.unstubAllGlobals()
})

async function fixture() {
  const { documents } = documentFixture()
  const query = documents.create('Welcome', '', 'master'), service = new TabRenameService(documents)
  const host = document.createElement('div'), other = document.createElement('div')
  other.className = 'dv-tab'; other.tabIndex = 0; other.dataset.tabPanelId = 'orders'
  other.textContent = 'orders.sql'
  document.body.append(host, other)
  const root: Root = createRoot(host)
  function Host() {
    const renaming = useSyncExternalStore(service.subscribe, service.getSnapshot)
    return createElement('div', { className: 'dv-tab', tabIndex: 0, 'data-tab-panel-id': query.id },
      renaming.id ? createElement(TabRenameBox, { tabId: query.id, name: query.name, service }) : query.name)
  }
  await act(() => { root.render(createElement(Host)); service.start(query.id) })
  cleanups.push(() => { root.unmount(); host.remove(); other.remove(); documents.dispose() })
  const input = host.querySelector<HTMLInputElement>('input')!
  expect(document.activeElement).toBe(input)
  const press = async (key: 'Enter' | 'Escape') => {
    input.value = 'Renamed'
    await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    expect(host.querySelector('input')).toBeNull()
  }
  const draw = async () => { await act(() => { frames.splice(0).forEach(callback => callback(0)) }) }
  return { documents, query, service, host, other, press, draw }
}

describe('inline tab rename focus', () => {
  it.each(['Enter', 'Escape'] as const)('returns focus to its tab after %s when no newer target took focus', async key => {
    const { documents, query, host, press, draw } = await fixture()
    await press(key)
    await draw()
    expect(document.activeElement).toBe(host.querySelector('.dv-tab'))
    expect(documents.get(query.id)?.name).toBe(key === 'Enter' ? 'Renamed' : 'Welcome')
  })
  it.each(['Enter', 'Escape'] as const)('does not steal focus from another tab reached before the %s refocus frame', async key => {
    const { other, press, draw } = await fixture()
    await press(key)
    other.focus()
    await draw()
    expect(document.activeElement).toBe(other)
  })
  it.each(['input', 'button'] as const)('does not steal focus from a newly focused %s after another tab is reached', async tag => {
    const { other, press, draw } = await fixture()
    await press('Enter')
    other.focus()
    const next = document.createElement(tag)
    if (tag === 'button') next.setAttribute('role', 'menuitem')
    other.append(next)
    next.focus()
    await draw()
    expect(document.activeElement).toBe(next)
  })
})
