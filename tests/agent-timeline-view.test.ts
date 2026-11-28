// @vitest-environment happy-dom
// The Schedules Timeline's drawing (TimelineView) and viewport helpers: bars where the runs are, close runs merged, the active run kept
// apart, a click opening the run under the pointer, and nothing left listening or drawn after dispose.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { freq, noEndDate, subday, type AgentScheduleTiming } from '../src/shared/agent/schedule'
import { timelineModel, type TimelineJobInput } from '../src/shared/agent/timeline'
import { TimelineView } from '../src/renderer/src/agent/TimelineView'
import { fitViewport, minViewportSeconds, zoomViewport } from '../src/renderer/src/agent/SchedulesTimeline'
import { stylesheetRules } from './fixtures/css-rules'
import { computed } from './fixtures/css-cascade'

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
  it('hides pooled axis ticks and midnight marks with display: none when narrower width shrinks tick count', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync('src/renderer/src/styles.css', 'utf8')
    document.head.appendChild(style)
    cleanups.push(() => style.remove())

    const hiddenRule = stylesheetRules().find(rule => rule.selector === '.agent-timeline-tick[hidden], .agent-timeline-midnight[hidden]')
    expect(hiddenRule?.declarations).toContainEqual({ property: 'display', value: 'none' })

    let currentWidth = 864
    const axis = document.createElement('div')
    Object.defineProperty(axis, 'clientWidth', { configurable: true, get: () => currentWidth })
    axis.getBoundingClientRect = () => ({ left: 100, top: 0, right: 100 + currentWidth, bottom: 20, width: currentWidth, height: 20, x: 100, y: 0, toJSON: () => ({}) })
    const root = sized(currentWidth + 200)
    document.body.appendChild(axis)
    const lanes = model.rows.map(() => sized(currentWidth))
    const timeline = new TimelineView({ axis, root, open: vi.fn(), requestFrame: () => 1, cancelFrame: () => {} })
    cleanups.push(() => timeline.dispose())
    timeline.setModel(model)
    timeline.setLanes(lanes)
    timeline.setViewport({ start: 0, seconds: 86_400 })
    timeline.draw()

    const wideVisible = [...axis.querySelectorAll<HTMLElement>('.agent-timeline-tick')].filter(tick => !tick.hidden)
    expect(wideVisible.length).toBeGreaterThanOrEqual(8)
    expect(getComputedStyle(wideVisible[0]).display).toBe('flex')

    // Shrink container width (simulating 1440 -> 1080 resize where tick step widens from 2h to 6h)
    currentWidth = 400
    timeline.draw()

    const allTicks = [...axis.querySelectorAll<HTMLElement>('.agent-timeline-tick')]
    const visibleTicks = allTicks.filter(tick => !tick.hidden)
    const hiddenTicks = allTicks.filter(tick => tick.hidden)
    expect(visibleTicks.length).toBeLessThan(wideVisible.length)
    expect(hiddenTicks.length).toBeGreaterThan(0)
    for (const tick of hiddenTicks) {
      expect(tick.hidden).toBe(true)
      expect(getComputedStyle(tick).display).toBe('none')
    }
    for (const tick of visibleTicks) {
      expect(getComputedStyle(tick).display).toBe('flex')
    }
  })

  it('insets .agent-timeline-overlaps-head:focus-visible outline inside .tl-overlap-drawer with transition: none', () => {
    const rules = stylesheetRules()
    const baseFocus = rules.find(rule => !rule.at.length && rule.selector === '.agent-timeline-overlaps-head:focus-visible')
    expect(baseFocus?.declarations).toContainEqual({ property: 'outline-offset', value: '-2px' })
    expect(baseFocus?.declarations).toContainEqual({ property: 'transition', value: 'none' })
    expect(baseFocus?.declarations).toContainEqual({ property: 'outline', value: '2px solid var(--varia-focusBorder)' })

    const forcedFocus = rules.find(rule => rule.at.includes('@media (forced-colors: active)') && rule.selector === '.agent-timeline-overlaps-head:focus-visible')
    expect(forcedFocus?.declarations).toContainEqual({ property: 'outline-color', value: 'Highlight' })

    const normal = computed(['button', '.agent-timeline-overlaps-head', ':focus-visible'], false)
    expect(normal.get('outline-offset')).toBe('-2px')
    expect(normal.get('transition')).toBe('none')

    const forced = computed(['button', '.agent-timeline-overlaps-head', ':focus-visible'], true)
    expect(forced.get('outline-offset')).toBe('-2px')
    expect(forced.get('transition')).toBe('none')
    expect(forced.get('outline-color')).toBe('Highlight')
  })

  it('omits axis tick labels near the right edge so partial times are never clipped while keeping tick marks intact', () => {
    const { timeline, axis } = view(864)
    const ticks = () => [...axis.querySelectorAll<HTMLElement>('.agent-timeline-tick')].filter(tick => !tick.hidden)

    // With now = 14:30:00 and 24h at 864px, the 14:00 tick sits at 23.5/24 * 864 = 846px (18px from right edge < 44px clearance).
    const dayTicks = ticks()
    const rightmost = dayTicks[dayTicks.length - 1]
    expect(rightmost.style.left).toMatch(/^97\.9/)
    expect(rightmost.textContent).toBe('')
    expect(dayTicks[dayTicks.length - 2].textContent).toBe('12:00')

    // When zoomed/shifted so the 14:00 tick has >= 44px clearance from the right edge, its label renders in full.
    timeline.setViewport({ start: 23 * 3_600 - 1_800, seconds: 7_200 })
    timeline.draw()
    const zoomedTicks = ticks()
    expect(zoomedTicks.some(tick => tick.textContent === '14:00')).toBe(true)

    // On a 7-day window, weekday-prefixed labels near the right edge also clear their text when within label clearance.
    const weekModel = timelineModel({ now: { date: 20261122, time: 10000 }, seconds: 7 * 86_400, jobs: [job('A', 'Backup', 1_260, { activeStartTime: 10000 }, 1)] })
    timeline.setModel(weekModel)
    timeline.setViewport({ start: 0, seconds: 7 * 86_400 })
    timeline.draw()
    const weekTicks = ticks()
    const lastWeekTick = weekTicks[weekTicks.length - 1]
    expect(lastWeekTick.textContent).toBe('')
    expect(weekTicks[weekTicks.length - 2].textContent).toMatch(/^[A-Z][a-z]{2} \d{2}:\d{2}$/)
  })

  it('uses live offsetWidth instead of static clearance when layout metrics exist', () => {
    let mockTickWidth = 0
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains('agent-timeline-tick') && this.textContent ? mockTickWidth : 0
    })
    cleanups.push(() => spy.mockRestore())

    const ticks = (axis: HTMLElement) => [...axis.querySelectorAll<HTMLElement>('.agent-timeline-tick')].filter(tick => !tick.hidden)

    // (a) A fitting label inside [width - clearance, width - measured] stays visible (14:00 at 23.5/24 * 1600 = 1566.67, clearance = 44, measured = 31 -> 1566.67 + 31 <= 1600).
    mockTickWidth = 31
    const wide = view(1600)
    const wideTicks = ticks(wide.axis)
    const wideLast = wideTicks[wideTicks.length - 1]
    expect(wideLast.hidden).toBe(false)
    expect(wideLast.textContent).toBe('14:00')

    // (b) An oversized label exceeding 1.5 * clearance (measured = 96 > 66; 12:00 at 21.5/24 * 864 = 774 -> 774 + 96 > 864) gets blanked cleanly while keeping the tick element visible.
    mockTickWidth = 96
    const scaled = view(864)
    const scaledTicks = ticks(scaled.axis)
    expect(scaledTicks[scaledTicks.length - 1].hidden).toBe(false)
    expect(scaledTicks[scaledTicks.length - 1].textContent).toBe('')
    expect(scaledTicks[scaledTicks.length - 2].hidden).toBe(false)
    expect(scaledTicks[scaledTicks.length - 2].textContent).toBe('')
    expect(scaledTicks[scaledTicks.length - 3].textContent).toBe('10:00')
  })
})
