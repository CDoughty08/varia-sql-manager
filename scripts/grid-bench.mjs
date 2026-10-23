import { _electron as electron, expect } from '@playwright/test'
import { cpus, totalmem } from 'node:os'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { shapes } from '../tests/fixtures/backend/shapes.mjs'
import { connectLive, liveRow, liveRowsSql } from './fixtures/live-rows.mjs'
import { enlargeOutput } from './fixtures/results-pane.mjs'
import { backendReady, documentTabs, gridCell, gridCellSelector, gridPart, jobNotice, outputStatus, part, statusBar, toolbarButton } from './fixtures/ui.mjs'

// End-to-end results grid benchmarks (npm run bench:grid): the built app in test mode at 1600 × 1000 (or the screen, if
// smaller), its grids fed by the fake backend's synthetic sets (tests/fixtures/backend.mjs, `-- varia-fake:` scripts).
// Measured in the renderer: GridView.frame() times, DOM elements and cache counters (window.__variaGrid), animation
// frames, long tasks, and through the DevTools protocol the main thread's task time and the heap after a collection.
// --live adds Copy and Save Results As of rows from VARIA_TEST_SQL_SERVER through the real backend. Writes
// artifacts/bench/grid.json, which scripts/check-bench.mjs compares with tests/bench/floors.json. Needs the Release
// backend and out/ (npm run check).
const live = process.argv.includes('--live')
const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (live && !process.env.VARIA_TEST_SQL_SERVER) throw new Error('--live needs VARIA_TEST_SQL_SERVER (and VARIA_TEST_SQL_USER and VARIA_TEST_SQL_PASSWORD for SQL authentication).')
if (live && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')
const output = resolve('artifacts/bench/grid.json')
await mkdir(resolve('artifacts/bench'), { recursive: true })
await rm(output, { force: true })
const profile = await mkdtemp(resolve('artifacts', 'grid-bench-profile-'))
const control = await mkdtemp(resolve('artifacts', 'grid-bench-control-'))
const saves = await mkdtemp(resolve('artifacts', 'grid-bench-save-'))
const baseEnv = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete baseEnv.ELECTRON_RUN_AS_NODE
const metrics = {}
let app, page, view
let step = 'launch'
const watchdog = setTimeout(() => { console.error(`Grid benchmarks timed out during: ${step}.`); app?.process()?.kill(); process.exit(1) }, 600000)

function record(id, value, unit, detail) {
  metrics[id] = { value, unit, ...detail ? { detail } : {} }
  console.log(`${id}: ${Math.abs(value) >= 100 ? Math.round(value).toLocaleString('en-US') : Number(value.toPrecision(3))} ${unit}${detail ? ` (${detail})` : ''}`)
}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.max(0, Math.ceil(p / 100 * values.length) - 1))]
const round = values => JSON.stringify(values.map(value => Math.round(value * 10) / 10))
// A fixed seed, so every run jumps to the same rows.
const random = (seed => () => {
  seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
})(20261010)

const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const status = () => outputStatus(page)
const grid = (index = 0) => page.locator(`[data-result-grid][data-result-index="${index}"]`)
const cell = (row, column) => gridCell(grid(), row, column)
const stats = () => page.evaluate(() => window.__variaGrid.stats())
const resetStats = () => page.evaluate(() => window.__variaGrid.reset())
/** Starts a named segment: the watchdog names it, and long tasks are counted against it. */
async function segment(name) {
  step = name
  await page.evaluate(value => window.__benchSegments?.push({ name: value, at: performance.now() }), name)
}
const activeText = () => grid().evaluate(root => document.getElementById(root.getAttribute('aria-activedescendant') ?? '')?.textContent)
async function run(sql, timeout = 60000) {
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(sql)
  await page.keyboard.press('F5')
  await expect(status()).toContainText(/^Query executed successfully\./, { timeout })
}

