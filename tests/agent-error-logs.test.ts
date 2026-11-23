// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { actionExecuteRequestSchema } from '../src/shared/actions/schema'
import { agentLimits } from '../src/shared/agent/catalog'
import {
  agentErrorLogArgsSchema, agentErrorLogsResultSchema, agentErrorLogsSchema, errorLogArgs, errorLogCommandEntries, errorLogLabel, errorLogsUnavailable, recycleText, recycleUnavailable
} from '../src/shared/agent/error-log'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { compileWhen, evaluateWhen } from '../src/shared/commands/when'
import { methodPolicies } from '../src/shared/ipc/methods'
import { liveProbes } from '../src/shared/live/catalog'
import { liveArgsSchemas } from '../src/shared/live/schema'
import { requestSchemas, resultSchemas } from '../src/main/validation'
import { logViewerText, type LogViewerState } from '../src/renderer/src/agent/LogViewerService'
import { RecycleDialog } from '../src/renderer/src/agent/LogFileViewer'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'
import type { FakeLiveHandle } from './fixtures/live-handle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()) })

const uuid = '33333333-3333-4333-8333-333333333333'
const sysadmin = { ok: true, value: { elapsedMs: 1, profile: { sysadmin: true, msdbAccess: true, purgeHistory: true } as never } } as const
const operator = { ok: true, value: { elapsedMs: 1, profile: { sysadmin: false, msdbAccess: true, operatorRole: true, purgeHistory: true } as never } } as const

function viewer() {
  const fixture = workbenchFixture({ agentPreview: true })
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  const handles = () => fixture.live.handles as FakeLiveHandle[]
  const errorLog = () => handles().filter(item => item.spec.source === 'agent.errorLog').at(-1)
  return { ...fixture, handles, errorLog }
}

