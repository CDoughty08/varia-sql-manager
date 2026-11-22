import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentScheduleCommandEntries, initialJobSchedules, jobScheduleChangeCount, jobScheduleProblems, jobScheduleText, jobSchedulesSave, jobSchedulesSaveProblems, jobSchedulesSaveSchema, momentOfText,
  rebaseJobSchedules, rebaseScheduleFields, refreshPickedSchedules, scheduleDraftSave, scheduleFieldsOf, scheduleSaveProblems, scheduleSaveSchema, timingProblem, type AgentScheduleRecord, type AgentSchedulesModel, type JobScheduleEntry
} from '../src/shared/actions/agent-schedule'
import { agentJobSave, initialAgentJobDraft, uncategorizedCategory, type AgentJobDocumentModel } from '../src/shared/actions/agent-job'
import type { ActionDescribeResult, ActionExecuteResult, ActionRequest } from '../src/shared/actions/schema'
import { agentLimits } from '../src/shared/agent/catalog'
import {
  defaultSchedule, formatRun, freeSlotCheck, freeSlotText, freq, matchingPreset, median, nextRuns, noEndDate, noRunsReason, schedulePresets, scheduleMatches, scheduleProblems, scheduleSavable,
  sameTiming, scheduleSentence, scheduleText, scheduleWhen, subday, withFrequency, type AgentMoment, type AgentScheduleFields
} from '../src/shared/agent/schedule'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { submenus } from '../src/shared/commands/menus'
import type { ApiResult } from '../src/shared/contracts'
import { newScheduleKey, schedulesText, visibleSchedules } from '../src/renderer/src/agent/SchedulesService'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

// Sunday 2026-11-22 14:30:00, server time.
const now: AgentMoment = { date: 20261122, time: 143000 }
const fields = (patch: Partial<AgentScheduleFields> = {}): AgentScheduleFields => ({
  name: 'Nightly 02:30', enabled: true, freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
  activeStartDate: 20260101, activeEndDate: noEndDate, activeStartTime: 23000, activeEndTime: 235959, ...patch
})
const record = (id: number, patch: Partial<AgentScheduleRecord> = {}): AgentScheduleRecord => ({ ...fields(), id, jobCount: 1, owner: 'sa', version: 3, modified: '2026-11-20T01:02:03.456', ...patch })
const runs = (timing: AgentScheduleFields, count = 5) => nextRuns(timing, now, count).map(formatRun)

