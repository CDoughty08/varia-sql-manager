import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { pageById, pagePath, type SettingKey } from '../../../shared/settings/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import DialogWindow, { DialogHeading } from '../popouts/DialogWindow'
import { trapFocus } from '../trap-focus'
import {
  ancestorIds, commitOptions, draftFrom, firstPage, pageForm, patchFrom, resetPage, rowNotes, setDraftValue, settingGridRow, treeRows, validateDraft, type OptionsDraft, type RowGroup, type SettingRow
} from './options-form'
import PropertyGrid, { controlId } from './PropertyGrid'
import { highlightParts, searchPages } from './search'
import { focusToReturn, isElement, returnFocusTo } from '../core/focus'
import { useShortcuts, useShortcutsSnapshot } from '../core/ShortcutsContext'
import type { ShortcutFile } from '../../../shared/commands/shortcut-schema'
import type { CaptureSource } from './shortcuts/CaptureField'
import ShortcutsPage from './shortcuts/ShortcutsPage'
import { followStored, gestureClash, saveRevision, shortcutsToSave, stagedChanges, startShortcutEdit, type ShortcutEdit } from './shortcuts/shortcut-draft'

const shortcutsPage = 'environment.shortcuts'
/** Fonts and Colors names the display item its rows are for, as SSMS's "Show settings for" list does (fixed for now). */
const groupHeading = (pageId: string, label: string) => pageId === 'environment.fontsAndColors' ? `Show settings for: ${label}` : label

interface RowProps { row: SettingRow; error?: string; focused: boolean; label: ReactNode; onFocus(): void; onChange(text: string): void }
/** What follows a control in the hint column: an integer's unit, then the setting's hint ("GiB · 0 = automatic"). */
export const rowHint = (row: SettingRow): string => [row.def.type === 'integer' ? row.def.unit : undefined, row.def.hint].filter(Boolean).join(' · ')
/**
 * A form row on the page's grid (label, control, hint columns): a checkbox with its label across the first two, a number
 * field or a list after its label, or radio buttons after theirs.
 */
