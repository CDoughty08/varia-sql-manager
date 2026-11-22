// SQL Server Agent schedules (AG-6c, docs/agent-plan.md › Schedules, docs/agent-ui-rethink.md › rx-job-schedules): the sysschedules
// encoding the editor reads and writes, SSMS's Description sentence and a short "when" for lists, the presets that only fill the fields,
// the problems msdb's sp_verify_schedule would refuse, the next runs in server time, and the free-slot check against other jobs' usual
// durations. Pure and erasable TypeScript: no React, no I/O. Times are the server's local wall clock, as msdb stores them; nothing
// here converts time zones.
import { agentGateOpen, agentLimits, relativeDays, relativeIntervals, weekDays, type AgentPlatform } from './catalog.ts'

/** A schedule's frequency, exactly as sysschedules stores it (sp_add_schedule's and sp_update_schedule's arguments). */
export interface AgentScheduleTiming {
  /** 1 one time, 4 daily, 8 weekly, 16 monthly, 32 monthly relative, 64 when Agent starts, 128 when the CPUs become idle. */
  readonly freqType: number
  /** Daily: every n days. Weekly: a bit per day (Sunday 1 … Saturday 64). Monthly: the day of the month. Relative: relativeDays' code. */
  readonly freqInterval: number
  /** 1 at the start time, 2 seconds, 4 minutes, 8 hours. */
  readonly freqSubdayType: number
  readonly freqSubdayInterval: number
  /** Relative: 1 first, 2 second, 4 third, 8 fourth, 16 last. */
  readonly freqRelativeInterval: number
  /** Weekly and monthly: every n weeks or months. */
  readonly freqRecurrenceFactor: number
  /** yyyymmdd. */
  readonly activeStartDate: number
  /** yyyymmdd; 99991231 is no end date. */
  readonly activeEndDate: number
  /** hhmmss. */
  readonly activeStartTime: number
  /** hhmmss; 235959 by default. Below the start time, the active window spans midnight (sp_verify_schedule's note). */
  readonly activeEndTime: number
}
/** A schedule's editable fields: its name, whether it is enabled, and its timing. */
export interface AgentScheduleFields extends AgentScheduleTiming {
  readonly name: string
  readonly enabled: boolean
}

export const freq = { once: 1, daily: 4, weekly: 8, monthly: 16, relative: 32, agentStart: 64, idle: 128 } as const
export const subday = { once: 1, seconds: 2, minutes: 4, hours: 8 } as const
export const noEndDate = 99_991_231
export const endOfDay = 235_959
/** sp_verify_job_date's earliest date. */
export const earliestScheduleDate = 19_900_101

// --- Dates and times as msdb's integers ---------------------------------------------------------------------------------

const pad = (value: number, width = 2) => String(value).padStart(width, '0')
const dayMs = 86_400_000
/** yyyymmdd as days since 1970-01-01 (UTC as a stand-in for the server's wall clock). */
export const dayNumber = (date: number) => Math.floor(Date.UTC(Math.floor(date / 10_000), Math.floor(date / 100) % 100 - 1, date % 100) / dayMs)
/** Days since 1970-01-01 as yyyymmdd. */
export function dateOfDay(day: number): number {
  const value = new Date(day * dayMs)
  return value.getUTCFullYear() * 10_000 + (value.getUTCMonth() + 1) * 100 + value.getUTCDate()
}
/** hhmmss as seconds since midnight. */
/** The end time msdb keeps: sp_verify_schedule stores an end of 00:00:00 as 23:59:59. */
export const effectiveEndTime = (time: number) => time === 0 ? 235959 : time
export const secondsOf = (time: number) => Math.floor(time / 10_000) * 3600 + Math.floor(time / 100) % 100 * 60 + time % 100
/** Seconds since midnight as hhmmss. */
export const timeOf = (seconds: number) => Math.floor(seconds / 3600) * 10_000 + Math.floor(seconds / 60) % 60 * 100 + seconds % 60
/** Whether yyyymmdd is a calendar date from 1990 (sp_verify_job_date) to 9999-12-31. */
export function validDate(date: number): boolean {
  if (!Number.isInteger(date) || date < earliestScheduleDate || date > noEndDate) return false
  return dateOfDay(dayNumber(date)) === date
}
/** Whether hhmmss is a time of day. */
export const validTime = (time: number) => Number.isInteger(time) && time >= 0 && time <= endOfDay && Math.floor(time / 100) % 100 < 60 && time % 100 < 60
/** yyyymmdd as yyyy-mm-dd. */
export const formatDate = (date: number) => `${pad(Math.floor(date / 10_000), 4)}-${pad(Math.floor(date / 100) % 100)}-${pad(date % 100)}`
/** hhmmss as hh:mm, or hh:mm:ss when it has seconds. */
export const formatTime = (time: number) => `${pad(Math.floor(time / 10_000))}:${pad(Math.floor(time / 100) % 100)}${time % 100 ? `:${pad(time % 100)}` : ''}`
/** yyyy-mm-dd as yyyymmdd, or undefined. */
export function parseDate(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (!match) return undefined
  const value = Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3])
  return validDate(value) ? value : undefined
}
/** hh:mm or hh:mm:ss as hhmmss, or undefined. */
export function parseTime(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (!match) return undefined
  const value = Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3] ?? 0)
  return validTime(value) ? value : undefined
}
/** A server wall-clock moment: its date and time as msdb writes them. */
export interface AgentMoment { readonly date: number; readonly time: number }
/** A moment as seconds since 1970-01-01 (wall clock, no zone). */
export const momentSeconds = (moment: AgentMoment) => dayNumber(moment.date) * 86_400 + secondsOf(moment.time)
export const momentOfSeconds = (seconds: number): AgentMoment => ({ date: dateOfDay(Math.floor(seconds / 86_400)), time: timeOf(((seconds % 86_400) + 86_400) % 86_400) })
/** "Sun 22/11/2026 03:00", as the mocks show runs; the weekday is the wall clock's. */
export function formatRun(moment: AgentMoment): string {
  const day = new Date(dayNumber(moment.date) * dayMs).getUTCDay()
  const date = moment.date
  return `${shortDays[day]} ${formatDate(date)} ${formatTime(moment.time)}`
}

