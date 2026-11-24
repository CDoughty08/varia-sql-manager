import { afterEach, describe, expect, it } from 'vitest'
import {
  dateOfDay, dayNumber, formatRun, freq, momentSeconds, nextRuns, noEndDate, scheduleRuns, subday, timeOf, type AgentMoment, type AgentScheduleTiming
} from '../src/shared/agent/schedule'
import { connectLive, liveServer } from './fixtures/live-sql'

// The occurrence math (src/shared/agent/schedule.ts) against a live SQL Server Agent (AG-14): one scratch job per schedule shape, each with
// that one schedule, and Agent's own next run for it (sysjobactivity.next_scheduled_run_date, which Agent writes as soon as a schedule is
// attached; sysjobschedules' copy waits for Agent's periodic write) compared with nextRuns from the server's clock. Times are chosen
// around the server's now, so windows that cross midnight are checked from inside their morning part. Needs VARIA_TEST_SQL_AGENT=1 (a
// server whose Agent runs) and VARIA_TEST_SQL_SCRATCH=1 (it creates and drops jobs named as the .NET checks' sweep expects).
const enabled = !!liveServer && process.env.VARIA_TEST_SQL_AGENT === '1' && process.env.VARIA_TEST_SQL_SCRATCH === '1'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const quote = (value: string) => `N'${value.replaceAll("'", "''")}'`
const momentOf = (text: string | null | undefined): AgentMoment | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})\|(\d{6})$/.exec(text ?? '')
  return match ? { date: Number(match[1] + match[2] + match[3]), time: Number(match[4]) } : undefined
}
const wait = (ms: number) => new Promise(done => setTimeout(done, ms))

interface Shape { readonly label: string; readonly timing: AgentScheduleTiming }
/** The shapes, around the server's now: AG-6c's known gaps (windows across midnight, every-n weeks and months) and the plain ones. */
function shapes(now: AgentMoment): Shape[] {
  const day = dayNumber(now.date), at = momentSeconds(now), minute = at - at % 60
  const date = (offset: number) => dateOfDay(day + offset)
  const clock = (seconds: number) => timeOf(((seconds % 86_400) + 86_400) % 86_400)
  const weekday = (offset: number) => 1 << (((day + offset + 4) % 7 + 7) % 7)
  const base: AgentScheduleTiming = {
    freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
    activeStartDate: date(-40), activeEndDate: noEndDate, activeStartTime: 30000, activeEndTime: 235959
  }
  // A window from 41 minutes ahead to 40 minutes ahead the next morning: now is inside its morning part.
  const window = { freqSubdayType: subday.minutes, freqSubdayInterval: 7, activeStartTime: clock(minute + 41 * 60), activeEndTime: clock(minute + 40 * 60) }
  const shape = (label: string, patch: Partial<AgentScheduleTiming>): Shape => ({ label, timing: { ...base, ...patch } })
  const monthStart = Math.floor(date(-62) / 100) * 100 + 1
  return [
    shape('daily window across midnight', window),
    shape('every 2 days from yesterday, window across midnight', { ...window, freqInterval: 2, activeStartDate: date(-1) }),
    shape('every 2 days from today, window across midnight', { ...window, freqInterval: 2, activeStartDate: date(0) }),
    shape("weekly on yesterday's weekday, window across midnight", { ...window, freqType: freq.weekly, freqInterval: weekday(-1), freqRecurrenceFactor: 1 }),
    shape("weekly on today's weekday, window across midnight", { ...window, freqType: freq.weekly, freqInterval: weekday(0), freqRecurrenceFactor: 1 }),
    shape('weekly every day, window across midnight', { ...window, freqType: freq.weekly, freqInterval: 127, freqRecurrenceFactor: 1 }),
    shape("monthly on yesterday's day, window across midnight", { ...window, freqType: freq.monthly, freqInterval: Math.min(28, date(-1) % 100), freqRecurrenceFactor: 1 }),
    shape('hourly window across midnight, started 50 minutes ago', { freqSubdayType: subday.hours, freqSubdayInterval: 1, activeStartTime: clock(minute - 50 * 60), activeEndTime: clock(minute - 110 * 60) }),
    shape("every 2 weeks on tomorrow's weekday", { freqType: freq.weekly, freqInterval: weekday(1), freqRecurrenceFactor: 2, activeStartDate: date(-10) }),
    shape('every 3 weeks on two weekdays', { freqType: freq.weekly, freqInterval: weekday(2) | weekday(5), freqRecurrenceFactor: 3, activeStartDate: date(-30) }),
    shape('every 2 months on day 1, started two months back', { freqType: freq.monthly, freqInterval: 1, freqRecurrenceFactor: 2, activeStartDate: monthStart, activeStartTime: 0 }),
    shape('every 3 months on day 28', { freqType: freq.monthly, freqInterval: 28, freqRecurrenceFactor: 3, activeStartDate: date(-100) }),
    shape('every 2 months on the first Monday', { freqType: freq.relative, freqInterval: 2, freqRelativeInterval: 1, freqRecurrenceFactor: 2, activeStartDate: date(-70) }),
    shape('the last day of every month', { freqType: freq.relative, freqInterval: 8, freqRelativeInterval: 16, freqRecurrenceFactor: 1 }),
    shape('every 3 days at 23:00', { freqInterval: 3, activeStartDate: date(-8), activeStartTime: 230000 }),
    shape('every 5 minutes all day', { freqSubdayType: subday.minutes, freqSubdayInterval: 5, activeStartTime: 0 }),
    shape('once tomorrow', { freqType: freq.once, freqInterval: 0, freqSubdayType: 0, activeStartDate: date(1), activeStartTime: 10000 })
  ]
}

