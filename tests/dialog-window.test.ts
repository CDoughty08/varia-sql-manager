// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import DialogWindow, { centredBounds, DialogHeading, dialogWindowSize, rememberDialogWindowSize } from '../src/renderer/src/popouts/DialogWindow'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { modalOpen } from '../src/renderer/src/core/modal'
import { windows } from '../src/renderer/src/core/windows'
import { dialogWindowKinds, dialogWindowName } from '../src/shared/popouts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()); vi.restoreAllMocks(); localStorage.clear() })
const screen = { width: 1920, height: 1040 }

/** A dialog window as the page sees it: its own document, events, size, and whether it was closed. */
function fakeChild() {
  const doc = document.implementation.createHTMLDocument('')
  const listeners = new Map<string, (() => void)[]>()
  const child = {
    document: doc, closed: false, innerWidth: 1000, innerHeight: 700,
    addEventListener: (event: string, listener: () => void) => { listeners.set(event, [...listeners.get(event) ?? [], listener]) },
    removeEventListener: (event: string, listener: () => void) => { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== listener)) },
    close: vi.fn(() => { child.closed = true }), focus: vi.fn()
  }
  return { child, emit: (event: string) => { for (const listener of listeners.get(event) ?? []) listener() } }
}

async function mount(options: { dialogWindows?: boolean; refuse?: boolean } = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const fake = fakeChild(), attached = { dispose: vi.fn() }, attachWindow = vi.fn(() => attached)
  const open = vi.spyOn(window, 'open').mockImplementation(() => options.refuse ? null : fake.child as unknown as Window)
  const workbench = { platform: 'win32', attachWindow, ...options.dialogWindows === false ? {} : { dialogWindows: true } } as unknown as Workbench
  const onClose = vi.fn()
  const root = createRoot(host)
  const render = (shown: boolean) => act(async () => {
    root.render(createElement(WorkbenchProvider, { workbench, children: shown ? createElement(DialogWindow, { kind: 'options', onClose, children:
      createElement('form', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fixture-title' }, createElement(DialogHeading, { id: 'fixture-title', title: 'Options', closeLabel: 'Close options', onClose })) }) : null }))
  })
  await render(true)
  cleanups.push(() => { act(() => { root.unmount() }); host.remove() })
  return { host, fake, open, attachWindow, attached, onClose, hide: () => render(false) }
}

describe('dialog window sizes', () => {
  it('open at the kind\'s default, or the size the user left a resizable one, within its minimum and the screen', () => {
    const { width, height, minWidth, minHeight } = dialogWindowKinds.options
    expect(dialogWindowSize('options', screen, null)).toEqual({ width, height })
    expect(dialogWindowSize('options', screen, JSON.stringify({ width: 1200, height: 800 }))).toEqual({ width: 1200, height: 800 })
    expect(dialogWindowSize('options', screen, JSON.stringify({ width: 10, height: 10 }))).toEqual({ width: minWidth, height: minHeight })
    expect(dialogWindowSize('options', { width: 1024, height: 700 }, JSON.stringify({ width: 4000, height: 4000 }))).toEqual({ width: 992, height: 668 })
    for (const damaged of ['{', '"x"', JSON.stringify({ width: 'wide', height: 700 }), JSON.stringify({ width: 1.5, height: 700 })]) expect(dialogWindowSize('options', screen, damaged)).toEqual({ width, height })
    // About cannot be resized, so a stored size never applies to it.
    expect(dialogWindowSize('about', screen, JSON.stringify({ width: 900, height: 900 }))).toEqual({ width: dialogWindowKinds.about.width, height: dialogWindowKinds.about.height })
    rememberDialogWindowSize('options', { width: 1100.4, height: 720.6 })
    expect(dialogWindowSize('options', screen)).toEqual({ width: 1100, height: 721 })
    rememberDialogWindowSize('about', { width: 900, height: 900 })
    expect(localStorage.getItem('varia.dialogWindow.about')).toBeNull()
  })
  it('centre over the main window', () => {
    expect(centredBounds({ screenX: 100, screenY: 50, outerWidth: 1440, outerHeight: 960 }, { width: 940, height: 680 })).toEqual({ x: 350, y: 190, width: 940, height: 680 })
    // A main window shorter than the dialog keeps its top edge.
    expect(centredBounds({ screenX: 0, screenY: 40, outerWidth: 1024, outerHeight: 500 }, { width: 940, height: 680 }).y).toBe(40)
  })
})

describe('DialogWindow', () => {
  it('renders the dialog into its own window, under a title bar, attached to the workbench', async () => {
    const view = await mount()
    const [, name, features] = view.open.mock.calls[0] as [string, string, string]
    expect(name).toMatch(dialogWindowName)
    expect(name.startsWith('varia-dialog-options-')).toBe(true)
    expect(features).toMatch(/^left=-?\d+,top=-?\d+,width=940,height=680$/)
    expect(view.attachWindow).toHaveBeenCalledWith(view.fake.child)
    const doc = view.fake.child.document
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
    expect(doc.querySelector('.dialog-window-root [role="dialog"]')).not.toBeNull()
    expect(doc.title).toBe('Options')
    // The heading is the frameless window's title bar, with its own close button (macOS has its traffic lights instead).
    expect(doc.querySelector('.dialog-titlebar h2')?.textContent).toBe('Options')
    const close = doc.querySelector<HTMLButtonElement>('.dialog-titlebar [aria-label="Close options"]')
    expect(close).not.toBeNull()
    close!.click()
    expect(view.onClose).toHaveBeenCalled()
  })
  it('treats the window closed by the user as the dialog\'s Cancel, and closes the window and remembers its size when the dialog goes', async () => {
    const view = await mount()
    view.fake.emit('pagehide')
    expect(view.onClose).toHaveBeenCalledTimes(1)
    const again = await mount()
    again.fake.child.innerWidth = 1111
    await again.hide()
    expect(again.fake.child.close).toHaveBeenCalled()
    expect(again.attached.dispose).toHaveBeenCalled()
    expect(again.onClose).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('varia.dialogWindow.options') ?? '{}')).toEqual({ width: 1111, height: 700 })
  })
  it('shows a dialog that stays open after its window was closed (Options while OK saves) over the main window', async () => {
    const view = await mount()
    await act(async () => { view.fake.emit('pagehide') })
    expect(view.onClose).toHaveBeenCalledTimes(1)
    expect(view.host.querySelector('.modal-backdrop [role="dialog"]')).not.toBeNull()
    expect(view.host.querySelector('[aria-label="Close options"]')).not.toBeNull()
  })
  it('shows over the main window, with its close button, where the window cannot open', async () => {
    for (const options of [{ refuse: true }, { dialogWindows: false }]) {
      const view = await mount(options)
      expect(view.host.querySelector('.modal-backdrop [role="dialog"]')).not.toBeNull()
      expect(view.host.querySelector('[aria-label="Close options"]')).not.toBeNull()
      cleanups.splice(0).reverse().forEach(clean => clean())
      vi.restoreAllMocks()
    }
  })
  it('holds the keys only while the user is in the dialog window: the main window works beside it', async () => {
    const view = await mount()
    const doc = view.fake.child.document
    vi.spyOn(windows, 'activeDocument').mockReturnValue(document)
    expect(modalOpen()).toBe(false)
    vi.spyOn(windows, 'activeDocument').mockReturnValue(doc)
    expect(modalOpen()).toBe(true)
  })
})
