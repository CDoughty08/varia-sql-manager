// Create several (AG-6f, docs/agent-ui-rethink.md › Create several, mocks rx-create-several and rx-create-several-review): the copy's tab as
// a table, one row per new job. A toolbar (Add row, Duplicate row, Paste rows, Fill names, Columns, then Review and create), the rows with
// grey inherited cells and accent-edged typed ones, Other changes and Check, and the selected row's details (every field it differs in, with
// Reset, Open full editor and Remove row). Review lists what each row sends; the results list each row's own outcome, with Open, Back to the
// table and Enable the created jobs. A bounded HTML table (at most createSeveralLimits.rows rows), not a result grid. JobDocumentService keeps
// every state; this only draws it.
import { useEffect, type ClipboardEvent } from 'react'
import {
  createSeveralText, severalCell, severalDifferences, severalDisabled, severalDoneText, severalLocked, severalOtherCount, severalSelectOption, severalSummary, type SeveralCheck, type SeveralColumn,
  type SeveralContext, type SeveralRow
} from '../../../shared/agent/create-several.ts'
import Icon from '../Icon'
import StatusPill from '../kit/StatusPill'
import type { JobDocumentService, JobDocumentState, JobSeveral } from './JobDocumentService'

interface Props { readonly state: JobDocumentState; readonly service: JobDocumentService }
interface TableProps extends Props { readonly several: JobSeveral; readonly context: SeveralContext; readonly checks: ReadonlyMap<string, SeveralCheck> }

const cellId = (documentId: string, row: string, column: string) => `agent-several-${documentId}-${row}-${column.replace(/[^A-Za-z0-9_-]/g, '_')}`

function Cell({ state, service, context, row, at, column, error }: Props & { readonly context: SeveralContext; readonly row: SeveralRow; readonly at: number; readonly column: SeveralColumn; readonly error?: string }) {
  const cell = severalCell(context, row, column)
  // Grey is the template's value; a value that differs from it (typed, or from the full editor) shows as text, so clearing it resets it.
  const base = column.get(context.template) ?? ''
  const shown = cell.changed ? cell.value : ''
  const label = `${column.label}, row ${at}`
  const id = cellId(state.id, row.key, column.id)
  const editable = service.canEditSeveral(state.id)
  const set = (value: string | undefined) => service.setSeveralCell(state.id, row.key, column.id, value)
  // Several lines pasted into a cell are rows copied from a spreadsheet.
  const paste = (event: ClipboardEvent<HTMLElement>) => {
    const text = event.clipboardData.getData('text/plain')
    if (/[\t\n]/.test(text.replace(/\r?\n$/, ''))) { event.preventDefault(); service.pasteSeveral(state.id, text) }
  }
  const common = { id, 'aria-label': label, 'aria-invalid': error ? true : undefined, title: error ?? (cell.changed ? undefined : `From Changes from source: ${column.text(base) || '(none)'}`), disabled: !editable, onFocus: () => service.selectSeveralRow(state.id, row.key) }
  let input
  switch (column.kind) {
    case 'check': input = <input type="checkbox" {...common} checked={cell.value === 'true'} onChange={event => set(String(event.target.checked))} />; break
    case 'select': {
      // Collision-free DOM option values ('inherit', 'opt:<index>') prevent any SQL Server object named '(none)' or '__inherit__' from colliding.
      const allOptions = column.options ?? []
      const options = allOptions.filter(option => option.value !== base)
      const selected = !cell.changed
        ? 'inherit'
        : (() => {
            const matched = severalSelectOption(allOptions, cell.value)
            if (!matched) return 'custom'
            if (matched.value === base) return 'inherit'
            const index = options.indexOf(matched)
            return index >= 0 ? `opt:${index}` : 'custom'
          })()
      input = <select {...common} className="property-input" value={selected} onChange={event => {
        if (event.target.value === 'inherit') { set(undefined); return }
        const match = /^opt:([0-9]+)$/.exec(event.target.value)
        const option = match ? options[Number(match[1])] : undefined
        if (option) set(option.value)
      }}>
        <option value="inherit">{column.text(base) || '(none)'}</option>
        {selected === 'custom' && <option value="custom" disabled hidden>{cell.value}</option>}
        {options.map((option, index) => <option key={`opt:${index}`} value={`opt:${index}`}>{option.label || '(none)'}</option>)}
      </select>
      break
    }
    case 'command': input = <textarea {...common} className="property-input agent-copy-mono" rows={1} spellCheck={false} value={shown} placeholder={base.split(/\r?\n/, 1)[0]} onChange={event => set(event.target.value)} onPaste={paste} />; break
    default: input = <input type="text" {...common} className="property-input" spellCheck={false} inputMode={column.kind === 'number' ? 'numeric' : undefined} value={shown} placeholder={base}
      onChange={event => set(event.target.value)} onPaste={paste} />
  }
  return <td className="agent-several-cell" data-changed={cell.changed || undefined} data-inherited={!cell.changed || undefined} data-error={error ? true : undefined}>{input}</td>
}

