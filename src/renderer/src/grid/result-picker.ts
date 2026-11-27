import type { MultiQueryTargetPhase } from '../../../shared/contracts'
import { Emitter } from '../core/events'
import type { Disposable } from '../core/types'
import { formatCount } from '../results/status'
import { entryName, entrySecondary, exactSuffix, hasMultiSummary, isSummaryActive, pivotOutOfDate, selectedEntry, summaryEntryKey, type EntryKey, type ResultGroup, type ResultSlot, type TabResults } from '../results/ResultsService'

// The Tabs layout's navigation, without React: the top row's items, the view a group's tab selects, the next and previous
// item and view (Next Result, Previous Result and their view commands), and the overflow picker's rows, filter and window
// of drawn rows. The picker lists every view of a run, so a run of 1,000 results is a list of 1,000 or more rows of which
// it draws a screenful (tests/results-tabs.test.ts and tests/bench/grid.bench.ts measure that case).

export { selectedEntry }

/** One item of the top row: a multi-server Summary tab, Combined tab, per-server tab, a single-server group (its Table
 *  and Pivot), or a comparison. `number` is a named result's positional text ("Result 2"), for its tooltip; an unnamed
 *  result's name is already its number. */
export interface TopItem {
  readonly key: EntryKey; readonly name: string; readonly number?: string; readonly group?: ResultGroup; readonly comparison?: ResultSlot
  /** A result whose name the query gave: its tab is capped at --varia-resultTab and ends in an ellipsis. A comparison is
   *  never capped: its `short` text is already bounded, and a cap would cut off the new side the middle shortening keeps. */
  readonly named?: true
  /** A comparison's tab text, "old → new" (`comparisonTabLabel`); its full `name` is the tab's accessible name and tooltip. */
  readonly short?: string
  /** Multi-server virtual Summary tab. */
  readonly summary?: true
  /** Multi-server Combined top tab (`Combined (k/N)`). */
  readonly combined?: true
  readonly combinedCount?: number
  readonly totalTargets?: number
  /** Multi-server per-server top tab metadata. */
  readonly targetKey?: string
  readonly targetIndex?: number
  readonly targetPhase?: MultiQueryTargetPhase
  readonly statementCount?: number
}
/** The characters a comparison's tab keeps of each side's name; a longer one is shortened in the middle. */
export const comparisonSideChars = 16
/** A name cut to `max` characters with an ellipsis in the middle, keeping its start and its end (where two results'
 *  names usually differ: "Orders by r…on (Result 3)"). */
export function shortenMiddle(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const head = Math.ceil((max - 1) / 2), tail = max - 1 - head
  return chars.slice(0, head).join('') + '…' + chars.slice(chars.length - tail).join('')
}
/** Shortens two comparison side names so they never collapse to the same truncated string (preserving distinct server
 *  prefixes such as `prod-sql-east-01` vs `prod-sql-west-01`). Non-colliding names keep `shortenMiddle` verbatim. */
