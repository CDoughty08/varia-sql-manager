import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { pageById, pagePath, type SettingKey } from '../../../shared/settings/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { trapFocus } from '../trap-focus'
import {
  ancestorIds, draftFrom, firstPage, pageForm, patchFrom, resetPage, rowNotes, setDraftValue, settingGridRow, treeRows, validateDraft, type OptionsDraft, type RowGroup, type SettingRow
} from './options-form'
import PropertyGrid, { controlId } from './PropertyGrid'
import { highlightParts, searchPages } from './search'

const errorText = (error: unknown) => error instanceof Error && error.message ? error.message : 'The options could not be saved.'
/** Fonts and Colors names the display item its rows are for, as SSMS's "Show settings for" list does (fixed for now). */
const groupHeading = (pageId: string, label: string) => pageId === 'environment.fontsAndColors' ? `Show settings for: ${label}` : label

interface RowProps { row: SettingRow; error?: string; focused: boolean; label: ReactNode; onFocus(): void; onChange(text: string): void }
/** A form row: a checkbox with its label, a number field with its unit, a list, or radio buttons. */
function FormRow({ row, error, focused, label, onFocus, onChange }: RowProps) {
  const { def } = row, id = controlId(row.key)
  const common = { id, disabled: row.disabled, 'data-setting': row.key, 'aria-description': def.description, onFocus }
  let control: ReactNode
  if (def.type === 'boolean') control = <label className="options-check"><input {...common} type="checkbox" checked={row.value === 'true'} onChange={event => onChange(String(event.target.checked))} />{label}</label>
  else if (def.type === 'integer') {
    control = <><label htmlFor={id}>{label}</label><span className="options-number">
      <input {...common} type="number" step={1} min={def.min} max={def.max} value={row.value} aria-invalid={error ? true : undefined} aria-errormessage={error ? id + '-error' : undefined}
        onChange={event => onChange(event.target.value)} />{def.unit && <span>{def.unit}</span>}</span></>
  } else if (def.presentation === 'radio') {
    control = <fieldset className="options-radios" disabled={row.disabled}><legend>{label}</legend>
      {def.values.map((choice, index) => <label key={choice.value}><input type="radio" name={id} value={choice.value} checked={row.value === choice.value} onFocus={onFocus}
        {...index === 0 ? { id, 'data-setting': row.key } : {}} onChange={() => onChange(choice.value)} />{choice.label}</label>)}
    </fieldset>
  } else {
    control = <><label htmlFor={id}>{label}</label><select {...common} value={row.value} onChange={event => onChange(event.target.value)}>
      {def.values.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></>
  }
  return <div className="options-form-row" data-focused={focused || undefined} data-disabled={row.disabled || undefined} onPointerDown={onFocus}>
    {control}
    {error && <span className="options-field-error" id={id + '-error'}>{error}</span>}
  </div>
}

/**
 * SSMS's Tools › Options: a search box and the page tree on the left, the page on the right with its path above it,
 * and the focused row's description below. Changes on every page stay in one draft until OK saves the ones that differ
 * from what main stored; Cancel and Escape discard them, and focus returns to where it was.
 */
export default function OptionsDialog({ page: requested }: { page?: string }) {
  const { settings, platform } = useWorkbench()
  const { values } = useServiceSnapshot(settings)
  const [draft, setDraft] = useState<OptionsDraft>(() => draftFrom(values))
  const [page, setPage] = useState(() => firstPage(requested && pageById(requested) ? requested : 'environment.general'))
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(ancestorIds(page)))
  const [treeFocus, setTreeFocus] = useState(page)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState<string>()
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // Read while rendering, before the search box takes focus.
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const search = useRef<HTMLInputElement>(null), tree = useRef<HTMLUListElement>(null), focusSetting = useRef<string>(undefined)
  const found = useMemo(() => searchPages(query, platform), [query, platform])
  const rows = treeRows(expanded, found?.shown)
  const focusId = rows.some(row => row.page.id === treeFocus) ? treeFocus : rows.find(row => row.page.id === page)?.page.id ?? rows[0]?.page.id
  const form = pageForm(page, draft, platform)
  const shownRows = form.groups.flatMap(group => group.rows)

  useEffect(() => { settings.showedPage(page) }, [settings, page])
  // The tree keeps focus on the row it moved to; a field OK found invalid takes focus once its page shows.
  useEffect(() => { if (focusId && tree.current?.contains(document.activeElement)) tree.current.querySelector<HTMLElement>(`[data-page="${focusId}"]`)?.focus() }, [focusId])
  useEffect(() => {
    const key = focusSetting.current
    if (!key) return
    focusSetting.current = undefined
    document.getElementById(controlId(key))?.focus()
  })

  const restoreFocus = () => { if (returnFocus?.isConnected) returnFocus.focus() }
  // While OK's save is on its way the dialog stays: the changes cannot be cancelled any more.
  const close = () => {
    if (saving) return
    settings.closeDialog()
    restoreFocus()
  }
  /** Shows `id`'s first page with its path expanded; `node` is the tree row that keeps focus (a category stays focused). */
  const showPage = (id: string, node = firstPage(id)) => {
    const target = firstPage(id)
    setPage(target)
    setTreeFocus(node)
    setFocused(undefined)
    setExpanded(current => new Set([...current, ...ancestorIds(target), ...target === id ? [] : [id]]))
  }
  const changeQuery = (text: string) => {
    setQuery(text)
    const next = searchPages(text, platform)
    if (next?.pages.length && !next.pages.includes(page)) showPage(next.pages[0])
  }
  const change = (key: SettingKey, text: string) => {
    setDraft(current => setDraftValue(current, key, text))
    setErrors(current => { if (!current.has(key)) return current; const next = new Map(current); next.delete(key); return next })
    setError('')
  }
  const ok = async () => {
    if (saving) return
    const result = validateDraft(draft)
    if (!result.ok) {
      const [first] = result.errors
      setErrors(new Map(result.errors.map(item => [item.key, item.message])))
      if (first.page !== page) showPage(first.page)
      focusSetting.current = first.key
      setFocused(first.key)
      setError('')
      return
    }
    setErrors(new Map())
    const patch = patchFrom(settings.getSnapshot().values, result.values)
    if (!Object.keys(patch).length) { close(); return }
    setSaving(true); setError('')
    try {
      if (await settings.saveDialog(patch)) restoreFocus()
    } catch (failure) { setError(errorText(failure)); setSaving(false) }
  }
  const treeKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = rows.findIndex(row => row.page.id === focusId), row = rows[index]
    if (!row) return
    const move = (to: number) => { const next = rows[Math.max(0, Math.min(rows.length - 1, to))]; if (next) showPage(next.page.id, next.page.id) }
    const key = event.key
    if (key === 'ArrowDown') move(index + 1)
    else if (key === 'ArrowUp') move(index - 1)
    else if (key === 'Home') move(0)
    else if (key === 'End') move(rows.length - 1)
    else if (key === 'ArrowRight') {
      if (row.expandable && !row.expanded) setExpanded(current => new Set([...current, row.page.id]))
      else if (row.expanded) move(index + 1)
    } else if (key === 'ArrowLeft') {
      if (row.expanded && !found) setExpanded(current => { const next = new Set(current); next.delete(row.page.id); return next })
      else if (row.page.parent) showPage(row.page.parent, row.page.parent)
    } else if (key === 'Enter' || key === ' ') showPage(row.page.id, row.page.id)
    else return
    event.preventDefault()
    event.stopPropagation()
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    const target = event.target
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      // As in Visual Studio, Escape in a search box with text clears the search first.
      if (target === search.current && query) changeQuery('')
      else close()
    } else if (event.key.toLowerCase() === 'e' && (platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      search.current?.focus(); search.current?.select()
    } else if (target === search.current && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      event.preventDefault()
      tree.current?.querySelector<HTMLElement>(`[data-page="${focusId}"]`)?.focus()
    } else if (event.key === 'Enter' && !(target instanceof HTMLSelectElement) && !(target instanceof HTMLButtonElement)) { event.preventDefault(); void ok() }
  }

  const highlight = (label: string): ReactNode => found ? highlightParts(label, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text) : label
  const focusedRow = shownRows.find(row => row.key === focused)
  const described = focusedRow ? { title: focusedRow.def.label, text: focusedRow.def.description, notes: rowNotes(focusedRow.def) } : { title: form.page.title, text: form.page.description ?? '', notes: [] }
  const groups = (list: readonly RowGroup[]) => list.map((group, index) => <div key={group.label ?? index} className="options-group" role="group" aria-label={group.label}>
    {group.label && <div className="options-category">{groupHeading(form.page.id, group.label)}</div>}
    {group.rows.map(row => <FormRow key={row.key} row={row} error={errors.get(row.key)} focused={row.key === focused} label={highlight(row.def.label)} onFocus={() => setFocused(row.key)} onChange={text => change(row.key, text)} />)}
  </div>)

  // Focusable itself, so pressing a greyed row, a label or the description keeps focus (and Escape and Enter) in the dialog.
  return <div className="modal-backdrop"><form className="connection-modal options-dialog" role="dialog" aria-modal="true" aria-labelledby="options-title" noValidate tabIndex={-1}
    onSubmit={event => { event.preventDefault(); void ok() }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="options-title">Options</h2><button type="button" className="icon-button" aria-label="Close options" disabled={saving} onClick={close}><Icon name="close" /></button></div>
    <div className="options-body">
      <div className="options-nav">
        <input ref={search} type="search" className="options-search" placeholder={platform === 'darwin' ? 'Search Options (⌘E)' : 'Search Options (Ctrl+E)'} aria-label="Search Options"
          maxLength={256} value={query} autoFocus onChange={event => changeQuery(event.target.value)} />
        {found && !found.pages.length
          ? <p className="options-empty" role="status">No settings match.</p>
          : <ul ref={tree} className="options-pages" role="tree" aria-label="Options pages" onKeyDown={treeKeyDown}>
            {rows.map(row => <li key={row.page.id} role="treeitem" aria-level={row.level} aria-expanded={row.expandable ? row.expanded : undefined} aria-selected={row.page.id === page}
              tabIndex={row.page.id === focusId ? 0 : -1} data-page={row.page.id} style={{ paddingLeft: 4 + (row.level - 1) * 14 }}
              onClick={() => showPage(row.page.id, row.page.id)} onFocus={() => setTreeFocus(row.page.id)}>
              <span className="options-twisty">{row.expandable && <Icon name="chevron-right" />}</span>{highlight(row.page.title)}
            </li>)}
          </ul>}
      </div>
      <div className="options-page">
        <h3 className="options-heading">{pagePath(form.page.id).map(node => node.title).join(' › ')}</h3>
        {form.provider === 'theme' && <p className="options-note">{highlight('Color theme')}: View › Theme</p>}
        {/* A form page's own note (Fonts and Colors: where colors come from) stays above its rows. */}
        {form.page.layout !== 'propertyGrid' && form.page.description && <p className="options-note">{highlight(form.page.description)}</p>}
        {form.page.layout === 'propertyGrid'
          ? <PropertyGrid label={form.page.title} groups={form.groups.map(group => ({ ...group, rows: group.rows.map(settingGridRow) }))} idPrefix="setting-" focused={focused} errors={errors} onFocusRow={key => setFocused(key)} onChange={(key, text) => change(key as SettingKey, text)} renderLabel={highlight} />
          : <div className="options-form">{groups(form.groups)}</div>}
      </div>
    </div>
    <div className="options-description"><strong>{described.title}</strong>{described.text && <p>{described.text}</p>}{described.notes.map(note => <p key={note}>{note}</p>)}</div>
    {error && <p className="connect-error options-error" role="alert">{error}</p>}
    <div className="connection-footer">
      <button type="button" onClick={() => { setDraft(current => resetPage(current, page, platform)); setErrors(new Map()); setError('') }}>Reset to Defaults</button><span />
      <button className="primary" type="submit" disabled={saving}>OK</button><button type="button" disabled={saving} onClick={close}>Cancel</button>
    </div>
  </form></div>
}
