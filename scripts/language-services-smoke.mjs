import { electron, expect } from './fixtures/smoke.mjs'
import { activeDocumentName, backendReady, documentTab, editorGroupForDocument, editorGroups, editorHover, editorOverflowHosts, editorSurface, editorText, editorTextbox, floatingEditorGroups, movePane, part, popoutDockButton, popoutTabs, queryDatabase, queryServer, suggestionItems, suggestionOption, suggestionWidget, toolbarButton } from './fixtures/ui.mjs'
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
  await expect(page.locator('.monaco-editor[role=code]')).toBeVisible({ timeout: 30000 })
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
async function widgetGeometry(target, widget, scope, outside = false) {
  await expect(widget).toBeVisible()
  const box = await editorSurface(scope).boundingBox()
  await expect.poll(() => widget.evaluate((element, editor) => {
    const rect = element.getBoundingClientRect(), inset = 6
    const points = [[rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset], [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset], [rect.left + rect.width / 2, rect.top + rect.height / 2]]
    return {
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      receivesPointer: points.every(([x, y]) => element.contains(document.elementFromPoint(x, y))),
      outsideEditor: rect.left < editor.x - 1 || rect.top < editor.y - 1 || rect.right > editor.x + editor.width + 1 || rect.bottom > editor.y + editor.height + 1
    }
  }, box)).toMatchObject({ inViewport: true, receivesPointer: true, ...outside ? { outsideEditor: true } : {} })
}
async function hover(target, scope, contents, outside = false, screenshot) {
  await target.bringToFront()
  await editorTextbox(scope).focus()
  await target.keyboard.press('Home')
  await target.keyboard.press('ArrowRight')
  await target.keyboard.press(`${mod}+K`)
  await target.keyboard.press(`${mod}+I`)
  const widget = editorHover(target, contents)
  await widgetGeometry(target, widget, scope, outside)
  if (screenshot) await target.screenshot({ path: resolve('artifacts', screenshot) })
  await target.keyboard.press('Escape')
}
async function resizeQueryHeight(height) {
  const surface = editorSurface(page).first(), before = await surface.boundingBox()
  const sash = page.locator('.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash.dv-enabled').first()
  const box = await sash.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + height - before.height, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await surface.boundingBox()).height).toBeLessThanOrEqual(height + 4)
}
async function moveFloatingQuery(name, x, y) {
  const frame = page.locator('.dv-resize-container').filter({ has: documentTab(page, name) })
  const before = await frame.boundingBox(), handle = await frame.locator('.dv-floating-titlebar').boundingBox()
  const area = await page.locator(part.editorArea).boundingBox(), start = Math.max(handle.x + 20, area.x + 20)
  await page.keyboard.down('Control')
  try {
    await page.mouse.move(start, handle.y + handle.height / 2)
    await page.mouse.down()
    // Dockview measures from the first move of a drag.
    await page.mouse.move(start + 1, handle.y + handle.height / 2)
    await page.mouse.move(start + x - before.x, handle.y + handle.height / 2 + y - before.y, { steps: 10 })
    await page.mouse.up()
  } finally { await page.keyboard.up('Control') }
  await expect.poll(async () => Math.abs((await frame.boundingBox()).x - x)).toBeLessThan(3)
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
  await expect.poll(() => editorOverflowHosts(page).evaluateAll(hosts => hosts.every(host => getComputedStyle(host).backgroundColor === 'rgba(0, 0, 0, 0)'))).toBe(true)
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

  // The original clipping bug: the query panel is near its minimum height, with Results immediately underneath. A visible DOM
  // node alone passes even when clipped, so check every widget corner by hit testing outside the editor's rectangle.
  const normalHeight = (await editorSurface(page).boundingBox()).height
  await resizeQueryHeight(110)
  await writeFile(join(control, 'language-widget-overflow'), '')
  await hover(page, page, 'Customer table (fake language service).', true, 'language-hover-small-editor.png')
  await setText(page, page, 'Cus')
  await page.keyboard.press('Control+Space')
  await expect(suggestionOption(page, 'Customer0')).toBeVisible()
  await widgetGeometry(page, suggestionWidget(page), page, true)
  await page.screenshot({ path: resolve('artifacts', 'language-suggest-small-editor.png') })
  if (process.platform !== 'darwin') {
    await page.keyboard.press('Shift+F10')
    const editorMenu = page.getByRole('menu', { name: 'Query editor', exact: true })
    await expect(editorMenu).toBeVisible()
    await widgetGeometry(page, editorMenu, page)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Space')
    await expect(suggestionOption(page, 'Customer0')).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await rm(join(control, 'language-widget-overflow'))
  await page.keyboard.press('Control+Space')
  await expect(suggestionOption(page, 'Customer')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect.poll(() => text(page)).toBe('Customer')
  await resizeQueryHeight(normalHeight)
  console.log('Language checks: real hover and completion widgets stay visible and interactive beyond a small query panel.')

  await writeFile(join(control, 'language-ordering'), '')
  await setText(page, page, 'h')
  await page.keyboard.press('Control+Space')
  await expect(suggestionItems(page).first()).toContainText('dbo.hiColumn')
  await expect(suggestionItems(page).nth(1)).toContainText('hiProperty')
  await page.keyboard.press('Tab')
  await expect.poll(() => text(page)).toBe('hiColumn')
  await setText(page, page, 'hi')
  await page.keyboard.press('Control+Space')
  await expect(suggestionItems(page).first()).toHaveAccessibleName(/^hi(?:,|$)/)
  await page.keyboard.press('Escape')
  await rm(join(control, 'language-ordering'))
  console.log('Language checks: equal prefix matches favor fields over globals, functions and keywords; an exact function match still ranks first.')

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
  await expect(editorOverflowHosts(page)).toHaveCount(2)
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
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await moveFloatingQuery(tabB, viewport.width - 300, viewport.height - 180)
  await hover(page, floatingB, 'language-server-b/master', true, 'language-hover-viewport-edge.png')
  await setText(page, floatingB, 'Cus')
  await page.keyboard.press('Control+Space')
  await expect(suggestionOption(page, 'CustomerMaster')).toBeVisible()
  await widgetGeometry(page, suggestionWidget(page), floatingB, true)
  await page.screenshot({ path: resolve('artifacts', 'language-suggest-viewport-edge.png') })
  await page.keyboard.press('Tab')
  await expect.poll(() => text(floatingB)).toBe('CustomerMaster')
  await moveFloatingQuery(tabB, -40, 180)
  await hover(page, floatingB, 'language-server-b/master', false, 'language-hover-left-edge.png')
  await moveFloatingQuery(tabB, 380, 180)

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
  await expect(editorOverflowHosts(page)).toHaveCount(2)
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

  // Hide output to extend the query to the viewport's bottom, then scroll the caret to the last line. Both widgets
  // must choose the room above it while the other editor group remains visible beside this one.
  await page.keyboard.press(`${mod}+r`)
  const bottomB = editorGroupForDocument(page, tabB), windowHeight = await page.evaluate(() => innerHeight)
  await expect.poll(async () => { const box = await editorSurface(bottomB).boundingBox(); return box.y + box.height }).toBeGreaterThan(windowHeight - 40)
  await setText(page, bottomB, '\n'.repeat(100) + 'CustomerMaster')
  await hover(page, bottomB, 'language-server-b/master', false, 'language-hover-bottom-edge.png')
  await setText(page, bottomB, '\n'.repeat(100) + 'Cus')
  await page.keyboard.press('Control+Space')
  await expect(suggestionOption(page, 'CustomerMaster')).toBeVisible()
  await widgetGeometry(page, suggestionWidget(page), bottomB)
  await page.screenshot({ path: resolve('artifacts', 'language-suggest-bottom-edge.png') })
  await page.keyboard.press('Escape')
  await page.keyboard.press(`${mod}+r`)
  console.log('Language checks: hover and suggestions remain inside the viewport beside a last-line caret at the bottom edge.')
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
