// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import MemoryIndicator from '../src/renderer/src/results/MemoryIndicator'
import { MemoryUsageService } from '../src/renderer/src/results/memory'
import { nerdMetrics, resultNames } from '../src/renderer/src/results/memory-details'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { SnapshotStore } from '../src/renderer/src/core/store'
import { SettingsService } from '../src/renderer/src/settings/SettingsService'
import { defaultSettings, settingDef } from '../src/shared/settings/catalog'
import { maxLargestResults, memoryEventSchema, resultMemoryDetailSchema } from '../src/shared/ipc/port-messages'
import type { ResultMemoryDetail } from '../src/shared/contracts'
import { settingsApi } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Chromium's close requests; happy-dom has none.
;(globalThis as { CloseWatcher?: unknown }).CloseWatcher = class extends EventTarget { destroy() {} }

const MB = 1048576
const key = 'environment.statusBar.memoryNerdMetrics'
const off = { pagesPacked: 0, pagesUnpacked: 0, packInputBytes: 0, packMicroseconds: 0, unpackOutputBytes: 0, unpackMicroseconds: 0, cacheHits: 0, cacheLookups: 0, lastUnpackMicroseconds: 0 }
/** What the backend reports today: nothing compressed, stored equal to the rows as read, the codec off. */
const raw: ResultMemoryDetail = {
  logicalBytes: 300 * MB, storedBytes: 300 * MB, compressedBytes: 0, packedLogicalBytes: 0, cacheBytes: 0,
  largest: [{ resultId: 7, logicalBytes: 200 * MB, storedBytes: 200 * MB, state: 'raw' }, { resultId: 9, logicalBytes: 100 * MB, storedBytes: 100 * MB, state: 'raw', live: true }],
  codec: off, heap: { committedBytes: 512 * MB, freeBytes: 40 * MB }
}
/** The accepted mock's proportions, in MB: 4,410 of rows held in 620 raw, 1,580 packed and 110 of cache. */
const packed: ResultMemoryDetail = {
  logicalBytes: 4410 * MB, storedBytes: 2200 * MB, compressedBytes: 1580 * MB, packedLogicalBytes: 3790 * MB, cacheBytes: 110 * MB,
  largest: [
    { resultId: 3, logicalBytes: 1840 * MB, storedBytes: 880 * MB, state: 'packed' },
    { resultId: 4, logicalBytes: 750 * MB, storedBytes: 270 * MB, state: 'unpacking', progress: 62 },
    { resultId: 5, logicalBytes: 620 * MB, storedBytes: 620 * MB, state: 'raw' }
  ],
  codec: { name: 'zstd', level: 2, pagesPacked: 15420, pagesUnpacked: 2000, packInputBytes: 342 * MB, packMicroseconds: 1_000_000, unpackOutputBytes: 1600 * MB, unpackMicroseconds: 1_000_000, cacheHits: 968, cacheLookups: 1000, lastUnpackMicroseconds: 380_000 },
  heap: { committedBytes: 2620 * MB, freeBytes: 210 * MB }
}
const named = (entry: { resultId: number }) => `Query · Result ${entry.resultId}`

