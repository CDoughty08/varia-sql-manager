import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentPropertiesChanges, agentPropertiesProblems, agentPropertiesText, draftLimits, draftPurge, initialAgentPropertiesDraft, keptFor, purgeCutoff, purgeRowsEstimate, rateText,
  retentionLimits, serverClock, serverTimeDiffers, sizesTouched, spanText, type AgentHistoryFacts, type AgentPropertiesDraft, type AgentPropertiesModel
} from '../src/shared/actions/agent-properties'
import { actionDescribeSchema, actionExecuteRequestSchema, actionScriptRequestSchema, type ActionDescribeResult, type ActionExecuteResult } from '../src/shared/actions/schema'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import { agentPropertiesDefinition, agentPurgeRequest } from '../src/renderer/src/dialogs/agent-properties'
import { ObjectDialogService } from '../src/renderer/src/dialogs/ObjectDialogService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const agentRef: ObjectRef = { kind: 'agent' }
const base = { connectionId: '00000000-0000-4000-8000-0000000000aa', requestId: '00000000-0000-4000-8000-000000000001', action: 'agentProperties', target: agentRef } as const
const history: AgentHistoryFacts = {
  total: 900, recent: 700, jobsTruncated: false,
  jobs: [{ name: 'Log backup', rows: 600, recent: 672 }, { name: 'Nightly', rows: 290, recent: 28 }, { name: 'Quiet', rows: 10, recent: 0 }],
  ages: [{ days: 0, rows: 100 }, { days: 3, rows: 300 }, { days: 30, rows: 400 }, { days: 400, rows: 100 }]
}
const model = (changes: Partial<AgentPropertiesModel> = {}): AgentPropertiesModel => ({
  settings: { sqlserverRestart: true, monitorAutostart: true, historyMaxRows: 1000, historyMaxRowsPerJob: 100, autoStart: true, startupAccount: 'NT Service\\SQLSERVERAGENT', errorLogFile: 'C:\\Logs\\SQLAGENT.OUT', errorLoggingLevel: 3 },
  serverNow: '2026-03-31T10:00:00', serverOffsetMinutes: 60, history, ...changes
})
const draft = (changes: Partial<AgentPropertiesDraft> = {}, from = model()): AgentPropertiesDraft => ({ ...initialAgentPropertiesDraft(from), ...changes })

describe('the agentProperties request', () => {
  it('takes the changes or the purge on the Agent node, never both, never empty, and bounded', () => {
    const parse = (extra: object) => actionExecuteRequestSchema.safeParse({ ...base, ...extra }).success
    expect(parse({ agentProperties: { historyMaxRows: 5000, historyMaxRowsPerJob: 500 } })).toBe(true)
    expect(parse({ agentProperties: { historyMaxRows: -1 } })).toBe(true)
    expect(parse({ agentProperties: { sqlserverRestart: false } })).toBe(true)
    expect(parse({ agentPurge: { count: 4, unit: 2 } })).toBe(true)
    expect(parse({})).toBe(false)
    expect(parse({ agentProperties: {} })).toBe(false)
    expect(parse({ agentProperties: { sqlserverRestart: true }, agentPurge: { count: 1, unit: 1 } })).toBe(false)
    expect(parse({ agentProperties: { historyMaxRows: 0 } })).toBe(false)
    expect(parse({ agentProperties: { historyMaxRows: 1_000_000 } })).toBe(false)
    expect(parse({ agentProperties: { historyMaxRows: -1, historyMaxRowsPerJob: 10 } })).toBe(false)
    expect(parse({ agentProperties: { historyMaxRows: 100, historyMaxRowsPerJob: 101 } })).toBe(false)
    expect(parse({ agentProperties: { historyMaxRows: 100, other: 1 } })).toBe(false)
    expect(parse({ agentProperties: { historyMaxRowsPerJob: 10 } })).toBe(false)
    expect(parse({ agentPurge: { count: 0, unit: 1 } })).toBe(false)
    expect(parse({ agentPurge: { count: 1000, unit: 3 } })).toBe(false)
    expect(parse({ agentPurge: { count: 1, unit: 4 } })).toBe(false)
    expect(parse({ agentPurge: { count: 4, unit: 2, before: '2026-03-03T10:00:00' } })).toBe(true)
    expect(parse({ agentPurge: { count: 4, unit: 2, before: '2026-02-30T10:00:00' } })).toBe(false)
    expect(parse({ agentPurge: { count: 4, unit: 2, before: '2026-03-03 10:00:00' } })).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...base, target: { kind: 'agent', name: 'x' }, agentPurge: { count: 1, unit: 1 } }).success).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...base, target: { kind: 'agentJob', name: 'x' }, agentPurge: { count: 1, unit: 1 } }).success).toBe(false)
    // Another action never carries them.
    expect(actionExecuteRequestSchema.safeParse({ ...base, action: 'restartAgent', agentPurge: { count: 1, unit: 1 } }).success).toBe(false)
    expect(actionScriptRequestSchema.safeParse({ ...base, agentProperties: { monitorAutostart: false } }).success).toBe(true)
    expect(actionDescribeSchema.safeParse({ connectionId: base.connectionId, requestId: base.requestId, dialog: 'agentProperties', target: agentRef }).success).toBe(true)
    expect(agentPropertiesProblems({ target: agentRef, agentProperties: { historyMaxRows: 10, historyMaxRowsPerJob: 11 } })).not.toEqual([])
  })
})