// --- Words ----------------------------------------------------------------------------------------------------------------

const shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const dayNames = weekDays.map(day => day.label)
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
/** A weekly bitmap's days in week order ("Monday, Wednesday"). */
export const weeklyDays = (bits: number) => dayNames.filter((_, index) => (bits & (1 << index)) !== 0)
const relativeWord = (code: number) => relativeIntervals.find(entry => entry.code === code)?.label.toLowerCase() ?? `#${code}`
const relativeDay = (code: number) => {
  const label = relativeDays.find(entry => entry.code === code)?.label ?? `#${code}`
  return code === 8 ? 'day' : code === 9 ? 'weekday' : code === 10 ? 'weekend day' : label
}
const unitOf = (type: number) => type === subday.seconds ? 'second' : type === subday.minutes ? 'minute' : 'hour'

/** The daily-frequency part of a sentence: "at 03:00", or "every 15 minutes between 00:00 and 23:59:59". */
function dailyPart(timing: AgentScheduleTiming): string {
  if (timing.freqSubdayType === subday.once || timing.freqSubdayType === 0) return `at ${formatTime(timing.activeStartTime)}`
  return `every ${plural(timing.freqSubdayInterval, unitOf(timing.freqSubdayType))} between ${formatTime(timing.activeStartTime)} and ${formatTime(timing.activeEndTime)}`
}
/** The frequency part: "every day", "every 2 weeks on Monday, Friday", "every month on day 1", "every month on the last Friday". */
function frequencyPart(timing: AgentScheduleTiming): string {
  switch (timing.freqType) {
    case freq.daily: return timing.freqInterval === 1 ? 'every day' : `every ${plural(timing.freqInterval, 'day')}`
    case freq.weekly: {
      const days = weeklyDays(timing.freqInterval).join(', ')
      return `${timing.freqRecurrenceFactor === 1 ? 'every week' : `every ${plural(timing.freqRecurrenceFactor, 'week')}`} on ${days}`
    }
    case freq.monthly: return `${timing.freqRecurrenceFactor === 1 ? 'every month' : `every ${plural(timing.freqRecurrenceFactor, 'month')}`} on day ${timing.freqInterval} of that month`
    case freq.relative:
      return `${timing.freqRecurrenceFactor === 1 ? 'every month' : `every ${plural(timing.freqRecurrenceFactor, 'month')}`} on the ${relativeWord(timing.freqRelativeInterval)} ${relativeDay(timing.freqInterval)} of that month`
    default: return ''
  }
}

/**
 * SSMS's Description sentence for a schedule (the New Job Schedule dialog's Summary), in Varia's formats: 24-hour times and ISO dates, as
 * docs/mockups/sql-server-agent.html shows them. "Occurs every week on Sunday at 03:00. Schedule will be used starting on 2025-02-02."
 */
export function scheduleSentence(timing: AgentScheduleTiming): string {
  switch (timing.freqType) {
    case freq.agentStart: return 'Start automatically when SQL Server Agent starts.'
    case freq.idle: return 'Start whenever the CPUs become idle.'
    case freq.once: return `Occurs on ${formatDate(timing.activeStartDate)} at ${formatTime(timing.activeStartTime)}.`
    default: {
      const used = timing.activeEndDate >= noEndDate
        ? `Schedule will be used starting on ${formatDate(timing.activeStartDate)}.`
        : `Schedule will be used between ${formatDate(timing.activeStartDate)} and ${formatDate(timing.activeEndDate)}.`
      return `Occurs ${frequencyPart(timing)} ${dailyPart(timing)}. ${used}`
    }
  }
}

