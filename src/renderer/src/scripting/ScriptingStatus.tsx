import { useCallback, useRef, type FocusEvent } from 'react'
import { stateJobsText } from '../actions/ObjectActionService'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'

/**
 * The status bar's Object Explorer segment: "Renaming dbo.Orders to Orders2…" (or another state job: "Disabling AppUser…")
 * with Stop once it has run for 300 ms (DDL waits for locks without a timeout, so Stop is how it ends), then "Scripting dbo.Orders…" with Cancel once
 * a request has run for 300 ms, else the latest notice (copied, saved, cancelled, or a warning). One polite live region
 * holds them, so each is announced. A warning is a button that shows every warning in the command banner, as a warning,
 * so its full text is not only a mouse tooltip.
 */
export default function ScriptingStatus() {
  const { scripting, actions, commands, documents } = useWorkbench()
  const { jobs, notice } = useServiceSnapshot(scripting)
  const { jobs: stateJobs } = useServiceSnapshot(actions)
  const shown = jobs.filter(job => job.visible)
  const running = stateJobs.filter(job => job.visible)
  // One Stop stops every visible job, so its name counts them (and says "actions" when their verbs differ).
  const first = stateJobsText(running)
  const returnTo = useRef<HTMLElement | null>(null)
  const entered = (event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) returnTo.current = event.relatedTarget
  }
  // These buttons go when their request or notice does; focus on one goes back where it came from, or to the editor.
  const leaves = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return
    return () => {
      if (document.activeElement !== node) return
      if (returnTo.current?.isConnected) returnTo.current.focus()
      else documents.focusActive()
    }
  }, [documents])
  return <span className="status-scripting" role="status" onFocus={entered}>
    {first && <>
      <span className="status-scripting-text">{first.text}</span>
      {running.length > 1 && <span className="status-scripting-more">(+{running.length - 1} more)</span>}
      <button type="button" ref={leaves} aria-label={first.stop} disabled={running.every(job => job.stopping)} onClick={() => actions.stopJobs(running.map(job => job.id))}>Stop</button>
    </>}
    {shown.length ? <>
      <span className="status-scripting-text">Scripting {shown[0].label}…</span>
      {shown.length > 1 && <span className="status-scripting-more">(+{shown.length - 1} more)</span>}
      <button type="button" ref={leaves} aria-label="Cancel scripting" onClick={() => scripting.cancel(shown.map(job => job.id))}>Cancel</button>
    </> : notice?.kind === 'warning' && notice.title
      ? <button key={notice.id} type="button" ref={leaves} className="status-scripting-text status-scripting-notice" title={notice.title}
        onClick={() => commands.reportWarning(notice.title!)}>{notice.text}</button>
      : notice ? <span key={notice.id} className="status-scripting-text" title={notice.title}>{notice.text}</span> : null}
  </span>
}