describe("the Agent error logs' shared rules", () => {
  it('takes args main and the backend both accept', () => {
    expect(liveArgsSchemas['agent.errorLog']).toBe(agentErrorLogArgsSchema)
    expect(agentErrorLogArgsSchema.safeParse({ logs: [0, 1, 99], days: 7, text: 'Login failed' }).success).toBe(true)
    for (const refused of [{}, { logs: [] }, { logs: [100] }, { logs: [-1] }, { logs: [0, 0] }, { logs: [0], days: 0 }, { logs: [0], days: 3651 }, { logs: [0], text: '' },
      { logs: [0], text: 'x'.repeat(agentLimits.searchChars + 1) }, { logs: [0], other: 1 }])
      expect(agentErrorLogArgsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false)
    expect(liveProbes['agent.errorLog.read'].tables![0].key).toEqual(['logKey'])
  })
  it('sends the checked logs in archive order with the shared filters, and nothing with no log checked', () => {
    expect(errorLogArgs([], { text: 'x', days: 7 })).toBeUndefined()
    expect(errorLogArgs([2, 0], { text: '  boom ', days: 7 })).toEqual({ logs: [0, 2], days: 7, text: 'boom' })
    expect(errorLogArgs([0], { text: '', days: undefined })).toEqual({ logs: [0] })
    expect(errorLogArgs([0], { text: 'x'.repeat(500) })!.text).toHaveLength(agentLimits.searchChars)
  })
  it('registers agent.errorLogs in every place a backend method needs, and checks its answer', () => {
    expect(requestSchemas['agent.errorLogs']).toBe(agentErrorLogsSchema)
    expect(resultSchemas['agent.errorLogs']).toBe(agentErrorLogsResultSchema)
    expect(methodPolicies['agent.errorLogs']).toMatchObject({ kind: 'unary', lane: 'metadata' })
    expect(agentErrorLogsSchema.safeParse({ connectionId: uuid, requestId: uuid }).success).toBe(true)
    expect(agentErrorLogsSchema.safeParse({ connectionId: uuid, requestId: uuid, log: 1 }).success).toBe(false)
    expect(agentErrorLogsResultSchema.safeParse({ logs: [{ archive: 0, date: '2026-11-22T14:31:00', bytes: 120 }], archives: true, elapsedMs: 3 }).success).toBe(true)
    expect(agentErrorLogsResultSchema.safeParse({ logs: [{ archive: 100 }], archives: true, elapsedMs: 3 }).success).toBe(false)
    expect(agentErrorLogsResultSchema.safeParse({ logs: [{ archive: 0, date: '22/11/2026' }], archives: true, elapsedMs: 3 }).success).toBe(false)
  })
  it('adds Recycle to actions.execute only, with the Agent as its target and nothing else', () => {
    const request = { action: 'recycleAgentErrorLog', connectionId: uuid, requestId: uuid, target: { kind: 'agent' } }
    expect(actionExecuteRequestSchema.safeParse(request).success).toBe(true)
    expect(actionExecuteRequestSchema.safeParse({ ...request, target: { kind: 'agent', name: 'x' } }).success).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...request, target: { kind: 'table', schema: 'dbo', name: 't' } }).success).toBe(false)
    expect(actionExecuteRequestSchema.safeParse({ ...request, agentHistory: { jobs: [], all: true } }).success).toBe(false)
    expect(requestSchemas['actions.script'].safeParse(request).success).toBe(false)
  })
  it('offers the error logs and Recycle to sysadmin alone, and Recycle nowhere on Managed Instance', () => {
    expect(errorLogsUnavailable('sysadmin')).toBeUndefined()
    expect(errorLogsUnavailable('operator')).toContain('sysadmin')
    expect(errorLogsUnavailable('unknown')).toContain('Reading')
    expect(recycleUnavailable({ role: 'sysadmin', live: true })).toBeUndefined()
    expect(recycleUnavailable({ role: 'operator', live: true })).toContain('sysadmin')
    expect(recycleUnavailable({ role: 'unknown', live: true })).toContain('Reading')
    expect(recycleUnavailable({ role: 'sysadmin', live: false })).toContain('Connect')
    expect(recycleUnavailable({ role: 'sysadmin', live: true, managedInstance: true })).toContain('Managed Instance')
  })
  it('names a log as Object Explorer lists it', () => {
    expect(errorLogLabel({ archive: 0, date: '2026-11-22T14:31:09' })).toBe('Current - 2026-11-22 14:31')
    expect(errorLogLabel({ archive: 3 })).toBe('Archive #3')
  })
  it('offers View Agent Log and Recycle on the Error Logs folder and its logs, behind the release gate', () => {
    const entries = errorLogCommandEntries()
    for (const id of ['agent.viewAgentLog', 'agent.recycleErrorLog'] as const) {
      expect(commandDescriptor(id).precondition).toBe(entries[id].precondition)
      expect(entries[id].precondition).toContain('agentEnabled')
      const when = compileWhen(commandDescriptor(id).menus![0].when!)
      const on = (keys: Record<string, unknown>) => evaluateWhen(when, { explorerServerLost: false, explorerServerEngine: 'box', ...keys } as never)
      expect(on({ explorerNode: 'agentErrorLog' }) && on({ explorerNode: 'folder', explorerFolder: 'agentErrorLogs' })).toBe(true)
      expect(on({ explorerNode: 'agent' }) || on({ explorerNode: 'folder', explorerFolder: 'agentJobs' }) || on({ explorerNode: 'agentErrorLog', explorerServerLost: true })).toBe(false)
    }
    expect(commandDescriptor('agent.recycleErrorLog').menus![0].title).toBe('Recycle')
    // Managed Instance manages its log itself: Recycle is not on its menu, View Agent Log is.
    const engine = (id: 'agent.viewAgentLog' | 'agent.recycleErrorLog', explorerServerEngine: string) =>
      evaluateWhen(compileWhen(commandDescriptor(id).menus![0].when!), { explorerServerLost: false, explorerNode: 'agentErrorLog', explorerServerEngine } as never)
    expect(engine('agent.recycleErrorLog', 'box') && engine('agent.viewAgentLog', 'managedInstance')).toBe(true)
    expect(engine('agent.recycleErrorLog', 'managedInstance')).toBe(false)
  })
})

