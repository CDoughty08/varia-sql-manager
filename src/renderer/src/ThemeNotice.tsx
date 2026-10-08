import { useState } from 'react'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'

const shownProblems = 3
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.' }

/** Theme problems from the main process: an alert when the selected theme could not be used, otherwise a status banner. */
export default function ThemeNotice() {
  const { theme } = useWorkbench()
  const state = useServiceSnapshot(theme)
  const [dismissed, setDismissed] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if ((!state.fallback && !state.notice) || dismissed === state.revision) return null
  const problems = state.problems.slice(0, shownProblems)
  const more = state.problems.length - problems.length + state.problemsOmitted
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('')
    try { await action() } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  return <div className={state.fallback ? 'global-error theme-notice' : 'global-error warning theme-notice'} role={state.fallback ? 'alert' : 'status'}>
    <div className="theme-notice-text">
      {state.notice && <span>{state.notice}</span>}
      {problems.map((problem, index) => <span key={index}>{`${problem.file}${problem.path ? ' ' + problem.path : ''}: ${problem.message}`}</span>)}
      {more > 0 && <span>+{more} more</span>}
      {error && <span>{error}</span>}
    </div>
    <div className="theme-notice-actions">
      <button disabled={busy} onClick={() => void run(() => theme.openFolder())}>Open Themes Folder</button>
      <button disabled={busy} onClick={() => void run(() => theme.reload())}>Reload</button>
      <button onClick={() => { setDismissed(state.revision); setError('') }}>Dismiss</button>
    </div>
  </div>
}