export function shortenDistinct(a: string, b: string, max: number): [string, string] {
  const sa = shortenMiddle(a, max), sb = shortenMiddle(b, max)
  if (sa !== sb || a === b) return [sa, sb]
  const ca = Array.from(a), cb = Array.from(b)
  const limit = Math.min(ca.length, cb.length)
  let diff = 0
  while (diff < limit && ca[diff] === cb[diff]) diff++
  // Preserve from the start through the differing segment when it fits within `max`.
  if (diff < max - 2) {
    const head = Math.min(max - 1, Math.max(diff + 4, Math.ceil((max - 1) / 2)))
    const tail = Math.max(0, max - 1 - head)
    const cut = (chars: string[]) => chars.length <= max ? chars.join('') : chars.slice(0, head).join('') + '…' + (tail > 0 ? chars.slice(chars.length - tail).join('') : '')
    const ra = cut(ca), rb = cut(cb)
    if (ra !== rb) return [ra, rb]
  }
  // When a long shared prefix pushes the difference past `max`, keep a short lead + ellipsis + differing window.
  const lead = Math.min(4, Math.max(0, Math.floor((max - 3) / 3)))
  const room = Math.max(4, max - lead - 1)
  const windowOf = (chars: string[]) => {
    const start = Math.max(lead, Math.min(diff, Math.max(0, chars.length - room)))
    const end = Math.min(chars.length, start + room)
    const suffix = end < chars.length ? '…' : ''
    const body = chars.slice(start, suffix ? Math.min(end, start + Math.max(1, room - 1)) : end).join('')
    return (lead > 0 ? chars.slice(0, lead).join('') : '') + '…' + body + suffix
  }
  const wa = windowOf(ca), wb = windowOf(cb)
  return wa !== wb ? [wa, wb] : [a, b]
}
/** A comparison's tab text: its inputs' names old side first, each shortened in the middle ("Result 1 → Result 3") while
 *  preserving distinct server prefixes, without the "Differences:" its icon already says, and " (exact text)" when it
 *  compares text exactly. */
export function comparisonTabLabel(slot: Pick<ResultSlot, 'entry' | 'sources'>): string {
  const [old, neu] = slot.sources
  const exact = entryName(slot.entry).endsWith(exactSuffix) ? exactSuffix : ''
  if (!old || !neu) return entryName(slot.entry)
  const [left, right] = shortenDistinct(old.name, neu.name, comparisonSideChars)
  return `${left} → ${right}${exact}`
}

/** Counts distinct surviving server targets that have a complete in-memory result for `statementSlot`. */
export function combinedTargetCount(tab: Partial<Pick<TabResults, 'sets' | 'multi'>>, statementSlot: number): number {
  const sets = tab.sets ?? []
  const combined = sets.find(entry => entry.descriptor.kind === 'combined' && (entry.descriptor.statementSlot ?? 0) === statementSlot)
  const combinedRolledBack = combined ? !!(combined.descriptor.rolledBackPreview || combined.handle?.getSnapshot().rolledBackPreview) : undefined
  const seen = new Set<string>()
  for (const entry of sets) {
    if (entry.sample || entry.descriptor.kind !== 'rows' || !entry.descriptor.targetKey) continue
    if ((entry.descriptor.statementSlot ?? 0) !== statementSlot) continue
    const snap = entry.handle?.getSnapshot()
    if (snap && (snap.state !== 'complete' || snap.residence === 'remote')) continue
    if (tab.multi?.targets.find(item => item.targetKey === entry.descriptor.targetKey)?.phase === 'commitInDoubt') continue
    if (combinedRolledBack !== undefined) {
      const entryRolledBack = !!(entry.descriptor.rolledBackPreview || snap?.rolledBackPreview)
      if (entryRolledBack !== combinedRolledBack) continue
    }
    seen.add(entry.descriptor.targetKey)
  }
  return seen.size
}

type MultiTabShape = Pick<TabResults, 'groups' | 'comparisons'> & Partial<Pick<TabResults, 'multi' | 'sets' | 'focused' | 'activeSummary' | 'combinedCounts'>>

/** The top row's items in the order drawn: for single-server, groups by ordinal then comparisons; for multi-server,
 *  Summary (when `includeSummary` is true) → Combined (k/N) → per-server tabs (in target order) → any extra groups → comparisons. */