/** A short "when" for lists and chips: "Every day at 02:30", "Every Sunday at 03:00", "Weekdays at 06:00", "Last day of every month at 22:00". */
export function scheduleWhen(timing: AgentScheduleTiming): string {
  const at = timing.freqSubdayType === subday.once || timing.freqSubdayType === 0 ? `at ${formatTime(timing.activeStartTime)}` : `every ${plural(timing.freqSubdayInterval, unitOf(timing.freqSubdayType))}`
  switch (timing.freqType) {
    case freq.agentStart: return 'When SQL Server Agent starts'
    case freq.idle: return 'Whenever the CPUs become idle'
    case freq.once: return `Once on ${formatDate(timing.activeStartDate)} at ${formatTime(timing.activeStartTime)}`
    case freq.daily: return `${timing.freqInterval === 1 ? 'Every day' : `Every ${plural(timing.freqInterval, 'day')}`} ${at}`
    case freq.weekly: {
      const every = timing.freqRecurrenceFactor === 1 ? '' : ` every ${plural(timing.freqRecurrenceFactor, 'week')}`
      if (timing.freqInterval === 62) return `Weekdays${every} ${at}`
      if (timing.freqInterval === 65) return `Weekends${every} ${at}`
      if (timing.freqInterval === 127) return `Every day${every} ${at}`
      return `Every ${weeklyDays(timing.freqInterval).join(', ')}${every} ${at}`
    }
    case freq.monthly: {
      const months = timing.freqRecurrenceFactor === 1 ? 'every month' : `every ${plural(timing.freqRecurrenceFactor, 'month')}`
      return `Day ${timing.freqInterval} of ${months} ${at}`
    }
    case freq.relative: {
      const months = timing.freqRecurrenceFactor === 1 ? 'every month' : `every ${plural(timing.freqRecurrenceFactor, 'month')}`
      const word = relativeWord(timing.freqRelativeInterval)
      return `${word[0].toUpperCase()}${word.slice(1)} ${relativeDay(timing.freqInterval)} of ${months} ${at}`
    }
    default: return `Frequency type ${timing.freqType}`
  }
}

// --- Defaults and presets -------------------------------------------------------------------------------------------------

/** New schedule's fields: SSMS's New Job Schedule defaults (recurring weekly on the day it is made, once at midnight, from today). */
export function defaultSchedule(today: number, name = ''): AgentScheduleFields {
  const day = new Date(dayNumber(today) * dayMs).getUTCDay()
  return {
    name, enabled: true, freqType: freq.weekly, freqInterval: 1 << day, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 1,
    activeStartDate: today, activeEndDate: noEndDate, activeStartTime: 0, activeEndTime: endOfDay
  }
}

