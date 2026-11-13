import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { changedConnectionDetails, connectionDetailLabels, connectionDetailsConfirmation as copy, type ConnectionDetails } from '../../shared/connection-targets'
import { focusToReturn, returnFocusTo } from './core/focus'
import { trapFocus } from './trap-focus'

interface Props {
  readonly current: ConnectionDetails
  readonly selected: ConnectionDetails
  readonly server: string
  readonly database: string
  readonly account?: string
  onChoose(choice: 'selected' | 'current' | 'cancel'): void
}
const label = (field: keyof ConnectionDetails, value: string | undefined) => field === 'autoReconnect'
  ? value === 'on' ? 'On' : value === 'off' ? 'Off' : 'Use global default' : value || 'None'

export default function ConnectionDetailsDialog({ current, selected, server, database, account, onChoose }: Props) {
  const dialog = useRef<HTMLDivElement>(null), [returnFocus] = useState(focusToReturn)
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  const choose = (choice: 'selected' | 'current' | 'cancel') => { flushSync(() => onChoose(choice)); returnFocusTo(returnFocus) }
  return <div className="modal-backdrop"><div ref={dialog} className="connection-modal connection-details-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-details-title" aria-describedby="connection-details-effects" onKeyDown={event => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); choose('cancel') }
  }}>
    <div className="connection-heading"><h2 id="connection-details-title">{copy.title}</h2></div>
    <div className="connection-scroll">
      <p>{server} · {database || 'Default database'}{account ? ` · ${account}` : ''}</p>
      <table><thead><tr><th scope="col">Detail</th><th scope="col">Current</th><th scope="col">Selected</th></tr></thead><tbody>{changedConnectionDetails(current, selected).map(field => <tr key={field}><th scope="row">{connectionDetailLabels[field]}</th><td>{label(field, current[field])}</td><td>{label(field, selected[field])}</td></tr>)}</tbody></table>
      <p id="connection-details-effects" className="field-note">Name, color and environment appear on this Explorer connection and its attached query badges. Startup reconnect controls future automatic reconnect; an explicit Disconnect stays respected. Your SQL sessions stay open.</p>
    </div>
    <div className="connection-footer"><span /><button className="primary" onClick={() => choose('selected')}>{copy.useSelected}</button><button onClick={() => choose('current')}>{copy.keepCurrent}</button><button onClick={() => choose('cancel')}>{copy.cancel}</button></div>
  </div></div>
}