async function launch(env) {
  app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  // Smoke windows stay hidden, and a hidden window gets about one animation frame a second; show it without focus.
  view = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0], area = screen.getPrimaryDisplay().workAreaSize
    window.setContentSize(Math.min(1600, area.width), Math.min(1000, area.height))
    window.showInactive()
    const [width, height] = window.getContentSize()
    return { width, height }
  })
  // Closing a typed query asks first; answer Don't Save.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await backendReady(page).waitFor({ timeout: 60000 })
  await page.evaluate(gridPart => {
    /** What grid 0 shows: its first row and column in view, how many cells in view still load, and how many rows show. */
    window.__benchView = () => {
      const root = document.querySelector('[data-result-grid][data-result-index="0"]')
      if (!root) return { signature: '', loading: 0, rows: 0 }
      const body = root.querySelector(gridPart.scroller).getBoundingClientRect(), head = root.querySelector(gridPart.head).getBoundingClientRect()
      const corner = root.querySelector(gridPart.corner).getBoundingClientRect()
      const inside = box => box.width > 0 && box.right > corner.right + 1 && box.left < body.right - 1 && box.bottom > head.bottom + 1 && box.top < body.bottom - 1
      let firstRow = Infinity, rows = 0, loading = 0, firstColumn = '', left = Infinity
      for (const row of root.querySelectorAll(gridPart.row)) {
        if (row.style.display === 'none' || !inside(row.getBoundingClientRect())) continue
        rows++
        firstRow = Math.min(firstRow, Number(row.querySelector(gridPart.rowHeader).textContent))
        for (const item of row.querySelectorAll(gridPart.loadingCell)) if (item.style.display !== 'none' && inside(item.getBoundingClientRect())) loading++
      }
      for (const header of root.querySelectorAll(gridPart.columnHeader)) {
        const box = header.getBoundingClientRect()
        if (header.style.display !== 'none' && box.width > 0 && box.right > corner.right + 1 && box.left < left) { left = box.left; firstColumn = header.textContent }
      }
      return { signature: `${firstRow}:${firstColumn}`, loading, rows }
    }
  }, gridPart)
}

async function close() {
  if (!app) return
  const closed = await Promise.race([app.close().then(() => true, () => false), new Promise(done => setTimeout(() => done(false), 15000))])
  if (!closed) app.process()?.kill('SIGKILL')
  app = undefined
}

/** Moves grid 0's scroll bars to fractions of their range and resolves, in ms, once the rows there are painted. */
const jump = (top, left) => page.evaluate(async ({ top, left, part }) => {
  const scroller = document.querySelector('[data-result-grid][data-result-index="0"] ' + part)
  const before = window.__benchView().signature, started = performance.now()
  scroller.scrollTop = top * (scroller.scrollHeight - scroller.clientHeight)
  if (left !== null) scroller.scrollLeft = left * (scroller.scrollWidth - scroller.clientWidth)
  for (;;) {
    await new Promise(done => requestAnimationFrame(done))
    const now = window.__benchView()
    if (now.signature !== before && now.rows > 0 && now.loading === 0) return performance.now() - started
    if (performance.now() - started > 15000) throw new Error(`Grid 0 did not paint after a jump to ${top}, ${left}: ${JSON.stringify(now)}.`)
  }
}, { top, left: left ?? null, part: gridPart.scroller })
/** Fractions at least `gap` from the previous one, so every jump moves the rows in view. */
function fractions(count, gap) {
  const list = []
  for (let previous = 0; list.length < count;) {
    const next = random()
    if (Math.abs(next - previous) >= gap) list.push(previous = next)
  }
  return list
}

