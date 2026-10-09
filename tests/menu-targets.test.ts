import { describe, expect, it, vi } from 'vitest'
import { contextMenuIds } from '../src/shared/commands/menus'
import { argsFor, contextMenuLabels, editableText, inputTarget, isEditableText, menuForTarget, MenuTargetService, targetKeys, type MenuTarget } from '../src/renderer/src/menus/targets'
import { fakeDocument, FakeElement } from './fixtures/elements'

const element = (tag: string, init?: ConstructorParameters<typeof FakeElement>[2]) => new FakeElement(document, tag, init)
const document = fakeDocument()
const dom = (value: FakeElement) => value as unknown as Element

describe('menu targets', () => {
  it('map every kind of target to its context menu and keys', () => {
    const input = inputTarget(element('input', { value: 'a' }).dom, () => true)
    const targets: MenuTarget[] = [
      { kind: 'editor', tabId: 't1' }, { kind: 'explorer', node: { kind: 'table', connectionId: 'c', database: 'd', schema: 's', name: 'n' } }, { kind: 'documentTab', tabId: 't2' },
      { kind: 'output', tabId: 't3', view: 'messages', resultIndex: 0, selectedText: '', element: element('div').dom }, { kind: 'dockTab', pane: 'output', floating: true }, input
    ]
    expect(targets.map(target => menuForTarget[target.kind])).toEqual(contextMenuIds)
    expect(targets.map(targetKeys)).toEqual([
      { explorerNode: '', outputView: '', paneFloating: false }, { explorerNode: 'table', outputView: '', paneFloating: false }, { explorerNode: '', outputView: '', paneFloating: false },
      { explorerNode: '', outputView: 'messages', paneFloating: false }, { explorerNode: '', outputView: '', paneFloating: true }, { explorerNode: '', outputView: '', paneFloating: false }
    ])
    expect(targetKeys(undefined)).toEqual({ explorerNode: '', outputView: '', paneFloating: false })
    expect(targetKeys({ kind: 'dockTab', pane: 'editor', floating: false }).paneFloating).toBe(false)
    // File commands act on the tab the menu is for.
    expect(targets.map(target => argsFor(target).tabId)).toEqual(['t1', undefined, 't2', 't3', undefined, undefined])
    expect(argsFor(targets[4])).toEqual({ target: targets[4] })
    expect(Object.keys(contextMenuLabels)).toEqual([...contextMenuIds])
  })
  it('treat text inputs, text areas, and editable content as text fields, but not the editor\'s own input', () => {
    for (const type of ['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'TEXT']) expect(isEditableText(element('input', { type }).dom), type).toBe(true)
    expect(isEditableText(element('input').dom)).toBe(true)
    for (const type of ['checkbox', 'color', 'button', 'range']) expect(isEditableText(element('input', { type }).dom), type).toBe(false)
    expect(isEditableText(element('textarea').dom)).toBe(true)
    for (const tag of ['select', 'button', 'div']) expect(isEditableText(element(tag).dom), tag).toBe(false)
    const span = element('span'), editable = element('div', { attributes: { contenteditable: 'true' } }).append(span)
    expect(editableText(dom(span))).toBe(editable)
    expect(isEditableText(dom(element('div', { attributes: { contenteditable: 'false' } }).append(element('span')).children[0]))).toBe(false)
    expect(isEditableText(element('div', { className: 'native-edit-context', attributes: { contenteditable: 'true' } }).dom)).toBe(false)
    expect(isEditableText(element('textarea', { className: 'inputarea' }).dom)).toBe(false)
  })
  it('read a text field\'s facts: read-only, password, selection, empty, undo and redo', () => {
    const facts = (field: FakeElement, enabled: (command: 'undo' | 'redo') => boolean = () => true) => {
      const { kind, readOnly, secret, hasSelection, empty, canUndo, canRedo } = inputTarget(field.dom, enabled)
      return { kind, readOnly, secret, hasSelection, empty, canUndo, canRedo }
    }
    expect(facts(element('input', { value: 'abc', selectionStart: 1, selectionEnd: 3 }))).toEqual({ kind: 'input', readOnly: false, secret: false, hasSelection: true, empty: false, canUndo: true, canRedo: true })
    expect(facts(element('input', { type: 'password', value: 'x', selectionStart: 1, selectionEnd: 1 }), command => command === 'redo'))
      .toEqual({ kind: 'input', readOnly: false, secret: true, hasSelection: false, empty: false, canUndo: false, canRedo: true })
    expect(facts(element('textarea', { value: '', readOnly: true }))).toMatchObject({ readOnly: true, empty: true, hasSelection: false })
    expect(facts(element('input', { value: 'x', disabled: true }))).toMatchObject({ readOnly: true })
    // Number inputs have no selection range; the document's selection says whether text is selected.
    document.selection = '42'
    expect(facts(element('input', { type: 'number', value: '42', selectionStart: null, selectionEnd: null }))).toMatchObject({ hasSelection: true })
    document.selection = ''
    expect(facts(element('div', { attributes: { contenteditable: 'true' }, isContentEditable: true, textContent: 'text' }))).toMatchObject({ readOnly: false, empty: false, hasSelection: false })
    // An undo check that throws counts as possible: the command itself does nothing harmful.
    expect(facts(element('input', { value: 'x' }), () => { throw new Error('unsupported') })).toMatchObject({ canUndo: true, canRedo: true })
  })
})

/**
 * A window's worth of elements: a query tab with a button, a Dockview tab around a panel's tab content, the query
 * editor with its find widget, the quick input, and a dialog with fields.
 */
function page() {
  const doc = fakeDocument(), make = (tag: string, init?: ConstructorParameters<typeof FakeElement>[2]) => new FakeElement(doc, tag, init)
  const tabName = make('span', { className: 'tab-name' }), tabButton = make('button', { className: 'tab-select' }).append(tabName)
  const queryTab = make('div', { className: 'query-tab', attributes: { 'data-tab-id': 't1' } }).append(tabButton)
  const paneTitle = make('div', { className: 'dv-default-tab-content' }), paneClose = make('button')
  const paneTab = make('div', { className: 'pane-tab', attributes: { 'data-pane-tab': 'output' } }).append(paneTitle, paneClose)
  const dvTab = make('div', { className: 'dv-tab', attributes: { tabindex: '0' } }).append(paneTab)
  const line = make('span'), scrollbar = make('div', { className: 'scrollbar' }), findInput = make('textarea', { className: 'input', value: 'find' }), findToggle = make('div', { className: 'toggle' })
  const editContext = make('div', { className: 'native-edit-context' })
  const editor = make('div', { className: 'editor-host' }).append(make('div', { className: 'monaco-editor' }).append(
    make('div', { className: 'view-lines' }).append(line), scrollbar, editContext, make('div', { className: 'overlayWidgets' }).append(make('div', { className: 'find-widget' }).append(findInput, findToggle))))
  const paletteInput = make('input'), quickInput = make('div', { className: 'quick-input' }).append(paletteInput)
  const plain = make('div', { className: 'status-bar' })
  const body = make('body').append(queryTab, dvTab, editor, quickInput, plain)
  return { doc, body, tabName, tabButton, queryTab, paneTitle, paneClose, paneTab, dvTab, line, scrollbar, findInput, findToggle, editContext, editor, paletteInput, plain }
}

describe('menu target service', () => {
  function setup(tabId = 't1') {
    const elements = page()
    const service = new MenuTargetService({ editor: () => ({ container: dom(elements.editor), tabId }), commandEnabled: () => true })
    service.register(dom(elements.queryTab), registered => ({ kind: 'documentTab', tabId: (registered as unknown as FakeElement).dataset.tabId }))
    service.register(dom(elements.paneTab), () => ({ kind: 'dockTab', pane: 'output', floating: false }))
    return { service, ...elements }
  }
  it('finds registered elements from anything inside them, focusing the part that was clicked', () => {
    const { service, tabName, tabButton, queryTab } = setup()
    expect(service.targetFor(dom(tabName))).toEqual({ target: { kind: 'documentTab', tabId: 't1' }, element: queryTab, mark: queryTab, focus: tabButton })
    // The tab itself is not focusable, so a click on its padding moves no focus.
    expect(service.targetFor(dom(queryTab))).toEqual({ target: { kind: 'documentTab', tabId: 't1' }, element: queryTab, mark: queryTab })
  })
  it('resolves panel tabs inside Dockview\'s tab element, from the tab and from keyboard focus on it', () => {
    const { service, paneTitle, paneClose, dvTab } = setup()
    const expected = { target: { kind: 'dockTab', pane: 'output', floating: false }, element: dvTab, mark: dvTab }
    expect(service.targetFor(dom(paneTitle))).toEqual({ ...expected, focus: dvTab })
    expect(service.targetFor(dom(paneClose))).toEqual({ ...expected, focus: paneClose })
    expect(service.targetFor(dom(dvTab))).toEqual({ ...expected, focus: dvTab })
  })
  it('gives the query editor its menu, except on its scroll bars and widgets, and text fields theirs', () => {
    const { service, line, scrollbar, findInput, findToggle, editContext, editor } = setup()
    expect(service.targetFor(dom(line))).toEqual({ target: { kind: 'editor', tabId: 't1' }, element: editor })
    expect(service.targetFor(dom(editContext))).toEqual({ target: { kind: 'editor', tabId: 't1' }, element: editor })
    expect(service.targetFor(dom(scrollbar))).toBeNull()
    expect(service.targetFor(dom(findToggle))).toBeNull()
    // The find widget's input is a text field, which takes focus back from the editor before its menu opens.
    expect(service.targetFor(dom(findInput))).toMatchObject({ target: { kind: 'input', element: findInput, empty: false }, element: findInput, focus: findInput })
    const closed = setup('')
    expect(closed.service.targetFor(dom(closed.line))).toBeNull()
  })
  it('shows no menu in the quick input or where nothing registered, and survives a throwing provider', () => {
    const { service, paletteInput, plain, body } = setup()
    expect(service.targetFor(dom(paletteInput))).toBeNull()
    expect(service.targetFor(dom(plain))).toBeUndefined()
    expect(service.targetFor(null)).toBeUndefined()
    expect(service.targetFor({ nodeType: 9 } as unknown as Element)).toBeUndefined()
    service.register(dom(plain), () => null)
    expect(service.targetFor(dom(plain))).toBeNull()
    service.register(dom(body), () => { throw new Error('provider') })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(service.targetFor(dom(body))).toBeUndefined()
      expect(report).toHaveBeenCalledOnce()
    } finally { report.mockRestore() }
  })
  it('resolves Query Output\'s views: the grid below its active cell, and Messages and the plan with their selected text', () => {
    const doc = fakeDocument(), make = (tag: string, init?: ConstructorParameters<typeof FakeElement>[2]) => new FakeElement(doc, tag, init)
    const view = (kind: string, attributes: Record<string, string> = {}) => make('div', { attributes: { 'data-output-view': kind, 'data-tab-id': 't1', 'data-result-index': '2', ...attributes } })
    const number = make('td', { className: 'row-number', attributes: { 'data-row': '0' } }), first = make('td', { attributes: { 'data-row': '0', 'data-col': '0' } })
    const active = make('td', { className: 'active-cell', attributes: { 'data-row': '1', 'data-col': '1' } })
    const grid = view('grid', { 'data-result-grid': '' }).append(make('table').append(make('tr').append(number, first), make('tr').append(active)))
    const text = make('pre', { textContent: 'hello' }), messages = view('messages', { 'data-result-index': '0' }).append(text), plan = view('plan').append(make('pre'))
    make('body').append(grid, messages, plan)
    const service = new MenuTargetService()
    const output = { kind: 'output', tabId: 't1', resultIndex: 2, selectedText: '' }
    expect(service.targetFor(dom(number))).toEqual({ target: { ...output, view: 'grid', element: grid }, element: grid, focus: grid, anchor: active })
    active.classes.delete('active-cell')
    expect(service.targetFor(dom(active))?.anchor).toBe(first)
    // Selected text counts only inside the view.
    doc.selection = 'hello'
    expect(service.targetFor(dom(text))?.target).toEqual({ ...output, resultIndex: 0, view: 'messages', element: messages })
    doc.selectionIn = text
    expect(service.targetFor(dom(text))).toEqual({ target: { ...output, resultIndex: 0, view: 'messages', selectedText: 'hello', element: messages }, element: messages, focus: messages })
    expect(service.targetFor(dom(plan))?.target).toMatchObject({ view: 'plan', selectedText: '' })
    // The grid's cells are selected, not its text.
    doc.selectionIn = first
    expect(service.targetFor(dom(first))?.target).toMatchObject({ view: 'grid', selectedText: '' })
    for (const attributes of [{ 'data-output-view': 'chart' }, { 'data-tab-id': '' }, { 'data-result-index': '-1' }, { 'data-result-index': '1.5' }] as Record<string, string>[]) {
      expect(service.targetFor(dom(make('div').append(view('messages', attributes)).children[0])), JSON.stringify(attributes)).toBeUndefined()
    }
  })
  it('reads a text field\'s facts again once it has focus', () => {
    let undo = false
    const doc = fakeDocument(), field = new FakeElement(doc, 'input', { value: 'x' })
    const service = new MenuTargetService({ commandEnabled: () => undo })
    const hit = service.targetFor(dom(field))!
    expect(hit.target).toMatchObject({ kind: 'input', canUndo: false })
    undo = true
    expect(service.refresh(hit.target)).toMatchObject({ kind: 'input', canUndo: true })
    const tab: MenuTarget = { kind: 'documentTab', tabId: 't1' }
    expect(service.refresh(tab)).toBe(tab)
  })
})
