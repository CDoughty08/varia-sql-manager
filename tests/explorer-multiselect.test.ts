// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConnectionInfo, ConnectionOptions, ExplorerChildrenResult, ExplorerNode, ProviderConnectionOptions } from '../src/shared/contracts'
import type { Platform } from '../src/shared/commands/keybindings'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { focusFacts } from '../src/renderer/src/core/contextkeys'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import ExplorerPane from '../src/renderer/src/explorer/ExplorerPane'
import ExplorerTree from '../src/renderer/src/explorer/ExplorerTree'
import { PinnedServerRow } from '../src/renderer/src/explorer/ExplorerRow'
import { connectionInfo, connectionOptions, readyBackend, workbenchFixture } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  document.body.replaceChildren()
  vi.useRealTimers()
})

const bigQueryOptions = (project: string): ProviderConnectionOptions => ({
  provider: 'bigquery',
  project,
  authentication: 'gcloud'
})

const sqlInfo = (server: string, id = crypto.randomUUID(), generation = 1, database = 'master'): ConnectionInfo => ({
  ...connectionInfo(id, generation),
  server,
  database
})

const bqInfo = (project: string, id = crypto.randomUUID(), generation = 1, dataset = 'analytics'): ConnectionInfo => ({
  ...connectionInfo(id, generation),
  server: project,
  database: dataset,
  serverVersion: 'BigQuery'
})

function connectSql(workbench: ReturnType<typeof workbenchFixture>, server: string, opts: Partial<ConnectionOptions> = {}) {
  const options = { ...connectionOptions, server, ...opts } as ConnectionOptions
  const attempt = workbench.connections.beginConnect(options, 1)!
  const info = sqlInfo(server, crypto.randomUUID(), 1, 'AppData')
  const auth = { principal: { provider: 'sqlserver' as const, authentication: 'sql' as const, id: `sid:${server}` } }
  workbench.connections.accept(info, options, attempt.operation.targetId, auth, attempt)
  return { info, targetId: attempt.operation.targetId }
}

function connectBq(workbench: ReturnType<typeof workbenchFixture>, project: string) {
  const options = bigQueryOptions(project)
  const attempt = workbench.connections.beginConnect(options, 1)!
  const info = bqInfo(project)
  const auth = { principal: { provider: 'bigquery' as const, project, principal: `bigquery:${project}@example.com` } }
  const accepted = workbench.connections.accept(info, options, attempt.operation.targetId, auth, attempt)
  expect(accepted.status).toBe('accepted')
  return { info, targetId: attempt.operation.targetId }
}

function createExplorerHarness(platform: Platform = 'win32', childrenHandler?: (params: { node: unknown }) => ExplorerChildrenResult) {
  const workbench = workbenchFixture({ platform })
  workbench.api.push(readyBackend())
  if (childrenHandler) {
    workbench.api.explorerChildren.mockImplementation(async params => ({ ok: true as const, value: childrenHandler(params) }))
  } else {
    workbench.api.explorerChildren.mockImplementation(async () => ({ ok: true as const, value: { nodes: [], elapsedMs: 1, total: 0 } }))
  }
  const peekArmed = new SnapshotStore(false)
  let peekSnapshot: { readonly open?: { readonly node: unknown; readonly source: 'hover' | 'keyboard' | 'menu' } } = {}
  const peek = {
    armed: peekArmed,
    pointer: vi.fn(),
    cancelHover: vi.fn(),
    getSnapshot: () => peekSnapshot,
    subscribe: () => () => {},
    close: vi.fn(() => { peekSnapshot = {} }),
    setOpen: (source: 'hover' | 'keyboard' | 'menu' = 'keyboard') => { peekSnapshot = { open: { node: {}, source } } }
  }
  const explorerStatus = new SnapshotStore({ servers: new Map() })
  const agentTree = new SnapshotStore({})
  const searchDetails = new SnapshotStore({ hidden: true, size: 30 })
  const serverDrop = { start: vi.fn(), end: vi.fn() }
  const theme = { ...workbench.theme, getSnapshot: () => workbench.theme.state, subscribe: () => () => {}, accent: () => undefined }
  const renderer = { ...workbench, platform, explorerStatus, agentTree, peek, searchDetails, serverDrop, theme } as unknown as Workbench
  return { workbench, renderer, peek }
}

