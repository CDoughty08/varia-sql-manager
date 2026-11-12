import { describe, expect, it, vi } from 'vitest'
import { contextMenuIds } from '../src/shared/commands/menus'
import { argsFor, contextMenuLabels, editableText, inputTarget, isEditableText, menuForTarget, MenuTargetService, registerLiveOutput, targetKeys, type LiveOutput, type MenuTarget } from '../src/renderer/src/menus/targets'
import { registerGridAnchor } from '../src/renderer/src/grid/anchor'
import { fakeDocument, FakeElement } from './fixtures/elements'

const element = (tag: string, init?: ConstructorParameters<typeof FakeElement>[2]) => new FakeElement(document, tag, init)
const document = fakeDocument()
const dom = (value: FakeElement) => value as unknown as Element

describe('menu targets', () => {
  it('map every kind of target to its context menu and keys', () => {
    const input = inputTarget(element('input', { value: 'a' }).dom, () => true)
    const hitObject = { kind: 'table', database: 'd', schema: 'dbo', name: 'Orders' } as const
    const targets: MenuTarget[] = [
      { kind: 'editor', tabId: 't1' }, { kind: 'explorer', node: { id: 7, lost: false, kind: 'table', connectionId: 'c', label: 's.n', ref: { type: 'object', object: { kind: 'table', database: 'd', schema: 's', name: 'n' } } } }, { kind: 'tableDesigner', tabId: 't4' },
      { kind: 'documentTab', tabId: 't2' }, { kind: 'output', tabId: 't3', view: 'messages', selectedText: '', element: element('div').dom }, { kind: 'dockTab', pane: 'results', floating: true, popout: false }, input, { kind: 'ssisOperations', tabId: 't5' },
      { kind: 'searchHit', searchId: 's', index: 0, hit: { object: hitObject, folder: 'tables', label: 'dbo.Orders' }, pane: false, node: { lost: false, kind: 'table', connectionId: 'c', label: 'dbo.Orders', ref: { type: 'object', object: hitObject } }, state: { explorerScriptTitle: 'table' } }
    ]
    expect(targets.map(target => menuForTarget[target.kind])).toEqual(contextMenuIds)
    const none = { explorerNode: '', explorerServerLost: false, explorerFolderFilterable: false, explorerFolderFiltered: false, explorerFolder: '', explorerFolderInsertable: false, explorerNodePeekable: false, explorerNodeStatus: '', explorerServerEngine: '', explorerServerLinux: false, outputView: '', outputGridTransposable: false, outputLiveFilterable: false, outputLiveRows: '', outputLiveSortable: false, pane: '', paneFloating: false, panePopout: false, documentTabFloating: false, searchHitSchema: false }
    expect(targets.map(targetKeys)).toEqual([none, { ...none, explorerNode: 'table', explorerNodePeekable: true }, none, none, { ...none, outputView: 'messages' }, { ...none, pane: 'results', paneFloating: true }, none, none, { ...none, searchHitSchema: true }])
    expect(targetKeys(undefined)).toEqual(none)
    // The empty area below the servers, and a server lost with its backend generation.
    expect(targetKeys({ kind: 'explorer' })).toEqual({ ...none, explorerNode: 'background' })
    const lost = { id: 1, lost: true, kind: 'server', connectionId: 'c', label: 'c', ref: { type: 'object', object: { kind: 'server' } } } as const
    expect(targetKeys({ kind: 'explorer', node: lost })).toEqual({ ...none, explorerNode: 'server', explorerServerLost: true })
    // Peek's menu item follows the Peek catalogue: a login peeks, a user does not.
    const principal = (kind: 'login' | 'user') => ({ id: 4, lost: false, kind, connectionId: 'c', label: 'p', ref: { type: 'object', object: kind === 'login' ? { kind, name: 'p' } : { kind, database: 'd', name: 'p' } } } as const)
    expect(targetKeys({ kind: 'explorer', node: principal('login') }).explorerNodePeekable).toBe(true)
    expect(targetKeys({ kind: 'explorer', node: principal('user') }).explorerNodePeekable).toBe(false)
    expect(targetKeys({ kind: 'dockTab', pane: 'editor', floating: false, popout: false }).paneFloating).toBe(false)
    expect(targetKeys({ kind: 'dockTab', pane: 'results', floating: false, popout: true }).panePopout).toBe(true)
    // A document tab in a floating editor group offers Dock rather than Float.
    expect(targetKeys({ kind: 'documentTab', tabId: 't2', floating: true })).toEqual({ ...none, documentTabFloating: true })
    // Folders Filter Settings can narrow, with or without a filter; folders that list nothing to filter.
    const folder = (id: 'tables' | 'programmability', filtered?: boolean) => ({ id: 2, lost: false, kind: 'folder', folder: id, connectionId: 'c', label: id, ref: { type: 'folder', owner: { kind: 'database', name: 'd' }, folder: id }, ...(filtered ? { filtered } : {}) } as const)
    // explorerFolder names the folder, so only Tables offers New › Table….
    expect(targetKeys({ kind: 'explorer', node: folder('tables') })).toEqual({ ...none, explorerNode: 'folder', explorerFolder: 'tables', explorerFolderFilterable: true })
    expect(targetKeys({ kind: 'explorer', node: folder('tables', true) })).toEqual({ ...none, explorerNode: 'folder', explorerFolder: 'tables', explorerFolderFilterable: true, explorerFolderFiltered: true })
    expect(targetKeys({ kind: 'explorer', node: folder('programmability') })).toEqual({ ...none, explorerNode: 'folder', explorerFolder: 'programmability' })
    // A fully loaded Columns folder has names to copy.
    const columns = { id: 3, lost: false, kind: 'folder', folder: 'columns', connectionId: 'c', label: 'Columns', ref: { type: 'folder', owner: { kind: 'table', database: 'd', schema: 's', name: 'n' }, folder: 'columns' }, insertable: true } as const
    expect(targetKeys({ kind: 'explorer', node: columns })).toEqual({ ...none, explorerNode: 'folder', explorerFolder: 'columns', explorerFolderInsertable: true })
    // File commands act on the tab the menu is for.
    expect(targets.map(target => argsFor(target).tabId)).toEqual(['t1', undefined, 't4', 't2', 't3', undefined, undefined, 't5', undefined])
    expect(argsFor(targets[5])).toEqual({ target: targets[5] })
    // A Search Objects result's commands read its own selection keys over the tree's.
    expect(argsFor(targets[8])).toEqual({ target: targets[8], state: { explorerScriptTitle: 'table' } })
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
  const paneTab = make('div', { className: 'pane-tab', attributes: { 'data-pane-tab': 'results' } }).append(paneTitle, paneClose)
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
    service.register(dom(elements.paneTab), () => ({ kind: 'dockTab', pane: 'results', floating: false, popout: false }))
    return { service, ...elements }
  }
  it('finds the document tab of an editor group from the Dockview tab element around it (Shift+F10)', () => {
    const doc = fakeDocument(), make = (tag: string, init?: ConstructorParameters<typeof FakeElement>[2]) => new FakeElement(doc, tag, init)
    const documentTab = make('div', { className: 'query-tab', attributes: { 'data-tab-id': 't2' } })
    const host = make('div', { className: 'dv-tab', attributes: { tabindex: '0', role: 'tab' } }).append(documentTab)
    make('body').append(host)
    const service = new MenuTargetService({ commandEnabled: () => true })
    service.register(dom(documentTab), registered => ({ kind: 'documentTab', tabId: (registered as unknown as FakeElement).dataset.tabId }))
    expect(service.targetFor(dom(host))).toEqual({ target: { kind: 'documentTab', tabId: 't2' }, element: host, mark: host, focus: host })
  })
  it('finds registered elements from anything inside them, focusing the part that was clicked', () => {
    const { service, tabName, tabButton, queryTab } = setup()
    expect(service.targetFor(dom(tabName))).toEqual({ target: { kind: 'documentTab', tabId: 't1' }, element: queryTab, mark: queryTab, focus: tabButton })
    // The tab itself is not focusable, so a click on its padding moves no focus.
    expect(service.targetFor(dom(queryTab))).toEqual({ target: { kind: 'documentTab', tabId: 't1' }, element: queryTab, mark: queryTab })
  })
  it('keeps a registered composite widget as the focus owner when an inner action opens its menu', () => {
    const doc = fakeDocument(), button = new FakeElement(doc, 'button', { attributes: { tabindex: '-1' } })
    const row = new FakeElement(doc, 'div').append(button), tree = new FakeElement(doc, 'div', { attributes: { tabindex: '0' } }).append(row)
    const service = new MenuTargetService()
    let owner: HTMLElement | undefined = tree.dom
    service.register(row.dom, () => ({ kind: 'explorer' }), () => owner)
    expect(service.targetFor(button.dom)).toEqual({ target: { kind: 'explorer' }, element: row, mark: row, focus: tree })
    expect(service.targetFor(row.dom)?.focus).toBe(tree)
    // Text fields keep their own focus and text menu, including an inline rename field inside this widget.
    const rename = new FakeElement(doc, 'input', { value: 'NewName' })
    row.append(rename)
    expect(service.targetFor(rename.dom)).toMatchObject({ target: { kind: 'input', element: rename }, focus: rename })
    // The resolver runs when the menu opens, falling back to the clicked control if the owner is no longer available.
    owner = undefined
    expect(service.targetFor(button.dom)?.focus).toBe(button)
  })
  it('resolves panel tabs inside Dockview\'s tab element, from the tab and from keyboard focus on it', () => {
    const { service, paneTitle, paneClose, dvTab } = setup()
    const expected = { target: { kind: 'dockTab', pane: 'results', floating: false, popout: false }, element: dvTab, mark: dvTab }
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
    // The find widget's input is a text field, which takes focus back from the editor before its menu opens, and is
    // outlined while the menu shows (its selection is not, without focus).
    expect(service.targetFor(dom(findInput))).toMatchObject({ target: { kind: 'input', element: findInput, empty: false }, element: findInput, focus: findInput, mark: findInput })
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
  it('resolves Query Output\'s views: the grid below its active cell, and Messages with their selected text', () => {
    const doc = fakeDocument(), make = (tag: string, init?: ConstructorParameters<typeof FakeElement>[2]) => new FakeElement(doc, tag, init)
    const view = (kind: string, attributes: Record<string, string> = {}) => make('div', { attributes: { 'data-output-view': kind, 'data-tab-id': 't1', ...attributes } })
    const number = make('div', { className: 'rg-rh' }), first = make('div', { className: 'rg-c' })
    const active = make('div', { className: 'rg-c is-act' })
    const grid = view('grid', { 'data-result-grid': '', 'data-result-entry': 'e3' }).append(make('div', { className: 'rg-scroll' }).append(make('div', { className: 'rg-row' }).append(number, first), make('div', { className: 'rg-row' }).append(active)))
    const text = make('pre', { textContent: 'hello' }), messages = view('messages').append(text), plan = view('plan').append(make('pre'))
    make('body').append(grid, messages, plan)
    const service = new MenuTargetService()
    const output = { kind: 'output', tabId: 't1', selectedText: '' }
    // A grid's target names its result by the entry key the grid carries; Messages name none.
    expect(service.targetFor(dom(number))).toEqual({ target: { ...output, view: 'grid', entry: 'e3', element: grid }, element: grid, focus: grid, anchor: active })
    active.classes.delete('is-act')
    expect(service.targetFor(dom(active))?.anchor).toBe(first)
    // A mounted grid names its anchor at event time, after painting a pending frame (a click just before Shift+F10
    // has not been painted yet); the DOM decides only without one.
    const painted = make('div', { className: 'rg-c' })
    const unregister = registerGridAnchor(dom(grid), () => dom(painted))
    expect(service.targetFor(dom(first))?.anchor).toBe(painted)
    unregister()
    expect(service.targetFor(dom(first))?.anchor).toBe(first)
    // Selected text counts only inside the view.
    doc.selection = 'hello'
    expect(service.targetFor(dom(text))?.target).toEqual({ ...output, view: 'messages', element: messages })
    doc.selectionIn = text
    expect(service.targetFor(dom(text))).toEqual({ target: { ...output, view: 'messages', selectedText: 'hello', element: messages }, element: messages, focus: messages })
    // Execution plans open as documents now; there is no plan view.
    expect(service.targetFor(dom(plan))).toBeUndefined()
    // The grid's cells are selected, not its text.
    doc.selectionIn = first
    expect(service.targetFor(dom(first))?.target).toMatchObject({ view: 'grid', selectedText: '' })
    for (const attributes of [{ 'data-output-view': 'chart' }, { 'data-tab-id': '' }] as Record<string, string>[]) {
      expect(service.targetFor(dom(make('div').append(view('messages', attributes)).children[0])), JSON.stringify(attributes)).toBeUndefined()
    }
    // A grid that names no entry is no target: no command could say which result it means.
    for (const attributes of [{}, { 'data-result-entry': '' }] as Record<string, string>[]) {
      expect(service.targetFor(dom(make('div').append(view('grid', attributes)).children[0])), JSON.stringify(attributes)).toBeUndefined()
    }
  })
  it('captures the clicked column and result identity, or the keyboard menu\'s active column', () => {
    const doc = fakeDocument(), make = (tag: string, init?: ConstructorParameters<typeof FakeElement>[2]) => new FakeElement(doc, tag, init)
    const text = make('span'), header = make('div', { attributes: { 'aria-colindex': '3' } }).append(text)
    const active = make('div', { className: 'rg-c is-act', attributes: { 'aria-colindex': '4' } })
    const grid = make('div', { attributes: { 'data-output-view': 'grid', 'data-tab-id': 'query', 'data-result-entry': 'e2', 'data-result-generation': '2', 'data-result-id': '7' } }).append(header, active)
    const service = new MenuTargetService()
    const clicked = service.targetFor(dom(text))!.target
    expect(clicked).toMatchObject({ kind: 'output', tabId: 'query', entry: 'e2', column: 1, result: { generation: 2, resultId: 7 } })
    expect(service.targetFor(dom(grid))!.target).toMatchObject({ column: 2 })
    header.setAttribute('aria-colindex', '5')
    expect(clicked).toMatchObject({ column: 1 })
    active.setAttribute('aria-colindex', '1')
    expect(service.targetFor(dom(grid))!.target).not.toHaveProperty('column')
    // Its result kind offers Transpose for rows, pivots and transposes, never a diff (or an unmarked grid).
    expect(targetKeys(service.targetFor(dom(grid))!.target).outputGridTransposable).toBe(false)
    const transposable = (kind: string) => { grid.setAttribute('data-result-kind', kind); return targetKeys(service.targetFor(dom(grid))!.target).outputGridTransposable }
    expect(['rows', 'pivot', 'transpose', 'diff'].map(transposable)).toEqual([true, true, true, false])
  })
  it('resolves a live view\'s grid as Query Output\'s view `live`, with its commands and the clicked or active column', () => {
    const doc = fakeDocument(), make = (tag: string, init?: ConstructorParameters<typeof FakeElement>[2]) => new FakeElement(doc, tag, init)
    const header = make('div', { attributes: { 'aria-colindex': '3' } })
    const active = make('div', { className: 'rg-c is-act', attributes: { 'aria-colindex': '4' } })
    const grid = make('div', { attributes: { 'data-output-view': 'live', 'aria-label': 'Sessions' } }).append(header, active)
    make('body').append(grid)
    const service = new MenuTargetService()
    // Until its grid registers its commands it has no menu (a stopped view's grid unmounted them).
    expect(service.targetFor(dom(header))).toBeUndefined()
    const live = { sortable: true, filterable: false } as LiveOutput
    const unregister = registerLiveOutput(dom(grid), live)
    const hit = service.targetFor(dom(header))!
    expect(hit).toMatchObject({ target: { kind: 'output', view: 'live', tabId: '', column: 1, live }, element: grid, anchor: active })
    expect(menuForTarget[hit.target.kind]).toBe('output.context')
    expect(service.targetFor(dom(grid))!.target).toMatchObject({ column: 2 })
    // It names no query, so File commands and Close Results have no tab to act on.
    expect(argsFor(hit.target).tabId).toBeUndefined()
    expect(targetKeys(hit.target)).toMatchObject({ outputView: 'live', outputLiveSortable: true, outputLiveFilterable: false, outputGridTransposable: false })
    // Only a grid whose source filters columns shows the Filter items.
    expect(targetKeys({ ...hit.target, live: { sortable: true, filterable: true } as LiveOutput } as MenuTarget).outputLiveFilterable).toBe(true)
    expect(targetKeys({ ...hit.target, live: { sortable: false } as LiveOutput } as MenuTarget).outputLiveSortable).toBe(false)
    unregister()
    expect(service.targetFor(dom(header))).toBeUndefined()
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
