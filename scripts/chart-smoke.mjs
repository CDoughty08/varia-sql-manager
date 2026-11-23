// Live charts in the real app (src/renderer/src/live/ChartView.ts) on the fake backend's debug.synthetic source, mounted
// over the workbench through window.__variaLive: the canvas draws the series in the theme's chart colors and redraws as
// ticks arrive, stops drawing while the window is hidden, names itself for screen readers, follows the keyboard and the
// pointer with a crosshair (gone when focus leaves, kept on the oldest sample as the window moves, kept under a pointer
// held still, its tooltip inside a narrow plot), keeps its name still while focused, lists its samples as a table in the
// plot's place (one-line caption, a header that stays, a themed focus ring, a row cap), follows its props, shows a legend
// only for several series, stops calling a paused sample "now", draws a sparkline in a metric tile (which takes no
// focus), follows a theme switch, and draws in the system colors the DOM resolves under forced colors, through a change
// of contrast theme, legend included.
import { electron, expect, within } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { backendReady, chartLegend, chartSwatchLines, chartTable, chartTableCaption, chartTooltip, connectDialogWindow, gridCell, gridCellSelector, gridPart, part, submitConnect, toolbarButton } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'chart-profile-'))
const control = await mkdtemp(resolve('artifacts', 'chart-control-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
let step = 'launch'
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error(`Chart suite timed out during: ${step}.`); app.process()?.kill(); process.exit(1) }, 240_000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
page.on('pageerror', error => failures.push(error.message))

const live = (method, ...args) => page.evaluate(([name, values]) => window.__variaLive[name](...values), [method, args])
const chart = key => live('chart', key)
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
const sleep = ms => new Promise(done => setTimeout(done, ms))
// A chart renames itself at most once per chartLimits.labelMs (5 s), so a poll on its name waits past that; the fixture's
// default (5 s off Windows) raced it on a slow Linux runner.
const labelSettles = { timeout: 10_000 }
async function menu(id) {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId)
    if (!item) throw new Error('Menu item missing: ' + itemId)
    item.click()
  }, id)
}
async function connect() {
  await toolbarButton(page, 'Connect').click()
  const { window, dialog } = await connectDialogWindow(app)
  await dialog.getByLabel('Server Name', { exact: true }).fill('chart-server')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
  await dialog.getByLabel('Password', { exact: true }).fill('chart-smoke-password')
  await dialog.getByLabel('Trust server certificate', { exact: true }).check()
  await submitConnect(window, dialog)
}

