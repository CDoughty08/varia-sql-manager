// @vitest-environment happy-dom
// The status bar's SQL Server Agent stopped item (AG-3): with Agent stopped on one server, it opens that server's Job Activity
// Monitor, not the active document's server.
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
  })
})
