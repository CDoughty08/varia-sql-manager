import { useState } from 'react'
import type { ThemeState } from '../../shared/theme/types'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'

const shownProblems = 3
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.' }
/** Main numbers each report; the text is part of the key too, because the renderer can add sentences of its own. */
const noticeKey = (state: ThemeState) => `${state.noticeId}\n${state.notice ?? ''}`

/** Theme problems from the main process: an alert when the selected theme could not be used, otherwise a status banner. */
export default function ThemeNotice() {
  const { theme } = useWorkbench()
  const state = useServiceSnapshot(theme)
  const [dismissed, setDismissed] = useState<string>()
  const [busy, setBusy] = useState(false)
  // A button's failure belongs to the notice it was clicked on; a later notice starts without it.
  const [error, setError] = useState<{ notice: string; text: string }>()
  const key = noticeKey(state)
  if ((!state.fallback && !state.notice) || dismissed === key) return null
  const problems = state.problems.slice(0, shownProblems)
  const more = state.problems.length - problems.length + state.problemsOmitted
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(undefined)
    try { await action() } catch (failure) { setError({ notice: key, text: errorText(failure) }) } finally { setBusy(false) }
  }
  return <div className={state.fallback ? 'global-error theme-notice' : 'global-error warning theme-notice'} role={state.fallback ? 'alert' : 'status'}>
    <div className="theme-notice-text">
      {state.notice && <span>{state.notice}</span>}
      {problems.map((problem, index) => <span key={index}>{`${problem.file}${problem.path ? ' ' + problem.path : ''}: ${problem.message}`}</span>)}
      {more > 0 && <span>+{more} more</span>}
      {error?.notice === key && <span>{error.text}</span>}
    </div>
    <div className="theme-notice-actions">
      <button disabled={busy} onClick={() => void run(() => theme.openFolder())}>Open Themes Folder</button>
      <button disabled={busy} onClick={() => void run(() => theme.reload())}>Reload</button>
      <button onClick={() => setDismissed(key)}>Dismiss</button>
    </div>
  </div>
}
