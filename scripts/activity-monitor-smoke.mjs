// The Activity Monitor document in the real app on the fake backend's activity source (tests/fixtures/backend.mjs,
// workbench mode): with no server connected it opens the Connect dialog and then the monitor; it opens from Object
// Explorer's server menu, the View menu, the palette and the toolbar, one tab per connection;
// its tiles fill after two samples and two charts are open (all eight may be); Sessions shows the sessions probe's rows in the results grid and its filters, funnels and sort reach the backend; Blocking and Active Expensive Queries show its other tables; Resource Waits and Data File I/O show the resources probe's tables and their chips reach the backend; and a failed sample keeps them and says why; Pause stops sampling and Resume starts it again; the
// interval and the chart window reach the live layer; a tab switch pauses it while hidden and keeps its choices; the
// panes, Split View and F6 work; the header, tiles and panes fit common window sizes; a login without server state gets
// the permission message and its GRANT statement; a lost backend reports it and
// Reconnect brings it back; Shift+Esc and closing the tab end its subscription. Screenshots in Dark and Light. With
// VARIA_TEST_SQL_SERVER set, a second run on the Release backend opens the monitor on that server: the real overview
// probe fills the tiles, and Pause stops it.
import { electron, expect, within } from './fixtures/smoke.mjs'
import {
  activityBanner, backendReady, bannerGlyph, documentActions, documentContent, documentFrame, documentTabs, documentTitle, explorerTree, gridCellSelector, gridPart, livePill, staleBadge, tileCaptions, toolbarButton
} from './fixtures/ui.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'activity-profile-'))
const control = await mkdtemp(resolve('artifacts', 'activity-control-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
let step = 'launch'
let app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error(`Activity Monitor suite timed out during: ${step}.`); app.process()?.kill(); process.exit(1) }, 420_000)
let page = await app.firstWindow()
page.setDefaultTimeout(15000)
/** Resizes the window itself (not an emulated viewport), so container queries and the panes' measure see real sizes. */
async function size(width, height) {
  const display = await app.evaluate(({ BrowserWindow, screen }, [w, h]) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(w, h)
    return screen.getDisplayMatching(window.getBounds()).size
  }, [width, height])
  const inner = () => page.evaluate(() => [window.innerWidth, window.innerHeight])
  if (width < display.width && height < display.height) return expect.poll(inner).toEqual([width, height])
  // X11 keeps a window inside its screen (Linux CI's 1600 x 1000 xvfb screen left 1599 x 999), while Windows lets it grow
  // past its 1024 x 768 display: a size the display cannot hold settles at most a few pixels inside it.
  const near = (got, wanted, limit) => got <= wanted && got >= Math.min(wanted, limit) - 8
  await expect.poll(async () => { const [w, h] = await inner(); return near(w, width, display.width) && near(h, height, display.height) }).toBe(true)
}
await size(1500, 960)
const failures = []
page.on('pageerror', error => failures.push(error.message))

const live = (method, ...args) => page.evaluate(([name, values]) => window.__variaLive[name](...values), [method, args])
const handles = async () => (await live('snapshot')).handles.filter(handle => handle.source === 'activity')
const frames = id => live('frames', id)
const viewOf = id => live('snapshot', id)
const calls = async method => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.method === method)
const backendState = () => app.evaluate(() => globalThis.__variaTest.state())
const sleep = ms => new Promise(done => setTimeout(done, ms))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const queryTabs = () => documentTabs(page).getByRole('tab')
// Only the active document renders, so the one frame by that name is the shown monitor's.
const monitor = () => documentFrame(page, 'Activity Monitor')
const charts = () => monitor().getByRole('region', { name: 'Charts', exact: true })
const chartTitles = () => charts().getByRole('heading', { level: 2 })
const tile = caption => monitor().getByRole('group', { name: new RegExp('^' + caption.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + ':') })
async function menu(id) {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId)
    if (!item) throw new Error('Menu item missing: ' + itemId)
    item.click()
  }, id)
}
async function connect(server, password = 'activity-smoke-password', login = 'reader') {
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  if (!await dialog.isVisible()) await toolbarButton(page, 'Connect').click()
  await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('Login', { exact: true }).fill(login)
  await dialog.getByLabel('Password', { exact: true }).fill(password)
  await dialog.getByLabel('Trust server certificate', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}
/** The view's ticks stay where they are for `ms`: nothing is sampled. */
async function stays(id, ms = 800) {
  const before = (await frames(id)).ticks
  await sleep(ms)
  expect((await frames(id)).ticks).toBe(before)
}

/** Where an element sits on screen, or undefined when it is not drawn. */
const box = locator => locator.boundingBox()
/** Eight open charts: the rows reserved match the columns the grid resolved, and each plot keeps a usable height. */
async function expectAllCharts(where) {
  await expect.poll(() => charts().evaluate(element => {
    const columns = getComputedStyle(element).gridTemplateColumns.split(' ').filter(track => parseFloat(track) > 0).length
    return Number(element.style.getPropertyValue('--activity-chart-rows')) === Math.ceil(8 / columns) && columns > 0
  }), `chart rows ${where}`).toBe(true)
  await expect.poll(async () => Math.min(...await Promise.all((await charts().locator('canvas').all()).map(async canvas => (await box(canvas)).height))), `smallest of eight charts ${where}`).toBeGreaterThanOrEqual(60)
}
/** The header's pieces at the window's size: the title cut or not, whether its state reaches into the controls on their row
 *  (a narrow document puts them on a row of their own), and whether the controls pass the document's right edge. */
async function header() {
  const [title, pill, badge, actions] = await Promise.all([box(documentTitle(monitor())), box(livePill(monitor())), box(staleBadge(monitor())), box(documentActions(monitor(), 'Activity Monitor'))])
  const right = await documentContent(monitor()).evaluate(element => Math.min(element.getBoundingClientRect().right, window.innerWidth))
  return {
    titleCut: await documentTitle(monitor()).evaluate(element => element.scrollWidth > element.clientWidth + 1),
    titleWidth: Math.round(title.width), clipped: Math.round(actions.x + actions.width - right),
    overlap: actions.y >= title.y + title.height ? -1 : Math.round(Math.max(title.x + title.width, pill.x + pill.width, badge.x + badge.width) - actions.x)
  }
}
/** Resizes the window and waits for the dock to lay the monitor out at the new width (it reaches the window's right edge). */
async function fit(width, height) {
  await size(width, height)
  await expect.poll(() => monitor().evaluate(element => Math.round(element.getBoundingClientRect().right) === window.innerWidth)).toBe(true)
}
/** The tiles' captions that are cut (three lines at most, each in its tile). */
const cutCaptions = () => tileCaptions(monitor()).evaluateAll(elements => elements.filter(element => element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1).map(element => element.textContent))
/** The tiles' captions whose text reaches under their tile's chart button. */
async function captionsUnderButtons() {
  const under = []
  for (const caption of await tileCaptions(monitor()).all()) {
    const name = await caption.textContent()
    const button = await box(monitor().getByRole('button', { name: `${name} chart`, exact: true }))
    const lines = await caption.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return [...range.getClientRects()].map(({ left, top, right, bottom }) => ({ left, top, right, bottom })) })
    if (lines.some(line => line.right > button.x && line.left < button.x + button.width && line.bottom > button.y + 1 && line.top < button.y + button.height - 1)) under.push(name)
  }
  return under
}
/** Draws the UI in `family`, or in the theme's own fonts again without one. */
const uiFont = family => page.evaluate(family => family ? document.documentElement.style.setProperty('--varia-font-ui', family) : document.documentElement.style.removeProperty('--varia-font-ui'), family)
/** Linux draws the UI in DejaVu Sans when none of the theme's fonts is installed (CI's runner); Verdana, which Windows
 *  and macOS have, matches its widths within about 2 %, so this stack measures that wider face on every platform. */
