import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { limits } from '../src/shared/ipc/wire/protocol'
import { liveCatalogJson, liveProbeIds, liveProbes, liveSourceIds, liveSources, liveUnits, productionSourceIds } from '../src/shared/live/catalog'
import { renderLiveDocs } from '../src/shared/live/docs'
import { liveArgsSchemas } from '../src/shared/live/schema'

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
      for (const series of probe.series ?? []) { expect(series.id, id).toMatch(catalogId); expect(liveUnits).toContain(series.unit) }
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
