import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/settings/catalog'
import { multiTargetSummaryText, queryStatusModel, serverText, versionLabel, type QueryStatusInput } from '../src/renderer/src/results/query-status'
import { statusLeads } from '../src/renderer/src/results/status'
import { iconSpec } from '../src/shared/icons'
import QueryStatusBar, { deriveMultiStatus } from '../src/renderer/src/QueryStatusBar'
import EditorStatus, { sqlStatusChip } from '../src/renderer/src/EditorStatus'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { QueryTab } from '../src/renderer/src/documents'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { stylesheetRules } from './fixtures/css-rules'
import { workbenchFixture } from './fixtures/workbench'

const settings = defaultSettings
const connection = { server: 'sql01', serverVersion: '16.00.4135', productVersion: '16.0.4135.4' }
const input = (patch: Partial<QueryStatusInput> = {}): QueryStatusInput => ({ connection, database: 'AppData', running: false, now: 10_000, settings, formatTime: time => `at ${time}`, ...patch })
const run = (status: NonNullable<QueryStatusInput['run']>['status'], patch: Partial<NonNullable<QueryStatusInput['run']>> = {}) => ({ status, startedAt: 1000, rowsRead: 1234, ...patch })
const texts = (model: ReturnType<typeof queryStatusModel>) => model.segments.map(segment => `${segment.label}: ${segment.text}`)