describe('schedule encoding, sentences and runs', () => {
  it("words a schedule as SSMS's sentence and a short when", () => {
    expect(scheduleSentence(fields())).toBe('Occurs every day at 02:30. Schedule will be used starting on 2026-01-01.')
    expect(scheduleSentence(fields({ freqType: freq.weekly, freqInterval: 1 | 64, freqRecurrenceFactor: 2, activeEndDate: 20271231 }))).toBe('Occurs every 2 weeks on Sunday, Saturday at 02:30. Schedule will be used between 2026-01-01 and 2027-12-31.')
    expect(scheduleSentence(fields({ freqSubdayType: subday.minutes, freqSubdayInterval: 15, activeStartTime: 0 }))).toBe('Occurs every day every 15 minutes between 00:00 and 23:59:59. Schedule will be used starting on 2026-01-01.')
    expect(scheduleSentence(fields({ freqType: freq.relative, freqInterval: 6, freqRelativeInterval: 16, freqRecurrenceFactor: 1 }))).toBe('Occurs every month on the last Friday of that month at 02:30. Schedule will be used starting on 2026-01-01.')
    expect(scheduleSentence(fields({ freqType: freq.agentStart }))).toBe('Start automatically when SQL Server Agent starts.')
    expect(scheduleSentence(fields({ freqType: freq.once, activeStartDate: 20261201 }))).toBe('Occurs on 2026-12-01 at 02:30.')
    expect(scheduleWhen(fields({ freqType: freq.weekly, freqInterval: 62, freqRecurrenceFactor: 1, activeStartTime: 60000 }))).toBe('Weekdays at 06:00')
    expect(scheduleWhen(fields({ freqType: freq.monthly, freqInterval: 1, freqRecurrenceFactor: 3 }))).toBe('Day 1 of every 3 months at 02:30')
  })
  it('lists the next five runs in server time from now, inclusive, across months and midnight', () => {
    expect(runs(fields())).toEqual(['Mon 2026-11-23 02:30', 'Tue 2026-11-24 02:30', 'Wed 2026-11-25 02:30', 'Thu 2026-11-26 02:30', 'Fri 2026-11-27 02:30'])
    expect(runs(fields({ freqSubdayType: subday.minutes, freqSubdayInterval: 15, activeStartTime: 0 }))).toEqual(['Sun 2026-11-22 14:30', 'Sun 2026-11-22 14:45', 'Sun 2026-11-22 15:00', 'Sun 2026-11-22 15:15', 'Sun 2026-11-22 15:30'])
    // Day 31 skips the months without one.
    expect(runs(fields({ freqType: freq.monthly, freqInterval: 31, freqRecurrenceFactor: 1 }))).toEqual(['Thu 2026-12-31 02:30', 'Sun 2027-01-31 02:30', 'Wed 2027-03-31 02:30', 'Mon 2027-05-31 02:30', 'Sat 2027-07-31 02:30'])
    expect(runs(fields({ freqType: freq.relative, freqInterval: 6, freqRelativeInterval: 16, freqRecurrenceFactor: 1 }), 2)).toEqual(['Fri 2026-11-27 02:30', 'Fri 2026-12-25 02:30'])
    // A window that runs past midnight: 22:00, then 00:00 and 02:00 the next day.
    expect(runs(fields({ freqSubdayType: subday.hours, freqSubdayInterval: 2, activeStartTime: 220000, activeEndTime: 20000 }), 4)).toEqual(['Sun 2026-11-22 22:00', 'Mon 2026-11-23 00:00', 'Mon 2026-11-23 02:00', 'Mon 2026-11-23 22:00'])
    // Every second week counts weeks from the start date's week (weeks start on Sunday).
    expect(runs(fields({ freqType: freq.weekly, freqInterval: 2, freqRecurrenceFactor: 2, activeStartDate: 20261116 }), 2)).toEqual(['Mon 2026-11-30 02:30', 'Mon 2026-12-14 02:30'])
    expect(runs(fields({ enabled: false }))).toEqual([])
    expect(noRunsReason(fields({ enabled: false }), now)).toBe('The schedule is disabled, so it starts no job.')
    expect(noRunsReason(fields({ freqType: freq.once, activeStartDate: 20261101 }), now)).toContain('has passed')
    expect(noRunsReason(fields({ activeEndDate: 20261121 }), now)).toBeDefined()
    expect(noRunsReason(fields(), now)).toBeUndefined()
  })
  it('fills only SSMS fields from presets, recognises them again, and switches frequency with defaults', () => {
    const start = defaultSchedule(now.date, 'x')
    expect(start).toMatchObject({ freqType: freq.weekly, freqInterval: 1, freqRecurrenceFactor: 1, activeStartDate: now.date, activeStartTime: 0 })
    for (const preset of schedulePresets) {
      const applied = preset.apply(start, now.date)
      expect(matchingPreset(applied), preset.id).toBe(preset.id === 'weekly' ? 'weekly' : preset.id)
      expect(applied.name).toBe('x')
      expect(scheduleSavable(scheduleProblems(applied, now)), preset.id).toBe(true)
    }
    expect(withFrequency(fields(), freq.monthly, now.date)).toMatchObject({ freqType: freq.monthly, freqInterval: 1, freqRecurrenceFactor: 1, freqSubdayType: subday.once })
    expect(withFrequency(fields(), freq.weekly, now.date)).toMatchObject({ freqType: freq.weekly, freqInterval: 1, freqRecurrenceFactor: 1 })
  })
  it('refuses what sp_verify_schedule refuses and warns about what would surprise', () => {
    const errors = (patch: Partial<AgentScheduleFields>) => scheduleProblems(fields(patch), now).filter(problem => problem.severity === 'error').map(problem => problem.field)
    const warnings = (patch: Partial<AgentScheduleFields>) => scheduleProblems(fields(patch), now).filter(problem => problem.severity === 'warning').map(problem => problem.field)
    expect(errors({ name: ' ' })).toEqual(['name'])
    expect(errors({ freqType: freq.weekly, freqInterval: 0, freqRecurrenceFactor: 1 })).toEqual(['days'])
    expect(errors({ freqSubdayType: subday.seconds, freqSubdayInterval: 5 })).toEqual(['dailyFrequency'])
    expect(errors({ freqSubdayType: subday.minutes, freqSubdayInterval: 5, activeEndTime: 23000 })).toEqual(['endTime'])
    expect(errors({ activeEndDate: 20251231 })).toEqual(['endDate'])
    expect(warnings({ freqType: freq.monthly, freqInterval: 30, freqRecurrenceFactor: 1 })).toEqual(['days'])
    expect(warnings({ freqType: freq.once, activeStartDate: 20261101 })).toEqual(['startDate'])
    expect(warnings({ freqSubdayType: subday.hours, freqSubdayInterval: 1, activeStartTime: 220000, activeEndTime: 20000 })).toEqual(['endTime'])
    expect(timingProblem(fields())).toBeUndefined()
    expect(timingProblem(fields({ freqType: freq.once, freqInterval: 1 }))).toContain('one-time')
    expect(timingProblem(fields({ freqSubdayType: subday.minutes, freqSubdayInterval: 5, activeEndTime: 23000 }))).toContain('different start and end')
  })
  it('finds a schedule by name or by when it runs', () => {
    expect(scheduleMatches(fields(), 'night')).toBe(true)
    expect(scheduleMatches(fields(), 'nightly')).toBe(true)
    expect(scheduleMatches(fields({ name: 'Log backups', freqSubdayType: subday.minutes, freqSubdayInterval: 15, activeStartTime: 0 }), 'every 15 minutes')).toBe(true)
    expect(scheduleMatches(fields({ name: 'Reports', activeStartTime: 90000 }), 'night')).toBe(false)
    expect(scheduleMatches(fields({ name: 'Reports', activeStartTime: 90000 }), 'morning')).toBe(true)
    expect(scheduleMatches(fields({ freqType: freq.weekly, freqInterval: 1, freqRecurrenceFactor: 1 }), 'sunday')).toBe(true)
  })
  it("checks a free slot against other enabled jobs' runs and their usual durations", () => {
    expect(median([10, 30, 20])).toBe(20)
    expect(median([10, 20, 30, 41])).toBe(25)
    expect(median([])).toBeUndefined()
    const backup = { name: 'Backup', enabled: true, usualSeconds: 300, schedules: [fields({ activeStartTime: 24000 })] }
    const disabled = { name: 'Old', enabled: false, schedules: [fields()] }
    const clash = freeSlotCheck(fields(), now, 18 * 60, [backup, disabled])
    expect(clash.clashes).toHaveLength(5)
    expect(new Set(clash.clashes.map(item => item.job))).toEqual(new Set(['Backup']))
    expect(freeSlotText(clash)).toBe("Backup also runs during this job's usual 18 minutes: first at Mon 2026-11-23 02:40, beside this job's run at Mon 2026-11-23 02:30.")
    // A job that ends before this one starts does not clash; neither does one without a measured duration a minute later.
    expect(freeSlotCheck(fields(), now, 60, [{ ...backup, schedules: [fields({ activeStartTime: 21000 })], usualSeconds: 600 }]).clashes).toEqual([])
    const free = freeSlotCheck(fields(), now, undefined, [{ name: 'Later', enabled: true, schedules: [fields({ activeStartTime: 23200 })] }])
    expect(free.clashes).toEqual([])
    expect(freeSlotText(free)).toBe('Nothing else is scheduled during the first minute of each run (this job has no successful run to measure).')
    // Every 10 seconds all day is far more runs than one window could list: each of this job's five nightly runs still meets it.
    const busy = { name: 'Poller', enabled: true, usualSeconds: 5, schedules: [fields({ freqSubdayType: subday.seconds, freqSubdayInterval: 10, activeStartTime: 0, activeEndTime: 235959 })] }
    expect(freeSlotCheck(fields(), now, 60, [busy]).clashes.map(item => formatRun(item.mine))).toEqual(runs(fields()))
    // A run that starts exactly as this one ends, or ends exactly as it starts, is no clash.
    expect(freeSlotCheck(fields(), now, 60, [{ name: 'Edge', enabled: true, usualSeconds: 60, schedules: [fields({ activeStartTime: 23100 }), fields({ activeStartTime: 22900 })] }]).clashes).toEqual([])
    // Runs measured at 0 seconds that start in the same second still clash, and the text names seconds.
    const instant = freeSlotCheck(fields(), now, 0, [{ name: 'Ping', enabled: true, usualSeconds: 0, schedules: [fields()] }])
    expect(instant.clashes).toHaveLength(5)
    expect(freeSlotText(freeSlotCheck(fields(), now, 0, []))).toBe("Nothing else is scheduled during this job's usual 1 second.")
    expect(freeSlotText(freeSlotCheck(fields(), now, 42, []))).toBe("Nothing else is scheduled during this job's usual 42 seconds.")
  })
  it('refuses a CPU-idle schedule on Managed Instance, and warns where no idle condition is set', () => {
    const idle = fields({ freqType: freq.idle, freqInterval: 0, freqSubdayType: 0, freqSubdayInterval: 0 })
    expect(scheduleSavable(scheduleProblems(idle, now, { platform: 'managedInstance' }))).toBe(false)
    expect(scheduleProblems(idle, now, { platform: 'managedInstance' })).toContainEqual(expect.objectContaining({ field: 'frequency', message: scheduleText.idleUnavailable }))
    expect(scheduleProblems(idle, now, { platform: 'windows', idleDefined: false })).toEqual([expect.objectContaining({ severity: 'warning', message: scheduleText.idleWarning })])
    expect(scheduleProblems(idle, now, { platform: 'linux', idleDefined: true })).toEqual([])
    expect(jobScheduleProblems(initialJobSchedules([]).concat([{ ...initialJobSchedules([record(9)])[0]!, id: undefined, key: 'new-1', fields: { ...idle, name: 'Idle' } }]), now, [], { platform: 'managedInstance' })
      .map(item => item.problem.message)).toContain(scheduleText.idleUnavailable)
  })
  it("warns past SSMS's limits that msdb does not have, and refuses an end date before the start for every type", () => {
    for (const timing of [fields({ freqInterval: 365 }), fields({ freqSubdayType: subday.hours, freqSubdayInterval: 48, activeEndTime: 235959 }), fields({ freqType: freq.weekly, freqInterval: 2, freqRecurrenceFactor: 150 })]) {
      const problems = scheduleProblems(timing, now)
      expect(scheduleSavable(problems)).toBe(true)
      expect(problems.some(problem => problem.severity === 'warning' && problem.field !== 'endTime')).toBe(true)
      expect(timingProblem(timing)).toBeUndefined()
    }
    expect(scheduleSavable(scheduleProblems(fields({ freqInterval: 0 }), now))).toBe(false)
    // A one-time schedule shows no end date: the refusal sits on its start date, which the user can change.
    const once = fields({ freqType: freq.once, freqSubdayType: 0, freqInterval: 0, activeStartDate: 20270105, activeEndDate: 20270101 })
    expect(scheduleProblems(once, now)).toContainEqual(expect.objectContaining({ field: 'startDate', severity: 'error' }))
    expect(timingProblem(once)).toBeDefined()
  })
  it("stops a schedule without an end date at msdb's last day, 9999-12-31", () => {
    expect(nextRuns(fields({ activeStartDate: 99991229 }), { date: 99991229, time: 0 }, 5).map(formatRun)).toHaveLength(3)
  })
  it('takes an end time of 00:00 as the 23:59:59 msdb stores', () => {
    const evening = fields({ freqSubdayType: subday.minutes, freqSubdayInterval: 15, activeStartTime: 180000, activeEndTime: 0 })
    expect(scheduleProblems(evening, now)).toEqual([])
    expect(nextRuns(evening, { date: 20261122, time: 234000 }, 2).map(formatRun)).toEqual(['Sun 2026-11-22 23:45', 'Mon 2026-11-23 18:00'])
    expect(sameTiming(evening, { ...evening, activeEndTime: 235959 })).toBe(true)
    // The whole day, every hour: msdb accepts it, so neither check refuses it.
    const allDay = fields({ freqSubdayType: subday.hours, freqSubdayInterval: 1, activeStartTime: 0, activeEndTime: 0 })
    expect(timingProblem(allDay)).toBeUndefined()
    expect(scheduleSavable(scheduleProblems(allDay, now))).toBe(true)
  })
  it('reads the server clock', () => {
    expect(momentOfText('2026-11-22T14:30:05')).toEqual({ date: 20261122, time: 143005 })
    expect(momentOfText('nope')).toBeUndefined()
  })
})

