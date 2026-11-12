import { describe, expect, it } from 'vitest'
import { fileViews, rowTones, tableSpecs } from '../src/shared/activity/catalog'
import { activityLiveArgsSchema } from '../src/shared/activity/schema'
import { liveProbes } from '../src/shared/live/catalog'
import { defaultFilesFilter, defaultProcessesFilter, defaultWaitsFilter, monitorArgs, type FilesFilter, type WaitsFilter } from '../src/renderer/src/activity/ActivityMonitorService'
import { MetricRing } from '../src/renderer/src/live/ring'
import { errorLatencyMs, fileToneLabel, filesStatus, resourceEmptyNote, resourceTableIndex, sampleRated, waitsStatus, type ResourceFacts } from '../src/renderer/src/activity/panes/ResourcePanes'

const facts = (patch: Partial<ResourceFacts>): ResourceFacts => ({ rows: 3, live: true, waiting: 'loading', refused: false, ...patch })
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
    // The backend keeps the first files by database and file id (ActivitySql), not the busiest.
    expect(filesStatus(files(), facts({ rows: 10_000, truncated: 'rowLimit' }))).toBe('10,000 files · warning at 20 ms, error at 50 ms · the first 10,000 by database and file id')
    expect([errorLatencyMs({ warningMs: 20, errorMs: 50 }), errorLatencyMs({ warningMs: 80, errorMs: 50 })]).toEqual([50, 80])
  })
  it('show an empty note only while the table is current and empty', () => {
    expect(resourceEmptyNote('waitCategories', facts({ rows: 0 }), undefined)).toBe('No wait time in the interval. Wait categories appear here as tasks wait on resources.')
    expect(resourceEmptyNote('waitTypes', facts({ rows: 0 }), undefined)).toBe('No wait time in the interval. Wait types appear here as tasks wait on resources.')
    expect(resourceEmptyNote('fileIo', facts({ rows: 0 }), undefined, 'overThreshold')).toBe('No file reached the latency warning threshold in the interval.')
    expect(resourceEmptyNote('fileIo', facts({ rows: 0 }), undefined, 'log')).toBe('No log files.')
    expect([
      resourceEmptyNote('waitCategories', facts({ rows: 2 }), undefined), resourceEmptyNote('waitCategories', facts({ rows: 0, live: false }), undefined),
      resourceEmptyNote('fileIo', facts({ rows: 0 }), { kind: 'failing', message: 'x' }), resourceEmptyNote('fileIo', facts({ rows: undefined }), undefined),
      resourceEmptyNote('fileIo', facts({ rows: 0, pending: true }), undefined, 'log')
    ]).toEqual([undefined, undefined, undefined, undefined, undefined])
  })
  it('say a sample without rates has no latencies or tones yet, rather than that no file is over the threshold', () => {
    expect(resourceEmptyNote('fileIo', facts({ rows: 0, rated: false }), undefined, 'overThreshold')).toBe('Latencies arrive with the next sample: files over the warning threshold appear then.')
    expect(filesStatus(files({ view: 'overThreshold' }), facts({ rows: 0, rated: false }))).toBe('No latencies yet · Over threshold only · warning at 20 ms, error at 50 ms · latencies and tones from the next sample')
    expect(filesStatus(files({ view: 'log' }), facts({ rows: 2, rated: false }))).toBe('2 files · Log only · warning at 20 ms, error at 50 ms · latencies and tones from the next sample')
    expect(waitsStatus(waits(), facts({ rows: 4, rated: false }))).toBe('4 wait categories · benign waits hidden · rates from the next sample')
  })
  it('say a new filter applies from the next sample while the rows shown predate it, counting them without the view\'s words', () => {
    expect(filesStatus(files({ view: 'log' }), facts({ rows: 5, pending: true }))).toBe('5 files · Log only · warning at 20 ms, error at 50 ms from the next sample')
    expect(filesStatus(files({ view: 'overThreshold', warningMs: 70 }), facts({ rows: 0, pending: true }))).toBe('No files · Over threshold only · warning at 70 ms, error at 70 ms from the next sample')
    expect(waitsStatus(waits({ hideBenign: false }), facts({ rows: 4, pending: true }))).toBe('4 wait categories · benign waits shown from the next sample')
    expect(waitsStatus(waits(), facts({ rows: 0, pending: true }))).toBe('No waits in the interval · benign waits hidden from the next sample')
  })
  it('read whether the latest sample had rates from its wait.signal value', () => {
    const series = liveProbes['activity.resources'].series ?? []
    const ring = new MetricRing(4, series.length)
    const handle = { ring: () => ring }
    expect(sampleRated(handle)).toBe(true)
    ring.push(1, series.map(() => null))
    expect(sampleRated(handle)).toBe(false)
    ring.push(2, series.map(() => 1))
    expect(sampleRated(handle)).toBe(true)
    expect(sampleRated({ ring: () => undefined })).toBe(true)
  })
})
