import { useState, type KeyboardEvent } from 'react'
import { dateFilterOps, filterPropertyLabels, folderSpecs, textFilterOps, type FilterProperty } from '../../../shared/explorer/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { maxIdentifierLength } from '../../../shared/sql/identifiers.ts'
import { useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { trapFocus } from '../trap-focus'
import { dateOpLabels, draftFilter, filterDraft, isRange, textOpLabels, type FilterProblems, type FilterRow } from './filter-form'

/**
 * SSMS's Filter Settings for one folder: a row per property the folder allows, each with an operator and a value.
 * OK applies the rows that have a value (none clears the filter) and reloads the folder; Clear Filter empties the rows.
 * Enter is OK and Escape is Cancel. Focus then returns to the tree: OK selects the folder it reloaded, and Cancel goes
 * back to the row that was selected (the capped row the dialog may have been opened from), scrolled into view.
 */
export default function FilterDialog({ folderId }: { readonly folderId: number }) {
  const { explorer } = useWorkbench()
  const node = explorer.node(folderId)
  const allowed: readonly FilterProperty[] = node?.folder ? folderSpecs[node.folder].filter ?? [] : []
  const [draft, setDraft] = useState(() => filterDraft(explorer.filter(folderId)))
  const [problems, setProblems] = useState<FilterProblems>({})
  const [error, setError] = useState('')
  const close = (applied = false) => {
    explorer.closeFilter()
    const { selected } = explorer.getSnapshot()
    explorer.select(!applied && selected !== undefined && explorer.menuNode(selected) ? selected : folderId, { reveal: true })
    document.querySelector<HTMLElement>('[data-explorer-tree]')?.focus()
  }
  const apply = () => {
    const result = draftFilter(draft, allowed)
    if (!result.ok) { setProblems(result.problems); return }
    try {
      explorer.setFilter(folderId, result.filter)
      close(true)
    } catch (failure) { setProblems({}); setError(failure instanceof Error ? failure.message : 'The filter could not be applied.') }
  }
  const change = (property: FilterProperty, value: Partial<FilterRow>) => {
    setDraft(current => ({ ...current, [property]: { ...current[property], ...value } }))
    setProblems(current => { const next = { ...current }; delete next[property]; return next })
    setError('')
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    // Text and date fields submit the form themselves; a closed list does not.
    else if (event.key === 'Enter' && event.target instanceof HTMLSelectElement) { event.preventDefault(); apply() }
  }
  const title = `Filter Settings – ${displayText(node?.label ?? 'Folder')}`
  return <div className="modal-backdrop"><form className="connection-modal filter-dialog" role="dialog" aria-modal="true" aria-labelledby="filter-title" noValidate
    onSubmit={event => { event.preventDefault(); apply() }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="filter-title">{title}</h2><button type="button" className="icon-button" aria-label="Close filter settings" onClick={() => close()}><Icon name="close" /></button></div>
    <div className="connection-scroll">
      <table className="filter-grid">
        <thead><tr><th scope="col">Property</th><th scope="col">Operator</th><th scope="col">Value</th></tr></thead>
        <tbody>{allowed.map((property, index) => {
          const row = draft[property], name = filterPropertyLabels[property], problem = problems[property], problemId = `filter-problem-${property}`
          const invalid = problem ? { 'aria-invalid': true, 'aria-describedby': problemId } : {}
          return <tr key={property}>
            <th scope="row">{name}</th>
            <td><select aria-label={`${name} operator`} value={row.op} onChange={event => change(property, { op: event.target.value })}>
              {(property === 'created' ? dateFilterOps : textFilterOps).map(op => <option key={op} value={op}>{property === 'created' ? dateOpLabels[op as keyof typeof dateOpLabels] : textOpLabels[op as keyof typeof textOpLabels]}</option>)}
            </select></td>
            <td>
              {property === 'created'
                ? <div className="filter-dates">
                  <input type="date" aria-label={name} min="1753-01-01" max="9999-12-31" autoFocus={index === 0} value={row.value} onChange={event => change(property, { value: event.target.value })} {...invalid} />
                  {isRange(row.op) && <input type="date" aria-label={`${name}, second date`} min="1753-01-01" max="9999-12-31" value={row.value2} onChange={event => change(property, { value2: event.target.value })} {...invalid} />}
                </div>
                : <input type="text" aria-label={`${name} value`} maxLength={maxIdentifierLength} spellCheck={false} autoComplete="off" autoFocus={index === 0} value={row.value} onChange={event => change(property, { value: event.target.value })} {...invalid} />}
              {problem && <div className="filter-problem" id={problemId}>{problem}</div>}
            </td>
          </tr>
        })}</tbody>
      </table>
      <p className="field-note">Objects must match every property that has a value. Leave every value empty to remove the filter.</p>
      {(error || Object.keys(problems).length > 0) && <p className="connect-error" role="alert">{error || 'Correct the values marked above.'}</p>}
    </div>
    <div className="connection-footer">
      <button type="button" onClick={() => { setDraft(filterDraft()); setProblems({}); setError('') }}>Clear Filter</button><span />
      <button className="primary" type="submit">OK</button><button type="button" onClick={() => close()}>Cancel</button>
    </div>
  </form></div>
}
