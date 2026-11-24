import { describe, expect, it } from 'vitest'
import { agentNextRun, formatRun, freeSlotCheck, freq, nextRuns, noEndDate, scheduleRuns, subday, type AgentMoment, type AgentScheduleTiming } from '../src/shared/agent/schedule'

// Every expectation in the first block is what a live SQL Server 2025 Agent computed (sysjobactivity.next_scheduled_run_date) for a scratch
// job with that one schedule, created at the `now` shown (server time, Monday 2026-11-23). tests/agent-schedule-live.test.ts repeats the
// comparison against whatever Agent the live checks reach.
interface Shape { readonly label: string; readonly timing: Partial<AgentScheduleTiming>; readonly agent: string }
const timing = (patch: Partial<AgentScheduleTiming>): AgentScheduleTiming => ({
  freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
  activeStartDate: 20261101, activeEndDate: noEndDate, activeStartTime: 0, activeEndTime: 235959, ...patch
})
const next = (shape: Shape, now: AgentMoment) => { const run = nextRuns(timing(shape.timing), now, 1)[0]; return run ? formatRun(run) : 'none' }
const weekly = (days: number, factor: number, start: number, time: number) => ({ freqType: freq.weekly, freqInterval: days, freqRecurrenceFactor: factor, activeStartDate: start, activeStartTime: time })
const monthly = (day: number, factor: number, start: number) => ({ freqType: freq.monthly, freqInterval: day, freqRecurrenceFactor: factor, activeStartDate: start, activeStartTime: 30000 })
const relative = (day: number, which: number, factor: number, start: number) => ({ freqType: freq.relative, freqInterval: day, freqRelativeInterval: which, freqRecurrenceFactor: factor, activeStartDate: start, activeStartTime: 30000 })
const minutes = (every: number, start: number, end: number) => ({ freqSubdayType: subday.minutes, freqSubdayInterval: every, activeStartTime: start, activeEndTime: end })