const wideFont = "Verdana, 'DejaVu Sans', sans-serif"
/** How far a banner's glyph sits from its box's left and top edges. */
async function glyphInset() {
  const banner = activityBanner(monitor())
  const [outer, glyph] = await Promise.all([box(banner), box(bannerGlyph(banner))])
  return [Math.round(glyph.x - outer.x), Math.round(glyph.y - outer.y)]
}

try {
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })

  step = 'open without a connection'
  // With no server connected, the monitor asks for one, then opens on it: no query tab comes with it.
  const before = await queryTabs().allTextContents()
  await menu('activity.open')
  // The monitor opens Connect itself; connect() would otherwise press the toolbar's Connect under its arriving backdrop.
  await expect(page.getByRole('dialog', { name: 'Connect', exact: true })).toBeVisible()
  await connect('activity-server')
  await expect(queryTabs().filter({ hasText: 'activity-server - Activity Monitor' })).toHaveCount(1)
  expect((await queryTabs().allTextContents()).filter(name => !name.includes('Activity Monitor'))).toEqual(before)
  await expect.poll(async () => (await handles()).length).toBe(1)
  await page.keyboard.press(mod + '+W')
  await expect(queryTabs().filter({ hasText: 'Activity Monitor' })).toHaveCount(0)
  await expect.poll(async () => (await handles()).length).toBe(0)
  console.log('Opening without a connection passed: the Connect dialog, then the monitor on the new connection and no query tab.')

  step = 'open from Object Explorer'
  const serverRow = explorerTree(page).getByRole('treeitem').filter({ hasText: 'activity-server' }).first()
  await serverRow.click({ button: 'right' })
  await page.getByRole('menu', { name: 'Object Explorer', exact: true }).getByRole('menuitem', { name: 'Activity Monitor', exact: true }).click()
  await expect(queryTabs().filter({ hasText: 'activity-server - Activity Monitor' })).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Activity Monitor', exact: true })).toBeVisible()
  // Focus goes to the monitor, so its keys (F5, F6, Shift+Esc) work at once.
  await expect(monitor().getByRole('button', { name: '% Processor Time chart', exact: true })).toBeFocused()
  await expect.poll(async () => (await handles()).length).toBe(1)
  const [{ id }] = await handles()
  const subscribed = await calls('live.subscribe')
  expect(subscribed.at(-1).params).toMatchObject({
    source: 'activity',
    args: { filters: [{ table: 'sessions', view: 'all', showSystem: false, showVaria: false }, { table: 'waitCategories', hideBenign: true }, { table: 'waitTypes', hideBenign: true }, { table: 'files', fileView: 'all', latencyWarningMs: 20, latencyErrorMs: 50 }] },
    probes: [{ probe: 'activity.overview', intervalMs: 2000 }, { probe: 'activity.sessions', intervalMs: 2000 }, { probe: 'activity.resources', intervalMs: 5000 }, { probe: 'activity.queries', intervalMs: 30000, paused: true }]
  })
  // Sessions and Resource Waits show on first open, so their probes run from the start.
  expect(subscribed.at(-1).params.probes.slice(0, 3).map(probe => probe.paused)).toEqual([undefined, undefined, undefined])
  // The View menu and the palette open the same monitor: one per connection.
  await queryTabs().filter({ hasText: 'SQLQuery1' }).click()
  await expect(queryTabs().filter({ hasText: 'SQLQuery1' })).toHaveAttribute('aria-selected', 'true')
  await menu('activity.open')
  // Main sends the menu's command to the page, which can take F1 first (input outranks other tasks on a busy page); the
  // command would then close the palette, as any command run from elsewhere does. The monitor coming forward shows it ran.
  await expect(queryTabs().filter({ hasText: 'activity-server - Activity Monitor' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('F1')
  // Typing before the palette has focus loses the keys (a Windows CI run found no option).
  await expect(page.getByRole('combobox', { name: 'Command Palette', exact: true })).toBeFocused()
  // The monitor focuses itself once drawn, and the hidden window's throttled frame can come after F1 opened the palette,
  // which keeps focus (moving it closed the palette). A page timer set now runs after the monitor's.
  await page.evaluate(() => new Promise(done => setTimeout(done, 100)))
  await expect(page.getByRole('combobox', { name: 'Command Palette', exact: true })).toBeFocused()
  await page.keyboard.type('Activity Monitor')
  await expect(page.getByRole('option', { name: /^Tools: Activity Monitor/ }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(queryTabs().filter({ hasText: 'Activity Monitor' })).toHaveCount(1)
  await toolbarButton(page, 'Activity Monitor').click()
  await expect(queryTabs().filter({ hasText: 'Activity Monitor' })).toHaveCount(1)
  expect(await handles()).toHaveLength(1)
  console.log('Opening passed: from the server menu, View, the palette and the toolbar, one monitor and one subscription per connection.')

  step = 'tiles'
  // Rates have a value from the second sample.
  await expect(tile('% Processor Time')).toHaveAccessibleName(/^% Processor Time: \d+(\.\d)? %/, { timeout: 10000 })
  await expect(tile('Waiting Tasks')).toHaveAccessibleName(/^Waiting Tasks: [\d.]+ tasks/)
  await expect(tile('Database I/O')).toHaveAccessibleName(/^Database I\/O: [\d.]+ MB\/s, Read latency 4 ms · Write latency 2 ms/)
  await expect(tile('Active Requests')).toHaveAccessibleName(/^Active Requests: 12, User sessions 87 · Logins 3\/s/)
  await expect(monitor().getByRole('region', { name: 'Server overview', exact: true }).getByRole('group')).toHaveCount(8)
  // SSMS's first two charts are open, and only they.
  await expect(chartTitles()).toHaveCount(2)
  await expect(chartTitles()).toHaveText(['% Processor Time', 'Waiting Tasks'])
  await expect(monitor().getByRole('button', { name: 'Waiting Tasks chart', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // Every chart may be open at once: each keeps a usable plot, and the panes keep their height below them.
  const captions = ['% Processor Time', 'Waiting Tasks', 'Database I/O', 'Batch Requests/sec', 'Blocked Sessions', 'Active Requests', 'CPU Pressure', 'Memory Grants Pending']
  for (const caption of captions.slice(2)) await monitor().getByRole('button', { name: `${caption} chart`, exact: true }).click()
  await expect(chartTitles()).toHaveText(captions)
  await expectAllCharts('at 1500 x 960')
  for (const caption of [captions[0], ...captions.slice(3)]) await monitor().getByRole('button', { name: `${caption} chart`, exact: true }).click()
  await expect(chartTitles()).toHaveText(['Waiting Tasks', 'Database I/O'])
  await expect(monitor().getByRole('button', { name: '% Processor Time chart', exact: true })).toHaveAttribute('aria-pressed', 'false')
  // Blocking: the tile and the Blocking tab's badge say so, and the tile is outlined once the wait is long.
  await writeFile(join(control, 'activity-blocked'), '')
  await expect(tile('Blocked Sessions')).toHaveAccessibleName(/^Blocked Sessions: 2, Longest block 41,200 ms, above its critical threshold$/)
  await expect(monitor().getByRole('tab', { name: /^Blocking 2/ }).first()).toBeVisible()
  await rm(join(control, 'activity-blocked'))
  await expect(tile('Blocked Sessions')).toHaveAccessibleName(/^Blocked Sessions: 0/)
  // The fact line names what the connection reported.
  await expect(monitor().getByRole('definition').first()).toHaveText('activity-server')
  // A failed sample: the tiles keep their last values, a note says why, and it goes once a sample succeeds.
  const failed = monitor().getByText('The overview waited too long for a lock and will try again.', { exact: true })
  await writeFile(join(control, 'activity-failing'), '')
  await expect(failed).toBeVisible()
  const failingInset = await glyphInset()
  await expect(tile('Active Requests')).toHaveAccessibleName(/^Active Requests: 12/)
  await rm(join(control, 'activity-failing'))
  await expect(failed).toHaveCount(0)
  await page.screenshot({ path: join('artifacts', 'activity-monitor-dark.png') })
  console.log('Tiles passed: values with units after two samples, two charts open, all eight open at once, and blocking tints its tile.')

  step = 'pause'
  await monitor().getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(monitor().getByRole('button', { name: 'Pause', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(livePill(monitor())).toHaveText('Paused')
  await expect.poll(async () => (await viewOf(id)).status).toBe('paused')
  await stays(id)
  // Refresh Now is not offered while paused.
  await expect(monitor().getByRole('button', { name: 'Refresh Now', exact: true })).toBeDisabled()
  await monitor().getByRole('button', { name: 'Pause', exact: true }).click()
  const resumed = (await frames(id)).ticks
  await expect.poll(async () => (await frames(id)).ticks).toBeGreaterThan(resumed + 1)
  await expect(livePill(monitor())).toHaveText('Live · every 2 s')
  expect((await calls('live.update')).map(call => call.params.paused).filter(paused => paused !== undefined)).toEqual([true, false])
  console.log('Pause passed: no samples while paused, Refresh Now disabled, Resume samples again.')

  step = 'interval and window'
  await monitor().getByLabel('Refresh interval', { exact: true }).selectOption('1')
  await expect.poll(async () => (await calls('live.update')).some(call => call.params.probes?.some(probe => probe.probe === 'activity.overview' && probe.intervalMs === 1000))).toBe(true)
  await expect(livePill(monitor())).toHaveText('Live · every 1 s')
  // The chart window is one choice, a picker as the interval is.
  await monitor().getByLabel('Chart window', { exact: true }).selectOption({ label: 'Last 5 min' })
  await expect(monitor().getByLabel('Chart window', { exact: true })).toHaveValue('5')
  await expect(charts().locator('canvas').first()).toHaveAttribute('aria-label', /over the last 5 minutes$/)
  // F5 in the monitor refreshes it.
  await monitor().getByRole('button', { name: 'Waiting Tasks chart', exact: true }).focus()
  await page.keyboard.press('F5')
  await expect.poll(async () => (await calls('live.update')).some(call => call.params.refresh === true)).toBe(true)
  console.log('Interval and window passed: 1 s reaches the overview probe, the charts show 5 minutes, and F5 refreshes.')

  step = 'tab switch'
  await page.keyboard.press(mod + '+N')
  await expect.poll(async () => (await viewOf(id)).status, { timeout: 6000 }).toBe('paused')
  expect((await viewOf(id)).pausedBy).toBe('hidden')
  await stays(id)
  await queryTabs().filter({ hasText: 'Activity Monitor' }).click()
  await expect.poll(async () => (await viewOf(id)).status).toBe('live')
  // The monitor kept its choices while another tab showed.
  await expect(chartTitles()).toHaveText(['Waiting Tasks', 'Database I/O'])
  await expect(monitor().getByLabel('Refresh interval', { exact: true })).toHaveValue('1')
  await expect(monitor().getByLabel('Chart window', { exact: true })).toHaveValue('5')
  console.log('Tab switch passed: hidden, the monitor paused; shown again, it resumed with its charts, interval and window.')

  step = 'sessions'
  // Sessions (SSMS's Processes) draws the sessions probe's rows in the results grid; system sessions and Varia's pools are
  // hidden by default.
  const sessionsGrid = monitor().getByRole('grid', { name: /^Sessions/ })
  const filters = monitor().getByRole('toolbar', { name: 'Sessions filters', exact: true })
  const columnHeader = name => sessionsGrid.locator(gridPart.columnHeader).filter({ hasText: new RegExp(`^${name}$`) })
  const loginAt = row => sessionsGrid.locator(gridCellSelector(row, 2))
  await expect(sessionsGrid).toBeVisible()
  await expect(monitor().getByText(/^3 sessions · system sessions and Varia's own hidden$/)).toBeVisible()
  await expect(sessionsGrid.getByRole('gridcell', { name: 'svc_reporting', exact: true })).toBeVisible()
  // The view chip goes to the backend as args: Blocked leaves the session waiting on 57.
  await filters.getByRole('button', { name: 'Blocked', exact: true }).click()
  await expect(filters.getByRole('button', { name: 'Blocked', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(monitor().getByText(/^1 session · 1 filter on/)).toBeVisible()
  await filters.getByRole('button', { name: 'Blocked', exact: true }).click()
  // The Show chips are chips too: Varia's own shows the Object Explorer pool session.
  const showVaria = filters.getByRole('group', { name: 'Show', exact: true }).getByRole('button', { name: "Varia's own", exact: true })
  await showVaria.click()
  await expect(showVaria).toHaveAttribute('aria-pressed', 'true')
  await expect(monitor().getByText(/^4 sessions · system sessions hidden$/)).toBeVisible()
  await showVaria.click()
  // The filter box matches the text columns once typing settles.
  await filters.getByRole('searchbox', { name: 'Filter sessions', exact: true }).fill('billing')
  await expect(monitor().getByText(/^1 session · 1 filter on/)).toBeVisible()
  await expect(sessionsGrid.getByRole('gridcell', { name: 'app_billing', exact: true })).toBeVisible()
  await filters.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(filters.getByRole('searchbox', { name: 'Filter sessions', exact: true })).toHaveValue('')
  // A facet column's header has the results grid's funnel: its popover lists the values with their counts from the
  // facets, and OK sends the ticked values to the backend as the source's args. A column the source cannot filter has none.
  await expect(monitor().getByText(/^3 sessions/)).toBeVisible()
  await columnHeader('Session ID').hover()
  await expect(columnHeader('Session ID').locator(gridPart.funnelButton)).toBeHidden()
  await columnHeader('Database').hover()
  await columnHeader('Database').locator(gridPart.funnelButton).click()
  const funnel = page.getByRole('dialog', { name: 'Filter Database', exact: true })
  await expect(funnel.getByRole('checkbox', { name: 'SalesDb (2)', exact: true })).toBeChecked()
  await expect(funnel.getByRole('searchbox', { name: 'Search values', exact: true })).toBeFocused()
  await page.screenshot({ path: join('artifacts', 'activity-monitor-sessions.png') })
  await funnel.getByRole('button', { name: 'Select none', exact: true }).click()
  await funnel.getByRole('checkbox', { name: 'BillingDb (1)', exact: true }).check()
  await funnel.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(funnel).toHaveCount(0)
  await expect(monitor().getByText(/^1 session · 1 filter on/)).toBeVisible()
  await expect(columnHeader('Database').locator(gridPart.funnelOn)).toHaveCount(1)
  await expect.poll(async () => (await calls('live.update')).some(call => JSON.stringify(call.params.args ?? {}).includes('"column":"database","values":["BillingDb"]'))).toBe(true)
  // Alt+Down (output.filterColumnValues) opens the active column's funnel, as in a results grid; Escape closes it and gives
  // the grid the focus back.
  await sessionsGrid.getByRole('gridcell', { name: 'BillingDb', exact: true }).click()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(funnel.getByRole('checkbox', { name: 'BillingDb (1)', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(funnel).toHaveCount(0)
  await expect(sessionsGrid).toBeFocused()
  // The grid's keys are Query Output's catalogue commands (outputGridFocus): Find in Results (Ctrl+F) moves to the pane's
  // filter box, since a live view has no Find of its own.
  await page.keyboard.press(`${mod}+F`)
  await expect(filters.getByRole('searchbox', { name: 'Filter sessions', exact: true })).toBeFocused()
  // A chosen value the facets no longer list (Blocked leaves no BillingDb row) stays listed, ticked, so it can be taken
  // off; a press outside closes the popover unchanged.
  await filters.getByRole('button', { name: 'Blocked', exact: true }).click()
  await expect(monitor().getByText(/^0 sessions · 2 filters on/)).toBeVisible()
  await columnHeader('Database').hover()
  await columnHeader('Database').locator(gridPart.funnelButton).click()
  await expect(funnel.getByRole('checkbox', { name: 'BillingDb (0)', exact: true })).toBeChecked()
  await monitor().getByText(/^0 sessions · 2 filters on/).click()
  await expect(funnel).toHaveCount(0)
  await filters.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(monitor().getByText(/^3 sessions/)).toBeVisible()
  await expect(columnHeader('Database').locator(gridPart.funnelOn)).toHaveCount(0)
  // Unticking one value of several leaves just that one out (an excluding filter), so values the facets never listed pass.
  await columnHeader('Login').hover()
  await columnHeader('Login').locator(gridPart.funnelButton).click()
  const loginFunnel = page.getByRole('dialog', { name: 'Filter Login', exact: true })
  await loginFunnel.getByRole('checkbox', { name: 'app_billing (1)', exact: true }).uncheck()
  await loginFunnel.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(monitor().getByText(/^2 sessions · 1 filter on/)).toBeVisible()
  await expect.poll(async () => (await calls('live.update')).some(call => (text => text.includes('"column":"login","values":["app_billing"]') && text.includes('"exclude":true'))(JSON.stringify(call.params.args ?? {})))).toBe(true)
  await filters.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(monitor().getByText(/^3 sessions/)).toBeVisible()
  // The toolbar keeps to one row in a pane 800 px wide (two panes side by side): its chips are dense, the Show chips are
  // chips (no raw checkboxes), and the View chip row shrinks and scrolls sideways rather than wrap.
  const rows = await filters.evaluate(element => {
    const width = element.style.width
    element.style.width = '800px'
    const shown = [...element.children].map(child => child.getBoundingClientRect()).filter(rect => rect.width > 0)
    const tops = new Set(shown.map(rect => Math.round(rect.top + rect.height / 2)))
    element.style.width = width
    return { rows: tops.size, widths: shown.map(rect => Math.round(rect.width)) }
  })
  expect(rows.rows, `Sessions toolbar rows at 800 px: ${JSON.stringify(rows.widths)}`).toBe(1)
  await expect(filters.getByRole('checkbox')).toHaveCount(0)
  // The header's sort button sorts in the backend (the probe's sort), as a results grid's header does: Login ascending,
  // then descending; Query Output's context menu (the results grid's own) Clear Sort and Sort Ascending do the same.
  await columnHeader('Login').hover()
  await columnHeader('Login').locator(gridPart.sortButton).click()
  await expect(loginAt(0)).toHaveText('app_billing')
  await expect(columnHeader('Login')).toHaveAttribute('aria-sort', 'ascending')
  await expect.poll(async () => (await calls('live.update')).some(call => call.params.probes?.some(probe => probe.probe === 'activity.sessions' && probe.sort?.[0]?.column === 'login'))).toBe(true)
  await columnHeader('Login').locator(gridPart.sortButton).click()
  await expect(loginAt(0)).toHaveText('svc_reporting')
  await sessionsGrid.getByRole('gridcell', { name: 'app_orders', exact: true }).click({ button: 'right' })
  const gridMenu = page.getByRole('menu', { name: 'Query output', exact: true })
  await expect(gridMenu.getByRole('menuitem', { name: /^Copy with Headers/ })).toBeVisible()
  await gridMenu.getByRole('menuitem', { name: /^Clear Sort/ }).click()
  await expect(columnHeader('Login')).not.toHaveAttribute('aria-sort', /./)
  await expect(loginAt(0)).toHaveText('app_orders')
  await sessionsGrid.getByRole('gridcell', { name: 'app_orders', exact: true }).click({ button: 'right' })
  await gridMenu.getByRole('menuitem', { name: /^Sort Ascending/ }).click()
  await expect(loginAt(0)).toHaveText('app_billing')
  await sessionsGrid.getByRole('gridcell', { name: 'app_billing', exact: true }).click({ button: 'right' })
  await gridMenu.getByRole('menuitem', { name: /^Clear Sort/ }).click()
  await expect(loginAt(0)).toHaveText('app_orders')
  console.log('Sessions passed: rows from the sessions probe; the view and Show chips, filter box, header funnels and header sort reach the backend; the context menu sorts; Clear filters resets them.')

  step = 'blocking and active'
  // Blocking and Active Expensive Queries read the sessions probe's other tables: no new probe, no extra SQL.
  const firstTabs = monitor().getByRole('tablist', { name: 'First pane', exact: true })
  const updatesBefore = (await calls('live.update')).length
  await firstTabs.getByRole('tab', { name: /^Blocking/ }).click()
  const chains = monitor().getByRole('grid', { name: /^Blocking/ })
  await expect(chains).toBeVisible()
  await expect(monitor().getByText('No blocking: no session waits on another.', { exact: true })).toBeVisible()
  await expect(monitor().getByText(/^No blocking right now\./)).toBeVisible()
  // A chain appears with the next sample, lead blocker first, and goes when the blocking ends.
  await writeFile(join(control, 'activity-blocked'), '')
  await expect(monitor().getByText('2 sessions in blocking chains', { exact: true })).toBeVisible()
  await expect(monitor().getByText(/^No blocking right now\./)).toHaveCount(0)
  // The first columns, in view at any width: the waiter indented under its lead blocker, and its wait.
  await expect(chains.getByRole('gridcell', { name: '└─ 61', exact: true })).toBeVisible()
  await expect(chains.getByRole('gridcell', { name: 'LCK_M_S', exact: true })).toBeVisible()
  // Its order is the chains', so its header has no sort buttons; Active Expensive Queries' header sorts.
  await expect(chains.locator(gridPart.sortButton)).toHaveCount(0)
  await rm(join(control, 'activity-blocked'))
  await expect(monitor().getByText('No blocking: no session waits on another.', { exact: true })).toBeVisible()
  await firstTabs.getByRole('tab', { name: 'Active Expensive Queries', exact: true }).click()
  const active = monitor().getByRole('grid', { name: /^Active Expensive Queries/ })
  await expect(active).toBeVisible()
  await expect(monitor().getByText('2 running requests', { exact: true })).toBeVisible()
  await expect(active.getByRole('gridcell', { name: 'BillingDb', exact: true })).toBeVisible()
  await expect(active.locator(gridPart.sortButton).first()).toBeAttached()
  // A pane change sends its probe states after the live service's short debounce; two ticks later it has gone, and no
  // probe may have resumed.
  const ticksAfterPanes = (await frames(id)).ticks
  await expect.poll(async () => (await frames(id)).ticks).toBeGreaterThan(ticksAfterPanes + 1)
  expect((await calls('live.update')).slice(updatesBefore).flatMap(call => call.params.probes ?? []).filter(probe => probe.paused === false)).toEqual([])
  await firstTabs.getByRole('tab', { name: 'Sessions', exact: true }).click()
  console.log('Blocking and active passed: the chain shows with its lead blocker and goes when blocking ends, running requests list, and neither starts a probe.')

  step = 'resource waits and file io'
  // Resource Waits shows in the second pane from the start, by category with benign waits hidden. Wait Category and Wait
  // Type are the first columns, in view at any width.
  // A filter change shows with the resources probe's next sample, up to its interval (5 s) away, so those waits are longer.
  const nextSample = { timeout: 15_000 }
  const secondTabs = monitor().getByRole('tablist', { name: 'Second pane', exact: true })
  await expect(secondTabs.getByRole('tab', { name: 'Resource Waits', exact: true })).toHaveAttribute('aria-selected', 'true')
  const waitTools = monitor().getByRole('toolbar', { name: 'Resource Waits filters', exact: true })
  const categories = monitor().getByRole('grid', { name: /^Wait categories/ })
  await expect(categories.getByRole('gridcell', { name: 'Lock', exact: true })).toBeVisible()
  await expect(monitor().getByText('4 wait categories · benign waits hidden', { exact: true })).toBeVisible()
  await expect(categories.getByRole('gridcell', { name: 'Idle', exact: true })).toHaveCount(0)
  // Hide benign waits off: the backend filters the next sample, and Idle shows.
  await waitTools.getByRole('button', { name: 'Hide benign waits', exact: true }).click()
  await expect(monitor().getByText('5 wait categories', { exact: true })).toBeVisible(nextSample)
  await expect(categories.getByRole('gridcell', { name: 'Idle', exact: true })).toBeVisible(nextSample)
  await expect.poll(async () => (await calls('live.update')).some(call => JSON.stringify(call.params.args ?? {}).includes('{"table":"waitTypes","hideBenign":false}'))).toBe(true)
  // By type shows the other table of the same sample: no args change, so nothing is sent.
  const argsBefore = (await calls('live.update')).filter(call => call.params.args).length
  await waitTools.getByRole('button', { name: 'By type', exact: true }).click()
  const types = monitor().getByRole('grid', { name: /^Wait types/ })
  await expect(types.getByRole('gridcell', { name: 'LCK_M_S', exact: true })).toBeVisible()
  await expect(monitor().getByText('5 wait types', { exact: true })).toBeVisible()
  expect((await calls('live.update')).filter(call => call.params.args).length).toBe(argsBefore)
  await waitTools.getByRole('button', { name: 'Hide benign waits', exact: true }).click()
  await expect(monitor().getByText('4 wait types · benign waits hidden', { exact: true })).toBeVisible(nextSample)
  await expect(types.getByRole('gridcell', { name: 'SLEEP_TASK', exact: true })).toHaveCount(0, nextSample)
  await waitTools.getByRole('button', { name: 'By category', exact: true }).click()
  await expect(monitor().getByText('4 wait categories · benign waits hidden', { exact: true })).toBeVisible()
  // Data File I/O reads the same probe, so showing it beside Resource Waits starts nothing new.
  const fileUpdates = (await calls('live.update')).length
  await firstTabs.getByRole('tab', { name: 'Data File I/O', exact: true }).click()
  const fileGrid = monitor().getByRole('grid', { name: /^Data File I\/O/ })
  await expect(fileGrid.getByRole('gridcell', { name: 'SalesDb', exact: true }).first()).toBeVisible()
  await expect(monitor().getByText('5 files · warning at 20 ms, error at 50 ms', { exact: true })).toBeVisible()
  expect((await calls('live.update')).slice(fileUpdates).flatMap(call => call.params.probes ?? []).filter(probe => probe.paused === false)).toEqual([])
  // Over threshold keeps the files the backend toned (SalesDb's log at 61.5 ms and data at 34 ms); Log keeps the logs.
  const fileTools = monitor().getByRole('toolbar', { name: 'Data File I/O filters', exact: true })
  await fileTools.getByRole('button', { name: 'Over threshold', exact: true }).click()
  await expect(monitor().getByText('2 files · Over threshold only · warning at 20 ms, error at 50 ms', { exact: true })).toBeVisible(nextSample)
  await expect(fileGrid.getByRole('gridcell', { name: 'master', exact: true })).toHaveCount(0, nextSample)
  await expect.poll(async () => (await calls('live.update')).some(call => JSON.stringify(call.params.args ?? {}).includes('"fileView":"overThreshold"'))).toBe(true)
  await fileTools.getByRole('button', { name: 'Over threshold', exact: true }).click()
  await expect(monitor().getByText('5 files · warning at 20 ms, error at 50 ms', { exact: true })).toBeVisible(nextSample)
  // Paused, a chip or a threshold setting changes the args at once, but the rows wait for a sample, so the status line
  // counts them and says the view and thresholds apply from the next one. The settings reach an open monitor.
  const pause = monitor().getByRole('button', { name: 'Pause', exact: true })
  await pause.click()
  await expect(livePill(monitor())).toHaveText('Paused')
  await fileTools.getByRole('button', { name: 'Log', exact: true }).click()
  await expect(monitor().getByText('5 files · Log only · warning at 20 ms, error at 50 ms from the next sample', { exact: true })).toBeVisible()
  await expect.poll(async () => (await calls('live.update')).some(call => JSON.stringify(call.params.args ?? {}).includes('"fileView":"log"'))).toBe(true)
  expect(await page.evaluate(() => window.varia.updateSettings({ 'activityMonitor.fileLatencyWarningMs': 70 }))).toMatchObject({ ok: true })
  await expect(monitor().getByText('5 files · Log only · warning at 70 ms, error at 70 ms from the next sample', { exact: true })).toBeVisible()
  await expect.poll(async () => (await calls('live.update')).some(call => JSON.stringify(call.params.args ?? {}).includes('"latencyWarningMs":70,"latencyErrorMs":50'))).toBe(true)
  // Resumed, the first sample has no interval: Log's rows without latencies or tones, and the line says when they come.
  await pause.click()
  await expect(monitor().getByText('2 files · Log only · warning at 70 ms, error at 70 ms · latencies and tones from the next sample', { exact: true })).toBeVisible(nextSample)
  await expect(fileGrid.getByRole('gridcell', { name: '/var/opt/mssql/data/SalesDb.mdf', exact: true })).toHaveCount(0)
  await expect(monitor().getByText('2 files · Log only · warning at 70 ms, error at 70 ms', { exact: true })).toBeVisible(nextSample)
  expect(await page.evaluate(() => window.varia.updateSettings({ 'activityMonitor.fileLatencyWarningMs': null }))).toMatchObject({ ok: true })
  await expect(monitor().getByText('2 files · Log only · warning at 20 ms, error at 50 ms', { exact: true })).toBeVisible(nextSample)
  await fileTools.getByRole('button', { name: 'Log', exact: true }).click()
  await expect(monitor().getByText('5 files · warning at 20 ms, error at 50 ms', { exact: true })).toBeVisible(nextSample)
  await page.screenshot({ path: join('artifacts', 'activity-monitor-resources.png') })
  await firstTabs.getByRole('tab', { name: 'Sessions', exact: true }).click()
  console.log('Resource waits and file I/O passed: categories and types from one sample, Hide benign waits, the file chips and the latency settings reach the backend and say so until the next sample, a sample without rates says so, and Data File I/O starts no probe beside Resource Waits.')

  step = 'recent queries'
  // Recent Expensive Queries reads the query statistics probe: it resumes only while the pane shows, at its own interval.
  const queriesUpdates = (await calls('live.update')).length
  const queriesPatches = async () => (await calls('live.update')).slice(queriesUpdates).flatMap(call => call.params.probes ?? []).filter(probe => probe.probe === 'activity.queries')
  await firstTabs.getByRole('tab', { name: 'Recent Expensive Queries', exact: true }).click()
  await expect.poll(async () => (await queriesPatches()).some(probe => probe.paused === false)).toBe(true)
  const recent = monitor().getByRole('grid', { name: /^Recent Expensive Queries/ })
  await expect(recent).toBeVisible()
  await expect(monitor().getByText('3 queries by query hash', { exact: true })).toBeVisible()
  // The first sample has no window: its rows go by total CPU. Query is the first column, in view at any width.
  const queryAt = row => recent.locator(gridCellSelector(row, 0))
  await expect(queryAt(0)).toHaveText(/^SELECT c\.CustomerId/)
  const rankBy = monitor().getByRole('group', { name: 'Rank by', exact: true })
  await expect(rankBy.getByRole('button', { name: 'CPU', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // A rank chip is the table's sort, sent to the probe; the status line says the rows keep their order until the next sample.
  await rankBy.getByRole('button', { name: 'Executions', exact: true }).click()
  await expect(rankBy.getByRole('button', { name: 'Executions', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(rankBy.getByRole('button', { name: 'CPU', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(monitor().getByText('3 queries by query hash · ranked by Executions from the next sample', { exact: true })).toBeVisible()
  await expect.poll(async () => (await queriesPatches()).map(probe => probe.sort).filter(Boolean).at(-1)).toEqual([{ column: 'executionsPerMinute', descending: true, table: 0 }])
  // Refresh Now brings the next sample, in the chip's order (most executions first), and the note goes.
  await rankBy.getByRole('button', { name: 'Executions', exact: true }).focus()
  await page.keyboard.press('F5')
  await expect(queryAt(0)).toHaveText(/^UPDATE dbo\.Invoices/)
  await expect(monitor().getByText('3 queries by query hash', { exact: true })).toBeVisible()
  // Leaving the pane pauses the probe again: the plan cache is read only for a pane someone can see.
  await firstTabs.getByRole('tab', { name: 'Sessions', exact: true }).click()
  await expect.poll(async () => (await queriesPatches()).at(-1)?.paused).toBe(true)
  console.log('Recent queries passed: the probe runs only while the pane shows, rows arrive by CPU, a rank chip sorts the next sample and says so until it comes.')

  step = 'panes'
  const first = monitor().getByRole('tablist', { name: 'First pane', exact: true })
  await expect(first.getByRole('tab', { name: 'Sessions', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(monitor().getByRole('tablist', { name: 'Second pane', exact: true }).getByRole('tab', { name: 'Resource Waits', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(monitor().getByRole('grid', { name: /^Wait categories/ })).toBeVisible()
  await first.getByRole('tab', { name: 'Sessions', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(first.getByRole('tab', { name: /^Blocking/ })).toHaveAttribute('aria-selected', 'true')
  await expect(first.getByRole('tab', { name: /^Blocking/ })).toBeFocused()
  // F6 moves on to the second pane, then round to the tiles.
  await page.keyboard.press('F6')
  await expect(monitor().getByRole('tablist', { name: 'Second pane', exact: true }).getByRole('tab', { name: 'Resource Waits', exact: true })).toBeFocused()
  await page.keyboard.press('F6')
  await expect(monitor().getByRole('button', { name: '% Processor Time chart', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+F6')
  await expect(monitor().getByRole('tablist', { name: 'Second pane', exact: true }).getByRole('tab', { name: 'Resource Waits', exact: true })).toBeFocused()
  const split = monitor().getByRole('button', { name: 'Split View', exact: true })
  await expect(split).toHaveAttribute('aria-pressed', 'true')
  const splitUpdates = (await calls('live.update')).length
  await split.click()
  await expect(split).toHaveAttribute('aria-pressed', 'false')
  await expect(monitor().getByRole('tablist', { name: 'Second pane', exact: true })).toHaveCount(0)
  // With Resource Waits gone (Blocking reads the sessions probe), the resources probe pauses.
  await expect.poll(async () => (await calls('live.update')).slice(splitUpdates).flatMap(call => call.params.probes ?? []).some(probe => probe.probe === 'activity.resources' && probe.paused === true)).toBe(true)
  await split.click()
  await expect(monitor().getByRole('separator', { name: 'Resize the panes', exact: true })).toBeVisible()
  // Resource Waits' probe runs again with the second pane.
  await expect.poll(async () => (await viewOf(id)).probes['activity.resources']?.state).toBe('fresh')
  console.log('Panes passed: tabs with arrow keys, F6 and Shift+F6 between regions, and Split View, the resources probe pausing without the second pane and sampling again with it.')

  step = 'layout'
  // The header keeps its title whole, and its state never reaches into its controls, at 1280 x 800 and in the smallest
  // window; the controls stay inside the document. The verbs keep their names for assistive technology.
  for (const [width, height] of [[1280, 800], [1024, 768]]) {
    await fit(width, height)
    const fits = await header()
    expect(Math.max(fits.overlap, fits.clipped), `header at ${width} x ${height}: ${JSON.stringify(fits)}`).toBeLessThanOrEqual(0)
    expect(fits.titleWidth).toBeGreaterThan(0)
    expect(fits.titleCut).toBe(false)
    await expect(monitor().getByRole('button', { name: 'Split View', exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: join('artifacts', `activity-monitor-${width}.png`) })
  }
  // Every tile's caption reads whole, clear of its chart button, in one row of eight or two of four, in the theme's font
  // and in a wider one (Linux's fallback); the tiles stay short enough that, stacked in split view, the first pane's tabs
  // show inside the document, and both panes keep a pane's height.
  for (const [width, height] of [[1600, 1000], [1440, 900], [1280, 800], [1024, 768]]) {
    await fit(width, height)
    expect(await cutCaptions(), `captions at ${width} x ${height}`).toEqual([])
    expect(await captionsUnderButtons(), `captions under their buttons at ${width} x ${height}`).toEqual([])
    await uiFont(wideFont)
    expect(await cutCaptions(), `captions in ${wideFont} at ${width} x ${height}`).toEqual([])
    expect(await captionsUnderButtons(), `captions under their buttons in ${wideFont} at ${width} x ${height}`).toEqual([])
    await uiFont()
    // The expanded charts give way only down to a usable plot each, side by side or stacked.
    for (const canvas of await charts().locator('canvas').all()) expect((await box(canvas)).height, `chart at ${width} x ${height}`).toBeGreaterThanOrEqual(60)
    if (width === 1024) continue
    await documentContent(monitor()).evaluate(element => { element.scrollTop = 0 })
    const content = await box(documentContent(monitor()))
    const [firstBox, secondBox] = await Promise.all([box(monitor().getByRole('region', { name: 'First pane', exact: true })), box(monitor().getByRole('region', { name: 'Second pane', exact: true }))])
    expect(firstBox.y + 40, `first pane at ${width} x ${height}`).toBeLessThan(content.y + content.height)
    expect(Math.min(firstBox.height, secondBox.height)).toBeGreaterThanOrEqual(199)
    expect(secondBox.y).toBeGreaterThan(firstBox.y + firstBox.height)
  }
  // In the smallest window, fewer chart columns: all eight still get a row each with a usable plot.
  const chartCaptions = ['% Processor Time', 'Batch Requests/sec', 'Blocked Sessions', 'Active Requests', 'CPU Pressure', 'Memory Grants Pending']
  for (const caption of chartCaptions) await monitor().getByRole('button', { name: `${caption} chart`, exact: true }).click()
  await expect(chartTitles()).toHaveCount(8)
  await expectAllCharts('at 1024 x 768')
  for (const caption of chartCaptions) await monitor().getByRole('button', { name: `${caption} chart`, exact: true }).click()
  await expect(chartTitles()).toHaveCount(2)
  await fit(1600, 1000)
  await page.screenshot({ path: join('artifacts', 'activity-monitor-1600.png') })
  await size(1500, 960)
  console.log('Layout passed: the header fits at 1280 x 800 and 1024 x 768, captions read whole, and stacked panes keep their height.')

  step = 'permission'
  // The fake server reports this login, which needs quoting in the GRANT statement.
  await connect('no-permission', 'activity-smoke-password', 'odd]reader')
  await menu('activity.open')
  await expect(queryTabs().filter({ hasText: 'no-permission - Activity Monitor' })).toHaveCount(1)
  await expect(monitor().getByText('Activity Monitor needs VIEW SERVER PERFORMANCE STATE to show server activity and other sessions.')).toBeVisible()
  await expect(tile('% Processor Time')).toHaveAccessibleName(/^% Processor Time: no data yet, No permission$/)
  await expect(monitor().getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  // Every banner has the same inset in the same box: the permission one and a failed sample's.
  expect(await glyphInset()).toEqual(failingInset)
  await monitor().getByRole('button', { name: 'Copy GRANT statement', exact: true }).click()
  await expect(monitor().getByText('GRANT statement copied. Varia never runs it.', { exact: true })).toBeVisible()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('GRANT VIEW SERVER PERFORMANCE STATE TO [odd]]reader];')
  // Shift+Esc closes it, and its subscription ends.
  await monitor().getByRole('button', { name: '% Processor Time chart', exact: true }).focus()
  await page.keyboard.press('Shift+Escape')
  await expect(queryTabs().filter({ hasText: 'no-permission' })).toHaveCount(0)
  await expect.poll(async () => (await handles()).length).toBe(1)
  console.log('Permission passed: the monitor opens, says which permission it needs, offers Retry, and Shift+Esc closes it.')

  step = 'backend lost'
  await queryTabs().filter({ hasText: 'activity-server - Activity Monitor' }).click()
  const lostGeneration = (await backendState()).generation
  await app.evaluate(() => globalThis.__variaTest.kill())
  await expect.poll(async () => (await viewOf(id)).status, { timeout: 30000 }).toBe('lost')
  await expect(livePill(monitor())).toHaveText('Stopped · backend unavailable')
  await expect.poll(async () => { const state = await backendState(); return state.status === 'ready' && state.generation > lostGeneration }, { timeout: 30000 }).toBe(true)
  await monitor().getByRole('button', { name: 'Reconnect…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(dialog.getByLabel('Server Name', { exact: true })).toHaveValue('activity-server')
  await dialog.getByLabel('Password', { exact: true }).fill('activity-smoke-password')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await viewOf(id)).status, { timeout: 15000 }).toBe('live')
  await expect(tile('% Processor Time')).toHaveAccessibleName(/^% Processor Time: \d/, { timeout: 10000 })
  console.log('Backend loss passed: the monitor said so, and Reconnect moved it to the new connection, sampling again.')

  step = 'light'
  const background = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--varia-editor-background').trim())
  const dark = await background()
  await menu('theme.mode.light')
  await expect.poll(background).not.toBe(dark)
  await sleep(500)
  await page.screenshot({ path: join('artifacts', 'activity-monitor-light.png') })

  step = 'close'
  await page.keyboard.press(mod + '+W')
  await expect(queryTabs().filter({ hasText: 'Activity Monitor' })).toHaveCount(0)
  await expect.poll(async () => (await handles()).length).toBe(0)
  await expect.poll(() => page.evaluate(() => window.__variaResults.liveStreams)).toBe(0)
  expect(failures).toEqual([])
  console.log('Activity Monitor passed on the fake backend.')

  if (process.env.VARIA_TEST_SQL_SERVER) {
    step = 'real server'
    await app.close()
    const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
    const realEnv = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
    delete realEnv.ELECTRON_RUN_AS_NODE
    delete realEnv.VARIA_TEST_BACKEND
    app = await electron.launch({ args: ['.'], env: realEnv, chromiumSandbox: process.getuid?.() !== 0 })
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => failures.push(error.message))
    await expect(backendReady(page)).toBeVisible({ timeout: 60000 })
    const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
    await toolbarButton(page, 'Connect').click()
    await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
    await dialog.getByLabel('Server Name', { exact: true }).fill(process.env.VARIA_TEST_SQL_SERVER)
    if (liveUser) {
      await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
      await dialog.getByLabel('Login', { exact: true }).fill(liveUser)
      await dialog.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD ?? '')
    } else await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await dialog.getByLabel('Trust server certificate', { exact: true }).check()
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30000 })
    await menu('activity.open')
    await expect(queryTabs().filter({ hasText: 'Activity Monitor' })).toHaveCount(1)
    // Rates need two samples on the server's clock; a login without server state gets the permission message instead.
    const permission = monitor().getByText(/^Activity Monitor needs VIEW SERVER/)
    const cpu = async () => (await tile('% Processor Time').getAttribute('aria-label')) ?? ''
    await expect.poll(async () => await permission.isVisible() || /^% Processor Time: \d/.test(await cpu()), { timeout: 20000 }).toBe(true)
    if (await permission.isVisible()) console.log('Real server: the login lacks server state, and the monitor says which permission it needs.')
    else {
      await expect(tile('Batch Requests/sec')).toHaveAccessibleName(/^Batch Requests\/sec: [\d,.]+ \/s/)
      await expect(tile('Active Requests')).toHaveAccessibleName(/^Active Requests: \d+, User sessions \d+/)
      const [real] = await handles()
      await monitor().getByRole('button', { name: 'Pause', exact: true }).click()
      await expect.poll(async () => (await viewOf(real.id)).status).toBe('paused')
      await stays(real.id, 2500)
      await monitor().getByRole('button', { name: 'Pause', exact: true }).click()
      await expect.poll(async () => (await viewOf(real.id)).status).toBe('live')
      await page.screenshot({ path: join('artifacts', 'activity-monitor-real.png') })
      console.log('Real server passed: the overview probe filled the tiles, and Pause stopped it.')
    }
    await page.keyboard.press(mod + '+W')
    await expect.poll(async () => (await handles()).length).toBe(0)
    expect(failures).toEqual([])
  }
  console.log('Activity Monitor passed.')
} catch (error) {
  await page.screenshot({ path: join('artifacts', 'activity-monitor-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await within(app.close(), 15000, () => app.process()?.kill()).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
