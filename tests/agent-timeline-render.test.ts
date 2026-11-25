// @vitest-environment happy-dom
// The Schedules Timeline as React renders it: the keyboard walks runs and opens the job (Enter) or the schedule (Shift+Enter, or any
// run of a schedule row), a Refresh that re-sorts the rows keeps the active run, one that takes the focused row away moves focus to the
// lane now in its place, and the filter keeps the jobs or schedules it names.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { freq, noEndDate, subday } from '../src/shared/agent/schedule'
import type { AgentScheduleRecord, AgentSchedulesModel } from '../src/shared/actions/agent-schedule'
import type { TimelineSpan } from '../src/shared/agent/timeline'
import SchedulesTimeline from '../src/renderer/src/agent/SchedulesTimeline'
import { timelineFiltered } from '../src/renderer/src/agent/SchedulesService'

// React's act() needs this flag outside a test renderer.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const record = (id: number, name: string, time: number, patch: Partial<AgentScheduleRecord> = {}): AgentScheduleRecord => ({
  id, name, enabled: true, freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
  activeStartDate: 20260101, activeEndDate: noEndDate, activeStartTime: time, activeEndTime: 235959, jobCount: 1, owner: 'sa', version: 1, modified: '2026-10-01T09:00:00', ...patch
})
const job = (id: string, name: string) => ({ id, name, enabled: true, owner: 'sa', version: 1 })
// Sunday 14:30: Nightly runs 02:30 and Reports 06:00 each day (Reports twice a day, 06:00 and 18:00, for runs to walk).
const read = (patch: Partial<AgentSchedulesModel> = {}): AgentSchedulesModel => ({
  login: 'sa', sysadmin: true, platform: 'windows', now: '2026-11-22T14:30:00',
  schedules: [record(1, 'Nightly 02:30', 23000), record(2, 'Twice a day', 60000, { freqSubdayType: subday.hours, freqSubdayInterval: 12, activeEndTime: 235959 })],
  jobs: [job('A', 'Nightly'), job('B', 'Reports')],
  links: [{ scheduleId: 1, jobId: 'A' }, { scheduleId: 2, jobId: 'B' }],
  durations: [{ jobId: 'A', seconds: 600 }, { jobId: 'B', seconds: 300 }],
  ...patch
})

let root: Root | undefined, container: HTMLElement | undefined
afterEach(() => { act(() => { root?.unmount() }); root = undefined; container?.remove() })

function mount(first: AgentSchedulesModel, span: TimelineSpan = 'day') {
  const onOpenJob = vi.fn(), onOpenSchedule = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const host = container
  const draw = (model: AgentSchedulesModel) => act(() => {
    root!.render(createElement(SchedulesTimeline, { documentId: 'd1', model, span, onSpan: () => {}, onOpenJob, onOpenSchedule }))
  })
  draw(first)
  const lanes = () => [...host.querySelectorAll<HTMLElement>('[role="gridcell"]')]
  const lane = (name: string) => lanes().find(item => item.getAttribute('aria-label')?.startsWith(`${name},`))!
  const announced = () => host.querySelector('[aria-live="polite"]')?.textContent ?? ''
  const key = (target: HTMLElement, name: string, shiftKey = false) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true })) })
  const focus = (target: HTMLElement) => act(() => { target.focus() })
  return { draw, lanes, lane, announced, key, focus, onOpenJob, onOpenSchedule }
}

describe('the Schedules Timeline as rendered', () => {
  it('walks runs by key and opens the job with Enter, the schedule with Shift+Enter', () => {
    const view = mount(read())
    // Rows in the order they next run: Reports at 18:00 today, then Nightly at 02:30.
    expect(view.lanes().map(item => item.getAttribute('aria-label')?.split(',')[0])).toEqual(['Reports', 'Nightly'])
    view.focus(view.lane('Reports'))
    expect(view.announced()).toMatch(/^Reports: 18:00 to 18:05, schedule Twice a day,/)
    view.key(view.lane('Reports'), 'End')
    expect(view.announced()).toMatch(/^Reports: 06:00 to 06:05,/)
    view.key(view.lane('Reports'), 'Home')
    expect(view.announced()).toMatch(/^Reports: 18:00 to 18:05,/)
    view.key(view.lane('Reports'), 'ArrowDown')
    expect(view.announced()).toMatch(/^Nightly: 02:30 to 02:40,/)
    expect(document.activeElement).toBe(view.lane('Nightly'))
    view.key(view.lane('Nightly'), 'Enter')
    expect(view.onOpenJob).toHaveBeenCalledWith('Nightly')
    view.key(view.lane('Nightly'), 'Enter', true)
    expect(view.onOpenSchedule).toHaveBeenCalledWith(1)
  })
  it('opens the schedule from a schedule row below sysadmin', () => {
    const view = mount(read({ sysadmin: false, jobs: undefined, links: undefined, durations: undefined }))
    view.focus(view.lane('Nightly 02:30'))
    view.key(view.lane('Nightly 02:30'), 'Enter')
    expect(view.onOpenSchedule).toHaveBeenCalledWith(1)
    expect(view.onOpenJob).not.toHaveBeenCalled()
  })
  it('keeps the active run through a Refresh that re-sorts the rows, and moves focus on when its row goes', () => {
    const view = mount(read())
    view.focus(view.lane('Reports'))
    view.key(view.lane('Reports'), 'End')
    expect(view.announced()).toMatch(/^Reports: 06:00 to 06:05,/)
    // A new job running at 15:00 now sorts first: Reports' 06:00 run stays the active one, on its lane.
    const early = read({ schedules: [...read().schedules, record(3, 'Afternoon', 150000)], jobs: [...read().jobs!, job('C', 'Afternoon job')], links: [...read().links!, { scheduleId: 3, jobId: 'C' }] })
    view.draw(early)
    expect(view.lanes()[0].getAttribute('aria-label')).toMatch(/^Afternoon job,/)
    expect(view.announced()).toMatch(/^Reports: 06:00 to 06:05,/)
    expect(view.lane('Reports').tabIndex).toBe(0)
    // Reports is gone from the next read: focus moves to the lane now in its place rather than to the page.
    view.draw(read({ jobs: [job('A', 'Nightly'), job('C', 'Afternoon job')], schedules: early.schedules, links: early.links!.filter(link => link.jobId !== 'B') }))
    expect(view.lanes().map(item => item.getAttribute('aria-label')?.split(',')[0])).toEqual(['Afternoon job', 'Nightly'])
    expect(document.activeElement).toBe(view.lanes()[1])
  })
  it('filters jobs by their name or a schedule name at sysadmin, and schedules by name below it', () => {
    const model = read()
    expect(timelineFiltered(model, '').jobs).toBe(model.jobs)
    expect(timelineFiltered(model, 'night').jobs?.map(item => item.name)).toEqual(['Nightly'])
    expect(timelineFiltered(model, 'twice').jobs?.map(item => item.name)).toEqual(['Reports'])
    expect(timelineFiltered(model, 'nothing').jobs).toEqual([])
    const below = read({ sysadmin: false, jobs: undefined, links: undefined })
    expect(timelineFiltered(below, 'twice').schedules.map(item => item.name)).toEqual(['Twice a day'])
    expect(timelineFiltered(below, 'reports').schedules).toEqual([])
  })
})
