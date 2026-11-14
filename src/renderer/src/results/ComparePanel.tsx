import { useId, useRef } from 'react'
import { focusResultGrid } from '../grid/ResultGrid'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import type { UnpairedColumn } from './compare-pairing'
import { entryName, entryOf, type ResultSetEntry, type TabResults } from './ResultsService'
import { formatCount } from './status'

const nameOf = (column: UnpairedColumn) => column.name || '(No column name)'

/**
 * The Compare picker, in the pivot builder's place beside the grids. It opens on a group's Table (Compare…), which is the
 * new side (+); the Table picked from the list is the old side (−), and Swap turns them round. It lists each side's
 * columns the diff leaves out (pairing is the backend's rule: name and wire, no mapping), Exact text, and that the inputs'
 * filters and sorts are not applied, as a warning while either is sorted or filtered. Compare starts the comparison, or
 * shows it when the run already has it. Only the user closes it: while the query runs it waits, and while the run has no
 * Table of its group it says so.
 */
export default function ComparePanel({ tabId, tab }: { tabId: string; tab: TabResults }) {
  const { compare, results } = useWorkbench()
  const state = useServiceSnapshot(compare)
  useServiceSnapshot(results)
  const ids = useId()
  const panel = useRef<HTMLElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const picker = state.pickers[tabId]
  if (!picker) return null
  const waiting = tab.status === 'running' || tab.queryId !== picker.queryId
  const active = waiting ? undefined : entryOf(tab.sets, picker.active)
  const name = active ? entryName(active) : `Result ${picker.ordinal}`
  const targets = active ? compare.targetsOf(tabId, active.key) : []
  const sides = compare.sidesOf(tabId)
  const running = !!sides && compare.isRunning(tabId, sides.old.key, sides.neu.key, picker.exact)
  const shown = sides ? compare.existing(tabId, sides.old.key, sides.neu.key, picker.exact) : undefined
  const busy = (state.running[tabId]?.length ?? 0) > (running ? 1 : 0)
  const reordered = (entry: ResultSetEntry) => { const sort = results.sortOf(tabId, entry.key); return !!sort && (sort.keys.length > 0 || sort.filters.length > 0) }
  const filtered = sides ? [sides.old, sides.neu].filter(reordered) : []
  const unpaired = (list: readonly UnpairedColumn[], own: ResultSetEntry, other: ResultSetEntry) => list.map(column => <li key={own.key + ':' + column.index}>
    <span className="compare-owner">{entryName(own)}</span>
    <code className="compare-column">{nameOf(column)}</code>
    {column.otherType !== undefined && <span className="compare-why">{column.dataType}; {column.otherType} in {entryName(other)}</span>}
  </li>)
  // Compare (or Show It) shows the comparison: the keyboard focus goes to its grid too, unless the user has put it somewhere
  // other than this button since. The picker stays open.
  const start = async () => {
    const owner = panel.current?.ownerDocument, from = button.current
    const shown = await compare.run(tabId)
    const at = owner?.activeElement
    const lost = !at || at === owner.body || !at.isConnected || at === from
    if (shown !== undefined && lost && results.getSnapshot()[tabId]?.focused === shown) focusResultGrid(owner, tabId, shown)
  }
  const oldOnly = sides?.pairing.oldOnly ?? [], newOnly = sides?.pairing.newOnly ?? []
  return <aside ref={panel} className="profile-panel pivot-panel compare-panel" aria-label="Compare" aria-busy={running || undefined}>
    <div className="profile-head">
      <span className="profile-title">Compare</span>
      <span className="profile-facts">{name} · Table</span>
      <button type="button" className="icon-button" aria-label="Close Compare" title="Close Compare" onClick={() => compare.close(tabId)}><Icon name="close" /></button>
    </div>
    <div className="pivot-body">
      {sides && <div className="compare-sides">
        <div className="compare-side" role="group" aria-label="Old side"><small>Old side <span aria-hidden="true">−</span></small><b>{entryName(sides.old)}</b></div>
        <button type="button" className="icon-button" aria-label="Swap old and new" title="Swap old and new" onClick={() => compare.swap(tabId)}><Icon name="arrow-swap" /></button>
        <div className="compare-side" role="group" aria-label="New side"><small>New side <span aria-hidden="true">+</span></small><b>{entryName(sides.neu)}</b></div>
      </div>}
      <section className="pivot-section">
        <fieldset className="compare-targets">
          <legend>Compare {name} with</legend>
          {waiting ? <div className="pivot-hint">Waiting for the query to finish.</div>
            : !active ? <div className="pivot-hint">This run has no {name} open. Run the query again, or close Compare.</div>
              : targets.length === 0 && <div className="pivot-hint">No other result of this run shares a column with {name}.</div>}
          {targets.map(target => <label key={target.entry.key} className="compare-target">
            <input type="radio" name={ids + 'target'} checked={picker.target === target.entry.key} onChange={() => compare.pick(tabId, target.entry.key)} />
            <span className="compare-target-name">{entryName(target.entry)}</span>
            <small>{formatCount(target.pairing.pairs.length)} of {formatCount((active?.descriptor.columns ?? []).filter(column => column.role !== 'tone').length)} columns pair · {formatCount(target.entry.descriptor.rowsStored)} rows</small>
          </label>)}
        </fieldset>
        <div className="pivot-hint">Tables of this run that share a column. Pivots, comparisons and plan sets are not offered.</div>
      </section>
      {sides && <section className="pivot-section" aria-labelledby={ids + 'unpaired'}>
        <h3 id={ids + 'unpaired'}>Columns not compared</h3>
        {oldOnly.length + newOnly.length > 0 ? <ul className="pivot-list compare-unpaired">{unpaired(oldOnly, sides.old, sides.neu)}{unpaired(newOnly, sides.neu, sides.old)}</ul>
          : <div className="pivot-hint">Every column pairs.</div>}
        <div className="pivot-hint">Columns pair by name and by holding text or binary data, repeated names in order. There is no manual mapping.</div>
      </section>}
      <label className="compare-exact"><input type="checkbox" checked={picker.exact} onChange={event => compare.setExact(tabId, event.target.checked)} /> Exact text <small>(case and trailing spaces count)</small></label>
      <div className={filtered.length > 0 ? 'profile-note warning' : 'profile-note'}>
        {filtered.length > 0 && `${filtered.map(entryName).join(' and ')} ${filtered.length > 1 ? 'are' : 'is'} sorted or filtered here. `}A comparison reads the stored results; filters and sorts on the inputs are not applied.
      </div>
    </div>
    <div className="pivot-foot">
      {/* Mounted, and in the accessibility tree, while the picker is, so a failure written into it is read out. */}
      <div className={picker.error ? 'profile-note error' : picker.cancelled ? 'profile-note' : 'visually-hidden'} role="status">{picker.error ?? (picker.cancelled ? 'Comparison cancelled.' : '')}</div>
      {busy && <div className="profile-note">Another comparison of this run is running. Each runs on its own.</div>}
      {sides && <div className="profile-note">{shown ? `${entryName(shown)} is already open.` : running ? `Comparing ${entryName(sides.old)} with ${entryName(sides.neu)}…`
        : `Opens “Differences: ${entryName(sides.old)} → ${entryName(sides.neu)}”, a snapshot that outlives both results.`}</div>}
      <div className="compare-buttons">
        {running && sides
          ? <button type="button" onClick={() => compare.cancel(tabId, sides.old.key, sides.neu.key, picker.exact)}>Cancel</button>
          : <button type="button" onClick={() => compare.close(tabId)}>Close</button>}
        {/* Only aria-disabled while its comparison runs, so the keyboard focus stays on it and a failure is met there. */}
        <button ref={button} type="button" className="primary" disabled={!sides} aria-disabled={running || undefined} onClick={() => { if (!running) void start() }}>{shown ? 'Show It' : 'Compare'}</button>
      </div>
    </div>
  </aside>
}
