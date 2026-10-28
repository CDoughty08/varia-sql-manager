import { describe, expect, it } from 'vitest'
import { activityIntervalsSeconds, grantStatement, serverStatePermission, tileSpecs, unavailableMessage } from '../src/shared/activity/catalog'
import { liveProbes } from '../src/shared/live/catalog'
import { defaultSettings, settingDef, settingDefs } from '../src/shared/settings/catalog'
import { chartScaleOf, latestValue, monitorFacts, overviewNotice, seriesIndex, tileReading, tileReadings, tileTone, toneAnnouncement } from '../src/renderer/src/activity/tiles'
import type { LiveSnapshot } from '../src/renderer/src/live/LiveService'
import { MetricRing, scaledRing } from '../src/renderer/src/live/ring'
import { freshness, pillStatus } from '../src/renderer/src/live/status'

const overviewSeries = liveProbes['activity.overview'].series!.length
/** An overview ring with one sample: the named series set, the rest missing. */
function ring(values: Readonly<Record<string, number>>, samples = 1): MetricRing {
  const result = new MetricRing(16, overviewSeries)
  for (let sample = 0; sample < samples; sample++) {
    const row: (number | null)[] = Array.from({ length: overviewSeries }, () => null)
    for (const [id, value] of Object.entries(values)) row[seriesIndex(id)] = value
    result.push(1_000 * (sample + 1), row)
  }
  return result
}
const tile = (caption: string) => tileSpecs.find(spec => spec.caption === caption)!

describe('Activity Monitor tiles', () => {
  it('read the newest sample in the tile\'s unit: bytes a second as MB/s, wait milliseconds a second as tasks', () => {
    const values = ring({ ioMegabytes: 3 * 1_048_576, waitingTasks: 2_100, cpuPercent: 34 })
    expect([latestValue(values, 'ioMegabytes'), latestValue(values, 'waitingTasks'), latestValue(values, 'cpuPercent')]).toEqual([3, 2.1, 34])
    // A rate's first sample has no value; a series the catalogue does not send has none either.
    expect([latestValue(values, 'batchRequests'), latestValue(values, 'nope'), latestValue(undefined, 'cpuPercent')].every(Number.isNaN)).toBe(true)
  })
  it('say each value with its unit and secondary figures, leaving out what has no value yet', () => {
    const values = ring({ cpuPercent: 34.4, schedulerDelay: 12, ioMegabytes: 18.4 * 1_048_576, readLatency: 3, writeLatency: 5.25, batchRequests: 1_284, runnablePerScheduler: 0.42 })
    const readings = tileReadings(values, defaultSettings)
    expect(readings[0]).toEqual({ caption: '% Processor Time', value: '34.4', unit: '%', context: 'Scheduler delay 12 ms/s' })
    expect(readings[2]).toEqual({ caption: 'Database I/O', value: '18.4', unit: 'MB/s', context: 'Read latency 3 ms · Write latency 5.3 ms' })
    expect(readings[3]).toEqual({ caption: 'Batch Requests/sec', value: '1,284', unit: '/s' })
    expect(readings[6]).toEqual({ caption: 'CPU Pressure', value: '0.42', unit: 'per scheduler' })
    // Before the first sample: no value, so the tile shows a dash.
    expect(tileReading(tileSpecs[1], undefined, defaultSettings)).toEqual({ caption: 'Waiting Tasks', unit: 'tasks' })
  })
  it('take the worst threshold crossed, from the settings where a threshold has them', () => {
    const tone = (caption: string, values: Readonly<Record<string, number>>, settings = {}) => tileTone(tile(caption), id => latestValue(ring(values), id), { ...defaultSettings, ...settings })
    expect([tone('% Processor Time', { cpuPercent: 79 }), tone('% Processor Time', { cpuPercent: 80 }), tone('% Processor Time', { cpuPercent: 95 })]).toEqual([undefined, 'warning', 'critical'])
    expect(tone('% Processor Time', { cpuPercent: 85 }, { 'activityMonitor.cpuWarningPercent': 90 })).toBeUndefined()
    // The longest block counts only while sessions are blocked, against settings in seconds.
    expect([tone('Blocked Sessions', { blockedSessions: 1, longestBlock: 6_000 }), tone('Blocked Sessions', { blockedSessions: 0, longestBlock: 60_000 }), tone('Blocked Sessions', { blockedSessions: 2, longestBlock: 30_000 })])
      .toEqual(['warning', undefined, 'critical'])
    expect(tone('Blocked Sessions', { blockedSessions: 1, longestBlock: 6_000 }, { 'activityMonitor.blockedWarningSeconds': 10 })).toBeUndefined()
    expect([tone('Database I/O', { readLatency: 25 }), tone('Database I/O', { readLatency: 1, writeLatency: 50 }), tone('Database I/O', { readLatency: 60 }, { 'activityMonitor.fileLatencyErrorMs': 100 })]).toEqual(['warning', 'critical', 'warning'])
    expect([tone('CPU Pressure', { runnablePerScheduler: 1.2, workQueue: 0 }), tone('CPU Pressure', { runnablePerScheduler: 0.1, workQueue: 1 }), tone('Memory Grants Pending', { grantsPending: 1 })]).toEqual(['warning', 'critical', 'warning'])
    expect(tone('Waiting Tasks', { waitingTasks: 1e9 })).toBeUndefined()
  })
  it('announce a threshold once, as it is crossed upward', () => {
    expect(toneAnnouncement('% Processor Time', undefined, 'warning')).toBe('% Processor Time is above its warning threshold.')
    expect(toneAnnouncement('% Processor Time', 'warning', 'critical')).toBe('% Processor Time is above its critical threshold.')
    expect([toneAnnouncement('A', 'warning', 'warning'), toneAnnouncement('A', 'critical', 'warning'), toneAnnouncement('A', 'warning', undefined)]).toEqual([undefined, undefined, undefined])
  })
  it('chart each series in a unit its labels can say, CPU up to 100 %', () => {
    expect(chartScaleOf('waitingTasks')).toEqual({ scale: { unit: 'count' }, factor: 0.001 })
    expect(chartScaleOf('cpuPercent')).toEqual({ scale: { unit: 'percent', max: 100 }, factor: 1 })
    expect(chartScaleOf('ioMegabytes')).toEqual({ scale: { unit: 'bytesPerSecond' }, factor: 1 })
    expect(chartScaleOf('pageLifeExpectancy')).toEqual({ scale: { unit: 'seconds' }, factor: 1 })
  })
})

