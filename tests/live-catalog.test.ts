import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { limits } from '../src/shared/ipc/wire/protocol'
import { defaultBudgetMs, liveCatalogJson, liveCounters, liveProbeIds, liveProbes, liveSourceIds, liveSources, liveUnits, productionSourceIds } from '../src/shared/live/catalog'
import { renderLiveDocs } from '../src/shared/live/docs'
import { liveArgsSchemas } from '../src/shared/live/schema'
import { catalogFingerprints } from '../src/shared/ssis/catalog'

const L = limits.live
const catalogId = /^[a-z][A-Za-z0-9]{0,31}$/

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
      for (const series of probe.series ?? []) { expect(series.id, id).toMatch(catalogId); expect(liveUnits).toContain(series.unit); expect(liveCounters).toContain(series.counter) }
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
        for (const column of table.columns) expect(column.id, id).toMatch(catalogId)
        for (const key of table.key) expect(table.columns.map(column => column.id), id).toContain(key)
      }
      expect((probe.status ?? []).length, id).toBeLessThanOrEqual(L.statuses)
      for (const status of probe.status ?? []) expect(status, id).toMatch(catalogId)
      for (const view of probe.views ?? []) expect(view, id).toMatch(catalogId)
      expect((probe.series ?? []).length + tables.length + (probe.status ?? []).length, id).toBeGreaterThan(0)
    }
  })
  it('gives every source its args schema, and keeps test-only sources out of production', () => {
    expect(Object.keys(liveArgsSchemas).sort()).toEqual([...liveSourceIds].sort())
    expect(productionSourceIds).toEqual(liveSourceIds.filter(id => !liveSources[id].testOnly))
    expect(liveSources['debug.synthetic']).toMatchObject({ testOnly: true, scope: 'none' })
    expect(productionSourceIds).toEqual(['activity', 'ssis.catalog'])
    expect(liveSources.activity).toMatchObject({ testOnly: false, scope: 'server', probes: ['activity.overview'] })
    // The Activity Monitor's overview: 2 s by default (owner decision), never below 1 s, a 0.2 load guard, server state.
    expect(liveProbes['activity.overview']).toMatchObject({ intervalMs: { default: 2000, min: 1000 }, maxDutyCycle: 0.2, permission: 'serverState', gates: { minMajor: 13 } })
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
