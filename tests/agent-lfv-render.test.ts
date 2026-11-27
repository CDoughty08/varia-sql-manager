// @vitest-environment happy-dom
// LogFileViewer Option A render tests: DocumentFrame body, Sources toggle + focus rescue, ResizableSplit persistence
// (agent.lfv.sources & agent.lfv.message), inline source search + counts + retention footer, single-row filter bar,
// mono timestamps, Copy -> Copied feedback, and truncation/banner preservation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import LogFileViewer from '../src/renderer/src/agent/LogFileViewer'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { LiveTable } from '../src/renderer/src/live/LiveService'
import { agentHistoryProbe } from '../src/shared/agent/history'
import { agentErrorLogProbe } from '../src/shared/agent/error-log'
import { liveProbes } from '../src/shared/live/catalog'
import type { FakeLiveHandle } from './fixtures/live-handle'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()) })
beforeEach(() => { window.localStorage.clear() })

const nightly = '11111111-1111-1111-1111-111111111111'
const backup = '22222222-2222-2222-2222-222222222222'

function tableOf(tableIndex: number, rows: string[][], truncated = false): LiveTable {
  const columns = liveProbes[agentHistoryProbe].tables![tableIndex].columns.map(col => ({ name: col.name, dataType: col.dataType }))
  const snapshot = { rowsAvailable: rows.length, rowsExpected: rows.length, state: 'complete', columns, truncated }
  return {
    handle: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      getWindow: async (first: number, count: number) => {
        const slice = rows.slice(first, first + count)
        return { first, count: slice.length, colStart: 0, colEnd: columns.length, text: slice.flat(), flags: new Uint8Array(slice.length * columns.length) }
      }
    },
    descriptor: { rowsAvailable: rows.length, truncated, columns }
  } as unknown as LiveTable
}

function errorLogTableOf(rows: string[][]): LiveTable {
  const columns = liveProbes[agentErrorLogProbe].tables![0].columns.map(col => ({ name: col.name, dataType: col.dataType }))
  const snapshot = { rowsAvailable: rows.length, rowsExpected: rows.length, state: 'complete', columns, truncated: false }
  return {
    handle: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      getWindow: async (first: number, count: number) => {
        const slice = rows.slice(first, first + count)
        return { first, count: slice.length, colStart: 0, colEnd: columns.length, text: slice.flat(), flags: new Uint8Array(slice.length * columns.length) }
      }
    },
    descriptor: { rowsAvailable: rows.length, truncated: false, columns }
  } as unknown as LiveTable
}

function errorRowFor(values: Record<string, string>): string[] {
  return liveProbes[agentErrorLogProbe].tables![0].columns.map(col => values[col.id] ?? '')
}

function rowFor(tableIndex: number, values: Record<string, string>): string[] {
  return liveProbes[agentHistoryProbe].tables![tableIndex].columns.map(col => values[col.id] ?? '')
}

