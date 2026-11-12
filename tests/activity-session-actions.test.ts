import { afterEach, describe, expect, it, vi } from 'vitest'
import { killOutcomes, liveColumnId } from '../src/shared/activity/catalog'
import type { ActivityDetailsResult } from '../src/shared/activity/schema'
import type { ApiResult } from '../src/shared/contracts'
import { liveProbes } from '../src/shared/live/catalog'
import type { AppliedTick } from '../src/renderer/src/live/LiveService'
import type { LiveOutput, LiveRowActions, MenuTarget } from '../src/renderer/src/menus/targets'
import { targetKeys } from '../src/renderer/src/menus/targets'
import {
  detailsState, detailsText, isVariaPool, killOffer, killQuestion, killReport, loginTimeOf, sessionColumns, sessionFromRow, sessionRows, type SessionRef
} from '../src/renderer/src/activity/session-actions'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

// Details and Kill Process (docs/activity-monitor.md, Session actions): what they read from a row, whether Kill is
// offered, how each answer reads, and the service's requests, over the workbench fixture's fake API.

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }

const session57: SessionRef = { sessionId: 57, loginTime: '2026-11-09T08:00:00.000', hostProcessId: 4100, login: 'app_orders', hostName: 'APP-01', openTransactions: 1 }
const present = (overrides: Partial<ActivityDetailsResult> = {}): ActivityDetailsResult => ({
  sessionId: 57, state: 'present', elapsedMs: 4,
  session: { sessionId: 57, loginTime: '2026-11-09T08:00:00.000', isUserProcess: true, login: 'app_orders', hostName: 'APP-01', isolationLevel: 'ReadCommitted', status: 'sleeping', requestCount: 0, cpuMs: 120, logicalReads: 512, reads: 4, writes: 1, memoryKb: 64, openTransactions: 1 },
  inputBuffer: { eventType: 'Language Event', parameters: 0, text: { text: 'BEGIN TRAN; UPDATE dbo.Orders SET Status = 2', chars: 45, truncated: false } },
  ...overrides
})

describe('session rows', () => {
  it('reads the identity every session pane carries, by the live layer\'s column ids', () => {
    expect(sessionColumns('sessions')).toEqual(['sessionId', 'loginTime', 'hostProcessId', 'login', 'hostName', 'openTransactions', 'varia'])
    expect(sessionColumns('blocking')).toEqual(['chainSessionId', 'chainLoginTime', 'chainHostProcessId', 'chainLogin', 'chainHostName', 'chainOpenTransactions', 'chainVaria'])
    expect(sessionColumns('activeQueries')).toEqual(['activeSessionId', 'activeLoginTime', 'activeHostProcessId', 'activeLogin', 'activeHostName', 'activeOpenTransactions', 'activeVaria'])
    // Every one of them is a column of the live table the pane's grid shows.
    const tables = liveProbes['activity.sessions'].tables!
    for (const [index, table] of (['sessions', 'blocking', 'activeQueries'] as const).entries())
      for (const id of sessionColumns(table)) expect(tables[index].columns.map(column => column.id), id).toContain(id)
  })
  it('turns a row\'s stored texts into the session Details and Kill name, or none without an id and login time', () => {
    const cells = { chainSessionId: '57', chainLoginTime: '2026-11-09 08:00:00.000', chainHostProcessId: '4100', chainLogin: 'app_orders', chainHostName: 'APP-01', chainOpenTransactions: '1', chainVaria: null }
    expect(sessionFromRow('blocking', cells)).toEqual(session57)
    expect(sessionFromRow('blocking', { ...cells, chainHostProcessId: null, chainLogin: '' })).toEqual({ ...session57, hostProcessId: null, login: undefined })
    expect(sessionFromRow('blocking', { ...cells, chainLoginTime: null })).toBeUndefined()
    expect(sessionFromRow('blocking', { ...cells, chainSessionId: '0' })).toBeUndefined()
    expect(sessionFromRow('blocking', { ...cells, chainSessionId: 'x' })).toBeUndefined()
    expect(sessionFromRow('blocking', undefined)).toBeUndefined()
    expect(loginTimeOf('2026-11-09 08:00:00.1234567')).toBe('2026-11-09T08:00:00.1234567')
    expect(loginTimeOf('yesterday')).toBeUndefined()
  })
})

