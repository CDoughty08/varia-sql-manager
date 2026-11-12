// The Details flyout (docs/activity-monitor.md, Session actions): a nonmodal panel beside the monitor for one session,
// showing the catalogue's sections (Identity and Now, the three texts, waits, transactions, tempdb, and locks on request),
// with Refresh, Copy and Close. The monitor goes on sampling beside it; Escape or Close cancels a read still running.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { DetailsSection } from '../../../shared/activity/catalog'
import type { ActivityDetailsResult } from '../../../shared/activity/schema'
import { useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import InlineError from '../kit/InlineError'
import Skeleton from '../kit/Skeleton'
import { formatCount } from '../results/status'
import type { DetailsPanel } from './ActivityMonitorService'
import { detailsState, detailsText, detailsTextOf, sectionTitle, sessionRows, textNote } from './session-actions'

export default function SessionDetails({ monitorId, details }: { readonly monitorId: string; readonly details: DetailsPanel }) {
  const { activity } = useWorkbench()
  const [copied, setCopied] = useState<boolean>()
  const panel = useRef<HTMLElement>(null)
  const { session, status, result, error } = details
  const titleId = `activity-${monitorId}-details-title`
  // Focus moves into the flyout when it opens on a session, so Escape and Tab work from there.
  useEffect(() => { panel.current?.focus() }, [session.sessionId, session.loginTime])
  useEffect(() => setCopied(undefined), [details.read])
  // A control that had focus may go as a read settles (Load locks becomes the locks table, Retry the sections): focus
  // stays in the flyout, so Escape and Tab still work from where the person was.
  useEffect(() => {
    const active = document.activeElement
    if (panel.current && (!active || active === document.body)) panel.current.focus()
  }, [status, details.locks])
  const close = () => activity.closeDetails(monitorId)
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  const shown = result && detailsState(result)
  const copy = () => { if (result) void window.varia.writeClipboardText(detailsText(result)).then(answer => setCopied(answer.ok), () => setCopied(false)) }
  return <aside ref={panel} className="activity-details" role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1} onKeyDown={keyDown} data-activity-details={session.sessionId}>
    <div className="activity-details-head">
      <h2 id={titleId} className="activity-details-title">Session {session.sessionId}{session.login && <span className="activity-details-login"> · {session.login}</span>}</h2>
      <button type="button" className="activity-tool icon-only" aria-label="Refresh details" title="Read the session again" disabled={status === 'loading'} onClick={() => activity.refreshDetails(monitorId)}><Icon name="refresh" /></button>
      <button type="button" className="activity-tool icon-only" aria-label="Copy details" title="Copy every section as text" disabled={shown?.kind !== 'present'} onClick={copy}><Icon name="copy" /></button>
      <button type="button" className="activity-tool icon-only" aria-label="Close details" title="Close (Escape)" onClick={close}><Icon name="close" /></button>
    </div>
    <p className="visually-hidden" role="status">{copied === undefined ? '' : copied ? 'Details copied.' : 'The details could not be copied.'}</p>
    <div className="activity-details-body">
      {status === 'loading' && !result && <Skeleton rows={8} label="Reading the session" />}
      {status === 'failed' && <InlineError message={`The session could not be read: ${error ?? 'unknown error'}`} actions={[{ label: 'Retry', run: () => activity.refreshDetails(monitorId) }]} />}
      {result && shown?.kind === 'departed' && <InlineError role="status" copy={false} message={shown.message ?? 'The session has ended.'} actions={[{ label: 'Close', run: close }]} />}
      {result && shown?.kind === 'error' && <InlineError code={result.error?.code} message={shown.message ?? 'The session could not be read.'} actions={[{ label: 'Retry', run: () => activity.refreshDetails(monitorId) }]} />}
      {result && shown?.kind === 'present' && <Sections monitorId={monitorId} details={details} result={result} />}
    </div>
    {result && <p className="activity-details-foot activity-note">
      {status === 'loading' ? 'Reading again…' : `Read ${result.readAt ? `at ${new Date(result.readAt).toLocaleTimeString()} ` : ''}in ${formatCount(Math.round(result.elapsedMs))} ms`}
    </p>}
  </aside>
}