try {
  await launch({ ...baseEnv, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const taskSeconds = async () => (await cdp.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'TaskDuration').value
  const heapBytes = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize }
  await toolbarButton(page, 'Connect').click()
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await enlargeOutput(page)
  // A first run compiles the grid's code paths; nothing is measured until the next one.
  step = 'warm-up'
  await run('-- varia-fake: sets=W1*100,N1*10')
  await expect(cell(0, 1)).toHaveText(shapes.W1.row(0)[1])
  await page.evaluate(() => {
    window.__benchLongTasks = []
    window.__benchSegments = []
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__benchLongTasks.push({ ms: Math.round(entry.duration), at: entry.startTime }) }).observe({ type: 'longtask' })
    // When the results service opens each set (its resultSet.opened event), for the first paint below.
    const client = window.__variaResults, open = client.open.bind(client)
    window.__benchOpened = []
    client.open = descriptor => { window.__benchOpened.push(performance.now()); return open(descriptor) }
  })

  await segment('first paint')
  const paints = []
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate(({ cell, loading }) => {
      window.__benchOpened.length = 0
      for (const element of document.querySelectorAll('[data-result-grid]')) element.dataset.stale = ''
      window.__benchPainted = new Promise(done => {
        const check = () => {
          const first = document.querySelector('[data-result-grid]:not([data-stale]) ' + cell)
          if (window.__benchOpened.length && first && !first.matches(loading) && first.textContent === '0') done(performance.now() - window.__benchOpened[0])
          else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      })
    }, { cell: gridCellSelector(0, 0), loading: gridPart.loadingCell })
    await run('-- varia-fake: sets=W1*100000')
    paints.push(await page.evaluate(() => window.__benchPainted))
  }
  record('grid.firstPaintMs', percentile(paints, 50), 'ms', `resultSet.opened → row 1 painted, 100,000 W1 rows: ${round(paints)}`)

  await segment('streaming')
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('-- varia-fake: sets=W1*1000000@250000')
  const streamStart = { task: await taskSeconds(), wall: performance.now() }
  await page.keyboard.press('F5')
  await expect(status()).toContainText('Query executed successfully.', { timeout: 60000 })
  const streamSeconds = (performance.now() - streamStart.wall) / 1000, streamBusy = await taskSeconds() - streamStart.task
  await expect(grid()).toHaveAttribute('aria-label', 'Result 1 of 1, 1,000,000 rows, 8 columns')
  record('grid.stream.busyPercent', streamBusy / streamSeconds * 100, '%', `main-thread task time ${streamBusy.toFixed(2)} s of ${streamSeconds.toFixed(1)} s while 1,000,000 rows streamed at 250,000 a second`)

  await segment('a million rows')
  await run('-- varia-fake: sets=W1*1000000')
  await expect(cell(0, 1)).toHaveText(shapes.W1.row(0)[1])
  await cell(0, 0).click()
  const heapBefore = await heapBytes()
  await page.keyboard.press('Control+End')
  await expect.poll(activeText).toBe(String(shapes.W1.row(999_999)[7] ?? 'NULL'))
  await page.keyboard.press('Control+Home')
  await expect.poll(activeText).toBe('0')
  const heapAfter = await heapBytes()
  record('grid.heapGrowthMb', (heapAfter - heapBefore) / 1e6, 'MB', `JS heap after a collection: ${(heapBefore / 1e6).toFixed(1)} MB before, ${(heapAfter / 1e6).toFixed(1)} MB after`)

  await segment('wheel')
  const box = await grid().locator(gridPart.scroller).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await resetStats()
  await page.evaluate(() => {
    const watch = window.__benchFrames = { intervals: [], running: true }
    let last = performance.now()
    const loop = now => { watch.intervals.push(now - last); last = now; if (watch.running) requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  })
  for (const end = Date.now() + 3000; Date.now() < end;) { await page.mouse.wheel(0, 100); await page.waitForTimeout(16) }
  const intervals = await page.evaluate(() => { window.__benchFrames.running = false; return window.__benchFrames.intervals.slice(1) })
  const wheeled = await stats()
  const wheelTop = Number((await page.evaluate(() => window.__benchView().signature)).split(':')[0])
  if (!(wheelTop > 100)) throw new Error(`The wheel did not scroll the grid (row ${wheelTop} at the top).`)
  record('grid.wheel.frameP95Ms', percentile(wheeled.frames, 95), 'ms', `${wheeled.frames.length} frames, max ${Math.max(...wheeled.frames).toFixed(1)} ms; scrolled to row ${wheelTop.toLocaleString('en-US')}`)
  record('grid.wheel.frameIntervalP95Ms', percentile(intervals, 95), 'ms', `${intervals.length} animation frames in 3 s`)
  record('grid.wheel.maxFrameGapMs', Math.max(...intervals), 'ms', `${intervals.length} animation frames in 3 s`)
  record('grid.w1.elements', wheeled.nodes, 'elements', `1 grid, ${view.width} × ${view.height} window`)

  await segment('PageDown')
  await cell(wheelTop, 0).click()
  for (let press = 0; press < 40; press++) await page.keyboard.press('PageDown')
  await page.keyboard.press('Control+Home')
  await expect.poll(activeText).toBe('0')

  await segment('sweep and jumps')
  for (let index = 1; index <= 50; index++) await jump(index / 50)
  const jumps = []
  for (const top of fractions(300, 0.002)) jumps.push(await jump(top))
  const cached = (await stats()).client
  record('grid.jump.paintP95Ms', percentile(jumps, 95), 'ms', `300 scroll bar jumps over 1,000,000 rows, median ${percentile(jumps, 50).toFixed(0)} ms, max ${Math.max(...jumps).toFixed(0)} ms`)
  record('grid.cache.uiWindows', cached.uiWindows, 'windows', 'after a sweep of 50 views and 300 jumps')
  record('grid.cache.uiMiUnits', cached.uiUnits / 1048576, 'Mi units', 'after a sweep of 50 views and 300 jumps')
  record('grid.cache.workerMiB', cached.workerBytes / 1048576, 'MiB', `${cached.workerPages} pages after a sweep of 50 views and 300 jumps`)

  /**
   * Scroll bar jumps in grid 0 to fresh rows and columns: frame() times, and each jump's main-thread task time from the
   * DevTools protocol, which adds the style, layout, paint and compositing a jump causes to frame()'s JS. A segment with
   * a long task runs once more, as results-smoke's segments do; the long tasks of its last run count.
   */
  async function jumpSegment(name, count) {
    for (let attempt = 1; ; attempt++) {
      const label = attempt === 1 ? name : `${name} (again)`
      await segment(label)
      await resetStats()
      const tops = fractions(count, 0.05), lefts = fractions(count, 0.05), tasks = []
      for (let index = 0; index < count; index++) {
        const before = await taskSeconds()
        await jump(tops[index], lefts[index])
        tasks.push((await taskSeconds() - before) * 1000)
      }
      const long = await page.evaluate(value => {
        const start = window.__benchSegments.findLast(item => item.name === value).at
        return window.__benchLongTasks.filter(task => task.at >= start && task.ms > 50).map(task => task.ms)
      }, label)
      if (long.length === 0 || attempt === 2) return { stats: await stats(), tasks, long, attempt }
    }
  }
  /**
   * Continuous scrolling down grid 0 for 3 s, 400 px (20 rows) every animation frame, natively below the scroll cap and
   * past it (a cap of 50,000 px) through the grid's own wheel handling, which takes the synthetic wheel events a page
   * cannot scroll with. The animation-frame intervals and the long tasks started meanwhile are what flicking through
   * wide results feels like.
   */
  const wheelLongTasks = []
  async function wheelSegment(name, cap) {
    await segment(name)
    await page.evaluate(value => window.__variaGrid.setScrollCap(value), cap)
    const result = await page.evaluate(async ({ label, scrollerPart }) => {
      const frame = () => new Promise(done => requestAnimationFrame(done))
      const scroller = document.querySelector('[data-result-grid][data-result-index="0"] ' + scrollerPart)
      scroller.scrollTop = 0
      scroller.scrollLeft = 0
      for (let index = 0; index < 5; index++) await frame()
      const box = scroller.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2, intervals = []
      const started = performance.now()
      let last = started
      while (performance.now() - started < 3000) {
        const wheel = new WheelEvent('wheel', { deltaY: 400, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true })
        scroller.dispatchEvent(wheel)
        if (!wheel.defaultPrevented) scroller.scrollTop += 400
        await frame()
        const now = performance.now()
        intervals.push(now - last)
        last = now
      }
      const start = window.__benchSegments.findLast(item => item.name === label).at
      return { intervals, rows: Number(window.__benchView().signature.split(':')[0]), long: window.__benchLongTasks.filter(task => task.at >= start && task.ms > 50).map(task => task.ms) }
    }, { label: name, scrollerPart: gridPart.scroller })
    await page.evaluate(() => window.__variaGrid.setScrollCap())
    if (!(result.rows > 1000)) throw new Error(`${name}: the grid scrolled to row ${result.rows} only.`)
    wheelLongTasks.push(...result.long)
    return [percentile(result.intervals, 95), 'ms', `${result.intervals.length} animation frames in 3 s at 400 px a frame, to row ${result.rows.toLocaleString('en-US')}; median ${percentile(result.intervals, 50).toFixed(1)} ms, longest ${Math.max(...result.intervals).toFixed(1)} ms; long tasks ${JSON.stringify(result.long)}`]
  }
  const jumpLongTasks = []
  await segment('300 columns')
  await run('-- varia-fake: sets=X1*5000')
  await expect(cell(0, 0)).toHaveText(String(shapes.X1.row(0)[0]))
  await cell(0, 0).click()
  const wide = await jumpSegment('300 columns: jumps', 60)
  jumpLongTasks.push(...wide.long)
  record('grid.x1.jumpFrameP95Ms', percentile(wide.stats.frames, 95), 'ms', `${wide.stats.frames.length} frames over 60 jumps, max ${Math.max(...wide.stats.frames).toFixed(1)} ms`)
  record('grid.x1.jumpTaskP95Ms', percentile(wide.tasks, 95), 'ms', `main-thread task time per jump over 60 jumps, median ${percentile(wide.tasks, 50).toFixed(1)} ms, max ${Math.max(...wide.tasks).toFixed(1)} ms`)
  record('grid.x1.elements', wide.stats.nodes, 'elements', `1 grid of 300 columns, ${view.width} × ${view.height} window`)
  await jump(0, 0)
  await segment('300 columns: across')
  await resetStats()
  const steps = await page.evaluate(async scrollerPart => {
    const scroller = document.querySelector('[data-result-grid][data-result-index="0"] ' + scrollerPart)
    let count = 0
    while (scroller.scrollLeft < scroller.scrollWidth - scroller.clientWidth - 1) {
      scroller.scrollLeft += 120
      count++
      await new Promise(done => requestAnimationFrame(done))
    }
    await new Promise(done => requestAnimationFrame(done))
    return count
  }, gridPart.scroller)
  const across = await stats()
  record('grid.x1.horizontalFrameP95Ms', percentile(across.frames, 95), 'ms', `${across.frames.length} frames over ${steps} steps of 120 px, max ${Math.max(...across.frames).toFixed(1)} ms`)
  record('grid.x1.wheelIntervalP95Ms', ...await wheelSegment('300 columns: wheel', undefined))
  record('grid.x1.virtualWheelIntervalP95Ms', ...await wheelSegment('300 columns: wheel past the cap', 50_000))

  // 300 bit columns: the narrowest columns put the most cells in view.
  await segment('narrow columns')
  await run('-- varia-fake: sets=X2*5000')
  await expect(cell(0, 0)).toHaveText(shapes.X2.row(0)[0])
  await cell(0, 0).click()
  const narrow = await jumpSegment('narrow columns: jumps', 40)
  jumpLongTasks.push(...narrow.long)
  record('grid.x2.jumpTaskP95Ms', percentile(narrow.tasks, 95), 'ms', `main-thread task time per jump over 40 jumps, median ${percentile(narrow.tasks, 50).toFixed(1)} ms, max ${Math.max(...narrow.tasks).toFixed(1)} ms; frame() p95 ${percentile(narrow.stats.frames, 95).toFixed(1)} ms`)
  record('grid.x2.elements', narrow.stats.nodes, 'elements', `1 grid of 300 bit columns, ${view.width} × ${view.height} window`)
  record('grid.x2.wheelIntervalP95Ms', ...await wheelSegment('narrow columns: wheel', undefined))
  record('grid.x2.virtualWheelIntervalP95Ms', ...await wheelSegment('narrow columns: wheel past the cap', 50_000))
  record('grid.wide.wheelLongTasks', wheelLongTasks.length, 'tasks', `over 50 ms in those four wheel segments: ${wheelLongTasks.length ? wheelLongTasks.join(', ') + ' ms' : 'none'}`)
  record('grid.jump.longTasks', jumpLongTasks.length, 'tasks', `over 50 ms in the 300-column and bit-column jump segments (a segment with one runs once more): ${jumpLongTasks.length ? jumpLongTasks.join(', ') + ' ms' : 'none'}; attempts ${wide.attempt} and ${narrow.attempt}`)

  await segment('stacked sets')
  await run('-- varia-fake: sets=M1*1000')
  const lastGrid = page.getByRole('grid', { name: 'Result 1000 of 1000, 1 row, 1 column', exact: true })
  for (let index = 0; index < 400 && !(await lastGrid.count()); index++) {
    await page.locator(part.resultStack).evaluate(stack => { stack.scrollTop += stack.clientHeight * 4 })
    await page.waitForTimeout(25)
  }
  await expect(lastGrid).toBeVisible()

  await segment('a 2 MB value')
  await run('-- varia-fake: sets=L1*3')
  await cell(2, 1).click()
  await expect(documentTabs(page).getByRole('tab').filter({ hasText: 'doc1.xml' })).toHaveAttribute('aria-selected', 'true', { timeout: 30000 })
  // The value fills in a chunk a frame, formatted as one line per item plus its root's two (as results-smoke checks).
  const items = shapes.L1.row(2)[1].split('<item ').length - 1
  const lastLine = async () => Math.max(...(await page.locator('.margin-view-overlays .line-numbers').allTextContents()).map(Number))
  await expect.poll(async () => { await textbox().focus(); await page.keyboard.press('Control+End'); return lastLine() }, { timeout: 30000 }).toBe(2 + 4 * items)
  await page.keyboard.press('Control+W')
  await expect(documentTabs(page).getByRole('tab')).toHaveCount(1)

  // Each long task, by the segment it started in. results-smoke holds every segment to 50 ms (with one retry); here the
  // count is reported and only the longest has a floor, which a freeze would break.
  const { tasks, segments } = await page.evaluate(() => ({ tasks: window.__benchLongTasks, segments: window.__benchSegments }))
  const by = tasks.map(task => `${segments.findLast(item => item.at <= task.at)?.name ?? 'start'} ${task.ms} ms`)
  record('grid.longTasks', tasks.filter(task => task.ms > 50).length, 'tasks', `from the first paint to the 2 MB value: ${by.length ? by.join(', ') : 'none'}`)
  record('grid.longTaskMaxMs', Math.max(0, ...tasks.map(task => task.ms)), 'ms', `the longest of ${tasks.length} long tasks`)
  await close()

  if (live) {
    step = 'live copy'
    await launch(baseEnv)
    await connectLive(page, expect)
    const eol = process.platform === 'win32' ? '\r\n' : '\n'
    const copyRows = 100_000
    const expected = Array.from({ length: copyRows }, (_, index) => liveRow(index + 1).map(value => value ?? 'NULL').join('\t')).join(eol)
    await run(liveRowsSql(copyRows), 120000)
    await expect(grid()).toHaveAttribute('aria-label', 'Result 1 of 1, 100,000 rows, 8 columns')
    await cell(0, 0).click()
    await page.keyboard.press('Control+A')
    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
    const copyStarted = performance.now()
    await page.keyboard.press('Control+C')
    // Electron's clipboard reads are asynchronous.
    await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.readText()).length), { intervals: [20], timeout: 60000 }).toBe(expected.length)
    const copyMs = performance.now() - copyStarted
    if (await app.evaluate(({ clipboard }) => clipboard.readText()) !== expected) throw new Error('The live copy differs from the rows the server returned.')
    record('grid.live.copyMs', copyMs, 'ms', `${copyRows.toLocaleString('en-US')} rows × 8 columns, ${(Buffer.byteLength(expected) / 1e6).toFixed(1)} MB of text`)

    step = 'live save'
    const saveRows = 1_000_000, file = join(saves, 'grid-bench.csv')
    await run(liveRowsSql(saveRows), 180000)
    await expect(grid()).toHaveAttribute('aria-label', 'Result 1 of 1, 1,000,000 rows, 8 columns')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, file)
    await cell(0, 0).click()
    const saveStarted = performance.now()
    await page.keyboard.press('Control+S')
    await expect(jobNotice(page)).toHaveText('Saved 1,000,000 rows to grid-bench.csv.', { timeout: 120000 })
    const saveMs = performance.now() - saveStarted
    const saved = await readFile(file)
    let lineCount = 0
    for (let index = saved.indexOf(10); index !== -1; index = saved.indexOf(10, index + 1)) lineCount++
    if (lineCount !== saveRows + 1) throw new Error(`The saved CSV has ${lineCount} lines, not ${saveRows + 1}.`)
    record('grid.live.saveMs', saveMs, 'ms', `${saveRows.toLocaleString('en-US')} rows × 8 columns as CSV, ${(saved.length / 1e6).toFixed(0)} MB`)
    await close()
  }

  await writeFile(output, JSON.stringify({
    harness: 'grid', date: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    cpus: cpus().length, cpu: cpus()[0]?.model ?? 'unknown', memoryBytes: totalmem(), view, live, metrics
  }, null, 2) + '\n')
  console.log(`Grid benchmarks written to ${output}.`)
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'grid-bench-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await close().catch(() => {})
  for (const directory of [profile, control, saves]) await rm(directory, { recursive: true, force: true })
}
