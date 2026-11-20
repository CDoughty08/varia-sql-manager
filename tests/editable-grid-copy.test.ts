// @vitest-environment happy-dom
// Editable grids (Table Designer, New Database, Restore, object dialog pages, Shortcut Mapping, Extended properties) copy
// their selected rows with Ctrl+C through the results text writer, headers as the copy setting says.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { cellText, copiesText, domCopyRows, useDomRowCopy } from '../src/renderer/src/grid/row-copy'
import { designerCopyRows } from '../src/renderer/src/designer/DesignerGrid'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { defaultSettings } from '../src/shared/settings/catalog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => { getSelection()?.removeAllRanges(); document.body.replaceChildren() })

const html = (markup: string) => { const host = document.createElement('div'); host.innerHTML = markup; document.body.append(host); return host }
// A New Database-like files table: fields, a list, a checkbox, a browse button, a placeholder default and a hidden Remove column.
const filesTable = () => html(`<table><thead><tr><th scope="col">Logical Name</th><th scope="col">File Type</th><th scope="col">Read-Only</th><th scope="col">Path</th><th scope="col">File Name</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>
  <tbody><tr data-selected="true"><td><input type="text" value="Sales"></td><td><select><option value="rows">ROWS Data</option><option value="log" selected>LOG</option></select></td>
  <td><input type="checkbox" checked></td><td><span><input type="text" value="C:\\Data"><button type="button">…</button></span></td><td><input type="text" value="" placeholder="Sales_log.ldf"></td><td><button type="button">Remove</button></td></tr>
  <tr><td><input type="text" value="Second"></td><td>ROWS Data</td><td><input type="checkbox"></td><td>  D:\\Data  </td><td><input type="text" value="Second.ndf"></td><td><button type="button">Remove</button></td></tr></tbody></table>`).querySelector('table')!