describe('the draft', () => {
  it('starts from the settings, with SSMS\'s 1,000 and 100 when the log has no limit', () => {
    expect(draft()).toMatchObject({ limit: true, maxRows: '1000', maxRowsPerJob: '100', purgeCount: '4', purgeUnit: 2, purgeConfirming: false })
    const unlimited = model({ settings: { ...model().settings, historyMaxRows: -1, historyMaxRowsPerJob: 0 } })
    expect(draft({}, unlimited)).toMatchObject({ limit: false, maxRows: '1000', maxRowsPerJob: '100' })
    expect(agentPropertiesChanges(unlimited, draft({}, unlimited))).toBeUndefined()
  })
  it('sends only what changed, the two sizes together, and -1 alone for no limit', () => {
    expect(agentPropertiesChanges(model(), draft())).toBeUndefined()
    expect(agentPropertiesChanges(model(), draft({ monitorAutostart: false }))).toEqual({ monitorAutostart: false })
    expect(agentPropertiesChanges(model(), draft({ maxRowsPerJob: '200' }))).toEqual({ historyMaxRows: 1000, historyMaxRowsPerJob: 200 })
    expect(agentPropertiesChanges(model(), draft({ limit: false }))).toEqual({ historyMaxRows: -1 })
  })
  it('neither checks nor sends history sizes the user did not touch, however msdb stores them', () => {
    // A log set above the dialog's cap through T-SQL: a restart box still saves alone, and OK is not blocked.
    const huge = model({ settings: { ...model().settings, historyMaxRows: 2_000_000, historyMaxRowsPerJob: 100 } })
    expect(sizesTouched(huge, draft({}, huge))).toBe(false)
    expect(agentPropertiesChanges(huge, draft({ sqlserverRestart: false }, huge))).toEqual({ sqlserverRestart: false })
    expect(agentPropertiesDefinition.blocked!(huge, draft({}, huge))).toBeUndefined()
    expect(agentPropertiesDefinition.blocked!(huge, draft({ maxRows: '2000001' }, huge))).toBe(agentPropertiesText.maxRowsRange)
    // A limited log with no rows per job (NULL, read as 0) drafts 100 but sends nothing until the user changes it.
    const noPerJob = model({ settings: { ...model().settings, historyMaxRowsPerJob: 0 } })
    expect(agentPropertiesChanges(noPerJob, draft({ monitorAutostart: false }, noPerJob))).toEqual({ monitorAutostart: false })
  })
  it('says why sizes or a purge count cannot be sent', () => {
    expect(draftLimits(draft({ maxRows: '1' }))).toEqual({ problem: agentPropertiesText.maxRowsRange })
    expect(draftLimits(draft({ maxRows: '1000000' }))).toEqual({ problem: agentPropertiesText.maxRowsRange })
    expect(draftLimits(draft({ maxRows: 'ten' }))).toEqual({ problem: agentPropertiesText.maxRowsRange })
    expect(draftLimits(draft({ maxRows: '50', maxRowsPerJob: '100' }))).toEqual({ problem: agentPropertiesText.perJobTooMany(50) })
    expect(draftLimits(draft({ limit: false, maxRows: 'x' }))).toEqual({ maxRows: -1 })
    expect(draftPurge(draft({ purgeCount: '0' }))).toEqual({ problem: agentPropertiesText.purgeRange })
    expect(draftPurge(draft({ purgeCount: '1000' }))).toEqual({ problem: agentPropertiesText.purgeRange })
    expect(draftPurge(draft({ purgeCount: '3', purgeUnit: 3 }))).toEqual({ count: 3, unit: 3 })
  })
})