export function topItems(tab: MultiTabShape, includeSummary = true): TopItem[] {
  if (!hasMultiSummary(tab)) {
    return [
      ...tab.groups.map(group => {
        const number = entrySecondary(group.table.entry)
        return { key: group.table.key, name: entryName(group.table.entry), ...number ? { number, named: true as const } : {}, group }
      }),
      ...tab.comparisons.map(slot => ({ key: slot.key, name: entryName(slot.entry), short: comparisonTabLabel(slot), comparison: slot }))
    ]
  }
  const items: TopItem[] = includeSummary ? [{ key: summaryEntryKey, name: 'Summary', summary: true }] : []
  const targets = tab.multi!.targets
  const activeKey = tab.focused !== summaryEntryKey ? tab.focused : undefined
  const activeGroup = activeKey === undefined ? undefined : tab.groups.find(group => group.table.key === activeKey || group.pivot?.key === activeKey)

  const combinedGroups = tab.groups.filter(group => group.table.entry.descriptor.kind === 'combined')
  if (combinedGroups.length > 0) {
    const picked = (activeGroup && combinedGroups.includes(activeGroup) ? activeGroup : combinedGroups[0])!
    const slot = picked.table.entry.descriptor.statementSlot ?? 0
    const count = tab.combinedCounts?.get(picked.table.key) ?? combinedTargetCount(tab, slot)
    items.push({
      key: picked.table.key,
      name: `Combined (${count}/${targets.length})`,
      combined: true,
      combinedCount: count,
      totalTargets: targets.length,
      group: picked,
      statementCount: combinedGroups.length
    })
  }

  const assigned = new Set<ResultGroup>(combinedGroups)
  targets.forEach((target, targetIndex) => {
    const targetGroups = tab.groups.filter(group => group.table.entry.descriptor.targetKey === target.targetKey)
    if (targetGroups.length === 0) return
    for (const group of targetGroups) assigned.add(group)
    const picked = (activeGroup && targetGroups.includes(activeGroup) ? activeGroup : targetGroups[0])!
    items.push({
      key: picked.table.key,
      name: target.label,
      named: true,
      targetKey: target.targetKey,
      targetIndex,
      targetPhase: target.phase,
      group: picked,
      statementCount: targetGroups.length
    })
  })

  for (const group of tab.groups) {
    if (assigned.has(group)) continue
    const number = entrySecondary(group.table.entry)
    items.push({ key: group.table.key, name: entryName(group.table.entry), ...number ? { number, named: true as const } : {}, group })
  }

  for (const slot of tab.comparisons) {
    items.push({ key: slot.key, name: entryName(slot.entry), short: comparisonTabLabel(slot), comparison: slot })
  }
  return items
}
/** The view a group's tab selects: the one it last showed, its Pivot while it has one, else its Table. */
export const groupView = (group: ResultGroup): EntryKey => group.selected === 'pivot' && group.pivot ? group.pivot.key : group.table.key

type Run = Pick<TabResults, 'sets' | 'focused' | 'groups' | 'comparisons'> & Partial<Pick<TabResults, 'multi' | 'activeSummary' | 'combinedCounts'>>
/** The group whose view is selected, if a group's (not Summary or a comparison's). */
export function selectedGroup(tab: Run): ResultGroup | undefined {
  const key = selectedEntry(tab)?.key
  return key === undefined ? undefined : tab.groups.find(group => group.table.key === key || group.pivot?.key === key)
}
/** The place in `topItems(tab)` of the selected item, or -1 without one. */
export function selectedItem(tab: Run, items: readonly TopItem[] = topItems(tab)): number {
  if (isSummaryActive(tab)) return items.findIndex(item => item.summary)
  const group = selectedGroup(tab), selected = selectedEntry(tab), key = selected?.key
  if (hasMultiSummary(tab)) {
    if (group?.table.entry.descriptor.kind === 'combined') return items.findIndex(item => item.combined)
    const targetKey = group?.table.entry.descriptor.targetKey
    if (targetKey) return items.findIndex(item => item.targetKey === targetKey)
  }
  return items.findIndex(item => group ? item.group === group : item.key === key)
}
/** Ordered navigation targets for Stacked layout (`includeSummary === false`) in multi-server runs: every group in
 *  stacked order (Combined first, then each target's groups in `tab.multi.targets` order, remaining groups, then
 *  comparisons) without collapsing multiple statements under one top tab. */
