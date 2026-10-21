import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type UIEvent } from 'react'
import { systemTypes } from '../../../shared/designer/catalog.ts'
import { defaultType, formatTypeText } from '../../../shared/designer/type-text.ts'
import { useWorkbench } from '../core/WorkbenchContext'
import { useMenuTarget } from '../menus/useMenuTarget'
import { selectorPress, TableDesignerService, type DesignerColumn, type DesignerState } from './TableDesignerService'

/** Every row has one height, so only the rows in view (and a few more) are rendered. */
export const designerRowHeight = 22
const overscan = 8
const columns: readonly DesignerColumn[] = ['name', 'type', 'nulls']
const headers: Readonly<Record<DesignerColumn, string>> = { name: 'Column Name', type: 'Data Type', nulls: 'Allow Nulls' }
/** SSMS's Data Type list: each listed type with its defaults, and the (MAX) forms. */
export const typeChoices: readonly string[] = systemTypes.filter(type => !type.unlisted)
  .flatMap(type => [formatTypeText(defaultType(type)), ...type.listMax ? [formatTypeText({ system: type.name, max: true })] : []])

interface Editing { readonly row: number; readonly column: 'name' | 'type'; readonly text: string }

/** The rows [first, last) a viewport shows, with overscan, for a scroll offset and height. */
export function visibleRange(scrollTop: number, height: number, count: number): { readonly first: number; readonly last: number } {
  const first = Math.max(0, Math.floor(scrollTop / designerRowHeight) - overscan)
  return { first, last: Math.min(count, Math.ceil((scrollTop + height) / designerRowHeight) + overscan) }
}

/**
 * The designer's column grid: a row selector, Column Name, Data Type and Allow Nulls, and the empty last row that adds a
 * column. It is not GridView (a read-only viewer of the results worker's pages): it edits at most 1,025 rows held in the
 * renderer, with one native field at a time (IME and assistive technology work as in any field) and native checkboxes.
 * Only the rows in view render. Keys reach it through React after the workbench dispatcher, so Ctrl+S, F4 and Ctrl+Tab
 * still work; names show only as React text and input values.
 */