describe('Kill Process', () => {
  it('is offered for user sessions, refused without ALTER ANY CONNECTION, and never for Varia\'s own pools', () => {
    expect(killOffer(session57, 1)).toEqual({ allowed: true })
    // Until the first sessions sample says, the backend's own check (denied) decides.
    expect(killOffer(session57, undefined)).toEqual({ allowed: true })
    expect(killOffer(session57, 0)).toMatchObject({ allowed: false, reason: expect.stringContaining('ALTER ANY CONNECTION') })
    const pool = { ...session57, varia: 'Varia Activity Monitor' }
    expect(isVariaPool(pool)).toBe(true)
    expect(killOffer(pool, 1)).toMatchObject({ allowed: false, reason: expect.stringContaining('Varia\'s own') })
    // A query tab of this window is a session like any other.
    expect(isVariaPool({ varia: 'Query tab' })).toBe(false)
    expect(killOffer(undefined, 1).allowed).toBe(false)
  })
  it('names the session, its login, host and open transactions, and warns about rollback', () => {
    const question = killQuestion(session57)
    expect(question.title).toBe('Kill session 57?')
    expect(question.facts).toEqual([['Login', 'app_orders'], ['Host', 'APP-01'], ['Open transactions', '1']])
    expect(question.warning).toContain('open transaction rolls back')
    expect(killQuestion({ ...session57, openTransactions: 0 }).warning).toContain('Any open transaction rolls back')
    expect(killQuestion({ sessionId: 9, loginTime: '2026-11-09T08:00:00', hostProcessId: null }).facts).toEqual([['Login', 'Unknown'], ['Host', 'None'], ['Open transactions', 'Unknown']])
  })
  it('reports every outcome in its own words, with the rollback and the session that no longer exists', () => {
    const report = (outcome: keyof typeof killOutcomes, message?: string) => killReport(session57, { results: [{ sessionId: 57, outcome, ...message ? { message } : {} }] })
    expect(report('killed')).toEqual({ tone: 'success', title: 'Session 57 was killed.', detail: expect.stringContaining('rolling back n %') })
    expect(killReport({ ...session57, openTransactions: 0 }, { results: [{ sessionId: 57, outcome: 'killed' }] }).detail).toBe(killOutcomes.killed)
    expect(report('ended')).toEqual({ tone: 'info', title: 'Session 57 had already ended.', detail: killOutcomes.ended })
    expect(report('changed').detail).toBe(killOutcomes.changed)
    expect(report('denied')).toMatchObject({ tone: 'error', detail: killOutcomes.denied })
    expect(report('varia').tone).toBe('warning')
    expect(report('failed', 'Lock request time out period exceeded.').detail).toBe(`Lock request time out period exceeded. ${killOutcomes.failed}`)
    // Not tried: the request's error, or the IPC failure, says why, and that nothing was killed.
    expect(killReport(session57, { results: [], error: { code: 'TIMEOUT', message: 'Kill Process ran out of time.', retryable: true } })).toEqual({ tone: 'error', title: 'Session 57 was not killed.', detail: 'Kill Process ran out of time. Nothing was killed.' })
    expect(killReport(session57, undefined, 'The backend is busy.').detail).toBe('The backend is busy. Nothing was killed.')
  })
})

describe('Details', () => {
  it('says when the session left, or its id now names another, and copies every section it read', () => {
    expect(detailsState(present())).toEqual({ kind: 'present' })
    expect(detailsState({ sessionId: 57, state: 'ended', elapsedMs: 1 })).toMatchObject({ kind: 'departed', message: expect.stringContaining('has ended') })
    expect(detailsState({ sessionId: 57, state: 'changed', elapsedMs: 1 })).toMatchObject({ kind: 'departed', message: expect.stringContaining('another session') })
    expect(detailsState({ sessionId: 57, state: 'unknown', elapsedMs: 1, error: { code: 'BLOCKED', message: 'Details waited too long for a lock.', retryable: true } })).toEqual({ kind: 'error', message: 'Details waited too long for a lock.' })
    expect(sessionRows(present().session!)).toContainEqual(['Login time', '2026-11-09 08:00:00.000'])
    const text = detailsText(present({ statement: { text: 'SELECT 1', chars: 70_000, truncated: true }, locks: [{ resourceType: 'KEY', mode: 'X', status: 'GRANT', count: 3 }] }))
    expect(text).toContain('Identity and Now\n----------------\nSession ID: 57')
    expect(text).toContain('Current statement\n-----------------\nSELECT 1\n(First 8 of 70,000 characters.)')
    expect(text).toContain('Last batch\n----------\nEvent: Language Event\nBEGIN TRAN;')
    expect(text).toContain('Locks\n-----\nKEY\t\tX\tGRANT\t3')
  })
})

