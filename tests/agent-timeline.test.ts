import { describe, expect, it } from 'vitest'
import { freq, noEndDate, subday, type AgentScheduleTiming } from '../src/shared/agent/schedule'
import { timelineClock, timelineLimits, timelineModel, timelineText, usualText, type TimelineJobInput } from '../src/shared/agent/timeline'

// Sunday 2026-11-22 14:30, server time (the mock's now).
const now = { date: 20261122, time: 143000 }
const timing = (patch: Partial<AgentScheduleTiming> = {}): AgentScheduleTiming => ({
  freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
  activeStartDate: 20260101, activeEndDate: noEndDate, activeStartTime: 10000, activeEndTime: 235959, ...patch
})
const job = (id: string, name: string, patch: Partial<TimelineJobInput> = {}, schedule: Partial<AgentScheduleTiming> = {}, scheduleId = 1): TimelineJobInput =>
  ({ id, name, enabled: true, schedules: [{ id: scheduleId, name: `${name} schedule`, enabled: true, timing: timing(schedule) }], ...patch })

describe('the Schedules Timeline', () => {
  const backup = job('A', 'Nightly full backup – Sales', { usualSeconds: 21 * 60 + 10 }, { activeStartTime: 10000 }, 1)
  const logs = job('B', 'Log backup – Sales', { usualSeconds: 4 }, { freqSubdayType: subday.minutes, freqSubdayInterval: 15, activeStartTime: 0 }, 2)
  const etl = job('C', 'ETL – Load warehouse', { usualSeconds: 18 * 60 }, { activeStartTime: 23000 }, 3)
  const off = job('D', 'Refresh reporting snapshot', { enabled: false, usualSeconds: 9 * 60 }, { freqType: freq.weekly, freqInterval: 62, freqRecurrenceFactor: 1, activeStartTime: 60000 }, 4)
  const day = timelineModel({ now, seconds: 86_400, jobs: [etl, backup, logs, off, job('E', 'Unscheduled', { schedules: [] })] })
  it('draws each job at its scheduled starts for its usual duration, in the order they next run', () => {
    expect(day.rows.map(row => row.name)).toEqual(['Log backup – Sales', 'Nightly full backup – Sales', 'ETL – Load warehouse', 'Refresh reporting snapshot'])
    const [logRow, backupRow, etlRow, offRow] = day.rows
    // Every 15 minutes from 14:30 to 14:15 the next day: 96 runs; the 01:00 backup is 10.5 hours in.
    expect(logRow.runs).toHaveLength(96)
    expect(backupRow.runs).toEqual([{ start: 10.5 * 3_600, seconds: 1_270, scheduleId: 1, off: false, overlap: true }])
    expect(etlRow.runs[0]).toMatchObject({ start: 12 * 3_600, seconds: 1_080, overlap: true })
    // A disabled job is drawn where it would run (Monday 06:00), dashed, and never overlaps.
    expect(offRow.runs).toEqual([{ start: 15.5 * 3_600, seconds: 540, scheduleId: 4, off: true, overlap: false }])
    expect(backupRow.label).toBe('Every day at 01:00 · ~21 min')
    expect(offRow.label).toBe('Weekdays at 06:00 · ~9 min · job disabled')
    expect(logRow.label).toBe('Every day every 15 minutes · ~4 s')
  })
  it('flags overlaps on both sides and explains each, the run the others start during first', () => {
    // 01:00 to 01:21:10 holds the log backups of 01:00, 01:15; 02:30 to 02:48 holds 02:30, 02:45.
    expect(day.overlaps.map(overlap => timelineText.overlap(day, overlap))).toEqual([
      'Overlap 01:00–01:21: Log backup – Sales runs twice during Nightly full backup – Sales.',
      'Overlap 02:30–02:48: Log backup – Sales runs twice during ETL – Load warehouse.'
    ])
    expect(day.overlaps[0]).toMatchObject({ row: 'j:a', scheduleId: 1 })
    expect(day.rows[0].runs.filter(run => run.overlap).length).toBe(4)
    expect(day.moreOverlaps).toBe(0)
    // Two log backups at the same instant from two schedules of one job are not an overlap between jobs.
    const twice = timelineModel({ now, seconds: 86_400, jobs: [{ ...logs, schedules: [logs.schedules[0], { ...logs.schedules[0], id: 9 }] }] })
    expect(twice.overlaps).toEqual([])
  })
  it('calls out a job whose usual run outlasts the gap to its next start', () => {
    const slow = timelineModel({ now, seconds: 86_400, jobs: [{ ...logs, usualSeconds: 20 * 60 }] })
    expect(slow.selfOverlaps.map(timelineText.self)).toEqual(['Log backup – Sales usually runs 20 min, longer than the 15 min between two of its starts; SQL Server Agent skips a start while the job is still running.'])
    expect(timelineModel({ now, seconds: 86_400, jobs: [{ ...logs, usualSeconds: undefined }] }).selfOverlaps).toEqual([])
  })
  it('bounds runs per row and in all, and rows, saying each cut', () => {
    const poller = job('P', 'Poller', { usualSeconds: 1 }, { freqSubdayType: subday.seconds, freqSubdayInterval: 10, activeStartTime: 0 })
    const week = timelineModel({ now, seconds: 7 * 86_400, jobs: [poller] })
    expect(week.rows[0].runs).toHaveLength(timelineLimits.runsPerRow)
    expect(week.rows[0].truncated).toBe(true)
    expect(week.runsCut).toBe(true)
    const many = Array.from({ length: 30 }, (_, index) => job(`P${index}`, `Poller ${index}`, { usualSeconds: 1 }, { freqSubdayType: subday.seconds, freqSubdayInterval: 10, activeStartTime: 0 }, index + 10))
    const capped = timelineModel({ now, seconds: 7 * 86_400, jobs: many })
    expect(capped.rows.reduce((total, row) => total + row.runs.length, 0)).toBe(timelineLimits.runs)
    const wide = timelineModel({ now, seconds: 86_400, jobs: Array.from({ length: timelineLimits.rows + 5 }, (_, index) => job(`R${index}`, `Job ${index}`, {}, {}, index + 1)) })
    expect(wide.rows).toHaveLength(timelineLimits.rows)
    expect(timelineText.rowsLeftOut(wide.rowsLeftOut)).toBe('5 more rows not drawn (the Timeline draws at most 200).')
    // Overlap notes are capped too, the rest counted.
    const crowd = timelineModel({ now, seconds: 86_400, jobs: [{ ...backup, usualSeconds: 86_400 }, logs] })
    expect(crowd.overlaps).toHaveLength(1)
    const pairs = timelineModel({ now, seconds: 86_400, jobs: [logs, { ...logs, id: 'B2', name: 'Copy', usualSeconds: 60 }] })
    expect(pairs.overlaps).toHaveLength(timelineLimits.notes)
    expect(pairs.moreOverlaps).toBe(96 - timelineLimits.notes)
  })
  it('makes schedule rows below sysadmin, and counts an every-n cycle from the next run Agent wrote', () => {
    const fortnightly = { id: 7, name: 'Fortnightly', enabled: true, timing: timing({ freqType: freq.weekly, freqInterval: 2, freqRecurrenceFactor: 2, activeStartTime: 30000 }) }
    const own = timelineModel({ now, seconds: 15 * 86_400, schedules: [fortnightly] })
    expect(own.kind).toBe('schedule')
    expect(own.rows[0]).toMatchObject({ key: 's:7', kind: 'schedule', label: 'Every Monday every 2 weeks at 03:00' })
    expect(own.rows[0].runs.map(run => timelineClock(own, run.start))).toEqual(['Mon 03:00', 'Mon 03:00'])
    expect(own.rows[0].runs.map(run => run.start / 3_600)).toEqual([12.5, 12.5 + 14 * 24])
    // Agent's next run is 30 November: the cycle follows it, not the first Monday from now.
    const anchored = timelineModel({ now, seconds: 15 * 86_400, schedules: [{ ...fortnightly, nextRun: { date: 20261130, time: 30000 } }] })
    expect(anchored.rows[0].runs.map(run => run.start / 3_600)).toEqual([12.5 + 7 * 24])
  })
  it('words times and durations', () => {
    expect(usualText(2)).toBe('~2 s')
    expect(usualText(1_080)).toBe('~18 min')
    expect(usualText(3_900)).toBe('~1 h 05 min')
    expect(timelineClock({ start: now, seconds: 86_400 }, 3_600 * 10.5)).toBe('01:00')
    expect(timelineClock({ start: now, seconds: 7 * 86_400 }, 3_600 * 10.5)).toBe('Mon 01:00')
    expect(timelineText.run(day, day.rows[1], day.rows[1].runs[0])).toBe('Nightly full backup – Sales: 01:00 to 01:21, schedule Nightly full backup – Sales schedule, usual run 21 min, overlaps another job')
    expect(timelineModel({ now, seconds: 86_400, jobs: [] }).rows).toEqual([])
  })
})
