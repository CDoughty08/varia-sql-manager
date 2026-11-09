import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { domFocusAdapter, focusToReturn, returnFocusTo } from '../src/renderer/src/core/focus'
import { focusWhenDrawn } from '../src/renderer/src/core/modal'
import { fakeDocument, FakeElement } from './fixtures/elements'

afterEach(() => { vi.unstubAllGlobals() })

/** The DOM focus adapter over fake elements: a title bar, a toolbar button, and `queries` open queries with an editor. */
function setup(queries: number) {
  const doc = fakeDocument(), body = new FakeElement(doc, 'body')
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('document', Object.assign(doc, { body, querySelector: () => null, querySelectorAll: () => [] }))
  const file = new FakeElement(doc, 'button', { attributes: { 'data-menu': 'file' } }), field = new FakeElement(doc, 'input')
  body.append(new FakeElement(doc, 'nav', { className: 'title-bar-menus' }).append(file), field)
  const editor = { focusCalls: 0, focus() { this.focusCalls++ } }
  // DocumentService.focusActive: the query editor here (a table designer's grid is documents.test.ts').
  const documents = { getSnapshot: () => ({ documents: Array.from({ length: queries }, (_, index) => ({ id: String(index) })) }), focusActive: () => editor.focus() }
  return { doc, file, field, editor, focus: domFocusAdapter(documents as unknown as Parameters<typeof domFocusAdapter>[0]) }
}

describe('DOM focus adapter', () => {
  it('captures focus outside the menus and returns it there, or else to the query editor', () => {
    const { doc, file, field, editor, focus } = setup(1)
    field.focus()
    expect(focus.capture()).toBe(field)
    file.focus()
    expect(focus.capture()).toBeUndefined()
    focus.restore(field)
    expect(doc.activeElement).toBe(field)
    file.focus()
    field.isConnected = false
    focus.restore(field)
    expect(editor.focusCalls).toBe(1)
  })
  it('falls back when the element it came from cannot take focus any more', () => {
    const { file, field, editor, focus } = setup(1)
    // A hidden element (a closed query's editor) ignores focus().
    field.focus = () => {}
    file.focus()
    focus.restore(field)
    expect(editor.focusCalls).toBe(1)
  })
  it('takes focus off a menubar button when there is no query to return to', () => {
    const { doc, file, field, editor, focus } = setup(0)
    file.focus()
    focus.restore(undefined)
    expect([doc.activeElement, editor.focusCalls]).toEqual([null, 0])
    // Focus anywhere else stays where it is.
    field.focus()
    focus.restore(undefined)
    expect(doc.activeElement).toBe(field)
  })
})

describe('focusWhenDrawn', () => {
  /** A document's control, the palette's input, a menu item and a dialog's field, and the frames waiting to run. */
  function page() {
    const doc = fakeDocument(), body = new FakeElement(doc, 'body')
    const control = new FakeElement(doc, 'button', { attributes: { 'data-activity-focus': '' } }), palette = new FakeElement(doc, 'input', { attributes: { role: 'combobox' } })
    const item = new FakeElement(doc, 'div', { attributes: { role: 'menuitem' } }), menubar = new FakeElement(doc, 'button', { attributes: { 'data-menu': 'view' } })
    const field = new FakeElement(doc, 'input'), dialog = new FakeElement(doc, 'form', { attributes: { 'aria-modal': 'true' } }).append(field)
    body.append(control, new FakeElement(doc, 'div', { className: 'quick-input' }).append(palette), new FakeElement(doc, 'div', { className: 'menu-layer' }).append(item),
      new FakeElement(doc, 'nav', { className: 'title-bar-menus' }).append(menubar))
    let modal: FakeElement | null = null
    vi.stubGlobal('document', Object.assign(doc, { body, querySelector: (selector: string) => selector === '[aria-modal="true"]' ? modal : body.querySelector(selector) }))
    const frames: (() => void)[] = []
    const later = () => focusWhenDrawn(callback => frames.push(callback), () => control.focus())
    const drawn = () => { for (const frame of frames.splice(0)) frame() }
    return { doc, control, palette, item, menubar, field, later, drawn, openDialog: () => { modal = dialog; field.focus() } }
  }
  it('focuses the document once drawn, from wherever focus was', () => {
    const { doc, control, field, later, drawn } = page()
    later()
    expect(control.focusCalls).toBe(0)
    drawn()
    expect(doc.activeElement).toBe(control)
    // A plain field outside any dialog holds nothing.
    field.focus()
    later(); drawn()
    expect(doc.activeElement).toBe(control)
  })
  it('leaves focus in the palette, a menu or a dialog that took it before the frame came', () => {
    // F1 just after View › Activity Monitor: a throttled frame came after the palette opened, and moving focus closed it.
    const { doc, control, palette, item, menubar, field, later, drawn, openDialog } = page()
    for (const holder of [palette, item, menubar]) {
      later()
      holder.focus()
      drawn()
      expect(doc.activeElement).toBe(holder)
    }
    later()
    openDialog()
    drawn()
    expect([doc.activeElement, control.focusCalls]).toEqual([field, 0])
  })
})

describe('deferred focus in the workbench', () => {
  it('goes only through focusWhenDrawn, so no document takes focus from the palette, a menu or a dialog', () => {
    // A document service that focused itself through nextFrame and modalOpen alone pulled focus out of the palette.
    const source = readFileSync(new URL('../src/renderer/src/core/workbench.ts', import.meta.url), 'utf8')
    expect(source.match(/nextFrame\(\(\) =>[^\n]*/g) ?? []).toEqual([])
    // A pending Float, Dock, Join or group-focus frame must leave a newly opened quick input in control.
    const groups = readFileSync(new URL('../src/renderer/src/editor-groups/EditorArea.tsx', import.meta.url), 'utf8')
    expect(groups.match(/requestAnimationFrame\(\(\) =>[^\n]*documents\.focusActive/g) ?? []).toEqual([])
  })
})

describe('focus returned by dialogs', () => {
  /** An element in a window, recording who took focus. */
  function element(view: { closed: boolean; focus(): void }, log: string[], name: string) {
    return { nodeType: 1, isConnected: true, closest: () => null, focus: () => { log.push(name) }, ownerDocument: { defaultView: view } }
  }
  it('takes the focused element of the window the user is in, and gives focus back there, bringing a popout forward', () => {
    const log: string[] = []
    const main = { closed: false, focus: () => { log.push('main window') } }, popout = { closed: false, focus: () => { log.push('popout window') } }
    const grid = element(popout, log, 'grid'), editor = element(main, log, 'editor')
    expect(focusToReturn({ activeElement: () => grid as unknown as Element })).toBe(grid)
    expect(focusToReturn({ activeElement: () => null })).toBeNull()
    returnFocusTo(grid as unknown as HTMLElement, main as unknown as Window)
    returnFocusTo(editor as unknown as HTMLElement, main as unknown as Window)
    expect(log).toEqual(['popout window', 'grid', 'editor'])
    // Gone with its window: nothing to give focus to.
    returnFocusTo({ ...grid, isConnected: false } as unknown as HTMLElement, main as unknown as Window)
    expect(log).toHaveLength(3)
  })
})