function monitorFixture() {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  const id = fixture.activity.open('c1')
  return { ...fixture, id }
}
const tick = (canKill: number): AppliedTick => ({ subscriptionId: 's', tick: { type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'activity.sessions', costMs: 1, effectiveIntervalMs: 2000, status: [{ id: 'canKill', value: canKill }] }] } as never })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('ActivityMonitorService session actions', () => {
  it('reads Details for the session, keeps only the newest answer, loads locks on request, and cancels the read on close', async () => {
    const { activity, api, id } = monitorFixture()
    const first = deferred<ApiResult<ActivityDetailsResult>>(), second = deferred<ApiResult<ActivityDetailsResult>>()
    api.activityDetails.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    activity.openDetails(id, session57)
    expect(activity.get(id)?.details).toMatchObject({ session: session57, status: 'loading', locks: 'none' })
    expect(api.activityDetails).toHaveBeenLastCalledWith({ requestId: expect.any(String), connectionId: 'c1', sessionId: 57, loginTime: '2026-11-09T08:00:00.000' })
    const firstId = api.activityDetails.mock.calls[0][0].requestId
    // Refresh while the first read runs: the first is cancelled, and its late answer changes nothing.
    activity.refreshDetails(id)
    expect(api.cancelActivity).toHaveBeenCalledWith([firstId])
    second.resolve({ ok: true, value: present() })
    await settled()
    first.resolve({ ok: true, value: { sessionId: 57, state: 'ended', elapsedMs: 1 } })
    await settled()
    expect(activity.get(id)?.details).toMatchObject({ status: 'ready', result: { state: 'present' } })
    api.activityDetails.mockResolvedValueOnce({ ok: true, value: present({ locks: [{ resourceType: 'KEY', mode: 'X', status: 'GRANT', count: 1 }] }) })
    activity.loadLocks(id)
    expect(api.activityDetails).toHaveBeenLastCalledWith(expect.objectContaining({ locks: true }))
    await settled()
    expect(activity.get(id)?.details).toMatchObject({ status: 'ready', locks: 'loaded' })
    // Closing with a read in flight cancels it in the backend.
    api.activityDetails.mockReturnValueOnce(new Promise(() => {}))
    activity.refreshDetails(id)
    const open = api.activityDetails.mock.calls.at(-1)![0].requestId
    activity.closeDetails(id)
    expect(api.cancelActivity).toHaveBeenLastCalledWith([open])
    expect(activity.get(id)?.details).toBeUndefined()
  })
  it('shows a failed read, but not a cancelled one', async () => {
    const { activity, api, id } = monitorFixture()
    api.activityDetails.mockResolvedValueOnce({ ok: false, error: 'The SQL backend is not running.', code: 'BACKEND_UNAVAILABLE' })
    activity.openDetails(id, session57)
    await settled()
    expect(activity.get(id)?.details).toMatchObject({ status: 'failed', error: 'The SQL backend is not running.' })
    api.activityDetails.mockResolvedValueOnce({ ok: false, error: 'Cancelled.', code: 'CANCELLED' })
    activity.refreshDetails(id)
    await settled()
    expect(activity.get(id)?.details?.status).toBe('loading')
  })
  it('asks before Kill, sends the row\'s identity, reports the outcome and samples again; Cancel kills nothing', async () => {
    const { activity, api, id, liveViews } = monitorFixture()
    activity.askKill(id, session57)
    expect(activity.get(id)?.kill).toEqual({ session: session57, phase: 'confirm' })
    activity.cancelKill(id)
    expect(activity.get(id)?.kill).toBeUndefined()
    expect(api.activityKill).not.toHaveBeenCalled()
    api.activityKill.mockResolvedValueOnce({ ok: true, value: { results: [{ sessionId: 57, outcome: 'killed' }], elapsedMs: 3 } })
    activity.askKill(id, session57)
    const running = activity.confirmKill(id)
    expect(activity.get(id)?.kill?.phase).toBe('running')
    await running
    expect(api.activityKill).toHaveBeenCalledWith({ connectionId: 'c1', sessions: [{ sessionId: 57, loginTime: '2026-11-09T08:00:00.000', hostProcessId: 4100 }] })
    expect(activity.get(id)).toMatchObject({ kill: undefined, killReport: { tone: 'success', title: 'Session 57 was killed.' } })
    expect(liveViews.last.calls.at(-1)).toEqual({ method: 'refresh' })
    activity.dismissKillReport(id)
    expect(activity.get(id)?.killReport).toBeUndefined()
  })
  it('refuses Kill once the sessions probe says the login may not end sessions, and for Varia\'s own pools', async () => {
    const { activity, api, id, liveViews } = monitorFixture()
    liveViews.last.tick(tick(0))
    activity.askKill(id, session57)
    expect(activity.killOffer(id, session57)).toMatchObject({ allowed: false })
    await activity.confirmKill(id)
    expect(api.activityKill).not.toHaveBeenCalled()
    // A permission gone while the confirm was open closes it with the reason, rather than doing nothing.
    expect(activity.get(id)?.kill).toBeUndefined()
    expect(activity.get(id)?.killReport).toMatchObject({ tone: 'error', title: 'Session 57 was not killed.', detail: expect.stringMatching(/needs ALTER ANY CONNECTION.*Nothing was killed\./) })
    liveViews.last.tick(tick(1))
    expect(activity.killOffer(id, { ...session57, varia: 'Varia Object Explorer' }).allowed).toBe(false)
  })
  it('gives the palette the focused pane, else the newest mounted', () => {
    const { activity, id } = monitorFixture()
    const first = { kind: 'session' as const, can: () => true, run: () => {} }, second = { ...first }
    const one = activity.registerSessionRows(id, first)
    activity.registerSessionRows(id, second)
    expect(activity.activeSessionRows(id)).toBe(second)
    activity.focusSessionRows(id, first)
    expect(activity.activeSessionRows(id)).toBe(first)
    one.dispose()
    expect(activity.activeSessionRows(id)).toBe(second)
  })
  it('reports a kill the backend could not try as nothing killed', async () => {
    const { activity, api, id } = monitorFixture()
    api.activityKill.mockResolvedValueOnce({ ok: false, error: 'Another Kill Process is running on this connection.', code: 'BUSY' })
    activity.askKill(id, session57)
    await activity.confirmKill(id)
    expect(activity.get(id)?.killReport).toMatchObject({ tone: 'error', detail: 'Another Kill Process is running on this connection. Nothing was killed.' })
  })
})

