// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BigQueryProperties } from '../src/shared/bigquery/objects'
import type { ApiResult } from '../src/shared/contracts'
import type { PeekResult } from '../src/shared/explorer/peek'
import type { ScriptingOptions } from '../src/shared/scripting/options'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import { BigQueryPropertiesService } from '../src/renderer/src/explorer/BigQueryPropertiesService'
import {
  constraintExpressionText, parseSchemaQualified, peekConstraintModel, peekCrumbs, peekFactLink, peekFkRelationModel,
  peekHeroKpis, peekKeySummaryModel, peekOverviewModel, peekParentTarget, peekRatioMeter, peekStatePills,
  peekStorageModel, peekTabCount, peekUsageModel, peekVitalsModel
} from '../src/renderer/src/explorer/peek-inspector'
import PeekCard, { cardStops, PeekBody, propertiesMenu } from '../src/renderer/src/explorer/PeekCard'
import { PeekService, type OpenPeek } from '../src/renderer/src/explorer/PeekService'
import PeekTabView from '../src/renderer/src/explorer/PeekTab'
import { PeekTabService } from '../src/renderer/src/explorer/PeekTabService'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/renderer/src/explorer/PeekListGrid', () => ({
  PeekListGrid: ({ id, preset, fill }: { id: string; preset: string; fill?: boolean }) =>
    createElement('div', { 'data-peek-list': id, 'data-preset': preset, ...(fill ? { 'data-fill': 'true' } : {}) })
}))

let root: Root | undefined, host: HTMLElement | undefined
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  host?.remove()
  host = undefined
  document.body.replaceChildren()
  getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root!.render(element) })
  return host
}

const connectionId = '11111111-1111-4111-8111-111111111111'
const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })

function makeOpen(kind: OpenPeek['kind'], overrides: Partial<OpenPeek> = {}): OpenPeek {
  const ref = kind === 'login'
    ? { type: 'object' as const, object: { kind, name: 'sa' } }
    : kind === 'database'
      ? { type: 'object' as const, object: { kind, name: 'Sales' } }
      : kind === 'index' || kind === 'key' || kind === 'constraint' || kind === 'trigger'
        ? { type: 'object' as const, object: { kind, database: 'Sales', parent: { kind: 'table' as const, schema: 'dbo', name: 'Orders' }, name: 'Obj1' } }
        : { type: 'object' as const, object: { kind, database: 'Sales', schema: 'dbo', name: 'Orders' } }
  return {
    id: 1,
    rowId: 1,
    kind,
    source: 'keyboard',
    tab: 'overview',
    back: [],
    facts: { status: 'ready', value: {} },
    definition: { status: 'ready', value: { text: 'CREATE TABLE [dbo].[Orders] (Id int)' } },
    node: { id: 1, connectionId, kind, label: 'dbo.Orders', lost: false, ref },
    ...overrides
  }
}