export const schedulePresetIds = ['everyDay', 'weekdays', 'weekly', 'everyMinutes', 'monthlyDay', 'agentStart', 'idle', 'oneTime'] as const
export type SchedulePresetId = typeof schedulePresetIds[number]
export interface SchedulePreset {
  readonly id: SchedulePresetId
  readonly label: string
  /** Under the More menu (mock rx-job-schedules: "More: when SQL Server Agent starts, whenever the CPUs become idle, one time"). */
  readonly more?: true
  /** The fields it fills, kept from `current` where it does not set them (name, enabled, the start date and time). */
  readonly apply: (current: AgentScheduleFields, today: number) => AgentScheduleFields
  /** Whether `timing` is what it fills (the chip shows as chosen). */
  readonly matches: (timing: AgentScheduleTiming) => boolean
}
const recurring = (current: AgentScheduleFields, today: number) => ({
  activeStartDate: current.freqType === freq.once || current.activeStartDate < today ? today : current.activeStartDate,
  activeEndDate: current.activeEndDate, activeStartTime: current.freqSubdayType === subday.once ? current.activeStartTime : 0, activeEndTime: endOfDay
})
const onceAt = (timing: AgentScheduleTiming) => timing.freqSubdayType === subday.once
/** "Start from" chips: each only fills SSMS's own fields; the preset is not stored. */
export const schedulePresets: readonly SchedulePreset[] = [
  {
    id: 'everyDay', label: 'Every day at…',
    apply: (current, today) => ({ ...current, ...recurring(current, today), freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0 }),
    matches: timing => timing.freqType === freq.daily && timing.freqInterval === 1 && onceAt(timing)
  },
  {
    id: 'weekdays', label: 'Weekdays at…',
    apply: (current, today) => ({ ...current, ...recurring(current, today), freqType: freq.weekly, freqInterval: 62, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 1 }),
    matches: timing => timing.freqType === freq.weekly && timing.freqInterval === 62 && timing.freqRecurrenceFactor === 1 && onceAt(timing)
  },
  {
    id: 'weekly', label: 'Weekly on…',
    apply: (current, today) => ({
      ...current, ...recurring(current, today), freqType: freq.weekly, freqInterval: current.freqType === freq.weekly && current.freqInterval !== 62 ? current.freqInterval : 1 << new Date(dayNumber(today) * dayMs).getUTCDay(),
      freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 1
    }),
    matches: timing => timing.freqType === freq.weekly && timing.freqInterval !== 62 && timing.freqRecurrenceFactor === 1 && onceAt(timing)
  },
  {
    id: 'everyMinutes', label: 'Every N minutes',
    apply: (current, today) => ({
      ...current, ...recurring(current, today), freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.minutes,
      freqSubdayInterval: current.freqSubdayType === subday.minutes ? current.freqSubdayInterval : 15, freqRelativeInterval: 0, freqRecurrenceFactor: 0, activeStartTime: 0, activeEndTime: endOfDay
    }),
    matches: timing => timing.freqType === freq.daily && timing.freqInterval === 1 && timing.freqSubdayType === subday.minutes
  },
  {
    id: 'monthlyDay', label: 'Monthly on day…',
    apply: (current, today) => ({
      ...current, ...recurring(current, today), freqType: freq.monthly, freqInterval: current.freqType === freq.monthly ? current.freqInterval : 1, freqSubdayType: subday.once, freqSubdayInterval: 0,
      freqRelativeInterval: 0, freqRecurrenceFactor: 1
    }),
    matches: timing => timing.freqType === freq.monthly && timing.freqRecurrenceFactor === 1 && onceAt(timing)
  },
  {
    id: 'agentStart', label: 'When SQL Server Agent starts', more: true,
    apply: current => ({ ...current, freqType: freq.agentStart, freqInterval: 0, freqSubdayType: 0, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0 }),
    matches: timing => timing.freqType === freq.agentStart
  },
  {
    id: 'idle', label: 'Whenever the CPUs become idle', more: true,
    apply: current => ({ ...current, freqType: freq.idle, freqInterval: 0, freqSubdayType: 0, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0 }),
    matches: timing => timing.freqType === freq.idle
  },
  {
    id: 'oneTime', label: 'One time', more: true,
    apply: (current, today) => ({
      ...current, freqType: freq.once, freqInterval: 0, freqSubdayType: 0, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
      activeStartDate: current.activeStartDate < today ? today : current.activeStartDate, activeEndDate: noEndDate, activeEndTime: endOfDay
    }),
    matches: timing => timing.freqType === freq.once
  }
]
/** The preset whose fields `timing` has, if any. */
export const matchingPreset = (timing: AgentScheduleTiming): SchedulePresetId | undefined => schedulePresets.find(preset => preset.matches(timing))?.id

/**
 * The fields a frequency type keeps when the editor switches to it (Occurs: Daily, Weekly, Monthly; or a type from More): what it does
 * not use goes to msdb's defaults (sp_verify_schedule zeroes them anyway), what it needs gets SSMS's default.
 */
export function withFrequency(current: AgentScheduleFields, type: number, today: number): AgentScheduleFields {
  if (current.freqType === type) return current
  const weekday = 1 << new Date(dayNumber(Math.max(today, current.activeStartDate)) * dayMs).getUTCDay()
  const keep = { freqSubdayType: current.freqSubdayType || subday.once, freqSubdayInterval: current.freqSubdayInterval, freqRelativeInterval: 0 }
  switch (type) {
    case freq.daily: return { ...current, ...keep, freqType: type, freqInterval: 1, freqRecurrenceFactor: 0 }
    case freq.weekly: return { ...current, ...keep, freqType: type, freqInterval: weekday, freqRecurrenceFactor: 1 }
    case freq.monthly: return { ...current, ...keep, freqType: type, freqInterval: Math.min(28, current.activeStartDate % 100) || 1, freqRecurrenceFactor: 1 }
    case freq.relative: return { ...current, ...keep, freqType: type, freqInterval: 1, freqRelativeInterval: 1, freqRecurrenceFactor: 1 }
    default: return schedulePresets.find(preset => preset.apply(current, today).freqType === type)?.apply(current, today) ?? { ...current, freqType: type }
  }
}

// --- Problems ---------------------------------------------------------------------------------------------------------------