describe('the server clock', () => {
  it('computes the cut-off as DATEADD does, a month back from the 31st on the month\'s last day', () => {
    expect(purgeCutoff('2026-03-31T10:00:00', { count: 1, unit: 3 })).toBe('2026-02-28 10:00:00')
    expect(purgeCutoff('2026-03-31T10:00:00', { count: 4, unit: 2 })).toBe('2026-03-03 10:00:00')
    expect(purgeCutoff('2026-03-01T00:00:05', { count: 1, unit: 1 })).toBe('2026-02-28 00:00:05')
    expect(purgeCutoff('2024-03-31T10:00:00', { count: 13, unit: 3 })).toBe('2023-02-28 10:00:00')
    expect(purgeCutoff('nonsense', { count: 1, unit: 1 })).toBeUndefined()
    expect(serverTimeDiffers(60, 60)).toBe(false)
    expect(serverTimeDiffers(60, -300)).toBe(true)
  })
  it('advances the server clock by the time the dialog has been open', () => {
    expect(serverClock({ serverNow: '2026-03-31T23:59:30', readAt: 1_000 }, 1_000 + 8 * 3_600_000 + 999)).toBe('2026-04-01T07:59:30')
    expect(serverClock({ serverNow: '2026-03-31T10:00:00' }, 5_000)).toBe('2026-03-31T10:00:00')
    expect(serverClock({ serverNow: '2026-03-31T10:00:00', readAt: 5_000 }, 4_000)).toBe('2026-03-31T10:00:00')
  })
  it('estimates the rows a purge deletes from the ages, and nothing past the ages it counts', () => {
    expect(purgeRowsEstimate(model(), { count: 1, unit: 1 })).toBe(800)
    expect(purgeRowsEstimate(model(), { count: 4, unit: 2 })).toBe(500)
    expect(purgeRowsEstimate(model(), { count: 999, unit: 3 })).toBeUndefined()
    expect(purgeRowsEstimate(model({ history: undefined }), { count: 1, unit: 1 })).toBeUndefined()
  })
})

describe('what this keeps', () => {
  it('words rates and spans', () => {
    expect(rateText(672)).toBe('96 a day')
    expect(rateText(5)).toBe('5 a week')
    expect(rateText(0)).toBe(agentPropertiesText.noRuns)
    expect(spanText(0.5)).toBe('about 12 hours')
    expect(spanText(2.4)).toBe('about 2½ days')
    expect(spanText(1)).toBe('about 1 day')
    expect(spanText(70)).toBe('about 10 weeks')
    expect(spanText(400)).toBe('about 13 months')
  })
  it('keeps each job for rows per job over its rate, or the log\'s size over every job\'s rate where that is less', () => {
    const [busy, nightly, quiet] = history.jobs
    // Nightly writes 4 a day: 100 rows per job last 25 days, but the log's 1,000 rows at every job's 100 a day last 10.
    expect(keptFor(nightly!, history, { maxRows: 1000, maxRowsPerJob: 100 })).toEqual({ text: "about 10 days (the log's size)", server: true })
    expect(keptFor(nightly!, history, { maxRows: 5000, maxRowsPerJob: 100 })).toEqual({ text: 'about 4 weeks', server: false })
    expect(keptFor(busy!, history, { maxRows: 1000, maxRowsPerJob: 100 })).toEqual({ text: 'about 1 day', server: false })
    expect(keptFor(busy!, history, { maxRows: 1000, maxRowsPerJob: 1000 })).toEqual({ text: 'about 10 days (the log\'s size)', server: true })
    expect(keptFor(quiet!, history, { maxRows: 1000, maxRowsPerJob: 100 })).toEqual({ text: '—', server: false })
    expect(keptFor(busy!, history, { maxRows: -1 })).toEqual({ text: 'everything (no limit)', server: false })
  })
})

