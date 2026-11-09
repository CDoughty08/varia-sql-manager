import { electron, expect } from './fixtures/smoke.mjs'
import { activeDocumentName, backendReady, caretStatus, documentTab, editorDiagnosticMarks, editorGroupForDocument, editorGroups, editorHover, editorSurface, editorText, editorTextbox, queryDatabase, queryServer, sqlQueryIssues, suggestionItems, suggestionOption, suggestionWidget, toolbarButton } from './fixtures/ui.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Rendered Monaco squiggles, their hover and keyboard navigation through the real preload/main boundary. --live
// substitutes the bundled SQL Tools binder and reads system metadata; neither mode executes the editor's SQL.
const live = process.argv.includes('--live')
const server = process.env.VARIA_TEST_SQL_SERVER
const username = process.env.VARIA_TEST_SQL_USER, password = process.env.VARIA_TEST_SQL_PASSWORD
if (live && !server) throw new Error('--live requires VARIA_TEST_SQL_SERVER.')
if (live && username && !password) throw new Error('VARIA_TEST_SQL_PASSWORD is required with VARIA_TEST_SQL_USER.')
await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'diagnostics-profile-'))
const control = live ? undefined : await mkdtemp(resolve('artifacts', 'diagnostics-control-'))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const wait = { timeout: live ? 60000 : 15000 }
const failures = []
let application, page
const started = Date.now()
const watchdog = setTimeout(() => { console.error('SQL diagnostics UI suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, live ? 240000 : 120000)
const calls = async () => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const analyses = async () => (await calls()).filter(call => call.method === 'language.diagnostics')
const text = scope => editorText(scope).then(value => value.replaceAll('\u00a0', ' '))

async function close() {
  if (!application) return
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
  application = undefined
}
async function setText(scope, value) {
  await editorTextbox(scope).focus()
  await page.keyboard.press(`${mod}+A`)
  await page.keyboard.insertText(value)
  await page.keyboard.press('Escape')
  await expect.poll(() => text(scope)).toBe(value)
}
async function connect(name, database) {
  await toolbarButton(page, 'Connect').click()
  await page.getByLabel('Server Name', { exact: true }).fill(name)
  await page.getByLabel('Authentication', { exact: true }).selectOption(live && username ? 'sql' : 'windows')
  if (live && username) {
    await page.getByLabel('Login', { exact: true }).fill(username)
    await page.getByLabel('Password', { exact: true }).fill(password)
  }
  await page.getByLabel('Database Name', { exact: true }).fill(database)
  await page.getByLabel('Trust server certificate', { exact: true }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0, wait)
  await expect(queryDatabase(page)).toHaveValue(database)
  return { connectionId: await queryServer(page).inputValue(), tab: await activeDocumentName(page) }
}
async function clean(scope = page) {
  await expect(sqlQueryIssues(page)).toHaveText('SQL: no issues', wait)
  await expect(editorDiagnosticMarks(scope)).toHaveCount(0)
  await expect(editorDiagnosticMarks(scope, 'warning')).toHaveCount(0)
}
async function hoverMarker(scope, offset, message) {
  await editorTextbox(scope).focus()
  await page.keyboard.press(`${mod}+Home`)
  for (let at = 0; at < offset; at++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press(`${mod}+K`)
  await page.keyboard.press(`${mod}+I`)
  await expect(editorHover(page, message)).toBeVisible(wait)
  await page.keyboard.press('Escape')
}
async function paint(scope, severity) {
  const marks = editorDiagnosticMarks(scope, severity)
  await expect(marks.first()).toBeVisible(wait)
  const colors = await marks.evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(), image = getComputedStyle(element).backgroundImage
    const fill = /<g fill=['"]([^'"]+)/.exec(decodeURIComponent(image))?.[1]
    return { visible: rect.width > 0 && rect.height > 0, image: image.startsWith('url("data:image/svg+xml,'), fill }
  }))
  expect(colors.every(color => color.visible && color.image && /^#[a-f\d]{6}/i.test(color.fill))).toBe(true)
  return colors[0].fill
}
async function navigation(scope, first, second) {
  await editorTextbox(scope).focus()
  await page.keyboard.press(`${mod}+Home`)
  await page.keyboard.press('Alt+F8')
  await expect(caretStatus(page)).toHaveAccessibleName(first)
  await page.keyboard.press('Alt+F8')
  await expect(caretStatus(page)).toHaveAccessibleName(second)
  await page.keyboard.press('Alt+Shift+F8')
  await expect(caretStatus(page)).toHaveAccessibleName(first)
  await page.keyboard.press('Escape')
}

async function joinedCompletion(scope) {
  const sources = 'WITH leftSource AS (SELECT 1 AS high, 2 AS low, 3 AS LeftOnly),\nrightSource AS (SELECT 4 AS high, 5 AS low, 6 AS RightOnly)\n'
  const from = ' FROM leftSource AS t CROSS JOIN rightSource AS b;'
  async function suggest(prefix) {
    await setText(scope, sources + prefix + from)
    await page.keyboard.press(`${mod}+End`)
    for (let at = 0; at < from.length; at++) await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Control+Space')
    await expect(suggestionWidget(page)).toBeVisible(wait)
  }
  await suggest('SELECT hi')
  await expect(suggestionOption(page, 't.high')).toBeVisible(wait)
  await expect(suggestionOption(page, 'b.high')).toBeVisible(wait)
  await expect(suggestionOption(page, 'high')).toHaveCount(0)
  await expect(suggestionItems(page).first()).toHaveAccessibleName(/^(?:t|b)\.high(?:,|$)/)
  await page.screenshot({ path: resolve('artifacts', 'sql-joined-completions.png') })
  await page.keyboard.press('Tab')
  await expect.poll(async () => [sources + 'SELECT t.high' + from, sources + 'SELECT b.high' + from].includes(await text(scope))).toBe(true)

  await suggest('SELECT t.')
  await expect(suggestionOption(page, 'high')).toBeVisible(wait)
  await expect(suggestionOption(page, 'LeftOnly')).toBeVisible(wait)
  await expect(suggestionOption(page, 'low')).toBeVisible(wait)
  await expect(suggestionOption(page, 'RightOnly')).toHaveCount(0)
  await expect(suggestionOption(page, 'b.RightOnly')).toHaveCount(0)
  await expect(suggestionOption(page, 'b.high')).toHaveCount(0)
  await expect(suggestionItems(page)).toHaveCount(3)
  await page.keyboard.press('Tab')
  await expect.poll(async () => {
    const value = await text(scope)
    return ['high', 'low', 'LeftOnly'].some(column => sources + 'SELECT t.' + column + from === value)
  }, { message: 't-dot completion inserts exactly one qualifier' }).toBe(true)
  console.log('Live SQL completion UI: hi displays both qualified joined columns and Tab inserts a qualifier; t-dot lists only its own columns without duplicating t-dot.')
}

async function fakeChecks() {
  const bad = 'SELECT MissingColumn;\nSELECT WarningColumn;'
  await setText(page, bad)
  await expect(sqlQueryIssues(page)).toHaveText('SQL: 1 error, 1 warning', wait)
  const error = await paint(page, 'error'), warning = await paint(page, 'warning')
  expect(error).not.toBe(warning)
  const rgb = value => [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16))
  const red = rgb(error), yellow = rgb(warning)
  expect(red[0] > red[1] && red[0] > red[2]).toBe(true)
  expect(yellow[0] > yellow[2] && yellow[1] > yellow[2]).toBe(true)
  await hoverMarker(page, 9, "Invalid column name 'MissingColumn' (offline).")
  await navigation(page, 'Line 1, column 8, character 8', 'Line 2, column 8, character 8')
  await page.screenshot({ path: resolve('artifacts', 'sql-diagnostics-markers.png') })
  console.log('SQL diagnostics UI: real red/yellow squiggle paint, marker hover, counts, Alt+F8 and Alt+Shift+F8 are visible in Monaco.')

  await mkdir(join(control, 'hold'), { recursive: true })
  await writeFile(join(control, 'hold', 'language.diagnostics'), '')
  await setText(page, 'SELECT CorrectColumn;')
  await expect(editorDiagnosticMarks(page)).toHaveCount(0)
  await expect(editorDiagnosticMarks(page, 'warning')).toHaveCount(0)
  await expect(sqlQueryIssues(page)).toHaveText('Checking SQL')
  await rm(join(control, 'hold', 'language.diagnostics'))
  await clean()

  await writeFile(join(control, 'hold', 'language.diagnostics'), '')
  const before = (await analyses()).length
  await setText(page, 'SELECT MissingColumn;')
  await expect.poll(async () => (await analyses()).length).toBeGreaterThan(before)
  await setText(page, 'SELECT CorrectColumn;')
  await expect(editorDiagnosticMarks(page)).toHaveCount(0)
  await rm(join(control, 'hold', 'language.diagnostics'))
  await clean()
  console.log('SQL diagnostics UI: edits clear markers immediately and a delayed obsolete response cannot restore them.')

  const first = await connect('diagnostic-server-a', 'AppData')
  await setText(page, bad)
  await expect(sqlQueryIssues(page)).toHaveText('SQL: 1 error, 1 warning')
  await hoverMarker(page, 9, 'diagnostic-server-a/AppData')
  const second = await connect('diagnostic-server-b', 'master')
  await setText(page, 'SELECT WarningColumn;')
  await expect(sqlQueryIssues(page)).toHaveText('SQL: 1 warning')
  await editorTextbox(page).focus()
  await page.keyboard.press(`${mod}+\\`)
  await expect(editorGroups(page)).toHaveCount(2)
  const groupA = editorGroupForDocument(page, first.tab), groupB = editorGroupForDocument(page, second.tab)
  await expect(editorDiagnosticMarks(groupA)).toHaveCount(1)
  await expect(editorDiagnosticMarks(groupA, 'warning')).toHaveCount(1)
  await expect(editorDiagnosticMarks(groupB)).toHaveCount(0)
  await expect(editorDiagnosticMarks(groupB, 'warning')).toHaveCount(1)
  await hoverMarker(groupB, 9, 'diagnostic-server-b/master')
  await editorTextbox(groupA).focus()
  await expect(queryServer(page)).toHaveValue(first.connectionId)
  await expect(sqlQueryIssues(page)).toHaveText('SQL: 1 error, 1 warning')
  await navigation(groupA, 'Line 1, column 8, character 8', 'Line 2, column 8, character 8')
  await page.keyboard.press(`${mod}+End`)
  await page.keyboard.press('Alt+F8')
  await expect(caretStatus(page)).toHaveAccessibleName('Line 1, column 8, character 8')
  await expect(queryServer(page)).toHaveValue(first.connectionId)
  expect(await activeDocumentName(page)).toBe(first.tab)
  await editorTextbox(groupB).focus()
  await expect(sqlQueryIssues(page)).toHaveText('SQL: 1 warning')
  await expect(queryServer(page)).toHaveValue(second.connectionId)
  const recorded = await analyses()
  expect(recorded.some(call => call.params.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n') === bad && call.params.context.connectionId === first.connectionId && call.params.context.database === 'AppData')).toBe(true)
  expect(recorded.some(call => call.params.text === 'SELECT WarningColumn;' && call.params.context.connectionId === second.connectionId && call.params.context.database === 'master')).toBe(true)
  console.log('SQL diagnostics UI: split models keep their own markers, hover context and counts; issue navigation stays in the focused model.')

  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async (_window, options) => ({ response: options.message === 'Restart the SQL backend?' ? 0 : 1, checkboxChecked: false }) })
  expect(await page.evaluate(() => window.varia.restartBackend())).toEqual({ ok: true, value: true })
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  for (const group of [groupA, groupB]) {
    await expect(editorDiagnosticMarks(group)).toHaveCount(0)
    await expect(editorDiagnosticMarks(group, 'warning')).toHaveCount(0)
  }
  await expect(sqlQueryIssues(page)).toHaveText('SQL analysis paused')
  await expect(sqlQueryIssues(page)).toHaveAttribute('title', 'Reconnect this query to restore SQL analysis.')
  expect((await calls()).some(call => call.method === 'query.execute')).toBe(false)
  console.log('SQL diagnostics UI: backend restart clears stale markers and pauses disconnected queries; analysis never executes SQL.')
}

async function liveChecks() {
  const first = await connect(server, 'master')
  await joinedCompletion(page)
  await setText(page, 'SELECT d.MissingColumn FROM sys.databases AS d;')
  await expect(editorDiagnosticMarks(page).first()).toBeVisible(wait)
  await expect(sqlQueryIssues(page)).toHaveText(/SQL: .*error/, wait)
  await paint(page, 'error')
  await hoverMarker(page, 12, 'MissingColumn')
  await page.screenshot({ path: resolve('artifacts', 'sql-diagnostics-live-error.png') })
  await page.keyboard.press(`${mod}+Home`)
  await page.keyboard.press('Alt+F8')
  await expect(caretStatus(page)).toHaveAccessibleName('Line 1, column 10, character 10')
  await page.keyboard.press('Escape')
  await setText(page, 'SELECT d.database_id FROM sys.databases AS d;')
  await clean()
  const second = await connect(server, 'msdb')
  await editorTextbox(page).focus()
  await page.keyboard.press(`${mod}+\\`)
  await expect(editorGroups(page)).toHaveCount(2)
  const groupA = editorGroupForDocument(page, first.tab), groupB = editorGroupForDocument(page, second.tab)
  const same = 'SELECT v.number FROM dbo.spt_values AS v;'
  await setText(groupA, same)
  await clean(groupA)
  await expect(queryDatabase(page)).toHaveValue('master')
  await setText(groupB, same)
  await expect(editorDiagnosticMarks(groupB).first()).toBeVisible(wait)
  await expect(sqlQueryIssues(page)).toHaveText(/SQL: .*error/, wait)
  await expect(queryDatabase(page)).toHaveValue('msdb')
  await expect(editorDiagnosticMarks(groupA)).toHaveCount(0)
  await hoverMarker(groupB, 'SELECT v.number FROM dbo.spt_'.length, 'spt_values')
  await setText(groupB, 'SELECT FROM sys.databases;')
  await expect(editorDiagnosticMarks(groupB).first()).toBeVisible(wait)
  await expect(sqlQueryIssues(page)).toHaveText(/SQL: .*error/, wait)
  await setText(groupB, 'SELECT j.job_id FROM dbo.sysjobs AS j;')
  await clean(groupB)
  await editorTextbox(groupA).focus()
  await clean(groupA)
  await expect(queryDatabase(page)).toHaveValue('master')
  await page.screenshot({ path: resolve('artifacts', 'sql-diagnostics-live.png') })
  console.log('Live SQL diagnostics UI: actual binder squiggles and hover clear after a fix; identical SQL follows each split model\'s database, and syntax errors clear without execution.')
}

try {
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  if (live) for (const name of ['VARIA_TEST_BACKEND', 'VARIA_SQLTOOLS_SERVICE_PATH', 'VARIA_SQLTOOLS_SERVICE_SOURCE']) delete env[name]
  else {
    await writeFile(join(control, 'language-enabled'), '')
    await writeFile(join(control, 'language-diagnostics'), '')
    Object.assign(env, { VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control })
  }
  application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await application.firstWindow()
  page.setDefaultTimeout(live ? 30000 : 15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, live ? /\.NET \d+\./ : 'fake')).toBeVisible({ timeout: 60000 })
  await expect(editorSurface(page)).toBeVisible()
  if (live) await liveChecks()
  else await fakeChecks()
  expect(failures).toEqual([])
  await close()
  console.log(`SQL diagnostics ${live ? 'live ' : ''}UI suite passed in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
} catch (error) {
  console.error(error)
  if (page) await page.screenshot({ path: resolve('artifacts', `sql-diagnostics-${live ? 'live-' : ''}failure.png`) }).catch(() => {})
  process.exitCode = 1
  await close().catch(() => application?.process()?.kill())
} finally { clearTimeout(watchdog) }
