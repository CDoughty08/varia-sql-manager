import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import { costPrompt, errorPosition, gibibytes, pricedBytes, type BigQueryDryRunResult } from '../src/shared/bigquery/dry-run'
import { methodAllows, optionsAllow } from '../src/shared/ipc/methods'
import { validateRequest, validateResult } from '../src/main/validation'
import { defaultSettings, type SettingKey, type SettingsValues } from '../src/shared/settings/catalog'
import { BigQueryCostService, dryRunDebounceMs, dryRunMarkerOwner, type CostPromptAnswer, type CostPromptRequest } from '../src/renderer/src/services/bigquery-cost'
import { CostPromptService, costPromptText } from '../src/renderer/src/services/bigquery-cost-prompt'
import { costChip } from '../src/renderer/src/BigQueryCostChip'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import { deferred, documentFixture } from './fixtures/documents'

const connectionId = '6f1e3c1a-8b8e-4c5e-9a43-1d2b3c4d5e6f'
const GiB = 2 ** 30

describe('bigquery.dryRun contract', () => {
  it('is BigQuery-only, bounded in zod, and checks its answer', () => {
    expect(methodAllows('bigquery.dryRun', 'bigquery')).toBe(true)
    expect(methodAllows('bigquery.dryRun', 'sqlserver')).toBe(false)
    expect(() => validateRequest('bigquery.dryRun', { connectionId, sql: 'SELECT 1', dataset: 'sales' })).not.toThrow()
    expect(() => validateRequest('bigquery.dryRun', { connectionId, sql: '' })).toThrow()
    expect(() => validateRequest('bigquery.dryRun', { connectionId, sql: 'x'.repeat(1_000_001) })).toThrow()
    expect(() => validateRequest('bigquery.dryRun', { connectionId, sql: 'SELECT 1', dataset: 'a-b' })).toThrow()
    expect(() => validateRequest('bigquery.dryRun', { connectionId, sql: 'SELECT 1', sessionId: connectionId })).toThrow()
    expect(validateResult('bigquery.dryRun', { bytesProcessed: 10, incomplete: 'script', statementType: 'SCRIPT' })).toMatchObject({ incomplete: 'script' })
    expect(() => validateResult('bigquery.dryRun', { bytesProcessed: -1 })).toThrow()
    expect(() => validateResult('bigquery.dryRun', { bytesProcessed: 1, incomplete: 'maybe' })).toThrow()
  })
  it("takes Options' cap and Bytes only for BigQuery runs only", () => {
    const base = { connectionId, sessionId: connectionId, sql: 'SELECT 1', queryId: connectionId, maxRows: 0, timeoutSeconds: 0 }
    expect(() => validateRequest('query.execute', { ...base, maximumBytesBilled: 10 * GiB, hidePrices: true })).not.toThrow()
    expect(() => validateRequest('query.execute', { ...base, maximumBytesBilled: 0 })).toThrow()
    expect(optionsAllow('query.execute', 'bigquery', { ...base, maximumBytesBilled: GiB, hidePrices: true })).toBe(true)
    expect(optionsAllow('query.execute', 'sqlserver', { ...base, database: 'master', maximumBytesBilled: GiB })).toBe(false)
    expect(optionsAllow('query.execute', 'sqlserver', { ...base, database: 'master', hidePrices: true })).toBe(false)
  })
})

