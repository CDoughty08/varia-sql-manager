import { describe, expect, it } from 'vitest'
import { activityLimits, tableSpecs } from '../src/shared/activity/catalog'
import { activityLiveArgsSchema } from '../src/shared/activity/schema'
import { defaultProcessesFilter, monitorArgs, processesActivityFilter, type ProcessesFilter } from '../src/renderer/src/activity/ActivityMonitorService'
import { activeFilters, processesStatus, processesToneLabel } from '../src/renderer/src/activity/panes/ProcessesPane'
import { facetList, liveCondition, liveFilterSource, type FacetList } from '../src/renderer/src/live/live-filter'
import { paneProblem, paneWaiting } from '../src/renderer/src/activity/panes/PaneState'
import type { LiveProbeSnapshot, LiveSnapshot } from '../src/renderer/src/live/LiveService'

const probe = (patch: Partial<LiveProbeSnapshot>): LiveProbeSnapshot => ({ state: 'fresh', intervalMs: 2000, effectiveIntervalMs: 2000, ...patch })
const view = (patch: Partial<LiveSnapshot>, sessions?: Partial<LiveProbeSnapshot>): LiveSnapshot => ({ status: 'live', connectionId: 'c1', probes: sessions ? { 'activity.sessions': probe(sessions) } : {}, ...patch })
const filter = (patch: Partial<ProcessesFilter>): ProcessesFilter => ({ ...defaultProcessesFilter, ...patch })

describe('Sessions filter args', () => {
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

describe('Sessions pane', () => {
  it('names the tones Sessions gives its rows', () => {
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
  it('lists a funnel\'s facet as the results grid\'s snapshot, ticked from the filter, keeping chosen values the facets no longer have', async () => {
    const facet = { column: 'login', values: [{ text: 'sa', count: 2 }, { text: '', count: 4 }, { text: 'app', count: 1 }] }
    const read = async (list: FacetList, order: 'value' | 'count' = 'value') => (await list.read({ order, offset: 0, count: 50 })).values.map(value => [value.text, value.count, value.checked])
    const none = facetList(0, facet, undefined)
    // Blank text is NULL's entry; the values sort by text, or by count.
    expect(none.summary).toMatchObject({ nulls: 4, nullsChecked: true, distinct: 2, checked: 2, rows: 7, complete: true })
    expect(await read(none)).toEqual([['app', 1, true], ['sa', 2, true]])
    expect(await read(none, 'count')).toEqual([['sa', 2, true], ['app', 1, true]])
    const chosen = facetList(0, facet, { values: ['app', 'gone'], blanks: true })
    expect(await read(chosen)).toEqual([['app', 1, true], ['gone', 0, true], ['sa', 2, false]])
    expect(chosen.ticked()).toEqual({ values: ['app', 'gone'], all: false, blanks: true })
    const nonBlanks = facetList(0, facet, { nonBlanks: true })
    expect(nonBlanks.ticked()).toEqual({ values: ['app', 'sa'], all: true, blanks: false })
    // Ticks go through the popover's protocol: by group, by search, and NULL's entry.
    await none.tick({ checked: false, all: true, search: 'P' })
    await none.tick({ checked: false, nulls: false })
    expect(none.ticked()).toEqual({ values: ['sa'], all: false, blanks: false })
    expect((await none.read({ order: 'value', offset: 0, count: 50, search: 'ap' })).total).toBe(1)
    expect(facetList(0, undefined, undefined).ticked()).toEqual({ values: [], all: true, blanks: true })
  })
  it('turns the popover\'s condition into the filter the backend applies, or none, within the values a column filter holds', async () => {
    const max = activityLimits.columnFilterValues
    const facet = { column: 'login', values: [{ text: 'sa', count: 2 }, { text: 'app', count: 1 }] }
    const ticked = async (groups: number[], blanks: boolean) => {
      const list = facetList(0, facet, undefined)
      await list.tick({ checked: false, all: true })
      if (groups.length) await list.tick({ checked: true, groups })
      await list.tick({ checked: blanks, nulls: blanks })
      return liveCondition({ kind: 'list', list }, list.texts, max)
    }
    expect(await ticked([0, 1], true)).toEqual({ filter: undefined })
    expect(await ticked([0, 1], false)).toEqual({ filter: { nonBlanks: true } })
    expect(await ticked([0], false)).toEqual({ filter: { values: ['app'] } })
    expect(await ticked([0], true)).toEqual({ filter: { values: ['app'], blanks: true } })
    expect(await ticked([], true)).toEqual({ filter: { blanks: true } })
    expect(await ticked([], false)).toEqual({ error: 'Select at least one value.' })
    const texts = ['app', 'sa']
    expect(liveCondition({ kind: 'equals', row: 1 }, texts, max)).toEqual({ filter: { values: ['sa'] } })
    expect(liveCondition({ kind: 'null' }, texts, max)).toEqual({ filter: { blanks: true } })
    expect(liveCondition({ kind: 'notNull' }, texts, max)).toEqual({ filter: { nonBlanks: true } })
    expect(liveCondition({ kind: 'clear' }, texts, max)).toEqual({ filter: undefined })
    expect(liveCondition({ kind: 'notEquals', row: 0 } as never, texts, max)).toMatchObject({ error: expect.any(String) })
    const many = { column: 'login', values: Array.from({ length: max + 2 }, (_, index) => ({ text: `v${index}`, count: 1 })) }
    const big = facetList(0, many, undefined)
    await big.tick({ checked: false, groups: [0] })
    expect(liveCondition({ kind: 'list', list: big }, big.texts, max)).toMatchObject({ error: expect.stringMatching(/at most/) })
  })
  it('gives the results grid\'s popover a live source: the facet columns only, the live conditions, and OK as the column\'s args', async () => {
    const applied: [string, unknown][] = []
    const source = liveFilterSource({
      columnId: column => ['login', 'host'][column], facet: id => id === 'login' ? { column: 'login', values: [{ text: 'sa', count: 2 }, { text: 'app', count: 1 }], more: true } : undefined,
      filterOf: () => undefined, apply: (id, value) => { applied.push([id, value]) }, maxValues: activityLimits.columnFilterValues
    })
    expect(source.conditions).toEqual(['list', 'equals', 'null', 'notNull'])
    expect(source.nullText).toBe('(Blanks)')
    expect(source.note?.(0)).toMatch(/most frequent/)
    await expect(source.columnValues(5, {})).rejects.toThrow()
    const list = await source.columnValues(0, {})
    await list.tick({ checked: false, groups: [1] })
    expect(source.apply(0, { kind: 'list', list })).toBe(true)
    expect(source.apply(0, { kind: 'notEquals', row: 0 } as never)).toEqual(expect.any(String))
    expect(source.apply(0, { kind: 'clear' })).toBe(true)
    expect(applied).toEqual([['login', { values: ['app'], blanks: true }], ['login', undefined]])
    // Every filter it hands the pane is one the live schema accepts as a column filter.
    const args = { filters: [processesActivityFilter(filter({ columnFilters: [{ column: 'login', ...applied[0][1] as object }] }))] }
    expect(activityLiveArgsSchema.safeParse(args).success).toBe(true)
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