describe('the query status bar', () => {
  it('shows SSMS\'s segments in its order: server (version), login (SPID), database, elapsed time and rows', () => {
    const model = queryStatusModel(input({ session: { login: 'CONTOSO\\ana', spid: 57 }, run: run('completed', { summary: { status: 'completed', elapsedMs: 3_725_000 } }) }))
    expect(model).toMatchObject({ tone: 'ready', icon: 'pass', text: 'Query executed successfully.', place: 'sql01 (16.0) | CONTOSO\\ana (57) | AppData' })
    expect(texts(model)).toEqual(['Server: sql01 (16.0)', 'Login: CONTOSO\\ana (57)', 'Database: AppData', 'Elapsed time: 01:02:05', 'Rows: 1,234 rows'])
  })
  it('says what the query is doing, in SSMS\'s words, with its colours', () => {
    const lead = (patch: Partial<QueryStatusInput>) => { const model = queryStatusModel(input(patch)); return [model.tone, model.icon, model.text] }
    expect(lead({})).toEqual(['ready', 'plug', 'Connected.'])
    expect(lead({ connection: undefined })).toEqual(['disconnected', 'debug-disconnect', 'Disconnected.'])
    expect(lead({ running: true, run: run('running') })).toEqual(['executing', 'loading', 'Executing query…'])
    expect(lead({ run: run('completedWithErrors') })).toEqual(['ready', 'warning', 'Query completed with errors.'])
    expect(lead({ run: run('failed') })).toEqual(['error', 'error', 'Query failed.'])
    expect(lead({ run: run('cancelled') })).toEqual(['error', 'debug-stop', 'Query was cancelled.'])
    expect(lead({ run: run('timedOut') })).toEqual(['error', 'watch', 'Query timed out.'])
    // The backend stopped mid-run, and Close Results keeps the sentence of how the run ended.
    expect(lead({ run: run('lost') })).toEqual(['error', 'error', 'Query failed.'])
    expect(lead({ run: run('closed', { summary: { status: 'cancelled', elapsedMs: 5 } }) })).toEqual(['error', 'debug-stop', 'Query was cancelled.'])
    expect(lead({ run: run('closed') })).toEqual(['ready', 'pass', 'Query executed successfully.'])
    // A run the backend lost, or main failed without a summary, keeps that after Close Results, never "successfully".
    expect(lead({ run: run('closed', { closedFrom: 'lost' }) })).toEqual(['error', 'error', 'Query failed.'])
    expect(lead({ run: run('closed', { closedFrom: 'failed' }) })).toEqual(['error', 'error', 'Query failed.'])
    expect(lead({ connection: { ...connection, lost: true }, run: run('completed') })).toEqual(['error', 'debug-disconnect', 'Connection lost.'])
    // The sentences are the output pane's.
    expect(statusLeads.completed).toBe('Query executed successfully.')
  })
  it('shows only the connection\'s facts in the window\'s status bar: the results head says how the run went, its time and rows', () => {
    const segment = (patch: Partial<QueryStatusInput>) => { const model = queryStatusModel(input({ variant: 'segment', session: { login: 'sa', spid: 52 }, ...patch })); return [model.tone, model.icon, model.text, ...texts(model)] }
    const facts = ['Server: sql01 (16.0)', 'Login: sa (52)', 'Database: AppData']
    expect(segment({})).toEqual(['ready', 'plug', 'Connected.', ...facts])
    expect(segment({ running: true, run: run('running'), now: 63_500 })).toEqual(['ready', 'plug', 'Connected.', ...facts])
    for (const status of ['completed', 'completedWithErrors', 'failed', 'cancelled', 'timedOut', 'lost', 'closed'] as const) expect(segment({ run: run(status) }), status).toEqual(['ready', 'plug', 'Connected.', ...facts])
    expect(segment({ connection: { ...connection, lost: true }, run: run('failed') })).toEqual(['error', 'debug-disconnect', 'Connection lost.', 'Server: sql01 (connection lost)', 'Database: AppData'])
    expect(segment({ connection: undefined })).toEqual(['disconnected', 'debug-disconnect', 'Disconnected.'])
    // Its time and row settings are the classic bar's; the segment ignores them.
    expect(segment({ settings: { ...settings, 'textEditor.statusBar.executionTime': 'end', 'textEditor.statusBar.showRowCount': true }, run: run('completed') })).toEqual(['ready', 'plug', 'Connected.', ...facts])
  })
  it('counts elapsed time while a query runs, and shows the run\'s own time after', () => {
    // A run without a summary took until it ended, not until now.
    expect(texts(queryStatusModel(input({ run: run('closed', { closedFrom: 'lost', endedAt: 4500 }), now: 999_000 })))).toContain('Elapsed time: 00:00:03')
    expect(texts(queryStatusModel(input({ running: true, run: run('running', { rowsRead: 1 }), now: 63_500 })))).toEqual(['Server: sql01 (16.0)', 'Database: AppData', 'Elapsed time: 00:01:02', 'Rows: 1 row'])
    expect(texts(queryStatusModel(input({ run: run('failed', { rowsRead: 0, summary: { status: 'failed', elapsedMs: 900 } }) })))).toContain('Elapsed time: 00:00:00')
    // Before the first run, as in SSMS.
    expect(texts(queryStatusModel(input()))).toEqual(['Server: sql01 (16.0)', 'Database: AppData', 'Elapsed time: 00:00:00', 'Rows: 0 rows'])
    // Without a connection or a run there is nothing to time.
    expect(queryStatusModel(input({ connection: undefined })).segments).toEqual([])
  })
  it('follows Tools › Options › Text Editor › Editor Tab and Status Bar', () => {
    const off = { ...settings, 'textEditor.statusBar.showServer': false, 'textEditor.statusBar.showLogin': false, 'textEditor.statusBar.showDatabase': false, 'textEditor.statusBar.showRowCount': false, 'textEditor.statusBar.executionTime': 'none' } as const
    const session = { login: 'sa', spid: 52 }
    expect(queryStatusModel(input({ settings: off, session })).segments).toEqual([])
    // The tooltip keeps the whole place whatever the bar shows.
    expect(queryStatusModel(input({ settings: off, session })).place).toBe('sql01 (16.0) | sa (52) | AppData')
    for (const [key, label] of [['textEditor.statusBar.showServer', 'Server'], ['textEditor.statusBar.showLogin', 'Login'], ['textEditor.statusBar.showDatabase', 'Database'], ['textEditor.statusBar.showRowCount', 'Rows']] as const) {
      expect(queryStatusModel(input({ settings: { ...off, [key]: true }, session })).segments.map(segment => segment.label), key).toEqual([label])
    }
    // End: the time of day the last run ended; a running query still counts up.
    const end = { ...off, 'textEditor.statusBar.executionTime': 'end' } as const
    expect(texts(queryStatusModel(input({ settings: end, run: run('completed', { summary: { status: 'completed', elapsedMs: 2500 } }) })))).toEqual(['End time: at 3500'])
    expect(texts(queryStatusModel(input({ settings: end, running: true, run: run('running'), now: 4000 })))).toEqual(['Elapsed time: 00:00:03'])
  })
  it('names the server as SSMS does, and a lost connection as lost', () => {
    expect(versionLabel({ productVersion: '16.0.4135.4' })).toBe('16.0')
    expect(versionLabel({ serverVersion: '15.00.2000' })).toBe('15.0')
    expect(versionLabel({ productVersion: 'unknown', serverVersion: '13.00.5026' })).toBe('13.0')
    expect(versionLabel({})).toBe('')
    expect(serverText({ server: 'sql01', displayName: 'Production', productVersion: '17.0.1000.7' })).toBe('Production (17.0)')
    expect(serverText({ server: 'sql01' })).toBe('sql01')
    expect(serverText({ server: 'sql01', productVersion: '17.0.1000.7', lost: true })).toBe('sql01 (connection lost)')
    // A lost connection has no session to show.
    expect(queryStatusModel(input({ connection: { ...connection, lost: true }, session: { login: 'sa', spid: 52 } })).segments.map(segment => segment.key)).toEqual(['server', 'database'])
  })
  it('uses codicons of the icon registry', () => {
    // The spinner spins with codicon-modifier-spin, which only the codicon font's glyphs take.
    for (const icon of ['plug', 'debug-disconnect', 'loading', 'pass', 'warning', 'error', 'debug-stop', 'watch', 'lock']) expect(iconSpec(icon)?.source, icon).toBe('codicon')
  })
})