describe('session commands', () => {
  const rowsOf = (can: boolean) => ({ kind: 'session' as const, can: () => can, run: vi.fn<LiveRowActions['run']>() })
  it('show in Query Output\'s menu only on a session grid, and act on its rows', () => {
    const { commands, id } = monitorFixture()
    const rows = rowsOf(true)
    const target = { kind: 'output', tabId: '', view: 'live', resultIndex: 0, selectedText: '', element: {} as HTMLElement, live: { sortable: true, rows } as unknown as LiveOutput } as MenuTarget
    expect(targetKeys(target).outputLiveRows).toBe('session')
    expect(targetKeys({ ...target, live: { sortable: true } as LiveOutput } as MenuTarget).outputLiveRows).toBe('')
    expect(commands.isEnabled('activity.sessionDetails', { target, tabId: id })).toBe(true)
    void commands.execute('activity.killProcess', { target, tabId: id }, 'menu')
    expect(rows.run).toHaveBeenCalledWith('kill')
    // A grid with no row actions (Resource Waits) offers neither.
    const plain = { ...target, live: { sortable: true } as LiveOutput } as MenuTarget
    expect(commands.isEnabled('activity.sessionDetails', { target: plain, tabId: id })).toBe(false)
  })
  it('act from the palette on the session pane focused last', () => {
    const { activity, commands, id } = monitorFixture()
    expect(commands.isEnabled('activity.sessionDetails')).toBe(false)
    const first = rowsOf(true), second = rowsOf(false)
    const one = activity.registerSessionRows(id, first), two = activity.registerSessionRows(id, second)
    activity.focusSessionRows(id, second)
    expect(commands.isEnabled('activity.killProcess')).toBe(false)
    activity.focusSessionRows(id, first)
    void commands.execute('activity.sessionDetails', undefined, 'palette')
    expect(first.run).toHaveBeenCalledWith('details')
    one.dispose()
    two.dispose()
    expect(activity.activeSessionRows(id)).toBeUndefined()
    expect(liveColumnId('blocking', 'loginTime')).toBe('chainLoginTime')
  })
})
