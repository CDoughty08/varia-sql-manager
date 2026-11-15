import { Emitter } from '../core/events'
import type { Disposable } from '../core/types'
import { formatCount } from '../results/status'
import { entryName, entryOf, pivotOutOfDate, type EntryKey, type ResultGroup, type ResultSetEntry, type ResultSlot, type TabResults } from '../results/ResultsService'

// The Tabs layout's navigation, without React: the top row's items, the view a group's tab selects, the next and previous
// item and view (Next Result, Previous Result and their view commands), and the overflow picker's rows, filter and window
// of drawn rows. The picker lists every view of a run, so a run of 1,000 results is a list of 1,000 or more rows of which
// it draws a screenful (tests/results-tabs.test.ts and tests/bench/grid.bench.ts measure that case).

/** The view the Tabs layout shows: the entry whose grid last had the focus, else the run's first. While a run streams the
 *  first stays selected, since results arrive after it; a tab the user picks is focused, so it stays picked. */
export function selectedEntry(tab: Pick<TabResults, 'sets' | 'focused'>): ResultSetEntry | undefined {
  return entryOf(tab.sets, tab.focused) ?? tab.sets[0]
}

/** One item of the top row: a group (its Table and Pivot) or a comparison. */
export interface TopItem { readonly key: EntryKey; readonly name: string; readonly group?: ResultGroup; readonly comparison?: ResultSlot }
/** The top row's items in the order drawn: the groups by ordinal, the comparisons after them. */
export function topItems(tab: Pick<TabResults, 'groups' | 'comparisons'>): TopItem[] {
  return [
    ...tab.groups.map(group => ({ key: group.table.key, name: entryName(group.table.entry), group })),
    ...tab.comparisons.map(slot => ({ key: slot.key, name: entryName(slot.entry), comparison: slot }))
  ]
}
/** The view a group's tab selects: the one it last showed, its Pivot while it has one, else its Table. */
export const groupView = (group: ResultGroup): EntryKey => group.selected === 'pivot' && group.pivot ? group.pivot.key : group.table.key

type Run = Pick<TabResults, 'sets' | 'focused' | 'groups' | 'comparisons'>
/** The group whose view is selected, if a group's (not a comparison's). */
export function selectedGroup(tab: Run): ResultGroup | undefined {
  const key = selectedEntry(tab)?.key
  return key === undefined ? undefined : tab.groups.find(group => group.table.key === key || group.pivot?.key === key)
}
/** The place in `topItems(tab)` of the selected item, or -1 without one. */
export function selectedItem(tab: Run, items: readonly TopItem[] = topItems(tab)): number {
  const group = selectedGroup(tab), key = selectedEntry(tab)?.key
  return items.findIndex(item => group ? item.group === group : item.key === key)
}
/** Next Result (`delta` 1) and Previous Result (-1): the view to select in the item that many places along the top row,
 *  wrapping round as the arrow keys do; a group's is the view it last showed. Undefined with fewer than two items. */
export function stepResult(tab: Run, delta: number): EntryKey | undefined {
  const items = topItems(tab)
  if (items.length < 2) return undefined
  const item = items[(((Math.max(0, selectedItem(tab, items)) + delta) % items.length) + items.length) % items.length]
  return item.group ? groupView(item.group) : item.key
}
/** Next and Previous Result View: the selected group's other view (its Table and its Pivot), wrapping round as the view
 *  tabs' arrow keys do. Undefined while a comparison is selected or the group has one view. */
export function stepView(tab: Run, delta: number): EntryKey | undefined {
  const group = selectedGroup(tab), key = selectedEntry(tab)?.key
  if (!group?.pivot) return undefined
  const views = [group.table.key, group.pivot.key], at = Math.max(0, views.indexOf(key ?? ''))
  return views[(((at + delta) % views.length) + views.length) % views.length]
}

/** One row of the picker: a group's Table, its Pivot (indented under it), or a comparison. `text` is what the filter
 *  matches, in lower case: the row's whole name ("pivot of result 3") and its kind. */
