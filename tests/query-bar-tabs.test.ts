// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import type { IDockviewPanelHeaderProps } from 'dockview-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import QueryBar from '../src/renderer/src/QueryBar'
import { DocumentTab } from '../src/renderer/src/editor-groups/EditorArea'
import { EditorStatusService } from '../src/renderer/src/services/editor-status'
import { ConnectionTargetService } from '../src/renderer/src/services/connection-targets'
import { TargetService } from '../src/renderer/src/services/targets'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { connectionTargetOptions } from '../src/shared/connection-targets'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(clean => clean())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function fixture() {
  const value = workbenchFixture({ platform: 'win32' })
  const registry = new ConnectionTargetService()
  const targets = new TargetService(value.documents, value.queries, value.connections, value.files, registry)
  const theme = { subscribe: () => () => {}, getSnapshot: () => 0, accent: (color: string | undefined) => color ? `var(--varia-connection-${color})` : undefined }
  const editorStatus = new EditorStatusService(callback => callback())
  const tabRename = new SnapshotStore({ id: '' })
  const menuTargets = { register: () => ({ dispose: () => {} }) }
  const gestures = { matches: () => false }
  const emptyEstimates = new Map()
  const bigQueryCost = { getSnapshot: () => emptyEstimates, subscribe: () => () => {}, status: () => undefined, asksAboveThreshold: () => true }
  cleanups.push(value.dispose, () => editorStatus.dispose())
  value.api.push(readyBackend())
  const workbench = { ...value, targets, theme, editorStatus, tabRename, menuTargets, gestures, bigQueryCost } as unknown as Workbench
  const mount = async (element: ReactElement) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => { act(() => { root.unmount() }); host.remove() })
    await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: element })) })
    return {
      host,
      rerender: async (next: ReactElement) => { await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: next })) }) }
    }
  }
  return { ...value, targets, registry, editorStatus, workbench, mount }
}

function tabProps(id: string): IDockviewPanelHeaderProps {
  return {
    api: {
      id,
      isVisible: true,
      location: { type: 'grid' },
      onDidVisibilityChange: () => ({ dispose: () => {} })
    },
    containerApi: {
      onDidLayoutChange: () => ({ dispose: () => {} })
    }
  } as unknown as IDockviewPanelHeaderProps
}