function CheckCell({ check, row }: { readonly check?: SeveralCheck; readonly row: SeveralRow }) {
  if (row.result?.state === 'created') return <td><StatusPill tone="success" size="small" label={row.result.enabled ? createSeveralText.createdEnabled : createSeveralText.created} /></td>
  if (row.result && !check?.blocking.length) return <td><StatusPill tone="critical" size="small" label="Failed" title={row.result.message} /></td>
  if (check?.blocking.length) return <td><StatusPill tone="critical" size="small" label={check.blocking[0]!} title={check.blocking.join('\n')} /></td>
  if (check?.warnings.length) return <td><StatusPill tone="warning" size="small" label={check.warnings[0]!} title={check.warnings.join('\n')} /></td>
  return <td><StatusPill tone="neutral" size="small" icon="pass" label={createSeveralText.ok} /></td>
}

function Toolbar({ state, service, several, context, checks }: TableProps) {
  const editable = service.canEditSeveral(state.id)
  const open = several.table.rows.filter(row => !severalLocked(row))
  const attention = open.filter(row => checks.get(row.key)?.blocking.length || checks.get(row.key)?.warnings.length).length
  const sendable = open.filter(row => !checks.get(row.key)?.blocking.length).length
  return <div className="agent-several-bar" role="toolbar" aria-label="Create several">
    <button type="button" disabled={!editable} onClick={() => service.addSeveralRow(state.id)}><Icon name="add" />{createSeveralText.addRow}</button>
    <button type="button" disabled={!editable || !several.selected || severalLocked(several.table.rows.find(row => row.key === several.selected) ?? { key: '', cells: {} })} onClick={() => several.selected && service.duplicateSeveralRow(state.id, several.selected)}><Icon name="copy" />{createSeveralText.duplicateRow}</button>
    <button type="button" aria-expanded={several.panel === 'paste'} disabled={!editable} onClick={() => service.toggleSeveralPanel(state.id, 'paste')}>{createSeveralText.pasteRows}</button>
    <span className="agent-several-sep" aria-hidden />
    <button type="button" aria-expanded={several.panel === 'fill'} disabled={!editable} onClick={() => service.toggleSeveralPanel(state.id, 'fill')}>{createSeveralText.fillNames}</button>
    <button type="button" aria-expanded={several.panel === 'columns'} disabled={!editable} onClick={() => service.toggleSeveralPanel(state.id, 'columns')}><Icon name="layout" />{createSeveralText.columns(several.table.columns.length, context.columns.length)}</button>
    <span className="agent-several-end">
      {attention > 0 && <span className="agent-several-attention" role="status"><Icon name="warning" />{createSeveralText.attention(attention)}</span>}
      <button type="button" className="primary" disabled={!editable || sendable === 0 || !service.live(state.id)} onClick={() => service.reviewSeveral(state.id)}>{createSeveralText.review(sendable)}</button>
    </span>
  </div>
}