describe('editable grid rows read from the page', () => {
  it('copies the row a copy came from, as shown, without its untitled or hidden columns', () => {
    const table = filesTable()
    const second = table.querySelectorAll('tbody tr')[1].querySelector('input')!
    expect(domCopyRows(table, second)).toEqual({ columns: ['Logical Name', 'File Type', 'Read-Only', 'Path', 'File Name'], rows: [['Second', 'ROWS Data', 'No', 'D:\\Data', 'Second.ndf']] })
    // From the table itself: its selected row; a field's placeholder is the default it shows.
    expect(domCopyRows(table, table)?.rows).toEqual([['Sales', 'LOG', 'Yes', 'C:\\Data', 'Sales_log.ldf']])
  })

  it('follows a grid\'s active cell, prefers data-copy, and copies nothing from a group heading', () => {
    const grid = html(`<div role="grid" aria-activedescendant="c-1"><div role="row"><span role="columnheader">Map</span><span role="columnheader">Database</span></div>
      <div role="row"><span role="gridcell"><input type="checkbox"></span><span role="gridcell" id="c-0">master</span></div>
      <div role="row"><span role="gridcell"><input type="checkbox" checked></span><span role="gridcell" id="c-1" data-copy="Sales">Sales <svg aria-hidden="true"></svg><span aria-hidden="true">icon</span></span></div></div>`).firstElementChild!
    expect(domCopyRows(grid, grid)).toEqual({ columns: ['Map', 'Database'], rows: [['Yes', 'Sales']] })
    const shortcuts = html(`<table role="grid"><thead><tr><th scope="col">Command</th><th scope="col">Shortcut</th></tr></thead><tbody><tr><th colspan="2" scope="colgroup">Edit</th></tr>
      <tr aria-selected="true" tabindex="0"><td data-copy="Copy">Copy<span>edit.copy</span></td><td data-copy="Ctrl+C"><kbd>Ctrl</kbd><kbd>C</kbd></td></tr></tbody></table>`).querySelector('table')!
    expect(domCopyRows(shortcuts, shortcuts.querySelector('[colspan]'))).toBeUndefined()
    expect(domCopyRows(shortcuts, shortcuts.querySelector('[tabindex]'))?.rows).toEqual([['Copy', 'Ctrl+C']])
    expect(cellText(html('<span>a<button>x</button>  b<datalist><option>z</option></datalist></span>').firstElementChild!)).toBe('a b')
  })

  it('leaves out hidden reasons and error messages, and keeps the spaces in a value', () => {
    // Restore's backup sets: a reason only a screen reader hears; Extended properties: a field's error under it.
    expect(cellText(html('<div> <input type="checkbox"> <span hidden>Logs follow this backup.</span> </div>').firstElementChild!)).toBe('No')
    expect(cellText(html('<div><input type="text" value="MS_Description"><span class="property-field-error"><svg></svg>A property of that name exists.</span></div>').firstElementChild!)).toBe('MS_Description')
    expect(cellText(html('<div><p role="alert">Fix this</p>Kept</div>').firstElementChild!)).toBe('Kept')
    // A path or name copies exactly, its doubled and edge spaces included; layout whitespace around it does not.
    const field = html('<div>\n  <input type="text"> <button>…</button>\n</div>').firstElementChild!
    field.querySelector('input')!.value = ' C:\\My  Data '
    expect(cellText(field)).toBe(' C:\\My  Data ')
    expect(cellText(html('<div>  Read  only <input type="text" value="x"> after  </div>').firstElementChild!)).toBe('Read only x after')
    expect(cellText(html('<div><input type="hidden" value="secret"><span>shown</span></div>').firstElementChild!)).toBe('shown')
    // New Database's unset filegroup shows a blank choice (a no-break space): an empty cell, not an invisible character.
    expect(cellText(html('<div><select><option value="" selected>&nbsp;</option><option value="PRIMARY">PRIMARY</option></select></div>').firstElementChild!)).toBe('')
    // A default choice with text (Attach's Owner, <default>) copies as it shows.
    expect(cellText(html('<div><select><option value="" selected>&lt;default&gt;</option><option value="sa">sa</option></select></div>').firstElementChild!)).toBe('<default>')
  })

  it('leaves selected text and a field\'s selected text to the native copy, but copies the row from a bare caret', () => {
    const field = html('<input type="text" value="Sales">').querySelector('input')!
    field.setSelectionRange(1, 3)
    expect(copiesText(field)).toBe(true)
    field.setSelectionRange(2, 2)
    expect(copiesText(field)).toBe(false)
    expect(copiesText(html('<input type="checkbox">').querySelector('input'))).toBe(false)
    const text = html('<p>Selected words</p>')
    const range = document.createRange()
    range.selectNodeContents(text)
    getSelection()!.addRange(range)
    expect(copiesText(text)).toBe(true)
  })
})

describe('Table Designer copy', () => {
  it('copies the selected columns in row order, else the current one, never the new-column row', () => {
    const rows = [{ key: 1, name: 'Id', typeText: 'int', allowNulls: false }, { key: 2, name: 'Name', typeText: 'nvarchar(50)', allowNulls: true }, { key: 3, name: 'Notes', typeText: 'nvarchar(MAX)', allowNulls: true }]
    expect(designerCopyRows({ rows, selected: [3, 1], current: { row: 1, column: 'name' } })).toEqual({ columns: ['Column Name', 'Data Type', 'Allow Nulls'], rows: [['Id', 'int', 'No'], ['Notes', 'nvarchar(MAX)', 'Yes']] })
    expect(designerCopyRows({ rows, selected: [], current: { row: 1, column: 'type' } }).rows).toEqual([['Name', 'nvarchar(50)', 'Yes']])
    expect(designerCopyRows({ rows, selected: [], current: { row: 3, column: 'name' } }).rows).toEqual([])
    // A cell being edited copies the text it shows, before it is committed.
    expect(designerCopyRows({ rows, selected: [], current: { row: 1, column: 'name' } }, { row: 1, column: 'name', text: 'Price' }).rows).toEqual([['Price', 'nvarchar(50)', 'Yes']])
    expect(designerCopyRows({ rows, selected: [1, 2], current: { row: 1, column: 'type' } }, { row: 1, column: 'type', text: 'money' }).rows).toEqual([['Id', 'int', 'No'], ['Name', 'money', 'Yes']])
  })
})