describe('cost rules', () => {
  const rules = { askAboveThreshold: true, thresholdBytes: 10 * GiB, warnIncomplete: true }
  it('asks above the threshold, then for an incomplete estimate, and never for a faked one', () => {
    expect(costPrompt({ bytesProcessed: 10 * GiB }, rules)).toBeUndefined()
    expect(costPrompt({ bytesProcessed: 10 * GiB + 1 }, rules)).toEqual({ kind: 'threshold', bytes: 10 * GiB + 1 })
    expect(costPrompt({ bytesProcessed: 20 * GiB, incomplete: 'script' }, rules)).toMatchObject({ kind: 'threshold' })
    expect(costPrompt({ bytesProcessed: GiB, incomplete: 'zeroBytes' }, rules)).toEqual({ kind: 'incomplete', bytes: GiB, reason: 'zeroBytes' })
    expect(costPrompt({ bytesProcessed: 20 * GiB }, { ...rules, askAboveThreshold: false })).toBeUndefined()
    expect(costPrompt({ bytesProcessed: GiB, incomplete: 'script' }, { ...rules, warnIncomplete: false })).toBeUndefined()
    expect(costPrompt({ bytesProcessed: 0, faked: true, incomplete: 'unknown' }, rules)).toBeUndefined()
  })
  it("reads BigQuery's last [line:column] and writes figures with or without dollars", () => {
    expect(errorPosition('Unrecognized name: order_totl at [5:7]')).toEqual({ line: 5, column: 7 })
    expect(errorPosition('Query error: x at [2:1]; caused by y at [9:14]')).toEqual({ line: 9, column: 14 })
    expect(errorPosition('No position here')).toBeUndefined()
    expect(errorPosition('at [0:3]')).toBeUndefined()
    expect(pricedBytes(1_331_439_862, true)).toBe('1.24 GiB · < $0.01')
    expect(pricedBytes(1_331_439_862, false)).toBe('1.24 GiB')
    expect(gibibytes(0)).toBeUndefined()
    expect(gibibytes(10)).toBe(10 * GiB)
  })
  it("words both prompts with the figure, its price and the job's cap", () => {
    const threshold = costPromptText({ prompt: { kind: 'threshold', bytes: 1.41 * 2 ** 40 }, connection: 'acme-analytics', thresholdBytes: 10 * GiB, prices: true })
    expect(threshold.sentence).toBe('This query will process 1.41 TiB (about $8.81 on demand), more than the 10.00 GiB threshold. Run it?')
    expect(threshold.note).toContain('No maximum bytes billed is set')
    expect(threshold.optOut).toBe("Don't ask again for acme-analytics")
    const incomplete = costPromptText({ prompt: { kind: 'incomplete', bytes: 0, reason: 'zeroBytes' }, connection: 'x', thresholdBytes: GiB, cap: 500 * GiB, prices: false })
    expect(incomplete.sentence).toContain('may be low')
    expect(incomplete.sentence).toContain('external tables')
    expect(incomplete.sentence).not.toContain('$')
    expect(incomplete.note).toContain('500.00 GiB')
    expect(incomplete.optOut).toBe("Don't warn me about incomplete estimates again")
  })
  it('draws the chip neutral, amber above the threshold, and as ran after a run', () => {
    const values = { ...defaultSettings }
    expect(costChip({ phase: 'estimate', bytes: GiB }, values)).toMatchObject({ tone: 'neutral', label: '≈ 1.00 GiB · < $0.01' })
    expect(costChip({ phase: 'estimate', bytes: 11 * GiB }, values)).toMatchObject({ tone: 'warning' })
    expect(costChip({ phase: 'estimate', bytes: 11 * GiB }, { ...values, 'queryExecution.bigQuery.costPrompt': false }).tone).toBe('neutral')
    expect(costChip({ phase: 'ran', bytes: 2 ** 40 }, values)).toMatchObject({ tone: 'success', label: '1.00 TiB · $6.25 processed' })
    expect(costChip({ phase: 'ran', bytes: 2 ** 40 }, { ...values, 'queryExecution.bigQuery.showCost': 'bytes' }).label).toBe('1.00 TiB processed')
    expect(costChip({ phase: 'estimate', bytes: GiB, incomplete: 'script' }, values).title).toContain('first DDL or control statement')
    expect(costChip({ phase: 'estimate', bytes: 0, faked: true }, values).label).toBe('No estimate')
  })
})

function fixture(settings: Partial<SettingsValues> = {}) {
  const docs = documentFixture({ provider: () => 'bigquery' })
  const values: Record<string, unknown> = { ...defaultSettings, ...settings }
  const listeners = new Set<() => void>()
  const connection = { id: connectionId, generation: 1, server: 'acme-analytics', providerId: 'bigquery', targetId: 'target-1', options: { provider: 'bigquery', project: 'acme-analytics', authentication: 'gcloud' } } as unknown as LiveConnection
  let live = true
  const connections = { get: (id: string) => id === connectionId ? connection : undefined, isLive: (id: string) => live && id === connectionId, subscribe: () => () => {} }
  const replies: ApiResult<BigQueryDryRunResult>[] = []
  const pending: ReturnType<typeof deferred<ApiResult<BigQueryDryRunResult>>>[] = []
  const api = { bigQueryDryRun: vi.fn<VariaApi['bigQueryDryRun']>(async () => { if (replies.length) return replies.shift()!; const next = deferred<ApiResult<BigQueryDryRunResult>>(); pending.push(next); return next.promise }) }
  const markers = vi.fn()
  const timers: (() => void)[] = []
  let timerIds = 0
  const asked: CostPromptRequest[] = []
  let answer: CostPromptAnswer = { run: true }
  const declined = new Set<string>()
  const service = new BigQueryCostService({
    api, documents: docs.documents, connections, events: docs.events, monaco: { MarkerSeverity: { Error: 8 } as never, editor: { setModelMarkers: markers } },
    settings: { get: key => values[key] as never, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, choose: async (key: SettingKey, value: unknown) => { values[key] = value; listeners.forEach(listener => listener()) } },
    ask: async request => { asked.push(request); return answer },
    optOut: { asks: c => !declined.has(c.id), dontAsk: c => { declined.add(c.id) } },
    schedule: (callback, ms) => { expect(ms).toBe(dryRunDebounceMs); timers.push(callback); return ++timerIds as unknown as ReturnType<typeof setTimeout> }
  })
  const tab = docs.documents.create('daily.sql', 'SELECT 1', 'sales', connectionId)
  const model = docs.model(tab.id)
  const tick = () => { for (const timer of timers.splice(0)) timer() }
  const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })
  return { docs, service, api, markers, timers, tick, settle, tab, model, replies, pending, asked, values, declined, setAnswer: (value: CostPromptAnswer) => { answer = value }, setLive: (value: boolean) => { live = value } }
}
const estimate = (bytesProcessed: number, extra: Partial<BigQueryDryRunResult> = {}): ApiResult<BigQueryDryRunResult> => ({ ok: true, value: { bytesProcessed, ...extra } })

