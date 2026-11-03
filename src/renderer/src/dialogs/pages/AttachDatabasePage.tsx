import { useEffect, useId, useRef, useState } from 'react'
import type { AttachServerFacts } from '../../../../shared/actions/schema.ts'
import { displayText } from '../../../../shared/explorer/refs.ts'
import type { IconId } from '../../../../shared/icons.ts'
import { useWorkbench } from '../../core/WorkbenchContext'
import Icon from '../../Icon'
import { stepIcons } from '../../kit/StepList'
import {
  addAttachDatabase, attachFileType, attachMessages, attachRowStates, browseAttachFile, checkAttachFile, ownerDefault, removeAttachDatabase, removeAttachFile, selectAttachFile, selectAttachRow,
  setAttachFilePath, setAttachName, setAttachOwner, type AttachDraft, type AttachHost, type AttachRowState
} from '../attach-database'
import type { PageProps } from '../ObjectDialog'

/** A row's Status as StepList draws a step's state; Rolled Back has an icon of its own. */
const statusIcons: Readonly<Record<Exclude<AttachRowState['status'], ''>, IconId>> = {
  'In progress': stepIcons.running, Success: stepIcons.done, Error: stepIcons.failed, Stopped: stepIcons.cancelled, 'Rolled Back': 'discard'
}

/** A path whose file name stays visible: the folder gives way first, with an ellipsis, so files in one folder stay apart. */
function PathText({ path }: { readonly path: string }) {
  const text = displayText(path), cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/')) + 1
  return <span className="attach-path"><bdi className="attach-path-folder">{text.slice(0, cut)}</bdi><bdi className="attach-path-name">{text.slice(cut)}</bdi></span>
}

/** Shows a path input's end (its file name) while it is not being edited. */
const showEnd = (input: HTMLInputElement | null) => { if (input && input.ownerDocument.activeElement !== input) input.scrollLeft = input.scrollWidth }

/**
 * Attach Databases' only page, as SSMS lays it out: "Databases to attach" (MDF File Location, Database Name, Attach As,
 * Owner, Status, Message) with Add… and Remove, then the selected database's files (Original File Name, File Type, Current
 * File Path with "…", Message) with Remove for a log file. A row takes the selection when anything in it takes focus. Add…
 * stays enabled while it reads a file (the picker returns focus to it), and Remove hands focus to the row that takes the
 * removed one's place, so focus never leaves the dialog.
 */
