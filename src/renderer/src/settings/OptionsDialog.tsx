import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { pageById, pagePath, settingPages, visibleSettings, type SettingDef, type SettingKey } from '../../../shared/settings/catalog'
import { defaultThemePreference } from '../../../shared/theme/format'
import { builtinThemes } from '../../../shared/theme/palette'
import { resolveBuiltin } from '../../../shared/theme/resolve'
import { themeChoice } from '../../../shared/theme/choice'
import type { ThemeMode, ThemePreference, ThemePreview, ThemeState, ThemeSummary, ThemeType } from '../../../shared/theme/types'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import Switch from '../kit/Switch'
import Segmented from '../kit/Segmented'
import DialogFooter from '../kit/DialogFooter'
import { followPointerDrag } from '../kit/pointer-drag'
import DialogWindow, { closesDialogWindow, DialogHeading } from '../popouts/DialogWindow'
import { trapFocus } from '../trap-focus'
import {
  ancestorIds, clampOptionsRailWidth, commitOptions, draftFrom, followValues, firstPage, loadOptionsRailWidth,
  optionsRailLimits, pageForm, patchFrom, pendingSettingsCount, resetPage, resetSetting, rowNotes, saveOptionsRailWidth, setDraftValue,
  settingGridRow, settingRow, themePatchFrom, themePreferenceChanged, treeRows, unsavedSettings, validateDraft, type OptionsDraft, type RowGroup, type SettingRow
} from './options-form'
import PropertyGrid, { controlId } from './PropertyGrid'
import { indexStorageNote } from './index-storage-note'
import type { SecretStorageState } from '../../../shared/connections'
import { highlightParts, normalizeQuery, searchAllOptions } from './search'
import { focusToReturn, isElement, returnFocusBeside } from '../core/focus'
import { useShortcuts, useShortcutsSnapshot } from '../core/ShortcutsContext'
import type { ShortcutFile } from '../../../shared/commands/shortcut-schema'
import type { CaptureSource } from './shortcuts/CaptureField'
import ShortcutsPage from './shortcuts/ShortcutsPage'
import { followStored, gestureClash, saveRevision, shortcutsToSave, stagedChanges, startShortcutEdit, type ShortcutEdit } from './shortcuts/shortcut-draft'

const shortcutsPage = 'environment.shortcuts'
const noopSubscribe = () => () => {}
const darkSwatchTheme = resolveBuiltin('dark')
const lightSwatchTheme = resolveBuiltin('light')
const themeModes: readonly { readonly mode: ThemeMode; readonly label: string; readonly caption: string }[] = [
  { mode: 'dark', label: 'Dark', caption: 'Calm graphite' },
  { mode: 'light', label: 'Light', caption: 'Crisp neutral' },
  { mode: 'system', label: 'Follow System', caption: 'Matches OS' }
]
const systemPrefersDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
const slotOf = (type: ThemeType) => type === 'dark' ? 'darkTheme' as const : 'lightTheme' as const
const effectiveTypeFor = (preference: ThemePreference, fallback: ThemeType = 'dark'): ThemeType =>
  preference.mode === 'system' ? (typeof matchMedia === 'function' ? (systemPrefersDark() ? 'dark' : 'light') : fallback) : preference.mode

/** Fonts and Colors names the display item its rows are for, as SSMS's "Show settings for" list does (fixed for now). */
const groupHeading = (pageId: string, label: string) => pageId === 'environment.fontsAndColors' ? `Show settings for: ${label}` : label

function descriptionExcerpt(text: string, query: string): string {
  const needle = normalizeQuery(query)
  if (!needle) return text
  const idx = text.toLowerCase().indexOf(needle)
  if (idx < 0 || idx <= 72) return text
  const target = Math.max(0, idx - 32)
  const boundary = text.lastIndexOf(' ', target)
  const start = boundary >= 0 ? boundary + 1 : target
  return start > 0 ? `…${text.slice(start)}` : text
}

interface RowProps {
  row: SettingRow
  error?: string
  focused: boolean
  label: ReactNode
  descriptionSnippet?: ReactNode
  onFocus(): void
  onHover?(): void
  onLeave?(): void
  onChange(text: string): void
  onReset?(): void
  /** In the Modified view every row is an unsaved edit: its button puts back the saved value, not the default. */
  onRevert?(): void
}

/** What follows a control in the hint column: an integer's unit, then the setting's hint ("GiB · 0 = automatic"). */
export const rowHint = (row: SettingRow): string => [row.def.type === 'integer' ? row.def.unit : undefined, row.def.hint].filter(Boolean).join(' · ')

/**
 * A compact single-line form row: label + badges on the left, optional search description snippet only when
 * matching in the description rather than the label, and aligned control + per-row reset on the right.
 */