export type ScheduleField = 'name' | 'frequency' | 'interval' | 'days' | 'dailyFrequency' | 'startTime' | 'endTime' | 'startDate' | 'endDate'
export interface ScheduleProblem { readonly field: ScheduleField; readonly severity: 'error' | 'warning'; readonly message: string }
export const scheduleText = {
  nameRequired: 'The schedule needs a name.',
  nameTooLong: `A name holds at most ${agentLimits.nameChars} characters.`,
  noDays: 'Choose at least one day of the week.',
  interval: (unit: string, most: number) => `Every how many ${unit}: a whole number from 1 to ${most}.`,
  beyondSsms: (unit: string, most: number) => `SSMS offers at most ${most} ${unit} here; SQL Server Agent accepts more and runs it as set.`,
  endBeforeStartHidden: (end: string) => `This schedule's end date (${end}, set outside Varia) is before its start date; SQL Server Agent refuses that. Choose an earlier start date.`,
  seconds: 'Every n seconds: at least 10 (SQL Server Agent\'s smallest interval).',
  monthDay: 'A day of the month from 1 to 31.',
  monthDayShort: (day: number) => `Months with fewer than ${day} days are skipped.`,
  startTime: 'Starting at: a time of day.',
  endTime: 'Ending at: a time of day.',
  sameTimes: 'Starting and ending at the same time leaves no time to repeat in; SQL Server Agent refuses it.',
  startDate: 'Start date: a date from 1990-01-01.',
  endDate: 'End date: a date from 1990-01-01.',
  endBeforeStart: 'The end date is before the start date.',
  oneTimePast: 'This time has passed, so the schedule never runs. SQL Server Agent saves it anyway.',
  ended: 'The end date has passed, so the schedule never runs again.',
  idleWarning: 'A CPU idle condition is set in SQL Server Agent Properties › Advanced, which Varia does not edit yet; set it in SSMS. Without one this schedule never starts a job.',
  idleNotDefined: (server: string) => `No idle CPU condition is defined on ${server}, so this schedule never starts a job. Set one in SQL Server Agent Properties › Advanced in SSMS.`,
  idleUnavailable: 'Start whenever the CPUs become idle is not available on this server\'s platform.',
  agentStart: 'Runs each time the SQL Server Agent service starts.',
  spansMidnight: 'The ending time is before the starting time, so the window runs past midnight into the next day.'
} as const

/**
 * What sp_verify_schedule would refuse (errors; Save cannot send them) and what would surprise (warnings; a one-time schedule in the
 * past is saved, as msdb does). `now` is the server's wall clock, when known.
 */
/** What the server says about idle schedules: its platform (Managed Instance refuses them, 41914) and, read by sysadmin only, whether
 *  Agent has an idle CPU condition (without one an idle schedule never starts a job). */
export interface ScheduleServer {
  readonly platform?: AgentPlatform
  readonly idleDefined?: boolean
}
/** Whether a platform offers the CPU-idle frequency. */
export const idleOffered = (platform: AgentPlatform | undefined) => !platform || agentGateOpen('cpuIdleSchedules', platform)
export function scheduleProblems(fields: AgentScheduleFields, now?: AgentMoment, server?: ScheduleServer): ScheduleProblem[] {
  const problems: ScheduleProblem[] = []
  const error = (field: ScheduleField, message: string) => problems.push({ field, severity: 'error', message })
  const warn = (field: ScheduleField, message: string) => problems.push({ field, severity: 'warning', message })
  const whole = (value: number, low: number, high: number) => Number.isInteger(value) && value >= low && value <= high
  // SSMS's dialog limits: msdb's sp_verify_schedule has no upper bound, so beyond them is a warning, never a refusal.
  const count = (field: ScheduleField, value: number, unit: string, most: number) => {
    if (!Number.isInteger(value) || value < 1) error(field, scheduleText.interval(unit, most))
    else if (value > most) warn(field, scheduleText.beyondSsms(unit, most))
  }
  if (!fields.name.trim()) error('name', scheduleText.nameRequired)
  else if (fields.name.length > agentLimits.nameChars) error('name', scheduleText.nameTooLong)
  if (!validDate(fields.activeStartDate)) error('startDate', scheduleText.startDate)
  const recurringType = fields.freqType === freq.daily || fields.freqType === freq.weekly || fields.freqType === freq.monthly || fields.freqType === freq.relative
  if (recurringType) {
    if (fields.freqType === freq.daily) count('interval', fields.freqInterval, 'days', 100)
    if (fields.freqType === freq.weekly) {
      if (!whole(fields.freqInterval, 1, 127)) error('days', scheduleText.noDays)
      count('interval', fields.freqRecurrenceFactor, 'weeks', 99)
    }
    if (fields.freqType === freq.monthly) {
      if (!whole(fields.freqInterval, 1, 31)) error('days', scheduleText.monthDay)
      else if (fields.freqInterval > 28) warn('days', scheduleText.monthDayShort(fields.freqInterval))
      count('interval', fields.freqRecurrenceFactor, 'months', 99)
    }
    if (fields.freqType === freq.relative) count('interval', fields.freqRecurrenceFactor, 'months', 99)
    if (fields.freqSubdayType !== subday.once) {
      const most = fields.freqSubdayType === subday.hours ? 24 : fields.freqSubdayType === subday.minutes ? 1440 : 86_400
      if (fields.freqSubdayType === subday.seconds && whole(fields.freqSubdayInterval, 1, 9)) error('dailyFrequency', scheduleText.seconds)
      else count('dailyFrequency', fields.freqSubdayInterval, `${unitOf(fields.freqSubdayType)}s`, most)
      if (!validTime(fields.activeEndTime)) error('endTime', scheduleText.endTime)
      else if (effectiveEndTime(fields.activeEndTime) === fields.activeStartTime) error('endTime', scheduleText.sameTimes)
      else if (effectiveEndTime(fields.activeEndTime) < fields.activeStartTime) warn('endTime', scheduleText.spansMidnight)
    }
    if (fields.activeEndDate !== noEndDate && !validDate(fields.activeEndDate)) error('endDate', scheduleText.endDate)
    else if (fields.activeEndDate < fields.activeStartDate) error('endDate', scheduleText.endBeforeStart)
    else if (now && fields.activeEndDate < now.date) warn('endDate', scheduleText.ended)
  } else if (validDate(fields.activeEndDate) && fields.activeEndDate < fields.activeStartDate) {
    // A one-time, autostart or idle schedule shows no end date, yet sp_verify_schedule refuses one before the start for every type.
    error('startDate', scheduleText.endBeforeStartHidden(formatDate(fields.activeEndDate)))
  }
  if (!validTime(fields.activeStartTime)) error('startTime', scheduleText.startTime)
  if (fields.freqType === freq.once && now && validDate(fields.activeStartDate) && validTime(fields.activeStartTime) && momentSeconds({ date: fields.activeStartDate, time: fields.activeStartTime }) <= momentSeconds(now)) {
    warn('startDate', scheduleText.oneTimePast)
  }
  if (!(Object.values(freq) as number[]).includes(fields.freqType)) error('frequency', `Frequency type ${fields.freqType} is not one SQL Server Agent knows.`)
  if (fields.freqType === freq.idle) {
    if (!idleOffered(server?.platform)) error('frequency', scheduleText.idleUnavailable)
    else if (server?.idleDefined === false) warn('frequency', scheduleText.idleWarning)
  }
  return problems
}
export const scheduleSavable = (problems: readonly ScheduleProblem[]) => !problems.some(problem => problem.severity === 'error')