describe('the dialog definition', () => {
  it('builds nothing when nothing changed or the login may only look, and the problem for a bad size', () => {
    expect(agentPropertiesDefinition.request(agentRef, model(), draft())).toBeUndefined()
    expect(agentPropertiesDefinition.request(agentRef, model(), draft({ sqlserverRestart: false }))).toEqual({ action: 'agentProperties', target: agentRef, agentProperties: { sqlserverRestart: false } })
    expect(agentPropertiesDefinition.request(agentRef, model({ readOnly: agentPropertiesText.notSysadmin }), draft({ sqlserverRestart: false }))).toBeUndefined()
    expect(agentPropertiesDefinition.blocked!(model(), draft({ maxRows: '1' }))).toBe(agentPropertiesText.maxRowsRange)
    expect(agentPropertiesDefinition.blocked!(model({ readOnly: 'x' }), draft({ maxRows: '1' }))).toBeUndefined()
    expect(agentPropertiesDefinition.readOnly!(model({ readOnly: agentPropertiesText.managedInstance }))).toBe(agentPropertiesText.managedInstance)
    // The purge carries the cut-off its confirmation showed, which the server never deletes past.
    expect(agentPurgeRequest(agentRef, draft({ purgeCount: '6', purgeUnit: 3 }), '2026-03-31T10:00:00')).toEqual({ action: 'agentProperties', target: agentRef, agentPurge: { count: 6, unit: 3, before: '2025-09-30T10:00:00' } })
    expect(agentPurgeRequest(agentRef, draft({ purgeCount: '' }), '2026-03-31T10:00:00')).toBeUndefined()
  })
  it('on Linux keeps the settings as they are (mssql-conf sets them) and still allows Delete old history', () => {
    const linux = model({ settingsNote: agentPropertiesText.linux })
    expect(agentPropertiesDefinition.request(agentRef, linux, draft({ sqlserverRestart: false }, linux))).toBeUndefined()
    expect(agentPropertiesDefinition.blocked!(linux, draft({ maxRows: '1' }, linux))).toBeUndefined()
    expect(agentPropertiesDefinition.readOnly!(linux)).toBeUndefined()
    expect(agentPurgeRequest(agentRef, draft({}, linux), '2026-03-31T10:00:00')).toMatchObject({ agentPurge: { count: 4, unit: 2 } })
  })
  it('shows Kept after OK only for sizes OK will send', () => {
    // msdb stores a log of 1,000 rows with no rows per job: the draft offers 100 per job, which OK never sends untouched.
    const odd = model({ settings: { ...model().settings, historyMaxRowsPerJob: 0 } })
    expect(retentionLimits(odd, draft({}, odd))).toEqual({ now: { maxRows: 1000, maxRowsPerJob: undefined } })
    expect(retentionLimits(odd, draft({ maxRowsPerJob: '50' }, odd)).after).toEqual({ maxRows: 1000, maxRowsPerJob: 50 })
    expect(retentionLimits(model(), draft({ maxRows: '1' })).after).toBeUndefined()
  })
})