describe('scaled rings', () => {
  it('read the ring\'s values times the factor, with its own times, flags and revision, one view per ring and factor', () => {
    const source = ring({ waitingTasks: 2_000 }, 3), view = scaledRing(source, 0.001), index = seriesIndex('waitingTasks')
    expect([view.value(2, index), view.minMax(index, 0, 3), view.length, view.time(1), view.lastTime]).toEqual([2, [2, 2], 3, 2_000, 3_000])
    expect(scaledRing(source, 0.001)).toBe(view)
    expect(scaledRing(source, 1)).toBe(source)
    const revision = view.revision
    source.push(4_000, Array.from({ length: overviewSeries }, () => 500))
    expect([view.revision > revision, view.value(3, index)]).toEqual([true, 0.5])
  })
})

describe('Activity Monitor header state', () => {
  const probe = (state: LiveSnapshot['probes'][string]['state'], intervalMs: number, extra: Partial<LiveSnapshot['probes'][string]> = {}) => ({ state, intervalMs, effectiveIntervalMs: intervalMs, ...extra })
  const snapshot = (status: LiveSnapshot['status'], probes: LiveSnapshot['probes'], extra: Partial<LiveSnapshot> = {}): LiveSnapshot => ({ status, probes, connectionId: 'c', ...extra })
  it('gives the states kit\'s pill the pace of the probes that run, slowed when the backend runs one slower', () => {
    const probes = { 'activity.overview': probe('fresh', 2_000), 'activity.sessions': probe('paused', 1_000), 'activity.resources': probe('unavailable', 5_000) }
    expect(pillStatus(snapshot('live', probes))).toEqual({ state: 'live', intervalMs: 2_000 })
    expect(pillStatus(snapshot('live', { ...probes, 'activity.overview': probe('fresh', 2_000, { effectiveIntervalMs: 4_000 }) }))).toEqual({ state: 'slowed', intervalMs: 2_000, effectiveMs: 4_000 })
    expect(pillStatus(snapshot('paused', probes, { pausedBy: 'user' }))).toEqual({ state: 'paused', intervalMs: 2_000, pausedBy: 'user' })
    expect(pillStatus(snapshot('ended', probes, { ended: { ended: 'disconnected', ticks: 3, elapsedMs: 1 } }))).toEqual({ state: 'ended', intervalMs: 2_000, ended: 'disconnected' })
    expect([pillStatus(snapshot('connecting', {})), pillStatus(snapshot('lost', probes)), pillStatus(snapshot('dormant', probes))].map(status => status?.state)).toEqual(['connecting', 'lost', 'dormant'])
    // Live, with nothing that can run (no permission for the overview, the panes' probes paused): no pill claims it is live.
    expect(pillStatus(snapshot('live', { ...probes, 'activity.overview': probe('unavailable', 2_000) }))).toBeUndefined()
  })
  it('dates the data by its newest running sample, and marks it stale from the oldest late one', () => {
    const probes = { 'activity.overview': probe('fresh', 2_000, { lastSampleAt: 9_000 }), 'activity.sessions': probe('paused', 2_000, { lastSampleAt: 9_500 }) }
    expect(freshness(snapshot('live', probes), 10_000)).toEqual({ updatedAt: 9_000 })
    expect(freshness(snapshot('live', { ...probes, 'activity.overview': probe('failing', 2_000, { lastSampleAt: 4_000 }) }), 10_000)).toEqual({ updatedAt: 4_000, stale: { since: 4_000 } })
    // Paused is not stale: the pill says why nothing new arrives.
    expect(freshness(snapshot('paused', { 'activity.overview': probe('paused', 2_000, { lastSampleAt: 4_000 }) }), 10_000)).toEqual({})
    expect(freshness(snapshot('live', {}), 10_000)).toEqual({})
  })
  it('says why the overview shows nothing new: no permission at open or found later, a server it does not cover, a failed sample', () => {
    const error = (code: 'PERMISSION_DENIED' | 'BLOCKED', terminal: boolean) => ({ probe: 'activity.overview' as const, code, message: code === 'BLOCKED' ? 'Blocked by a lock.' : 'No permission.', retryInMs: 4_000, terminal })
    const overview = (extra: Partial<LiveSnapshot['probes'][string]>, state: LiveSnapshot['probes'][string]['state'] = 'fresh') => snapshot('live', { 'activity.overview': probe(state, 2_000, extra) })
    expect(overviewNotice(overview({}))).toBeUndefined()
    expect(overviewNotice(overview({ reason: 'PERMISSION_DENIED', note: 'x' }, 'unavailable'))).toEqual({ kind: 'permission' })
    // AM1's sampler stops a server-state probe for good when the session probe finds the permission gone after open.
    expect(overviewNotice(overview({ error: error('PERMISSION_DENIED', true) }, 'failing'))).toEqual({ kind: 'permission' })
    expect(overviewNotice(overview({ reason: 'NOT_SUPPORTED', note: 'Some note.' }, 'unavailable'))).toEqual({ kind: 'unavailable', message: unavailableMessage })
    expect(overviewNotice(overview({ error: error('BLOCKED', false) }, 'failing'))).toEqual({ kind: 'failing', code: 'BLOCKED', message: 'Blocked by a lock.' })
    // A probe that recovered keeps no notice, and a view without the probe has none.
    expect(overviewNotice(overview({ error: error('BLOCKED', false) }, 'fresh'))).toBeUndefined()
    expect(overviewNotice(snapshot('live', {}))).toBeUndefined()
  })
  it('lists only the facts the connection has in the header', () => {
    expect(monitorFacts(undefined)).toEqual([])
    expect(monitorFacts({ server: 'sql01', productVersion: '17.0.1000.7', serverVersion: '17.00.1000', engineEdition: 3, login: 'CONTOSO\\dba' }))
      .toEqual([{ label: 'Server', value: 'sql01' }, { label: 'Version', value: '17.0.1000.7' }, { label: 'Login', value: 'CONTOSO\\dba' }])
    expect(monitorFacts({ server: 'mi.contoso', serverVersion: '12.00.2000', engineEdition: 8 }))
      .toEqual([{ label: 'Server', value: 'mi.contoso' }, { label: 'Version', value: '12.00.2000' }, { label: 'Kind', value: 'Azure SQL Managed Instance' }])
  })
})

