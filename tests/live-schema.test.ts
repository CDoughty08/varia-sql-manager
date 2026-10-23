import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { encodeControl } from '../src/shared/ipc/wire/msgpack'
import { limits } from '../src/shared/ipc/wire/protocol'
import { portRequestSchema, testPortRequestSchema } from '../src/shared/ipc/port-messages'
import { liveProbeIds, liveProbes, liveSourceIds, liveSources, type LiveProbeSpec, type LiveSourceSpec } from '../src/shared/live/catalog'
import {
  buildLiveSchemas, liveEndSchema, liveErrorCodes, liveEventFits, liveEventSchema, liveRetired, liveStartSchema, liveUpdateResultSchema, stampLive, testLiveSubscribeParamsSchema,
  testLiveUpdateParamsSchema, type BackendLiveEvent, type LiveSubscribeParams
} from '../src/shared/live/schema'

const L = limits.live
const uuid = () => crypto.randomUUID()
const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success
const subscribe = (patch: Record<string, unknown> = {}): LiveSubscribeParams & Record<string, unknown> => ({
  subscriptionId: uuid(), connectionId: uuid(), source: 'debug.synthetic', probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000 }], ...patch
}) as LiveSubscribeParams & Record<string, unknown>
const descriptor = (columns: readonly string[], resultId = 1) => ({
  resultId, index: 0, batchNumber: 1, iteration: 1, kind: 'rows', columns: columns.map(name => ({ name, dataType: 'int', wire: 'text', nullable: false })),
  rowsRead: 1, rowsStored: 1, rowsAvailable: 1, bytesStored: 1, truncatedCells: 0, state: 'complete', incomplete: false
})
const rows = ['id', 'label', 'value']
const opened = { type: 'live.opened', seq: 0, source: 'debug.synthetic', probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000, minIntervalMs: 1000, maxIntervalMs: 3_600_000, state: 'ok' }] }
const sample = (patch: Record<string, unknown> = {}) => ({ probe: 'debug.synthetic.table', costMs: 0, effectiveIntervalMs: 1000, ...patch })
const tick = (samples: unknown[], patch: Record<string, unknown> = {}) => ({ type: 'live.tick', seq: 1, sampledAt: 1, samples, ...patch })

/** Shapes the shipped catalogue does not have yet: two sources, and a probe with every kind of output. */
const column = (id: string) => ({ id, name: id, dataType: 'int' })
const fixtureProbes: Record<string, LiveProbeSpec> = {
  'one.all': {
    id: 'one.all', source: 'one', label: 'All', description: 'All', intervalMs: { default: 1000, min: 1000, max: 60_000 }, views: ['blocked'], filterMode: 'memory',
    series: [{ id: 'a', unit: 'count', label: 'A', counter: 'gauge' }],
    tables: [
      { id: 's0', mode: 'snapshot', key: ['k0'], departed: true, facets: ['v0'], columns: [column('k0'), column('v0')] }, { id: 's1', mode: 'snapshot', key: [], columns: [column('k1')] },
      { id: 's2', mode: 'snapshot', key: ['k2'], columns: [column('k2')] }, { id: 's3', mode: 'snapshot', key: ['k3'], columns: [column('k3')] },
      { id: 'a0', mode: 'append', key: ['m0'], columns: [column('m0')] }, { id: 'a1', mode: 'append', key: ['m1'], columns: [column('m1')] },
      { id: 'a2', mode: 'append', key: ['m2'], columns: [column('m2')] }, { id: 'a3', mode: 'append', key: ['m3'], columns: [column('m3')] }
    ],
    status: ['state']
  },
  'one.plain': { id: 'one.plain', source: 'one', label: 'Plain', description: 'Plain', intervalMs: { default: 1000, min: 1000, max: 60_000 }, tables: [{ id: 't', mode: 'snapshot', key: ['x'], columns: [column('x')] }] },
  'two.only': { id: 'two.only', source: 'two', label: 'Two', description: 'Two', intervalMs: { default: 1000, min: 1000, max: 60_000 }, series: [{ id: 'b', unit: 'count', label: 'B', counter: 'rate' }] },
  'two.rows': { id: 'two.rows', source: 'two', label: 'Rows', description: 'Rows', intervalMs: { default: 1000, min: 1000, max: 60_000 }, tables: [{ id: 't', mode: 'snapshot', key: ['y'], columns: [column('y')] }] }
}
const fixtureSources: Record<string, LiveSourceSpec> = {
  one: { id: 'one', label: 'One', description: 'One', scope: 'server', testOnly: false, probes: ['one.all', 'one.plain'] },
  two: { id: 'two', label: 'Two', description: 'Two', scope: 'server', testOnly: true, probes: ['two.only', 'two.rows'] }
}
const fixture = buildLiveSchemas({ sources: fixtureSources, probes: fixtureProbes, args: { one: z.object({ id: z.number().int().min(1).max(10) }).strict() } }, { test: false })
const fixtureTest = buildLiveSchemas({ sources: fixtureSources, probes: fixtureProbes, args: {} }, { test: true })