describe('split-group QueryBar activation & focus', () => {
  it('activates an inactive split group and returns focus to its editor on button click while targeting that tab', async () => {
    const { connections, documents, commands, mount } = fixture()
    connections.add({ ...connectionInfo('prod'), color: 'red', displayName: 'Production ERP' }, { ...connectionOptions, color: 'red', displayName: 'Production ERP', environment: 'Production' })
    connections.add({ ...connectionInfo('stg'), color: 'blue', displayName: 'Staging Analytics' }, { ...connectionOptions, server: 'stg.example', color: 'blue', displayName: 'Staging Analytics', environment: 'Staging' })
    const q1 = documents.create('q1.sql', 'SELECT 1', 'AppData', 'prod')
    const q2 = documents.create('q2.sql', 'SELECT 2', 'AnalyticsStg', 'stg')
    documents.activate(q1.id)

    const onActivate2 = vi.fn(() => documents.activate(q2.id))
    const focusSpy = vi.spyOn(documents, 'focusActive')
    const executeSpy = vi.spyOn(commands, 'execute')

    const { host } = await mount(createElement('div', null,
      createElement(QueryBar, { tabId: q1.id }),
      createElement(QueryBar, { tabId: q2.id, onActivate: onActivate2 })
    ))

    const bars = host.querySelectorAll<HTMLElement>('[data-query-bar]')
    expect(bars).toHaveLength(2)
    // Click Actual Plan in the inactive split group's QueryBar (pointer click leaves focus outside the bar).
    const planBtn2 = bars[1].querySelector<HTMLButtonElement>('button[aria-label="Include Actual Execution Plan"]')!
    await act(async () => { planBtn2.click() })

    expect(onActivate2).toHaveBeenCalledTimes(1)
    expect(documents.active?.id).toBe(q2.id)
    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(executeSpy).toHaveBeenCalledWith('query.includeActualPlan', expect.objectContaining({ tabId: q2.id }), 'toolbar')
    expect(documents.get(q2.id)?.includeActualPlan).toBe(true)
    expect(documents.get(q1.id)?.includeActualPlan).toBeFalsy()
  })

  it('activates an inactive split group on keyboard focus without stealing focus away from the bar', async () => {
    const { connections, documents, mount } = fixture()
    connections.add(connectionInfo('a'), connectionOptions)
    const q1 = documents.create('q1.sql', 'SELECT 1', 'master', 'a')
    const q2 = documents.create('q2.sql', 'SELECT 2', 'master', 'a')
    documents.activate(q1.id)

    const onActivate2 = vi.fn(() => documents.activate(q2.id))
    const focusSpy = vi.spyOn(documents, 'focusActive')

    const { host } = await mount(createElement(QueryBar, { tabId: q2.id, onActivate: onActivate2 }))
    const executeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Execute"]')!
    await act(async () => { executeBtn.focus() })

    expect(onActivate2).toHaveBeenCalledTimes(1)
    expect(documents.active?.id).toBe(q2.id)
    expect(focusSpy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(executeBtn)
  })
})

describe('refined 2-line DocumentTab', () => {
  it('omits .tab-sid when idle without a session or remembered server, and keeps a fixed .tab-pin slot', async () => {
    const { connections, documents, queries, registry, mount } = fixture()
    connections.add({ ...connectionInfo('prod'), color: 'red', displayName: 'Production ERP' }, { ...connectionOptions, color: 'red', displayName: 'Production ERP', environment: 'Production' })

    // 1. Fresh disconnected SQL tab: no .tab-sid ("—") and no empty .tab-metadata row.
    const idle = documents.create('SQLQuery1.sql', '', 'master')
    const view = await mount(createElement(DocumentTab, tabProps(idle.id)))
    expect(view.host.querySelector('.tab-sid')).toBeNull()
    expect(view.host.querySelector('.tab-metadata')).toBeNull()
    expect(view.host.querySelector('.tab-pin')).not.toBeNull()

    // 2. Connected SQL tab with environment but no live SPID: renders environment tag, still omits .tab-sid.
    let connectedId = ''
    await act(async () => { connectedId = documents.create('SQLQuery2.sql', '', 'AppData', 'prod').id })
    await view.rerender(createElement(DocumentTab, tabProps(connectedId)))
    expect(view.host.querySelector('.environment-tag')).not.toBeNull()
    expect(view.host.querySelector('.tab-sid')).toBeNull()

    // 3. Live session SPID present: renders SID 54 without boxed dash placeholder.
    vi.spyOn(queries, 'getSnapshot').mockReturnValue({ [connectedId]: { session: { connectionId: 'prod', spid: 54 } } })
    await view.rerender(createElement(DocumentTab, tabProps(connectedId)))
    expect(view.host.querySelector('.tab-sid')?.textContent).toBe('SID 54')

    // 4. Remembered disconnected query: renders remembered server and Disconnected status.
    const targetId = '00000000-0000-4000-8000-000000000002'
    let restoredId = ''
    await act(async () => {
      registry.add({ id: targetId, options: connectionTargetOptions(connectionOptions), details: { displayName: 'Reporting', environment: 'Staging', color: '#71a7df', autoReconnect: 'inherit' }, inExplorer: true, resumeWanted: true })
      restoredId = documents.create('Restored.sql', '', 'AppData').id
      documents.update(restoredId, { targetId, attachWanted: true })
    })
    await view.rerender(createElement(DocumentTab, tabProps(restoredId)))
    expect(view.host.querySelector('.tab-remembered-server')?.textContent).toBe('server.example')
    expect(view.host.querySelector('.tab-sid')?.textContent).toBe('Disconnected')
  })

  it('hoists document tabs above per-query bars with no workspace-level QueryBar or spacer (non-query tab Y-stability)', () => {
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const editorAreaSource = readFileSync('src/renderer/src/editor-groups/EditorArea.tsx', 'utf8')
    expect(appSource).not.toContain('<QueryBar')
    expect(appSource).not.toContain('query-bar-spacer')
    expect(editorAreaSource).toContain('<QueryBar tabId={api.id}')
  })
})
