import { electron, expect } from './fixtures/smoke.mjs'
import { activeDocumentName, backendReady, documentTab, editorGroupForDocument, editorGroups, editorText, editorTextbox, floatingEditorGroups, movePane, popoutDockButton, popoutTabs, queryDatabase, queryServer, suggestionOption, toolbarButton } from './fixtures/ui.mjs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Real Monaco -> preload -> backend -> bundled SQL Tools Service -> SQL Server. This suite reads system metadata only.
const server = process.env.VARIA_TEST_SQL_SERVER
if (!server) throw new Error('Set VARIA_TEST_SQL_SERVER before running the live language UI check.')
const username = process.env.VARIA_TEST_SQL_USER, password = process.env.VARIA_TEST_SQL_PASSWORD
if (username && !password) throw new Error('VARIA_TEST_SQL_PASSWORD is required with VARIA_TEST_SQL_USER.')
await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'language-live-profile-'))
const closeTrace = resolve(profile, 'close-stages.jsonl')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
let application, page
const failures = []
const watchdog = setTimeout(() => { console.error('Live language UI check exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 300000)
let closeTracing = false, closeRecords = 0, closeReported = false

function recordClose(stage, details = {}) {
  if (closeRecords++ >= 16) return
  try { appendFileSync(closeTrace, JSON.stringify({ at: new Date().toISOString(), stage, ...details }) + '\n') } catch { /* Diagnostics must not prevent cleanup. */ }
}
function reportCloseTrace() {
  if (closeReported) return
  closeReported = true
  try { console.error('Live language UI close stages:\n' + readFileSync(closeTrace, 'utf8').slice(0, 32_768)) } catch { console.error('Live language UI close stages unavailable.') }
}

async function close() {
  if (!application) return
  const child = application.process()
  if (!closeTracing) {
    closeTracing = true
    child?.once('exit', (code, signal) => recordClose('child-exit', { code, signal }))
    child?.once('close', (code, signal) => recordClose('child-close', { code, signal }))
  }
  try {
    // Playwright disconnects main's inspector after asking it to quit. Persist stages before that disconnect so a
    // timed-out close can distinguish a refused quit, backend shutdown, and an exited leader with open child pipes.
    await application.evaluate(({ app, BrowserWindow, dialog }, file) => {
      if (globalThis.variaLanguageCloseTrace) return
      globalThis.variaLanguageCloseTrace = true
      const fs = process.getBuiltinModule('node:fs')
      let records = 0
      const record = (stage, details = {}) => {
        if (records++ >= 80) return
        try { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), stage, ...details }) + '\n') } catch { /* Best-effort diagnostics. */ }
      }
      record('close-requested', { windows: BrowserWindow.getAllWindows().length })
      for (const event of ['before-quit', 'will-quit', 'quit']) app.on(event, value => record(event, { prevented: !!value?.defaultPrevented }))
      process.once('exit', () => record('main-exit'))
      for (const window of BrowserWindow.getAllWindows()) {
        const id = window.id
        for (const event of ['close', 'closed', 'unresponsive', 'responsive']) window.on(event, value => record('window-' + event, { id, prevented: !!value?.defaultPrevented }))
        window.webContents.on('will-prevent-unload', () => record('will-prevent-unload', { id }))
        window.webContents.on('render-process-gone', () => record('renderer-gone', { id }))
      }
      dialog.showMessageBox = async (_window, options) => {
        const category = ['Unsaved query', 'Uncommitted transactions', 'Query executing', 'Workbench stopped', 'Reload workbench'].includes(options?.title) ? options.title : 'other'
        record('message-box', { category, response: 1 })
        return { response: 1, checkboxChecked: false }
      }
    }, closeTrace)
    await application.close()
    recordClose('close-returned', { failed: !!process.exitCode, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null })
    if (process.exitCode) reportCloseTrace()
    application = undefined
  } catch (error) {
    recordClose('close-rejected', { exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null })
    reportCloseTrace()
    throw error
  }
}
async function caret(target, offset) {
  await target.keyboard.press(`${mod}+Home`)
  for (let index = 0; index < offset; index++) await target.keyboard.press('ArrowRight')
}
async function connect(database) {
  await toolbarButton(page, 'Connect').click()
  await page.getByLabel('Server Name', { exact: true }).fill(server)
  await page.getByLabel('Authentication', { exact: true }).selectOption(username ? 'sql' : 'windows')
  if (username) {
    await page.getByLabel('Login', { exact: true }).fill(username)
    await page.getByLabel('Password', { exact: true }).fill(password)
  }
  await page.getByLabel('Database Name', { exact: true }).fill(database)
  await page.getByLabel('Trust server certificate', { exact: true }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 60000 })
  await expect(queryDatabase(page)).toHaveValue(database)
  return { connectionId: await queryServer(page).inputValue(), tab: await activeDocumentName(page) }
}
async function suggest(target, scope, { prefix, suffix, label }) {
  await target.bringToFront()
  await editorTextbox(scope).focus()
  await target.keyboard.press(`${mod}+A`)
  await target.keyboard.insertText(prefix + suffix)
  await caret(target, prefix.length)
  await target.keyboard.press('Control+Space')
  await expect(suggestionOption(target, label)).toBeVisible({ timeout: 60000 })
  await target.keyboard.press('Tab')
  const accepted = prefix.slice(0, prefix.lastIndexOf('.') + 1) + label + suffix
  await expect.poll(async () => (await editorText(scope)).replaceAll('\u00a0', ' ')).toBe(accepted)
}
async function hover(target, scope, offset, label, type) {
  await target.bringToFront()
  await editorTextbox(scope).focus()
  await caret(target, offset)
  await target.keyboard.press(`${mod}+K`)
  await target.keyboard.press(`${mod}+I`)
  const contents = target.locator('.monaco-hover').filter({ hasText: label })
  await expect(contents).toBeVisible({ timeout: 60000 })
  await expect(contents).toContainText(type)
  await target.keyboard.press('Escape')
}
async function context(scope, connectionId, database) {
  await expect(queryServer(scope)).toHaveValue(connectionId)
  await expect(queryDatabase(scope)).toHaveValue(database)
}
async function moveEditor(name, action) {
  await documentTab(page, name).focus()
  await page.keyboard.press('Shift+F10')
  await page.getByRole('menu', { name: 'Query tab', exact: true }).getByRole('menuitem', { name: action, exact: true }).click()
}

