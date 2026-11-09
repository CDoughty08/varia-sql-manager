import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { emptyShortcutFile, type ShortcutFile } from '../src/shared/commands/shortcut-schema'
import { gestureRows, setGesture } from '../src/renderer/src/settings/shortcuts/gesture-rows'
import MouseView from '../src/renderer/src/settings/shortcuts/MouseView'

// The view reads the linked editor setting and command keys from the workbench, which server rendering has no store for.
vi.mock('../src/renderer/src/core/WorkbenchContext', async original => ({
  ...await original<object>(),
  useWorkbench: () => ({ settings: {}, keybindings: { lookup: () => ({ parts: ['F2'], aria: 'F2' }), getRevision: () => 0, subscribe: () => () => {} } }),
  useServiceSelector: () => 'ctrlCmd'
}))

const draft = (gestures: Record<string, string> = {}): ShortcutFile => ({ ...emptyShortcutFile, gestures })
const ids = (rows: readonly { id: string }[]) => rows.map(row => row.id)

describe('gesture rows', () => {
  it('list every gesture of the platform by group, with its choices, lock and keyboard path', () => {
    const rows = gestureRows(draft(), 'win32', '')
    expect(rows.map(row => row.kind)).toEqual(['modifier', 'modifier', 'modifier', 'modifier', 'pointerCommand', 'pointerCommand', 'pointerCommand', 'pointerCommand', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed'])
    expect(rows.find(row => row.id === 'connections.connect')).toMatchObject({ scopeTitle: 'Connect Dialog', kind: 'fixed', options: [] })
    // macOS's Control+click is a right-click there only.
    expect(ids(rows)).not.toContain('grid.secondaryClick')
    expect(ids(gestureRows(draft(), 'darwin', ''))).toContain('grid.secondaryClick')
    const float = rows.find(row => row.id === 'dock.floatWhileDragging')!
    expect([float.label, float.source, float.changed, float.options.map(option => option.label)]).toEqual(['Ctrl+Drag', 'default', false, ['Ctrl', 'Alt', 'Off']])
    const toggle = gestureRows(draft(), 'darwin', '').find(row => row.id === 'dock.toggleFloat')!
    expect([toggle.label, toggle.options.map(option => option.label), toggle.keyboard]).toEqual(['⌘ Double-click', ['⌘', '⌥', '⇧', 'None'], ['pane.float', 'pane.dock']])
    const fit = rows.find(row => row.id === 'grid.fitColumn')!
    expect([fit.source, fit.options, fit.locked]).toEqual(['builtin', [], 'Double-clicking a column border fits it, as in SSMS.'])
    const rename = rows.find(row => row.id === 'documentTabs.rename')!
    expect([rename.kind, rename.options, rename.locked]).toEqual(['pointerCommand', [], expect.stringContaining('F2 renames')])
    // The linked editor setting shows only where the Mouse view passes its value, never in the All view's gesture rows.
    expect(gestureRows(draft(), 'win32', '', { multiCursorModifier: 'alt' }).at(-1)).toMatchObject({ id: 'textEditor.multiCursorModifier', kind: 'linked', label: 'Alt+Click', source: 'setting', changed: false, page: 'textEditor.general' })
    expect(gestureRows(draft(), 'darwin', '', { multiCursorModifier: 'ctrlCmd' }).at(-1)).toMatchObject({ label: '⌘ Click', changed: true })
  })
  it("keep the fields the All view reads, with the stub's names", () => {
    const float = gestureRows(draft({ 'dock.floatWhileDragging': 'alt' }), 'win32', '').find(row => row.id === 'dock.floatWhileDragging')!
    expect({ id: float.id, title: float.title, label: float.label, scopeTitle: float.scopeTitle, kind: float.kind, changed: float.changed, locked: float.locked })
      .toEqual({ id: 'dock.floatWhileDragging', title: 'Float While Dragging', label: 'Alt+Drag', scopeTitle: 'Panels and Editor Tabs', kind: 'modifier', changed: true, locked: undefined })
  })
  it('follow edits to the draft, which keeps only changes, and reset per row', () => {
    let file = setGesture(draft({ 'later.gesture': 'alt' }), 'dock.floatWhileDragging', ['alt'], 'linux')
    file = setGesture(file, 'explorer.peekHover', null, 'linux')
    expect(file.gestures).toEqual({ 'later.gesture': 'alt', 'dock.floatWhileDragging': 'alt', 'explorer.peekHover': 'off' })
    const rows = gestureRows(file, 'linux', '')
    expect(rows.find(row => row.id === 'dock.floatWhileDragging')).toMatchObject({ label: 'Alt+Drag', currentToken: 'alt', source: 'user', changed: true, problems: [expect.objectContaining({ code: 'linuxAlt', severity: 'warning' })] })
    expect(rows.find(row => row.id === 'explorer.peekHover')).toMatchObject({ label: 'Off', currentToken: 'off', changed: true })
    file = setGesture(file, 'dock.floatWhileDragging', undefined, 'linux')
    expect(file.gestures).toEqual({ 'later.gesture': 'alt', 'explorer.peekHover': 'off' })
    // The rest of the draft is untouched.
    expect({ ...file, gestures: {} }).toEqual({ ...emptyShortcutFile, gestures: {} })
  })
  it('filter by words and the page\'s tokens', () => {
    const file = draft({ 'dock.floatWhileDragging': 'alt' })
    expect(ids(gestureRows(file, 'win32', 'float'))).toEqual(['dock.floatWhileDragging', 'dock.toggleFloat', 'dock.dragFloatingTitleBar'])
    expect(ids(gestureRows(file, 'win32', 'GRID  Fit'))).toEqual(['grid.fitColumn'])
    expect(ids(gestureRows(file, 'win32', '@modified'))).toEqual(['dock.floatWhileDragging'])
    expect(ids(gestureRows(file, 'win32', '@source:fixed shift'))).toEqual(['grid.extendSelection', 'dock.dragFloatingTitleBar'])
    // Keyboard commands are searchable: Peek on Hover's keyboard path is Peek.
    expect(ids(gestureRows(file, 'win32', 'object explorer peek'))).toEqual(['explorer.peekHover', 'explorer.openPeekTab'])
    expect(gestureRows(file, 'win32', '@kind:keyboard')).toEqual([])
    expect(gestureRows(file, 'win32', 'nothing like this')).toEqual([])
  })
})

describe('gesture rows follow the page', () => {
  it('read search tokens as the Shortcuts page does: prefixes, scopes, and unknown tokens filter nothing', () => {
    const file = draft({ 'dock.floatWhileDragging': 'alt', 'explorer.peekHover': 'off' })
    const all = gestureRows(file, 'win32', '').length
    for (const query of ['@kind:', '@kind:m', '@kind:mo', '@kind:mouse', '@conflict', '@whatever:x']) expect(gestureRows(file, 'win32', query), query).toHaveLength(all)
    expect(gestureRows(file, 'win32', '@kind:k')).toEqual([])
    expect(ids(gestureRows(file, 'win32', '@source:u'))).toEqual(['explorer.peekHover', 'dock.floatWhileDragging'])
    expect(ids(gestureRows(file, 'win32', '@scope:grid'))).toEqual(['grid.addToSelection', 'grid.addSortKey', 'grid.extendSelection', 'grid.fitColumn'])
    expect(ids(gestureRows(file, 'win32', '@unbound'))).toEqual(['explorer.peekHover'])
    expect(ids(gestureRows(file, 'win32', '@command:pane.dock'))).toEqual(['dock.toggleFloat'])
    // Problems: Alt on Linux warns.
    expect(ids(gestureRows(file, 'linux', '@conflicts'))).toEqual(['dock.floatWhileDragging'])
  })
  it('call every locked row built-in, as the All view does', () => {
    const rows = gestureRows(draft(), 'win32', '')
    expect(rows.filter(row => row.locked).map(row => row.source)).toEqual(rows.filter(row => row.locked).map(() => 'builtin'))
    expect(rows.find(row => row.id === 'documentTabs.rename')?.source).toBe('builtin')
    expect(ids(gestureRows(draft(), 'win32', '@source:built'))).toContain('documentTabs.rename')
    expect(ids(gestureRows(draft(), 'win32', '@source:fixed'))).toContain('documentTabs.rename')
  })
  it('show a choice only another platform offers as a change that Reset removes', () => {
    // ⌘ is macOS's own choice for Toggle Docking; a hand-edited file can carry it to Windows.
    const file = draft({ 'dock.toggleFloat': 'meta' })
    const row = gestureRows(file, 'win32', '').find(entry => entry.id === 'dock.toggleFloat')!
    expect(row).toMatchObject({ label: 'Ctrl+Double-click', currentToken: 'ctrl', changed: true, otherPlatform: true })
    expect(setGesture(file, 'dock.toggleFloat', undefined, 'win32').gestures).toEqual({})
    // On macOS it is the default, which the file never needs: it applies, and nothing is flagged.
    expect(gestureRows(file, 'darwin', '').find(entry => entry.id === 'dock.toggleFloat')).not.toHaveProperty('otherPlatform')
  })
  it('label keyboard paths from the draft, so a key changed on the page shows before OK', () => {
    const peek = (file: ShortcutFile) => gestureRows(file, 'win32', '').find(row => row.id === 'explorer.peekHover')!.keys
    expect(peek(draft())).toEqual([{ command: 'explorer.peek', label: expect.objectContaining({ text: 'Alt+F12' }) }])
    const remapped: ShortcutFile = { ...draft(), bindings: [{ command: 'explorer.peek', key: 'alt+f12', remove: true }, { command: 'explorer.peek', key: 'ctrl+shift+f12' }] }
    expect(peek(remapped)[0].label?.text).toBe('Ctrl+Shift+F12')
  })
})

describe('MouseView', () => {
  const render = (props: Partial<Parameters<typeof MouseView>[0]> = {}) =>
    renderToStaticMarkup(createElement(MouseView, { draft: draft(), onChange: () => {}, platform: 'linux', search: '', ...props }))
  it('draws a dropdown per remappable row, locks fixed rows with their reason, and links the editor setting', () => {
    const html = render({ draft: draft({ 'dock.floatWhileDragging': 'alt' }), onOpenPage: () => {} })
    expect(html).toContain('aria-label="Float While Dragging: modifier"')
    expect(html).toMatch(/<option value="alt" selected="">Alt<\/option>/)
    expect(html).toContain('<option value="off">Off</option>')
    expect(html).toContain('Many Linux desktops move the window on Alt+drag')
    expect(html).toContain('aria-label="Reset Float While Dragging to Ctrl"')
    expect(html).toContain('Shift extends a selection everywhere')
    expect(html).toContain('data-icon="lock"')
    expect(html).not.toContain('aria-label="Rename Tab: modifier"')
    // The linked setting shows its saved value and opens its page.
    expect(html).toContain('Ctrl+Click · <button type="button" class="mouse-link">Text Editor › General</button>')
    expect(html).toContain('Keyboard: Peek <span class="keybinding" role="img" aria-label="Alt+F12">')
    // Float has no key of its own (its context menu reaches it): the title alone.
    expect(html).toContain('<span class="mouse-keyboard">Keyboard: Float, Float Editor</span>')
  })
  it('keeps the row header to the title and reads the details with the dropdown', () => {
    const html = render()
    expect(html).toContain('<th scope="row"><span class="mouse-gesture"><span class="mouse-dot" aria-hidden="true"></span><span class="mouse-title">Peek on Hover</span></span></th>')
    expect(html).toContain('aria-describedby="mouse-explorer-peekHover-about"')
    expect(html).toContain('<span class="mouse-about" id="mouse-explorer-peekHover-about">Peeks a table')
  })
  it("shows the Options dialog's draft value of the linked setting when it is given", () => {
    // The mocked saved setting is Ctrl+Click; the page's draft says Alt+Click.
    expect(render({ multiCursorModifier: 'alt' })).toContain('<span class="mouse-binding-text">Alt+Click · Text Editor › General</span>')
  })
  it('says when nothing matches the search', () => {
    expect(render({ search: 'no such gesture' })).toBe('<p class="mouse-empty" role="status">No gestures match.</p>')
  })
})