describe.runIf(enabled)('schedule occurrences against SQL Server Agent', () => {
  it("computes the same next run as Agent for every shape, windows across midnight and every-n cycles included", async () => {
    const { run } = await connectLive(cleanups)
    const scalar = async (sql: string) => (await run(sql)).resultSets[0]?.rows[0]?.[0] ?? null
    const deadline = Date.now() + 30_000
    while (await scalar("SELECT CASE WHEN c.value_in_use = 1 AND EXISTS (SELECT 1 FROM sys.dm_exec_sessions AS s WHERE s.program_name LIKE N'SQLAgent - %') THEN 1 ELSE 0 END FROM sys.configurations AS c WHERE c.configuration_id = 16384;") !== '1') {
      if (Date.now() > deadline) throw new Error('SQL Server Agent is not up (Agent XPs on and an Agent session), as VARIA_TEST_SQL_AGENT=1 requires.')
      await wait(500)
    }
    const clock = async () => momentOf(await scalar("SELECT FORMAT(GETDATE(), 'yyyyMMdd|HHmmss');"))!
    const before = await clock()
    const list = shapes(before)
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
    const jobs = list.map(() => `VariaScratch_${stamp}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`)
    cleanups.push(async () => { await run(jobs.map(prefix => `IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = ${quote(prefix + '_job')}) EXEC msdb.dbo.sp_delete_job @job_name = ${quote(prefix + '_job')}, @delete_unused_schedule = 1;`).join('\n'), 'msdb') })
    const created = await run('DECLARE @job uniqueidentifier, @schedule int;\n' + list.map(({ timing }, index) => [
      `SET @job = NULL; EXEC msdb.dbo.sp_add_job @job_name = ${quote(jobs[index] + '_job')}, @enabled = 1, @description = N'varia.scratch', @job_id = @job OUTPUT;`,
      "EXEC msdb.dbo.sp_add_jobstep @job_id = @job, @step_name = N'noop', @command = N'SELECT 1;'; EXEC msdb.dbo.sp_add_jobserver @job_id = @job;",
      `EXEC msdb.dbo.sp_add_schedule @schedule_name = ${quote(jobs[index] + '_sch')}, @freq_type = ${timing.freqType}, @freq_interval = ${timing.freqInterval}, @freq_subday_type = ${timing.freqSubdayType},`,
      ` @freq_subday_interval = ${timing.freqSubdayInterval}, @freq_relative_interval = ${timing.freqRelativeInterval}, @freq_recurrence_factor = ${timing.freqRecurrenceFactor},`,
      ` @active_start_date = ${timing.activeStartDate}, @active_end_date = ${timing.activeEndDate}, @active_start_time = ${timing.activeStartTime}, @active_end_time = ${timing.activeEndTime}, @schedule_id = @schedule OUTPUT;`,
      'EXEC msdb.dbo.sp_attach_schedule @job_id = @job, @schedule_id = @schedule;'
    ].join('\n')).join('\n'), 'msdb')
    expect(created.status).toBe('completed')
    const names = jobs.map(prefix => quote(prefix + '_job')).join(', ')
    let agent = new Map<string, string | null>()
    for (const until = Date.now() + 20_000; ;) {
      const read = await run(`SELECT j.name, FORMAT(a.next_scheduled_run_date, 'yyyyMMdd|HHmmss') FROM msdb.dbo.sysjobs AS j LEFT JOIN msdb.dbo.sysjobactivity AS a ON a.job_id = j.job_id
        AND a.session_id = (SELECT MAX(s.session_id) FROM msdb.dbo.syssessions AS s) WHERE j.name IN (${names});`, 'msdb')
      agent = new Map(read.resultSets[0]?.rows.map(row => [row[0] ?? '', row[1]]) ?? [])
      if ([...agent.values()].every(value => value) && agent.size === jobs.length) break
      if (Date.now() > until) break
      await wait(500)
    }
    // Agent computes some time after the attach, and a short schedule may even run while the loop above waits, so Agent then writes the
    // run after it: any run Varia lists from the clock read before the create up to its next run after the wait is Agent's answer.
    const after = await clock()
    const ours = (timing: AgentScheduleTiming, now: AgentMoment) => { const next = nextRuns(timing, now, 1)[0]; return next ? formatRun(next) : 'none' }
    const between = (timing: AgentScheduleTiming) => {
      const last = nextRuns(timing, after, 1)[0]
      return last ? scheduleRuns(timing, before, 1_000, momentSeconds(last)).map(formatRun) : []
    }
    const report = list.map(({ label, timing }, index) => {
      const read = momentOf(agent.get(jobs[index] + '_job'))
      const theirs = read ? formatRun(read) : 'none'
      const mine = [ours(timing, before), ours(timing, after), ...between(timing)]
      return `${label}: Agent ${theirs}, Varia ${mine.includes(theirs) ? theirs : mine.join(' or ')}`
    })
    // Agent's answers stay in the failure diff; the label alone says which shape differs.
    expect(report).toEqual(list.map(({ label }, index) => { const read = momentOf(agent.get(jobs[index] + '_job')); return `${label}: Agent ${read ? formatRun(read) : 'none'}, Varia ${read ? formatRun(read) : 'none'}` }))
  }, 120_000)
})
