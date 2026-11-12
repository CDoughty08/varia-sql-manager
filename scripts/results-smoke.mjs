// The results grid against the fake backend's synthetic result sets (`-- varia-fake:` scripts, tests/fixtures/backend):
// streaming, a million rows past the scroll cap, wide results, stacked sets, ARIA, selection and copy, column resizing,
// Save Results As, XML, JSON and plan values in their own tabs, Messages, lifecycle, the memory indicator, the grid's
// menu, styling, panes and tabs. Then, with VARIA_TEST_SQL_SERVER set, part B repeats the essentials against that
// server through the Release backend. No assertion depends on absolute pixel sizes.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { shapes } from '../tests/fixtures/backend/shapes.mjs'
import { connectLive, liveColumns, liveRow, liveRowsSql } from './fixtures/live-rows.mjs'
import { checkClientStatistics } from './fixtures/client-statistics.mjs'
import { enlargeOutput, sizeResultStack } from './fixtures/results-pane.mjs'
import { expandExplorerPath, explorerRow } from './fixtures/explorer-tree.mjs'
import {
  activeDocument, anyResultGrid, backendReady, columnProfile, documentTabs, emptyState, emptyStateDetail, emptyStateIcon, emptyStateTitle, errorMessages, gridCell, gridCellSelector, gridPart, jobNotice,
  jobProgress, kindIcon, lostServerRows, matching, memoryBreakdown, memoryIndicator, memoryUsage, menuItemNames, messageLines, messages, messagesStrip, outputAnnouncer, outputEmpty, outputPane, outputStatus,
  outputPaneIds, outputPanel, outputToolbar, outputView, paneTab, part, planViewer, planCanvas, queryBar, queryBarButton, queryFacts, queryStatus, quickInput, quickInputActive, resultClose, resultGrid, resultSplitters, resultsToolbar, resultToggle, statusBar,
  pivotPanel, profileCard, profileFigures, resultsSearchAnnouncer, resultsSearchCount, statusSegment, toastAnnouncer, toastMessage, toasts, toolbarButton, unsavedMark
} from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'results-profile-'))
const control = await mkdtemp(resolve('artifacts', 'results-control-'))
await mkdir(join(control, 'hold'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
const linux = process.platform === 'linux', eol = process.platform === 'win32' ? '\r\n' : '\n'
// Renderer tasks in the measured segments, from a trace of the renderer's main thread: none with 50 ms of CPU time on
// Linux (100 ms elsewhere), and none of 250 ms by the clock; a segment over either runs once more before it fails. A
// shared machine stretches short tasks by the clock (a 36 ms task had 7 ms of CPU time), which made clock-only limits
// flaky; the CPU time is what the grid itself spends.
const cpuLimit = linux ? 50 : 100, clockLimit = 250
const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (process.env.VARIA_TEST_SQL_SERVER && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')
// Part B relaunches the app on the real backend; every helper below follows these to the current one.
let application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
let child = application.process()
const watchdog = setTimeout(() => { console.error('Results suite exceeded its time limit.'); child?.kill(); process.exit(1) }, 900_000)
let page = await application.firstWindow()
page.setDefaultTimeout(30000)
const failures = [], cleanups = []
page.on('pageerror', error => failures.push(error.message))

const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText())
const setClipboard = text => application.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
const status = () => outputStatus(page)
const queryTabs = () => documentTabs(page).getByRole('tab')
const server = () => page.getByLabel('Query server', { exact: true })
/** A result's grid by the result's name, as its accessible name starts ("Result 2 of 3, …"). */
const grid = (name = 'Result 1') => resultGrid(page, name)
const scroller = (name = 'Result 1') => grid(name).locator(gridPart.scroller)
const cell = (row, column, of = grid()) => gridCell(of, row, column)
const header = (name, of = grid()) => of.getByRole('columnheader', { name, exact: true })
/** A grid's strip, beside the grid rather than inside its table structure. */
const strip = (name = 'Result 1') => grid(name).locator('xpath=..').locator(gridPart.strip)
/** A row's number as drawn in the sticky row-number column (screen readers read the row's own header instead). */
const rowNumber = (row, of = grid()) => of.locator(gridPart.rowNumber + ':visible').filter({ hasText: new RegExp(`^${row + 1}$`) })
const outputTab = name => outputView(page, name)
const planParseCalls = async () => (await readFile(join(control, 'calls.jsonl'), 'utf8')).split('\n').filter(line => line.includes('"method":"plans.parse"')).length
const stats = () => page.evaluate(() => window.__variaGrid.stats())
const w1 = row => shapes.W1.row(row).map(value => value ?? 'NULL')
const w1Names = shapes.W1.columns.map(column => column.name)
const tsv = rows => rows.map(row => row.join('\t')).join(eol)
const p95 = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0 }
async function typeSql(sql) {
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(sql)
}
/** Runs a script and waits until the status line says it ended (or, with `running`, that it is executing). */
async function run(sql, { running = false } = {}) {
  await typeSql(sql)
  await page.keyboard.press('F5')
  if (running) await expect(status()).toContainText(/^Executing · /)
  else await expect(status()).toContainText(/^Completed( with errors)? · /)
}
/** The active cell as screen readers find it: the element `aria-activedescendant` names, with its row and column. */
const active = (name = 'Result 1') => grid(name).evaluate(root => {
  const id = root.getAttribute('aria-activedescendant'), element = id ? document.getElementById(id) : null
  if (!element || !root.contains(element)) return { id, resolved: false }
  return {
    id, resolved: true, role: element.getAttribute('role'), row: Number(element.parentElement.getAttribute('aria-rowindex')) - 2, column: Number(element.getAttribute('aria-colindex')) - 2,
    selected: element.getAttribute('aria-selected'), label: element.getAttribute('aria-label'), text: element.textContent
  }
})
/** Records the active cell's name each time aria-activedescendant moves, as a screen reader reads it then. */
const watchActiveNames = (name = 'Result 1') => grid(name).evaluate(root => {
  window.__variaActiveObserver?.disconnect()
  window.__variaActiveNames = []
  window.__variaActiveObserver = new MutationObserver(() => {
    const element = document.getElementById(root.getAttribute('aria-activedescendant'))
    window.__variaActiveNames.push(element?.getAttribute('aria-label') ?? element?.textContent ?? '')
  })
  window.__variaActiveObserver.observe(root, { attributes: true, attributeFilter: ['aria-activedescendant'] })
})
const activeNames = () => page.evaluate(() => { window.__variaActiveObserver.disconnect(); return window.__variaActiveNames })
/** The active cell once keys and drags are painted: its row and the scroll position no longer change. */
async function settled(name = 'Result 1') {
  const position = async () => JSON.stringify([(await active(name)).row, await scroller(name).evaluate(element => element.scrollTop)])
  let previous
  await expect.poll(async () => { const now = await position(), same = now === previous; previous = now; return same }, { intervals: [100] }).toBe(true)
  return active(name)
}
/** The first and last row numbers drawn inside the grid's body; NaN, which fails every comparison, before a scroll's rows are drawn
 * (Math.min of none is Infinity, which passed `toBeGreaterThan` polls before any row was there). */
const visibleRows = (name = 'Result 1') => grid(name).evaluate((root, gridPart) => {
  const body = root.querySelector(gridPart.scroller).getBoundingClientRect(), head = root.querySelector(gridPart.head).getBoundingClientRect()
  const numbers = [...root.querySelectorAll(gridPart.row)].filter(row => row.style.display !== 'none').filter(row => {
    const box = row.getBoundingClientRect()
    return box.top >= head.bottom - 1 && box.bottom <= body.bottom + 1
  }).map(row => Number(row.querySelector(gridPart.rowHeader).textContent))
  return numbers.length === 0 ? [NaN, NaN] : [Math.min(...numbers), Math.max(...numbers)]
}, gridPart)
/** The shown rows' numbers in DOM order, which browse-mode screen readers follow: ascending, whatever was scrolled. */
const rowOrder = (name = 'Result 1') => grid(name).evaluate((root, row) => [...root.querySelectorAll(row)].filter(item => item.style.display !== 'none').map(item => Number(item.getAttribute('aria-rowindex'))), gridPart.row)
const ascending = values => values.length > 0 && values.every((value, index) => index === 0 || value > values[index - 1])
/** True when the element is drawn inside the grid's body, not scrolled away. */
const insideGrid = locator => locator.evaluate((element, { grid, scroller }) => {
  const root = element.closest(grid), box = element.getBoundingClientRect(), body = root.querySelector(scroller).getBoundingClientRect()
  return element.style.display !== 'none' && box.left >= body.left - 1 && box.right <= body.right + 1 && box.top >= body.top - 1 && box.bottom <= body.bottom + 1
}, { grid: gridPart.root, scroller: gridPart.scroller })
/** How many cells inside the grid's body are still waiting for their rows. */
const loadingInView = (name = 'Result 1') => grid(name).evaluate((root, gridPart) => {
  const body = root.querySelector(gridPart.scroller).getBoundingClientRect(), head = root.querySelector(gridPart.head).getBoundingClientRect()
  return [...root.querySelectorAll(gridPart.loadingCell)].filter(cell => {
    const box = cell.getBoundingClientRect()
    return cell.style.display !== 'none' && cell.parentElement.style.display !== 'none' && box.width > 0 && box.right > body.left && box.left < body.right && box.bottom > head.bottom && box.top < body.bottom
  }).length
}, gridPart)
let tracer
/** Traces the renderer from now on; the returned function stops and gives each main-thread task's clock and CPU ms. */
async function startTrace() {
  if (tracer?.page !== page) tracer = { page, cdp: await page.context().newCDPSession(page) }
  const { cdp } = tracer, events = []
  const collect = data => { for (const event of data.value) events.push(event) }
  cdp.on('Tracing.dataCollected', collect)
  const complete = new Promise(done => cdp.once('Tracing.tracingComplete', done))
  // DevTools' timeline category names the main thread's tasks RunTask, with their thread (CPU) time.
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['toplevel', 'disabled-by-default-devtools.timeline'] }, transferMode: 'ReportEvents' })
  return async () => {
    await cdp.send('Tracing.end')
    await complete
    cdp.off('Tracing.dataCollected', collect)
    // The page's main thread is the renderer main thread that ran the most tasks.
    const threads = events.filter(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain')
    const tasks = thread => events.filter(event => event.ph === 'X' && event.name === 'RunTask' && event.pid === thread.pid && event.tid === thread.tid)
    const main = threads.map(tasks).sort((a, b) => b.length - a.length)[0] ?? []
    // A segment runs thousands of tasks: none would mean the trace missed the page, not that the page was idle.
    if (main.length === 0) throw new Error('The trace holds no tasks of the renderer\'s main thread.')
    return main.map(event => ({ clock: event.dur / 1000, cpu: (event.tdur ?? event.dur) / 1000 }))
  }
}
/**
 * Runs `segment` with the renderer traced; a segment over a limit runs once more before it fails. `over` names a
 * segment's own timing limit it went over (its frames' p95, say), or returns '': it gets the same second run.
 */
async function measured(name, segment, over = () => '') {
  for (let attempt = 1; ; attempt++) {
    const stop = await startTrace()
    await segment()
    const tasks = await stop(), long = tasks.filter(task => task.clock >= 50 || task.cpu >= 50)
    const shown = JSON.stringify(long.map(task => `${Math.round(task.clock)}/${Math.round(task.cpu)}`))
    console.log(`Results ${name}: of ${tasks.length} tasks, those of 50 ms by the clock / of CPU time: ${shown} (attempt ${attempt}).`)
    const exceeded = long.some(task => task.cpu >= cpuLimit || task.clock >= clockLimit)
      ? `renderer tasks ${shown} (limits ${cpuLimit} ms of CPU time, ${clockLimit} ms by the clock)` : await over()
    if (!exceeded) return
    if (attempt === 2) throw new Error(`${name}: ${exceeded}`)
    console.log(`Results ${name}: ${exceeded}; running it once more.`)
  }
}
/** `over` for `measured`: the frames' p95 when it is over `limit` ms on Linux, where the limits apply. */
const framesOver = (frames, limit) => linux && p95(frames) > limit ? `frames p95 ${p95(frames).toFixed(2)} ms (limit ${limit} ms)` : ''
/** A theme token's color as computed styles report it, for comparison with an element's computed color. */
const tokenColor = name => page.evaluate(value => {
  const probe = document.createElement('div')
  probe.style.color = `var(--varia-${value.replaceAll('.', '-')})`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}, name)
const computed = (locator, pseudo) => locator.evaluate((element, which) => { const style = getComputedStyle(element, which); return { color: style.color, background: style.backgroundColor } }, pseudo ?? null)
/** Pixels of focusBorder's color along the top edge of grid 0, away from its first cell, as the window draws them. */
async function focusRingPixels() {
  const box = await grid().boundingBox(), rgb = (await tokenColor('focusBorder')).match(/\d+/g).slice(0, 3).map(Number)
  return application.evaluate(async ({ BrowserWindow }, { rect, rgb }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect), bitmap = image.toBitmap()
    const near = (offset, order) => order.every((value, index) => Math.abs(bitmap[offset + index] - value) <= 8)
    let count = 0
    // Raw bitmaps are BGRA on most platforms; either order counts.
    for (let offset = 0; offset < bitmap.length; offset += 4) if (near(offset, [rgb[2], rgb[1], rgb[0]]) || near(offset, rgb)) count++
    return count
  }, { rect: { x: Math.round(box.x + 200), y: Math.round(box.y), width: 300, height: 2 }, rgb })
}