function Panel({ state, service, several, context }: TableProps) {
  const visible = several.table.columns.map(id => context.columns.find(column => column.id === id)!).filter(Boolean)
  if (several.panel === 'paste') {
    const id = `agent-several-${state.id}-paste`
    const lines = (several.paste ?? '').split(/\r?\n/).filter(line => line.trim()).length
    return <div className="agent-several-panel" role="group" aria-label={createSeveralText.pasteTitle}>
      <label htmlFor={id}>{createSeveralText.pasteHint(visible.map(column => column.label))}</label>
      <textarea id={id} className="property-input agent-copy-mono" rows={5} spellCheck={false} value={several.paste ?? ''} onChange={event => service.setSeveralPaste(state.id, event.target.value)} />
      <p><button type="button" className="primary" disabled={!lines} onClick={() => service.pasteSeveral(state.id)}>{createSeveralText.pasteAdd(lines)}</button></p>
    </div>
  }
  if (several.panel === 'fill') {
    const id = `agent-several-${state.id}-pattern`
    return <div className="agent-several-panel" role="group" aria-label={createSeveralText.fillTitle}>
      <label htmlFor={id}>{createSeveralText.fillTitle}</label>
      <span className="agent-copy-inline">
        <input id={id} className="property-input" type="text" spellCheck={false} placeholder={`${context.source.base.name} – {package}`} value={several.pattern ?? ''} aria-describedby={`${id}-hint`}
          onChange={event => service.setSeveralPattern(state.id, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); service.fillSeveralNames(state.id) } }} />
        <button type="button" className="primary" disabled={!several.pattern?.trim()} onClick={() => service.fillSeveralNames(state.id)}>{createSeveralText.fillApply}</button>
      </span>
      <p id={`${id}-hint`} className="field-note">{createSeveralText.fillHint}</p>
    </div>
  }
  if (several.panel === 'columns') {
    const groups = [...new Set(context.columns.map(column => column.group))]
    return <div className="agent-several-panel" role="group" aria-label={createSeveralText.columnsTitle}>
      <p className="field-note">{createSeveralText.columnsHint}</p>
      <div className="agent-several-columns">
        {groups.map(group => <fieldset key={group}><legend>{group}</legend>
          {context.columns.filter(column => column.group === group).map(column => <label key={column.id} className="agent-copy-check">
            <input type="checkbox" checked={several.table.columns.includes(column.id)} disabled={column.id === 'name'} onChange={event => service.setSeveralColumn(state.id, column.id, event.target.checked)} />{column.label}
          </label>)}
        </fieldset>)}
      </div>
    </div>
  }
  return null
}

function Rows({ state, service, several, context, checks }: TableProps) {
  const visible = several.table.columns.map(id => context.columns.find(column => column.id === id)).filter((column): column is SeveralColumn => !!column)
  return <div className="agent-several-scroll">
    <table className="agent-several-table" aria-label="Jobs to create">
      <thead><tr><th scope="col"><span className="visually-hidden">Row</span></th>{visible.map(column => <th key={column.id} scope="col">{column.label}</th>)}<th scope="col">{createSeveralText.otherChanges}</th><th scope="col">{createSeveralText.check}</th></tr></thead>
      <tbody>
        {several.table.rows.map((row, index) => {
          const at = index + 1, check = checks.get(row.key), other = severalOtherCount(context, several.table, row)
          const selected = several.selected === row.key
          const created = row.result?.state === 'created' ? row.result : undefined
          return <tr key={row.key} aria-selected={selected} data-locked={created ? true : undefined}>
            <th scope="row"><button type="button" className="agent-several-num" aria-label={`Row ${at}`} aria-pressed={selected} onClick={() => service.selectSeveralRow(state.id, row.key)}>{at}</button></th>
            {created
              ? visible.map(column => <td key={column.id} className="agent-several-cell" data-changed={severalCell(context, row, column).changed || undefined}>{column.id === 'name'
                ? <span className="agent-copy-inline">{created.name}<button type="button" className="link-button" onClick={() => service.openSeveralCreated(state.id, created.name)}>{createSeveralText.open}</button></span>
                : column.text(severalCell(context, row, column).value)}</td>)
              : visible.map(column => <Cell key={column.id} state={state} service={service} context={context} row={row} at={at} column={column} {...check?.cellErrors[column.id] ? { error: check.cellErrors[column.id]! } : {}} />)}
            <td>{other ? <span className="agent-several-tag">{createSeveralText.fields(other)}</span> : <span className="field-note">{createSeveralText.none}</span>}</td>
            <CheckCell check={check} row={row} />
          </tr>
        })}
        <tr><td /><td colSpan={visible.length + 2} className="field-note">{createSeveralText.addRowHint}</td></tr>
      </tbody>
    </table>
  </div>
}