describe('Memory panel Nerd metrics', () => {
  it('shows honest figures while nothing is compressed: no ratio, nothing given back, raw pages only, dashed codec timings', () => {
    const model = nerdMetrics(raw, named)
    expect(model.compressed).toBe(false)
    expect(model.tiles.map(tile => [tile.label, tile.value, tile.unit, tile.note, tile.tone])).toEqual([
      ['Compressed', '0', '%', 'of rows, by size', undefined], ['Ratio', '—', undefined, 'Compression off', undefined], ['Saved', '0', 'MB', '0% of 300 MB', undefined]
    ])
    expect(model.bars.map(bar => bar.segments.map(part => [part.part, part.share]))).toEqual([[['raw', 1]], [['raw', 1]]])
    expect(model.legend.map(part => part.part)).toEqual(['raw'])
    expect(model.biggest.map(row => [row.name, row.logical, row.stored, row.stateLabel, row.logicalShare, row.storedShare])).toEqual([
      ['Query · Result 7', '200 MB', '200 MB', 'Raw', 1, 1], ['Query · Result 9', '100 MB', '100 MB', 'Raw', 0.5, 0.5]
    ])
    expect(Object.fromEntries(model.counters.map(counter => [counter.label, counter.value]))).toEqual({
      'Pages packed': '0', 'Pack speed': '—', 'Cache hits': '—', 'Unpack speed': '—', 'Last unpack': '—', 'Per page': '—'
    })
    expect([model.heap, model.cozy]).toEqual(['Heap 512 MB · 40 MB free for reuse', { lead: 'Your rows are', accent: 'stretching out' }])
    const empty = nerdMetrics({ ...raw, logicalBytes: 0, storedBytes: 0, largest: [] }, named)
    expect([empty.tiles[0].value, empty.tiles[2].note, empty.cozy.lead, empty.bars.every(bar => bar.segments.length === 0)]).toEqual(['—', 'No rows held', 'Nothing to tuck in yet', true])
  })

  it('splits compressed memory into raw, packed, cache and given back on one scale, with the codec\'s counters', () => {
    const model = nerdMetrics(packed, named)
    expect([model.compressed, model.memoryBytes, model.givenBack]).toEqual([true, 2310 * MB, 2100 * MB])
    expect(model.tiles.map(tile => `${tile.value}${tile.unit ?? ''} ${tile.note}`)).toEqual(['86% of rows, by size', '2.40× zstd · level 2', '2.05GB 48% of 4.31 GB'])
    expect(model.tiles[2].tone).toBe('saved')
    const [asRead, now] = model.bars
    expect(asRead.segments.map(part => [part.part, part.bytes / MB])).toEqual([['raw', 620], ['packed', 3790]])
    expect(now.segments.map(part => [part.part, part.bytes / MB])).toEqual([['raw', 620], ['packed', 1580], ['cache', 110], ['returned', 2100]])
    // One scale: the lower bar's parts, given back included, fill the same width as the rows as read.
    expect(now.segments.reduce((sum, part) => sum + part.share, 0)).toBeCloseTo(1)
    expect(model.biggest.map(row => row.stateLabel)).toEqual(['Packed', 'Unpacking 62%', 'Raw'])
    expect(model.biggest[0].storedShare).toBeCloseTo(880 / 1840)
    expect(Object.fromEntries(model.counters.map(counter => [counter.label, counter.value]))).toEqual({
      'Pages packed': '15,420', 'Pack speed': '342 MB/s', 'Cache hits': '96.8%', 'Unpack speed': '1.6 GB/s', 'Last unpack': '0.38 s', 'Per page': '0.5 ms'
    })
    expect(model.cozy).toEqual({ lead: 'Your rows are', accent: '2.4× cozier' })
  })

  it('names results by their query tab and Results caption in the generation the figures came from', () => {
    const set = (generation: number, resultId: number, number: number, label?: string) => ({ descriptor: { generation, resultId }, number, ...label ? { label } : {} })
    const name = resultNames({ a: { sets: [set(2, 7, 1), set(2, 8, 2, 'Pivot of Result 1'), set(1, 9, 3)] } }, id => id === 'a' ? 'Query 3' : undefined, 2)
    expect([7, 8, 9].map(resultId => name({ resultId, logicalBytes: 1, storedBytes: 1, state: 'raw' }))).toEqual(['Query 3 · Result 1', 'Query 3 · Pivot of Result 1', 'Unlisted result'])
    expect(name({ resultId: 9, logicalBytes: 1, storedBytes: 1, state: 'raw', live: true })).toBe('Live view table')
  })

  it('accepts the backend\'s event with its detail and bounds it', () => {
    const event = { type: 'results.memory', usedBytes: 1, globalBytes: 2, seq: 1, detail: packed }
    expect(memoryEventSchema.safeParse(event).success).toBe(true)
    expect(memoryEventSchema.safeParse({ type: 'results.memory', usedBytes: 1, globalBytes: 2, seq: 1 }).success).toBe(true)
    expect(memoryEventSchema.safeParse({ ...event, type: 'explorer.index.memory' }).success).toBe(false)
    const tooMany = { ...raw, largest: Array.from({ length: 9 }, (_, index) => ({ resultId: index + 1, logicalBytes: 1, storedBytes: 1, state: 'raw' })) }
    expect([resultMemoryDetailSchema.safeParse(tooMany).success, resultMemoryDetailSchema.safeParse({ ...raw, extra: 1 }).success,
      resultMemoryDetailSchema.safeParse({ ...packed, largest: [{ ...packed.largest[1], progress: 101 }] }).success]).toEqual([false, false, false])
  })

  it('keeps the last event\'s detail through a summary\'s budget, and drops it with the backend', () => {
    const service = new MemoryUsageService({ onMemory: () => ({ dispose: () => {} }) }, 'results')
    service.update({ usedBytes: 10 * MB, globalBytes: 100 * MB, generation: 1, seq: 1, detail: raw })
    service.update({ usedBytes: 20 * MB, globalBytes: 100 * MB, generation: 1, seq: 2 })
    expect(service.getSnapshot()).toEqual({ usedBytes: 20 * MB, globalBytes: 100 * MB, detail: raw, generation: 1 })
    service.update({ usedBytes: 0, globalBytes: 0, generation: 2, seq: 0 })
    expect(service.getSnapshot().detail).toBeUndefined()
  })

  it('samples the saved share once per event that brings a detail, for the sparkline, and empties it with the backend', () => {
    let time = 1000
    const service = new MemoryUsageService({ onMemory: () => ({ dispose: () => {} }) }, 'results', undefined, () => time)
    service.update({ usedBytes: 10 * MB, globalBytes: 100 * MB, generation: 1, seq: 1, detail: raw })
    time = 2000
    service.update({ usedBytes: 20 * MB, globalBytes: 100 * MB, generation: 1, seq: 2 })
    service.update({ usedBytes: 20 * MB, globalBytes: 100 * MB, generation: 1, seq: 2, detail: packed })
    time = 3000
    service.update({ usedBytes: 20 * MB, globalBytes: 100 * MB, generation: 1, seq: 3, detail: packed })
    const ring = service.history
    // The summary (seq 2, no detail) adds nothing; the stale seq-2 event is dropped; seq 3 is sampled.
    expect(Array.from({ length: ring.length }, (_, index) => [ring.time(index), Math.round(ring.value(index, 0))])).toEqual([[1000, 0], [3000, 48]])
    service.update({ usedBytes: 0, globalBytes: 0, generation: 2, seq: 0 })
    expect(service.history.length).toBe(0)
  })

  it('caps the biggest results at the same count in the backend and the schema', () => {
    const snapshot = readFileSync(resolve(__dirname, '../backend/Varia.Backend/Results/ResultStore.Snapshot.cs'), 'utf8')
    expect(Number(/const int MaxLargest = (\d+);/.exec(snapshot)?.[1])).toBe(maxLargestResults)
  })
})

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()) })