export default function DesignerGrid({ state, service, editable }: { state: DesignerState; service: TableDesignerService; editable: boolean }) {
  const id = state.id
  const root = useRef<HTMLDivElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const [editing, setEditingState] = useState<Editing>()
  // Read synchronously: Escape, then the blur its refocus causes, must not commit what Escape discarded.
  const live = useRef<Editing | undefined>(undefined)
  const setEditing = (value: Editing | undefined) => { live.current = value; setEditingState(value) }
  const [view, setView] = useState({ top: 0, height: 400 })
  const count = state.rows.length + 1
  const problems = useMemo(() => TableDesignerService.design(state).problems, [state])
  const problemAt = (row: number, column: DesignerColumn) => problems.find(problem => problem.row === row && (column === 'name' ? problem.property === 'name'
    : column === 'type' ? problem.property === 'dataType' || problem.property === 'identity' : problem.property === 'allowNulls'))?.message
  const menuRef = useMenuTarget<HTMLDivElement>(() => ({ kind: 'tableDesigner', tabId: id }))
  const setRoot = (element: HTMLDivElement | null) => { root.current = element; menuRef(element) }
  const { platform } = useWorkbench()

  useLayoutEffect(() => {
    const element = body.current
    if (!element) return
    const measure = () => setView(current => current.height === element.clientHeight ? current : { ...current, height: element.clientHeight })
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [])
  // The current row stays in view as the keys move it.
  useEffect(() => {
    const element = body.current
    if (!element) return
    const top = state.current.row * designerRowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + designerRowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + designerRowHeight - element.clientHeight
  }, [state.current.row])

  const focusGrid = () => root.current?.focus({ preventScroll: true })
  const begin = (row: number, column: DesignerColumn, text?: string) => {
    if (!editable || column === 'nulls' || (row >= state.rows.length && column !== 'name')) return
    service.setCurrent(id, row, column)
    const current = row < state.rows.length ? (column === 'name' ? state.rows[row].name : state.rows[row].typeText) : ''
    setEditing({ row, column, text: text ?? current })
  }
  const commit = () => {
    const value = live.current
    setEditing(undefined)
    if (value) service.setCell(id, value.row, value.column, value.text)
  }
  const move = (row: number, column: DesignerColumn) => service.setCurrent(id, row, column)
  // Ctrl+S reaches the workbench before the cell's field blurs: Save and Generate Change Script commit what it holds first.
  useEffect(() => {
    const registration = service.registerEditor(id, () => {
      const value = live.current
      if (!value) return
      setEditing(undefined)
      service.setCell(id, value.row, value.column, value.text)
      root.current?.focus({ preventScroll: true })
    })
    return () => registration.dispose()
  }, [service, id])

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    const { row, column } = state.current, col = columns.indexOf(column), mod = event.ctrlKey || event.metaKey
    if (editing) {
      if (event.key === 'Escape') { event.preventDefault(); setEditing(undefined); focusGrid() }
      else if (event.key === 'Enter') { event.preventDefault(); commit(); focusGrid() }
      else if (event.key === 'Tab') {
        event.preventDefault()
        commit()
        const next = col + (event.shiftKey ? -1 : 1)
        move(next < 0 ? Math.max(0, row - 1) : next >= columns.length ? Math.min(count - 1, row + 1) : row, columns[(next + columns.length) % columns.length])
        focusGrid()
      }
      return
    }
    const page = Math.max(1, Math.floor(view.height / designerRowHeight) - 1)
    let handled = true
    switch (event.key) {
      case 'ArrowDown':
        if (event.altKey && column === 'type') begin(row, 'type')
        else move(Math.min(count - 1, row + 1), column)
        break
      case 'ArrowUp': move(Math.max(0, row - 1), column); break
      case 'ArrowLeft': move(row, columns[Math.max(0, col - 1)]); break
      case 'ArrowRight': move(row, columns[Math.min(columns.length - 1, col + 1)]); break
      case 'Home': move(mod ? 0 : row, mod ? column : columns[0]); break
      case 'End': move(mod ? count - 1 : row, mod ? column : columns[columns.length - 1]); break
      case 'PageDown': move(Math.min(count - 1, row + page), column); break
      case 'PageUp': move(Math.max(0, row - page), column); break
      case 'Tab': {
        const next = col + (event.shiftKey ? -1 : 1)
        if ((next < 0 && row === 0) || (next >= columns.length && row === count - 1)) { handled = false; break }
        move(next < 0 ? row - 1 : next >= columns.length ? row + 1 : row, columns[(next + columns.length) % columns.length])
        break
      }
      case 'F2': case 'Enter': begin(row, column); break
      case ' ':
        if (column === 'nulls' && row < state.rows.length && editable) service.toggleNulls(id, row)
        else handled = false
        break
      default:
        // Typing starts editing the cell with the character typed, as in SSMS's grid.
        if (event.key.length === 1 && !mod && !event.altKey && column !== 'nulls') begin(row, column, event.key)
        else handled = false
    }
    if (handled) event.preventDefault()
  }

  const scroll = (event: UIEvent<HTMLDivElement>) => { const top = event.currentTarget.scrollTop; setView(current => current.top === top ? current : { ...current, top }) }
  const { first, last } = visibleRange(view.top, view.height, count)
  const selector = (event: ReactPointerEvent, row: number) => {
    const mode = selectorPress(event, platform, state.selected.includes(state.rows[row]?.key ?? -1))
    if (mode) service.select(id, row, mode)
  }
  const current = state.current
  const activeId = `${id}-cell-${current.row}-${current.column}`

  return <div ref={setRoot} className="designer-grid" role="grid" aria-label="Columns" aria-rowcount={count + 1} aria-colcount={4} aria-multiselectable="true" tabIndex={0}
    data-designer-focus="" aria-activedescendant={editing ? undefined : activeId} onKeyDown={keyDown}>
    <div className="designer-grid-head" role="row" aria-rowindex={1}>
      <span className="designer-selector" role="columnheader" aria-label="Row selector" />
      {columns.map(column => <span key={column} className={`designer-cell designer-${column}`} role="columnheader">{headers[column]}</span>)}
    </div>
    <div ref={body} className="designer-grid-body" onScroll={scroll}>
      <div style={{ height: count * designerRowHeight, position: 'relative' }}>
        {Array.from({ length: last - first }, (_, offset) => {
          const index = first + offset, row = state.rows[index], placeholder = !row
          const selected = !!row && state.selected.includes(row.key), key = !!row && state.primaryKey.includes(row.key)
          return <div key={row?.key ?? 'new'} className="designer-row" role="row" aria-rowindex={index + 2} aria-selected={selected} data-selected={selected || undefined}
            data-current={index === current.row || undefined} style={{ top: index * designerRowHeight, height: designerRowHeight }}>
            <span className="designer-selector" role="rowheader" aria-label={placeholder ? 'New column' : `${row.name || 'Unnamed column'}${key ? ', primary key' : ''}`}
              onPointerDown={event => selector(event, index)}>
              {key ? <span className="codicon codicon-key" aria-hidden="true" /> : index === current.row ? <span className="codicon codicon-triangle-right" aria-hidden="true" /> : null}
            </span>
            {columns.map(column => {
              const cellId = `${id}-cell-${index}-${column}`, problem = row ? problemAt(index, column) : undefined
              const isEditing = editing?.row === index && editing.column === column
              const common = { id: cellId, role: 'gridcell', 'aria-colindex': columns.indexOf(column) + 2, 'aria-selected': index === current.row && column === current.column,
                'aria-describedby': problem ? cellId + '-problem' : undefined, 'data-active': (index === current.row && column === current.column) || undefined, 'data-invalid': problem ? true : undefined }
              if (column === 'nulls') {
                const locked = !row || service.nullsLocked(state, row)
                return <span key={column} {...common} className="designer-cell designer-nulls" onPointerDown={() => move(index, column)}>
                  {row && <input type="checkbox" tabIndex={-1} aria-label={`Allow Nulls for ${row.name || 'the unnamed column'}`} checked={row.allowNulls} disabled={!editable || locked}
                    onChange={() => { service.toggleNulls(id, index); focusGrid() }} />}
                  {problem && <span className="designer-problem codicon codicon-error" id={cellId + '-problem'} role="img" aria-label={problem} title={problem} />}
                </span>
              }
              const text = row ? (column === 'name' ? row.name : row.typeText) : ''
              return <span key={column} {...common} className={`designer-cell designer-${column}`} onPointerDown={() => move(index, column)} onDoubleClick={() => begin(index, column)}>
                {isEditing
                  ? <input className="designer-editor" autoFocus aria-label={headers[column]} value={editing.text} list={column === 'type' ? `${id}-types` : undefined} spellCheck={false}
                    onChange={event => setEditing({ ...editing, text: event.target.value })} onBlur={() => commit()}
                    onFocus={event => { const end = event.currentTarget.value.length; event.currentTarget.setSelectionRange(end, end) }} />
                  : <span className="designer-text">{text}</span>}
                {problem && !isEditing && <span className="designer-problem codicon codicon-error" id={cellId + '-problem'} role="img" aria-label={problem} title={problem} />}
              </span>
            })}
          </div>
        })}
      </div>
    </div>
    <datalist id={`${id}-types`}>{typeChoices.map(choice => <option key={choice} value={choice} />)}</datalist>
  </div>
}