describe("the job document's schedule saves", () => {
  const records = [record(1), record(2, { name: 'Shared', jobCount: 3 })]
  it('sends detaches, guarded updates, guarded attaches and new schedules, and counts each changed entry', () => {
    const base = initialJobSchedules(records)
    expect(jobSchedulesSave(records, base)).toBeUndefined()
    const picked = record(9, { name: 'Weekly', version: 1, modified: '2026-11-01T00:00:00.000' })
    const entries: JobScheduleEntry[] = [
      { ...base[0], fields: { ...base[0].fields, activeStartTime: 30000 } },
      { ...base[1], remove: 'delete' },
      { key: 's:9', id: 9, attached: true, base: picked, fields: scheduleFieldsOf(picked) },
      { key: 'n:1', fields: fields({ name: ' New one ' }) }
    ]
    const save = jobSchedulesSave(records, entries)!
    expect(save.detach).toEqual([{ id: 2, deleteUnused: true }])
    expect(save.update).toEqual([{ id: 1, version: 3, modified: '2026-11-20T01:02:03.456', timing: expect.objectContaining({ activeStartTime: 30000 }) }])
    expect(save.attach).toEqual([{ id: 9, version: 1, modified: '2026-11-01T00:00:00.000' }])
    expect(save.add).toEqual([{ name: 'New one', enabled: true, timing: expect.objectContaining({ freqType: freq.daily, freqRecurrenceFactor: 0 }) }])
    expect(jobScheduleChangeCount(base, entries)).toBe(4)
    expect(jobSchedulesSaveProblems(save)).toEqual([])
    expect(jobSchedulesSaveSchema.safeParse(save).success).toBe(true)
  })
  it('rides on the job save and rebases onto the schedules as read again', () => {
    const job: AgentJobDocumentModel = {
      job: { jobId: '11111111-1111-1111-1111-111111111111', name: 'Nightly load', enabled: true, description: '', category: uncategorizedCategory, owner: 'sa', emailLevel: 0, emailOperator: '', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0, created: '2026-01-01T00:00:00', modified: '2026-11-20T00:00:00.000', version: 4, startStepId: 1 },
      login: 'sa', sysadmin: true, platform: 'windows', categories: [uncategorizedCategory], operators: [], owners: ['sa'], steps: [], alerts: [], alertsEditable: true, mail: { checked: false, sysadmin: true }, schedules: records
    }
    const draft = initialAgentJobDraft(job)
    expect(draft.schedules.map(entry => entry.key)).toEqual(['s:1', 's:2'])
    const save = agentJobSave(job, { ...draft, schedules: [{ ...draft.schedules[0], remove: 'detach' }, draft.schedules[1]] })
    expect(save?.schedules).toEqual({ detach: [{ id: 1, deleteUnused: false }] })
    // The server changed schedule 2 and the draft edited schedule 1: each keeps its side; a schedule gone from the job drops its edit.
    const edited: JobScheduleEntry[] = [{ ...draft.schedules[0], fields: { ...draft.schedules[0].fields, name: 'Mine' } }, draft.schedules[1]]
    const rebased = rebaseJobSchedules(records, [record(1), record(2, { name: 'Theirs', version: 4 })], edited)
    expect(rebased.map(entry => entry.fields.name)).toEqual(['Mine', 'Theirs'])
    expect(rebaseJobSchedules(records, [record(2)], edited).map(entry => entry.id)).toEqual([2])
  })
  it('blocks adding past the per-job limit but not a job that already holds more, and a pick without its guard', () => {
    const many = initialJobSchedules(Array.from({ length: agentLimits.schedulesPerJob + 2 }, (_, at) => record(at + 1)))
    expect(jobScheduleProblems(many, now)).toEqual([])
    expect(jobScheduleProblems([...many, { key: 'n:1', fields: fields() }], now).map(item => item.problem.message)).toEqual([jobScheduleText.tooMany])
    // One save removes at most schedulesPerJob of them, as zod and C# bound it.
    expect(jobScheduleProblems(many.map((entry, at) => at <= agentLimits.schedulesPerJob ? { ...entry, remove: 'detach' as const } : entry), now).map(item => item.problem.message)).toEqual([jobScheduleText.tooManyRemoved])
    expect(jobScheduleProblems(many.map((entry, at) => at < agentLimits.schedulesPerJob ? { ...entry, remove: 'detach' as const } : entry), now)).toEqual([])
    const unguarded = record(9, { version: undefined })
    expect(jobScheduleProblems([{ key: 's:9', id: 9, attached: true, base: unguarded, fields: scheduleFieldsOf(unguarded) }], now)).toEqual([{ key: 's:9', problem: expect.objectContaining({ severity: 'error', message: jobScheduleText.unguarded }) }])
  })
  it("checks only the job's schedules the user changed, so one made outside Varia never blocks the job's Save", () => {
    const odd = record(4, { name: '' })
    const entries = initialJobSchedules([odd])
    expect(jobScheduleProblems(entries, now, [odd])).toEqual([])
    expect(jobScheduleProblems([{ ...entries[0], fields: { ...entries[0].fields, activeStartTime: 10000 } }], now, [odd]).map(item => item.problem.message)).toContain(scheduleText.nameRequired)
  })
  it("moves picked schedules onto the shared schedules as read again, keeping the user's edits", () => {
    const picked = record(9, { name: 'Weekly', version: 1 })
    const plain: JobScheduleEntry = { key: 's:9', id: 9, attached: true, base: picked, fields: scheduleFieldsOf(picked) }
    const edited: JobScheduleEntry = { key: 's:8', id: 8, attached: true, base: record(8, { version: 1 }), fields: { ...scheduleFieldsOf(record(8)), name: 'Mine' } }
    const entries = [plain, edited, { key: 'n:1', fields: fields() }]
    // Nothing changed on the server: the same entries.
    expect(refreshPickedSchedules(entries, [picked, record(8, { version: 1 })])).toBe(entries)
    const moved = refreshPickedSchedules(entries, [record(9, { name: 'Weekly (theirs)', version: 2 }), record(8, { version: 5, activeStartTime: 10000 })])
    expect(moved[0]).toMatchObject({ base: { version: 2 }, fields: { name: 'Weekly (theirs)' } })
    // Only the name was the user's: the start time someone else changed is kept, not sent back as it was.
    expect(moved[1]).toMatchObject({ base: { version: 5 }, fields: { name: 'Mine', activeStartTime: 10000 } })
    // The job's own schedules rebase the same way on Reload and keep my changes.
    const own = initialJobSchedules([record(8, { version: 1 })]).map(entry => ({ ...entry, fields: { ...entry.fields, name: 'Mine' } }))
    expect(rebaseJobSchedules([record(8, { version: 1 })], [record(8, { version: 5, activeStartTime: 10000 })], own)[0]?.fields).toMatchObject({ name: 'Mine', activeStartTime: 10000 })
    expect(jobSchedulesSave([], moved)?.attach?.map(guard => guard.version)).toEqual([2, 5])
    // A picked schedule deleted since: dropped when the read is complete (its attach could only be STALE), kept when it was cut short.
    expect(refreshPickedSchedules(entries, [record(8, { version: 5 })], true).map(entry => entry.key)).toEqual(['s:8', 'n:1'])
    expect(refreshPickedSchedules(entries, [record(8, { version: 5 })]).map(entry => entry.key)).toEqual(['s:9', 's:8', 'n:1'])
    // Keep my changes in the Schedules document: what the user changed stays, the rest takes the server's new values.
    expect(rebaseScheduleFields(record(1), record(1, { name: 'Theirs', activeStartTime: 10000, version: 4 }), { ...fields(), enabled: false })).toMatchObject({ name: 'Theirs', enabled: false, activeStartTime: 10000 })
    expect(rebaseScheduleFields(record(1), record(1, { name: 'Theirs', version: 4 }), { ...fields(), name: 'Mine', activeStartTime: 40000 })).toMatchObject({ name: 'Mine', activeStartTime: 40000 })
  })
  it('bounds a job save in zod as C# does', () => {
    expect(jobSchedulesSaveSchema.safeParse({ detach: [] }).success).toBe(false)
    expect(jobSchedulesSaveSchema.safeParse({ attach: [{ id: 1, version: 1, modified: '2026-11-20T01:02:03' }] }).success).toBe(false)
    expect(jobSchedulesSaveSchema.safeParse({ add: [{ name: 'x', enabled: true, timing: { ...fields(), name: undefined } }] }).success).toBe(false)
    expect(jobSchedulesSaveSchema.safeParse({ detach: Array.from({ length: agentLimits.schedulesPerJob + 1 }, (_, at) => ({ id: at + 1, deleteUnused: false })) }).success).toBe(false)
    expect(jobSchedulesSaveProblems({ detach: [{ id: 1, deleteUnused: false }], attach: [{ id: 1, version: 1, modified: '2026-11-20T01:02:03.000' }] })).toContain('A schedule is attached or detached twice.')
    expect(jobSchedulesSaveProblems({ update: [{ id: 1, version: 1, modified: '2026-11-20T01:02:03.000' }] })).toContain('A schedule update changes nothing.')
  })
})

