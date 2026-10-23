// Database Properties as a document, without the DOM: which control each option gets, which sections need attention,
// and the state the header shows. Node tests run it; the sections render what it decides.
import type { PageId } from '../../../shared/actions/catalog.ts'
import { databaseStatusText, type DatabaseOptionDef } from '../../../shared/actions/database.ts'
import type { DatabasePropertiesModel } from '../../../shared/actions/schema.ts'
import type { StatusTone } from '../../../shared/theme/tones'
import { segmentedMaximum } from '../kit/Segmented'

/**
 * How a property shows (Calm Pro's property sheets): a fact as text when Varia does not change it, a boolean as a switch,
 * an enum of four values or fewer as a segmented control and a longer or server-supplied one as a list, a number as a
 * number field, and PRIMARY-or-a-number as a field with suggestions.
 */
export type FieldControl = 'fact' | 'switch' | 'segmented' | 'select' | 'integer' | 'combo'
export function fieldControl(def: DatabaseOptionDef): FieldControl {
  if (!def.settable || def.control === 'text') return 'fact'
  if (def.control === 'bool') return 'switch'
  if (def.control === 'integer') return def.choices ? 'combo' : 'integer'
  return def.choices && def.choices.length <= segmentedMaximum ? 'segmented' : 'select'
}

/** The section a field's problem marks in the section list: the owner is on Files, every option on Options. */
export const problemSection = (key: string): PageId => key === 'owner' ? 'files' : 'options'
export function problemSections(errors: ReadonlyMap<string, string>): ReadonlySet<PageId> { return new Set([...errors.keys()].map(problemSection)) }

/**
 * The header's state pill, from the describe's state: a database that is not online is critical, one restoring or
 * recovering is running, a read-only or single-user one needs attention, and an online multi-user one is fine. The pill
 * says SMO's words ("Normal", "Restoring, Standby", "Normal, Read-Only"), so the colour only repeats them.
 */
export function databaseStatusPill(model: DatabasePropertiesModel): { readonly tone: StatusTone; readonly label: string } {
  const { status, standby } = model.general, readOnly = model.options.readOnly === 'true', access = model.options.restrictAccess
  const words = databaseStatusText(status, { standby, readOnly })
  const label = access === 'SINGLE_USER' ? `${words}, Single User` : access === 'RESTRICTED_USER' ? `${words}, Restricted User` : words
  const tone: StatusTone = status === 'RESTORING' || status === 'RECOVERING' ? 'running'
    : status !== 'ONLINE' ? 'critical'
      : readOnly || access === 'SINGLE_USER' || access === 'RESTRICTED_USER' ? 'warning' : 'success'
  return { tone, label }
}

/** A boolean option's words for each state, as SSMS's grid says them. */
export function switchStates(def: DatabaseOptionDef): { readonly on: string; readonly off: string } {
  return { on: def.choices?.find(choice => choice.token === 'true')?.label ?? 'True', off: def.choices?.find(choice => choice.token === 'false')?.label ?? 'False' }
}

/** "16.00 MB": two decimals in the person's locale, as SSMS shows sizes; unknown as blank. */
export const megabytes = (value: number | undefined) => value === undefined ? '' : `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`
/** A date in the person's locale; 'None' (no backup) as is; unknown as blank. */
export const dateText = (value: string | undefined) => value === undefined ? '' : value === 'None' ? 'None' : Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString()
