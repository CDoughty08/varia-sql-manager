import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agoText, cancelQuestion, rerunAsks, rerunQuestion, consoleJobLink, customRange, parseStatements, defaultJobHistoryFilters, jobHistoryActionState, jobHistoryActiveFilters, jobHistoryArgs, jobHistoryColumns, jobHistoryLimits,
  jobHistoryDetailsSchema, qualifiedJobId, type JobHistoryDetails, type JobHistoryRow
} from '../src/shared/bigquery/history'
import { jobsByProject, jobsUnavailableText } from '../src/shared/bigquery/jobs'
import { optionsAllow } from '../src/shared/ipc/methods'
import { liveArgsSchemas } from '../src/shared/live/schema'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { documentProvider } from '../src/renderer/src/documents'
import { actionKeys, cancelNotice, jobHistoryPendingMs, jobHistoryText } from '../src/renderer/src/bigquery/JobHistoryService'
import { argsFor } from '../src/renderer/src/menus/targets'
import { costPromptText } from '../src/renderer/src/services/bigquery-cost-prompt'
import type { LiveGrid, LiveGridSnapshot } from '../src/renderer/src/live/LiveGrid'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { ConnectionInfo } from '../src/shared/contracts'
import { readyBackend, workbenchFixture } from './fixtures/workbench'
import type { FakeLiveHandle } from './fixtures/live-handle'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const row = (patch: Partial<JobHistoryRow> = {}): JobHistoryRow => ({ jobId: 'job_1', location: 'US', state: 'done', type: 'query', mine: true, hidden: false, children: 0, ...patch })