async function mount(memory: { usedBytes: number; globalBytes: number; detail?: ResultMemoryDetail }, seed: Partial<typeof defaultSettings> = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const client = { onMemory: () => ({ dispose: () => {} }) }
  const resultMemory = new MemoryUsageService(client, 'results'), indexMemory = new MemoryUsageService(client, 'index')
  indexMemory.update({ usedBytes: 92 * MB, globalBytes: 512 * MB, generation: 1, seq: 1 })
  resultMemory.update({ ...memory, generation: 1, seq: 1 })
  const api = settingsApi(seed)
  const settings = new SettingsService(api as never, { ...defaultSettings, ...seed })
  const results = new SnapshotStore({ tab: { sets: [{ descriptor: { generation: 1, resultId: 3 }, number: 1 }] } })
  const documents = new SnapshotStore({ documents: [{ id: 'tab', name: 'Query 3' }] })
  const menus = { ownsKeyboard: () => false, controller: { subscribe: () => () => {} } }
  const theme = { getSnapshot: () => ({ active: { colors: {} } }), subscribe: () => () => {} }
  const live = { page: { hidden: () => false, subscribe: () => () => {} } }
  const workbench = { resultMemory, indexMemory, menus, settings, results, documents, theme, live } as unknown as Workbench
  const root = createRoot(host)
  await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: createElement(MemoryIndicator) })) })
  cleanups.push(() => { act(() => { root.unmount() }); document.body.querySelectorAll('.memory-details').forEach(node => node.remove()); host.remove(); settings.dispose() })
  const panel = () => document.body.querySelector<HTMLElement>('.memory-details')!
  await act(async () => { host.querySelector<HTMLButtonElement>('.memory-indicator')!.click() })
  const toggle = () => panel().querySelector<HTMLButtonElement>('.memory-nerd-toggle')!
  return { panel, toggle, api, settings }
}

