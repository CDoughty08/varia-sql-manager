// A live grid's column value filter (the header funnel's popover over a live source): the checklist's entries from the
// source's facets, and the filter its ticks ask for. The filter travels to the backend as the source's args (an
// Activity Monitor pane's ActivityColumnFilter, applied by ActivityFilter.cs), never filtering on the client.
import type { LiveFacet } from '../../../shared/live/schema'

/** Rows whose cell equals one of `values`, or is blank (`blanks`), or is not blank (`nonBlanks`); ActivityColumnFilter's shape. */
export interface LiveValueFilter {
  readonly values?: readonly string[]
  readonly blanks?: boolean
  readonly nonBlanks?: boolean
}
export interface LiveFilterEntry {
  readonly text: string
  /** Rows with this value in the last sample; undefined for a chosen value no row shown now has. */
  readonly count?: number
}
/** The checklist: its value entries, and which are ticked; (Blanks) is an entry of its own, like NULL in a results grid. */
export interface LiveFilterTicks {
  readonly entries: readonly LiveFilterEntry[]
  readonly ticked: ReadonlySet<string>
  readonly blanks: boolean
}

/**
 * The checklist a funnel opens with: the facet's values (blank ones are (Blanks)), then any value the filter has that the
 * facets no longer list (other filters hid its rows, or it fell out of the most frequent), so a filter on is always shown.
 * No filter ticks everything; (Non-blanks) ticks every value and not (Blanks).
 */
export function liveFilterTicks(facet: LiveFacet | undefined, filter: LiveValueFilter | undefined): LiveFilterTicks {
  const listed: LiveFilterEntry[] = (facet?.values ?? []).filter(value => value.text !== '').map(value => ({ text: value.text, count: value.count }))
  const chosen = filter?.values ?? []
  const entries = [...listed, ...chosen.filter(text => text !== '' && !listed.some(entry => entry.text === text)).map(text => ({ text }))]
  if (!filter || (!filter.values?.length && !filter.blanks && !filter.nonBlanks)) return { entries, ticked: new Set(entries.map(entry => entry.text)), blanks: true }
  if (filter.nonBlanks) return { entries, ticked: new Set(entries.map(entry => entry.text)), blanks: !!filter.blanks }
  return { entries, ticked: new Set(chosen), blanks: !!filter.blanks }
}

/** What OK applies: a filter, none (`clear`: everything ticked), or why it cannot. */
export type LiveFilterOutcome = { readonly filter: LiveValueFilter } | { readonly clear: true } | { readonly error: string }

/**
 * The filter the ticks ask for. Every value ticked is no filter, or (Non-blanks) without (Blanks); otherwise the ticked
 * values (with (Blanks) when ticked), at most `maxValues` of them. Values the facets did not list (`more`) are not ticked,
 * so a value list leaves their rows out, as the popover's note says.
 */
export function liveFilterOutcome(ticks: LiveFilterTicks, maxValues: number): LiveFilterOutcome {
  const values = ticks.entries.filter(entry => ticks.ticked.has(entry.text)).map(entry => entry.text)
  if (values.length === ticks.entries.length) return ticks.blanks ? { clear: true } : { filter: { nonBlanks: true } }
  if (values.length === 0) return ticks.blanks ? { filter: { blanks: true } } : { error: 'Select at least one value.' }
  if (values.length > maxValues) return { error: `A column filter holds at most ${maxValues} values: untick some, or Select none and tick the ones to show.` }
  return { filter: { values, ...ticks.blanks ? { blanks: true } : {} } }
}
