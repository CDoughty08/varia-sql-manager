// The results grid against the fake backend's synthetic result sets (`-- varia-fake:` scripts, tests/fixtures/backend):
// streaming, a million rows past the scroll cap, wide results, stacked sets, ARIA, selection and copy, column resizing,
// Save Results As, XML, JSON and plan values in their own tabs, Messages, lifecycle, the memory indicator, the grid's
// menu, styling, panes and tabs. No assertion depends on absolute pixel sizes.
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { shapes } from '../tests/fixtures/backend/shapes.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'results-profile-'))
const control = await mkdtemp(resolve('artifacts', 'results-control-'))
await mkdir(join(control, 'hold'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
const linux = process.platform === 'linux', eol = process.platform === 'win32' ? '\r\n' : '\n'
// Renderer long tasks in the measured segments: none of 50 ms on Linux (a segment may run once more), elsewhere at most
// 2 and none of 100 ms.
const longTaskLimit = linux ? 50 : 100
const application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const child = application.process()
const watchdog = setTimeout(() => { console.error('Results suite exceeded its time limit.'); child?.kill(); process.exit(1) }, 900_000)
const page = await application.firstWindow()
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
/** The active cell once keys and drags are painted: its row and the scroll position no longer change. */
async function settled(index = 0) {
  const position = async () => JSON.stringify([(await active(index)).row, await scroller(index).evaluate(element => element.scrollTop)])
  let previous
  await expect.poll(async () => { const now = await position(), same = now === previous; previous = now; return same }, { intervals: [100] }).toBe(true)
  return active(index)
}
/** The first and last row numbers drawn inside the grid's body. */
const visibleRows = (index = 0) => grid(index).evaluate(root => {
  const body = root.querySelector('.rg-scroll').getBoundingClientRect(), head = root.querySelector('.rg-head').getBoundingClientRect()
  const numbers = [...root.querySelectorAll('.rg-row')].filter(row => row.style.display !== 'none').filter(row => {
    const box = row.getBoundingClientRect()
    return box.top >= head.bottom - 1 && box.bottom <= body.bottom + 1
  }).map(row => Number(row.querySelector('.rg-rh').textContent))
  return [Math.min(...numbers), Math.max(...numbers)]
})
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
/** Records renderer long tasks from now on. */
const startLongTasks = () => page.evaluate(() => {
  window.__variaLongTasks?.disconnect()
  window.__variaLongTaskList = []
  window.__variaLongTasks = new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__variaLongTaskList.push(Math.round(entry.duration)) })
  window.__variaLongTasks.observe({ type: 'longtask' })
})
const longTasks = () => page.evaluate(() => window.__variaLongTaskList)
/** Runs `segment` with long tasks recorded; a segment over the limit runs once more before it fails. */
async function measured(name, segment) {
  for (let attempt = 1; ; attempt++) {
    await startLongTasks()
    await segment()
    const tasks = await longTasks()
    console.log(`Results ${name}: long tasks ${JSON.stringify(tasks)} (attempt ${attempt}).`)
    const over = tasks.filter(ms => ms >= longTaskLimit)
    if (linux ? over.length === 0 : tasks.length <= 2 && over.length === 0) return
    if (attempt === 2) throw new Error(`${name}: renderer long tasks ${JSON.stringify(tasks)} (limit ${longTaskLimit} ms)`)
  }
}
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
  const outputTop = (await page.locator('.output-panel').boundingBox()).y
  const sash = (await Promise.all((await page.locator('.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash:not(.dv-disabled)').all()).map(item => item.boundingBox())))
    .filter(box => box && box.y < outputTop).sort((a, b) => b.y - a.y)[0]
  await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2)
  await page.mouse.down()
  await page.mouse.move(sash.x + sash.width / 2, Math.max(150, sash.y - 300), { steps: 5 })
  await page.mouse.up()

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
    await page.keyboard.press('Control+End')
    await expect.poll(async () => (await active()).text).toBe(w1(999_999)[7])
    expect(await active()).toMatchObject({ resolved: true, row: 999_999, column: 7 })
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
    jumped = await stats()
    // The wheel moves the rows by its pixels (a row is 20 of them), never by the compressed scroll bar.
    await page.evaluate(() => window.__variaGrid.reset())
    const box = await scroller().boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const [before] = await visibleRows()
    for (let step = 0; step < 30; step++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(16) }
    await expect.poll(async () => (await visibleRows())[0]).toBeGreaterThan(before + 100)
    expect((await visibleRows())[0]).toBeLessThan(before + 200)
    wheeled = await stats()
  })
  console.log(`Results frames over a million rows: jumps p95 ${p95(jumped.frames).toFixed(2)} ms of ${jumped.frames.length}, wheel p95 ${p95(wheeled.frames).toFixed(2)} ms of ${wheeled.frames.length}; tiles ${wheeled.hits} hits / ${wheeled.misses} misses; UI cache ${wheeled.client.uiWindows} windows / ${wheeled.client.uiUnits} units; worker ${wheeled.client.workerPages} pages / ${wheeled.client.workerBytes} bytes; ${wheeled.nodes} grid elements.`)
  if (linux) expect(p95(wheeled.frames)).toBeLessThanOrEqual(8)
  expect(wheeled.client.uiWindows).toBeLessThanOrEqual(256)
  expect(wheeled.client.uiUnits).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(wheeled.client.workerBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
  expect(wheeled.nodes).toBeLessThanOrEqual(1500)

  // 3. Wide results: End and Ctrl+→ bring the last column into view, the DOM stays small, and the row numbers stay at
  // the grid's left edge however far it scrolls, with native and with virtual scrolling.
  const rowHeaderAtLeft = () => grid().evaluate(root => {
    const row = [...root.querySelectorAll('.rg-row')].find(item => item.style.display !== 'none')
    return Math.abs(row.querySelector('.rg-rh').getBoundingClientRect().left - root.getBoundingClientRect().left) <= 1
  })
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
    })
    const wide = await stats()
    console.log(`Results checks: 300 columns (${cap ? 'virtual' : 'native'} scrolling): ${wide.nodes} grid elements, frames p95 ${p95(wide.frames).toFixed(2)} ms of ${wide.frames.length}.`)
    expect(wide.nodes).toBeLessThanOrEqual(4000)
    if (linux) expect(p95(wide.frames)).toBeLessThanOrEqual(16)
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
  await grid(0).focus()
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
    // A cell whose rows are still being read has no text and no label yet.
    let state
    await expect.poll(async () => { state = await active(); return state.resolved && state.label !== null }, key).toBe(true)
    expect(state, key).toMatchObject({ role: 'gridcell', selected: 'true' })
    expect(state.id, key).toMatch(new RegExp(`-r${state.row}c${state.column}$`))
    expect(state.label.startsWith(state.text), key).toBe(true)
    if (state.text === 'NULL') expect(state.label, key).toContain(', NULL')
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
  await expect.poll(async () => (await active()).label).toBe('NULL, NULL')
  console.log('Results checks: the active descendant follows every grid key with its row, column, selection and label.')

  // 6. Selection and copy: clicks, Shift, a drag that scrolls, Ctrl+click on columns and rows, headers and the corner;
  // the exact text by keys, with headers, and through Edit › Copy; a long copy's strip; a copy over the limit.
  await run('-- varia-fake: sets=W1*400')
  const selected = () => grid().locator('.rg-c.is-sel').count()
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
  await grid().locator('.rg-row[aria-rowindex="2"] .rg-rh').click()
  await grid().locator('.rg-row[aria-rowindex="4"] .rg-rh').click({ modifiers: ['Control'] })
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
  expect(await grid().locator('.rg-ch.sel').count()).toBe(0)
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
  expect(await readFile(join(saveDir, 'w1.csv'), 'utf8')).toBe('﻿' + [w1Names, ...w1Rows(400)].map(row => row.map(csvField).join(',') + '\r\n').join(''))
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
  await expect(page.locator('.job-strip[role="status"]')).toContainText(/^Saving held\.csv… \d+% \([\d,]+ of 5,000 rows\)/)
  await expect.poll(async () => (await files()).some(name => name.endsWith('.tmp'))).toBe(true)
  await page.screenshot({ path: resolve('artifacts', 'results-saving.png') })
  await page.keyboard.press('Escape')
  await expect(notice).toHaveText('Saving was cancelled. The file was not written.')
  await expect.poll(files).toEqual(['w1.csv', 'w1.json', 'w1.txt'])
  // Running the query again releases the result, but the save goes on with its strip and finishes the file.
  await choose(join(saveDir, 'kept.csv'))
  await cell(0, 0).click()
  await page.keyboard.press('Control+S')
  await expect(page.locator('.job-strip[role="status"]')).toContainText('Saving kept.csv…')
  await run('-- varia-fake: sets=M1*1')
  await expect(page.locator('.job-strip[role="status"]')).toContainText('Saving kept.csv…')
  await rm(join(control, 'hold', 'results.export'))
  await expect(notice).toHaveText('Saved 5,000 rows to kept.csv.', { timeout: 30000 })
  await expect(page.locator('.job-strip[role="status"]')).toHaveCount(0)
  expect((await readFile(join(saveDir, 'kept.csv'), 'utf8')).split('\r\n')).toHaveLength(5002)
  expect(await files()).toEqual(['kept.csv', 'w1.csv', 'w1.json', 'w1.txt'])
  // Close Results (from the palette) frees the results and their windows; Messages stay.
  await textbox().focus()
  await page.keyboard.press('F1')
  await page.keyboard.type('close results')
  await expect(page.locator('.quick-input .quick-input-row.active')).toContainText('Query: Close Results')
  await page.keyboard.press('Enter')
  await expect(page.locator('.output-empty')).toHaveText('Results were closed to free memory. Execute the query again to see them.')
  await expect(page.locator('[data-result-grid]')).toHaveCount(0)
  await expect.poll(async () => (await stats()).client.uiWindows).toBe(0)
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
  await forXml.click()
  const forXmlName = 'XML_F52E2B61-18A1-11d1-B105-00805F49916B1.xml'
  await expect(valueTab(forXmlName)).toHaveAttribute('aria-selected', 'true')
  await expect(textbox()).toBeFocused()
  expect(await editorLanguage()).toBe('xml')
  await expect(page.locator('.query-context')).toHaveText('XML document')
  await expect(page.locator('.query-tab.active .sql-icon')).toHaveText('XML')
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
  await expect(page.locator('.query-tab.active .sql-icon')).toHaveText('PLAN')
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
  console.log('Results checks: XML, JSON and plan values open formatted in their own tabs, save as XML, and close without a session; a 2 MB value fills in without a long task.')

  // 10. Messages stream while the script runs; errors are red and in order; the completion time and the error badge.
  await writeFile(join(control, 'hold', 'query.execute'), '')
  await run('-- varia-fake: sets=N1*10 messages=3 errors=2 hold', { running: true })
  await outputTab(/^Messages/).click()
  await expect(page.locator('.messages')).toContainText('Message 3')
  await expect(status()).toContainText('Executing query…')
  await rm(join(control, 'hold', 'query.execute'))
  await expect(status()).toContainText('Query completed with errors.')
  const entries = await page.locator('.messages .msg').evaluateAll(items => items.map(item => [item.classList.contains('error') ? 'error' : 'info', item.textContent]))
  expect(entries.slice(0, 5)).toEqual([['info', 'Message 1'], ['info', 'Message 2'], ['info', 'Message 3'], ['error', 'Msg 50000, Level 16, State 1, Line 1\nFake error 1.'], ['error', 'Msg 50000, Level 16, State 1, Line 2\nFake error 2.']])
  expect(entries.at(-1)[1]).toMatch(/^Completion time: \d{4}-\d\d-\d\dT/)
  expect((await computed(page.locator('.messages .msg.error').first())).color).toBe(await tokenColor('errorForeground'))
  await expect(outputTab(/^Messages/).locator('.error-count')).toHaveText('!')
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
  await expect(memory).toHaveText('Results 236 MB / 256 MB')
  await expect(memory.locator('.codicon-warning')).toHaveCount(1)
  await expect(memory).toHaveAttribute('title', /When it is full, new results are truncated\.$/)
  await run('-- varia-fake: sets=W1*10 memory=0')
  await expect(memory).toHaveCount(0)

  // 13. Menu: Shift+F10 on the grid lists its commands; a right-click on an unselected cell selects it first.
  await cell(1, 1).click()
  await page.keyboard.press('Shift+F10')
  const outputMenu = page.getByRole('menu', { name: 'Query output', exact: true })
  await expect(outputMenu).toBeVisible()
  expect(await outputMenu.locator('.menu-item .menu-label').allTextContents()).toEqual(['Copy', 'Copy with Headers', 'Select All', 'Save Results As…'])
  await page.keyboard.press('Escape')
  await cell(3, 2).click({ button: 'right' })
  await expect(outputMenu).toBeVisible()
  await expect(cell(3, 2)).toHaveClass(/is-sel/)
  await expect(cell(1, 1)).not.toHaveClass(/is-sel/)
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
    expect(await computed(nullCell)).toEqual({ color: await tokenColor('resultsGrid.nullForeground'), background: await tokenColor('resultsGrid.nullBackground') })
    expect((await computed(cell(1, 3), '::after')).color).toBe(await tokenColor('resultsGrid.truncationForeground'))
    expect((await computed(cell(2, 4))).color).toBe(await tokenColor('errorForeground'))
    await cell(0, 0).click()
    const selection = { color: await tokenColor('resultsGrid.selectionForeground'), background: await tokenColor('resultsGrid.selectionBackground') }
    await expect.poll(() => computed(cell(0, 0))).toEqual(selection)
    await page.screenshot({ path: resolve('artifacts', `results-${mode}.png`) })
    await textbox().focus()
    const inactive = await tokenColor('resultsGrid.inactiveSelectionBackground')
    await expect.poll(async () => (await computed(cell(0, 0))).background).toBe(inactive)
    await expect(nullCell).toHaveAttribute('data-identity', 'kept')
  }
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))
  console.log('Results checks: NULL, truncated, failed and selected cells take their theme tokens, and a theme change keeps the grid\'s nodes.')

  // 15. Panes and tabs: F6 goes to the results and back; Ctrl+R hides and shows them keeping scroll, selection and a
  // resized column; a tab switch restores all three.
  await run('-- varia-fake: sets=W1*2000')
  await expect(cell(0, 1)).toHaveText(w1(0)[1])
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
  await page.keyboard.press('Control+N')
  await expect(queryTabs()).toHaveCount(2)
  await queryTabs().first().click()
  await expect.poll(scrollTop).toBe(keptTop)
  expect(await active()).toMatchObject({ row: kept.row, column: kept.column, selected: 'true' })
  await expect.poll(() => widthOf(header('id'))).toBeCloseTo(resized, 0)
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
  console.log('Results checks: a backend crash marks the shown results unavailable.')

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
  await expect(grid().locator('.rg-strip')).toContainText('This result is incomplete')
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  for (const locator of [page.locator('.output-toolbar'), grid().locator('.rg-strip'), page.locator('.status-bar')]) {
    const box = await locator.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
  }
  await page.screenshot({ path: resolve('artifacts', 'results-small.png') })
  expect(failures).toEqual([])
  console.log('Results checks passed: streaming, a million rows past the scroll cap, wide results, stacked sets, ARIA, selection and copy, resizing, Save Results As, values in their own tabs, Messages, lifecycle, memory, the menu, styling, F6, Ctrl+R, tabs and a small window.')
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
