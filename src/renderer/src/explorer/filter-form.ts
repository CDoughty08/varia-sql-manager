// Filter Settings as a form: the dialog's rows and the filter they set, without the DOM, so the rules run in Node.
import { filterProperties, type FilterProperty } from '../../../shared/explorer/catalog.ts'
import type { DateFilterOp, ExplorerFilter, TextFilterOp } from '../../../shared/explorer/refs.ts'
import { explorerFilterSchema } from '../../../shared/explorer/schema.ts'

/** SSMS's operator names. */
export const textOpLabels: Readonly<Record<TextFilterOp, string>> = { contains: 'Contains', equals: 'Equals', notContains: 'Does not contain' }
export const dateOpLabels: Readonly<Record<DateFilterOp, string>> = {
  equals: 'Equals', lessThan: 'Less than', lessOrEqual: 'Less than or equal', greaterThan: 'Greater than', greaterOrEqual: 'Greater than or equal', between: 'Between', notBetween: 'Not between'
}
/** One property's row: its operator and value (dates as `yyyy-mm-dd`, the second only for a range); '' means unset. */
export interface FilterRow { readonly op: string; readonly value: string; readonly value2: string }
export type FilterDraft = { readonly [P in FilterProperty]: FilterRow }
export type FilterProblems = Partial<Record<FilterProperty, string>>
export const isRange = (op: string): boolean => op === 'between' || op === 'notBetween'
const dateRange = 'Enter a date from 1753-01-01 to 9999-12-31.'

/** The rows for a folder's current filter: its values, else Contains (text) and Equals (dates) with no value. */
export function filterDraft(filter?: ExplorerFilter): FilterDraft {
  const row = (property: FilterProperty): FilterRow => {
    const value = filter?.[property]
    if (!value) return { op: property === 'created' ? 'equals' : 'contains', value: '', value2: '' }
    return { op: value.op, value: value.value, value2: 'value2' in value ? value.value2 ?? '' : '' }
  }
  return { name: row('name'), schema: row('schema'), owner: row('owner'), created: row('created') }
}

/**
 * The filter the rows set on a folder that allows `allowed`: every row with a value, combined with AND (SSMS). No
 * values at all clears the filter. Values are used as typed: names are never trimmed. Problems name the row they are in.
 */
export function draftFilter(draft: FilterDraft, allowed: readonly FilterProperty[]): { readonly ok: true; readonly filter: ExplorerFilter | undefined } | { readonly ok: false; readonly problems: FilterProblems } {
  const filter: Record<string, unknown> = {}, problems: FilterProblems = {}
  for (const property of allowed) {
    const { op, value, value2 } = draft[property]
    if (property !== 'created') { if (value) filter[property] = { op, value }; continue }
    const range = isRange(op)
    if (!value && !(range && value2)) continue
    if (!value) problems.created = 'Enter the first date.'
    else if (range && !value2) problems.created = 'Enter the second date.'
    else filter.created = range ? { op, value, value2 } : { op, value }
  }
  if (Object.keys(problems).length) return { ok: false, problems }
  if (!Object.keys(filter).length) return { ok: true, filter: undefined }
  const parsed = explorerFilterSchema.safeParse(filter)
  if (parsed.success) return { ok: true, filter: parsed.data }
  for (const issue of parsed.error.issues) {
    const property = filterProperties.find(name => name === issue.path[0])
    // A date the schema cannot read (a year past 9999, say) gets the range sentence rather than the pattern.
    if (property && !problems[property]) problems[property] = property === 'created' && issue.code !== 'custom' ? dateRange : issue.message
  }
  return { ok: false, problems: Object.keys(problems).length ? problems : { [allowed[0] ?? 'name']: parsed.error.issues[0]?.message ?? 'The filter is not valid.' } }
}
