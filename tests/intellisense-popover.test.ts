// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SnapshotStore } from '../src/renderer/src/core/store'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import EditorStatus from '../src/renderer/src/EditorStatus'
import type { MemoryUsage } from '../src/renderer/src/results/memory'
import type { IndexEntry, ObjectSearchSnapshot } from '../src/renderer/src/search/ObjectSearchService'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import type { LanguageLookupAnswer } from '../src/shared/language-lookup'
import { workbenchFixture } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const watchers: EventTarget[] = []
;(globalThis as { CloseWatcher?: unknown }).CloseWatcher = class extends EventTarget {
  constructor() { super(); watchers.push(this) }
  destroy() { const i = watchers.indexOf(this); if (i >= 0) watchers.splice(i, 1) }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(clean => clean())
  watchers.length = 0
  document.body.innerHTML = ''
})

interface PopoverHarnessOptions {
  readonly isBigQuery: boolean
  readonly sqlText?: string
  readonly indexEntry?: IndexEntry
  readonly starred?: readonly string[]
  readonly memory?: MemoryUsage
  readonly language?: { readonly label: string; readonly detail: string }
  readonly issues?: { readonly label: string; readonly detail: string }
  readonly lookupAnswers?: readonly LanguageLookupAnswer[]
  readonly setStarredResult?: { readonly ok: true } | { readonly ok: false; readonly error: string }
}

function mountEditorStatus(options: PopoverHarnessOptions) {
  const connId = options.isBigQuery ? 'bq-1' : 'sql-1'
  const connection: LiveConnection = options.isBigQuery
    ? {
        id: connId,
        providerId: 'bigquery',
        generation: 1,
        server: 'analytics-prod',
        database: 'sales',
        serverVersion: 'BigQuery',
        principalId: 'alice@example.com',
        authentication: { principal: { provider: 'bigquery', principal: 'alice@example.com' } },
        options: { provider: 'bigquery', project: 'analytics-prod', dataset: 'sales', authentication: 'gcloud' }
      } as unknown as LiveConnection
    : {
        id: connId,
        providerId: 'sqlserver',
        generation: 1,
        server: 'sql01',
        database: 'SalesDB',
        serverVersion: '16.0',
        options: { provider: 'sqlserver', server: 'sql01', database: 'SalesDB', authentication: 'windows', trustServerCertificate: false }
      } as unknown as LiveConnection

  const searchStore = new SnapshotStore<ObjectSearchSnapshot>({
    indexes: options.indexEntry ? { [connId]: options.indexEntry } : {},
    documents: {},
    paneFocus: 0
  })
  const refreshBigQuery = vi.fn()
  const ensureIndex = vi.fn()
  const objectSearch = Object.assign(searchStore, { refreshBigQuery, ensureIndex })

  const memoryStore = new SnapshotStore<MemoryUsage>(options.memory ?? { usedBytes: 64 * 1024 * 1024, globalBytes: 512 * 1024 * 1024 })
  const starredStore = new SnapshotStore<{ readonly byPrincipal: Readonly<Record<string, readonly string[]>> }>({
    byPrincipal: { 'alice@example.com': options.starred ?? [] }
  })
  const setStarred = vi.fn(async () => options.setStarredResult ?? { ok: true as const })
  const bigQueryStarred = Object.assign(starredStore, { setStarred })
  const reportError = vi.fn()
  const lookupDocument = vi.fn(async () => options.lookupAnswers ?? [])

  const fixture = workbenchFixture()
  cleanups.push(fixture.dispose)
  const tab = fixture.documents.create('Query1.sql', options.sqlText ?? '', options.isBigQuery ? 'sales' : 'SalesDB', connId)
  const reportErrorSpy = vi.spyOn(fixture.commands, 'reportError').mockImplementation(reportError)
  vi.spyOn(fixture.commands, 'execute').mockResolvedValue(true)
  const wb = {
    ...fixture,
    editorStatus: new SnapshotStore({ line: 1, column: 1, character: 1, eol: 'lf' }),
    inputMode: new SnapshotStore({ mode: 'insert', available: true }),
    connections: Object.assign(new SnapshotStore([connection]), {
      get: (id: string) => id === connId ? connection : undefined,
      liveBigQuery: () => options.isBigQuery ? [connection] : []
    }),
    sqlLanguage: Object.assign(new SnapshotStore({}), {
      availability: () => !options.isBigQuery ? (options.language ?? { label: 'IntelliSense', detail: 'Active' }) : undefined
    }),
    sqlDiagnostics: Object.assign(new SnapshotStore({}), {
      status: () => !options.isBigQuery ? options.issues : undefined
    }),
    indexCompletion: Object.assign(new SnapshotStore({}), {
      availability: () => options.isBigQuery ? (options.language ?? { label: 'IntelliSense', detail: 'Active' }) : undefined,
      lookupDocument
    }),
    bigQueryCost: Object.assign(new SnapshotStore(new Map()), {
      status: () => options.isBigQuery ? options.issues : undefined
    }),
    objectSearch,
    indexMemory: memoryStore,
    bigQueryStarred
  } as unknown as Workbench
  void reportErrorSpy
  void tab

  const host = document.createElement('div')
  const trailingButton = document.createElement('button')
  trailingButton.textContent = 'Memory'
  document.body.append(host, trailingButton)
  const root = createRoot(host)
  cleanups.push(() => { act(() => { root.unmount() }); host.remove(); trailingButton.remove() })
  act(() => { root.render(createElement(WorkbenchProvider, { workbench: wb, children: createElement(EditorStatus) })) })
  const trigger = host.querySelector<HTMLButtonElement>('.editor-status-sql')!
  return { host, trigger, trailingButton, reportError, setStarred, refreshBigQuery, ensureIndex, lookupDocument }
}