function stackedItems(tab: Run): { readonly key: EntryKey; readonly group?: ResultGroup; readonly comparison?: ResultSlot }[] {
  const items: { readonly key: EntryKey; readonly group?: ResultGroup; readonly comparison?: ResultSlot }[] = []
  const added = new Set<ResultGroup>()
  const pushGroup = (group: ResultGroup) => {
    if (added.has(group)) return
    added.add(group)
    items.push({ key: group.table.key, group })
  }
  for (const group of tab.groups) if (group.table.entry.descriptor.kind === 'combined') pushGroup(group)
  for (const target of tab.multi!.targets) {
    for (const group of tab.groups) {
      if (group.table.entry.descriptor.targetKey === target.targetKey) pushGroup(group)
    }
  }
  for (const group of tab.groups) pushGroup(group)
  for (const slot of tab.comparisons) items.push({ key: slot.key, comparison: slot })
  return items
}
/** Next Result (`delta` 1) and Previous Result (-1): the view to select in the item that many places along the top row,
 *  wrapping round as the arrow keys do; a group's is the view it last showed, and Summary returns `summaryEntryKey`.
 *  Pass `includeSummary = false` in Stacked layout when result sets exist so stepping wraps across every real grid in
 *  stacked order (including every multi-server statement slot). Undefined with fewer than two items. */
export function stepResult(tab: Run, delta: number, includeSummary = true): EntryKey | undefined {
  if (!includeSummary && hasMultiSummary(tab)) {
    const items = stackedItems(tab)
    if (items.length < 2) return undefined
    const group = selectedGroup(tab), key = selectedEntry(tab)?.key
    const at = Math.max(0, items.findIndex(item => group ? item.group === group : item.key === key))
    const item = items[(((at + delta) % items.length) + items.length) % items.length]
    return item.group ? groupView(item.group) : item.key
  }
  const items = topItems(tab, includeSummary)
  if (items.length < 2) return undefined
  const item = items[(((Math.max(0, selectedItem(tab, items)) + delta) % items.length) + items.length) % items.length]
  return item.summary ? summaryEntryKey : item.group ? groupView(item.group) : item.key
}
/** Go to Result 1 to 8 (`place` 1 to 8) and Go to Last Result (`place` 'last'), as a browser's Ctrl+1 to Ctrl+9 pick its
 *  tabs: the view to select in that item of the top row (or stacked order when `includeSummary === false`), a group's
 *  being the view it last showed. Undefined when the run has no such item. */
export function jumpResult(tab: Run, place: number | 'last', includeSummary = true): EntryKey | undefined {
  if (!includeSummary && hasMultiSummary(tab)) {
    const items = stackedItems(tab), at = place === 'last' ? items.length - 1 : place - 1
    const item = items[at]
    if (!item) return undefined
    return item.group ? groupView(item.group) : item.key
  }
  const items = topItems(tab, includeSummary), at = place === 'last' ? items.length - 1 : place - 1
  const item = items[at]
  if (!item) return undefined
  return item.summary ? summaryEntryKey : item.group ? groupView(item.group) : item.key
}
/** Next and Previous Result View: the selected group's other view (its Table and its Pivot), wrapping round as the view
 *  tabs' arrow keys do. Undefined while Summary or a comparison is selected or the group has one view. */
export function stepView(tab: Run, delta: number): EntryKey | undefined {
  const group = selectedGroup(tab), key = selectedEntry(tab)?.key
  if (!group?.pivot) return undefined
  const views = [group.table.key, group.pivot.key], at = Math.max(0, views.indexOf(key ?? ''))
  return views[(((at + delta) % views.length) + views.length) % views.length]
}

/** One row of the picker: Summary (for multi-server runs), a group's Table, its Pivot (indented under it), or a comparison.
 *  `text` is what the filter matches, in lower case: the row's whole name ("pivot of result 3"), a named result's number,
 *  and its kind. */