describe('Activity Monitor settings and permissions', () => {
  it('offer the monitor\'s intervals within the overview probe\'s live bounds, and the tiles\' thresholds as defaults', () => {
    const interval = settingDef('activityMonitor.refreshIntervalSeconds')
    const bounds = liveProbes['activity.overview'].intervalMs
    expect(interval.type === 'enum' && interval.values.map(value => Number(value.value))).toEqual(activityIntervalsSeconds.filter(seconds => seconds * 1_000 >= bounds.min && seconds * 1_000 <= bounds.max))
    expect(defaultSettings['activityMonitor.refreshIntervalSeconds']).toBe(String(bounds.default / 1_000))
    // Every threshold a tile reads from settings is one, defaulting to the tile's own bound.
    for (const spec of tileSpecs.flatMap(entry => entry.thresholds)) for (const bound of ['warning', 'error'] as const) {
      const key = spec.settings?.[bound]
      if (!key) continue
      expect(settingDefs.some(def => def.key === key), key).toBe(true)
      expect((defaultSettings as Record<string, unknown>)[key], key).toBe(spec[bound]! / (spec.settingScale ?? 1))
    }
    expect(settingDefs.filter(def => def.page === 'activityMonitor').every(def => def.varia)).toBe(true)
  })
  it('name the permission the server needs, and quote any login in the GRANT statement it offers', () => {
    expect([serverStatePermission(16), serverStatePermission(17), serverStatePermission(15), serverStatePermission(undefined), serverStatePermission(16, 8)])
      .toEqual(['VIEW SERVER PERFORMANCE STATE', 'VIEW SERVER PERFORMANCE STATE', 'VIEW SERVER STATE', 'VIEW SERVER STATE', 'VIEW SERVER STATE'])
    expect(grantStatement('CONTOSO\\dba', 17)).toBe('GRANT VIEW SERVER PERFORMANCE STATE TO [CONTOSO\\dba];')
    expect(grantStatement('x]; DROP LOGIN sa; --', 15)).toBe('GRANT VIEW SERVER STATE TO [x]]; DROP LOGIN sa; --];')
  })
})