function FormRow({ row, error, focused, label, descriptionSnippet, onFocus, onHover, onLeave, onChange, onReset, onRevert }: RowProps) {
  const { def } = row, id = controlId(row.key), hint = rowHint(row), isSegmented = def.type === 'enum' && def.presentation === 'radio'
  const common = { id, disabled: row.disabled, 'data-setting': row.key, 'aria-description': [def.description, hint].filter(Boolean).join(' ') || undefined, onFocus }
  let control: ReactNode
  if (def.type === 'boolean') {
    control = <Switch id={id} checked={row.value === 'true'} disabled={row.disabled} changed={row.changed} data-setting={row.key} aria-description={[def.description, hint].filter(Boolean).join(' ') || undefined} onFocus={onFocus} onChange={checked => onChange(String(checked))} />
  } else if (def.type === 'integer') {
    control = <div className="options-number-wrap">
      <input {...common} className="ui-field options-control options-number" type="number" step={1} min={def.min} max={def.max} value={row.value} aria-invalid={error ? true : undefined} aria-errormessage={error ? id + '-error' : undefined}
        onChange={event => onChange(event.target.value)} />
      {hint && <span className="options-hint">{hint}</span>}
    </div>
  } else if (isSegmented) {
    control = <Segmented id={id} labelledBy={id + '-label'} segments={def.values} value={row.value} disabled={row.disabled} changed={row.changed} onFocus={onFocus} dataSetting={row.key} onChange={onChange} />
  } else {
    control = <><select {...common} className="ui-field options-control" value={row.value} onChange={event => onChange(event.target.value)}>
      {def.values.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
      {hint && <span className="options-hint">{hint}</span>}</>
  }
  const appliesBadge = def.applies === 'nextExecution' ? 'Next execution' : def.applies === 'newConnections' ? 'New connections' : undefined
  return <div className="options-form-row" data-focused={focused || undefined} data-changed={row.changed || undefined} data-disabled={row.disabled || undefined} onPointerDown={onFocus} onPointerEnter={onHover} onPointerLeave={onLeave}>
    <div className="options-row-meta">
      <div className="options-row-title">
        {row.changed && <span className="options-row-dot" aria-hidden="true" title="Customized from default" />}
        {isSegmented
          ? <span className="options-label" id={id + '-label'}>{label}</span>
          : <label className="options-label" htmlFor={id}>{label}</label>}
        {appliesBadge && <span className="options-badge" data-tone="warning">{appliesBadge}</span>}
        {def.varia && <span className="options-badge">Varia</span>}
      </div>
      {descriptionSnippet && <p className="options-row-desc">{descriptionSnippet}</p>}
      {error && <span className="options-field-error" id={id + '-error'}>{error}</span>}
    </div>
    <div className="options-row-controls">
      {onRevert
        ? <button type="button" className="ui-button icon-button options-row-reset" aria-label={`Revert ${def.label}`} title={`Revert ${def.label} to its saved value`} tabIndex={-1} onClick={event => { event.stopPropagation(); onRevert() }}><Icon name="discard" /></button>
        : row.changed && onReset && <button type="button" className="ui-button icon-button options-row-reset" aria-label={`Reset ${def.label}`} title={`Reset ${def.label} to default`} tabIndex={-1} onClick={event => { event.stopPropagation(); onReset() }}><Icon name="discard" /></button>}
      {control}
    </div>
  </div>
}

interface ThemeSectionProps {
  readonly preference: ThemePreference
  readonly themes: readonly ThemeSummary[]
  readonly activeType: ThemeType
  readonly highlight: (label: string) => ReactNode
  readonly onChange: (patch: ThemePreference) => void
  readonly onCommand?: (id: 'preferences.createTheme' | 'preferences.openThemesFolder') => void
}

function ThemeSection({ preference, themes, activeType, highlight, onChange, onCommand }: ThemeSectionProps) {
  const usable = themes.filter(item => item.usable && item.types.includes(activeType))
  const currentId = preference[slotOf(activeType)]
  const darkVars = {
    '--swatch-bg': darkSwatchTheme.colors['editor.background'],
    '--swatch-side': darkSwatchTheme.colors['sideBar.background'],
    '--swatch-panel': darkSwatchTheme.colors['editorWidget.background'],
    '--swatch-line': darkSwatchTheme.colors['panel.border'],
    '--swatch-accent': darkSwatchTheme.colors['button.background']
  } as CSSProperties
  const lightVars = {
    '--swatch-bg': lightSwatchTheme.colors['editor.background'],
    '--swatch-side': lightSwatchTheme.colors['sideBar.background'],
    '--swatch-panel': lightSwatchTheme.colors['editorWidget.background'],
    '--swatch-line': lightSwatchTheme.colors['panel.border'],
    '--swatch-accent': lightSwatchTheme.colors['button.background']
  } as CSSProperties
  return <section className="options-group" role="group" aria-label="Appearance and Theme">
    <div className="options-section-head">
      <h4 className="options-category">{highlight('Color theme')}</h4>
      <p className="options-section-description">Choose a palette mode and theme, or follow your operating system.</p>
    </div>
    <div className="options-theme-cards" role="radiogroup" aria-label="Color theme mode">
      {themeModes.map(item => {
        const selected = preference.mode === item.mode
        return <button key={item.mode} type="button" role="radio" aria-checked={selected} className="options-theme-card" onClick={() => onChange({ ...preference, mode: item.mode })}>
          {item.mode === 'system'
            ? <span className="options-theme-preview options-theme-system" aria-hidden="true">
              <span className="options-theme-half" style={darkVars}><span className="options-theme-bar" /><span className="options-theme-bar" data-accent /></span>
              <span className="options-theme-half" style={lightVars}><span className="options-theme-bar" /><span className="options-theme-bar" data-accent /></span>
            </span>
            : <span className="options-theme-preview" style={item.mode === 'dark' ? darkVars : lightVars} aria-hidden="true">
              <span className="options-theme-rail" /><span className="options-theme-canvas"><span className="options-theme-bar" data-accent /><span className="options-theme-bar" /><span className="options-theme-bar" /></span>
            </span>}
          <span className="options-theme-meta"><strong>{item.label}</strong><span>{item.caption}</span></span>
        </button>
      })}
    </div>
    {usable.length > 0 && <div className="options-theme-row">
      <label className="options-label" htmlFor="options-color-theme">{highlight(activeType === 'dark' ? 'Dark theme palette' : 'Light theme palette')}</label>
      <div className="options-theme-actions">
        <select id="options-color-theme" className="ui-field options-control" value={usable.some(item => item.id === currentId) ? currentId : builtinThemes[activeType].id}
          onChange={event => {
            const picked = usable.find(item => item.id === event.target.value)
            if (!picked) return
            const patch = themeChoice(preference, picked, activeType)
            onChange({ ...preference, ...patch })
          }}>
          {usable.map(item => <option key={item.id} value={item.id}>{item.name}{item.source === 'user' ? ' (user)' : ''}</option>)}
        </select>
        {onCommand && <>
          <button type="button" className="ui-button" data-control-variant="secondary" data-control-size="dense" onClick={() => onCommand('preferences.createTheme')}>Create Custom Theme…</button>
          <button type="button" className="ui-button" data-control-variant="secondary" data-control-size="dense" onClick={() => onCommand('preferences.openThemesFolder')}>Open Themes Folder</button>
        </>}
      </div>
    </div>}
  </section>
}

function SqlFontPreview({ fontSize, theme }: { readonly fontSize: number; readonly theme?: ThemeState['active'] }) {
  const numeric = Number.isFinite(fontSize) ? Math.min(72, Math.max(8, Math.round(fontSize))) : 13
  const syntaxVars = theme ? {
    '--sql-kw': theme.syntax.keyword.foreground,
    '--sql-fn': theme.syntax.predefined.foreground,
    '--sql-str': theme.syntax.string.foreground,
    '--sql-num': theme.syntax.number.foreground,
    '--sql-cm': theme.syntax.comment.foreground
  } as CSSProperties : undefined
  const codeStyle = { fontSize: `${numeric}px` } as CSSProperties
  return <div className="options-sql-preview" style={syntaxVars} aria-label="Editor font size preview">
    <div className="options-sql-preview-head">
      <span>Live Query Editor Preview · {numeric} px</span>
      <span>Transact-SQL</span>
    </div>
    <pre className="options-sql-preview-code" style={codeStyle}><code>
      <span className="sql-ln">1</span><span className="sql-cm">-- Customer order totals for current quarter</span>{'\n'}
      <span className="sql-ln">2</span><span className="sql-kw">SELECT TOP</span> (<span className="sql-num">25</span>) o.CustomerId, <span className="sql-fn">SUM</span>(o.TotalAmount) <span className="sql-kw">AS</span> Revenue{'\n'}
      <span className="sql-ln">3</span><span className="sql-kw">FROM</span> dbo.Orders <span className="sql-kw">AS</span> o{'\n'}
      <span className="sql-ln">4</span><span className="sql-kw">WHERE</span> o.Status = <span className="sql-str">'Completed'</span> <span className="sql-kw">AND</span> o.CreatedAt &gt;= <span className="sql-str">'2026-10-01'</span>{'\n'}
      <span className="sql-ln">5</span><span className="sql-kw">GROUP BY</span> o.CustomerId <span className="sql-kw">ORDER BY</span> Revenue <span className="sql-kw">DESC</span>;
    </code></pre>
  </div>
}

/**
 * SSMS's Tools › Options: a resizable navigation rail with cross-page search and Modified filter on the left,
 * unified search/modified results or the selected page on the right, and Apply / OK / Cancel with dirty-close guard.
 */
export default function OptionsDialog({ page: requested, setting }: { page?: string; setting?: string }) {
  const { settings, platform, keybindings, documents, theme, commands } = useWorkbench()
  const { values } = useServiceSnapshot(settings)
  const themeState = useSyncExternalStore(theme?.subscribe ?? noopSubscribe, () => theme?.getSnapshot(), () => undefined)
  const storedTheme: ThemePreference = themeState?.preference ?? defaultThemePreference
  const [draft, setDraft] = useState<OptionsDraft>(() => draftFrom(values))
  const [themeDraft, setThemeDraft] = useState<ThemePreference>(() => storedTheme)
  const base = useRef(draft)
  const baseTheme = useRef(storedTheme)
  useEffect(() => {
    const next = draftFrom(values), previous = base.current
    base.current = next
    setDraft(current => followValues(current, previous, next))
  }, [values])
  useEffect(() => {
    const next = storedTheme, previous = baseTheme.current
    baseTheme.current = next
    setThemeDraft(current => themePreferenceChanged(current, previous) ? current : next)
  }, [storedTheme])

  // Whether the system can protect the saved Search Objects index: asked when the dialog opens, so its page can say when it cannot.
  const [indexStorage, setIndexStorage] = useState<SecretStorageState>()
  useEffect(() => {
    let live = true
    void window.varia?.searchIndexStorage?.().then(result => { if (live && result.ok) setIndexStorage(result.value) }, () => {})
    return () => { live = false }
  }, [])

  const shortcuts = useShortcuts()
  const shortcutsState = useShortcutsSnapshot()
  const [shortcutEdit, setShortcutEdit] = useState<ShortcutEdit>(() => startShortcutEdit(shortcuts.getSnapshot()))
  const shortcutDraft = shortcutEdit.draft
  const setShortcutDraft = (next: ShortcutFile) => setShortcutEdit(edit => ({ ...edit, draft: next }))
  useEffect(() => { void shortcuts.reload() }, [shortcuts])
  useEffect(() => { setShortcutEdit(edit => followStored(edit, shortcutsState)) }, [shortcutsState])
  const stagedShortcuts = stagedChanges(shortcutDraft, shortcutEdit.base.file)
  const linked = { multiCursorModifier: draft['textEditor.multiCursorModifier'] === 'ctrlCmd' ? 'ctrlCmd' as const : 'alt' as const }
  const capture = useMemo<CaptureSource>(() => (onChord, options) => keybindings.capture(onChord, options), [keybindings])

  const [page, setPage] = useState(() => firstPage(requested && pageById(requested) ? requested : 'environment.general'))
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(ancestorIds(page)))
  const [treeFocus, setTreeFocus] = useState(page)
  const [query, setQuery] = useState('')
  const [modifiedOnly, setModifiedOnly] = useState(false)
  const [browseScope, setBrowseScope] = useState<'all' | 'page'>('page')
  const [focused, setFocused] = useState<string>()
  const [hovered, setHovered] = useState<string>()
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [appliedNotice, setAppliedNotice] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [dialogWidth, setDialogWidth] = useState(960)
  const [railWidth, setRailWidth] = useState(() => loadOptionsRailWidth(960))
  const [draggingSplit, setDraggingSplit] = useState(false)
  const [returnFocus] = useState(focusToReturn)
  const search = useRef<HTMLInputElement>(null), tree = useRef<HTMLUListElement>(null), focusSetting = useRef<string | undefined>(setting)
  const previewSeq = useRef(0), previewing = useRef(false)
  const request = useServiceSnapshot(settings.dialog)
  const [formElement, setForm] = useState<HTMLFormElement | null>(null)

  const searchResult = useMemo(() => searchAllOptions(query, platform), [query, platform])
  // Modified means edited here and not saved yet: values saved earlier, in Options or elsewhere, are not called out.
  const stored = useMemo(() => draftFrom(values), [values])
  const unsavedList = useMemo(() => unsavedSettings(draft, stored, platform), [draft, stored, platform])
  const unsavedSet = useMemo(() => new Set(unsavedList.map(def => def.key as SettingKey)), [unsavedList])
  const unsavedTheme = !!themeState && themePreferenceChanged(themeDraft, storedTheme)
  const totalUnsaved = unsavedList.length + (unsavedTheme ? 1 : 0) + (stagedShortcuts > 0 ? 1 : 0)

  const pageCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (searchResult) {
      for (const entry of searchResult.pages) {
        const filtered = modifiedOnly
          ? entry.settings.filter(def => unsavedSet.has(def.key as SettingKey)).length
            + (entry.matchTheme && unsavedTheme ? 1 : 0)
            + (entry.matchShortcuts && stagedShortcuts > 0 ? 1 : 0)
          : entry.count
        if (filtered > 0) counts.set(entry.page.id, filtered)
      }
      return counts
    }
    if (modifiedOnly) {
      for (const node of settingPages) {
        if (!node.layout) continue
        let count = unsavedList.filter(def => def.page === node.id).length
        if (node.provider === 'theme' && unsavedTheme) count++
        if (node.layout === 'shortcuts' && stagedShortcuts > 0) count += stagedShortcuts
        if (count > 0) counts.set(node.id, count)
      }
    }
    return counts
  }, [searchResult, modifiedOnly, unsavedList, unsavedSet, unsavedTheme, stagedShortcuts])

  const shownTree = useMemo(() => {
    if (!searchResult && !modifiedOnly) return undefined
    const shown = new Set<string>()
    for (const id of pageCounts.keys()) for (const node of pagePath(id)) shown.add(node.id)
    return shown
  }, [searchResult, modifiedOnly, pageCounts])

  const rows = treeRows(expanded, shownTree)
  const focusId = rows.some(row => row.page.id === treeFocus) ? treeFocus : rows.find(row => row.page.id === page)?.page.id ?? rows[0]?.page.id
  const form = pageForm(page, draft, platform)
  const indexStorageText = indexStorageNote(indexStorage, draft['objectExplorer.search.saveIndex'] === true, draft['objectExplorer.search.saveUnencrypted'] === true)
  const shownRows = form.groups.flatMap(group => group.rows)
  const showingUnified = browseScope === 'all' && (!!searchResult || modifiedOnly)

  // The Modified view keeps the row being edited even once it matches the saved value again, so typing or toggling it
  // back does not pull the row (and focus) out from under the user; it leaves when focus moves or it is reverted.
  const inModifiedView = (def: SettingDef) => unsavedSet.has(def.key as SettingKey) || def.key === focused
  const unifiedEntries = useMemo(() => {
    if (!showingUnified) return []
    const items: {
      readonly pageId: string
      readonly path: string
      readonly settings: readonly SettingRow[]
      readonly showTheme: boolean
      readonly showShortcuts: boolean
    }[] = []
    if (searchResult) {
      for (const entry of searchResult.pages) {
        const list = modifiedOnly ? entry.settings.filter(inModifiedView) : entry.settings
        const showTheme = entry.matchTheme && (!modifiedOnly || unsavedTheme)
        const showShortcuts = entry.matchShortcuts && (!modifiedOnly || stagedShortcuts > 0)
        if (!list.length && !showTheme && !showShortcuts) continue
        items.push({ pageId: entry.page.id, path: entry.path, settings: list.map(def => settingRow(def, draft)), showTheme, showShortcuts })
      }
      return items
    }
    for (const node of settingPages) {
      if (!node.layout) continue
      const list = visibleSettings(platform).filter(def => def.page === node.id && inModifiedView(def))
      const showTheme = node.provider === 'theme' && unsavedTheme
      const showShortcuts = node.layout === 'shortcuts' && stagedShortcuts > 0
      if (!list.length && !showTheme && !showShortcuts) continue
      items.push({ pageId: node.id, path: pagePath(node.id).map(item => item.title).join(' › '), settings: list.map(def => settingRow(def, draft)), showTheme, showShortcuts })
    }
    return items
  }, [showingUnified, searchResult, modifiedOnly, unsavedSet, unsavedTheme, stagedShortcuts, draft, focused, platform])

  const pendingSettings = pendingSettingsCount(values, draft)
  const themePatch = themeState ? themePatchFrom(storedTheme, themeDraft) : undefined
  const totalPending = pendingSettings + (themePatch ? 1 : 0) + stagedShortcuts

  useEffect(() => { settings.showedPage(page) }, [settings, page])
  useEffect(() => { if (focusId && tree.current?.contains(tree.current.ownerDocument.activeElement)) tree.current.querySelector<HTMLElement>(`[data-page="${focusId}"]`)?.focus() }, [focusId])
  useEffect(() => {
    const key = focusSetting.current
    if (!key || !formElement) return
    const target = formElement.ownerDocument.getElementById(controlId(key))
    if (!target) return
    focusSetting.current = undefined
    target.focus()
  })
  useEffect(() => {
    if (!formElement) return
    const updateWidth = () => { if (formElement.clientWidth > 0) setDialogWidth(formElement.clientWidth) }
    updateWidth()
    const win = formElement.ownerDocument.defaultView, Observer = win?.ResizeObserver ?? globalThis.ResizeObserver
    const observer = typeof Observer === 'function' ? new Observer(updateWidth) : undefined
    observer?.observe(formElement)
    return () => observer?.disconnect()
  }, [formElement])

  const clearPreview = () => {
    previewSeq.current++
    if (!previewing.current) return
    previewing.current = false
    theme?.endPreview()
    void window.varia?.previewTheme?.(null).catch(() => {})
  }
  useEffect(() => () => { clearPreview() }, [])

  const firstRequest = useRef(request)
  useEffect(() => {
    if (request === firstRequest.current || !request.open) return
    firstRequest.current = request
    if (request.page && pageById(request.page)) showPage(request.page)
    if (request.setting) { focusSetting.current = request.setting; setFocused(request.setting) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  const restoreFocus = () => returnFocusBeside(returnFocus, '[data-options-dialog]', () => documents.focusActive())
  const finishClose = () => {
    if (saving) return
    clearPreview()
    setConfirmClose(false)
    settings.closeDialog()
    restoreFocus()
  }
  const requestClose = () => {
    if (saving) return
    if (totalPending > 0) { setConfirmClose(true); return }
    finishClose()
  }
  const dismissConfirmClose = () => {
    setConfirmClose(false)
    formElement?.focus()
  }
  const showPage = (id: string, node = firstPage(id)) => {
    const target = firstPage(id)
    setPage(target)
    setTreeFocus(node)
    setBrowseScope('page')
    setFocused(undefined)
    setHovered(undefined)
    setExpanded(current => new Set([...current, ...ancestorIds(target), ...target === id ? [] : [id]]))
  }
  const changeQuery = (text: string) => {
    setQuery(text)
    setBrowseScope(text.trim() || modifiedOnly ? 'all' : 'page')
    setHovered(undefined)
    setConfirmClose(false)
  }
  const toggleModified = () => {
    const next = !modifiedOnly
    setModifiedOnly(next)
    setBrowseScope(next || query.trim() ? 'all' : 'page')
    setFocused(undefined)
    setHovered(undefined)
    setConfirmClose(false)
  }
  const previewThemePreference = (next: ThemePreference) => {
    setThemeDraft(next)
    setAppliedNotice(false)
    setConfirmClose(false)
    if (!themeState) return
    if (!themePreferenceChanged(next, storedTheme)) { clearPreview(); return }
    const variant = effectiveTypeFor(next, themeState.active.type)
    const id = next[slotOf(variant)]
    const targetId = themeState.themes.some(item => item.id === id && item.usable && item.types.includes(variant)) ? id : builtinThemes[variant].id
    const target: ThemePreview = { id: targetId, type: variant }
    const seq = ++previewSeq.current
    previewing.current = true
    void window.varia?.previewTheme?.(target).then(result => {
      if (seq === previewSeq.current && result.ok && result.value) theme?.preview(result.value)
    }, () => {})
  }
  const change = (key: SettingKey, text: string) => {
    setDraft(current => setDraftValue(current, key, text))
    setErrors(current => { if (!current.has(key)) return current; const next = new Map(current); next.delete(key); return next })
    setError(''); setAppliedNotice(false); setConfirmClose(false)
  }
  const revertOneSetting = (key: SettingKey) => {
    setDraft(current => current[key] === stored[key] ? current : { ...current, [key]: stored[key] })
    setErrors(current => { if (!current.has(key)) return current; const next = new Map(current); next.delete(key); return next })
    setFocused(current => current === key ? undefined : current)
    setError(''); setAppliedNotice(false); setConfirmClose(false)
  }
  const resetOneSetting = (key: SettingKey) => {
    setDraft(current => resetSetting(current, key))
    setErrors(current => { if (!current.has(key)) return current; const next = new Map(current); next.delete(key); return next })
    setError(''); setAppliedNotice(false); setConfirmClose(false)
  }

  const commit = async (keepOpen: boolean) => {
    if (saving) return
    const result = validateDraft(draft)
    if (!result.ok) {
      const [first] = result.errors
      setErrors(new Map(result.errors.map(item => [item.key, item.message])))
      showPage(first.page)
      focusSetting.current = first.key
      setFocused(first.key)
      setError('')
      setConfirmClose(false)
      return
    }
    setErrors(new Map())
    const patch = patchFrom(settings.getSnapshot().values, result.values)
    const shortcutFile = shortcutsToSave(shortcutEdit)
    const activeThemePatch = themeState ? themePatchFrom(storedTheme, themeDraft) : undefined
    if (!Object.keys(patch).length && !shortcutFile && !activeThemePatch) {
      if (!keepOpen) finishClose()
      return
    }
    const clash = shortcutFile && gestureClash(shortcutFile, platform)
    if (clash) {
      setError(`Shortcuts were not saved: ${clash} Choose another modifier in the Mouse view.`)
      if (page !== shortcutsPage || showingUnified) showPage(shortcutsPage)
      return
    }
    const asking = settings.dialog.getSnapshot()
    setSaving(true); setError(''); setConfirmClose(false)
    const saved = await commitOptions({
      update: next => settings.update(next),
      saveTheme: async next => {
        const res = await window.varia.setThemePreference(next)
        if (!res.ok) throw new Error(res.error)
        theme?.receive(res.value)
        clearPreview()
      },
      saveShortcuts: file => shortcuts.save(file, saveRevision(shortcutEdit))
    }, patch, shortcutFile, { early: shortcutEdit.early, themePatch: activeThemePatch })
    if (!saved.ok) {
      setError(saved.message); setSaving(false)
      if (saved.stale) { const shown = shortcuts.getSnapshot().revision; setShortcutEdit(edit => ({ ...edit, replace: shown })) }
      if (saved.stage === 'shortcuts' && (page !== shortcutsPage || showingUnified)) showPage(shortcutsPage)
      return
    }
    if (keepOpen) {
      const committedValues = { ...base.current, ...patch } as OptionsDraft
      base.current = committedValues
      baseTheme.current = themeDraft
      if (shortcutFile) setShortcutEdit(startShortcutEdit({ file: shortcutDraft, revision: shortcuts.getSnapshot().revision }))
      setSaving(false)
      setAppliedNotice(true)
      return
    }
    if (settings.dialog.getSnapshot() !== asking) { setSaving(false); return }
    clearPreview()
    settings.closeDialog()
    restoreFocus()
  }

  const effectiveRailWidth = clampOptionsRailWidth(railWidth, dialogWidth)
  const startPointerSplitter = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX, startWidth = effectiveRailWidth
    let latest = startWidth
    setDraggingSplit(true)
    followPointerDrag(event.currentTarget, event.pointerId, moved => {
      latest = clampOptionsRailWidth(startWidth + (moved.clientX - startX), dialogWidth)
      setRailWidth(latest)
    })
    const finish = () => { setDraggingSplit(false); saveOptionsRailWidth(latest) }
    event.currentTarget.addEventListener('pointerup', finish, { once: true })
    event.currentTarget.addEventListener('pointercancel', finish, { once: true })
  }
  const splitterKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 24 : 12
    const next = event.key === 'ArrowLeft' ? clampOptionsRailWidth(effectiveRailWidth - step, dialogWidth)
      : event.key === 'ArrowRight' ? clampOptionsRailWidth(effectiveRailWidth + step, dialogWidth)
        : event.key === 'Home' ? clampOptionsRailWidth(optionsRailLimits.defaultWidth, dialogWidth) : undefined
    if (next === undefined) return
    event.preventDefault(); event.stopPropagation()
    setRailWidth(next); saveOptionsRailWidth(next)
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
      if (row.expanded && !shownTree) setExpanded(current => { const next = new Set(current); next.delete(row.page.id); return next })
      else if (row.page.parent) showPage(row.page.parent, row.page.parent)
    } else if (key === 'Enter' || key === ' ') showPage(row.page.id, row.page.id)
    else return
    event.preventDefault(); event.stopPropagation()
  }

  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    const target = event.target
    if (closesDialogWindow(event, platform)) { event.preventDefault(); event.stopPropagation(); requestClose(); return }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (confirmClose) { dismissConfirmClose(); return }
      if (target === search.current && query) changeQuery('')
      else requestClose()
    } else if (target === search.current && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      event.preventDefault()
      tree.current?.querySelector<HTMLElement>(`[data-page="${focusId}"]`)?.focus()
    } else if (event.key === 'Enter' && !(isElement(target) && (target.tagName === 'SELECT' || target.tagName === 'BUTTON'))) {
      event.preventDefault(); void commit(false)
    }
  }

  const highlight = (label: string): ReactNode => searchResult ? highlightParts(label, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text) : label
  const unifiedRows = useMemo(() => unifiedEntries.flatMap(entry => entry.settings), [unifiedEntries])
  const activeKey = hovered ?? focused
  const describedRow = (showingUnified ? unifiedRows : shownRows).find(row => row.key === activeKey)
    ?? (showingUnified ? unifiedRows[0] : shownRows[0])
  const described = describedRow
    ? { title: describedRow.def.label, text: describedRow.def.description, notes: rowNotes(describedRow.def) }
    : { title: showingUnified ? (searchResult ? 'Search Results' : 'Modified Settings') : form.page.title, text: showingUnified ? '' : form.page.description ?? '', notes: [] }
  const showDescription = (showingUnified && unifiedEntries.length > 0) || (!showingUnified && form.page.layout !== 'shortcuts')

  const snippetFor = (row: SettingRow): ReactNode => {
    if (!searchResult) return undefined
    if (highlightParts(row.def.label, query).some(part => part.match)) return undefined
    const parts = highlightParts(descriptionExcerpt(row.def.description, query), query)
    if (!parts.some(part => part.match)) return undefined
    return parts.map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text)
  }

  const groups = (list: readonly RowGroup[]) => list.map((group, index) => <section key={group.label ?? index} className="options-group" role="group" aria-label={group.label} aria-description={group.description}>
    {group.label && <div className="options-section-head"><h4 className="options-category">{highlight(groupHeading(form.page.id, group.label))}</h4>{group.description && <p className="options-section-description">{group.description}</p>}</div>}
    <div className="options-grid">
      {group.rows.map(row => <FormRow key={row.key} row={row} error={errors.get(row.key)} focused={row.key === focused} label={highlight(row.def.label)}
        onFocus={() => setFocused(row.key)} onHover={() => setHovered(row.key)} onLeave={() => setHovered(current => current === row.key ? undefined : current)}
        onChange={text => change(row.key, text)} onReset={() => resetOneSetting(row.key)} />)}
    </div>
  </section>)

  const path = pagePath(form.page.id), ancestors = path.slice(0, -1).map(node => node.title).join(' › ')
  const formStyle = { '--options-rail-width': `${effectiveRailWidth}px` } as CSSProperties
  const runThemeCommand = commands ? (id: 'preferences.createTheme' | 'preferences.openThemesFolder') => { void commands.execute(id, undefined, 'toolbar') } : undefined

  const pendingParts: string[] = []
  if (pendingSettings) pendingParts.push(`${pendingSettings} ${pendingSettings === 1 ? 'setting' : 'settings'}`)
  if (themePatch) pendingParts.push('1 theme preference')
  if (stagedShortcuts) pendingParts.push(`${stagedShortcuts} ${stagedShortcuts === 1 ? 'shortcut' : 'shortcuts'}`)
  const pendingSummary = pendingParts.length ? `${pendingParts.join(', ')} pending` : appliedNotice ? 'Changes applied' : ''

  return <DialogWindow kind="options" onClose={finishClose} raise={request}><form ref={setForm} style={formStyle} className="connection-modal options-dialog" data-options-dialog role="dialog" aria-modal="true" aria-labelledby="options-title" noValidate tabIndex={-1}
    onSubmit={event => { event.preventDefault(); void commit(false) }} onKeyDown={keyDown}>
    <DialogHeading id="options-title" title="Options" closeLabel="Close options" disabled={saving} onClose={requestClose} />
    <div className="options-body">
      <div className="options-nav">
        <div className="options-nav-top">
          <div className="options-search-box">
            <Icon name="search" />
            <input ref={search} type="search" className="ui-field options-search" data-options-search placeholder={platform === 'darwin' ? 'Search Options (⌘E)' : 'Search Options (Ctrl+E)'} aria-label="Search Options"
              maxLength={256} value={query} autoFocus onChange={event => changeQuery(event.target.value)} />
            {query && <button type="button" className="ui-button icon-button options-search-clear" aria-label="Clear search" title="Clear search" onClick={() => { changeQuery(''); search.current?.focus() }}><Icon name="close" /></button>}
          </div>
          <div className="options-nav-filters">
            <button type="button" className="chip options-modified-pill" aria-pressed={modifiedOnly} onClick={toggleModified}>
              Modified ({totalUnsaved})
            </button>
          </div>
        </div>
        {shownTree && !rows.length
          ? <p className="options-empty">{query.trim() ? 'No matching pages.' : 'No modified pages.'}</p>
          : <ul ref={tree} className="options-pages" role="tree" aria-label="Options pages" onKeyDown={treeKeyDown}>
            {rows.map(row => {
              const count = pageCounts.get(row.page.id)
              const hasMod = unsavedList.some(def => def.page === row.page.id) || (row.page.id === 'environment.general' && unsavedTheme) || (row.page.id === shortcutsPage && stagedShortcuts > 0)
              return <li key={row.page.id} role="treeitem" aria-label={row.page.title} aria-level={row.level} aria-expanded={row.expandable ? row.expanded : undefined} aria-selected={!showingUnified && row.page.id === page}
                tabIndex={row.page.id === focusId ? 0 : -1} data-page={row.page.id} data-count={count ? String(count) : undefined} data-modified={hasMod || undefined}
                style={{ paddingLeft: 4 + (row.level - 1) * 14 }}
                onClick={() => showPage(row.page.id, row.page.id)} onFocus={() => setTreeFocus(row.page.id)}>
                <span className="options-twisty">{row.expandable && <Icon name="chevron-right" />}</span>{highlight(row.page.title)}
              </li>
            })}
          </ul>}
      </div>
      <div className={'options-splitter' + (draggingSplit ? ' is-dragging' : '')} role="separator" aria-orientation="vertical" aria-label="Resize options navigation"
        aria-valuenow={effectiveRailWidth} aria-valuemin={optionsRailLimits.minWidth} aria-valuemax={optionsRailLimits.maxWidth} tabIndex={0}
        onPointerDown={startPointerSplitter} onKeyDown={splitterKeyDown} onDoubleClick={() => { setRailWidth(optionsRailLimits.defaultWidth); saveOptionsRailWidth(optionsRailLimits.defaultWidth) }} />
      <div className="options-page">
        {showingUnified ? <>
          <h3 className="options-heading">
            <span className="options-title">{searchResult ? 'Search Results' : 'Modified Settings'}</span>
          </h3>
          {unifiedEntries.length === 0
            ? <p className="options-empty" role="status">{query.trim() ? 'No settings match.' : 'No unsaved changes.'}</p>
            : <div className="options-form options-search-results">
              {unifiedEntries.map(entry => <div key={entry.pageId} className="options-search-group">
                <button type="button" className="options-search-crumb" onClick={() => showPage(entry.pageId)}>{entry.path} ›</button>
                {entry.showTheme && themeState && <ThemeSection preference={themeDraft} themes={themeState.themes} activeType={effectiveTypeFor(themeDraft, themeState.active.type)} highlight={highlight} onChange={previewThemePreference} onCommand={runThemeCommand} />}
                {entry.settings.length > 0 && <div className="options-grid">
                  {entry.settings.map(row => <FormRow key={row.key} row={row} error={errors.get(row.key)} focused={row.key === focused} label={highlight(row.def.label)} descriptionSnippet={snippetFor(row)}
                    onFocus={() => setFocused(row.key)} onHover={() => setHovered(row.key)} onLeave={() => setHovered(current => current === row.key ? undefined : current)}
                    onChange={text => change(row.key, text)} onReset={() => resetOneSetting(row.key)}
                    onRevert={modifiedOnly && unsavedSet.has(row.key) ? () => revertOneSetting(row.key) : undefined} />)}
                </div>}
                {entry.showShortcuts && <div className="options-shortcut-hit">
                  <span>Keyboard and mouse shortcuts ({stagedShortcuts ? `${stagedShortcuts} staged` : 'Open page to search or assign keys'})</span>
                  <button type="button" className="ui-button" data-control-variant="secondary" data-control-size="dense" onClick={() => showPage(shortcutsPage)}>Open Shortcuts…</button>
                </div>}
              </div>)}
            </div>}
        </> : <>
          {(searchResult || modifiedOnly) && <div className="options-filter-bar">
            <button type="button" className="options-back-link" onClick={() => setBrowseScope('all')}><Icon name="arrow-left" />Back to all {searchResult ? 'search results' : 'modified settings'}</button>
          </div>}
          <h3 className="options-heading">{ancestors && <span className="options-crumb">{ancestors}<span className="visually-hidden"> › </span></span>}<span className="options-title">{form.page.title}</span></h3>
          {form.page.layout === 'form' && form.page.description && <p className="options-note">{highlight(form.page.description)}</p>}
          {form.page.id === 'objectExplorer.commands' && indexStorageText && <p className="options-note" data-tone="warning" role="note"><Icon name="warning" /><span>{indexStorageText}</span></p>}
          {form.page.layout === 'shortcuts'
            ? <ShortcutsPage draft={shortcutDraft} stored={shortcutEdit.base.file} platform={platform} files={shortcuts} capture={capture} linked={linked}
              salvaged={shortcutsState.salvaged ? shortcutsState.notice ?? '' : undefined} onChange={next => { setShortcutDraft(next); setError(''); setAppliedNotice(false); setConfirmClose(false) }} />
            : form.page.layout === 'propertyGrid'
              ? <PropertyGrid label={form.page.title} groups={form.groups.map(group => ({ ...group, rows: group.rows.map(settingGridRow) }))} idPrefix="setting-" fieldSize="dense" focused={focused} errors={errors}
                onFocusRow={key => setFocused(key)} onHoverRow={setHovered} onChange={(key, text) => change(key as SettingKey, text)} onResetRow={key => resetOneSetting(key as SettingKey)} renderLabel={highlight} />
              : <div className="options-form">
                {form.provider === 'theme' && (themeState
                  ? <ThemeSection preference={themeDraft} themes={themeState.themes} activeType={effectiveTypeFor(themeDraft, themeState.active.type)} highlight={highlight} onChange={previewThemePreference} onCommand={runThemeCommand} />
                  : <p className="options-note">{highlight('Color theme')}: View › Theme</p>)}
                {groups(form.groups)}
                {form.page.id === 'environment.fontsAndColors' && <SqlFontPreview fontSize={Number(draft['environment.fonts.editorFontSize'])} theme={themeState?.active} />}
              </div>}
        </>}
      </div>
    </div>
    {showDescription && <div className="options-description">
      <div className="options-description-head"><strong>{described.title}</strong>{described.notes.length > 0 && <span className="options-description-notes">{described.notes.join(' ')}</span>}</div>
      {described.text && <p>{described.text}</p>}
    </div>}
    {error && <p className="connect-error options-error" role="alert">{error}</p>}
    <DialogFooter
      leading={!showingUnified && form.page.layout !== 'shortcuts' ? <button type="button" className="ui-button" data-control-variant="secondary" onClick={() => {
        setDraft(current => resetPage(current, page, platform))
        if (page === 'environment.general' && themeState) previewThemePreference(defaultThemePreference)
        setErrors(new Map()); setError(''); setAppliedNotice(false); setConfirmClose(false)
      }}>Reset Page</button> : undefined}
      status={<span className={'options-staged' + (appliedNotice && !totalPending ? ' is-saved' : '')}>{pendingSummary && <>{totalPending > 0 && <span className="shortcuts-dot" aria-hidden="true" />}{pendingSummary}</>}</span>}
      trailing={<>
        <button type="button" className="ui-button" data-control-variant="secondary" disabled={saving || totalPending === 0} onClick={() => void commit(true)}>Apply</button>
        <button className="ui-button primary" type="submit" disabled={saving}>OK</button>
        <button className="ui-button" data-control-variant="secondary" type="button" disabled={saving} onClick={requestClose}>Cancel</button>
      </>}
      confirm={confirmClose ? {
        message: `You have ${totalPending} unsaved ${totalPending === 1 ? 'change' : 'changes'}. Discard changes?`,
        disabled: saving,
        onKeep: dismissConfirmClose,
        onDiscard: finishClose
      } : undefined}
    />
  </form></DialogWindow>
}
