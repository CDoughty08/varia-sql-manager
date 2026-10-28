import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  activityBands, activityCapabilities, activityCatalogJson, activityEditions, activityIntervalDefaults, activityIntervalsSeconds, activityLimits, activityLiveUnits, activityLoadGuard, activityPanes, activityPoolSuffix, activityProbes,
  activitySource, activityTables, benignWaits, blockerLabels, defaultPanes, maxExpandedTiles, paneSpecs, probeIntervalMs, probeSeries, probeSpecs, rankChips, rowTones, seriesSpecs, tableSpecs,
  tileSpecs, variaSessionKinds, viewChips, viewChipTitles, waitCategories, waitCategoryIds, waitExceptions, waitsChartSeries, waitToggles
} from '../src/shared/activity/catalog'
import { copyKeys, renderActivityMonitorDocs } from '../src/shared/activity/docs'
import { activityFilterSchema } from '../src/shared/activity/schema'
import { defaultRules, keybindingLabel, platforms, reservedReason } from '../src/shared/commands/keybindings'

describe('activity monitor catalogue', () => {
  it('declares one live source with SSMS\'s panes in SSMS\'s order and four probes, each pane fed by its probe', () => {
    expect([activitySource, activityPoolSuffix]).toEqual(['activity', ' - Activity Monitor'])
    expect(activityProbes).toEqual(['activity.overview', 'activity.sessions', 'activity.resources', 'activity.queries'])
    expect(activityLimits.probesPerMonitor).toBe(activityProbes.length)
    expect(activityPanes.map(pane => paneSpecs[pane].title)).toEqual(['Processes', 'Blocking', 'Resource Waits', 'Data File I/O', 'Recent Expensive Queries', 'Active Expensive Queries'])
    for (const pane of activityPanes) {
      const spec = paneSpecs[pane]
      for (const table of spec.tables) expect(probeSpecs[spec.probe].tables, `${pane} ${table}`).toContain(table)
    }
    // Every table belongs to exactly one probe, which lists it, and some pane shows it.
    for (const table of activityTables) {
      expect(activityProbes.filter(probe => probeSpecs[probe].tables.includes(table)), table).toEqual([tableSpecs[table].probe])
      expect(activityPanes.some(pane => paneSpecs[pane].tables.includes(table)), table).toBe(true)
    }
    expect(defaultPanes).toEqual({ primary: 'processes', secondary: 'waits' })
    // The owner's name for the grid (SSMS's), with "sessions" as a palette keyword later.
    expect(tableSpecs.sessions.title).toBe('Processes')
  })
  it('samples every 2 s by default within SSMS-free bounds: resources every 5 s at most, query statistics 30 s and never under 15 s', () => {
    expect(activityIntervalsSeconds).toEqual([1, 2, 3, 5, 10, 15, 30, 60])
    expect(activityIntervalDefaults).toEqual({ refreshIntervalSeconds: 2, queriesIntervalSeconds: { default: 30, min: 15, max: 60 } })
    expect(activityIntervalsSeconds).toContain(activityIntervalDefaults.refreshIntervalSeconds)
    for (const probe of activityProbes) {
      const spec = probeSpecs[probe]
      expect(spec.minIntervalMs <= spec.floorMs && spec.floorMs <= spec.maxIntervalMs && spec.minIntervalMs <= spec.defaultIntervalMs && spec.defaultIntervalMs <= spec.maxIntervalMs, probe).toBe(true)
      expect(spec.maxIntervalMs, probe).toBe(60_000)
      expect(spec.maxDutyCycle, probe).toBe(0.2)
      expect(spec.budgetMs, probe).toBeLessThanOrEqual(10_000)
    }
    expect(activityIntervalsSeconds.map(seconds => probeIntervalMs('activity.overview', seconds))).toEqual([1_000, 2_000, 3_000, 5_000, 10_000, 15_000, 30_000, 60_000])
    expect([probeIntervalMs('activity.sessions', 1), probeIntervalMs('activity.resources', 2), probeIntervalMs('activity.resources', 10)]).toEqual([1_000, 5_000, 10_000])
    expect([probeIntervalMs('activity.queries', 2), probeIntervalMs('activity.queries', 2, 15), probeIntervalMs('activity.queries', 60, 15), probeIntervalMs('activity.queries', 2, 5)]).toEqual([30_000, 15_000, 60_000, 15_000])
    expect(probeSpecs['activity.queries']).toMatchObject({ minGapMs: 15_000, maxdop1: true, budgetMs: 10_000 })
    expect(activityLoadGuard).toEqual({ slowSamples: 3, cheapSamples: 10 })
  })
  it('declares the live catalogue\'s per-probe fields, so contributing the probes to it is mechanical', () => {
    // A probe without filterMode refuses filters in the live layer; the metrics probe has no tables to filter.
    for (const probe of activityProbes) expect([probe, probeSpecs[probe].filterMode, probeSpecs[probe].hidden]).toEqual([probe, probeSpecs[probe].tables.length ? 'memory' : undefined, 'pause'])
    // L1a's liveUnits plus seconds, which the activity probes add for page life expectancy.
    expect(activityLiveUnits).toEqual(['perSecond', 'percent', 'ms', 'msPerSecond', 'bytesPerSecond', 'count', 'seconds'])
    for (const [id, spec] of Object.entries(seriesSpecs)) expect(activityLiveUnits, id).toContain(spec.liveUnit)
    expect(Object.entries(seriesSpecs).filter(([, spec]) => spec.liveUnit === 'seconds').map(([id]) => id)).toEqual(['pageLifeExpectancy'])
    expect([seriesSpecs.ioMegabytes!.liveUnit, seriesSpecs.waitingTasks!.liveUnit, seriesSpecs.cpuPercent!.liveUnit]).toEqual(['bytesPerSecond', 'msPerSecond', 'percent'])
  })
  it('cites the results grid\'s copy keys as the commands catalogue binds them on each platform', () => {
    for (const [id, labels] of Object.entries(copyKeys)) {
      for (const platform of platforms) {
        const rule = defaultRules(platform).find(entry => entry.command === id)
        expect(rule && keybindingLabel(rule.chords, platform).text, `${id} ${platform}`).toBe(platform === 'darwin' ? labels.darwin : labels.other)
      }
    }
  })
  it('gives every column a unique id and caption, a unit unless it is text, a time or a flag, and keys, sorts, filters and facets that exist', () => {
    for (const table of activityTables) {
      const spec = tableSpecs[table], ids = spec.columns.map(column => column.id)
      expect(new Set(ids).size, table).toBe(ids.length)
      expect(new Set(spec.columns.map(column => column.caption)).size, table).toBe(ids.length)
      for (const column of spec.columns) {
        const unitless = column.type === 'text' || column.type === 'datetime' || column.type === 'bool'
        expect(column.unit === '', `${table}.${column.id}`).toBe(unitless)
        expect(column.note.length, `${table}.${column.id}`).toBeGreaterThan(0)
        expect(/^[a-z][A-Za-z]*$/.test(column.id), `${table}.${column.id}`).toBe(true)
      }
      for (const id of [...spec.key, ...spec.identity ?? [], ...spec.defaultSort.map(sort => sort.column), ...spec.textColumns ?? [], ...spec.facetColumns ?? []]) expect(ids, `${table} ${id}`).toContain(id)
      expect((spec.facetColumns ?? []).every(id => spec.textColumns?.includes(id)), table).toBe(true)
      expect(spec.facetColumns?.length ?? 0).toBeLessThanOrEqual(activityLimits.facetColumns)
      expect(ids.length, table).toBeLessThanOrEqual(activityLimits.columnsPerProjection)
    }
    expect(tableSpecs.sessions.facetColumns).toEqual(['login', 'database', 'application', 'hostName', 'waitType', 'command', 'status'])
    expect(Object.keys(rankChips).map(chip => rankChips[chip as keyof typeof rankChips].column).every(column => tableSpecs.recentQueries.columns.some(spec => spec.id === column))).toBe(true)
    expect(tableSpecs.recentQueries.columns.filter(column => column.capability).map(column => [column.id, column.capability])).toEqual([['spills', 'totalSpills']])
    expect(activityCapabilities).toEqual(['totalSpills'])
  })
  it('keeps the Processes columns DBAs need visible: Blocked By, Host, Application and Elapsed', () => {
    const visible = tableSpecs.sessions.columns.filter(column => column.visible).map(column => column.caption)
    for (const caption of ['Session ID', 'Status', 'Blocked By', 'Head Blocker', 'Blocking', 'Host Name', 'Application', 'Elapsed (s)', 'Open Transactions', 'Wait Type']) expect(visible).toContain(caption)
    expect(tableSpecs.sessions.columns.find(column => column.id === 'openTransactions')).toMatchObject({ parity: 'fix', type: 'int', unit: 'count' })
  })
  it('caps every table at the limits D-am binds, sessions at 10,000', () => {
    expect([tableSpecs.sessions.rowCap, tableSpecs.blocking.rowCap, tableSpecs.activeQueries.rowCap, tableSpecs.waitTypes.rowCap, tableSpecs.files.rowCap, tableSpecs.recentQueries.rowCap])
      .toEqual([activityLimits.sessions, activityLimits.blockingRows, activityLimits.activeQueries, activityLimits.waitTypes, activityLimits.files, activityLimits.shownHashes])
    expect(tableSpecs.waitCategories.rowCap).toBe(waitCategories.length)
    expect(activityLimits).toMatchObject({ sessions: 10_000, blockingEdges: 20_000, blockingDepth: 32, killSessions: 64, filterText: 400, columnFilters: 8, columnFilterValues: 50, columnFilterChars: 256,
      facetValues: 100, facetChars: 128, detailsChars: 1_000_000, sessionId: 32_767 })
  })
  it('uses only generic row tones, so the grid needs no Activity Monitor colour keys', () => {
    expect(new Set(Object.values(rowTones))).toEqual(new Set(['error', 'warning', 'running', 'muted']))
    expect(rowTones).toMatchObject({ blocked: 'error', blocking: 'warning', rollback: 'running', departed: 'muted', system: 'muted' })
    for (const table of activityTables) if (tableSpecs[table].departedLinger) expect(tableSpecs[table].tones, table).toContain('departed')
  })
  it('draws SSMS\'s four charts first, expands two of them on first open, and every tile series exists', () => {
    expect(tileSpecs.map(tile => tile.caption)).toEqual(['% Processor Time', 'Waiting Tasks', 'Database I/O', 'Batch Requests/sec', 'Blocked Sessions', 'Active Requests', 'CPU Pressure', 'Memory Grants Pending'])
    expect(tileSpecs.filter(tile => tile.defaultExpanded).map(tile => tile.caption)).toEqual(['% Processor Time', 'Waiting Tasks'])
    expect(tileSpecs.filter(tile => tile.defaultExpanded).length).toBeLessThanOrEqual(maxExpandedTiles)
    const overview = probeSeries('activity.overview')
    for (const tile of tileSpecs) {
      for (const series of [tile.series, ...tile.secondary, ...tile.thresholds.flatMap(spec => [spec.series, ...spec.while ? [spec.while] : []])]) expect(overview, `${tile.caption} ${series}`).toContain(series)
    }
    for (const probe of activityProbes) for (const series of probeSeries(probe)) expect(seriesSpecs[series] ?? (series.startsWith('wait.') && waitCategoryIds.includes(series.slice(5))), `${probe} ${series}`).toBeTruthy()
    expect(probeSeries('activity.resources')).toHaveLength(waitCategories.length + 1)
    // Five categorical hues and Other in gray: status colours never carry a series.
    expect(waitsChartSeries).toBe(5)
  })
  it('maps Query Store\'s 24 categories in its order, with prefixes only and each name in one place', () => {
    expect(waitCategories.map(category => [category.value, category.label])).toEqual([
      [0, 'Unknown'], [1, 'CPU'], [2, 'Worker Thread'], [3, 'Lock'], [4, 'Latch'], [5, 'Buffer Latch'], [6, 'Buffer IO'], [7, 'Compilation'], [8, 'SQL CLR'], [9, 'Mirroring'], [10, 'Transaction'],
      [11, 'Idle'], [12, 'Preemptive'], [13, 'Service Broker'], [14, 'Tran Log IO'], [15, 'Network IO'], [16, 'Parallelism'], [17, 'Memory'], [18, 'User Wait'], [19, 'Tracing'], [20, 'Full Text Search'],
      [21, 'Other Disk IO'], [22, 'Replication'], [23, 'Log Rate Governor']
    ])
    for (const category of waitCategories) for (const pattern of category.patterns) expect(/^[A-Z_]+%$/.test(pattern), pattern).toBe(true)
    const names = waitCategories.flatMap(category => category.names).concat(benignWaits.map(wait => wait.name))
    // Exceptions are the only names listed twice: in their category and again as exceptions.
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])
    for (const exception of waitExceptions) expect(waitCategories.find(category => category.id === exception.category)?.names, exception.name).toContain(exception.name)
    expect(benignWaits.every(wait => wait.reason.endsWith('.'))).toBe(true)
    expect(benignWaits.map(wait => wait.name)).toEqual([...benignWaits.map(wait => wait.name)].sort())
  })
  it('names the meaning of negative blocking ids, Varia\'s session suffixes, and the servers it serves', () => {
    expect(blockerLabels).toEqual({ '-2': 'Orphaned DTC', '-3': 'Deferred recovery', '-4': 'Latch owner unknown', '-5': 'Latch owner not tracked' })
    expect(variaSessionKinds.filter(kind => kind.kind === 'queryTab').map(kind => kind.suffix)).toEqual([''])
    expect(variaSessionKinds.map(kind => kind.suffix)).toContain(activityPoolSuffix)
    expect(Object.values(activityEditions).flatMap(spec => spec.editions).sort()).toEqual([1, 2, 3, 4, 5, 8])
    expect(Object.entries(activityEditions).filter(([, spec]) => spec.available).map(([id]) => id)).toEqual(['box', 'managedInstance'])
    expect(activityBands).toEqual({ min: 13, max: 17 })
    // SSMS opens Activity Monitor with Ctrl+Alt+A. Varia reserves Ctrl+Alt+letter on Windows and Linux (AltGr types
    // characters there, Polish ą among them), so only macOS's ⌘⌥A is free for the document's PR; nothing takes either yet.
    for (const platform of platforms) {
      const chord = platform === 'darwin' ? 'alt+meta+a' : 'ctrl+alt+a'
      expect([reservedReason(chord, platform), defaultRules(platform).filter(rule => rule.chords[0] === chord).length], platform)
        .toEqual([platform === 'darwin' ? undefined : 'AltGr types characters with Ctrl+Alt', 0])
    }
  })
  it('validates filters strictly: Processes-only fields, facet columns, one filter per column, and the bounds', () => {
    const ok = (value: unknown) => activityFilterSchema.safeParse(value).success
    expect(ok({ table: 'sessions', view: 'blocked', showSystem: true, showVaria: false, text: 'app', columnFilters: [{ column: 'login', values: ['sa'] }, { column: 'database', blanks: true }] })).toBe(true)
    expect(viewChips.every(view => ok({ table: 'sessions', view }) && viewChipTitles[view].length > 0)).toBe(true)
    expect(ok({ table: 'files', text: 'tempdb' })).toBe(true)
    // Hide benign waits: Resource Waits' two tables only, on by default.
    expect([ok({ table: 'waitTypes', hideBenign: false }), ok({ table: 'waitCategories', hideBenign: true }), ok({ table: 'sessions', hideBenign: true }), ok({ table: 'files', hideBenign: false })])
      .toEqual([true, true, false, false])
    expect(waitToggles.hideBenign).toMatchObject({ tables: ['waitCategories', 'waitTypes'], default: true })
    for (const bad of [
      { table: 'files', view: 'all' }, { table: 'waitTypes', showSystem: true }, { table: 'sessions', view: 'sleeping' }, { table: 'nope' }, { table: 'sessions', extra: 1 },
      { table: 'sessions', text: 'x'.repeat(activityLimits.filterText + 1) }, { table: 'sessions', columnFilters: [{ column: 'sessionId', values: ['1'] }] },
      { table: 'sessions', columnFilters: [{ column: 'login', values: ['a'] }, { column: 'login', values: ['b'] }] }, { table: 'sessions', columnFilters: [{ column: 'login' }] },
      { table: 'sessions', columnFilters: [{ column: 'login', values: Array.from({ length: activityLimits.columnFilterValues + 1 }, (_, index) => String(index)) }] },
      { table: 'sessions', columnFilters: [{ column: 'login', values: ['x'.repeat(activityLimits.columnFilterChars + 1)] }] },
      { table: 'sessions', columnFilters: [{ column: 'login', values: ['a'], other: true }] },
      { table: 'sessions', columnFilters: Array.from({ length: activityLimits.columnFilters + 1 }, () => ({ column: 'login', values: ['a'] })) }
    ]) expect(ok(bad), JSON.stringify(bad).slice(0, 120)).toBe(false)
  })
  it('loads in plain Node 24, as the fake backend and scripts load the other catalogues', () => {
    const files = ['catalog.ts', 'schema.ts', 'docs.ts'].map(name => join('src', 'shared', 'activity', name))
    for (const file of files) expect(() => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }), file).not.toThrow()
    const script = files.map(file => `await import(${JSON.stringify(pathToFileURL(file).href)})`).join(';')
    const result = spawnSync(process.execPath, ['--input-type=module', '--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
  it('keeps the backend\'s embedded copy and docs/activity-monitor.md in sync', async () => {
    await expect(activityCatalogJson()).toMatchFileSnapshot('../backend/Varia.Backend/Activity/activity-catalog.json')
    await expect(renderActivityMonitorDocs()).toMatchFileSnapshot('../docs/activity-monitor.md')
  })
  it('embeds the catalogue in the backend build', () => {
    expect(readFileSync(join('backend', 'Varia.Backend', 'Varia.Backend.csproj'), 'utf8')).toContain('<EmbeddedResource Include="Activity/activity-catalog.json" LogicalName="Varia.Backend.Activity.activity-catalog.json" />')
  })
})