describe("the Log File Viewer's Agent error logs", () => {
  it('opens on a log with no job checked, and follows the checked logs and the shared filters', async () => {
    const { logViewer, errorLog, handles, api } = viewer()
    api.agentProfile.mockResolvedValue(sysadmin)
    const id = logViewer.open('c1', { errorLog: 1 })
    expect(logViewer.get(id)).toMatchObject({ logs: [1], checked: [] })
    expect(errorLog()!.spec).toMatchObject({ source: 'agent.errorLog', args: { logs: [1], days: 7 } })
    expect(handles().find(item => item.spec.source === 'agent.history')!.spec.args).toEqual({ jobs: [], days: 7 })
    await settled()
    // sysadmin: Select logs lists the error logs.
    expect(api.agentErrorLogs).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c1' }))
    expect(logViewer.get(id)?.errorLogs).toMatchObject({ state: 'ready', archives: true, logs: [{ archive: 0 }, { archive: 1 }] })
    logViewer.toggleLog(id, 0)
    expect(errorLog()!.args.at(-1)).toEqual({ logs: [0, 1], days: 7 })
    logViewer.setText(id, 'Login failed')
    expect(errorLog()!.args.at(-1)).toMatchObject({ logs: [0, 1], text: 'Login failed' })
    // Unchanged args are not sent again.
    const sent = errorLog()!.args.length
    logViewer.toggleLog(id, 0)
    logViewer.toggleLog(id, 0)
    expect(errorLog()!.args.length).toBe(sent + 2)
    logViewer.toggleLog(id, 0)
    logViewer.toggleLog(id, 1)
    expect(errorLog()!.disposed).toBe(true)
    expect(logViewer.errorLogHandle(id)).toBeUndefined()
    // Checking one again opens a fresh view; the open viewer re-aims at a log a node names.
    expect(logViewer.open('c1', { errorLog: 2 })).toBe(id)
    expect(errorLog()!.disposed).toBe(false)
    expect(errorLog()!.spec.args).toMatchObject({ logs: [2] })
  })
  it("says why the log view stopped, a terminal error included, and keeps the viewer's jobs when Recycle opens on it", async () => {
    const { logViewer, api, errorLog } = viewer()
    api.agentProfile.mockResolvedValue(sysadmin)
    const nightly = '11111111-1111-1111-1111-111111111111'
    const id = logViewer.open('c1', { jobs: [nightly] })
    await settled()
    expect(logViewer.errorLogHandle(id)).toBeUndefined()
    // Recycle from Object Explorer on the open viewer: the checked job stays, Current is checked as no log was, and it asks.
    logViewer.open('c1', { errorLog: 0, recycle: true })
    expect(logViewer.get(id)).toMatchObject({ checked: [nightly], logs: [0], recycle: { running: false } })
    logViewer.cancelRecycle(id)
    expect(logViewer.errorLogFailure(id)).toBeUndefined()
    // A terminal error stops the only probe (the backend then ends the subscription): the probe reads paused with its error.
    errorLog()!.set({ probes: { 'agent.errorLog.read': { state: 'paused', error: { code: 'NOT_SUPPORTED', message: 'This server has no Agent error log.' } } as never } })
    expect(logViewer.errorLogFailure(id)).toEqual({ code: 'NOT_SUPPORTED', message: 'This server has no Agent error log.' })
    errorLog()!.set({ status: 'ended', probes: {}, ended: { ended: 'failed', code: 'PERMISSION_DENIED', message: 'Refused.' } as never })
    expect(logViewer.errorLogFailure(id)).toEqual({ code: 'PERMISSION_DENIED', message: 'Refused.' })
    const refreshes = errorLog()!.refreshes
    logViewer.refresh(id)
    expect(errorLog()!.refreshes).toBe(refreshes + 1)
  })
  it('lists no error logs for a login that is not sysadmin', async () => {
    const { logViewer, api } = viewer()
    api.agentProfile.mockResolvedValue(operator)
    const id = logViewer.open('c1')
    await settled()
    expect(api.agentErrorLogs).not.toHaveBeenCalled()
    expect(logViewer.errorLogsUnavailable(id)).toContain('sysadmin')
    expect(logViewer.canRecycle(id)).toBe(false)
  })
  it('unchecks a log View Agent Log checked once the role reads below sysadmin, which Select logs gives no checkbox to undo', async () => {
    const { logViewer, api, errorLog } = viewer()
    api.agentProfile.mockResolvedValue(operator)
    const id = logViewer.open('c1', { errorLog: 0 })
    expect(errorLog()!.disposed).toBe(false)
    await settled()
    expect(logViewer.get(id)?.logs).toEqual([])
    expect(logViewer.get(id)?.note).toContain('sysadmin')
    expect(errorLog()!.disposed).toBe(true)
  })
  it('keeps a failed list with its reason, and reads it again on Retry', async () => {
    const { logViewer, api } = viewer()
    api.agentProfile.mockResolvedValue(sysadmin)
    api.agentErrorLogs.mockResolvedValueOnce({ ok: true, value: { logs: [], archives: false, elapsedMs: 1, error: { code: 'PERMISSION_DENIED', message: 'Refused.', retryable: false } } })
    const id = logViewer.open('c1')
    await settled()
    expect(logViewer.get(id)?.errorLogs).toMatchObject({ state: 'failed', error: 'Refused.' })
    logViewer.retryErrorLogs(id)
    await settled()
    expect(logViewer.get(id)?.errorLogs).toMatchObject({ state: 'ready' })
  })
  it('recycles behind its confirmation, keeps a refusal in it, and reloads the Error Logs folder after', async () => {
    const { logViewer, api, commands, errorLog, logViewerRecycled } = viewer()
    api.agentProfile.mockResolvedValue(sysadmin)
    const id = logViewer.open('c1', { errorLog: 0 })
    await settled()
    expect(logViewer.canRecycle(id)).toBe(true)
    await commands.execute('agent.recycleErrorLog', { tabId: id }, 'api')
    expect(logViewer.get(id)?.recycle).toEqual({ running: false })
    logViewer.cancelRecycle(id)
    expect(logViewer.get(id)).not.toHaveProperty('recycle')
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    logViewer.askRecycle(id)
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: [], elapsedMs: 1, error: { code: 'AGENT_STOPPED', message: 'SQL Server Agent is not running.', retryable: false } } })
    await logViewer.confirmRecycle(id)
    expect(api.executeObjectAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'recycleAgentErrorLog', connectionId: 'c1', target: { kind: 'agent' } }))
    expect(logViewer.get(id)?.recycle).toEqual({ running: false, error: { code: 'AGENT_STOPPED', message: 'SQL Server Agent is not running.' } })
    expect(logViewerRecycled).not.toHaveBeenCalled()
    // A lost connection: whether it ran is unknown, and the line says so.
    api.executeObjectAction.mockResolvedValueOnce({ ok: false, code: 'CONNECTION_LOST', error: 'gone' } as never)
    await logViewer.confirmRecycle(id)
    expect(logViewer.get(id)?.recycle?.error?.message).toBe(logViewerText.recycleLost)
    api.executeObjectAction.mockResolvedValueOnce({ ok: true, value: { steps: [], messages: [], elapsedMs: 1 } })
    const refreshes = errorLog()!.refreshes
    const lists = api.agentErrorLogs.mock.calls.length
    await logViewer.confirmRecycle(id)
    await settled()
    expect(logViewer.get(id)).not.toHaveProperty('recycle')
    expect(logViewer.get(id)?.recycled).toBe(recycleText.done)
    expect(logViewerRecycled).toHaveBeenCalledWith('c1')
    expect(errorLog()!.refreshes).toBe(refreshes + 1)
    expect(api.agentErrorLogs.mock.calls.length).toBe(lists + 1)
    logViewer.closeRecycled(id)
    expect(logViewer.get(id)).not.toHaveProperty('recycled')
  })
  it('opens on Current with the confirmation from the Error Logs folder, and asks nothing of a login that may not recycle', async () => {
    const { logViewer, api } = viewer()
    api.agentProfile.mockResolvedValue(operator)
    const id = logViewer.open('c1', { errorLog: 0, recycle: true })
    // The role is still being read: the confirmation opens (its OK disabled until the role is known), and OK still checks it.
    expect(logViewer.get(id)?.recycle).toEqual({ running: false })
    await settled()
    await logViewer.confirmRecycle(id)
    expect(api.executeObjectAction).not.toHaveBeenCalled()
    expect(logViewer.get(id)?.recycle?.error?.message).toContain('sysadmin')
    logViewer.cancelRecycle(id)
    logViewer.askRecycle(id)
    expect(logViewer.get(id)).not.toHaveProperty('recycle')
    expect(logViewer.get(id)?.note).toContain('sysadmin')
  })
})

