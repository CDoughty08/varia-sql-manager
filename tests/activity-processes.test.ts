import { describe, expect, it } from 'vitest'
import { activityLimits, tableSpecs } from '../src/shared/activity/catalog'
import { activityLiveArgsSchema } from '../src/shared/activity/schema'
import { defaultProcessesFilter, monitorArgs, processesActivityFilter, type ProcessesFilter } from '../src/renderer/src/activity/ActivityMonitorService'
import { activeFilters, processesStatus, processesToneLabel, valueChoices } from '../src/renderer/src/activity/panes/ProcessesPane'
import { paneProblem, paneWaiting } from '../src/renderer/src/activity/panes/PaneState'
import type { LiveProbeSnapshot, LiveSnapshot } from '../src/renderer/src/live/LiveService'

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