describe('next runs as a live SQL Server Agent computes them', () => {
  it('counts every-n weeks and months from the first run on or after now, every-n days from the start date and relative months from the start month', () => {
    const now = { date: 20261123, time: 194944 }
    const shapes: Shape[] = [
      { label: 'every 2 months on day 5, started 2026-09-20', timing: monthly(5, 2, 20260920), agent: 'Sat 2026-12-05 03:00' },
      { label: 'every 3 months on day 30, started 2026-08-31', timing: monthly(30, 3, 20260831), agent: 'Mon 2026-11-30 03:00' },
      { label: 'every 2 months on the first Monday, started 2026-09-20', timing: relative(2, 1, 2, 20260920), agent: 'Mon 2027-01-04 03:00' },
      { label: 'every 2 weeks on Monday, started on a Wednesday', timing: weekly(2, 2, 20261111, 230000), agent: 'Mon 2026-11-23 23:00' },
      { label: 'every 2 weeks on Monday, started on a Sunday', timing: weekly(2, 2, 20261115, 230000), agent: 'Mon 2026-11-23 23:00' },
      { label: 'every 3 days from 2026-11-01', timing: { freqInterval: 3, activeStartTime: 230000 }, agent: 'Wed 2026-11-25 23:00' },
      { label: 'day 31 of every month', timing: monthly(31, 1, 20261101), agent: 'Thu 2026-12-31 03:00' },
      { label: 'the last day of every month', timing: relative(8, 16, 1, 20261101), agent: 'Mon 2026-11-30 03:00' },
      { label: 'every 3 weeks on Saturday, started on a Monday', timing: weekly(64, 3, 20261005, 30000), agent: 'Sat 2026-11-28 03:00' },
      { label: 'every 5 minutes all day', timing: minutes(5, 0, 235959), agent: 'Mon 2026-11-23 19:50' },
      { label: 'every 7 minutes from 00:03', timing: minutes(7, 300, 235959), agent: 'Mon 2026-11-23 19:53' },
      { label: 'once tomorrow', timing: { freqType: freq.once, freqInterval: 0, freqSubdayType: 0, activeStartDate: 20261124, activeStartTime: 10000 }, agent: 'Tue 2026-11-24 01:00' }
    ]
    expect(shapes.map(shape => `${shape.label}: ${next(shape, now)}`)).toEqual(shapes.map(shape => `${shape.label}: ${shape.agent}`))
    const later = { date: 20261123, time: 195111 }
    const more: Shape[] = [
      { label: 'every 2 weeks on Monday, started the Monday before', timing: weekly(2, 2, 20261116, 230000), agent: 'Mon 2026-11-23 23:00' },
      { label: 'every 2 weeks on Tuesday, started the Tuesday before', timing: weekly(4, 2, 20261117, 30000), agent: 'Tue 2026-11-24 03:00' },
      { label: 'every 2 weeks on Monday, starting on a later Tuesday', timing: weekly(2, 2, 20261201, 30000), agent: 'Mon 2026-12-07 03:00' },
      { label: 'every 2 weeks on Sunday and Wednesday, starting on a Thursday', timing: weekly(9, 2, 20261126, 30000), agent: 'Sun 2026-11-29 03:00' },
      { label: 'every 3 months on day 5, started 2026-07-01', timing: monthly(5, 3, 20260701), agent: 'Sat 2026-12-05 03:00' },
      { label: 'every 2 months on day 25, started 2026-10-01', timing: monthly(25, 2, 20261001), agent: 'Wed 2026-11-25 03:00' },
      { label: 'every 4 months on day 30, started 2026-09-01', timing: monthly(30, 4, 20260901), agent: 'Mon 2026-11-30 03:00' },
      { label: 'every 2 months on day 5, starting 2026-12-10', timing: monthly(5, 2, 20261210), agent: 'Tue 2027-01-05 03:00' },
      { label: 'every 3 months on the first Monday, started 2026-07-01', timing: relative(2, 1, 3, 20260701), agent: 'Mon 2027-01-04 03:00' },
      { label: 'every 2 months on the last Friday, started 2026-10-01', timing: relative(6, 16, 2, 20261001), agent: 'Fri 2026-12-25 03:00' },
      { label: 'every 3 days from 2026-11-22', timing: { freqInterval: 3, activeStartDate: 20261122, activeStartTime: 30000 }, agent: 'Wed 2026-11-25 03:00' },
      { label: 'hourly, 19:01 to 18:01 the next morning', timing: { freqSubdayType: subday.hours, freqSubdayInterval: 1, activeStartTime: 190100, activeEndTime: 180100 }, agent: 'Mon 2026-11-23 20:01' },
      { label: 'every 7 minutes, 20:32 to 20:31 the next morning', timing: minutes(7, 203200, 203100), agent: 'Mon 2026-11-23 19:52' },
      { label: 'every 7 minutes, 19:31 to 19:21 the next morning', timing: minutes(7, 193100, 192100), agent: 'Mon 2026-11-23 19:52' }
    ]
    expect(more.map(shape => `${shape.label}: ${next(shape, later)}`)).toEqual(more.map(shape => `${shape.label}: ${shape.agent}`))
    expect(next({ label: '', timing: relative(3, 2, 2, 20261201), agent: '' }, later)).toBe('Tue 2026-12-08 03:00')
  })
  it('carries a daily window past midnight only after a day it runs, and ends other windows at midnight', () => {
    // Now is 19:52:17, inside the morning part of a 20:33 to 20:32 window.
    const now = { date: 20261123, time: 195217 }
    const window = (patch: Partial<AgentScheduleTiming>) => ({ ...minutes(7, 203300, 203200), ...patch })
    const shapes: Shape[] = [
      { label: 'daily, every minute', timing: window({ freqSubdayInterval: 1 }), agent: 'Mon 2026-11-23 19:53' },
      { label: 'weekly every day', timing: window({ freqType: freq.weekly, freqInterval: 127, freqRecurrenceFactor: 1 }), agent: 'Mon 2026-11-23 20:33' },
      { label: 'weekly Sunday and Monday', timing: window({ freqType: freq.weekly, freqInterval: 3, freqRecurrenceFactor: 1 }), agent: 'Mon 2026-11-23 20:33' },
      { label: 'weekly Monday and Tuesday', timing: window({ freqType: freq.weekly, freqInterval: 6, freqRecurrenceFactor: 1 }), agent: 'Mon 2026-11-23 20:33' },
      { label: 'every 2 days from today', timing: window({ freqInterval: 2, activeStartDate: 20261123 }), agent: 'Mon 2026-11-23 20:33' },
      { label: 'every 2 days from yesterday', timing: window({ freqInterval: 2, activeStartDate: 20261122 }), agent: 'Mon 2026-11-23 19:53' },
      { label: 'every 2 days from the day before', timing: window({ freqInterval: 2, activeStartDate: 20261121 }), agent: 'Mon 2026-11-23 20:33' },
      { label: 'monthly on day 23', timing: window({ freqType: freq.monthly, freqInterval: 23, freqRecurrenceFactor: 1 }), agent: 'Mon 2026-11-23 20:33' },
      { label: 'monthly on day 22', timing: window({ freqType: freq.monthly, freqInterval: 22, freqRecurrenceFactor: 1 }), agent: 'Tue 2026-12-22 20:33' },
      { label: 'the fourth Monday', timing: window({ freqType: freq.relative, freqInterval: 2, freqRelativeInterval: 8, freqRecurrenceFactor: 1 }), agent: 'Mon 2026-11-23 20:33' }
    ]
    expect(shapes.map(shape => `${shape.label}: ${next(shape, now)}`)).toEqual(shapes.map(shape => `${shape.label}: ${shape.agent}`))
    const earlier = { date: 20261123, time: 194944 }
    expect(next({ label: '', timing: { ...weekly(1, 1, 20261101, 203000), ...minutes(7, 203000, 202900), freqType: freq.weekly }, agent: '' }, earlier)).toBe('Sun 2026-11-29 20:30')
    expect(next({ label: '', timing: { ...weekly(2, 1, 20261101, 211900), ...minutes(1, 211900, 202900), freqType: freq.weekly }, agent: '' }, earlier)).toBe('Mon 2026-11-23 21:19')
    expect(next({ label: '', timing: { freqInterval: 2, activeStartDate: 20261122, freqSubdayType: subday.hours, freqSubdayInterval: 2, activeStartTime: 203000, activeEndTime: 202900 }, agent: '' }, earlier)).toBe('Tue 2026-11-24 20:30')
  })
})