describe('the standalone schedule save', () => {
  it('creates whole, updates only what changed under the guard, and refuses mixed shapes', () => {
    expect(scheduleDraftSave(undefined, fields({ name: ' X ' }), [{ jobId: '11111111-1111-1111-1111-111111111111', version: 2, attach: true }])).toEqual({
      op: 'create', name: 'X', enabled: true, timing: expect.objectContaining({ activeStartTime: 23000 }), jobs: [{ jobId: '11111111-1111-1111-1111-111111111111', version: 2, attach: true }]
    })
    const read = record(5)
    expect(scheduleDraftSave(read, scheduleFieldsOf(read))).toBeUndefined()
    expect(scheduleDraftSave(read, { ...scheduleFieldsOf(read), enabled: false })).toEqual({ op: 'update', schedule: { id: 5, version: 3, modified: '2026-11-20T01:02:03.456' }, enabled: false })
    expect(scheduleDraftSave(record(5, { version: undefined }), { ...scheduleFieldsOf(read), enabled: false })).toBeUndefined()
    const guard = { id: 5, version: 3, modified: '2026-11-20T01:02:03.456' }
    expect(scheduleSaveProblems({ op: 'delete', schedule: guard })).toEqual([])
    expect(scheduleSaveProblems({ op: 'delete', schedule: guard, enabled: true })).toEqual(['delete takes only the schedule.'])
    expect(scheduleSaveProblems({ op: 'create', name: 'x' })).toContain('A new schedule names its name, enabled and timing.')
    expect(scheduleSaveProblems({ op: 'update', schedule: guard })).toEqual(['There is nothing to change.'])
    expect(scheduleSaveSchema.safeParse({ op: 'enable', schedule: guard }).success).toBe(true)
    expect(scheduleSaveSchema.safeParse({ op: 'drop', schedule: guard }).success).toBe(false)
    expect(scheduleSaveSchema.safeParse({ op: 'update', schedule: guard, jobs: [{ jobId: 'not-a-guid', version: 1, attach: true }] }).success).toBe(false)
  })
  it('keeps every command behind the release gate, with Manage Schedules on the Jobs folder and New › Schedule… on the Agent node', () => {
    for (const [id, entry] of Object.entries(agentScheduleCommandEntries())) expect(entry.precondition, id).toContain('agentEnabled')
    expect(commandDescriptor('agent.schedules').menus?.[0].when).toContain("explorerFolder == 'agentJobs'")
    expect(commandDescriptor('agent.newSchedule').menus?.[0]).toMatchObject({ menu: 'explorer.new', title: 'Schedule…', when: "explorerNode == 'agent' && !explorerServerLost" })
    expect(commandDescriptor('agent.newJobOnAgent').menus?.[0]).toMatchObject({ menu: 'explorer.new', when: "explorerNode == 'agent' && !explorerServerLost" })
    expect(commandDescriptor('agent.newJob').menus?.map(item => item.menu)).not.toContain('explorer.new')
    expect(JSON.stringify(submenus['explorer.new'])).toContain("(explorerNode == 'agent' && agentEnabled)")
  })
})

// --- The Schedules document ------------------------------------------------------------------------------------------------

const jobA = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'ETL', enabled: true, owner: 'sa', version: 4 }
const jobB = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Backup', enabled: true, owner: 'sa', version: 9 }
const schedulesModel = (patch: Partial<AgentSchedulesModel> = {}): AgentSchedulesModel => ({
  login: 'sa', sysadmin: true, platform: 'windows', now: '2026-11-22T14:30:00',
  schedules: [record(1), record(2, { name: 'Unused', jobCount: 0 }), record(3, { name: 'Off', enabled: false, owner: 'dana' })],
  jobs: [jobA, jobB], links: [{ scheduleId: 1, jobId: jobA.id }, { scheduleId: 3, jobId: jobB.id }], durations: [], ...patch
})

