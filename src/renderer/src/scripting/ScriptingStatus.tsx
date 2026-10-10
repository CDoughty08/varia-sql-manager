import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'

/**
 * The status bar's scripting segment: "Scripting dbo.Orders…" with Cancel once a request has run for 300 ms, else the
 * latest notice (copied, saved, cancelled, or a warning). One polite live region holds both, so each is announced.
 */
export default function ScriptingStatus() {
  const { scripting } = useWorkbench()
  const { jobs, notice } = useServiceSnapshot(scripting)
  const shown = jobs.filter(job => job.visible)
  return <span className="status-scripting" role="status">
    {shown.length ? <>
      <span className="status-scripting-text">Scripting {shown[0].label}…{shown.length > 1 ? ` (+${shown.length - 1} more)` : ''}</span>
      <button type="button" aria-label="Cancel scripting" onClick={() => scripting.cancel(shown.map(job => job.id))}>Cancel</button>
    </> : notice ? <span key={notice.id} className="status-scripting-text" title={notice.title}>{notice.text}</span> : null}
  </span>
}