describe('dry-run diagnostics', () => {
  it('dry-runs only after an edit and a pause, then shows the estimate and clears markers', async () => {
    const f = fixture()
    // Opening or restoring a tab runs nothing (decision 44).
    expect(f.timers).toHaveLength(0)
    expect(f.api.bigQueryDryRun).not.toHaveBeenCalled()
    f.model.edit('SELECT * FROM orders')
    expect(f.api.bigQueryDryRun).not.toHaveBeenCalled()
    f.replies.push(estimate(GiB))
    f.tick()
    await f.settle()
    expect(f.api.bigQueryDryRun).toHaveBeenCalledWith({ connectionId, sql: 'SELECT * FROM orders', dataset: 'sales' })
    expect(f.service.getSnapshot().get(f.tab.id)).toEqual({ phase: 'estimate', bytes: GiB })
    expect(f.markers).toHaveBeenLastCalledWith(expect.anything(), dryRunMarkerOwner, [])
    expect(f.service.status(f.tab.id)?.label).toBe('BigQuery: no issues')
  })
  it("marks a refused query at BigQuery's [line:column], on the word there", async () => {
    const f = fixture()
    f.model.edit('SELECT\n  SUM(order_totl) AS revenue\nFROM orders')
    f.replies.push({ ok: false, code: 'SQL_ERROR', error: 'Unrecognized name: order_totl; Did you mean order_total? at [2:7]' } as ApiResult<BigQueryDryRunResult>)
    f.tick()
    await f.settle()
    const [, owner, list] = f.markers.mock.calls.at(-1)!
    expect(owner).toBe(dryRunMarkerOwner)
    expect(list).toEqual([expect.objectContaining({ startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 17, severity: 8, source: 'BigQuery dry run' })])
    expect(f.service.getSnapshot().get(f.tab.id)).toMatchObject({ phase: 'refused' })
    expect(f.service.status(f.tab.id)?.label).toBe('BigQuery: 1 error')
  })
  it('keeps one dry run in flight per document, and the latest text wins', async () => {
    const f = fixture()
    f.model.edit('SELECT 1 AS a')
    f.tick()
    await f.settle()
    f.model.edit('SELECT 2 AS b')
    f.tick()
    await f.settle()
    expect(f.api.bigQueryDryRun).toHaveBeenCalledTimes(1)
    f.pending[0].resolve(estimate(5))
    await f.settle()
    // The first answer is for older text: dropped, and the newer text is dry-run next.
    expect(f.service.getSnapshot().get(f.tab.id)).toEqual({ phase: 'checking' })
    expect(f.api.bigQueryDryRun).toHaveBeenCalledTimes(2)
    expect(f.api.bigQueryDryRun.mock.calls[1][0].sql).toBe('SELECT 2 AS b')
    f.pending[1].resolve(estimate(7))
    await f.settle()
    expect(f.service.getSnapshot().get(f.tab.id)).toEqual({ phase: 'estimate', bytes: 7 })
  })
  it('sends nothing while the setting is off or the tab is not connected', async () => {
    const off = fixture({ 'textEditor.googleSql.dryRunDiagnostics': false })
    off.model.edit('SELECT 3')
    expect(off.timers).toHaveLength(0)
    const lost = fixture()
    lost.setLive(false)
    lost.docs.documents.update(lost.tab.id, { database: 'other' })
    lost.model.edit('SELECT 4')
    lost.tick()
    await lost.settle()
    expect(off.api.bigQueryDryRun).not.toHaveBeenCalled()
    expect(lost.api.bigQueryDryRun).not.toHaveBeenCalled()
  })
  it('clears the estimate and markers when the dataset changes, without dry-running', async () => {
    const f = fixture()
    f.model.edit('SELECT 5')
    f.replies.push(estimate(GiB))
    f.tick()
    await f.settle()
    f.docs.documents.update(f.tab.id, { database: 'archive' })
    expect(f.service.getSnapshot().get(f.tab.id)).toBeUndefined()
    expect(f.api.bigQueryDryRun).toHaveBeenCalledTimes(1)
  })
})