function schedulesWorkbench(first = schedulesModel()) {
  const fixture = workbenchFixture({ agentPreview: true })
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  let current = first
  const answers: ApiResult<ActionExecuteResult>[] = []
  fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog !== 'agentSchedules' ? { elapsedMs: 1 }
    : params.schedule !== undefined ? { agentSchedules: { ...current, schedules: [], scheduleJobs: [jobB] }, elapsedMs: 1 }
      : { agentSchedules: current, elapsedMs: 1 }) as ActionDescribeResult }))
  fixture.api.executeObjectAction.mockImplementation(async () => answers.shift() ?? { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
  const executes = () => fixture.api.executeObjectAction.mock.calls.map(([sent]) => sent as ActionRequest)
  return { ...fixture, executes, answers, setModel: (next: AgentSchedulesModel) => { current = next } }
}

describe('the Schedules document', () => {
  it('filters by view and by schedule or job name', () => {
    const model = schedulesModel()
    expect(visibleSchedules(model, 'all', '').map(item => item.id)).toEqual([1, 2, 3])
    expect(visibleSchedules(model, 'unused', '').map(item => item.id)).toEqual([2])
    expect(visibleSchedules(model, 'disabled', '').map(item => item.id)).toEqual([3])
    expect(visibleSchedules(model, 'all', 'backup').map(item => item.id)).toEqual([3])
    expect(visibleSchedules(model, 'all', 'unused').map(item => item.id)).toEqual([2])
  })
  it('opens one tab per connection, saves the selected schedule under its guard with job changes, and reads again', async () => {
    const { schedules, documents, executes, setModel } = schedulesWorkbench()
    const id = schedules.open('c1')
    expect(documents.active).toMatchObject({ id, kind: 'agentSchedules', name: 'Schedules', connectionId: 'c1' })
    await settled()
    expect(schedules.get(id)).toMatchObject({ phase: 'ready' })
    expect(schedules.open('c1')).toBe(id)
    schedules.select(id, '1')
    expect(schedules.jobsOf(id, 1)?.map(job => job.name)).toEqual(['ETL'])
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Nightly' })
    schedules.toggleJob(id, jobB.id, true)
    schedules.toggleJob(id, jobA.id, false)
    expect(schedules.draftJobs(id).map(job => job.name)).toEqual(['Backup'])
    expect(schedules.changes(id)).toBe(3)
    expect(documents.get(id)?.dirty).toBe(true)
    // Unsaved drafts close through Save / Don't Save (the tab is dirty), not a refusal.
    expect(schedules.canClose(id)).toBeUndefined()
    setModel(schedulesModel({ schedules: [record(1, { name: 'Nightly', version: 4 })] }))
    expect(await schedules.save(id)).toBe(true)
    expect(executes()[0]).toMatchObject({
      action: 'agentSchedule', target: { kind: 'agent' },
      agentSchedule: { op: 'update', schedule: { id: 1, version: 3, modified: '2026-11-20T01:02:03.456' }, name: 'Nightly', jobs: [{ jobId: jobB.id, version: 9, attach: true }, { jobId: jobA.id, version: 4, attach: false }] }
    })
    await settled()
    expect(schedules.get(id)).toMatchObject({ phase: 'ready', selected: '1', notice: schedulesText.saved('Nightly'), drafts: {} })
    expect(documents.get(id)?.dirty).toBe(false)
  })
  it('creates a new schedule from New › Schedule… and selects it once read', async () => {
    const { schedules, executes, setModel } = schedulesWorkbench()
    const id = schedules.open('c1', true)
    await settled()
    expect(schedules.get(id)?.selected).toBe(newScheduleKey)
    expect(schedules.canSave(id)).toBe(false)
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Month end' })
    expect(schedules.canSave(id)).toBe(true)
    setModel(schedulesModel({ schedules: [...schedulesModel().schedules, record(7, { name: 'Month end', jobCount: 0 })] }))
    expect(await schedules.save(id)).toBe(true)
    expect(executes()[0]).toMatchObject({ action: 'agentSchedule', agentSchedule: { op: 'create', name: 'Month end', enabled: true } })
    await settled()
    expect(schedules.get(id)).toMatchObject({ selected: '7', notice: schedulesText.created('Month end') })
  })
  it('saves the Enabled box at once, refuses a schedule another login owns below sysadmin, and asks before Delete', async () => {
    const { schedules, executes, answers } = schedulesWorkbench(schedulesModel({ sysadmin: false, login: 'sa', links: undefined }))
    const id = schedules.open('c1')
    await settled()
    await schedules.setEnabled(id, 1, false)
    expect(executes()[0]).toMatchObject({ agentSchedule: { op: 'disable', schedule: { id: 1, version: 3 } } })
    await settled()
    // Schedule 3 is dana's: read-only for sa below sysadmin, so neither Enabled nor Delete is offered.
    expect(schedules.readOnly(id, schedules.record(id, '3'))).toBe(schedulesText.readOnly('dana'))
    await schedules.setEnabled(id, 3, true)
    expect(executes()).toHaveLength(1)
    // Below sysadmin, a schedule's jobs are read when it is selected.
    schedules.select(id, '3')
    await settled()
    expect(schedules.jobsOf(id, 3)?.map(job => job.name)).toEqual(['Backup'])
    expect(schedules.canDelete(id)).toBe(false)
    schedules.select(id, '1')
    schedules.askDelete(id)
    expect(schedules.get(id)?.confirmDelete).toBe(true)
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'IN_USE', message: 'The schedule is in use.', retryable: false } } })
    expect(await schedules.confirmDelete(id)).toBe(false)
    expect(executes()[1]).toMatchObject({ agentSchedule: { op: 'delete', schedule: { id: 1 } } })
    expect(executes()[1]).not.toHaveProperty('agentSchedule.force')
    expect(schedules.get(id)?.error?.message).toBe(schedulesText.inUse(1))
    schedules.askDelete(id)
    expect(await schedules.confirmDelete(id)).toBe(true)
    await settled()
    expect(schedules.get(id)).toMatchObject({ notice: schedulesText.deleted('Nightly 02:30') })
    expect(schedules.get(id)?.selected).toBeUndefined()
  })
  it('keeps drafts across Refresh but drops those of schedules gone since, and says when the connection is lost mid-save', async () => {
    const { schedules, setModel, connections, api } = schedulesWorkbench()
    const id = schedules.open('c1')
    await settled()
    schedules.select(id, '1')
    schedules.update(id, { ...schedules.draft(id)!.fields, enabled: false })
    schedules.select(id, '2')
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Spare' })
    setModel(schedulesModel({ schedules: [record(1)] }))
    schedules.refresh(id)
    await settled()
    expect(Object.keys(schedules.get(id)!.drafts)).toEqual(['1'])
    expect(schedules.get(id)?.selected).toBeUndefined()
    // The connection goes while a save is on its way: whether it ran is unknown, and the draft stays.
    schedules.select(id, '1')
    let answer: (value: ApiResult<ActionExecuteResult>) => void = () => {}
    api.executeObjectAction.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const saving = schedules.save(id)
    expect(schedules.get(id)?.busy).toBe('saving')
    connections.markLostBefore(2)
    answer({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    expect(await saving).toBe(false)
    expect(schedules.get(id)?.error?.message).toBe(schedulesText.lost)
    expect(schedules.get(id)?.drafts['1']).toBeDefined()
    expect(schedules.canSave(id)).toBe(false)
  })
  it("guards a draft by the schedule it began from, and after STALE keeps the user's changes on top of the new one", async () => {
    const { schedules, setModel, executes, answers } = schedulesWorkbench()
    const id = schedules.open('c1')
    await settled()
    schedules.select(id, '1')
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Mine' })
    // Another session changes schedule 1 and this document reads again (Refresh, or after saving another schedule): the draft's guard stays.
    setModel(schedulesModel({ schedules: [record(1, { version: 4, activeStartTime: 10000 }), record(2, { name: 'Unused', jobCount: 0 })] }))
    schedules.refresh(id)
    await settled()
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Changed.', retryable: false, field: 'schedules' } } })
    expect(await schedules.save(id)).toBe(false)
    expect(executes()[0]).toMatchObject({ agentSchedule: { op: 'update', schedule: { id: 1, version: 3 }, name: 'Mine' } })
    expect(executes()[0]).not.toHaveProperty('agentSchedule.timing')
    await settled()
    // Their start time, my name, and the new guard; the next Save is the user's.
    expect(schedules.get(id)?.error).toMatchObject({ code: 'STALE', message: schedulesText.staleKept })
    expect(schedules.draft(id)).toMatchObject({ base: { version: 4 }, fields: { name: 'Mine', activeStartTime: 10000 } })
    expect(await schedules.save(id)).toBe(true)
    expect(executes()[1]).toMatchObject({ agentSchedule: { op: 'update', schedule: { id: 1, version: 4 }, name: 'Mine' } })
    expect(executes()[1]).not.toHaveProperty('agentSchedule.timing')
  })
  it('reads the chosen jobs again after a STALE Create, keeps a pending new schedule, and drops a jobs read from before a re-read', async () => {
    const { schedules, setModel, executes, answers, api } = schedulesWorkbench()
    const id = schedules.open('c1', true)
    await settled()
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Month end' })
    schedules.toggleJob(id, jobB.id, true)
    // New schedule again (or New › Schedule…, or Duplicate) keeps the half-filled one.
    schedules.newSchedule(id)
    schedules.duplicate(id)
    expect(schedules.draft(id)?.fields.name).toBe('Month end')
    expect(schedules.get(id)?.notice).toBe(schedulesText.newPending)
    setModel(schedulesModel({ jobs: [jobA, { ...jobB, version: 10 }] }))
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Changed.', retryable: false } } })
    expect(await schedules.save(id)).toBe(false)
    await settled()
    expect(schedules.get(id)?.error?.message).toBe(schedulesText.staleJobs)
    expect(await schedules.save(id)).toBe(true)
    expect(executes()[1]).toMatchObject({ agentSchedule: { op: 'create', name: 'Month end', jobs: [{ jobId: jobB.id, version: 10, attach: true }] } })
    await settled()
    // Below sysadmin, a schedule's jobs read that answers after the schedules were read again is dropped.
    setModel(schedulesModel({ sysadmin: false, links: undefined }))
    schedules.refresh(id)
    await settled()
    let answer: (value: ApiResult<ActionDescribeResult>) => void = () => {}
    api.describeObject.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    schedules.select(id, '2')
    expect(schedules.get(id)?.scheduleJobs?.[2]?.state).toBe('loading')
    schedules.refresh(id)
    await settled()
    answer({ ok: true, value: { agentSchedules: { ...schedulesModel(), schedules: [], scheduleJobs: [jobA] }, elapsedMs: 1 } })
    await settled()
    expect(schedules.jobsOf(id, 2)?.map(job => job.name)).toEqual(['Backup'])
  })
  it("attaches and detaches only jobs the login owns below sysadmin, and reads a failed schedule's jobs again", async () => {
    const { schedules, api } = schedulesWorkbench(schedulesModel({ sysadmin: false, login: 'sa', links: undefined, jobs: [jobA, { ...jobB, owner: 'dana' }] }))
    const id = schedules.open('c1')
    await settled()
    api.describeObject.mockImplementationOnce(async () => ({ ok: false, code: 'SQL_ERROR', error: 'Refused.' }))
    schedules.select(id, '1')
    await settled()
    expect(schedules.get(id)?.scheduleJobs?.[1]?.state).toBe('failed')
    schedules.ensureScheduleJobs(id, 1)
    await settled()
    expect(schedules.get(id)?.scheduleJobs?.[1]?.state).toBe('ready')
    expect(schedules.canChangeJob(id, jobA)).toBe(true)
    expect(schedules.canChangeJob(id, { owner: 'dana' })).toBe(false)
    schedules.toggleJob(id, jobB.id, true)
    expect(schedules.get(id)?.drafts['1']).toBeUndefined()
    schedules.toggleJob(id, jobA.id, true)
    expect(schedules.get(id)?.drafts['1']?.jobs).toEqual([{ jobId: jobA.id, version: 4, attach: true }])
  })
  it("saves every changed draft for File › Save and the close prompt, refuses to close only mid-save, and drops an older schedules read", async () => {
    const { schedules, executes, answers, api, documents } = schedulesWorkbench()
    const id = schedules.open('c1')
    await settled()
    schedules.select(id, '1')
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'One' })
    schedules.select(id, '2')
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Two' })
    schedules.select(id, '3')
    // The palette's Save Schedule follows any changed draft, not only the selected one.
    expect(schedules.canSave(id)).toBe(false)
    expect(schedules.canSaveAll(id)).toBe(true)
    let answer: (value: ApiResult<ActionExecuteResult>) => void = () => {}
    api.executeObjectAction.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const saving = schedules.save(id)
    await settled()
    expect(schedules.canClose(id)).toBeDefined()
    answer({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    expect(await saving).toBe(true)
    expect(executes()).toMatchObject([{ agentSchedule: { schedule: { id: 1 }, name: 'One' } }, { agentSchedule: { schedule: { id: 2 }, name: 'Two' } }])
    expect(documents.get(id)?.dirty).toBe(false)
    expect(schedules.canClose(id)).toBeUndefined()
    // A refusal stops the run on the draft it refused, selected so its error shows.
    schedules.select(id, '1')
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Uno' })
    schedules.select(id, '2')
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Dos' })
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'SQL_ERROR', message: 'Refused.', retryable: false } } })
    expect(await schedules.save(id)).toBe(false)
    expect(executes()).toHaveLength(3)
    expect(schedules.get(id)?.selected).toBe('2')
    // A Refresh that answers after a later read (here the read after an Enabled toggle) is dropped.
    schedules.discard(id)
    let late: (value: ApiResult<ActionDescribeResult>) => void = () => {}
    api.describeObject.mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
    schedules.refresh(id)
    await schedules.setEnabled(id, 2, false)
    await settled()
    late({ ok: true, value: { agentSchedules: schedulesModel({ schedules: [record(1, { name: 'Stale' })] }), elapsedMs: 1 } })
    await settled()
    expect(schedules.get(id)?.model?.schedules.map(item => item.name)).not.toContain('Stale')
  })
  it('stays busy until the read after a save lands, so neither a toggle nor an edit starts from the schedules as they were', async () => {
    const { schedules, api, executes } = schedulesWorkbench()
    const id = schedules.open('c1')
    await settled()
    schedules.select(id, '1')
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Renamed' })
    let read: (value: ApiResult<ActionDescribeResult>) => void = () => {}
    api.describeObject.mockImplementationOnce(() => new Promise(resolve => { read = resolve }))
    const saving = schedules.saveSelected(id)
    await settled()
    expect(executes()).toHaveLength(1)
    expect(schedules.get(id)?.busy).toBe('saving')
    await schedules.setEnabled(id, 2, false)
    schedules.update(id, { ...schedules.draft(id)!.fields, activeStartTime: 40000 })
    expect(executes()).toHaveLength(1)
    expect(schedules.get(id)?.drafts['1']).toBeUndefined()
    read({ ok: true, value: { agentSchedules: schedulesModel({ schedules: [record(1, { name: 'Renamed', version: 4 }), record(2, { name: 'Unused', jobCount: 0 })] }), elapsedMs: 1 } })
    expect(await saving).toBe(true)
    expect(schedules.get(id)).toMatchObject({ notice: schedulesText.saved('Renamed') })
    expect(schedules.get(id)?.busy).toBeUndefined()
    expect(schedules.canClose(id)).toBeUndefined()
  })
  it("keeps a STALE save's own message with the read's failure when the read after it fails, and does not claim to show their change", async () => {
    const { schedules, api, answers } = schedulesWorkbench()
    const id = schedules.open('c1')
    await settled()
    schedules.select(id, '1')
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Mine' })
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Changed.', retryable: false } } })
    api.describeObject.mockImplementationOnce(async () => ({ ok: false, code: 'SQL_ERROR', error: 'Read refused.' }))
    expect(await schedules.save(id)).toBe(false)
    await settled()
    expect(schedules.get(id)?.error).toMatchObject({ code: 'STALE', message: 'Changed. Read refused.' })
    expect(schedules.get(id)?.busy).toBeUndefined()
    expect(schedules.draft(id)?.fields.name).toBe('Mine')
  })
  it('leaves out a chosen job that is gone after a STALE save, so the next save does not send it', async () => {
    const { schedules, setModel, executes, answers } = schedulesWorkbench()
    const id = schedules.open('c1', true)
    await settled()
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Month end' })
    schedules.toggleJob(id, jobA.id, true)
    schedules.toggleJob(id, jobB.id, true)
    setModel(schedulesModel({ jobs: [jobA], links: [{ scheduleId: 1, jobId: jobA.id }] }))
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Changed.', retryable: false } } })
    expect(await schedules.save(id)).toBe(false)
    await settled()
    expect(schedules.get(id)?.error?.message).toBe(`${schedulesText.staleJobs} ${schedulesText.jobsDropped(1)}`)
    expect(await schedules.save(id)).toBe(true)
    expect(executes()[1]).toMatchObject({ agentSchedule: { op: 'create', name: 'Month end', jobs: [{ jobId: jobA.id, attach: true }] } })
    expect((executes()[1] as { agentSchedule?: { jobs?: unknown[] } }).agentSchedule?.jobs).toHaveLength(1)
  })
  it("drops a job change someone else already made after a STALE save, and lists an attached job once", async () => {
    const { schedules, setModel, answers } = schedulesWorkbench()
    const id = schedules.open('c1')
    await settled()
    schedules.select(id, '1')
    schedules.toggleJob(id, jobA.id, false)
    schedules.toggleJob(id, jobB.id, true)
    // Someone else detached Backup's sibling ETL (its version moved) and attached Backup.
    setModel(schedulesModel({ jobs: [{ ...jobA, version: 5 }, jobB], links: [{ scheduleId: 1, jobId: jobB.id }, { scheduleId: 3, jobId: jobB.id }] }))
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Changed.', retryable: false } } })
    expect(await schedules.save(id)).toBe(false)
    await settled()
    expect(schedules.get(id)?.error?.message).toBe(`${schedulesText.staleKept} ${schedulesText.jobsDropped(2)}`)
    expect(schedules.draft(id)?.jobs).toEqual([])
    expect(schedules.draftJobs(id).map(job => job.name)).toEqual(['Backup'])
  })
  it("waits below sysadmin for the schedule's own jobs read before keeping a detach after a STALE save", async () => {
    const { schedules, api, answers, executes } = schedulesWorkbench()
    let model = schedulesModel({ sysadmin: false, links: undefined }), using = [jobA]
    api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.schedule !== undefined ? { agentSchedules: { ...model, schedules: [], scheduleJobs: using }, elapsedMs: 1 }
      : { agentSchedules: model, elapsedMs: 1 }) as ActionDescribeResult }))
    const id = schedules.open('c1')
    await settled()
    schedules.select(id, '1')
    await settled()
    expect(schedules.jobsOf(id, 1)?.map(job => job.name)).toEqual(['ETL'])
    schedules.toggleJob(id, jobA.id, false)
    // Someone else detached ETL (its version moved).
    model = schedulesModel({ sysadmin: false, links: undefined, jobs: [{ ...jobA, version: 5 }, jobB] })
    using = []
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Changed.', retryable: false } } })
    expect(await schedules.save(id)).toBe(false)
    await settled()
    expect(schedules.get(id)?.error?.message).toBe(`${schedulesText.staleKept} ${schedulesText.jobsDropped(1)}`)
    expect(schedules.draft(id)?.jobs).toEqual([])
    expect(schedules.get(id)?.busy).toBeUndefined()
    expect(executes()).toHaveLength(1)
  })
  it("attaches and detaches the login's own jobs on another login's schedule, as msdb allows, but changes none of its settings", async () => {
    const { schedules, executes } = schedulesWorkbench(schedulesModel({ sysadmin: false, login: 'sa', links: undefined }))
    const id = schedules.open('c1')
    await settled()
    schedules.select(id, '3')
    await settled()
    const theirs = schedules.record(id, '3')
    expect(schedules.readOnly(id, theirs)).toBe(schedulesText.readOnly('dana'))
    expect(schedules.canChangeJobsOf(id, theirs)).toBe(true)
    schedules.toggleJob(id, jobA.id, true)
    expect(schedules.canSave(id)).toBe(true)
    expect(await schedules.save(id)).toBe(true)
    expect(executes()[0]).toMatchObject({ agentSchedule: { op: 'update', schedule: { id: 3 }, jobs: [{ jobId: jobA.id, attach: true }] } })
    expect(executes()[0]).not.toHaveProperty('agentSchedule.name')
    // A schedule whose version could not be read takes no job change.
    expect(schedules.canChangeJobsOf(id, { ...theirs!, version: undefined })).toBe(false)
  })
  it("marks a schedule's jobs read the connection's loss dropped as failed, so it is read again", async () => {
    const { schedules, api, connections } = schedulesWorkbench(schedulesModel({ sysadmin: false, links: undefined }))
    const id = schedules.open('c1')
    await settled()
    let answer: (value: ApiResult<ActionDescribeResult>) => void = () => {}
    api.describeObject.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    schedules.select(id, '2')
    expect(schedules.get(id)?.scheduleJobs?.[2]?.state).toBe('loading')
    connections.markLostBefore(2)
    answer({ ok: true, value: { agentSchedules: { ...schedulesModel(), schedules: [], scheduleJobs: [jobA] }, elapsedMs: 1 } })
    await settled()
    expect(schedules.get(id)?.scheduleJobs?.[2]?.state).toBe('failed')
  })
  it("starts New › Schedule…'s untouched draft on the server's date once read, not the local one", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 10, 25, 9, 0, 0))
      const { schedules } = schedulesWorkbench()
      const id = schedules.open('c1', true)
      expect(schedules.draft(id)?.fields.activeStartDate).toBe(20261125)
      await settled()
      // The server reads 2026-11-22, a Sunday.
      expect(schedules.draft(id)?.fields).toMatchObject({ activeStartDate: 20261122, freqInterval: 1 })
    } finally { vi.useRealTimers() }
  })
  it("moves a draft's guard with its own Enabled toggle, not with someone else's change", async () => {
    const { schedules, setModel, executes } = schedulesWorkbench()
    const id = schedules.open('c1')
    await settled()
    schedules.select(id, '1')
    schedules.update(id, { ...schedules.draft(id)!.fields, name: 'Mine' })
    setModel(schedulesModel({ schedules: [record(1, { enabled: false, version: 4 })] }))
    await schedules.setEnabled(id, 1, false)
    await settled()
    expect(schedules.draft(id)).toMatchObject({ base: { version: 4 }, fields: { name: 'Mine', enabled: false } })
    expect(await schedules.save(id)).toBe(true)
    expect(executes()[1]).toMatchObject({ agentSchedule: { op: 'update', schedule: { id: 1, version: 4 }, name: 'Mine' } })
    expect(executes()[1]).not.toHaveProperty('agentSchedule.enabled')
  })
})