describe('live request schemas', () => {
  it('refuses test-only sources on the production port and accepts them on the test port', () => {
    const request = { t: 'live', rid: 1, generation: 1, params: subscribe() }
    expect(ok(portRequestSchema, request)).toBe(false)
    expect(ok(testPortRequestSchema, request)).toBe(true)
    const update = { t: 'liveUpdate', rid: 2, generation: 1, params: { subscriptionId: uuid(), source: 'debug.synthetic', paused: true } }
    expect(ok(portRequestSchema, update)).toBe(false)
    expect(ok(testPortRequestSchema, update)).toBe(true)
    expect(ok(fixture.subscribe, { ...subscribe(), source: 'two', probes: [{ probe: 'two.only', intervalMs: 1000 }] })).toBe(false)
    expect(ok(fixtureTest.subscribe, { ...subscribe(), source: 'two', probes: [{ probe: 'two.only', intervalMs: 1000 }] })).toBe(true)
  })
  it('accepts the Activity Monitor source on the production port, with no args', () => {
    const activity = (patch: Record<string, unknown> = {}) => ({ t: 'live', rid: 1, generation: 1, params: subscribe({ source: 'activity', probes: [{ probe: 'activity.overview', intervalMs: 2000 }], ...patch }) })
    expect(ok(portRequestSchema, activity())).toBe(true)
    expect(ok(portRequestSchema, activity({ args: {} }))).toBe(false)
    expect(ok(portRequestSchema, activity({ probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000 }] }))).toBe(false)
    expect(ok(portRequestSchema, { t: 'liveUpdate', rid: 2, generation: 1, params: { subscriptionId: uuid(), source: 'activity', probes: [{ probe: 'activity.overview', intervalMs: 5000 }], refresh: true } })).toBe(true)
    expect(ok(portRequestSchema, { t: 'liveUpdate', rid: 2, generation: 1, params: { subscriptionId: uuid(), source: 'activity', args: { rows: 1 } } })).toBe(false)
  })
  it('is strict and bounded at every level', () => {
    const schema = testLiveSubscribeParamsSchema
    expect(ok(schema, subscribe())).toBe(true)
    expect(ok(schema, subscribe({ probes: liveSources['debug.synthetic'].probes.map(probe => ({ probe, intervalMs: 3_600_000, paused: true })), args: { rows: 10_000, tickMs: 10, endAfterTicks: 10_000, errorEvery: 1000 } }))).toBe(true)
    for (const [name, patch] of Object.entries({
      unknown: { extra: 1 },
      subscription: { subscriptionId: 'x' },
      connection: { connectionId: 'x'.repeat(36) },
      noProbes: { probes: [] },
      nine: { probes: Array.from({ length: 9 }, () => ({ probe: 'debug.synthetic.table', intervalMs: 1000 })) },
      duplicate: { probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000 }, { probe: 'debug.synthetic.table', intervalMs: 2000 }] },
      fast: { probes: [{ probe: 'debug.synthetic.table', intervalMs: 999 }] },
      slow: { probes: [{ probe: 'debug.synthetic.table', intervalMs: 3_600_001 }] },
      noInterval: { probes: [{ probe: 'debug.synthetic.table' }] },
      probeMember: { probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000, extra: true }] },
      unknownProbe: { probes: [{ probe: 'activity.overview', intervalMs: 1000 }] },
      argsMember: { args: { rows: 1, other: 1 } },
      argsBound: { args: { rows: 10_001 } },
      argsType: { args: 'rows' },
      resumeCharacters: { resume: 'a=b' },
      resumeLength: { resume: 'a'.repeat(257) },
      resumeEmpty: { resume: '' }
    })) expect(ok(schema, subscribe(patch)), name).toBe(false)
    expect(ok(schema, subscribe({ resume: 'a'.repeat(256) }))).toBe(true)
  })
  it('allows sort, views and filters only where the probe declares them', () => {
    const settings = (probe: Record<string, unknown>) => ({ ...subscribe(), source: 'one', probes: [{ probe: 'one.all', intervalMs: 1000, ...probe }] })
    expect(ok(fixture.subscribe, settings({ sort: [{ column: 'v0', descending: true }, { column: 'k1', descending: false }], view: 'blocked', filter: { text: 'x', columns: ['m0', 'k0'] } }))).toBe(true)
    for (const [name, probe] of Object.entries({
      appendSort: { sort: [{ column: 'm0', descending: true }] },
      unknownSort: { sort: [{ column: 'nope', descending: true }] },
      repeatedSort: { sort: [{ column: 'k0', descending: true }, { column: 'k0', descending: false }] },
      fiveSorts: { sort: ['k0', 'v0', 'k1', 'k2', 'k3'].map(column => ({ column, descending: false })) },
      view: { view: 'other' },
      filterColumn: { filter: { text: 'x', columns: ['nope'] } },
      filterText: { filter: { text: 'x'.repeat(401) } },
      emptyFilter: { filter: { text: '' } }
    })) expect(ok(fixture.subscribe, settings(probe)), name).toBe(false)
    // A probe without a filter mode refuses filters; one from another source is refused, as is another source's args.
    expect(ok(fixture.subscribe, { ...subscribe(), source: 'one', probes: [{ probe: 'one.plain', intervalMs: 1000, filter: { text: 'x' } }] })).toBe(false)
    expect(ok(fixtureTest.subscribe, { ...subscribe(), source: 'one', probes: [{ probe: 'two.only', intervalMs: 1000 }] })).toBe(false)
    expect(ok(fixture.subscribe, { ...subscribe(), source: 'one', probes: [{ probe: 'one.plain', intervalMs: 1000 }], args: { id: 3 } })).toBe(true)
    expect(ok(fixture.subscribe, { ...subscribe(), source: 'one', probes: [{ probe: 'one.plain', intervalMs: 1000 }], args: { id: 11 } })).toBe(false)
    expect(ok(fixtureTest.subscribe, { ...subscribe(), source: 'two', probes: [{ probe: 'two.only', intervalMs: 1000 }], args: {} })).toBe(false)
  })
  it('checks updates against the same rules, and tracking against keyed snapshot tables', () => {
    const update = (patch: Record<string, unknown>) => ({ subscriptionId: uuid(), source: 'debug.synthetic', ...patch })
    const schema = testLiveUpdateParamsSchema
    expect(ok(schema, update({ paused: false }))).toBe(true)
    expect(ok(schema, update({ probes: [{ probe: 'debug.synthetic.table', paused: true, sort: [{ column: 'value', descending: true }] }], refresh: true, args: { tickMs: 50 } }))).toBe(true)
    expect(ok(schema, update({ track: [{ probe: 'debug.synthetic.table', table: 0, seq: 1, keys: Array.from({ length: 64 }, () => 'k'.repeat(512)) }] }))).toBe(true)
    for (const [name, patch] of Object.entries({
      nothing: {},
      refreshFalse: { refresh: false },
      unknown: { paused: true, extra: 1 },
      metricsSort: { probes: [{ probe: 'debug.synthetic.metrics', sort: [{ column: 'id', descending: true }] }] },
      emptyProbes: { probes: [] },
      trackMetrics: { track: [{ probe: 'debug.synthetic.metrics', table: 0, seq: 1, keys: [] }] },
      trackMissingTable: { track: [{ probe: 'debug.synthetic.table', table: 1, seq: 1, keys: [] }] },
      trackTwice: { track: [{ probe: 'debug.synthetic.table', table: 0, seq: 1, keys: [] }, { probe: 'debug.synthetic.table', table: 0, seq: 2, keys: [] }] },
      trackKeys: { track: [{ probe: 'debug.synthetic.table', table: 0, seq: 1, keys: Array.from({ length: 65 }, () => 'k') }] },
      trackKeyLength: { track: [{ probe: 'debug.synthetic.table', table: 0, seq: 1, keys: ['k'.repeat(513)] }] },
      trackSeq: { track: [{ probe: 'debug.synthetic.table', table: 0, seq: 0, keys: [] }] },
      args: { args: { rows: -1 } }
    })) expect(ok(schema, update(patch)), name).toBe(false)
    // An unkeyed snapshot table and an append table are never tracked.
    const fixtureUpdate = (table: number, probe = 'one.all') => ({ subscriptionId: uuid(), source: 'one', track: [{ probe, table, seq: 1, keys: ['a'] }] })
    expect([0, 1, 4].map(table => ok(fixture.update, fixtureUpdate(table)))).toEqual([true, false, false])
    // Another source's keyed snapshot table is never tracked, nor its probe patched.
    expect(ok(fixtureTest.update, fixtureUpdate(0, 'two.rows'))).toBe(false)
    expect(ok(fixtureTest.update, { subscriptionId: uuid(), source: 'two', track: [{ probe: 'two.rows', table: 0, seq: 1, keys: ['a'] }] })).toBe(true)
    expect(ok(fixtureTest.update, { subscriptionId: uuid(), source: 'one', probes: [{ probe: 'two.rows', paused: true }] })).toBe(false)
  })
  it('clears sort, view and filter only in updates, once each and never alongside a new value', () => {
    const update = (probe: Record<string, unknown>) => ({ subscriptionId: uuid(), source: 'one', probes: [{ probe: 'one.all', ...probe }] })
    expect(ok(fixture.update, update({ clear: ['sort', 'view', 'filter'] }))).toBe(true)
    expect(ok(fixture.update, update({ clear: ['filter'], sort: [{ column: 'k0', descending: false }] }))).toBe(true)
    for (const [name, probe] of Object.entries({
      empty: { clear: [] },
      twice: { clear: ['sort', 'sort'] },
      unknown: { clear: ['rows'] },
      four: { clear: ['sort', 'view', 'filter', 'sort'] },
      clearAndSet: { clear: ['sort'], sort: [{ column: 'k0', descending: false }] },
      clearAndView: { clear: ['view'], view: 'blocked' }
    })) expect(ok(fixture.update, update(probe)), name).toBe(false)
    expect(ok(fixture.subscribe, { ...subscribe(), source: 'one', probes: [{ probe: 'one.all', intervalMs: 1000, clear: ['sort'] }] })).toBe(false)
  })
})

