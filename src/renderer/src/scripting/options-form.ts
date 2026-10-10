// Tools › Options › Scripting as a form: the dialog's rows and the options they set, without the DOM, so the rules run in Node.
import {
  defaultScriptingOptions, scriptingOptionDef, scriptingOptionDefs, scriptingOptionGroupLabels, scriptingOptionGroups, scriptingOptionsSchema,
  type ScriptingOptionDef, type ScriptingOptionGroup, type ScriptingOptionKey, type ScriptingOptions
} from '../../../shared/scripting/options.ts'

export interface OptionChoice { readonly value: string; readonly label: string }
/** One property row: its select's value and choices, whether it differs from its default (bold), and whether it is greyed. */
export interface OptionRow {
  readonly key: ScriptingOptionKey
  readonly label: string
  readonly value: string
  readonly choices: readonly OptionChoice[]
  readonly changed: boolean
  readonly disabled: boolean
}
export interface OptionCategory { readonly group: ScriptingOptionGroup; readonly label: string; readonly rows: readonly OptionRow[] }

const booleanChoices: readonly OptionChoice[] = [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]
const defs = scriptingOptionDefs as readonly ScriptingOptionDef[]
const valueText = (value: boolean | string) => typeof value === 'boolean' ? String(value) : value

/** Whether a row is greyed: the version rows while Match script settings to source is True, as in SSMS. */
export const optionDisabled = (def: ScriptingOptionDef, draft: ScriptingOptions): boolean =>
  def.disabledWhen !== undefined && (draft as Readonly<Record<string, boolean | string>>)[def.disabledWhen] === true

/** The page's categories in the docs page's order, each with its rows. */
export function optionCategories(draft: ScriptingOptions): OptionCategory[] {
  return scriptingOptionGroups.map(group => ({
    group, label: scriptingOptionGroupLabels[group],
    rows: defs.filter(def => def.group === group).map(def => {
      const key = def.key as ScriptingOptionKey, value = draft[key]
      return { key, label: def.label, value: valueText(value), choices: def.type === 'boolean' ? booleanChoices : def.values, changed: value !== def.default, disabled: optionDisabled(def, draft) }
    })
  }))
}

/** The draft with `key` set from its select's value; a value that is not one of the row's choices leaves it unchanged. */
export function setOption(draft: ScriptingOptions, key: ScriptingOptionKey, text: string): ScriptingOptions {
  const def = scriptingOptionDef(key)
  if (def.type === 'boolean') return text === 'true' || text === 'false' ? { ...draft, [key]: text === 'true' } : draft
  return def.values.some(choice => choice.value === text) ? { ...draft, [key]: text } : draft
}

/** Reset to Defaults: a new draft with every default; the stored options change only with OK. */
export const resetOptions = (): ScriptingOptions => ({ ...defaultScriptingOptions })

/** What OK stores: the complete draft, checked by the same strict schema as main and every request. */
export function validateOptions(draft: unknown): { readonly ok: true; readonly options: ScriptingOptions } | { readonly ok: false; readonly error: string } {
  const parsed = scriptingOptionsSchema.safeParse(draft)
  if (parsed.success) return { ok: true, options: parsed.data }
  const issue = parsed.error.issues[0], key = typeof issue?.path[0] === 'string' ? issue.path[0] : undefined
  const def = key ? defs.find(item => item.key === key) : undefined
  return { ok: false, error: def ? `${def.label} has a value that is not supported.` : 'The scripting options are not valid.' }
}

/** The description pane's text for a row. */
export function optionDescription(key: ScriptingOptionKey): { readonly label: string; readonly description: string } {
  const { label, description } = scriptingOptionDef(key)
  return { label, description }
}
