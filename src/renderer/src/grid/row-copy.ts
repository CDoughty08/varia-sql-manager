import type { ClipboardEvent } from 'react'
import { useOptionalWorkbench } from '../core/WorkbenchContext'
import { onUnexpectedError } from '../core/errors'
import { localTableCopyText, type LocalCell } from '../../../shared/results/local-table'
import { beginCopy, latestCopy } from './copy-generation'

/** An editable grid's rows as Copy writes them: its column titles and each row's text as shown. */
export interface CopyRows { readonly columns: readonly string[]; readonly rows: readonly (readonly LocalCell[])[] }

/** A checkbox cell's text, as the local grids write a yes/no fact. */
export const checkText = (checked: boolean) => checked ? 'Yes' : 'No'

/** Rows copied as a results grid copies them: tab-separated through the results text writer, after a header line when `headers`. */
export const rowsCopyText = (table: CopyRows, o: { headers: boolean; crlf: boolean }) =>
  localTableCopyText({ columns: table.columns.map(name => ({ name })), rows: table.rows }, o)

const textFields = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])
/**
 * Whether a copy belongs to text, which copies natively: a field with text selected in it (or one whose selection cannot be
 * read, a number field's), or text selected in the page. A caret with nothing selected copies the row instead.
 */
export function copiesText(target: EventTarget | null): boolean {
  const element = target as Element | null
  if (element?.closest?.('[contenteditable]:not([contenteditable="false"])')) return true
  if (element?.matches?.('textarea') || (element?.matches?.('input') && textFields.has((element as HTMLInputElement).type))) {
    const field = element as HTMLInputElement
    try { return field.selectionStart === null || field.selectionEnd === null || field.selectionStart !== field.selectionEnd } catch { return true }
  }
  const selection = element?.ownerDocument?.getSelection()
  return !!selection && !selection.isCollapsed && selection.toString() !== ''
}

const rowSelector = 'tr, [role="row"]'
const cellSelector = 'td, th, [role="gridcell"], [role="rowheader"], [role="columnheader"]'
const isElement = (node: Node | null | undefined): node is Element => node?.nodeType === 1
/**
 * A cell's text as shown: a field's value (else its placeholder, as File Name shows its default), a list's chosen option, a
 * checkbox as Yes or No, and the rest of its text, leaving out buttons, hidden text and icons. `data-copy` overrides it.
 */
export function cellText(cell: Element): string {
  const override = cell.getAttribute('data-copy')
  if (override !== null) return override
  let text = ''
  const walk = (node: Node) => {
    if (node.nodeType === 3) { text += node.nodeValue ?? ''; return }
    if (!isElement(node) || node.matches('button, datalist, template, .visually-hidden, [aria-hidden="true"]')) return
    if (node.matches('input')) {
      const input = node as HTMLInputElement
      text += input.type === 'checkbox' || input.type === 'radio' ? checkText(input.checked) : input.value || input.placeholder
      return
    }
    if (node.matches('textarea')) { text += (node as HTMLTextAreaElement).value; return }
    if (node.matches('select')) { const select = node as HTMLSelectElement; text += select.options[select.selectedIndex]?.textContent ?? ''; return }
    node.childNodes.forEach(walk)
  }
  walk(cell)
  return text.replace(/\s+/g, ' ').trim()
}
const cellsOf = (row: Element) => [...row.children].filter(child => child.matches(cellSelector))
const isHeaderRow = (row: Element) => cellsOf(row).every(cell => cell.matches('th[scope="col"], [role="columnheader"]'))

/**
 * The row an editable grid's copy is about, read from the page: the row the copy came from, else the grid's selected or active
 * row, with the grid's column titles. A column without a title (a row selector, a hidden Remove column) is left out, and a
 * row whose cells do not line up with the titles (a group heading) copies nothing.
 */
export function domCopyRows(grid: Element, from: EventTarget | null): CopyRows | undefined {
  const inGrid = (row: Element | null | undefined) => row && grid.contains(row) && !isHeaderRow(row) ? row : undefined
  const active = grid.getAttribute('aria-activedescendant')
  const row = inGrid(isElement(from as Node) ? (from as Element).closest(rowSelector) : undefined)
    ?? inGrid(active ? grid.ownerDocument.getElementById(active)?.closest(rowSelector) : undefined)
    ?? inGrid(grid.querySelector('[aria-selected="true"][role="row"], tr[aria-selected="true"], [data-selected][role="row"], tr[data-selected]'))
  const head = [...grid.querySelectorAll(rowSelector)].find(isHeaderRow)
  if (!row || !head) return undefined
  const titles = cellsOf(head).map(cellText), cells = cellsOf(row)
  if (cells.length !== titles.length) return undefined
  const kept = titles.flatMap((title, index) => title ? [index] : [])
  return { columns: kept.map(index => titles[index]), rows: [kept.map(index => cellText(cells[index]))] }
}

/** `useRowCopy` for a grid whose copy is the row it is on, read from the page (`domCopyRows`). */
export function useDomRowCopy(): (event: ClipboardEvent<HTMLElement>) => void {
  let event: ClipboardEvent<HTMLElement> | undefined
  const copy = useRowCopy(() => event ? domCopyRows(event.currentTarget, event.target) : undefined)
  return next => { event = next; try { copy(next) } finally { event = undefined } }
}

/**
 * An editable grid's Copy: Ctrl+C (⌘C on macOS) and Edit › Copy reach the focused grid as a copy event, which writes `rows()`
 * (its selected rows) as a results grid's copy, with a header line when Include column headers when copying the results is
 * on. A field being edited, or selected text, copies its text as usual; a grid with no rows to copy leaves the event alone.
 */
export function useRowCopy(rows: () => CopyRows | undefined): (event: ClipboardEvent<HTMLElement>) => void {
  const workbench = useOptionalWorkbench()
  return event => {
    try {
      if (copiesText(event.target)) return
      const table = rows()
      if (!table?.rows.length) return
      event.preventDefault()
      const headers = workbench?.settings.getSnapshot().values['queryResults.grid.copyColumnHeaders'] ?? false
      const crlf = (workbench?.platform ?? (navigator.userAgent.includes('Windows') ? 'win32' : 'linux')) === 'win32'
      // Only the latest copy of any grid writes the clipboard.
      const copy = beginCopy()
      void rowsCopyText(table, { headers, crlf }).then(async text => {
        if (!latestCopy(copy)) return
        const written = await window.varia.writeClipboardText(text)
        if (!written.ok) throw new Error(written.error)
      }).catch(onUnexpectedError)
    } catch (error) { onUnexpectedError(error) }
  }
}
