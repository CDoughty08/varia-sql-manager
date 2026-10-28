import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/settings/catalog'
import { queryStatusModel, serverText, versionLabel, type QueryStatusInput } from '../src/renderer/src/results/query-status'
import { statusLeads } from '../src/renderer/src/results/status'
import { iconSpec } from '../src/shared/icons'

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
