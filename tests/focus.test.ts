import { afterEach, describe, expect, it, vi } from 'vitest'
import { domFocusAdapter } from '../src/renderer/src/core/focus'
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
