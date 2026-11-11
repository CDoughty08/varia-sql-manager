// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchProvider, useServiceSnapshot, useWorkbench } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import HelpDocument from '../src/renderer/src/help/HelpDocument'
import { ResultsSample } from '../src/renderer/src/help/Samples'
import * as frames from '../src/renderer/src/core/frame'
import { DocumentSections } from '../src/renderer/src/kit/DocumentFrame'
import { initialFrameState } from '../src/renderer/src/kit/document-frame'
import { workbenchFixture } from './fixtures/workbench'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const chunks = vi.hoisted(() => {
  const deferred = () => {
    let resolve!: (module: Record<string, unknown>) => void, reject!: (error: Error) => void
    const promise = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  return { connect: deferred(), query: deferred(), results: deferred() }
})
vi.mock('../src/renderer/src/help/guides/connect.tsx', () => chunks.connect.promise)
vi.mock('../src/renderer/src/help/guides/run-query.tsx', () => chunks.query.promise)
vi.mock('../src/renderer/src/help/guides/results.tsx', () => chunks.results.promise)

function HelpHost() {
  const { help, documents } = useWorkbench(), { documentId } = useServiceSnapshot(help), { activeId } = useServiceSnapshot(documents)
  return documentId && activeId === documentId ? createElement(HelpDocument, { documentId }) : null
}

async function mount(child: ReactNode = createElement(HelpHost)) {
  const focusRequests: string[] = [], caught: unknown[] = []
  const fixture = workbenchFixture({ helpFocus: id => focusRequests.push(id) })
  const host = document.createElement('div'), other = document.createElement('input')
  other.setAttribute('aria-label', 'Another workbench input')
  document.body.append(host, other)
  const root = createRoot(host, { onCaughtError: error => caught.push(error) })
  await act(async () => { root.render(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: child })) })
  const flushFocus = () => {
    for (const id of focusRequests.splice(0)) if (fixture.documents.getSnapshot().activeId === id)
      host.querySelector<HTMLElement>('[data-help-focus]')?.focus()
  }
  const open = async (id?: string) => { await act(async () => fixture.help.open(id)); flushFocus() }
  const dispose = () => { act(() => root.unmount()); fixture.dispose(); host.remove(); other.remove() }
  return { fixture, host, other, caught, open, flushFocus, dispose }
}