describe('runs over a window', () => {
  const now = { date: 20261122, time: 143000 }
  const list = (patch: Partial<AgentScheduleTiming>, count: number, from = now, anchor?: AgentMoment) => scheduleRuns(timing(patch), from, count, undefined, anchor).map(formatRun)
  it('continues a daily window from its starting time past midnight, never restarting at 00:00', () => {
    // Every 90 minutes from 22:00 to 04:00: 22:00, 23:30, then 01:00, 02:30 and 04:00 the next morning (00:00 alignment would give 00:00, 01:30, 03:00).
    expect(list({ freqSubdayType: subday.minutes, freqSubdayInterval: 90, activeStartTime: 220000, activeEndTime: 40000 }, 5)).toEqual(['Sun 2026-11-22 22:00', 'Sun 2026-11-22 23:30', 'Mon 2026-11-23 01:00', 'Mon 2026-11-23 02:30', 'Mon 2026-11-23 04:00'])
    // The window stops at the end date, as a live Agent does (ended yesterday, a 21:30-21:20 window gave no next run at 20:52), and the
    // first day's morning has none.
    expect(list({ freqSubdayType: subday.hours, freqSubdayInterval: 3, activeStartTime: 220000, activeEndTime: 30000, activeStartDate: 20261122, activeEndDate: 20261123 }, 9, { date: 20261122, time: 0 }))
      .toEqual(['Sun 2026-11-22 22:00', 'Mon 2026-11-23 01:00', 'Mon 2026-11-23 22:00'])
    expect(list({ freqSubdayType: subday.minutes, freqSubdayInterval: 5, activeStartTime: 213000, activeEndTime: 212000, activeStartDate: 20261118, activeEndDate: 20261122 }, 1, { date: 20261123, time: 205228 })).toEqual([])
    expect(list({ freqSubdayType: subday.minutes, freqSubdayInterval: 5, activeStartTime: 213000, activeEndTime: 212000, activeStartDate: 20261118, activeEndDate: 20261123 }, 1, { date: 20261123, time: 205228 })).toEqual(['Mon 2026-11-23 20:55'])
    // A weekly window ends at midnight.
    expect(list({ freqType: freq.weekly, freqInterval: 1, freqRecurrenceFactor: 1, freqSubdayType: subday.hours, freqSubdayInterval: 1, activeStartTime: 220000, activeEndTime: 20000 }, 3))
      .toEqual(['Sun 2026-11-22 22:00', 'Sun 2026-11-22 23:00', 'Sun 2026-11-29 22:00'])
  })
  it('keeps an every-n cycle counted from the anchor when the window starts later', () => {
    const fortnightly = { freqType: freq.weekly, freqInterval: 2, freqRecurrenceFactor: 2, activeStartDate: 20260105, activeStartTime: 30000 }
    // From now: Mondays 23 Nov, 7 Dec, 21 Dec. A window from 1 Dec keeps that cycle when anchored at now; unanchored it would start a new one.
    expect(list(fortnightly, 3)).toEqual(['Mon 2026-11-23 03:00', 'Mon 2026-12-07 03:00', 'Mon 2026-12-21 03:00'])
    expect(list(fortnightly, 2, { date: 20261201, time: 0 }, now)).toEqual(['Mon 2026-12-07 03:00', 'Mon 2026-12-21 03:00'])
    expect(list(fortnightly, 2, { date: 20261201, time: 0 })).toEqual(['Mon 2026-12-07 03:00', 'Mon 2026-12-21 03:00'])
    expect(list(fortnightly, 2, { date: 20261124, time: 0 }, now)).toEqual(['Mon 2026-12-07 03:00', 'Mon 2026-12-21 03:00'])
    expect(list(fortnightly, 2, { date: 20261124, time: 0 })).toEqual(['Mon 2026-11-30 03:00', 'Mon 2026-12-14 03:00'])
    // Agent's own next run as the anchor: a fortnightly schedule whose next run is 30 Nov stays on 30 Nov, 14 Dec.
    expect(list(fortnightly, 2, now, { date: 20261130, time: 30000 })).toEqual(['Mon 2026-11-30 03:00', 'Mon 2026-12-14 03:00'])
    // Two weekdays every other week: both days of the anchor's week (weeks start on Sunday), then two weeks on.
    expect(list({ ...fortnightly, freqInterval: 2 | 32 }, 4)).toEqual(['Mon 2026-11-23 03:00', 'Fri 2026-11-27 03:00', 'Mon 2026-12-07 03:00', 'Fri 2026-12-11 03:00'])
    expect(list({ freqType: freq.monthly, freqInterval: 1, freqRecurrenceFactor: 3, activeStartDate: 20260101, activeStartTime: 30000 }, 3)).toEqual(['Tue 2026-12-01 03:00', 'Mon 2027-03-01 03:00', 'Tue 2027-06-01 03:00'])
  })
  it("shows a saved every-n schedule's runs on Agent's own cycle, in the editor and the free-slot check too", () => {
    const fortnightly = timing({ freqType: freq.weekly, freqInterval: 2, freqRecurrenceFactor: 2, activeStartDate: 20260105, activeStartTime: 30000 })
    const tuesday = { date: 20261124, time: 120000 }
    // It last ran Monday 23 November, so Agent's next run is 7 December; counted from Tuesday it would be the off week, 30 November.
    // Saved long ago: sysjobschedules' pair values have been rewritten since. A and B also run another schedule.
    const saved = { ...fortnightly, modified: '2026-10-01T09:00:00.000' }
    const others = [{ scheduleId: 8, jobId: 'A' }, { scheduleId: 8, jobId: 'B' }]
    const links = [{ scheduleId: 7, jobId: 'A', nextRunDate: 20261207, nextRunTime: 30000 }, { scheduleId: 7, jobId: 'B', nextRunDate: 20261207, nextRunTime: 30000 }, { scheduleId: 7, jobId: 'C' }, ...others]
    expect(agentNextRun(links, 7, saved, tuesday)).toEqual({ date: 20261207, time: 30000 })
    expect(agentNextRun(links, 7, saved, tuesday, 'b')).toEqual({ date: 20261207, time: 30000 })
    // C has no value Agent wrote: the save is where its cycle restarted (Monday 5 October, on the cycle of 7 December).
    expect(agentNextRun(links, 7, saved, tuesday, 'C')).toEqual({ date: 20261001, time: 90000 })
    expect(agentNextRun(undefined, 7, saved, tuesday)).toBeUndefined()
    // Jobs attached in different weeks keep different cycles: the schedule itself then has none.
    expect(agentNextRun([...links, { scheduleId: 7, jobId: 'D', nextRunDate: 20261130, nextRunTime: 30000 }, { scheduleId: 8, jobId: 'D' }], 7, saved, tuesday)).toBeUndefined()
    // The same cycle seen at different moments agrees: a past value two weeks back, or a Friday of the same week of a Monday-and-Friday schedule.
    expect(agentNextRun([...links, { scheduleId: 7, jobId: 'D', nextRunDate: 20261123, nextRunTime: 30000 }, { scheduleId: 8, jobId: 'D' }], 7, saved, tuesday)).toEqual({ date: 20261207, time: 30000 })
    const twoDays = { ...saved, freqInterval: 2 | 32 }
    expect(agentNextRun([{ scheduleId: 7, jobId: 'A', jobNextRunDate: 20261130, jobNextRunTime: 30000 }, { scheduleId: 7, jobId: 'B', nextRunDate: 20261120, nextRunTime: 30000 }, { scheduleId: 8, jobId: 'B' }], 7, twoDays, { date: 20261121, time: 120000 }))
      .toEqual({ date: 20261130, time: 30000 })
    // A value written for an older timing (Monday 03:00, now Wednesday 02:30) is not a run of the current one, so the save is the anchor.
    expect(agentNextRun(links, 7, { ...saved, freqInterval: 8, activeStartTime: 23000 }, tuesday)).toEqual({ date: 20261001, time: 90000 })
    // Saved ten minutes ago, sooner than Agent's 20-minute rewrite of sysjobschedules: a pair value that still fits may predate the save
    // (an end date changed: Agent restarted the cycle at the save), so the save is the anchor.
    const fresh = { ...fortnightly, activeEndDate: 20271231, modified: '2026-11-24T11:50:00.000' }
    expect(agentNextRun(links, 7, fresh, tuesday, 'b')).toEqual({ date: 20261124, time: 115000 })
    expect(nextRuns(fresh, tuesday, 2, agentNextRun(links, 7, fresh, tuesday, 'b')).map(formatRun)).toEqual(['Mon 2026-11-30 03:00', 'Mon 2026-12-14 03:00'])
    // The job's sysjobactivity value is current: taken when it is a run of this schedule, passed over when it belongs to another one.
    expect(agentNextRun([{ scheduleId: 7, jobId: 'E', nextRunDate: 20261130, nextRunTime: 30000, jobNextRunDate: 20261207, jobNextRunTime: 30000 }], 7, saved, tuesday)).toEqual({ date: 20261207, time: 30000 })
    expect(agentNextRun([{ scheduleId: 7, jobId: 'E', nextRunDate: 20261207, nextRunTime: 30000, jobNextRunDate: 20261125, jobNextRunTime: 10000 }], 7, saved, tuesday)).toEqual({ date: 20261207, time: 30000 })
    expect(nextRuns(fortnightly, tuesday, 2).map(formatRun)).toEqual(['Mon 2026-11-30 03:00', 'Mon 2026-12-14 03:00'])
    expect(nextRuns(fortnightly, tuesday, 2, agentNextRun(links, 7, saved, tuesday)).map(formatRun)).toEqual(['Mon 2026-12-07 03:00', 'Mon 2026-12-21 03:00'])
    // The free-slot check counts this job's runs and each other job's from their anchors: a weekly 03:00 job on Agent's other week never clashes.
    const other = { name: 'Other', enabled: true, usualSeconds: 600, schedules: [{ ...fortnightly, nextRun: { date: 20261130, time: 30000 } }] }
    expect(freeSlotCheck(fortnightly, tuesday, 600, [other], 3, { date: 20261207, time: 30000 }).clashes).toEqual([])
    expect(freeSlotCheck(fortnightly, tuesday, 600, [{ ...other, schedules: [{ ...fortnightly, nextRun: { date: 20261207, time: 30000 } }] }], 3, { date: 20261207, time: 30000 }).clashes).toHaveLength(3)
  })
})