export interface PickerRow {
  readonly key: EntryKey
  /** What the row shows: "Result 3", "Pivot" (under its result) or the comparison's name. */
  readonly name: string
  /** The row's accessible name: "Result 3, Table", "Pivot of Result 3", "Differences: Result 1 → Result 2, Comparison". */
  readonly label: string
  /** Beside the name, muted: Table, Plan set, Out of date (a Pivot) or Comparison. */
  readonly detail: string
  readonly kind: 'table' | 'plan' | 'pivot' | 'comparison'
  readonly text: string
}
/** Every view of the run in the order the layout draws them: each group's Table then its Pivot, comparisons last. */
export function pickerRows(tab: Pick<TabResults, 'groups' | 'comparisons' | 'sorts'>): PickerRow[] {
  const rows: PickerRow[] = []
  for (const group of tab.groups) {
    const name = entryName(group.table.entry), detail = group.planSet ? 'Plan set' : 'Table'
    rows.push({ key: group.table.key, name, label: `${name}, ${detail}`, detail, kind: group.planSet ? 'plan' : 'table', text: `${name} ${detail}`.toLowerCase() })
    if (group.pivot) {
      const stale = pivotOutOfDate(tab, group), label = `Pivot of ${name}`
      rows.push({ key: group.pivot.key, name: 'Pivot', label: stale ? `${label}, out of date` : label, detail: stale ? 'Out of date' : '', kind: 'pivot', text: `${label}${stale ? ' out of date' : ''}`.toLowerCase() })
    }
  }
  for (const slot of tab.comparisons) {
    const name = entryName(slot.entry)
    rows.push({ key: slot.key, name, label: `${name}, Comparison`, detail: 'Comparison', kind: 'comparison', text: `${name} comparison`.toLowerCase() })
  }
  return rows
}
/** The rows whose text holds every word of `query`, ignoring case: "3 piv" finds the Pivot of Result 3 (and of 13, 30…). */
export function filterRows(rows: readonly PickerRow[], query: string): readonly PickerRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length === 0 ? rows : rows.filter(row => words.every(word => row.text.includes(word)))
}
/** The places of the rows the list draws, from `first` up to `end` (exclusive): those in view and `overscan` either side. */
export function pickerWindow(scrollTop: number, viewHeight: number, count: number, rowHeight: number, overscan = 2): [first: number, end: number] {
  const first = Math.max(0, Math.min(count, Math.floor(scrollTop / rowHeight) - overscan))
  return [first, Math.min(count, Math.max(first, Math.ceil((scrollTop + viewHeight) / rowHeight) + overscan))]
}
/** The list's scroll offset that shows row `at` whole, moving as little as it can. */
export function pickerScroll(scrollTop: number, viewHeight: number, at: number, rowHeight: number): number {
  const top = at * rowHeight
  if (top < scrollTop) return top
  return top + rowHeight > scrollTop + viewHeight ? Math.max(0, top + rowHeight - viewHeight) : scrollTop
}
/** The picker's footer: how many views, of which results, Pivots and comparisons; "12 of …" while a filter hides some. */
export function pickerSummary(rows: readonly PickerRow[], shown: number): string {
  let results = 0, pivots = 0, comparisons = 0
  for (const row of rows) { if (row.kind === 'pivot') pivots++; else if (row.kind === 'comparison') comparisons++; else results++ }
  const count = (value: number, one: string) => `${formatCount(value)} ${value === 1 ? one : one + 's'}`
  const parts = [count(results, 'result'), ...pivots ? [count(pivots, 'Pivot')] : [], ...comparisons ? [count(comparisons, 'comparison')] : []]
  return `${shown < rows.length ? `${formatCount(shown)} of ` : ''}${count(rows.length, 'view')}: ${parts.join(', ')}`
}

/**
 * Go to Result… asks the Tabs layout drawn for a query to open its picker. The request waits briefly for a layout that is
 * not drawn yet (the Results view was hidden behind Messages and is shown with it), which takes it when it mounts; one
 * drawn takes it at once. A request no layout took in time lapses, so a layout drawn much later never opens the picker
 * and takes the focus from whatever the user is doing then.
 */
export const pickerRequestMs = 2000
class PickerRequests {
  private readonly pending = new Map<string, number>()
  private readonly emitter = new Emitter<string>()
  request(tabId: string, now = performance.now()): void { this.pending.set(tabId, now); this.emitter.emit(tabId) }
  /** Whether a request for the tab was waiting and is still fresh; it is taken either way. */
  take(tabId: string, now = performance.now()): boolean {
    const at = this.pending.get(tabId)
    this.pending.delete(tabId)
    return at !== undefined && now - at <= pickerRequestMs
  }
  subscribe(listener: (tabId: string) => void): Disposable { return this.emitter.subscribe(listener) }
}
export const pickerRequests = new PickerRequests()