describe('guide loading and focus ownership', () => {
  it('keeps the header mounted and leaves user focus alone when a delayed guide arrives', async () => {
    const view = await mount()
    try {
      await view.open('connect')
      const heading = view.host.querySelector('h1'), back = view.host.querySelector<HTMLButtonElement>('[data-help-focus]')!
      expect(heading?.textContent).toBe('Connect to SQL Server')
      expect(view.host.querySelector('[role="status"]')?.textContent).toContain('Opening guide')
      expect(document.activeElement).toBe(back)
      view.other.focus()
      const page = await vi.importActual<Record<string, unknown>>('../src/renderer/src/help/guides/connect.tsx')
      await act(async () => { chunks.connect.resolve(page); await vi.dynamicImportSettled() })
      view.flushFocus()
      expect(view.host.textContent).toContain('Before you connect')
      expect(view.host.querySelector('h1')).toBe(heading)
      expect(view.host.querySelector('[data-help-focus]')).toBe(back)
      expect(document.activeElement).toBe(view.other)
      expect(view.caught).toEqual([])
    } finally { view.dispose() }
  })
  it('preserves the focused recovery control and document region when a guide chunk fails', async () => {
    const view = await mount()
    try {
      await view.open('run-query')
      const back = view.host.querySelector<HTMLButtonElement>('[data-help-focus]')!, region = back.closest('[data-help-document]')
      expect(document.activeElement).toBe(back)
      await act(async () => { chunks.query.reject(new Error('Missing guide chunk')); await vi.dynamicImportSettled() })
      view.flushFocus()
      expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('This guide could not be opened')
      expect(back.closest('[data-help-document]')).toBe(region)
      expect(view.host.querySelector('[data-help-focus]')).toBe(back)
      expect(document.activeElement).toBe(back)
      expect(view.caught).toHaveLength(1)
      await act(async () => back.click())
      view.flushFocus()
      expect(view.host.querySelector('h1')?.textContent).toBe('Getting Started')
      expect(document.activeElement).toBe(view.host.querySelector('input[type="search"]'))
      await view.open('run-query')
      expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Restart Varia to try loading this guide again.')
      expect(document.activeElement).toBe(view.host.querySelector('[data-help-focus]'))
    } finally { view.dispose() }
  })
  it('ignores a guide completing after its document was closed', async () => {
    const view = await mount()
    try {
      await view.open('results')
      const id = view.fixture.help.getSnapshot().documentId!
      await act(async () => view.fixture.documents.close(id))
      view.other.focus()
      const page = await vi.importActual<Record<string, unknown>>('../src/renderer/src/help/guides/results.tsx')
      await act(async () => { chunks.results.resolve(page); await vi.dynamicImportSettled() })
      view.flushFocus()
      expect(view.host.childElementCount).toBe(0)
      expect(document.activeElement).toBe(view.other)
      expect(view.fixture.help.getSnapshot().documentId).toBeUndefined()
      expect(view.caught).toEqual([])
    } finally { view.dispose() }
  })
  it('restores home focus and the search when its tab is shown again', async () => {
    const view = await mount()
    try {
      await view.open()
      const { documentId } = view.fixture.help.getSnapshot()
      await act(async () => view.fixture.help.search('connect'))
      await act(async () => view.fixture.documents.newQuery())
      view.other.focus()
      expect(view.host.childElementCount).toBe(0)
      await act(async () => view.fixture.documents.activate(documentId!))
      view.flushFocus()
      expect(document.activeElement).toBe(view.host.querySelector('[data-help-focus]'))
      expect(view.host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('connect')
      expect(view.caught).toEqual([])
    } finally { view.dispose() }
  })
})

it('does not overwrite the reading position when a queued scroll runs after the tab is hidden', async () => {
  let pending: (() => void) | undefined, visible = true
  const clock = vi.spyOn(frames, 'nextFrame').mockImplementation(callback => { pending = callback; return () => { pending = undefined } })
  const sections = ['first', 'current', 'last'].map(id => ({ id, title: id, content: id })), onFrame = vi.fn()
  const view = await mount(createElement(DocumentSections, { id: 'queued-scroll', title: 'Guide', sections, frame: { ...initialFrameState(sections), section: 'current' }, onFrame }))
  try {
    const column = view.host.querySelector<HTMLElement>('[aria-label="Guide sections"]')!
    Object.defineProperties(column, { clientHeight: { get: () => visible ? 100 : 0 }, scrollHeight: { get: () => visible ? 300 : 0 } })
    column.querySelectorAll('section').forEach((section, index) => Object.defineProperty(section, 'offsetTop', { get: () => visible ? index * 100 : 0 }))
    await act(async () => column.dispatchEvent(new Event('scroll')))
    expect(pending).toBeTypeOf('function')
    visible = false
    act(() => pending?.())
    expect(onFrame).not.toHaveBeenCalled()
    visible = true
    await act(async () => column.dispatchEvent(new Event('scroll')))
    act(() => pending?.())
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ section: 'first' }))
  } finally { view.dispose(); clock.mockRestore() }
})

it('keeps a restored section current as the tab finishes laying out, until the user scrolls elsewhere', async () => {
  let pending: (() => void) | undefined, height = 320
  const clock = vi.spyOn(frames, 'nextFrame').mockImplementation(callback => { pending = callback; return () => { pending = undefined } })
  const sections = ['browse', 'select', 'limits', 'related'].map(id => ({ id, title: id, content: id })), onFrame = vi.fn()
  const view = await mount(createElement(DocumentSections, { id: 'restored-scroll', title: 'Guide', sections, frame: { ...initialFrameState(sections), section: 'limits' }, onFrame }))
  try {
    const column = view.host.querySelector<HTMLElement>('[aria-label="Guide sections"]')!
    Object.defineProperties(column, { clientHeight: { get: () => height }, scrollHeight: { get: () => 1187 } })
    column.querySelectorAll('section').forEach((section, index) => Object.defineProperty(section, 'offsetTop', { get: () => [0, 538, 847, 1006][index] }))
    const scroll = async (top: number, user = false) => {
      if (user) await act(async () => column.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: top - column.scrollTop })))
      column.scrollTop = top
      await act(async () => column.dispatchEvent(new Event('scroll')))
      act(() => pending?.())
    }
    await scroll(847)
    height = 356
    await scroll(831)
    expect(onFrame).toHaveBeenLastCalledWith(expect.objectContaining({ section: 'limits' }))
    await scroll(538, true)
    expect(onFrame).toHaveBeenLastCalledWith(expect.objectContaining({ section: 'select' }))
    await scroll(831, true)
    expect(onFrame).toHaveBeenLastCalledWith(expect.objectContaining({ section: 'related' }))
  } finally { view.dispose(); clock.mockRestore() }
})

