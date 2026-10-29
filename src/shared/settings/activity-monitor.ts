import { activityIntervalsSeconds, activityPanes, chartWindowsMinutes, defaultChartWindowMinutes, defaultPanes, paneSpecs, tileSpecs } from '../activity/catalog.ts'
import { liveProbes } from '../live/catalog.ts'
import type { SettingDef } from './types'

/**
 * Activity Monitor (not in SSMS, whose monitor has no options page): what a new monitor starts with, and the thresholds that
 * tint its tiles. An open monitor keeps its own interval, window and panes; thresholds apply at once. The interval choices
 * are the monitor's own UX choice, kept within what the overview probe accepts in the live catalogue, and the threshold
 * defaults are the tiles' in the Activity Monitor catalogue, so neither file states them twice.
 */
const overview = liveProbes['activity.overview'].intervalMs
const intervals = activityIntervalsSeconds.filter(seconds => seconds * 1_000 >= overview.min && seconds * 1_000 <= overview.max)
const threshold = (setting: string, bound: 'warning' | 'error'): number => {
  for (const tile of tileSpecs) for (const spec of tile.thresholds) if (spec.settings?.[bound] === setting) return spec[bound]! / (spec.settingScale ?? 1)
  throw new Error(`No Activity Monitor tile uses ${setting}.`)
}
const panes = activityPanes.map(pane => ({ value: pane, label: paneSpecs[pane].title }))
const seconds = (value: number) => `${value} ${value === 1 ? 'second' : 'seconds'}`
const minutes = (value: number) => `${value} ${value === 1 ? 'minute' : 'minutes'}`

export const activityMonitorSettings = [
  {
    key: 'activityMonitor.refreshIntervalSeconds', page: 'activityMonitor', group: 'New monitors', label: 'Refresh interval', type: 'enum', varia: true,
    values: intervals.map(value => ({ value: String(value), label: seconds(value) })), default: String(overview.default / 1_000),
    keywords: ['activity', 'monitor', 'refresh', 'interval', 'sample', 'live'],
    description: 'How often a new Activity Monitor samples the server. Resource waits and file I/O are read every 5 seconds at most, and the header changes an open monitor\'s interval.'
  },
  {
    key: 'activityMonitor.chartWindowMinutes', page: 'activityMonitor', group: 'New monitors', label: 'Chart window', type: 'enum', varia: true,
    values: chartWindowsMinutes.map(value => ({ value: String(value), label: minutes(value) })), default: String(defaultChartWindowMinutes),
    keywords: ['activity', 'monitor', 'chart', 'history', 'window', 'minutes'],
    description: 'How much time a new Activity Monitor\'s tiles and charts show. Charts reach back only as far as Environment › Live Data keeps history.'
  },
  {
    key: 'activityMonitor.primaryPane', page: 'activityMonitor', group: 'New monitors', label: 'First pane', type: 'enum', varia: true, values: panes, default: defaultPanes.primary,
    keywords: ['activity', 'monitor', 'pane', 'processes', 'split'],
    description: 'The pane a new Activity Monitor shows first (on the left, or on top in a narrow window).'
  },
  {
    key: 'activityMonitor.secondaryPane', page: 'activityMonitor', group: 'New monitors', label: 'Second pane', type: 'enum', varia: true,
    values: [...panes, { value: 'none', label: 'None (no split view)' }], default: defaultPanes.secondary,
    keywords: ['activity', 'monitor', 'pane', 'split', 'waits'],
    description: 'The pane a new Activity Monitor shows beside the first in split view. None opens it with one pane; Split View shows a second one again.'
  },
  {
    key: 'activityMonitor.cpuWarningPercent', page: 'activityMonitor', group: 'Thresholds', label: 'Processor time warning', type: 'integer', min: 50, max: 100, unit: 'percent', varia: true,
    default: threshold('activityMonitor.cpuWarningPercent', 'warning'), keywords: ['activity', 'monitor', 'cpu', 'processor', 'threshold', 'warning'],
    description: 'The % Processor Time tile is outlined as a warning from this much SQL Server CPU, and as an error from 95 %.'
  },
  {
    key: 'activityMonitor.blockedWarningSeconds', page: 'activityMonitor', group: 'Thresholds', label: 'Blocking warning after', type: 'integer', min: 1, max: 3_600, unit: 'seconds', varia: true,
    default: threshold('activityMonitor.blockedWarningSeconds', 'warning'), keywords: ['activity', 'monitor', 'blocked', 'blocking', 'threshold', 'warning'],
    description: 'The Blocked Sessions tile is outlined as a warning once a session has waited on another this long.'
  },
  {
    key: 'activityMonitor.blockedErrorSeconds', page: 'activityMonitor', group: 'Thresholds', label: 'Blocking error after', type: 'integer', min: 1, max: 3_600, unit: 'seconds', varia: true,
    default: threshold('activityMonitor.blockedErrorSeconds', 'error'), keywords: ['activity', 'monitor', 'blocked', 'blocking', 'threshold', 'error'],
    description: 'The Blocked Sessions tile is outlined as an error once a session has waited on another this long.'
  },
  {
    key: 'activityMonitor.fileLatencyWarningMs', page: 'activityMonitor', group: 'Thresholds', label: 'I/O latency warning', type: 'integer', min: 1, max: 10_000, unit: 'ms', varia: true,
    default: threshold('activityMonitor.fileLatencyWarningMs', 'warning'), keywords: ['activity', 'monitor', 'latency', 'disk', 'io', 'threshold', 'warning'],
    description: 'The Database I/O tile is outlined as a warning when reads or writes take this long on average over the interval.'
  },
  {
    key: 'activityMonitor.fileLatencyErrorMs', page: 'activityMonitor', group: 'Thresholds', label: 'I/O latency error', type: 'integer', min: 1, max: 10_000, unit: 'ms', varia: true,
    default: threshold('activityMonitor.fileLatencyErrorMs', 'error'), keywords: ['activity', 'monitor', 'latency', 'disk', 'io', 'threshold', 'error'],
    description: 'The Database I/O tile is outlined as an error when reads or writes take this long on average over the interval.'
  }
] as const satisfies readonly SettingDef[]