describe('Job History rules', () => {
  it('let main forward a live source only on the engines it serves', () => {
    expect(optionsAllow('live.subscribe', 'bigquery', { source: 'bigquery.jobs' })).toBe(true)
    expect(optionsAllow('live.subscribe', 'sqlserver', { source: 'activity' })).toBe(true)
    expect(optionsAllow('live.subscribe', 'bigquery', { source: 'activity' })).toBe(false)
    expect(optionsAllow('live.subscribe', 'sqlserver', { source: 'bigquery.jobs' })).toBe(false)
    // Object Explorer's BigQuery chip is BigQuery's alone.
    expect(optionsAllow('live.subscribe', 'bigquery', { source: 'bigquery.explorer' })).toBe(true)
    expect(optionsAllow('live.subscribe', 'sqlserver', { source: 'bigquery.explorer' })).toBe(false)
    expect(optionsAllow('live.subscribe', 'bigquery', { source: 'nope' })).toBe(false)
  })
  it('names jobs as BigQuery does and copies the console link as text', () => {
    expect(qualifiedJobId('varia-alpha', 'job_1', 'EU')).toBe('varia-alpha:EU.job_1')
    expect(qualifiedJobId('varia-alpha', 'job_1')).toBe('varia-alpha:job_1')
    expect(consoleJobLink('varia-alpha', 'job_1', 'EU')).toBe('https://console.cloud.google.com/bigquery?project=varia-alpha&j=bq%3AEU%3Ajob_1&page=queryresults')
    expect(consoleJobLink('varia-alpha', 'job_1')).toContain('j=bq%3AUS%3Ajob_1')
  })
  it('send only the filters that apply, always within the source\'s schema', () => {
    expect(jobHistoryArgs(defaultJobHistoryFilters, [], true)).toEqual({ scope: 'mine', hours: 24, prices: true })
    const busy = jobHistoryArgs({
      scope: 'all', custom: { from: 1, to: 2 }, states: ['running', 'running', 'failed'], types: ['query', 'load', 'extract', 'copy'], statements: Array.from({ length: 20 }, (_, index) => `S_${String.fromCharCode(65 + index)}`),
      varia: true, jobs: Array.from({ length: 70 }, (_, index) => ({ jobId: `j_${index}` }))
    }, [{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }, { jobId: 'd' }, { jobId: 'e' }, { jobId: 'a' }], false)
    expect(busy).toMatchObject({ scope: 'all', from: 1, to: 2, states: ['running', 'failed'], varia: true, prices: false })
    expect(busy).not.toHaveProperty('types')
    expect(busy).not.toHaveProperty('hours')
    expect(busy.statements).toHaveLength(jobHistoryLimits.statements)
    expect(busy.jobs).toHaveLength(jobHistoryLimits.pinned)
    expect(busy.expand?.map(job => job.jobId)).toEqual(['b', 'c', 'd', 'e'])
    expect(liveArgsSchemas['bigquery.jobs'].safeParse(busy).success).toBe(true)
    expect(liveArgsSchemas['bigquery.jobs'].safeParse({ scope: 'mine', varia: false }).success).toBe(false)
    expect(jobHistoryActiveFilters(defaultJobHistoryFilters)).toBe(0)
    expect(jobHistoryActiveFilters({ ...defaultJobHistoryFilters, hours: 1, states: ['failed'], varia: true })).toBe(3)
  })
  it("read the statement filter's text and keep a custom range within BigQuery's retention", () => {
    expect(parseStatements('select, merge;CREATE_TABLE_AS_SELECT  select bad-one 1x')).toEqual(['SELECT', 'MERGE', 'CREATE_TABLE_AS_SELECT'])
    expect(parseStatements(Array.from({ length: 30 }, (_, index) => 'S_' + String.fromCharCode(65 + index % 26) + (index >= 26 ? 'X' : '')).join(' '))).toHaveLength(jobHistoryLimits.statements)
    const now = 200 * 86_400_000, day = 86_400_000
    expect(customRange(now - day, now, now)).toEqual({ from: now - day, to: now })
    expect(customRange(now - 400 * day, now - 100 * day, now)).toEqual({ from: now - 180 * day, to: now - 100 * day })
    expect(customRange(now, now - day, now)).toBeUndefined()
    expect(customRange(Number.NaN, now, now)).toBeUndefined()
    expect(liveArgsSchemas['bigquery.jobs'].safeParse(jobHistoryArgs({ ...defaultJobHistoryFilters, custom: customRange(now - 400 * day, now, now)! }, [], true)).success).toBe(true)
  })
  it('offer each action only where it applies, saying why not', () => {
    expect(jobHistoryActionState('openResults', row(), {})).toEqual({ enabled: true })
    expect(jobHistoryActionState('openResults', row({ mine: false }), {}).reason).toBe('Only the job\'s creator can read its result table.')
    expect(jobHistoryActionState('openResults', row({ state: 'running' }), {}).enabled).toBe(false)
    expect(jobHistoryActionState('openResults', row({ state: 'failed' }), {}).enabled).toBe(false)
    expect(jobHistoryActionState('openResults', row({ type: 'load' }), {}).enabled).toBe(false)
    expect(jobHistoryActionState('reattach', row({ state: 'running' }), {})).toEqual({ enabled: true })
    expect(jobHistoryActionState('reattach', row({ state: 'running', parentJobId: 'script_1' }), {}).enabled).toBe(false)
    expect(jobHistoryActionState('reattach', row(), {}).reason).toBe('The job has finished: Open Results instead.')
    expect(jobHistoryActionState('openSql', row({ mine: false, hidden: true }), {}).reason).toBe('BigQuery hides this job\'s details.')
    expect(jobHistoryActionState('openSql', row({ mine: false }), { get: 'refused' })).toEqual({ enabled: false, reason: 'refused' })
    expect(jobHistoryActionState('openSql', row({ parentJobId: 'script_1' }), {}).enabled).toBe(true)
    expect(jobHistoryActionState('rerun', row({ parentJobId: 'script_1' }), {}).enabled).toBe(false)
    expect(jobHistoryActionState('cancel', row(), {}).enabled).toBe(false)
    expect(jobHistoryActionState('cancel', row({ state: 'pending', mine: false }), {})).toEqual({ enabled: true })
    expect(jobHistoryActionState('cancel', row({ state: 'running', mine: false }), { cancel: 'no' })).toEqual({ enabled: false, reason: 'no' })
    expect(jobHistoryActionState('cancel', row({ state: 'running' }), { cancel: 'no' }).enabled).toBe(true)
  })
  it('ask before cancelling, naming the job, its user and its age', () => {
    expect(cancelQuestion(row({ mine: false, user: 'ana@example.com' }), '12 minutes ago')).toBe('Cancel job job_1 started by ana@example.com 12 minutes ago?')
    expect(cancelQuestion(row({ mine: false }))).toBe('Cancel job job_1 started by another user?')
    expect(cancelQuestion(row({ jobId: 'x'.repeat(50) }))).toBe(`Cancel job ${'x'.repeat(39)}…?`)
    expect([agoText(0, 500), agoText(0, 30_000), agoText(0, 60_000), agoText(0, 720_000), agoText(0, 3_600_000), agoText(0, 3 * 86_400_000)])
      .toEqual(['just now', '30 seconds ago', '1 minute ago', '12 minutes ago', '1 hour ago', '3 days ago'])
  })
  it('ask before a Re-run that may change table data or runs another user\'s job, naming it; the cost prompt names it too', () => {
    expect(rerunAsks(row({ statement: 'SELECT' }))).toBe(false)
    // Anything but a SELECT asks: DML, DDL that drops or replaces a table, a script, and a statement BigQuery did not name.
    expect(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE_TABLE', 'SCRIPT', 'DROP_TABLE', 'CREATE_TABLE_AS_SELECT', 'ALTER_TABLE'].every(statement => rerunAsks(row({ statement })))).toBe(true)
    expect(rerunAsks(row({ statement: undefined }))).toBe(true)
    expect(rerunQuestion(row({ statement: 'DROP_TABLE' }))).toBe('Re-run job job_1? Its DROP_TABLE may change tables or data again.')
    expect(rerunQuestion(row({ statement: undefined }))).toBe('Re-run job job_1? BigQuery did not say what kind of statement it is.')
    expect(rerunAsks(row({ statement: 'SELECT', mine: false }))).toBe(true)
    expect(rerunQuestion(row({ statement: 'DELETE' }), '2 hours ago')).toBe('Re-run job job_1 2 hours ago? Its DELETE changes table data again.')
    expect(rerunQuestion(row({ statement: 'SCRIPT', mine: false, user: 'ana@example.com' }))).toBe('Re-run job job_1 started by ana@example.com? It is a script, which may change table data. It runs as you.')
    const request = { prompt: { kind: 'threshold' as const, bytes: 2 ** 40 }, connection: 'acme', thresholdBytes: 2 ** 30, prices: true }
    expect(costPromptText({ ...request, rerunOf: 'job_1' })).toMatchObject({ title: 'Re-run this job?', sentence: expect.stringMatching(/^Re-running job job_1 will process 1\.00 TiB/) })
    expect(costPromptText(request).title).toBe('Run this query?')
    expect(costPromptText({ prompt: { kind: 'incomplete', bytes: 0, reason: 'script' }, connection: 'acme', thresholdBytes: 1, prices: false, rerunOf: 'job_1' }).sentence).toMatch(/^The estimate for re-running job job_1, 0 B, may be low/)
  })
  it('group records without a tab by project for Show in Job History, 64 jobs a project at most', () => {
    const records = [...Array.from({ length: 70 }, (_, index) => ({ jobId: `a_${index}`, project: 'varia-alpha', location: 'US' })), { jobId: 'b_1', project: 'varia-beta' }]
    const show = jobsByProject(records)
    expect(show.map(item => [item.project, item.jobs.length])).toEqual([['varia-alpha', 64], ['varia-beta', 1]])
    expect(show[1].jobs).toEqual([{ jobId: 'b_1' }])
    // With the saved connections and the connected projects: a connected project needs none; another takes the newest of
    // its records' connections that still exists; one with none says why.
    const owned = [
      { jobId: 'c_1', project: 'varia-gamma', profileId: 'p-old', createdAt: 1 }, { jobId: 'c_2', project: 'varia-gamma', profileId: 'p-new', createdAt: 2 },
      { jobId: 'c_3', project: 'varia-gamma', profileId: 'p-gone', createdAt: 3 }, { jobId: 'd_1', project: 'varia-delta', profileId: 'p-gone', createdAt: 1 },
      { jobId: 'e_1', project: 'varia-alpha', profileId: 'p-new', createdAt: 1 }
    ]
    const profiles = new Map([['p-old', 'varia-gamma'], ['p-new', 'varia-gamma']])
    expect(jobsByProject(owned, profiles, new Set(['varia-alpha'])).map(({ jobs: _jobs, ...rest }) => rest)).toEqual([
      { project: 'varia-gamma', profileId: 'p-new' }, { project: 'varia-delta', unavailable: jobsUnavailableText('varia-delta') }, { project: 'varia-alpha' }
    ])
    // A saved connection since edited to another project would open the wrong project's history: the older one is used.
    expect(jobsByProject(owned, new Map([['p-old', 'varia-gamma'], ['p-new', 'varia-omega']]))[0]).toMatchObject({ project: 'varia-gamma', profileId: 'p-old' })
    // Saved connections that could not be read say so rather than that they were removed.
    expect(jobsByProject(owned, null)[1]).toMatchObject({ project: 'varia-delta', unavailable: jobsUnavailableText('varia-delta', true) })
    expect(jobsUnavailableText('varia-delta', true)).toMatch(/^Varia could not read the saved connections/)
  })
  it('keep every action offered while a job\'s cells are read, and none once the connection is gone', () => {
    const pending = { ...row({ state: 'done', type: 'other', mine: false }), pending: true as const }
    expect(actionKeys(pending, {}, [], true)).toEqual({ selected: true, openResults: true, reattach: true, openSql: true, rerun: true, cancel: true })
    expect(actionKeys(row({ state: 'running' }), {}, ['job_1'], true)).toMatchObject({ reattach: true, cancel: false, openResults: false })
    expect(actionKeys(row(), {}, [], false)).toEqual({ selected: false, openResults: false, reattach: false, openSql: false, rerun: false, cancel: false })
    expect(cancelNotice(row(), { ok: true, value: { cancelled: true, state: 'running' } })).toEqual({ tone: 'info', text: jobHistoryText.cancelSent('job_1') })
    expect(cancelNotice(row(), { ok: true, value: { cancelled: true, state: 'done' } })).toEqual({ tone: 'info', text: jobHistoryText.cancelDone('job_1') })
    expect(cancelNotice(row(), { ok: true, value: { cancelled: true, state: 'cancelled' } })).toEqual({ tone: 'info', text: jobHistoryText.cancelled('job_1') })
    expect(cancelNotice(row({ mine: false }), { ok: false, error: 'No.', code: 'PERMISSION_DENIED' }).text).toBe(jobHistoryText.cancelDenied('No.'))
  })
  it('hold the same bounds as the backend\'s BigQueryJobHistory', () => {
    const backend = readFileSync('backend/Varia.Backend/BigQuery/BigQueryJobHistory.cs', 'utf8')
    const constant = (name: string) => Number(new RegExp(`\\b${name} = ([\\d_]+)`).exec(backend)?.[1].replaceAll('_', ''))
    const names = { jobs: 'MaxJobs', pageJobs: 'PageJobs', previewChars: 'PreviewChars', retentionDays: 'RetentionDays', children: 'Children', expanded: 'Expanded', pinned: 'Pinned',
      statements: 'Statements', statementChars: 'StatementChars', errorChars: 'ErrorChars', overlapMs: 'OverlapMs' } as const
    for (const [key, name] of Object.entries(names)) expect(constant(name), name).toBe(jobHistoryLimits[key as keyof typeof names])
    expect(backend).toContain('ResponseBytes = 10 * 1024 * 1024')
    expect(jobHistoryLimits.responseBytes).toBe(10 * 1024 * 1024)
    // A children error past the schema's bound would cost main's check of the whole bigquery.jobs.get answer.
    expect(constant('ChildrenErrorChars')).toBe(jobHistoryDetailsSchema.shape.childrenError.unwrap().maxLength)
  })
  it('treat a Job History document as BigQuery\'s', () => {
    expect(documentProvider({ kind: 'bigQueryJobs' })).toBe('bigquery')
  })
})

const bigQueryInfo = (id: string): ConnectionInfo => ({ id, server: 'varia-alpha', database: '', serverVersion: 'BigQuery', generation: 1 })
const options = (project = 'varia-alpha') => ({ provider: 'bigquery' as const, project, authentication: 'gcloud' as const })

/** A LiveGrid stand-in whose active row is one job: its cells in the probe's column order. */
class FakeGrid extends SnapshotStore<LiveGridSnapshot> {
  /** `others`: further rows by index, which a menu may be opened on while row 0 stays active. */
  select(cells: Partial<Record<(typeof jobHistoryColumns)[number]['id'], string>> | undefined, others: Record<number, Partial<Record<(typeof jobHistoryColumns)[number]['id'], string>>> = {}) {
    if (!cells) { this.publish({ newRows: 0, following: true, lost: false } as unknown as LiveGridSnapshot); return }
    const textOf = (row: Partial<Record<(typeof jobHistoryColumns)[number]['id'], string>>) => jobHistoryColumns.map(column => row[column.id] ?? '')
    const text = textOf(cells)
    const handle = { getWindow: async (first: number) => { const row = first === 0 ? text : others[first] ? textOf(others[first]) : undefined; return row ? { first, count: 1, colStart: 0, colEnd: row.length, text: row, flags: new Uint8Array(row.length) } : { first, count: 0, colStart: 0, colEnd: 0, text: [], flags: new Uint8Array(0) } } }
    this.publish({ newRows: 0, following: true, lost: false, activeKey: cells.job, selection: { entry: 'live', active: { row: 0, col: 0 }, anchor: { row: 0, col: 0 }, blocks: [] }, table: { handle } } as unknown as LiveGridSnapshot)
  }
}
const cells = (patch: Partial<Record<(typeof jobHistoryColumns)[number]['id'], string>> = {}) =>
  ({ state: 'Done', jobId: 'job_1', type: 'Query', statement: 'SELECT', user: 'ana@example.com', created: '2026-11-21 10:00:00', location: 'US', job: 'job_1', mine: '1', hidden: '0', children: '0', ...patch })

const details = (patch: Partial<JobHistoryDetails['job']> = {}): JobHistoryDetails => ({
  job: { jobId: 'job_1', project: 'varia-alpha', location: 'US', state: 'done', type: 'query', sql: 'SELECT 42', labels: [], varia: false, hidden: false, ...patch }, children: []
})

function history(settings: Record<string, unknown> = {}) {
  const fixture = workbenchFixture({ settings })
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connections.add(bigQueryInfo('bq1'), options())
  const handle = () => fixture.live.handles.at(-1) as FakeLiveHandle
  const grid = new FakeGrid({ newRows: 0, following: true, lost: false } as unknown as LiveGridSnapshot)
  return { ...fixture, handle, grid, service: fixture.jobHistory }
}

describe('Job History documents', () => {
  it('open one document per BigQuery connection on the bigquery.jobs source, pinning the jobs a link names', () => {
    const { service, documents, handle, live } = history()
    const id = service.open('bq1')
    expect(documents.active).toMatchObject({ id, kind: 'bigQueryJobs', name: 'Job History - varia-alpha', connectionId: 'bq1' })
    expect(handle().spec).toEqual({ connectionId: 'bq1', source: 'bigquery.jobs', args: { scope: 'mine', hours: 24, prices: true }, probes: [{ probe: 'bigquery.jobs.list' }] })
    expect(handle().owner.key).toBe('tab:' + id)
    documents.newQuery()
    expect(service.open('bq1', [{ jobId: 'script_1', location: 'US' }])).toBe(id)
    expect(documents.active?.id).toBe(id)
    expect(live.open).toHaveBeenCalledTimes(1)
    expect(handle().args.at(-1)).toEqual({ scope: 'mine', hours: 24, jobs: [{ jobId: 'script_1', location: 'US' }], prices: true })
    expect(() => service.open('nope')).toThrow(jobHistoryText.notConnected)
  })
  it('refuse a SQL Server connection, and the command is offered only on BigQuery nodes', () => {
    const { service, connect } = history()
    connect({ id: 'sql1', server: 'sql1.example', database: 'master', serverVersion: '17.0', generation: 1 })
    expect(() => service.open('sql1')).toThrow(jobHistoryText.notConnected)
    const when = compileWhen(commandDescriptor('bigquery.jobHistory').menus!.find(menu => menu.menu === 'explorer.context')!.when!)
    expect(evaluateWhen(when, { explorerNode: 'server', explorerProvider: 'bigquery', explorerServerLost: false })).toBe(true)
    expect(evaluateWhen(when, { explorerNode: 'bqProject', explorerServerLost: false })).toBe(true)
    expect(evaluateWhen(when, { explorerNode: 'server', explorerProvider: 'sqlserver', explorerServerLost: false })).toBe(false)
  })
  it('turn a refused All users listing back to My jobs, say why, and keep All users off for the connection', () => {
    const { service, handle } = history()
    const id = service.open('bq1')
    service.setScope(id, 'all')
    expect(handle().args.at(-1)).toMatchObject({ scope: 'all' })
    handle().deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'bigquery.jobs.list', costMs: 1, effectiveIntervalMs: 5000, status: [{ id: 'held', value: 0 }, { id: 'allUsersDenied', value: 1 }] }] })
    expect(service.get(id)?.filters.scope).toBe('mine')
    expect(service.get(id)?.notice).toMatchObject({ code: 'PERMISSION_DENIED', text: jobHistoryText.allUsersDenied() })
    expect(handle().args.at(-1)).toMatchObject({ scope: 'mine' })
    const sent = handle().args.length
    service.setScope(id, 'all')
    expect(handle().args).toHaveLength(sent)
    expect(service.get(id)?.notice?.text).toBe(jobHistoryText.allUsersRefused)
  })
  it('keep the status line\'s counts, search the text columns, and leave the Cost column empty with Show cost as Bytes', async () => {
    const { service, handle, settings } = history()
    const id = service.open('bq1')
    handle().deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'bigquery.jobs.list', costMs: 1, effectiveIntervalMs: 5000, status: [{ id: 'held', value: 1000 }, { id: 'more', value: 1 }, { id: 'loading', value: 0 }, { id: 'unreachable', value: 'asia-east1' }, { id: 'open', value: 2 }, { id: 'allUsersDenied', value: 0 }] }] })
    expect(service.get(id)?.status).toEqual({ held: 1000, more: true, loading: false, unreachable: 'asia-east1', open: 2 })
    service.setText(id, '  orders  ')
    expect(handle().probes.at(-1)).toEqual({ probe: 'bigquery.jobs.list', patch: { filter: { text: 'orders', columns: ['job', 'user', 'destination', 'sql'] } } })
    await settings.update({ 'queryExecution.bigQuery.showCost': 'bytes' })
    expect(handle().args.at(-1)).toMatchObject({ prices: false })
    const refreshes = handle().refreshes
    service.toggleExpanded(id, { jobId: 'script_1', location: 'US' })
    expect(handle().args.at(-1)).toMatchObject({ expand: [{ jobId: 'script_1', location: 'US' }] })
    // New args sample at once: an idle view (no open job) would otherwise wait out the idle interval for the statements.
    expect(handle().refreshes).toBe(refreshes + 1)
    service.update(id, filters => ({ ...filters, states: ['running', 'pending', 'done', 'failed', 'cancelled'] }))
    expect(handle().args.at(-1)).not.toHaveProperty('states')
  })
  it('read the selected job from the grid, open its results without taking its session, and focus a tab that already holds it', async () => {
    const { service, grid, context, queries, documents, api } = history()
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells())
    await settled()
    expect(service.get(id)?.selected).toMatchObject({ jobId: 'job_1', state: 'done', type: 'query', location: 'US', mine: true, hidden: false, children: 0 })
    expect(context.getState()).toMatchObject({ activeDocumentIsJobHistory: true, jobHistoryJobSelected: true, jobHistoryCanOpenResults: true, jobHistoryCanReattach: false, jobHistoryCanCancel: false })
    const restore = vi.spyOn(queries, 'restoreJobs').mockImplementation(() => undefined)
    await service.attach(id, 'openResults')
    const tab = documents.active!
    // No default dataset: not the active document's, which for Job History is the project.
    expect(tab).toMatchObject({ connectionId: 'bq1', database: '' })
    expect(tab.id).not.toBe(id)
    expect(restore).toHaveBeenCalledWith(tab.id, [expect.objectContaining({ jobId: 'job_1', project: 'varia-alpha', location: 'US', state: 'done', adopt: false })])
    // With the job's SQL read (jobs.get, free), Open Results' tab holds it and the dataset it ran with, so Execute there runs
    // it again once BigQuery no longer keeps the result.
    documents.activate(id)
    api.bigQueryJob.mockResolvedValueOnce({ ok: true, value: details({ sql: 'SELECT 42', dataset: 'varia-alpha.sales' }) })
    await service.attach(id, 'openResults')
    expect(api.bigQueryJob).toHaveBeenLastCalledWith({ connectionId: 'bq1', jobId: 'job_1', location: 'US' })
    expect(documents.getModel(documents.active!.id)?.getValue()).toBe('SELECT 42')
    expect(documents.active).toMatchObject({ database: 'sales' })
    // SQL BigQuery cut is not put there: an empty tab, no default dataset.
    documents.activate(id)
    api.bigQueryJob.mockResolvedValueOnce({ ok: true, value: details({ sql: 'SELECT', sqlTruncated: true, dataset: 'varia-alpha.sales' }) })
    await service.attach(id, 'openResults')
    expect(documents.getModel(documents.active!.id)?.getValue()).toBe('')
    expect(documents.active).toMatchObject({ database: '' })
    restore.mockClear()
    // Re-attach on a running job adopts its session; a tab that already holds the job is shown instead.
    documents.activate(id)
    grid.select(cells({ state: 'Running' }))
    await settled()
    vi.spyOn(queries, 'tabHoldingJob').mockReturnValueOnce(undefined).mockReturnValueOnce(tab.id)
    await service.attach(id, 'reattach')
    expect(restore.mock.calls.at(-1)?.[1][0]).toMatchObject({ jobId: 'job_1', state: 'running' })
    expect(restore.mock.calls.at(-1)?.[1][0]).not.toHaveProperty('adopt')
    documents.activate(id)
    await service.attach(id, 'reattach')
    expect(documents.active?.id).toBe(tab.id)
    expect(restore).toHaveBeenCalledTimes(1)
  })
  it('open the job\'s whole SQL in a new tab, and Re-run executes it there unless the SQL was cut', async () => {
    const { service, grid, api, queries, documents } = history()
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells({ mine: '0', user: 'ben@example.com' }))
    await settled()
    const execute = vi.spyOn(queries, 'execute').mockResolvedValue(undefined)
    api.bigQueryJob.mockResolvedValue({ ok: true, value: details() })
    await service.openSql(id, false)
    expect(api.bigQueryJob).toHaveBeenLastCalledWith({ connectionId: 'bq1', jobId: 'job_1', location: 'US', allUsers: true })
    expect(documents.getModel(documents.active!.id)?.getValue()).toBe('SELECT 42')
    expect(documents.active).toMatchObject({ database: '' })
    expect(execute).not.toHaveBeenCalled()
    // The job's own default dataset when it is in this project; another project's is no tab dataset.
    documents.activate(id)
    api.bigQueryJob.mockResolvedValueOnce({ ok: true, value: details({ dataset: 'varia-alpha.sales' }) })
    await service.openSql(id, false)
    expect(documents.active).toMatchObject({ database: 'sales' })
    documents.activate(id)
    api.bigQueryJob.mockResolvedValueOnce({ ok: true, value: details({ dataset: 'other-project.sales' }) })
    await service.openSql(id, false)
    expect(documents.active).toMatchObject({ database: '' })
    // Re-run of another user's job asks first, naming the job and its user; the tab opens and runs only on Re-run.
    documents.activate(id)
    const tabs = documents.getSnapshot().documents.length
    await service.openSql(id, true)
    expect(service.get(id)?.confirm).toMatchObject({ action: 'rerun', question: expect.stringMatching(/^Re-run job job_1 started by ben@example\.com .+ ago\? It runs as you\.$/) })
    expect(documents.getSnapshot().documents).toHaveLength(tabs)
    service.answerConfirm(id, false)
    expect(service.get(id)?.confirm).toBeUndefined()
    expect(documents.getSnapshot().documents).toHaveLength(tabs)
    await service.openSql(id, true)
    service.answerConfirm(id, true)
    await settled()
    // Execute names the job it runs again, so the cost prompts can.
    expect(execute).toHaveBeenCalledWith(documents.active!.id, undefined, 'job_1')
    documents.activate(id)
    api.bigQueryJob.mockResolvedValue({ ok: true, value: details({ sql: 'SELECT', sqlTruncated: true }) })
    await service.openSql(id, true)
    service.answerConfirm(id, true)
    await settled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(service.get(id)?.notice?.text).toBe(jobHistoryText.sqlTruncated)
    // A refused read of another user's job is remembered: Open SQL is then greyed with the reason.
    documents.activate(id)
    api.bigQueryJob.mockResolvedValue({ ok: false, error: 'Access Denied.', code: 'PERMISSION_DENIED' })
    await service.openSql(id, false)
    expect(service.get(id)?.notice).toMatchObject({ tone: 'error', text: jobHistoryText.getDenied('Access Denied.') })
    expect(service.actionState(id, 'openSql')).toEqual({ enabled: false, reason: jobHistoryText.getDenied('Access Denied.') })
  })
  it('keep the details pane answer when an Open SQL starts before it arrives, and the other way round', async () => {
    const { service, grid, api, documents } = history()
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells())
    await settled()
    let answer!: (value: { ok: true; value: JobHistoryDetails }) => void
    api.bigQueryJob.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const pane = service.toggleDetails(id)
    api.bigQueryJob.mockResolvedValueOnce({ ok: true, value: details({ sql: 'SELECT 7' }) })
    await service.openSql(id, false)
    expect(documents.getModel(documents.active!.id)?.getValue()).toBe('SELECT 7')
    answer({ ok: true, value: details() })
    await pane
    expect(service.get(id)?.details).toMatchObject({ jobId: 'job_1', loading: false, value: { job: { sql: 'SELECT 42' } } })
  })
  it('drop a details answer still on its way when the scope changes', async () => {
    const { service, grid, api } = history()
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells())
    await settled()
    let answer!: (value: { ok: true; value: JobHistoryDetails }) => void
    api.bigQueryJob.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const pane = service.toggleDetails(id)
    await vi.waitFor(() => expect(api.bigQueryJob).toHaveBeenCalled())
    service.setScope(id, 'all')
    answer({ ok: true, value: details() })
    await pane
    expect(service.get(id)?.details).toBeUndefined()
  })
  it('cancel a running job only after asking, and remember a refused cancel of another user\'s job', async () => {
    const { service, grid, api, handle, context } = history({ })
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells({ state: 'Running', mine: '0', user: 'ben@example.com' }))
    await settled()
    expect(context.getState().jobHistoryCanCancel).toBe(true)
    await service.requestCancel(id)
    expect(service.get(id)?.confirm?.question).toMatch(/^Cancel job job_1 started by ben@example\.com .+ ago\?$/)
    service.answerConfirm(id, false)
    expect(api.bigQueryCancelJob).not.toHaveBeenCalled()
    await service.requestCancel(id)
    service.answerConfirm(id, true)
    await settled()
    expect(api.bigQueryCancelJob).toHaveBeenCalledWith({ connectionId: 'bq1', jobId: 'job_1', location: 'US' })
    expect(service.get(id)?.notice).toEqual({ tone: 'info', text: jobHistoryText.cancelSent('job_1') })
    expect(handle().refreshes).toBe(1)
    api.bigQueryCancelJob.mockResolvedValueOnce({ ok: false, error: 'No.', code: 'PERMISSION_DENIED' })
    await service.requestCancel(id)
    service.answerConfirm(id, true)
    await settled()
    expect(service.get(id)?.notice).toMatchObject({ tone: 'error', text: jobHistoryText.cancelDenied('No.') })
    expect(context.getState().jobHistoryCanCancel).toBe(false)
    expect(service.actionState(id, 'cancel').reason).toBe(jobHistoryText.cancelDenied('No.'))
  })
  it("re-run the user's own SELECT at once, and ask first for one that changes table data", async () => {
    const { service, grid, api, queries, documents } = history()
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    const execute = vi.spyOn(queries, 'execute').mockResolvedValue(undefined)
    api.bigQueryJob.mockResolvedValue({ ok: true, value: details() })
    grid.select(cells())
    await settled()
    await service.openSql(id, true)
    expect(service.get(id)?.confirm).toBeUndefined()
    expect(execute).toHaveBeenCalledWith(documents.active!.id, undefined, 'job_1')
    documents.activate(id)
    grid.select(cells({ statement: 'MERGE' }))
    await settled()
    await service.openSql(id, true)
    expect(service.get(id)?.confirm).toMatchObject({ action: 'rerun', question: expect.stringMatching(/^Re-run job job_1 .+ ago\? Its MERGE changes table data again\.$/) })
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('act on the pressed row when a menu opens on a row other than the active one', async () => {
    const { service, grid, api, commands } = history()
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    // The active row is job_1; row 3 holds job_3 (another user's running job).
    grid.select(cells(), { 3: cells({ job: 'job_3', jobId: 'job_3', state: 'Running', mine: '0', user: 'ben@example.com', location: 'EU' }) })
    await settled()
    const target = { kind: 'jobHistory' as const, tabId: id, row: 3 }
    // Every row action is offered for a pressed row: its job is read when one runs.
    expect(argsFor(target).state).toMatchObject({ jobHistoryCanCancel: true, jobHistoryCanRerun: true })
    expect(argsFor({ kind: 'jobHistory', tabId: id }).state).toBeUndefined()
    await commands.execute('bigquery.copyJobId', argsFor(target), 'menu')
    expect(api.writeClipboardText).toHaveBeenLastCalledWith('varia-alpha:EU.job_3')
    await commands.execute('bigquery.cancelJob', argsFor(target), 'menu')
    expect(service.get(id)?.confirm).toMatchObject({ action: 'cancel', job: { jobId: 'job_3' }, question: expect.stringMatching(/^Cancel job job_3 started by ben@example\.com/) })
    service.answerConfirm(id, true)
    await settled()
    expect(api.bigQueryCancelJob).toHaveBeenCalledWith({ connectionId: 'bq1', jobId: 'job_3', location: 'EU' })
    // An action that does not apply to the pressed job says why, whatever the active row allows.
    await commands.execute('bigquery.openJobResults', argsFor(target), 'menu')
    expect(service.get(id)?.notice?.text).toBe('Only the job\'s creator can read its result table.')
    // The active row's own row is the selected job.
    await commands.execute('bigquery.copyJobId', argsFor({ ...target, row: 0 }), 'menu')
    expect(api.writeClipboardText).toHaveBeenLastCalledWith('varia-alpha:US.job_1')
  })
  it('act on the job the menu was opened on when a refresh moves the rows meanwhile', async () => {
    const { service, grid, api, commands } = history()
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells(), { 3: cells({ job: 'job_3', jobId: 'job_3' }) })
    await settled()
    // The menu opens on row 3, then a new job is listed and row 3 holds another job before the action runs.
    service.pressRow(id, 3)
    grid.select(cells({ job: 'job_new', jobId: 'job_new' }), { 3: cells({ job: 'job_2', jobId: 'job_2' }) })
    await settled()
    const target = { kind: 'jobHistory' as const, tabId: id, row: 3 }
    await commands.execute('bigquery.copyJobId', argsFor(target), 'menu')
    expect(api.writeClipboardText).toHaveBeenLastCalledWith('varia-alpha:US.job_3')
    // A row the list no longer has says so rather than doing nothing.
    api.writeClipboardText.mockClear()
    await commands.execute('bigquery.copyJobId', argsFor({ ...target, row: 7 }), 'menu')
    expect(api.writeClipboardText).not.toHaveBeenCalled()
    expect(service.get(id)?.notice?.text).toBe(jobHistoryText.rowUnread)
  })
  it('copy the qualified job id and the console link as text', async () => {
    const { service, grid, api } = history()
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells({ location: 'EU' }))
    await settled()
    await service.copy(id, 'id')
    expect(api.writeClipboardText).toHaveBeenLastCalledWith('varia-alpha:EU.job_1')
    await service.copy(id, 'link')
    expect(api.writeClipboardText).toHaveBeenLastCalledWith(consoleJobLink('varia-alpha', 'job_1', 'EU'))
    expect(service.get(id)?.notice?.text).toBe(jobHistoryText.copied('the console link'))
  })
  it('keep filters changed while the connection is lost for the next subscription, and give the document no dataset', () => {
    const { service, handle, connections, documents } = history()
    const id = service.open('bq1')
    // The project is no dataset: a new query opened from Job History takes the active document's, so it holds none.
    expect(documents.active).toMatchObject({ id, database: '' })
    const refreshes = handle().refreshes
    connections.markLostBefore(2)
    service.setScope(id, 'all')
    expect(handle().args.at(-1)).toMatchObject({ scope: 'all' })
    expect(handle().refreshes).toBe(refreshes)
  })
  it('clear the search when a link pins jobs, and say why the details pane cannot read a job on a lost connection', async () => {
    const { service, handle, grid, connections, api } = history()
    const id = service.open('bq1')
    service.setText(id, 'orders')
    expect(service.open('bq1', [{ jobId: 'job_1', location: 'US' }])).toBe(id)
    expect(service.get(id)?.text).toBe('')
    expect(handle().probes.at(-1)).toMatchObject({ probe: 'bigquery.jobs.list' })
    // A running job that finishes reloads the open details pane: its facts changed.
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells({ state: 'Running' }))
    await settled()
    api.bigQueryJob.mockResolvedValue({ ok: true, value: details({ state: 'running' }) })
    await service.toggleDetails(id)
    expect(api.bigQueryJob).toHaveBeenCalledTimes(1)
    api.bigQueryJob.mockResolvedValue({ ok: true, value: details() })
    grid.select(cells())
    await settled()
    expect(api.bigQueryJob).toHaveBeenCalledTimes(2)
    expect(service.get(id)?.details).toMatchObject({ loading: false, value: { job: { state: 'done' } } })
    connections.markLostBefore(2)
    await service.loadDetails(id)
    expect(service.get(id)?.details).toEqual({ jobId: 'job_1', loading: false, error: { message: jobHistoryText.notConnected } })
    // A grid that goes away takes its selection with it.
    service.attachGrid(id, undefined)
    expect(service.get(id)?.selected).toBeUndefined()
  })
  it('show jobs of a project not connected yet once a connection to it goes live', () => {
    const { service, connections, documents } = history()
    expect(service.show('varia-beta', [{ jobId: 'job_9' }])).toBe(false)
    expect(Object.keys(service.getSnapshot().documents)).toEqual([])
    connections.add(bigQueryInfo('bq2'), options('varia-beta'))
    const opened = Object.values(service.getSnapshot().documents)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ connectionId: 'bq2', project: 'varia-beta', filters: { jobs: [{ jobId: 'job_9' }] } })
    expect(documents.active?.id).toBe(opened[0].id)
    expect(service.show('varia-alpha', [{ jobId: 'job_1' }])).toBe(true)
  })
  it('let a Show in Job History lapse when its project connects long after (a Connect given up)', () => {
    const { service, connections } = history()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    expect(service.show('varia-beta', [{ jobId: 'job_9' }])).toBe(false)
    clock.mockReturnValue(1_000_000 + jobHistoryPendingMs)
    connections.add(bigQueryInfo('bq2'), options('varia-beta'))
    clock.mockRestore()
    expect(Object.keys(service.getSnapshot().documents)).toEqual([])
  })
  it('run the palette command on the one live BigQuery connection and the row commands on the active document', async () => {
    const { commands, documents, grid, service, api } = history()
    expect(await commands.execute('bigquery.jobHistory', undefined, 'palette')).not.toBe(false)
    const id = documents.active!.id
    expect(service.get(id)?.connectionId).toBe('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells())
    await settled()
    await commands.execute('bigquery.copyJobId', undefined, 'palette')
    expect(api.writeClipboardText).toHaveBeenLastCalledWith('varia-alpha:US.job_1')
    expect(await commands.execute('bigquery.jobHistory', { bigQueryJobs: { connectionId: 'bq1', jobs: [{ jobId: 'job_7', location: 'US' }] } }, 'api')).not.toBe(false)
    expect(service.get(id)?.filters.jobs).toEqual([{ jobId: 'job_7', location: 'US' }])
  })
})
