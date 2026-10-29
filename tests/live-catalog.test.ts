import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { activityLiveProbes, activitySource, activityStatuses, liveColumnId, liveColumnTypes, pendingProbes, probeSeries, probeSpecs, seriesSpecs, tableSpecs, type ActivityTable } from '../src/shared/activity/catalog'
import { limits } from '../src/shared/ipc/wire/protocol'
import { defaultBudgetMs, liveCatalogJson, liveCounters, liveDataTypes, liveProbeIds, liveProbes, liveSourceIds, liveSources, liveTones, liveUnits, productionSourceIds } from '../src/shared/live/catalog'
import { renderLiveDocs } from '../src/shared/live/docs'
import { liveArgsSchemas } from '../src/shared/live/schema'
import { catalogFingerprints } from '../src/shared/ssis/catalog'

const L = limits.live
const catalogId = /^[a-z][A-Za-z0-9]{0,31}$/
// Series travel as positions, never ids, so an id may name its family (wait.lock, focus.cpuRate).
const seriesId = /^(?=.{1,32}$)[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)?$/

describe('live catalogue', () => {
  it('names every source and probe once, and each probe belongs to exactly one source', () => {
    expect(new Set(liveSourceIds).size).toBe(liveSourceIds.length)
    expect(new Set(liveProbeIds).size).toBe(liveProbeIds.length)
    for (const id of liveSourceIds) expect(liveSources[id].id).toBe(id)
    for (const id of liveProbeIds) {
      expect(liveProbes[id].id).toBe(id)
      expect(liveSourceIds.filter(source => liveSources[source].probes.includes(id)), id).toEqual([liveProbes[id].source])
    }
    for (const id of liveSourceIds) {
      expect(liveSources[id].probes.length, id).toBeGreaterThan(0)
      for (const probe of liveSources[id].probes) expect(liveProbes[probe as keyof typeof liveProbes]?.source, probe).toBe(id)
    }
  })
  it('keeps every probe within the live limits', () => {
    for (const id of liveProbeIds) {
      const probe = liveProbes[id]
      const { min, max } = probe.intervalMs
      expect(min <= probe.intervalMs.default && probe.intervalMs.default <= max && min >= L.intervalMs.min && max <= L.intervalMs.max, id).toBe(true)
      expect((probe.series ?? []).length, id).toBeLessThanOrEqual(L.series)
      for (const series of probe.series ?? []) { expect(series.id, id).toMatch(seriesId); expect(liveUnits).toContain(series.unit); expect(liveCounters).toContain(series.counter) }
      // The scheduler's own settings: a budget the statement gates and LOCK_TIMEOUT fit in, a duty cycle that can trip, a refresh gap.
      const budget = probe.budgetMs ?? defaultBudgetMs
      expect(budget.min >= L.budgetMs.min && budget.min <= budget.max && budget.max <= L.budgetMs.max, id).toBe(true)
      expect(probe.maxDutyCycle === undefined || (probe.maxDutyCycle > 0.1 && probe.maxDutyCycle <= 1), id).toBe(true)
      expect(probe.minGapMs === undefined || (Number.isInteger(probe.minGapMs) && probe.minGapMs >= 0 && probe.minGapMs <= L.intervalMs.max), id).toBe(true)
      if (probe.gates) expect(probe.gates.minMajor >= 13 && probe.gates.editions.length > 0 && probe.gates.editions.every(edition => Number.isInteger(edition) && edition > 0), id).toBe(true)
      // A probe that reads SQL Server belongs to a source with a scope that has a pool; a test source reads none.
      expect(probe.permission === undefined || liveSources[probe.source as keyof typeof liveSources].scope === 'server', id).toBe(true)
      expect(new Set((probe.series ?? []).map(series => series.id)).size).toBe((probe.series ?? []).length)
      const tables = probe.tables ?? []
      expect(tables.filter(table => table.mode === 'snapshot').length, id).toBeLessThanOrEqual(L.tablesPerProbe)
      expect(tables.filter(table => table.mode === 'append').length, id).toBeLessThanOrEqual(L.appendPerProbe)
      // Sort and filter name columns by id across the probe's tables, so the ids are unique within a probe.
      const columns = tables.flatMap(table => table.columns.map(column => column.id))
      expect(new Set(columns).size, id).toBe(columns.length)
      for (const table of tables) {
        expect(table.columns.length, id).toBeGreaterThan(0)
        expect(table.columns.length, id).toBeLessThanOrEqual(L.columns)
        for (const column of table.columns) { expect(column.id, id).toMatch(catalogId); expect(liveDataTypes, id).toContain(column.dataType) }
        for (const key of table.key) expect(table.columns.map(column => column.id), id).toContain(key)
        const columnIds = table.columns.map(column => column.id)
        if (table.mode === 'snapshot') {
          // A snapshot's own settings: a row cap within the limit, departed rows only where rows have a key, facets on its own columns.
          expect(table.rowCap === undefined || (Number.isInteger(table.rowCap) && table.rowCap >= 1 && table.rowCap <= L.snapshotRows), id).toBe(true)
          expect(!table.departed || table.key.length > 0, id).toBe(true)
          expect((table.facets ?? []).length, id).toBeLessThanOrEqual(L.facetColumns)
          expect(new Set(table.facets ?? []).size, id).toBe((table.facets ?? []).length)
          for (const facet of table.facets ?? []) expect(columnIds, id).toContain(facet)
          expect(table.settle === undefined && table.batchRows === undefined, id).toBe(true)
        } else {
          // An append table reads by one integer keyset id, settles within a minute, and reads at most batchRows a tick.
          expect(table.key.length, id).toBe(1)
          expect(['int', 'bigint'], id).toContain(table.columns.find(column => column.id === table.key[0])?.dataType)
          expect(table.settle === undefined || (Number.isInteger(table.settle.ticks) && table.settle.ticks >= 1 && table.settle.ticks <= 10 && Number.isInteger(table.settle.ms) && table.settle.ms >= 0 && table.settle.ms <= 60_000), id).toBe(true)
          expect(table.batchRows === undefined || (Number.isInteger(table.batchRows) && table.batchRows >= 1 && table.batchRows <= L.batchRows), id).toBe(true)
          expect(table.rowCap === undefined && table.departed === undefined && table.facets === undefined, id).toBe(true)
        }
      }
      expect((probe.status ?? []).length, id).toBeLessThanOrEqual(L.statuses)
      for (const status of probe.status ?? []) expect(status, id).toMatch(catalogId)
      for (const view of probe.views ?? []) expect(view, id).toMatch(catalogId)
      expect((probe.series ?? []).length + tables.length + (probe.status ?? []).length, id).toBeGreaterThan(0)
    }
  })
  it('keeps a row tone column last, as text, and out of keys and facets', () => {
    // The grid hides the last column when it is the tone (GridView), so a tone column anywhere else would show and shift
    // every column after it.
    let toned = 0
    for (const id of liveProbeIds) {
      for (const table of liveProbes[id].tables ?? []) {
        const tones = table.columns.filter(column => column.role !== undefined)
        expect(tones.every(column => column.role === 'tone' && column.dataType === 'nvarchar'), id).toBe(true)
        expect(tones.length, id).toBeLessThanOrEqual(1)
        if (tones.length === 0) continue
        toned++
        expect(table.columns.at(-1), id).toBe(tones[0])
        expect(table.columns.length, id).toBeGreaterThan(1)
        expect(table.key, id).not.toContain(tones[0].id)
        expect(table.facets ?? [], id).not.toContain(tones[0].id)
      }
    }
    // The synthetic grid and log carry one, so the renderer and smoke tests see tones in both table modes.
    expect(toned).toBeGreaterThanOrEqual(2)
    expect(liveTones).toEqual(['error', 'warning', 'running', 'muted'])
  })
  it('keeps a statusOnly source\'s hidden sampling to probes without tables', () => {
    for (const id of liveSourceIds) {
      const source = liveSources[id]
      expect([undefined, 'pause', 'statusOnly'], id).toContain(source.hidden)
      if (source.hidden === 'statusOnly') expect(source.probes.some(probe => (liveProbes[probe as typeof liveProbeIds[number]].tables ?? []).length === 0), id).toBe(true)
    }
    expect(L.hiddenIntervalMs).toBeGreaterThanOrEqual(30_000)
  })
  it('gives every source its args schema, and keeps test-only sources out of production', () => {
    expect(Object.keys(liveArgsSchemas).sort()).toEqual([...liveSourceIds].sort())
    expect(productionSourceIds).toEqual(liveSourceIds.filter(id => !liveSources[id].testOnly))
    expect(liveSources['debug.synthetic']).toMatchObject({ testOnly: true, scope: 'none' })
    expect(productionSourceIds).toEqual(['activity', 'explorer', 'ssis.catalog'])
    expect(liveSources.activity).toMatchObject({ testOnly: false, scope: 'server', probes: ['activity.overview', 'activity.sessions', 'activity.resources'] })
    // Object Explorer's status chips: database states need no permission (a low-privilege login still gets them), the
    // DMV probes need server state, the Agent probe skips Express and the availability probe runs only where Always On can.
    expect(liveSources.explorer).toMatchObject({ testOnly: false, scope: 'server', probes: ['explorer.databases', 'explorer.progress', 'explorer.agent', 'explorer.availability'] })
    expect(liveProbes['explorer.databases']).toMatchObject({ intervalMs: { default: 5000, min: 2000 }, gates: { minMajor: 13, editions: [1, 2, 3, 4, 8] } })
    expect(liveProbes['explorer.databases'].permission).toBeUndefined()
    expect(liveProbes['explorer.progress']).toMatchObject({ permission: 'serverState', tables: [{ id: 'progress', key: ['name'] }] })
    expect(liveProbes['explorer.agent']).toMatchObject({ gates: { editions: [1, 2, 3, 8] }, series: [{ id: 'runningJobs', counter: 'gauge' }] })
    expect(liveProbes['explorer.agent'].permission).toBeUndefined()
    expect(liveProbes['explorer.availability']).toMatchObject({ permission: 'serverState', gates: { editions: [2, 3] }, tables: [{ id: 'groups', key: ['name'] }] })
    // The Activity Monitor's overview: 2 s by default (owner decision), never below 1 s, a 0.2 load guard, server state.
    expect(liveProbes['activity.overview']).toMatchObject({ intervalMs: { default: 2000, min: 1000 }, maxDutyCycle: 0.2, permission: 'serverState', gates: { minMajor: 13 } })
  })
  it('builds the Activity Monitor\'s probes from its own catalogue: tables, columns in order, keys, facets, series and gates', () => {
    expect(activityLiveProbes).toEqual(['activity.overview', 'activity.sessions', 'activity.resources'])
    for (const id of activityLiveProbes) {
      const live = liveProbes[id], spec = probeSpecs[id]
      expect(live, id).toMatchObject({ source: activitySource, label: spec.title, intervalMs: { default: spec.defaultIntervalMs, min: spec.minIntervalMs, max: spec.maxIntervalMs },
        budgetMs: { max: spec.budgetMs }, maxDutyCycle: spec.maxDutyCycle, gates: { minMajor: 13, editions: [1, 2, 3, 4, 8] } })
      expect(live.filterMode, id).toBe(spec.filterMode)
      expect(live.minGapMs, id).toBe(spec.minGapMs)
      expect((live.series ?? []).map(series => series.id), id).toEqual(probeSeries(id))
      // A metrics probe's series go through the delta engine by kind; a snapshot probe sends what it worked out itself.
      for (const series of live.series ?? []) expect(series.counter, `${id} ${series.id}`).toBe(spec.kind === 'metrics' ? seriesSpecs[series.id]!.kind : 'gauge')
      expect((live.tables ?? []).map(table => table.id), id).toEqual(spec.tables)
      for (const table of live.tables ?? []) {
        const source = tableSpecs[table.id as ActivityTable]
        expect(table.columns.map(column => [column.id, column.name, column.dataType]), table.id).toEqual(source.columns.map(column => [liveColumnId(table.id as ActivityTable, column.id), column.caption, liveColumnTypes[column.type]]))
        expect(table.key, table.id).toEqual(source.key.map(column => liveColumnId(table.id as ActivityTable, column)))
        expect(table.facets ?? [], table.id).toEqual((source.facetColumns ?? []).map(column => liveColumnId(table.id as ActivityTable, column)))
        expect(table.departed ?? false, table.id).toBe(source.departedLinger ?? false)
        expect(table.rowCap, table.id).toBe(source.rowCap)
        // Names are what Copy with Headers and Save write, so they are the captions, unique within a table.
        expect(new Set(table.columns.map(column => column.name)).size, table.id).toBe(table.columns.length)
      }
    }
    // A probe's first table keeps the catalogue's ids, so Processes sorts by sessionId; the others are prefixed.
    expect([liveColumnId('sessions', 'login'), liveColumnId('blocking', 'sessionId'), liveColumnId('activeQueries', 'cpuMs'), liveColumnId('waitCategories', 'waitRate'), liveColumnId('waitTypes', 'waitRate'), liveColumnId('files', 'file')])
      .toEqual(['login', 'chainSessionId', 'activeCpuMs', 'waitRate', 'typeWaitRate', 'ioFile'])
    // Without server state, only the sessions probe runs (the monitor's own session); it reports what the login may do.
    expect([liveProbes['activity.overview'].permission, liveProbes['activity.sessions'].permission, liveProbes['activity.resources'].permission]).toEqual(['serverState', undefined, 'serverState'])
    expect(liveProbes['activity.sessions'].status).toEqual(Object.keys(activityStatuses))
    expect(liveProbes['activity.resources'].description).toContain(pendingProbes['activity.resources'])
    // The opened frame carries a pending probe's note.
    for (const note of Object.values(pendingProbes)) expect(note.length).toBeLessThanOrEqual(L.noteCharacters)
    expect(liveProbes['activity.overview'].series?.find(series => series.id === 'pageLifeExpectancy')).toMatchObject({ unit: 'seconds', counter: 'gauge' })
  })
  it('fingerprints the SSIS Catalog for the tree every 30 s, on its own pool and with no args', () => {
    // Owner decision 12: the tree probe runs every 30 s; D-ssis 7.3 bounds it at 10 s to 300 s. SSISDB's budget is 10 s.
    expect(liveSources['ssis.catalog']).toMatchObject({ testOnly: false, scope: 'ssisdb', probes: ['ssis.catalogProbe'] })
    expect(liveProbes['ssis.catalogProbe']).toMatchObject({ intervalMs: { default: 30_000, min: 10_000, max: 300_000 }, budgetMs: { min: 500, max: 10_000 } })
    const probe = liveProbes['ssis.catalogProbe']
    expect(probe.series ?? []).toEqual([])
    expect(probe.tables ?? []).toEqual([])
    expect(probe.permission).toBeUndefined()
    // Two status values per fingerprint, exactly what the status limit allows, so another view needs another probe.
    expect(probe.status).toEqual(catalogFingerprints.flatMap(fingerprint => [fingerprint.id + 'Count', fingerprint.id + 'Checksum']))
    expect(probe.status).toHaveLength(L.statuses)
    expect(liveArgsSchemas['ssis.catalog'].safeParse({}).success).toBe(false)
  })
  it('stays erasable TypeScript that plain Node loads, as the fake backend does', () => {
    const file = join('src', 'shared', 'live', 'catalog.ts')
    expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' })).not.toThrow()
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)})`], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
  it('generates the backend\'s embedded catalogue and docs/live.md', async () => {
    const json = liveCatalogJson()
    expect(JSON.parse(json)).toMatchObject({ version: 1, limits: { ...L, eventBody: limits.eventBody } })
    await expect(json).toMatchFileSnapshot('../backend/Varia.Backend/Live/live-catalog.json')
    await expect(renderLiveDocs()).toMatchFileSnapshot('../docs/live.md')
  })
})