describe('Memory panel', () => {
  it('keeps both rows and starts with Nerd metrics collapsed, showing no compression parts while nothing is compressed', async () => {
    const view = await mount({ usedBytes: 300 * MB, globalBytes: 1024 * MB, detail: raw })
    expect([...view.panel().querySelectorAll('.memory-row h3')].map(node => node.textContent)).toEqual(['Search Indexer', 'Results'])
    expect(view.toggle().getAttribute('aria-expanded')).toBe('false')
    // Pinned by a click, the heading is in the tab order (a preview keeps it out: menus-smoke, results-smoke).
    expect(view.toggle().tabIndex).toBe(0)
    expect(view.panel().querySelector<HTMLElement>('.memory-nerd-body')!.hidden).toBe(true)
    expect(view.panel().querySelector('.memory-tiles')).toBeNull()
    expect(view.panel().querySelector('.memory-packed')).toBeNull()
    expect(view.panel().querySelector('.memory-ring[data-packed]')).toBeNull()
    expect(settingDef(key)).toMatchObject({ type: 'boolean', default: false, hidden: true })
  })

  it('opens Nerd metrics from its heading, saves the open state, and opens that way next time', async () => {
    const view = await mount({ usedBytes: 300 * MB, globalBytes: 1024 * MB, detail: raw })
    await act(async () => { view.toggle().click() })
    expect(view.api.updateSettings).toHaveBeenCalledWith({ [key]: true })
    expect(view.toggle().getAttribute('aria-expanded')).toBe('true')
    const body = view.panel().querySelector<HTMLElement>('.memory-nerd-body')!
    expect(body.hidden).toBe(false)
    expect(body.id).toBe(view.toggle().getAttribute('aria-controls'))
    expect([...body.querySelectorAll('.memory-tile-value')].map(node => node.textContent)).toEqual(['0%', '—', '0MB'])
    expect(body.querySelector('.memory-biggest-name')!.textContent).toBe('Unlisted result')
    expect(body.querySelector('.memory-bar')!.getAttribute('aria-label')).toBe('Rows as read: 300 MB. Raw pages 300 MB')
    expect(body.textContent).toContain('Heap 512 MB · 40 MB free for reuse')
    // Nothing compressed: no sparkline, and the rows' sizes read with their meaning, not just as figures.
    expect(view.panel().querySelector('.memory-trend')).toBeNull()
    expect(body.querySelector('.memory-biggest li')!.textContent).toBe('Unlisted resultrows 200 MBstored 200 MBRaw')
    cleanups.splice(0).reverse().forEach(clean => clean())
    const again = await mount({ usedBytes: 300 * MB, globalBytes: 1024 * MB, detail: raw }, { [key]: true })
    expect(again.toggle().getAttribute('aria-expanded')).toBe('true')
    await act(async () => { again.toggle().click() })
    expect(again.api.updateSettings).toHaveBeenCalledWith({ [key]: false })
    expect(again.panel().querySelector<HTMLElement>('.memory-nerd-body')!.hidden).toBe(true)
  })

  it('keeps focus on the heading as it opens and closes, and carries Tab into and out of the pinned panel', async () => {
    const view = await mount({ usedBytes: 300 * MB, globalBytes: 1024 * MB, detail: raw })
    const toggle = view.toggle()
    toggle.focus()
    await act(async () => { toggle.click() })
    // The same button, still focused: the section must not remount its heading (Enter, then Space, in results-smoke).
    expect([view.toggle() === toggle, document.activeElement === toggle]).toEqual([true, true])
    await act(async () => { toggle.click() })
    expect([view.toggle() === toggle, document.activeElement === toggle]).toEqual([true, true])
    const trigger = document.body.querySelector<HTMLButtonElement>('.memory-indicator')!
    const before = document.createElement('button')
    before.textContent = 'First control'
    document.body.prepend(before)
    cleanups.push(() => before.remove())
    // A stop learns which way Tab went from where focus came from (happy-dom's focus() gives no relatedTarget). React's
    // onFocus listens for focusin; focus starts elsewhere so a stop that does nothing fails the check.
    const arrive = async (stop: HTMLElement, from: HTMLElement | null) => {
      await act(async () => { (document.activeElement as HTMLElement | null)?.blur() })
      await act(async () => { stop.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: from })) })
      return document.activeElement
    }
    // Tab from the Memory control lands on the stop after it, which hands focus to the panel's heading.
    const enter = trigger.nextElementSibling as HTMLElement
    expect(await arrive(enter, trigger)).toBe(toggle)
    const stops = view.panel().querySelectorAll<HTMLElement>(':scope > span[tabindex="0"]')
    const [first, last] = [stops[0], stops[stops.length - 1]]
    // Nothing follows the Memory control: Tab past the panel wraps to the page's first control, never back into a loop.
    expect(await arrive(last, toggle)).toBe(before)
    // Shift+Tab before the heading goes back to the Memory control.
    expect(await arrive(first, toggle)).toBe(trigger)
    // A control after the Memory control: Tab past the panel goes there, and Tab on from it passes the panel by.
    const after = document.createElement('button')
    after.textContent = 'Next control'
    trigger.parentElement!.after(after)
    cleanups.push(() => after.remove())
    expect(await arrive(last, toggle)).toBe(after)
    expect(await arrive(first, after)).toBe(before)
    // Shift+Tab from the page into the panel's end goes to its heading.
    expect(await arrive(last, before)).toBe(toggle)
    // After a press on the panel's text nothing is focused: Shift+Tab to the start stop goes back to the Memory control,
    // and Tab to the end stop leaves the panel, rather than stepping back to the heading.
    expect(await arrive(first, null)).toBe(trigger)
    view.panel().querySelector('.memory-heading')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(await arrive(last, null)).toBe(after)
    expect(await arrive(last, null)).toBe(toggle)
  })

  it('adds the packed chip and the ring\'s second tone once pages are compressed, alongside a warning or critical level', async () => {
    const warning = await mount({ usedBytes: 930 * MB, globalBytes: 1000 * MB, detail: packed }, { [key]: true })
    const row = warning.panel().querySelector<HTMLElement>('.memory-row[data-feature="results"]')!
    expect(row.dataset.level).toBe('warning')
    expect(row.querySelector('.memory-packed')!.textContent).toBe('−2,100 MB packed 4,410 MB of rows held in 2,310 MB')
    expect(row.textContent).toContain('New results may be truncated.')
    const ring = row.querySelector<HTMLElement>('.memory-ring')!
    expect([ring.hasAttribute('data-packed'), ring.style.getPropertyValue('--memory-fill'), ring.style.getPropertyValue('--memory-read')]).toEqual([true, '93%', '100%'])
    // Once something is compressed the heading carries the saved-share sparkline, drawn through ChartView.
    expect(warning.panel().querySelector('.memory-nerd-heading .memory-trend canvas')).not.toBeNull()
    expect(warning.panel().querySelector('.memory-biggest-name')!.textContent).toBe('Query 3 · Result 1')
    expect([...warning.panel().querySelectorAll('.memory-state')].map(node => node.textContent)).toEqual(['Packed', 'Unpacking 62%', 'Raw'])
    cleanups.splice(0).reverse().forEach(clean => clean())
    const critical = await mount({ usedBytes: 960 * MB, globalBytes: 1000 * MB, detail: packed })
    expect(critical.panel().querySelector<HTMLElement>('.memory-row[data-feature="results"]')!.dataset.level).toBe('critical')
    expect(document.body.querySelector('.memory-indicator')!.getAttribute('data-level')).toBe('critical')
    expect(critical.panel().querySelector('.memory-packed')).not.toBeNull()
  })
})
