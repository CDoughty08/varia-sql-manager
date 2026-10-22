import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { explorerRow } from './fixtures/explorer-tree.mjs'
import { anyResultGrid, backendBanner, errorMessages, explorerLabel, gridCell as gridCellOf, lostServerRows, menuItemNames, messages as messagesOf, openMenus, outputStatus, outputView, queryStatus, statusBar as statusBarOf, toolbarButton } from './fixtures/ui.mjs'

// Backend restarts end to end: the real backend's readiness and reload, a fake backend (tests/fixtures/backend.mjs)
// that crashes, crash-loops, and hangs on cue, a stale protocol 1 backend, and, with a live server, a real session lost
// and reconnected; and the UI's responsiveness while a million stored rows are read through the results worker.
// Main honours VARIA_TEST_BACKEND, VARIA_BACKEND_LIVENESS_MS, __variaTest, and test mode only in smoke runs.
const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (process.env.VARIA_TEST_SQL_SERVER && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')
const lostQuery = 'The SQL backend stopped while this script was running. It was not re-run.'
const lostHint = "This query's connection was lost when the SQL backend restarted. Reconnect to run queries."
const newSession = 'This query opened a new SQL session. The previous session ended when the SQL backend restarted'
await mkdir('artifacts', { recursive: true })
const temporary = []
// Backends a regression could leave running after their app exits; killed at the end whatever happens.
const orphans = []
let app
let page
const failures = []
let step = 'start'
const watchdog = setTimeout(() => { console.error(`Backend suite timed out during: ${step}.`); app?.process()?.kill(); process.exit(1) }, 300000)

/** Starts the app on a new profile, or on `profile`, and returns the profile. */
async function launch(extra = {}, profile = undefined) {
  if (!profile) {
    profile = await mkdtemp(resolve('artifacts', 'backend-profile-'))
    temporary.push(profile)
  }
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  // Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
  app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  return profile
}
/** Quits without the unsaved-query prompts (they would wait for a hidden dialog), killing the app if it hangs. */
async function close() {
  const current = app
  app = undefined
  if (!current) return
  await current.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  const closed = await Promise.race([current.close().then(() => true, () => false), new Promise(resolve => setTimeout(() => resolve(false), 15000))])
  if (!closed) current.process()?.kill('SIGKILL')
}
const hooks = () => app.evaluate(() => ({ state: globalThis.__variaTest.state(), pid: globalThis.__variaTest.pid() }))
const states = () => app.evaluate(() => globalThis.__variaTest.states.map(state => state.status + (state.generation ? ':' + state.generation : '')))
async function ready(generation) {
  await expect.poll(async () => { const { state } = await hooks(); return state.status === 'ready' && (generation === undefined || state.generation === generation) }, { timeout: 30000 }).toBe(true)
  return hooks()
}
const banner = () => backendBanner(page)
const statusBar = () => statusBarOf(page)
async function size(width, height) { await app.evaluate(({ BrowserWindow }, dimensions) => { BrowserWindow.getAllWindows()[0].setContentSize(...dimensions) }, [width, height]) }
async function typeSql(sql) {
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(sql)
}
const execute = () => toolbarButton(page, /Execute/)
async function messages() {
  await outputView(page, /^Messages/).click()
  return messagesOf(page)
}
/** A data cell of the first results grid, by row and column. */
const gridCell = (row, column) => gridCellOf(anyResultGrid(page), row, column).first()
const running = () => expect(outputStatus(page)).toContainText('Executing query…')
async function connectDialog() {
  await toolbarButton(page, 'Connect').click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
  return dialog
}
async function fillLogin(dialog, server, user, password) {
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  if (user) {
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await dialog.getByLabel('Login', { exact: true }).fill(user)
    await dialog.getByLabel('Password', { exact: true }).fill(password)
  } else await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await dialog.getByLabel('Trust server certificate', { exact: true }).check()
}
/** Every button of the banner lies inside the window's content area. */
async function bannerInViewport() {
  await expect(banner().getByRole('button').first()).toBeVisible()
  await expect.poll(() => banner().evaluate(element => [...element.querySelectorAll('button')].filter(button => {
    const rect = button.getBoundingClientRect()
    return rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight || rect.width === 0
  }).map(button => button.textContent))).toEqual([])
}

try {
  // 1. The real backend: protocol 2, its versions, and Ready from main's state.
  step = 'real backend'
  // The real backend with its test hooks: debug.results.synthesize stores rows without a SQL Server.
  await launch({ VARIA_BACKEND_TEST_HOOKS: '1' })
  await expect(statusBar()).toContainText(/\.NET 10\..* · Ready/, { timeout: 30000 })
  const health = await page.evaluate(() => window.varia.health())
  expect(health.ok && health.value.protocolVersion).toBe(2)
  expect(health.ok && health.value.smoVersion).toMatch(/^\d+\./)
  const first = await ready(1)
  const pushed = await page.evaluate(() => window.varia.getBackendState())
  expect(pushed).toEqual({ ok: true, value: first.state })
  expect(first.state.pid).toBe(first.pid)
  expect(await page.evaluate(() => typeof window.varia.restartBackend)).toBe('function')
  await expect(banner()).toHaveCount(0)

  // 7. Responsiveness: a million stored rows read window by window through the results worker. Pages are decoded off
  // the UI thread, so the UI thread never blocks for long (generous bounds: CI machines are slow and shared).
  step = 'responsiveness'
  expect(await page.evaluate(() => ({ testMode: window.varia.testMode, results: typeof window.__variaResults }))).toEqual({ testMode: true, results: 'object' })
  const synthesized = await app.evaluate(() => globalThis.__variaTest.synthesize('W1', 1000000))
  expect(synthesized).toMatchObject({ generation: 1, state: 'complete', rowsRead: 1000000, columns: expect.arrayContaining([expect.objectContaining({ name: 'id', wire: 'text' })]) })
  expect(synthesized.rowsAvailable).toBeGreaterThan(100000)
  const responsiveness = await page.evaluate(async descriptor => {
    const longTasks = []
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration)) })
    observer.observe({ type: 'longtask' })
    // Animation frames, and a timer heartbeat in case the hidden smoke window produces no frames.
    let frames = 0, frameGap = 0, timerGap = 0, running = true
    let lastFrame = performance.now(), lastTick = performance.now()
    const frame = now => { frames++; frameGap = Math.max(frameGap, now - lastFrame); lastFrame = now; if (running) requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
    const tick = () => { const now = performance.now(); timerGap = Math.max(timerGap, now - lastTick); lastTick = now; if (running) setTimeout(tick, 16) }
    setTimeout(tick, 16)
    const handle = window.__variaResults.open(descriptor)
    const started = performance.now()
    let rows = 0, first = []
    for (let row = 0; row < descriptor.rowsAvailable; row += 4096) {
      const window_ = await handle.getWindow(row, 4096)
      if (row === 0) first = window_.text.slice(0, 8)
      rows += window_.count
    }
    const elapsed = performance.now() - started
    running = false
    await new Promise(resolve => setTimeout(resolve, 50))
    observer.disconnect()
    await handle.close()
    return { rows, elapsed: Math.round(elapsed), longTasks, frames, frameGap: Math.round(frameGap), timerGap: Math.round(timerGap), first, visibility: document.visibilityState }
  }, synthesized)
  console.log(`Read ${responsiveness.rows} rows in ${responsiveness.elapsed} ms (${Math.round(responsiveness.rows / responsiveness.elapsed * 1000)} rows/s); long tasks ${JSON.stringify(responsiveness.longTasks)}; ${responsiveness.frames} frames, largest frame gap ${responsiveness.frameGap} ms, largest timer gap ${responsiveness.timerGap} ms (${responsiveness.visibility} window).`)
  expect(responsiveness.rows).toBe(synthesized.rowsAvailable)
  expect(responsiveness.first).toEqual(['0', 'Customer 0000000000 GmbH', '2026-01-01 00:00:00.0000000', '0.00', '00000000-0000-4A1F-9C2E-00C04FC90000', expect.stringMatching(/^Note 0: /), '1', '0'])
  // Linux measures no long task and gaps under 150 ms even on 2 CPUs; Windows runners are slower and shared, so they keep
  // looser bounds.
  const linux = process.platform === 'linux'
  expect(responsiveness.longTasks.filter(duration => duration > (linux ? 100 : 250))).toEqual([])
  if (!linux) expect(responsiveness.longTasks.length).toBeLessThanOrEqual(2)
  // A window that was never shown may get frames only once a second; then the timer heartbeat measures the UI thread.
  expect(responsiveness.frames >= responsiveness.elapsed / 100 ? responsiveness.frameGap : responsiveness.timerGap).toBeLessThanOrEqual(linux ? 300 : 500)
  console.log('Responsiveness passed: a million synthetic rows read through the results worker without blocking the UI.')

  step = 'reload'
  // 6. A workbench reload ends the generation with the page that owned it; the new page shows no banner.
  await page.reload()
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  const reloaded = await ready(2)
  expect(reloaded.pid).not.toBe(first.pid)
  await expect(statusBar()).toContainText('Ready')
  await expect(banner()).toHaveCount(0)

  // 8. Live: a real session is lost with its backend, nothing is re-run, and Reconnect opens a new session.
  if (process.env.VARIA_TEST_SQL_SERVER) {
    step = 'live session loss'
    let dialog = await connectDialog()
    await fillLogin(dialog, process.env.VARIA_TEST_SQL_SERVER, liveUser, process.env.VARIA_TEST_SQL_PASSWORD)
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30000 })
    await typeSql("CREATE TABLE #varia_session_marker (id int); SELECT OBJECT_ID('tempdb..#varia_session_marker') AS marker;")
    await execute().click()
    await expect(gridCell(0, 0)).not.toHaveText('NULL', { timeout: 30000 })
    await expect(gridCell(0, 0)).not.toHaveText('', { timeout: 30000 })
    await typeSql("WAITFOR DELAY '00:00:30';")
    await execute().click()
    await running()
    const before = await hooks()
    await app.evaluate(() => globalThis.__variaTest.kill())
    await expect(errorMessages(page)).toContainText(lostQuery, { timeout: 30000 })
    await expect(outputStatus(page)).toHaveText('The SQL backend stopped while this query was running.')
    const after = await ready(before.state.generation + 1)
    expect(after.pid).not.toBe(before.pid)
    await expect(banner()).toContainText('1 connection was lost and 1 running script was stopped; nothing was re-run.')
    await expect(lostServerRows(page)).toContainText('(connection lost)')
    await lostServerRows(page).getByRole('button', { name: /^Reconnect/ }).click()
    dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
    await expect(dialog.getByLabel('Server Name', { exact: true })).toHaveValue(process.env.VARIA_TEST_SQL_SERVER)
    await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('')
    if (liveUser) await dialog.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD)
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30000 })
    await expect(lostServerRows(page)).toHaveCount(0)
    // SPIDs can be reused, so the old session's temporary table shows whether the session is new.
    await typeSql("SELECT OBJECT_ID('tempdb..#varia_session_marker') AS marker;")
    await execute().click()
    await expect(gridCell(0, 0)).toHaveText('NULL', { timeout: 30000 })
    await expect(await messages()).toContainText(newSession)
    console.log('Live session loss passed: the killed backend did not re-run the script, and Reconnect opened a new session.')
  }
  await close()

  // 2, 3 and 5: a fake backend that crashes, crash-loops, and hangs on cue.
  step = 'crash during execute'
  const control = await mkdtemp(resolve('artifacts', 'backend-control-'))
  temporary.push(control)
  await mkdir(join(control, 'hold'))
  const calls = async () => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  await launch({ VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control, VARIA_BACKEND_LIVENESS_MS: '2000' })
  await expect(statusBar()).toContainText('fake · Ready')
  let dialog = await connectDialog()
  await fillLogin(dialog, 'crash-server', 'reader', 'smoke-password-marker')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(await explorerRow(page, 'crash-server')).toBeVisible()
  await typeSql('SELECT 1;')
  // The script is running when the backend crashes.
  await writeFile(join(control, 'hold', 'query.execute'), '')
  await execute().click()
  await running()
  await expect.poll(async () => (await calls()).some(call => call.method === 'query.execute')).toBe(true)
  const crashed = await hooks()
  await writeFile(join(control, 'crash-next'), '')
  await rm(join(control, 'hold', 'query.execute'))
  await expect(errorMessages(page)).toContainText(lostQuery)
  const restarted = await ready(2)
  expect(restarted.pid).not.toBe(crashed.pid)
  const history = await states()
  expect(history.slice(history.indexOf('restarting:1'))).toEqual(expect.arrayContaining(['restarting:1', 'starting:2', 'ready:2']))
  expect(history.indexOf('restarting:1')).toBeLessThan(history.indexOf('starting:2'))
  expect(await app.evaluate(() => globalThis.__variaTest.states.find(state => state.status === 'restarting')?.lost)).toEqual({ generation: 1, reason: 'crash', connections: 1, queries: 1 })
  await expect(statusBar()).toContainText('fake · Ready')
  // Object Explorer keeps the server's row, collapsed and dimmed, with Reconnect and Remove (in its menu too).
  const lostRow = lostServerRows(page)
  await expect(lostRow).toHaveAttribute('aria-label', 'crash-server (connection lost)')
  await expect(lostRow).not.toHaveAttribute('aria-expanded')
  await explorerLabel(lostRow).click({ button: 'right' })
  await expect.poll(() => menuItemNames(page.getByRole('menu', { name: 'Object Explorer', exact: true }))).toEqual(['Connect…', 'Reconnect…', 'Remove'])
  await page.keyboard.press('Escape')
  await expect(openMenus(page)).toHaveCount(0)
  // Enter on the lost row reconnects it, as its button does: the Connect dialog opens filled in from it.
  await explorerLabel(lostRow).click()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Connect', exact: true }).getByLabel('Server Name', { exact: true })).toHaveValue('crash-server')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(execute()).toBeDisabled()
  await expect(execute()).toHaveAttribute('title', lostHint)
  await expect(queryStatus(page)).toContainText('crash-server (connection lost)')
  await expect(banner()).toContainText('The SQL backend stopped unexpectedly and was restarted. 1 connection was lost and 1 running script was stopped; nothing was re-run.')
  // Nothing written to generation 1 reached generation 2, and the password never reached the call log.
  let recorded = await calls()
  expect(recorded.filter(call => call.generation === 2).map(call => call.method)).not.toContain('query.execute')
  expect(recorded.filter(call => call.method === 'query.execute').map(call => call.generation)).toEqual([1])
  expect(JSON.stringify(recorded)).not.toContain('smoke-password-marker')
  // The keyboard opens the lost row's own menu too, not the empty area's: Shift+F10 in the tree with the row selected.
  const explorerMenu = page.getByRole('menu', { name: 'Object Explorer', exact: true })
  await explorerLabel(lostRow).click()
  await expect(lostRow).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Shift+F10')
  await expect.poll(() => menuItemNames(explorerMenu)).toEqual(['Connect…', 'Reconnect…', 'Remove'])
  await page.keyboard.press('Escape')
  await expect(explorerMenu).toHaveCount(0)
  await size(1024, 700)
  await bannerInViewport()
  await page.screenshot({ path: resolve('artifacts', 'backend-restart.png') })
  await banner().getByRole('button', { name: 'Reconnect…', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(dialog.getByLabel('Server Name', { exact: true })).toHaveValue('crash-server')
  await expect(dialog.getByLabel('Login', { exact: true })).toHaveValue('reader')
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('')
  await dialog.getByLabel('Password', { exact: true }).fill('smoke-password-marker')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(lostServerRows(page)).toHaveCount(0)
  await expect(await explorerRow(page, 'crash-server')).toHaveAttribute('aria-expanded', 'true')
  await expect(queryStatus(page)).not.toContainText('connection lost')
  await expect(execute()).toBeEnabled()
  await execute().click()
  await expect(page.locator('[data-result-grid]')).toHaveAttribute('aria-rowcount', '2')
  await expect(gridCell(0, 1)).toHaveText('2')
  await expect(await messages()).toContainText(newSession)
  recorded = await calls()
  expect(recorded.filter(call => call.method === 'query.execute').map(call => call.generation)).toEqual([1, 2])
  await banner().getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(banner()).toHaveCount(0)
  console.log('Crash during execute passed: BACKEND_LOST, lost Explorer row and its menu, Execute hint, restart with a new pid, nothing re-run, and Reconnect with the new-session line.')

  // A manual restart asks first while servers are connected, and resets the breaker.
  step = 'manual restart'
  await app.evaluate(({ dialog }) => {
    globalThis.variaPrompts = []
    dialog.showMessageBox = async (_window, options) => {
      globalThis.variaPrompts.push(options.message + ' ' + options.detail)
      return { response: options.message === 'Restart the SQL backend?' ? globalThis.variaPromptResponse ?? 1 : 1, checkboxChecked: false }
    }
  })
  expect(await page.evaluate(() => window.varia.restartBackend())).toEqual({ ok: true, value: false })
  expect(await app.evaluate(() => globalThis.variaPrompts)).toEqual(['Restart the SQL backend? The connection closes and uncommitted transactions are rolled back.'])
  expect((await hooks()).state.generation).toBe(2)
  await app.evaluate(() => { globalThis.variaPromptResponse = 0 })
  expect(await page.evaluate(() => window.varia.restartBackend())).toEqual({ ok: true, value: true })
  await ready(3)
  await expect(banner()).toContainText('The SQL backend was restarted. 1 connection was closed.')
  await banner().getByRole('button', { name: 'Dismiss', exact: true }).click()

  step = 'crash loop'
  // 3. Three unexpected losses within 120 s leave the backend failed until the user restarts it.
  for (const generation of [3, 4]) {
    await ready(generation)
    await app.evaluate(() => globalThis.__variaTest.kill())
  }
  await ready(5)
  await app.evaluate(() => globalThis.__variaTest.kill())
  await expect(banner()).toContainText('The SQL backend stopped repeatedly and was not restarted again.')
  await expect(statusBar()).toContainText('SQL backend unavailable')
  await expect(statusBar()).toHaveAttribute('data-state', 'error')
  expect((await hooks()).state).toMatchObject({ status: 'failed', reason: 'crashLoop' })
  await bannerInViewport()
  await page.screenshot({ path: resolve('artifacts', 'backend-failed.png') })
  await banner().getByRole('button', { name: 'Copy details', exact: true }).click()
  await expect(banner().getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Status: failed (crashLoop)')
  await banner().getByRole('button', { name: 'Restart SQL Backend', exact: true }).click()
  await ready(6)
  // The losses stay reported until dismissed.
  await expect(banner()).toContainText('The SQL backend stopped unexpectedly and was restarted. 0 connections were lost and 0 running scripts were stopped; nothing was re-run.')
  await banner().getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(banner()).toHaveCount(0)
  console.log('Crash loop passed: the breaker tripped on the third loss in 120 s, Copy details, and Restart SQL Backend.')

  step = 'unresponsive backend'
  // 5. A backend that is alive but silent is reported, never killed; the user decides.
  const silent = await hooks()
  await writeFile(join(control, 'silent-6'), '')
  await expect(banner()).toContainText('The SQL backend is not responding.', { timeout: 20000 })
  await expect(statusBar()).toContainText('SQL backend not responding…')
  await page.waitForTimeout(3000)
  expect(await hooks()).toMatchObject({ pid: silent.pid, state: { status: 'unresponsive', generation: 6 } })
  await rm(join(control, 'silent-6'))
  await expect(banner()).toHaveCount(0, { timeout: 20000 })
  expect((await hooks()).state).toMatchObject({ status: 'ready', generation: 6 })
  await writeFile(join(control, 'silent-6'), '')
  await expect(banner()).toContainText('The SQL backend is not responding.', { timeout: 20000 })
  await bannerInViewport()
  await banner().getByRole('button', { name: 'Restart now', exact: true }).click()
  const replaced = await ready(7)
  expect(replaced.pid).not.toBe(silent.pid)
  await expect(banner()).toHaveCount(0)
  console.log('Unresponsive backend passed: warned, never killed, recovered on its own, and replaced on Restart now.')
  expect(failures).toEqual([])

  step = 'quit'
  // Quitting stops every backend before the app exits, and starts no other. Restart now has just replaced a backend that
  // cannot act on stdin EOF (as a wedged one cannot), and the app quits at once: it must still wait for main to kill it.
  const spawns = async () => (await readFile(join(control, 'spawns.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).pid)
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const wedged = await hooks()
  orphans.push(wedged.pid)
  await writeFile(join(control, `ignore-eof-${wedged.state.generation}`), '')
  const spawnedBefore = await spawns()
  await page.evaluate(() => { void window.varia.restartBackend() })
  // The next generation (which exits on EOF) is running, so quitting now waits only for the replaced one.
  await expect.poll(async () => (await spawns()).length).toBe(spawnedBefore.length + 1)
  const spawnedAtQuit = await spawns()
  await close()
  await expect.poll(() => alive(wedged.pid), { timeout: 3000 }).toBe(false)
  expect(await spawns()).toEqual(spawnedAtQuit)
  console.log('Quit passed: the backend Restart now replaced was killed before the app exited, and no backend was started while quitting.')

  step = 'relaunch while quitting'
  // While the app waits to kill a backend that ignores EOF (2 s, then a kill) it has no window, so it gives up the
  // single-instance lock: a relaunch then opens a window instead of being handed to the quitting app and dropped.
  const quitControl = await mkdtemp(resolve('artifacts', 'backend-control-'))
  temporary.push(quitControl)
  await writeFile(join(quitControl, 'ignore-eof'), '')
  const profile = await launch({ VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: quitControl })
  const stuck = await ready(1)
  orphans.push(stuck.pid)
  const quitting = app
  app = undefined
  await quitting.evaluate(({ app, dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); app.quit() })
  const lock = () => quitting.evaluate(({ app }) => app.hasSingleInstanceLock() ? 'held' : 'released').catch(() => 'exited')
  await expect.poll(lock, { timeout: 10000, intervals: [50] }).toBe('released')
  await launch({ VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }, profile)
  await expect(statusBar()).toContainText('fake · Ready')
  await expect.poll(() => alive(stuck.pid), { timeout: 5000 }).toBe(false)
  await Promise.race([quitting.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))])
  await close()
  console.log('Relaunch while quitting passed: the quitting app released the single-instance lock, and the relaunch opened its window.')

  step = 'incompatible backend'
  // 4. A protocol 1 backend is detected from its JSON answer to the handshake, at once.
  const started = Date.now()
  await launch({ VARIA_TEST_BACKEND: 'v1', VARIA_TEST_NODE: process.execPath })
  await expect(banner()).toContainText('The SQL backend is from a different build (protocol 1, expected 2). Run npm run backend:build, then restart.', { timeout: 5000 })
  console.log(`Incompatible backend reported ${Date.now() - started} ms after launch.`)
  expect((await hooks()).state).toMatchObject({ status: 'failed', reason: 'incompatible' })
  await expect(toolbarButton(page, 'Connect')).toBeDisabled()
  expect(failures).toEqual([])
  console.log('Backend restart checks passed: real readiness and reload, crash during execute with Reconnect, manual restart prompt, crash loop, unresponsive warning, and incompatible build.')
} catch (error) {
  // CI keeps screenshots only as artifacts, so the log names the step, main's backend states, and the banner.
  let timer
  const settled = new Promise(resolve => { timer = setTimeout(resolve, 3000, 'no answer') })
  const report = async () => ({ step, states: await states().catch(() => 'unavailable'), banner: await banner().allTextContents().catch(() => 'unavailable') })
  console.log(await Promise.race([report(), settled]))
  clearTimeout(timer)
  throw error
} finally {
  await close()
  for (const pid of orphans) { try { process.kill(pid, 'SIGKILL') } catch { /* Already gone, as it should be. */ } }
  clearTimeout(watchdog)
  for (const path of temporary) await rm(path, { recursive: true, force: true })
}
