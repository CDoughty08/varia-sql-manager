// Tools › Options as a form: the page tree, each page's rows, the draft they edit, and what OK saves, without the DOM,
// so the rules run in Node.
import type { Platform } from '../../../shared/commands/keybindings'
import {
  defaultSettings, pageById, settingDefs, settingPages, visibleSettings, type SettingDef, type SettingKey, type SettingPage, type SettingsValues
} from '../../../shared/settings/catalog'
import { valueSchema, type SettingsPatch } from '../../../shared/settings/schema'
import type { GridRow } from './PropertyGrid'

/** The dialog's edits across every page: typed values, or the text of an integer field that is not a whole number yet. */
export type OptionsDraft = Readonly<Record<SettingKey, boolean | number | string>>
export interface OptionChoice { readonly value: string; readonly label: string }
/** One row: its control's value as text, whether it differs from its default (bold in a property grid), and whether it is greyed. */
export interface SettingRow {
  readonly key: SettingKey
  readonly def: SettingDef
  readonly value: string
  readonly choices?: readonly OptionChoice[]
  readonly changed: boolean
  readonly disabled: boolean
}
export interface RowGroup { readonly label?: string; readonly rows: readonly SettingRow[] }
/** A page as it shows: the provider's rows first (Environment › General's theme note), then its settings by group. */
export interface PageForm { readonly page: SettingPage; readonly provider?: 'theme'; readonly groups: readonly RowGroup[] }

const booleanChoices: readonly OptionChoice[] = [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]
/** The first page at or under `id` that has a layout: selecting a category shows it. */
export function firstPage(id: string): string {
  const page = pageById(id)
  if (!page || page.layout) return id
  const child = settingPages.find(node => node.parent === id)
  return child ? firstPage(child.id) : id
}
export const childrenOf = (id: string | undefined): readonly SettingPage[] => settingPages.filter(page => page.parent === id)
/** The ids of a page's ancestors, root first: what must be expanded for it to show. */
export function ancestorIds(id: string): string[] {
  const ids: string[] = []
  for (let page = pageById(id); page?.parent; page = pageById(page.parent)) ids.unshift(page.parent)
  return ids
}
export interface TreeRow { readonly page: SettingPage; readonly level: number; readonly expandable: boolean; readonly expanded: boolean }
/**
 * The tree's visible rows in order: children of expanded nodes, limited to `shown` (search results and their
 * ancestors) when given. `level` is 1-based, for aria-level.
 */
export function treeRows(expanded: ReadonlySet<string>, shown?: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (parent: string | undefined, level: number) => {
    for (const page of childrenOf(parent)) {
      if (shown && !shown.has(page.id)) continue
      const expandable = childrenOf(page.id).some(child => !shown || shown.has(child.id)), open = expandable && (expanded.has(page.id) || !!shown)
      rows.push({ page, level, expandable, expanded: open })
      if (open) walk(page.id, level + 1)
    }
  }
  walk(undefined, 1)
  return rows
}

const textOf = (value: boolean | number | string) => String(value)
/** Greyed: a `disabledWhen` setting is True, or an `enabledBy` setting is False, in the draft. */
export const rowDisabled = (def: SettingDef, draft: OptionsDraft): boolean =>
  (def.disabledWhen !== undefined && draft[def.disabledWhen as SettingKey] === true) || (def.enabledBy !== undefined && draft[def.enabledBy as SettingKey] === false)