describe("Recycle's confirmation", () => {
  it('is an alert whose Cancel takes focus, so Enter recycles nothing', async () => {
    const confirmRecycle = vi.fn(), cancelRecycle = vi.fn()
    const workbench = { logViewer: { confirmRecycle, cancelRecycle, role: () => 'sysadmin' } } as unknown as Workbench
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => { act(() => root.unmount()); host.remove() })
    const state = { id: 'v1', label: 'server-a', recycle: { running: false } } as unknown as LogViewerState
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench, children: createElement(RecycleDialog, { documentId: 'v1', state }) })))
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(recycleText.question)
    expect(document.activeElement?.textContent).toBe('Cancel')
    // While the role is read, OK waits disabled.
    const unknown = { ...workbench.logViewer, role: () => 'unknown' }
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench: { logViewer: unknown } as unknown as Workbench, children: createElement(RecycleDialog, { documentId: 'v1', state }) })))
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === 'Recycle')!.disabled).toBe(true)
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench, children: createElement(RecycleDialog, { documentId: 'v1', state }) })))
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await act(async () => { dialog.querySelector('input, p')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(confirmRecycle).not.toHaveBeenCalled()
    const ok = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Recycle')!
    expect(ok.className).toContain('danger')
    await act(async () => ok.click())
    expect(confirmRecycle).toHaveBeenCalledWith('v1')
  })
})
