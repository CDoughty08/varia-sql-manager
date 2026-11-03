import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { timelineIntervals, timelineIntervalSpecs, type BackupSetRow, type TimelineInterval } from '../../../shared/actions/restore.ts'
import { pointAllowed } from '../../../shared/actions/restore-plan.ts'
import { cssVariable, type ColorKey } from '../../../shared/theme/registry'
import SubDialog from '../dialogs/SubDialog'
import { useForcedColors } from '../live/LiveChart'
import { draftPlan, restoreToText, sourceSets } from './model'
import type { SectionProps } from './fields'
import { coverage, position, stepPoint, timeMs, timelineWindow, timeText } from './timeline'

const fieldId = (documentId: string, key: string) => `restore-${documentId}-${key}`

/** The track's drawing, in CSS pixels: never stretched, so a mark keeps its size and shape at any dialog width. */
const track = { height: 48, inset: 8, bandTop: 20, bandHeight: 8, fallbackWidth: 480 } as const
type Mark = 'full' | 'differential' | 'log' | 'covered'
/** Each mark's series colour (chart categorical keys, which have contrast pairs on the dialog's surface) and its label. */
const marks: { readonly [M in Mark]: { readonly key: ColorKey; readonly label: string } } = {
  full: { key: 'charts.blue', label: 'Full' },
  differential: { key: 'charts.purple', label: 'Differential' },
  log: { key: 'charts.orange', label: 'Transaction Log' },
  covered: { key: 'charts.green', label: 'Covered by log backups' }
}
const kind = (set: BackupSetRow): Exclude<Mark, 'covered'> => set.type === 'log' ? 'log' : set.type === 'differential' ? 'differential' : 'full'

/** A mark's shape at x: a large triangle for a full backup, a small one for a differential, a tick under the band for a log. */
function Glyph({ mark, x, fill }: { readonly mark: Exclude<Mark, 'covered'>; readonly x: number; readonly fill?: CSSProperties }) {
  const className = `restore-timeline-${mark}`
  switch (mark) {
    case 'full': return <polygon className={className} style={fill} points={`${x - 7},4 ${x + 7},4 ${x},18`} />
    case 'differential': return <polygon className={className} style={fill} points={`${x - 4.5},9 ${x + 4.5},9 ${x},18`} />
    case 'log': return <rect className={className} style={fill} x={x - 1.5} y={30} width={3} height={12} />
  }
}

/** A legend entry: the mark's own shape, so the legend reads without colour (and under forced colours) too. */
function Swatch({ mark, fill }: { readonly mark: Mark; readonly fill?: CSSProperties }) {
  return <svg className="restore-timeline-swatch" viewBox="0 0 14 14" aria-hidden="true">
    {mark === 'full' ? <polygon className="restore-timeline-full" style={fill} points="0,1 14,1 7,13" />
      : mark === 'differential' ? <polygon className="restore-timeline-differential" style={fill} points="2.5,4 11.5,4 7,12" />
        : mark === 'log' ? <rect className="restore-timeline-log" style={fill} x={5.5} y={1} width={3} height={12} />
          : <rect className="restore-timeline-covered" style={fill} x={0} y={3} width={14} height={8} />}
  </svg>
}

/**
 * Backup Timeline: Restore to the last backup taken or a specific date and time, chosen with the Date and Time fields or on
 * the timeline (a slider: the arrows move a minute, Shift an hour), which shows the backups and the stretches the logs cover
 * (SSMS's sub-dialog, recalled).
 */
export default function BackupTimeline({ state, draft, facts, service }: Pick<SectionProps, 'state' | 'draft' | 'facts' | 'service'>) {
  const plan = draftPlan(draft, facts)
  const sets = sourceSets(draft, facts)
  const lastFinish = Math.max(...sets.map(set => timeMs(set.finish) ?? 0))
  const [specific, setSpecific] = useState(draft.stopAt !== undefined)
  const [point, setPoint] = useState(timeMs(draft.stopAt ?? '') ?? lastFinish)
  const [interval, chooseInterval] = useState<TimelineInterval>('day')
  const [width, setWidth] = useState<number>(track.fallbackWidth)
  const box = useRef<HTMLDivElement>(null)
  const forced = useForcedColors()
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => { if (element.clientWidth > 0) setWidth(element.clientWidth) }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const span = timelineWindow(sets, interval, point)
  const text = timeText(point), allowed = pointAllowed(sets, text)
  const id = (key: string) => fieldId(state.id, `timeline-${key}`)
  // Inset by half the widest glyph, so marks at the window's ends show whole.
  const scale = width - 2 * track.inset, at = (fraction: number) => track.inset + fraction * scale
  const fill = (mark: Mark): CSSProperties | undefined => forced ? undefined : { fill: `var(${cssVariable(marks[mark].key)})` }
  const move = (ms: number) => { setSpecific(true); setPoint(Math.round(ms / 1000) * 1000) }
  const keyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const next = stepPoint(event.key, event.shiftKey, point, span)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    move(next)
  }
  const pointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width > 2 * track.inset) move(span.from + (span.to - span.from) * Math.min(1, Math.max(0, (event.clientX - rect.left - track.inset) / (rect.width - 2 * track.inset))))
  }
  // Logs first, then differentials, then fulls: a larger glyph draws over a tick it shares a time with.
  const order = { log: 0, differential: 1, full: 2 } as const
  const placed = sets.flatMap(set => { const ms = timeMs(set.finish); return ms === undefined || ms < span.from || ms > span.to ? [] : [{ set, x: at(position(ms, span)) }] })
    .sort((a, b) => order[kind(a.set)] - order[kind(b.set)])
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
    <div className="restore-timeline-box" ref={box}>
      <svg className="restore-timeline-track" width={width} height={track.height} viewBox={`0 0 ${width} ${track.height}`} role="slider" tabIndex={0} aria-label="Point in time"
        aria-valuemin={Math.floor(span.from / 60_000)} aria-valuemax={Math.ceil(span.to / 60_000)} aria-valuenow={Math.floor(point / 60_000)} aria-valuetext={text.replace('T', ' ')}
        aria-invalid={specific && !allowed ? true : undefined} onKeyDown={keyDown} onPointerDown={pointer}>
        <rect className="restore-timeline-base" x={track.inset} y={track.bandTop + 2} width={scale} height={track.bandHeight - 4} />
        {coverage(sets, span).map((stretch, index) => <rect key={index} className="restore-timeline-covered" style={fill('covered')} x={at(stretch.from)} y={track.bandTop} width={Math.max(2, (stretch.to - stretch.from) * scale)} height={track.bandHeight} />)}
        {placed.map(({ set, x }) => <Glyph key={set.id} mark={kind(set)} x={x} fill={fill(kind(set))} />)}
        {specific && <rect className="restore-timeline-point" x={at(position(point, span)) - 1.5} y={0} width={3} height={track.height} />}
      </svg>
    </div>
    <div className="restore-timeline-ends"><span>{timeText(span.from).replace('T', ' ')}</span><span>{timeText(span.to).replace('T', ' ')}</span></div>
    <ul className="restore-timeline-legend" aria-label="Legend">
      {(Object.keys(marks) as Mark[]).map(mark => <li key={mark}><Swatch mark={mark} fill={fill(mark)} />{marks[mark].label}</li>)}
    </ul>
  </SubDialog>
}
