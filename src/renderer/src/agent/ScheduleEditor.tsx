// The schedule editor (AG-6c, docs/agent-ui-rethink.md › rx-job-schedules) that the job document's Schedules section and the Schedules
// document share: SSMS's own fields (Frequency, Daily frequency, Duration) with presets that only fill them, SSMS's sentence, the next five
// runs in server time and, where the caller has one, the free-slot check. Pure drawing: every change goes back through onChange as whole
// fields, and problems come from scheduleProblems.
import { agentLimits, frequencyTypes, relativeDays, relativeIntervals, weekDays, type AgentPlatform } from '../../../shared/agent/catalog.ts'
import {
  endOfDay, formatDate, formatRun, formatTime, freq, idleOffered, matchingPreset, nextRuns, noEndDate, noRunsReason, parseDate, parseTime, schedulePresets, scheduleSentence, subday, withFrequency,
  type AgentMoment, type AgentScheduleFields, type ScheduleField, type ScheduleProblem
} from '../../../shared/agent/schedule.ts'
import Icon from '../Icon'
import { Chip, ChipGroup } from '../kit/Chip'
import PropertyField, { fieldAria } from '../kit/PropertyField'
import Segmented from '../kit/Segmented'
import Switch from '../kit/Switch'

export interface ScheduleEditorProps {
  /** Unique per editor on screen: every control's id starts with it. */
  readonly idPrefix: string
  readonly fields: AgentScheduleFields
  /** The fields as read (undefined for a new schedule): changed fields are marked. */
  readonly base?: AgentScheduleFields
  readonly onChange: (fields: AgentScheduleFields) => void
  readonly disabled?: boolean
  readonly problems: readonly ScheduleProblem[]
  /** The server's clock: presets start from its date and next runs count from it. */
  readonly now: AgentMoment
  /** The free-slot check in words, when the caller can make one. */
  readonly freeSlot?: string
  /** Shown under the next runs (Also used by, Copy for this job only). */
  readonly aside?: React.ReactNode
  /** The server's platform: Managed Instance offers no CPU-idle frequency or preset (a schedule already idle still shows it). */
  readonly platform?: AgentPlatform
}

const recurringTypes: readonly number[] = [freq.daily, freq.weekly, freq.monthly, freq.relative]
const subdayUnits = [{ code: subday.hours, label: 'hour(s)' }, { code: subday.minutes, label: 'minute(s)' }, { code: subday.seconds, label: 'second(s)' }]
const shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** A count as typed, capped at the field's highest; empty or not a whole number is 0, which its problem names, so clearing a field to
 *  type another number never turns it into the lowest one first. */
const number = (text: string, _low: number, high: number) => { const value = text.trim() === '' ? 0 : Number(text); return Number.isInteger(value) ? Math.min(high, Math.max(0, value)) : 0 }

/** A field's problems: its first error, else its warnings joined. */
function textOf(problems: readonly ScheduleProblem[], ...fields: ScheduleField[]): { error?: string; note?: string } {
  const own = problems.filter(problem => fields.includes(problem.field))
  const error = own.find(problem => problem.severity === 'error')?.message
  const warnings = own.filter(problem => problem.severity === 'warning').map(problem => problem.message)
  return { ...error ? { error } : {}, ...warnings.length ? { note: warnings.join(' ') } : {} }
}