export default function AttachDatabasePage({ open, editable }: PageProps) {
  const { dialogs } = useWorkbench()
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  // Where focus goes once a Remove has re-rendered: a selector inside the page, or Add… when nothing matches it.
  const [focusNext, setFocusNext] = useState<string>()
  useEffect(() => {
    if (focusNext === undefined) return
    setFocusNext(undefined)
    ;(root.current?.querySelector<HTMLElement>(focusNext) ?? root.current?.querySelector<HTMLElement>('[data-attach-add]'))?.focus()
  }, [focusNext])
  const host = dialogs as unknown as AttachHost
  const server = open.model as AttachServerFacts | undefined, draft = open.draft as AttachDraft | undefined
  if (!server || !draft) return <p className="field-note">{open.phase === 'loading' ? 'Loading…' : ''}</p>
  const states = attachRowStates(draft.rows, open.phase, open.steps)
  const selectedIndex = draft.rows.findIndex(row => row.key === draft.selected)
  const selected = selectedIndex < 0 ? undefined : draft.rows[selectedIndex]
  const file = selected && draft.selectedFile !== undefined ? selected.files[draft.selectedFile] : undefined
  const owners = server.logins
  const removeDatabase = () => {
    removeAttachDatabase(host)
    setFocusNext(`[data-attach-row="${Math.min(selectedIndex, draft.rows.length - 2)}"]`)
  }
  const removeFile = () => {
    if (!selected || draft.selectedFile === undefined) return
    removeAttachFile(host, selected.key, draft.selectedFile)
    setFocusNext(`[data-attach-file="${Math.min(draft.selectedFile, selected.files.length - 2)}"]`)
  }
  return <div className="attach-database" ref={root}>
    <div className="object-dialog-caption" id={`${id}-databases`}>Databases to attach:</div>
    <div className="attach-database-table">
      <table className="object-dialog-grid attach-database-grid" aria-labelledby={`${id}-databases`}>
        <colgroup><col className="attach-col-path" /><col /><col /><col /><col className="attach-col-status" /><col /></colgroup>
        <thead><tr><th scope="col">MDF File Location</th><th scope="col">Database Name</th><th scope="col">Attach As</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Message</th></tr></thead>
        <tbody>
          {draft.rows.map((row, index) => {
            const state = states[index]
            return <tr key={row.key} data-selected={row.key === draft.selected || undefined} onFocusCapture={() => selectAttachRow(host, row.key)} onMouseDown={() => selectAttachRow(host, row.key)}>
              <td title={row.mdf}><PathText path={row.mdf} /></td>
              <td title={row.databaseName}><bdi>{displayText(row.databaseName)}</bdi></td>
              <td><input className="attach-database-cell" type="text" aria-label={`Attach As for ${displayText(row.mdf)}`} maxLength={128} spellCheck={false} value={row.name} disabled={!editable}
                data-attach-row={index} onChange={event => setAttachName(host, row.key, event.target.value)} /></td>
              <td><select className="attach-database-cell" aria-label={`Owner for ${displayText(row.mdf)}`} value={row.owner ?? ''} disabled={!editable} onChange={event => setAttachOwner(host, row.key, event.target.value === '' ? undefined : event.target.value)}>
                <option value="">{ownerDefault}</option>
                {row.owner !== undefined && !owners.includes(row.owner) && <option value={row.owner}>{displayText(row.owner)}</option>}
                {owners.map(login => <option key={login} value={login}>{displayText(login)}</option>)}
              </select></td>
              <td className="attach-database-status" data-status={state?.status || undefined}>
                {state?.status && <><Icon name={statusIcons[state.status]} className={state.status === 'In progress' ? 'step-list-spinner' : undefined} />{state.status}</>}
              </td>
              {/* The whole message wraps here: a Rolled Back row's explanation is shown nowhere else. */}
              <td className="object-dialog-cell-message">{state?.message}</td>
            </tr>
          })}
          {draft.rows.length === 0 && <tr><td colSpan={6} className="attach-database-empty">{draft.adding ? 'Reading the file…' : 'Add a primary data file (.mdf) to attach its database.'}</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="attach-database-buttons">
      <button type="button" data-attach-add disabled={!editable} onClick={() => void addAttachDatabase(host)}>Add…</button>
      <button type="button" aria-label="Remove the selected database" disabled={!editable || !selected} onClick={removeDatabase}>Remove</button>
    </div>
    {draft.problem && <p className="attach-database-problem" role="alert"><Icon name="warning" /><span>{draft.problem}</span></p>}
    {server.loginsTruncated && <p className="field-note">Owner lists the first {owners.length.toLocaleString('en-US')} logins.</p>}
    {selected && <>
      <div className="object-dialog-caption" id={`${id}-files`}>"<bdi>{displayText(selected.name || selected.databaseName)}</bdi>" database details:</div>
      <div className="attach-database-table">
        <table className="object-dialog-grid attach-database-grid" aria-labelledby={`${id}-files`}>
          <colgroup><col /><col className="attach-col-type" /><col className="attach-col-path" /><col className="attach-col-status" /></colgroup>
          <thead><tr><th scope="col">Original File Name</th><th scope="col">File Type</th><th scope="col">Current File Path</th><th scope="col">Message</th></tr></thead>
          <tbody>{selected.files.map((item, index) => <tr key={`${selected.key}-${index}`} data-selected={index === draft.selectedFile || undefined} onFocusCapture={() => selectAttachFile(host, index)} onMouseDown={() => selectAttachFile(host, index)}>
            <td title={item.original}><PathText path={item.original} /></td>
            <td>{attachFileType(item.type)}</td>
            <td><span className="attach-database-path">
              <input ref={input => showEnd(input)} className="attach-database-cell" type="text" aria-label={`Current File Path for ${displayText(item.original)}`} spellCheck={false} value={item.current} disabled={!editable}
                title={item.current} data-attach-file={index} aria-invalid={item.found === false || undefined} onChange={event => setAttachFilePath(host, selected.key, index, event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void checkAttachFile(host, selected.key, index) }} onBlur={event => { showEnd(event.currentTarget); void checkAttachFile(host, selected.key, index) }} />
              <button type="button" className="property-browse" aria-label={`Browse for ${displayText(item.original)}`} title="Browse" disabled={!editable} onClick={() => void browseAttachFile(host, selected.key, index)}>…</button>
            </span></td>
            <td className="object-dialog-cell-message">{item.checking ? 'Checking…' : item.found === false ? attachMessages.notFound : ''}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="attach-database-buttons">
        <button type="button" aria-label="Remove the selected log file" disabled={!editable || file?.type !== 'log'} onClick={removeFile}>Remove</button>
      </div>
      {!selected.files.some(item => item.type === 'log') && <p className="field-note">{attachMessages.rebuildLog}</p>}
    </>}
  </div>
}
