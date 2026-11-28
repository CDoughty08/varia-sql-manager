import { useState } from 'react'
import { authenticationCatalog, authenticationModes, type AuthenticationMode } from '../../../shared/auth'
import { settingValueLabel } from '../../../shared/help/references'
import { defaultSchedule, formatRun, nextRuns, schedulePresets, scheduleSentence, type AgentMoment, type SchedulePresetId } from '../../../shared/agent/schedule'
import { checkCrossEngineReadOnly, classifyStatements } from '../../../shared/multi-query'
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

/** Fictional result sizes against a fictional result memory with 4 GB free. Automatic keeps a result in memory when it fits
 *  half of the room the query may still take (docs/bigquery.md, Residence); the sample keeps that one rule. */
export const bigQuerySampleResults = [{ label: '250,000 rows (about 40 MB)', mb: 40 }, { label: '12 million rows (about 3 GB)', mb: 3_000 }, { label: '400 million rows (about 90 GB)', mb: 90_000 }] as const
export const bigQuerySampleFreeMb = 4_000
export function bigQuerySampleResidence(mode: string, mb: number): 'memory' | 'truncated' | 'windowed' {
  if (mode === 'memory') return mb <= bigQuerySampleFreeMb ? 'memory' : 'truncated'
  if (mode === 'windowed') return 'windowed'
  return mb <= bigQuerySampleFreeMb / 2 ? 'memory' : 'windowed'
}
export function BigQueryResultsSample() {
  const { settings } = useWorkbench(), { values } = useServiceSnapshot(settings)
  const [size, setSize] = useState(1), result = bigQuerySampleResults[size], mode = values['queryResults.bigQuery.residence']
  const residence = bigQuerySampleResidence(mode, result.mb), loadable = result.mb <= bigQuerySampleFreeMb
  return <figure className="help-sample"><figcaption>Sample · where a BigQuery result’s rows stay</figcaption>
    <div className="help-sample-controls" role="group" aria-label="Sample result size">{bigQuerySampleResults.map((entry, index) => <button key={entry.label} type="button" aria-pressed={size === index} onClick={() => setSize(index)}>{entry.label}</button>)}</div>
    <p role="status">{residence === 'memory' ? 'Kept in memory: every result tool works on it, as on a SQL Server result.'
      : residence === 'truncated' ? 'Kept in memory until the result memory is full: the rest is not read, and the grid says the result was truncated.'
        : 'Windowed in BigQuery: the grid reads blocks of rows as you scroll, free, and the caption says windowed in BigQuery.'}</p>
    {residence === 'windowed' && <ul aria-label="What a windowed result offers">
      <li>Sort, filter and column value lists run in BigQuery as billed queries, estimated first.</li>
      <li>Copy works within the Copy limit; Save Results As streams every row to the file.</li>
      <li>{loadable ? 'Load into memory fits the free result memory, so the strip offers it; then every tool works.' : 'Too large to load into memory: Load Sample… reads some of its rows into a new result instead.'}</li>
      <li>BigQuery keeps the result about 24 hours; after that the strip offers Re-run.</li>
    </ul>}
    <p className="help-muted">Follows your Keep results option ({settingValueLabel('queryResults.bigQuery.residence', values)}) with a fictional {bigQuerySampleFreeMb.toLocaleString('en-US')} MB of result memory free. Illustration only: it runs no query and connects to nothing.</p>
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

export const multiServerSampleScenarios = [
  {
    id: 'sqlDml',
    label: 'SQL Server DML + SELECT',
    provider: 'sqlserver' as const,
    crossEngine: false,
    sql: "UPDATE dbo.Orders SET Status = 'Archived' WHERE CreatedAt < '2025-01-01';\nSELECT COUNT(*) AS Archived FROM dbo.Orders WHERE Status = 'Archived';"
  },
  {
    id: 'bqDdl',
    label: 'BigQuery permanent DDL',
    provider: 'bigquery' as const,
    crossEngine: false,
    sql: 'CREATE OR REPLACE VIEW analytics.active_orders AS SELECT id, region FROM analytics.orders WHERE active;'
  },
  {
    id: 'crossGuard',
    label: 'Cross-Engine blocked write',
    provider: 'sqlserver' as const,
    crossEngine: true,
    sql: "DELETE FROM dbo.Orders WHERE Status = 'Cancelled';"
  }
] as const
export type MultiServerSampleId = (typeof multiServerSampleScenarios)[number]['id']

export interface MultiServerSampleInput {
  readonly provider: 'sqlserver' | 'bigquery'
  readonly crossEngine: boolean
  readonly sql: string
}

export function multiServerSampleOutcome(scenario: MultiServerSampleInput): {
  readonly tags: readonly string[]
  readonly outcome: string
} {
  if (scenario.crossEngine) {
    const violations = checkCrossEngineReadOnly(scenario.sql, scenario.provider)
    const noun = violations.length === 1 ? 'violation' : 'violations'
    return {
      tags: [],
      outcome: violations.length > 0
        ? `Blocked before sending (${violations.length} ${noun} on Line ${violations[0]!.line}): ${violations[0]!.message}`
        : 'Read-only check passed: both dialect panes run together.'
    }
  }
  const classification = classifyStatements(scenario.sql, scenario.provider)
  const outcome = scenario.provider === 'bigquery' && classification.hasBigQueryPermanentDdl
    ? 'Coordinated Transaction is disabled for permanent BigQuery DDL. Varia pre-selects Fire and Forget with Pre-flight Dry Run (free) and Sequential rollout.'
    : scenario.provider === 'bigquery' && classification.blocksBigQueryTransaction
      ? 'Coordinated Transaction is disabled for this BigQuery statement. Run it with Fire and Forget instead.'
      : scenario.provider === 'sqlserver' && classification.hasNonTransactionalTSql
        ? 'Coordinated Transaction is disabled for non-transactional SQL Server statements. Run it with Fire and Forget instead.'
        : 'Coordinated Transaction is available: all servers commit together if every target succeeds, or all roll back together if any target fails.'
  return { tags: classification.tags, outcome }
}

export function MultiServerSample() {
  const [scenarioId, setScenarioId] = useState<MultiServerSampleId>('sqlDml')
  const scenario = multiServerSampleScenarios.find(item => item.id === scenarioId) ?? multiServerSampleScenarios[0]
  const { tags, outcome } = multiServerSampleOutcome(scenario)
  return <figure className="help-sample"><figcaption>Sample · how Varia classifies statements before multi-server execution</figcaption>
    <div className="help-sample-controls" role="group" aria-label="Sample multi-server scenario">{multiServerSampleScenarios.map(item =>
      <button key={item.id} type="button" aria-pressed={item.id === scenario.id} onClick={() => setScenarioId(item.id)}>{item.label}</button>)}</div>
    <pre aria-label="Sample multi-server SQL"><code>{scenario.sql}</code></pre>
    {tags.length > 0 && <p>Detected: <strong>{tags.join(' · ')}</strong></p>}
    <p role="status">{outcome}</p>
    <p className="help-muted">Illustration only. Uses Varia’s real statement classifier and Cross-Engine read-only guard on fictional SQL; it never connects or sends queries.</p>
  </figure>
}