/**
 * The fields as sp_add_schedule and sp_update_schedule receive them: what the frequency type does not use goes as msdb's own defaults
 * (sp_verify_schedule zeroes them for one-time, autostart and idle schedules, and the daily type's recurrence factor), so a save and a
 * re-read agree.
 */
export function normalizedTiming(timing: AgentScheduleTiming): AgentScheduleTiming {
  timing = { ...timing, activeEndTime: effectiveEndTime(timing.activeEndTime) }
  if (timing.freqType === freq.once || timing.freqType === freq.agentStart || timing.freqType === freq.idle) {
    return { ...timing, freqInterval: 0, freqSubdayType: 0, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0 }
  }
  const once = timing.freqSubdayType === subday.once || timing.freqSubdayType === 0
  return {
    ...timing, freqSubdayType: once ? subday.once : timing.freqSubdayType, freqSubdayInterval: once ? 0 : timing.freqSubdayInterval,
    freqRelativeInterval: timing.freqType === freq.relative ? timing.freqRelativeInterval : 0, freqRecurrenceFactor: timing.freqType === freq.daily ? 0 : timing.freqRecurrenceFactor
  }
}
export const timingKeys = ['freqType', 'freqInterval', 'freqSubdayType', 'freqSubdayInterval', 'freqRelativeInterval', 'freqRecurrenceFactor', 'activeStartDate', 'activeEndDate', 'activeStartTime', 'activeEndTime'] as const
/** Whether two timings run at the same moments (after normalizing what the type does not use). */
export function sameTiming(a: AgentScheduleTiming, b: AgentScheduleTiming): boolean {
  const x = normalizedTiming(a), y = normalizedTiming(b)
  return timingKeys.every(key => x[key] === y[key])
}

// --- Next runs ------------------------------------------------------------------------------------------------------------

/** Days a search for runs walks at most (a monthly schedule every 99 months on day 31 still finds its runs well inside this). */
export const scheduleSearchDays = 366 * 9
const weekOf = (day: number) => Math.floor((day + 4) / 7) // weeks start on Sunday; 1970-01-01 was a Thursday
const monthOf = (date: number) => Math.floor(date / 10_000) * 12 + Math.floor(date / 100) % 100 - 1
const daysInMonth = (date: number) => new Date(Date.UTC(Math.floor(date / 10_000), Math.floor(date / 100) % 100, 0)).getUTCDate()