function FormRow({ row, error, focused, label, onFocus, onChange }: RowProps) {
  const { def } = row, id = controlId(row.key), hint = rowHint(row)
  const common = { id, disabled: row.disabled, 'data-setting': row.key, 'aria-description': def.description, onFocus }
  let control: ReactNode
  if (def.type === 'boolean') control = <label className="options-check"><input {...common} type="checkbox" checked={row.value === 'true'} onChange={event => onChange(String(event.target.checked))} /><span>{label}</span></label>
  else if (def.type === 'integer') {
    control = <><label className="options-label" htmlFor={id}>{label}</label>
      <input {...common} className="options-control" type="number" step={1} min={def.min} max={def.max} value={row.value} aria-invalid={error ? true : undefined} aria-errormessage={error ? id + '-error' : undefined}
        onChange={event => onChange(event.target.value)} /></>
  } else if (def.presentation === 'radio') {
    control = <><span className="options-label" id={id + '-label'}>{label}</span><div className="options-radios" role="radiogroup" aria-labelledby={id + '-label'} aria-disabled={row.disabled || undefined}>
      {def.values.map((choice, index) => <label key={choice.value}><input type="radio" name={id} value={choice.value} checked={row.value === choice.value} disabled={row.disabled} onFocus={onFocus}
        {...index === 0 ? { id, 'data-setting': row.key } : {}} onChange={() => onChange(choice.value)} />{choice.label}</label>)}
    </div></>
  } else {
    control = <><label className="options-label" htmlFor={id}>{label}</label><select {...common} className="options-control" value={row.value} onChange={event => onChange(event.target.value)}>
      {def.values.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></>
  }
  return <div className="options-form-row" data-focused={focused || undefined} data-disabled={row.disabled || undefined} onPointerDown={onFocus}>
    {control}
    {hint && !(def.type === 'enum' && def.presentation === 'radio') && <span className="options-hint">{hint}</span>}
    {error && <span className="options-field-error" id={id + '-error'}>{error}</span>}
  </div>
}

/**
 * SSMS's Tools › Options: a search box and the page tree on the left, the page on the right with its path above it,
 * and the focused row's description below. Changes on every page stay in one draft until OK saves the ones that differ
 * from what main stored; Cancel and Escape discard them, and focus returns to where it was.
 */
export default function OptionsDialog({ page: requested, setting }: { page?: string; setting?: string }) {
  const { settings, platform, keybindings, documents } = useWorkbench()
  const { values } = useServiceSnapshot(settings)
  const [draft, setDraft] = useState<OptionsDraft>(() => draftFrom(values))
  // The Shortcuts page's edits: a second draft, saved after the settings by OK.
  const shortcuts = useShortcuts()
  const shortcutsState = useShortcutsSnapshot()
  const [shortcutEdit, setShortcutEdit] = useState<ShortcutEdit>(() => startShortcutEdit(shortcuts.getSnapshot()))
  const shortcutDraft = shortcutEdit.draft
  const setShortcutDraft = (draft: ShortcutFile) => setShortcutEdit(edit => ({ ...edit, draft }))
  // Main re-reads the file on every get, so opening the dialog sees a hand edit before the user starts editing.
  useEffect(() => { void shortcuts.reload() }, [shortcuts])
  useEffect(() => { setShortcutEdit(edit => followStored(edit, shortcutsState)) }, [shortcutsState])
  const staged = stagedChanges(shortcutDraft, shortcutEdit.base.file)
  // The Mouse view shows the linked Text Editor setting as this dialog's draft has it, before OK.
  const linked = { multiCursorModifier: draft['textEditor.multiCursorModifier'] === 'ctrlCmd' ? 'ctrlCmd' as const : 'alt' as const }
  // KeybindingService.capture routes every key but Tab to the capture box while it records, so it stays the only key listener.
  const capture = useMemo<CaptureSource>(() => (onChord, options) => keybindings.capture(onChord, options), [keybindings])
  const [page, setPage] = useState(() => firstPage(requested && pageById(requested) ? requested : 'environment.general'))
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(ancestorIds(page)))
  const [treeFocus, setTreeFocus] = useState(page)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState<string>()
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // Read while rendering, before the search box takes focus.
  const [returnFocus] = useState(focusToReturn)
  const search = useRef<HTMLInputElement>(null), tree = useRef<HTMLUListElement>(null), focusSetting = useRef<string | undefined>(setting)
  // Tools › Options… again while the dialog is open: its window comes forward, on the page asked for.
  const request = useServiceSnapshot(settings.dialog)
  // State, not a ref: in a dialog window the form mounts a render later, once the window is open, and focusing the setting waits for it.
  const [formElement, setForm] = useState<HTMLFormElement | null>(null)
  const found = useMemo(() => searchPages(query, platform), [query, platform])
  const rows = treeRows(expanded, found?.shown)
  const focusId = rows.some(row => row.page.id === treeFocus) ? treeFocus : rows.find(row => row.page.id === page)?.page.id ?? rows[0]?.page.id
  const form = pageForm(page, draft, platform)
  const shownRows = form.groups.flatMap(group => group.rows)

  useEffect(() => { settings.showedPage(page) }, [settings, page])
  // The tree keeps focus on the row it moved to; a field OK found invalid takes focus once its page shows.
  useEffect(() => { if (focusId && tree.current?.contains(tree.current.ownerDocument.activeElement)) tree.current.querySelector<HTMLElement>(`[data-page="${focusId}"]`)?.focus() }, [focusId])
  useEffect(() => {
    const key = focusSetting.current
    if (!key || !formElement) return
    focusSetting.current = undefined
    formElement.ownerDocument.getElementById(controlId(key))?.focus()
  })
  const firstRequest = useRef(request)
  useEffect(() => {
    if (request === firstRequest.current || !request.open) return
    firstRequest.current = request
    if (request.page && pageById(request.page)) showPage(request.page)
    if (request.setting) { focusSetting.current = request.setting; setFocused(request.setting) }
  // showPage only sets state; the request is what changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  // What opened the dialog may be gone once its changes apply (the status bar's Results discarded item, for one): the
  // keyboard goes to the active document rather than to nothing.
  const restoreFocus = () => { if (returnFocus?.isConnected) returnFocusTo(returnFocus); else documents.focusActive() }
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
    const shortcutFile = shortcutsToSave(shortcutEdit)
    if (!Object.keys(patch).length && !shortcutFile) { close(); return }
    const clash = shortcutFile && gestureClash(shortcutFile, platform)
    if (clash) { setError(`Shortcuts were not saved: ${clash} Choose another modifier in the Mouse view.`); if (page !== shortcutsPage) showPage(shortcutsPage); return }
    // Settings first, then shortcuts; a failure keeps the dialog open on the page that failed, with its draft.
    const asking = settings.dialog.getSnapshot()
    setSaving(true); setError('')
    const saved = await commitOptions({ update: next => settings.update(next), saveShortcuts: file => shortcuts.save(file, saveRevision(shortcutEdit)) }, patch, shortcutFile, { early: shortcutEdit.early })
    if (!saved.ok) {
      setError(saved.message); setSaving(false)
      // The message offers OK again to replace the other window's shortcuts (the service has read them by now); only that
      // choice may overwrite them, and only that revision.
      if (saved.stale) { const shown = shortcuts.getSnapshot().revision; setShortcutEdit(edit => ({ ...edit, replace: shown })) }
      if (saved.stage === 'shortcuts' && page !== shortcutsPage) showPage(shortcutsPage)
      return
    }
    // A dialog that closed, or was opened again, while the saves were on their way is left as it is.
    if (settings.dialog.getSnapshot() !== asking) { setSaving(false); return }
    settings.closeDialog()
    restoreFocus()
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
  // Ctrl+E (⌘E) is the catalogue's options.focusSearch (contributions/settings.ts), which focuses the box marked data-options-search.
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    const target = event.target
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      // As in Visual Studio, Escape in a search box with text clears the search first.
      if (target === search.current && query) changeQuery('')
      else close()
    } else if (target === search.current && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      event.preventDefault()
      tree.current?.querySelector<HTMLElement>(`[data-page="${focusId}"]`)?.focus()
    } else if (event.key === 'Enter' && !(isElement(target) && (target.tagName === 'SELECT' || target.tagName === 'BUTTON'))) { event.preventDefault(); void ok() }
  }

  const highlight = (label: string): ReactNode => found ? highlightParts(label, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text) : label
  const focusedRow = shownRows.find(row => row.key === focused)
  const described = focusedRow ? { title: focusedRow.def.label, text: focusedRow.def.description, notes: rowNotes(focusedRow.def) } : { title: form.page.title, text: form.page.description ?? '', notes: [] }
  // A section: its heading and one-line description above the rows, which share the page's label, control and hint columns.
  const groups = (list: readonly RowGroup[]) => list.map((group, index) => <section key={group.label ?? index} className="options-group" role="group" aria-label={group.label} aria-description={group.description}>
    {group.label && <div className="options-section-head"><h4 className="options-category">{highlight(groupHeading(form.page.id, group.label))}</h4>{group.description && <p className="options-section-description">{group.description}</p>}</div>}
    <div className="options-grid">
      {group.rows.map(row => <FormRow key={row.key} row={row} error={errors.get(row.key)} focused={row.key === focused} label={highlight(row.def.label)} onFocus={() => setFocused(row.key)} onChange={text => change(row.key, text)} />)}
    </div>
  </section>)
  // The page's ancestors on a line above its title; the separator after them is read with the heading, so its text stays the whole path.
  const path = pagePath(form.page.id), ancestors = path.slice(0, -1).map(node => node.title).join(' › ')

  // Focusable itself, so pressing a greyed row, a label or the description keeps focus (and Escape and Enter) in the dialog.
  return <DialogWindow kind="options" onClose={close} raise={request}><form ref={setForm} className="connection-modal options-dialog" data-options-dialog role="dialog" aria-modal="true" aria-labelledby="options-title" noValidate tabIndex={-1}
    onSubmit={event => { event.preventDefault(); void ok() }} onKeyDown={keyDown}>
    <DialogHeading id="options-title" title="Options" closeLabel="Close options" disabled={saving} onClose={close} />
    <div className="options-body">
      <div className="options-nav">
        <input ref={search} type="search" className="options-search" data-options-search placeholder={platform === 'darwin' ? 'Search Options (⌘E)' : 'Search Options (Ctrl+E)'} aria-label="Search Options"
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
        <h3 className="options-heading">{ancestors && <span className="options-crumb">{ancestors}<span className="visually-hidden"> › </span></span>}<span className="options-title">{form.page.title}</span></h3>
        {form.provider === 'theme' && <p className="options-note">{highlight('Color theme')}: View › Theme</p>}
        {/* A form page's own note (Fonts and Colors: where colors come from) stays above its rows. */}
        {form.page.layout === 'form' && form.page.description && <p className="options-note">{highlight(form.page.description)}</p>}
        {form.page.layout === 'shortcuts'
          ? <ShortcutsPage draft={shortcutDraft} stored={shortcutEdit.base.file} platform={platform} files={shortcuts} capture={capture} linked={linked}
            salvaged={shortcutsState.salvaged ? shortcutsState.notice ?? '' : undefined} onChange={next => { setShortcutDraft(next); setError('') }} />
          : form.page.layout === 'propertyGrid'
            ? <PropertyGrid label={form.page.title} groups={form.groups.map(group => ({ ...group, rows: group.rows.map(settingGridRow) }))} idPrefix="setting-" focused={focused} errors={errors} onFocusRow={key => setFocused(key)} onChange={(key, text) => change(key as SettingKey, text)} renderLabel={highlight} />
            : <div className="options-form">{groups(form.groups)}</div>}
      </div>
    </div>
    {/* The Shortcuts page's inspector describes what is selected there. */}
    {form.page.layout !== 'shortcuts' && <div className="options-description"><strong>{described.title}</strong>{described.text && <p>{described.text}</p>}{described.notes.map(note => <p key={note}>{note}</p>)}</div>}
    {error && <p className="connect-error options-error" role="alert">{error}</p>}
    <div className="connection-footer">
      {form.page.layout !== 'shortcuts' && <button type="button" onClick={() => { setDraft(current => resetPage(current, page, platform)); setErrors(new Map()); setError('') }}>Reset to Defaults</button>}
      <span className="options-staged">{staged > 0 && <><span className="shortcuts-dot" aria-hidden="true" />{staged === 1 ? '1 shortcut change' : `${staged} shortcut changes`} staged · applied on OK</>}</span>
      <button className="primary" type="submit" disabled={saving}>OK</button><button type="button" disabled={saving} onClick={close}>Cancel</button>
    </div>
  </form></DialogWindow>
}