// --- The job document's Schedules section ------------------------------------------------------------------------------------

describe("the job document's Schedules section", () => {
  const job: AgentJobDocumentModel = {
    job: { jobId: jobA.id, name: 'ETL', enabled: true, description: '', category: uncategorizedCategory, owner: 'sa', emailLevel: 0, emailOperator: '', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0, created: '2026-01-01T00:00:00', modified: '2026-11-20T00:00:00.000', version: 4, startStepId: 1 },
    login: 'sa', sysadmin: true, platform: 'windows', categories: [uncategorizedCategory], operators: [], owners: ['sa'], steps: [], alerts: [], alertsEditable: true, mail: { checked: false, sysadmin: true },
    schedules: [record(1)], now: '2026-11-22T14:30:00'
  }
  function jobWorkbench() {
    const fixture = workbenchFixture({ agentPreview: true })
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    let shared = schedulesModel()
    const answers: ApiResult<ActionExecuteResult>[] = []
    fixture.api.describeObject.mockImplementation(async params => ({ ok: true, value: (params.dialog === 'agentSchedules' ? { agentSchedules: shared, elapsedMs: 1 }
      : params.dialog === 'agentJob' ? { agentJobDocument: job, elapsedMs: 1 } : { elapsedMs: 1 }) as ActionDescribeResult }))
    fixture.api.executeObjectAction.mockImplementation(async () => answers.shift() ?? { ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    const executes = () => fixture.api.executeObjectAction.mock.calls.map(([sent]) => sent as ActionRequest)
    return { ...fixture, executes, answers, setShared: (next: AgentSchedulesModel) => { shared = next } }
  }
  it('reads the shared schedules once, edits new, picked and removed entries in place, and sends them with the job', async () => {
    const { jobDocuments, executes, api } = jobWorkbench()
    const id = jobDocuments.openJob('c1', 'ETL')
    await settled()
    expect(jobDocuments.now(id)).toEqual(now)
    jobDocuments.ensureShared(id)
    jobDocuments.ensureShared(id)
    await settled()
    expect(api.describeObject.mock.calls.filter(([sent]) => sent.dialog === 'agentSchedules')).toHaveLength(1)
    expect(jobDocuments.get(id)?.shared?.state).toBe('ready')
    // New schedule named from the search, a picked shared schedule, and the job's own removed (detach by default, then delete; Undo restores).
    jobDocuments.setScheduleSearch(id, 'Month end')
    jobDocuments.newSchedule(id, 'Month end')
    const created = jobDocuments.get(id)!.draft!.schedules.at(-1)!
    expect(created).toMatchObject({ fields: { name: 'Month end', freqType: freq.weekly } })
    expect(jobDocuments.get(id)).toMatchObject({ scheduleSelected: created.key, scheduleSearch: '' })
    jobDocuments.attachSchedule(id, record(2, { name: 'Unused', jobCount: 0 }))
    jobDocuments.attachSchedule(id, record(2, { name: 'Unused', jobCount: 0 }))
    expect(jobDocuments.get(id)!.draft!.schedules.filter(entry => entry.id === 2)).toHaveLength(1)
    jobDocuments.removeSchedule(id, 's:1')
    expect(jobDocuments.get(id)!.draft!.schedules.find(entry => entry.key === 's:1')?.remove).toBe('detach')
    jobDocuments.setRemoveMode(id, 's:1', 'delete')
    jobDocuments.undoRemove(id, 's:1')
    expect(jobDocuments.get(id)!.draft!.schedules.find(entry => entry.key === 's:1')?.remove).toBeUndefined()
    jobDocuments.removeSchedule(id, 's:1')
    jobDocuments.setRemoveMode(id, 's:1', 'delete')
    expect(jobDocuments.get(id)?.changes).toBe(3)
    expect(await jobDocuments.save(id)).toBe(true)
    expect(executes()[0]).toMatchObject({
      action: 'agentJob', agentJob: { version: 4, schedules: { detach: [{ id: 1, deleteUnused: true }], attach: [{ id: 2, version: 3 }], add: [{ name: 'Month end', enabled: true }] } }
    })
  })
  it('copies a shared schedule for this job only: the shared one is detached and a new copy takes its place', async () => {
    const { jobDocuments } = jobWorkbench()
    const id = jobDocuments.openJob('c1', 'ETL')
    await settled()
    jobDocuments.updateSchedule(id, 's:1', { ...jobDocuments.get(id)!.draft!.schedules[0].fields, activeStartTime: 40000 })
    jobDocuments.copySchedule(id, 's:1')
    const entries = jobDocuments.get(id)!.draft!.schedules
    // The shared schedule goes back to its fields as read, and the edit moves to the copy.
    expect(entries[0]).toMatchObject({ key: 's:1', remove: 'detach', fields: { activeStartTime: 23000 } })
    expect(entries[1]).toMatchObject({ fields: { name: 'Nightly 02:30 (copy)', activeStartTime: 40000 } })
    expect(entries[1].id).toBeUndefined()
    expect(jobDocuments.get(id)?.scheduleSelected).toBe(entries[1].key)
    expect(jobDocuments.canChangeSchedule(id, record(5, { owner: 'dana' }))).toBe(true)
  })
  it("gives a picked schedule the guard read again on Reload and keep my changes, so the save is not STALE for ever", async () => {
    const { jobDocuments, executes, answers, setShared } = jobWorkbench()
    const id = jobDocuments.openJob('c1', 'ETL')
    await settled()
    jobDocuments.ensureShared(id)
    await settled()
    jobDocuments.attachSchedule(id, jobDocuments.get(id)!.shared!.model!.schedules[1])
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Changed.', retryable: false, field: 'schedules' } } })
    expect(await jobDocuments.save(id)).toBe(false)
    await settled()
    expect(jobDocuments.get(id)?.stale).toBeDefined()
    setShared(schedulesModel({ schedules: [record(1), record(2, { name: 'Unused (theirs)', jobCount: 0, version: 6 })] }))
    jobDocuments.reloadKeep(id)
    await settled()
    expect(jobDocuments.get(id)!.draft!.schedules.find(entry => entry.id === 2)).toMatchObject({ base: { version: 6 }, fields: { name: 'Unused (theirs)' } })
    expect(await jobDocuments.save(id)).toBe(true)
    expect(executes()[1]).toMatchObject({ agentJob: { schedules: { attach: [{ id: 2, version: 6 }] } } })
  })
  it('drops a picked schedule someone deleted on Reload and keep my changes, and says so, so the save is not STALE for ever', async () => {
    const { jobDocuments, answers, setShared } = jobWorkbench()
    const id = jobDocuments.openJob('c1', 'ETL')
    await settled()
    jobDocuments.ensureShared(id)
    await settled()
    jobDocuments.attachSchedule(id, jobDocuments.get(id)!.shared!.model!.schedules[1])
    answers.push({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'STALE', message: 'Changed.', retryable: false, field: 'schedules' } } })
    expect(await jobDocuments.save(id)).toBe(false)
    await settled()
    setShared(schedulesModel({ schedules: [record(1)] }))
    jobDocuments.reloadKeep(id)
    await settled()
    expect(jobDocuments.get(id)!.draft!.schedules.some(entry => entry.id === 2)).toBe(false)
    expect(jobDocuments.get(id)?.notice).toBe(jobScheduleText.pickedGone(1))
  })
  it('drops a shared read that answers after a save started the reads over', async () => {
    const { jobDocuments, api } = jobWorkbench()
    const id = jobDocuments.openJob('c1', 'ETL')
    await settled()
    let answer: (value: ApiResult<ActionDescribeResult>) => void = () => {}
    api.describeObject.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    jobDocuments.ensureShared(id)
    expect(jobDocuments.get(id)?.shared?.state).toBe('loading')
    jobDocuments.updateSchedule(id, 's:1', { ...jobDocuments.get(id)!.draft!.schedules[0].fields, activeStartTime: 40000 })
    expect(await jobDocuments.save(id)).toBe(true)
    await settled()
    expect(jobDocuments.get(id)?.shared).toBeUndefined()
    answer({ ok: true, value: { agentSchedules: schedulesModel({ schedules: [record(99)] }), elapsedMs: 1 } })
    await settled()
    expect(jobDocuments.get(id)?.shared).toBeUndefined()
  })
})