describe('the estimate before Execute', () => {
  it('reuses the diagnostics estimate for the same text, and runs without asking under the threshold', async () => {
    const f = fixture()
    f.model.edit('SELECT 6')
    f.replies.push(estimate(GiB))
    f.tick()
    await f.settle()
    await expect(f.service.beforeExecute(f.tab.id, 'SELECT 6')).resolves.toBe(true)
    expect(f.api.bigQueryDryRun).toHaveBeenCalledTimes(1)
    expect(f.asked).toHaveLength(0)
  })
  it('dry-runs first when there is no estimate, dropping a pending diagnostics run, and asks above the threshold', async () => {
    const f = fixture()
    f.model.edit('SELECT * FROM events')
    expect(f.timers).toHaveLength(1)
    f.replies.push(estimate(1.41 * 2 ** 40))
    f.setAnswer({ run: false })
    await expect(f.service.beforeExecute(f.tab.id, 'SELECT * FROM events')).resolves.toBe(false)
    expect(f.asked).toEqual([expect.objectContaining({ prompt: { kind: 'threshold', bytes: 1.41 * 2 ** 40 }, connection: 'acme-analytics', thresholdBytes: 10 * GiB, prices: true })])
    f.tick()
    await f.settle()
    expect(f.api.bigQueryDryRun).toHaveBeenCalledTimes(1)
  })
  it("never asks again for a connection the user opted out of", async () => {
    const f = fixture()
    f.replies.push(estimate(20 * GiB), estimate(20 * GiB))
    f.setAnswer({ run: true, dontAskAgain: true })
    await expect(f.service.beforeExecute(f.tab.id, 'SELECT big')).resolves.toBe(true)
    expect(f.declined.has(connectionId)).toBe(true)
    await expect(f.service.beforeExecute(f.tab.id, 'SELECT big2')).resolves.toBe(true)
    expect(f.asked).toHaveLength(1)
  })
  it('warns about an incomplete estimate once per tab, and the global opt-out turns it off', async () => {
    const f = fixture()
    f.replies.push(estimate(GiB, { incomplete: 'script' }), estimate(GiB, { incomplete: 'script' }))
    await f.service.beforeExecute(f.tab.id, 'DECLARE x INT64; SELECT x')
    await f.service.beforeExecute(f.tab.id, 'DECLARE y INT64; SELECT y')
    expect(f.asked.map(request => request.prompt.kind)).toEqual(['incomplete'])
    const g = fixture()
    g.replies.push(estimate(GiB, { incomplete: 'lowerBound' }))
    g.setAnswer({ run: true, dontAskAgain: true })
    await g.service.beforeExecute(g.tab.id, 'SELECT * FROM ext')
    expect(g.values['queryExecution.bigQuery.incompleteEstimateWarning']).toBe(false)
  })
  it('runs when the dry run fails: the cap is the hard guard, and the run reports the error', async () => {
    const f = fixture()
    f.replies.push({ ok: false, code: 'CONNECTION_LOST', error: 'Varia could not reach Google Cloud.' } as ApiResult<BigQueryDryRunResult>)
    await expect(f.service.beforeExecute(f.tab.id, 'SELECT 7')).resolves.toBe(true)
    expect(f.service.getSnapshot().get(f.tab.id)).toMatchObject({ phase: 'unavailable' })
  })
  it("names the job's cap: the connection's, else Options'", () => {
    const f = fixture({ 'queryExecution.bigQuery.maximumBytesBilled': 50 })
    const connection = { options: { provider: 'bigquery' } } as unknown as LiveConnection
    expect(f.service.cap(connection)).toBe(50 * GiB)
    expect(f.service.cap({ options: { provider: 'bigquery', maximumBytesBilled: 1000 } } as unknown as LiveConnection)).toBe(1000)
  })
  it('shows what a finished run processed', async () => {
    const f = fixture()
    f.docs.events.emit({ type: 'query.finished', tabId: f.tab.id, queryId: 'q', summary: { job: { project: 'p', jobId: 'j', bytesProcessed: 42 } } as never })
    expect(f.service.getSnapshot().get(f.tab.id)).toEqual({ phase: 'ran', bytes: 42 })
  })
})

describe('the cost prompt', () => {
  it('answers one prompt at a time; a newer one cancels the older', async () => {
    const prompts = new CostPromptService()
    const request = { prompt: { kind: 'threshold', bytes: 1 }, connection: 'c', thresholdBytes: 0, prices: true } as const
    const first = prompts.ask(request), second = prompts.ask(request)
    await expect(first).resolves.toEqual({ run: false })
    prompts.answer({ run: true })
    await expect(second).resolves.toEqual({ run: true })
    expect(prompts.getSnapshot().pending).toBeUndefined()
  })
})