export interface PickerRow {
  readonly key: EntryKey
  /** What the row shows: "Summary", "Result 3" or the query's name for it ("Open orders"), "Pivot" (under its result) or the
   *  comparison's name. */
  readonly name: string
  /** A named result's positional text ("Result 3"), shown after its name as secondary text: two results of one name are
   *  told apart by it. */
  readonly number?: string
  /** The row's accessible name: "Summary, Multi-server summary", "Result 3, Table", "Open orders, Result 3, Table",
   *  "Pivot of Result 3", "Differences: Result 1 → Result 2, Comparison". */
  readonly label: string
  /** Beside the name, muted: Summary, Table, Combined, Plan set, Out of date (a Pivot) or Comparison. */
  readonly detail: string
  readonly kind: 'summary' | 'table' | 'plan' | 'pivot' | 'comparison'
  readonly text: string
}
/** Every view of the run in the order the layout draws them: Summary (when multi-server), each group's Table then its Pivot, comparisons last. */
export function pickerRows(tab: Pick<TabResults, 'groups' | 'comparisons' | 'sorts'> & Partial<Pick<TabResults, 'multi'>>): PickerRow[] {
  const rows: PickerRow[] = []
  if (hasMultiSummary(tab)) {
    rows.push({ key: summaryEntryKey, name: 'Summary', label: 'Summary, Multi-server summary', detail: 'Summary', kind: 'summary', text: 'summary multi server overview' })
  }
  for (const group of tab.groups) {
    const name = entryName(group.table.entry)
    const detail = group.planSet ? 'Plan set' : group.table.entry.descriptor.kind === 'combined' ? 'Combined' : 'Table'
    const number = entrySecondary(group.table.entry)
    const named = number ? `${name}, ${number}` : name, words = number ? `${name} ${number}` : name
    rows.push({ key: group.table.key, name, ...number ? { number } : {}, label: `${named}, ${detail}`, detail, kind: group.planSet ? 'plan' : 'table', text: `${words} ${detail}`.toLowerCase() })
    if (group.pivot) {
      // The Pivot's own title, as its tab and close button say it: made from one of two results of one name, it has the
      // number ("Pivot of Totals (Result 3)").
      const stale = pivotOutOfDate(tab, group), label = entryName(group.pivot.entry)
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
  let summaries = 0, results = 0, pivots = 0, comparisons = 0
  for (const row of rows) {
    if (row.kind === 'summary') summaries++
    else if (row.kind === 'pivot') pivots++
    else if (row.kind === 'comparison') comparisons++
    else results++
  }
  const count = (value: number, one: string) => `${formatCount(value)} ${value === 1 ? one : one + 's'}`
  const parts = [...summaries ? [`${formatCount(summaries)} summary`] : [], ...results || !summaries ? [count(results, 'result')] : [], ...pivots ? [count(pivots, 'Pivot')] : [], ...comparisons ? [count(comparisons, 'comparison')] : []]
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

/**
 * Next Result, Previous Result and Go to Result N in the Stacked layout: the stack drawn for the query scrolls the
 * selected view into view (opening it when collapsed), so its grid mounts, and moves the focus there when the focus was in
 * the stack. A stack not drawn yet (the Results view hidden behind Messages, or its pane closed and opened again for the
 * command) takes the request when it mounts, as Go to Result…'s picker does; one no stack took in time lapses.
 */
class StackReveals {
  private readonly pending = new Map<string, { readonly key: EntryKey; readonly at: number }>()
  private readonly emitter = new Emitter<string>()
  request(tabId: string, key: EntryKey, now = performance.now()): void { this.pending.set(tabId, { key, at: now }); this.emitter.emit(tabId) }
  /** The view a request for the tab asked for, if one waits and is still fresh; it is taken either way. */
  take(tabId: string, now = performance.now()): EntryKey | undefined {
    const request = this.pending.get(tabId)
    this.pending.delete(tabId)
    return request && now - request.at <= pickerRequestMs ? request.key : undefined
  }
  subscribe(listener: (tabId: string) => void): Disposable { return this.emitter.subscribe(listener) }
}
export const stackReveals = new StackReveals()
