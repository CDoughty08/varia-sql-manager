import { useState } from 'react'
import { authenticationCatalog, authenticationModes, type AuthenticationMode } from '../../../shared/auth'
import { defaultSchedule, formatRun, nextRuns, schedulePresets, scheduleSentence, type AgentMoment, type SchedulePresetId } from '../../../shared/agent/schedule'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'

/** Bounded teaching illustrations, not another editor, connection dialog or result-grid implementation. */
export function ConnectionSample() {
  const [mode, setMode] = useState<AuthenticationMode>('sql'), { platform } = useWorkbench(), auth = authenticationCatalog[mode]
  return <figure className="help-sample"><figcaption>Sample · how authentication changes the form</figcaption>
    <label>Authentication<select aria-label="Sample authentication" value={mode} onChange={event => setMode(event.target.value as AuthenticationMode)}>
      {authenticationModes.filter(id => !authenticationCatalog[id].windowsOnly || platform === 'win32').map(id => <option key={id} value={id}>{authenticationCatalog[id].label}</option>)}
    </select></label>
    <dl className="help-sample-fields"><div><dt>Server</dt><dd>training.example,1433</dd></div><div><dt>{auth.userLabel}</dt><dd>{auth.user === 'identity' ? 'Current signed-in identity' : auth.user === 'required' ? 'Required' : 'Optional'}</dd></div><div><dt>Password</dt><dd>{auth.password ? 'Entered in the real Connect dialog' : 'Not entered for this method'}</dd></div></dl>
    <p role="status">{auth.interactive ? 'Connecting opens your browser for sign-in. Return to Varia when it finishes.' : auth.user === 'identity' ? 'Your environment must provide an integrated identity. Outside Windows, Windows Authentication requires Kerberos setup.' : 'Use the identity your administrator has configured for this server.'}</p>
  </figure>
}

export const sampleStatements = ["SELECT 'Hello, Varia' AS Greeting;", 'SELECT 2 AS ExampleNumber;'] as const
export function QuerySample() {
  const [selection, setSelection] = useState(false)
  return <figure className="help-sample"><figcaption>Sample · selection determines what Execute sends</figcaption>
    <div className="help-sample-controls" role="group" aria-label="Sample query scope"><button type="button" aria-pressed={!selection} onClick={() => setSelection(false)}>Entire query</button><button type="button" aria-pressed={selection} onClick={() => setSelection(true)}>Select second statement</button></div>
    <pre aria-label="Sample SQL"><code>{sampleStatements[0]}{'\n'}{selection ? <mark>{sampleStatements[1]}</mark> : sampleStatements[1]}</code></pre>
    <p role="status">{selection ? 'Only the selected second statement would run: one result set.' : 'With no selection, both statements would run: two result sets.'}</p>
    <div className="help-sample-output" aria-label="Illustrated query output">{!selection && <p><strong>Greeting</strong><br />Hello, Varia</p>}<p><strong>ExampleNumber</strong><br />2</p></div>
    <p className="help-muted">Illustration only. These controls never send SQL to a server.</p>
  </figure>
}

export function ResultsSample() {
  const { settings } = useWorkbench(), { values } = useServiceSnapshot(settings)
  const [filter, setFilter] = useState(false), [ascending, setAscending] = useState(false)
  const rows = [{ rank: 30, name: 'Orion', status: 'Open' }, { rank: 10, name: 'Atlas', status: 'Closed' }, { rank: 20, name: 'Lyra', status: 'Open' }]
  const visible = rows.filter(row => !filter || row.status === 'Open').sort((a, b) => ascending ? a.rank - b.rank : 0)
  const headers = values['queryResults.grid.copyColumnHeaders']
  return <figure className="help-sample"><figcaption>Sample · explore returned rows</figcaption>
    <div className="help-sample-controls"><button type="button" aria-pressed={filter} onClick={() => setFilter(!filter)}>Show Open rows only</button><button type="button" aria-pressed={ascending} onClick={() => setAscending(!ascending)}>Sort Rank ascending</button></div>
    <table aria-label="Fictional returned rows"><thead><tr><th>Rank</th><th>Name</th><th>Status</th></tr></thead><tbody>{visible.map(row => <tr key={row.name}><td>{row.rank}</td><td>{row.name}</td><td>{row.status}</td></tr>)}</tbody></table>
    <p role="status">{visible.length} of 3 sample rows shown. Sorting and filtering change the view; they do not rerun the query.</p>
    <p className="help-muted">Rank is numeric, so it sorts by value regardless of your text-sort option.</p>
    <p><strong>Ordinary Copy currently {headers ? 'includes' : 'omits'} column headers.</strong> Copy with Headers includes them regardless of that option.</p>
    <p className="help-muted">Fictional rows only. Use the real grid to select, copy or save returned data.</p>
  </figure>
}

/** The fictional clock the schedule sample counts from, so its runs read the same on every computer and day. */
export const agentSampleNow: AgentMoment = { date: 20260105, time: 90000 }
/** Presets the job document's Schedules section offers first (not its More menu). */
export const agentSamplePresets = schedulePresets.filter(preset => !preset.more)
export function AgentScheduleSample() {
  const [presetId, setPresetId] = useState<SchedulePresetId>('everyDay')
  // The production presets and sentence, from a fictional New Job Schedule starting at 02:30 on the sample's day.
  const start = { ...defaultSchedule(agentSampleNow.date, 'Nightly sales load'), activeStartTime: 23000 }
  const preset = agentSamplePresets.find(item => item.id === presetId) ?? agentSamplePresets[0]
  const schedule = preset.apply(start, agentSampleNow.date)
  return <figure className="help-sample"><figcaption>Sample · how a schedule reads before you save it</figcaption>
    <div className="help-sample-controls" role="group" aria-label="Sample schedule starting point">{agentSamplePresets.map(item =>
      <button type="button" key={item.id} aria-pressed={item.id === preset.id} onClick={() => setPresetId(item.id)}>{item.label.replace(/…$/, '')}</button>)}</div>
    <p role="status"><strong>{scheduleSentence(schedule)}</strong></p>
    <p>Next runs of the fictional job “Nightly sales load”, counted from Monday 2026-01-05 09:00:</p>
    <ol aria-label="Sample next runs">{nextRuns(schedule, agentSampleNow, 3).map(run => <li key={formatRun(run)}>{formatRun(run)}</li>)}</ol>
    <p className="help-muted">Illustration only. The sentence and runs come from the job document’s own schedule rules, on a fictional date; this sample never connects, creates a schedule or runs a job.</p>
  </figure>
}
