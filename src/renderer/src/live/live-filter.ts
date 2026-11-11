// A live grid's funnel source (docs/ipc.md, LiveGrid): the results grid's ColumnFilterPopover over a live source's facets,
// the most frequent values of a column in the last sample. The facets become an in-memory DistinctList (the popover's
// snapshot protocol: read windows, ticks), and OK becomes a value filter the owner sends as the source's args (an Activity
// Monitor pane's ActivityColumnFilter, applied by ActivityFilter.cs): nothing filters on the client.
import type { DistinctValue, ResultsDistinctReadResult, ResultsDistinctResult } from '../../../shared/contracts'
import type { LiveFacet } from '../../../shared/live/schema'
import type { ColumnCondition } from '../results/column-filter'
import type { ColumnFilterSource, Condition } from '../results/ColumnFilterPopover'
import type { DistinctList } from '../results/ResultClient'
import { formatCount } from '../results/status'

/** Rows whose cell equals one of `values`, or is blank (`blanks`), or is not blank (`nonBlanks`); ActivityColumnFilter's shape. */
export interface LiveValueFilter {
  readonly values?: readonly string[]
  readonly blanks?: boolean
  readonly nonBlanks?: boolean
}
/** A facet list's values by text, for OK: the ticked ones, and whether every listed value is ticked. */
export interface FacetList extends DistinctList {
  readonly texts: readonly string[]
  ticked(): { readonly values: readonly string[]; readonly all: boolean; readonly blanks: boolean }
}

const empty = (filter: LiveValueFilter | undefined) => !filter || (!filter.values?.length && !filter.blanks && !filter.nonBlanks)

/**
 * The popover's snapshot over a column's facet: its values (blank text is NULL's entry, "(Blanks)"), then any value the
 * filter has that the facet no longer lists (other filters hid its rows, or it fell out of the most frequent), with a count
 * of 0, so a filter on stays visible. A value's group is its place in value order, and its row the same number (Equals
 * names a value by its row). The ticks start from the filter: none ticks everything, (Non-blanks) every value.
 */
export function facetList(column: number, facet: LiveFacet | undefined, filter: LiveValueFilter | undefined): FacetList {
  const counts = new Map<string, number>()
  let nulls = 0
  for (const value of facet?.values ?? []) { if (value.text === '') nulls = value.count; else counts.set(value.text, value.count) }
  for (const text of filter?.values ?? []) if (text !== '' && !counts.has(text)) counts.set(text, 0)
  const texts = [...counts.keys()].sort((a, b) => a.localeCompare(b))
  const checked = new Set<number>(empty(filter) || filter!.nonBlanks ? texts.map((_, group) => group) : texts.flatMap((text, group) => filter!.values?.includes(text) ? [group] : []))
  let nullsChecked = empty(filter) || !!filter!.blanks
  const values = (): DistinctValue[] => texts.map((text, group) => ({ group, row: group, text, count: counts.get(text) ?? 0, checked: checked.has(group) }))
  const matching = (search: string | undefined) => { const needle = search?.toLocaleLowerCase(); return needle ? values().filter(value => value.text.toLocaleLowerCase().includes(needle)) : values() }
  const summary: ResultsDistinctResult = {
    snapshotId: 0, rows: [...counts.values()].reduce((sum, count) => sum + count, nulls), complete: true, nulls, distinct: texts.length, approximate: false,
    checked: checked.size, nullsChecked
  }
  return {
    generation: 0, resultId: 0, snapshotId: 0, column, summary, texts,
    read: async ({ order, offset, count, search }): Promise<ResultsDistinctReadResult> => {
      const shown = matching(search)
      if (order === 'count') shown.sort((a, b) => b.count - a.count || a.group - b.group)
      return { total: shown.length, offset, values: shown.slice(offset, offset + count), checked: checked.size, nullsChecked }
    },
    tick: async ({ checked: on, groups, all, search, nulls: nullTick }) => {
      const targets = all ? matching(search).map(value => value.group) : groups ?? []
      for (const group of targets) { if (on) checked.add(group); else checked.delete(group) }
      if (nullTick !== undefined) nullsChecked = nullTick
      return { checked: checked.size, nullsChecked }
    },
    close: async () => {},
    ticked: () => ({ values: texts.filter((_, group) => checked.has(group)), all: checked.size === texts.length, blanks: nullsChecked })
  }
}

/** What a condition asks the source to filter by: a value filter, none (`undefined`, every value), or why it cannot. */
export function liveCondition(condition: ColumnCondition, texts: readonly string[], maxValues: number): { readonly filter: LiveValueFilter | undefined } | { readonly error: string } {
  switch (condition.kind) {
    case 'list': {
      const ticks = (condition.list as Partial<FacetList>).ticked?.()
      if (!ticks) return { error: 'The values could not be read.' }
      if (ticks.all) return { filter: ticks.blanks ? undefined : { nonBlanks: true } }
      if (ticks.values.length > maxValues) return { error: `A column filter holds at most ${formatCount(maxValues)} values.` }
      if (ticks.values.length === 0) return ticks.blanks ? { filter: { blanks: true } } : { error: 'Select at least one value.' }
      return { filter: { values: ticks.values, ...ticks.blanks ? { blanks: true } : {} } }
    }
    case 'equals': return texts[condition.row] === undefined ? { error: 'Choose a value.' } : { filter: { values: [texts[condition.row]] } }
    case 'null': return { filter: { blanks: true } }
    case 'notNull': return { filter: { nonBlanks: true } }
    case 'all': case 'clear': return { filter: undefined }
    default: return { error: 'This view cannot filter by that condition.' }
  }
}

/** The conditions a live source's value filters can express (no Does not equal or Between). */
export const liveConditions: readonly Condition[] = ['list', 'equals', 'null', 'notNull']

/**
 * A live grid's funnel source for ColumnFilterPopover: `columnId` names a shown column by its catalogue id, `facet` and
 * `filterOf` read the owner's facets and filters, and `apply` hands the owner a column's new filter (undefined: none).
 */
export function liveFilterSource(o: {
  columnId(column: number): string | undefined
  facet(id: string): LiveFacet | undefined
  filterOf(id: string): LiveValueFilter | undefined
  apply(id: string, filter: LiveValueFilter | undefined): void
  readonly maxValues: number
}): ColumnFilterSource {
  const lists = new Map<number, FacetList>()
  return {
    conditions: liveConditions,
    nullText: '(Blanks)',
    columnValues: async column => {
      const id = o.columnId(column)
      if (id === undefined) throw new Error('This column cannot be filtered.')
      const list = facetList(column, o.facet(id), o.filterOf(id))
      lists.set(column, list)
      return list
    },
    apply: (column, condition) => {
      const id = o.columnId(column)
      if (id === undefined) return false
      const outcome = liveCondition(condition, lists.get(column)?.texts ?? [], o.maxValues)
      if ('error' in outcome) return outcome.error
      o.apply(id, outcome.filter)
      return true
    },
    note: column => {
      const id = o.columnId(column), facet = id === undefined ? undefined : o.facet(id)
      return facet?.more ? `Only the ${formatCount(facet.values.length)} most frequent values of the last sample are listed.` : 'Values and counts are from the last sample.'
    }
  }
}