describe('peek-inspector pure data builders', () => {
  it('parses unambiguous schema.name strings and refuses embedded dots or oversized names', () => {
    expect(parseSchemaQualified('dbo.Customers')).toEqual({ schema: 'dbo', name: 'Customers' })
    expect(parseSchemaQualified('Sales.OrderLines')).toEqual({ schema: 'Sales', name: 'OrderLines' })
    expect(parseSchemaQualified('a.b.c')).toBeUndefined()
    expect(parseSchemaQualified('.Orders')).toBeUndefined()
    expect(parseSchemaQualified('dbo.')).toBeUndefined()
    expect(parseSchemaQualified('Orders')).toBeUndefined()
    expect(parseSchemaQualified(`${'s'.repeat(129)}.Orders`)).toBeUndefined()
  })

  it('builds parent, referenced table, and login default database cross-object links', () => {
    const fk = makeOpen('key', { facts: { status: 'ready', value: { parentTable: 'dbo.Orders', referencedTable: 'Sales.Customers' } } })
    expect(peekParentTarget(fk)?.target).toEqual({ kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' })
    expect(peekFactLink(fk, 'parentTable', 'dbo.Orders')?.target).toEqual({ kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' })
    expect(peekFactLink(fk, 'referencedTable', 'Sales.Customers')?.target).toEqual({ kind: 'table', database: 'Sales', schema: 'Sales', name: 'Customers' })
    // Embedded dot in referencedTable gracefully declines linking instead of mis-splitting.
    expect(peekFactLink(fk, 'referencedTable', 'dbo.a.b')).toBeUndefined()
    const login = makeOpen('login')
    expect(peekFactLink(login, 'defaultDatabase', 'AppData')?.target).toEqual({ kind: 'database', name: 'AppData' })
    expect(peekFactLink(login, 'defaultDatabase', null)).toBeUndefined()
  })

  it('builds Data vs. Index RatioBar for tables, Seeks/Scans vs. Updates for indexes, and Data vs. Log for databases', () => {
    const table = makeOpen('table', {
      facts: { status: 'ready', value: { rowCount: 12_345, dataSpace: 2048, indexSpace: 512, filegroup: 'PRIMARY', partitioned: true, temporal: 'SYSTEM_VERSIONED_TEMPORAL_TABLE' } },
      lists: { columns: { rows: [['Id', 'int', false, 'PK', null, null, null, '[Id] int']] }, tableObjects: { rows: [['Primary key', 'PK', 'Id', 'Active']] } }
    })
    const tableMeter = peekRatioMeter(table)
    expect(tableMeter).toMatchObject({ title: 'Space allocation', totalLabel: '2.50 MB' })
    expect(tableMeter?.segments.map(s => [s.label, s.value, s.displayValue])).toEqual([['Data', 2048, '2.00 MB'], ['Index', 512, '512 KB']])
    expect(peekStatePills(table).map(p => p.label)).toEqual(['System-versioned', 'Partitioned'])
    expect(peekHeroKpis(table).map(k => [k.id, k.value])).toEqual([
      ['rows', '12,345'], ['space', '2.50 MB'], ['columns', '1'], ['indexes', '1'], ['filegroup', 'PRIMARY']
    ])

    const index = makeOpen('index', {
      facts: { status: 'ready', value: { indexType: 'Nonclustered', userSeeks: 900, userScans: 60, userLookups: 0, userUpdates: 40, space: 4096, rowCount: 5000, fillFactor: 90, filter: '([Active] = 1)' } }
    })
    const indexMeter = peekRatioMeter(index)
    expect(indexMeter).toMatchObject({ title: 'Usage since server start', totalLabel: '1,000 ops · 96% reads' })
    expect(indexMeter?.segments.map(s => [s.label, s.value])).toEqual([['Seeks', 900], ['Scans', 60], ['Updates', 40]])
    expect(peekStatePills(index).map(p => p.label)).toEqual(['Healthy · 96% reads', 'Filtered'])
    expect(peekUsageModel(index).meter).toEqual(indexMeter)

    // Refused index usage omits the meter and reports the refusal message.
    const refusedIndex = makeOpen('index', { facts: { status: 'ready', value: { indexType: 'Clustered' } }, refused: ['usage'] })
    expect(peekRatioMeter(refusedIndex)).toBeUndefined()
    expect(peekUsageModel(refusedIndex).refused).toContain('VIEW SERVER STATE')

    const db = makeOpen('database', { facts: { status: 'ready', value: { status: 'ONLINE', size: 10240, dataSize: 8192, logSize: 2048 } } })
    expect(peekRatioMeter(db)).toMatchObject({ title: 'File allocation', totalLabel: '10.00 MB' })
    expect(peekCrumbs(index, 'prod-01')).toEqual([{ label: 'prod-01' }, { label: 'Sales' }, { label: 'dbo.Orders' }])
  })

  it('separates identity facts and signal-first capabilities in Overview, and builds Vitals and tab counts', () => {
    const follow = vi.fn()
    const index = makeOpen('index', {
      facts: {
        status: 'ready',
        value: {
          indexType: 'Nonclustered', unique: true, primaryKey: false, uniqueConstraint: false, disabled: false,
          fillFactor: 90, padIndex: true, allowRowLocks: true, allowPageLocks: false, space: 1024
        }
      },
      lists: { indexColumns: { rows: [['Id', false, false, 'int']], truncated: true } }
    })
    const overview = peekOverviewModel(index, follow)
    expect(overview.sections.map(s => s.id)).toEqual(['general', 'options', 'storage'])
    // Synthetic parent table link is prepended to General on child objects lacking a parentTable fact.
    const parentRow = overview.sections[0]!.facts[0]!
    expect(parentRow.label).toBe('Parent table')
    expect(parentRow.value).toBe('dbo.Orders')
    parentRow.onLink?.()
    expect(follow).toHaveBeenCalledWith({ kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' }, 'dbo.Orders')
    // Unique=true, Pad index=true, Allow page locks=false (off-default) are notable; Allow row locks=true (default) is not.
    const notable = overview.capabilities.filter(c => c.notable).map(c => c.id)
    expect(notable).toEqual(['unique', 'padIndex', 'allowPageLocks'])
    expect(overview.capabilities.find(c => c.id === 'allowRowLocks')?.notable).toBe(false)

    const vitals = peekVitalsModel(index, follow)
    expect(vitals.facts.some(f => f.label === 'Parent table')).toBe(true)
    expect(vitals.notableFlags.map(c => c.id)).toEqual(['unique', 'padIndex', 'allowPageLocks'])
    expect(peekTabCount(index, 'indexColumns')).toBe('1+')
    expect(peekStorageModel(makeOpen('table', { facts: { status: 'ready', value: { rowCount: 10, dataSpace: 16, indexSpace: 8 } } })).facts.map(f => f.id))
      .toEqual(['rowCount', 'dataSpace', 'indexSpace'])
  })
})

describe('PeekService.followObject and Back stack', () => {
  it('navigates in-place to a cross-object target, promotes hover to keyboard, and returns via Back', () => {
    const api = {
      explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(() => {})),
      explorerPeekDependencies: vi.fn(() => new Promise<never>(() => {})),
      explorerCancel: vi.fn(async () => ok({ cancelled: 1 })),
      scriptObjects: vi.fn(() => new Promise<never>(() => {})),
      cancelScripting: vi.fn(async () => ok({ cancelled: 1 })),
      writeClipboardText: vi.fn(async () => ok(undefined))
    }
    const service = new PeekService({
      api: api as never,
      connections: { getSnapshot: () => [{ id: connectionId }], subscribe: () => () => {} },
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
      newId: () => 'req'
    })
    const keyNode: ExplorerMenuNode = {
      id: 9, connectionId, kind: 'key', label: 'FK_Orders_Customers', lost: false,
      ref: { type: 'object', object: { kind: 'key', database: 'Sales', parent: { kind: 'table', schema: 'dbo', name: 'Orders' }, name: 'FK_Orders_Customers' } }
    }
    service.peek(keyNode, 'hover')
    service.followObject({ kind: 'table', database: 'Sales', schema: 'dbo', name: 'Customers' }, 'dbo.Customers')
    expect(service.getSnapshot().open).toMatchObject({
      kind: 'table',
      source: 'keyboard',
      tab: 'overview',
      rowId: 9,
      back: [{ kind: 'key', tab: 'overview' }]
    })
    expect(api.explorerPeek).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Customers' }
    }))
    // Invalid targets violating scopeFields (missing schema, missing database, missing/mismatched child parent) are ignored.
    const calls = api.explorerPeek.mock.calls.length
    service.followObject({ kind: 'table', database: 'Sales', name: 'MissingSchema' })
    service.followObject({ kind: 'table', schema: 'dbo', name: 'MissingDatabase' })
    service.followObject({ kind: 'databaseTrigger', name: 'MissingDatabase' })
    service.followObject({ kind: 'index', database: 'Sales', name: 'MissingParent' })
    service.followObject({ kind: 'index', database: 'Sales', parent: { kind: 'procedure' as never, schema: 'dbo', name: 'P' }, name: 'WrongParentKind' })
    service.followObject({ kind: 'database', name: '' })
    expect(api.explorerPeek).toHaveBeenCalledTimes(calls)
    // Back restores the original key and tab.
    service.goBack()
    expect(service.getSnapshot().open).toMatchObject({ kind: 'key', tab: 'overview', back: [] })
    service.dispose()
  })
})

describe('Unified PeekCard and PeekTab rendering on ObjectInspectorFrame', () => {
  function setupWorkbench(facts: PeekResult['facts'], lists?: PeekResult['lists']) {
    const fixture = workbenchFixture({ platform: 'win32', activeElement: () => document.activeElement })
    let resolvePeek: (result: ApiResult<PeekResult>) => void = () => {}
    const api = {
      explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(resolve => { resolvePeek = resolve })),
      explorerPeekDependencies: vi.fn(() => new Promise<never>(() => {})),
      explorerPeekDefinition: vi.fn(() => new Promise<never>(() => {})),
      explorerCancel: vi.fn(async () => ok({ cancelled: 1 })),
      scriptObjects: vi.fn(() => new Promise<never>(() => {})),
      cancelScripting: vi.fn(async () => ok({ cancelled: 1 })),
      writeClipboardText: vi.fn(async () => ok(undefined)),
      tableColumns: vi.fn(() => new Promise<never>(() => {})),
      execute: vi.fn(() => new Promise<never>(() => {})),
      closeQuerySession: vi.fn(async () => ok({ closed: true }))
    }
    const connectionList = [{ id: connectionId, server: 'prod-sql-01', displayName: 'Prod SQL' }]
    const connectionsStore = {
      getSnapshot: () => connectionList,
      get: (id: string) => id === connectionId ? connectionList[0] : undefined,
      subscribe: () => () => {}
    }
    const peek = new PeekService({
      api: api as never,
      connections: connectionsStore,
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
      newId: () => 'id'
    })
    const peekTabs = new PeekTabService({
      peek,
      documents: fixture.documents,
      targetIdOf: () => 'target-1',
      connections: connectionsStore
    })
    const workbench = Object.assign(fixture, {
      peek,
      peekTabs,
      connections: connectionsStore,
      menus: { registerTarget: () => ({ dispose: () => {} }) }
    }) as unknown as Workbench
    return {
      workbench,
      fixture,
      peek,
      peekTabs,
      api,
      finishPeek: () => resolvePeek(ok({ facts, ...(lists ? { lists } : {}), elapsedMs: 1 }))
    }
  }

  it('renders PeekCard with surface="peek", [data-peek-card], persistent 1-9 badges, immediate Ctrl+1..9 switching, no Hero KPIs, and separate peek Vitals state', async () => {
    const { workbench, fixture, peek, api, finishPeek } = setupWorkbench(
      { schema: 'dbo', created: '2024-01-02T03:04:05', rowCount: 12_345, dataSpace: 2048, indexSpace: 512, filegroup: 'PRIMARY', memoryOptimized: true, replicated: false },
      { columns: { rows: [['Id', 'int', false, 'PK', null, null, null, '[Id] int']] }, tableObjects: { rows: [['Primary key', 'PK_Orders', 'Clustered (Id)', 'Active']] } }
    )
    try {
      const tableNode: ExplorerMenuNode = {
        id: 1, connectionId, kind: 'table', label: 'Orders', lost: false,
        ref: { type: 'object', object: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' } }
      }
      peek.peek(tableNode, 'keyboard')
      finishPeek()
      await Promise.resolve()

      mount(createElement(WorkbenchProvider, { workbench, children: createElement(PeekCard) }))
      const dialog = document.body.querySelector<HTMLElement>('[data-peek-card]')!
      expect(dialog).not.toBeNull()
      expect(dialog.getAttribute('role')).toBe('dialog')
      expect(dialog.getAttribute('aria-label')).toBe('Peek: dbo.Orders')
      expect(dialog.getAttribute('data-inspector-surface')).toBe('peek')
      expect(dialog.hasAttribute('data-object-inspector')).toBe(true)
      expect(dialog.hasAttribute('data-mod-held')).toBe(true)
      // Peek Card omits Hero KPI strip.
      expect(dialog.querySelector('.inspector-kpi-strip')).toBeNull()
      // Canonical tab order on table.
      const tabs = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      expect(tabs.map(t => t.dataset.inspectorTab)).toEqual(['overview', 'definition', 'storage', 'columns', 'tableObjects', 'dependencies', 'rows'])
      // Focus landed on the card root itself; Ctrl+3 immediately jumps to Storage & Layout!
      expect(document.activeElement).toBe(dialog)
      await act(async () => {
        fixture.keybindings.handleKeyDown(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, cancelable: true }))
        await Promise.resolve()
      })
      expect(peek.getSnapshot().open?.tab).toBe('storage')
      expect(dialog.querySelector('.ratio-bar')).not.toBeNull()
      expect(dialog.querySelector('.inspector-pane-flow')).not.toBeNull()
      // Ctrl+4 jumps to Columns in full-bleed fill pane.
      await act(async () => {
        fixture.keybindings.handleKeyDown(new KeyboardEvent('keydown', { key: '4', ctrlKey: true, cancelable: true }))
        await Promise.resolve()
      })
      expect(peek.getSnapshot().open?.tab).toBe('columns')
      expect(dialog.querySelector('.inspector-pane-fill')).not.toBeNull()
      expect(dialog.querySelector('[data-peek-list="columns"]')?.getAttribute('data-fill')).toBe('true')
      // Arrowing across tabs never triggers lazy Dependencies or Top rows.
      const colsTab = dialog.querySelector<HTMLButtonElement>('[data-inspector-tab="columns"]')!
      act(() => { colsTab.focus() })
      act(() => { colsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
      act(() => { dialog.querySelector<HTMLButtonElement>('[data-inspector-tab="tableObjects"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
      expect(document.activeElement).toBe(dialog.querySelector('[data-inspector-tab="dependencies"]'))
      expect(api.explorerPeekDependencies).not.toHaveBeenCalled()
      expect(api.execute).not.toHaveBeenCalled()
      // Vitals rail renders flat RatioBar and persists independently under `peek` surface.
      expect(dialog.querySelector('.inspector-vitals-rail .ratio-bar.flat')).not.toBeNull()
      act(() => { fixture.inspector.setVitals('peek', { width: 260 }) })
      expect(fixture.inspector.vitals.getSnapshot().peek.width).toBe(260)
      expect(fixture.inspector.vitals.getSnapshot().full.width).toBe(272)
      // Back button is hidden when history is empty; Close verb closes the card.
      expect(dialog.querySelector('[aria-label="Back"]')).toBeNull()
      const closeBtn = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Close')!
      expect(closeBtn).toBeDefined()
      act(() => { closeBtn.click() })
      expect(peek.getSnapshot().open).toBeUndefined()
    } finally {
      peek.dispose()
      fixture.dispose()
    }
  })

  it('renders PeekTab with surface="full", [data-peek-tab], Hero KPI strip, breadcrumbs, and propertiesMenu support on FactGrid rows', async () => {
    const { workbench, fixture, peek, peekTabs, finishPeek } = setupWorkbench(
      { schema: 'dbo', created: '2024-01-02T03:04:05', rowCount: 12_345, dataSpace: 2048, indexSpace: 512, filegroup: 'PRIMARY' },
      { columns: { rows: [['Id', 'int', false, 'PK', null, null, null, '[Id] int']] } }
    )
    try {
      const tableNode: ExplorerMenuNode = {
        id: 2, connectionId, kind: 'table', label: 'Orders', lost: false,
        ref: { type: 'object', object: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' } }
      }
      const docId = peekTabs.open(tableNode)!
      const el = mount(createElement(WorkbenchProvider, { workbench, children: createElement(PeekTabView, { documentId: docId }) }))
      await act(async () => {
        finishPeek()
        await new Promise(resolve => setImmediate(resolve))
      })
      const frame = el.querySelector<HTMLElement>('[data-peek-tab]')!
      expect(frame).not.toBeNull()
      expect(frame.getAttribute('data-inspector-surface')).toBe('full')
      expect(frame.getAttribute('data-peek-tab')).toBe(docId)
      expect(frame.hasAttribute('data-object-inspector')).toBe(true)
      // Full surface renders Hero KPI strip with inline mini RatioBar and breadcrumbs.
      expect(frame.querySelector('.inspector-kpi-strip')).not.toBeNull()
      expect(frame.querySelector('.inspector-kpi-strip .ratio-bar-mini')).not.toBeNull()
      expect(frame.querySelector('nav[aria-label="Location"]')?.textContent).toContain('Prod SQL')
      expect(frame.querySelector('nav[aria-label="Location"]')?.textContent).toContain('Sales')
      // Overview FactGrid rows are supported by propertiesMenu Copy without including copy button text.
      const propsPane = frame.querySelector<HTMLElement>('.peek-properties-pane')!
      expect(propertiesMenu(false).target(propsPane)?.text).toBe('Schema\tdbo\nCreated\t2024-01-02 03:04')
    } finally {
      act(() => { root?.unmount() })
      root = undefined
      peekTabs.dispose()
      peek.dispose()
      fixture.dispose()
    }
  })

  it('navigates in-place from a foreign key Overview link and shows Back', async () => {
    const fixture = workbenchFixture({ platform: 'win32' })
    const api = {
      explorerPeek: vi.fn(() => Promise.resolve(ok({
        facts: { keyType: 'FOREIGN_KEY_CONSTRAINT', parentTable: 'dbo.Orders', referencedTable: 'dbo.Customers', disabled: false, notTrusted: false },
        elapsedMs: 1
      }))),
      explorerCancel: vi.fn(async () => ok({ cancelled: 0 })),
      scriptObjects: vi.fn(() => new Promise<never>(() => {})),
      cancelScripting: vi.fn(async () => ok({ cancelled: 0 })),
      writeClipboardText: vi.fn(async () => ok(undefined))
    }
    const peek = new PeekService({
      api: api as never,
      connections: { getSnapshot: () => [{ id: connectionId }], subscribe: () => () => {} },
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
      newId: () => 'id'
    })
    const workbench = Object.assign(fixture, { peek, menus: { registerTarget: () => ({ dispose: () => {} }) } }) as unknown as Workbench
    try {
      const fkNode: ExplorerMenuNode = {
        id: 3, connectionId, kind: 'key', label: 'FK_Orders_Customers', lost: false,
        ref: { type: 'object', object: { kind: 'key', database: 'Sales', parent: { kind: 'table', schema: 'dbo', name: 'Orders' }, name: 'FK_Orders_Customers' } }
      }
      peek.peek(fkNode, 'keyboard')
      await Promise.resolve()
      await Promise.resolve()
      const el = mount(createElement(WorkbenchProvider, {
        workbench,
        children: createElement(PeekBody, { view: peek, open: peek.getSnapshot().open!, idPrefix: 'fk' })
      }))
      const link = el.querySelector<HTMLButtonElement>('[aria-label="Peek dbo.Customers"]')!
      expect(link).not.toBeNull()
      act(() => { link.click() })
      expect(peek.getSnapshot().open).toMatchObject({ kind: 'table', node: { label: 'dbo.Customers' }, back: [{ kind: 'key', tab: 'overview' }] })
    } finally {
      peek.dispose()
      fixture.dispose()
    }
  })

  it('rescues keyboard focus inside PeekTab across Overview followObject and Back, and omits links when disconnected', async () => {
    const fixture = workbenchFixture({ platform: 'win32', activeElement: () => document.activeElement })
    let connected = true
    const listeners = new Set<() => void>()
    const connectionList = [{ id: connectionId, server: 'prod-sql-01', displayName: 'Prod SQL' }]
    const emptyList: typeof connectionList = []
    const connectionsStore = {
      getSnapshot: () => connected ? connectionList : emptyList,
      get: (id: string) => connected && id === connectionId ? connectionList[0] : undefined,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    }
    let failNext = false
    const api = {
      explorerPeek: vi.fn(() => failNext
        ? Promise.resolve({ ok: false as const, error: 'Could not read object' })
        : Promise.resolve(ok({
            facts: { keyType: 'FOREIGN_KEY_CONSTRAINT', parentTable: 'dbo.Orders', referencedTable: 'dbo.Customers', disabled: false, notTrusted: false },
            elapsedMs: 1
          }))),
      explorerCancel: vi.fn(async () => ok({ cancelled: 0 })),
      scriptObjects: vi.fn(() => new Promise<never>(() => {})),
      cancelScripting: vi.fn(async () => ok({ cancelled: 0 })),
      writeClipboardText: vi.fn(async () => ok(undefined))
    }
    const peek = new PeekService({
      api: api as never,
      connections: connectionsStore,
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
      newId: () => 'id'
    })
    const peekTabs = new PeekTabService({
      peek,
      documents: fixture.documents,
      targetIdOf: () => 'target-1',
      connections: connectionsStore
    })
    const workbench = Object.assign(fixture, {
      peek,
      peekTabs,
      connections: connectionsStore,
      menus: { registerTarget: () => ({ dispose: () => {} }) }
    }) as unknown as Workbench

    try {
      const fkNode: ExplorerMenuNode = {
        id: 4, connectionId, kind: 'key', label: 'FK_Orders_Customers', lost: false,
        ref: { type: 'object', object: { kind: 'key', database: 'Sales', parent: { kind: 'table', schema: 'dbo', name: 'Orders' }, name: 'FK_Orders_Customers' } }
      }
      const docId = peekTabs.open(fkNode)!
      const el = mount(createElement(WorkbenchProvider, { workbench, children: createElement(PeekTabView, { documentId: docId }) }))
      // While loading, only the active pane renders role="status" (Vitals rail does not duplicate it).
      expect(el.querySelectorAll('[role="status"]')).toHaveLength(1)
      await act(async () => { await new Promise(resolve => setImmediate(resolve)) })

      const frame = el.querySelector<HTMLElement>('[data-peek-tab]')!
      const link = frame.querySelector<HTMLButtonElement>('[aria-label="Peek dbo.Customers"]')!
      expect(link).not.toBeNull()
      // Focus the cross-object link and activate it: Overview -> Overview replaces the keyed pane and unmounts the link.
      act(() => { link.focus() })
      expect(document.activeElement).toBe(link)
      await act(async () => {
        link.click()
        await new Promise(resolve => setImmediate(resolve))
      })
      // Focus must stay inside the PeekTab on the active tab so Ctrl+1..9 and Back shortcuts keep working.
      expect(frame.contains(document.activeElement)).toBe(true)
      expect(document.activeElement).toBe(frame.querySelector('[role="tab"][aria-selected="true"]'))

      // Clicking Back unmounts the Back button when returning to depth 0; focus is rescued back inside the frame.
      const backBtn = frame.querySelector<HTMLButtonElement>('[aria-label="Back"]')!
      expect(backBtn).not.toBeNull()
      act(() => { backBtn.focus() })
      await act(async () => {
        backBtn.click()
        await new Promise(resolve => setImmediate(resolve))
      })
      expect(frame.querySelector('[aria-label="Back"]')).toBeNull()
      expect(frame.contains(document.activeElement)).toBe(true)

      // Error state also emits only a single role="alert" (Vitals rail does not duplicate it).
      failNext = true
      await act(async () => {
        peekTabs.getSnapshot().views[docId]?.refresh()
        await new Promise(resolve => setImmediate(resolve))
      })
      expect(frame.querySelectorAll('[role="alert"]')).toHaveLength(1)

      // Reload cleanly, then disconnect: cross-object links degrade to plain values with zero .fact-grid-link buttons.
      failNext = false
      await act(async () => {
        peekTabs.getSnapshot().views[docId]?.refresh()
        await new Promise(resolve => setImmediate(resolve))
      })
      expect(frame.querySelectorAll('.fact-grid-link').length).toBeGreaterThan(0)
      act(() => {
        connected = false
        for (const listener of listeners) listener()
      })
      expect(frame.querySelectorAll('.fact-grid-link')).toHaveLength(0)
    } finally {
      act(() => { root?.unmount() })
      root = undefined
      peekTabs.dispose()
      peek.dispose()
      fixture.dispose()
    }
  })

  it('renders Foreign Key relationship diagram, PK/UQ key summary, and Constraint expression + Definition fallback', async () => {
    const fk = makeOpen('key', {
      facts: {
        status: 'ready',
        value: {
          keyType: 'Foreign key', parentTable: 'dbo.Orders', referencedTable: 'Sales.Customers',
          deleteAction: 'CASCADE', updateAction: 'NO_ACTION', disabled: false, notTrusted: false
        }
      },
      lists: { keyColumns: { rows: [['CustomerId', 'Id', null, 'int'], ['TenantId', 'TenantId', null, 'int']] } }
    })
    const follow = vi.fn()
    const fkModel = peekFkRelationModel(fk, follow)!
    expect(fkModel.parentColumns).toEqual(['CustomerId', 'TenantId'])
    expect(fkModel.referencedColumns).toEqual(['Id', 'TenantId'])
    expect(fkModel.onDelete).toEqual({ label: 'Cascade', tone: 'warning' })
    expect(fkModel.onUpdate).toEqual({ label: 'No action', tone: 'neutral' })
    expect(fkModel.statusPills.map(p => p.label)).toEqual(['Enabled', 'Trusted'])
    expect(peekStatePills(fk).map(p => p.label)).toEqual(['Enabled', 'Trusted'])
    // Disabled FK must never emit a green Trusted pill even when notTrusted is false.
    const disabledFk = makeOpen('key', {
      facts: { status: 'ready', value: { keyType: 'Foreign key', parentTable: 'dbo.Orders', referencedTable: 'Sales.Customers', disabled: true, notTrusted: false } }
    })
    expect(peekFkRelationModel(disabledFk)?.statusPills.map(p => p.label)).toEqual(['Disabled'])

    const pk = makeOpen('key', {
      facts: { status: 'ready', value: { keyType: 'Primary key', parentTable: 'dbo.Orders', indexType: 'Clustered', disabled: false } },
      lists: { keyColumns: { rows: [['OrderId', null, false, 'int'], ['CreatedAt', null, true, 'datetime2']] } }
    })
    const pkModel = peekKeySummaryModel(pk, follow)!
    expect(pkModel.columns).toEqual([{ name: 'OrderId', descending: false, type: 'int' }, { name: 'CreatedAt', descending: true, type: 'datetime2' }])
    expect(peekStatePills(pk).map(p => p.label)).toEqual(['Primary key', 'Clustered'])

    const ck = makeOpen('constraint', {
      facts: { status: 'ready', value: { constraintType: 'Check constraint', parentTable: 'dbo.Orders', column: 'TotalAmount', expression: '([TotalAmount] >= 0)', disabled: false, notTrusted: true, systemNamed: true } },
      definition: { status: 'ready', value: {} }
    })
    expect(peekConstraintModel(ck)).toMatchObject({ constraintType: 'Check constraint', column: 'TotalAmount', expression: '([TotalAmount] >= 0)' })
    expect(constraintExpressionText(ck)).toBe('([TotalAmount] >= 0)')
    expect(peekOverviewModel(ck).capabilities.map(c => [c.label, c.notable, c.tone])).toEqual([
      ['System-named', true, 'neutral'], ['Enabled', true, 'success'], ['Not trusted', true, 'warning']
    ])

    // Render FK card and Constraint Overview + Definition expression fallback in DOM.
    const fixture = workbenchFixture({ platform: 'win32', activeElement: () => document.activeElement })
    const writeClipboardText = vi.fn(async () => ok(undefined))
    const api = {
      explorerPeek: vi.fn(() => Promise.resolve(ok({ facts: ck.facts.status === 'ready' ? ck.facts.value : {}, elapsedMs: 1 }))),
      explorerCancel: vi.fn(async () => ok({ cancelled: 0 })),
      scriptObjects: vi.fn(() => Promise.resolve(ok({ warnings: [] }))),
      cancelScripting: vi.fn(async () => ok({ cancelled: 0 })),
      writeClipboardText
    }
    const peek = new PeekService({
      api: api as never,
      connections: { getSnapshot: () => [{ id: connectionId }], subscribe: () => () => {} },
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
      newId: () => 'id'
    })
    const wb = Object.assign(fixture, { peek, menus: { registerTarget: () => ({ dispose: () => {} }) } }) as unknown as Workbench
    try {
      const fkEl = mount(createElement(WorkbenchProvider, {
        workbench: wb,
        children: createElement(PeekBody, { view: peek, open: fk, idPrefix: 'fk-vis' })
      }))
      expect(fkEl.querySelector('[data-fk-relationship]')).not.toBeNull()
      expect(fkEl.textContent).toContain('ON DELETE: Cascade')
      expect(fkEl.textContent).toContain('ON UPDATE: No action')
      expect(fkEl.textContent).toContain('CustomerId')
      expect(fkEl.textContent).toContain('Sales.Customers')

      // Check constraint shows expression block in Overview and expression cleanly in Definition tab when script text is absent.
      const ckNode: ExplorerMenuNode = {
        id: 12, connectionId, kind: 'constraint', label: 'CK_Orders_Total', lost: false,
        ref: { type: 'object', object: { kind: 'constraint', database: 'Sales', parent: { kind: 'tableType', schema: 'dbo', name: 'OrderRows' }, name: 'CK_Orders_Total' } }
      }
      peek.peek(ckNode, 'keyboard')
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      const ckEl = mount(createElement(WorkbenchProvider, {
        workbench: wb,
        children: createElement(PeekBody, { view: peek, open: peek.getSnapshot().open!, idPrefix: 'ck-vis' })
      }))
      expect(ckEl.querySelector('[data-constraint-expression]')?.textContent).toContain('([TotalAmount] >= 0)')

      act(() => { peek.selectTab('definition') })
      const ckDefEl = mount(createElement(WorkbenchProvider, {
        workbench: wb,
        children: createElement(PeekBody, { view: peek, open: peek.getSnapshot().open!, idPrefix: 'ck-def' })
      }))
      expect(ckDefEl.textContent).toContain('Constraint Expression')
      expect(ckDefEl.textContent).toContain('([TotalAmount] >= 0)')
      await peek.copyDefinition()
      expect(writeClipboardText).toHaveBeenCalledWith('([TotalAmount] >= 0)')
    } finally {
      peek.dispose()
      fixture.dispose()
    }
  })

  it('supports BigQuery Peek Card with zero billed queries on open, Back stack navigation, lazy Preview Rows, and Open as Tab promotion', async () => {
    const fixture = workbenchFixture({ platform: 'win32', activeElement: () => document.activeElement })
    const tableProps: BigQueryProperties = {
      name: 'orders',
      type: 'table',
      elapsedMs: 8,
      fullName: 'varia-alpha.sales.orders',
      location: 'US',
      storage: { rows: 500, logicalBytes: 4096, longTermLogicalBytes: 1024 },
      schema: [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }],
      labels: [{ key: 'env', value: 'prod' }],
      groups: []
    }
    const datasetProps: BigQueryProperties = {
      name: 'sales',
      type: 'dataset',
      elapsedMs: 4,
      fullName: 'varia-alpha.sales',
      location: 'US',
      dataset: { defaultTableExpirationMs: 86_400_000 * 30 },
      groups: []
    }
    const results = { begin: vi.fn(), finish: vi.fn(() => Promise.resolve()), release: vi.fn() }
    const api = {
      explorerPeek: vi.fn(() => Promise.resolve(ok({ facts: {}, elapsedMs: 1 }))),
      explorerCancel: vi.fn(async () => ok({ cancelled: 0 })),
      scriptObjects: vi.fn(async () => ok({ warnings: [], text: 'CREATE TABLE `varia-alpha.sales.orders` (id INT64);' })),
      cancelScripting: vi.fn(async () => ok({ cancelled: 0 })),
      writeClipboardText: vi.fn(async () => ok(undefined)),
      execute: vi.fn(async () => ok({ status: 'completed', resultSets: [{ rowsRead: 2 }], messages: [] })),
      cancel: vi.fn(async () => ok({ cancelled: true })),
      bigQueryProperties: vi.fn(async (params: { kind: string }) => ok(params.kind === 'bqDataset' ? datasetProps : tableProps))
    }
    const billedGate = vi.fn(async () => ({ run: true as const }))
    const connectionList = [{ id: connectionId, server: 'varia-alpha', displayName: 'Analytics', providerId: 'bigquery' as const }]
    const connectionsStore = {
      getSnapshot: () => connectionList,
      get: (id: string) => id === connectionId ? connectionList[0] : undefined,
      subscribe: () => () => {}
    }
    const peek = new PeekService({
      api: api as never,
      connections: connectionsStore,
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      results,
      billedGate,
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
      newId: () => 'bq-id'
    })
    const bigQueryProperties = new BigQueryPropertiesService({
      api: api as never,
      documents: fixture.documents,
      connections: connectionsStore,
      results,
      billedGate
    })
    const peekTabs = new PeekTabService({
      peek,
      documents: fixture.documents,
      targetIdOf: () => 'target-bq',
      connections: connectionsStore,
      bigQueryProperties
    })
    const wb = Object.assign(fixture, {
      peek, peekTabs, bigQueryProperties, connections: connectionsStore,
      menus: { registerTarget: () => ({ dispose: () => {} }) }
    }) as unknown as Workbench

    const bqTableNode: ExplorerMenuNode = {
      id: 20, connectionId, kind: 'bqTable', provider: 'bigquery', label: 'orders', lost: false,
      ref: { type: 'object', object: { kind: 'bqTable', project: 'varia-alpha', dataset: 'sales', name: 'orders' } }
    }
    const bqRoutineNode: ExplorerMenuNode = {
      id: 21, connectionId, kind: 'bqRoutine', provider: 'bigquery', label: 'to_cents', lost: false,
      ref: { type: 'object', object: { kind: 'bqRoutine', project: 'varia-alpha', dataset: 'sales', name: 'to_cents' } }
    }
    const bqDatasetNode: ExplorerMenuNode = {
      id: 22, connectionId, kind: 'bqDataset', provider: 'bigquery', label: 'sales', lost: false,
      ref: { type: 'object', object: { kind: 'bqDataset', project: 'varia-alpha', name: 'sales' } }
    }
    const bqModelNode: ExplorerMenuNode = {
      id: 23, connectionId, kind: 'bqModel', provider: 'bigquery', label: 'churn', lost: false,
      ref: { type: 'object', object: { kind: 'bqModel', project: 'varia-alpha', dataset: 'sales', name: 'churn' } }
    }

    try {
      expect(peek.canPeek(bqTableNode)).toBe(true)
      expect(peek.canPeek(bqRoutineNode)).toBe(true)
      expect(peek.canPeek(bqDatasetNode)).toBe(true)
      expect(peek.canPeek(bqModelNode)).toBe(false)

      // Open BigQuery Peek Card: calls ONLY free bigquery.properties (zero billed queries, zero explorerPeek, zero preview).
      peek.peek(bqTableNode, 'keyboard')
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(api.bigQueryProperties).toHaveBeenCalledTimes(1)
      expect(api.explorerPeek).not.toHaveBeenCalled()
      expect(api.scriptObjects).not.toHaveBeenCalled()
      expect(api.execute).not.toHaveBeenCalled()

      mount(createElement(WorkbenchProvider, { workbench: wb, children: createElement(PeekCard) }))
      const card = document.body.querySelector<HTMLElement>('[data-peek-card]')!
      expect(card).not.toBeNull()
      expect(card.getAttribute('data-inspector-surface')).toBe('peek')
      expect(card.querySelectorAll('.inspector-tab-idx').length).toBeGreaterThanOrEqual(5)

      // Clicking the Dataset cross-object link navigates in-place to the dataset and pushes onto Back stack.
      const datasetLink = card.querySelector<HTMLButtonElement>('[aria-label="Peek varia-alpha.sales"]')!
      expect(datasetLink).not.toBeNull()
      await act(async () => {
        datasetLink.click()
        await Promise.resolve(); await Promise.resolve()
      })
      expect(peek.getSnapshot().open).toMatchObject({ kind: 'bqDataset', back: [{ kind: 'bqTable', tab: 'overview' }] })
      expect(card.querySelector('[aria-label="Back"]')).not.toBeNull()

      // Back returns to the table.
      await act(async () => {
        card.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click()
        await Promise.resolve(); await Promise.resolve()
      })
      expect(peek.getSnapshot().open?.kind).toBe('bqTable')

      // Selecting Preview Rows lazy-loads free tabledata.list; selecting Definition never auto-runs billed DDL.
      act(() => { peek.selectTab('definition') })
      expect(api.scriptObjects).not.toHaveBeenCalled()
      await act(async () => {
        peek.selectTab('preview')
        await Promise.resolve(); await Promise.resolve()
      })
      expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ preview: { project: 'varia-alpha', dataset: 'sales', table: 'orders' } }))

      // Open as Tab promotes BigQuery Peek directly into unified BigQueryPropertiesTab on the matching tab (no duplicate Peek tab).
      act(() => { peek.selectTab('columns') })
      const filterInput = card.querySelector<HTMLInputElement>('input[aria-label="Filter columns"]')!
      expect(filterInput).not.toBeNull()
      expect(cardStops(card)).toContain(filterInput)
      const promotedId = peekTabs.open(peek.getSnapshot().open!.node, peek.getSnapshot().open!.tab)!
      expect(bigQueryProperties.view(promotedId)).toMatchObject({ kind: 'bqTable', name: 'orders', activeTab: 'columns' })
      expect(peekTabs.view(promotedId)).toBeUndefined()
      // Promoting again focuses the existing BigQueryPropertiesTab on the new tab without opening a second tab.
      expect(peekTabs.open(bqTableNode, 'labels')).toBe(promotedId)
      expect(bigQueryProperties.view(promotedId)?.activeTab).toBe('labels')

      // Closing the card releases the Preview Rows results entry.
      act(() => { peek.close() })
      expect(results.release).toHaveBeenCalled()
    } finally {
      peekTabs.dispose()
      bigQueryProperties.dispose()
      peek.dispose()
      fixture.dispose()
    }
  })
})
