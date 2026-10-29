// Live views in the real app on the fake backend's debug.synthetic source (tests/fixtures/backend.mjs, workbench mode),
// through window.__variaLive: ticks arrive and are acknowledged one at a time; a hidden window pauses the view within
// 3 s and its frames stop; showing it resumes the view with a gap in its history; switching tabs pauses the tab's view;
// closing the owner tab ends its view; a killed backend reports the view lost, and Reconnect brings it back on the new
// connection. Smoke windows keep background throttling off, so the page is always visible to itself: the test hook
// stands in for minimizing. Last, Object Explorer's status chips: the fake backend's explorer source, steered by
// explorer-status.json in the control directory, puts state chips on a server and a database row, which follow a change
// on the next samples without reloading the tree; the view pauses with a hidden window, and F5 samples it at once.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expandExplorerPath, explorerRow } from './fixtures/explorer-tree.mjs'
import { activeDocumentName, backendBanner, backendReady, documentTab, documentTabs, environmentPill, explorerLabel, explorerSublabel, explorerTree, part, queryStatus, statusBar, statusChips, toolbarButton } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'live-profile-'))
const control = await mkdtemp(resolve('artifacts', 'live-control-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
let step = 'launch'
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error(`Live suite timed out during: ${step}.`); app.process()?.kill(); process.exit(1) }, 300_000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
page.on('pageerror', error => failures.push(error.message))

const live = (method, ...args) => page.evaluate(([name, values]) => window.__variaLive[name](...values), [method, args])
const frames = id => live('frames', id)
const snapshot = id => live('snapshot', id)
const calls = async () => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const liveCalls = async method => (await calls()).filter(call => call.method === method)
/** The synthetic views' subscriptions: every connection also asks for Object Explorer's status (refused until the last step). */
const syntheticSubscribes = async () => (await liveCalls('live.subscribe')).filter(call => call.params.source === 'debug.synthetic')
const backendState = () => app.evaluate(() => globalThis.__variaTest.state())
const sleep = ms => new Promise(done => setTimeout(done, ms))
const queryTabs = () => documentTabs(page).getByRole('tab')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
/** The view's ticks stay where they are for `ms`: nothing is sampled. */
async function stays(id, ms = 600) {
  const before = (await frames(id)).ticks
  await sleep(ms)
  expect((await frames(id)).ticks).toBe(before)
}
async function connect(password = 'live-smoke-password', server = 'live-server', environment = undefined) {
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  if (!await dialog.isVisible()) await toolbarButton(page, 'Connect').click()
  await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
  await dialog.getByLabel('Password', { exact: true }).fill(password)
  await dialog.getByLabel('Trust server certificate', { exact: true }).check()
  if (environment) await dialog.getByLabel('Environment', { exact: true }).selectOption(environment)
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

try {
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  await connect()
  await expect(queryStatus(page)).toContainText('live-server')
  // Background throttling is off in smoke runs, so the hidden window counts as visible: only the hook can hide it.
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')

  step = 'ticks'
  const id = await live('subscribeSynthetic', { tickMs: 50, rows: 5 })
  await expect.poll(async () => (await frames(id)).ticks).toBeGreaterThanOrEqual(5)
  const first = await snapshot(id)
  expect(first).toMatchObject({ status: 'live', subscriptionId: id })
  expect(Object.values(first.probes).map(probe => probe.state)).toEqual(['fresh', 'fresh', 'fresh'])
  // The tab's own connection, and each frame acknowledged in turn: seq goes up one at a time, and the stream keeps going.
  const subscribed = await syntheticSubscribes()
  expect(subscribed).toHaveLength(1)
  expect(subscribed[0].params).toMatchObject({ subscriptionId: id, source: 'debug.synthetic', args: { tickMs: 50, rows: 5 } })
  const counted = await frames(id)
  expect(counted.lastSeq).toBe(counted.events - 1)
  await expect.poll(async () => (await live('table', id, 'debug.synthetic.table'))?.state).toBe('complete')
  expect((await live('table', id, 'debug.synthetic.table')).descriptor.rowsAvailable).toBe(5)
  expect((await live('ring', id, 'debug.synthetic.metrics')).length).toBeGreaterThanOrEqual(5)
  console.log('Live ticks passed: a view on the tab\'s connection, every frame applied and acknowledged in turn.')

  step = 'hidden window'
  const hiddenAt = Date.now()
  await live('setPageHidden', true)
  await expect.poll(async () => (await frames(id)).lastPatch, { timeout: 3000 }).toEqual({ paused: true })
  expect(Date.now() - hiddenAt).toBeLessThan(3000)
  await expect.poll(async () => (await snapshot(id)).status).toBe('paused')
  expect((await snapshot(id)).pausedBy).toBe('hidden')
  await sleep(200)
  await stays(id)
  const gaps = (await live('ring', id, 'debug.synthetic.metrics')).gaps
  await live('setPageHidden', false)
  await expect.poll(async () => (await frames(id)).lastPatch).toEqual({ paused: false })
  const resumed = (await frames(id)).ticks
  await expect.poll(async () => (await frames(id)).ticks).toBeGreaterThan(resumed + 2)
  expect((await snapshot(id)).status).toBe('live')
  // The first sample after the pause starts a new stretch of history.
  expect((await live('ring', id, 'debug.synthetic.metrics')).gaps).toBe(gaps + 1)
  expect((await liveCalls('live.update')).map(call => call.params.paused)).toEqual([true, false])
  console.log('Hidden window passed: paused within 3 s, no frames while hidden, resumed with a gap when shown.')

  step = 'tab switch'
  const owner = await activeDocumentName(page)
  await page.keyboard.press(mod + '+N')
  await expect(queryTabs()).toHaveCount(2)
  await expect.poll(async () => (await snapshot(id)).status, { timeout: 5000 }).toBe('paused')
  await stays(id)
  await documentTab(page, owner).click()
  await expect.poll(async () => (await snapshot(id)).status).toBe('live')
  console.log('Tab switch passed: the view paused while its tab was not showing and resumed when it was.')

  step = 'close owner'
  // A second view owned by the new tab ends when that tab closes.
  await queryTabs().nth(1).click()
  const second = await live('subscribeSynthetic', { tickMs: 50, probes: ['debug.synthetic.status'] })
  await expect.poll(async () => (await frames(second))?.ticks ?? 0).toBeGreaterThanOrEqual(2)
  expect((await snapshot()).handles).toHaveLength(2)
  await page.keyboard.press(mod + '+W')
  await expect(queryTabs()).toHaveCount(1)
  await expect.poll(async () => (await snapshot()).handles.map(handle => handle.id)).toEqual([id])
  await expect.poll(() => page.evaluate(() => window.__variaResults.liveStreams)).toBe(1)
  await expect.poll(async () => (await snapshot(id)).status).toBe('live')
  console.log('Closing the owner tab passed: its view ended and released its stream; the other view kept going.')

  step = 'backend lost'
  const lostGeneration = (await backendState()).generation
  await app.evaluate(() => globalThis.__variaTest.kill())
  await expect.poll(async () => (await snapshot(id)).status, { timeout: 30000 }).toBe('lost')
  expect((await snapshot(id)).error.code).toMatch(/^(BACKEND_LOST|RESULT_UNAVAILABLE)$/)
  await expect.poll(async () => { const state = await backendState(); return state.status === 'ready' && state.generation > lostGeneration }, { timeout: 30000 }).toBe(true)
  // Nothing comes back by itself: the view's connection went with its backend.
  await sleep(500)
  expect((await snapshot(id)).status).toBe('lost')
  const history = (await live('ring', id, 'debug.synthetic.metrics')).length
  await backendBanner(page).getByRole('button', { name: 'Reconnect…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(dialog.getByLabel('Server Name', { exact: true })).toHaveValue('live-server')
  await dialog.getByLabel('Password', { exact: true }).fill('live-smoke-password')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await snapshot(id)).status, { timeout: 15000 }).toBe('live')
  const back = await snapshot(id)
  expect(back.connectionId).not.toBe(first.connectionId)
  expect(back.subscriptionId).not.toBe(id)
  const resubscribed = await syntheticSubscribes()
  expect(resubscribed.at(-1)).toMatchObject({ generation: lostGeneration + 1, params: { connectionId: back.connectionId, subscriptionId: back.subscriptionId } })
  await expect.poll(async () => (await live('ring', id, 'debug.synthetic.metrics')).length).toBeGreaterThan(history)
  console.log('Backend loss passed: the view reported lost, kept its history, and Reconnect resubscribed on the new connection.')

  await live('dispose', id)
  await expect.poll(() => page.evaluate(() => window.__variaResults.liveStreams)).toBe(0)

  step = 'explorer status'
  // A database restoring with a single user, two Agent jobs and a healthy group, as the fake backend's explorer source reads them.
  const cue = join(control, 'explorer-status.json')
  await writeFile(cue, JSON.stringify({ databases: [['AppData', 1, 1, 0, 0]], progress: [['AppData', 'RESTORE DATABASE', 42]], jobs: 2, groups: [['AG1', 2, 1]] }))
  // A Production connection, so its PROD tag shares the server row with the chips.
  await connect('live-smoke-password', 'status-server', 'Production')
  const statusServer = await explorerRow(page, 'status-server')
  await expect(statusChips(statusServer)).toHaveText(['2 jobs running', 'AG1 healthy'])
  await expect(statusServer).toHaveAttribute('aria-label', /, SQL Server Agent: 2 jobs running, Availability groups: AG1 healthy, Production environment$/)
  const explorerSubscribe = (await liveCalls('live.subscribe')).filter(call => call.params.source === 'explorer').at(-1)
  expect(explorerSubscribe.params.probes.map(probe => probe.probe)).toEqual(['explorer.databases', 'explorer.progress', 'explorer.agent', 'explorer.availability'])
  await expandExplorerPath(page, 'status-server', 'Databases')
  const appData = await explorerRow(page, 'status-server', 'Databases', 'AppData')
  await expect(statusChips(appData)).toHaveText(['RESTORING 42 %', 'SINGLE USER'])
  // The chips say the state: no listing sublabel, and the row name says it in words, dimmed as unavailable.
  await expect(appData).toHaveAttribute('aria-label', 'AppData (Restoring 42 %, Single user), unavailable')
  await expect(explorerSublabel(appData)).toHaveCount(0)
  await expect(appData).toHaveAttribute('title', /Its state changed since Databases loaded\. Refresh Databases to update it\./)
  // A pane narrower than 30em shows only each row's first chip, rather than every chip cut to a letter or two. At the
  // default pane width the chip that shows is whole (RESTORING 42 % keeps its percentage), and the server's PROD tag keeps
  // its word whole beside the chips: the label gives up the row's empty space first, and the chips give way, not the tag.
  const narrow = await statusServer.evaluate(row => row.getBoundingClientRect().width < 30 * parseFloat(getComputedStyle(row).fontSize))
  await expect(statusChips(statusServer).first()).toBeVisible()
  await expect(statusChips(statusServer).nth(1)).toBeVisible({ visible: !narrow })
  await expect(statusChips(appData).nth(1)).toBeVisible({ visible: !narrow })
  await explorerTree(page).screenshot({ path: resolve('artifacts', 'explorer-status.png') })
  // Each part of the server row, for a failure's message: its width, and whether its text is cut.
  const parts = [part.explorerLabel, part.explorerSublabel, part.explorerEnd, part.explorerChips, part.statusPillValue, part.statusPillLabel, part.explorerDot].join(', ')
  const layout = await statusServer.evaluate((row, parts) => [...row.querySelectorAll(parts)].map(element => `${element.className} ${Math.round(element.getBoundingClientRect().width)}${element.scrollWidth > element.clientWidth ? ' cut' : ''}`).join(', ')
    + ` (row ${Math.round(row.getBoundingClientRect().width)} px)`, parts)
  // Whether an element's text is whole and it ends inside the box that clips it.
  const shown = (locator, clip) => locator.evaluate((element, clip) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= element.closest(clip).getBoundingClientRect().right + 0.5, clip)
  // The database row has room: RESTORING 42 % is whole. The server row is short of it (its name, the chips, PROD, the
  // active query's glyph and the dot): the jobs chip's word gives way, its count does not, and PROD stays whole.
  await expect(statusChips(appData).first()).toHaveText('RESTORING 42 %')
  expect([await shown(statusChips(appData).first().locator(part.statusPillLabel), part.explorerChips), await shown(statusChips(appData).first().locator(part.statusPillValue), part.explorerChips)], layout).toEqual([true, true])
  await expect(statusChips(statusServer).first().locator(part.statusPillValue)).toHaveText('2')
  expect(await shown(statusChips(statusServer).first().locator(part.statusPillValue), part.explorerChips), layout).toBe(true)
  const prod = environmentPill(statusServer, 'explorer')
  await expect(prod).toHaveText('PROD')
  expect([await shown(prod.locator(part.statusPillLabel), part.explorerRow), await shown(statusServer.locator(part.explorerDot), part.explorerRow), await shown(explorerLabel(statusServer), part.explorerRow)], layout).toEqual([true, true, true])
  console.log('Object Explorer status chips at the default pane width: ' + layout)
  // The server changes: the next samples move the chips, and the tree is not listed again.
  const listings = (await calls()).filter(call => call.method === 'explorer.children').length
  await writeFile(cue, JSON.stringify({ databases: [['AppData', 0, 0, 1, 0]], jobs: 0, groups: [['AG1', 1, 2]] }))
  await expect(statusChips(appData)).toHaveText(['READ-ONLY'])
  await expect(appData).toHaveAttribute('aria-label', 'AppData (Read-only)')
  await expect(statusChips(statusServer)).toHaveText(['AG1 partially healthy'])
  expect((await calls()).filter(call => call.method === 'explorer.children').length).toBe(listings)
  const explorerUpdates = async () => (await liveCalls('live.update')).filter(call => call.params.subscriptionId === explorerSubscribe.params.subscriptionId).map(call => call.params)
  // Hidden, the view pauses as every live view does; shown, it resumes.
  await live('setPageHidden', true)
  await expect.poll(explorerUpdates, { timeout: 5000 }).toContainEqual(expect.objectContaining({ paused: true }))
  await live('setPageHidden', false)
  await expect.poll(async () => (await explorerUpdates()).at(-1)).toMatchObject({ paused: false })
  // F5 on the server reloads its rows and samples its status at once.
  await explorerLabel(statusServer).click()
  await page.keyboard.press('F5')
  await expect.poll(async () => (await explorerUpdates()).at(-1)).toMatchObject({ refresh: true })
  await expect(statusChips(statusServer)).toHaveText(['AG1 partially healthy'])
  console.log('Object Explorer status passed: chips on the server and a database row from the explorer source, following a change without a tree reload, paused while hidden, and sampled by F5.')
  expect(failures).toEqual([])
  console.log('Live views passed.')
} finally {
  clearTimeout(watchdog)
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await Promise.race([app.close(), sleep(15000).then(() => app.process()?.kill())]).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