describe('editable grid Copy', () => {
  async function mount(values: Partial<typeof defaultSettings>, platform = 'linux') {
    const writeClipboardText = vi.fn(async (_text: string) => ({ ok: true as const, value: undefined }))
    Object.assign(window, { varia: { writeClipboardText } })
    const workbench = { platform, settings: { getSnapshot: () => ({ values: { ...defaultSettings, ...values } }) } } as unknown as Workbench
    function Grid() {
      const copy = useDomRowCopy()
      return createElement('table', { onCopy: copy }, createElement('thead', null, createElement('tr', null, createElement('th', { scope: 'col' }, 'Name'), createElement('th', { scope: 'col' }, 'Value'))),
        createElement('tbody', null, createElement('tr', null, createElement('td', null, createElement('input', { type: 'text', defaultValue: 'MS_Description' })), createElement('td', null, 'Orders\ttable'))))
    }
    const host = document.createElement('div')
    document.body.append(host)
    await act(async () => createRoot(host).render(createElement(WorkbenchProvider, { workbench, children: createElement(Grid) })))
    const input = host.querySelector('input')!
    const copy = async () => {
      const event = new Event('copy', { bubbles: true, cancelable: true })
      await act(async () => { input.dispatchEvent(event) })
      await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalled())
      return { prevented: event.defaultPrevented, text: writeClipboardText.mock.calls.at(-1)![0] }
    }
    return { copy, input, writeClipboardText }
  }

  it('writes the row through the results writer, with headers only when the copy setting is on', async () => {
    const off = await mount({ 'queryResults.grid.saveColumnHeaders': true })
    expect(await off.copy()).toEqual({ prevented: true, text: 'MS_Description\tOrders table' })
    document.body.replaceChildren()
    const on = await mount({ 'queryResults.grid.copyColumnHeaders': true }, 'win32')
    expect(await on.copy()).toEqual({ prevented: true, text: 'Name\tValue\r\nMS_Description\tOrders table' })
  })

  it('leaves a field\'s selected text to the native copy', async () => {
    const { input, writeClipboardText } = await mount({})
    input.setSelectionRange(0, 2)
    const event = new Event('copy', { bubbles: true, cancelable: true })
    await act(async () => { input.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})

// Each grid's copy reaches its rows only through its onCopy: losing one would leave Ctrl+C there copying nothing, silently.
describe('editable grid Copy wiring', () => {
  const grids: Readonly<Record<string, number>> = {
    'src/renderer/src/new-database/NewDatabase.tsx': 2, 'src/renderer/src/dialogs/pages/AttachDatabasePage.tsx': 2, 'src/renderer/src/dialogs/pages/NewLoginPages.tsx': 1,
    'src/renderer/src/dialogs/pages/UserMappingPage.tsx': 1, 'src/renderer/src/dialogs/pages/SecurablesPage.tsx': 2, 'src/renderer/src/properties/TableProperties.tsx': 1,
    'src/renderer/src/restore/RestoreDatabase.tsx': 2, 'src/renderer/src/restore/RestoreFiles.tsx': 2, 'src/renderer/src/settings/shortcuts/ShortcutTable.tsx': 1
  }
  it('gives every editable grid a row Copy', () => {
    for (const [file, count] of Object.entries(grids)) {
      const source = readFileSync(file, 'utf8')
      expect(source.match(/onCopy=\{copyRow\}/g)?.length ?? 0, file).toBe(count)
      expect(source, file).toMatch(/const copyRow = use(Dom)?RowCopy\(/)
    }
    // An unbound command's Shortcut and Scope both show a muted dash and both copy as empty cells.
    const shortcuts = readFileSync('src/renderer/src/settings/shortcuts/ShortcutTable.tsx', 'utf8')
    expect(shortcuts).toContain("data-copy={binding?.label.text ?? ''}")
    expect(shortcuts).toContain("data-copy={binding ? binding.scopeTitle : ''}")
    expect(readFileSync('src/renderer/src/designer/DesignerGrid.tsx', 'utf8')).toMatch(/useRowCopy\(\(\) => designerCopyRows\(state, live\.current\)\)[\s\S]*onCopy=\{copy\}/)
  })
})
