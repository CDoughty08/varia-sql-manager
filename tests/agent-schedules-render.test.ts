// @vitest-environment happy-dom
// The Schedules document's grid (AG-10): the SQLAgentOperatorRole answer arrives after the schedules, and the grid's Enabled box on
// another login's schedule follows it at once, not only after the next selection or filter.
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import SchedulesDocument from '../src/renderer/src/agent/SchedulesDocument'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ActionDescribeResult } from '../src/shared/actions/schema'
import type { AgentScheduleRecord, AgentSchedulesModel } from '../src/shared/actions/agent-schedule'
import { freq, noEndDate, subday } from '../src/shared/agent/schedule'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const record = (id: number, name: string, owner: string): AgentScheduleRecord => ({
  name, enabled: false, freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
  activeStartDate: 20260101, activeEndDate: noEndDate, activeStartTime: 23000, activeEndTime: 235959, id, jobCount: 0, owner, version: 3, modified: '2026-11-20T01:02:03.456'
})
const model: AgentSchedulesModel = { login: 'sa', sysadmin: false, platform: 'windows', now: '2026-11-22T14:30:00', schedules: [record(3, 'Off', 'dana')], jobs: [], durations: [] }
const profile = { platform: 'windows', engineEdition: 3, msdbAccess: true, sysadmin: false, userRole: false, readerRole: false, operatorRole: true, purgeHistory: true, serverServices: false, sessions: false, alterAnyCredential: false, clustered: false, databaseMail: false } as const

describe('The Schedules grid', () => {
  it("enables the Enabled box on another login's schedule once the operator role is read", async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentSchedules: model, elapsedMs: 1 } as ActionDescribeResult }))
    let answer: (value: unknown) => void = () => {}
    fixture.api.agentProfile.mockImplementation(() => new Promise(resolve => { answer = resolve }) as never)
    const id = fixture.schedules.open('c1')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: createElement(SchedulesDocument, { documentId: id }) })) })
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
    const box = () => host.querySelector<HTMLInputElement>('input[aria-label="Enabled: Off"]')
    await act(async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) })
    expect(box()?.disabled).toBe(true)
    await act(async () => { answer({ ok: true, value: { elapsedMs: 1, profile } }); for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) })
    expect(box()?.disabled).toBe(false)
  })
})
