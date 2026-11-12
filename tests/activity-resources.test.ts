import { describe, expect, it } from 'vitest'
import { fileViews, rowTones, tableSpecs } from '../src/shared/activity/catalog'
import { activityLiveArgsSchema } from '../src/shared/activity/schema'
import { liveProbes } from '../src/shared/live/catalog'
import { defaultFilesFilter, defaultProcessesFilter, defaultWaitsFilter, monitorArgs, type FilesFilter, type WaitsFilter } from '../src/renderer/src/activity/ActivityMonitorService'
import { errorLatencyMs, fileToneLabel, filesStatus, resourceEmptyNote, resourceTableIndex, waitsStatus } from '../src/renderer/src/activity/panes/ResourcePanes'
import type { TableFacts } from '../src/renderer/src/activity/panes/SessionTablePanes'

const facts = (patch: Partial<TableFacts>): TableFacts => ({ rows: 3, live: true, waiting: 'loading', refused: false, ...patch })
const waits = (patch: Partial<WaitsFilter> = {}): WaitsFilter => ({ ...defaultWaitsFilter, ...patch })
const files = (patch: Partial<FilesFilter> = {}): FilesFilter => ({ ...defaultFilesFilter, ...patch })

describe('Resource Waits and Data File I/O panes', () => {
  it('read the resources probe\'s tables at their places in its sample, the files table ending with its tone column', () => {
    const tables = liveProbes['activity.resources'].tables ?? []
    expect([resourceTableIndex('waitCategories'), resourceTableIndex('waitTypes'), resourceTableIndex('files')].map(index => tables[index].id)).toEqual(['waitCategories', 'waitTypes', 'files'])
    // The catalogue declares files' tones, and the backend writes them (ActivityResourceRows.Tone, checked offline); the live
    // grid reads them from the table's last column. The wait tables declare none, so they have no tone column.
    expect(tables[resourceTableIndex('files')].columns.at(-1)).toMatchObject({ id: 'ioTone', role: 'tone' })
    expect(tableSpecs.files.tones?.map(tone => rowTones[tone])).toEqual(['warning', 'error'])
    for (const table of ['waitCategories', 'waitTypes'] as const) expect(tables[resourceTableIndex(table)].columns.some(column => column.role === 'tone')).toBe(false)
  })
  it('say each file tone in words for screen readers', () => {
    expect([fileToneLabel('warning'), fileToneLabel('error'), fileToneLabel('muted')]).toEqual(['latency over the warning threshold', 'latency over the error threshold', undefined])
  })
  it('send args the live schema accepts for every view and the thresholds at their bounds', () => {
    for (const view of fileViews) for (const [warningMs, errorMs] of [[1, 1], [10_000, 10_000], [50, 20]]) {
      const args = monitorArgs({ processes: defaultProcessesFilter, waits: waits({ hideBenign: false }), files: files({ view, warningMs, errorMs }) })
      expect(activityLiveArgsSchema.safeParse(args).success, JSON.stringify(args)).toBe(true)
    }
  })
  it('give Resource Waits a status line by category or type, with what is hidden and why it is short', () => {
    expect(waitsStatus(waits(), facts({ rows: undefined }))).toBe('Waiting for the first sample…')
    expect(waitsStatus(waits(), facts({ rows: undefined, waiting: 'paused' }))).toBe('Paused: rows arrive when sampling resumes.')
    expect(waitsStatus(waits(), facts({ rows: undefined, refused: true }))).toBe('Wait statistics cannot be read on this server.')
    expect(waitsStatus(waits(), facts({ rows: 0 }))).toBe('No waits in the interval.')
    expect(waitsStatus(waits(), facts({ rows: 0, live: false }))).toBe('No waits in the last sample.')
    expect(waitsStatus(waits(), facts({ rows: 1 }))).toBe('1 wait category · benign waits hidden')
    expect(waitsStatus(waits({ hideBenign: false }), facts({ rows: 7 }))).toBe('7 wait categories')
    expect(waitsStatus(waits({ table: 'waitTypes' }), facts({ rows: 2_000, truncated: 'rowLimit' }))).toBe('2,000 wait types · benign waits hidden · the 2,000 with the most wait time')
    expect(waitsStatus(waits({ table: 'waitTypes', hideBenign: false }), facts({ rows: 12, truncated: 'queryBudget' }))).toBe('12 wait types · cut to stay inside the memory budget')
  })
  it('give Data File I/O a status line with its view and thresholds, an error threshold below the warning one acting as it', () => {
    expect(filesStatus(files(), facts({ rows: undefined, refused: true }))).toBe('File I/O statistics cannot be read on this server.')
    expect(filesStatus(files(), facts({ rows: undefined, waiting: 'stopped' }))).toBe('No rows: the monitor stopped sampling.')
    expect(filesStatus(files(), facts({ rows: 4 }))).toBe('4 files · warning at 20 ms, error at 50 ms')
    expect(filesStatus(files({ view: 'log', warningMs: 30, errorMs: 10 }), facts({ rows: 1 }))).toBe('1 file · Log only · warning at 30 ms, error at 30 ms')
    expect(filesStatus(files({ view: 'overThreshold' }), facts({ rows: 0 }))).toBe('No file over the latency threshold · warning at 20 ms, error at 50 ms')
    expect(filesStatus(files({ view: 'rows' }), facts({ rows: 0, live: false }))).toBe('No data files in the last sample · warning at 20 ms, error at 50 ms')
    expect(filesStatus(files(), facts({ rows: 10_000, truncated: 'rowLimit' }))).toBe('10,000 files · warning at 20 ms, error at 50 ms · at most 10,000 kept, the busiest first')
    expect([errorLatencyMs({ warningMs: 20, errorMs: 50 }), errorLatencyMs({ warningMs: 80, errorMs: 50 })]).toEqual([50, 80])
  })
  it('show an empty note only while the table is current and empty', () => {
    expect(resourceEmptyNote('waits', facts({ rows: 0 }), undefined)).toMatch(/^No wait time in the interval\./)
    expect(resourceEmptyNote('fileIo', facts({ rows: 0 }), undefined, 'overThreshold')).toBe('No file reached the latency warning threshold in the interval.')
    expect(resourceEmptyNote('fileIo', facts({ rows: 0 }), undefined, 'log')).toBe('No log files.')
    expect([
      resourceEmptyNote('waits', facts({ rows: 2 }), undefined), resourceEmptyNote('waits', facts({ rows: 0, live: false }), undefined),
      resourceEmptyNote('fileIo', facts({ rows: 0 }), { kind: 'failing', message: 'x' }), resourceEmptyNote('fileIo', facts({ rows: undefined }), undefined)
    ]).toEqual([undefined, undefined, undefined, undefined])
  })
})