function Details({ state, service, several, context, checks }: TableProps) {
  const row = several.table.rows.find(item => item.key === several.selected)
  if (!row) return null
  const at = several.table.rows.indexOf(row) + 1
  const differences = severalDifferences(context, several.table, row)
  const created = severalLocked(row)
  const editable = service.canEditSeveral(state.id) && !created
  const check = checks.get(row.key)
  const name = row.result?.state === 'created' ? row.result.name : service.severalRowName(state.id, row.key)
  return <section className="agent-several-details" aria-label={createSeveralText.rowTitle(at, name)}>
    <div className="agent-several-details-head">
      <strong>{createSeveralText.rowTitle(at, name)}</strong><span className="field-note">{createSeveralText.differs(differences.length)}</span>
      <span className="agent-several-end">
        <button type="button" disabled={!editable} onClick={() => service.openSeveralRow(state.id, row.key)}><Icon name="edit" />{createSeveralText.openEditor}</button>
        <button type="button" disabled={!editable} onClick={() => service.removeSeveralRow(state.id, row.key)}><Icon name="trash" />{createSeveralText.removeRow}</button>
      </span>
    </div>
    {row.result && row.result.state !== 'created' && <p className="property-field-error" role="note"><Icon name="error" />{row.result.message}</p>}
    {check && [...check.blocking, ...check.warnings].length > 0 && <ul className="agent-several-problems" aria-label="Checks">
      {check.blocking.map(message => <li key={`b:${message}`}><Icon name="error" />{message}</li>)}
      {check.warnings.map(message => <li key={`w:${message}`}><Icon name="warning" />{message}</li>)}
    </ul>}
    {differences.length > 0 && <table className="agent-several-table" aria-label="Differences">
      <thead><tr><th scope="col">Field</th><th scope="col">From Changes from source</th><th scope="col">This job</th><th scope="col"><span className="visually-hidden">Reset</span></th></tr></thead>
      <tbody>{differences.map(item => <tr key={item.id}>
        <th scope="row">{item.label}</th><td className="field-note">{item.template}</td><td>{item.value}</td>
        <td>{item.inColumn ? <span className="field-note">{createSeveralText.inColumn}</span>
          : <button type="button" className="link-button" disabled={!editable} aria-label={`${createSeveralText.reset} ${item.label}`} onClick={() => service.resetSeveral(state.id, row.key, item.id)}>{createSeveralText.reset}</button>}</td>
      </tr>)}</tbody>
    </table>}
    <p className="field-note">{createSeveralText.detailsHint}</p>
  </section>
}