describe('live event schemas', () => {
  it('accepts the opened frame only first, for the source\'s probes', () => {
    expect(ok(liveEventSchema, opened)).toBe(true)
    expect(ok(liveEventSchema, { ...opened, seq: 1 })).toBe(false)
    expect(ok(liveEventSchema, { ...opened, probes: [...opened.probes, ...opened.probes] })).toBe(false)
    expect(ok(liveEventSchema, { ...opened, probes: [{ ...opened.probes[0], state: 'later' }] })).toBe(false)
    expect(ok(liveEventSchema, { ...opened, extra: true })).toBe(false)
    expect(ok(fixture.event, { ...opened, source: 'one', probes: [{ ...opened.probes[0], probe: 'two.only' }] })).toBe(false)
  })
  it('checks every sample against its probe\'s catalogue entry', () => {
    const table = (patch: Record<string, unknown> = {}) => ({ table: 0, descriptor: descriptor(rows), revision: 1, ...patch })
    expect(ok(liveEventSchema, tick([sample({ tables: [table({ retired: [1, 2], diff: { added: 1, removed: 1, changed: 0 }, tracked: { seq: 1, rows: [-1, 0] } })] })]))).toBe(true)
    expect(ok(liveEventSchema, tick([sample({ probe: 'debug.synthetic.metrics', metrics: [1, null, 2.5] })]))).toBe(true)
    expect(ok(liveEventSchema, tick([], { errors: liveErrorCodes.map(code => ({ probe: 'debug.synthetic.table', code, message: 'Failed.', retryInMs: 1000, terminal: false })).slice(0, 8) }))).toBe(true)
    for (const [name, value] of Object.entries({
      empty: tick([]),
      twice: tick([sample(), sample()]),
      metricsLength: tick([sample({ probe: 'debug.synthetic.metrics', metrics: [1, 2] })]),
      metricsOnTable: tick([sample({ metrics: [1] })]),
      infinite: tick([sample({ probe: 'debug.synthetic.metrics', metrics: [1, Infinity, 2] })]),
      tableIndex: tick([sample({ tables: [table({ table: 1 })] })]),
      columns: tick([sample({ tables: [table({ descriptor: descriptor(['id', 'label']) })] })]),
      columnNames: tick([sample({ tables: [table({ descriptor: descriptor(['id', 'label', 'other']) })] })]),
      appendOfSnapshot: tick([sample({ append: [{ table: 0, descriptor: descriptor(rows), segment: 0 }] })]),
      threeRetired: tick([sample({ tables: [table({ retired: [1, 2, 3] })] })]),
      trackedRow: tick([sample({ tables: [table({ tracked: { seq: 1, rows: [-2] } })] })]),
      status: tick([sample({ probe: 'debug.synthetic.status', status: [{ id: 'other', value: 1 }] })]),
      statusLength: tick([sample({ probe: 'debug.synthetic.status', status: [{ id: 'phase', value: 'x'.repeat(129) }] })]),
      gap: tick([sample({ gap: 'early' })]),
      errorCode: tick([], { errors: [{ probe: 'debug.synthetic.table', code: 'NOPE', message: 'Failed.', retryInMs: 0, terminal: false }] }),
      errorTable: tick([], { errors: [{ probe: 'debug.synthetic.table', code: 'SQL_ERROR', message: 'Failed.', retryInMs: 0, terminal: false, tables: [1] }] }),
      errorSeries: tick([], { errors: [{ probe: 'debug.synthetic.metrics', code: 'SQL_ERROR', message: 'Failed.', retryInMs: 0, terminal: false, series: [3] }] }),
      errorMessage: tick([], { errors: [{ probe: 'debug.synthetic.table', code: 'SQL_ERROR', message: 'x'.repeat(2001), retryInMs: 0, terminal: false }] }),
      nineErrors: tick([], { errors: Array.from({ length: 9 }, () => ({ probe: 'debug.synthetic.table', code: 'BUSY', message: 'Busy.', retryInMs: 0, terminal: false })) }),
      seq: tick([sample()], { seq: 0 }),
      member: tick([sample({ extra: 1 })])
    })) expect(ok(liveEventSchema, value), name).toBe(false)
    expect(liveErrorCodes).toEqual(expect.arrayContaining(['CATALOG_MISSING', 'NOT_FOUND', 'PERMISSION_DENIED', 'BLOCKED', 'LOGIN_FAILED']))
  })
  it('allows four snapshot and four append tables per probe, and eight tables per tick', () => {
    const all = fixtureProbes['one.all'].tables!
    const tables = all.flatMap((spec, index) => spec.mode === 'snapshot' ? [{ table: index, descriptor: descriptor(spec.columns.map(item => item.name)), revision: 1 }] : [])
    const append = all.flatMap((spec, index) => spec.mode === 'append' ? [{ table: index, descriptor: descriptor(spec.columns.map(item => item.name)), segment: 0 }] : [])
    const full = { probe: 'one.all', costMs: 0, effectiveIntervalMs: 1000, metrics: [1], tables, append, status: [{ id: 'state', value: 'ok' }] }
    expect(ok(fixture.event, tick([full]))).toBe(true)
    const plain = { probe: 'one.plain', costMs: 0, effectiveIntervalMs: 1000, tables: [{ table: 0, descriptor: descriptor(['x']), revision: 1 }] }
    expect(ok(fixture.event, tick([full, plain])), 'nine tables in one tick').toBe(false)
    expect(ok(fixture.event, tick([{ ...full, append: [] }, plain]))).toBe(false)
    expect(ok(fixture.event, tick([{ ...full, append: append.slice(0, 3) }, plain]))).toBe(true)
    expect(ok(fixture.event, tick([{ ...full, tables: [...tables, tables[0]] }])), 'five snapshot entries').toBe(false)
  })
  it('fits an event to its subscription: its source, every probe it opened once, and only those probes sampled', () => {
    const subscription = { source: 'debug.synthetic' as const, probes: [{ probe: 'debug.synthetic.table' as const, intervalMs: 1000 }] }
    const opener = (probes: string[], source = 'debug.synthetic') => ({ ...opened, source, probes: probes.map(probe => ({ ...opened.probes[0], probe })) }) as BackendLiveEvent
    expect(liveEventFits(opener(['debug.synthetic.table']), subscription)).toBe(true)
    expect(liveEventFits(opener(['debug.synthetic.table', 'debug.synthetic.status']), subscription)).toBe(false)
    expect(liveEventFits(opener(['debug.synthetic.status']), subscription)).toBe(false)
    expect(liveEventFits(opener(['debug.synthetic.table'], 'activity'), subscription)).toBe(false)
    const table = { table: 0, descriptor: descriptor(rows), revision: 1 }
    expect(liveEventFits(tick([sample({ tables: [table] })]) as BackendLiveEvent, subscription)).toBe(true)
    expect(liveEventFits(tick([sample({ probe: 'debug.synthetic.status', status: [{ id: 'phase', value: 'odd' }] })]) as BackendLiveEvent, subscription)).toBe(false)
    expect(liveEventFits(tick([], { errors: [{ probe: 'debug.synthetic.metrics', code: 'SQL_ERROR', message: 'Failed.', retryInMs: 0, terminal: false }] }) as BackendLiveEvent, subscription)).toBe(false)
    // With two sources, another source's probe and table pass the catalogue schema, so only the subscription can refuse them.
    const foreign = tick([{ probe: 'two.rows', costMs: 0, effectiveIntervalMs: 1000, tables: [{ table: 0, descriptor: descriptor(['y']), revision: 1 }] }])
    expect(ok(fixture.event, foreign)).toBe(true)
    expect(liveEventFits(foreign as BackendLiveEvent, { source: 'one' as never, probes: [{ probe: 'one.plain' as never, intervalMs: 1000 }] })).toBe(false)
  })
  it('stamps the generation on every descriptor', () => {
    const value = tick([sample({ tables: [{ table: 0, descriptor: descriptor(rows, 4), revision: 1 }] })]) as BackendLiveEvent
    const stamped = stampLive(value, 7)
    expect(stamped.type === 'live.tick' && stamped.samples[0].tables![0].descriptor).toMatchObject({ resultId: 4, generation: 7 })
    expect(stampLive(opened as BackendLiveEvent, 7)).toEqual(opened)
  })
  it('checks the end and the update answer', () => {
    expect(ok(liveEndSchema, { ended: 'sourceEnded', kept: [3], ticks: 2, elapsedMs: 5 })).toBe(true)
    expect(ok(liveEndSchema, { ended: 'failed', code: 'BACKEND_ERROR', message: 'A live update was too large to send.', ticks: 0, elapsedMs: 0 })).toBe(true)
    // Every probe stopped for good: the end carries the first probe's own error code.
    for (const code of liveErrorCodes) expect(ok(liveEndSchema, { ended: 'failed', code, message: 'Stopped.', ticks: 0, elapsedMs: 0 }), code).toBe(true)
    expect(ok(liveEndSchema, { ended: 'failed', code: 'NO_SUCH_CODE', message: 'Stopped.', ticks: 0, elapsedMs: 0 })).toBe(false)
    for (const value of [
      { ended: 'cancelled', kept: [3], ticks: 2, elapsedMs: 5 }, { ended: 'failed', ticks: 0, elapsedMs: 0 }, { ended: 'failed', code: 'BACKEND_ERROR', ticks: 0, elapsedMs: 0 },
      { ended: 'cancelled', code: 'CANCELLED', message: 'Cancelled.', ticks: 0, elapsedMs: 0 }, { ended: 'paused', ticks: 0, elapsedMs: 0 },
      { ended: 'sourceEnded', kept: Array.from({ length: 65 }, (_, index) => index + 1), ticks: 0, elapsedMs: 0 }
    ]) expect(ok(liveEndSchema, value), JSON.stringify(value).slice(0, 60)).toBe(false)
    expect(ok(liveUpdateResultSchema, { applied: true, probes: [{ probe: 'debug.synthetic.table', intervalMs: 1000, effectiveIntervalMs: 2000, paused: false }] })).toBe(true)
    expect(ok(liveUpdateResultSchema, { applied: false, probes: [] })).toBe(false)
  })
})

