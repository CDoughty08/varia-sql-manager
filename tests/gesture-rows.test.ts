import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { emptyShortcutFile, type ShortcutFile } from '../src/shared/commands/shortcut-schema'
import { gestureRows, setGesture } from '../src/renderer/src/settings/shortcuts/gesture-rows'
import MouseView from '../src/renderer/src/settings/shortcuts/MouseView'

// The view reads the linked editor setting and command keys from the workbench, which server rendering has no store for.
vi.mock('../src/renderer/src/core/WorkbenchContext', async original => ({
  ...await original<object>(),
  useWorkbench: () => ({ settings: {}, keybindings: { lookup: () => ({ parts: ['F2'], aria: 'F2' }) } }),
  useServiceSelector: () => 'ctrlCmd'
}))

const draft = (gestures: Record<string, string> = {}): ShortcutFile => ({ ...emptyShortcutFile, gestures })
const ids = (rows: readonly { id: string }[]) => rows.map(row => row.id)

describe('gesture rows', () => {
  it('list every gesture of the platform by group, with its choices, lock and keyboard path', () => {
    const rows = gestureRows(draft(), 'win32', '')
    expect(rows.map(row => row.group)).toEqual(['modifier', 'modifier', 'modifier', 'pointerCommand', 'pointerCommand', 'pointerCommand', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'linked'])
    // macOS's Control+click is a right-click there only.
    expect(ids(rows)).not.toContain('grid.secondaryClick')
    expect(ids(gestureRows(draft(), 'darwin', ''))).toContain('grid.secondaryClick')
    const float = rows.find(row => row.id === 'dock.floatWhileDragging')!
    expect([float.binding, float.source, float.modified, float.options.map(option => option.label)]).toEqual(['Ctrl+Drag', 'default', false, ['Ctrl', 'Alt', 'Off']])
    const toggle = gestureRows(draft(), 'darwin', '').find(row => row.id === 'dock.toggleFloat')!
    expect([toggle.binding, toggle.options.map(option => option.label), toggle.keyboard]).toEqual(['⌘ Double-click', ['⌘', '⌥', '⇧', 'None'], ['pane.float', 'pane.dock']])
    const fit = rows.find(row => row.id === 'grid.fitColumn')!
    expect([fit.source, fit.options, fit.locked]).toEqual(['fixed', [], 'Double-clicking a column border fits it, as in SSMS.'])
    const rename = rows.find(row => row.id === 'documentTabs.rename')!
    expect([rename.group, rename.options, rename.locked]).toEqual(['pointerCommand', [], expect.stringContaining('F2 renames')])
    expect(rows.at(-1)).toMatchObject({ id: 'textEditor.multiCursorModifier', binding: 'Alt+Click', source: 'setting', page: 'textEditor.general' })
    expect(gestureRows(draft(), 'darwin', '', { multiCursorModifier: 'ctrlCmd' }).at(-1)).toMatchObject({ binding: '⌘ Click', modified: true })
  })
  it('follow edits to the draft, which keeps only changes, and reset per row', () => {
    let file = setGesture(draft({ 'later.gesture': 'alt' }), 'dock.floatWhileDragging', ['alt'], 'linux')
    file = setGesture(file, 'explorer.peekHover', null, 'linux')
    expect(file.gestures).toEqual({ 'later.gesture': 'alt', 'dock.floatWhileDragging': 'alt', 'explorer.peekHover': 'off' })
    const rows = gestureRows(file, 'linux', '')
    expect(rows.find(row => row.id === 'dock.floatWhileDragging')).toMatchObject({ binding: 'Alt+Drag', currentToken: 'alt', source: 'user', modified: true, problems: [expect.objectContaining({ code: 'linuxAlt', severity: 'warning' })] })
    expect(rows.find(row => row.id === 'explorer.peekHover')).toMatchObject({ binding: 'Off', currentToken: 'off', modified: true })
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
    expect(ids(gestureRows(file, 'win32', 'object explorer peek'))).toEqual(['explorer.peekHover'])
    expect(gestureRows(file, 'win32', '@kind:keyboard')).toEqual([])
    expect(gestureRows(file, 'win32', 'nothing like this')).toEqual([])
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
    expect(html).toContain('Keyboard: Float <span class="keybinding"')
  })
  it('says when nothing matches the search', () => {
    expect(render({ search: 'no such gesture' })).toBe('<p class="mouse-empty" role="status">No gestures match.</p>')
  })
})