describe('SQL Server Agent Properties in ObjectDialogService', () => {
  const node: ExplorerMenuNode = { id: 4, connectionId: 'server-a', ref: { type: 'object', object: agentRef }, kind: 'agent', label: 'SQL Server Agent', lost: false }
  function setup(described: AgentPropertiesModel) {
    const api = {
      describeObject: vi.fn<VariaApi['describeObject']>(async () => ({ ok: true, value: { agentProperties: described, elapsedMs: 1 } as ActionDescribeResult })),
      scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(),
      executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(),
      cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async ids => ({ ok: true, value: { cancelled: ids.length } })),
      writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(), confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(), confirmAction: vi.fn<VariaApi['confirmAction']>()
    }
    const connections = new ConnectionService()
    connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
    let ids = 0
    const dialogs = new ObjectDialogService({
      api, connections, explorer: { listingFolderOf: vi.fn(() => undefined), reconcile: vi.fn() }, documents: { newQuery: vi.fn() }, files: { saveCopy: vi.fn() },
      notify: vi.fn(), databaseState: vi.fn(), newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
    } as never)
    cleanups.push(() => dialogs.dispose())
    return { dialogs, api, settle: () => new Promise(resolve => setImmediate(resolve)) }
  }
  it('runs Delete old history apart from OK, keeps the dialog and its unsaved draft open, and reads the history again', async () => {
    const { dialogs, api, settle } = setup(model())
    dialogs.open('agentProperties', node)
    await settle()
    dialogs.updateDraft({ maxRowsPerJob: '250' })
    const execute = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(execute.promise)
    const run = dialogs.runInline(agentPurgeRequest(agentRef, dialogs.current!.draft as AgentPropertiesDraft, '2026-03-31T10:00:00')!)
    expect(dialogs.current?.phase).toBe('executing')
    expect(api.executeObjectAction.mock.calls[0]![0]).toMatchObject({ action: 'agentProperties', target: agentRef, agentPurge: { count: 4, unit: 2 }, connectionId: 'server-a' })
    execute.resolve({ ok: true, value: { steps: [{ status: 'done', title: 'Delete old job history' }], messages: ['120 history entries purged.'], elapsedMs: 1 } })
    await run
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'ready', inline: { state: 'done', messages: ['120 history entries purged.'] }, draft: { maxRowsPerJob: '250' } })
    expect(api.describeObject).toHaveBeenCalledTimes(2)
    expect(api.executeObjectAction.mock.calls[0]![0]).toMatchObject({ agentPurge: { before: '2026-03-03T10:00:00' } })
  })
  it('keeps the dialog usable with the model it had when the read after a purge fails', async () => {
    const { dialogs, api, settle } = setup(model())
    dialogs.open('agentProperties', node)
    await settle()
    dialogs.updateDraft({ monitorAutostart: false })
    api.describeObject.mockResolvedValueOnce({ ok: false, code: 'TIMEOUT', error: 'Timed out.' } as never)
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Delete old job history' }], messages: [], elapsedMs: 1 } })
    await dialogs.runInline(agentPurgeRequest(agentRef, dialogs.current!.draft as AgentPropertiesDraft, '2026-03-31T10:00:00')!)
    await settle()
    expect(dialogs.current).toMatchObject({ phase: 'ready', inline: { state: 'done' }, draft: { monitorAutostart: false }, model: { serverNow: '2026-03-31T10:00:00' } })
    expect(dialogs.current?.error).toBeUndefined()
  })
  it('keeps the model read after a purge when OK, pressed during that read, fails', async () => {
    const { dialogs, api, settle } = setup(model())
    dialogs.open('agentProperties', node)
    await settle()
    const reread = deferred<ApiResult<ActionDescribeResult>>()
    api.describeObject.mockReturnValueOnce(reread.promise)
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Delete old job history' }], messages: [], elapsedMs: 1 } })
    await dialogs.runInline(agentPurgeRequest(agentRef, dialogs.current!.draft as AgentPropertiesDraft, '2026-03-31T10:00:00')!)
    dialogs.updateDraft({ monitorAutostart: false })
    const ok = deferred<ApiResult<ActionExecuteResult>>()
    api.executeObjectAction.mockReturnValueOnce(ok.promise)
    const pressed = dialogs.ok()
    reread.resolve({ ok: true, value: { agentProperties: model({ serverNow: '2026-03-31T11:00:00' }), elapsedMs: 1 } as ActionDescribeResult })
    await settle()
    ok.resolve({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: 'Failed.', retryable: false } } })
    await pressed
    expect(dialogs.current).toMatchObject({ phase: 'failed', model: { serverNow: '2026-03-31T11:00:00' } })
  })
  it('cancels the read after a purge when OK, pressed during it, closes the dialog', async () => {
    const { dialogs, api, settle } = setup(model())
    dialogs.open('agentProperties', node)
    await settle()
    const reread = deferred<ApiResult<ActionDescribeResult>>()
    api.describeObject.mockReturnValueOnce(reread.promise)
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Delete old job history' }], messages: [], elapsedMs: 1 } })
    await dialogs.runInline(agentPurgeRequest(agentRef, dialogs.current!.draft as AgentPropertiesDraft, '2026-03-31T10:00:00')!)
    const rereadId = api.describeObject.mock.calls[1]![0].requestId
    dialogs.updateDraft({ monitorAutostart: false })
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [{ status: 'done', title: 'Save SQL Server Agent properties' }], messages: [], elapsedMs: 1 } })
    await dialogs.ok()
    expect(dialogs.current).toBeUndefined()
    expect(api.cancelObjectActions.mock.calls.flatMap(call => call[0])).toContain(rereadId)
    reread.resolve({ ok: true, value: { agentProperties: model(), elapsedMs: 1 } as ActionDescribeResult })
    await settle()
    expect(dialogs.current).toBeUndefined()
  })
  it("keeps the latest read when two purges' reads land out of order", async () => {
    const { dialogs, api, settle } = setup(model())
    dialogs.open('agentProperties', node)
    await settle()
    const first = deferred<ApiResult<ActionDescribeResult>>(), second = deferred<ApiResult<ActionDescribeResult>>()
    api.describeObject.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const purged = { ok: true, value: { steps: [{ status: 'done', title: 'Delete old job history' }], messages: [], elapsedMs: 1 } } as const
    api.executeObjectAction.mockResolvedValueOnce(purged).mockResolvedValueOnce(purged)
    await dialogs.runInline(agentPurgeRequest(agentRef, dialogs.current!.draft as AgentPropertiesDraft, '2026-03-31T10:00:00')!)
    await dialogs.runInline(agentPurgeRequest(agentRef, dialogs.current!.draft as AgentPropertiesDraft, '2026-03-31T10:00:00')!)
    second.resolve({ ok: true, value: { agentProperties: model({ serverNow: '2026-03-31T10:02:00' }), elapsedMs: 1 } as ActionDescribeResult })
    await settle()
    first.resolve({ ok: true, value: { agentProperties: model({ serverNow: '2026-03-31T10:01:00' }), elapsedMs: 1 } as ActionDescribeResult })
    await settle()
    expect(dialogs.current?.model).toMatchObject({ serverNow: '2026-03-31T10:02:00' })
    expect(api.cancelObjectActions.mock.calls.flatMap(call => call[0])).toContain(api.describeObject.mock.calls[1]![0].requestId)
  })
  it('shows a failed purge as a value and stays open', async () => {
    const { dialogs, api, settle } = setup(model())
    dialogs.open('agentProperties', node)
    await settle()
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'Denied.', retryable: false } } })
    await dialogs.runInline(agentPurgeRequest(agentRef, dialogs.current!.draft as AgentPropertiesDraft, '2026-03-31T10:00:00')!)
    expect(dialogs.current).toMatchObject({ phase: 'ready', inline: { state: 'failed', error: { code: 'PERMISSION_DENIED' } } })
  })
  it('closes on OK when read-only and runs nothing, inline or not', async () => {
    const { dialogs, api, settle } = setup(model({ readOnly: agentPropertiesText.notSysadmin, history: undefined, historyNote: agentPropertiesText.historyHidden }))
    dialogs.open('agentProperties', node)
    await settle()
    await dialogs.runInline({ action: 'agentProperties', target: agentRef, agentPurge: { count: 1, unit: 1 } } as never)
    dialogs.updateDraft({ sqlserverRestart: false })
    await dialogs.ok()
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(dialogs.current).toBeUndefined()
  })
})
