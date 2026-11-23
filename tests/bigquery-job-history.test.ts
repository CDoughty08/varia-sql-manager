import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agoText, cancelQuestion, consoleJobLink, customRange, parseStatements, defaultJobHistoryFilters, jobHistoryActionState, jobHistoryActiveFilters, jobHistoryArgs, jobHistoryColumns, jobHistoryLimits,
  jobHistoryDetailsSchema, qualifiedJobId, type JobHistoryDetails, type JobHistoryRow
} from '../src/shared/bigquery/history'
import { jobsByProject } from '../src/shared/bigquery/jobs'
import { liveArgsSchemas } from '../src/shared/live/schema'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { documentProvider } from '../src/renderer/src/documents'
import { actionKeys, cancelNotice, jobHistoryPendingMs, jobHistoryText } from '../src/renderer/src/bigquery/JobHistoryService'
import type { LiveGrid, LiveGridSnapshot } from '../src/renderer/src/live/LiveGrid'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { ConnectionInfo } from '../src/shared/contracts'
import { readyBackend, workbenchFixture } from './fixtures/workbench'
import type { FakeLiveHandle } from './fixtures/live-handle'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const row = (patch: Partial<JobHistoryRow> = {}): JobHistoryRow => ({ jobId: 'job_1', location: 'US', state: 'done', type: 'query', mine: true, hidden: false, children: 0, ...patch })

describe('Job History rules', () => {
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
  it('group records without a tab by project for Show in Job History, 64 jobs a project at most', () => {
    const records = [...Array.from({ length: 70 }, (_, index) => ({ jobId: `a_${index}`, project: 'varia-alpha', location: 'US' })), { jobId: 'b_1', project: 'varia-beta' }]
    const show = jobsByProject(records)
    expect(show.map(item => [item.project, item.jobs.length])).toEqual([['varia-alpha', 64], ['varia-beta', 1]])
    expect(show[1].jobs).toEqual([{ jobId: 'b_1' }])
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
  select(cells: Partial<Record<(typeof jobHistoryColumns)[number]['id'], string>> | undefined) {
    if (!cells) { this.publish({ newRows: 0, following: true, lost: false } as unknown as LiveGridSnapshot); return }
    const text = jobHistoryColumns.map(column => cells[column.id] ?? '')
    const handle = { getWindow: async () => ({ first: 0, count: 1, colStart: 0, colEnd: text.length, text, flags: new Uint8Array(text.length) }) }
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
    const { service, grid, context, queries, documents } = history()
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
    expect(restore).toHaveBeenCalledTimes(2)
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
    documents.activate(id)
    await service.openSql(id, true)
    expect(execute).toHaveBeenCalledWith(documents.active!.id)
    documents.activate(id)
    api.bigQueryJob.mockResolvedValue({ ok: true, value: details({ sql: 'SELECT', sqlTruncated: true }) })
    await service.openSql(id, true)
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
  it('cancel a running job only after asking, and remember a refused cancel of another user\'s job', async () => {
    const { service, grid, api, handle, context } = history({ })
    const id = service.open('bq1')
    service.attachGrid(id, grid as unknown as LiveGrid)
    grid.select(cells({ state: 'Running', mine: '0', user: 'ben@example.com' }))
    await settled()
    expect(context.getState().jobHistoryCanCancel).toBe(true)
    await service.requestCancel(id)
    expect(service.get(id)?.confirm?.question).toMatch(/^Cancel job job_1 started by ben@example\.com .+ ago\?$/)
    service.answerCancel(id, false)
    expect(api.bigQueryCancelJob).not.toHaveBeenCalled()
    await service.requestCancel(id)
    service.answerCancel(id, true)
    await settled()
    expect(api.bigQueryCancelJob).toHaveBeenCalledWith({ connectionId: 'bq1', jobId: 'job_1', location: 'US' })
    expect(service.get(id)?.notice).toEqual({ tone: 'info', text: jobHistoryText.cancelSent('job_1') })
    expect(handle().refreshes).toBe(1)
    api.bigQueryCancelJob.mockResolvedValueOnce({ ok: false, error: 'No.', code: 'PERMISSION_DENIED' })
    await service.requestCancel(id)
    service.answerCancel(id, true)
    await settled()
    expect(service.get(id)?.notice).toMatchObject({ tone: 'error', text: jobHistoryText.cancelDenied('No.') })
    expect(context.getState().jobHistoryCanCancel).toBe(false)
    expect(service.actionState(id, 'cancel').reason).toBe(jobHistoryText.cancelDenied('No.'))
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