export default function ScheduleEditor({ idPrefix, fields, base, onChange, disabled, problems, now, freeSlot, aside, platform }: ScheduleEditorProps) {
  const idle = idleOffered(platform) || fields.freqType === freq.idle
  const presets = schedulePresets.filter(preset => idleOffered(platform) || preset.id !== 'idle')
  const id = (key: string) => `${idPrefix}-${key}`
  const set = (patch: Partial<AgentScheduleFields>) => onChange({ ...fields, ...patch })
  const changed = (...keys: (keyof AgentScheduleFields)[]) => !!base && keys.some(key => base[key] !== fields[key])
  const chosen = matchingPreset(fields)
  const recurring = recurringTypes.includes(fields.freqType)
  const name = { description: 'Jobs that share the schedule show it; names need not be unique.', ...textOf(problems, 'name') }
  const frequency = { description: 'How often the schedule repeats.', ...textOf(problems, 'frequency', 'interval', 'days') }
  const daily = { description: 'When in the day it runs: once, or every so often between two times.', ...textOf(problems, 'dailyFrequency', 'startTime', 'endTime') }
  const duration = { description: 'The dates the schedule is used between.', ...textOf(problems, 'startDate', 'endDate') }
  const runs = nextRuns(fields, now, 5)
  const reason = runs.length ? undefined : noRunsReason(fields, now)
  const unit = subdayUnits.find(item => item.code === fields.freqSubdayType)
  return <div className="agent-schedule-editor">
    <div className="properties-fields">
      <PropertyField id={id('name')} label="Name" changed={changed('name')} {...name}>
        <input id={id('name')} data-schedule-name className="property-input" type="text" maxLength={agentLimits.nameChars} spellCheck={false} value={fields.name} disabled={disabled}
          data-changed={changed('name') || undefined} {...fieldAria(id('name'), { ...name, changed: changed('name') })} onChange={event => set({ name: event.target.value })} />
      </PropertyField>
      <PropertyField id={id('enabled')} label="Enabled" changed={changed('enabled')} description="A disabled schedule starts no job.">
        <Switch id={id('enabled')} checked={fields.enabled} disabled={disabled} changed={changed('enabled')} states={{ on: 'Runs on this schedule', off: 'Disabled' }}
          onChange={checked => set({ enabled: checked })} />
      </PropertyField>
      <PropertyField id={id('presets')} labelFor={false} label="Start from" description="A preset fills the fields below; it is not stored.">
        <span className="agent-schedule-presets">
          <ChipGroup label="Presets">
            {presets.filter(preset => !preset.more).map(preset =>
              <Chip key={preset.id} label={preset.label} pressed={chosen === preset.id} disabled={disabled} onToggle={() => onChange(preset.apply(fields, now.date))} />)}
          </ChipGroup>
          <select className="property-input" aria-label="More presets" value="" disabled={disabled}
            onChange={event => { const preset = presets.find(item => item.id === event.target.value); if (preset) onChange(preset.apply(fields, now.date)) }}>
            <option value="">More…</option>
            {presets.filter(preset => preset.more).map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </span>
      </PropertyField>
      <PropertyField id={id('type')} label="Occurs" changed={changed('freqType', 'freqInterval', 'freqRecurrenceFactor', 'freqRelativeInterval')} {...frequency}>
        <span className="agent-schedule-row">
          <select id={id('type')} className="property-input" value={fields.freqType} disabled={disabled} {...fieldAria(id('type'), frequency)}
            onChange={event => onChange(withFrequency(fields, Number(event.target.value), now.date))}>
            {frequencyTypes.filter(type => idle || type.code !== freq.idle).map(type => <option key={type.code} value={type.code}>{type.label}</option>)}
          </select>
          {fields.freqType === freq.daily && <>
            <span>every</span>
            <input className="property-input agent-schedule-number" type="number" min={1} max={100} aria-label="Every how many days" value={fields.freqInterval} disabled={disabled}
              onChange={event => set({ freqInterval: number(event.target.value, 1, 100) })} /><span>day(s)</span>
          </>}
          {fields.freqType === freq.weekly && <>
            <span>every</span>
            <input className="property-input agent-schedule-number" type="number" min={1} max={99} aria-label="Every how many weeks" value={fields.freqRecurrenceFactor} disabled={disabled}
              onChange={event => set({ freqRecurrenceFactor: number(event.target.value, 1, 99) })} /><span>week(s) on</span>
            <ChipGroup label="Days of the week">
              {weekDays.map((day, index) => <Chip key={day.code} label={shortDays[index]} title={day.label} pressed={(fields.freqInterval & day.code) !== 0} disabled={disabled}
                onToggle={() => set({ freqInterval: fields.freqInterval ^ day.code })} />)}
            </ChipGroup>
          </>}
          {fields.freqType === freq.monthly && <>
            <span>on day</span>
            <input className="property-input agent-schedule-number" type="number" min={1} max={31} aria-label="Day of the month" value={fields.freqInterval} disabled={disabled}
              onChange={event => set({ freqInterval: number(event.target.value, 1, 31) })} />
            <span>of every</span>
            <input className="property-input agent-schedule-number" type="number" min={1} max={99} aria-label="Every how many months" value={fields.freqRecurrenceFactor} disabled={disabled}
              onChange={event => set({ freqRecurrenceFactor: number(event.target.value, 1, 99) })} /><span>month(s)</span>
          </>}
          {fields.freqType === freq.relative && <>
            <span>on the</span>
            <select className="property-input" aria-label="Which" value={fields.freqRelativeInterval} disabled={disabled} onChange={event => set({ freqRelativeInterval: Number(event.target.value) })}>
              {relativeIntervals.map(item => <option key={item.code} value={item.code}>{item.label.toLowerCase()}</option>)}
            </select>
            <select className="property-input" aria-label="Day" value={fields.freqInterval} disabled={disabled} onChange={event => set({ freqInterval: Number(event.target.value) })}>
              {relativeDays.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}
            </select>
            <span>of every</span>
            <input className="property-input agent-schedule-number" type="number" min={1} max={99} aria-label="Every how many months" value={fields.freqRecurrenceFactor} disabled={disabled}
              onChange={event => set({ freqRecurrenceFactor: number(event.target.value, 1, 99) })} /><span>month(s)</span>
          </>}
          {fields.freqType === freq.once && <>
            <span>on</span>
            <input className="property-input" type="date" aria-label="Date" value={formatDate(fields.activeStartDate)} disabled={disabled}
              onChange={event => { const date = parseDate(event.target.value); if (date) set({ activeStartDate: date }) }} />
            <span>at</span>
            <input className="property-input" type="time" step={1} aria-label="Time" value={formatTime(fields.activeStartTime)} disabled={disabled}
              onChange={event => { const time = parseTime(event.target.value); if (time !== undefined) set({ activeStartTime: time }) }} />
          </>}
        </span>
      </PropertyField>
      {recurring && <PropertyField id={id('daily')} labelFor={false} label="Daily frequency" changed={changed('freqSubdayType', 'freqSubdayInterval', 'activeStartTime', 'activeEndTime')} {...daily}>
        <span className="agent-schedule-row">
          <Segmented id={id('daily')} labelledBy={`${id('daily')}-label`} value={fields.freqSubdayType === subday.once ? 'once' : 'every'} disabled={disabled}
            segments={[{ value: 'once', label: 'Once at' }, { value: 'every', label: 'Every' }]}
            onChange={value => set(value === 'once' ? { freqSubdayType: subday.once, freqSubdayInterval: 0 } : { freqSubdayType: subday.hours, freqSubdayInterval: 1, activeStartTime: 0, activeEndTime: endOfDay })} />
          {fields.freqSubdayType === subday.once
            ? <input className="property-input" type="time" step={1} aria-label="At" value={formatTime(fields.activeStartTime)} disabled={disabled}
              onChange={event => { const time = parseTime(event.target.value); if (time !== undefined) set({ activeStartTime: time }) }} />
            : <>
              <input className="property-input agent-schedule-number" type="number" min={1} max={fields.freqSubdayType === subday.hours ? 24 : fields.freqSubdayType === subday.minutes ? 1_440 : 86_400}
                aria-label={`Every how many ${unit?.label ?? 'units'}`} value={fields.freqSubdayInterval} disabled={disabled} onChange={event => set({ freqSubdayInterval: number(event.target.value, 1, 86_400) })} />
              <select className="property-input" aria-label="Unit" value={fields.freqSubdayType} disabled={disabled} onChange={event => set({ freqSubdayType: Number(event.target.value) })}>
                {subdayUnits.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}
              </select>
              <span>from</span>
              <input className="property-input" type="time" step={1} aria-label="Starting at" value={formatTime(fields.activeStartTime)} disabled={disabled}
                onChange={event => { const time = parseTime(event.target.value); if (time !== undefined) set({ activeStartTime: time }) }} />
              <span>to</span>
              <input className="property-input" type="time" step={1} aria-label="Ending at" value={formatTime(fields.activeEndTime)} disabled={disabled}
                onChange={event => { const time = parseTime(event.target.value); if (time !== undefined) set({ activeEndTime: time }) }} />
            </>}
        </span>
      </PropertyField>}
      {recurring && <PropertyField id={id('start')} label="Duration" changed={changed('activeStartDate', 'activeEndDate')} {...duration}>
        <span className="agent-schedule-row">
          <input id={id('start')} className="property-input" type="date" aria-label="Start date" value={formatDate(fields.activeStartDate)} disabled={disabled}
            onChange={event => { const date = parseDate(event.target.value); if (date) set({ activeStartDate: date }) }} />
          <span>to</span>
          {fields.activeEndDate === noEndDate
            ? <button type="button" disabled={disabled} onClick={() => set({ activeEndDate: Math.max(fields.activeStartDate, now.date) })}>No end date</button>
            : <>
              <input className="property-input" type="date" aria-label="End date" value={formatDate(fields.activeEndDate)} disabled={disabled}
                onChange={event => { const date = parseDate(event.target.value); if (date) set({ activeEndDate: date }) }} />
              <button type="button" disabled={disabled} onClick={() => set({ activeEndDate: noEndDate })}>No end date</button>
            </>}
        </span>
      </PropertyField>}
    </div>
    <p className="agent-schedule-sentence" aria-live="polite"><strong>{scheduleSentence(fields)}</strong></p>
    <div className="agent-schedule-facts">
      <section aria-label="Next 5 runs">
        <h4>Next 5 runs <span className="field-note">server time</span></h4>
        {runs.length ? <ol className="agent-schedule-runs">{runs.map(run => <li key={`${run.date}-${run.time}`}>{formatRun(run)}</li>)}</ol> : <p className="field-note">{reason}</p>}
        {freeSlot && <p className="field-note"><Icon name={freeSlot.startsWith('Nothing') ? 'check' : 'warning'} />{freeSlot}</p>}
      </section>
      {aside}
    </div>
  </div>
}