/** Whether a recurring schedule runs on a day (`day` as days since 1970). */
function runsOn(timing: AgentScheduleTiming, day: number): boolean {
  const start = dayNumber(timing.activeStartDate)
  const date = dateOfDay(day)
  const weekday = new Date(day * dayMs).getUTCDay()
  switch (timing.freqType) {
    case freq.daily: return (day - start) % Math.max(1, timing.freqInterval) === 0
    case freq.weekly: return (timing.freqInterval & (1 << weekday)) !== 0 && (weekOf(day) - weekOf(start)) % Math.max(1, timing.freqRecurrenceFactor) === 0
    case freq.monthly: return date % 100 === timing.freqInterval && (monthOf(date) - monthOf(timing.activeStartDate)) % Math.max(1, timing.freqRecurrenceFactor) === 0
    case freq.relative: {
      if ((monthOf(date) - monthOf(timing.activeStartDate)) % Math.max(1, timing.freqRecurrenceFactor) !== 0) return false
      const matches = (candidate: number) => {
        const kind = timing.freqInterval
        if (kind >= 1 && kind <= 7) return candidate === kind - 1
        if (kind === 8) return true
        if (kind === 9) return candidate >= 1 && candidate <= 5
        return candidate === 0 || candidate === 6
      }
      if (!matches(weekday)) return false
      // Which matching day of the month this is, counted from the start (first … fourth) or from the end (last).
      const dom = date % 100, first = day - dom + 1, total = daysInMonth(date)
      let index = 0, count = 0
      for (let d = 1; d <= total; d++) {
        if (!matches(new Date((first + d - 1) * dayMs).getUTCDay())) continue
        count++
        if (d === dom) index = count
      }
      return timing.freqRelativeInterval === 16 ? index === count : index === Math.log2(timing.freqRelativeInterval) + 1
    }
    default: return false
  }
}
/** The times of day a recurring schedule runs on a day it runs, in seconds since midnight, in order. */
function timesOfDay(timing: AgentScheduleTiming): number[] {
  const start = secondsOf(timing.activeStartTime)
  if (timing.freqSubdayType === subday.once || timing.freqSubdayType === 0) return [start]
  const step = Math.max(1, timing.freqSubdayInterval) * (timing.freqSubdayType === subday.seconds ? 1 : timing.freqSubdayType === subday.minutes ? 60 : 3600)
  const end = secondsOf(effectiveEndTime(timing.activeEndTime))
  const times: number[] = []
  // An end before the start spans midnight: the window runs from the start to the day's end, and from midnight to the end.
  if (end >= start) for (let t = start; t <= end; t += step) times.push(t)
  else {
    for (let t = start; t < 86_400; t += step) times.push(t)
    for (let t = start % step; t <= end; t += step) times.push(t)
    times.sort((a, b) => a - b)
  }
  return [...new Set(times)]
}

/**
 * The runs of a schedule from `from` (inclusive) in server time: at most `count`, and none after `until` (seconds, wall clock) when it
 * is given. Agent-start, CPU-idle and disabled schedules have none. A recurring search stops after `scheduleSearchDays`.
 */
export function scheduleRuns(schedule: AgentScheduleTiming & { readonly enabled?: boolean }, from: AgentMoment, count: number, until?: number): AgentMoment[] {
  if (schedule.enabled === false || count <= 0) return []
  const fromSeconds = momentSeconds(from)
  if (schedule.freqType === freq.once) {
    if (!validDate(schedule.activeStartDate) || !validTime(schedule.activeStartTime)) return []
    const at = { date: schedule.activeStartDate, time: schedule.activeStartTime }
    const seconds = momentSeconds(at)
    return seconds >= fromSeconds && (until === undefined || seconds <= until) ? [at] : []
  }
  if (![freq.daily, freq.weekly, freq.monthly, freq.relative].includes(schedule.freqType as 4) || !validDate(schedule.activeStartDate)) return []
  const runs: AgentMoment[] = []
  const times = timesOfDay(schedule)
  // No end date still ends with msdb's calendar, on 9999-12-31.
  const lastDay = schedule.activeEndDate >= noEndDate || !validDate(schedule.activeEndDate) ? dayNumber(noEndDate) : dayNumber(schedule.activeEndDate)
  const firstDay = Math.max(dayNumber(schedule.activeStartDate), Math.floor(fromSeconds / 86_400))
  for (let day = firstDay; day <= lastDay && day - firstDay <= scheduleSearchDays && runs.length < count; day++) {
    if (until !== undefined && day * 86_400 > until) break
    if (!runsOn(schedule, day)) continue
    for (const time of times) {
      const seconds = day * 86_400 + time
      if (seconds < fromSeconds) continue
      if (until !== undefined && seconds > until) break
      runs.push(momentOfSeconds(seconds))
      if (runs.length >= count) break
    }
  }
  return runs
}
/** The next five runs, as the editor lists them. */
export const nextRuns = (schedule: AgentScheduleTiming & { readonly enabled?: boolean }, now: AgentMoment, count = 5) => scheduleRuns(schedule, now, count)

/** Why a schedule has no next runs, or undefined when it has some. */
export function noRunsReason(schedule: AgentScheduleTiming & { readonly enabled?: boolean }, now: AgentMoment): string | undefined {
  if (schedule.freqType === freq.agentStart) return scheduleText.agentStart
  if (schedule.freqType === freq.idle) return 'Runs only when the CPUs are idle; there are no set times.'
  if (schedule.enabled === false) return 'The schedule is disabled, so it starts no job.'
  if (scheduleRuns(schedule, now, 1).length) return undefined
  if (schedule.freqType === freq.once) return scheduleText.oneTimePast
  return 'No run falls inside its start and end dates from now.'
}

