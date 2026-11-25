// @vitest-environment happy-dom
// The Schedules Timeline's drawing (TimelineView) and viewport helpers: bars where the runs are, close runs merged, the active run kept
// apart, a click opening the run under the pointer, and nothing left listening or drawn after dispose.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { freq, noEndDate, subday, type AgentScheduleTiming } from '../src/shared/agent/schedule'
import { timelineModel, type TimelineJobInput } from '../src/shared/agent/timeline'
import { TimelineView } from '../src/renderer/src/agent/TimelineView'
import { fitViewport, minViewportSeconds, zoomViewport } from '../src/renderer/src/agent/SchedulesTimeline'

const now = { date: 20261122, time: 143000 }
const timing = (patch: Partial<AgentScheduleTiming> = {}): AgentScheduleTiming => ({
  freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
  activeStartDate: 20260101, activeEndDate: noEndDate, activeStartTime: 10000, activeEndTime: 235959, ...patch
})
const job = (id: string, name: string, usualSeconds: number, schedule: Partial<AgentScheduleTiming>, scheduleId: number): TimelineJobInput =>
  ({ id, name, enabled: true, usualSeconds, schedules: [{ id: scheduleId, name: `${name} schedule`, enabled: true, timing: timing(schedule) }] })
// 01:00 for 21 minutes (10.5 hours into the window), and every 15 minutes for 4 seconds.
const model = timelineModel({ now, seconds: 86_400, jobs: [job('A', 'Backup', 1_260, { activeStartTime: 10000 }, 1), job('B', 'Logs', 4, { freqSubdayType: subday.minutes, freqSubdayInterval: 15, activeStartTime: 0 }, 2)] })

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.replaceChildren() })

function sized(width: number): HTMLElement {
  const element = document.createElement('div')
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width })
  element.getBoundingClientRect = () => ({ left: 100, top: 0, right: 100 + width, bottom: 20, width, height: 20, x: 100, y: 0, toJSON: () => ({}) })
  document.body.appendChild(element)
  return element
}
function view(width: number) {
  const axis = sized(width), root = sized(width + 200)
  const lanes = model.rows.map(() => sized(width))
  const open = vi.fn()
  const timeline = new TimelineView({ axis, root, open, requestFrame: () => 1, cancelFrame: () => {} })
  cleanups.push(() => timeline.dispose())
  timeline.setModel(model)
  timeline.setLanes(lanes)
  timeline.setViewport({ start: 0, seconds: 86_400 })
  timeline.draw()
  return { timeline, lanes, open, axis }
}
const bars = (lane: HTMLElement) => [...lane.querySelectorAll<HTMLElement>('.agent-timeline-bar')].filter(bar => !bar.hidden)

describe('the Timeline view', () => {
  it('draws a bar per run where it starts, for its usual duration, with the now line and the axis', () => {
    const { lanes, axis } = view(864)
    expect(model.rows.map(row => row.name)).toEqual(['Logs', 'Backup'])
    // 864 pixels for 24 hours: 100 seconds a pixel, so the backup 10.5 hours in starts at 378 and lasts 12.6 pixels.
    const [backup] = bars(lanes[1])
    expect(backup.style.left).toBe('378px')
    expect(backup.style.width).toBe('13px')
    expect(backup.hasAttribute('data-overlap')).toBe(true)
    // The logs every 15 minutes are 9 pixels apart, so each is its own bar.
    expect(bars(lanes[0])).toHaveLength(96)
    expect(lanes[0].querySelectorAll('.agent-timeline-now')).toHaveLength(1)
    expect([...axis.querySelectorAll<HTMLElement>('.agent-timeline-tick')].filter(tick => !tick.hidden).length).toBeGreaterThan(5)
  })
  it('merges runs closer than two pixels into one bar, but keeps the active run and overlaps apart', () => {
    const { timeline, lanes } = view(96)
    // 900 seconds a pixel: every log run meets the next. Only the change into and out of the two flagged runs during the backup splits them.
    const merged = bars(lanes[0])
    expect(merged.length).toBeLessThanOrEqual(3)
    timeline.setActive({ row: 0, run: 10 })
    timeline.draw()
    expect(bars(lanes[0]).filter(bar => bar.hasAttribute('data-active'))).toHaveLength(1)
    expect(bars(lanes[0]).length).toBeGreaterThan(merged.length)
  })
  it('opens the run under a click, the schedule with Shift, and nothing away from a run', () => {
    const { lanes, open } = view(864)
    lanes[1].dispatchEvent(new MouseEvent('click', { clientX: 100 + 384, bubbles: true }))
    expect(open).toHaveBeenLastCalledWith(1, 0, false)
    lanes[1].dispatchEvent(new MouseEvent('click', { clientX: 100 + 380, shiftKey: true, bubbles: true }))
    expect(open).toHaveBeenLastCalledWith(1, 0, true)
    open.mockClear()
    lanes[1].dispatchEvent(new MouseEvent('click', { clientX: 100 + 200, bubbles: true }))
    expect(open).not.toHaveBeenCalled()
  })
  it('stops listening and removes what it drew on dispose', () => {
    const { timeline, lanes, open, axis } = view(864)
    timeline.dispose()
    lanes[1].dispatchEvent(new MouseEvent('click', { clientX: 100 + 384, bubbles: true }))
    expect(open).not.toHaveBeenCalled()
    expect(lanes.every(lane => !lane.querySelector('span'))).toBe(true)
    expect(axis.querySelector('span')).toBeNull()
  })
  it('keeps the viewport inside the window and at least an hour wide, zooming around a point', () => {
    expect(fitViewport({ start: -50, seconds: 600 }, 86_400)).toEqual({ start: 0, seconds: minViewportSeconds })
    expect(fitViewport({ start: 86_000, seconds: 7_200 }, 86_400)).toEqual({ start: 79_200, seconds: 7_200 })
    expect(fitViewport({ start: 0, seconds: 999_999 }, 86_400)).toEqual({ start: 0, seconds: 86_400 })
    // Zooming in around 6 hours in keeps that point where it was on the screen (a quarter of the way across).
    expect(zoomViewport({ start: 0, seconds: 86_400 }, 86_400, 0.5, 21_600)).toEqual({ start: 10_800, seconds: 43_200 })
    expect(zoomViewport({ start: 0, seconds: 3_600 }, 86_400, 0.5)).toEqual({ start: 0, seconds: 3_600 })
    expect(zoomViewport({ start: 40_000, seconds: 43_200 }, 86_400, 4)).toEqual({ start: 0, seconds: 86_400 })
  })
})
