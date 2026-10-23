import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { expandExplorerPath, explorerLines, explorerRow, explorerTree } from './fixtures/explorer-tree.mjs'
import { explorerStubData, installExplorerStub } from './fixtures/explorer-stub.mjs'
import { backendReady, documentTabs, editorText as editorTextOf, errorMessages, explorerLabel, explorerToolbar, messages, outputView, paneMenuButton, part, quickInput, serverRows, toolbarButton as mainToolbarButton } from './fixtures/ui.mjs'

// Same rules as the backend live checks: SQL authentication when a test login is supplied, otherwise Windows authentication.
const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (process.env.VARIA_TEST_SQL_SERVER && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')
await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'explorer-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
// No renderer task may block for this long while Object Explorer streams, scrolls, searches, expands or refreshes.
const longTaskLimit = process.platform === 'win32' ? 100 : 50
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Object Explorer suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 420000)

async function launch() {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  // Unsaved queries make exit ask first; answer Don't Save.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
}
const stubCalls = (method = 'explorer.children') => application.evaluate((_electron, name) => globalThis.variaStub.calls.filter(call => call.method === name).map(call => call.params), method)
const setStub = values => application.evaluate((_electron, changes) => { Object.assign(globalThis.variaStub, changes) }, values)
const cancels = () => application.evaluate(() => globalThis.variaStub.cancels)
const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText())
const tree = () => explorerTree(page)
const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const editorText = () => editorTextOf(page)
const tabs = () => documentTabs(page).getByRole('tab')
const toolbarButton = name => explorerToolbar(page).getByRole('button', { name, exact: true })
const menu = name => page.getByRole('menu', { name, exact: true })
const isFolder = (params, folder) => params.node.type === 'folder' && params.node.folder === folder
/** The row `aria-activedescendant` names, as a screen reader finds it. */
const active = () => page.evaluate(text => {
  const id = document.querySelector('[data-explorer-tree]')?.getAttribute('aria-activedescendant')
  const row = id ? document.getElementById(id) : null
  return row && { id, label: row.querySelector(text)?.textContent ?? '', selected: row.getAttribute('aria-selected'), level: Number(row.getAttribute('aria-level')), expanded: row.getAttribute('aria-expanded') }
}, part.explorerRowText)
/** Presses a key in the tree, waits for the selection to land on `label`, and checks the active row is the selected one. */
async function press(key, label) {
  await page.keyboard.press(key)
  if (label !== undefined) await expect.poll(async () => (await active())?.label, { message: `${key} selects ${label}` }).toBe(label)
  expect((await active())?.selected).toBe('true')
}
/** Clicks a row's label, which selects it and focuses the tree without toggling it. */
async function select(...path) {
  const row = await explorerRow(page, ...path)
  await row.locator(part.explorerRowText).first().click()
  await expect(tree()).toBeFocused()
  await expect.poll(async () => (await active())?.id).toBe(await row.getAttribute('id'))
  return row
}
/** Connects from the main toolbar, or with `keyboard` from the empty state's Connect button by Enter, submitting by Enter. */
async function connect(server, { keyboard = false } = {}) {
  if (keyboard) {
    await page.getByRole('button', { name: 'Connect to server', exact: true }).focus()
    await page.keyboard.press('Enter')
  } else await mainToolbarButton(page, 'Connect').click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  if (server === process.env.VARIA_TEST_SQL_SERVER && liveUser) {
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await dialog.getByLabel('Login', { exact: true }).fill(liveUser)
    await dialog.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD)
  } else await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  if (server === process.env.VARIA_TEST_SQL_SERVER) await dialog.getByLabel('Trust server certificate', { exact: true }).check()
  if (keyboard) {
    await dialog.getByLabel('Server Name', { exact: true }).focus()
    await page.keyboard.press('Enter')
  } else await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30000 })
}
/** Records renderer long tasks (50 ms or more, the shortest Chromium reports) from now on, by the phase they fell in. */
const startLongTasks = () => page.evaluate(() => {
  window.__variaLongTasks?.observer.disconnect()
  const record = { entries: [], phases: [['start', performance.now()]], observer: new PerformanceObserver(list => { for (const entry of list.getEntries()) record.entries.push([entry.startTime, Math.round(entry.duration)]) }) }
  record.observer.observe({ type: 'longtask' })
  window.__variaLongTasks = record
})
const phase = name => page.evaluate(value => { window.__variaLongTasks.phases.push([value, performance.now()]) }, name)
/** Each long task as `{ phase, ms }`. */
const longTasks = () => page.evaluate(() => {
  const { entries, phases } = window.__variaLongTasks
  return entries.map(([start, ms]) => ({ phase: phases.filter(([, at]) => at <= start).at(-1)[0], ms }))
})
const renderedRows = () => explorerTree(page).getByRole('treeitem').count()
/** Rendered rows that show inside the tree's scrolled view. */
const rowsInView = () => page.evaluate(() => {
  const tree = document.querySelector('[data-explorer-tree]'), box = tree.getBoundingClientRect()
  return [...tree.querySelectorAll('[role="treeitem"]')].filter(row => { const rect = row.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom }).length
})
const liveRegion = () => page.locator('[data-explorer-tree] + [role="status"]')
/** The enabled toolbar buttons' names, in order, and the focused one's. */
const enabledTools = () => explorerToolbar(page).evaluate(toolbar => [...toolbar.querySelectorAll('button:not(:disabled)')].map(button => button.getAttribute('aria-label')))
const focusedTool = () => page.evaluate(toolbar => document.activeElement?.closest(toolbar) ? document.activeElement.getAttribute('aria-label') : null, part.explorerToolbar)
/** Waits until Object Explorer has nothing loading or queued (the tree's aria-busy). */
const idle = (timeout = 30000) => expect(tree()).toHaveAttribute('aria-busy', 'false', { timeout })
/** Whether the row `aria-activedescendant` names is inside the tree's scrolled view. */
const activeInView = () => page.evaluate(() => {
  const tree = document.querySelector('[data-explorer-tree]'), row = document.getElementById(tree.getAttribute('aria-activedescendant') ?? '')
  if (!row) return false
  const box = tree.getBoundingClientRect(), rect = row.getBoundingClientRect()
  return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
})
/** The labels of the rendered children of the row at `path`, in order. */
const childLabels = (...path) => page.evaluate(({ path, part }) => {
  const rows = [...document.querySelectorAll(part.explorerTree + ' [role="treeitem"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  const stack = [], children = []
  let inside = false
  for (const row of rows) {
    const level = Number(row.getAttribute('aria-level')), label = row.querySelector(part.explorerRowText)?.textContent ?? ''
    if (inside && level <= path.length) break
    if (inside && level === path.length + 1) children.push(label)
    stack.length = level - 1
    stack[level - 1] = label
    if (!inside && level === path.length && path.every((name, index) => stack[index] === name)) inside = true
  }
  return children
}, { path, part })
/**
 * Presses F5 on the selected folder (`folder` at `path`) and waits until its refreshed rows have replaced the old ones:
 * its first page was requested and the folder lists exactly `objects` (its rows that are not static folders). Until
 * then, a row found by its path may be an old one that the first page is about to replace.
 */
async function refreshTo(folder, path, objects) {
  const from = (await stubCalls()).length
  await press('F5')
  await expect.poll(async () => (await stubCalls()).slice(from).some(params => isFolder(params, folder) && !params.cursor)).toBe(true)
  await idle()
  await expect.poll(async () => (await childLabels(...path)).filter(label => label.startsWith('dbo.'))).toEqual(objects)
}
/** Reloads a selected folder from its first page: F5 when it is expanded, else expanding it (F5 on a collapsed folder only forgets its rows). */
async function reload(...path) {
  const row = await select(...path)
  await press(await row.getAttribute('aria-expanded') === 'true' ? 'F5' : 'ArrowRight')
}

try {
  await launch()
  await application.evaluate(installExplorerStub, explorerStubData())
  await expect(page.getByText('Connect to SQL Server to browse databases and objects.')).toBeVisible()

  // 1. One focusable ARIA tree: a new server is expanded, its folders are collapsed, and nothing below them is loaded.
  // Connecting the first server by keyboard from the empty state moves focus to the tree, which replaced the button.
  await connect('server-a', { keyboard: true })
  await expect(tree()).toBeFocused()
  const serverA = await explorerRow(page, 'server-a')
  await expect(serverA).toHaveAttribute('aria-level', '1')
  await expect(serverA).toHaveAttribute('aria-expanded', 'true')
  await expect(serverA).toHaveAttribute('aria-label', 'server-a (SQL Server 16.0.4135.4 - sa)')
  for (const label of ['Databases', 'Security', 'Server Objects']) await expect(await explorerRow(page, 'server-a', label)).toHaveAttribute('aria-expanded', 'false')
  expect((await stubCalls()).map(params => params.node)).toEqual([{ type: 'object', object: { kind: 'server' } }])
  await expect(tree()).toHaveAttribute('tabindex', '0')
  await tree().focus()
  expect(await active()).toMatchObject({ label: 'server-a', selected: 'true', level: 1, expanded: 'true' })
  await connect('server-b')
  await expect(await explorerRow(page, 'server-b')).toHaveAttribute('aria-expanded', 'true')
  console.log('Object Explorer checks: the ARIA tree, focused after the first server is connected by keyboard, two servers expanded on connect, and nothing loaded below their folders.')

  // 2. The Windows tree's keys, type-ahead, and `*`.
  await select('server-a')
  await press('ArrowDown', 'Databases')
  await press('ArrowRight', 'Databases')
  await expect(await explorerRow(page, 'server-a', 'Databases')).toHaveAttribute('aria-expanded', 'true')
  await expect(await explorerRow(page, 'server-a', 'Databases', 'System Databases')).toBeVisible()
  await press('ArrowRight', 'System Databases')
  await press('ArrowLeft', 'Databases')
  await press('ArrowLeft', 'Databases')
  await expect(await explorerRow(page, 'server-a', 'Databases')).toHaveAttribute('aria-expanded', 'false')
  await press('NumpadAdd', 'Databases')
  await expect(await explorerRow(page, 'server-a', 'Databases')).toHaveAttribute('aria-expanded', 'true')
  await press('NumpadSubtract', 'Databases')
  await expect(await explorerRow(page, 'server-a', 'Databases')).toHaveAttribute('aria-expanded', 'false')
  await press('End', 'Server Objects')
  expect((await active()).level).toBe(2)
  await press('Home', 'server-a')
  await press('PageDown', 'Server Objects')
  await press('PageUp', 'server-a')
  await page.keyboard.type('sec')
  await expect.poll(async () => (await active())?.label).toBe('Security')
  // After a pause the buffer starts again: one letter moves to the next row that starts with it, and repeats cycle.
  await page.waitForTimeout(1100)
  await press('s', 'Server Objects')
  await press('s', 'server-b')
  expect((await stubCalls()).some(params => isFolder(params, 'serverSecurity'))).toBe(false)
  await select('server-a', 'Databases')
  await press('*', 'Databases')
  for (const label of ['Databases', 'Security', 'Server Objects']) await expect(await explorerRow(page, 'server-a', label)).toHaveAttribute('aria-expanded', 'true')
  // Security's folders were requested only now, when `*` expanded it.
  expect((await stubCalls()).filter(params => isFolder(params, 'serverSecurity'))).toHaveLength(1)
  // A folder that fails shows why as a row; Enter retries once the cause is gone.
  await select('server-a', 'Security', 'Audits')
  await press('ArrowRight')
  const auditsError = 'You do not have permission to view Audits. Press Enter to retry.'
  await expect(await explorerRow(page, 'server-a', 'Security', 'Audits', auditsError)).toBeVisible()
  await press('ArrowDown', auditsError)
  // The live region says why; a retry that fails again says it again, as a new node, so screen readers repeat it.
  const auditsSentence = 'Could not load Audits: You do not have permission to view Audits.'
  await expect(liveRegion()).toHaveText(auditsSentence)
  await page.evaluate(() => {
    window.__variaLiveChanges = 0
    new MutationObserver(records => { window.__variaLiveChanges += records.length }).observe(document.querySelector('[data-explorer-tree] + [role="status"]'), { childList: true, subtree: true, characterData: true })
  })
  await press('Enter')
  await expect.poll(() => page.evaluate(() => window.__variaLiveChanges)).toBeGreaterThan(0)
  await expect(liveRegion()).toHaveText(auditsSentence)
  await select('server-a', 'Security', 'Audits', auditsError)
  await setStub({ auditsOk: true })
  await press('Enter')
  await expect(await explorerRow(page, 'server-a', 'Security', 'Audits', 'LoginAudit')).toBeVisible()
  console.log('Object Explorer checks: arrows, Home, End, Page Up and Down, Numpad plus and minus, type-ahead with cycling, *, and Enter on an error row, announced again when it fails again.')

  // 3. Lazy loading and cancellation: collapsing a folder whose load is running cancels it in the backend.
  await select('server-a', 'Server Objects', 'Linked Servers')
  const linkedCalls = async () => (await stubCalls()).filter(params => isFolder(params, 'linkedServers'))
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await linkedCalls()).length).toBe(1)
  const [held] = await linkedCalls()
  await expect.poll(cancels).toContain(held.requestId)
  await expect(await explorerRow(page, 'server-a', 'Server Objects', 'Linked Servers')).toHaveAttribute('aria-expanded', 'false')
  await press('ArrowRight')
  await expect.poll(async () => (await linkedCalls()).length).toBe(2)
  expect((await linkedCalls())[1].requestId).not.toBe(held.requestId)
  await application.evaluate(() => globalThis.variaStub.release())
  await expect(await explorerRow(page, 'server-a', 'Server Objects', 'Linked Servers', 'REMOTE1')).toBeVisible()
  // Stop during streaming: the folder says how far it got, and Enter on that row continues. Small, slow pages keep the
  // folder's last row in view.
  await setStub({ pageDelayMs: 1000, pageSize: 5 })
  await expandExplorerPath(page, 'server-a', 'Databases', 'AppData', 'Tables')
  await expect(explorerTree(page).getByRole('treeitem', { name: /^Loading… \d+ of 120,005$/ })).toBeVisible()
  await expect(toolbarButton('Stop')).toBeEnabled()
  await toolbarButton('Stop').click()
  const stopped = explorerTree(page).getByRole('treeitem', { name: /^Stopped after \d+ of 120,005 items\. Press Enter to continue loading\.$/ })
  await expect(stopped).toBeVisible()
  await expect(toolbarButton('Stop')).toBeDisabled()
  const before = (await stubCalls()).length
  await stopped.click()
  await press('Enter')
  await expect.poll(async () => (await stubCalls()).length).toBeGreaterThan(before)
  await expect(explorerTree(page).locator(part.explorerProgressRow)).toBeVisible()
  // Stop by keyboard: it disables itself, and focus moves on to the next enabled button instead of the page.
  await expect(tree()).toBeFocused()
  // The header's ⋯ button sits between the toolbar and the tree.
  await page.keyboard.press('Shift+Tab')
  await expect(paneMenuButton(page, 'explorer')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  for (let step = 0; step < 6 && await focusedTool() !== 'Stop'; step++) await page.keyboard.press('ArrowRight')
  expect(await focusedTool()).toBe('Stop')
  await page.keyboard.press('Enter')
  await expect(stopped).toBeVisible()
  await expect(toolbarButton('Stop')).toBeDisabled()
  await expect.poll(focusedTool).toBe('Filter Settings')
  await page.keyboard.press('Tab')
  await expect(paneMenuButton(page, 'explorer')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(tree()).toBeFocused()
  console.log('Object Explorer checks: folders load only when expanded, collapsing cancels a running load, Stop (by mouse and by keyboard, which keeps focus in the toolbar) shows how far a folder got, and Enter continues.')

  // 4. F5 in the tree refreshes the selected folder once; what was expanded below it comes back collapsed.
  await setStub({ pageDelayMs: 0, pageSize: 2000, tables: 3 })
  await select('server-a', 'Databases', 'AppData', 'Tables')
  await refreshTo('tables', ['server-a', 'Databases', 'AppData', 'Tables'], ['dbo.Orders', 'dbo.table1', 'dbo.table2'])
  await expect(explorerTree(page).locator(part.explorerSyntheticRow)).toHaveCount(0)
  await expandExplorerPath(page, 'server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders')
  await select('server-a', 'Databases', 'AppData', 'Tables')
  const refreshedFrom = (await stubCalls()).length
  await press('F5', 'Tables')
  await expect.poll(async () => (await stubCalls()).slice(refreshedFrom).map(params => params.node)).toEqual([{ type: 'folder', owner: { kind: 'database', name: 'AppData' }, folder: 'tables' }])
  await expect.poll(async () => (await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders')).getAttribute('aria-expanded')).toBe('false')
  await page.waitForTimeout(200)
  expect((await stubCalls()).length).toBe(refreshedFrom + 1)
  // F5 in the query editor still executes the query.
  const executed = (await stubCalls('query.execute')).length
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT 1')
  await page.keyboard.press('F5')
  await expect.poll(async () => (await stubCalls('query.execute')).length).toBe(executed + 1)
  console.log('Object Explorer checks: F5 refreshes the selected folder with one request and brings its descendants back collapsed; F5 in the editor executes.')

  // 5. Speed: stream 120,000 tables, scroll, End and Home, type-ahead, `*` over 10,000 views, and refresh 2,000 tables.
  const perf = { limitMs: longTaskLimit, attempts: [] }
  async function speedSegment() {
    // A hidden window draws about once a second, so scrolling would never re-window the tree: show it, without focus.
    // It stays shown: hiding it again would stop the frames later screenshots wait for.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    await startLongTasks()
    let rows = 0, jumps = []
    await setStub({ tables: 120_000 })
    await tree().focus()
    await press('Home', 'server-a')
    await phase('stream 120,000 tables')
    await reload('server-a', 'Databases', 'AppData', 'Tables')
    // The folder stops at 100,000 children and says how to narrow it.
    const capped = explorerTree(page).getByRole('treeitem', { name: 'Showing the first 100,000 of 120,005 items in Tables. Use Filter Settings to narrow the list.', exact: true })
    await idle(60000)
    await expect.poll(async () => (await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Tables')).getAttribute('aria-expanded')).toBe('true')
    await phase('scroll')
    // Each jump waits for the rows in view, so the re-windowing happens while long tasks are observed.
    jumps = await page.evaluate(async () => {
      const element = document.querySelector('[data-explorer-tree]'), counts = []
      const inView = () => { const box = element.getBoundingClientRect(); return [...element.querySelectorAll('[role="treeitem"]')].filter(row => { const rect = row.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom }).length }
      for (let jump = 1; jump <= 20; jump++) {
        element.scrollTop = element.scrollHeight * ((jump * 7919) % 20) / 20
        const deadline = performance.now() + 3000
        do await new Promise(resolve => requestAnimationFrame(() => resolve()))
        while (inView() < 5 && performance.now() < deadline)
        counts.push(inView())
      }
      return counts
    })
    rows = Math.max(rows, await renderedRows())
    // Enter on the capped row opens Filter Settings for its folder.
    await phase('capped row')
    await page.evaluate(() => {
      const element = document.querySelector('[data-explorer-tree]')
      element.scrollTop = (6 + 100_000) * 22 - element.clientHeight / 2
    })
    // It is not aria-disabled: Enter acts on it. Escape returns to it, still in view.
    expect(await capped.getAttribute('aria-disabled')).toBeNull()
    await capped.click()
    await press('Enter')
    const cappedDialog = page.getByRole('dialog', { name: 'Filter Settings – Tables', exact: true })
    await expect(cappedDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(cappedDialog).toHaveCount(0)
    await expect(tree()).toBeFocused()
    await expect.poll(async () => (await active())?.label).toBe('Showing the first 100,000 of 120,005 items in Tables. Use Filter Settings to narrow the list.')
    expect(await activeInView()).toBe(true)
    await phase('End and Home')
    await press('End')
    await expect.poll(async () => (await active())?.label).toBe('Server Objects')
    expect((await active()).level).toBe(2)
    await expect.poll(rowsInView).toBeGreaterThan(5)
    rows = Math.max(rows, await renderedRows())
    await press('Home', 'server-a')
    await expect.poll(rowsInView).toBeGreaterThan(5)
    await phase('type-ahead')
    await page.keyboard.type('table119')
    await expect.poll(async () => (await active())?.label).toBe('dbo.table119')
    rows = Math.max(rows, await renderedRows())
    // Left moves to Tables and collapses it (its 100,000 rows stay loaded), so Views comes into view.
    await phase('collapse Tables')
    await press('ArrowLeft', 'Tables')
    await press('ArrowLeft', 'Tables')
    // `*` on one of 10,000 views expands 50 of them (a request each) and skips the rest.
    const viewsFrom = (await stubCalls()).length
    await phase('load 10,000 views')
    await reload('server-a', 'Databases', 'AppData', 'Views')
    await expect.poll(async () => (await stubCalls()).slice(viewsFrom).filter(params => isFolder(params, 'views')).length, { timeout: 30000 }).toBe(5)
    await idle()
    await select('server-a', 'Databases', 'AppData', 'Views', 'dbo.view0')
    const starFrom = (await stubCalls()).length
    await phase('* over 10,000 views')
    await press('*', 'dbo.view0')
    // Views' two static subfolders are siblings too: 48 views and both folders.
    await expect.poll(async () => (await stubCalls()).slice(starFrom).length).toBe(50)
    await idle()
    await page.waitForTimeout(200)
    expect((await stubCalls()).slice(starFrom).filter(params => params.node.type === 'object' && params.node.object.kind === 'view')).toHaveLength(48)
    rows = Math.max(rows, await renderedRows())
    // Refreshing a folder of 100,000 rows to 2,000: the old rows are deleted in slices.
    await setStub({ tables: 1995 })
    await select('server-a', 'Databases', 'AppData', 'Tables')
    await phase('expand 100,000 tables')
    await press('ArrowRight')
    const refreshFrom = (await stubCalls()).length
    await phase('refresh to 2,000 tables')
    await press('F5')
    await expect.poll(async () => (await stubCalls()).slice(refreshFrom).filter(params => isFolder(params, 'tables')).length).toBe(1)
    await idle()
    await expect(await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Tables', 'dbo.table5')).toBeVisible()
    rows = Math.max(rows, await renderedRows())
    const tasks = await longTasks()
    return { maxLongTaskMs: Math.max(0, ...tasks.map(task => task.ms)), longTasks: tasks, maxRenderedRows: rows, rowsInViewPerJump: jumps }
  }
  perf.attempts.push(await speedSegment())
  // A shared runner can stall one task (garbage collection, another process); the segment runs again once.
  if (perf.attempts[0].maxLongTaskMs >= longTaskLimit) perf.attempts.push(await speedSegment())
  await writeFile(resolve('artifacts', 'explorer-perf.json'), JSON.stringify(perf, null, 2) + '\n')
  const last = perf.attempts.at(-1)
  expect(last.maxLongTaskMs, `renderer long tasks: ${perf.attempts.map(attempt => attempt.longTasks.map(task => `${task.ms} ms (${task.phase})`).join(', ') || 'none').join(' / ')}`).toBeLessThan(longTaskLimit)
  for (const attempt of perf.attempts) expect(attempt.maxRenderedRows).toBeLessThanOrEqual(80)
  // Every scroll jump drew rows where it landed, so the long-task limit covered real re-windowing.
  for (const attempt of perf.attempts) expect(Math.min(...attempt.rowsInViewPerJump), JSON.stringify(attempt.rowsInViewPerJump)).toBeGreaterThanOrEqual(5)
  console.log(`Object Explorer checks: 120,000 tables capped at 100,000, 20 scroll jumps, End, Home, type-ahead, * over 10,000 views (50 requests), and a 2,000-table refresh with the longest task ${last.maxLongTaskMs} ms and at most ${Math.max(...perf.attempts.map(attempt => attempt.maxRenderedRows))} rows in the DOM.`)

  // 6. Filter Settings from the toolbar narrows a folder; Remove Filter from its menu restores it.
  await setStub({ tables: 3 })
  await select('server-a', 'Databases', 'AppData', 'Tables')
  // Space does nothing, as in the Windows tree, rather than scrolling Tables' 2,000 rows a page past the selection.
  const scrollTop = () => page.evaluate(() => document.querySelector('[data-explorer-tree]').scrollTop)
  const top = await scrollTop()
  await page.keyboard.press('Space')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await scrollTop()).toBe(top)
  expect(await active()).toMatchObject({ label: 'Tables', selected: 'true' })
  expect(await activeInView()).toBe(true)
  await refreshTo('tables', ['server-a', 'Databases', 'AppData', 'Tables'], ['dbo.Orders', 'dbo.table1', 'dbo.table2'])
  await expect(toolbarButton('Filter Settings')).toBeEnabled()
  await toolbarButton('Filter Settings').click()
  const filterDialog = page.getByRole('dialog', { name: 'Filter Settings – Tables', exact: true })
  await expect(filterDialog).toBeVisible()
  await expect(filterDialog.getByLabel('Name value', { exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(filterDialog).toHaveCount(0)
  await expect(tree()).toBeFocused()
  const filterFrom = (await stubCalls()).length
  await toolbarButton('Filter Settings').click()
  await expect(filterDialog.getByLabel('Name operator', { exact: true })).toHaveValue('contains')
  await filterDialog.getByLabel('Creation Date operator', { exact: true }).selectOption('between')
  await filterDialog.getByLabel('Creation Date', { exact: true }).fill('2026-02-01')
  await filterDialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(filterDialog.getByText('Enter the second date.')).toBeVisible()
  await expect(filterDialog.getByLabel('Creation Date, second date', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await page.screenshot({ path: resolve('artifacts', 'explorer-filter.png') })
  await filterDialog.getByLabel('Creation Date', { exact: true }).fill('')
  await filterDialog.getByLabel('Name value', { exact: true }).fill('Ord')
  await page.keyboard.press('Enter')
  await expect(filterDialog).toHaveCount(0)
  await expect(tree()).toBeFocused()
  await expect.poll(async () => (await active())?.label).toBe('Tables')
  expect(await activeInView()).toBe(true)
  await expect.poll(async () => (await stubCalls()).slice(filterFrom).map(params => params.filter)).toEqual([{ name: { op: 'contains', value: 'Ord' } }])
  const tablesRow = await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Tables')
  await expect(tablesRow).toHaveAttribute('aria-label', 'Tables (filtered)')
  await expect(tablesRow.locator(part.explorerFiltered)).toHaveText('(filtered)')
  await expect(toolbarButton('Filter Settings').locator('.codicon-filter-filled')).toHaveCount(1)
  // The filtered first page replaces the old rows, dbo.Orders's included.
  await expect.poll(async () => (await childLabels('server-a', 'Databases', 'AppData', 'Tables')).filter(label => label.startsWith('dbo.'))).toEqual(['dbo.Orders'])
  await expect(await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders')).toBeVisible()
  await tablesRow.click({ button: 'right' })
  await menu('Object Explorer').getByRole('menuitem', { name: 'Remove Filter', exact: true }).click()
  await expect(tablesRow).toHaveAttribute('aria-label', 'Tables')
  await expect.poll(async () => (await stubCalls()).at(-1)).toMatchObject({ node: { type: 'folder', folder: 'tables' } })
  expect((await stubCalls()).at(-1)).not.toHaveProperty('filter')
  await expect(await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Tables', 'dbo.table2')).toBeVisible()
  console.log('Object Explorer checks: Space keeps the selection in view; Filter Settings from the toolbar (Escape cancels, a missing date is explained, Enter applies and keeps the folder in view), the (filtered) marker, and Remove Filter from the menu.')

  // 7. Dragging a table into the query inserts its quoted name as one undo step; Dockview shows no drop overlay.
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await expect.poll(editorText).toBe('')
  await page.evaluate(() => {
    window.__variaDockOverlay = false
    const observer = new MutationObserver(() => { if (document.querySelector('.dv-drop-target, .dv-drop-target-dropzone')) window.__variaDockOverlay = true })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    window.__variaDockObserver = observer
  })
  const orders = await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders')
  await expect(orders).toHaveAttribute('draggable', 'true')
  await expect(await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Tables')).not.toHaveAttribute('draggable', 'true')
  await orders.dragTo(page.locator('.monaco-editor .view-lines'), { targetPosition: { x: 20, y: 8 } }).catch(() => {})
  let dragged = 'dragTo'
  const dropped = await expect.poll(editorText, { timeout: 3000 }).toContain('[dbo].[Orders]').then(() => true, () => false)
  if (!dropped) {
    // Where the platform's drag does not reach the page, the same events with a real DataTransfer.
    dragged = 'synthetic DragEvent'
    await page.evaluate(id => {
      const row = document.getElementById(id), target = document.querySelector('.monaco-editor .view-lines')
      const box = target.getBoundingClientRect(), at = { clientX: box.left + 20, clientY: box.top + 8, bubbles: true, cancelable: true }
      const dataTransfer = new DataTransfer()
      row.dispatchEvent(new DragEvent('dragstart', { ...at, dataTransfer }))
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { ...at, dataTransfer }))
      row.dispatchEvent(new DragEvent('dragend', { ...at, dataTransfer }))
    }, await orders.getAttribute('id'))
  }
  await expect.poll(editorText).toBe('[dbo].[Orders]')
  await expect(textbox()).toBeFocused()
  expect(await page.evaluate(() => { window.__variaDockObserver.disconnect(); return window.__variaDockOverlay })).toBe(false)
  await page.keyboard.press('Control+Z')
  await expect.poll(editorText).toBe('')
  console.log(`Object Explorer checks: dragging dbo.Orders into the editor (${dragged}) inserts [dbo].[Orders] as one undo step, with no docking overlay.`)

  // 8. Ctrl+C in the tree copies the selected node's name.
  await expandExplorerPath(page, 'server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders', 'Columns')
  const id = await select('server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders', 'Columns', 'Id')
  await expect(id).toHaveAttribute('aria-label', 'Id (PK, int, not null)')
  await application.evaluate(({ clipboard }) => clipboard.writeText('before'))
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe('[Id]')
  // A fully loaded Columns folder copies (and drags) its column list.
  const columnsFolder = await select('server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders', 'Columns')
  await page.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe('[Id], [CustomerName]')
  // So does Copy Name in its menu.
  await application.evaluate(({ clipboard }) => clipboard.writeText('before'))
  await columnsFolder.click({ button: 'right' })
  await menu('Object Explorer').getByRole('menuitem', { name: 'Copy Name', exact: true }).click()
  await expect.poll(clipboard).toBe('[Id], [CustomerName]')
  console.log('Object Explorer checks: Ctrl+C copies a column\'s quoted name, and Ctrl+C and Copy Name a loaded Columns folder\'s list.')

  // 9. An offline database is listed, dimmed, with no chevron.
  await select('server-a', 'Databases', 'AppData')
  await press('ArrowLeft', 'AppData')
  const legacy = await explorerRow(page, 'server-a', 'Databases', 'Legacy')
  expect(await legacy.getAttribute('aria-expanded')).toBeNull()
  await expect(legacy).toHaveAttribute('aria-label', 'Legacy (Offline), unavailable')
  await expect(legacy.locator(part.explorerBadge)).toHaveAttribute('data-badge', 'unavailable')
  // Forced colors keep it dimmed (GrayText), unlike AppData.
  const labelColor = path => explorerRow(page, ...path).then(row => explorerLabel(row).evaluate(label => getComputedStyle(label).color))
  await page.emulateMedia({ forcedColors: 'active' })
  const dimmedColor = await labelColor(['server-a', 'Databases', 'Legacy']), plainColor = await labelColor(['server-a', 'Databases', 'AppData'])
  await page.emulateMedia({ forcedColors: null })
  expect(dimmedColor).not.toBe(plainColor)
  // Screen readers hear the name once: the description is the tooltip without it.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Accessibility.enable')
  const items = (await cdp.send('Accessibility.getFullAXTree')).nodes.filter(node => node.role?.value === 'treeitem').map(node => ({ name: node.name?.value ?? '', description: node.description?.value ?? '' }))
  await cdp.detach()
  expect(items.find(item => item.name === 'Legacy (Offline), unavailable')?.description).toMatch(/^Database\s+The database is not available\./)
  expect(items.filter(item => item.description && item.description.startsWith(item.name.replace(/,.*$/, '')))).toEqual([])
  console.log('Object Explorer checks: an offline database is dimmed without a chevron, in forced colors too, and rows describe themselves without repeating their names.')

  // 10. Ctrl+N in the tree opens a query on the selected database; F8 returns to the tree; the palette lists Filter Settings.
  await select('server-a', 'Databases', 'AppData')
  const tabCount = await tabs().count()
  await page.keyboard.press('Control+N')
  await expect(tabs()).toHaveCount(tabCount + 1)
  await expect(page.locator('#query-database')).toHaveValue('AppData')
  await textbox().focus()
  await page.keyboard.press('F8')
  await expect(tree()).toBeFocused()
  if (process.platform !== 'darwin') {
    await page.keyboard.press('F1')
    const palette = page.getByRole('combobox', { name: 'Command Palette', exact: true })
    await expect(palette).toBeFocused()
    await page.keyboard.type('filter settings')
    await expect(quickInput(page).getByRole('option', { name: /^Object Explorer: Filter Settings…/ })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(tree()).toBeFocused()
  }
  // The toolbar is one tab stop: Shift+Tab from the tree reaches it past the header's ⋯ button, the arrows, Home and End
  // move between its enabled buttons (wrapping), Tab goes on to ⋯ and then the tree, and the toolbar remembers the button
  // last used.
  await tree().focus()
  await page.keyboard.press('Shift+Tab')
  await expect(paneMenuButton(page, 'explorer')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  const tools = await enabledTools(), first = tools.indexOf(await focusedTool())
  expect(first).toBeGreaterThanOrEqual(0)
  expect(await explorerToolbar(page).locator('button[tabindex="0"]').count()).toBe(1)
  await page.keyboard.press('ArrowRight')
  expect(await focusedTool()).toBe(tools[(first + 1) % tools.length])
  await page.keyboard.press('Home')
  expect(await focusedTool()).toBe(tools[0])
  await page.keyboard.press('ArrowLeft')
  expect(await focusedTool()).toBe(tools.at(-1))
  await page.keyboard.press('Home')
  await page.keyboard.press('End')
  expect(await focusedTool()).toBe(tools.at(-1))
  await page.keyboard.press('Tab')
  await expect(paneMenuButton(page, 'explorer')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(tree()).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  expect(await focusedTool()).toBe(tools.at(-1))
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(tree()).toBeFocused()
  console.log('Object Explorer checks: Ctrl+N on a database, F8, Filter Settings in the palette, and the toolbar\'s arrow keys.')

  // 11. Disconnecting a server while one of its folders streams cancels the load and removes its rows.
  await setStub({ tables: 120_000, pageDelayMs: 250 })
  await select('server-a', 'Databases', 'AppData')
  await press('ArrowRight', 'AppData')
  await reload('server-a', 'Databases', 'AppData', 'Tables')
  await expect(tree()).toHaveAttribute('aria-busy', 'true')
  await expect.poll(async () => (await stubCalls()).at(-1)?.cursor ?? '').toMatch(/^v1\.tables\./)
  // While Tables streams above them, keys keep the selected row in view, though each page that lands moves the rows
  // below it. The key goes to the tree and the check runs before the next frame, when a page waits to be drawn.
  await expect(tree()).toBeFocused()
  await press('End')
  const outOfView = []
  for (let step = 0; step < 20; step++) {
    await page.waitForTimeout(160)
    const shown = await page.evaluate(async () => {
      const tree = document.querySelector('[data-explorer-tree]')
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', bubbles: true, cancelable: true }))
      // React renders the selection in a microtask after the event.
      for (let turn = 0; turn < 10; turn++) await Promise.resolve()
      const row = document.getElementById(tree.getAttribute('aria-activedescendant')), box = tree.getBoundingClientRect(), rect = row.getBoundingClientRect()
      return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 ? '' : `${row.textContent} at ${Math.round(rect.top - box.top)} px`
    })
    if (shown) outOfView.push(shown)
  }
  expect(outOfView).toEqual([])
  await expect(tree()).toHaveAttribute('aria-busy', 'true')
  await press('Home', 'server-a')
  const cancelledBefore = (await cancels()).length
  await toolbarButton('Disconnect').click()
  await expect(serverRows(page)).toHaveCount(1)
  await expect(explorerLabel(serverRows(page))).toHaveText('server-b')
  await expect.poll(async () => (await cancels()).length).toBeGreaterThan(cancelledBefore)
  await setStub({ pageDelayMs: 0 })
  console.log('Object Explorer checks: Disconnect during streaming cancels the load and removes the server\'s rows.')

  // 12. Robustness: 200 quick expansions and collapses, then a rendering fault and Reload.
  await select('server-b', 'Databases')
  for (let round = 0; round < 100; round++) { await page.keyboard.press('NumpadAdd'); await page.keyboard.press('NumpadSubtract') }
  await press('NumpadAdd', 'Databases')
  await expect(await explorerRow(page, 'server-b', 'Databases', 'AppData')).toBeVisible()
  await expect(tree()).toBeFocused()
  await page.evaluate(() => window.__variaTestExplorerFault())
  await expect(page.getByText('Object Explorer stopped because of a rendering error.')).toBeVisible()
  // Focus went with the tree to the Reload button, and after Reload to the new tree, which repeats no old announcement.
  await expect(page.getByRole('button', { name: 'Reload Object Explorer', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(await explorerRow(page, 'server-b')).toHaveAttribute('aria-expanded', 'true')
  await expect(tree()).toBeFocused()
  await page.waitForTimeout(900)
  await expect(liveRegion()).toHaveText('')
  await setStub({ tables: 3 })
  await expandExplorerPath(page, 'server-b', 'Databases', 'AppData', 'Tables', 'dbo.Orders', 'Columns')
  await select('server-b', 'Databases', 'AppData', 'Tables', 'dbo.Orders', 'Columns', 'Id')
  for (const mode of ['dark', 'light']) {
    await page.evaluate(value => window.varia.setThemePreference({ mode: value }), mode)
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe(mode)
    await page.screenshot({ path: resolve('artifacts', `explorer-${mode}.png`) })
  }
  await page.evaluate(() => window.varia.setThemePreference({ mode: 'dark' }))
  // Forced colors (Windows contrast themes): the focused selection's outline and chevron take the system's selection
  // text colour, so focus shows on any Highlight colour.
  await tree().focus()
  await page.emulateMedia({ forcedColors: 'active' })
  const forced = await page.evaluate(part => {
    const row = document.querySelector(part.explorerTree + ' [role="treeitem"][aria-selected="true"]'), style = getComputedStyle(row)
    return { text: style.color, outline: style.outlineColor, width: style.outlineWidth, twistie: getComputedStyle(row.querySelector(part.explorerTwistie)).color, icon: getComputedStyle(row.querySelector(part.explorerIcon)).color }
  }, part)
  await page.emulateMedia({ forcedColors: null })
  expect(forced).toEqual({ text: forced.text, outline: forced.text, width: '2px', twistie: forced.text, icon: forced.text })
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1024, 768) })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
  const layout = await page.evaluate(part => {
    const toolbar = document.querySelector(part.explorerToolbar).getBoundingClientRect()
    const rows = [...document.querySelectorAll(part.explorerTree + ' [role="treeitem"]')].filter(row => !row.matches(part.explorerSyntheticRow)).map(row => {
      const icon = row.querySelector(part.explorerIcon).getBoundingClientRect(), label = row.querySelector(part.explorerLabel).getBoundingClientRect()
      return Math.abs((icon.top + icon.bottom) / 2 - (label.top + label.bottom) / 2)
    })
    // A sublabel only takes the space its label leaves, so a label is never cut short while its sublabel still shows.
    const clipped = [...document.querySelectorAll(part.explorerTree + ' [role="treeitem"]')].filter(row => {
      const label = row.querySelector(part.explorerLabel), sublabel = row.querySelector(part.explorerSublabel)
      return label && sublabel && sublabel.getBoundingClientRect().width > 0 && label.scrollWidth > label.clientWidth
    }).map(row => row.getAttribute('aria-label'))
    return { toolbar: { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom }, width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, offsets: rows, clipped }
  }, part)
  expect(layout.toolbar.left).toBeGreaterThanOrEqual(0)
  expect(layout.toolbar.right).toBeLessThanOrEqual(layout.width)
  expect(layout.toolbar.bottom).toBeLessThanOrEqual(layout.height)
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height)
  expect(layout.offsets.length).toBeGreaterThan(5)
  expect(Math.max(...layout.offsets)).toBeLessThanOrEqual(1)
  expect(layout.clipped).toEqual([])
  for (const name of ['Connect Object Explorer', 'Disconnect', 'Stop', 'Filter Settings', 'Refresh', 'Collapse All']) await expect(toolbarButton(name)).toBeInViewport()
  await page.screenshot({ path: resolve('artifacts', 'explorer-1024.png') })
  // Disconnecting the last server from its menu by keyboard leaves focus in the pane, on the empty state's Connect button.
  await select('server-b')
  await page.keyboard.press('Shift+F10')
  const serverMenu = menu('Object Explorer')
  await expect(serverMenu.getByRole('menuitem', { name: 'Connect…', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(serverMenu.getByRole('menuitem', { name: 'Disconnect', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Connect to server', exact: true })).toBeFocused()
  expect(failures).toEqual([])
  console.log('Object Explorer checks: 200 quick toggles, a rendering fault reloaded with focus kept, Dark and Light screenshots, the toolbar and rows at 1024×768, and focus after the last server goes.')

  // 13. A real server: a scratch database's table and columns, and F5 after DDL in a query.
  if (process.env.VARIA_TEST_SQL_SERVER && process.env.VARIA_TEST_SQL_SCRATCH === '1') {
    await application.close()
    application = undefined
    await launch()
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14), name = `VariaScratch_${stamp}_${randomBytes(4).toString('hex')}`
    const wait = { timeout: 30000 }
    async function run(sql, marker) {
      await textbox().focus()
      await page.keyboard.press('Control+A')
      await page.keyboard.insertText(`${sql}\nPRINT '${marker}';`)
      await page.keyboard.press('F5')
      await outputView(page, /^Messages/).click()
      await expect(messages(page)).toContainText(marker, wait)
      await expect(errorMessages(page)).toHaveCount(0)
    }
    await connect(process.env.VARIA_TEST_SQL_SERVER)
    const live = serverRows(page).first()
    await expect(live).toBeVisible(wait)
    const server = await explorerLabel(live).textContent()
    // Set before the batch runs, and the database is marked in the batch that creates it: a failure after CREATE still
    // drops it here, or leaves it marked for ScratchDatabase's sweep, which drops only marked online databases.
    let created = false
    try {
      created = true
      await run(`CREATE DATABASE [${name}];\nEXEC [${name}].sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;`, 'created')
      await run(`USE [${name}];\nCREATE TABLE dbo.Orders (Id int PRIMARY KEY);\nUSE master;`, 'tabled')
      await expandExplorerPath(page, server, 'Databases', wait)
      const stale = await (await explorerRow(page, server, 'Databases', name, wait)).getAttribute('id')
      await select(server, 'Databases')
      await press('F5')
      // The old rows stay until the refreshed list arrives; then the database is a new row.
      await expect.poll(async () => (await explorerRow(page, server, 'Databases', name, wait)).getAttribute('id'), wait).not.toBe(stale)
      await expandExplorerPath(page, server, 'Databases', name, 'Tables', 'dbo.Orders', 'Columns', wait)
      await expect(await explorerRow(page, server, 'Databases', name, 'Tables', 'dbo.Orders', 'Columns', 'Id', wait)).toHaveAttribute('aria-label', 'Id (PK, int, not null)')
      await run(`ALTER TABLE [${name}].dbo.Orders ADD Note nvarchar(20) NULL;`, 'altered')
      await select(server, 'Databases', name, 'Tables', 'dbo.Orders', 'Columns')
      await press('F5')
      await expect(await explorerRow(page, server, 'Databases', name, 'Tables', 'dbo.Orders', 'Columns', 'Note', wait)).toHaveAttribute('aria-label', 'Note (nvarchar(20), null)')
      console.log('Object Explorer checks: a real server lists a new scratch database\'s table and its key column, and F5 on Columns shows a column added by a query.')
    } finally {
      // Object Explorer's pool holds no database open, so nothing it did blocks the drop.
      if (created) await run(`USE master;\nIF DB_ID(N'${name}') IS NOT NULL\nBEGIN\n  ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n  DROP DATABASE [${name}];\nEND`, 'dropped')
    }
  } else console.log('Object Explorer checks: the live slice was skipped (it needs VARIA_TEST_SQL_SERVER and VARIA_TEST_SQL_SCRATCH=1).')

  expect(failures).toEqual([])
  console.log('Object Explorer checks passed: the ARIA tree and its keys, lazy loading and cancellation, Stop, refresh, speed while streaming 120,000 tables, filters, drag and drop, copy, offline databases, commands, disconnect, robustness, layout at 1024×768, and a real server when configured.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'explorer-failure.png') }).catch(() => {})
  console.log(await page?.evaluate(() => ({ focused: document.activeElement?.outerHTML.slice(0, 300), alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent) })).catch(() => 'no page'))
  if (page) console.log((await explorerLines(page).catch(() => [])).slice(0, 60).join('\n'))
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