describe('live table samples', () => {
  const full = (patch: Record<string, unknown> = {}) => ({ table: 0, descriptor: descriptor(['k0', 'v0']), revision: 2, ...patch })
  const allTick = (snapshot: Record<string, unknown> = {}, append?: Record<string, unknown>) => tick([{
    probe: 'one.all', costMs: 0, effectiveIntervalMs: 1000, tables: [full(snapshot)], ...(append ? { append: [{ table: 4, descriptor: descriptor(['m0']), segment: 3, ...append }] } : {})
  }])
  const facet = (column: string, values: { text: string; count: number }[], more?: true) => ({ column, values, ...(more ? { more } : {}) })
  it('lists departed rows only for a table that keeps them, each once', () => {
    expect(ok(fixture.event, allTick({ departed: [0, 5], tracked: { seq: 1, rows: [0, 5] } }))).toBe(true)
    expect(ok(fixture.event, allTick({ departed: Array.from({ length: L.trackedKeys }, (_, index) => index) }))).toBe(true)
    for (const [name, patch] of Object.entries({
      repeated: { departed: [1, 1] }, negative: { departed: [-1] }, empty: { departed: [] }, tooMany: { departed: Array.from({ length: L.trackedKeys + 1 }, (_, index) => index) }
    })) expect(ok(fixture.event, allTick(patch)), name).toBe(false)
    // Only s0 keeps departed rows; s2 does not.
    const other = tick([{ probe: 'one.all', costMs: 0, effectiveIntervalMs: 1000, tables: [{ table: 2, descriptor: descriptor(['k2']), revision: 1, departed: [0] }] }])
    expect(ok(fixture.event, other)).toBe(false)
  })
  it('carries facets only for the table\'s facet columns, bounded in values, characters and text per tick', () => {
    expect(ok(fixture.event, allTick({ facets: [facet('v0', [{ text: 'a', count: 2 }, { text: '', count: 1 }], true)] }))).toBe(true)
    expect(ok(fixture.event, allTick({ facets: [facet('v0', Array.from({ length: L.facetValues }, (_, index) => ({ text: 'v' + index, count: 1 })))] }))).toBe(true)
    for (const [name, patch] of Object.entries({
      column: { facets: [facet('k0', [])] },
      twice: { facets: [facet('v0', []), facet('v0', [])] },
      values: { facets: [facet('v0', Array.from({ length: L.facetValues + 1 }, (_, index) => ({ text: 'v' + index, count: 1 })))] },
      characters: { facets: [facet('v0', [{ text: 'x'.repeat(L.facetCharacters + 1), count: 1 }])] },
      count: { facets: [facet('v0', [{ text: 'x', count: 0 }])] },
      moreFalse: { facets: [{ column: 'v0', values: [], more: false }] },
      empty: { facets: [] }
    })) expect(ok(fixture.event, allTick(patch)), name).toBe(false)
    // At most facetBytes of UTF-8 text in one tick: 3-byte characters count three times.
    const wide = (count: number) => Array.from({ length: count }, (_, index) => ({ text: String(index % 10).repeat(1) + '€'.repeat(L.facetCharacters - 1), count: 1 }))
    const perValue = 1 + 3 * (L.facetCharacters - 1)
    expect(ok(fixture.event, allTick({ facets: [facet('v0', wide(Math.floor(L.facetBytes / perValue)))] }))).toBe(true)
    expect(ok(fixture.event, allTick({ facets: [facet('v0', wide(Math.floor(L.facetBytes / perValue) + 1))] }))).toBe(false)
  })
  it('marks a restarted append table, which may retire every result it held', () => {
    const all = Array.from({ length: L.segmentResults }, (_, at) => 7 + at)
    const value = allTick({}, { restarted: true, retired: all })
    expect(ok(fixture.event, value)).toBe(true)
    expect(liveRetired(value as BackendLiveEvent)).toEqual(all)
    for (const [name, patch] of Object.entries({ more: { retired: [...all, 99] }, restartedFalse: { restarted: false }, none: { retired: [] } }))
      expect(ok(fixture.event, allTick({}, patch)), name).toBe(false)
  })
  it('takes start positions for a source\'s append tables: beginning, the last rows, or the rows before an id', () => {
    for (const value of ['beginning', { tail: 1 }, { tail: L.segmentRows }, { before: 1 }, { before: Number.MAX_SAFE_INTEGER }]) expect(ok(liveStartSchema, value), JSON.stringify(value)).toBe(true)
    for (const value of ['end', { tail: 0 }, { tail: L.segmentRows + 1 }, { before: 0 }, { tail: 1, before: 2 }, { tail: 1.5 }, {}]) expect(ok(liveStartSchema, value), JSON.stringify(value)).toBe(false)
    const synthetic = (args: Record<string, unknown>) => subscribe({ probes: [{ probe: 'debug.synthetic.log', intervalMs: 1000 }], args })
    expect(ok(testLiveSubscribeParamsSchema, synthetic({ logRows: 10_000, logLevel: 3, lateEvery: 1000, start: { tail: 5 } }))).toBe(true)
    for (const args of [{ logRows: 10_001 }, { logLevel: 4 }, { lateEvery: 0 }, { start: { tail: 0 } }]) expect(ok(testLiveSubscribeParamsSchema, synthetic(args)), JSON.stringify(args)).toBe(false)
    expect(ok(testLiveUpdateParamsSchema, { subscriptionId: uuid(), source: 'debug.synthetic', args: { start: { before: 9 } } })).toBe(true)
  })
  it('lets the log take a restart filter and the grid a memory filter, view, sort and tracking of both tables', () => {
    expect(ok(testLiveSubscribeParamsSchema, subscribe({ probes: [{ probe: 'debug.synthetic.log', intervalMs: 1000, filter: { text: 'x', columns: ['text'] } }] }))).toBe(true)
    expect(ok(testLiveSubscribeParamsSchema, subscribe({ probes: [{ probe: 'debug.synthetic.log', intervalMs: 1000, sort: [{ column: 'messageId', descending: true }] }] }))).toBe(false)
    expect(ok(testLiveSubscribeParamsSchema, subscribe({ probes: [{ probe: 'debug.synthetic.grid', intervalMs: 1000, view: 'even', filter: { text: 'G1' }, sort: [{ column: 'items', descending: true }] }] }))).toBe(true)
    expect(ok(testLiveUpdateParamsSchema, { subscriptionId: uuid(), source: 'debug.synthetic', track: [{ probe: 'debug.synthetic.grid', table: 0, seq: 1, keys: ['1'] }, { probe: 'debug.synthetic.grid', table: 1, seq: 1, keys: ['G1'] }] })).toBe(true)
    expect(ok(testLiveUpdateParamsSchema, { subscriptionId: uuid(), source: 'debug.synthetic', track: [{ probe: 'debug.synthetic.log', table: 0, seq: 1, keys: ['1'] }] })).toBe(false)
  })
})

