import { useState } from 'react'
import type { BackendNotice } from './services/backend'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useCommandEnabled } from './core/useCommand'

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
const were = (n: number) => n === 1 ? 'was' : 'were'

/** The sentence for losses the user has not dismissed yet. Nothing is ever re-run, and the banner says so. */
export function noticeText(notice: BackendNotice): string {
  if (!notice.unexpected) return `The SQL backend was restarted. ${count(notice.connections, 'connection')} ${were(notice.connections)} closed.`
  return `The SQL backend stopped unexpectedly and was restarted. ${count(notice.connections, 'connection')} ${were(notice.connections)} lost and ${count(notice.queries, 'running script')} ${were(notice.queries)} stopped; nothing was re-run.`
}

/** The backend's problems: not responding, failed, or restarted with connections lost. */
export default function BackendBanner() {
  const { backend, commands } = useWorkbench()
  const { state, notice } = useServiceSnapshot(backend)
  const canReconnect = useCommandEnabled('connection.reconnect')
  // Which details were copied, so a later failure offers its own copy again.
  const [copied, setCopied] = useState<string>()
  const restart = () => { void commands.execute('backend.restart', undefined, 'toolbar') }
  if (state.status === 'unresponsive') {
    return <div className="global-error warning backend-banner" role="status">
      <span className="backend-banner-text">The SQL backend is not responding. You can keep waiting, or restart it; restarting closes all connections and rolls back uncommitted transactions.</span>
      <div className="backend-banner-actions"><button onClick={restart}>Restart now</button></div>
    </div>
  }
  if (state.status === 'failed') {
    const details = state.details
    const copy = () => { void navigator.clipboard.writeText(details).then(() => setCopied(details), () => setCopied(undefined)) }
    return <div className="global-error backend-banner" role="alert">
      <span className="backend-banner-text">{state.message}</span>
      <div className="backend-banner-actions"><button onClick={restart}>Restart SQL Backend</button><button onClick={copy}>{copied === details ? 'Copied' : 'Copy details'}</button></div>
    </div>
  }
  if (!notice) return null
  return <div className="global-error backend-banner" role="alert">
    <span className="backend-banner-text">{noticeText(notice)}</span>
    <div className="backend-banner-actions">
      {canReconnect && <button onClick={() => { void commands.execute('connection.reconnect', undefined, 'toolbar') }}>Reconnect…</button>}
      <button onClick={() => backend.dismiss()}>Dismiss</button>
    </div>
  </div>
}