describe('IntelliSensePopover accessibility, badges, Star action, and memory bar', () => {
  it('uses list/listitem ARIA roles, moves focus into the dialog on keyboard activation, bridges Tab stops, and restores focus on Escape', async () => {
    const h = mountEditorStatus({
      isBigQuery: true,
      sqlText: 'SELECT * FROM `other-proj.web.sessions` s',
      lookupAnswers: [{ state: 'absent', path: ['other-proj', 'web', 'sessions'], items: [], truncated: false }]
    })

    // Keyboard activation (detail === 0) opens dialog and moves focus to its first focusable control.
    await act(async () => { h.trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })) })
    const dialog = document.body.querySelector<HTMLElement>('.intellisense-popover')!
    expect(dialog).toBeTruthy()
    expect(dialog.querySelectorAll('[role="listbox"], [role="option"]')).toHaveLength(0)
    expect(dialog.querySelectorAll('[role="list"]').length).toBeGreaterThanOrEqual(2)
    expect(dialog.querySelectorAll('[role="listitem"]').length).toBeGreaterThanOrEqual(4)
    const closeBtn = dialog.querySelector<HTMLButtonElement>('.intellisense-popover-close')!
    expect(document.activeElement).toBe(closeBtn)

    // Focus sentinel right after trigger routes Tab into dialog; leading sentinel routes Shift+Tab back to trigger.
    const enterSentinel = h.host.querySelector<HTMLElement>('[data-focus-sentinel="enter"]')!
    const startSentinel = dialog.querySelector<HTMLElement>('[data-focus-sentinel="start"]')!
    expect(enterSentinel).toBeTruthy()
    act(() => { startSentinel.focus() })
    expect(document.activeElement).toBe(h.trigger)
    act(() => { enterSentinel.focus() })
    expect(document.activeElement).toBe(closeBtn)

    // Escape via CloseWatcher closes the dialog and restores focus to the trigger.
    act(() => { watchers.at(-1)?.dispatchEvent(new Event('close')) })
    expect(document.body.querySelector('.intellisense-popover')).toBeNull()
    expect(document.activeElement).toBe(h.trigger)
  })

  it('shows accurate SQL Server status badges when index is unbuilt, building, ready, or analysis is paused', async () => {
    const unbuilt = mountEditorStatus({ isBigQuery: false, indexEntry: undefined })
    await act(async () => { unbuilt.trigger.click() })
    const unbuiltBadge = document.body.querySelector('.intellisense-popover-header .intellisense-popover-pill')!
    expect(unbuiltBadge.textContent).toBe('STS Ready')
    expect(document.body.querySelectorAll('.intellisense-popover [role="listbox"], .intellisense-popover [role="option"]')).toHaveLength(0)
    expect(document.body.querySelectorAll('.intellisense-popover [role="listitem"]')).toHaveLength(3)
    act(() => { unbuilt.trigger.click() })

    const paused = mountEditorStatus({
      isBigQuery: false,
      issues: { label: 'SQL analysis paused', detail: 'Paused by user' },
      indexEntry: {
        connectionId: 'sql-1', done: 2, total: 2, objects: 120,
        status: { state: 'ready', databases: 2, indexed: 2, objects: 120, modules: 0, cut: 0, skipped: [], definitions: true }
      }
    })
    await act(async () => { paused.trigger.click() })
    const pausedBadge = document.body.querySelector('.intellisense-popover-header .intellisense-popover-pill')!
    expect(pausedBadge.textContent).toBe('STS + Index · Analysis paused')
    expect(pausedBadge.getAttribute('data-tone')).toBe('neutral')
  })

  it('shows Not built / Pending / Indexing for BigQuery Wave 3a/3b before the index is ready and guards NaN memory usage', async () => {
    const unbuilt = mountEditorStatus({
      isBigQuery: true,
      starred: ['dw-shared'],
      indexEntry: undefined,
      memory: { usedBytes: Number.NaN, globalBytes: 512 * 1024 * 1024 }
    })
    await act(async () => { unbuilt.trigger.click() })
    const pills = [...document.body.querySelectorAll('.intellisense-popover-rows .intellisense-popover-pill')].map(el => el.textContent)
    expect(pills).toEqual(['Not built', 'Not built', 'Not built'])
    expect(document.body.querySelector('.intellisense-popover-memory-value')?.textContent).toBe('Unavailable')
    expect(document.body.querySelector('.intellisense-popover-bar')?.getAttribute('aria-valuenow')).toBe('0')
    act(() => { unbuilt.trigger.click() })

    const building = mountEditorStatus({
      isBigQuery: true,
      starred: ['dw-shared'],
      indexEntry: { connectionId: 'bq-1', requestId: 'r1', phase: 'names', done: 1, total: 5, objects: 0 },
      memory: { usedBytes: 100, globalBytes: Number.POSITIVE_INFINITY }
    })
    await act(async () => { building.trigger.click() })
    const buildingPills = [...document.body.querySelectorAll('.intellisense-popover-rows .intellisense-popover-pill')].map(el => el.textContent)
    expect(buildingPills).toEqual(['Indexing', 'Pending', 'Pending'])
    expect(document.body.querySelector('.intellisense-popover-bar')?.getAttribute('aria-valuenow')).toBe('0')
  })

  it('reports Star errors via commands.reportError and triggers objectSearch.refreshBigQuery on success', async () => {
    const failing = mountEditorStatus({
      isBigQuery: true,
      sqlText: 'SELECT * FROM `other-proj.web.sessions` s',
      lookupAnswers: [{ state: 'absent', path: ['other-proj', 'web', 'sessions'], items: [], truncated: false }],
      setStarredResult: { ok: false, error: 'Could not save starred project.' }
    })
    await act(async () => { failing.trigger.click() })
    const starBtnFail = document.body.querySelector<HTMLButtonElement>('.intellisense-popover-inline-action')!
    await act(async () => { starBtnFail.click() })
    expect(failing.reportError).toHaveBeenCalledWith('Could not save starred project.')
    expect(failing.refreshBigQuery).not.toHaveBeenCalled()
    act(() => { failing.trigger.click() })

    const ok = mountEditorStatus({
      isBigQuery: true,
      sqlText: 'SELECT * FROM `other-proj.web.sessions` s',
      lookupAnswers: [{ state: 'absent', path: ['other-proj', 'web', 'sessions'], items: [], truncated: false }],
      setStarredResult: { ok: true }
    })
    await act(async () => { ok.trigger.click() })
    const starBtnOk = document.body.querySelector<HTMLButtonElement>('.intellisense-popover-inline-action')!
    await act(async () => { starBtnOk.click() })
    expect(ok.reportError).not.toHaveBeenCalled()
    expect(ok.refreshBigQuery).toHaveBeenCalledWith('bq-1', { scope: { project: 'other-proj' } })
  })
})