try {
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
  // The same bundled-path resolver used by a normal launch must supply the actual runtime.
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VARIA_TEST_BACKEND', 'VARIA_SQLTOOLS_SERVICE_PATH', 'VARIA_SQLTOOLS_SERVICE_SOURCE']) delete env[name]
  application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await application.firstWindow()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page)).toBeVisible({ timeout: 60000 })
  const status = await page.evaluate(() => window.varia.languageStatus())
  expect(status.ok && status.value.providers.some(provider => provider.id === 'sqlserver' && provider.configured)).toBe(true)

  const first = await connect('master')
  await suggest(page, page, { prefix: 'SELECT d.database_', suffix: ' FROM sys.databases AS d;', label: 'database_id' })
  console.log('Live language UI: real database column suggestion inserts through Monaco without a service-path override.')
  await hover(page, page, 'SELECT d.datab'.length, 'database_id', 'int')
  const second = await connect('msdb')
  expect(second.connectionId).not.toBe(first.connectionId)
  expect(second.tab).not.toBe(first.tab)
  await editorTextbox(page).focus()
  await page.keyboard.press(`${mod}+\\`)
  await expect(editorGroups(page)).toHaveCount(2)
  const master = { prefix: 'SELECT v.num', suffix: ' FROM dbo.spt_values AS v;', label: 'number' }
  const msdb = { prefix: 'SELECT j.job_', suffix: ' FROM dbo.sysjobs AS j;', label: 'job_id' }
  const firstGroup = editorGroupForDocument(page, first.tab), secondGroup = editorGroupForDocument(page, second.tab)
  await suggest(page, firstGroup, master)
  await context(page, first.connectionId, 'master')
  await hover(page, firstGroup, 'SELECT v.num'.length, 'number', 'int')
  await suggest(page, secondGroup, msdb)
  await context(page, second.connectionId, 'msdb')
  await hover(page, secondGroup, 'SELECT j.job'.length, 'job_id', 'uniqueidentifier')
  await suggest(page, firstGroup, master)
  await context(page, first.connectionId, 'master')
  console.log('Live language UI: both split editors display database-specific completion and hover after switching focus.')

  // Floating editor groups remain in this window; Results is the supported OS popout exercised below.
  await moveEditor(second.tab, 'Float')
  await expect(floatingEditorGroups(page)).toHaveCount(1)
  const floating = editorGroupForDocument(page, second.tab)
  await suggest(page, floating, msdb)
  await context(page, second.connectionId, 'msdb')
  await hover(page, floating, 'SELECT j.job'.length, 'job_id', 'uniqueidentifier')
  const beforeRefresh = (await editorText(floating)).replaceAll('\u00a0', ' ')
  const marker = await page.evaluate(() => globalThis.__languageRefreshPage = crypto.randomUUID())
  await page.keyboard.press(`${mod}+Shift+R`)
  await expect.poll(async () => (await editorText(floating)).replaceAll('\u00a0', ' ')).toBe(beforeRefresh)
  expect(await page.evaluate(() => globalThis.__languageRefreshPage)).toBe(marker)
  await suggest(page, floating, msdb)
  await hover(page, floating, 'SELECT j.job'.length, 'job_id', 'uniqueidentifier')
  console.log('Live language UI: real completion and hover work in a floating editor, including cache refresh without changing SQL or reloading.')

  await moveEditor(second.tab, 'Dock')
  await expect(floatingEditorGroups(page)).toHaveCount(0)
  if (await editorGroups(page).count() === 1) {
    await documentTab(page, second.tab).click()
    await editorTextbox(page).focus()
    await page.keyboard.press(`${mod}+\\`)
  }
  await expect(editorGroups(page)).toHaveCount(2)
  const opened = application.waitForEvent('window', { timeout: 30000 })
  await movePane(page, 'results', 'window')
  const popout = await opened
  popout.setDefaultTimeout(30000)
  popout.on('pageerror', error => failures.push(error.message))
  await expect(popoutTabs(popout)).toBeVisible()
  await expect(editorTextbox(popout)).toHaveCount(0)
  expect(await popout.evaluate(() => typeof window.varia)).toBe('undefined')
  await popout.bringToFront()
  await popoutDockButton(popout).focus()
  await suggest(page, editorGroupForDocument(page, first.tab), master)
  await context(page, first.connectionId, 'master')
  await hover(page, editorGroupForDocument(page, first.tab), 'SELECT v.num'.length, 'number', 'int')
  await popout.bringToFront()
  await popoutDockButton(popout).focus()
  await suggest(page, editorGroupForDocument(page, second.tab), msdb)
  await context(page, second.connectionId, 'msdb')
  await hover(page, editorGroupForDocument(page, second.tab), 'SELECT j.job'.length, 'job_id', 'uniqueidentifier')
  console.log('Live language UI: focus returning from the Results OS popout keeps both main-window editors on their own database metadata.')

  await popoutDockButton(popout).click()
  await expect.poll(() => popout.isClosed()).toBe(true)
  await page.bringToFront()
  await expect(editorGroups(page)).toHaveCount(2)
  await documentTab(page, second.tab).click()
  await suggest(page, editorGroupForDocument(page, second.tab), msdb)
  await context(page, second.connectionId, 'msdb')
  await documentTab(page, first.tab).click()
  await suggest(page, editorGroupForDocument(page, first.tab), master)
  await context(page, first.connectionId, 'master')
  console.log('Live language UI: docking Results back and switching editors preserves both live database contexts.')
  expect(failures).toEqual([])
  await close()
  if (!process.exitCode) console.log('Live SQL language UI check passed.')
} catch (error) {
  console.error(error)
  if (page) await page.screenshot({ path: resolve('artifacts', 'language-live-failure.png') }).catch(() => {})
  process.exitCode = 1
  await close().catch(() => application?.process()?.kill())
} finally { clearTimeout(watchdog) }