export function settingRow(def: SettingDef, draft: OptionsDraft): SettingRow {
  const key = def.key as SettingKey, value = draft[key]
  return {
    key, def, value: textOf(value), changed: value !== def.default, disabled: rowDisabled(def, draft),
    ...def.type === 'boolean' ? { choices: booleanChoices } : def.type === 'enum' ? { choices: def.values } : {}
  }
}
/** A setting's row in a property grid: booleans and enums are lists, integers number fields. */
export const settingGridRow = (row: SettingRow): GridRow => ({
  key: row.key, label: row.def.label, description: row.def.description, control: row.def.type === 'integer' ? 'integer' : 'choice', value: row.value,
  ...row.choices ? { choices: row.choices } : {}, ...row.def.type === 'integer' ? { min: row.def.min, max: row.def.max } : {}, changed: row.changed, disabled: row.disabled
})
/** The page's rows on `platform`, grouped in catalogue order; hidden settings and other platforms' are left out. */
export function pageForm(pageId: string, draft: OptionsDraft, platform: Platform, defs: readonly SettingDef[] = settingDefs): PageForm {
  const page = pageById(pageId) ?? pageById('environment.general')!, groups: { label?: string; rows: SettingRow[] }[] = []
  for (const def of visibleSettings(platform, defs).filter(item => item.page === page.id)) {
    const group = groups.find(item => item.label === def.group) ?? groups[groups.push({ ...def.group ? { label: def.group } : {}, rows: [] }) - 1]
    group.rows.push(settingRow(def, draft))
  }
  return { page, ...page.provider ? { provider: page.provider } : {}, groups }
}

/** The draft with `key` set from its control's text: a boolean's 'true' or 'false', an enum's value, an integer's text. */
export function setDraftValue(draft: OptionsDraft, key: SettingKey, text: string, defs: readonly SettingDef[] = settingDefs): OptionsDraft {
  const def = defs.find(item => item.key === key)
  if (!def) return draft
  if (def.type === 'boolean') return text === 'true' || text === 'false' ? { ...draft, [key]: text === 'true' } : draft
  if (def.type === 'enum') return def.values.some(choice => choice.value === text) ? { ...draft, [key]: text } : draft
  // An integer field keeps what was typed; OK checks it.
  const trimmed = text.trim()
  return { ...draft, [key]: /^-?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : text }
}
/** Reset to Defaults: the page's visible rows take their defaults, in the draft only. */
export function resetPage(draft: OptionsDraft, pageId: string, platform: Platform, defs: readonly SettingDef[] = settingDefs): OptionsDraft {
  const next: Record<string, boolean | number | string> = { ...draft }
  for (const def of visibleSettings(platform, defs)) if (def.page === pageId) next[def.key] = def.default
  return next as OptionsDraft
}

export interface DraftError { readonly key: SettingKey; readonly page: string; readonly message: string }
/**
 * What OK may save: every value valid. Otherwise the problems in tree order, so the dialog can show the first one's
 * page and focus its field; an integer that is empty, not whole or out of range says its bounds.
 */
export function validateDraft(draft: OptionsDraft, defs: readonly SettingDef[] = settingDefs): { readonly ok: true; readonly values: SettingsValues } | { readonly ok: false; readonly errors: readonly DraftError[] } {
  const pageOrder = (def: SettingDef) => settingPages.findIndex(page => page.id === def.page)
  const errors = [...defs].sort((a, b) => pageOrder(a) - pageOrder(b)).flatMap((def): DraftError[] => {
    if (valueSchema(def).safeParse(draft[def.key as SettingKey]).success) return []
    const message = def.type === 'integer' ? `${def.label} must be a whole number from ${def.min.toLocaleString('en-US')} to ${def.max.toLocaleString('en-US')}.` : `${def.label} has a value that is not supported.`
    return [{ key: def.key as SettingKey, page: def.page, message }]
  })
  return errors.length ? { ok: false, errors } : { ok: true, values: draft as SettingsValues }
}
/** What OK sends: only the settings whose draft value differs from what main stored. */
export function patchFrom(stored: SettingsValues, draft: SettingsValues): SettingsPatch {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(stored) as SettingKey[]) if (draft[key] !== stored[key]) patch[key] = draft[key]
  return patch as SettingsPatch
}
/** The description pane's notes for a row: when a change applies, and whether SSMS has the option. */
export function rowNotes(def: SettingDef): string[] {
  return [def.applies === 'nextExecution' ? 'Applies to the next execution.' : def.applies === 'newConnections' ? 'Applies to new connections.' : '', def.varia ? 'Not in SSMS.' : ''].filter(Boolean)
}
export const draftFrom = (values: SettingsValues): OptionsDraft => ({ ...defaultSettings, ...values })