// --- Free-slot check --------------------------------------------------------------------------------------------------------

/** Another job and the schedules that start it, with its usual duration (the median of its last successful runs), when known. */
export interface ScheduledJob {
  readonly name: string
  readonly enabled: boolean
  /** Seconds; undefined when it has no successful run to measure. */
  readonly usualSeconds?: number
  readonly schedules: readonly (AgentScheduleTiming & { readonly enabled?: boolean })[]
}
export interface FreeSlotClash { readonly job: string; readonly at: AgentMoment; readonly mine: AgentMoment }
export interface FreeSlotResult {
  /** This job's runs it checked, and how long each is taken to last. */
  readonly runs: readonly AgentMoment[]
  readonly usualSeconds: number
  /** Whether the usual duration was measured (else a minute stands in). */
  readonly measured: boolean
  readonly clashes: readonly FreeSlotClash[]
}
/** A job without a measured duration is taken to run a minute: long enough to show a start inside another job's run. */
export const unmeasuredSeconds = 60
/** The median of durations (seconds), or undefined when there are none. */
export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}
/**
 * The free-slot check (mock rx-job-schedules): this schedule's next runs, each lasting the job's usual duration, against the runs of other
 * enabled jobs' enabled schedules lasting theirs. A clash is any overlap, at most one per other job and run of this one.
 */
export function freeSlotCheck(schedule: AgentScheduleTiming & { readonly enabled?: boolean }, now: AgentMoment, usualSeconds: number | undefined, others: readonly ScheduledJob[], count = 5): FreeSlotResult {
  const runs = nextRuns({ ...schedule, enabled: true }, now, count)
  // A run measured at 0 seconds still occupies its start second, so two runs starting together always clash.
  const mine = Math.max(1, usualSeconds ?? unmeasuredSeconds)
  const clashes: FreeSlotClash[] = []
  if (!runs.length) return { runs, usualSeconds: mine, measured: usualSeconds !== undefined, clashes }
  for (const job of others) {
    if (!job.enabled) continue
    const theirs = Math.max(1, job.usualSeconds ?? unmeasuredSeconds)
    for (const run of runs) {
      // Each run asks only for a start that overlaps it, (a - theirs, b): one run per schedule, so even an every-second schedule over
      // many days of runs stays cheap and never runs out of runs before the window ends.
      const a = momentSeconds(run), b = a + mine
      const from = momentOfSeconds(Math.max(0, a - theirs + 1))
      const hits = job.schedules.flatMap(other => scheduleRuns(other, from, 1, b - 1)).map(momentSeconds)
      if (hits.length) clashes.push({ job: job.name, at: momentOfSeconds(Math.min(...hits)), mine: run })
    }
  }
  return { runs, usualSeconds: mine, measured: usualSeconds !== undefined, clashes }
}
/** The free-slot check in words: "Nothing else is scheduled during this job's usual 16 minutes." or the first clash. */
export function freeSlotText(result: FreeSlotResult): string {
  const usual = result.usualSeconds < 60 ? plural(result.usualSeconds, 'second') : plural(Math.round(result.usualSeconds / 60), 'minute')
  const span = result.measured ? `this job's usual ${usual}` : 'the first minute of each run (this job has no successful run to measure)'
  if (!result.runs.length) return 'No upcoming run to check.'
  if (!result.clashes.length) return `Nothing else is scheduled during ${span}.`
  const first = result.clashes[0]
  const jobs = [...new Set(result.clashes.map(clash => clash.job))]
  const more = jobs.length > 1 ? ` and ${plural(jobs.length - 1, 'other job')}` : ''
  return `${first.job}${more} also ${jobs.length > 1 ? 'run' : 'runs'} during ${span}: first at ${formatRun(first.at)}, beside this job's run at ${formatRun(first.mine)}.`
}

// --- Search -----------------------------------------------------------------------------------------------------------------

/** Whether a shared schedule matches the pick's search: by name or by when it runs ("night", "every 15 minutes", "sunday"). */
export function scheduleMatches(schedule: AgentScheduleFields, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hour = Math.floor(schedule.activeStartTime / 10_000)
  const parts = [schedule.name, scheduleWhen(schedule), scheduleSentence(schedule)]
  // "night", "morning" and friends match a once-a-day start in their hours.
  if (schedule.freqSubdayType === subday.once && schedule.freqType !== freq.agentStart && schedule.freqType !== freq.idle) {
    if (hour >= 21 || hour < 5) parts.push('night nightly overnight')
    else if (hour < 12) parts.push('morning')
    else if (hour < 18) parts.push('afternoon')
    else parts.push('evening')
  }
  const text = parts.join(' ').toLowerCase()
  return words.every(word => text.includes(word))
}
