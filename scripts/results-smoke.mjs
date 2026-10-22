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
import { enlargeOutput } from './fixtures/results-pane.mjs'
import { expandExplorerPath, explorerRow } from './fixtures/explorer-tree.mjs'

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
const status = () => page.locator('.output-status')
const queryTabs = () => page.locator('.query-tabs').getByRole('tab')
const server = () => page.getByLabel('Query server', { exact: true })
const grid = (index = 0) => page.locator(`[data-result-grid][data-result-index="${index}"]`)
const scroller = (index = 0) => grid(index).locator('.rg-scroll')
const cell = (row, column, of = grid()) => of.locator(`.rg-row[aria-rowindex="${row + 2}"] .rg-c[aria-colindex="${column + 2}"]`)
const header = (name, of = grid()) => of.getByRole('columnheader', { name, exact: true })
/** A grid's strip, beside the grid rather than inside its table structure. */
const strip = (index = 0) => page.locator('.rg-frame').filter({ has: grid(index) }).locator('.rg-strip')
/** A row's number as drawn in the sticky row-number column (screen readers read the row's own header instead). */
const rowNumber = (row, of = grid()) => of.locator('.rg-rn:visible').filter({ hasText: new RegExp(`^${row + 1}$`) })
const outputTab = name => page.locator('.output-toolbar').getByRole('tab', { name })
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
  if (running) await expect(status()).toContainText('Executing query…')
  else await expect(status()).toContainText(/^Query (executed successfully|completed with errors)\./)
}
/** The active cell as screen readers find it: the element `aria-activedescendant` names, with its row and column. */
const active = (index = 0) => grid(index).evaluate(root => {
  const id = root.getAttribute('aria-activedescendant'), element = id ? document.getElementById(id) : null
  if (!element || !root.contains(element)) return { id, resolved: false }
  return {
    id, resolved: true, role: element.getAttribute('role'), row: Number(element.parentElement.getAttribute('aria-rowindex')) - 2, column: Number(element.getAttribute('aria-colindex')) - 2,
    selected: element.getAttribute('aria-selected'), label: element.getAttribute('aria-label'), text: element.textContent
  }
})
/** Records the active cell's name each time aria-activedescendant moves, as a screen reader reads it then. */
const watchActiveNames = (index = 0) => grid(index).evaluate(root => {
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
async function settled(index = 0) {
  const position = async () => JSON.stringify([(await active(index)).row, await scroller(index).evaluate(element => element.scrollTop)])
  let previous
  await expect.poll(async () => { const now = await position(), same = now === previous; previous = now; return same }, { intervals: [100] }).toBe(true)
  return active(index)
}
/** The first and last row numbers drawn inside the grid's body; NaN, which fails every comparison, before a scroll's rows are drawn
 * (Math.min of none is Infinity, which passed `toBeGreaterThan` polls before any row was there). */
const visibleRows = (index = 0) => grid(index).evaluate(root => {
  const body = root.querySelector('.rg-scroll').getBoundingClientRect(), head = root.querySelector('.rg-head').getBoundingClientRect()
  const numbers = [...root.querySelectorAll('.rg-row')].filter(row => row.style.display !== 'none').filter(row => {
    const box = row.getBoundingClientRect()
    return box.top >= head.bottom - 1 && box.bottom <= body.bottom + 1
  }).map(row => Number(row.querySelector('.rg-rh').textContent))
  return numbers.length === 0 ? [NaN, NaN] : [Math.min(...numbers), Math.max(...numbers)]
})
/** The shown rows' numbers in DOM order, which browse-mode screen readers follow: ascending, whatever was scrolled. */
const rowOrder = (index = 0) => grid(index).evaluate(root => [...root.querySelectorAll('.rg-row')].filter(row => row.style.display !== 'none').map(row => Number(row.getAttribute('aria-rowindex'))))
const ascending = values => values.length > 0 && values.every((value, index) => index === 0 || value > values[index - 1])
/** True when the element is drawn inside the grid's body, not scrolled away. */
const insideGrid = (locator, index = 0) => locator.evaluate((element, gridIndex) => {
  const root = document.querySelector(`[data-result-grid][data-result-index="${gridIndex}"]`), box = element.getBoundingClientRect(), body = root.querySelector('.rg-scroll').getBoundingClientRect()
  return element.style.display !== 'none' && box.left >= body.left - 1 && box.right <= body.right + 1 && box.top >= body.top - 1 && box.bottom <= body.bottom + 1
}, index)
/** How many cells inside the grid's body are still waiting for their rows. */
const loadingInView = (index = 0) => grid(index).evaluate(root => {
  const body = root.querySelector('.rg-scroll').getBoundingClientRect(), head = root.querySelector('.rg-head').getBoundingClientRect()
  return [...root.querySelectorAll('.rg-c.is-load')].filter(cell => {
    const box = cell.getBoundingClientRect()
    return cell.style.display !== 'none' && cell.parentElement.style.display !== 'none' && box.width > 0 && box.right > body.left && box.left < body.right && box.bottom > head.bottom && box.top < body.bottom
  }).length
})
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
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  // A hidden window draws about once a second; the grid's frames and the scroll steps need real ones.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
  // Closing an unsaved query asks first; answer Don't Save.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
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
    await page.keyboard.press('Control+End')
    // The cell's text follows once its rows are read.
    await expect.poll(async () => { const state = await active(); return state.resolved && state.text === w1(state.row)[7] }).toBe(true)
    const end = await active()
    expect(end).toMatchObject({ role: 'gridcell', column: 7, selected: 'true' })
    expect(end.row).toBeGreaterThan(1000)
    await expect(status()).toContainText('Executing query…')
    await rm(join(control, 'hold', 'query.execute'))
    await expect(status()).toContainText('Query executed successfully.', { timeout: 30000 })
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
    await expect(grid().locator('.rg-row[aria-rowindex="1000001"] .rg-rh')).toHaveText('1000000')
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

  // 3. Wide results: End and Ctrl+→ bring the last column into view, the DOM stays small, and the row numbers stay at
  // the grid's left edge however far it scrolls, with native and with virtual scrolling.
  // The numbers are drawn in one sticky column, each level with its row.
  const rowHeaderAtLeft = () => grid().evaluate(root => {
    const rows = [...root.querySelectorAll('.rg-row')].filter(item => item.style.display !== 'none')
    const marks = [...root.querySelectorAll('.rg-rn')].filter(item => item.style.display !== 'none')
    const row = rows.find(item => marks.some(mark => mark.textContent === item.querySelector('.rg-rh').textContent))
    const mark = marks.find(item => item.textContent === row?.querySelector('.rg-rh').textContent)
    return !!mark && Math.abs(mark.getBoundingClientRect().left - root.getBoundingClientRect().left) <= 1 && Math.abs(mark.getBoundingClientRect().top - row.getBoundingClientRect().top) <= 1
  })
  // A sticky element inside a pooled row makes every row slot a composited layer, which made scroll bar jumps long tasks.
  const stickyInRows = () => grid().evaluate(root => [...root.querySelectorAll('.rg-row, .rg-row *')].filter(item => getComputedStyle(item).position === 'sticky').length)
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
  const heights = () => page.locator('.rs-item').evaluateAll(items => items.map(item => item.getBoundingClientRect().height))
  await run('-- varia-fake: sets=N1*50,N1*50,N1*50,N1*50,N1*50')
  await expect(page.locator('.rs-item')).toHaveCount(5)
  await expect(page.locator('[data-result-grid]')).toHaveCount(5)
  const five = await heights()
  expect(Math.max(...five) - Math.min(...five)).toBeLessThanOrEqual(1)
  await run('-- varia-fake: sets=N1*50,N1*50')
  await expect(page.locator('[data-result-grid]')).toHaveCount(2)
  const splitter = page.locator('.rs-splitter').first()
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
  await grid(0).focus()
  await page.keyboard.press('Tab')
  await expect(splitter).toBeFocused()
  // In forced colors (Windows High Contrast) a splitter is drawn, and its focus shows.
  await page.mouse.move(1, 1)
  await page.emulateMedia({ forcedColors: 'active' })
  const splitterStyle = () => splitter.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, outline: style.outlineStyle } })
  // The grid's own background is forced to the system's Canvas.
  const canvas = await grid(0).evaluate(element => getComputedStyle(element).backgroundColor)
  const focusedSplitter = await splitterStyle()
  expect(focusedSplitter.background).not.toBe(canvas)
  expect(focusedSplitter.outline).toBe('solid')
  await grid(0).focus()
  expect(await splitterStyle()).not.toEqual(focusedSplitter)
  expect((await splitterStyle()).background).not.toBe(canvas)
  await page.emulateMedia({ forcedColors: null })
  await page.keyboard.press('Tab')
  await expect(splitter).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(grid(1)).toBeFocused()
  await measured('a thousand stacked sets', async () => {
    await run('-- varia-fake: sets=M1*1000')
    await expect(outputTab(/^Results/)).toContainText('1000')
    await expect(page.locator('[data-result-grid]').first()).toBeVisible()
    const target = page.getByRole('grid', { name: 'Result 1000 of 1000, 1 row, 1 column', exact: true })
    let most = 0
    for (let step = 0; step < 400 && !(await target.count()); step++) {
      await page.locator('.rs-stack').evaluate(stack => { stack.scrollTop += stack.clientHeight * 4 })
      await page.waitForTimeout(25)
      most = Math.max(most, await page.locator('[data-result-grid]').count())
    }
    await expect(target).toBeVisible()
    expect(most).toBeLessThanOrEqual(12)
  })
  console.log('Results checks: stacked grids split the pane equally, resize by mouse and keys, and a thousand sets mount at most 12 grids.')

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
  await expect(cell(1, 3)).toHaveClass(/is-trunc/)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  // A NULL and a value that could not be read look alike; their labels tell them apart.
  await expect.poll(async () => (await active()).label).toBe('NULL, null value')
  await page.keyboard.press('ArrowDown')
  for (let column = 0; column < 3; column++) await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await active()).label).toBe('NULL, could not be read')
  expect(await cell(2, 4).evaluate(element => getComputedStyle(element).fontStyle)).toBe('italic')
  console.log('Results checks: the active descendant follows every grid key with its row, column, selection and label.')

  // 6. Selection and copy: clicks, Shift, a drag that scrolls, Ctrl+click on columns and rows, headers and the corner;
  // the exact text by keys, with headers, and through Edit › Copy; a long copy's strip; a copy over the limit.
  await run('-- varia-fake: sets=W1*400')
  const selected = () => grid().locator('.rg-c.is-sel').count()
  // The first cell is the current cell from the start, so a first Shift+click selects from it.
  await expect(cell(0, 0)).toHaveClass(/is-sel/)
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
  await grid().locator('.rg-corner').click()
  await expect.poll(() => grid().locator('.rg-ch.sel').count()).toBeGreaterThan(3)
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
  await expect(page.locator('.job-notice')).toHaveText('Copied 20 rows. 10 values were truncated.')
  await expect(page.locator('.output-panel > [role="status"]')).toHaveText('Copied 20 rows. 10 values were truncated.')
  // A copy that takes a while shows its strip, then sets the clipboard.
  await run('-- varia-fake: sets=W1*200000')
  await measured('copying 200,000 rows', async () => {
    await cell(0, 0).click()
    await page.keyboard.press('Control+A')
    await setClipboard('')
    await writeFile(join(control, 'hold', 'results.copy'), '')
    await page.keyboard.press('Control+C')
    await expect(page.locator('.job-strip')).toContainText('Copying…')
    await rm(join(control, 'hold', 'results.copy'))
    await expect.poll(async () => (await clipboard()).split(eol).length, { timeout: 60000 }).toBe(200_000)
    await expect(page.locator('.job-strip')).toHaveCount(0)
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
  await expect(grid()).toHaveClass(/rg-border-hover/)
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
  expect(await grid().locator('.rg-ch.sel').allTextContents()).toEqual(['id'])
  const narrowed = await header('name').boundingBox()
  await page.mouse.dblclick(narrowed.x + narrowed.width - 1, narrowed.y + narrowed.height / 2)
  await expect.poll(() => widthOf(header('name'))).toBeCloseTo(initial, 0)
  expect(await clipped()).toBe(false)
  await page.mouse.move(border.x, border.y + 200)
  await expect(grid()).not.toHaveClass(/rg-border-hover/)
  console.log('Results checks: a column border resizes its column, Escape restores it, and a double-click fits it.')

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
  const notice = page.locator('.job-notice')
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
  await expect(page.locator('.job-strip:not(.job-notice)')).toContainText(/^Saving held\.csv… \d+% \([\d,]+ of 5,000 rows\)/)
  // The strip's progress is visual only: the pane's live region says how the save ended, once.
  await expect(page.locator('.output-toolbar [role="status"], .output-toolbar [aria-live]')).toHaveCount(0)
  await expect.poll(async () => (await files()).some(name => name.endsWith('.tmp'))).toBe(true)
  await page.screenshot({ path: resolve('artifacts', 'results-saving.png') })
  await page.keyboard.press('Escape')
  await expect(notice).toHaveText('Saving was cancelled. The file was not written.')
  await expect.poll(files).toEqual(['w1.csv', 'w1.json', 'w1.txt'])
  // Running the query again releases the result, but the save goes on with its strip and finishes the file.
  await choose(join(saveDir, 'kept.csv'))
  await cell(0, 0).click()
  await page.keyboard.press('Control+S')
  await expect(page.locator('.job-strip:not(.job-notice)')).toContainText('Saving kept.csv…')
  await run('-- varia-fake: sets=M1*1')
  await expect(page.locator('.job-strip:not(.job-notice)')).toContainText('Saving kept.csv…')
  await rm(join(control, 'hold', 'results.export'))
  await expect(notice).toHaveText('Saved 5,000 rows to kept.csv.', { timeout: 30000 })
  await expect(page.locator('.job-strip:not(.job-notice)')).toHaveCount(0)
  expect((await readFile(join(saveDir, 'kept.csv'), 'utf8')).split('\r\n')).toHaveLength(5002)
  expect(await files()).toEqual(['kept.csv', 'w1.csv', 'w1.json', 'w1.txt'])
  // Back to the default (null resets), so the copies below have no header line.
  expect((await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.includeColumnHeaders': null }))).ok).toBe(true)
  // Close Results (from the palette) frees the results and their windows; Messages stay.
  await textbox().focus()
  await page.keyboard.press('F1')
  await page.keyboard.type('close results')
  await expect(page.locator('.quick-input .quick-input-row.active')).toContainText('Query: Close Results')
  await page.keyboard.press('Enter')
  await expect(page.locator('.output-empty')).toHaveText('Results were closed to free memory. Execute the query again to see them.')
  await expect(page.locator('[data-result-grid]')).toHaveCount(0)
  // Run from the editor, it leaves focus there.
  await expect(textbox()).toBeFocused()
  await expect.poll(async () => (await stats()).client.uiWindows).toBe(0)
  // The Results tab stays, with no count of the sets that are gone.
  await expect(outputTab(/^Results/)).toHaveText('Results')
  await expect(outputTab(/^Results/)).toHaveAccessibleName('Results')
  await outputTab(/^Messages/).click()
  await expect(page.locator('.messages')).toContainText('Completion time:')
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
  await expect(forXml).toHaveClass(/is-link/)
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
  await expect(page.locator('.query-context')).toHaveText('XML document')
  // A value's tab shows its kind by icon, not a text badge.
  await expect(page.locator('.query-tab.active .tab-icon')).toHaveAttribute('data-icon', 'code')
  await expect(page.locator('.query-tab.active .tab-select')).toHaveText(forXmlName)
  await expect(page.locator('.query-tab.active .dirty-dot')).toHaveCount(0)
  await expect(server()).toBeDisabled()
  await expect(server()).toHaveValue('')
  await expect(page.locator('.toolbar-actions button.execute')).toBeDisabled()
  await expect(page.locator('.output-empty')).toContainText('Query results appear here for query tabs.')
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
  await cell(0, 0, grid(1)).click({ modifiers: ['Shift'] })
  await expect(queryTabs()).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(valueTab('ExecutionPlan1.sqlplan')).toHaveAttribute('aria-selected', 'true')
  expect(await editorLanguage()).toBe('xml')
  await expect(page.locator('.query-context')).toHaveText('Execution plan')
  await expect(page.locator('.query-tab.active .tab-icon')).toHaveAttribute('data-icon', 'execution-plan')
  expect(await editorText()).toBe('<ShowPlanXML>\n  <BatchSequence>\n    <Batch />\n  </BatchSequence>\n</ShowPlanXML>')
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  // A JSON value opens formatted, in JSON.
  await run('-- varia-fake: sets=L1*3')
  await cell(0, 2).click()
  await expect(valueTab('data1.json')).toHaveAttribute('aria-selected', 'true')
  expect(await editorLanguage()).toBe('json')
  await expect(page.locator('.query-context')).toHaveText('JSON document')
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
    await expect(page.locator('.query-tab.active .dirty-dot')).toHaveCount(0)
    await page.keyboard.press('Control+W')
    await expect(queryTabs()).toHaveCount(1)
  })
  expect(await calls('query.session.close')).toBe(sessionCloses)
  // macOS overlay scroll bars take no room: they lie over the cells, and a press on one targets the scroller itself.
  // Hidden bars in a small scroller give Linux that geometry. The press a scroll-bar drag sends there (at the edge, and
  // 40 px in, where a zoomed-out window's bar still is) selects nothing and opens nothing; the same press on the plan
  // cell under it selects the cell and opens the plan.
  const overlayStyle = await page.addStyleTag({ content: '[data-result-grid] .rg-scroll { max-width: 520px; max-height: 80px } [data-result-grid] .rg-scroll::-webkit-scrollbar { width: 0; height: 0 }' })
  await cell(0, 0).click()
  await page.keyboard.press('End')
  await settled()
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const beforeOverlayPress = await active()
  const overlayBar = await scroller().evaluate(element => {
    const box = element.getBoundingClientRect(), row = element.querySelector('.rg-row[aria-rowindex="3"]').getBoundingClientRect()
    const x = box.left + element.clientWidth - 5, y = row.top + row.height / 2, under = document.elementFromPoint(x, y)?.closest('.rg-c')
    const inner = document.elementFromPoint(x - 35, y)?.closest('.rg-c')
    return {
      x, y, inner: inner === under, overlay: element.offsetWidth === element.clientWidth && element.offsetHeight === element.clientHeight,
      overflows: element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight,
      inView: y < box.top + element.clientHeight, link: !!under?.classList.contains('is-link'), column: under?.getAttribute('aria-colindex')
    }
  })
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
  await expect(page.locator('.query-context')).toHaveText('Execution plan')
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  expect(await active()).toMatchObject({ row: 1, column: 3 })
  await overlayStyle.evaluate(node => node.remove())
  console.log('Results checks: XML, JSON and plan values open formatted in their own tabs, save as XML, and close without a session; a 2 MB value fills in without a long task; a press on an overlay scroll bar selects and opens nothing.')

  // 10. Messages stream while the script runs; errors are red and in order; the completion time and the error badge.
  await writeFile(join(control, 'hold', 'query.execute'), '')
  await run('-- varia-fake: sets=N1*10 messages=3 errors=2 hold', { running: true })
  await outputTab(/^Messages/).click()
  await expect(page.locator('.messages')).toContainText('Message 3')
  await expect(status()).toContainText('Executing query…')
  // The query status bar's executing icon turns (Icon's spin), and stops under the smoke runs' reduced motion.
  const spinner = page.locator('.query-status-state [data-icon="loading"]')
  await expect(spinner).toHaveClass(/\bcodicon-modifier-spin\b/)
  const turning = () => spinner.evaluate(element => getComputedStyle(element).animationName)
  expect(await turning()).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await turning()).toBe('codicon-spin')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await rm(join(control, 'hold', 'query.execute'))
  await expect(status()).toContainText('Query completed with errors.')
  const entries = await page.locator('.messages .msg').evaluateAll(items => items.map(item => [item.classList.contains('error') ? 'error' : 'info', item.textContent]))
  expect(entries.slice(0, 5)).toEqual([['info', 'Message 1'], ['info', 'Message 2'], ['info', 'Message 3'], ['error', 'Msg 50000, Level 16, State 1, Line 1\nFake error 1.'], ['error', 'Msg 50000, Level 16, State 1, Line 2\nFake error 2.']])
  expect(entries.at(-1)[1]).toMatch(/^Completion time: \d{4}-\d\d-\d\dT/)
  expect((await computed(page.locator('.messages .msg.error').first())).color).toBe(await tokenColor('errorForeground'))
  await expect(outputTab(/^Messages/).locator('.error-count')).toHaveText('!')
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
  const panel = page.locator('.output-panel [role="tabpanel"]')
  await expect(panel.locator('.messages')).toBeVisible()
  expect(await panel.getAttribute('aria-labelledby')).toBe(await outputTab(/^Messages/).getAttribute('id'))
  expect(await outputTab(/^Messages/).getAttribute('aria-controls')).toBe(await panel.getAttribute('id'))
  await page.keyboard.press('Home')
  await expect(outputTab(/^Results/)).toBeFocused()
  await expect(panel.locator('[data-result-grid]')).toHaveCount(1)
  await page.keyboard.press('ArrowLeft')
  await expect(outputTab(/^Messages/)).toBeFocused()
  await run('-- varia-fake: sets=W1*0')
  await outputTab(/^Messages/).click()
  await expect(page.locator('.messages')).toContainText('Commands completed successfully.')
  console.log('Results checks: Messages stream, show errors in red and in order, and end with the completion time.')

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

  // 12. Memory: the status bar shows what the backend holds against its budget, with a warning from 90 %.
  await server().selectOption({ index: 1 })
  await run('-- varia-fake: sets=W1*10 memory=0.92')
  const memory = page.locator('.memory-indicator')
  // The warning icon is drawn; the words say it to screen readers.
  await expect(memory).toHaveText('Warning: Results 236 MB / 256 MB. When it is full, new results are truncated.')
  await expect(memory.locator('.codicon-warning')).toHaveCount(1)
  await expect(memory).toHaveAttribute('title', /When it is full, new results are truncated\.$/)
  // Script As's segment and then the server and database give way to a long text; the backend status and the indicator
  // keep their size. Every segment keeps one line (step 17 fits a long server name into a small window).
  expect(await page.locator('.status-bar > :not(.status-scripting)').evaluateAll(parts => parts.map(part => getComputedStyle(part).flexShrink + ' ' + getComputedStyle(part).whiteSpace)))
    .toEqual(['0 nowrap', '1 nowrap', '0 nowrap'])
  // Closing the results releases them; the backend reports the fall before it answers, and the indicator hides. Run
  // while a grid has focus, it moves focus to the Results tab, which stays, rather than dropping it with the grid.
  await cell(0, 0).click()
  await expect(grid()).toBeFocused()
  await page.keyboard.press('F1')
  await page.keyboard.type('close results')
  await expect(page.locator('.quick-input .quick-input-row.active')).toContainText('Query: Close Results')
  await page.keyboard.press('Enter')
  await expect(memory).toHaveCount(0)
  await expect(page.locator('[data-result-grid]')).toHaveCount(0)
  await expect(outputTab(/^Results/)).toBeFocused()
  await expect(outputTab(/^Results/)).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true)
  // A run that grows by less than a report step is shown only by its summary, which the backend counts as reported, so
  // closing it still sends the fall and the indicator hides.
  const closeResults = async () => {
    await page.keyboard.press('F1')
    await page.keyboard.type('close results')
    await expect(page.locator('.quick-input .quick-input-row.active')).toContainText('Query: Close Results')
    await page.keyboard.press('Enter')
    await expect(page.locator('.quick-input')).toHaveCount(0)
  }
  await run('-- varia-fake: sets=W1*10 memory=0.1')
  await expect(memory).toHaveText(/^Results 26 MB \/ 256 MB$/)
  await closeResults()
  await expect(memory).toHaveCount(0)
  // Two tabs' results add up, and closing one tab's leaves the other's.
  await run('-- varia-fake: sets=W1*10 memory=0.1')
  await expect(memory).toHaveText(/^Results 26 MB \/ 256 MB$/)
  await page.keyboard.press('Control+N')
  await expect(queryTabs()).toHaveCount(2)
  if (!(await server().inputValue())) await server().selectOption({ index: 1 })
  await run('-- varia-fake: sets=W1*10 memory=0.1')
  await expect(memory).toHaveText(/^Results 51 MB \/ 256 MB$/)
  await closeResults()
  await expect(memory).toHaveText(/^Results 26 MB \/ 256 MB$/)
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  await expect(memory).toHaveText(/^Results 26 MB \/ 256 MB$/)
  await closeResults()
  await expect(memory).toHaveCount(0)
  await run('-- varia-fake: sets=W1*10 memory=0')
  await expect(memory).toHaveCount(0)
  // Closing a tab of hundreds of sets frees every one of them: one request closes them all, where one request each ran
  // into main's limit of 64 outstanding and left most of them held.
  await page.keyboard.press('Control+N')
  await expect(queryTabs()).toHaveCount(2)
  if (!(await server().inputValue())) await server().selectOption({ index: 1 })
  await run('-- varia-fake: sets=M1*300 memory=0.5')
  await expect(memory).toHaveText(/^Results 128 MB/)
  await page.keyboard.press('Control+W')
  await expect(queryTabs()).toHaveCount(1)
  await expect(memory).toHaveCount(0)
  console.log('Results checks: the memory indicator warns from 90 %, and closing results or a tab of 300 sets frees them all.')

  // 13. Menu: Shift+F10 on the grid lists its commands; a right-click on an unselected cell selects it first.
  await cell(1, 1).click()
  await page.keyboard.press('Shift+F10')
  const outputMenu = page.getByRole('menu', { name: 'Query output', exact: true })
  await expect(outputMenu).toBeVisible()
  expect(await outputMenu.locator('.menu-item .menu-label').allTextContents()).toEqual(['Copy', 'Copy with Headers', 'Select All', 'Save Results As…'])
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
  await expect(cell(3, 2)).toHaveClass(/is-sel/)
  await expect(cell(4, 2)).not.toHaveClass(/is-sel/)
  await page.keyboard.press('Escape')
  await expect(outputMenu).toHaveCount(0)

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
  await expect(cell(1, 3)).toHaveClass(/is-sel/)
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
  await page.keyboard.press('Control+R')
  await expect(page.locator('[data-pane-tab="output"]')).toHaveCount(0)
  await expect(page.locator('.output-panel')).toBeHidden()
  await page.keyboard.press('Control+R')
  await expect(page.locator('[data-pane-tab="output"]')).toBeVisible()
  await expect(page.locator('.output-panel')).toBeVisible()
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
    const closed = document.querySelector('[data-pane-tab="output"]') === null
    await Promise.resolve()
    press()
    return closed
  })).toBe(true)
  await expect(page.locator('.output-panel')).toBeVisible()
  await expect(scroller()).toHaveAttribute('data-moved', 'kept')
  await expect.poll(scrollTop).toBe(keptTop)
  await expect.poll(async () => { const [first, last] = await visibleRows(); return first <= kept.row + 1 && last >= kept.row + 1 }).toBe(true)
  expect(await active()).toMatchObject({ row: kept.row, column: kept.column, selected: 'true' })
  expect(await widthOf(header('id'))).toBeCloseTo(resized, 0)
  // The pane's live region reads out only what happens while a tab is shown: switching tabs repeats no sentence.
  const liveRegion = page.locator('.output-panel > [role="status"]')
  await page.keyboard.press('Control+N')
  await expect(queryTabs()).toHaveCount(2)
  await expect(liveRegion).toHaveText('')
  await queryTabs().first().click()
  await expect(liveRegion).toHaveText('')
  await expect.poll(scrollTop).toBe(keptTop)
  expect(await active()).toMatchObject({ row: kept.row, column: kept.column, selected: 'true' })
  await expect.poll(() => widthOf(header('id'))).toBeCloseTo(resized, 0)
  // A press on the grid's scroll bar leaves the focus on the grid, so the arrow keys move a cell screen readers hear.
  const bar = await scroller().evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.left + element.clientWidth + (element.offsetWidth - element.clientWidth) / 2, y: box.top + element.clientHeight * 0.75, width: element.offsetWidth - element.clientWidth } })
  if (bar.width > 0) {
    await textbox().focus()
    await page.mouse.click(bar.x, bar.y)
    await expect(grid()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await active()).resolved).toBe(true)
    await expect(grid()).toBeFocused()
  }
  console.log('Results checks: F6 goes to the results and back; Ctrl+R and tab switches keep scroll, selection and column widths.')

  // 11 (continued). A backend crash makes the shown results unavailable, without a page error.
  await writeFile(join(control, 'crash-next'), '')
  await queryTabs().nth(1).click()
  if (!(await server().inputValue())) await server().selectOption({ index: 1 })
  await typeSql('SELECT 1;')
  await page.keyboard.press('F5')
  await expect(page.locator('.messages .msg.error')).toContainText('The SQL backend stopped', { timeout: 30000 })
  await queryTabs().first().click()
  await expect(page.locator('.rg-overlay')).toHaveText('These results are no longer available because the SQL backend restarted.', { timeout: 30000 })
  // Nothing is left to save.
  await textbox().focus()
  await page.keyboard.press('F1')
  await page.keyboard.type('save results as')
  await expect(page.locator('.quick-input .quick-input-row.active')).toContainText('Save Results As')
  await expect(page.locator('.quick-input .quick-input-row.active')).toHaveClass(/disabled/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.quick-input')).toHaveCount(0)
  console.log('Results checks: a backend crash marks the shown results unavailable, and Save Results As is disabled.')

  // 17. At a small window the output toolbar, the grid's strip and the status bar stay inside it.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 700))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024)
  await queryTabs().nth(1).click()
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  await page.locator('.explorer-row.lost').getByRole('button', { name: /^Reconnect/ }).click()
  const connect = page.getByRole('dialog', { name: 'Connect', exact: true })
  await connect.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(connect).toHaveCount(0)
  await expect(page.locator('.query-context')).not.toContainText('connection lost')
  // A cancelled run keeps the rows it read, marked incomplete in the grid's strip.
  await run('-- varia-fake: sets=W1*200000@20000', { running: true })
  await expect(cell(0, 0)).toHaveText('0')
  await page.locator('.toolbar-actions').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(status()).toContainText('Query was cancelled.')
  await outputTab(/^Results/).click()
  await expect(strip()).toContainText('This result is incomplete')
  // A grid holds only its rows: the strip (a status, here with no Retry) is outside the table structure.
  await expect(grid().locator('[role="status"], button')).toHaveCount(0)
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  for (const locator of [page.locator('.output-toolbar'), strip(), page.locator('.status-bar')]) {
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
  const strips = page.locator('.job-strip:not(.job-notice)')
  await expect(strips).toHaveCount(1)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+C')
  await expect(strips).toHaveCount(2)
  for (const locator of [...await page.locator('.output-toolbar > *').all(), ...await strips.getByRole('button', { name: 'Cancel', exact: true }).all()]) {
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
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByLabel('Server Name', { exact: true }).fill(longServer)
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await server().selectOption({ label: longServer })
  await run('-- varia-fake: sets=W1*10 memory=0.5')
  await expect(page.locator('.memory-indicator')).toHaveText(/^Results 128 MB/)
  await expect(page.locator('.query-status-bar')).toHaveAttribute('title', new RegExp(`^${longServer.replace(/[\\.]/g, '\\$&')}( \\(\\d+\\.\\d+\\))? \\| \\S`))
  expect(await page.evaluate(() => {
    const fits = bar => { const box = bar.getBoundingClientRect(); return [...bar.querySelectorAll(':scope > *, .query-status-segment')].every(child => { const part = child.getBoundingClientRect(); return part.left >= box.left - 0.5 && part.right <= box.right + 0.5 && part.top >= box.top - 0.5 && part.bottom <= box.bottom + 0.5 }) }
    const server = document.querySelector('.query-status-server'), database = document.querySelector('.query-status-database')
    return {
      fits: fits(document.querySelector('.status-bar')) && fits(document.querySelector('.query-status-bar')), rows: document.querySelector('.query-status-rows')?.textContent,
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, cut: server.scrollWidth > server.clientWidth,
      // The server gives way before the database, which stays whole while the server can shrink.
      database: database.scrollWidth <= database.clientWidth
    }
  })).toEqual({ fits: true, rows: 'Rows: 10 rows', overflow: false, cut: true, database: true })
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
  const statusLayout = () => page.evaluate(() => {
    const bar = document.querySelector('.status-bar'), box = bar.getBoundingClientRect()
    const parts = { backend: bar.firstElementChild, cancel: bar.querySelector('button[aria-label="Cancel scripting"]'), place: bar.querySelector('.editor-status'), memory: bar.querySelector('.memory-indicator') }
    const boxes = Object.entries(parts).map(([name, part]) => [name, part.getBoundingClientRect()])
    const overlaps = boxes.flatMap(([name, a], i) => boxes.slice(i + 1).filter(([, b]) => a.left < b.right - 0.5 && b.left < a.right - 0.5).map(([other]) => name + '/' + other))
    const text = bar.querySelector('.status-scripting-text').getBoundingClientRect(), gap = text.left - parts.backend.getBoundingClientRect().right
    return {
      overlaps, inside: boxes.every(([, part]) => part.left >= box.left - 0.5 && part.right <= box.right + 0.5),
      text: text.width >= 40, gap: gap >= 8 || gap, placeShown: parts.place.getBoundingClientRect().width >= 40
    }
  })
  await scriptOrders('CREATE To', 'Clipboard')
  const cancelScripting = page.getByRole('button', { name: 'Cancel scripting', exact: true })
  await expect(cancelScripting).toBeVisible()
  expect(await statusLayout()).toEqual({ overlaps: [], inside: true, text: true, gap: true, placeShown: true })
  await page.locator('.status-bar').screenshot({ path: resolve('artifacts', 'results-small-scripting.png') })
  await scriptOrders('DROP To', 'New Query Editor Window')
  await expect(page.locator('.status-scripting-more')).toHaveText('(+1 more)')
  expect(await statusLayout()).toEqual({ overlaps: [], inside: true, text: true, gap: true, placeShown: true })
  await page.locator('.status-bar').screenshot({ path: resolve('artifacts', 'results-small-scripting-2.png') })
  await rm(join(control, 'hold', 'scripting.script'))
  await expect(cancelScripting).toHaveCount(0)
  expect(failures).toEqual([])
  console.log('Results checks passed: streaming, a million rows past the scroll cap, wide results, stacked sets, ARIA, selection and copy, resizing, Save Results As, values in their own tabs, Messages, lifecycle, memory, the menu, styling, F6, Ctrl+R, tabs and a small window.')

  // Part B: a real SQL Server through the Release backend. The first rows of a million show within a second while the
  // script still runs; Cancel keeps them and Ctrl+End reaches the last; Save Results As writes every one as CSV; a copy
  // of 100,000 rows matches the server's rows; a FOR XML PATH value opens in its own tab; and a SQL error sits between
  // the messages printed around it.
  if (process.env.VARIA_TEST_SQL_SERVER) {
    await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 10000))]).catch(() => {})
    child?.kill()
    const liveProfile = await mkdtemp(resolve('artifacts', 'results-live-profile-')), liveSaves = await mkdtemp(resolve('artifacts', 'results-live-save-'))
    cleanups.push(() => rm(liveProfile, { recursive: true, force: true }), () => rm(liveSaves, { recursive: true, force: true }))
    const liveEnv = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: liveProfile }
    delete liveEnv.ELECTRON_RUN_AS_NODE
    application = await electron.launch({ args: ['.'], env: liveEnv, chromiumSandbox: process.getuid?.() !== 0 })
    child = application.process()
    page = await application.firstWindow()
    page.setDefaultTimeout(30000)
    page.on('pageerror', error => failures.push(error.message))
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await expect(page.locator('.status-bar').getByText(/· Ready/)).toBeVisible({ timeout: 30000 })
    await connectLive(page, expect)
    await enlargeOutput(page)
    // The session opens with the first run, so the timed one below measures rows, not the login.
    await run('SELECT 1 AS warm;')
    const liveText = n => liveRow(n).map(value => value ?? 'NULL')
    // Row 1 painted, timed in the page from just before F5 (a poll from here would add its own interval). The server holds
    // a part-filled packet until the batch ends, so RAISERROR WITH NOWAIT sends the last rows before the wait.
    await typeSql(`${liveRowsSql(1_000_000)}\nRAISERROR(N'All rows sent.', 0, 1) WITH NOWAIT;\nWAITFOR DELAY '00:05:00';`)
    await page.evaluate(first => {
      window.__variaLiveFirst = new Promise(done => {
        const started = performance.now()
        const check = () => {
          const element = document.querySelector('[data-result-grid] .rg-row[aria-rowindex="2"] .rg-c[aria-colindex="3"]')
          if (element?.textContent === first) done(performance.now() - started)
          else if (performance.now() - started < 30000) requestAnimationFrame(check)
          else done(Infinity)
        }
        requestAnimationFrame(check)
      })
    }, liveText(1)[1])
    await page.keyboard.press('F5')
    const firstRows = await page.evaluate(() => window.__variaLiveFirst)
    console.log(`Results live: the first rows of a million painted ${Math.round(firstRows)} ms after F5.`)
    expect(firstRows).toBeLessThan(1000)
    await expect(status()).toContainText('Executing query…')
    const rowsRead = async () => Number((await status().textContent()).match(/· ([\d,]+) rows?/)?.[1].replaceAll(',', '') ?? 0)
    await expect.poll(rowsRead, { timeout: 120000 }).toBe(1_000_000)
    await expect(status()).toContainText('Executing query…')
    await page.screenshot({ path: resolve('artifacts', 'results-live.png') })
    await page.locator('.toolbar-actions').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(status()).toContainText('Query was cancelled.', { timeout: 30000 })
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
    await expect(page.locator('.job-notice')).toHaveText('Saved 1,000,000 rows to million.csv.', { timeout: 120000 })
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
    await expect(cell(0, 0)).toHaveClass(/is-link/)
    await cell(0, 0).click()
    await expect(queryTabs().filter({ hasText: 'XML_F52E2B61-18A1-11d1-B105-00805F49916B1.xml' })).toHaveAttribute('aria-selected', 'true')
    const xml = await editorText()
    expect(xml.startsWith('<objects>\n  <o>\n    <name>')).toBe(true)
    expect(xml.endsWith('</objects>')).toBe(true)
    expect(xml.split('<o>').length - 1).toBe(200)
    await page.keyboard.press('Control+W')
    await expect(queryTabs()).toHaveCount(1)
    // A statement's error is reported in place, between the messages before and after it, and the run ends on Messages.
    await run(`PRINT 'before';\nSELECT 1/0 AS boom;\nPRINT 'after';`)
    await expect(status()).toContainText('Query completed with errors.')
    await expect(outputTab(/^Messages/)).toHaveAttribute('aria-selected', 'true')
    const messages = await page.locator('.messages .msg').evaluateAll(items => items.map(item => [item.classList.contains('error') ? 'error' : 'info', item.textContent]))
    expect(messages.slice(0, 3)).toEqual([['info', 'before'], ['error', 'Msg 8134, Level 16, State 1, Line 2\nDivide by zero error encountered.'], ['info', 'after']])
    expect(messages.at(-1)[1]).toMatch(/^Completion time: \d{4}-\d\d-\d\dT/)
    // Memory: Close Results in one tab races the summary of a 1,000-set run in another. The summary takes its figure
    // before it is serialized, so the close's fall can arrive first; the indicator must still end on what the backend
    // holds, which the next summary (SELECT 1) reports.
    const memory = page.locator('.memory-indicator')
    const shown = async () => (await memory.count()) ? (await memory.textContent()).trim() : '(hidden)'
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
      await expect(status()).toContainText('Executing query…')
      // Close Results for tab 1 from the palette; Enter goes the moment tab 2's last set closes.
      await queryTabs().first().click()
      await page.keyboard.press('F1')
      await page.keyboard.type('close results')
      await expect(page.locator('.quick-input .quick-input-row.active')).toContainText('Query: Close Results')
      await page.evaluate(() => {
        const input = document.activeElement
        window.__variaRace.trigger = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      })
      await page.waitForFunction(() => window.__variaRace.log.some(entry => entry[0] === 'summary' && entry[3] === 1000), null, { timeout: 120000 })
      if (!(await page.evaluate(() => window.__variaRace.fired))) await page.keyboard.press('Enter')
      await expect(page.locator('.quick-input')).toHaveCount(0)
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
    expect(failures).toEqual([])
    console.log('Results live checks passed: rows show while a million stream, Cancel keeps them, Save Results As and Copy match the server, FOR XML opens in a tab, errors keep their order, and the memory indicator survives a close racing a summary.')
  }
} catch (error) {
  await page.screenshot({ path: resolve('artifacts', 'results-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 10000))]).catch(() => {})
  child?.kill()
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
  for (const cleanup of cleanups) await cleanup().catch(() => {})
}