describe('live frame budget', () => {
  it('keeps the worst-case tick of every source within 192 KiB', () => {
    // Every number at its widest, every string in three-byte characters, every list at its catalogue or schema maximum.
    const big = Number.MAX_SAFE_INTEGER, wideText = (length: number) => '€'.repeat(length)
    for (const source of liveSourceIds) {
      let tables = L.tablesPerTick
      // Facet text is bounded per tick, not per value: the worst case spends it on as many values as fit, every count at its
      // widest, spread over the facet columns the source's tables declare.
      const facetColumns = liveSources[source].probes.flatMap(id => liveProbes[id as typeof liveProbeIds[number]].tables ?? []).filter(table => table.mode === 'snapshot').flatMap(table => table.facets ?? []).length
      const characters = Math.min(L.facetCharacters, Math.floor(L.facetBytes / 3 / Math.max(1, facetColumns * L.facetValues)))
      const facetValues = () => Array.from({ length: L.facetValues }, () => ({ text: '€'.repeat(characters), count: 2 ** 31 - 1 }))
      const samples = liveSources[source].probes.slice(0, L.probes).map(id => {
        const probe = liveProbes[id as typeof liveProbeIds[number]]
        const spec = (mode: 'snapshot' | 'append') => (probe.tables ?? []).flatMap((table, index) => table.mode === mode && tables-- > 0 ? [{ table, index }] : [])
        const columnsOf = (table: NonNullable<LiveProbeSpec['tables']>[number]) => ({ ...descriptor(table.columns.map(item => item.name), 0xffffffff), columns: table.columns.map(item => ({ name: item.name, dataType: item.dataType, wire: 'binary', role: 'vector', maxLength: big, precision: big, scale: big, nullable: false })), rowsRead: big, rowsStored: big, rowsAvailable: big, bytesStored: big, truncatedCells: big, truncated: 'globalBudget', state: 'released', incomplete: true })
        const snapshots = spec('snapshot'), appends = spec('append')
        return {
          probe: id, costMs: 2 ** 31 - 1, effectiveIntervalMs: L.intervalMs.max, elapsedMs: big, gap: 'baseline', skipped: 2 ** 31 - 1,
          ...(probe.series?.length ? { metrics: probe.series.map(() => -Number.MAX_VALUE) } : {}),
          ...(snapshots.length ? { tables: snapshots.slice(0, L.tablesPerProbe).map(({ table, index }) => ({
            table: index, descriptor: columnsOf(table), revision: big, retired: [0xffffffff, 0xffffffff], diff: { added: 2 ** 31 - 1, removed: 2 ** 31 - 1, changed: 2 ** 31 - 1 },
            tracked: { seq: 2 ** 31 - 1, rows: Array.from({ length: L.trackedKeys }, () => 2 ** 31 - 1) },
            ...(table.departed ? { departed: Array.from({ length: L.trackedKeys }, (_, at) => 2 ** 31 - 1 - at) } : {}),
            ...(table.facets?.length ? { facets: table.facets.map(column => ({ column, values: facetValues(), more: true })) } : {})
          })) } : {}),
          ...(appends.length ? { append: appends.slice(0, L.appendPerProbe).map(({ table, index }) => ({ table: index, descriptor: columnsOf(table), segment: 2 ** 31 - 1, rolledFrom: 0xffffffff, retired: Array.from({ length: L.segmentResults }, () => 0xffffffff), restarted: true })) } : {}),
          ...(probe.status?.length ? { status: probe.status.map(id => ({ id, value: wideText(L.statusCharacters) })) } : {})
        }
      })
      const errors = Array.from({ length: L.errors }, (_, index) => {
        const probe = liveSources[source].probes[index % liveSources[source].probes.length], spec = liveProbes[probe as typeof liveProbeIds[number]]
        const indexes = (count: number) => count > 0 ? { length: count } : undefined
        const tables = indexes(spec.tables?.length ?? 0), series = indexes(spec.series?.length ?? 0)
        return {
          probe, code: 'DATABASE_UNAVAILABLE', message: wideText(L.messageCharacters), number: -2_147_483_648, retryInMs: L.intervalMs.max, terminal: false,
          ...(tables ? { tables: Array.from(tables, (_, at) => at) } : {}), ...(series ? { series: Array.from(series, (_, at) => at) } : {})
        }
      })
      const worst = { type: 'live.tick', seq: big, sampledAt: big, spid: 32_767, resume: 'A'.repeat(L.resumeCharacters), samples, errors }
      expect(liveEventSchema.safeParse(worst).error?.issues ?? [], source).toEqual([])
      expect(encodeControl(worst).length, source).toBeLessThanOrEqual(L.frameBudget)
    }
  })
})