it.each([
  ['clicked', 'wheel'], ['restored', 'wheel'], ['restored', 'keyboard'], ['restored', 'nested-keyboard'], ['restored', 'tab'],
  ['restored', 'scrollbar'], ['restored', 'touch'], ['restored', 'middle-autoscroll'], ['restored', 'text-drag'], ['restored', 'section-list-tab']
] as const)('marks the last section after %s navigation and %s scrolling directly to the end', async (mode, input) => {
  let pending: (() => void) | undefined
  const clock = vi.spyOn(frames, 'nextFrame').mockImplementation(callback => { pending = callback; return () => { pending = undefined } })
  const sections = ['A', 'B', 'C', 'D'].map(id => ({ id, title: id, content: createElement('div', null, createElement('button', { type: 'button' }, id), createElement('span', null, `Text ${id}`)) })), onFrame = vi.fn()
  const view = await mount(createElement(DocumentSections, { id: 'user-scroll', title: 'Guide', sections, frame: { ...initialFrameState(sections), section: mode === 'restored' ? 'B' : 'A' }, onFrame }))
  try {
    const column = view.host.querySelector<HTMLElement>('[aria-label="Guide sections"]')!
    Object.defineProperties(column, { clientHeight: { get: () => 400 }, scrollHeight: { get: () => 1100 } })
    column.querySelectorAll('section').forEach((section, index) => Object.defineProperty(section, 'offsetTop', { get: () => [0, 500, 900, 1000][index] }))
    if (mode === 'clicked') await act(async () => view.host.querySelector<HTMLButtonElement>('[data-section="B"]')!.click())
    column.scrollTop = 500
    await act(async () => column.dispatchEvent(new Event('scroll')))
    act(() => pending?.())
    expect(onFrame).toHaveBeenLastCalledWith(expect.objectContaining({ section: 'B' }))
    const event = {
      wheel: new WheelEvent('wheel', { bubbles: true, deltaY: 200 }), keyboard: new KeyboardEvent('keydown', { bubbles: true, key: 'End' }),
      'nested-keyboard': new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' }),
      tab: new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }),
      scrollbar: new Event('pointerdown', { bubbles: true }), touch: new Event('touchmove', { bubbles: true }),
      'middle-autoscroll': new PointerEvent('pointerdown', { bubbles: true, button: 1, pointerType: 'mouse' }),
      'text-drag': new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
      'section-list-tab': new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Tab' })
    }[input]
    let target: HTMLElement = input === 'nested-keyboard' ? column.querySelector('button')! : column
    if (input === 'middle-autoscroll' || input === 'text-drag') {
      target = column.querySelector<HTMLElement>('section[data-section="B"] span')!
      target.addEventListener('pointerdown', event => event.stopPropagation())
    }
    if (input === 'section-list-tab') {
      target = view.host.querySelector<HTMLElement>('nav [data-section="B"]')!
      // happy-dom has no layout; make the current section's first control eligible for SectionNav's real Tab handler.
      Object.defineProperty(column.querySelector('section[data-section="B"] button')!, 'getClientRects', { value: () => [new DOMRect()] })
    }
    await act(async () => target.dispatchEvent(event))
    if (input === 'section-list-tab') {
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(column.querySelector('section[data-section="B"] button'))
    }
    column.scrollTop = 700
    await act(async () => column.dispatchEvent(new Event('scroll')))
    act(() => pending?.())
    expect(onFrame).toHaveBeenLastCalledWith(expect.objectContaining({ section: 'D' }))
  } finally { view.dispose(); clock.mockRestore() }
})

it('sorts numeric ranks consistently while text-sort and copy settings change live', async () => {
  const view = await mount(createElement(ResultsSample))
  const button = (name: string) => [...view.host.querySelectorAll('button')].find(button => button.textContent === name)!
  const ranks = () => [...view.host.querySelectorAll('tbody tr')].map(row => row.firstElementChild?.textContent)
  try {
    await act(async () => button('Sort Rank ascending').click())
    for (const mode of ['chars', 'bytes', 'value'] as const) {
      const headers = mode !== 'value'
      await act(async () => view.fixture.settings.update({ 'queryResults.grid.sortText': mode, 'queryResults.grid.includeColumnHeaders': headers }))
      expect(ranks()).toEqual(['10', '20', '30'])
      expect(view.host.textContent).toContain(`Ordinary Copy currently ${headers ? 'includes' : 'omits'} column headers`)
    }
    await act(async () => button('Show Open rows only').click())
    expect(ranks()).toEqual(['20', '30'])
    await act(async () => button('Sort Rank ascending').click())
    expect(ranks()).toEqual(['30', '20'])
    expect(view.fixture.api.execute).not.toHaveBeenCalled()
  } finally { view.dispose() }
})
