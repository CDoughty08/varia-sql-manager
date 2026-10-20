import { useEffect, useState, type KeyboardEvent } from 'react'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import Icon from './Icon'
import { savedAgo } from './services/recovery'
import { trapFocus } from './trap-focus'

/**
 * Recover Unsaved Queries: what AutoRecover kept of queries an earlier run or workbench did not save, all selected.
 * Recover Selected opens them as unsaved queries; Discard Selected deletes them after asking in place; Later (or
 * Escape) leaves them for the next start or File: Recover Unsaved Queries…, until Keep AutoRecover information for
 * passes.
 */
export default function RecoveryDialog() {
  const { recovery, documents } = useWorkbench()
  const { entries } = useServiceSnapshot(recovery)
  const [unselected, setUnselected] = useState<ReadonlySet<string>>(() => new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chosen = entries.filter(entry => !unselected.has(entry.id)).map(entry => entry.id)
  const all = chosen.length === entries.length
  const close = () => {
    recovery.closeDialog()
    requestAnimationFrame(() => documents.focusActive())
  }
  // Nothing left to offer (all discarded): the dialog has done its work.
  useEffect(() => {
    if (entries.length) return
    recovery.closeDialog()
    requestAnimationFrame(() => documents.focusActive())
  }, [entries.length, recovery, documents])
  const toggle = (id: string, checked: boolean) => {
    setConfirming(false)
    setUnselected(current => { const next = new Set(current); if (checked) next.delete(id); else next.add(id); return next })
  }
  const recover = () => {
    close()
    // Opening is a file task, which reports its own failures in the file banner.
    void recovery.recover(chosen)
  }
  const discard = async () => {
    setBusy(true)
    try { await recovery.discard(chosen); setConfirming(false); setUnselected(new Set()) } catch (failure) { setError(failure instanceof Error ? failure.message : 'The queries could not be discarded.') } finally { setBusy(false) }
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    trapFocus(event)
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (confirming) setConfirming(false)
    else close()
  }
  const count = chosen.length === 1 ? '1 query' : `${chosen.length} queries`
  return <div className="modal-backdrop"><div className="connection-modal recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title" aria-describedby="recovery-text" onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="recovery-title">Recover Unsaved Queries</h2><button type="button" className="icon-button" aria-label="Close Recover Unsaved Queries" onClick={close}><Icon name="close" /></button></div>
    <div className="connection-scroll">
      <p className="field-note" id="recovery-text">Varia SQL Manager closed before these queries were saved. AutoRecover kept the copies below.</p>
      <table className="recovery-grid">
        <thead><tr>
          <th scope="col"><input type="checkbox" aria-label="Select all queries" checked={all} onChange={event => { setConfirming(false); setUnselected(event.target.checked ? new Set() : new Set(entries.map(entry => entry.id))) }} /></th>
          <th scope="col">Name</th><th scope="col">Original file</th><th scope="col">Server and database</th><th scope="col">Saved</th>
        </tr></thead>
        <tbody>{entries.map(entry => {
          const place = entry.server ? entry.database ? `${entry.server} / ${entry.database}` : entry.server : 'Not connected', saved = new Date(entry.savedAt)
          return <tr key={entry.id}>
            <td><input type="checkbox" aria-label={`Recover ${entry.name}`} checked={!unselected.has(entry.id)} onChange={event => toggle(entry.id, event.target.checked)} /></td>
            <td className="recovery-name" title={entry.name}>{entry.name}</td>
            <td title={entry.path ?? ''}>{entry.path ?? 'Not saved to a file'}</td>
            <td title={place}>{place}</td>
            <td title={Number.isNaN(saved.getTime()) ? '' : saved.toLocaleString()}>{savedAgo(entry.savedAt)}</td>
          </tr>
        })}</tbody>
      </table>
      {confirming && <div className="recovery-confirm" role="alert">
        <span>Discard {count}? This cannot be undone.</span>
        <button type="button" className="primary" disabled={busy} autoFocus onClick={() => void discard()}>Discard</button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
      </div>}
      {error && <p className="connect-error" role="alert">{error}</p>}
    </div>
    <div className="connection-footer">
      <button type="button" disabled={!chosen.length || busy} onClick={() => { setError(''); setConfirming(true) }}>Discard Selected</button><span />
      <button className="primary" type="button" autoFocus disabled={!chosen.length || busy} onClick={recover}>Recover Selected</button>
      <button type="button" onClick={close}>Later</button>
    </div>
  </div></div>
}
