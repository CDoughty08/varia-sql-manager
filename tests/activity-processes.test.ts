import { describe, expect, it } from 'vitest'
import { activityLimits, tableSpecs } from '../src/shared/activity/catalog'
import { activityLiveArgsSchema } from '../src/shared/activity/schema'
import { defaultProcessesFilter, monitorArgs, processesActivityFilter, type ProcessesFilter } from '../src/renderer/src/activity/ActivityMonitorService'
import { activeFilters, processesStatus, processesToneLabel, valueChoices } from '../src/renderer/src/activity/panes/ProcessesPane'
import { paneProblem, paneWaiting } from '../src/renderer/src/activity/panes/PaneState'
import type { LiveProbeSnapshot, LiveSnapshot } from '../src/renderer/src/live/LiveService'
import { activeStatus, activeToneLabel, blockingStatus, blockingToneLabel, emptyNote, sessionTableIndex, type TableFacts } from '../src/renderer/src/activity/panes/SessionTablePanes'
import { liveProbes } from '../src/shared/live/catalog'

const probe = (patch: Partial<LiveProbeSnapshot>): LiveProbeSnapshot => ({ state: 'fresh', intervalMs: 2000, effectiveIntervalMs: 2000, ...patch })
const view = (patch: Partial<LiveSnapshot>, sessions?: Partial<LiveProbeSnapshot>): LiveSnapshot => ({ status: 'live', connectionId: 'c1', probes: sessions ? { 'activity.sessions': probe(sessions) } : {}, ...patch })
const filter = (patch: Partial<ProcessesFilter>): ProcessesFilter => ({ ...defaultProcessesFilter, ...patch })

describe('Processes filter args', () => {
  it('builds args the live schema accepts, with every facet column and the bounds at their limits', () => {
    const columns = tableSpecs.sessions.facetColumns ?? []
    expect(columns.length).toBeGreaterThan(0)
    const long = 'x'.repeat(1_000)
    const full = filter({ view: 'blocked', showSystem: true, showVaria: true, text: long, columnFilters: columns.map(column => ({ column, values: Array.from({ length: 80 }, (_, index) => `${index}${long}`), blanks: true, nonBlanks: false })) })
    for (const args of [monitorArgs({ processes: defaultProcessesFilter }), monitorArgs({ processes: full }), { filters: [processesActivityFilter(filter({ columnFilters: [{ column: columns[0], blanks: true }] }))] }]) {
      // What the main process's validation would do to a live.update: a shape the backend refuses fails here, not at runtime.
      expect(activityLiveArgsSchema.safeParse(args).success, JSON.stringify(args).slice(0, 200)).toBe(true)
    }
  })
})

describe('Processes pane', () => {
  it('names the tones Processes gives its rows', () => {
    expect(['error', 'warning', 'running', 'muted', 'info'].map(tone => processesToneLabel(tone as never))).toEqual(['blocked', 'blocking others', 'rolling back', 'system or ended session', undefined])
  })
  it('counts the rows shown and says what is hidden, cut or why there are none', () => {
    expect(processesStatus(3, false, defaultProcessesFilter)).toBe('3 sessions · system sessions and Varia\'s own hidden')
    expect(processesStatus(1, true, filter({ view: 'blocked', text: ' x ', showSystem: true, showVaria: true, columnFilters: [{ column: 'login', values: ['a'] }] })))
      .toBe(`1 session · 3 filters on · at most ${tableSpecs.sessions.rowCap?.toLocaleString('en-US')} kept; idle sessions were dropped first`)
    expect(activeFilters(filter({ text: '   ' }))).toBe(0)
    expect(processesStatus(undefined, false, defaultProcessesFilter)).toBe('Waiting for the first sample…')
    expect(processesStatus(undefined, false, defaultProcessesFilter, 'paused')).toMatch(/^Paused/)
    expect(processesStatus(undefined, false, defaultProcessesFilter, 'stopped')).toMatch(/stopped/)
  })
  it('lists chosen values the facets no longer have, and disables the rest at the limit instead of dropping a value', () => {
    const facet = { column: 'login', values: [{ text: 'sa', count: 2 }, { text: 'app', count: 1 }] }
    expect(valueChoices(facet, ['app', 'gone'])).toEqual([
      { text: 'sa', count: 2, checked: false, disabled: false },
      { text: 'app', count: 1, checked: true, disabled: false },
      { text: 'gone', checked: true, disabled: false }
    ])
    expect(valueChoices(undefined)).toEqual([])
    const chosen = Array.from({ length: activityLimits.columnFilterValues }, (_, index) => `v${index}`)
    const choices = valueChoices({ column: 'login', values: [{ text: 'v0', count: 1 }, { text: 'other', count: 1 }] }, chosen)
    expect(choices.slice(0, 2)).toEqual([{ text: 'v0', count: 1, checked: true, disabled: false }, { text: 'other', count: 1, checked: false, disabled: true }])
    expect(choices).toHaveLength(activityLimits.columnFilterValues + 1)
  })
  it('says why a pane has no rows: its own table\'s failure or refusal, a pause, or a stopped view', () => {
    expect(paneProblem(undefined, 0)).toBeUndefined()
    expect(paneProblem(probe({ state: 'unavailable', reason: 'NOT_SUPPORTED', note: 'Not here.' }), 0)).toEqual({ kind: 'refused', code: 'NOT_SUPPORTED', message: 'Not here.' })
    expect(paneProblem(probe({ state: 'failing', error: { code: 'PERMISSION_DENIED', message: 'No.' } as never }), 0)).toMatchObject({ kind: 'refused' })
    expect(paneProblem(probe({ state: 'failing', error: { code: 'BLOCKED', message: 'Blocked.' } as never }), 0)).toEqual({ kind: 'failing', code: 'BLOCKED', message: 'Blocked.' })
    // An error that names other tables of the probe leaves this one alone.
    expect(paneProblem(probe({ state: 'failing', error: { code: 'BLOCKED', message: 'Blocked.', tables: [1] } as never }), 0)).toBeUndefined()
    expect(paneProblem(probe({ state: 'fresh', error: { code: 'BLOCKED', message: 'Old.' } as never }), 0)).toBeUndefined()
    expect(paneWaiting(view({}, { state: 'fresh' }), 'activity.sessions')).toBe('loading')
    expect(paneWaiting(view({}), 'activity.sessions')).toBe('loading')
    expect(paneWaiting(view({}, { state: 'paused' }), 'activity.sessions')).toBe('paused')
    expect(paneWaiting(view({ status: 'paused', pausedBy: 'user' }), 'activity.sessions')).toBe('paused')
    expect(paneWaiting(view({ status: 'ended' }, { state: 'fresh' }), 'activity.sessions')).toBe('stopped')
    expect(paneWaiting(view({ status: 'lost' }), 'activity.sessions')).toBe('stopped')
  })
})

