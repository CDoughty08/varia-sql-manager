// @vitest-environment happy-dom
// The status bar's SQL Server Agent stopped item (AG-3): with Agent stopped on one server, it opens that server's Job Activity
// Monitor, not the active document's server; a followed job's end always shows its date.
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import AgentJobStatus from '../src/renderer/src/agent/AgentJobStatus'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'
import type { FakeLiveHandle } from './fixtures/live-handle'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

describe("The status bar's Agent stopped item", () => {
  it('opens Job Activity Monitor on the server whose Agent is stopped', async () => {
    const fixture = workbenchFixture({ agentPreview: true })
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    fixture.connect(connectionInfo('c2'))
    const monitor = fixture.jobActivity.open('c1')
    const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.connectionId === 'c1')!
    handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.jobs.service', costMs: 1, effectiveIntervalMs: 10_000, status: [{ id: 'agentXps', value: 0 }, { id: 'serviceState', value: 1 }] }] })
    fixture.documents.newQuery('', undefined, 'c2')
    expect(fixture.documents.active?.connectionId).toBe('c2')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const workbench = { ...fixture, platform: 'win32' } as unknown as Workbench
    await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(AgentJobStatus) })) })
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
    const button = host.querySelector<HTMLButtonElement>('.agent-stopped-status button')!
    expect(button.textContent).toContain('SQL Server Agent stopped')
    await act(async () => { button.click() })
    expect(fixture.documents.active?.id).toBe(monitor)
    expect(Object.values(fixture.jobActivity.getSnapshot().documents).map(state => state.connectionId)).toEqual(['c1'])
    // A followed job's end shows its start with the date: the client's today is not the server's.
    fixture.agentJobs.watch('c2', { id: '11111111-1111-1111-1111-111111111111', name: 'Nightly', lastRun: '2026-11-15 02:30:00' })
    const view = (fixture.live.handles as FakeLiveHandle[]).at(-1)!
    const today = new Date(), stamp = today.getFullYear() * 10_000_000_000 + (today.getMonth() + 1) * 100_000_000 + today.getDate() * 1_000_000 + 140000
    await act(async () => { view.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.jobs.watched', costMs: 1, effectiveIntervalMs: 5000, metrics: [4, null, 3, null, 1, stamp, ...Array.from({ length: 12 }, () => null)] }] }) })
    expect(host.querySelector('.agent-job-status')?.textContent).toContain(`Nightly: Succeeded (started ${String(stamp).slice(0, 4)}-${String(stamp).slice(4, 6)}-${String(stamp).slice(6, 8)} 14:00:00, server time)`)
  })
  it('offers only the stopped servers when several are down, and forgets a server whose connection is gone', async () => {
    const fixture = workbenchFixture({ agentPreview: true })
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    fixture.connect(connectionInfo('c2'))
    fixture.connect(connectionInfo('c3', 2))
    for (const id of ['c1', 'c2']) {
      fixture.jobActivity.open(id)
      const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.connectionId === id)!
      handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.jobs.service', costMs: 1, effectiveIntervalMs: 10_000, status: [{ id: 'agentXps', value: 1 }, { id: 'serviceState', value: 1 }] }] })
    }
    fixture.documents.newQuery('', undefined, 'c3')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const workbench = { ...fixture, platform: 'win32' } as unknown as Workbench
    await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(AgentJobStatus) })) })
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
    const button = host.querySelector<HTMLButtonElement>('.agent-stopped-status button')!
    expect(button.textContent).toContain('on 2 servers')
    await act(async () => { button.click() })
    // Not the active query's server: a pick of the two whose Agent is stopped.
    expect(fixture.quickInput.getSnapshot().rows.map(row => row.item.id)).toEqual(['c1', 'c2'])
    fixture.quickInput.hide('cancel')
    // Both connections lost: their monitors' last readings are no news, so the item goes.
    await act(async () => { fixture.connections.markLostBefore(2) })
    expect(host.querySelector('.agent-stopped-status')).toBeNull()
  })
})
