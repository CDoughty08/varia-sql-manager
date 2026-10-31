import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { timelineIntervals, timelineIntervalSpecs, type TimelineInterval } from '../../../shared/actions/restore.ts'
import { pointAllowed } from '../../../shared/actions/restore-plan.ts'
import SubDialog from '../dialogs/SubDialog'
import { draftPlan, restoreToText } from './model'
import type { SectionProps } from './RestoreDatabase'
import { coverage, position, stepPoint, timeMs, timelineWindow, timeText } from './timeline'

const fieldId = (documentId: string, key: string) => `restore-${documentId}-${key}`

/**
 * Backup Timeline: Restore to the last backup taken or a specific date and time, chosen with the Date and Time fields or on
 * the timeline (a slider: the arrows move a minute, Shift an hour), which shows the backups and, in green, where the logs
 * cover (SSMS's sub-dialog, recalled).
 */
export default function BackupTimeline({ state, draft, facts, service }: Pick<SectionProps, 'state' | 'draft' | 'facts' | 'service'>) {
  const plan = draftPlan(draft, facts)
  const lastFinish = Math.max(...facts.sets.map(set => timeMs(set.finish) ?? 0))
  const [specific, setSpecific] = useState(draft.stopAt !== undefined)
  const [point, setPoint] = useState(timeMs(draft.stopAt ?? '') ?? lastFinish)
  const [interval, chooseInterval] = useState<TimelineInterval>('day')
  const span = timelineWindow(facts.sets, interval, point)
  const text = timeText(point), allowed = pointAllowed(facts.sets, text)
  const id = (key: string) => fieldId(state.id, `timeline-${key}`)
  const move = (ms: number) => { setSpecific(true); setPoint(Math.round(ms / 1000) * 1000) }
  const keyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const next = stepPoint(event.key, event.shiftKey, point, span)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    move(next)
  }
  const pointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width > 0) move(span.from + (span.to - span.from) * Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)))
  }
  const markers = facts.sets.flatMap(set => { const at = timeMs(set.finish); return at === undefined || at < span.from || at > span.to ? [] : [{ set, x: position(at, span) * 1000 }] })
  return <SubDialog title="Backup Timeline" okDisabled={specific && !allowed} onCancel={() => service.openDialog(state.id, undefined)} className="restore-timeline"
    onOk={() => { service.openDialog(state.id, undefined); service.updateDraft(state.id, { stopAt: specific ? text : undefined }) }}
    status={specific && !allowed ? 'No backup reaches this point in time.' : undefined}>
    <fieldset className="restore-timeline-mode">
      <legend>Restore to:</legend>
      <label className="checkbox-label"><input type="radio" name={id('mode')} checked={!specific} onChange={() => setSpecific(false)} />Last backup taken{plan.ids.length > 0 ? ` (${restoreToText({ ...draft, stopAt: undefined }, facts, plan).replace(/^The last backup taken \(|\)$/g, '')})` : ''}</label>
      <label className="checkbox-label"><input type="radio" name={id('mode')} checked={specific} onChange={() => setSpecific(true)} />Specific date and time</label>
    </fieldset>
    <div className="property-row"><label htmlFor={id('date')}>Date:</label><input id={id('date')} type="date" value={text.slice(0, 10)} disabled={!specific}
      onChange={event => { const ms = timeMs(`${event.target.value}T${text.slice(11)}`); if (ms !== undefined) move(ms) }} /></div>
    <div className="property-row"><label htmlFor={id('time')}>Time:</label><input id={id('time')} type="time" step={1} value={text.slice(11)} disabled={!specific}
      onChange={event => { const value = event.target.value.length === 5 ? `${event.target.value}:00` : event.target.value; const ms = timeMs(`${text.slice(0, 10)}T${value}`); if (ms !== undefined) move(ms) }} /></div>
    <div className="property-row"><label htmlFor={id('interval')}>Timeline Interval:</label>
      <select id={id('interval')} value={interval} onChange={event => chooseInterval(event.target.value as TimelineInterval)}>
        {timelineIntervals.map(value => <option key={value} value={value}>{timelineIntervalSpecs[value].label}</option>)}
      </select>
    </div>
    <svg className="restore-timeline-track" viewBox="0 0 1000 40" preserveAspectRatio="none" role="slider" tabIndex={0} aria-label="Point in time"
      aria-valuemin={Math.floor(span.from / 60_000)} aria-valuemax={Math.ceil(span.to / 60_000)} aria-valuenow={Math.floor(point / 60_000)} aria-valuetext={text.replace('T', ' ')}
      aria-invalid={specific && !allowed ? true : undefined} onKeyDown={keyDown} onPointerDown={pointer}>
      <rect className="restore-timeline-base" x={0} y={16} width={1000} height={8} />
      {coverage(facts.sets, span).map((stretch, index) => <rect key={index} className="restore-timeline-covered" x={stretch.from * 1000} y={16} width={Math.max(2, (stretch.to - stretch.from) * 1000)} height={8} />)}
      {markers.map(({ set, x }) => <rect key={set.id} className={`restore-timeline-backup restore-timeline-${set.type === 'log' ? 'log' : set.type === 'differential' ? 'differential' : 'full'}`} x={x - 2} y={set.type === 'log' ? 12 : 6} width={4} height={set.type === 'log' ? 16 : 28} />)}
      {specific && <rect className="restore-timeline-point" x={position(point, span) * 1000 - 1.5} y={0} width={3} height={40} />}
    </svg>
    <div className="restore-timeline-ends"><span>{timeText(span.from).replace('T', ' ')}</span><span>{timeText(span.to).replace('T', ' ')}</span></div>
    <p className="field-note restore-timeline-legend"><span className="restore-timeline-swatch restore-timeline-full" />Full <span className="restore-timeline-swatch restore-timeline-differential" />Differential <span className="restore-timeline-swatch restore-timeline-log" />Transaction Log <span className="restore-timeline-swatch restore-timeline-covered" />Covered by log backups</p>
  </SubDialog>
}

