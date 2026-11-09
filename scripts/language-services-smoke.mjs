import { electron, expect } from './fixtures/smoke.mjs'
import { activeDocumentName, backendReady, documentTab, editorGroupForDocument, editorGroups, editorText, editorTextbox, floatingEditorGroups, movePane, popoutDockButton, popoutTabs, queryDatabase, queryServer, suggestionOption, toolbarButton } from './fixtures/ui.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Real Monaco suggestion/hover widgets through preload, main validation and the fake backend. SQL Tools Service's
// process/protocol/provider lifecycle is tested separately; this suite needs neither that executable nor a database.
await mkdir('artifacts', { recursive: true })
const control = await mkdtemp(resolve('artifacts', 'language-control-'))
const profile = await mkdtemp(resolve('artifacts', 'language-profile-'))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
let application, page
const failures = []
const watchdog = setTimeout(() => { console.error('Language-service suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 180000)
const calls = async () => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const languageCalls = async method => (await calls()).filter(call => call.method === method)
const text = scope => editorText(scope).then(value => value.replaceAll('\u00a0', ' '))
async function launch() {
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
}
async function close() {
  if (!application) return
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
  application = undefined
}
async function setText(target, scope, value) {
  await target.bringToFront()
  await editorTextbox(scope).focus()
  await target.keyboard.press(`${mod}+A`)
  await target.keyboard.insertText(value)
}
async function suggestAndAccept(target = page, scope = target, label = 'Customer') {
  await setText(target, scope, 'Cus')
  await target.keyboard.press('Control+Space')
  await expect(suggestionOption(target, label)).toBeVisible()
  await target.keyboard.press('Tab')
  await expect.poll(() => text(scope)).toBe(label)
}
async function hover(target, scope, contents) {
  await target.bringToFront()
  await editorTextbox(scope).focus()
  await target.keyboard.press('Home')
  await target.keyboard.press('ArrowRight')
  await target.keyboard.press(`${mod}+K`)
  await target.keyboard.press(`${mod}+I`)
  await expect(target.locator('.monaco-hover').filter({ hasText: contents })).toBeVisible()
  await target.keyboard.press('Escape')
}
async function ownContext(documentId, connectionId, database) {
  await expect.poll(async () => (await languageCalls('language.complete')).at(-1)?.params)
    .toMatchObject({ documentId, context: { providerId: 'sqlserver', connectionId, database } })
}
async function moveEditor(name, action) {
  await documentTab(page, name).focus()
  await page.keyboard.press('Shift+F10')
  await page.getByRole('menu', { name: 'Query tab', exact: true }).getByRole('menuitem', { name: action, exact: true }).click()
}
async function connect(server) {
  await toolbarButton(page, 'Connect').click()
  await page.getByLabel('Server Name', { exact: true }).fill(server)
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const selected = queryServer(page).locator('option').filter({ hasText: server })
  await expect(selected).toHaveCount(1)
  const connectionId = await selected.getAttribute('value')
  await expect(queryServer(page)).toHaveValue(connectionId)
  return connectionId
}

try {
  await launch()
  await expect(page.getByLabel('SQL IntelliSense', { exact: true })).toHaveText('IntelliSense off')
  await expect(page.getByLabel('SQL IntelliSense', { exact: true })).toHaveAttribute('title', 'SQL language test provider is disabled.')
  await editorTextbox(page).focus()
  await page.keyboard.press('Control+Space')
  expect(await languageCalls('language.complete')).toHaveLength(0)
  await close()

  await writeFile(join(control, 'language-enabled'), '')
  await writeFile(join(control, 'language-status-fail'), '')
  await launch()
  await expect(page.getByLabel('SQL IntelliSense', { exact: true })).toHaveText('IntelliSense unavailable')
  await expect(page.getByLabel('SQL IntelliSense', { exact: true })).toHaveAttribute('title', 'SQL language provider availability check failed.')
  const availabilityGeneration = (await languageCalls('language.status')).at(-1).generation
  const availabilityChecks = (await languageCalls('language.status')).length
  await rm(join(control, 'language-status-fail'))
  await suggestAndAccept()
  await expect(page.getByLabel('SQL IntelliSense', { exact: true })).toHaveText('IntelliSense')
  expect((await languageCalls('language.status')).length).toBeGreaterThan(availabilityChecks)
  expect((await languageCalls('language.status')).at(-1).generation).toBe(availabilityGeneration)
  await expect.poll(async () => (await languageCalls('language.complete')).length).toBeGreaterThan(0)
  console.log('Language checks: missing provider is explained, a failed availability check recovers through Ctrl+Space in the same backend generation, and Tab accepts real suggestions.')

  await hover(page, page, 'Customer table (fake language service).')
  await expect.poll(async () => (await languageCalls('language.hover')).length).toBeGreaterThan(0)

  const idA = await connect('language-server-a')
  await expect(queryDatabase(page).getByRole('option', { name: 'AppData', exact: true })).toHaveCount(1)
  await queryDatabase(page).selectOption('AppData')
  const tabA = await activeDocumentName(page)
  await suggestAndAccept(page, page, 'CustomerAppData')
  await expect.poll(async () => (await languageCalls('language.complete')).at(-1)?.params.context).toEqual({ providerId: 'sqlserver', connectionId: idA, database: 'AppData' })
  const documentA = (await languageCalls('language.complete')).at(-1).params.documentId

  const idB = await connect('language-server-b')
  expect(idB).not.toBe(idA)
  await expect.poll(() => activeDocumentName(page)).not.toBe(tabA)
  const tabB = await activeDocumentName(page)
  await queryDatabase(page).selectOption('master')
  await suggestAndAccept(page, page, 'CustomerMaster')
  await expect.poll(async () => (await languageCalls('language.complete')).at(-1)?.params.context).toEqual({ providerId: 'sqlserver', connectionId: idB, database: 'master' })
  const documentB = (await languageCalls('language.complete')).at(-1).params.documentId
  expect(documentB).not.toBe(documentA)

  await documentTab(page, tabA).click()
  await suggestAndAccept(page, page, 'CustomerAppData')
  await expect.poll(async () => (await languageCalls('language.complete')).at(-1)?.params).toMatchObject({ documentId: documentA, context: { connectionId: idA, database: 'AppData' } })
  await documentTab(page, tabB).click()
  await expect(queryServer(page)).toHaveValue(idB)
  await editorTextbox(page).focus()
  await page.keyboard.press(`${mod}+\\`)
  await expect(editorGroups(page)).toHaveCount(2)
  const groupA = editorGroupForDocument(page, tabA), groupB = editorGroupForDocument(page, tabB)
  await suggestAndAccept(page, groupA, 'CustomerAppData')
  await ownContext(documentA, idA, 'AppData')
  await hover(page, groupA, 'language-server-a/AppData')
  await suggestAndAccept(page, groupB, 'CustomerMaster')
  await ownContext(documentB, idB, 'master')
  await hover(page, groupB, 'language-server-b/master')
  await editorTextbox(groupA).focus()
  await expect(queryServer(page)).toHaveValue(idA)
  await editorTextbox(groupB).focus()
  await expect(queryServer(page)).toHaveValue(idB)
  console.log('Language checks: both split Monaco editors display suggestions and hover from their own document, connection and database.')

  // Query documents float inside the main editor area. They intentionally do not move into OS popouts.
  await moveEditor(tabB, 'Float')
  await expect(floatingEditorGroups(page)).toHaveCount(1)
  const floatingB = editorGroupForDocument(page, tabB)
  await suggestAndAccept(page, floatingB, 'CustomerMaster')
  await ownContext(documentB, idB, 'master')
  await hover(page, floatingB, 'language-server-b/master')

  await writeFile(join(control, 'language-fail'), '')
  await setText(page, floatingB, 'Cus')
  await page.keyboard.press('Control+Space')
  await expect(page.getByLabel('SQL IntelliSense', { exact: true })).toHaveText('IntelliSense unavailable')
  await expect(page.getByLabel('SQL IntelliSense', { exact: true })).toHaveAttribute('title', 'SQL language test provider failed.')
  await page.keyboard.press('Escape')
  await rm(join(control, 'language-fail'))
  const marker = await page.evaluate(() => globalThis.__languageRefreshPage = crypto.randomUUID())
  const refreshCount = (await languageCalls('language.refresh')).length
  await page.keyboard.press(`${mod}+Shift+R`)
  await expect.poll(async () => (await languageCalls('language.refresh')).length).toBe(refreshCount + 1)
  expect((await languageCalls('language.refresh')).at(-1).params).toMatchObject({ documentId: documentB, text: 'Cus', context: { connectionId: idB, database: 'master' } })
  expect(await page.evaluate(() => globalThis.__languageRefreshPage)).toBe(marker)
  await expect.poll(() => text(floatingB)).toBe('Cus')
  await suggestAndAccept(page, floatingB, 'CustomerMaster')
  await hover(page, floatingB, 'language-server-b/master')
  console.log('Language checks: the floating editor displays its own widgets, and Refresh Local Cache recovers a failed provider without reloading or changing SQL.')

  await moveEditor(tabB, 'Dock')
  await expect(floatingEditorGroups(page)).toHaveCount(0)
  if (await editorGroups(page).count() === 1) {
    await documentTab(page, tabB).click()
    await editorTextbox(page).focus()
    await page.keyboard.press(`${mod}+\\`)
  }
  await expect(editorGroups(page)).toHaveCount(2)
  const opened = application.waitForEvent('window', { timeout: 30000 })
  await movePane(page, 'results', 'window')
  const popout = await opened
  popout.setDefaultTimeout(15000)
  popout.on('pageerror', error => failures.push(error.message))
  await expect(popoutTabs(popout)).toBeVisible()
  await expect(editorTextbox(popout)).toHaveCount(0)
  expect(await popout.evaluate(() => typeof window.varia)).toBe('undefined')
  await popout.bringToFront()
  await popoutDockButton(popout).focus()
  await suggestAndAccept(page, editorGroupForDocument(page, tabA), 'CustomerAppData')
  await ownContext(documentA, idA, 'AppData')
  await hover(page, editorGroupForDocument(page, tabA), 'language-server-a/AppData')
  await popout.bringToFront()
  await popoutDockButton(popout).focus()
  await suggestAndAccept(page, editorGroupForDocument(page, tabB), 'CustomerMaster')
  await ownContext(documentB, idB, 'master')
  await hover(page, editorGroupForDocument(page, tabB), 'language-server-b/master')
  console.log('Language checks: returning from the Results OS popout preserves suggestion and hover context in both main-window editors.')

  await popoutDockButton(popout).click()
  await expect.poll(() => popout.isClosed()).toBe(true)
  await page.bringToFront()
  await expect(editorGroups(page)).toHaveCount(2)
  await suggestAndAccept(page, editorGroupForDocument(page, tabA), 'CustomerAppData')
  await ownContext(documentA, idA, 'AppData')
  await suggestAndAccept(page, editorGroupForDocument(page, tabB), 'CustomerMaster')
  await ownContext(documentB, idB, 'master')
  console.log('Language checks: docking Results back preserves both documents and their language contexts.')
  expect(failures).toEqual([])
  await close()
  console.log('Language-service suite passed.')
} catch (error) {
  console.error(error)
  if (page) await page.screenshot({ path: resolve('artifacts', 'language-services-failure.png') }).catch(() => {})
  process.exitCode = 1
  await close().catch(() => application?.process()?.kill())
} finally {
  clearTimeout(watchdog)
}