describe('the query status facts\' environment tag', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
  /** The facts for a query on a Production connection, as the window's status bar segment and as the query window bar. */
  function render(variant: 'segment' | 'bar') {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    const theme = { subscribe: () => () => {}, getSnapshot: () => 0, accent: (color?: string) => color }
    const workbench = { ...fixture, theme } as unknown as Workbench
    const tab: QueryTab = fixture.documents.create('SQLQuery1.sql', 'SELECT 1', 'master', 'c1')
    const connection: LiveConnection = { id: 'c1', server: 'sql01', database: 'master', serverVersion: '16.00.4135', generation: 1, options: { server: 'sql01', database: 'master', authentication: 'windows', trustServerCertificate: false, environment: 'Production' } }
    return renderToStaticMarkup(createElement(WorkbenchProvider, { workbench, children: createElement(QueryStatusBar, { tab, connection, variant }) }))
  }
  it('leads the server in the query window bar, and is left out of the window\'s status bar segment, which shows it after the backend\'s state', () => {
    expect(render('bar')).toContain('query-status-environment')
    expect(render('bar')).toContain('PROD')
    expect(render('segment')).not.toContain('query-status-environment')
    expect(render('segment')).not.toContain('PROD')
  })

  it('collapses the redundant plug icon and Connected label when compact is enabled for a ready connection, while keeping non-ready states prominent', () => {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    const theme = { subscribe: () => () => {}, getSnapshot: () => 0, accent: (color?: string) => color }
    const workbench = { ...fixture, theme } as unknown as Workbench
    const tab: QueryTab = fixture.documents.create('SQLQuery1.sql', 'SELECT 1', 'master', 'c1')
    const live: LiveConnection = { id: 'c1', server: 'sql01', database: 'master', serverVersion: '16.00.4135', generation: 1, options: { server: 'sql01', database: 'master', authentication: 'windows', trustServerCertificate: false } }
    const renderStatus = (connection: LiveConnection | undefined, variant: 'segment' | 'bar', compact: boolean) =>
      renderToStaticMarkup(createElement(WorkbenchProvider, { workbench, children: createElement(QueryStatusBar, { tab, connection, variant, compact }) }))

    const compactReady = renderStatus(live, 'segment', true)
    expect(compactReady).toContain('data-compact="true"')
    expect(compactReady).toContain('query-status-state visually-hidden')
    expect(compactReady).toContain('Connected.')
    expect(compactReady).not.toContain('data-icon="plug"')
    expect(compactReady).toContain('sql01 (16.0)')

    // Non-ready backend (compact=false) keeps the full state visible alongside the backend's non-ready status.
    const nonReadyBackend = renderStatus(live, 'segment', false)
    expect(nonReadyBackend).not.toContain('data-compact="true"')
    expect(nonReadyBackend).not.toContain('query-status-state visually-hidden')
    expect(nonReadyBackend).toContain('data-icon="plug"')

    // Disconnected / lost connections always stay prominent even when compact=true.
    const disconnected = renderStatus(undefined, 'segment', true)
    expect(disconnected).not.toContain('data-compact="true"')
    expect(disconnected).not.toContain('query-status-state visually-hidden')
    expect(disconnected).toContain('Disconnected.')
    expect(disconnected).toContain('data-icon="debug-disconnect"')

    // Classic SSMS bar ignores compact.
    const classic = renderStatus(live, 'bar', true)
    expect(classic).not.toContain('data-compact="true"')
    expect(classic).toContain('data-icon="plug"')
  })

  it('derives multi-server status without stale success after refuseReadOnly, backend loss, cancel, timeout, or IPC error', () => {
    const staleCompleted = { queryId: 'q1', mode: 'cross' as const, status: 'completed' as const, elapsedMs: 10, targets: [] }
    // Running always clears settled outcome.
    expect(deriveMultiStatus(true, { status: 'failed' }, { multiSummary: staleCompleted })).toBeUndefined()
    // After refuseReadOnly (run.status='failed', no run.multiSummary), never shows stale completed summary.
    expect(deriveMultiStatus(false, { status: 'failed' }, { multiSummary: staleCompleted })).toBe('failed')
    // Backend lost mid-run overrides any stale summary.
    expect(deriveMultiStatus(false, { status: 'lost' }, { multiSummary: staleCompleted })).toBe('failed')
    // Cancelled / timedOut runs without multiSummary map cleanly instead of falling back to stale summary.
    expect(deriveMultiStatus(false, { status: 'cancelled' }, { multiSummary: staleCompleted })).toBe('cancelled')
    expect(deriveMultiStatus(false, { status: 'timedOut' }, { multiSummary: staleCompleted })).toBe('timedOut')
    // Authoritative run.multiSummary (e.g. rolledBack / commitInDoubt) is preserved when run.status is 'failed'.
    expect(deriveMultiStatus(false, { status: 'failed', multiSummary: { ...staleCompleted, status: 'rolledBack' } }, { multiSummary: staleCompleted })).toBe('rolledBack')
    expect(deriveMultiStatus(false, { status: 'failed', multiSummary: { ...staleCompleted, status: 'commitInDoubt' } }, undefined)).toBe('commitInDoubt')
    // IPC error without multiSummary reports failed.
    expect(deriveMultiStatus(false, undefined, { error: 'IPC failed' })).toBe('failed')
  })

  it('matches multi-target live phases strictly by connectionId before falling back to label', () => {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    const theme = { subscribe: () => () => {}, getSnapshot: () => 0, accent: (color?: string) => color }
    fixture.connections.add(
      { id: 'c1', server: 'sql01', displayName: 'SharedName', database: 'master', serverVersion: '16.0', generation: 1 },
      { server: 'sql01', displayName: 'SharedName', database: 'master', authentication: 'windows', trustServerCertificate: false }
    )
    fixture.connections.add(
      { id: 'c2', server: 'sql02', displayName: 'SharedName', database: 'master', serverVersion: '16.0', generation: 1 },
      { server: 'sql02', displayName: 'SharedName', database: 'master', authentication: 'windows', trustServerCertificate: false }
    )
    const tab = fixture.documents.openMultiQuery({
      mode: 'same',
      targets: [
        { connectionId: 'c1', provider: 'sqlserver', database: 'master', enabled: true },
        { connectionId: 'c2', provider: 'sqlserver', database: 'master', enabled: true }
      ]
    })
    // Only c2 is in multiTargets as succeeded; c1 has a connectionId so it must NOT borrow c2's phase by matching label 'SharedName'.
    const queries = new SnapshotStore({
      [tab.id]: {
        running: { queryId: 'q1', connectionId: 'c2', startedAt: 100 },
        multiTargets: [{ targetKey: 't2', connectionId: 'c2', label: 'SharedName', provider: 'sqlserver', database: 'master', phase: 'succeeded' }]
      }
    })
    const workbench = { ...fixture, queries, theme } as unknown as Workbench
    const html = renderToStaticMarkup(createElement(WorkbenchProvider, { workbench, children: createElement(QueryStatusBar, { tab, variant: 'bar' }) }))
    // Only 1 target (c2) has a live phase, not 2!
    expect(html).toContain('Executing on 1 target (1/1 settled)')
  })

  it('R2 Finding 6: emits explicit engine-missing text on Cross-Engine tabs when all enabled targets are connected on only one engine', () => {
    const missingBq = multiTargetSummaryText('cross', [
      { provider: 'sqlserver', connected: true, enabled: true },
      { provider: 'sqlserver', connected: true, enabled: true }
    ])
    expect(missingBq.ready).toBe(false)
    expect(missingBq.label).toBe('2 SQL Servers + 0 BigQuery · Select a BigQuery project')

    const missingSql = multiTargetSummaryText('cross', [
      { provider: 'bigquery', connected: true, enabled: true }
    ])
    expect(missingSql.ready).toBe(false)
    expect(missingSql.label).toBe('0 SQL Servers + 1 BigQuery · Select a SQL Server')

    const model = queryStatusModel({
      database: '',
      running: false,
      multiMode: 'cross',
      multiTargets: [
        { provider: 'sqlserver', connected: true, enabled: true },
        { provider: 'sqlserver', connected: true, enabled: true }
      ],
      now: 1000,
      settings: {
        'textEditor.statusBar.executionTime': 'elapsed',
        'textEditor.statusBar.showServer': true,
        'textEditor.statusBar.showLogin': true,
        'textEditor.statusBar.showDatabase': true,
        'textEditor.statusBar.showRowCount': true
      }
    })
    expect(model.tone).toBe('disconnected')
    expect(model.text).toBe('2 SQL Servers + 0 BigQuery · Select a BigQuery project')
    expect(model.text).not.toContain('2 of 2 connected')
  })

  it('R3 Finding 7: deduplicates identical multi.label in variant="bar" when idle while keeping the Targets segment during execution or settled outcomes', () => {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    const theme = { subscribe: () => () => {}, getSnapshot: () => 0, accent: (color?: string) => color }
    fixture.connections.add(
      { id: 'c1', server: 'sql01', displayName: 'SQL One', database: 'master', serverVersion: '16.0', generation: 1 },
      { server: 'sql01', displayName: 'SQL One', database: 'master', authentication: 'windows', trustServerCertificate: false }
    )
    fixture.connections.add(
      { id: 'c2', server: 'sql02', displayName: 'SQL Two', database: 'master', serverVersion: '16.0', generation: 1 },
      { server: 'sql02', displayName: 'SQL Two', database: 'master', authentication: 'windows', trustServerCertificate: false }
    )
    const tab = fixture.documents.openMultiQuery({
      mode: 'same',
      targets: [
        { connectionId: 'c1', provider: 'sqlserver', database: 'master', enabled: true },
        { connectionId: 'c2', provider: 'sqlserver', database: 'master', enabled: true }
      ]
    })

    // Idle bar: model.text already shows "2 SQL Servers · Ready" -> omit duplicate query-status-server segment.
    const idleWorkbench = { ...fixture, theme } as unknown as Workbench
    const idleHtml = renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: idleWorkbench, children: createElement(QueryStatusBar, { tab, variant: 'bar' }) }))
    const idleVisibleText = idleHtml.replace(/<[^>]+>/g, '')
    expect(idleVisibleText.split('2 SQL Servers · Ready').length - 1).toBe(1)
    expect(idleHtml).not.toContain('query-status-server')

    // Settled outcome bar: model.text differs ("Query executed successfully.") -> keep query-status-server segment.
    const queries = new SnapshotStore({
      [tab.id]: { multiSummary: { queryId: 'q1', mode: 'same' as const, status: 'completed' as const, elapsedMs: 12, targets: [] } }
    })
    const settledWorkbench = { ...fixture, queries, theme } as unknown as Workbench
    const settledHtml = renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: settledWorkbench, children: createElement(QueryStatusBar, { tab, variant: 'bar' }) }))
    expect(settledHtml).toContain('Query executed successfully.')
    expect(settledHtml).toContain('query-status-server')
    expect(settledHtml).toContain('2 SQL Servers · Ready')
  })
})