function Results({ state, service, several, context, checks }: TableProps) {
  const skipped = new Map((several.skipped ?? []).map(item => [item.key, item.reason]))
  const disabled = severalDisabled(several.table).length
  const rows = several.table.rows
  const sending = rows.filter(row => !severalLocked(row) && !checks.get(row.key)?.blocking.length).length
  const left = rows.filter(row => !severalLocked(row) && checks.get(row.key)?.blocking.length).length
  const created = (row: SeveralRow) => row.result?.state === 'created' ? row.result : undefined
  return <div className="agent-several-results">
    {several.phase === 'review' && <p role="status">{createSeveralText.reviewTitle(sending, left)}</p>}
    <table className="agent-several-table" aria-label={several.phase === 'review' ? 'Jobs to create' : 'Results'}>
      <thead><tr><th scope="col"><span className="visually-hidden">Row</span></th><th scope="col">Job</th><th scope="col">What is sent</th><th scope="col">Result</th></tr></thead>
      <tbody>{rows.map((row, index) => {
        const check = checks.get(row.key), done = created(row), reason = several.phase === 'review' ? check?.blocking[0] : skipped.get(row.key)
        const name = done?.name ?? service.severalRowName(state.id, row.key)
        return <tr key={row.key} data-state={done ? 'created' : row.result ? 'failed' : reason ? 'skipped' : undefined}>
          <td>{index + 1}</td><th scope="row">{name}</th>
          <td>{reason ? createSeveralText.skipped(reason) : severalSummary(context, several.table, row)}</td>
          <td>{done ? <span className="agent-copy-inline"><Icon name="pass" />{done.enabled ? createSeveralText.createdEnabled : createSeveralText.created}
            {done.enableError && <span className="field-note">{createSeveralText.enableFailed(done.enableError)}</span>}
            <button type="button" className="link-button" onClick={() => service.openSeveralCreated(state.id, done.name)}>{createSeveralText.open}</button></span>
            : row.result && row.result.state !== 'created' ? <span className="agent-copy-inline agent-several-failed"><Icon name="error" />{row.result.state === 'failed' ? createSeveralText.failed(row.result.message) : row.result.state === 'unknown' ? createSeveralText.unknown(row.result.message) : row.result.message}</span>
              : several.phase === 'creating' && !reason ? <span className="field-note">{createSeveralText.waiting}</span> : reason || several.phase !== 'review' ? <span className="field-note">{createSeveralText.notSent}</span> : <span className="field-note">{createSeveralText.ok}</span>}</td>
        </tr>
      })}</tbody>
    </table>
    <p className="agent-copy-inline">
      {several.phase === 'review' && <>
        <button type="button" className="primary" disabled={!sending || !service.live(state.id)} onClick={() => void service.createSeveralJobs(state.id)}>{createSeveralText.create(sending)}</button>
        <button type="button" onClick={() => service.severalToTable(state.id)}>{createSeveralText.backToTable}</button>
      </>}
      {several.phase === 'done' && <>
        <button type="button" className="primary" disabled={several.enabling} onClick={() => service.closeSeveral(state.id)}>{createSeveralText.close}</button>
        <button type="button" disabled={several.enabling} onClick={() => service.severalToTable(state.id)}>{createSeveralText.backToTable}</button>
        {disabled > 0 && <button type="button" disabled={several.enabling || !service.live(state.id)} onClick={() => void service.enableSeveralCreated(state.id)}>{createSeveralText.enable(disabled)}</button>}
        <span className="field-note">{createSeveralText.backHint}</span>
      </>}
    </p>
  </div>
}

/** The banner's lines for the table: what it is, progress, and what the last action said. */
export function SeveralBanner({ state, service }: Props) {
  const several = state.several!
  const skipped = several.skipped?.length ?? 0
  return <>
    <div className="agent-copy-banner" role="note"><Icon name="copy" /><span>{createSeveralText.banner(state.source?.base.name ?? '')}</span></div>
    {several.phase === 'creating' && several.progress && <p className="document-status" role="status"><Icon name="loading" spin />{createSeveralText.creating(several.progress.at, several.progress.count)}</p>}
    {several.enabling && <p className="document-status" role="status"><Icon name="loading" spin />{createSeveralText.enabling}</p>}
    {several.phase === 'done' && <p className="document-status" role="status"><Icon name="info" />{severalDoneText(several.table, skipped)}</p>}
    {several.notice && <p className="document-status" role="status"><Icon name="pass" />{several.notice}</p>}
    {!service.live(state.id) && <p className="property-field-error" role="alert"><Icon name="error" />The server was disconnected. Reconnect to create the jobs.</p>}
  </>
}

/** The table, its fill panels and the selected row's details; or the review and the results. */
export default function CreateSeveral({ state, service }: Props) {
  const several = state.several!
  const context = service.severalContextOf(state.id)
  const packages = service.severalPackages(state.id).join('\n')
  useEffect(() => {
    for (const path of packages ? packages.split('\n') : []) {
      const [folder, project, packageName] = path.split('\\')
      if (folder && project && packageName) void service.loadSsisPackage(state.id, folder, project, packageName)
    }
  }, [packages, service, state.id])
  if (!context) return null
  const checks = service.severalChecks(state.id)
  const props: TableProps = { state, service, several, context, checks }
  if (several.phase !== 'table') return <div className="agent-several" data-agent-several={state.id}><Results {...props} /></div>
  return <div className="agent-several" data-agent-several={state.id}>
    <Toolbar {...props} />
    <Panel {...props} />
    <Rows {...props} />
    <Details {...props} />
  </div>
}