function Sections({ monitorId, details, result }: { readonly monitorId: string; readonly details: DetailsPanel; readonly result: ActivityDetailsResult }) {
  const { activity } = useWorkbench()
  const problem = (section: DetailsSection) => result.sectionErrors?.find(item => item.section === section)
  const section = (id: DetailsSection, content: ReactNode, empty?: string) => {
    const failed = problem(id)
    return <section className="activity-details-section" aria-labelledby={`activity-${monitorId}-details-${id}`}>
      <h3 id={`activity-${monitorId}-details-${id}`}>{sectionTitle(id)}</h3>
      {failed ? <InlineError role="status" copy={false} code={failed.code} message={failed.message} /> : content ?? <p className="activity-note">{empty}</p>}
    </section>
  }
  const session = result.session!
  return <>
    {section('session', <dl className="activity-details-fields">
      {sessionRows(session).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>)}
    {(['statement', 'batch', 'inputBuffer'] as const).map(id => {
      const text = detailsTextOf(result, id), note = text && textNote(text)
      const event = id === 'inputBuffer' && result.inputBuffer?.eventType ? `${result.inputBuffer.eventType}${result.inputBuffer.parameters ? ` · ${result.inputBuffer.parameters} parameters` : ''}` : undefined
      return <div key={id}>{section(id, text && text.text ? <>
        {event && <p className="activity-note">{event}</p>}
        <pre className="activity-details-text" tabIndex={0} aria-label={sectionTitle(id)}>{text.text}</pre>
        {note && <p className="activity-note">{note}</p>}
      </> : undefined, id === 'inputBuffer' ? 'No batch has been sent.' : 'No request is running.')}</div>
    })}
    {section('waits', result.waits?.length ? <table className="activity-details-table">
      <thead><tr><th scope="col">Wait type</th><th scope="col">Tasks</th><th scope="col">Wait (ms)</th><th scope="col">Max (ms)</th><th scope="col">Signal (ms)</th></tr></thead>
      <tbody>{result.waits.map(wait => <tr key={wait.waitType}><th scope="row">{wait.waitType}</th><td>{formatCount(wait.waitingTasks)}</td><td>{formatCount(wait.waitTimeMs)}</td><td>{formatCount(wait.maxWaitTimeMs)}</td><td>{formatCount(wait.signalWaitTimeMs)}</td></tr>)}</tbody>
    </table> : undefined, 'No waits since the session logged in.')}
    {section('transactions', result.transactions?.length ? <>
      <table className="activity-details-table">
        <thead><tr><th scope="col">ID</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col">State</th><th scope="col">Database</th><th scope="col">Log used</th></tr></thead>
        <tbody>{result.transactions.map((tran, index) => <tr key={`${tran.transactionId}-${tran.database ?? ''}-${index}`}>
          <th scope="row">{tran.transactionId}</th><td>{tran.name ?? ''}</td><td>{tran.type}</td><td>{tran.state}</td><td>{tran.database ?? ''}</td><td>{tran.logBytesUsed === undefined ? '' : `${formatCount(tran.logBytesUsed)} B`}</td>
        </tr>)}</tbody>
      </table>
      {result.transactionsTruncated && <p className="activity-note">Only the first transactions are listed.</p>}
    </> : undefined, 'No open transactions.')}
    {section('tempdb', result.tempdb ? <dl className="activity-details-fields">
      <div><dt>User objects</dt><dd>{formatCount(result.tempdb.userObjectsKb)} KB</dd></div>
      <div><dt>Internal objects</dt><dd>{formatCount(result.tempdb.internalObjectsKb)} KB</dd></div>
    </dl> : undefined, 'No tempdb usage was read.')}
    {section('locks', details.locks === 'loaded'
      ? result.locks?.length ? <>
        <table className="activity-details-table">
          <thead><tr><th scope="col">Resource</th><th scope="col">Database</th><th scope="col">Mode</th><th scope="col">Status</th><th scope="col">Count</th></tr></thead>
          <tbody>{result.locks.map((lock, index) => <tr key={index}><th scope="row">{lock.resourceType}</th><td>{lock.database ?? lock.databaseId ?? ''}</td><td>{lock.mode}</td><td>{lock.status}</td><td>{formatCount(lock.count)}</td></tr>)}</tbody>
        </table>
        {result.locksTruncated && <p className="activity-note">Only the first lock groups are listed.</p>}
      </> : <p className="activity-note">The session holds no locks.</p>
      : <div className="activity-details-load">
        <p className="activity-note">Reading locks is costly on a busy server, so they load only when asked.</p>
        <button type="button" disabled={details.locks === 'loading'} onClick={() => activity.loadLocks(monitorId)}>{details.locks === 'loading' ? 'Loading locks…' : 'Load locks'}</button>
      </div>)}
  </>
}