try {
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  // A hidden window draws about once a second; the grid's frames and the scroll steps need real ones.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
  // Closing an unsaved query asks first; answer Don't Save.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await toolbarButton(page, 'Connect').click()
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // The output pane gets most of the window: the editor above it shrinks to a few lines.
  await enlargeOutput(page)

  // A first run compiles the grid's code paths; long tasks are measured from the next one.
  await run('-- varia-fake: sets=W1*100,N1*10')
  await expect(cell(0, 1)).toHaveText(w1(0)[1])

  // 1. Streaming: rows show while the script runs and their count grows, Ctrl+End reaches the last row read so far,
  // and the run completes. (`hold` keeps it running after its rows until the control file goes.)
  await measured('streaming', async () => {
    await writeFile(join(control, 'hold', 'query.execute'), '')
    await run('-- varia-fake: sets=W1*200000@20000 hold', { running: true })
    await expect(cell(0, 1)).toHaveText(w1(0)[1])
    await expect(grid()).toHaveAttribute('aria-busy', 'true')
    await expect(grid()).toHaveAttribute('aria-label', /^Result 1 of 1, [\d,]+ rows, 8 columns, still loading$/)
    const rows = async () => Number((await status().textContent()).match(/· ([\d,]+) rows?/)?.[1].replaceAll(',', '') ?? 0)
    const early = await rows()
    await expect.poll(rows).toBeGreaterThan(early)
    await cell(0, 0).click()
    // The end is the last column of a row past the first page, with its text read once its rows are. The text alone is not
    // enough: row 0, where the click leaves the active cell, reads '0' in its first and last columns, so a slow frame let
    // the start cell pass for the end before the grid painted the move.
    const reachedEnd = state => state.resolved && state.column === 7 && state.row > 1000 && state.text === w1(state.row)[7]
    await expect.poll(active).toMatchObject({ resolved: true, row: 0, column: 0 })
    expect(reachedEnd(await active()), 'the start cell does not pass for the end').toBe(false)
    await page.keyboard.press('Control+End')
    await expect.poll(async () => reachedEnd(await active())).toBe(true)
    const end = await active()
    expect(end).toMatchObject({ role: 'gridcell', column: 7, selected: 'true' })
    expect(end.row).toBeGreaterThan(1000)
    await expect(status()).toContainText(/^Executing · /)
    await rm(join(control, 'hold', 'query.execute'))
    await expect(status()).toContainText(/^Completed · /, { timeout: 30000 })
    await expect(status()).toContainText('200,000 rows')
    await expect(grid()).toHaveAttribute('aria-busy', 'false')
    await expect(grid()).toHaveAttribute('aria-label', 'Result 1 of 1, 200,000 rows, 8 columns')
  })
  console.log('Results checks: rows stream into the grid while the script runs, and Ctrl+End reaches the last row read.')

  // 2. A million rows past a lowered scroll cap (virtual scrolling): every row is reachable by keys, the scroll bar and
  // the wheel, and the caches stay inside their bounds.
  await page.evaluate(() => window.__variaGrid.setScrollCap(200_000))
  await run('-- varia-fake: sets=W1*1000000')
  let jumped, wheeled
  await measured('a million rows', async () => {
    await page.evaluate(() => window.__variaGrid.reset())
    await cell(0, 0).click()
    await watchActiveNames()
    await page.keyboard.press('Control+End')
    await expect.poll(async () => (await active()).text).toBe(w1(999_999)[7])
    expect(await active()).toMatchObject({ resolved: true, row: 999_999, column: 7 })
    // The far cell's rows are not read yet when the active cell moves there: it is announced as loading, never blank.
    const names = await activeNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names.every(name => name !== ''), `names as the active cell moved: ${JSON.stringify(names)}`).toBe(true)
    await expect(grid().locator(`${gridPart.row}[aria-rowindex="1000001"] ${gridPart.rowHeader}`)).toHaveText('1000000')
    expect(await scroller().evaluate(element => element.scrollHeight)).toBeLessThanOrEqual(200_000 + 1)
    await page.keyboard.press('Control+Home')
    await expect(cell(0, 0)).toHaveText('0')
    // The scroll bar halfway shows the middle rows.
    await scroller().evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2 })
    await expect.poll(async () => (await visibleRows())[0]).toBeGreaterThan(490_000)
    const [top, bottom] = await visibleRows()
    expect(bottom).toBeLessThan(510_000)
    await cell(top + 1, 0).click()
    for (let press = 0; press < 20; press++) await page.keyboard.press('PageDown')
    const paged = await settled()
    expect(paged.row).toBeGreaterThan(top + 1 + 20 * Math.max(1, bottom - top - 3))
    await expect(cell(paged.row, 0)).toHaveText(String(paged.row))
    expect(await insideGrid(cell(paged.row, 0))).toBe(true)
    // The DOM catches up with the rows a frame after they stop moving.
    await expect.poll(async () => ascending(await rowOrder()), { message: 'rows in DOM order after PageDown' }).toBe(true)
    jumped = await stats()
    // The wheel moves the rows by its pixels (a row is 20 of them), never by the compressed scroll bar.
    await page.evaluate(() => window.__variaGrid.reset())
    const box = await scroller().boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect.poll(async () => Number.isFinite((await visibleRows())[0])).toBe(true)
    const [before] = await visibleRows()
    for (let step = 0; step < 30; step++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(16) }
    await expect.poll(async () => (await visibleRows())[0]).toBeGreaterThan(before + 100)
    expect((await visibleRows())[0]).toBeLessThan(before + 200)
    // The active row, scrolled out above, keeps its slot, which comes first; the rows wheeled in follow in order.
    let order
    await expect.poll(async () => { order = await rowOrder(); return ascending(order) }, { message: 'rows in DOM order after the wheel' }).toBe(true)
    expect(order[0]).toBe(paged.row + 2)
    wheeled = await stats()
  }, () => framesOver(wheeled.frames, 8))
  console.log(`Results frames over a million rows: jumps p95 ${p95(jumped.frames).toFixed(2)} ms of ${jumped.frames.length}, wheel p95 ${p95(wheeled.frames).toFixed(2)} ms of ${wheeled.frames.length}; tiles ${wheeled.hits} hits / ${wheeled.misses} misses; UI cache ${wheeled.client.uiWindows} windows / ${wheeled.client.uiUnits} units; worker ${wheeled.client.workerPages} pages / ${wheeled.client.workerBytes} bytes; ${wheeled.nodes} grid elements.`)
  expect(wheeled.client.uiWindows).toBeLessThanOrEqual(256)
  expect(wheeled.client.uiUnits).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(wheeled.client.workerBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
  expect(wheeled.nodes).toBeLessThanOrEqual(1500)
  // The header funnel over the million names (one each): the checklist lists them all a window at a time, its scroll bar
  // reaches the last (by value, as count order ties), it draws only the rows in view, a search runs in the backend, and
  // Cancel closes it.
  await page.keyboard.press('Control+Home')
  await expect(cell(0, 0)).toHaveText('0')
  await cell(0, 1).click()
  await page.keyboard.press('Alt+ArrowDown')
  const names = page.getByRole('dialog', { name: 'Filter name', exact: true })
  await expect(names).toContainText('1,000,000 values in 1,000,000 rows. 1,000,000 ticked.', { timeout: 60000 })
  const valueList = names.getByRole('group', { name: 'Values', exact: true })
  await valueList.evaluate(list => { list.scrollTop = list.scrollHeight })
  await expect(names.getByRole('checkbox', { name: 'Société 0000999995 SARL (1)', exact: true })).toBeChecked()
  expect(await valueList.getByRole('checkbox').count()).toBeLessThan(100)
  await names.getByRole('searchbox', { name: 'Search values', exact: true }).fill('0000999995')
  await expect(names).toContainText('1 of 1,000,000 values match.')
  await expect(names.getByRole('checkbox', { name: 'Société 0000999995 SARL (1)', exact: true })).toBeChecked()
  await names.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(names).toHaveCount(0)
  console.log('Results checks: the header funnel lists a million values a window at a time, reaches the last by its scroll bar and searches them in the backend.')

  // 3. Wide results: End and Ctrl+→ bring the last column into view, the DOM stays small, and the row numbers stay at
  // the grid's left edge however far it scrolls, with native and with virtual scrolling.
  // The numbers are drawn in one sticky column, each level with its row.
  const rowHeaderAtLeft = () => grid().evaluate((root, gridPart) => {
    const rows = [...root.querySelectorAll(gridPart.row)].filter(item => item.style.display !== 'none')
    const marks = [...root.querySelectorAll(gridPart.rowNumber)].filter(item => item.style.display !== 'none')
    const row = rows.find(item => marks.some(mark => mark.textContent === item.querySelector(gridPart.rowHeader).textContent))
    const mark = marks.find(item => item.textContent === row?.querySelector(gridPart.rowHeader).textContent)
    return !!mark && Math.abs(mark.getBoundingClientRect().left - root.getBoundingClientRect().left) <= 1 && Math.abs(mark.getBoundingClientRect().top - row.getBoundingClientRect().top) <= 1
  }, gridPart)
  // A sticky element inside a pooled row makes every row slot a composited layer, which made scroll bar jumps long tasks.
  const stickyInRows = () => grid().evaluate((root, row) => [...root.querySelectorAll(`${row}, ${row} *`)].filter(item => getComputedStyle(item).position === 'sticky').length, gridPart.row)
  const last = shapes.X1.row(0)[299]
  for (const cap of [undefined, 50_000]) {
    await page.evaluate(value => window.__variaGrid.setScrollCap(value), cap)
    await measured(`300 columns (${cap ? 'virtual' : 'native'})`, async () => {
      await run('-- varia-fake: sets=X1*5000')
      await cell(0, 0).click()
      await page.evaluate(() => window.__variaGrid.reset())
      await page.keyboard.press('End')
      await expect.poll(async () => (await active()).text).toBe(last)
      expect(await active()).toMatchObject({ row: 0, column: 299 })
      await expect.poll(() => insideGrid(header('c299'))).toBe(true)
      expect(await rowHeaderAtLeft()).toBe(true)
      await page.keyboard.press('Home')
      await expect.poll(() => insideGrid(header('c000'))).toBe(true)
      await page.keyboard.press('Control+ArrowRight')
      await expect.poll(async () => (await active()).column).toBe(299)
      await expect.poll(() => insideGrid(header('c299'))).toBe(true)
      // A scroll bar jump down and back across.
      await scroller().evaluate(element => { element.scrollTop = element.scrollHeight / 3; element.scrollLeft = element.scrollWidth / 2 })
      await expect.poll(async () => (await visibleRows())[0]).toBeGreaterThan(1000)
      await expect.poll(loadingInView).toBe(0)
      expect(await rowHeaderAtLeft()).toBe(true)
      expect(await stickyInRows()).toBe(0)
    }, async () => framesOver((await stats()).frames, 16))
    const wide = await stats()
    console.log(`Results checks: 300 columns (${cap ? 'virtual' : 'native'} scrolling): ${wide.nodes} grid elements, frames p95 ${p95(wide.frames).toFixed(2)} ms of ${wide.frames.length}.`)
    expect(wide.nodes).toBeLessThanOrEqual(4000)
  }
  await page.evaluate(() => window.__variaGrid.setScrollCap())

  // 4. Stacked sets: equal heights; a splitter by mouse and keys; Tab order; a thousand one-row sets.
  const heights = () => page.locator(part.resultItem).evaluateAll(items => items.map(item => item.getBoundingClientRect().height))
  await run('-- varia-fake: sets=N1*50,N1*50,N1*50,N1*50,N1*50')
  await expect(page.locator(part.resultItem)).toHaveCount(5)
  await expect(page.locator('[data-result-grid]')).toHaveCount(5)
  const five = await heights()
  expect(Math.max(...five) - Math.min(...five)).toBeLessThanOrEqual(1)
  await run('-- varia-fake: sets=N1*50,N1*50')
  await expect(page.locator('[data-result-grid]')).toHaveCount(2)
  const splitter = resultSplitters(page).first()
  const difference = async () => { const [first, second] = await heights(); return Math.round(first - second) }
  expect(Math.abs(await difference())).toBeLessThanOrEqual(1)
  const split = await splitter.boundingBox()
  await page.mouse.move(split.x + 40, split.y + split.height / 2)
  await page.mouse.down()
  await page.mouse.move(split.x + 40, split.y + split.height / 2 + 30, { steps: 4 })
  await page.mouse.up()
  await expect.poll(difference).toBeGreaterThanOrEqual(58)
  await expect(splitter).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(async () => Math.abs(await difference())).toBeLessThanOrEqual(1)
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => Math.abs((await difference()) - 40)).toBeLessThanOrEqual(1)
  await splitter.dblclick()
  await expect.poll(async () => Math.abs(await difference())).toBeLessThanOrEqual(1)
  // Its value is the upper grid's height, between the two grids' minimum heights.
  const [upper, lower] = await heights()
  const range = await splitter.evaluate(element => ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext'].map(name => element.getAttribute(name)))
  expect(Math.abs(Number(range[0]) - upper)).toBeLessThanOrEqual(1)
  expect(Number(range[1])).toBeGreaterThan(0)
  expect(Math.abs(Number(range[1]) + Number(range[2]) - upper - lower)).toBeLessThanOrEqual(2)
  expect(range[3]).toBe(`Result 1 height ${range[0]} pixels`)
  await grid().focus()
  await page.keyboard.press('Tab')
  await expect(splitter).toBeFocused()
  // In forced colors (Windows High Contrast) a splitter is drawn, and its focus shows.
  await page.mouse.move(1, 1)
  await page.emulateMedia({ forcedColors: 'active' })
  const splitterStyle = () => splitter.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, outline: style.outlineStyle } })
  // The grid's own background is forced to the system's Canvas.
  const canvas = await grid().evaluate(element => getComputedStyle(element).backgroundColor)
  const focusedSplitter = await splitterStyle()
  expect(focusedSplitter.background).not.toBe(canvas)
  expect(focusedSplitter.outline).toBe('solid')
  await grid().focus()
  expect(await splitterStyle()).not.toEqual(focusedSplitter)
  expect((await splitterStyle()).background).not.toBe(canvas)
  await page.emulateMedia({ forcedColors: null })
  await page.keyboard.press('Tab')
  await expect(splitter).toBeFocused()
  // The next set's caption comes first: its Collapse button, Save Results As and Close, then its grid.
  await page.keyboard.press('Tab')
  await expect(resultToggle(page, 'Result 2')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(outputPane(page).getByRole('button', { name: 'Save Result 2 As…', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(resultClose(page, 'Result 2')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(grid('Result 2')).toBeFocused()
  await measured('a thousand stacked sets', async () => {
    await run('-- varia-fake: sets=M1*1000')
    await expect(outputTab(/^Results/)).toContainText('1000')
    await expect(page.locator('[data-result-grid]').first()).toBeVisible()
    const target = page.getByRole('grid', { name: 'Result 1000 of 1000, 1 row, 1 column', exact: true })
    let most = 0
    for (let step = 0; step < 400 && !(await target.count()); step++) {
      await page.locator(part.resultStack).evaluate(stack => { stack.scrollTop += stack.clientHeight * 4 })
      await page.waitForTimeout(25)
      most = Math.max(most, await page.locator('[data-result-grid]').count())
    }
    await expect(target).toBeVisible()
    expect(most).toBeLessThanOrEqual(12)
  })
  console.log('Results checks: stacked grids split the pane equally, resize by mouse and keys, and a thousand sets mount at most 12 grids.')

  // 4b. The results head and captions: one run summary; a small set sized to its rows and the rest to the large one,
  // with no outer scroll bar; a caption names its set and collapses it; splitters keep to each set's floor; headers show
  // SQL types; the Messages strip opens for PRINT and errors; the Execution plan view lists a run's plans.
  await run('-- varia-fake: sets=N1*3,W1*2000 messages=2')
  await expect(status()).toHaveText(/^Completed · 2,003 rows · \d+\.\d{3} s · \d\d:\d\d:\d\d$/)
  await expect(status()).toHaveAttribute('title', 'Query executed successfully. · 00:00:00 · 2,003 rows')
  await expect(status().locator('[data-icon="pass"]')).toHaveCount(1)
  // PRINT-like messages opened the strip under the grids, with its one line.
  await expect(messagesStrip(page)).toHaveText('Messages · 2 · no errors')
  // Its name says what the Messages tab's does, without the drawn dots.
  await expect(messagesStrip(page)).toHaveAccessibleName('Messages, 2 messages, no errors')
  await expect(messagesStrip(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(outputPane(page).getByRole('tabpanel').getByRole('log', { name: 'Messages', exact: true })).toContainText('Message 2')
  const captions = page.locator(part.resultCaption)
  await expect(captions).toHaveCount(2)
  await expect(captions.nth(0)).toContainText('Result 1')
  await expect(captions.nth(0)).toContainText('3 rows · 7 columns')
  await expect(captions.nth(1)).toContainText('2,000 rows · 8 columns')
  await expect(resultToggle(page)).toHaveAttribute('aria-expanded', 'true')
  const fitted = async () => {
    const [small, large] = await heights()
    const shown = await scroller().evaluate(element => element.scrollHeight <= element.clientHeight + 1)
    const stack = await page.locator(part.resultStack).evaluate(element => element.scrollHeight <= element.clientHeight + 1)
    return { smaller: small < large, shown, stack }
  }
  // The 3-row set shows every row without scrolling; the 2,000-row set takes the rest; the stack itself fits.
  await expect.poll(fitted).toEqual({ smaller: true, shown: true, stack: true })
  // Collapsing a set leaves its caption; its grid goes and the other set grows; expanding brings it back.
  const [, before] = await heights()
  await resultToggle(page).click()
  await expect(resultToggle(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('[data-result-grid]')).toHaveCount(1)
  await expect.poll(async () => (await heights())[0]).toBe(await captions.nth(0).evaluate(element => element.getBoundingClientRect().height))
  await expect.poll(async () => (await heights())[1]).toBeGreaterThan(before)
  // Beside a collapsed set the splitter only divides: it has no value, takes no focus, and a drag moves nothing.
  await expect(resultSplitters(page)).toHaveCount(0)
  const divider = outputPane(page).getByRole('separator')
  await expect(divider).toHaveCount(1)
  await expect(divider).not.toHaveAttribute('tabindex', /./)
  const collapsedHeights = await heights(), line = await divider.boundingBox()
  await page.mouse.move(line.x + 40, line.y + line.height / 2)
  await page.mouse.down()
  await page.mouse.move(line.x + 40, line.y + line.height / 2 + 30, { steps: 3 })
  await page.mouse.up()
  expect(await heights()).toEqual(collapsedHeights)
  await resultToggle(page).click()
  await expect(page.locator('[data-result-grid]')).toHaveCount(2)
  await expect.poll(fitted).toEqual({ smaller: true, shown: true, stack: true })
  // The 3-row set is shorter than four rows: ArrowUp on the splitter below it keeps it at its rows (it never grows), and
  // the splitter's value lies within its range.
  const sized = await heights()
  await resultSplitters(page).first().focus()
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(100)
  expect((await heights())[0]).toBe(sized[0])
  const bounds = (await resultSplitters(page).first().evaluate(element => ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map(name => Number(element.getAttribute(name)))))
  expect(bounds[0]).toBeGreaterThanOrEqual(bounds[1])
  expect(bounds[0]).toBeLessThanOrEqual(bounds[2])
  // ArrowDown grows it by a row, and Enter goes back to sizing by rows.
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => Math.round((await heights())[0] - sized[0])).toBe(20)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await heights())[0]).toBe(sized[0])
  // Headers show each column's SQL type, drawn after the name and kept out of its accessible name.
  await expect(header('id', grid('Result 2'))).toHaveCount(1)
  await expect(header('id', grid('Result 2')).locator(gridPart.columnType)).toHaveText('int')
  await expect(header('amount', grid('Result 2')).locator(gridPart.columnType)).toHaveText('decimal(18,2)')
  expect((await computed(header('amount', grid('Result 2')).locator(gridPart.columnType))).color).toBe(await tokenColor('resultsGrid.headerDescriptionForeground'))
  expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.showColumnTypes': false }))).ok).toBe(true)
  await expect(header('id', grid('Result 2')).locator(gridPart.columnType)).toHaveText('')
  expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.showColumnTypes': null }))).ok).toBe(true)
  await expect(header('id', grid('Result 2')).locator(gridPart.columnType)).toHaveText('int')
  // Closed, the strip stays closed for the run; the next run's PRINT output opens it again.
  await messagesStrip(page).click()
  await expect(messagesStrip(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(outputPane(page).getByRole('tabpanel').getByRole('log')).toHaveCount(0)
  await run('-- varia-fake: sets=N1*3 messages=1')
  await expect(messagesStrip(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(messagesStrip(page)).toHaveText('Messages · 1 · no errors')
  // An error opens it too and counts there, while the run stays on Results.
  await messagesStrip(page).click()
  await run('-- varia-fake: sets=N1*3 errors=1')
  await expect(messagesStrip(page)).toHaveText('Messages · 1 · 1 error')
  await expect(messagesStrip(page)).toHaveAccessibleName('Messages, 1 message, 1 error')
  await expect(messagesStrip(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(outputTab(/^Results/)).toHaveAttribute('aria-selected', 'true')
  await expect(errorMessages(page)).toContainText('Fake error 1.')
  // Closed, its line shows the first error's message, which describes it.
  await messagesStrip(page).click()
  await expect(messagesStrip(page)).toContainText('Fake error 1.')
  await expect(messagesStrip(page)).toHaveAccessibleDescription('Fake error 1.')
  await messagesStrip(page).click()
  // A run without messages has no strip.
  await run('-- varia-fake: sets=N1*3')
  await expect(messagesStrip(page)).toHaveCount(0)
  // A caption's close button closes its result alone: the others keep their names and numbers, the run its summary and
  // row total, and the focus goes to the caption that took its place. Closing the last one leaves the Results view,
  // saying the results were closed (not that the query returned none), with the Messages strip still under it.
  await run('-- varia-fake: sets=N1*3,N1*4,N1*5 messages=2')
  await expect(captions).toHaveCount(3)
  await expect(outputTab(/^Results/)).toHaveAccessibleName('Results, 3 result sets')
  await expect(status()).toHaveText(/^Completed · 12 rows · /)
  await resultClose(page, 'Result 2').click()
  await expect(captions).toHaveCount(2)
  await expect(grid('Result 2')).toHaveCount(0)
  await expect(resultToggle(page, 'Result 2')).toHaveCount(0)
  await expect(grid('Result 3')).toHaveAccessibleName(/^Result 3 of 3, 5 rows/)
  await expect(captions.nth(1)).toContainText('5 rows')
  await expect(resultToggle(page, 'Result 3')).toBeFocused()
  await expect(outputTab(/^Results/)).toHaveAccessibleName('Results, 2 result sets')
  await expect(status()).toHaveText(/^Completed · 12 rows · /)
  // By the keyboard: the last caption's close hands the focus to the caption before it.
  await resultClose(page, 'Result 3').focus()
  await page.keyboard.press('Enter')
  await expect(captions).toHaveCount(1)
  await expect(resultToggle(page, 'Result 1')).toBeFocused()
  await resultClose(page, 'Result 1').click()
  await expect(outputEmpty(page)).toHaveText('Results were closed. Execute the query again to see them.')
  await expect(page.locator('[data-result-grid]')).toHaveCount(0)
  await expect(outputTab(/^Results/)).toHaveAttribute('aria-selected', 'true')
  await expect(outputTab(/^Results/)).toHaveAccessibleName('Results')
  await expect(outputTab(/^Results/)).toBeFocused()
  await expect(status()).toHaveText(/^Completed · 12 rows · /)
  await expect(messagesStrip(page)).toHaveAccessibleName('Messages, 2 messages, no errors')
  await expect(resultsToolbar(page)).toHaveCount(0)
  // Running the query again brings its results back, with their close buttons.
  await run('-- varia-fake: sets=N1*3')
  await expect(captions).toHaveCount(1)
  await expect(resultClose(page, 'Result 1')).toBeEnabled()
  // The Execution plan view: only for a run that returned plans, each opened as a .sqlplan document.
  await expect(outputTab(/^Execution plan/)).toHaveCount(0)
  const parsesBeforePlan = await planParseCalls()
  await run('SELECT 1 -- XML_PLAN_FIXTURE')
  // Two one-row sets that fit keep their rows, the second right under the first: what is left stays below the last one.
  await expect(page.locator('[data-result-grid]')).toHaveCount(2)
  await expect.poll(async () => { const [first, second] = await heights(); return Math.abs(first - second) <= 1 }).toBe(true)
  expect(await page.locator(part.resultItem).evaluateAll(items => { const [first, second] = items.map(item => item.getBoundingClientRect()); return second.top - first.bottom })).toBeLessThanOrEqual(6)
  expect(await page.locator(part.resultStack).evaluate((stack, item) => stack.getBoundingClientRect().bottom - [...stack.querySelectorAll(item)].at(-1).getBoundingClientRect().bottom, part.resultItem)).toBeGreaterThan(40)
  await expect(outputTab(/^Execution plan/)).toHaveAccessibleName('Execution plan, 1 plan')
  expect(await planParseCalls()).toBe(parsesBeforePlan)
  await outputTab(/^Execution plan/).click()
  await expect(planViewer(page).getByRole('combobox', { name: 'Plan statement' }).getByRole('option')).toHaveCount(2)
  await expect(planViewer(page).getByRole('treeitem')).toHaveCount(2)
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  expect(await planParseCalls()).toBe(parsesBeforePlan + 1)
  await planViewer(page).getByRole('button', { name: 'Fit statement', exact: true }).click()
  const canvasBounds = await planCanvas(page).boundingBox()
  // The fixture's first statement has two horizontally aligned operators, with Index Scan on the right.
  await planCanvas(page).focus()
  await planCanvas(page).hover({ position: { x: canvasBounds.width / 2 + Math.min(108, canvasBounds.width / 4), y: canvasBounds.height / 2 } })
  const operatorStats = page.getByRole('tooltip').filter({ hasText: 'Index Scan' })
  await expect(operatorStats).toContainText('Est. rows per execution')
  await expect(operatorStats).toContainText('Actual rows · total')
  await expect(operatorStats).toContainText('40 ms')
  await expect(operatorStats).toContainText('PlanAffectingConvert')
  await expect(planViewer(page).getByRole('complementary', { name: 'Plan properties' })).toContainText('Statement properties')
  await page.keyboard.press('Escape')
  await expect(operatorStats).toHaveCount(0)
  await planViewer(page).getByRole('treeitem').filter({ hasText: 'Index Scan' }).click()
  await expect(planViewer(page).getByRole('complementary', { name: 'Plan properties' })).toContainText('PlanAffectingConvert')
  await planViewer(page).getByRole('searchbox', { name: 'Find plan operators' }).fill('Customers')
  await expect(planViewer(page).getByRole('treeitem')).toHaveCount(1)
  await planViewer(page).getByRole('searchbox', { name: 'Find plan operators' }).fill('')
  const planZoom = planViewer(page).getByRole('button', { name: 'Reset plan zoom to 100%', exact: true })
  await planZoom.click()
  await expect(planZoom).toHaveText('100%')
  const touch = await page.context().newCDPSession(page)
  try {
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
    const { x, y, width, height } = await planCanvas(page).boundingBox()
    const fingers = spread => [-spread, spread].map((offset, id) => ({ id, x: x + width / 2 + offset, y: y + height / 2 }))
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(24) })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(48) })
    await expect(planZoom).toHaveText('200%')
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(24) })
    await expect(planZoom).toHaveText('100%')
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await touch.detach()
  }
  // The arrow keys reach it like the other views.
  await outputTab(/^Execution plan/).focus()
  await page.keyboard.press('Home')
  await expect(outputTab(/^Results/)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(outputTab(/^Execution plan/)).toHaveAttribute('aria-selected', 'true')
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  expect(await planParseCalls()).toBe(parsesBeforePlan + 1)
  await expect(planZoom).toHaveText('100%')
  await expect(planViewer(page).getByRole('treeitem').filter({ hasText: 'Index Scan' })).toHaveAttribute('aria-selected', 'true')
  await planViewer(page).getByRole('button', { name: 'Open plan document', exact: true }).click()
  await expect(activeDocument(page)).toContainText('ExecutionPlan1.sqlplan')
  // The enlarged output leaves only a few editor lines on a 1024×768 display. Give the plan
  // document the editor's space through the normal toggle before interacting with its outline.
  await page.keyboard.press('Control+R')
  await expect(outputPanel(page, 'plan')).toBeHidden()
  await expect(planCanvas(page)).toBeFocused()
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  expect(await planParseCalls()).toBe(parsesBeforePlan + 2)
  await planViewer(page).getByRole('treeitem').filter({ hasText: 'Index Scan' }).click()
  await planViewer(page).getByRole('button', { name: 'Reset plan zoom to 100%', exact: true }).click()
  await planViewer(page).getByRole('button', { name: 'Zoom in plan', exact: true }).click()
  const documentZoom = await planViewer(page).getByRole('button', { name: 'Reset plan zoom to 100%', exact: true }).innerText()
  await page.getByRole('button', { name: 'XML source', exact: true }).click()
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  expect(await planParseCalls()).toBe(parsesBeforePlan + 2)
  await expect(planViewer(page).getByRole('treeitem').filter({ hasText: 'Index Scan' })).toHaveAttribute('aria-selected', 'true')
  await expect(planViewer(page).getByRole('button', { name: 'Reset plan zoom to 100%', exact: true })).toHaveText(documentZoom)
  await page.emulateMedia({ forcedColors: 'active' })
  await page.getByRole('button', { name: 'XML source', exact: true }).click()
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(planViewer(page).getByRole('treeitem').filter({ hasText: 'Index Scan' })).toBeVisible()
  await expect(planViewer(page).getByRole('treeitem').filter({ hasText: 'Index Scan' })).toHaveAttribute('aria-selected', 'true')
  await expect(planViewer(page).getByRole('region', { name: 'Query plan canvas', exact: true, includeHidden: true }).locator('canvas')).toHaveCount(0)
  expect(await planParseCalls()).toBe(parsesBeforePlan + 2)
  await page.emulateMedia({ forcedColors: 'none' })
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  await expect(planViewer(page).getByRole('button', { name: 'Reset plan zoom to 100%', exact: true })).toHaveText(documentZoom)
  await queryTabs().first().click()
  await queryTabs().filter({ hasText: 'ExecutionPlan1.sqlplan' }).click()
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  expect(await planParseCalls()).toBe(parsesBeforePlan + 2)
  await page.getByRole('button', { name: 'XML source', exact: true }).click()
  await textbox().focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n<!-- edited while XML is shown -->')
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  await expect.poll(planParseCalls).toBe(parsesBeforePlan + 3)
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  await page.keyboard.press('Control+R')
  await expect(outputTab(/^Execution plan/)).toHaveAttribute('aria-selected', 'true')
  await page.screenshot({ path: resolve('artifacts', 'results-head.png') })
  console.log('Results checks: one run summary, captions that collapse and close their results, small sets sized to their rows, header types, the Messages strip and the Execution plan view.')

  // 4c. At the default split of a 1280x800 window the Messages strip yields to the results: an error does not open it over
  // the grids, its line shows the error's message, and a data row stays in view. Opened by hand, it shows the error.
  const fullSize = await page.evaluate(() => [innerWidth, innerHeight])
  const resize = async (width, height) => {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
  }
  await resize(1280, 800)
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('layout.reset').click())
  /** Whether an element lies inside the output view, and how many of a grid's data rows show whole in the stack. */
  const inView = locator => locator.evaluate((element, view) => { const box = element.getBoundingClientRect(), outer = element.closest(view).getBoundingClientRect(); return box.height > 0 && box.top >= outer.top - 0.5 && box.bottom <= outer.bottom + 0.5 }, '[role="tabpanel"]')
  const rowsShown = (name = 'Result 1') => grid(name).evaluate((root, stack) => {
    const scroller = root.querySelector('[tabindex="-1"]').getBoundingClientRect(), view = root.closest(stack).getBoundingClientRect()
    const top = Math.max(scroller.top, view.top) + 22, bottom = Math.min(scroller.bottom, view.bottom)
    return [...root.querySelectorAll('[role="row"]')].filter(row => { const box = row.getBoundingClientRect(); return box.height > 0 && row.querySelector('[role="gridcell"]') && box.top >= top - 0.5 && box.bottom <= bottom + 0.5 }).length
  }, part.resultStack)
  for (const sql of ['-- varia-fake: sets=N1*50,N1*50,N1*50,N1*50,N1*50 messages=1 errors=1', '-- varia-fake: sets=N1*3,W1*2000 messages=2 errors=1']) {
    await run(sql)
    await expect(messagesStrip(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(messagesStrip(page)).toContainText(/ · 1 error/)
    await expect(messagesStrip(page)).toContainText('Fake error 1.')
    expect(await inView(messagesStrip(page))).toBe(true)
    await expect.poll(() => rowsShown()).toBeGreaterThanOrEqual(1)
  }
  await page.screenshot({ path: resolve('artifacts', 'results-default-split.png') })
  // Opened by hand it takes at least a few lines and shows the first error, not the tail.
  await messagesStrip(page).click()
  await expect(messagesStrip(page)).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => inView(errorMessages(page).first())).toBe(true)
  await messagesStrip(page).click()
  // One set in a pane too short for a caption, a header and four rows shows its grid without the caption. The window
  // size alone does not make it that short: Reset restores the split of the first window, whose size differs between
  // machines (a CI display can be smaller than it), and later height changes all go to the output pane. So the sash
  // sizes the stack to fit a caption, a header and three rows.
  await resize(1024, 700)
  await run('-- varia-fake: sets=N1*3')
  expect(Math.abs(await sizeResultStack(page, 26 + 22 + 3 * 20 + 2) - (26 + 22 + 3 * 20 + 2))).toBeLessThanOrEqual(1)
  await expect.poll(() => page.locator(part.resultStack).evaluate(stack => stack.clientHeight)).toBeLessThan(26 + 22 + 4 * 20 + 2)
  await expect(page.locator(part.resultCaption)).toHaveCount(0)
  await expect.poll(() => rowsShown()).toBeGreaterThanOrEqual(1)
  await resize(...fullSize)
  await enlargeOutput(page)
  console.log('Results checks: at the default split the Messages strip yields to the grids and shows the first error in its line.')

  // 5. ARIA: after each grid key the active descendant is a selected gridcell at the active row and column, labelled
  // with its text and what it is.
  await run('-- varia-fake: sets=N1*300')
  await cell(0, 0).click()
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowRight', 'Shift+ArrowDown', 'Shift+ArrowRight', 'ArrowLeft', 'End', 'Home', 'PageDown', 'PageUp', 'Control+End', 'Control+Home',
    'Control+ArrowDown', 'Control+ArrowRight', 'Control+ArrowUp', 'Control+ArrowLeft', 'Shift+Space', 'Control+Space', 'Tab', 'Shift+Tab', 'Enter']) {
    await page.keyboard.press(key)
    // A cell whose rows are still being read is labelled as loading until they are.
    let state
    await expect.poll(async () => { state = await active(); return state.resolved && state.label !== null && state.label !== 'Loading' }, key).toBe(true)
    expect(state, key).toMatchObject({ role: 'gridcell', selected: 'true' })
    expect(state.id, key).toMatch(new RegExp(`-r${state.row}c${state.column}$`))
    expect(state.label.startsWith(state.text), key).toBe(true)
    if (state.text === 'NULL') expect(state.label, key).toMatch(/^NULL, (null value|could not be read)/)
  }
  await expect(grid()).toBeFocused()
  // Row 1's "clipped" value was stored as a prefix: it is marked, and says so.
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  for (let column = 0; column < 3; column++) await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await active()).label).toBe('truncated pre, truncated')
  await expect(matching(cell(1, 3), gridPart.truncatedCell)).toHaveCount(1)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  // A NULL and a value that could not be read both show NULL; their labels tell them apart, and so does more than hue.
  await expect.poll(async () => (await active()).label).toBe('NULL, null value')
  await page.keyboard.press('ArrowDown')
  for (let column = 0; column < 3; column++) await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await active()).label).toBe('NULL, could not be read')
  const cue = element => { const style = getComputedStyle(element); return `${style.fontStyle} ${style.textDecorationLine} ${style.textDecorationStyle}` }
  expect(await cell(1, 1).evaluate(cue)).toBe('italic none solid')
  expect(await cell(2, 4).evaluate(cue)).toBe('normal underline wavy')
  console.log('Results checks: the active descendant follows every grid key with its row, column, selection and label.')

  // 6. Selection and copy: clicks, Shift, a drag that scrolls, Ctrl+click on columns and rows, headers and the corner;
  // the exact text by keys, with headers, and through Edit › Copy; a long copy's strip; a copy over the limit.
  await run('-- varia-fake: sets=W1*400')
  const selected = () => grid().locator(gridPart.selectedCell).count()
  // The first cell is the current cell from the start, so a first Shift+click selects from it.
  await expect(cell(0, 0)).toHaveAttribute('aria-selected', 'true')
  await cell(2, 2).click({ modifiers: ['Shift'] })
  await expect.poll(selected).toBe(9)
  await cell(1, 1).click()
  await cell(2, 2).click({ modifiers: ['Shift'] })
  await expect.poll(selected).toBe(4)
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(tsv([1, 2].map(row => w1(row).slice(1, 3))))
  // A drag past the bottom of the body keeps scrolling and extending.
  const body = await scroller().boundingBox()
  const start = await cell(0, 0).boundingBox()
  await page.mouse.move(start.x + 5, start.y + 5)
  await page.mouse.down()
  await page.mouse.move(start.x + 5, body.y + body.height + 40, { steps: 5 })
  await expect.poll(async () => (await active()).row ?? 0, { timeout: 15000 }).toBeGreaterThan(60)
  await page.mouse.up()
  const dragged = (await settled()).row
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(tsv(Array.from({ length: dragged + 1 }, (_, row) => [w1(row)[0]])))
  // Ctrl+click on column headers selects them side by side; on row headers, whole rows.
  await header('id').click()
  await header('created').click({ modifiers: ['Control'] })
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(tsv(Array.from({ length: 400 }, (_, row) => [w1(row)[0], w1(row)[2]])))
  await page.keyboard.press('Control+Home')
  // Until the next frame, row 1 may still be the active row's spare slot, which that frame hides.
  await expect.poll(() => insideGrid(cell(0, 0))).toBe(true)
  await rowNumber(0).click()
  await rowNumber(2).click({ modifiers: ['Control'] })
  await page.keyboard.press('Control+Shift+C')
  await expect.poll(clipboard).toBe(tsv([w1Names, w1(0), w1(2)]))
  await grid().getByRole('columnheader', { name: 'Select all', exact: true }).click()
  await expect.poll(() => grid().locator(gridPart.selectedColumnHeader).count()).toBeGreaterThan(3)
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(tsv(Array.from({ length: 400 }, (_, row) => w1(row))))
  await cell(0, 0).click()
  await page.keyboard.press('Control+A')
  await setClipboard('')
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(tsv(Array.from({ length: 400 }, (_, row) => w1(row))))
  // Edit › Copy is Electron's copy role: the copy event reaches the focused grid.
  await setClipboard('')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy())
  await expect.poll(clipboard).toBe(tsv(Array.from({ length: 400 }, (_, row) => w1(row))))
  // Values the backend stored cut are copied cut, and the copy says how many, in the toolbar and to screen readers.
  await run('-- varia-fake: sets=N1*20')
  await cell(0, 0).click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+C')
  await expect(jobNotice(page)).toHaveText('Copied 20 rows. 10 values were truncated.')
  await expect(outputAnnouncer(page)).toHaveText('Copied 20 rows. 10 values were truncated.')
  // A copy that takes a while shows its strip, then sets the clipboard.
  await run('-- varia-fake: sets=W1*200000')
  await measured('copying 200,000 rows', async () => {
    await cell(0, 0).click()
    await page.keyboard.press('Control+A')
    await setClipboard('')
    await writeFile(join(control, 'hold', 'results.copy'), '')
    await page.keyboard.press('Control+C')
    await expect(jobProgress(page)).toContainText('Copying…')
    await rm(join(control, 'hold', 'results.copy'))
    await expect.poll(async () => (await clipboard()).split(eol).length, { timeout: 60000 }).toBe(200_000)
    await expect(jobProgress(page)).toHaveCount(0)
  })
  const copied = (await clipboard()).split(eol)
  expect([copied[0], copied.at(-1)]).toEqual([w1(0).join('\t'), w1(199_999).join('\t')])
  // A copy over 64 MB is refused before any text is made: a banner says so and the clipboard keeps its text.
  await setClipboard('kept')
  await run('-- varia-fake: sets=B1*9000')
  await cell(0, 0).click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+C')
  const tooLarge = page.getByRole('alert').filter({ hasText: 'The selection is too large to copy' })
  await expect(tooLarge).toBeVisible({ timeout: 60000 })
  expect(await clipboard()).toBe('kept')
  await tooLarge.getByRole('button', { name: 'Dismiss command error', exact: true }).click()
  console.log('Results checks: selection by clicks, Shift, drag, Ctrl and headers; copies by keys, Edit › Copy, with headers, long and too large.')

  // 7. Resize: a header's right border follows the pointer (its cells with it), Escape puts it back, a drag narrows the
  // column without selecting it, and a double-click fits the column to its widest value.
  await run('-- varia-fake: sets=W1*400')
  await expect(cell(0, 1)).toHaveText(w1(0)[1])
  const widthOf = locator => locator.evaluate(element => element.getBoundingClientRect().width)
  const clipped = () => cell(0, 1).evaluate(element => element.scrollWidth > element.clientWidth)
  // The first rows size the columns once they arrive; the border is found after that.
  let nameBox
  await expect.poll(async () => { const now = JSON.stringify(await header('name').boundingBox()), same = now === nameBox; nameBox = now; return same }, { intervals: [100] }).toBe(true)
  nameBox = JSON.parse(nameBox)
  const initial = nameBox.width, border = { x: nameBox.x + nameBox.width - 1, y: nameBox.y + nameBox.height / 2 }
  expect(await clipped()).toBe(false)
  await page.mouse.move(border.x, border.y)
  await expect(matching(grid(), gridPart.borderHover)).toHaveCount(1)
  await page.mouse.down()
  await page.mouse.move(border.x + 50, border.y, { steps: 5 })
  await expect.poll(() => widthOf(header('name'))).toBeCloseTo(initial + 50, 0)
  expect(await widthOf(cell(0, 1))).toBeCloseTo(initial + 50, 0)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect.poll(() => widthOf(header('name'))).toBeCloseTo(initial, 0)
  await page.mouse.move(border.x, border.y)
  await page.mouse.down()
  await page.mouse.move(border.x - initial, border.y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => widthOf(header('name'))).toBeLessThan(initial / 2)
  expect(await clipped()).toBe(true)
  // Only the current cell's column (the first) is marked, as before the drag.
  await expect(grid().locator(gridPart.selectedColumnHeader)).toHaveCount(1)
  await expect(grid().locator(gridPart.selectedColumnHeader)).toHaveAccessibleName('id')
  const narrowed = await header('name').boundingBox()
  await page.mouse.dblclick(narrowed.x + narrowed.width - 1, narrowed.y + narrowed.height / 2)
  await expect.poll(() => widthOf(header('name'))).toBeCloseTo(initial, 0)
  expect(await clipped()).toBe(false)
  await page.mouse.move(border.x, border.y + 200)
  await expect(matching(grid(), gridPart.borderHover)).toHaveCount(0)
  // The column menu copies metadata only; its Fit command also works from the keyboard and preserves other widths.
  const idWidth = await widthOf(header('id')), fittedName = await header('name').boundingBox()
  await page.mouse.move(fittedName.x + fittedName.width - 1, fittedName.y + fittedName.height / 2)
  await page.mouse.down()
  await page.mouse.move(fittedName.x, fittedName.y + fittedName.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => widthOf(header('name'))).toBeLessThan(initial / 2)
  await header('name').click({ button: 'right' })
  const columnMenu = page.getByRole('menu', { name: 'Query output', exact: true })
  await columnMenu.getByRole('menuitem', { name: 'Copy Column Name', exact: true }).click()
  expect(await clipboard()).toBe('name')
  await page.keyboard.press('Shift+F10')
  await columnMenu.getByRole('menuitem', { name: 'Fit Column', exact: true }).click()
  await expect.poll(() => widthOf(header('name'))).toBeCloseTo(initial, 0)
  expect(await widthOf(header('id'))).toBeCloseTo(idWidth, 0)
  expect(await clipped()).toBe(false)
  console.log('Results checks: column borders resize and fit, Escape restores sizing, and keyboard menus fit a column or copy only its name.')

  // 8. Save Results As: the grid's menu writes CSV through main's dialog, the extension picks tab-delimited text or JSON,
  // Ctrl+S in the grid opens the dialog, a long save shows its strip and Escape cancels it leaving no file, and a save
  // outlives running the query again (the backend leases its result).
  const saveDir = await mkdtemp(resolve('artifacts', 'results-save-'))
  cleanups.push(() => rm(saveDir, { recursive: true, force: true }))
  await application.evaluate(({ dialog }) => {
    globalThis.variaSave = { paths: [], dialogs: [] }
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.variaSave.dialogs.push(options)
      const filePath = globalThis.variaSave.paths.shift()
      return filePath ? { canceled: false, filePath } : { canceled: true }
    }
  })
  const choose = path => application.evaluate((_, value) => { globalThis.variaSave.paths.push(value) }, path)
  const lastDialog = () => application.evaluate(() => globalThis.variaSave.dialogs.at(-1))
  const files = async () => (await readdir(saveDir)).sort()
  const notice = jobNotice(page)
  const w1Rows = count => Array.from({ length: count }, (_, row) => shapes.W1.row(row))
  // Independent of the backend's writers: CSV quotes only where needed and leaves NULL empty; TSV writes NULL.
  const csvField = value => value === null ? '' : value === '' || /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  await choose(join(saveDir, 'w1.csv'))
  await cell(1, 1).click({ button: 'right' })
  const saveItem = page.getByRole('menu', { name: 'Query output', exact: true }).getByRole('menuitem', { name: 'Save Results As…', exact: true })
  await saveItem.click()
  await expect(notice).toHaveText('Saved 400 rows to w1.csv.')
  expect(await lastDialog()).toMatchObject({ title: 'Save Grid Results', defaultPath: expect.stringMatching(/SQLQuery1-Result1\.csv$/) })
  // No header row: Include column headers when copying or saving the results is off by default, as in SSMS.
  expect(await readFile(join(saveDir, 'w1.csv'), 'utf8')).toBe('﻿' + w1Rows(400).map(row => row.map(csvField).join(',') + '\r\n').join(''))
  // With the option on (Tools › Options › Query Results › Results to Grid), saves start with the column names.
  expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.includeColumnHeaders': true }))).ok).toBe(true)
  await choose(join(saveDir, 'w1.txt'))
  await cell(0, 0).click()
  await page.keyboard.press('Control+S')
  await expect(notice).toHaveText('Saved 400 rows to w1.txt.')
  expect(await lastDialog()).toMatchObject({ defaultPath: expect.stringMatching(/SQLQuery1-Result1\.csv$/) })
  expect(await readFile(join(saveDir, 'w1.txt'), 'utf8')).toBe('﻿' + [w1Names, ...w1Rows(400)].map(row => row.map(value => value ?? 'NULL').join('\t') + '\r\n').join(''))
  await choose(join(saveDir, 'w1.json'))
  await page.keyboard.press('Control+S')
  await expect(notice).toHaveText('Saved 400 rows to w1.json.')
  // The last format chosen is offered first.
  expect(await lastDialog()).toMatchObject({ defaultPath: expect.stringMatching(/SQLQuery1-Result1\.txt$/), filters: [expect.objectContaining({ name: 'Text (Tab delimited)' }), expect.anything(), expect.anything(), expect.anything()] })
  const json = await readFile(join(saveDir, 'w1.json'), 'utf8')
  expect(json.startsWith('[\n{')).toBe(true)
  const objects = JSON.parse(json)
  expect(objects).toHaveLength(400)
  expect(objects[4]).toMatchObject({ id: 4, name: w1(4)[1], key: w1(4)[4], active: false, score: null })
  // A cancelled dialog writes nothing and says nothing.
  await page.keyboard.press('Control+S')
  await expect.poll(async () => (await application.evaluate(() => globalThis.variaSave.dialogs.length))).toBe(4)
  expect(await files()).toEqual(['w1.csv', 'w1.json', 'w1.txt'])
  // A save held after its first page shows its strip; Escape in the grid cancels it, and neither the file nor its
  // temporary file is left.
  await run('-- varia-fake: sets=W1*5000')
  await writeFile(join(control, 'hold', 'results.export'), '')
  await choose(join(saveDir, 'held.csv'))
  await cell(0, 0).click()
  await page.keyboard.press('Control+S')
  await expect(jobProgress(page)).toContainText(/^Saving held\.csv… \d+% \([\d,]+ of 5,000 rows\)/)
  // The strip's progress is visual only: the pane's live region says how the save ended, once.
  await expect(jobProgress(page).locator('[role="status"], [aria-live]')).toHaveCount(0)
  await expect(jobProgress(page)).not.toHaveAttribute('aria-live', /.*/)
  // The toolbar's only live region is the search count, silent while it is empty.
  await expect(outputToolbar(page).locator('[role="status"], [aria-live]')).toHaveCount(1)
  await expect(resultsToolbar(page).getByRole('status')).toHaveText('')
  await expect.poll(async () => (await files()).some(name => name.endsWith('.tmp'))).toBe(true)
  await page.screenshot({ path: resolve('artifacts', 'results-saving.png') })
  await page.keyboard.press('Escape')
  await expect(notice).toHaveText('Saving was cancelled. The file was not written.')
  await expect.poll(files).toEqual(['w1.csv', 'w1.json', 'w1.txt'])
  // Running the query again releases the result, but the save goes on with its strip and finishes the file.
  await choose(join(saveDir, 'kept.csv'))
  await cell(0, 0).click()
  await page.keyboard.press('Control+S')
  await expect(jobProgress(page)).toContainText('Saving kept.csv…')
  await run('-- varia-fake: sets=M1*1')
  await expect(jobProgress(page)).toContainText('Saving kept.csv…')
  await rm(join(control, 'hold', 'results.export'))
  await expect(notice).toHaveText('Saved 5,000 rows to kept.csv.', { timeout: 30000 })
  await expect(jobProgress(page)).toHaveCount(0)
  expect((await readFile(join(saveDir, 'kept.csv'), 'utf8')).split('\r\n')).toHaveLength(5002)
  expect(await files()).toEqual(['kept.csv', 'w1.csv', 'w1.json', 'w1.txt'])
  // The saves above ended in view and showed no toast. One that ends while its query is in the background says so in a
  // toast with Show results, which Focus Notifications reaches from the keyboard.
  const toast = toasts(page)
  await expect(toast).toHaveCount(0)
  await run('-- varia-fake: sets=W1*5000')
  await writeFile(join(control, 'hold', 'results.export'), '')
  await choose(join(saveDir, 'background.csv'))
  await cell(0, 0).click()
  await page.keyboard.press('Control+S')
  await expect(jobProgress(page)).toContainText('Saving background.csv…')
  await page.keyboard.press('Control+N')
  await expect(queryTabs()).toHaveCount(2)
  await rm(join(control, 'hold', 'results.export'))
  await expect(toast).toHaveCount(1, { timeout: 30000 })
  await expect(toast).toHaveAttribute('data-severity', 'info')
  // Focused, it says its severity and then its sentence.
  await expect(toast).toHaveAccessibleName('Information')
  await expect(toast).toHaveAccessibleDescription('Saved 5,000 rows to background.csv.')
  await expect(toastMessage(toast)).toHaveText('Saved 5,000 rows to background.csv.')
  await expect(toastAnnouncer(page)).toHaveText('Saved 5,000 rows to background.csv.')
  // Above the status bar, inside the window, and not focused: a toast never takes focus by itself.
  const [toastBox, statusBox] = [await toast.boundingBox(), await statusBar(page).boundingBox()]
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(statusBox.y)
  expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))
  await expect(toast).not.toBeFocused()
  // Drawn over the dock (and, below, over a grid): what is laid out there must also be what the pointer reaches.
  const onTop = () => toast.evaluate(element => {
    const box = element.getBoundingClientRect()
    return [[0.5, 0.5], [0.05, 0.1], [0.95, 0.9]].map(([x, y]) => element.contains(document.elementFromPoint(box.left + box.width * x, box.top + box.height * y)))
  })
  expect(await onTop()).toEqual([true, true, true])
  await page.screenshot({ path: resolve('artifacts', 'results-toast.png') })
  const focusNotifications = async () => {
    await page.keyboard.press('F1')
    await page.keyboard.type('focus notifications')
    await expect(quickInputActive(page)).toContainText('View: Focus Notifications')
    await page.keyboard.press('Enter')
    await expect(toast).toBeFocused()
  }
  // The focused toast takes the theme's focus ring, as its buttons do; Tab reaches Show results, and Escape there
  // dismisses the toast and gives focus back to the query it came from.
  await textbox().focus()
  await focusNotifications()
  expect(await toast.evaluate(element => { const style = getComputedStyle(element); return [style.outlineStyle, style.outlineWidth, style.outlineColor] }))
    .toEqual(['solid', '2px', await tokenColor('focusBorder')])
  await page.keyboard.press('Tab')
  await expect(toast.getByRole('button', { name: 'Show results', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(toast).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  // The dismissed toast's sentence leaves the live region, so the same sentence again (below) changes it and is read.
  const politeRegion = toastAnnouncer(page)
  await expect(politeRegion).toHaveText('')
  // Again, held while the second query shows a grid where the toast appears, and this time Show results, clicked with
  // the pointer (which waits until nothing covers it), goes back to the first.
  await run('-- varia-fake: sets=W1*5000')
  await queryTabs().first().click()
  await writeFile(join(control, 'hold', 'results.export'), '')
  await choose(join(saveDir, 'background.csv'))
  await cell(0, 0).click()
  await page.keyboard.press('Control+S')
  await expect(jobProgress(page)).toContainText('Saving background.csv…')
  await queryTabs().nth(1).click()
  await expect(cell(0, 0)).toBeVisible()
  await rm(join(control, 'hold', 'results.export'))
  await expect(toast).toHaveCount(1, { timeout: 30000 })
  await expect(politeRegion).toHaveText('Saved 5,000 rows to background.csv.')
  expect(await onTop()).toEqual([true, true, true])
  await page.screenshot({ path: resolve('artifacts', 'results-toast-grid.png') })
  await toast.getByRole('button', { name: 'Show results', exact: true }).click({ timeout: 5000 })
  await expect(toast).toHaveCount(0)
  await expect(queryTabs().first()).toHaveAttribute('aria-selected', 'true')
  expect((await readFile(join(saveDir, 'background.csv'), 'utf8')).split('\r\n')).toHaveLength(5002)
  await queryTabs().nth(1).click()
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  // Back to the default (null resets), so the copies below have no header line.
  expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.includeColumnHeaders': null }))).ok).toBe(true)
  // Close Results (from the palette) frees the results and their windows; Messages stay.
  await textbox().focus()
  await page.keyboard.press('F1')
  await page.keyboard.type('close results')
  await expect(quickInputActive(page)).toContainText('Query: Close Results')
  await page.keyboard.press('Enter')
  await expect(outputEmpty(page)).toHaveText('Results were closed to free memory. Execute the query again to see them.')
  // A line only, centred by the states kit's empty state, with nothing to click.
  await expect(emptyStateDetail(emptyState(outputEmpty(page)))).toHaveCount(1)
  await expect(emptyState(outputEmpty(page))).toHaveCSS('justify-content', 'center')
  await expect(emptyStateTitle(outputEmpty(page))).toHaveCount(0)
  await expect(outputEmpty(page).getByRole('button')).toHaveCount(0)
  await expect(page.locator('[data-result-grid]')).toHaveCount(0)
  // Run from the editor, it leaves focus there.
  await expect(textbox()).toBeFocused()
  await expect.poll(async () => (await stats()).client.uiWindows).toBe(0)
  // The Results tab stays, with no count of the sets that are gone.
  await expect(outputTab(/^Results/)).toHaveText('Results')
  await expect(outputTab(/^Results/)).toHaveAccessibleName('Results')
  await outputTab(/^Messages/).click()
  await expect(messages(page)).toContainText('Completion time:')
  console.log('Results checks: Save Results As writes CSV, tab-delimited text and JSON, shows a cancellable strip, and outlives running again; Close Results frees the results.')

  // 9. Values: XML, JSON and plan cells are links. A click opens the whole value, formatted, in a new tab named as SSMS
  // names it, in its language, not dirty and with no connection, where Execute and F5 do nothing and the output pane
  // has no results; Enter opens a plan; a value tab saves with its own filter and closes without a SQL session; a 2 MB
  // value fills in without a long task.
  const valueTab = name => queryTabs().filter({ hasText: name })
  const editorLanguage = () => page.locator('[data-mode-id]').first().getAttribute('data-mode-id')
  /** The active document's whole text, copied from the editor as a user would. */
  const editorText = async () => {
    await textbox().focus()
    await setClipboard('')
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Control+C')
    let text = ''
    await expect.poll(async () => (text = await clipboard())).not.toBe('')
    return text.replaceAll('\r\n', '\n')
  }
  const calls = async method => (await readFile(join(control, 'calls.jsonl'), 'utf8')).split('\n').filter(line => line.includes(`"method":"${method}"`)).length
  const lastLine = async () => Math.max(...(await page.locator('.margin-view-overlays .line-numbers').allTextContents()).map(Number))
  await run('SELECT 1 -- FOR_XML_FIXTURE')
  const forXml = cell(0, 0)
  await expect(matching(forXml, gridPart.linkCell)).toHaveCount(1)
  expect((await computed(forXml)).color).toBe(await tokenColor('resultsGrid.linkForeground'))
  await forXml.hover()
  await expect(forXml).toHaveAttribute('title', 'Open in a new tab (Enter)')
  const sessionCloses = await calls('query.session.close'), executes = await calls('query.execute')
  // A double-click opens one tab: the value opens on the first click, and the second press opens nothing more.
  await forXml.dblclick()
  const forXmlName = 'XML_F52E2B61-18A1-11d1-B105-00805F49916B1.xml'
  await expect(valueTab(forXmlName)).toHaveAttribute('aria-selected', 'true')
  await page.waitForTimeout(300)
  await expect(queryTabs()).toHaveCount(2)
  await expect(textbox()).toBeFocused()
  expect(await editorLanguage()).toBe('xml')
  await expect(queryStatus(page)).toHaveText('XML document')
  // A value's tab shows its kind by icon, not a text badge.
  await expect(kindIcon(activeDocument(page), 'XML document')).toHaveAttribute('data-icon', 'code')
  await expect(activeDocument(page)).toHaveAccessibleName(forXmlName)
  await expect(unsavedMark(activeDocument(page))).toHaveCount(0)
  // A value has no server and never executes: it has no query bar.
  await expect(queryBar(page)).toHaveCount(0)
  await expect(server()).toHaveCount(0)
  await expect(outputEmpty(page)).toContainText('Query results appear here for query tabs.')
  await expect(emptyStateTitle(emptyState(outputEmpty(page)))).toHaveText('Query results')
  // Varia's own table icon, as in Object Explorer.
  await expect(emptyStateIcon(outputEmpty(page))).toHaveAttribute('data-icon', 'table')
  await expect(emptyState(outputEmpty(page))).toHaveCSS('justify-content', 'center')
  const forXmlText = '<objects>\n  <o>\n    <name>Orders</name>\n    <object_id>1</object_id>\n  </o>\n  <o>\n    <name>Customers</name>\n    <object_id>2</object_id>\n  </o>\n</objects>'
  expect(await editorText()).toBe(forXmlText)
  await page.keyboard.press('F5')
  await page.waitForTimeout(200)
  expect(await calls('query.execute')).toBe(executes)
  // Save offers XML; closing needs no SQL session.
  await choose(join(saveDir, 'objects.xml'))
  await page.keyboard.press('Control+S')
  await expect(valueTab('objects.xml')).toHaveAttribute('aria-selected', 'true')
  expect(await lastDialog()).toMatchObject({ title: 'Save XML document', defaultPath: expect.stringMatching(/XML_F52E2B61-18A1-11d1-B105-00805F49916B1\.xml$/), filters: [{ name: 'XML files', extensions: ['xml'] }] })
  expect(await readFile(join(saveDir, 'objects.xml'), 'utf8')).toBe(forXmlText)
  await page.keyboard.press('Control+W')
  await expect(valueTab('objects.xml')).toHaveCount(0)
  expect(await calls('query.session.close')).toBe(sessionCloses)
  // Enter on a plan cell opens it as an execution plan, in XML.
  await run('SELECT 1 -- XML_PLAN_FIXTURE')
  await cell(0, 0, grid('Result 2')).click({ modifiers: ['Shift'] })
  await expect(queryTabs()).toHaveCount(1)
  await page.keyboard.press('Enter')
  // The session's second plan document: the Execution plan view opened the first (section 4b).
  await expect(valueTab('ExecutionPlan2.sqlplan')).toHaveAttribute('aria-selected', 'true')
  expect(await editorLanguage()).toBe('xml')
  await expect(queryStatus(page)).toHaveText('Execution plan')
  await expect(kindIcon(activeDocument(page), 'Execution plan')).toHaveAttribute('data-icon', 'execution-plan')
  await page.getByRole('button', { name: 'XML source', exact: true }).click()
  expect(await editorText()).toContain('SELECT SUM(Amount)')
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  const actualPlan = page.getByRole('button', { name: 'Include Actual Execution Plan', exact: true })
  await expect(actualPlan).toHaveAttribute('aria-pressed', 'false')
  await actualPlan.click()
  await expect(actualPlan).toHaveAttribute('aria-pressed', 'true')
  await run('SELECT 42 -- ACTUAL_PLAN_FIXTURE')
  await expect(outputTab(/^Results/)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-result-grid]')).toHaveCount(1)
  await expect(cell(0, 0)).toHaveText('42')
  await expect(outputTab(/^Execution plan/)).toHaveAccessibleName('Execution plan, 2 plans')
  await outputTab(/^Execution plan/).click()
  await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
  await expect(planViewer(page).getByRole('combobox', { name: 'Plan statement' }).getByRole('option')).toHaveCount(4)
  await planViewer(page).getByRole('button', { name: 'Open plan document', exact: true }).click()
  await expect(valueTab('ExecutionPlan3.sqlplan')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  await expect(actualPlan).toHaveAttribute('aria-pressed', 'true')
  await run('SELECT 42 -- ACTUAL_PLAN_FIXTURE UNREADABLE_PLAN')
  await outputTab(/^Execution plan/).click()
  await expect(planViewer(page).getByRole('status').filter({ hasText: 'Plan 2 · Batch 2' })).toBeVisible()
  await expect(planViewer(page).getByRole('combobox', { name: 'Plan statement' }).getByRole('option')).toHaveCount(2)
  await planViewer(page).getByRole('combobox', { name: 'Plan XML source' }).selectOption({ label: 'Plan 2 · Batch 2' })
  await planViewer(page).getByRole('button', { name: 'Open plan document', exact: true }).click()
  await expect(valueTab('ExecutionPlan4.sqlplan')).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'XML source', exact: true }).click()
  expect(await editorText()).toContain('<unavailable-plan')
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  const holdPlans = join(control, 'hold', 'mixed-plan-summary')
  await writeFile(holdPlans, '')
  await run('SELECT 42 -- MIXED_PLAN_FIXTURE', { running: true })
  await expect(outputTab(/^Execution plan/)).toHaveAccessibleName('Execution plan, 2 plans')
  await outputTab(/^Execution plan/).click()
  const xmlSource = planViewer(page).getByRole('combobox', { name: 'Plan XML source' })
  const planStatement = planViewer(page).getByRole('combobox', { name: 'Plan statement' })
  await expect(planStatement.getByRole('option')).toHaveCount(4)
  await planStatement.selectOption({ index: 2 })
  await xmlSource.selectOption({ label: 'Result 2, plan 1' })
  await rm(holdPlans)
  await expect(status()).toContainText(/^Completed · /)
  await expect(xmlSource.getByRole('option')).toHaveCount(3)
  await expect(xmlSource.locator('option:checked')).toHaveText('Result 2, plan 1')
  await expect(planStatement.locator('option:checked')).toHaveText(/^5\. SELECT SUM/)
  await expect(planStatement.getByRole('option').first()).toHaveText('1. SELECT · Batch 1, repetition 2')
  await planViewer(page).getByRole('button', { name: 'Open plan document', exact: true }).click()
  await page.getByRole('button', { name: 'XML source', exact: true }).click()
  expect(await editorText()).toContain('dbo.PickedPlan')
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  await textbox().focus()
  await page.keyboard.press('Control+M')
  await expect(actualPlan).toHaveAttribute('aria-pressed', 'false')
  await run('SELECT 42 -- ACTUAL_PLAN_FIXTURE')
  await expect(outputTab(/^Execution plan/)).toHaveCount(0)
  console.log('Results checks: actual plan capture keeps data grids separate, shows multiple plans on one canvas, and can be toggled off for the next run.')
  await checkClientStatistics(page, expect, run, false)

  // A JSON value opens formatted, in JSON.
  await run('-- varia-fake: sets=L1*3')
  await cell(0, 2).click()
  await expect(valueTab('data1.json')).toHaveAttribute('aria-selected', 'true')
  expect(await editorLanguage()).toBe('json')
  await expect(queryStatus(page)).toHaveText('JSON document')
  expect((await editorText()).startsWith('{\n  "items": [\n    {\n      "id": 1,\n      "name": "Item 1",\n')).toBe(true)
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  // A 2 MB XML value (about 2.9 million characters formatted) fills in a chunk a frame without blocking the window.
  const items = shapes.L1.row(2)[1].split('<item ').length - 1
  let opened = 0
  await measured('opening a 2 MB value', async () => {
    await cell(2, 1).click()
    await expect(valueTab(`doc${++opened}.xml`)).toHaveAttribute('aria-selected', 'true', { timeout: 30000 })
    await expect.poll(async () => { await textbox().focus(); await page.keyboard.press('Control+End'); return lastLine() }, { timeout: 30000 }).toBe(2 + 4 * items)
    await expect(unsavedMark(activeDocument(page))).toHaveCount(0)
    await page.keyboard.press('Control+W')
    await expect(queryTabs()).toHaveCount(1)
  })
  expect(await calls('query.session.close')).toBe(sessionCloses)
  // macOS overlay scroll bars take no room: they lie over the cells, and a press on one targets the scroller itself.
  // Hidden bars in a small scroller give Linux that geometry. The press a scroll-bar drag sends there (at the edge, and
  // 40 px in, where a zoomed-out window's bar still is) selects nothing and opens nothing; the same press on the plan
  // cell under it selects the cell and opens the plan.
  const overlayStyle = await page.addStyleTag({ content: `[data-result-grid] ${gridPart.scroller} { max-width: 520px; max-height: 80px } [data-result-grid] ${gridPart.scroller}::-webkit-scrollbar { width: 0; height: 0 }` })
  // Scroll a numeric cell into view and press it in the same task, before a scroll event or frame can update the grid.
  // The previous offset would put this point over the XML column: the press must select the numeric cell, opening no tab.
  const firstColumnWidth = await cell(0, 0).evaluate(element => element.getBoundingClientRect().width)
  await scroller().evaluate((element, width) => { element.scrollLeft = width }, firstColumnWidth)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  expect(await scroller().evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  await grid().evaluate((root, { parts, selector }) => {
    root.querySelector(parts.scroller).scrollLeft = 0
    const target = root.querySelector(selector), box = target.getBoundingClientRect()
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 0, detail: 1 }
    const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true }
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, ...pointer, buttons: 1 }))
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }))
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, ...pointer, buttons: 0 }))
    target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }))
  }, { parts: gridPart, selector: gridCellSelector(0, 0) })
  await expect.poll(() => active()).toMatchObject({ row: 0, column: 0 })
  await expect(queryTabs()).toHaveCount(1)
  await cell(0, 0).click()
  await page.keyboard.press('End')
  await settled()
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const beforeOverlayPress = await active()
  const overlayBar = await scroller().evaluate((element, gridPart) => {
    const box = element.getBoundingClientRect(), row = element.querySelector(gridPart.row + '[aria-rowindex="3"]').getBoundingClientRect()
    const x = box.left + element.clientWidth - 5, y = row.top + row.height / 2, under = document.elementFromPoint(x, y)?.closest(gridPart.cell)
    const inner = document.elementFromPoint(x - 35, y)?.closest(gridPart.cell)
    return {
      x, y, inner: inner === under, overlay: element.offsetWidth === element.clientWidth && element.offsetHeight === element.clientHeight,
      overflows: element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight,
      inView: y < box.top + element.clientHeight, link: !!under?.matches(gridPart.linkCell), column: under?.getAttribute('aria-colindex')
    }
  }, gridPart)
  expect(overlayBar).toMatchObject({ inner: true, overlay: true, overflows: true, inView: true, link: true, column: '5' })
  const pressAt = (on, x = overlayBar.x) => scroller().evaluate((element, { x, y, on }) => {
    const target = on === 'scroller' ? element : document.elementFromPoint(x, y)
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 }
    const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true }
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, ...pointer, buttons: 1 }))
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }))
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, ...pointer, buttons: 0 }))
    target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }))
  }, { x, y: overlayBar.y, on })
  await pressAt('scroller')
  await pressAt('scroller', overlayBar.x - 35)
  await page.waitForTimeout(300)
  await expect(queryTabs()).toHaveCount(1)
  expect(await active()).toEqual(beforeOverlayPress)
  await pressAt('cell')
  await expect(queryTabs()).toHaveCount(2)
  await expect(queryStatus(page)).toHaveText('Execution plan')
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  expect(await active()).toMatchObject({ row: 1, column: 3 })
  await overlayStyle.evaluate(node => node.remove())
  console.log('Results checks: XML, JSON and plan values open formatted in their own tabs, save as XML, and close without a session; a 2 MB value fills in without a long task; a press on an overlay scroll bar selects and opens nothing.')

  // 10. Messages stream while the script runs; errors are red and in order; the completion time and the error badge.
  await writeFile(join(control, 'hold', 'query.execute'), '')
  await run('-- varia-fake: sets=N1*10 messages=3 errors=2 hold', { running: true })
  await outputTab(/^Messages/).click()
  await expect(messages(page)).toContainText('Message 3')
  await expect(status()).toContainText(/^Executing · /)
  // The results head's executing icon turns (Icon's spin), and stops under the smoke runs' reduced motion. The run's state
  // shows there only: the status bar keeps the connection's facts.
  await expect(queryStatus(page).locator('[data-icon="loading"]')).toHaveCount(0)
  const spinner = status().locator('[data-icon="loading"]')
  await expect(spinner).toHaveClass(/\bcodicon-modifier-spin\b/)
  const turning = () => spinner.evaluate(element => getComputedStyle(element).animationName)
  expect(await turning()).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await turning()).toBe('codicon-spin')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await rm(join(control, 'hold', 'query.execute'))
  await expect(status()).toContainText(/^Completed with errors · /)
  const entries = await messageLines(page).evaluateAll((items, error) => items.map(item => [item.matches(error) ? 'error' : 'info', item.textContent]), part.errorMessage)
  expect(entries.slice(0, 5)).toEqual([['info', 'Message 1'], ['info', 'Message 2'], ['info', 'Message 3'], ['error', 'Msg 50000, Level 16, State 1, Line 1\nFake error 1.'], ['error', 'Msg 50000, Level 16, State 1, Line 2\nFake error 2.']])
  expect(entries.at(-1)[1]).toMatch(/^Completion time: \d{4}-\d\d-\d\dT/)
  expect((await computed(errorMessages(page).first())).color).toBe(await tokenColor('errorForeground'))
  await expect(outputTab(/^Messages/).locator(part.errorCount)).toHaveText('!')
  // The badges are drawn; the tabs' names say what they mean.
  await expect(outputTab(/^Messages/)).toHaveAccessibleName('Messages, contains errors')
  await expect(outputTab(/^Results/)).toHaveAccessibleName('Results, 1 result set')
  // Results and Messages are tabs: one Tab stop, and the arrow keys, Home and End show the tab they reach.
  await outputTab(/^Results/).click()
  await expect(outputTab(/^Results/)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(outputTab(/^Messages/)).toBeFocused()
  await expect(outputTab(/^Messages/)).toHaveAttribute('aria-selected', 'true')
  expect([await outputTab(/^Results/).getAttribute('tabindex'), await outputTab(/^Messages/).getAttribute('tabindex')]).toEqual(['-1', '0'])
  const panel = outputPane(page).getByRole('tabpanel')
  await expect(panel.getByRole('log', { name: 'Messages', exact: true })).toBeVisible()
  expect(await panel.getAttribute('aria-labelledby')).toBe(await outputTab(/^Messages/).getAttribute('id'))
  expect(await outputTab(/^Messages/).getAttribute('aria-controls')).toBe(await panel.getAttribute('id'))
  await page.keyboard.press('Home')
  await expect(outputTab(/^Results/)).toBeFocused()
  await expect(panel.locator('[data-result-grid]')).toHaveCount(1)
  await page.keyboard.press('ArrowLeft')
  await expect(outputTab(/^Messages/)).toBeFocused()
  await run('-- varia-fake: sets=W1*0')
  await outputTab(/^Messages/).click()
  await expect(messages(page)).toContainText('Commands completed successfully.')
  // Ctrl+A in Messages is the catalogue's output.selectAll (messagesFocus): it selects only their text, not the window's,
  // and Ctrl+C there stays Chromium's copy of it.
  await messages(page).click()
  await page.keyboard.press('Control+A')
  await expect.poll(() => messages(page).evaluate(log => {
    const selection = log.ownerDocument.getSelection(), range = selection.rangeCount === 1 ? selection.getRangeAt(0) : undefined
    return !!range && log.contains(range.startContainer) && log.contains(range.endContainer) && selection.toString().includes('Commands completed successfully.')
  })).toBe(true)
  await setClipboard('')
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toContain('Commands completed successfully.')
  console.log('Results checks: Messages stream, show errors in red and in order, and end with the completion time; Ctrl+A selects only their text.')

  // 11. Lifecycle: running again frees the last run's windows, closing a tab disposes its grids, and results outlive
  // Disconnect.
  await run('-- varia-fake: sets=W1*5000')
  await cell(0, 0).click()
  await page.keyboard.press('Control+End')
  await expect.poll(async () => (await stats()).client.uiWindows).toBeGreaterThan(1)
  await run('-- varia-fake: sets=M1*1')
  await expect(cell(0, 0)).toHaveText('0')
  await expect.poll(async () => (await stats()).client.uiWindows).toBe(1)
  const baseline = await stats()
  await page.keyboard.press('Control+N')
  await expect(queryTabs()).toHaveCount(2)
  if (!(await server().inputValue())) await server().selectOption({ index: 1 })
  await run('-- varia-fake: sets=W1*100,N1*10')
  await expect(page.locator('[data-result-grid]')).toHaveCount(2)
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  await expect.poll(async () => { const now = await stats(); return [now.grids, now.client.uiWindows] }).toEqual([baseline.grids, baseline.client.uiWindows])
  await run('-- varia-fake: sets=W1*3')
  await server().selectOption('')
  await expect(server()).toHaveValue('')
  await expect(cell(2, 1)).toHaveText(w1(2)[1])
  await cell(0, 0).click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(tsv([0, 1, 2].map(w1)))
  console.log('Results checks: results are freed on re-run and tab close, and stay readable and copyable after Disconnect.')

  // 12. Memory: both backend budgets, with a preview on hover and a pinned breakdown on click.
  await server().selectOption({ index: 1 })
  await run('-- varia-fake: sets=W1*10 memory=0.92')
  const memory = memoryIndicator(page)
  const memoryDetails = memoryBreakdown(page)
  const resultsMemory = memoryUsage(page, 'results')
  await expect(memory).toHaveAttribute('data-level', 'warning')
  await expect(memory).toHaveAccessibleName(/Results 91%|Results 92%/)
  await expect(memory.locator('.codicon-warning')).toHaveCount(1)
  await expect(memoryDetails).toBeHidden()
  await memory.hover()
  await expect(memoryDetails).toBeVisible()
  await expect(memoryDetails).toContainText('New results may be truncated.')
  await expect(memoryUsage(page, 'index')).toHaveText(/^[1-9]\d* MB \/ 512 MB$/)
  await expect(resultsMemory).toHaveText('236 MB / 256 MB')
  const triggerBox = await memory.boundingBox(), detailsBox = await memoryDetails.boundingBox()
  expect(detailsBox.y + detailsBox.height).toBeCloseTo(triggerBox.y, 0)
  expect(detailsBox.x).toBeGreaterThanOrEqual(0)
  await memoryDetails.hover()
  await expect(memoryDetails).toBeVisible()
  await page.mouse.move(5, 80)
  await expect(memoryDetails).toBeHidden()
  await memory.click()
  await page.mouse.move(5, 80)
  await expect(memoryDetails).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(memoryDetails).toBeHidden()
  await memory.press('Enter')
  await expect(memoryDetails).toBeVisible()
  await page.mouse.click(5, 80)
  await expect(memoryDetails).toBeHidden()
  await run('-- varia-fake: sets=W1*10 memory=0.96')
  await expect(memory).toHaveAttribute('data-level', 'critical')
  // Script As's segment, then the query's facts, give way to a long text; the backend status, the editor's segments (Ln/Col,
  // INS, EOL, encoding) and the indicator keep their size. Every segment keeps one line (step 17 fits a long server name
  // into a small window).
  expect(await statusBar(page).locator(`:scope > :not(${part.statusSegment})`).evaluateAll(parts => parts.map(part => getComputedStyle(part).flexShrink + ' ' + getComputedStyle(part).whiteSpace)))
    .toEqual(['0 nowrap', '1 nowrap', '0 nowrap', '0 nowrap'])
  // Closing the results releases them; the backend reports the fall before it answers, and the Results ring empties. Run
  // while a grid has focus, it moves focus to the Results tab, which stays, rather than dropping it with the grid.
  await cell(0, 0).click()
  await expect(grid()).toBeFocused()
  await page.keyboard.press('F1')
  await page.keyboard.type('close results')
  await expect(quickInputActive(page)).toContainText('Query: Close Results')
  await page.keyboard.press('Enter')
  await expect(resultsMemory).toHaveText('0 MB / 256 MB')
  await expect(memory).not.toHaveAttribute('data-level', /warning|critical/)
  await expect(page.locator('[data-result-grid]')).toHaveCount(0)
  await expect(outputTab(/^Results/)).toBeFocused()
  await expect(outputTab(/^Results/)).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true)
  // A small run after the store emptied shows up again and closing it empties the ring.
  const closeResults = async () => {
    await resultsToolbar(page).getByRole('button', { name: 'Close Results', exact: true }).click()
    await expect(outputTab(/^Results/)).toBeFocused()
  }
  await run('-- varia-fake: sets=W1*10 memory=0.1')
  await expect(resultsMemory).toHaveText('26 MB / 256 MB')
  await closeResults()
  await expect(resultsMemory).toHaveText('0 MB / 256 MB')
  // Two tabs' results add up, and closing one tab's leaves the other's.
  await run('-- varia-fake: sets=W1*10 memory=0.1')
  await expect(resultsMemory).toHaveText('26 MB / 256 MB')
  await page.keyboard.press('Control+N')
  await expect(queryTabs()).toHaveCount(2)
  if (!(await server().inputValue())) await server().selectOption({ index: 1 })
  await run('-- varia-fake: sets=W1*10 memory=0.1')
  await expect(resultsMemory).toHaveText('51 MB / 256 MB')
  await closeResults()
  await expect(resultsMemory).toHaveText('26 MB / 256 MB')
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  await expect(resultsMemory).toHaveText('26 MB / 256 MB')
  await closeResults()
  await expect(resultsMemory).toHaveText('0 MB / 256 MB')
  await run('-- varia-fake: sets=W1*10 memory=0')
  await expect(resultsMemory).toHaveText('0 MB / 256 MB')
  // Closing a tab of hundreds of sets frees every one of them: one request closes them all, where one request each ran
  // into main's limit of 64 outstanding and left most of them held.
  await page.keyboard.press('Control+N')
  await expect(queryTabs()).toHaveCount(2)
  if (!(await server().inputValue())) await server().selectOption({ index: 1 })
  await run('-- varia-fake: sets=M1*300 memory=0.5')
  await expect(resultsMemory).toHaveText('128 MB / 256 MB')
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  await expect(resultsMemory).toHaveText('0 MB / 256 MB')
  console.log('Results checks: both memory rings, hover and click details, the 90 % and 95 % Results thresholds, and memory released on close.')

  // 13. Menu: Shift+F10 on the grid lists its commands; a right-click on an unselected cell selects it first.
  await cell(1, 1).click()
  await page.keyboard.press('Shift+F10')
  const outputMenu = page.getByRole('menu', { name: 'Query output', exact: true })
  await expect(outputMenu).toBeVisible()
  expect(await menuItemNames(outputMenu)).toEqual(['Copy', 'Copy with Headers', 'Copy Column Name', 'Select All', 'Sort Ascending', 'Sort Descending', 'Then Sort Ascending', 'Then Sort Descending', 'Clear Sort', 'Filter', 'Highlight', 'Compare with Previous Result', 'Pivot Results…', 'Transpose', 'Fit Column', 'Save Results As…', 'Show Spaces and Tabs', 'Show All White Space', 'Column Profile', 'Show Row Size', 'Close Results'])
  await page.keyboard.press('Escape')
  // Shift+F10 right after a click opens at the cell just clicked, though the grid paints it as active only on its next
  // frame: below it (or above, when there is no room), from its left edge (or to its right edge, near the window's).
  for (const [row, column] of [[2, 1], [5, 3], [3, 2], [6, 1], [1, 3], [4, 2]]) {
    await cell(row, column).click()
    await page.keyboard.press('Shift+F10')
    await expect(outputMenu).toBeVisible()
    const menuBox = await outputMenu.boundingBox(), cellBox = await cell(row, column).boundingBox()
    expect(Math.min(Math.abs(menuBox.x - cellBox.x - 8), Math.abs(menuBox.x + menuBox.width - cellBox.x - cellBox.width)), `the menu's side for cell ${row}, ${column}`).toBeLessThanOrEqual(2)
    expect(Math.min(Math.abs(menuBox.y - cellBox.y - cellBox.height), Math.abs(menuBox.y + menuBox.height - cellBox.y)), `the menu's edge for cell ${row}, ${column}`).toBeLessThanOrEqual(2)
    await page.keyboard.press('Escape')
    await expect(outputMenu).toHaveCount(0)
  }
  await cell(3, 2).click({ button: 'right' })
  await expect(outputMenu).toBeVisible()
  await expect(cell(3, 2)).toHaveAttribute('aria-selected', 'true')
  await expect(cell(4, 2)).toHaveAttribute('aria-selected', 'false')
  await page.keyboard.press('Escape')
  await expect(outputMenu).toHaveCount(0)

  await cell(3, 2).click({ button: 'right' })
  await outputMenu.getByRole('menuitem', { name: 'Close Results', exact: true }).click()
  await expect(page.locator('[data-result-grid]')).toHaveCount(0)
  await expect(outputTab(/^Results/)).toBeFocused()
  await outputTab(/^Messages/).click()
  await expect(messageLines(page).first()).toBeVisible()

  // Messages has its own copy of the output tabs, which leaves when Close Results selects the Results panel.
  await run('-- varia-fake: sets=N1*3 messages=1')
  await outputTab(/^Messages/).click()
  await messages(page).click({ button: 'right' })
  await outputMenu.getByRole('menuitem', { name: 'Close Results', exact: true }).click()
  await expect(page.locator('[data-result-grid]')).toHaveCount(0)
  await expect(outputTab(/^Results/)).toHaveAttribute('aria-selected', 'true')
  await expect(outputTab(/^Results/)).toBeFocused()
  await outputTab(/^Messages/).click()
  await expect(messageLines(page).first()).toBeVisible()

  // 13b. Column profile and row size: the results toolbar's Profile opens a card per column, computed by the backend over
  // the set (results.profile), and closes from the panel; Row size draws a bar behind each row number with its bytes in
  // the tooltip, and hides it when turned off.
  await run('-- varia-fake: sets=W1*100')
  await settled()
  const show = name => resultsToolbar(page).getByRole('group', { name: 'Show', exact: true }).getByRole('button', { name, exact: true })
  await expect(show('Profile')).toHaveAttribute('aria-pressed', 'false')
  // The toolbar fits the output pane at the window's size (the runners' 1024 px included): nothing in it is clipped.
  expect(await resultsToolbar(page).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await show('Profile').click()
  await expect(columnProfile(page)).toBeVisible()
  await expect(show('Profile')).toHaveAttribute('aria-pressed', 'true')
  await expect(columnProfile(page)).toContainText('100 rows')
  await expect.poll(() => profileFigures(profileCard(page, 'id'))).toMatchObject({ NULLs: '0', Distinct: '100 · unique', Min: '0', Max: '99' })
  await expect.poll(() => profileFigures(profileCard(page, 'score'))).toMatchObject({ NULLs: '20 (20%)' })
  expect(await profileFigures(profileCard(page, 'name'))).toHaveProperty('Length')
  // Running again with the panel open replaces the run's grids rather than leaving the last run's beside them.
  await run('-- varia-fake: sets=W1*100')
  await settled()
  await run('-- varia-fake: sets=W1*100')
  await settled()
  await expect(anyResultGrid(page)).toHaveCount(1)
  await expect(columnProfile(page)).toHaveCount(1)
  await expect(columnProfile(page)).toContainText('100 rows')
  await columnProfile(page).getByRole('button', { name: 'Close Column Profile', exact: true }).click()
  await expect(columnProfile(page)).toHaveCount(0)
  await expect(show('Profile')).toHaveAttribute('aria-pressed', 'false')
  await expect(show('Row size')).toHaveAttribute('aria-pressed', 'true')
  await expect(rowNumber(0)).toHaveAttribute('title', /^Row 1: [\d,]+ bytes/)
  expect(Number(await rowNumber(0).evaluate(element => element.style.getPropertyValue('--rg-rs')))).toBeGreaterThan(0)
  await show('Row size').click()
  await expect(show('Row size')).toHaveAttribute('aria-pressed', 'false')
  await expect(rowNumber(0)).not.toHaveAttribute('title', /bytes/)
  await show('Row size').click()
  await expect(rowNumber(0)).toHaveAttribute('title', /^Row 1: /)
  console.log('Results checks: the column profile panel shows the figures the backend computes for each column, and the row-size bar shows and hides with its bytes.')

  // 13b2. Pivot: the results toolbar's Pivot opens the panel on the grid; a row group (active: 1 for every third id) with a
  // Count of rows and a Max of id, built in the backend (results.pivot), adds the pivot as the run's next result.
  await expect(show('Pivot')).toHaveAttribute('aria-pressed', 'false')
  await show('Pivot').click()
  const pivoting = pivotPanel(page)
  await expect(pivoting).toBeVisible()
  await expect(show('Pivot')).toHaveAttribute('aria-pressed', 'true')
  await pivoting.getByRole('combobox', { name: 'Add row group', exact: true }).selectOption({ label: 'active' })
  await expect(pivoting.getByRole('button', { name: 'Remove row group active', exact: true })).toBeVisible()
  await pivoting.getByRole('button', { name: 'Add value', exact: true }).click()
  await pivoting.getByRole('combobox', { name: 'Value 2 aggregate', exact: true }).selectOption({ label: 'Max' })
  await expect(pivoting.getByRole('combobox', { name: 'Value 2 column', exact: true })).toHaveValue('0')
  // Sum and Average take only numbers: the text name column is not offered for them.
  await pivoting.getByRole('combobox', { name: 'Value 1 aggregate', exact: true }).selectOption({ label: 'Sum' })
  await expect(pivoting.getByRole('combobox', { name: 'Value 1 column', exact: true }).getByRole('option', { name: 'name', exact: true })).toBeDisabled()
  await pivoting.getByRole('combobox', { name: 'Value 1 aggregate', exact: true }).selectOption({ label: 'Count' })
  await pivoting.getByRole('combobox', { name: 'Value 1 column', exact: true }).selectOption({ label: '(Rows)' })
  await pivoting.getByRole('button', { name: 'Build Pivot', exact: true }).click()
  const pivoted = grid('Pivot of Result 1')
  await expect(cell(1, 2, pivoted)).toHaveText('99')
  for (const name of ['active', 'Count of rows', 'Max of id']) await expect(pivoted.getByRole('columnheader', { name: new RegExp(`^${name}`) })).toHaveCount(1)
  expect(await Promise.all([0, 1].map(row => Promise.all([0, 1, 2].map(column => cell(row, column, pivoted).textContent()))))).toEqual([['0', '66', '98'], ['1', '34', '99']])
  await expect(strip('Pivot of Result 1')).toContainText('Pivot of Result 1: 100 rows in 2 row groups.')
  await expect(page.getByRole('button', { name: 'Pivot of Result 1', exact: true })).toBeVisible()
  await expect(pivoting.getByRole('combobox', { name: 'Pivot source', exact: true }).getByRole('option', { name: 'Pivot of Result 1', exact: true })).toHaveCount(1)
  await page.screenshot({ path: resolve('artifacts', 'results-pivot.png') })
  await pivoting.getByRole('button', { name: 'Close Pivot', exact: true }).click()
  await expect(pivotPanel(page)).toHaveCount(0)
  await expect(show('Pivot')).toHaveAttribute('aria-pressed', 'false')
  // A pivot past its bounds is refused, not shown in part: 300 ids as column groups say so in the panel, which keeps the
  // draft, and add no result. Running again releases the pivot with the run's other results.
  await run('-- varia-fake: sets=W1*300')
  await settled()
  await expect(anyResultGrid(page)).toHaveCount(1)
  await show('Pivot').click()
  await expect(pivoting.getByRole('button', { name: 'Remove row group active', exact: true })).toBeVisible()
  await pivoting.getByRole('combobox', { name: 'Column group', exact: true }).selectOption({ label: 'id' })
  await pivoting.getByRole('button', { name: 'Build Pivot', exact: true }).click()
  await expect(pivoting.getByRole('status')).toContainText('The column group has 300 distinct values, and a pivot can have at most 256 column groups.')
  await expect(anyResultGrid(page)).toHaveCount(1)
  await pivoting.getByRole('button', { name: 'Close Pivot', exact: true }).click()
  await run('-- varia-fake: sets=W1*100')
  await settled()
  await expect(anyResultGrid(page)).toHaveCount(1)
  console.log('Results checks: Pivot groups the rows of a grid by a column in the backend and adds the counts and maxima as a new result, offering Sum only for numeric columns and refusing a pivot past its bounds in the panel.')

  // 13b3. Transpose: the results toolbar's Transpose turns the grid's 8 columns into rows and its 100 rows into columns in
  // the backend (results.transpose), added as the run's next result, which sorts as any other. The grid menu's Transpose
  // submenu takes only the selected rows, or names the columns by the active cell's column; past 4,095 rows it takes the
  // first ones and says so. Running again releases the transposes with the run's other results.
  const transposeMenu = async (row, column, name) => {
    await cell(row, column).click({ button: 'right' })
    await outputMenu.getByRole('menuitem', { name: 'Transpose', exact: true }).click()
    await page.getByRole('menu', { name: 'Transpose', exact: true }).getByRole('menuitem', { name, exact: true }).click()
  }
  // A window narrower than 1180 pixels (Windows CI's display) hides the toolbar's Transpose; the grid's menu has it too.
  if (await show('Transpose').isVisible()) await show('Transpose').click()
  else await transposeMenu(0, 0, 'All Rows')
  const transposed = grid('Result 2')
  await expect(cell(0, 0, transposed)).toHaveText('id')
  expect(await Promise.all([0, 1, 2].map(column => cell(0, column, transposed).textContent()))).toEqual(['id', '0', '1'])
  for (const name of ['Column', 'Row 1', 'Row 2']) await expect(transposed.getByRole('columnheader', { name: new RegExp(`^${name}\\b`) }).first()).toBeVisible()
  await expect(cell(6, 0, transposed)).toHaveText('active')
  await expect(strip('Result 2')).toContainText('Transpose of Result 1: 8 columns as rows, 100 rows as columns.')
  await expect(page.getByRole('button', { name: 'Transpose of Result 1', exact: true })).toBeVisible()
  await page.screenshot({ path: resolve('artifacts', 'results-transpose.png') })
  // The transpose sorts as any result: its Column column ascending puts active first.
  await cell(0, 0, transposed).click({ button: 'right' })
  await outputMenu.getByRole('menuitem', { name: 'Sort Ascending', exact: true }).click()
  await expect(cell(0, 0, transposed)).toHaveText('active')
  // Selected rows (rows 3 and 4 of Result 1) make a record view, its columns named by position.
  const firstName = await cell(0, 1).textContent()
  await cell(2, 0).click()
  await cell(3, 0).click({ modifiers: ['Shift'] })
  await transposeMenu(3, 0, 'Selected Rows')
  const selectedRows = grid('Result 3')
  await expect(cell(0, 1, selectedRows)).toHaveText('2')
  expect(await Promise.all([0, 1, 2].map(column => cell(0, column, selectedRows).textContent()))).toEqual(['id', '2', '3'])
  await expect(strip('Result 3')).toContainText('Transpose of Result 1: 8 columns as rows, 2 selected rows as columns.')
  // Using Column as Headers names the columns by the name column's values. Running again releases the transposes first,
  // so the new one is the second set, in view.
  await run('-- varia-fake: sets=W1*100')
  await settled()
  await expect(anyResultGrid(page)).toHaveCount(1)
  await cell(0, 1).click()
  await transposeMenu(0, 1, 'Using Column as Headers')
  const named = grid('Result 2')
  await expect(cell(0, 1, named)).toHaveText('0')
  await expect(named.getByRole('columnheader', { name: new RegExp(`^${firstName}`) })).toHaveCount(1)
  await expect(strip('Result 2')).toContainText(', named by name.')
  // Past 4,095 rows: the first ones, and the strip says how to transpose the others.
  await run('-- varia-fake: sets=W1*5000')
  await settled()
  await expect(anyResultGrid(page)).toHaveCount(1)
  await transposeMenu(0, 0, 'All Rows')
  await expect(strip('Result 2')).toContainText('Transposed the first 4,095 of 5,000 rows; filter or select rows to transpose others.')
  await run('-- varia-fake: sets=W1*100')
  await settled()
  await expect(anyResultGrid(page)).toHaveCount(1)
  console.log('Results checks: Transpose turns a grid into a new result of its columns as rows in the backend, of all rows, the selected ones or named by a column, sorts it as any result, and says when it took the first 4,095 rows only.')

  // 13c. Filters: the grid menu's Filter submenu filters by the selected cells' values, without NULL, between the lowest and
  // highest selected value and to duplicates; the caption counts the rows kept and lists each filter, named by its values,
  // with a Remove button, and Clear filters takes them all off. W1's active is 1 for every third id; its score is NULL for
  // ids ending in 4 or 9.
  const filterMenu = async (row, column, name) => {
    await cell(row, column).click({ button: 'right' })
    await outputMenu.getByRole('menuitem', { name: 'Filter', exact: true }).click()
    await page.getByRole('menu', { name: 'Filter', exact: true }).getByRole('menuitem', { name, exact: true }).click()
  }
  const filterList = outputPane(page).getByRole('group', { name: 'Filters of Result 1', exact: true })
  const caption = page.locator(part.resultCaption)
  // Clicking a far column scrolls the grid sideways, and a narrow window then leaves id out of the rendered columns. Each
  // menu opens on a cell already in view, since a scroll closes it.
  const idInView = () => scroller().evaluate(element => { element.scrollLeft = 0 })
  await cell(0, 6).click()
  await filterMenu(0, 6, 'Filter for Selected Values')
  await expect(caption).toContainText('34 of 100 rows')
  await expect(filterList).toContainText("active = '1'")
  await filterMenu(0, 7, 'Exclude NULLs')
  await expect(caption).toContainText('27 of 100 rows')
  await expect(filterList).toContainText('score is not NULL')
  await idInView()
  await expect(cell(1, 0)).toHaveText('3')
  // Ids 3, 6 and 12 selected in the filtered grid: Between keeps ids 3 to 12 that pass the other filters.
  await idInView()
  await cell(1, 0).click()
  await cell(3, 0).click({ modifiers: ['Shift'] })
  await filterMenu(3, 0, 'Filter Between Lowest and Highest Selected')
  await expect(filterList).toContainText("id between '3' and '12'")
  await expect(caption).toContainText('3 of 100 rows')
  // Without the first filter, ids 3 to 12 with a score: 3, 5, 6, 7, 8, 10, 11, 12.
  await filterList.getByRole('button', { name: "Remove filter active = '1'", exact: true }).click()
  await expect(caption).toContainText('8 of 100 rows')
  // Duplicates in active: every row repeats a value, each group together in the order of its first row (1s, then 0s).
  await cell(0, 6).click()
  await filterMenu(0, 6, 'Filter for Duplicates in Selected Columns')
  await expect(filterList).toContainText('Duplicates in active')
  await idInView()
  await expect(cell(2, 0)).toHaveText('12')
  await expect(cell(3, 0)).toHaveText('5')
  await expect(caption).toContainText('8 of 100 rows')
  await page.screenshot({ path: resolve('artifacts', 'results-filters.png') })
  await filterList.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(filterList).toHaveCount(0)
  // The focused button went with the filters: focus is on the result's caption, not lost to the page.
  await expect(outputPane(page).getByRole('button', { name: 'Result 1', exact: true })).toBeFocused()
  await expect(caption).toContainText('100 rows')
  await expect(caption).not.toContainText(' of ')
  await idInView()
  await expect(cell(1, 0)).toHaveText('1')
  console.log('Results checks: the Filter submenu filters by selected values, NULL, a range and duplicates; the caption counts the rows and removes and clears filters.')

  // 13c2. Keep Selected Rows: the rows the selection covers, whatever their values, as one filter whose chip counts them.
  // A sort keeps them, and keeping a selection of the kept rows replaces the filter instead of adding another.
  await idInView()
  await cell(1, 0).click()
  await cell(3, 0).click({ modifiers: ['Shift'] })
  await filterMenu(3, 0, 'Keep Selected Rows')
  await expect(filterList).toContainText('3 selected rows')
  await expect(caption).toContainText('3 of 100 rows')
  await expect(cell(0, 0)).toHaveText('1')
  await expect(cell(2, 0)).toHaveText('3')
  await cell(1, 0).click()
  await filterMenu(1, 0, 'Keep Selected Rows')
  await expect(filterList).toContainText('1 selected row')
  await expect(filterList).not.toContainText('3 selected rows')
  await expect(caption).toContainText('1 of 100 rows')
  await expect(cell(0, 0)).toHaveText('2')
  await page.screenshot({ path: resolve('artifacts', 'results-keep-rows.png') })
  await filterList.getByRole('button', { name: 'Remove filter 1 selected row', exact: true }).click()
  await expect(filterList).toHaveCount(0)
  await expect(caption).toContainText('100 rows')
  await expect(caption).not.toContainText(' of ')
  console.log('Results checks: Keep Selected Rows filters a grid to its selected rows, counts them in its chip, and a new one replaces it.')

  // 13d. The header funnel (results.distinct): its popover lists a column's distinct values with their counts as a
  // checklist; OK filters by the values ticked, the funnel stays filled while its column is filtered, Alt+Down opens it
  // for the active cell's column, NULL is an entry, a search narrows the list, a custom condition filters between two
  // values, the list reflects what the column's filter keeps, Clear filter takes the column's filters off and Escape
  // closes it unchanged. In W1, active is 1 for every third id (34 rows) and 0 for the rest (66).
  const funnel = name => page.getByRole('dialog', { name: `Filter ${name}`, exact: true })
  // A wide header's funnel opens on a click (a narrow one leaves clicks to selecting its column); Cancel changes nothing.
  await idInView()
  await header('name').hover()
  await header('name').locator(gridPart.funnelButton).click()
  await expect(funnel('name').getByRole('checkbox', { name: 'Customer 0000000001 GmbH (1)', exact: true })).toBeChecked()
  await expect(funnel('name').getByRole('searchbox', { name: 'Search values', exact: true })).toBeFocused()
  await expect(funnel('name')).toContainText('100 values in 100 rows.')
  await funnel('name').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(funnel('name')).toHaveCount(0)
  // A second press on the open funnel closes it, as a menu button does.
  await header('name').hover()
  await header('name').locator(gridPart.funnelButton).click()
  await expect(funnel('name')).toBeVisible()
  await header('name').locator(gridPart.funnelButton).click()
  await expect(funnel('name')).toHaveCount(0)
  await expect(caption).not.toContainText(' of ')
  await cell(0, 6).click()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(funnel('active').getByRole('checkbox', { name: '0 (66)', exact: true })).toBeChecked()
  await funnel('active').getByRole('checkbox', { name: '1 (34)', exact: true }).uncheck()
  await funnel('active').getByRole('button', { name: 'OK', exact: true }).click()
  await expect(funnel('active')).toHaveCount(0)
  await expect(caption).toContainText('66 of 100 rows')
  await expect(filterList).toContainText("active = '0'")
  await expect(header('active').locator(gridPart.funnelOn)).toBeVisible()
  // Score in the 66 rows: NULL for ids ending in 4 or 9 that are not a multiple of 3, 13 of them.
  await cell(0, 7).click()
  await page.keyboard.press('Alt+ArrowDown')
  const score = funnel('score')
  await expect(score.getByRole('checkbox', { name: 'NULL (13)', exact: true })).toBeChecked()
  await score.getByRole('searchbox', { name: 'Search values', exact: true }).fill('zzz')
  await expect(score).toContainText('No values match.')
  await score.getByRole('searchbox', { name: 'Search values', exact: true }).fill('')
  await score.getByRole('button', { name: 'Select none', exact: true }).click()
  await expect(score.getByRole('checkbox', { name: 'NULL (13)', exact: true })).not.toBeChecked()
  await score.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(score.getByRole('alert')).toHaveText('Select at least one value.')
  await score.getByRole('checkbox', { name: 'NULL (13)', exact: true }).check()
  await score.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(caption).toContainText('13 of 100 rows')
  await expect(filterList).toContainText('score is NULL')
  // The grid has the focus back: Alt+Down opens score again, whose Clear filter takes its filter off.
  await page.keyboard.press('Alt+ArrowDown')
  await score.getByRole('button', { name: 'Clear filter', exact: true }).click()
  await expect(caption).toContainText('66 of 100 rows')
  await expect(header('score').locator(gridPart.funnelOn)).toHaveCount(0)
  // A custom condition, from the ids the 66 rows hold: id between 2 and 13 keeps 2, 4, 5, 7, 8, 10, 11 and 13.
  await idInView()
  await cell(0, 0).click()
  await page.keyboard.press('Alt+ArrowDown')
  await funnel('id').getByRole('combobox', { name: 'Condition', exact: true }).selectOption({ label: 'Between' })
  await expect(funnel('id').getByRole('checkbox').first()).toBeDisabled()
  await funnel('id').getByRole('combobox', { name: 'Lowest value', exact: true }).selectOption({ label: '2' })
  await funnel('id').getByRole('combobox', { name: 'Highest value', exact: true }).selectOption({ label: '13' })
  await funnel('id').getByRole('button', { name: 'OK', exact: true }).click()
  await expect(caption).toContainText('8 of 100 rows')
  await expect(filterList).toContainText("id between '2' and '13'")
  // Active's list now covers the ids 2 to 13 (its own filter left out), with only the value its filter keeps ticked.
  await cell(0, 6).click()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(funnel('active').getByRole('checkbox', { name: '0 (8)', exact: true })).toBeChecked()
  await expect(funnel('active').getByRole('checkbox', { name: '1 (4)', exact: true })).not.toBeChecked()
  await page.screenshot({ path: resolve('artifacts', 'results-funnel.png') })
  await page.keyboard.press('Escape')
  await expect(funnel('active')).toHaveCount(0)
  await expect(grid()).toBeFocused()
  await expect(caption).toContainText('8 of 100 rows')
  await filterList.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(caption).not.toContainText(' of ')
  console.log('Results checks: the header funnel lists distinct values with counts, filters by the values ticked, NULL, a search, a range and Clear filter, and opens with Alt+Down.')

  // 14. Styling: NULL, truncation, read errors and the selection (focused or not) take their tokens; a theme change
  // recolours the same nodes.
  await run('-- varia-fake: sets=N1*20')
  const nullCell = cell(1, 1)
  await nullCell.evaluate(element => { element.dataset.identity = 'kept' })
  for (const mode of ['dark', 'light']) {
    await page.evaluate(value => window.varia.setThemePreference({ mode: value }), mode)
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe(mode)
    await textbox().focus()
    // The set's rows are painted a frame or more after the run completes.
    const nullColors = { color: await tokenColor('resultsGrid.nullForeground'), background: await tokenColor('resultsGrid.nullBackground') }
    await expect.poll(() => computed(nullCell)).toEqual(nullColors)
    expect(await nullCell.evaluate(element => getComputedStyle(element).fontStyle)).toBe('italic')
    expect((await computed(cell(1, 3), '::after')).color).toBe(await tokenColor('resultsGrid.truncationForeground'))
    expect((await computed(cell(2, 4))).color).toBe(await tokenColor('errorForeground'))
    await cell(0, 0).click()
    const selection = { color: await tokenColor('resultsGrid.selectionForeground'), background: await tokenColor('resultsGrid.selectionBackground') }
    await expect.poll(() => computed(cell(0, 0))).toEqual(selection)
    await page.screenshot({ path: resolve('artifacts', `results-${mode}.png`) })
    await textbox().focus()
    const inactive = await tokenColor('resultsGrid.inactiveSelectionBackground')
    await expect.poll(async () => (await computed(cell(0, 0))).background).toBe(inactive)
    // A selected NULL takes the grid's text color while the grid is not focused: its tint is too faint on that fill.
    await nullCell.click()
    await textbox().focus()
    await expect.poll(() => computed(nullCell)).toEqual({ color: await tokenColor('resultsGrid.foreground'), background: inactive })
    await cell(0, 0).click()
    await expect(nullCell).toHaveAttribute('data-identity', 'kept')
  }
  // In forced colors a selected value's truncation marker and the selection's column and row headers take the system's
  // selection colors, as the selected cells do.
  await page.emulateMedia({ forcedColors: 'active' })
  await cell(1, 3).click()
  // The grid paints the selection on its next frame.
  await expect(cell(1, 3)).toHaveAttribute('aria-selected', 'true')
  const selectedCell = await computed(cell(1, 3))
  await expect.poll(() => computed(cell(1, 3), '::after')).toEqual(selectedCell)
  await expect.poll(async () => (await computed(header('clipped'))).background).toBe(selectedCell.background)
  expect(selectedCell.background).not.toBe((await computed(header('id'))).background)
  await expect.poll(async () => (await computed(rowNumber(1))).background).toBe(selectedCell.background)
  // NULL's tint is dropped too: its dimmed text still tells it from a value.
  expect((await computed(nullCell)).color).not.toBe((await computed(cell(1, 0))).color)
  await page.emulateMedia({ forcedColors: null })
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))
  console.log('Results checks: NULL, truncated, failed and selected cells take their theme tokens, and a theme change keeps the grid\'s nodes.')

  // 14b. White space: the results toolbar marks spaces and tabs, then line breaks and invisible characters too. The marks
  // are drawn only: the active cell's name and Copy keep the value, and the grid's menu checks the choice that is on.
  const whitespace = resultsToolbar(page).getByRole('group', { name: 'White space', exact: true })
  const choice = name => whitespace.getByRole('button', { name, exact: true })
  const cellText = (row, column) => cell(row, column).evaluate(element => element.textContent)
  await expect(choice('Off')).toHaveAttribute('aria-pressed', 'true')
  expect(await cellText(3, 2)).toBe('😀 astral')
  await choice('Spaces').click()
  await expect(choice('Spaces')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => cellText(3, 2)).toBe('😀·astral')
  // A line break Spaces does not mark stays one line, as it shows when off.
  expect(await cellText(5, 2)).toBe('tab→line quote"\\')
  await choice('Spaces').press('ArrowRight')
  await expect(choice('All')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(choice('All')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => cellText(5, 2)).toBe('tab→lineLFquote"\\')
  await expect(cell(5, 2).locator(gridPart.whitespaceBadge)).toHaveText('LF')
  expect(await cellText(4, 2)).toBe('BOMbom')
  expect((await computed(cell(5, 2).locator(gridPart.whitespaceMark).first())).color).toBe(await tokenColor('resultsGrid.whitespaceForeground'))
  await cell(3, 2).click()
  await expect(cell(3, 2)).toHaveAttribute('aria-label', /^😀 astral/)
  await setClipboard('')
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe('😀 astral')
  await page.keyboard.press('Shift+F10')
  const shownAll = page.getByRole('menu', { name: 'Query output', exact: true }).getByRole('menuitemcheckbox', { name: /^Show All White Space/ })
  await expect(shownAll).toHaveAttribute('aria-checked', 'true')
  await shownAll.click()
  await expect(choice('Off')).toHaveAttribute('aria-pressed', 'true')
  await expect(grid().locator(gridPart.whitespaceMark)).toHaveCount(0)
  expect(await cellText(5, 2)).toBe('tab line quote"\\')
  console.log('Results checks: White space marks spaces, tabs, line breaks and a BOM, from the toolbar and the grid\'s menu, while Copy and the cell\'s name keep the value.')

  // 14c. Sorting: a header's sort button sorts ascending, then descending, and Shift+click adds a key; the header says
  // so with aria-sort and the button with its arrow and place. A narrow header keeps its clicks for selecting the column,
  // and the grid's menu sorts it. Copy follows the order shown; Clear Sort shows the rows as SQL Server sent them.
  const sortButton = name => header(name).locator(gridPart.sortButton)
  const menuSort = async (column, name) => {
    await cell(0, column).click({ button: 'right' })
    await outputMenu.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click()
  }
  await header('clipped').hover()
  await sortButton('clipped').click()
  await expect(header('clipped')).toHaveAttribute('aria-sort', 'ascending')
  await expect(cell(0, 0)).toHaveText('0')
  await sortButton('clipped').click()
  await expect(header('clipped')).toHaveAttribute('aria-sort', 'descending')
  // Text order, not row order: the stored prefixes "truncated pre" first (rows 1, 5, …), then "complete 8" down to
  // "complete 0", ties in row order (rows past the pane are not drawn).
  await expect(cell(0, 0)).toHaveText('1')
  await expect(cell(5, 0)).toHaveText('8')
  await expect(cell(6, 0)).toHaveText('7')
  // The button took the presses: the selection is still the one cell White space left selected.
  await expect(grid().locator(gridPart.selectedCell)).toHaveCount(1)
  await cell(0, 0).click()
  await setClipboard('')
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe('1')
  // "id" is too narrow for the button: a click on it selects the column even where a wide header's button would be.
  const narrowBox = await header('id').boundingBox()
  await page.mouse.click(narrowBox.x + narrowBox.width - 12, narrowBox.y + narrowBox.height / 2)
  await expect(grid().locator(gridPart.selectedColumnHeader)).toHaveAttribute('aria-colindex', '2')
  await expect(header('clipped')).toHaveAttribute('aria-sort', 'descending')
  // NULL sorts lowest; Shift+click adds "clipped" after "maybe", numbered on both buttons.
  await menuSort(1, 'Sort Ascending')
  await expect(header('maybe')).toHaveAttribute('aria-sort', 'ascending')
  await expect(header('clipped')).not.toHaveAttribute('aria-sort', /./)
  await expect(cell(0, 1)).toHaveText('NULL')
  await header('clipped').hover()
  await sortButton('clipped').click({ modifiers: ['Shift'] })
  await expect(sortButton('clipped').locator(gridPart.sortOrder)).toHaveText('2')
  await expect(sortButton('maybe').locator(gridPart.sortOrder)).toHaveText('1')
  await expect(header('maybe')).toHaveAttribute('aria-sort', 'ascending')
  await menuSort(0, 'Clear Sort')
  await expect(header('maybe')).not.toHaveAttribute('aria-sort', /./)
  await expect(grid().locator(gridPart.sortedButton)).toHaveCount(0)
  await expect(cell(0, 0)).toHaveText('0')
  await expect(cell(5, 0)).toHaveText('5')
  console.log('Results checks: header sort buttons sort ascending, descending and by a further key, narrow headers keep selecting, the menu sorts, Copy follows the order, and Clear Sort restores it.')

  // 14d. Highlights: Ctrl+Shift+H colours the selected rows (yellow at first) and the grid's Highlight submenu picks a
  // colour; each follows its row by the key the backend picked (id) through a sort and a re-run of the query, and the row
  // header names it for screen readers. Clear All Highlights takes them off.
  const highlighted = () => grid().locator(gridPart.highlightedRow)
  const rowHeaderAt = row => grid().locator(`[role="row"][aria-rowindex="${row + 2}"] > ${gridPart.rowHeader}`)
  const highlightMenu = async (row, name) => {
    await cell(row, 1).click({ button: 'right' })
    await outputMenu.getByRole('menuitem', { name: 'Highlight', exact: true }).click()
    await page.getByRole('menu', { name: 'Highlight', exact: true }).getByRole('menuitem', { name, exact: true }).click()
  }
  await cell(1, 0).click()
  await page.keyboard.press('Control+Shift+H')
  await expect(rowHeaderAt(1)).toHaveAttribute('aria-description', 'Highlighted yellow')
  await highlightMenu(3, 'Green')
  await expect(rowHeaderAt(3)).toHaveAttribute('aria-description', 'Highlighted green')
  await expect(highlighted()).toHaveCount(2)
  // Sorted by id descending, ids 3 and 1 are rows 17 and 19 of 20: the highlights moved with them.
  await menuSort(0, 'Sort Descending')
  await expect(cell(0, 0)).toHaveText('19')
  await page.keyboard.press('Control+End')
  await expect(cell(18, 0)).toHaveText('1')
  await expect(rowHeaderAt(18)).toHaveAttribute('aria-description', 'Highlighted yellow')
  await expect(rowHeaderAt(16)).toHaveAttribute('aria-description', 'Highlighted green')
  await expect(rowHeaderAt(17)).not.toHaveAttribute('aria-description', /./)
  // The same query again: its new result's rows are told apart by id, and the highlights find their rows there.
  await run('-- varia-fake: sets=N1*20')
  await expect(rowHeaderAt(1)).toHaveAttribute('aria-description', 'Highlighted yellow')
  await expect(rowHeaderAt(3)).toHaveAttribute('aria-description', 'Highlighted green')
  // Ctrl+Shift+H uses the colour last picked (green); again on rows that all have it, it takes it off.
  await cell(1, 0).click()
  await page.keyboard.press('Control+Shift+H')
  await expect(rowHeaderAt(1)).toHaveAttribute('aria-description', 'Highlighted green')
  await page.keyboard.press('Control+Shift+H')
  await expect(rowHeaderAt(1)).not.toHaveAttribute('aria-description', /./)
  await expect(highlighted()).toHaveCount(1)
  await highlightMenu(0, 'Clear All Highlights')
  await expect(highlighted()).toHaveCount(0)
  console.log('Results checks: Highlight Rows and the Highlight submenu colour rows, which keep their colours through a sort and a re-run, and Clear All Highlights clears them.')

  // 14e. Search in results: Ctrl+F in a grid puts the focus in the toolbar's search box; the backend finds the cells
  // (results.search) and the grid marks them, the active one outlined. Enter, Shift+Enter and F3 step through them, a
  // sort searches again through its order, Columns matches column names, and Escape clears it all.
  const searchBox = resultsToolbar(page).getByRole('textbox', { name: 'Search results', exact: true })
  const searchCount = resultsSearchCount(page), searchAnnouncer = resultsSearchAnnouncer(page)
  const searchMode = name => resultsToolbar(page).getByRole('group', { name: 'Search in', exact: true }).getByRole('button', { name, exact: true })
  // Pooled slots out of view keep their last classes while hidden, so only shown marks count.
  const marked = selector => grid().locator(selector).filter({ visible: true })
  const currentMatch = marked(gridPart.searchCurrent)
  // The menu opens on the active match, in "clipped" and in view: a cell out of view would scroll the grid, which closes
  // menus; a step's reveal may still be scrolling as it opens, so it opens again until it stays.
  const searchSort = name => expect(async () => {
    await currentMatch.click({ button: 'right' })
    await outputMenu.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  // A 1024-wide window, as on a CI display: the box keeps its buttons clear of the groups after it.
  await resize(1024, 700)
  const clear = () => page.evaluate(() => {
    const search = document.querySelector('[role="toolbar"][aria-label="Results tools"] [role="group"][aria-label="Search in"]').parentElement
    let next = search.nextElementSibling
    while (next && next.getBoundingClientRect().width === 0) next = next.nextElementSibling
    return !!next && search.getBoundingClientRect().right <= next.getBoundingClientRect().left + 0.5
  })
  // Compact mode hides the magnifier even after Monaco loads its more specific codicon display rule.
  await expect(resultsToolbar(page).locator(part.resultsSearchIcon)).toBeHidden()
  // With the box empty every group fits, including Close Results. Report geometry and fonts on a failure.
  const toolsLayout = await resultsToolbar(page).evaluate(tools => {
    const last = [...tools.children].filter(child => child.getBoundingClientRect().width > 0).at(-1)
    const right = tools.getBoundingClientRect().right, lastRight = last.getBoundingClientRect().right
    return { fits: lastRight <= right + 0.5, right, lastRight, width: tools.clientWidth, scroll: tools.scrollWidth, font: getComputedStyle(tools).font,
      groups: [...tools.children].filter(child => child.getBoundingClientRect().width > 0).map(child => ({ name: child.getAttribute('aria-label'), width: child.getBoundingClientRect().width })) }
  })
  expect(toolsLayout.fits, JSON.stringify(toolsLayout)).toBe(true)
  // Transpose gives way in a narrow window (it is in the grid's menu and the palette), so the other groups fit.
  await expect(resultsToolbar(page).getByRole('button', { name: 'Transpose', exact: true })).toBeHidden()
  await expect(resultsToolbar(page).getByRole('button', { name: 'Close Results', exact: true })).toBeInViewport({ ratio: 1 })
  await cell(0, 0).click()
  await page.keyboard.press('Control+F')
  await expect(searchBox).toBeFocused()
  // The live region says each count once it settles, not "Searching…" and every keystroke's count on the way (#347).
  await searchAnnouncer.evaluate(element => {
    window.__variaSearchSaid = []
    window.__variaSearchObserver = new MutationObserver(() => { if (element.textContent) window.__variaSearchSaid.push(element.textContent) })
    window.__variaSearchObserver.observe(element, { childList: true, characterData: true, subtree: true })
  })
  // "complete 10" to "complete 19" in "clipped", but for rows 13 and 17, stored as "truncated pre".
  await page.keyboard.type('COMPLETE 1')
  await expect(searchCount).toHaveText('1 of 8')
  await expect(currentMatch).toHaveText('complete 10')
  await expect(currentMatch).toHaveAttribute('aria-colindex', '5')
  await expect(searchAnnouncer).toHaveText('1 of 8 matches')
  expect(await page.evaluate(() => { window.__variaSearchObserver.disconnect(); return window.__variaSearchSaid })).toEqual(['1 of 8 matches'])
  // The Enter that commits an IME composition neither steps nor searches (#348).
  await searchBox.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })))
  await page.keyboard.press('Enter')
  await expect(searchCount).toHaveText('2 of 8')
  await expect(currentMatch).toHaveText('complete 11')
  await expect(marked(gridPart.searchMatch)).not.toHaveCount(0)
  await page.keyboard.press('Shift+Enter')
  await expect(searchCount).toHaveText('1 of 8')
  // Steps from the box leave the grid's active cell where it was (the cell pressed before Ctrl+F), and the focus in the box.
  expect(await active()).toMatchObject({ row: 0, column: 0 })
  await expect(searchBox).toBeFocused()
  // F3 from the grid, on the active match (in view in this short pane, where the first rows may not be), makes the next
  // match the active cell too, so it is announced and Ctrl+C copies it (#347).
  await currentMatch.click()
  await page.keyboard.press('F3')
  await expect(searchCount).toHaveText('2 of 8')
  await expect(currentMatch).toHaveText('complete 11')
  await expect.poll(async () => (await active()).text).toBe('complete 11')
  await expect(grid()).toBeFocused()
  await page.keyboard.press('Shift+F3')
  await expect(searchCount).toHaveText('1 of 8')
  await expect.poll(async () => (await active()).text).toBe('complete 10')
  await page.keyboard.press('F3')
  await expect.poll(async () => (await active()).text).toBe('complete 11')
  // Sorted descending, the matches follow the text order ("complete 19" first); the active one keeps its place.
  // A search again keeps the active match's place without scrolling; a step there and back shows it.
  const stepThereAndBack = async () => {
    await searchBox.press('Enter')
    await expect(searchCount).toHaveText('3 of 8')
    await searchBox.press('Shift+Enter')
    await expect(searchCount).toHaveText('2 of 8')
  }
  await searchSort('Sort Descending')
  await expect(header('clipped')).toHaveAttribute('aria-sort', 'descending')
  await expect(searchCount).toHaveText('2 of 8')
  await stepThereAndBack()
  await expect(currentMatch).toHaveText('complete 18')
  await searchSort('Clear Sort')
  await expect(header('clipped')).not.toHaveAttribute('aria-sort', /./)
  await expect(searchCount).toHaveText('2 of 8')
  await stepThereAndBack()
  await expect(currentMatch).toHaveText('complete 11')
  // Columns: id, unicode, clipped and failed hold an "i"; the others fade.
  await searchMode('Columns').click()
  await expect(searchMode('Columns')).toHaveAttribute('aria-pressed', 'true')
  const columnBox = resultsToolbar(page).getByRole('textbox', { name: 'Search column names', exact: true })
  await columnBox.fill('I')
  await expect(searchCount).toHaveText('4 of 7 columns')
  expect(await clear()).toBe(true)
  await expect(marked(gridPart.searchColumn)).toHaveCount(4)
  await expect(marked(gridPart.searchDimmedHeader)).toHaveCount(3)
  await expect(marked(gridPart.searchMatch)).toHaveCount(0)
  await columnBox.press('Escape')
  await expect(columnBox).toHaveValue('')
  await expect(searchCount).toHaveText('')
  await expect(marked(gridPart.searchColumn)).toHaveCount(0)
  await expect(marked(gridPart.searchDimmedHeader)).toHaveCount(0)
  await searchMode('Data').click()
  expect(await clear()).toBe(true)
  // A run from the editor keeps the focus there, though the box took it for Ctrl+F before and is shown again.
  await run('-- varia-fake: sets=N1*20,N1*20,N1*20')
  await expect(cell(0, 1)).toBeVisible()
  await expect(textbox()).toBeFocused()
  // Several grids: Shift+Enter from the first match wraps to the last, in the last grid, which the stack scrolls into
  // view with the match in it, though the grid was built already below the fold.
  await searchBox.click()
  await page.keyboard.type('COMPLETE 1')
  await expect(searchCount).toHaveText('1 of 24')
  await page.keyboard.press('Shift+Enter')
  await expect(searchCount).toHaveText('24 of 24')
  const lastMatch = grid('Result 3').locator(gridPart.searchCurrent).filter({ visible: true })
  await expect(lastMatch).toHaveText('complete 19')
  await expect(lastMatch).toBeInViewport({ ratio: 1 })
  await searchBox.press('Escape')
  await expect(searchBox).toHaveValue('')
  await expect(searchBox).toBeFocused()
  // Escape in the empty box goes back to the grid that last had the focus (#347).
  await searchBox.press('Escape')
  await expect(page.locator('[data-result-grid]:focus')).toHaveCount(1)
  await resize(...fullSize)
  await enlargeOutput(page)
  console.log('Results checks: Ctrl+F searches every grid in the backend, Enter, Shift+Enter and F3 step through the marked matches (F3 in a grid moving its active cell, an IME Enter doing nothing), the live region says only settled counts, a sort searches again in its order, Columns matches column names, and Escape clears it, then returns to the grid.')

  // 14f. Compare with Previous Result: the second result against the first, aligned by ItemId in the backend, adds their
  // unified diff as a third result: a changed row as its old row (−) then its new one (+) with the changed price marked, a
  // name changed only in case underlined (equal by the collation), a removed and an added row, a row of context between.
  await run('SELECT * FROM Items -- DIFF_FIXTURE')
  await expect(cell(3, 0, grid('Result 2'))).toHaveText('5')
  await cell(0, 0, grid('Result 2')).click({ button: 'right' })
  await outputMenu.getByRole('menuitem', { name: 'Compare with Previous Result', exact: true }).click()
  const diff = grid('Result 3')
  await expect(cell(5, 3, diff)).toHaveText('5')
  for (const name of ['Change', 'R1', 'R2', 'ItemId', 'Name', 'Price']) await expect(diff.getByRole('columnheader', { name: new RegExp(`^${name}`) })).toHaveCount(1)
  const diffRows = () => Promise.all([0, 1, 2, 3, 4, 5].map(row => Promise.all([0, 1, 2, 3, 4, 5].map(column => cell(row, column, diff).textContent()))))
  expect(await diffRows()).toEqual([
    ['\u2212', '1', 'NULL', '1', 'apple', '1.50'],
    ['+', 'NULL', '1', '1', 'apple', '1.75'],
    [' ', '2', '2', '2', 'PEAR', '2.00'],
    ['\u2212', '3', 'NULL', '3', 'plum', '3.00'],
    [' ', '4', '3', '4', 'fig', '4.00'],
    ['+', 'NULL', '4', '5', 'kiwi', '5.00']
  ])
  await expect(diff.locator(gridPart.removedRow)).toHaveCount(2)
  await expect(diff.locator(gridPart.addedRow)).toHaveCount(2)
  await expect(diff.locator(gridPart.changedCell)).toHaveCount(2)
  await expect(cell(0, 5, diff).and(diff.locator(gridPart.changedCell))).toHaveCount(1)
  await expect(cell(1, 5, diff).and(diff.locator(gridPart.changedCell))).toHaveCount(1)
  await expect(cell(2, 4, diff).and(diff.locator(gridPart.softCell))).toHaveCount(1)
  await expect(strip('Result 3')).toContainText('Result 1 \u2192 Result 2, rows matched by ItemId: 1 changed row, 1 added row, 1 removed row, 2 unchanged.')
  await expect(page.getByText('Differences: Result 1 \u2192 Result 2', { exact: true })).toBeVisible()
  // The active cell names a changed value and its row's kind for screen readers.
  await cell(1, 5, diff).click()
  await expect(cell(1, 5, diff)).toHaveAttribute('aria-label', '1.75, changed, added row')
  // Where the features meet: a highlighted removed row shows its highlight over the diff's tone, and a search match on a
  // changed value shows the match's tint over the changed one.
  const background = locator => locator.evaluate(element => getComputedStyle(element).backgroundColor)
  const removedTone = await background(diff.locator(gridPart.removedRow).first())
  await cell(3, 1, diff).click({ button: 'right' })
  await outputMenu.getByRole('menuitem', { name: 'Highlight', exact: true }).click()
  await page.getByRole('menu', { name: 'Highlight', exact: true }).getByRole('menuitem', { name: 'Blue', exact: true }).click()
  const highlightedRemoved = diff.locator(gridPart.highlightedRow).and(diff.locator(gridPart.removedRow))
  await expect(highlightedRemoved).toHaveCount(1)
  await expect.poll(() => background(highlightedRemoved)).not.toBe(removedTone)
  // The changed value's own tint, measured now that the selection moved off it.
  const changedTint = await background(cell(1, 5, diff))
  await searchBox.click()
  await page.keyboard.type('1.75')
  const changedMatch = cell(1, 5, diff).and(diff.locator(gridPart.searchMatch))
  await expect(changedMatch).toHaveCount(1)
  await expect.poll(() => background(changedMatch)).not.toBe(changedTint)
  await searchBox.press('Escape')
  await cell(3, 1, diff).click({ button: 'right' })
  await outputMenu.getByRole('menuitem', { name: 'Highlight', exact: true }).click()
  await page.getByRole('menu', { name: 'Highlight', exact: true }).getByRole('menuitem', { name: 'Clear All Highlights', exact: true }).click()
  await expect(diff.locator(gridPart.highlightedRow)).toHaveCount(0)
  console.log('Results checks: Compare with Previous Result adds a unified diff of the two results, aligned by their key, with changed, soft, added and removed rows marked; highlights and search matches show over its tones.')

  // 15. Panes and tabs: F6 goes to the results and back; Ctrl+R hides and shows them keeping scroll, selection and a
  // resized column; a tab switch restores all three.
  await run('-- varia-fake: sets=W1*2000')
  await expect(cell(0, 1)).toHaveText(w1(0)[1])
  // F6 into a fresh grid lands on its first cell, the current cell: screen readers hear it, Ctrl+C copies it, and the
  // grid's focus ring shows above its sticky headers.
  await textbox().focus()
  await page.keyboard.press('F6')
  await expect(grid()).toBeFocused()
  await expect.poll(async () => { const state = await active(); return [state.resolved, state.row, state.column, state.selected] }).toEqual([true, 0, 0, 'true'])
  await setClipboard('')
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(w1(0)[0])
  await expect.poll(focusRingPixels).toBeGreaterThan(100)
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => { const state = await active(); return [state.row, state.column] }).toEqual([1, 0])
  let idBox
  await expect.poll(async () => { const now = JSON.stringify(await header('id').boundingBox()), same = now === idBox; idBox = now; return same }, { intervals: [100] }).toBe(true)
  idBox = JSON.parse(idBox)
  await page.mouse.move(idBox.x + idBox.width - 1, idBox.y + idBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(idBox.x + idBox.width + 39, idBox.y + idBox.height / 2, { steps: 4 })
  await page.mouse.up()
  const resized = idBox.width + 40
  await expect.poll(() => widthOf(header('id'))).toBeCloseTo(resized, 0)
  await cell(0, 0).click()
  for (let press = 0; press < 3; press++) await page.keyboard.press('PageDown')
  const scrollTop = () => scroller().evaluate(element => element.scrollTop)
  const kept = await settled(), keptTop = await scrollTop()
  expect(kept.row).toBeGreaterThan(0)
  expect(keptTop).toBeGreaterThan(0)
  await textbox().focus()
  await page.keyboard.press('F6')
  await expect(grid()).toBeFocused()
  await page.keyboard.press('F6')
  await expect(textbox()).toBeFocused()
  // Ctrl+R closes every output panel and brings each back where it was, Results showing.
  await page.keyboard.press('Control+R')
  for (const id of outputPaneIds) await expect(paneTab(page, id)).toHaveCount(0)
  await expect(outputPane(page)).toBeHidden()
  await page.keyboard.press('Control+R')
  for (const id of outputPaneIds) await expect(paneTab(page, id)).toHaveCount(1)
  await expect(outputPanel(page, 'results')).toBeVisible()
  await expect(page.locator('.dv-groupview').filter({ has: paneTab(page, 'results') }).locator('[data-pane-tab]')).toHaveCount(3)
  await expect.poll(scrollTop).toBe(keptTop)
  expect(await active()).toMatchObject({ row: kept.row, column: kept.column, selected: 'true' })
  expect(await widthOf(header('id'))).toBeCloseTo(resized, 0)
  // Both presses within one frame: the grid stays mounted but is moved, which drops its scroller's offsets without a
  // resize or a scroll event. Its rows stayed drawn below the view, or it took the reset for a scroll to the top.
  await textbox().focus()
  // Tagged to show the grid was moved, not remounted (a remount restores its offsets anyway and would not test this).
  await scroller().evaluate(element => { element.dataset.moved = 'kept' })
  // Ctrl+R reads which panes show, which the dock publishes in a microtask: one runs between the presses, as between
  // two real key events, and no frame can.
  expect(await page.evaluate(async () => {
    const press = () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', ctrlKey: true, bubbles: true, cancelable: true }))
    press()
    const closed = document.querySelector('[data-pane-tab="results"]') === null
    await Promise.resolve()
    press()
    return closed
  })).toBe(true)
  await expect(outputPane(page)).toBeVisible()
  await expect(scroller()).toHaveAttribute('data-moved', 'kept')
  await expect.poll(scrollTop).toBe(keptTop)
  await expect.poll(async () => { const [first, last] = await visibleRows(); return first <= kept.row + 1 && last >= kept.row + 1 }).toBe(true)
  expect(await active()).toMatchObject({ row: kept.row, column: kept.column, selected: 'true' })
  expect(await widthOf(header('id'))).toBeCloseTo(resized, 0)
  // The pane's live region reads out only what happens while a tab is shown: switching tabs repeats no sentence.
  const liveRegion = outputAnnouncer(page)
  await page.keyboard.press('Control+N')
  await expect(queryTabs()).toHaveCount(2)
  await expect(liveRegion).toHaveText('')
  await queryTabs().first().click()
  await expect(liveRegion).toHaveText('')
  await expect.poll(scrollTop).toBe(keptTop)
  expect(await active()).toMatchObject({ row: kept.row, column: kept.column, selected: 'true' })
  await expect.poll(() => widthOf(header('id'))).toBeCloseTo(resized, 0)
  // A press after that move and before the frame that writes the offsets back: it lands on the row drawn there before the
  // move, rather than taking the dropped offsets for a scroll to the top and selecting a row near it.
  await textbox().focus()
  // The tab switch above built the grid afresh, so this tag marks the scroller to find once the pane shows again.
  await scroller().evaluate(element => { element.dataset.moved = 'early' })
  // The dock lays the shown pane out on an animation frame, which a hidden window (the smoke tests') under xvfb can hold
  // back for a second or more (a Linux CI run measured the scroll bar below the window and clicked nothing). The frames are
  // held back here as there, so these steps wait for that layout wherever they run.
  await page.evaluate(() => {
    const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame, held = new Map()
    // Ids of their own, so a frame asked for before this can still be cancelled.
    let next = 1e9
    window.requestAnimationFrame = callback => {
      const id = next++
      held.set(id, setTimeout(() => held.set(id, -request(time => { held.delete(id); callback(time) })), 1000))
      return id
    }
    window.cancelAnimationFrame = id => {
      const handle = held.get(id)
      if (handle === undefined) cancel(id)
      else if (handle < 0) cancel(-handle)
      else clearTimeout(handle)
      held.delete(id)
    }
    window.__variaHeldFrames = () => { window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel }
  })
  const early = await page.evaluate(({ parts }) => new Promise(resolve => {
    const press = () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', ctrlKey: true, bubbles: true, cancelable: true }))
    // The pane shows again in a later task; a mutation observer runs right after the move, before the grid's next frame. The
    // press waits for the second Ctrl+R, for the move (a removal of the grid's ancestor) and for the pane to show again (a
    // hidden scroller also reads 0).
    const scroller = document.querySelector(parts.scroller + '[data-moved="early"]')
    let reopened = false, moved = false
    const ready = () => reopened && moved && scroller.isConnected && scroller.clientHeight > 0
    const observer = new MutationObserver(records => {
      moved ||= records.some(record => [...record.removedNodes].some(node => node.contains?.(scroller)))
      if (ready()) pressNow()
    })
    const timer = setTimeout(() => { observer.disconnect(); resolve({ dropped: scroller.scrollTop, inGrid: false, moved: 'never shown again, moved ' + moved }) }, 5000)
    const pressNow = () => { try { pressAt() } catch (error) { resolve({ dropped: scroller.scrollTop, inGrid: false, moved: 'press failed: ' + error.message }) } }
    const pressAt = () => {
      observer.disconnect()
      clearTimeout(timer)
      const root = scroller.closest('[data-result-grid]'), box = scroller.getBoundingClientRect(), headHeight = root.querySelector(parts.head).offsetHeight
      const dropped = scroller.scrollTop
      // The second row of the view, clear of the row numbers. The dock lays the pane out again only after the frame, so the
      // scroller can still sit outside the window here: the press goes to the scroller itself, at a point of its box.
      const x = box.left + Math.min(box.width / 2, 200), y = box.top + headHeight + 30, target = scroller
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 }
      const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true }
      target.dispatchEvent(new PointerEvent('pointerdown', { ...init, ...pointer, buttons: 1 }))
      target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }))
      target.dispatchEvent(new PointerEvent('pointerup', { ...init, ...pointer, buttons: 0 }))
      target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }))
      resolve({ dropped, inGrid: root.contains(target) && headHeight > 0, moved: scroller.dataset.moved })
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    press()
    // Ctrl+R reads which panes show, which the dock publishes in a microtask: one runs between the presses.
    Promise.resolve().then(() => { press(); reopened = true })
  }), { parts: gridPart })
  expect(early).toEqual({ dropped: 0, inGrid: true, moved: 'early' })
  await expect.poll(scrollTop).toBe(keptTop)
  // The grid paints the press on its next frame: until then the kept cell is still the active one, and a row near the top
  // would pass for the pressed one.
  await expect.poll(async () => { const cell = await active(); return cell.row !== kept.row || cell.column !== kept.column }).toBe(true)
  const [earlyFirst, earlyLast] = await visibleRows()
  const earlyRow = (await active()).row
  expect(earlyRow >= earlyFirst - 1 && earlyRow <= earlyLast && earlyFirst > 1, `pressed row ${earlyRow}, rows ${earlyFirst} to ${earlyLast} shown`).toBe(true)
  // A press on the grid's scroll bar leaves the focus on the grid, so the arrow keys move a cell screen readers hear. The
  // bar is pressed where it shows once the dock has laid the pane out (a classic bar; an overlay one takes no width).
  const scrollBar = () => scroller().evaluate(element => {
    const box = element.getBoundingClientRect(), width = element.offsetWidth - element.clientWidth
    const x = box.left + element.clientWidth + width / 2, y = box.top + element.clientHeight * 0.75
    return { x, y, width, shown: width === 0 || document.elementFromPoint(x, y) === element }
  })
  await expect.poll(async () => (await scrollBar()).shown).toBe(true)
  const bar = await scrollBar()
  if (bar.width > 0) {
    await textbox().focus()
    await page.mouse.click(bar.x, bar.y)
    await expect(grid()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await active()).resolved).toBe(true)
    await expect(grid()).toBeFocused()
  }
  await page.evaluate(() => window.__variaHeldFrames())
  console.log('Results checks: F6 goes to the results and back; Ctrl+R and tab switches keep scroll, selection and column widths.')

  // 11 (continued). A backend crash makes the shown results unavailable, without a page error.
  await writeFile(join(control, 'crash-next'), '')
  await queryTabs().nth(1).click()
  if (!(await server().inputValue())) await server().selectOption({ index: 1 })
  await typeSql('SELECT 1;')
  await page.keyboard.press('F5')
  await expect(errorMessages(page)).toContainText('The SQL backend stopped', { timeout: 30000 })
  await queryTabs().first().click()
  await expect(page.locator(gridPart.overlay)).toHaveText('These results are no longer available because the SQL backend restarted.', { timeout: 30000 })
  // Nothing is left to save.
  await textbox().focus()
  await page.keyboard.press('F1')
  await page.keyboard.type('save results as')
  await expect(quickInputActive(page)).toContainText('Save Results As')
  await expect(quickInputActive(page)).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(quickInput(page)).toHaveCount(0)
  console.log('Results checks: a backend crash marks the shown results unavailable, and Save Results As is disabled.')

  // 17. At a small window the output toolbar, the grid's strip and the status bar stay inside it.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 700))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024)
  await queryTabs().nth(1).click()
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  await lostServerRows(page).getByRole('button', { name: /^Reconnect/ }).click()
  const connect = page.getByRole('dialog', { name: 'Connect', exact: true })
  await connect.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(connect).toHaveCount(0)
  await expect(queryStatus(page)).not.toContainText('connection lost')
  // A cancelled run keeps the rows it read, marked incomplete in the grid's strip.
  await run('-- varia-fake: sets=W1*200000@20000', { running: true })
  await expect(cell(0, 0)).toHaveText('0')
  await queryBarButton(page, 'Cancel').click()
  await expect(status()).toContainText(/^Cancelled · /)
  await outputTab(/^Results/).click()
  await expect(strip()).toContainText('This result is incomplete')
  // A grid holds only its rows: the strip (a status, here with no Retry) is outside the table structure.
  await expect(grid().locator('[role="status"], button')).toHaveCount(0)
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  for (const locator of [outputToolbar(page), strip(), statusBar(page)]) {
    const box = await locator.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
  }
  await page.screenshot({ path: resolve('artifacts', 'results-small.png') })
  // A save of a long-named file and a copy, both held, share the toolbar: the name is cut short, while both Cancel
  // buttons and the status line stay in the window.
  await run('-- varia-fake: sets=W1*5000')
  await writeFile(join(control, 'hold', 'results.export'), '')
  await writeFile(join(control, 'hold', 'results.copy'), '')
  await choose(join(saveDir, 'Quarterly revenue by region and product category for the board 2026-10-10.csv'))
  await cell(0, 0).click()
  await page.keyboard.press('Control+S')
  const strips = jobProgress(page)
  await expect(strips).toHaveCount(1)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+C')
  await expect(strips).toHaveCount(2)
  for (const locator of [...await outputToolbar(page).locator(':scope > *').all(), ...await strips.getByRole('button', { name: 'Cancel', exact: true }).all()]) {
    const box = await locator.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  }
  expect((await status().boundingBox()).width).toBeGreaterThan(40)
  await page.screenshot({ path: resolve('artifacts', 'results-small-jobs.png') })
  await rm(join(control, 'hold', 'results.copy'))
  await rm(join(control, 'hold', 'results.export'))
  await expect(strips).toHaveCount(0, { timeout: 30000 })
  // A long server name is cut short in the query status bar, whole in its tooltip; its other segments keep their size
  // inside the bar, as the backend status, the editor's segments and the memory indicator do in the IDE status bar, and
  // the page never scrolls.
  const longServer = 'sqlprod-analytics-warehouse-cluster-01.' + 'reporting-'.repeat(10) + 'corp.contoso.com\\INSTANCE01,1433'
  await toolbarButton(page, 'Connect').click()
  await page.getByLabel('Server Name', { exact: true }).fill(longServer)
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await server().selectOption({ label: longServer })
  await run('-- varia-fake: sets=W1*10 memory=0.5')
  await expect(memoryUsage(page, 'results')).toHaveText('128 MB / 256 MB')
  await expect(queryStatus(page)).toHaveAttribute('title', new RegExp(`^${longServer.replace(/[\\.]/g, '\\$&')}( \\(\\d+\\.\\d+\\))? \\| \\S`))
  expect(await page.evaluate(([part, facts]) => {
    const fits = bar => { const box = bar.getBoundingClientRect(); return [...bar.querySelectorAll(':scope > *, ' + part.querySegment)].every(child => { const rect = child.getBoundingClientRect(); return rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5 }) }
    const server = document.querySelector(facts.server), database = document.querySelector(facts.database)
    return {
      fits: fits(document.querySelector(part.statusBar)) && fits(document.querySelector(part.queryStatus)), rows: !!document.querySelector(facts.rows),
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, cut: server.scrollWidth > server.clientWidth,
      // The server gives way before the database, which stays whole while the server can shrink.
      database: database.scrollWidth <= database.clientWidth
    }
  }, [part, queryFacts])).toEqual({ fits: true, rows: false, overflow: false, cut: true, database: true })
  await page.screenshot({ path: resolve('artifacts', 'results-small-status.png') })
  // Script As requests held in the backend keep Cancel and the start of their text: the editor's segments give way,
  // no segment covers another, and the text keeps a gap from the backend status even when it fills its segment (two
  // requests), so the two do not read as one phrase.
  await writeFile(join(control, 'hold', 'scripting.script'), '')
  const ordersPath = [longServer, 'Databases', 'AppData', 'Tables', 'dbo.Orders']
  await expandExplorerPath(page, ...ordersPath.slice(0, -1))
  const contextMenu = name => page.getByRole('menu', { name, exact: true })
  const scriptOrders = async (verb, destination) => {
    await (await explorerRow(page, ...ordersPath)).click({ button: 'right', force: true })
    await contextMenu('Object Explorer').getByRole('menuitem', { name: 'Script Table as', exact: true }).click({ force: true })
    await contextMenu('Script Table as').getByRole('menuitem', { name: verb, exact: true }).click({ force: true })
    await contextMenu(verb).getByRole('menuitem', { name: destination, exact: true }).click({ force: true })
  }
  const statusLayout = () => page.evaluate(part => {
    const bar = document.querySelector(part.statusBar), box = bar.getBoundingClientRect()
    const parts = { backend: bar.firstElementChild, cancel: bar.querySelector('button[aria-label="Cancel scripting"]'), place: bar.querySelector(part.editorStatus), memory: bar.querySelector(part.memory) }
    const boxes = Object.entries(parts).map(([name, element]) => [name, element.getBoundingClientRect()])
    const overlaps = boxes.flatMap(([name, a], i) => boxes.slice(i + 1).filter(([, b]) => a.left < b.right - 0.5 && b.left < a.right - 0.5).map(([other]) => name + '/' + other))
    const text = bar.querySelector(part.statusSegmentText).getBoundingClientRect(), gap = text.left - parts.backend.getBoundingClientRect().right
    return {
      overlaps, inside: boxes.every(([, rect]) => rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5),
      text: text.width >= 40, gap: gap >= 8 || gap, placeShown: parts.place.getBoundingClientRect().width >= 40
    }
  }, part)
  await scriptOrders('CREATE To', 'Clipboard')
  const cancelScripting = page.getByRole('button', { name: 'Cancel scripting', exact: true })
  await expect(cancelScripting).toBeVisible()
  expect(await statusLayout()).toEqual({ overlaps: [], inside: true, text: true, gap: true, placeShown: true })
  await statusBar(page).screenshot({ path: resolve('artifacts', 'results-small-scripting.png') })
  await scriptOrders('DROP To', 'New Query Editor Window')
  await expect(statusSegment(page).locator(part.statusSegmentMore)).toHaveText('(+1 more)')
  expect(await statusLayout()).toEqual({ overlaps: [], inside: true, text: true, gap: true, placeShown: true })
  await statusBar(page).screenshot({ path: resolve('artifacts', 'results-small-scripting-2.png') })
  await rm(join(control, 'hold', 'scripting.script'))
  await expect(cancelScripting).toHaveCount(0)
  expect(failures).toEqual([])
  console.log('Results checks passed: streaming, a million rows past the scroll cap, wide results, stacked sets, ARIA, selection and copy, resizing, Save Results As, values in their own tabs, Messages, lifecycle, memory, the menu, styling, F6, Ctrl+R, tabs and a small window.')

  // Part B: a real SQL Server through the Release backend. The first rows of a million show within a second while the
  // script still runs; Cancel keeps them and Ctrl+End reaches the last; Save Results As writes every one as CSV; a copy
  // of 100,000 rows matches the server's rows; a FOR XML PATH value opens in its own tab; and a SQL error sits between
  // the messages printed around it.
  if (process.env.VARIA_TEST_SQL_SERVER) {
    await application.close().catch(() => {})
    const liveProfile = await mkdtemp(resolve('artifacts', 'results-live-profile-')), liveSaves = await mkdtemp(resolve('artifacts', 'results-live-save-'))
    cleanups.push(() => rm(liveProfile, { recursive: true, force: true }), () => rm(liveSaves, { recursive: true, force: true }))
    const liveEnv = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: liveProfile }
    delete liveEnv.ELECTRON_RUN_AS_NODE
    application = await electron.launch({ args: ['.'], env: liveEnv, chromiumSandbox: process.getuid?.() !== 0 })
    child = application.process()
    child.stderr?.on('data', chunk => { for (const line of chunk.toString().split(/\r?\n/)) if (line.startsWith('Results close prompt: ')) console.error(line) })
    page = await application.firstWindow()
    page.setDefaultTimeout(30000)
    page.on('pageerror', error => failures.push(error.message))
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...args) => {
        const { title, buttons } = args.at(-1)
        if (title !== 'Unsaved query') process.stderr.write('Results close prompt: ' + JSON.stringify({ title, buttons }) + '\n')
        return { response: 1, checkboxChecked: false }
      }
    })
    await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
    await connectLive(page, expect)
    await enlargeOutput(page)
    // The session opens with the first run, so the timed one below measures rows, not the login.
    await run('SELECT 1 AS warm;')
    await checkClientStatistics(page, expect, run, true)
    const liveText = n => liveRow(n).map(value => value ?? 'NULL')
    // Row 1 painted, timed in the page from just before F5 (a poll from here would add its own interval). The server holds
    // a part-filled packet until the batch ends, so RAISERROR WITH NOWAIT sends the last rows before the wait.
    await typeSql(`${liveRowsSql(1_000_000)}\nRAISERROR(N'All rows sent.', 0, 1) WITH NOWAIT;\nWAITFOR DELAY '00:05:00';`)
    await page.evaluate(({ first, cell }) => {
      window.__variaLiveFirst = new Promise(done => {
        const started = performance.now()
        const check = () => {
          const element = document.querySelector('[data-result-grid] ' + cell)
          if (element?.textContent === first) done(performance.now() - started)
          else if (performance.now() - started < 30000) requestAnimationFrame(check)
          else done(Infinity)
        }
        requestAnimationFrame(check)
      })
    }, { first: liveText(1)[1], cell: gridCellSelector(0, 1) })
    await page.keyboard.press('F5')
    const firstRows = await page.evaluate(() => window.__variaLiveFirst)
    console.log(`Results live: the first rows of a million painted ${Math.round(firstRows)} ms after F5.`)
    expect(firstRows).toBeLessThan(1000)
    await expect(status()).toContainText(/^Executing · /)
    const rowsRead = async () => Number((await status().textContent()).match(/· ([\d,]+) rows?/)?.[1].replaceAll(',', '') ?? 0)
    await expect.poll(rowsRead, { timeout: 120000 }).toBe(1_000_000)
    await expect(status()).toContainText(/^Executing · /)
    await page.screenshot({ path: resolve('artifacts', 'results-live.png') })
    await queryBarButton(page, 'Cancel').click()
    await expect(status()).toContainText(/^Cancelled · /, { timeout: 30000 })
    await outputTab(/^Results/).click()
    await expect(grid()).toHaveAttribute('aria-label', 'Result 1 of 1, 1,000,000 rows, 8 columns')
    await cell(0, 0).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Home')
    await expect.poll(async () => (await active()).text, { timeout: 30000 }).toBe(liveText(1_000_000)[0])
    expect(await active()).toMatchObject({ row: 999_999, column: 0, selected: 'true' })
    // The set ended before the cancel, so it saves whole: a header row (the Results to Grid option, on for this save) and
    // a million rows, as the server sent them.
    expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.includeColumnHeaders': true }))).ok).toBe(true)
    const csvPath = join(liveSaves, 'million.csv')
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, csvPath)
    await page.keyboard.press('Control+S')
    await expect(jobNotice(page)).toHaveText('Saved 1,000,000 rows to million.csv.', { timeout: 120000 })
    const saved = await readFile(csvPath)
    let lines = 0
    for (let index = saved.indexOf(10); index !== -1; index = saved.indexOf(10, index + 1)) lines++
    expect(lines).toBe(1_000_001)
    const csvLine = values => values.map(csvField).join(',') + '\r\n'
    expect(saved.subarray(0, 4096).toString('utf8').startsWith('\uFEFF' + csvLine(liveColumns) + csvLine(liveRow(1)))).toBe(true)
    expect(saved.subarray(saved.lastIndexOf(10, saved.length - 2) + 1).toString('utf8')).toBe(csvLine(liveRow(1_000_000)))
    expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.includeColumnHeaders': null }))).ok).toBe(true)
    // Copy: every row, in order, as the server sent them.
    await run(liveRowsSql(100_000))
    await expect(grid()).toHaveAttribute('aria-label', 'Result 1 of 1, 100,000 rows, 8 columns')
    await cell(0, 0).click()
    await page.keyboard.press('Control+A')
    await setClipboard('')
    await page.keyboard.press('Control+C')
    const copied = () => application.evaluate(async ({ clipboard }, separator) => {
      const lines = (await clipboard.readText()).split(separator)
      return { count: lines.length, first: lines[0], last: lines.at(-1) }
    }, eol)
    await expect.poll(async () => (await copied()).count, { timeout: 60000 }).toBe(100_000)
    expect(await copied()).toEqual({ count: 100_000, first: tsv([liveText(1)]), last: tsv([liveText(100_000)]) })
    // FOR XML PATH arrives as rows of about 2,000 characters; the grid shows one link, which opens the whole value.
    await run(`SELECT TOP (200) name, object_id FROM sys.all_objects ORDER BY object_id FOR XML PATH('o'), ROOT('objects');`)
    await expect(matching(cell(0, 0), gridPart.linkCell)).toHaveCount(1)
    await cell(0, 0).click()
    await expect(queryTabs().filter({ hasText: 'XML_F52E2B61-18A1-11d1-B105-00805F49916B1.xml' })).toHaveAttribute('aria-selected', 'true')
    const xml = await editorText()
    expect(xml.startsWith('<objects>\n  <o>\n    <name>')).toBe(true)
    expect(xml.endsWith('</objects>')).toBe(true)
    expect(xml.split('<o>').length - 1).toBe(200)
    await page.keyboard.press('Control+W')
    await expect(queryTabs()).toHaveCount(1)
    // A statement's error is reported in place, between the messages before and after it; the run keeps its (empty) set
    // on Results, and the Messages strip opens under it.
    await run(`PRINT 'before';\nSELECT 1/0 AS boom;\nPRINT 'after';`)
    await expect(status()).toContainText(/^Completed with errors · /)
    await expect(outputTab(/^Results/)).toHaveAttribute('aria-selected', 'true')
    await expect(messagesStrip(page)).toHaveAttribute('aria-expanded', 'true')
    const messages = await messageLines(page).evaluateAll((items, error) => items.map(item => [item.matches(error) ? 'error' : 'info', item.textContent]), part.errorMessage)
    expect(messages.slice(0, 3)).toEqual([['info', 'before'], ['error', 'Msg 8134, Level 16, State 1, Line 2\nDivide by zero error encountered.'], ['info', 'after']])
    expect(messages.at(-1)[1]).toMatch(/^Completion time: \d{4}-\d\d-\d\dT/)
    // Memory: Close Results in one tab races the summary of a 1,000-set run in another. The summary takes its figure
    // before it is serialized, so the close's fall can arrive first; the indicator must still end on what the backend
    // holds, which the next summary (SELECT 1) reports.
    const memory = memoryIndicator(page)
    const shown = () => memoryUsage(page, 'results').textContent()
    const wideColumns = Array.from({ length: 30 }, (_, c) => `${c + 1} AS [c${String(c + 1).padStart(3, '0')}_${'x'.repeat(110)}]`).join(', ')
    const thousandSets = `SET NOCOUNT ON; DECLARE @i int = 0; WHILE @i < 1000 BEGIN SELECT ${wideColumns}; WAITFOR DELAY '00:00:00.002'; SET @i += 1; END`
    await page.evaluate(() => {
      const client = window.__variaResults, race = window.__variaRace = { log: [], fired: false, trigger: undefined }
      client.onMemory(report => race.log.push(['event', report.seq, report.usedBytes]))
      const applySummary = client.applySummary.bind(client)
      client.applySummary = summary => { race.log.push(['summary', summary.budget.seq, summary.budget.usedBytes, summary.resultSets.length]); return applySummary(summary) }
    })
    let raced = 0
    for (let attempt = 1; attempt <= 3 && raced === 0; attempt++) {
      await queryTabs().first().click()
      await run('SELECT TOP (200000) a.name AS n1, b.name AS n2 FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;')
      await expect(memory).toBeVisible()
      if (await queryTabs().count() < 2) {
        await page.keyboard.press('Control+N')
        await expect(queryTabs()).toHaveCount(2)
        if (!(await server().inputValue())) await server().selectOption({ index: 1 })
      } else await queryTabs().nth(1).click()
      await typeSql(thousandSets)
      // The trigger listens to the run's own events, ahead of the results view.
      await page.evaluate(() => {
        const client = window.__variaResults, race = window.__variaRace
        Object.assign(race, { log: [], fired: false, trigger: undefined })
        client.onQueryEvent = (queryId, listener) => {
          delete client.onQueryEvent
          client.onQueryEvent(queryId, event => {
            if (event.type !== 'resultSet.closed' || event.descriptor.index !== 999 || race.fired || !race.trigger) return
            race.fired = true
            race.log.push(['close'])
            race.trigger()
          })
          return client.onQueryEvent(queryId, listener)
        }
      })
      await page.keyboard.press('F5')
      await expect(status()).toContainText(/^Executing · /)
      // Close Results for tab 1 from the palette; Enter goes the moment tab 2's last set closes.
      await queryTabs().first().click()
      await page.keyboard.press('F1')
      await page.keyboard.type('close results')
      await expect(quickInputActive(page)).toContainText('Query: Close Results')
      await page.evaluate(() => {
        const input = document.activeElement
        window.__variaRace.trigger = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      })
      await page.waitForFunction(() => window.__variaRace.log.some(entry => entry[0] === 'summary' && entry[3] === 1000), null, { timeout: 120000 })
      if (!(await page.evaluate(() => window.__variaRace.fired))) await page.keyboard.press('Enter')
      await expect(quickInput(page)).toHaveCount(0)
      await page.waitForTimeout(1500)
      const log = await page.evaluate(() => window.__variaRace.log)
      const summaryAt = log.findIndex(entry => entry[0] === 'summary' && entry[3] === 1000), summarySeq = log[summaryAt][1]
      // The race happened when the close's report, newer than the summary, arrived before it.
      if (log.slice(0, summaryAt).some(entry => entry[0] === 'event' && entry[1] > summarySeq)) raced++
      const afterRace = await shown()
      await run('SELECT 1 AS truth;')
      const truth = await shown()
      console.log(`Results live: attempt ${attempt}, ${raced ? 'the close overtook the summary' : 'no overtaking'}; shown ${afterRace}, held ${truth} (${log.map(entry => entry.join(' ')).join(', ')}).`)
      expect(afterRace).toBe(truth)
    }
    if (!raced) console.log('Results live: Close Results never overtook the 1,000-set summary in 3 attempts; the ordering was not exercised on this machine.')
    await queryTabs().nth(1).click()
    await page.keyboard.press('Control+W')
    await expect(queryTabs()).toHaveCount(1)
    // Results can publish completion before the query service releases its execution reservation.
    await expect(queryBarButton(page, 'Cancel')).toBeDisabled()
    expect(failures).toEqual([])
    console.log('Results live checks passed: rows show while a million stream, Cancel keeps them, Save Results As and Copy match the server, FOR XML opens in a tab, errors keep their order, and the memory indicator survives a close racing a summary.')
  }
} catch (error) {
  await page.screenshot({ path: resolve('artifacts', 'results-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await application.close().catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
  for (const cleanup of cleanups) await cleanup().catch(() => {})
}