describe('grouped calm status bar and condensed SQL status chip', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

  it('condenses IntelliSense off and SQL analysis paused into one chip while surfacing issues and full tooltip detail', () => {
    expect(sqlStatusChip(undefined, undefined)).toBeUndefined()
    const paused = sqlStatusChip(
      { label: 'IntelliSense off', detail: 'Language service is not configured.' },
      { label: 'SQL analysis paused', detail: 'Reconnect to restore analysis.' }
    )!
    expect(paused).toMatchObject({ label: 'SQL: Paused', icon: 'code', tone: 'muted' })
    expect(paused.detail).toContain('IntelliSense off: Language service is not configured.')
    expect(paused.detail).toContain('SQL analysis paused: Reconnect to restore analysis.')

    const errors = sqlStatusChip(
      { label: 'IntelliSense', detail: 'Active' },
      { label: 'SQL: 1 error, 1 warning', detail: 'Alt+F8 goes to the next issue.' }
    )!
    expect(errors).toMatchObject({ label: 'SQL: 1 error, 1 warning', icon: 'error', tone: 'error' })

    const unavailable = sqlStatusChip(
      { label: 'IntelliSense unavailable', detail: 'Provider crashed.' },
      { label: 'SQL analysis unavailable', detail: 'Provider crashed.' }
    )!
    expect(unavailable).toMatchObject({ label: 'SQL: Unavailable', icon: 'warning', tone: 'warning' })
  })

  it('renders EditorStatus as calm groups with one clickable SQL chip and intact aria-live status regions', () => {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    const tab = fixture.documents.create('Query1.sql', 'SELECT 1', 'master', 'c1')
    const workbench = {
      ...fixture,
      editorStatus: new SnapshotStore({ line: 9, column: 28, character: 28, eol: 'crlf' as const }),
      inputMode: new SnapshotStore({ mode: 'insert' as const, available: true }),
      sqlLanguage: Object.assign(new SnapshotStore({}), { availability: () => ({ label: 'IntelliSense off', detail: 'Disabled.' }) }),
      sqlDiagnostics: Object.assign(new SnapshotStore({}), { status: () => ({ label: 'SQL analysis paused', detail: 'Paused.' }) }),
      bigQueryCost: Object.assign(new SnapshotStore(new Map()), { status: () => undefined }),
      indexCompletion: Object.assign(new SnapshotStore({}), { availability: () => undefined })
    } as unknown as Workbench
    expect(tab.id).toBeTruthy()
    const html = renderToStaticMarkup(createElement(WorkbenchProvider, { workbench, children: createElement(EditorStatus) }))
    expect(html).toContain('editor-status-caret')
    expect(html).toContain('editor-status-file')
    expect(html).toContain('editor-status-sql')
    expect(html).toContain('SQL: Paused')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-label="SQL IntelliSense"')
    expect(html).toContain('aria-label="SQL query issues"')
  })

  it('replaces vertical pipe separators with calm dividers in the window status bar', () => {
    const rules = stylesheetRules()
    expect(rules.some(rule => rule.selector === '.editor-status > * + *::before')).toBe(false)
    const querySeg = rules.find(rule => rule.selector === '.query-status .query-status-segment + .query-status-segment::before')
    expect(querySeg?.declarations.find(d => d.property === 'content')?.value).toBe("'·'")
    const groupDivider = rules.find(rule => rule.selector === '.editor-status-group + .editor-status-group::before')
    expect(groupDivider?.declarations.find(d => d.property === 'width')?.value).toBe('1px')
  })
})