try {
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  // The window stays hidden, as in every suite (fixtures/smoke.mjs lifts its frame cap): shown, it took real pointer events,
  // and a desktop's own mouse moved or cleared the crosshair this suite holds still.
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
  await connect()
  const id = await live('subscribeSynthetic', { tickMs: 100 })
  // A rare Windows CI timeout here (no samples at all) left nothing to go on: on failure, say what the view was doing.
  await expect.poll(async () => (await live('ring', id, 'debug.synthetic.metrics'))?.length ?? 0).toBeGreaterThanOrEqual(5).catch(async error => {
    const view = await live('snapshot', id).catch(reason => String(reason))
    const owner = await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() })).catch(reason => String(reason))
    console.error('Synthetic view after the timeout:', JSON.stringify({ view, frames: await live('frames', id).catch(() => undefined), owner }))
    throw error
  })

  step = 'draw'
  const key = await live('mountChart', id, { series: [1], style: 'area', max: 100, labels: 'axes', spanMs: 10_000 })
  const box = page.locator(`[data-chart-test="${key}"]`)
  const canvas = box.locator('canvas')
  await expect(canvas).toHaveAttribute('role', 'img')
  await expect(canvas).toHaveAttribute('aria-roledescription', 'chart')
  await expect(canvas).toHaveAccessibleDescription(/^Left and Right step through the samples/)
  await expect.poll(async () => (await chart(key)).pixels.colors['charts.blue'], { timeout: 5000 }).toBeGreaterThan(20)
  const drawn = await chart(key)
  const ratio = await page.evaluate(() => devicePixelRatio)
  expect(drawn.width).toBe(Math.round((await canvas.evaluate(element => element.clientWidth)) * ratio))
  expect(drawn.label).toMatch(/^Synthetic metrics: \d+(\.\d)? %, \d+(\.\d+)? % to \d+(\.\d+)? % over the last 10 seconds$/)
  await expect(canvas).toHaveAttribute('aria-label', drawn.label)
  // One series needs no legend: the chart's name says what it is.
  await expect(chartLegend(box)).toHaveCount(0)
  // Ticks redraw it: one draw a frame at most, and only when the ring moved.
  await expect.poll(async () => (await chart(key)).draws).toBeGreaterThan(drawn.draws + 3)
  const counted = await chart(key)
  expect(counted.draws).toBeLessThanOrEqual(counted.frames)
  await page.screenshot({ path: resolve('artifacts', 'chart-dark.png') })
  console.log('Chart draw passed: the wave in charts.blue, redrawn as ticks arrive, named for screen readers.')

  step = 'hidden window'
  // The view pauses only after 2 s; the chart stops drawing at once, while ticks still arrive.
  await live('setPageHidden', true)
  const hiddenDraws = (await chart(key)).draws, hiddenTicks = (await live('frames', id)).ticks
  await sleep(700)
  expect((await live('frames', id)).ticks).toBeGreaterThan(hiddenTicks + 2)
  expect((await chart(key)).draws).toBe(hiddenDraws)
  await live('setPageHidden', false)
  await expect.poll(async () => (await chart(key)).draws).toBeGreaterThan(hiddenDraws)
  console.log('Hidden window passed: no draws while hidden, though ticks still arrived; drawing resumed when shown.')

  step = 'keyboard crosshair'
  const tip = chartTooltip(box)
  const status = box.locator('[role="status"]')
  await canvas.focus()
  // The name holds still while the chart has focus, though its value changes every tick and the name every 5 s otherwise.
  const focusedLabel = await canvas.getAttribute('aria-label'), focusedAt = Date.now()
  await page.keyboard.press('ArrowLeft')
  await expect(status).toHaveText(/^now · \d+(\.\d+)? %$/)
  await expect(tip).toBeVisible()
  await expect(tip).toHaveText(await status.textContent())
  // Home goes to the window's oldest sample: up to 10 s back, less while the view is younger than that.
  await page.keyboard.press('Home')
  await expect(status).toHaveText(/^0:(0[1-9]|10) ago · \d+(\.\d+)? %$/)
  const oldest = await status.textContent()
  // Ticks move the window past that sample: the crosshair stays on the window's oldest sample, shown, not gone.
  await sleep(400)
  await expect(tip).toBeVisible()
  // The tooltip's parts keep their own spaces from breaking (no-break spaces, which \s matches), so it wraps only between
  // parts.
  await expect(tip).toHaveText(/^0:(0\d|10)\sago · \d+(\.\d+)?\s%$/)
  await page.keyboard.press('ArrowRight')
  await expect(status).not.toHaveText(oldest)
  await page.keyboard.press('Escape')
  await expect(tip).toBeHidden()
  await expect(status).toHaveText('')
  await sleep(Math.max(0, 5600 - (Date.now() - focusedAt)))
  expect(await canvas.getAttribute('aria-label')).toBe(focusedLabel)
  // Focus leaving the chart takes its crosshair and tooltip along.
  await page.keyboard.press('ArrowLeft')
  await expect(tip).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(canvas).not.toBeFocused()
  await expect(tip).toBeHidden()
  await expect(status).toHaveText('')
  // Blurred, the name catches up.
  await expect.poll(() => canvas.getAttribute('aria-label')).not.toBe(focusedLabel)
  console.log('Keyboard crosshair passed: Left, Home, Right and Escape move, announce and clear it; it stays on the oldest sample as the window moves; Tab away clears it; the name held still while focused.')

  step = 'pointer crosshair'
  const bounds = await canvas.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await expect(tip).toBeVisible()
  await expect(tip).toHaveText(/^0:0\d\sago · \d+(\.\d+)?\s%$/)
  // The tooltip sits inside the plot, so it covers nothing outside the chart.
  const tipBox = await tip.boundingBox()
  expect(tipBox.y).toBeGreaterThanOrEqual(bounds.y)
  expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(bounds.y + bounds.height)
  expect(tipBox.x).toBeGreaterThanOrEqual(bounds.x)
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
  // A pointer held still keeps the crosshair under it while ticks move the window: the tooltip names a sample as old as
  // the place under the pointer, near either edge, and does not go when the sample it showed scrolls out.
  const ageOf = text => text.startsWith('now') ? 0 : Number.parseInt(/^0:(\d\d)\s+ago/.exec(text)?.[1] ?? 'NaN', 10)
  for (const [fraction, place] of [[0.85, 'right'], [0.12, 'left']]) {
    await page.mouse.move(bounds.x + bounds.width * fraction, bounds.y + bounds.height / 2)
    await expect(tip).toBeVisible()
    const held = ageOf(await tip.textContent())
    expect(held, place).not.toBeNaN()
    for (let sample = 0; sample < 6; sample++) {
      await sleep(500)
      await expect(tip, place).toBeVisible()
      expect(Math.abs(ageOf(await tip.textContent()) - held), `${place}, after ${(sample + 1) * 500} ms`).toBeLessThanOrEqual(1)
    }
  }
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height + 60)
  await expect(tip).toBeHidden()
  // A tooltip wider than a narrow card's plot wraps inside it, whichever side of the crosshair has room.
  const narrow = await live('mountChart', id, { series: [1, 2], unit: 'perSecond', labels: 'axes', spanMs: 10_000, width: 200, height: 110 })
  const narrowBox = page.locator(`[data-chart-test="${narrow}"]`), narrowCanvas = narrowBox.locator('canvas'), narrowTip = chartTooltip(narrowBox)
  await expect.poll(async () => (await chart(narrow))?.pixels.colors['charts.orange'] ?? 0).toBeGreaterThan(5)
  const narrowBounds = await narrowCanvas.boundingBox()
  for (const fraction of [0.3, 0.5, 0.8, 0.98]) {
    await page.mouse.move(narrowBounds.x + narrowBounds.width * fraction, narrowBounds.y + narrowBounds.height / 2)
    await expect(narrowTip).toHaveText(/^(now|\d:\d\d\s+ago) · Wave\s.* · Rate\s.*$/)
    const narrowTipBox = await narrowTip.boundingBox()
    expect(narrowTipBox.x, `left at ${fraction}`).toBeGreaterThanOrEqual(narrowBounds.x)
    expect(narrowTipBox.x + narrowTipBox.width, `right at ${fraction}`).toBeLessThanOrEqual(narrowBounds.x + narrowBounds.width + 1)
    // Its text wraps inside the box rather than running out of it.
    expect(await narrowTip.evaluate(element => element.scrollWidth - element.clientWidth), `text at ${fraction}`).toBeLessThanOrEqual(1)
  }
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height + 60)
  await live('unmountChart', narrow)
  console.log('Pointer crosshair passed: the tooltip follows the pointer, stays under a pointer held still as the window moves, stays inside a narrow plot, and goes when the pointer leaves.')

  step = 'table'
  // View as table is the results grid (LocalGrid, card) in the plot's place: a new table each tick, its selection kept.
  await box.getByRole('button', { name: 'View as table', exact: true }).click()
  await expect(box.getByRole('button', { name: 'View as table', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const table = chartTable(box), caption = chartTableCaption(box)
  await expect(caption).toHaveText(/^Synthetic metrics: \d+ samples, newest first$/)
  await expect(table).toHaveAttribute('aria-label', /^Synthetic metrics table, \d+ rows?, 2 columns$/)
  await expect(table.locator(gridPart.columnHeader).filter({ visible: true })).toHaveText(['Time', 'Wave'])
  await expect(gridCell(table, 0, 0)).toHaveText('now')
  await expect(canvas).toBeHidden()
  // Ctrl+A before the ticks: the selection lasts through the tables each tick swaps in.
  await gridCell(table, 0, 0).click()
  await page.keyboard.press('Control+A')
  // A tick swaps its table into the same view rather than building another, so a drag or column resize under way goes on:
  // the view's drawn cells stay in the page.
  const keptCell = await gridCell(table, 0, 1).elementHandle()
  // The grid takes the plot's place in the fixed box, as many rows tall as fit, and stays filled tick after tick.
  const boxBounds = await box.boundingBox()
  const values = new Set()
  for (let sample = 0; sample < 10; sample++) {
    const seen = await box.evaluate((element, [wrapSelector, captionSelector, frameSelector, newest]) => {
      const wrap = element.querySelector(wrapSelector).getBoundingClientRect(), frame = element.querySelector(frameSelector).getBoundingClientRect()
      return { label: element.querySelector('[role="grid"]').getAttribute('aria-label'), caption: element.querySelector(captionSelector).textContent, value: element.querySelector(newest)?.textContent, bottom: wrap.bottom, frameBottom: frame.bottom }
    }, [part.chartTableWrap, part.chartTableCaption, part.localGrid, gridCellSelector(0, 1)])
    expect(seen.caption).toMatch(/^Synthetic metrics: (\d+ of )?\d+ samples, newest first$/)
    const rows = Number(/, (\d+) rows?,/.exec(seen.label)?.[1])
    expect(rows).toBeGreaterThan(5)
    expect(rows).toBeLessThanOrEqual(120)
    values.add(seen.value)
    expect(seen.bottom).toBeLessThanOrEqual(boxBounds.y + boxBounds.height + 1)
    expect(seen.frameBottom).toBeLessThanOrEqual(seen.bottom + 1)
    // No more than a row's height (and a scroll bar's) left empty under it once the samples outnumber what fits.
    expect(seen.bottom - seen.frameBottom).toBeLessThan(20 + 20)
    await sleep(150)
  }
  // The newest value follows the ticks (the synthetic wave moves on each sample).
  if (values.size < 2) await expect.poll(() => table.locator(gridCellSelector(0, 1)).textContent(), { timeout: 10_000 }).not.toBe([...values][0])
  expect(await keptCell.evaluate(element => element.isConnected), 'the same view after the ticks').toBe(true)
  // The caption takes one line across the plot's width.
  expect(await caption.evaluate(element => element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight))).toBeLessThan(1.5)
  // Ctrl+Shift+C copies the kept selection of the latest table, with headers, as a results grid copies.
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await page.keyboard.press('Control+Shift+C')
  const eol = process.platform === 'win32' ? '\r\n' : '\n'
  await expect.poll(async () => (await clipboard()).split(eol).slice(0, 2).join('|')).toMatch(/^Time\tWave\|now\t\d/)
  expect((await clipboard()).split(eol).length).toBeGreaterThan(6)
  // Shift+Tab from the toggle reaches the grid.
  await box.getByRole('button', { name: 'View as table', exact: true }).focus()
  await page.keyboard.press('Shift+Tab')
  await expect(table).toBeFocused()
  await box.getByRole('button', { name: 'View as table', exact: true }).click()
  await expect(table).toHaveCount(0)
  await expect(canvas).toBeVisible()
  console.log('Table passed: the window\'s samples, newest first, as a results grid in the plot\'s place, a new table each tick with its selection kept, copied with headers.')

  step = 'table rows'
  const capped = await live('mountChart', id, { series: [1], max: 100, spanMs: 10_000, width: 360, height: 200, tableShown: true, tableRows: 7 })
  const cappedBox = page.locator(`[data-chart-test="${capped}"]`)
  await expect(chartTableCaption(cappedBox)).toHaveText(/^Synthetic metrics: 7 of \d+ samples, newest first$/)
  await expect(chartTable(cappedBox)).toHaveAttribute('aria-label', 'Synthetic metrics table, 7 rows, 2 columns')
  await live('unmountChart', capped)
  console.log('Table rows passed: tableRows caps the table.')

  step = 'table from outside'
  // A document that offers View as table as a catalogue command hides the button and drives the table itself.
  const driven = await live('mountChart', id, { series: [1], max: 100, spanMs: 10_000, width: 360, height: 160, tableToggle: false })
  const drivenBox = page.locator(`[data-chart-test="${driven}"]`)
  await expect(drivenBox.locator('canvas')).toBeVisible()
  await expect(drivenBox.getByRole('button')).toHaveCount(0)
  await live('updateChart', driven, { tableShown: true })
  await expect(chartTableCaption(drivenBox)).toHaveText(/^Synthetic metrics: (\d+ of )?\d+ samples, newest first$/)
  await expect(drivenBox.locator('canvas')).toBeHidden()
  await live('updateChart', driven, { tableShown: false })
  await expect(chartTable(drivenBox)).toHaveCount(0)
  console.log('Table from outside passed: no button, and the table follows the tableShown prop.')

  step = 'props'
  // Changing a mounted chart's series, window and title redraws it and renames it.
  await live('updateChart', driven, { series: [1, 2], unit: 'count', max: undefined, spanMs: 20_000, title: 'Renamed metrics' })
  await expect(chartLegend(drivenBox)).toHaveAttribute('aria-label', 'Renamed metrics series')
  await expect(chartLegend(drivenBox).getByRole('listitem')).toHaveText(['Wave', 'Rate'])
  await expect.poll(async () => (await chart(driven)).label, labelSettles).toMatch(/^Renamed metrics: Wave .*; Rate .* over the last 20 seconds$/)
  await expect.poll(async () => (await chart(driven)).pixels.colors['charts.orange']).toBeGreaterThan(10)
  await live('unmountChart', driven)
  console.log('Props passed: new series, window and title reached the mounted chart.')

  step = 'legend'
  const both = await live('mountChart', id, { series: [1, 2], unit: 'count', spanMs: 10_000, width: 360, height: 160 })
  const legend = chartLegend(page.locator(`[data-chart-test="${both}"]`))
  await expect(legend.getByRole('listitem')).toHaveText(['Wave', 'Rate'])
  await expect.poll(async () => { const pixels = (await chart(both)).pixels.colors; return pixels['charts.blue'] > 10 && pixels['charts.orange'] > 10 }).toBe(true)
  await live('unmountChart', both)
  console.log('Legend passed: two series, two colors, each named.')

  step = 'stale'
  // Paused, the view collects nothing; within a few seconds its newest sample is no longer "now".
  await live('setUserPaused', id, true)
  await expect.poll(async () => (await chart(key)).label, labelSettles).toMatch(/ from \d\d:\d\d:\d\d to \d\d:\d\d:\d\d$/)
  await box.getByRole('button', { name: 'View as table', exact: true }).click()
  await expect(gridCell(table, 0, 0)).toHaveText(/^\d\d:\d\d:\d\d$/)
  await live('setUserPaused', id, false)
  await expect(gridCell(table, 0, 0)).toHaveText('now')
  await box.getByRole('button', { name: 'View as table', exact: true }).click()
  await expect.poll(async () => (await chart(key)).label, labelSettles).toMatch(/ over the last 10 seconds$/)
  console.log('Stale passed: paused, the chart names its window by the clock, and says "now" again once samples arrive.')

  step = 'tile'
  // A sparkline in a metric tile's chart slot: drawn on the tile's surface, its end marker ringed in the tile's color.
  const tiled = await live('mountChart', id, { series: [1], style: 'area', max: 100, variant: 'sparkline', surface: 'tile.background', tile: 'Wave', width: 220, height: 140 })
  const tileBox = page.locator(`[data-chart-test="${tiled}"]`)
  await expect(tileBox.getByRole('group', { name: 'Wave: no data yet', exact: true })).toBeVisible()
  await expect.poll(async () => { const pixels = (await chart(tiled)).pixels.colors; return pixels['charts.blue'] > 10 && pixels['tile.background'] > 0 }).toBe(true)
  expect((await tileBox.locator('canvas').boundingBox()).height).toBe(32)
  // A sparkline has no keys and no focus ring, so it takes no focus: a click on it does what a click on the tile's caption
  // does, and never leaves the focus on an invisible canvas.
  const spark = tileBox.locator('canvas')
  expect(await spark.getAttribute('tabindex')).toBeNull()
  const focusAfterClick = async target => {
    await box.getByRole('button', { name: 'View as table', exact: true }).focus()
    await target.click()
    return page.evaluate(() => { const at = document.activeElement; return at ? `${at.tagName} ${at.getAttribute('class') ?? ''}` : '' })
  }
  const afterSpark = await focusAfterClick(spark)
  await expect(spark).not.toBeFocused()
  expect(afterSpark).toBe(await focusAfterClick(tileBox.getByText('Wave', { exact: true })))
  await live('unmountChart', tiled)
  console.log('Tile passed: a sparkline in the tile\'s chart slot, 32 px tall, on the tile\'s surface, taking no focus.')

  step = 'theme'
  const darkBlue = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--varia-charts-blue').trim())
  await menu('theme.mode.light')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--varia-charts-blue').trim())).not.toBe(darkBlue)
  // The pixel count reads the active theme's charts.blue, so a chart still in the dark one counts nothing.
  await expect.poll(async () => (await chart(key)).pixels.colors['charts.blue']).toBeGreaterThan(20)
  await page.screenshot({ path: resolve('artifacts', 'chart-light.png') })
  console.log('Theme passed: the chart redrew in Light\'s chart colors.')

  step = 'forced colors'
  // In the Dark theme, whose color-scheme the canvas would otherwise read the system color keywords by.
  await menu('theme.mode.dark')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--varia-charts-blue').trim())).toBe(darkBlue)
  await expect.poll(async () => (await chart(key)).pixels.colors['charts.blue']).toBeGreaterThan(20)
  const before = (await chart(key)).draws
  // Night sky (dark), then Desert (light) with forced colors still on, as Windows switches contrast themes.
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' })
  await expect.poll(async () => (await chart(key)).draws).toBeGreaterThan(before)
  await expect.poll(async () => (await chart(key)).pixels.colors['charts.blue']).toBe(0)
  expect((await chart(key)).pixels.drawn).toBeGreaterThan(100)
  // The series and the labels stand out from the box behind them, in whichever palette is on.
  await expect.poll(async () => (await chart(key)).pixels.contrasting, { message: 'forced dark' }).toBeGreaterThan(100)
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'light' })
  await expect.poll(async () => (await chart(key)).pixels.contrasting, { message: 'forced light after dark' }).toBeGreaterThan(100)
  await page.emulateMedia({ forcedColors: 'none', colorScheme: 'light' })
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' })
  await expect.poll(async () => (await chart(key)).pixels.contrasting, { message: 'forced dark after a forced light session' }).toBeGreaterThan(100)
  // The legend shows each series' dash in the order the canvas gives them.
  const pair = await live('mountChart', id, { series: [1, 2], unit: 'count', spanMs: 10_000, width: 360, height: 160 })
  const swatches = chartSwatchLines(page.locator(`[data-chart-test="${pair}"]`))
  await expect(swatches).toHaveCount(2)
  expect(await swatches.nth(0).getAttribute('stroke-dasharray')).toBeNull()
  await expect(swatches.nth(1)).toHaveAttribute('stroke-dasharray', '6 3')
  await page.screenshot({ path: resolve('artifacts', 'chart-forced.png') })
  await live('unmountChart', pair)
  await page.emulateMedia({ forcedColors: 'none', colorScheme: 'no-preference' })
  await expect.poll(async () => (await chart(key)).pixels.colors['charts.blue']).toBeGreaterThan(20)
  console.log('Forced colors passed: the chart drew in system colors and went back to the theme after.')

  await live('unmountChart', key)
  await expect(box).toHaveCount(0)
  await live('dispose', id)
  expect(failures).toEqual([])
  console.log('Live charts passed.')
} finally {
  clearTimeout(watchdog)
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await within(app.close(), 15000, () => app.process()?.kill()).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