async function mountViewer(options: {
  readonly openWith?: { readonly errorLog?: number }
  readonly errorLogs?: { readonly logs: readonly { archive: number; date: string; bytes: number }[]; readonly archives: boolean }
} = {}) {
  const fixture = workbenchFixture()
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  fixture.api.agentProfile.mockResolvedValue({
    ok: true,
    value: { elapsedMs: 1, profile: { sysadmin: true, msdbAccess: true, purgeHistory: true } as never }
  })
  fixture.api.agentErrorLogs.mockResolvedValue({
    ok: true,
    value: {
      logs: options.errorLogs?.logs ?? [{ archive: 0, date: '2026-11-22T14:31:00', bytes: 120 }, { archive: 1, date: '2026-11-13T07:48:00', bytes: 80 }],
      archives: options.errorLogs?.archives ?? true,
      elapsedMs: 1
    }
  })
  fixture.api.agentHistoryMessage.mockResolvedValue({ ok: true, value: { message: 'Step 2 failed on PK_SalesFact.', elapsedMs: 1 } })
  const id = fixture.logViewer.open('c1', options.openWith)
  const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.source === 'agent.history')!
  handle.tables.set(`${agentHistoryProbe}:2`, tableOf(2, [
    [nightly, 'Nightly', 'sa', 'No', 'Yes'],
    [backup, 'Backup', 'sa', 'No', 'Yes']
  ]))
  handle.tables.set(`${agentHistoryProbe}:0`, tableOf(0, [
    rowFor(0, { runKey: `${nightly}:12`, jobName: 'Nightly', outcome: 'Failed', started: '2026-11-22 14:00:00', duration: '00:04:18', steps: '2', message: 'The job failed.' }),
    rowFor(0, { runKey: `${backup}:5`, jobName: 'Backup', outcome: 'Succeeded', started: '2026-11-22 13:00:00', duration: '00:01:02', steps: '1', message: 'Succeeded.' })
  ], true))
  const stepsTable = tableOf(1, [
    rowFor(1, { stepInstance: '12', stepId: '0', stepName: '(Job outcome)', stepOutcome: 'Failed', stepStarted: '2026-11-22 14:00:00', stepDuration: '00:04:18' }),
    rowFor(1, { stepInstance: '11', stepId: '2', stepName: 'Merge SalesFact', stepOutcome: 'Failed', stepStarted: '2026-11-22 14:01:12', stepDuration: '00:03:06' })
  ])
  handle.tables.set(`${agentHistoryProbe}:1`, stepsTable)
  handle.deliver({
    type: 'live.tick',
    seq: 1,
    sampledAt: 1,
    samples: [{
      probe: agentHistoryProbe,
      costMs: 1,
      effectiveIntervalMs: 15_000,
      status: [{ id: 'historyMaxRows', value: 10000 }, { id: 'historyMaxRowsPerJob', value: 500 }]
    }]
  })
  await settled()

  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: createElement(LogFileViewer, { documentId: id }) }))
    await settled()
  })
  cleanups.unshift(() => { act(() => root.unmount()); host.remove() })

  // Attach fake runs grid first so Run steps LiveGridPane mounts, then attach fake steps grid with row 1 selected.
  const runsSnapshot = { activeKey: `${nightly}:12` }
  await act(async () => {
    fixture.logViewer.attachRuns(id, {
      subscribe: () => () => {},
      getSnapshot: () => runsSnapshot
    } as never)
    await settled()
  })
  const stepsSnapshot = { activeKey: '11', table: stepsTable, selection: { active: { row: 1, col: 0 } } }
  await act(async () => {
    fixture.logViewer.attachSteps(id, {
      subscribe: () => () => {},
      getSnapshot: () => stepsSnapshot
    } as never)
    await settled()
  })
  return { fixture, host, id }
}