async function mountExplorerPane(harness: ReturnType<typeof createExplorerHarness>, props: { onNewMultiServerQuery?: () => void } = {}) {
  const host = document.body.appendChild(document.createElement('div'))
  host.style.height = '600px'
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(WorkbenchProvider, { workbench: harness.renderer, children: createElement(ExplorerPane, props) }))
  })
  // Give the virtualized tree a non-zero viewport in happy-dom and trigger a resize measure.
  const tree = host.querySelector<HTMLDivElement>('[data-explorer-tree]')
  if (tree) {
    Object.defineProperty(tree, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(tree, 'clientWidth', { configurable: true, value: 300 })
    await act(async () => { tree.dispatchEvent(new Event('scroll')) })
  }
  cleanups.push(() => { act(() => root.unmount()); harness.workbench.dispose() })
  return { host, root, tree: () => host.querySelector<HTMLDivElement>('[data-explorer-tree]')! }
}

const serverRowId = (workbench: ReturnType<typeof workbenchFixture>, label: string) =>
  workbench.explorer.settle().rows.nodes.find(node => node?.parent === 0 && node.label === label)!.id

describe('ExplorerService multi-select model', () => {
  it('enforces engine-homogeneity lock (SQL Server first, BigQuery first, removing index 0, incompatible notice)', () => {
    const { workbench } = createExplorerHarness()
    cleanups.push(() => workbench.dispose())
    connectSql(workbench, 'prod-sql-01', { environment: 'Production' } as Partial<ConnectionOptions>)
    connectSql(workbench, 'prod-sql-02')
    connectSql(workbench, 'stage-sql-03')
    connectBq(workbench, 'bq-analytics-01')
    connectBq(workbench, 'bq-warehouse-02')

    const sql1 = serverRowId(workbench, 'prod-sql-01')
    const sql2 = serverRowId(workbench, 'prod-sql-02')
    const sql3 = serverRowId(workbench, 'stage-sql-03')
    const bq1 = serverRowId(workbench, 'bq-analytics-01')
    const bq2 = serverRowId(workbench, 'bq-warehouse-02')

    // Plain select SQL1, then mod-toggle SQL2 -> [sql1, sql2] locked to SQL Server.
    workbench.explorer.select(sql1)
    const added2 = workbench.explorer.toggleMultiSelect(sql2)
    expect(added2).toEqual({ changed: true, multiSelected: [sql1, sql2] })
    expect(workbench.explorer.multiSelectProvider).toBe('sqlserver')

    // Adding SQL3 succeeds and preserves selection order in multiSelectedTargets().
    expect(workbench.explorer.toggleMultiSelect(sql3)).toEqual({ changed: true, multiSelected: [sql1, sql2, sql3] })
    expect(workbench.explorer.multiSelectedTargets().map(t => ({ rowId: t.rowId, label: t.label, provider: t.provider }))).toEqual([
      { rowId: sql1, label: 'prod-sql-01', provider: 'sqlserver' },
      { rowId: sql2, label: 'prod-sql-02', provider: 'sqlserver' },
      { rowId: sql3, label: 'stage-sql-03', provider: 'sqlserver' }
    ])

    // Removing index 0 while >= 2 remain keeps lock via new index 0 (sql2).
    expect(workbench.explorer.toggleMultiSelect(sql1)).toEqual({ changed: true, multiSelected: [sql2, sql3] })
    expect(workbench.explorer.multiSelectProvider).toBe('sqlserver')

    // Toggling incompatible BigQuery server does not add it and raises calm notice pointing to New Cross-Engine SELECT….
    const rejected = workbench.explorer.toggleMultiSelect(bq1)
    expect(rejected.changed).toBe(false)
    expect(rejected.multiSelected).toEqual([sql2, sql3])
    expect(rejected.notice).toContain('SQL Server')
    expect(rejected.notice).toContain('New Cross-Engine SELECT…')
    expect(workbench.explorer.getSnapshot().multiSelectNotice).toBe(rejected.notice)
    expect(workbench.explorer.getSnapshot().announcement?.immediate).toBe(true)

    // Plain select on BigQuery clears SQL selection; BigQuery first locks to BigQuery.
    workbench.explorer.select(bq1)
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])
    expect(workbench.explorer.getSnapshot().multiSelectNotice).toBeUndefined()

    expect(workbench.explorer.toggleMultiSelect(bq2)).toEqual({ changed: true, multiSelected: [bq1, bq2] })
    expect(workbench.explorer.multiSelectProvider).toBe('bigquery')

    const rejectedSql = workbench.explorer.toggleMultiSelect(sql1)
    expect(rejectedSql.changed).toBe(false)
    expect(rejectedSql.multiSelected).toEqual([bq1, bq2])
    expect(rejectedSql.notice).toContain('BigQuery')
    expect(rejectedSql.notice).toContain('New Cross-Engine SELECT…')

    // Plain primary click on already-focused member clears multiSelected.
    workbench.explorer.select(bq2)
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])
  })

  it('prunes disconnected, lost, removed, and backend-restarted servers and exits cleanly when < 2 remain', () => {
    const { workbench } = createExplorerHarness()
    cleanups.push(() => workbench.dispose())
    const s1 = connectSql(workbench, 'sql-01')
    const s2 = connectSql(workbench, 'sql-02')
    const s3 = connectSql(workbench, 'sql-03')
    const r1 = serverRowId(workbench, 'sql-01')
    const r2 = serverRowId(workbench, 'sql-02')
    const r3 = serverRowId(workbench, 'sql-03')

    workbench.explorer.select(r1)
    workbench.explorer.toggleMultiSelect(r2)
    workbench.explorer.toggleMultiSelect(r3)
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([r1, r2, r3])

    // Disconnect s1 (retained as lost row): r2 and r3 remain (>= 2), keeping lock.
    const op = workbench.connectionTargets.beginDisconnect(s1.targetId, crypto.randomUUID())!
    workbench.connectionTargets.completeDisconnect(op)
    workbench.explorer.settle()
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([r2, r3])
    expect(workbench.explorer.multiSelectProvider).toBe('sqlserver')

    // Lost server cannot be re-added to multiSelected.
    expect(workbench.explorer.toggleMultiSelect(r1).changed).toBe(false)
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([r2, r3])

    // Disconnecting and removing s2 drops remaining count to 1 -> multi-select exits cleanly.
    const op2 = workbench.connectionTargets.beginDisconnect(s2.targetId, crypto.randomUUID())!
    workbench.connectionTargets.completeDisconnect(op2)
    workbench.connections.remove(s2.info.id)
    workbench.explorer.settle()
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])

    // Removing a legacy unmanaged server directly also prunes and exits multi-select cleanly.
    const legacy = sqlInfo('sql-legacy')
    workbench.connect(legacy)
    const rLegacy = serverRowId(workbench, 'sql-legacy')
    workbench.explorer.select(r3)
    workbench.explorer.toggleMultiSelect(rLegacy)
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([r3, rLegacy])
    workbench.connections.remove(legacy.id)
    workbench.explorer.settle()
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])

    // Re-add another server and simulate backend restart (markLostBefore).
    const s4 = connectSql(workbench, 'sql-04')
    const r4 = serverRowId(workbench, 'sql-04')
    workbench.explorer.select(r3)
    workbench.explorer.toggleMultiSelect(r4)
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([r3, r4])
    expect(s3.info.id).not.toBe(s4.info.id)

    workbench.connections.markLostBefore(2)
    workbench.explorer.settle()
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])
  })

  it('populates multiSelected and sameEngineMultiple in menuNode() and supports selectAllServersByProvider', () => {
    const { workbench } = createExplorerHarness()
    cleanups.push(() => workbench.dispose())
    connectSql(workbench, 'sql-a')
    connectSql(workbench, 'sql-b')
    connectBq(workbench, 'bq-only')

    const sqlA = serverRowId(workbench, 'sql-a')
    const sqlB = serverRowId(workbench, 'sql-b')
    const bqOnly = serverRowId(workbench, 'bq-only')

    // Single-server menu: SQL has >= 2 connected servers (sameEngineMultiple: true), BQ has only 1.
    expect(workbench.explorer.menuNode(sqlA)).toMatchObject({ id: sqlA, sameEngineMultiple: true })
    expect(workbench.explorer.menuNode(sqlA)?.multiSelected).toBeUndefined()
    expect(workbench.explorer.menuNode(bqOnly)?.sameEngineMultiple).toBeUndefined()
    expect(workbench.explorer.menuNode(bqOnly)?.multiSelected).toBeUndefined()

    const singleSqlMenu = workbench.menus.resolve('explorer.context', { kind: 'explorer', node: workbench.explorer.menuNode(sqlA)! })
    expect(singleSqlMenu).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'command', id: 'explorer.selectAllSqlServers' }),
      expect.objectContaining({ kind: 'command', id: 'explorer.newCrossEngineQuery' }),
      expect.objectContaining({ kind: 'command', id: 'connection.disconnect' })
    ]))
    expect(singleSqlMenu.some(item => item.kind === 'command' && item.id === 'explorer.newMultiServerQuery')).toBe(false)

    // selectAllServersByProvider selects all connected SQL Servers, ignores single BigQuery.
    expect(workbench.explorer.selectAllServersByProvider('bigquery')).toEqual([])
    expect(workbench.explorer.selectAllServersByProvider('sqlserver')).toEqual([sqlA, sqlB])
    expect(workbench.explorer.menuNode(sqlA)).toMatchObject({ id: sqlA, multiSelected: true, sameEngineMultiple: true })
    expect(workbench.explorer.menuNode(sqlB)).toMatchObject({ id: sqlB, multiSelected: true, sameEngineMultiple: true })
    expect(workbench.explorer.menuNode(bqOnly)?.multiSelected).toBeUndefined()

    const multiSqlMenu = workbench.menus.resolve('explorer.context', { kind: 'explorer', node: workbench.explorer.menuNode(sqlA)! })
    expect(multiSqlMenu).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'command', id: 'explorer.newMultiServerQuery' }),
      expect.objectContaining({ kind: 'command', id: 'explorer.newCrossEngineQuery' }),
      expect.objectContaining({ kind: 'command', id: 'explorer.refreshSelected' }),
      expect.objectContaining({ kind: 'command', id: 'explorer.clearMultiSelect' }),
      expect.objectContaining({ kind: 'command', id: 'explorer.disconnectSelected' })
    ]))
    expect(multiSqlMenu.some(item => item.kind === 'command' && item.id === 'connection.disconnect')).toBe(false)
    expect(multiSqlMenu.some(item => item.kind === 'command' && item.id === 'explorer.newQuery')).toBe(false)
  })
})