describe('Blocking and Active Expensive Queries panes', () => {
  it('read the sessions probe\'s second and third tables, in the catalogue\'s order', () => {
    expect(liveProbes['activity.sessions']?.tables?.map(table => table.id)).toEqual(['sessions', 'blocking', 'activeQueries'])
    expect([sessionTableIndex('blocking'), sessionTableIndex('activeQueries')]).toEqual([1, 2])
  })
  it('name the tones the backend sets on them', () => {
    expect(['error', 'warning', 'muted', 'running'].map(tone => blockingToneLabel(tone as never))).toEqual(['blocked', 'lead blocker', 'left the chain', undefined])
    expect(['error', 'running', 'muted', 'warning'].map(tone => activeToneLabel(tone as never))).toEqual(['blocked', 'rolling back', 'no longer listed', undefined])
  })
  it('say what the table holds, what cut it, that it is empty right now only while live, and why there is nothing', () => {
    const facts = (patch: Partial<TableFacts>): TableFacts => ({ rows: 0, live: true, waiting: 'loading', refused: false, ...patch })
    expect(blockingStatus(facts({}))).toBe('No blocking: no session waits on another.')
    expect(blockingStatus(facts({ live: false }))).toBe('No blocking in the last sample.')
    expect(blockingStatus(facts({ rows: 2 }))).toBe('2 sessions in blocking chains')
    expect(blockingStatus(facts({ rows: 33, truncated: 'rowLimit' }))).toBe(`33 sessions in blocking chains · cut at ${tableSpecs.blocking.rowCap.toLocaleString('en-US')} sessions or ${activityLimits.blockingDepth} levels deep`)
    expect(blockingStatus(facts({ rows: 5, truncated: 'globalBudget' }))).toBe('5 sessions in blocking chains · cut to stay inside the memory budget')
    expect(blockingStatus(facts({ rows: undefined, waiting: 'paused' }))).toMatch(/^Paused/)
    // A refusal at open sends no table: the status says so instead of waiting for a sample that never comes.
    expect(blockingStatus(facts({ rows: undefined, refused: true }))).toBe('Blocking chains cannot be read on this server.')
    expect(activeStatus(facts({}))).toBe('No requests running.')
    expect(activeStatus(facts({ live: false }))).toBe('No requests running in the last sample.')
    expect(activeStatus(facts({ rows: 1 }))).toBe('1 running request')
    expect(activeStatus(facts({ rows: 100, truncated: 'rowLimit' }))).toBe(`100 running requests · the ${tableSpecs.activeQueries.rowCap} using the most CPU`)
    expect(activeStatus(facts({ rows: 37, truncated: 'queryBudget' }))).toBe('37 running requests · cut to stay inside the memory budget')
    expect(activeStatus(facts({ rows: undefined, refused: true }))).toBe('Running requests cannot be read on this server.')
    expect(activeStatus(facts({ rows: undefined }))).toBe('Waiting for the first sample…')
    // The empty note claims "right now" only while the table is current, and never over a failure.
    expect(emptyNote('blocking', facts({}), undefined)).toMatch(/^No blocking right now\./)
    expect(emptyNote('activeQueries', facts({}), undefined)).toBe('No requests are running right now.')
    expect(emptyNote('blocking', facts({ live: false }), undefined)).toBeUndefined()
    expect(emptyNote('blocking', facts({ rows: 1 }), undefined)).toBeUndefined()
    expect(emptyNote('blocking', facts({}), { kind: 'failing', message: 'Blocked.' })).toBeUndefined()
  })
  it('take the probe\'s error only when it names their table', () => {
    const denied = probe({ state: 'fresh', error: { code: 'PERMISSION_DENIED', message: 'No.', tables: [1, 2] } as never })
    expect([paneProblem(denied, 0), paneProblem(denied, 1)?.kind, paneProblem(denied, 2)?.kind]).toEqual([undefined, 'refused', 'refused'])
  })
})