describe('LogFileViewer Option A', () => {
  it('renders DocumentFrame body (no .document-content), header Sources toggle, single-row filters, counts, and retention footer', async () => {
    const { host } = await mountViewer()
    expect(host.querySelector('.document-frame > .document-content')).toBeNull()
    expect(host.querySelector('.document-frame > .document-body.lfv')).not.toBeNull()

    // Header actions: Sources toggle, Refresh, Delete History…, Recycle…
    const sourcesBtn = host.querySelector<HTMLButtonElement>('.document-header .lfv-sources-toggle')!
    expect(sourcesBtn).not.toBeNull()
    expect(sourcesBtn.getAttribute('aria-pressed')).toBe('true')
    expect(sourcesBtn.textContent).toContain('Sources')
    expect(host.querySelector('.document-header')?.textContent).toContain('Delete History…')
    expect(host.querySelector('.document-header')?.textContent).toContain('Recycle…')

    // Single Select logs region (no duplicate region) + group eyebrow counts + retention footer
    expect(host.querySelectorAll('[role="region"][aria-label="Select logs"]')).toHaveLength(1)
    const sourcesRegion = host.querySelector('[role="region"][aria-label="Select logs"]')!
    expect(sourcesRegion.querySelectorAll('.agent-eyebrow')).toHaveLength(2)
    expect(sourcesRegion.textContent).toContain('2 / 2')
    expect(sourcesRegion.textContent).toContain('0 / 2')
    expect(sourcesRegion.querySelector('.lfv-rail-foot')?.textContent).toContain('Retention: 10,000 rows · 500/job')

    // Filter bar: Segmented Window radiogroup, Outcome select, Message contains, Step # mono input, Clear
    const toolbar = host.querySelector('[role="toolbar"][aria-label="History filters"]')!
    expect(toolbar.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(toolbar.querySelector<HTMLSelectElement>('select[aria-label="Outcome"]')?.options[0].textContent).toBe('Outcome: All')
    expect(toolbar.querySelector<HTMLInputElement>('input[type="search"]')).not.toBeNull()
    expect(toolbar.querySelector<HTMLInputElement>('input[aria-label="Step"]')?.className).toContain('agent-mono')
    expect(toolbar.querySelector('button[aria-label="Clear filters"]')).not.toBeNull()

    // Truncation note preserved
    expect(host.querySelector('.lfv-main > .lfv-note')?.textContent).toContain('10,000 history rows')
  })

  it('collapses Select logs rail, hides its separator, and rescues focus back to Sources toggle when focus was inside the rail', async () => {
    const { host } = await mountViewer()
    const sourcesBtn = host.querySelector<HTMLButtonElement>('.lfv-sources-toggle')!
    const searchInput = host.querySelector<HTMLInputElement>('.lfv-rail-search input[type="search"]')!
    expect(host.querySelector('[role="separator"][aria-label="Resize Select logs"]')).not.toBeNull()

    // Focus search box inside Select logs, then collapse Sources
    await act(async () => { searchInput.focus() })
    expect(document.activeElement).toBe(searchInput)

    await act(async () => { sourcesBtn.click() })
    expect(sourcesBtn.getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelector('[role="region"][aria-label="Select logs"]')).toBeNull()
    expect(host.querySelector('[role="separator"][aria-label="Resize Select logs"]')).toBeNull()
    expect(document.activeElement).toBe(sourcesBtn)
  })

  it('filters jobs and error logs via inline source search while keeping ARIA contracts', async () => {
    const { host } = await mountViewer()
    const sources = host.querySelector('[role="region"][aria-label="Select logs"]')!
    const search = sources.querySelector<HTMLInputElement>('input[type="search"]')!

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'Night')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const jobNames = [...sources.querySelectorAll('ul:not([aria-label]) li span')].map(el => el.textContent)
    expect(jobNames).toEqual(['Nightly'])
    expect(sources.querySelector('[aria-label="SQL Server Agent error logs"]')).not.toBeNull()
    expect(sources.textContent).toContain('No error logs match the filter.')
  })

  it('persists ResizableSplit widths under agent.lfv.sources and agent.lfv.message and shows mono timestamps + Copy feedback', async () => {
    const { host } = await mountViewer()
    const sourcesSash = host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize Select logs"]')!
    const messageSash = host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize Message details"]')!
    expect(sourcesSash.getAttribute('aria-valuenow')).toBe('236')
    expect(messageSash.getAttribute('aria-valuenow')).toBe('430')

    await act(async () => {
      sourcesSash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      messageSash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(window.localStorage.getItem('varia.split.agent.lfv.sources')).toBe('248')
    expect(window.localStorage.getItem('varia.split.agent.lfv.message')).toBe('442')

    const details = host.querySelector('[role="region"][aria-label="Message details"]')!
    expect(details.querySelector('.lfv-details-meta .agent-mono')?.textContent).toContain('2026-11-22 14:01:12 · 00:03:06')
    const copyBtn = details.querySelector<HTMLButtonElement>('button[aria-label="Copy the message"]')!
    expect(copyBtn.textContent).toBe('Copy')

    const prevVaria = (window as unknown as { varia?: unknown }).varia
    ;(window as unknown as { varia: { writeClipboardText: ReturnType<typeof vi.fn> } }).varia = {
      writeClipboardText: vi.fn(async () => ({ ok: true }))
    }
    cleanups.push(() => { (window as unknown as { varia?: unknown }).varia = prevVaria })

    await act(async () => { copyBtn.click(); await settled() })
    expect(copyBtn.textContent).toBe('Copied')
    expect(copyBtn.hasAttribute('data-copied')).toBe(true)
  })

  it('does not count stale or missing error log archive IDs in ErrorLogSources count', async () => {
    const { host } = await mountViewer({
      openWith: { errorLog: 0 },
      errorLogs: { logs: [], archives: false }
    })
    const sources = host.querySelector('[role="region"][aria-label="Select logs"]')!
    const headers = [...sources.querySelectorAll('.lfv-group-hdr')]
    const errorLogHeader = headers.find(hdr => hdr.textContent?.includes('Agent Error Logs'))!
    expect(errorLogHeader.querySelector('.lfv-sources-count')?.textContent).toBe('0 / 0')
    expect(errorLogHeader.textContent).not.toContain('1 / 0')
  })

  it('rescues focus on Sources collapse from rail (incl. pointerdown blur) and does NOT hijack focus after .blur() to document.body', async () => {
    // (i) Focus inside rail -> blur to document.body -> Sources collapse does NOT move focus from document.body
    const first = await mountViewer()
    const firstToggle = first.host.querySelector<HTMLButtonElement>('.lfv-sources-toggle')!
    const firstSearch = first.host.querySelector<HTMLInputElement>('.lfv-rail-search input[type="search"]')!
    await act(async () => { firstSearch.focus() })
    expect(document.activeElement).toBe(firstSearch)
    await act(async () => { firstSearch.blur() })
    expect(document.activeElement).toBe(document.body)

    await act(async () => { firstToggle.click() })
    expect(firstToggle.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(document.body)

    // (ii) Focus inside rail -> macOS pointerdown on Sources toggle blurs rail to null -> click still rescues focus
    const second = await mountViewer()
    const secondToggle = second.host.querySelector<HTMLButtonElement>('.lfv-sources-toggle')!
    const secondSearch = second.host.querySelector<HTMLInputElement>('.lfv-rail-search input[type="search"]')!
    await act(async () => { secondSearch.focus() })
    expect(document.activeElement).toBe(secondSearch)
    await act(async () => {
      secondToggle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      secondSearch.blur()
      secondToggle.click()
    })
    expect(secondToggle.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(secondToggle)
  })

  it('ignores stale async Copy completion after switching to a different message', async () => {
    const { fixture, host, id } = await mountViewer()
    const details = host.querySelector('[role="region"][aria-label="Message details"]')!
    const copyBtn = details.querySelector<HTMLButtonElement>('button[aria-label="Copy the message"]')!

    let resolveCopy!: (value: { ok: boolean }) => void
    const prevVaria = (window as unknown as { varia?: unknown }).varia
    ;(window as unknown as { varia: { writeClipboardText: ReturnType<typeof vi.fn> } }).varia = {
      writeClipboardText: vi.fn(() => new Promise<{ ok: boolean }>(resolve => { resolveCopy = resolve }))
    }
    cleanups.push(() => { (window as unknown as { varia?: unknown }).varia = prevVaria })

    await act(async () => { copyBtn.click() })

    // Switch step selection while clipboard write is still pending
    const runsHandle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.source === 'agent.history')!
    const stepsTable = runsHandle.tables.get(`${agentHistoryProbe}:1`)!
    fixture.api.agentHistoryMessage.mockResolvedValue({ ok: true, value: { message: 'Second message.', elapsedMs: 1 } })
    await act(async () => {
      fixture.logViewer.attachSteps(id, {
        subscribe: () => () => {},
        getSnapshot: () => ({ activeKey: '12', table: stepsTable, selection: { active: { row: 0, col: 0 } } })
      } as never)
      await settled()
    })

    await act(async () => {
      resolveCopy({ ok: true })
      await settled()
    })
    expect(copyBtn.textContent).toBe('Copy')
    expect(copyBtn.hasAttribute('data-copied')).toBe(false)
  })

  it('ignores stale async Copy completion in ErrorLogPane after switching to a different log entry', async () => {
    const { fixture, host, id } = await mountViewer({ openWith: { errorLog: 0 } })
    const logHandle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.source === 'agent.errorLog')!
    const entriesTable = errorLogTableOf([
      errorRowFor({ logKey: 'e1', logDate: '2026-11-22 14:31:00', logSource: '[000]', logType: 'Error', logMessage: 'First error' }),
      errorRowFor({ logKey: 'e2', logDate: '2026-11-22 14:32:00', logSource: '[000]', logType: 'Warning', logMessage: 'Second warning' })
    ])
    logHandle.tables.set(`${agentErrorLogProbe}:0`, entriesTable)
    await act(async () => {
      fixture.logViewer.attachEntries(id, {
        subscribe: () => () => {},
        getSnapshot: () => ({ activeKey: 'e1', table: entriesTable, selection: { active: { row: 0, col: 0 } } })
      } as never)
      await settled()
    })

    const logDetails = host.querySelector('[role="region"][aria-label="Log row details"]')!
    const copyBtn = logDetails.querySelector<HTMLButtonElement>('button[aria-label="Copy the log message"]')!
    let resolveCopy!: (value: { ok: boolean }) => void
    const prevVaria = (window as unknown as { varia?: unknown }).varia
    ;(window as unknown as { varia: { writeClipboardText: ReturnType<typeof vi.fn> } }).varia = {
      writeClipboardText: vi.fn(() => new Promise<{ ok: boolean }>(resolve => { resolveCopy = resolve }))
    }
    cleanups.push(() => { (window as unknown as { varia?: unknown }).varia = prevVaria })

    await act(async () => { copyBtn.click() })
    await act(async () => {
      fixture.logViewer.attachEntries(id, {
        subscribe: () => () => {},
        getSnapshot: () => ({ activeKey: 'e2', table: entriesTable, selection: { active: { row: 1, col: 0 } } })
      } as never)
      await settled()
    })

    await act(async () => {
      resolveCopy({ ok: true })
      await settled()
    })
    expect(copyBtn.textContent).toBe('Copy')
    expect(copyBtn.hasAttribute('data-copied')).toBe(false)
  })
})
