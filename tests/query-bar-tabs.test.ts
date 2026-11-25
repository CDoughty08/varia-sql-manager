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
    // Open the unified Plan ▾ menu in the inactive split group's QueryBar via pointer click and choose Include Actual Plan.
    const planTrigger2 = bars[1].querySelector<HTMLButtonElement>('button.plan-menu-trigger')!
    await act(async () => { planTrigger2.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    const menu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Execution Plan Options"]')!
    expect(menu).not.toBeNull()
    const actualItem = menu.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"][aria-label="Include Actual Plan"]')!
    await act(async () => { actualItem.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })

    expect(onActivate2).toHaveBeenCalledTimes(1)
    expect(documents.active?.id).toBe(q2.id)
    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(executeSpy).toHaveBeenCalledWith('query.includeActualPlan', expect.objectContaining({ tabId: q2.id }), 'toolbar')
    expect(documents.get(q2.id)?.includeActualPlan).toBe(true)
    expect(documents.get(q1.id)?.includeActualPlan).toBeFalsy()
    expect(bars[1].querySelector<HTMLButtonElement>('button.plan-menu-trigger')?.getAttribute('aria-label')).toBe('Actual Plan')
    expect(bars[0].querySelector<HTMLButtonElement>('button.plan-menu-trigger')?.getAttribute('aria-label')).toBe('Plan')
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

describe('unified Plan menu & morphing Execute/Cancel', () => {
  it('toggles Actual Plan, Live Plan and Estimated Plan via the unified Plan menu with full keyboard accessibility', async () => {
    const { connections, documents, commands, mount } = fixture()
    connections.add(connectionInfo('prod'), connectionOptions)
    const doc = documents.create('plan.sql', 'SELECT 1', 'master', 'prod')
    const executeSpy = vi.spyOn(commands, 'execute')

    const { host } = await mount(createElement(QueryBar, { tabId: doc.id }))
    const trigger = () => host.querySelector<HTMLButtonElement>('button.plan-menu-trigger')!
    const menu = () => document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Execution Plan Options"]')

    expect(trigger().getAttribute('aria-label')).toBe('Plan')
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().hasAttribute('data-active')).toBe(false)
    expect(menu()).toBeNull()

    // Keyboard: ArrowDown opens the popover and focuses the first enabled menu item.
    await act(async () => { trigger().focus() })
    await act(async () => { trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    const openMenu = menu()!
    expect(openMenu).not.toBeNull()
    const items = [...openMenu.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')]
    expect(items.map(item => item.getAttribute('aria-label'))).toEqual(['Include Actual Plan', 'Include Live Plan', 'Display Estimated Plan'])
    expect(openMenu.querySelector('[role="separator"]')).not.toBeNull()
    expect(document.activeElement).toBe(items[0])

    // ArrowDown, End, Home navigate within the menu; Escape closes it and returns focus to the trigger.
    await act(async () => { items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.activeElement).toBe(items[1])
    await act(async () => { items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(document.activeElement).toBe(items[2])
    await act(async () => { items[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    expect(document.activeElement).toBe(items[0])
    await act(async () => { items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger())

    // Toggle Actual Plan on -> trigger reads "Actual Plan" with data-active and execution-plan-actual icon.
    await act(async () => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { menu()!.querySelector<HTMLButtonElement>('[aria-label="Include Actual Plan"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    expect(menu()).toBeNull()
    expect(trigger().getAttribute('aria-label')).toBe('Actual Plan')
    expect(trigger().hasAttribute('data-active')).toBe(true)
    expect(trigger().querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('execution-plan-actual')

    // Toggle Live Plan on too -> trigger reads "Actual + Live" with execution-plan-live icon.
    await act(async () => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    expect(menu()!.querySelector('[aria-label="Include Actual Plan"]')?.getAttribute('aria-checked')).toBe('true')
    await act(async () => { menu()!.querySelector<HTMLButtonElement>('[aria-label="Include Live Plan"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    expect(trigger().getAttribute('aria-label')).toBe('Actual + Live')
    expect(trigger().querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('execution-plan-live')

    // Toggle Actual Plan off -> trigger reads "Live Plan".
    await act(async () => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { menu()!.querySelector<HTMLButtonElement>('[aria-label="Include Actual Plan"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    expect(trigger().getAttribute('aria-label')).toBe('Live Plan')

    // Trigger Display Estimated Plan from the menu -> executes query.estimatePlan for this tab.
    await act(async () => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { menu()!.querySelector<HTMLButtonElement>('[aria-label="Display Estimated Plan"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    expect(executeSpy).toHaveBeenCalledWith('query.estimatePlan', expect.objectContaining({ tabId: doc.id }), 'toolbar')

    // Outside pointerdown dismisses the open popover.
    await act(async () => { trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    expect(menu()).not.toBeNull()
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(menu()).toBeNull()
  })

  it('keeps keyboard focus across Execute ↔ Cancel morph, ticks elapsed time per tab, and rescues focus when disabled', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const { api, connections, documents, queries, mount } = fixture()
      connections.add(connectionInfo('a'), connectionOptions)
      const q1 = documents.create('q1.sql', 'SELECT 1', 'master', 'a')
      const q2 = documents.create('q2.sql', 'SELECT 2', 'master', 'a')
      documents.activate(q1.id)

      let snapshot: Record<string, { running?: { queryId: string; connectionId: string; startedAt: number } }> = {}
      const listeners = new Set<() => void>()
      vi.spyOn(queries, 'getSnapshot').mockImplementation(() => snapshot as never)
      vi.spyOn(queries, 'isRunning').mockImplementation(id => !!snapshot[id]?.running)
      vi.spyOn(queries, 'subscribe').mockImplementation(listener => { listeners.add(listener); return () => listeners.delete(listener) })
      const publish = (next: typeof snapshot) => { snapshot = next; listeners.forEach(listener => listener()) }

      const { host } = await mount(createElement('div', null,
        createElement(QueryBar, { tabId: q1.id }),
        createElement(QueryBar, { tabId: q2.id })
      ))
      const bars = host.querySelectorAll<HTMLElement>('[data-query-bar]')
      const primary1 = bars[0].querySelector<HTMLButtonElement>('button.query-bar-action')!
      expect(primary1.getAttribute('aria-label')).toBe('Execute')
      expect(bars[0].querySelector('button[aria-label="Cancel"]')).toBeNull()

      // Focus Execute, then transition tab 1 into running -> same button morphs to Cancel and keeps focus.
      await act(async () => { primary1.focus() })
      expect(document.activeElement).toBe(primary1)
      await act(async () => { publish({ [q1.id]: { running: { queryId: 'run-1', connectionId: 'a', startedAt: 10_000 } } }) })
      expect(primary1.getAttribute('aria-label')).toBe('Cancel')
      expect(primary1.className).toContain('cancel')
      expect(primary1.disabled).toBe(false)
      expect(primary1.querySelector('.query-elapsed')?.textContent).toBe('0.0s')
      expect(document.activeElement).toBe(primary1)
      // Tab 2 stays idle and un-morphed.
      expect(bars[1].querySelector<HTMLButtonElement>('button.query-bar-action')?.getAttribute('aria-label')).toBe('Execute')
      expect(bars[1].querySelector('.query-elapsed')).toBeNull()

      // Advance timers by 1.4s -> tab 1's elapsed timer ticks cleanly.
      await act(async () => { vi.advanceTimersByTime(1400) })
      expect(primary1.querySelector('.query-elapsed')?.textContent).toBe('1.4s')

      // Transition back to idle -> morphs back to Execute, keeping focus seamlessly.
      await act(async () => { publish({}) })
      expect(primary1.getAttribute('aria-label')).toBe('Execute')
      expect(primary1.querySelector('.query-elapsed')).toBeNull()
      expect(document.activeElement).toBe(primary1)

      // Roving focus moves across Execute -> Plan -> Client Statistics -> Query server -> Query database.
      await act(async () => { primary1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
      expect(document.activeElement).toBe(bars[0].querySelector('button.plan-menu-trigger'))

      // When focused Execute turns disabled (e.g. backend restarting/lost), focus rescues to the nearest enabled control.
      await act(async () => { primary1.focus() })
      expect(document.activeElement).toBe(primary1)
      await act(async () => {
        // Lose the connection so Execute disables while Plan remains enabled.
        api.push({ status: 'restarting', generation: 1, retryInMs: 0, lost: { generation: 1, reason: 'crash', connections: 1, queries: 0 } })
      })
      expect(primary1.disabled).toBe(true)
      expect(document.activeElement).toBe(bars[0].querySelector('button.plan-menu-trigger'))
    } finally {
      vi.useRealTimers()
    }
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