describe('ExplorerPane & ExplorerTree multi-select pointer, keyboard, ARIA, and visuals', () => {
  it('handles mod+click, secondary-click preservation, no double-fire openPeekTab, non-server mod+click, and visuals', async () => {
    const tableWire: ExplorerNode = {
      ref: { type: 'object', object: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' } },
      label: 'dbo.Orders', icon: 'table', hasChildren: false
    }
    const harness = createExplorerHarness('win32', params => {
      const node = params.node as { type: string; object?: { kind: string } }
      if (node.type === 'object' && node.object?.kind === 'server') return { nodes: [tableWire], elapsedMs: 1, total: 1 }
      return { nodes: [], elapsedMs: 1, total: 0 }
    })
    const { workbench } = harness
    connectSql(workbench, 'sql-1')
    connectSql(workbench, 'sql-2')
    connectBq(workbench, 'bq-project-01')
    await act(async () => { await Promise.resolve() })
    workbench.explorer.settle()

    const executeSpy = vi.spyOn(workbench.commands, 'execute')
    const newMultiSpy = vi.fn()

    const { host, tree } = await mountExplorerPane(harness, { onNewMultiServerQuery: newMultiSpy })
    const sql1 = serverRowId(workbench, 'sql-1')
    const sql2 = serverRowId(workbench, 'sql-2')
    const bq1 = serverRowId(workbench, 'bq-project-01')
    const tableNode = workbench.explorer.settle().rows.nodes.find(node => node?.kind === 'table')!

    const rowEl = (id: number) => host.querySelector<HTMLDivElement>(`[data-row-id="${id}"]`)!

    // Tree has >= 2 servers -> aria-multiselectable="true" and data-server-focused on connected server.
    expect(tree().getAttribute('aria-multiselectable')).toBe('true')
    expect(tree().hasAttribute('data-server-focused')).toBe(true)
    expect(focusFacts(tree(), undefined).explorerServerFocus).toBe(true)

    // Ctrl+mousedown + click on sql-2 toggles multi-select and NEVER fires explorer.openPeekTab.
    await act(async () => {
      rowEl(sql2).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }))
      rowEl(sql2).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true, detail: 1 }))
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([sql1, sql2])
    expect(executeSpy).not.toHaveBeenCalledWith('explorer.openPeekTab', expect.anything(), expect.anything())

    // ARIA: aria-selected="true" on every member, aria-activedescendant on focused row.
    expect(rowEl(sql1).getAttribute('aria-selected')).toBe('true')
    expect(rowEl(sql2).getAttribute('aria-selected')).toBe('true')
    expect(rowEl(bq1).getAttribute('aria-selected')).toBe('false')
    expect(tree().getAttribute('aria-activedescendant')).toBe(`oe-${sql2}`)

    // Immediate live region announcement (0 ms delay, no timer advance needed).
    expect(host.querySelector('.explorer-tree-frame > [role="status"]')?.textContent).toContain('2 SQL Servers selected')

    // 26 px selection bar, checkboxes, incompatible dimming + SQL only pill.
    const bar = host.querySelector<HTMLDivElement>('.oe-multi-bar')!
    expect(bar).toBeTruthy()
    expect(bar.textContent).toContain('2 SQL Servers selected')
    expect(rowEl(sql1).querySelector('.oe-server-check')?.hasAttribute('data-checked')).toBe(true)
    expect(rowEl(bq1).classList.contains('dimmed')).toBe(true)
    expect(rowEl(bq1).classList.contains('engine-incompatible')).toBe(true)
    expect(rowEl(bq1).textContent).toContain('SQL only')

    // New Query button triggers multi-server query action.
    await act(async () => {
      bar.querySelector<HTMLButtonElement>('.oe-multi-bar-action')!.click()
    })
    expect(newMultiSpy).toHaveBeenCalledOnce()

    // Ctrl+Click incompatible BigQuery server does not add it and raises calm info toast.
    await act(async () => {
      rowEl(bq1).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }))
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([sql1, sql2])
    expect(workbench.notifications.getSnapshot().visible.some(t => t.severity === 'info' && t.message.includes('New Cross-Engine SELECT…'))).toBe(true)

    // Right-click on member already in multiSelected preserves multiSelected.
    await act(async () => {
      rowEl(sql1).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }))
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([sql1, sql2])

    // Right-click on server OUTSIDE multiSelected replaces selection with that server.
    await act(async () => {
      rowEl(bq1).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }))
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])
    expect(workbench.explorer.getSnapshot().selected).toBe(bq1)

    // Re-enter multi-select on [sql1, sql2], then mod+click a non-server row -> clears multiSelected and runs openPeekTab.
    await act(async () => {
      workbench.explorer.select(sql1)
      workbench.explorer.toggleMultiSelect(sql2)
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([sql1, sql2])
    await act(async () => {
      rowEl(tableNode.id).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }))
      rowEl(tableNode.id).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true, detail: 1 }))
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])
    expect(executeSpy).toHaveBeenCalledWith('explorer.openPeekTab', expect.objectContaining({ target: expect.objectContaining({ kind: 'explorer' }) }), 'toolbar')
    // Focus on non-server row clears data-server-focused (explorerServerFocus = false).
    expect(tree().hasAttribute('data-server-focused')).toBe(false)
    expect(focusFacts(tree(), undefined).explorerServerFocus).toBe(false)
  })

  it('handles Escape precedence (type-ahead -> Peek -> multiSelected) and returns focus to tree on Clear (×)', async () => {
    const harness = createExplorerHarness('win32')
    const { workbench, renderer, peek } = harness
    connectSql(workbench, 'alpha-sql')
    connectSql(workbench, 'beta-sql')
    workbench.explorer.settle()

    // Mount ExplorerTree directly for Escape precedence with mock Peek open state.
    const treeHost = document.body.appendChild(document.createElement('div'))
    const treeRoot = createRoot(treeHost)
    await act(async () => {
      treeRoot.render(createElement(WorkbenchProvider, { workbench: renderer, children: createElement(ExplorerTree) }))
    })
    const treeEl = treeHost.querySelector<HTMLDivElement>('[data-explorer-tree]')!
    Object.defineProperty(treeEl, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(treeEl, 'clientWidth', { configurable: true, value: 300 })
    await act(async () => { treeEl.dispatchEvent(new Event('scroll')) })

    const alpha = serverRowId(workbench, 'alpha-sql')
    const beta = serverRowId(workbench, 'beta-sql')

    await act(async () => {
      workbench.explorer.select(alpha)
      workbench.explorer.toggleMultiSelect(beta)
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([alpha, beta])

    // Start type-ahead AND open Peek card simultaneously.
    peek.setOpen('keyboard')
    await act(async () => {
      treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    })
    expect(treeEl.hasAttribute('data-type-ahead')).toBe(true)

    // Escape 1: clears type-ahead only (Peek stays open, multiSelected stays).
    await act(async () => {
      treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(treeEl.hasAttribute('data-type-ahead')).toBe(false)
    expect(peek.close).not.toHaveBeenCalled()
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([alpha, beta])

    // Escape 2: closes Peek card only (multiSelected stays).
    await act(async () => {
      treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(peek.close).toHaveBeenCalledTimes(1)
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([alpha, beta])

    // Escape 3: clears multiSelected back to focused row.
    const focusedBefore = workbench.explorer.getSnapshot().selected
    await act(async () => {
      treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])
    expect(workbench.explorer.getSnapshot().selected).toBe(focusedBefore)
    act(() => treeRoot.unmount())
    treeHost.remove()

    // Mount ExplorerPane and activate × button in the selection bar -> clears selection and focuses [data-explorer-tree].
    const { host, tree } = await mountExplorerPane(harness)
    await act(async () => {
      workbench.explorer.select(alpha)
      workbench.explorer.toggleMultiSelect(beta)
    })
    const clearBtn = host.querySelector<HTMLButtonElement>('.oe-multi-bar-clear')!
    expect(clearBtn).toBeTruthy()
    await act(async () => {
      clearBtn.focus()
      clearBtn.click()
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])
    expect(document.activeElement).toBe(tree())
  })

  it('forwards mod+click and macOS grid.secondaryClick on PinnedServerRow without jumping or clearing multiSelected', async () => {
    const harness = createExplorerHarness('darwin')
    const { workbench, renderer } = harness
    connectSql(workbench, 'mac-sql-1')
    connectSql(workbench, 'mac-sql-2')
    connectSql(workbench, 'mac-sql-3')
    workbench.explorer.settle()

    const r1 = serverRowId(workbench, 'mac-sql-1')
    const r2 = serverRowId(workbench, 'mac-sql-2')
    const r3 = serverRowId(workbench, 'mac-sql-3')
    const node2 = workbench.explorer.node(r2)!
    const node3 = workbench.explorer.node(r3)!
    workbench.explorer.select(r1)

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const jump2 = vi.fn(), jump3 = vi.fn()
    await act(async () => {
      root.render(createElement(WorkbenchProvider, {
        workbench: renderer,
        children: createElement('div', null,
          createElement(PinnedServerRow, { node: node2, edge: 'top', current: false, active: false, color: undefined, menu: false, jump: jump2 }),
          createElement(PinnedServerRow, { node: node3, edge: 'top', current: false, active: false, color: undefined, menu: false, jump: jump3 })
        )
      }))
    })
    cleanups.push(() => { act(() => root.unmount()); workbench.dispose() })
    const [btn2, btn3] = host.querySelectorAll<HTMLButtonElement>('button')

    // macOS ⌘+Click toggles node2 into multiSelected without calling jump().
    await act(async () => {
      btn2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: true }))
      btn2.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, metaKey: true }))
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([r1, r2])
    expect(jump2).not.toHaveBeenCalled()

    // macOS Control+Click (grid.secondaryClick) on a member ALREADY in multiSelected preserves multiSelected.
    await act(async () => {
      btn2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }))
      btn2.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }))
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([r1, r2])
    expect(jump2).not.toHaveBeenCalled()

    // macOS Control+Click on a pinned server OUTSIDE multiSelected replaces selection with that server.
    await act(async () => {
      btn3.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }))
      btn3.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }))
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([])
    expect(workbench.explorer.getSnapshot().selected).toBe(r3)
    expect(jump3).not.toHaveBeenCalled()
  })

  it('omits aria-multiselectable with one server, preserves multi-select across keyboard arrows, and shows BigQuery labels + BQ only pill', async () => {
    const harness = createExplorerHarness('win32')
    const { workbench } = harness
    connectBq(workbench, 'bq-alpha-01')
    workbench.explorer.settle()

    const { host, tree } = await mountExplorerPane(harness)
    // Only 1 server -> aria-multiselectable is absent.
    expect(tree().getAttribute('aria-multiselectable')).toBeNull()

    // Connect second BigQuery project and a SQL Server -> aria-multiselectable="true".
    await act(async () => {
      connectBq(workbench, 'bq-beta-02')
      connectSql(workbench, 'sql-other-01')
      workbench.explorer.settle()
    })
    expect(tree().getAttribute('aria-multiselectable')).toBe('true')

    const bq1 = serverRowId(workbench, 'bq-alpha-01')
    const bq2 = serverRowId(workbench, 'bq-beta-02')
    const sql1 = serverRowId(workbench, 'sql-other-01')

    // Collapse bq1 so ArrowDown lands directly on bq2, and verify keyboard multi-select flow.
    await act(async () => {
      workbench.explorer.collapse(bq1)
      workbench.explorer.settle()
      workbench.explorer.select(bq1)
      workbench.explorer.toggleMultiSelect()
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([bq1])
    await act(async () => {
      tree().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(workbench.explorer.getSnapshot().selected).toBe(bq2)
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([bq1])
    await act(async () => {
      workbench.explorer.toggleMultiSelect()
    })
    expect(workbench.explorer.getSnapshot().multiSelected).toEqual([bq1, bq2])

    // BigQuery selection bar label and BQ only pill on incompatible SQL Server row.
    expect(host.querySelector('.oe-multi-bar')?.textContent).toContain('2 BigQuery Projects selected')
    const sqlRow = host.querySelector<HTMLDivElement>(`[data-row-id="${sql1}"]`)!
    expect(sqlRow.classList.contains('dimmed')).toBe(true)
    expect(sqlRow.textContent).toContain('BQ only')
  })
})
