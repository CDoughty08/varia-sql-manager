import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseExplorerMenuItem, expandExplorerPath, explorerMenuItems, explorerRow, expectSelectedExplorerRow, explorerSubmenuItems, explorerTree, openExplorerMenu, revealExplorerRow } from './fixtures/explorer-tree.mjs'
import { resizeWindow } from './fixtures/window-resize.mjs'
import { actionsStubData, caution, dependentsMessage, detachFiles, detachScript, installActionsStub, longDatabase, longRole, offlineScript, offlineWarning, propertiesScript, restoreFilesScript, restoreScript, scriptText, stubServerFiles, stubSessions } from './fixtures/actions-stub.mjs'
import {
  addObjectDialogSteps, attachFileNameShown, backendReady, closeDocumentButton, documentBanner, documentCrumbs, documentFrame, documentState, documentSubtitle, documentTab, documentTabs, documentVerb, editorText, editorTextbox,
  errorBanner, explorerLabel, fieldHint, frameSection, inputShowsEnd, objectDialogConnection, objectDialogPage, objectDialogProgress, objectDialogSessions, objectDialogSessionsToggle, objectDialogTabs, objectDialogWarnings, openMenus as openMenusOf, part,
  passwordField, propertyFact, propertyRow, renameBox, scriptActions, scriptDrawer, scriptNotice, scriptText as drawerText, scriptToggle, sectionList as sectionListOf, statusSegment, toastMessage, toasts, toolbarButton, unsavedMark,
  warningBanner as warningBannerOf
} from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'object-actions-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const mac = process.platform === 'darwin'
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Object actions suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 300000)

const menuNamed = name => page.getByRole('menu', { name, exact: true })
const explorerMenu = () => menuNamed('Object Explorer')
const openMenus = () => openMenusOf(page)
const dialog = () => page.getByRole('dialog', { name: 'Delete Object', exact: true })
const commandBanner = () => errorBanner(page)
const warningBanner = () => warningBannerOf(page)
const tabs = () => documentTabs(page).getByRole('tab')
const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText())
const stubCalls = method => application.evaluate((_electron, name) => globalThis.variaStub.calls.filter(call => call.method === name).map(call => call.params), method)
const appData = ['server-a', 'Databases', 'AppData']
const tablesPath = [...appData, 'Tables']
const ordersPath = [...tablesPath, 'dbo.Orders']

async function connect(server) {
  await toolbarButton(page, 'Connect').click()
  const connectDialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(connectDialog.getByText('Loading saved connections…')).toHaveCount(0)
  await connectDialog.getByLabel('Server Name', { exact: true }).fill(server)
  await connectDialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await connectDialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(connectDialog).toHaveCount(0, { timeout: 30000 })
}
/** Opens a row's menu (explorerMenuItems) and returns its item labels; the menu stays open. */
async function menuOf(...path) {
  return (await explorerMenuItems(page, ...path)).names
}
async function closeMenu() {
  await page.keyboard.press('Escape')
  await expect(openMenus()).toHaveCount(0)
}
/** Selects a row with a click on its label, which also focuses the tree. */
async function select(...path) {
  await explorerLabel(await revealExplorerRow(page, ...path)).click()
  await expect(explorerTree(page)).toBeFocused()
}

try {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
  await application.evaluate(installActionsStub, actionsStubData())
  await connect('server-a')
  // A row moves when a folder above it finishes loading, as Views does when Tables' rows arrive. Here Views' row moves
  // between the press on its chevron and the release, once, so that click is lost: expanding the path must click again
  // rather than wait for an expansion that never comes (a Windows run failed so).
  await page.evaluate(({ twistie, label }) => {
    const move = event => {
      const row = event.target.closest?.('[role="treeitem"]')
      if (!event.target.closest?.(twistie) || row?.querySelector(label)?.textContent !== 'Views') return
      window.removeEventListener('pointerdown', move, true)
      row.style.translate = `0 ${row.offsetHeight}px`
      setTimeout(() => { row.style.translate = '' }, 50)
      window.__variaMovedPress = true
    }
    window.addEventListener('pointerdown', move, true)
  }, { twistie: part.explorerTwistie, label: part.explorerLabel })
  // Top down, so no row moves once its own folder has loaded: a right-click must land on the row it selects.
  for (const path of [['server-a', 'Databases', 'System Databases'], tablesPath, [...appData, 'Views'], [...appData, 'Programmability', 'Stored Procedures']]) await expandExplorerPath(page, ...path)
  expect(await page.evaluate(() => window.__variaMovedPress)).toBe(true)
  await expect(explorerTree(page)).toHaveAttribute('aria-busy', 'false')

  // 1. SSMS's order: the query items, Script … as, Copy Name, then Rename and Delete, then Refresh; SQL Server's own
  // database shows Rename and Delete greyed, and F2 does nothing there.
  expect(await menuOf(...ordersPath)).toEqual(['Select Top 1000 Rows', 'Script Table as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  await closeMenu()
  expect(await menuOf(...appData, 'Views', 'dbo.OrderSummary')).toEqual(['Select Top 1000 Rows', 'Script View as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  await closeMenu()
  expect(await menuOf(...appData, 'Programmability', 'Stored Procedures', 'dbo.ShipOrder')).toEqual(['Modify', 'Script Stored Procedure as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  await closeMenu()
  expect(await menuOf(...appData)).toEqual(['New Database…', 'New Query', 'Script Database as', 'Tasks', 'Copy Name', 'Rename', 'Delete', 'Refresh', 'Properties'])
  await closeMenu()
  // SSMS offers Properties on its own databases too: only Rename, Delete and Tasks' items are greyed. Tasks holds Detach…, Take
  // Offline, Bring Online and Restore › Database… so far, all greyed there (system databases restore with T-SQL), so the submenu is greyed too.
  expect(await explorerMenuItems(page, 'server-a', 'Databases', 'System Databases', 'master')).toEqual({
    names: ['New Database…', 'New Query', 'Script Database as', 'Tasks', 'Copy Name', 'Rename', 'Delete', 'Refresh', 'Properties'], disabled: ['Tasks', 'Rename', 'Delete']
  })
  await closeMenu()
  await select('server-a', 'Databases', 'System Databases', 'master')
  await page.keyboard.press('F2')
  await expect(renameBox(page)).toHaveCount(0)
  await page.keyboard.press('Delete')
  await expect(dialog()).toHaveCount(0)
  console.log('Object action checks: table, view, procedure and database menus in SSMS\'s order, Properties last, with master\'s Rename and Delete greyed and its keys inert.')

  // 2. Select Top 1000 Rows on a view lists its columns and runs on its database.
  const before = await tabs().count()
  await chooseExplorerMenuItem(page, [...appData, 'Views', 'dbo.OrderSummary'], 'Select Top 1000 Rows')
  const selectTop = ['/****** Script for SelectTopNRows command from Varia SQL Manager ******/', 'SELECT TOP (1000) [OrderId]', '      ,[Total]', '  FROM [AppData].[dbo].[OrderSummary]'].join(process.platform === 'win32' ? '\r\n' : '\n')
  // New queries take the platform's line ending, as SSMS's do.
  await expect.poll(async () => (await stubCalls('query.execute')).at(-1)?.sql).toBe(selectTop)
  expect((await stubCalls('query.execute')).at(-1).database).toBe('AppData')
  expect((await stubCalls('tables.columns')).at(-1)).toEqual({ connectionId: expect.any(String), database: 'AppData', schema: 'dbo', name: 'OrderSummary' })
  await expect(tabs()).toHaveCount(before + 1)
  console.log('Object action checks: Select Top 1000 Rows on a view opens its column list and runs it on AppData.')

  // 3. F2: the box holds the name without its schema, all selected; Escape sends nothing; Enter renames and reselects.
  await select(...ordersPath)
  await page.keyboard.press('F2')
  const box = page.getByRole('textbox', { name: 'Rename Table', exact: true })
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('Orders')
  expect(await box.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([0, 6])
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  await expect(explorerTree(page)).toBeFocused()
  expect(await stubCalls('actions.execute')).toEqual([])
  await page.keyboard.press('F2')
  await expect(box).toBeFocused()
  await page.keyboard.type('Orders2')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'rename', target: { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }, newName: 'Orders2' })
  const renamed = await explorerRow(page, ...tablesPath, 'dbo.Orders2')
  await expect(renamed).toHaveAttribute('aria-selected', 'true')
  await expect(explorerTree(page)).toBeFocused()
  await expect(warningBanner()).toHaveText(caution)
  await page.getByRole('button', { name: 'Dismiss warning', exact: true }).click()
  // A name already in use: the banner says so, and the label shows the old name again.
  await select(...tablesPath, 'dbo.Orders2')
  await page.keyboard.press('F2')
  await expect(box).toHaveValue('Orders2')
  await page.keyboard.type('Taken')
  await page.keyboard.press('Enter')
  await expect(commandBanner()).toHaveText('Rename failed for dbo.Orders2: The name Taken is already in use in this schema.')
  await expect(box).toHaveCount(0)
  await expect(explorerLabel(renamed)).toHaveText('dbo.Orders2')
  await page.getByRole('button', { name: 'Dismiss command error', exact: true }).click()
  console.log('Object action checks: F2 renames inline with the name selected, Escape sends nothing, Enter renames and reselects, and NAME_IN_USE reverts the label.')

  // A rename waiting on a lock shows in the status bar; its Stop cancels it, and the object keeps its name.
  await select(...tablesPath, 'dbo.Orders2')
  await page.keyboard.press('F2')
  await expect(box).toHaveValue('Orders2')
  await page.keyboard.type('Blocked')
  await page.keyboard.press('Enter')
  const status = statusSegment(page)
  await expect(status).toContainText('Renaming dbo.Orders2 to Blocked…')
  const blockedId = (await stubCalls('actions.execute')).at(-1).requestId
  await status.getByRole('button', { name: 'Stop rename', exact: true }).click()
  await expect.poll(() => application.evaluate(() => globalThis.variaStub.cancels)).toContain(blockedId)
  await expect(status).not.toContainText('Renaming')
  await expect(explorerLabel(renamed)).toHaveText('dbo.Orders2')
  await expect(commandBanner()).toHaveCount(0)
  console.log('Object action checks: a rename waiting on a lock shows in the status bar, and its Stop cancels it in the backend and keeps the name.')

  // 4. Delete opens exactly one Delete Object dialog, consuming the key (the hidden menu's Delete role does not also run).
  await select(...tablesPath, 'dbo.Lines')
  await page.evaluate(() => { addEventListener('keydown', event => { if (event.key === 'Delete') window.variaDeleteKey = event.defaultPrevented }, true) })
  await page.keyboard.press(mac ? 'Meta+Backspace' : 'Delete')
  await expect(dialog()).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  if (!mac) expect(await page.evaluate(() => window.variaDeleteKey)).toBe(true)
  await expect(dialog().getByRole('navigation', { name: 'Select a page' }).getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page')
  await expect(objectDialogConnection(dialog()).locator('dd')).toHaveText(['server-a', 'sa'])
  await expect(objectDialogProgress(dialog())).toHaveText('Ready')
  await expect(dialog().getByRole('grid').locator('tbody td')).toHaveText(['dbo.Lines', 'Table', 'dbo', '', ''])
  // Where the dialog is narrower than 720 px (zoomed in on a 1024 × 768 window, a viewport under 768 CSS px), "Select a
  // page" is a row of tabs, the Connection and Progress boxes wrap onto a row of their own inside the dialog, and the
  // page keeps its room; forced colours mark the selected tab alone. Back at 100 %, the list returns, and a long run's
  // steps scroll within the column, above OK.
  const sizeBefore = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  const zoomBefore = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
  const zoom = factor => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value), factor)
  await resizeWindow(application, page, 1024, 768)
  await zoom(1.5)
  await expect(objectDialogTabs(dialog())).toHaveCount(1)
  await expect(objectDialogTabs(dialog()).first()).toHaveAttribute('aria-selected', 'true')
  const narrowFrame = async () => {
    const boxes = await Promise.all([dialog(), objectDialogTabs(dialog()).first(), objectDialogConnection(dialog()), dialog().getByRole('region', { name: 'Progress', exact: true }), dialog().getByRole('tabpanel')].map(locator => locator.boundingBox()))
    if (boxes.some(box => !box)) return 'not laid out'
    const [form, tab, connection, progress, shown] = boxes
    const inside = box => box.width >= 100 && box.x >= form.x - 1 && box.x + box.width <= form.x + form.width + 1 && box.y >= tab.y + tab.height - 1 && box.y + box.height <= form.y + form.height
    return { viewport: await page.evaluate(() => innerWidth < 768), tab: tab.height <= 40, boxes: inside(connection) && inside(progress), page: shown.height >= form.height * 0.3 }
  }
  await expect.poll(narrowFrame, 'the narrow frame: a short tab row, both boxes inside the dialog below it, and room for the page').toEqual({ viewport: true, tab: true, boxes: true, page: true })
  await page.screenshot({ path: resolve('artifacts', 'object-actions-delete-narrow-dark.png') })
  await page.emulateMedia({ forcedColors: 'active' })
  // A second, unselected tab beside the selected one (Delete Object has one page): only the selected one has a bar.
  const bars = await objectDialogTabs(dialog()).first().evaluate(tab => {
    const other = tab.cloneNode(true)
    other.setAttribute('aria-selected', 'false')
    tab.after(other)
    const colors = [tab, other].map(node => getComputedStyle(node).borderBottomColor)
    other.remove()
    return colors
  })
  await page.emulateMedia({ forcedColors: null })
  expect(bars[0], 'forced colours: the selected tab\'s bar differs from an unselected tab\'s').not.toBe(bars[1])
  await zoom(zoomBefore)
  await expect(dialog().getByRole('navigation', { name: 'Select a page' }).getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page')
  await expect(objectDialogTabs(dialog())).toHaveCount(0)
  const removeSteps = await addObjectDialogSteps(dialog(), 40)
  const [stepsBox, okBox, pageBox] = await Promise.all([dialog().getByRole('region', { name: 'Steps', exact: true }), dialog().getByRole('button', { name: 'OK', exact: true }), objectDialogPage(dialog())].map(locator => locator.boundingBox()))
  await removeSteps()
  expect(stepsBox.y + stepsBox.height, 'forty steps end above OK').toBeLessThanOrEqual(okBox.y)
  expect(pageBox.height, 'the page keeps its room under forty steps').toBeGreaterThan(60)
  await resizeWindow(application, page, ...sizeBefore)
  await expect(objectDialogWarnings(dialog())).toHaveText(['Referenced by foreign key FK_Items_Lines on dbo.Items; the DROP fails until it is dropped.'])
  // Script › Script Action to Clipboard puts the action's script there; the dialog stays open, as in SSMS.
  await dialog().getByRole('button', { name: 'Script options', exact: true }).click()
  await dialog().getByRole('option', { name: 'Script Action to Clipboard', exact: true }).click()
  await expect.poll(clipboard).toBe(scriptText('Lines'))
  await expect(dialog()).toBeVisible()
  expect((await stubCalls('actions.script')).at(-1)).toMatchObject({ action: 'delete', target: { name: 'Lines' }, closeConnections: false, deleteHistory: false })
  // OK: the foreign key blocks the DROP, so the dialog stays with the error.
  await dialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog().getByRole('alert')).toHaveText(dependentsMessage)
  await expect(dialog().getByRole('grid').locator('tbody td').nth(3)).toHaveText('Error')
  await expect(objectDialogProgress(dialog())).toHaveText('Error')
  await page.screenshot({ path: resolve('artifacts', 'object-actions-delete-dark.png') })
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  await expect(explorerTree(page)).toBeFocused()
  // OK deletes dbo.Orders2: the dialog closes, Tables reloads without it, and the tree has focus.
  await chooseExplorerMenuItem(page, [...tablesPath, 'dbo.Orders2'], 'Delete')
  await expect(objectDialogProgress(dialog())).toHaveText('Ready')
  await dialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  await expect.poll(async () => (await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'delete', target: { name: 'Orders2' } })
  await expect(explorerTree(page).locator(part.explorerLabel, { hasText: 'dbo.Orders2' })).toHaveCount(0)
  await expect(explorerTree(page)).toBeFocused()
  console.log('Object action checks: Delete opens one Delete Object dialog, Script Action to Clipboard leaves it open, DEPENDENTS keeps it with the error, and OK deletes and reloads Tables.')

  // 5. Database Properties as a document: a tab rather than a modal, SSMS's pages as sections with their list, facts as
  // text, switches and segments, a description on focus, a Script drawer whose preview and Copy carry only the changes,
  // a frame and draft kept across tab switches, Select Database Owner over the document, Enter that never applies, the
  // Open Connections prompt before Apply, and the close prompt.
  await application.evaluate(({ dialog }) => {
    globalThis.variaStub.prompts = []
    globalThis.variaStub.answers = []
    dialog.showMessageBox = async (_window, options) => {
      globalThis.variaStub.prompts.push({ title: options.title, message: options.message, buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId })
      return { response: globalThis.variaStub.answers.shift() ?? options.cancelId, checkboxChecked: false }
    }
  })
  const tabCount = await tabs().count()
  // A 1280 × 800 window, where the sections column is about 770 px wide: descriptions and file paths must still read whole.
  // The page's resize event closes menus and can land after the next one opens, so each change waits for it.
  const windowSize = ([width, height]) => resizeWindow(application, page, width, height)
  const restoreSize = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  await windowSize([1280, 800])
  /** Whether any of the elements cuts its text: wider or taller content than its box. */
  const cut = locator => locator.evaluateAll(elements => elements.filter(element => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1).map(element => element.textContent))
  /** The words split across lines (Not Applicabl|e): each word of the elements' text must sit on one line, wherever the text wraps. */
  const brokenWords = locator => locator.evaluateAll(elements => {
    const broken = []
    for (const cell of elements) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of node.data.matchAll(/\S+/g)) {
          const range = document.createRange()
          range.setStart(node, match.index)
          range.setEnd(node, match.index + match[0].length)
          const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size
          if (lines > 1) broken.push(match[0])
        }
      }
    }
    return broken
  })
  const properties = () => documentFrame(page, 'AppData')
  const propertiesTab = () => documentTab(page, 'Database Properties - AppData')
  const verb = name => documentVerb(properties(), 'AppData', name)
  const sectionList = () => sectionListOf(properties())
  const fact = label => propertyFact(properties(), label)
  // Tables has just reloaded after the Delete, which can move the rows under the press: chooseExplorerMenuItem presses
  // until AppData's own menu opens.
  await chooseExplorerMenuItem(page, appData, 'Properties')
  await expect(properties()).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(tabs()).toHaveCount(tabCount + 1)
  await expect(propertiesTab()).toHaveAttribute('aria-selected', 'true')
  await expect(documentCrumbs(properties())).toHaveText(['server-a', 'Databases'])
  await expect(documentSubtitle(properties())).toHaveText('Database Properties')
  await expect(documentState(properties())).toHaveText('Normal')
  await expect(verb('Refresh')).toBeEnabled()
  await expect(verb('Discard Changes')).toBeDisabled()
  await expect(verb('Apply')).toBeDisabled()
  await expect(sectionList().getByRole('button')).toHaveText(['General', 'Files', 'Filegroups', 'Options'])
  await expect(sectionList().getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'location')
  // Facts are text, not greyed inputs.
  await expect(fact('Name')).toHaveText('AppData')
  await expect(fact('Status')).toHaveText('Normal')
  await expect(fact('Last Database Backup')).toHaveText('None')
  await expect(fact('Number of Users')).toHaveText('4')
  await expect(frameSection(properties(), 'General').locator('input, select, textarea')).toHaveCount(0)
  // No row here has a description, so the hint strip is not there at all: no blank band under the rows.
  await expect(fieldHint(properties())).toBeHidden()
  await page.screenshot({ path: resolve('artifacts', 'database-properties-general-dark.png') })
  // The section list answers SSMS's page keys from the focused section.
  await expect(sectionList().getByRole('button', { name: 'General' })).toBeFocused()
  for (const name of ['Files', 'Filegroups', 'Options']) {
    await page.keyboard.press('ArrowDown')
    await expect(sectionList().getByRole('button', { name })).toHaveAttribute('aria-current', 'location')
  }
  // Tab goes into the section chosen, not to the first control in the column (Files' Owner).
  await page.keyboard.press('Tab')
  await expect(properties().getByLabel('Collation', { exact: true })).toBeFocused()
  await expect(sectionList().getByRole('button', { name: 'Options' })).toHaveAttribute('aria-current', 'location')
  // A short enum is a segmented control: one tab stop, and the arrows choose as they move.
  const recovery = properties().getByRole('radiogroup', { name: 'Recovery model', exact: true })
  await expect(recovery.getByRole('radio', { name: 'Full', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(recovery.locator('[tabindex="0"]')).toHaveCount(1)
  await recovery.getByRole('radio', { name: 'Simple', exact: true }).click()
  await expect(recovery.getByRole('radio', { name: 'Simple', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(recovery.getByRole('radio', { name: 'Bulk-logged', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(recovery.getByRole('radio', { name: 'Bulk-logged', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(recovery.getByRole('radio', { name: 'Simple', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(recovery).toHaveAttribute('data-changed', 'true')
  // A boolean is a switch, and its whole description shows in the hint strip while it has focus or the pointer.
  const autoClose = properties().getByRole('switch', { name: 'Auto Close', exact: true })
  const autoCloseDescription = 'Specify whether the database shuts down cleanly and frees resources after the last user exits.'
  const hint = fieldHint(properties())
  await expect(autoClose).not.toBeChecked()
  await expect(autoClose).toHaveAccessibleDescription(autoCloseDescription)
  await expect(hint).not.toHaveText(autoCloseDescription)
  await autoClose.focus()
  await expect(hint).toHaveText(`Auto Close ${autoCloseDescription}`)
  expect(await cut(hint)).toEqual([])
  // The pointer's row wins while it is there, and the longest description wraps whole within the strip's two lines. The
  // strip lies over the rows, so neither showing it nor changing its text moves the row under the pointer.
  const pointed = propertyRow(properties(), 'Date Correlation Optimization Enabled')
  await pointed.scrollIntoViewIfNeeded()
  const pointedTop = (await pointed.boundingBox()).y
  await pointed.hover()
  await expect(hint).toHaveAttribute('data-field', /dateCorrelationOptimization$/)
  expect(await cut(hint)).toEqual([])
  expect((await pointed.boundingBox()).y).toBe(pointedTop)
  await page.mouse.move(0, 0)
  await expect(hint).toHaveAttribute('data-field', /autoClose$/)
  await page.keyboard.press('Space')
  await expect(autoClose).toBeChecked()
  await expect(autoClose).toHaveAttribute('data-changed', 'true')
  // The Changed mark is part of the switch's description, so a screen reader hears it too.
  await expect(autoClose).toHaveAccessibleDescription(`Changed ${autoCloseDescription}`)
  await expect(properties().getByRole('switch', { name: 'Auto Shrink', exact: true })).not.toHaveAttribute('data-changed', 'true')
  await expect(unsavedMark(propertiesTab())).toHaveCount(1)
  await expect(verb('Apply')).toBeEnabled()
  await expect(verb('Refresh')).toBeDisabled()
  // Tab stops at a read-only row too, as SSMS's read-only rows can be selected: a screen reader hears its label, value and
  // description, and the hint strip shows the description.
  const trustworthy = properties().getByRole('textbox', { name: 'Trustworthy', exact: true })
  for (let presses = 0; presses < 80 && !await trustworthy.evaluate(element => element === document.activeElement); presses++) await page.keyboard.press('Tab')
  await expect(trustworthy).toBeFocused()
  await expect(trustworthy).toHaveAttribute('aria-readonly', 'true')
  await expect(trustworthy).toHaveText('False')
  const trustworthyDescription = await properties().locator(`[id="${await trustworthy.getAttribute('id')}-description"]`).textContent()
  expect(trustworthyDescription.length).toBeGreaterThan(10)
  await expect(trustworthy).toHaveAccessibleDescription(trustworthyDescription)
  await expect(hint).toHaveText(`Trustworthy ${trustworthyDescription}`)
  await page.screenshot({ path: resolve('artifacts', 'database-properties-options-dark.png') })
  // The Script drawer previews only the changes, and Copy takes what it shows; the document stays as it was.
    // A text box keeps its value with LF line ends; Copy takes the script as the backend wrote it.
  const shownScript = propertiesScript.replaceAll('\r\n', '\n')
  await scriptToggle(properties()).click()
  await expect(drawerText(properties())).toHaveValue(shownScript)
  expect((await stubCalls('actions.script')).at(-1)).toEqual({ action: 'properties', connectionId: expect.any(String), requestId: expect.any(String), target: { kind: 'database', name: 'AppData' },
    closeConnections: false, changes: { options: { recoveryModel: 'SIMPLE', autoClose: 'true' } }, identity: { id: 7, created: '2026-01-02T03:04:05.000' } })
  const scriptRequests = (await stubCalls('actions.script')).length
  await scriptActions(properties(), 'Copy').click()
  await expect(scriptNotice(properties()).filter({ hasText: 'Script copied to the clipboard.' })).toHaveCount(1)
  await expect.poll(clipboard).toBe(propertiesScript)
  expect((await stubCalls('actions.script')).length).toBe(scriptRequests)
  await page.screenshot({ path: resolve('artifacts', 'database-properties-script-dark.png') })
  // Save Script As… writes the script to the file main's save dialog picks.
  const savedScript = resolve(profile, 'database-properties.sql')
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, savedScript)
  await scriptActions(properties(), 'Save Script As…').click()
  await expect(scriptNotice(properties()).filter({ hasText: 'Saved database-properties.sql.' })).toHaveCount(1)
  expect(await readFile(savedScript, 'utf8')).toContain('ALTER DATABASE [AppData] SET RECOVERY SIMPLE WITH NO_WAIT')
  // Open in Query Window opens the script in a new query, which takes the tab away; coming back, the section, the drawer
  // and the draft are as they were.
  await scriptActions(properties(), 'Open in Query Window').click()
  await expect(tabs()).toHaveCount(tabCount + 2)
  await expect(properties()).toHaveCount(0)
  // Monaco draws spaces as no-break spaces.
  await expect.poll(async () => (await editorText(page)).replaceAll('\u00a0', ' ')).toContain('ALTER DATABASE [AppData] SET AUTO_CLOSE ON WITH NO_WAIT')
  expect((await stubCalls('actions.script')).length).toBe(scriptRequests)
  await propertiesTab().click()
  await expect(sectionList().getByRole('button', { name: 'Options' })).toHaveAttribute('aria-current', 'location')
  await expect(drawerText(properties())).toHaveValue(shownScript)
  await expect(recovery.getByRole('radio', { name: 'Simple', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(autoClose).toBeChecked()
  // Files: the owner's browse button opens Select Database Owner over the document; Escape closes only it, Enter chooses.
  await sectionList().getByRole('button', { name: 'Files' }).click()
  await expect(properties().getByRole('table', { name: 'Database files', exact: true }).locator('tbody tr')).toHaveCount(2)
  await expect(properties().getByRole('table', { name: 'Database files', exact: true }).locator('tbody tr').first().locator('td')).toHaveText(['AppData', 'ROWS Data', 'PRIMARY', '8', 'By 64 MB, Unlimited', 'C:\\Data', 'AppData.mdf'])
  // No cell is cut: the grids size their columns to their text and wrap what does not fit. Only a path breaks inside a
  // word (the log file's long one takes the width the rest leave), so names and words read whole (never Not Applicabl|e),
  // and the grid still fits its width at 1280 × 800.
  const filesGrid = properties().getByRole('table', { name: 'Database files', exact: true })
  expect(await cut(properties().getByRole('table').locator('th, td'))).toEqual([])
  expect(await brokenWords(filesGrid.locator('th, td:not(:nth-child(6))'))).toEqual([])
  expect(await brokenWords(properties().getByRole('table', { name: 'Rows', exact: true }).locator('th, td'))).toEqual([])
  expect(await filesGrid.evaluate(grid => grid.parentElement.scrollWidth - grid.parentElement.clientWidth)).toBe(0)
  await page.screenshot({ path: resolve('artifacts', 'database-properties-files-dark.png') })
  const owner = page.getByRole('dialog', { name: 'Select Database Owner', exact: true })
  await properties().getByRole('button', { name: 'Browse for the owner', exact: true }).click()
  await expect(owner.getByLabel('Logins:', { exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(owner).toHaveCount(0)
  await expect(properties()).toBeVisible()
  await properties().getByRole('button', { name: 'Browse for the owner', exact: true }).click()
  await expect(owner.getByLabel('Logins:', { exact: true })).toHaveValue('sa')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(owner).toHaveCount(0)
  await expect(properties().getByLabel('Owner', { exact: true })).toHaveValue('AppUser')
  await expect(properties().getByLabel('Owner', { exact: true })).toHaveAttribute('data-changed', 'true')
  // Enter in a field never applies, as Enter in SSMS's grid never presses OK.
  const executes = (await stubCalls('actions.execute')).length
  const recoveryTime = properties().getByLabel('Target Recovery Time (Seconds)', { exact: true })
  await recoveryTime.fill('120')
  await recoveryTime.press('Enter')
  await expect(recoveryTime).toHaveAttribute('data-changed', 'true')
  expect((await stubCalls('actions.execute')).length).toBe(executes)
  await recoveryTime.fill('60')
  await expect(recoveryTime).not.toHaveAttribute('data-changed', 'true')
  // Restrict Access closes other connections: No runs nothing; Yes writes WITH ROLLBACK IMMEDIATE, then the document
  // stays open, reads the database again and is clean, and Databases reloads.
  await properties().getByRole('radiogroup', { name: 'Restrict Access', exact: true }).getByRole('radio', { name: 'SINGLE_USER', exact: true }).click()
  await application.evaluate(() => { globalThis.variaStub.answers.push(1) })
  await verb('Apply').click()
  await expect.poll(() => application.evaluate(() => globalThis.variaStub.prompts.length)).toBe(1)
  await expect(verb('Apply')).toBeEnabled()
  expect((await stubCalls('actions.execute')).length).toBe(executes)
  expect((await application.evaluate(() => globalThis.variaStub.prompts))[0]).toEqual({ title: 'Open Connections', buttons: ['Yes', 'No'], defaultId: 1, cancelId: 1,
    message: 'To change the database properties, SQL Server must close all other connections to the database. Are you sure you want to change the properties and close all other connections?' })
  const listings = (await stubCalls('explorer.children')).filter(call => call.node.folder === 'databases').length
  const describes = (await stubCalls('actions.describe')).length
  await application.evaluate(() => { globalThis.variaStub.answers.push(0) })
  await verb('Apply').click()
  await expect(documentBanner(properties()).getByRole('status')).toHaveText('The changes were applied.')
  expect((await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'properties', closeConnections: true,
    changes: { owner: 'AppUser', options: { recoveryModel: 'SIMPLE', autoClose: 'true', restrictAccess: 'SINGLE_USER' } } })
  await expect.poll(async () => (await stubCalls('explorer.children')).filter(call => call.node.folder === 'databases').length).toBeGreaterThan(listings)
  expect((await stubCalls('actions.describe')).length).toBe(describes + 1)
  await expect(unsavedMark(propertiesTab())).toHaveCount(0)
  await expect(verb('Apply')).toBeDisabled()
  await expect(explorerTree(page)).toHaveAttribute('aria-busy', 'false')
  // Closing with a change asks to save it; Don't Save closes without applying.
  await sectionList().getByRole('button', { name: 'Options' }).click()
  await properties().getByRole('switch', { name: 'Auto Shrink', exact: true }).click()
  await expect(unsavedMark(propertiesTab())).toHaveCount(1)
  const applied = (await stubCalls('actions.execute')).length
  await application.evaluate(() => { globalThis.variaStub.answers.push(1) })
  await closeDocumentButton(page, 'Database Properties - AppData').click()
  await expect(properties()).toHaveCount(0)
  await expect(tabs()).toHaveCount(tabCount + 1)
  expect((await application.evaluate(() => globalThis.variaStub.prompts)).at(-1)).toMatchObject({ message: 'Save changes to Database Properties - AppData?' })
  expect((await stubCalls('actions.execute')).length).toBe(applied)
  // ⌘I opens it on macOS (no key on Windows and Linux, where Alt+Enter stays reserved).
  if (mac) {
    await select(...appData)
    await page.keyboard.press('Meta+i')
    await expect(properties()).toBeVisible()
    await page.keyboard.press('Meta+w')
    await expect(properties()).toHaveCount(0)
  }
  await windowSize(restoreSize)
  console.log('Object action checks: Database Properties opens as a document with facts as text, switches and segments, Tab into the section chosen, a whole description on focus and hover, a Script preview that carries only the changes to the clipboard, a file and a query window, its frame and draft kept across tabs, Select Database Owner over it, Enter that never applies, Open Connections before Apply, and the close prompt.')

  // 7. Create Catalog (S9a), from Integration Services Catalogs: SSMS's form (until CLR integration is checked nothing else
  // can change; the passwords must match), the password reaching only the request, then SSISDB in the folder; once it
  // exists the dialog says so; a failure lists its steps with the removal; Stop waits for the answer and says Stopped.
  const catalogs = ['server-a', 'Integration Services Catalogs']
  const createDialog = () => page.getByRole('dialog', { name: 'Create Catalog', exact: true })
  // Databases may still be reloading after Database Properties' OK, moving the rows below it: openExplorerMenu presses
  // until the folder's own menu opens.
  const openCreate = async () => {
    expect(await menuOf(...catalogs)).toEqual(['Create Catalog…', 'Refresh'])
    await chooseExplorerMenuItem(page, catalogs, 'Create Catalog…')
    await expect(createDialog()).toBeVisible()
  }
  await openCreate()
  const clr = createDialog().getByLabel('Enable CLR Integration', { exact: true })
  const password = createDialog().getByLabel('Password', { exact: true }), retype = createDialog().getByLabel('Retype Password', { exact: true })
  await expect(clr).not.toBeChecked()
  await expect(clr).toBeEnabled()
  await expect(password).toBeDisabled()
  const startup = createDialog().getByLabel('Enable automatic execution of Integration Services stored procedure at SQL Server startup', { exact: true })
  await expect(startup).toBeDisabled()
  await expect(createDialog().getByRole('button', { name: 'OK', exact: true })).toBeDisabled()
  await expect(createDialog().getByText(String.raw`C:\Program Files\Microsoft SQL Server\170\DTS\Binn\SSISDBBackup.bak`, { exact: true })).toBeVisible()
  await expect(createDialog().getByRole('list', { name: 'This changes the server', exact: true }).getByRole('listitem')).toHaveText(['Enable CLR integration', 'Restore the catalog database', 'Create the master key',
    'Register the Integration Services assembly and startup procedure', 'Create the maintenance job'])
  await clr.check()
  await expect(password).toBeEnabled()
  // The startup box as the user leaves it reaches the request.
  await expect(startup).not.toBeChecked()
  await startup.check()
  await page.screenshot({ path: resolve('artifacts', 'object-actions-create-catalog-dark.png') })
  const secret = "Pa'ss]--w0rd ünï"
  await password.fill(secret)
  await retype.fill(secret + 'x')
  await retype.press('Enter')
  await expect(createDialog().getByRole('alert')).toHaveText('Passwords you have typed do not match. Retype the password.')
  expect(await stubCalls('ssis.execute')).toEqual([])
  await retype.fill(secret)
  await createDialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(createDialog()).toHaveCount(0)
  expect(await stubCalls('ssis.execute')).toEqual([expect.objectContaining({ action: { verb: 'createCatalog', password: secret, enableClr: true, startupProcedure: true } })])
  await expect(explorerTree(page)).toBeFocused()
  await expandExplorerPath(page, ...catalogs)
  await expect(await explorerRow(page, ...catalogs, 'SSISDB')).toBeVisible()
  // The dialog's form leaves nothing behind in the page once it closes.
  expect(await page.evaluate(marker => document.documentElement.outerHTML.includes(marker), 'w0rd')).toBe(false)
  await openCreate()
  await expect(createDialog().getByRole('alert')).toHaveText('There already exists a catalog (SSISDB), and only one catalog is supported on a server.')
  await expect(createDialog().getByRole('button', { name: 'OK', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(createDialog()).toHaveCount(0)
  await application.evaluate(() => { globalThis.variaStub.catalog = false })
  await openCreate()
  await clr.check()
  await password.fill('Weak')
  await retype.fill('Weak')
  await createDialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(createDialog().getByRole('alert')).toContainText('Msg 15118: Password validation failed.')
  await expect(createDialog().getByRole('alert')).toContainText('Varia removed what Create Catalog had created')
  expect(await createDialog().getByRole('list', { name: 'This changes the server', exact: true }).getByRole('listitem').evaluateAll(items => items.map(item => item.getAttribute('data-status')))).toEqual(['done', 'done', 'failed', 'skipped', 'skipped', 'done'])
  await page.screenshot({ path: resolve('artifacts', 'object-actions-create-catalog-failed-dark.png') })
  await password.fill('Held')
  await retype.fill('Held')
  await createDialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(createDialog().getByRole('status')).toContainText('Creating the catalog')
  await createDialog().getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(createDialog().getByRole('status').filter({ hasText: 'Create Catalog was stopped' })).toBeVisible()
  expect((await application.evaluate(() => globalThis.variaStub.cancels)).length).toBeGreaterThan(0)
  await createDialog().getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(createDialog()).toHaveCount(0)
  console.log('Object action checks: Create Catalog asks for CLR first, checks the passwords, sends the password only in its request, lists SSISDB after, refuses a second catalog, shows a failure\'s steps and Stops.')

  // 5b. The server file picker, through its test hook until New Database, Attach and Restore open it from "…" (A17): the
  // default backup folder opens, the keyboard expands a folder and chooses a file, a typed share and folder are listed,
  // a slow folder is busy, and Escape returns focus to where it was.
  const picker = () => page.getByRole('dialog', { name: 'Locate Backup File - server-a', exact: true })
  const pickerTree = () => picker().getByRole('tree', { name: 'Select the file', exact: true })
  const item = name => pickerTree().getByRole('treeitem', { name, exact: true })
  const fileName = () => picker().getByLabel('File name', { exact: true })
  const answers = () => page.evaluate(() => window.__variaServerFiles.answers())
  await explorerTree(page).focus()
  expect(await page.evaluate(() => window.__variaServerFiles.pick('backup'))).toBe(true)
  await expect(pickerTree()).toBeFocused()
  await expect(item('Nightly')).toBeVisible()
  await expect(picker().getByText("Paths are on the server server-a; SQL Server's service account must be able to read them.", { exact: true })).toBeVisible()
  await expect(picker().getByRole('status')).toHaveText(/^5 items · listed in \d+ ms · type a path or a UNC name to go there$/)
  await expect(item(stubServerFiles.backupFolder)).toHaveAttribute('aria-selected', 'true')
  await expect(item(stubServerFiles.backupFolder)).toHaveAttribute('aria-description', 'default backup folder')
  await expect(item('C:\\')).toHaveAttribute('aria-description', '212 GB free')
  await expect(item('AppData.bak')).toHaveAttribute('aria-description', '15 MB, modified 2026-10-12 14:03')
  await expect(item('readme.txt')).toHaveCount(0)
  await expect(picker().getByLabel('Files of type', { exact: true })).toHaveText(/Backup Files\(\*\.bak;\*\.trn\)/)
  expect((await stubCalls('actions.describe')).filter(call => call.dialog === 'serverFiles').map(call => call.files)).toEqual([{ purpose: 'backup' }, { purpose: 'backup', path: stubServerFiles.backupFolder }])
  // A default folder shows its own name beside its tag; its full path stays its accessible name.
  await expect(item(stubServerFiles.backupFolder).getByText('Backup', { exact: true })).toBeVisible()
  // Tab from the last control and Shift+Tab from the first field come back to the tree, which the trap counts as a stop.
  await picker().getByRole('button', { name: 'Cancel', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(pickerTree()).toBeFocused()
  await picker().getByLabel('Selected path', { exact: true }).focus()
  await page.keyboard.press('Shift+Tab')
  await expect(pickerTree()).toBeFocused()
  // Folders come first, by name: Empty, Nightly, Slow, then the files.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(item('Nightly')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(item('Nightly')).toHaveAttribute('aria-expanded', 'true')
  await expect(picker()).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(item('Sales.bak')).toHaveAttribute('aria-selected', 'true')
  await expect(fileName()).toHaveValue('Sales.bak')
  await expect(picker().getByLabel('Selected path', { exact: true })).toHaveValue(stubServerFiles.backupFolder + 'Nightly\\')
  // Under forced colours the selected row is Highlight, as Object Explorer's is; the others are not.
  await page.emulateMedia({ forcedColors: 'active' })
  const highlight = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.cssText = 'background: Highlight; forced-color-adjust: none'
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
  const forcedBackgrounds = await Promise.all(['Sales.bak', 'Nightly'].map(name => item(name).evaluate(row => getComputedStyle(row).backgroundColor)))
  await page.emulateMedia({ forcedColors: null })
  expect(forcedBackgrounds[0]).toBe(highlight)
  expect(forcedBackgrounds[1]).not.toBe(highlight)
  await page.screenshot({ path: resolve('artifacts', 'object-actions-server-files-dark.png') })
  await page.keyboard.press('Enter')
  await expect(picker()).toHaveCount(0)
  await expect.poll(answers).toEqual([stubServerFiles.backupFolder + 'Nightly\\Sales.bak'])
  await expect(explorerTree(page)).toBeFocused()

  expect(await page.evaluate(() => window.__variaServerFiles.pick('backup'))).toBe(true)
  await expect(item('Nightly')).toBeVisible()
  await fileName().fill('//files/share/')
  await fileName().press('Enter')
  await expect(item('\\\\files\\share\\')).toHaveAttribute('aria-expanded', 'true')
  await expect(item('Shared.bak')).toBeVisible()
  await expect(fileName()).toHaveValue('')
  await fileName().fill('C:\\Missing\\x.bak')
  await fileName().press('Enter')
  await expect(picker().getByRole('alert')).toHaveText('The folder C:\\Missing\\ does not exist, or SQL Server\'s service account cannot see it.')
  await fileName().fill(stubServerFiles.backupFolder + 'Empty\\')
  await fileName().press('Enter')
  await expect(pickerTree().getByText('This folder is empty, or the server\'s account cannot list it.', { exact: true })).toBeVisible()
  await fileName().fill('C:\\Legacy\\')
  await fileName().press('Enter')
  await expect(pickerTree().getByText('SQL Server 2016 lists folders only to members of sysadmin. Type the path instead.', { exact: true })).toBeVisible()
  // Slow answers after 1.5 s: after 300 ms its row and the tree are busy, with a spinner, until it lists.
  await fileName().fill(stubServerFiles.backupFolder + 'Slow\\')
  await fileName().press('Enter')
  await expect(pickerTree()).toHaveAttribute('aria-busy', 'true')
  await expect(item('Slow')).toHaveAttribute('aria-busy', 'true')
  await expect(item('Old.bak')).toBeVisible()
  await expect(pickerTree()).not.toHaveAttribute('aria-busy', 'true')
  await picker().getByLabel('Files of type', { exact: true }).selectOption({ label: 'All Files(*.*)' })
  await expect(item('readme.txt')).toBeVisible()
  await expect(item('Old.bak')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker()).toHaveCount(0)
  await expect.poll(answers).toEqual([stubServerFiles.backupFolder + 'Nightly\\Sales.bak', null])
  await expect(explorerTree(page)).toBeFocused()

  // A typed name the listing does not show is asked about, and refused only when the server says it does not exist; under
  // C:\Legacy\ SQL Server 2016 cannot say, so the name is taken as typed.
  expect(await page.evaluate(() => window.__variaServerFiles.pick('backup'))).toBe(true)
  await expect(item('Nightly')).toBeVisible()
  await fileName().fill('nothing.bak')
  await fileName().press('Enter')
  await expect(picker().getByRole('alert')).toHaveText(stubServerFiles.backupFolder + 'nothing.bak does not exist, or SQL Server\'s service account cannot see it.')
  await fileName().fill('readme.txt')
  await fileName().press('Enter')
  await expect(picker()).toHaveCount(0)
  expect((await stubCalls('actions.describe')).filter(call => call.files?.exists).map(call => call.files.path)).toEqual([stubServerFiles.backupFolder + 'nothing.bak', stubServerFiles.backupFolder + 'readme.txt'])
  expect(await page.evaluate(() => window.__variaServerFiles.pick('backup', 'C:\\Legacy\\Old.bak'))).toBe(true)
  await expect(fileName()).toHaveValue('Old.bak')
  await fileName().press('Enter')
  await expect(picker()).toHaveCount(0)
  await expect.poll(answers).toEqual([stubServerFiles.backupFolder + 'Nightly\\Sales.bak', null, stubServerFiles.backupFolder + 'readme.txt', 'C:\\Legacy\\Old.bak'])

  // Locate Folder: "Select the folder", no Modified column, and a folder of files has no subfolders.
  const folderPicker = () => page.getByRole('dialog', { name: 'Locate Folder - server-a', exact: true })
  expect(await page.evaluate(() => window.__variaServerFiles.pick('folder'))).toBe(true)
  const folderTree = folderPicker().getByRole('tree', { name: 'Select the folder', exact: true })
  await expect(folderTree).toBeFocused()
  await expect(folderTree.getByText('This folder has no subfolders, or the server\'s account cannot list it.', { exact: true })).toBeVisible()
  await expect(folderPicker().getByText('Modified', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: resolve('artifacts', 'object-actions-server-files-folder.png') })
  await page.keyboard.press('Escape')
  await expect(folderPicker()).toHaveCount(0)
  await expect(explorerTree(page)).toBeFocused()
  console.log('Object action checks: the server file picker opens the default backup folder, keeps Tab in reach of its tree, expands a folder and chooses a file by keyboard, shows the selection under forced colours, goes to typed shares and folders, shows empty, 2016 and slow folders, lists All Files, asks the server about typed names it does not list, and Escape returns focus; Locate Folder names its tree for folders.')

  // 5b. New Database… (D1b): first on the Databases folder's menu and offered on a database's; a document whose logical and file
  // names follow the database's name, a files grid with Add and Remove, Change Autogrowth over it, Locate Folder for a path,
  // the Script drawer, OK that closes the tab and selects the new database, and Stop while CREATE DATABASE runs.
  const newDatabase = () => documentFrame(page, 'New Database')
  const newVerb = name => documentVerb(newDatabase(), 'New Database', name)
  const newFiles = () => newDatabase().getByRole('table', { name: 'Database files', exact: true })
  const databases = ['server-a', 'Databases']
  // Databases may still be reloading, moving the rows under the press: the helpers press until the folder's own menu opens.
  const databasesMenu = async () => (await explorerMenuItems(page, ...databases)).names
  const chooseNewDatabase = () => chooseExplorerMenuItem(page, databases, 'New Database…')
  expect((await databasesMenu())[0]).toBe('New Database…')
  await closeMenu()
  expect((await menuOf(...appData))[0]).toBe('New Database…')
  await chooseExplorerMenuItem(page, appData, 'New Database…')
  await expect(newDatabase()).toBeVisible()
  await expect(documentTab(page, 'New Database')).toHaveAttribute('aria-selected', 'true')
  await expect(documentCrumbs(newDatabase())).toHaveText(['server-a', 'Databases'])
  const databaseName = newDatabase().getByLabel('Database name', { exact: true })
  await expect(databaseName).toBeFocused()
  await expect(newVerb('OK')).toBeDisabled()
  await databaseName.fill('Sales')
  await expect(newFiles().getByLabel('Logical Name of Sales', { exact: true })).toHaveValue('Sales')
  await expect(newFiles().getByLabel('Logical Name of Sales_log', { exact: true })).toHaveValue('Sales_log')
  await expect(newFiles().getByLabel('File Name of Sales', { exact: true })).toHaveAttribute('placeholder', 'Sales.mdf')
  await expect(newFiles().getByLabel('Path of Sales', { exact: true })).toHaveValue(String.raw`C:\Program Files\Microsoft SQL Server\MSSQL17.MSSQLSERVER\MSSQL\DATA`)
  await expect(newVerb('OK')).toBeEnabled()
  // Add puts a ROWS file in PRIMARY, which needs a name before OK, with the caret in its name; Remove, named after the row it
  // takes, leaves the caret on the row before. The primary data file and the only log file cannot be removed.
  await newDatabase().getByRole('button', { name: 'Add', exact: true }).click()
  await expect(newFiles().getByRole('row')).toHaveCount(4)
  await expect(newDatabase().getByText('3 of 256 files · paths are on the server server-a', { exact: true })).toBeVisible()
  await expect(newVerb('OK')).toBeDisabled()
  await expect(newFiles().getByLabel('Logical Name of File 3', { exact: true })).toBeFocused()
  await newFiles().getByLabel('Logical Name of File 3', { exact: true }).fill('Sales2')
  await expect(newFiles().getByLabel('File Name of Sales2', { exact: true })).toHaveAttribute('placeholder', 'Sales2.ndf')
  // Forced colours drop the selection's fill, so the row Remove takes is outlined.
  await page.emulateMedia({ forcedColors: 'active' })
  const selectedOutline = await newFiles().getByRole('row').nth(3).evaluate(row => getComputedStyle(row).outlineStyle)
  await page.emulateMedia({ forcedColors: null })
  expect(selectedOutline, 'forced colours: the selected file row is outlined').toBe('solid')
  await newDatabase().getByRole('button', { name: 'Remove Sales2', exact: true }).click()
  await expect(newFiles().getByRole('row')).toHaveCount(3)
  await expect(newFiles().getByLabel('Logical Name of Sales_log', { exact: true })).toBeFocused()
  await expect(newDatabase().getByRole('button', { name: 'Remove', exact: true })).toBeDisabled()
  await newFiles().getByLabel('Logical Name of Sales', { exact: true }).focus()
  await expect(newDatabase().getByRole('button', { name: 'Remove', exact: true })).toBeDisabled()
  // Each filegroup list's buttons say which list they act on.
  await expect(newDatabase().getByRole('group', { name: 'Rows', exact: true }).getByRole('button', { name: 'Add Filegroup to Rows', exact: true })).toBeEnabled()
  await expect(newDatabase().getByRole('button', { name: 'Remove from Memory Optimized Data', exact: true })).toBeDisabled()
  // At 1024 x 768 a name and a path stay readable: the grid scrolls rather than squeezing them.
  const sizeBeforeNarrow = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  await resizeWindow(application, page, 1024, 768)
  const readable = await Promise.all(['Logical Name of Sales', 'Path of Sales', 'File Name of Sales'].map(label => newFiles().getByLabel(label, { exact: true })
    .evaluate(input => Math.round(input.getBoundingClientRect().width / parseFloat(getComputedStyle(input).fontSize)))))
  await resizeWindow(application, page, ...sizeBeforeNarrow)
  // In font sizes (about two characters each): 16, 24 and 20 characters at least.
  expect(readable[0], 'Logical Name at 1024 x 768').toBeGreaterThanOrEqual(8)
  expect(readable[1], 'Path at 1024 x 768').toBeGreaterThanOrEqual(12)
  expect(readable[2], 'File Name at 1024 x 768').toBeGreaterThanOrEqual(10)
  // Change Autogrowth over the document: percent growth, and the cell says so.
  await newFiles().getByRole('button', { name: 'Change Autogrowth of Sales', exact: true }).click()
  const autogrowth = page.getByRole('dialog', { name: 'Change Autogrowth for Sales', exact: true })
  await expect(autogrowth).toBeVisible()
  await autogrowth.getByLabel('In Percent', { exact: true }).check()
  await autogrowth.getByLabel('File growth in percent', { exact: true }).fill('10')
  await autogrowth.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(autogrowth).toHaveCount(0)
  await expect(newFiles().getByRole('row').nth(1)).toContainText('By 10 percent, Unlimited')
  // The path's "…" opens Locate Folder on the server; Escape leaves the path as it was.
  const locateFolder = () => page.getByRole('dialog', { name: 'Locate Folder - server-a', exact: true })
  await newFiles().getByRole('button', { name: 'Browse for the path of Sales', exact: true }).click()
  await expect(locateFolder()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(locateFolder()).toHaveCount(0)
  // The Script drawer previews what OK runs.
  await scriptToggle(newDatabase()).click()
  await expect(drawerText(newDatabase())).toContainText('CREATE DATABASE [Sales]')
  await expect.poll(async () => (await stubCalls('actions.script')).at(-1)).toMatchObject({ action: 'createDatabase', target: { kind: 'database', name: 'Sales' } })
  await page.screenshot({ path: resolve('artifacts', 'new-database-dark.png') })
  await newVerb('OK').click()
  await expect(newDatabase()).toHaveCount(0)
  const created = (await stubCalls('actions.execute')).at(-1)
  expect(created).toMatchObject({ action: 'createDatabase', target: { kind: 'database', name: 'Sales' }, design: { containment: 'NONE', options: {}, scoped: {} } })
  expect(created.design.files.map(file => [file.name, file.fileName, file.growth])).toEqual([
    ['Sales', 'Sales.mdf', { enabled: true, unit: 'percent', by: 10 }], ['Sales_log', 'Sales_log.ldf', { enabled: true, unit: 'percent', by: 10, maxMb: 2097152 }]
  ])
  await expectSelectedExplorerRow(page, 'server-a', 'Databases', 'Sales')
  // Stop while CREATE DATABASE runs: the tab stays and says what happened; Cancel then closes it.
  await chooseNewDatabase()
  await expect(databaseName).toBeFocused()
  await databaseName.fill('Held')
  // Enter outside the grids is OK, as in SSMS's dialog.
  await databaseName.press('Enter')
  await expect(newVerb('Stop')).toBeVisible()
  await expect(newDatabase().getByRole('status').filter({ hasText: 'Creating the database…' })).toBeVisible()
  await newVerb('Stop').click()
  await expect(newDatabase().getByRole('status').filter({ hasText: 'SQL Server cancelled that statement' })).toBeVisible()
  await expect(newVerb('OK')).toBeEnabled()
  await newVerb('Cancel').click()
  await expect(newDatabase()).toHaveCount(0)
  // A second New Database is numbered; Ctrl+S is its OK, and Escape cancels the first.
  await chooseNewDatabase()
  await expect(databaseName).toBeFocused()
  await chooseNewDatabase()
  const secondDatabase = documentFrame(page, 'New Database (2)')
  await expect(documentTab(page, 'New Database (2)')).toHaveAttribute('aria-selected', 'true')
  const secondName = secondDatabase.getByLabel('Database name', { exact: true })
  await expect(secondName).toBeFocused()
  await secondName.fill('Sales3')
  await page.keyboard.press('Control+S')
  await expect(secondDatabase).toHaveCount(0)
  expect((await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'createDatabase', target: { kind: 'database', name: 'Sales3' } })
  await documentTab(page, 'New Database').click()
  await expect(newDatabase()).toBeVisible()
  await databaseName.focus()
  await page.keyboard.press('Escape')
  await expect(newDatabase()).toHaveCount(0)
  console.log('Object action checks: New Database… comes first on Databases, names files after the database, adds and removes files with the caret kept and buttons named, keeps names and paths readable at 1024 x 768, changes autogrowth, browses the server for a path, scripts, creates and selects the database, stops a create, numbers a second tab, and takes Enter, Ctrl+S and Escape.')

  // 5c. Attach Databases (D1d) on the Databases folder: Add… reads an .mdf chosen in Locate Database Files, a data file that
  // is not found blocks OK until its path is corrected, Script sends the rows, a log file can be removed (the log is then
  // rebuilt), a database that fails rolls the first back, and OK attaches it and selects it in the folder.
  const attachDialog = () => page.getByRole('dialog', { name: 'Attach Databases', exact: true })
  const attachOk = () => attachDialog().getByRole('button', { name: 'OK', exact: true })
  const databasesGrid = () => attachDialog().getByRole('table', { name: 'Databases to attach:', exact: true })
  const databaseRow = index => databasesGrid().getByRole('row').nth(index + 1)
  const detailsGrid = name => attachDialog().getByRole('table', { name: `"${name}" database details:`, exact: true })
  const dataPicker = () => page.getByRole('dialog', { name: 'Locate Database Files - server-a', exact: true })
  const salesMdf = stubServerFiles.dataFolder + 'Sales.mdf'
  const addButton = () => attachDialog().getByRole('button', { name: 'Add…', exact: true })
  /** Add… through Locate Database Files: typing the file name and Enter, double-clicking it, or Escape (nothing added). */
  async function addDatabase(file, how = 'enter') {
    await addButton().click()
    await expect(dataPicker().getByLabel('Selected path', { exact: true })).toHaveValue(stubServerFiles.dataFolder)
    await expect(dataPicker().getByRole('treeitem', { name: file, exact: true })).toBeVisible()
    if (how === 'double') await dataPicker().getByRole('treeitem', { name: file, exact: true }).dblclick()
    else if (how === 'escape') await dataPicker().getByLabel('File name', { exact: true }).press('Escape')
    else {
      await dataPicker().getByLabel('File name', { exact: true }).fill(file)
      await dataPicker().getByLabel('File name', { exact: true }).press('Enter')
    }
    await expect(dataPicker()).toHaveCount(0)
    // Focus comes back to Add…, which stays enabled while the file is read, so it never falls out of the modal.
    await expect(addButton()).toBeFocused()
  }
  const openAttach = async () => {
    expect(await databasesMenu()).toEqual(['New Database…', 'Attach…', 'Restore Database…', 'Restore Files and Filegroups…', 'Filter Settings…', 'Refresh'])
    await chooseExplorerMenuItem(page, databases, 'Attach…')
    await expect(objectDialogProgress(attachDialog())).toHaveText('Ready')
  }
  await openAttach()
  await expect(attachDialog().getByText('Add a primary data file (.mdf) to attach its database.', { exact: true })).toBeVisible()
  expect((await stubCalls('actions.describe')).filter(call => call.dialog === 'attachDatabase').map(call => [call.target, call.attach])).toEqual([[{ kind: 'server' }, undefined]])
  // Escape in the picker returns to Add…, and Escape there closes the dialog.
  await addDatabase('Sales.mdf', 'escape')
  await page.keyboard.press('Escape')
  await expect(attachDialog()).toHaveCount(0)
  await openAttach()
  await addDatabase('Sales.mdf', 'double')
  // Only .mdf files are listed; the database's name comes from the file, and Attach As starts as it.
  await expect(databaseRow(0).getByRole('cell')).toHaveText([salesMdf, 'Sales', '', /<default>/, '', ''])
  await expect(attachDialog().getByLabel('Attach As for ' + salesMdf, { exact: true })).toHaveValue('Sales')
  await expect(attachDialog().getByLabel('Owner for ' + salesMdf, { exact: true })).toHaveValue('')
  await expect(detailsGrid('Sales').getByRole('row')).toHaveCount(4)
  await expect(detailsGrid('Sales').getByRole('row').nth(2).getByRole('cell')).toHaveText(['D:\\Old\\Sales_2.ndf', 'Data', /…/, 'Not found'])
  await expect(attachOk()).toBeDisabled()
  await expect(attachDialog().getByText('A data file of Sales is not found. Correct its Current File Path, or remove the database.', { exact: true })).toBeVisible()
  // Paths keep their file names in view: Sales.mdf and Sales_log.ldf share a long folder, which gives way instead.
  await expect.poll(() => attachFileNameShown(databaseRow(0).getByRole('cell').first())).toBe(true)
  await expect.poll(() => attachFileNameShown(detailsGrid('Sales').getByRole('row').nth(1).getByRole('cell').first())).toBe(true)
  await expect.poll(() => attachFileNameShown(detailsGrid('Sales').getByRole('row').nth(3).getByRole('cell').first())).toBe(true)
  await expect.poll(() => inputShowsEnd(attachDialog().getByLabel('Current File Path for ' + stubServerFiles.dataFolder + 'Sales_log.ldf', { exact: true }))).toBe(true)
  // Owner lines up with Attach As: both take the row height.
  const cellHeights = await Promise.all(['Attach As for ', 'Owner for '].map(async label => (await attachDialog().getByLabel(label + salesMdf, { exact: true }).boundingBox())?.height))
  expect(cellHeights[0]).toBeGreaterThan(0)
  expect(cellHeights[1]).toBe(cellHeights[0])
  await page.screenshot({ path: resolve('artifacts', 'object-actions-attach-dark.png') })
  // A corrected Current File Path waits for its check (OK stays disabled and says why); Enter asks the server whether the file is there.
  const secondFile = attachDialog().getByLabel('Current File Path for D:\\Old\\Sales_2.ndf', { exact: true })
  await secondFile.fill(stubServerFiles.dataFolder + 'Sales_2.ndf')
  await expect(attachOk()).toBeDisabled()
  await expect(attachDialog().getByText('Press Enter in a Current File Path of Sales, or leave it, to check the file.', { exact: true })).toBeVisible()
  await secondFile.press('Enter')
  await expect(detailsGrid('Sales').getByRole('row').nth(2).getByRole('cell').nth(3)).toHaveText('')
  await expect(attachOk()).toBeEnabled()
  await expect(secondFile).toBeFocused()
  expect((await stubCalls('actions.describe')).filter(call => call.files?.exists).at(-1)?.files).toEqual({ purpose: 'database', path: stubServerFiles.dataFolder + 'Sales_2.ndf', exists: true })
  await attachDialog().getByLabel('Owner for ' + salesMdf, { exact: true }).selectOption('app_owner')
  await attachDialog().getByRole('button', { name: 'Script', exact: true }).click()
  const salesFiles = ['Sales.mdf', 'Sales_2.ndf', 'Sales_log.ldf'].map(name => stubServerFiles.dataFolder + name)
  await expect.poll(async () => (await stubCalls('actions.script')).filter(call => call.action === 'attach').map(call => call.databases))
    .toEqual([[{ name: 'Sales', owner: 'app_owner', files: salesFiles, rebuildLog: false }]])
  await expect(attachDialog()).toBeVisible()
  // A second database whose log is not found: removing the log rebuilds it, and OK fails at Hr, so Sales is rolled back.
  await addDatabase('Hr.mdf')
  await expect(databasesGrid().getByRole('row')).toHaveCount(3)
  await expect(detailsGrid('Hr').getByRole('row')).toHaveCount(3)
  // Under forced colours the selected row (Hr, which Remove acts on) is Highlight, and a file that is not found keeps a mark.
  await page.emulateMedia({ forcedColors: 'active' })
  const cellBackground = row => row.getByRole('cell').first().evaluate(cell => getComputedStyle(cell).backgroundColor)
  await expect.poll(async () => await cellBackground(databaseRow(1)) !== await cellBackground(databaseRow(0))).toBe(true)
  expect(await attachDialog().getByLabel('Current File Path for D:\\Old\\Hr_log.ldf', { exact: true }).evaluate(input => getComputedStyle(input).outlineStyle)).toBe('dashed')
  await page.screenshot({ path: resolve('artifacts', 'object-actions-attach-forced.png') })
  await page.emulateMedia({ forcedColors: 'none' })
  await attachDialog().getByLabel('Current File Path for D:\\Old\\Hr_log.ldf', { exact: true }).focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(attachDialog().getByRole('button', { name: 'Remove the selected log file', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(detailsGrid('Hr').getByRole('row')).toHaveCount(2)
  // The removed row's place is taken, and so is focus: it never drops out of the modal.
  await expect(attachDialog().getByLabel('Current File Path for ' + stubServerFiles.dataFolder + 'Hr.mdf', { exact: true })).toBeFocused()
  await expect(attachDialog().getByText(/^No log file is listed, so SQL Server will rebuild the log \(FOR ATTACH_REBUILD_LOG\)\./)).toBeVisible()
  await attachOk().click()
  await expect(objectDialogProgress(attachDialog())).toHaveText('Error')
  await expect(databaseRow(0).getByRole('cell').nth(4)).toHaveText('Rolled Back')
  await expect(databaseRow(1).getByRole('cell').nth(4)).toHaveText('Error')
  await expect(databaseRow(1).getByRole('cell').nth(5)).toHaveText(/^Msg 5120: Unable to open the physical file/)
  // The whole Rolled Back explanation is shown (it wraps), not only a tooltip.
  await expect(databaseRow(0).getByRole('cell').nth(5)).toHaveText('The attach succeeded but was rolled back because another database failed to attach.')
  expect(await databaseRow(0).getByRole('cell').nth(5).evaluate(cell => cell.scrollWidth <= cell.clientWidth && cell.scrollHeight <= cell.clientHeight)).toBe(true)
  expect((await stubCalls('actions.execute')).filter(call => call.action === 'attach').at(-1)?.databases).toEqual([
    { name: 'Sales', owner: 'app_owner', files: salesFiles, rebuildLog: false }, { name: 'Hr', files: [stubServerFiles.dataFolder + 'Hr.mdf'], rebuildLog: true }])
  await page.screenshot({ path: resolve('artifacts', 'object-actions-attach-failed-dark.png') })
  await attachDialog().getByLabel('Attach As for ' + stubServerFiles.dataFolder + 'Hr.mdf', { exact: true }).focus()
  await attachDialog().getByRole('button', { name: 'Remove the selected database', exact: true }).click()
  await expect(databasesGrid().getByRole('row')).toHaveCount(2)
  await expect(attachDialog().getByLabel('Attach As for ' + salesMdf, { exact: true })).toBeFocused()
  // New Database (5b) made a Sales already, so this one is attached as SalesCopy.
  await attachDialog().getByLabel('Attach As for ' + salesMdf, { exact: true }).fill('SalesCopy')
  await attachOk().click()
  await expect(attachDialog()).toHaveCount(0)
  expect((await stubCalls('actions.execute')).filter(call => call.action === 'attach').at(-1)?.databases).toEqual([{ name: 'SalesCopy', owner: 'app_owner', files: salesFiles, rebuildLog: false }])
  await expectSelectedExplorerRow(page, 'server-a', 'Databases', 'SalesCopy')
  console.log('Object action checks: Attach Databases reads an .mdf chosen in Locate Database Files (Enter, double-click or Escape, focus back on Add…), keeps file names in view, blocks OK while a data file is not found or a typed one unchecked, checks a corrected path on Enter, marks the selection under forced colours, keeps focus in the dialog after Remove, scripts its rows, rebuilds a removed log, shows a rolled-back attach per row, and selects the attached database.')
  // 5d. Restore Database (D1e, run by D1f): AppData's history plans
  // the full, differential and log backups; the grid's checkboxes wait for Manual Selection; master is a source but never a
  // destination; the Backup Timeline draws its marks whole and moves its slider by keys; Script previews the plan; Prompt
  // before restoring each backup is greyed (critic A22).
  const restoreFrame = name => documentFrame(page, 'Restore Database - ' + name)
  const restoreSection = (title, name = 'AppData') => frameSection(restoreFrame(name), title)
  expect(await page.evaluate(() => window.__variaRestore.open('AppData'))).toEqual(expect.any(String))
  await expect(documentTab(page, 'Restore Database - AppData')).toBeVisible()
  const restoreTo = restoreSection('General').getByRole('textbox', { name: 'Restore to:', exact: true })
  await expect(restoreTo).toHaveText('The last backup taken (2026-10-29 13:00:00)')
  await expect(restoreSection('General').getByRole('checkbox', { checked: true })).toHaveCount(3)
  const restoreSource = restoreSection('General').getByRole('combobox', { name: 'Database:', exact: true }).first()
  await expect(restoreSource).toHaveValue('AppData')
  await expect(restoreSource.getByRole('option', { name: 'master', exact: true })).toBeEnabled()
  // Restore to reads as one line in a field's size, not the page's 16 px.
  await expect(restoreTo).toHaveCSS('font-size', '12px')
  expect((await restoreTo.boundingBox()).height).toBeLessThanOrEqual(32)
  // The grid's checkboxes take clicks only while Manual Selection is checked; its scroller is a named tab stop.
  const manual = restoreSection('General').getByRole('checkbox', { name: 'Manual Selection', exact: true })
  const setBoxes = restoreSection('General').getByRole('region', { name: 'Backup sets to restore:', exact: true }).getByRole('checkbox')
  await expect(setBoxes).toHaveCount(3)
  for (const box of await setBoxes.all()) await expect(box).toBeDisabled()
  await manual.check()
  for (const box of await setBoxes.all()) await expect(box).toBeEnabled()
  await manual.uncheck()
  await expect(setBoxes.first()).toBeDisabled()
  const setsRegion = restoreSection('General').getByRole('region', { name: 'Backup sets to restore:', exact: true })
  await setsRegion.focus()
  await expect(setsRegion).toBeFocused()
  await expect(restoreSection('Files').getByRole('table', { name: 'Restore the database files as', exact: true })).toBeVisible()
  await expect(restoreSection('General').getByRole('button', { name: 'Verify Backup Media', exact: true })).toBeDisabled()
  await expect(restoreSection('Options').getByRole('checkbox', { name: 'Prompt before restoring each backup', exact: true })).toBeDisabled()
  await expect(restoreSection('Options').getByRole('checkbox', { name: 'Take tail-log backup before restore', exact: true })).toBeChecked()
  await restoreSection('General').getByRole('button', { name: 'Timeline…', exact: true }).click()
  const timeline = page.getByRole('dialog', { name: 'Backup Timeline', exact: true })
  // The dialog takes its own width (min(560px, 100vw - 48px)), not the sub-dialog's 420 px.
  const timelineWidth = await timeline.evaluate(element => ({ width: element.getBoundingClientRect().width, expected: Math.min(560, innerWidth - 48) }))
  expect(Math.abs(timelineWidth.width - timelineWidth.expected)).toBeLessThanOrEqual(1)
  // In the Day window the marks keep their pixel size: the full backup a 14 px triangle, the log a 3 px tick, and the
  // differential's triangle smaller than the full's.
  const markBox = async selector => (await timeline.locator(selector).first().boundingBox())
  const [fullMark, differentialMark, logMark] = [await markBox(part.restoreTimelineFull), await markBox(part.restoreTimelineDifferential), await markBox(part.restoreTimelineLog)]
  expect(fullMark.width).toBeGreaterThanOrEqual(13)
  expect(differentialMark.width).toBeLessThan(fullMark.width)
  expect(logMark.width).toBeGreaterThanOrEqual(2.5)
  // Marks at the window's ends show whole: inside the track.
  const trackBox = await timeline.getByRole('slider', { name: 'Point in time', exact: true }).boundingBox()
  for (const mark of [fullMark, differentialMark, logMark]) expect(mark.x + mark.width).toBeLessThanOrEqual(trackBox.x + trackBox.width + 0.5)
  await expect(timeline.locator(part.restoreTimelineSwatch)).toHaveCount(4)
  // Under forced colours the marks, the band and the legend's samples take system colours that differ from Canvas.
  await page.emulateMedia({ forcedColors: 'active' })
  const forcedFills = await timeline.evaluate((element, selectors) => {
    const fill = selector => getComputedStyle(element.querySelector(selector)).fill
    const probe = element.appendChild(document.createElement('div'))
    probe.style.backgroundColor = 'Canvas'
    const canvas = getComputedStyle(probe).backgroundColor
    probe.remove()
    return { background: canvas, marks: selectors.map(fill), swatch: getComputedStyle(element.querySelector(selectors.at(-1) + ' polygon')).fill }
  }, [part.restoreTimelineFull, part.restoreTimelineLog, part.restoreTimelineCovered, part.restoreTimelineSwatch])
  for (const fill of [...forcedFills.marks.slice(0, 3), forcedFills.swatch]) expect(fill, JSON.stringify(forcedFills)).not.toBe(forcedFills.background)
  await page.emulateMedia({ forcedColors: 'none' })
  await timeline.getByLabel('Timeline Interval:', { exact: true }).selectOption({ label: 'Hour' })
  const slider = timeline.getByRole('slider', { name: 'Point in time', exact: true })
  await slider.focus()
  await slider.press('Home')
  await expect(slider).toHaveAttribute('aria-valuetext', '2026-10-29 12:00:00')
  // The slider's focus ring is the app's 2 px.
  await expect(slider).toHaveCSS('outline-width', '2px')
  await expect(timeline.getByRole('radio', { name: 'Specific date and time', exact: true })).toBeChecked()
  await slider.press('ArrowRight')
  await expect(slider).toHaveAttribute('aria-valuetext', '2026-10-29 12:01:00')
  await page.screenshot({ path: resolve('artifacts', 'object-actions-restore-timeline.png') })
  await timeline.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(timeline).toHaveCount(0)
  await expect(restoreTo).toHaveText('2026-10-29 12:01:00')
  await scriptToggle(restoreFrame('AppData')).click()
  await expect(drawerText(restoreFrame('AppData'))).toHaveValue(restoreScript.replaceAll('\r\n', '\n'))
  expect((await stubCalls('actions.script')).at(-1)).toMatchObject({ action: 'restore', target: { kind: 'database', name: 'AppData' }, identity: { id: 5 },
    restore: { stopAt: '2026-10-29T12:01:00', recovery: 'recovery', tailLog: { noRecovery: true }, sets: [{ type: 'full', file: 1 }, { type: 'differential', file: 2 }, { type: 'log', file: 1 }] } })
  // Restoring over master is refused with the reason, and nothing more is scripted for it.
  const scripted = (await stubCalls('actions.script')).length
  await restoreSection('General').getByRole('combobox', { name: 'Database:', exact: true }).last().fill('master')
  await expect(restoreSection('General', 'master').getByText('Restore system databases with T-SQL; it needs single-user mode or a stopped Agent.').first()).toBeVisible()
  await expect(scriptDrawer(restoreFrame('master')).getByText('Restore system databases with T-SQL; it needs single-user mode or a stopped Agent.', { exact: true })).toBeVisible()
  await page.screenshot({ path: resolve('artifacts', 'object-actions-restore-dark.png') })
  expect((await stubCalls('actions.script')).length).toBe(scripted)
  // Select backup devices lists its files in a list eight rows tall, not a one-row spin box.
  await restoreSection('General', 'master').getByRole('radio', { name: 'Device', exact: true }).click()
  await restoreSection('General', 'master').getByRole('button', { name: 'Select backup devices', exact: true }).click()
  const devicesDialog = page.getByRole('dialog', { name: 'Select backup devices', exact: true })
  expect((await devicesDialog.getByRole('listbox', { name: 'Backup media:', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(150)
  await devicesDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(devicesDialog).toHaveCount(0)
  // The tab names the destination, as the frame's title does.
  await expect(documentTab(page, 'Restore Database - master')).toBeVisible()
  await closeDocumentButton(page, 'Restore Database - master').click()
  await expect(documentTab(page, 'Restore Database - master')).toHaveCount(0)
  console.log('Object action checks: Restore Database (test hook) plans the history\'s backups, takes grid clicks only under Manual Selection, refuses master only as the destination, greys Prompt with its reason, draws the Backup Timeline\'s marks whole (and under forced colours) and moves its point by keys, scripts the plan, and lists backup media eight rows tall.')

  // 5c. Restore Database runs (D1f). The Databases folder's Restore Database… opens it on the history's first database, and a
  // database's Tasks › Restore › Database… on that database. Close existing connections makes Restore ask first, Cancel in
  // focus, drawn as the default and last, Escape answering it and focus going back to Restore, which is disabled while the bar
  // asks (owner decision 4); the Run panel lists the backend's steps with the full backup's RESTORE at 40 % (about 13 % of
  // three sets) while the sections say their choices in a line; Stop over a database that existed asks first (Keep restoring
  // in focus and last, focus back on Stop), and the outcome, a status rather than an error, names the state SQL Server left
  // (critic A12). Without the confirm's fact it runs at once, and ends restored.
  await chooseExplorerMenuItem(page, databases, 'Restore Database…')
  await expect(documentTab(page, 'Restore Database - AppData')).toBeVisible()
  await expect(restoreSection('General').getByRole('checkbox', { checked: true })).toHaveCount(3)
  await closeDocumentButton(page, 'Restore Database - AppData').click()
  await expect(documentTab(page, 'Restore Database - AppData')).toHaveCount(0)
  await chooseExplorerMenuItem(page, appData, ['Tasks', 'Restore', 'Database…'])
  await expect(documentTab(page, 'Restore Database - AppData')).toBeVisible()
  await expect(restoreSection('General').getByRole('checkbox', { checked: true })).toHaveCount(3)
  const runFrame = restoreFrame('AppData')
  const restoreVerb = name => documentVerb(runFrame, 'Restore Database - AppData', name)
  const restoreRuns = async () => (await stubCalls('actions.execute')).filter(call => call.action === 'restore')
  const stubCancels = () => application.evaluate(() => globalThis.variaStub.cancels.length)
  await restoreSection('Options').getByRole('checkbox', { name: 'Close existing connections to destination database', exact: true }).check()
  await restoreVerb('Restore').click()
  const runConfirm = runFrame.getByRole('alertdialog', { name: 'Restore Database', exact: true })
  await expect(runConfirm).toContainText('Closing existing connections ends 1 session in AppData, and rolls back any open transaction.')
  await expect(runConfirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  // Danger first, the safe default last and drawn as the default whether or not focus shows (its ring is a box shadow).
  expect(await runConfirm.getByRole('button').allTextContents()).toEqual(['Restore', 'Cancel'])
  expect(await runConfirm.getByRole('button', { name: 'Cancel', exact: true }).evaluate(button => getComputedStyle(button).boxShadow)).not.toBe('none')
  await expect(restoreVerb('Restore')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(runConfirm).toHaveCount(0)
  await expect(restoreVerb('Restore')).toBeFocused()
  expect(await restoreRuns()).toHaveLength(0)
  await restoreVerb('Restore').click()
  await runConfirm.getByRole('button', { name: 'Restore', exact: true }).click()
  const runPanel = runFrame.getByRole('region', { name: 'Restoring AppData', exact: true })
  await expect(runPanel.getByRole('progressbar', { name: 'Restoring AppData', exact: true })).toHaveAttribute('aria-valuenow', '13')
  const runStatuses = panel => panel.getByRole('listitem').evaluateAll(items => items.map(item => item.dataset.status))
  await expect.poll(() => runStatuses(runPanel)).toEqual(['done', 'done', 'running', 'pending', 'pending', 'pending'])
  await expect(runPanel.getByRole('listitem').nth(2)).toContainText('Restore the full backup (AppData.bak, position 1)')
  await expect(documentState(runFrame)).toContainText('Restoring · about 13 %')
  await expect(restoreSection('General').getByRole('checkbox')).toHaveCount(0)
  expect((await restoreRuns()).at(-1)).toMatchObject({ target: { kind: 'database', name: 'AppData' }, identity: { id: 5 },
    restore: { closeConnections: true, replace: false, recovery: 'recovery', tailLog: { noRecovery: true }, sets: [{ type: 'full', file: 1 }, { type: 'differential', file: 2 }, { type: 'log', file: 1 }] } })
  await page.screenshot({ path: resolve('artifacts', 'object-actions-restore-run.png') })
  const cancelsBefore = await stubCancels()
  await restoreVerb('Stop').click()
  const stopConfirm = runFrame.getByRole('alertdialog', { name: 'Stop the restore', exact: true })
  await expect(stopConfirm).toContainText('Stop the restore? Stopping leaves AppData restoring and unusable until a restore finishes.')
  await expect(stopConfirm.getByRole('button', { name: 'Keep restoring', exact: true })).toBeFocused()
  expect(await stopConfirm.getByRole('button').allTextContents()).toEqual(['Stop', 'Keep restoring'])
  await page.keyboard.press('Escape')
  await expect(stopConfirm).toHaveCount(0)
  await expect(runPanel).toBeVisible()
  await expect(restoreVerb('Stop')).toBeFocused()
  expect(await stubCancels()).toBe(cancelsBefore)
  await restoreVerb('Stop').click()
  await stopConfirm.getByRole('button', { name: 'Stop', exact: true }).click()
  const stoppedPanel = runFrame.getByRole('region', { name: 'Stopped restoring AppData', exact: true })
  await expect(stoppedPanel.getByRole('heading', { name: 'Stopped restoring AppData', exact: true })).toBeFocused()
  await expect(stoppedPanel.getByRole('status')).toContainText('AppData is restoring, in single-user mode, and cannot be used until a restore finishes.')
  await expect(stoppedPanel.getByRole('alert')).toHaveCount(0)
  await expect.poll(() => runStatuses(stoppedPanel)).toEqual(['done', 'done', 'cancelled', 'skipped', 'skipped', 'skipped'])
  await expect(stoppedPanel.getByRole('listitem').nth(2)).toContainText('40 %')
  await expect(stoppedPanel.getByRole('button', { name: 'Restore again', exact: true })).toBeEnabled()
  await expect(documentState(runFrame)).toContainText('Stopped')
  expect(await stubCancels()).toBe(cancelsBefore + 1)
  await page.screenshot({ path: resolve('artifacts', 'object-actions-restore-stop.png') })
  await restoreSection('Options').getByRole('checkbox', { name: 'Close existing connections to destination database', exact: true }).uncheck()
  await restoreVerb('Restore').click()
  const restoredPanel = runFrame.getByRole('region', { name: 'Restored AppData', exact: true })
  await expect(restoredPanel).toContainText('AppData is online.')
  await expect.poll(() => runStatuses(restoredPanel)).toEqual(['done', 'done', 'done', 'done'])
  await expect(runConfirm).toHaveCount(0)
  await expect(documentState(runFrame)).toContainText('Restored')
  expect(await restoreRuns()).toHaveLength(2)
  await closeDocumentButton(page, 'Restore Database - AppData').click()
  await expect(documentTab(page, 'Restore Database - AppData')).toHaveCount(0)
  console.log('Object action checks: Restore Database opens from the Databases folder and from Tasks › Restore › Database…, asks before closing connections (Restore disabled meanwhile, Cancel last, the default and in focus, Escape answering and focus back on Restore), shows the steps and the RESTORE\'s percent while the sections summarise, asks before Stop over a database that existed (Keep restoring last and in focus, focus back on Stop), names what Stop left as a status with focus on the panel title, and runs at once to Restored without the confirm\'s fact.')

  // 5d. Restore Files and Filegroups (D1g): the Databases folder's item and a database's Tasks › Restore › Files and Filegroups…
  // open it on AppData. The grid lists the full backup's data files, the PRIMARY one greyed online with its reason shown and
  // read as its description, and Restore as filegroup shows each row's filegroup first; once a file is checked, so is the log
  // after it, which cannot be unchecked. Varia's log backup is on for an online FULL database and STANDBY greyed (SQL Server
  // refuses it online), its reason shown and read; the options' labels take the fields' body size. Script shows actions.script's
  // text for the restoreFiles request, and Restore runs at once to Restored with its four steps, focus on the Run panel's title.
  const filesTitle = 'Restore Files and Filegroups - AppData'
  await chooseExplorerMenuItem(page, databases, 'Restore Files and Filegroups…')
  await expect(documentTab(page, filesTitle)).toBeVisible()
  await closeDocumentButton(page, filesTitle).click()
  await expect(documentTab(page, filesTitle)).toHaveCount(0)
  await chooseExplorerMenuItem(page, appData, ['Tasks', 'Restore', 'Files and Filegroups…'])
  await expect(documentTab(page, filesTitle)).toBeVisible()
  const filesFrame = documentFrame(page, filesTitle)
  const filesSection = title => frameSection(filesFrame, title)
  await expect(filesSection('Files')).toHaveCount(0)
  await expect(filesSection('General').getByRole('combobox', { name: 'To database:', exact: true })).toHaveValue('AppData')
  const backupSetsGrid = filesSection('General').getByRole('region', { name: 'Select the backup sets to restore:', exact: true })
  await expect(backupSetsGrid.getByRole('row')).toHaveCount(4)
  const logBox = backupSetsGrid.getByRole('checkbox', { name: 'Restore AppData-Log (2026-10-29 13:00:00)', exact: true })
  await expect(logBox).toBeDisabled()
  await expect(logBox).not.toBeChecked()
  const primaryBox = backupSetsGrid.getByRole('checkbox', { name: 'Restore AppData from AppData-Full (2026-10-29 08:00:00)', exact: true })
  await expect(primaryBox).toBeDisabled()
  await expect(primaryBox).toHaveAccessibleDescription(/^A file of the PRIMARY filegroup restores only offline/)
  await expect(filesSection('General').getByText(/^A file of the PRIMARY filegroup restores only offline/)).toBeVisible()
  await expect(documentVerb(filesFrame, filesTitle, 'Restore')).toBeDisabled()
  // Restore as filegroup: each row shows the filegroup its checkbox names, in its own first column.
  const asFilegroup = filesSection('Options').getByRole('checkbox', { name: 'Restore as filegroup', exact: true })
  await asFilegroup.check()
  await expect(backupSetsGrid.getByRole('columnheader', { name: 'Filegroup', exact: true })).toBeVisible()
  await expect(backupSetsGrid.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Restore Archive from AppData-Full (2026-10-29 08:00:00)', exact: true }) }).getByRole('cell').nth(1)).toHaveText('Archive')
  await asFilegroup.uncheck()
  await expect(backupSetsGrid.getByRole('columnheader', { name: 'Filegroup', exact: true })).toHaveCount(0)
  await backupSetsGrid.getByRole('checkbox', { name: 'Restore AppData_2 from AppData-Full (2026-10-29 08:00:00)', exact: true }).check()
  await expect(logBox).toBeChecked()
  await expect(filesSection('Options').getByRole('checkbox', { name: 'Back up the log and restore it to bring the files online (WITH COPY_ONLY)', exact: true })).toBeChecked()
  const standbyRadio = filesSection('Options').getByRole('radio', { name: /\(RESTORE WITH STANDBY\)$/ })
  await expect(standbyRadio).toBeDisabled()
  await expect(standbyRadio).toHaveAccessibleDescription(/^RESTORE WITH STANDBY conflicts with an online restore/)
  await expect(filesSection('Options').getByRole('checkbox', { name: 'Prompt before restoring each backup', exact: true })).toHaveAccessibleDescription('Not yet available')
  await expect(filesSection('Options').getByRole('radio', { name: /\(RESTORE WITH RECOVERY\)$/ })).toBeChecked()
  // The options' labels and the grid's title take the fields' body size (the metric token), not the page's 16 px.
  const bodySize = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--varia-size-md').trim())
  expect(await standbyRadio.evaluate(radio => getComputedStyle(radio.closest('label')).fontSize)).toBe(bodySize)
  expect(await backupSetsGrid.evaluate(grid => getComputedStyle(document.getElementById(grid.getAttribute('aria-labelledby'))).fontSize)).toBe(bodySize)
  await expect(filesSection('Options').getByRole('table', { name: 'Restore the database files as', exact: true }).getByRole('textbox', { name: 'Restore AppData_2 as', exact: true })).toBeVisible()
  await scriptToggle(filesFrame).click()
  await expect(drawerText(filesFrame)).toHaveValue(restoreFilesScript.replaceAll('\r\n', '\n'))
  expect((await stubCalls('actions.script')).at(-1)).toMatchObject({ action: 'restoreFiles', target: { kind: 'database', name: 'AppData' }, identity: { id: 5 },
    restoreFiles: { files: ['AppData_2'], filegroups: [], recovery: 'recovery', sets: [{ type: 'full', file: 1 }, { type: 'log', file: 1 }], logBackup: { file: expect.stringMatching(/AppData_LogBackup_.*\.bak$/) } } })
  await page.screenshot({ path: resolve('artifacts', 'object-actions-restore-files.png') })
  await scriptToggle(filesFrame).click()
  await documentVerb(filesFrame, filesTitle, 'Restore').click()
  const filesDone = filesFrame.getByRole('region', { name: 'Restored AppData', exact: true })
  await expect(filesDone).toContainText('AppData is online.')
  await expect(filesDone.getByRole('listitem')).toHaveText([/^Done: Restore the files/, /^Done: Restore log backup/, /^Done: Back up the log/, /^Done: Restore the log backup/])
  // Restore ran at once (no confirm bar) and took the verb that had focus away: the Run panel's title has it.
  await expect(filesDone.getByRole('heading', { name: 'Restored AppData', exact: true })).toBeFocused()
  expect((await stubCalls('actions.execute')).filter(call => call.action === 'restoreFiles')).toHaveLength(1)
  await closeDocumentButton(page, filesTitle).click()
  await expect(documentTab(page, filesTitle)).toHaveCount(0)
  console.log('Object action checks: Restore Files and Filegroups opens from the Databases folder and from Tasks › Restore › Files and Filegroups…, lists the full backup\'s files in Select the backup sets to restore (PRIMARY\'s greyed online with its reason, each filegroup named under Restore as filegroup) with the log after it checked once a file is, offers the log backup with STANDBY greyed online and its reason read, draws the options at the body size, scripts the restoreFiles request, and runs to Restored with its four steps and focus on the Run panel.')

  // 8. New Login (D2a): Security › New › Login… opens "Login - New" with SSMS's pages and defaults; the password fields are masked
  // and keep what was typed across pages; Script (clipboard and a query window, so AutoRecover too) never carries the password,
  // which goes only with OK; PASSWORD_POLICY keeps the dialog and its password; Stop answers Stopped with the steps; OK adds the
  // login, and Logins shows and selects it. New Login… on the Logins folder opens the same dialog. User Mapping (D2b) maps
  // AppData with the login's name, a schema chosen in Select Schema and a role, by pointer and by keys, never the offline Archive
  // or the read-only Ledger.
  const loginDialog = () => page.getByRole('dialog', { name: 'Login - New', exact: true })
  const typed = 'Typed-Z9q-' + Date.now().toString(36)
  // Logins listed first: OK reloads that folder and selects the new login (a folder Object Explorer has not listed stays so).
  await expandExplorerPath(page, 'server-a', 'Security', 'Logins')
  expect(await menuOf('server-a', 'Security')).toContain('New')
  await chooseExplorerMenuItem(page, ['server-a', 'Security'], ['New', 'Login…'])
  await expect(loginDialog()).toBeVisible()
  await expect(objectDialogProgress(loginDialog())).toHaveText('Ready')
  expect(await loginDialog().getByRole('navigation', { name: 'Select a page', exact: true }).getByRole('button').allTextContents()).toEqual(['General', 'Server Roles', 'User Mapping', 'Status'])
  // A Windows server: Windows authentication, so the password fields are greyed until SQL Server authentication is chosen.
  await expect(loginDialog().getByRole('radio', { name: 'Windows authentication', exact: true })).toBeChecked()
  await expect(passwordField(loginDialog(), 'Password')).toBeDisabled()
  // Their labels grey with them, as the option checkboxes' do.
  const labelColor = locator => locator.evaluate(input => getComputedStyle(input.labels[0]).color)
  expect(await labelColor(passwordField(loginDialog(), 'Password')), 'a disabled password row\'s label is dimmed').not.toBe(await labelColor(loginDialog().getByRole('textbox', { name: 'Login name', exact: true })))
  await loginDialog().getByRole('radio', { name: 'SQL Server authentication', exact: true }).check()
  await expect(loginDialog().getByLabel('Password', { exact: true }), 'only the Password field is named Password').toHaveCount(1)
  await loginDialog().getByRole('textbox', { name: 'Login name', exact: true }).fill('app_reader')
  await passwordField(loginDialog(), 'Password').fill(typed)
  await passwordField(loginDialog(), 'Confirm password').fill(typed)
  await expect(loginDialog().getByText('Passwords match.', { exact: true })).toBeVisible()
  // The narrow frame (1024 × 768 at 150 %): General, taller than the dialog, scrolls inside it above OK, and the password
  // fields line up with Login name.
  await resizeWindow(application, page, 1024, 768)
  await zoom(1.5)
  await expect(objectDialogTabs(loginDialog())).toHaveCount(4)
  const loginPage = objectDialogPage(loginDialog())
  const loginOk = loginDialog().getByRole('button', { name: 'OK', exact: true })
  const narrowLogin = async () => {
    const boxes = await Promise.all([loginPage, loginOk, loginDialog().getByRole('textbox', { name: 'Login name', exact: true }), passwordField(loginDialog(), 'Password')].map(locator => locator.boundingBox()))
    if (boxes.some(box => !box)) return 'not laid out'
    const [shown, ok, name, secret] = boxes
    return { above: shown.y + shown.height <= ok.y + 1, scrolls: await loginPage.evaluate(element => element.scrollHeight > element.clientHeight), aligned: Math.abs(name.x - secret.x) <= 1 }
  }
  await expect.poll(narrowLogin, 'the narrow frame: General ends above OK and scrolls, and Password lines up with Login name').toEqual({ above: true, scrolls: true, aligned: true })
  const language = loginDialog().getByRole('combobox', { name: 'Default language', exact: true })
  await language.scrollIntoViewIfNeeded()
  await expect(language).toBeInViewport()
  const [languageBox, loginOkBox] = await Promise.all([language.boundingBox(), loginOk.boundingBox()])
  expect(languageBox.y + languageBox.height, 'Default language scrolls into view above OK').toBeLessThanOrEqual(loginOkBox.y)
  await page.screenshot({ path: resolve('artifacts', 'object-actions-new-login-narrow-dark.png') })
  await zoom(zoomBefore)
  await resizeWindow(application, page, ...sizeBefore)
  await expect(objectDialogTabs(loginDialog())).toHaveCount(0)
  for (const name of ['Enforce password policy', 'Enforce password expiration', 'User must change password at next login']) await expect(loginDialog().getByRole('checkbox', { name, exact: true })).toBeChecked()
  await loginDialog().getByRole('checkbox', { name: 'Enforce password policy', exact: true }).uncheck()
  await expect(loginDialog().getByRole('checkbox', { name: 'Enforce password expiration', exact: true })).toBeDisabled()
  await expect(loginDialog().getByRole('checkbox', { name: 'User must change password at next login', exact: true })).toBeDisabled()
  await page.screenshot({ path: resolve('artifacts', 'object-actions-new-login-dark.png') })
  await loginDialog().getByRole('button', { name: 'Status', exact: true }).click()
  await expect(loginDialog().getByRole('radiogroup', { name: 'Permission to connect to database engine', exact: true }).getByRole('radio', { name: 'Grant', exact: true })).toBeChecked()
  await expect(loginDialog().getByRole('radiogroup', { name: 'Login', exact: true }).getByRole('radio', { name: 'Enabled', exact: true })).toBeChecked()
  await loginDialog().getByRole('button', { name: 'Server Roles', exact: true }).click()
  const serverRoles = loginDialog().getByRole('group', { name: 'Server roles', exact: true })
  await expect(serverRoles.getByRole('checkbox', { name: 'public', exact: true })).toBeChecked()
  await expect(serverRoles.getByRole('checkbox', { name: 'public', exact: true })).toBeDisabled()
  await serverRoles.getByRole('checkbox', { name: 'dbcreator', exact: true }).check()
  // User Mapping: Map fills User with the login's name; the selected database's roles are read once, public checked and greyed.
  await loginDialog().getByRole('button', { name: 'User Mapping', exact: true }).click()
  const mappingGrid = loginDialog().getByRole('grid', { name: 'Users mapped to this login:', exact: true })
  const mappingRow = database => mappingGrid.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Map ${database}`, exact: true }) })
  const mappingCells = async database => (await mappingRow(database).getByRole('gridcell').allTextContents()).map(text => text.replace('…', ''))
  await expect(mappingGrid.getByRole('columnheader')).toHaveText(['Map', 'Database', 'User', 'Default Schema'])
  await expect(mappingGrid.getByRole('checkbox', { name: 'Map Archive', exact: true }), 'an offline database cannot be mapped').toBeDisabled()
  await expect(mappingRow('Archive')).toContainText('OFFLINE')
  await expect(mappingGrid.getByRole('checkbox', { name: 'Map Ledger', exact: true }), 'a read-only database cannot be mapped').toBeDisabled()
  await expect(mappingRow('Ledger')).toContainText('READ-ONLY')
  // Thirteen databases, so the rows scroll: the header's columns still sit over the cells (both keep the scroll bar's gutter).
  const columnLefts = locator => locator.evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().left))
  const [heads, cells] = [await columnLefts(mappingGrid.getByRole('columnheader')), await columnLefts(mappingRow('AppData').getByRole('gridcell'))]
  expect(heads.map((left, index) => Math.abs(left - cells[index]) <= 1), `header lefts ${heads} over cell lefts ${cells}`).toEqual([true, true, true, true])
  // A long database name ends in an ellipsis inside its cell and shows whole in its tooltip.
  const clipped = locator => locator.evaluate(text => { const style = getComputedStyle(text); return [style.overflowX, style.textOverflow, text.getBoundingClientRect().right <= text.parentElement.getBoundingClientRect().right + 0.5] })
  expect(await clipped(mappingRow(longDatabase).getByTitle(longDatabase, { exact: true }))).toEqual(['hidden', 'ellipsis', true])
  await mappingGrid.getByRole('checkbox', { name: 'Map AppData', exact: true }).check()
  expect(await mappingCells('AppData')).toEqual(['', 'AppData', 'app_reader', ''])
  const databaseRoles = loginDialog().getByRole('group', { name: 'Database role membership for: AppData', exact: true })
  await expect(databaseRoles.getByRole('checkbox', { name: 'public', exact: true })).toBeChecked()
  await expect(databaseRoles.getByRole('checkbox', { name: 'public', exact: true })).toBeDisabled()
  await expect(loginDialog().getByRole('checkbox', { name: 'Guest account enabled for: AppData', exact: true })).not.toBeChecked()
  // The database's name runs on inline from the label's words (not as a flex item of its own), so no gap widens the space before it.
  expect(await loginDialog().getByRole('checkbox', { name: 'Guest account enabled for: AppData', exact: true }).evaluate(input => getComputedStyle(input.closest('label').querySelector('bdi')).display)).toBe('inline')
  await databaseRoles.getByRole('checkbox', { name: 'db_datareader', exact: true }).check()
  // So does a long role name, within its column.
  expect(await clipped(databaseRoles.getByTitle(longRole, { exact: true }))).toEqual(['hidden', 'ellipsis', true])
  // Select Schema (the cell's … button) lists the database's schemas; OK puts the one chosen in Default Schema.
  await mappingGrid.getByRole('button', { name: 'Select Schema for AppData', exact: true }).click()
  const selectSchema = page.getByRole('dialog', { name: 'Select Schema', exact: true })
  await expect(selectSchema.getByRole('listbox', { name: 'Schemas in AppData:', exact: true }).getByRole('option')).toHaveText(['dbo', 'sales'])
  await selectSchema.getByRole('listbox', { name: 'Schemas in AppData:', exact: true }).selectOption('sales')
  await selectSchema.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(selectSchema).toHaveCount(0)
  expect(await mappingCells('AppData')).toEqual(['', 'AppData', 'app_reader', 'sales'])
  // Select Schema hands focus back to the grid, not to the … button the pointer pressed, so the keys move a cell that shows.
  await expect(mappingGrid).toBeFocused()
  await page.screenshot({ path: resolve('artifacts', 'object-actions-new-login-user-mapping-dark.png') })
  // Tab leaves the grid for the next control (the first role it may check), never for the grid's unnamed scrolling box.
  await page.keyboard.press('Tab')
  await expect(databaseRoles.getByRole('checkbox', { name: 'db_datareader', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(mappingGrid).toBeFocused()
  // In forced colours the selected row is Highlight, and everything in it HighlightText: the active cell's outline, the … button,
  // and a greyed database's name.
  await page.emulateMedia({ forcedColors: 'active' })
  expect(await mappingGrid.getByRole('gridcell', { selected: true }).evaluate(cell => { const style = getComputedStyle(cell); return [style.outlineStyle, style.outlineColor === style.color] })).toEqual(['solid', true])
  expect(await mappingGrid.getByRole('button', { name: 'Select Schema for AppData', exact: true }).evaluate(button => {
    const style = getComputedStyle(button), cell = getComputedStyle(button.parentElement)
    return [style.color === cell.color, style.borderTopColor === cell.color, style.backgroundColor === cell.backgroundColor]
  })).toEqual([true, true, true])
  // By keys: Down moves to Archive, Ledger and master, Space maps and unmaps master (whose guest may connect), Home and Right reach User,
  // F2 edits it, and Escape ends the edit, never the dialog.
  await page.keyboard.press('ArrowDown')
  expect(await mappingRow('Archive').getByTitle('Archive', { exact: true }).evaluate(text => getComputedStyle(text).color === getComputedStyle(text.parentElement).color)).toBe(true)
  await page.emulateMedia({ forcedColors: null })
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(loginDialog().getByRole('checkbox', { name: 'Guest account enabled for: master', exact: true })).toBeChecked()
  await page.keyboard.press(' ')
  await expect(mappingGrid.getByRole('checkbox', { name: 'Map master', exact: true })).toBeChecked()
  // Home is the Map column (Select Schema left the cursor in Default Schema); two Rights reach User.
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('F2')
  await expect(loginDialog().getByRole('textbox', { name: 'User in master', exact: true })).toBeFocused()
  await expect(loginDialog().getByRole('textbox', { name: 'User in master', exact: true })).toHaveValue('app_reader')
  await page.keyboard.press('Escape')
  await expect(loginDialog().getByRole('textbox', { name: 'User in master', exact: true })).toHaveCount(0)
  await expect(loginDialog()).toBeVisible()
  await page.keyboard.press(' ')
  await expect(mappingGrid.getByRole('checkbox', { name: 'Map master', exact: true })).not.toBeChecked()
  await loginDialog().getByRole('button', { name: 'General', exact: true }).click()
  expect(await passwordField(loginDialog(), 'Password').evaluate(input => [input.type, input.value.length])).toEqual(['password', typed.length])
  await loginDialog().getByRole('button', { name: 'Script options', exact: true }).click()
  await page.getByRole('option', { name: 'Script Action to Clipboard', exact: true }).click()
  await expect.poll(clipboard).toContain('PASSWORD=<password>')
  expect(await clipboard()).not.toContain(typed)
  const queries = await tabs().count()
  await loginDialog().getByRole('button', { name: 'Script', exact: true }).click()
  await expect(tabs()).toHaveCount(queries + 1)
  await expect(loginDialog()).toBeVisible()
  const loginScripts = (await stubCalls('actions.script')).filter(call => call.action === 'createLogin')
  expect(loginScripts).toHaveLength(2)
  expect(loginScripts.every(call => !Object.hasOwn(call, 'secrets')) && !JSON.stringify(loginScripts).includes(typed)).toBe(true)
  expect(loginScripts[0]).toMatchObject({ login: { auth: 'sql', name: 'app_reader', checkPolicy: false, checkExpiration: false, mustChange: false }, serverRoles: ['dbcreator'],
    mappings: [{ database: 'AppData', user: 'app_reader', defaultSchema: 'sales', rolesAdd: ['db_datareader'] }] })
  expect((await stubCalls('actions.describe')).filter(call => call.dialog === 'loginDatabaseRoles').map(call => call.target.name), 'each database\'s roles are read once').toEqual(['AppData', 'master'])
  expect(await stubCalls('actions.execute').then(calls => calls.filter(call => call.action === 'createLogin'))).toEqual([])
  // The server's password policy refuses "Weak": the dialog stays open, says why, and keeps the password typed.
  for (const label of ['Password', 'Confirm password']) await passwordField(loginDialog(), label).fill('Weak')
  await loginDialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(loginDialog().getByRole('alert')).toContainText('Password validation failed.')
  expect(await passwordField(loginDialog(), 'Password').inputValue()).toBe('Weak')
  expect((await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'createLogin', secrets: { password: 'Weak' } })
  // "Held" waits as on a lock: Stop takes Cancel's place, and its answer says Stopped and lists the steps.
  for (const label of ['Password', 'Confirm password']) await passwordField(loginDialog(), label).fill('Held')
  await loginDialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(objectDialogProgress(loginDialog())).toHaveText('Executing')
  await expect(loginDialog().getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
  await loginDialog().getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(objectDialogProgress(loginDialog())).toHaveText('Stopped')
  await expect(loginDialog().getByRole('status').filter({ hasText: 'The action was stopped at "Create the login"' })).toBeVisible()
  await expect(loginDialog().getByRole('list', { name: 'Steps', exact: true }).getByRole('listitem')).toHaveCount(5)
  // A password the policy takes: the dialog closes, and Logins lists the login and selects it.
  for (const label of ['Password', 'Confirm password']) await passwordField(loginDialog(), label).fill(typed)
  await loginDialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(loginDialog()).toHaveCount(0)
  expect((await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'createLogin', target: { kind: 'server' }, secrets: { password: typed }, serverRoles: ['dbcreator'], status: { connect: 'grant', enabled: true },
    mappings: [{ database: 'AppData', user: 'app_reader', defaultSchema: 'sales', rolesAdd: ['db_datareader'] }] })
  await expect(explorerTree(page).getByRole('treeitem', { name: 'app_reader', selected: true })).toBeVisible()
  expect(await menuOf('server-a', 'Security', 'Logins')).toContain('New Login…')
  await chooseExplorerMenuItem(page, ['server-a', 'Security', 'Logins'], 'New Login…')
  await expect(loginDialog()).toBeVisible()
  await expect(loginDialog().getByRole('textbox', { name: 'Login name', exact: true })).toHaveValue('')
  // Enter in Confirm password is OK; when the policy refuses the password, focus returns to Password (running disabled the
  // field it was in), so Escape still cancels.
  await loginDialog().getByRole('radio', { name: 'SQL Server authentication', exact: true }).check()
  await loginDialog().getByRole('textbox', { name: 'Login name', exact: true }).fill('app_writer')
  for (const label of ['Password', 'Confirm password']) await passwordField(loginDialog(), label).fill('Weak')
  await passwordField(loginDialog(), 'Confirm password').press('Enter')
  await expect(loginDialog().getByRole('alert')).toContainText('Password validation failed.')
  await expect(passwordField(loginDialog(), 'Password')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(loginDialog()).toHaveCount(0)
  // AutoRecover keeps the scripted window once it has unsaved changes (a script alone is not unsaved), and no copy holds the password.
  await tabs().nth(queries).click()
  await editorTextbox(page).focus()
  await page.keyboard.insertText('-- kept\n')
  await expect(unsavedMark(tabs().nth(queries))).toHaveCount(1)
  await page.evaluate(() => window.__variaRecovery.flush())
  const recovered = async folder => (await readdir(folder, { withFileTypes: true }).catch(() => [])).reduce(async (texts, entry) => [...await texts,
    ...entry.isDirectory() ? await recovered(resolve(folder, entry.name)) : [await readFile(resolve(folder, entry.name), 'utf8')]], Promise.resolve([]))
  const copies = await recovered(resolve(profile, 'AutoRecover'))
  expect(copies.some(text => text.includes('PASSWORD=<password>'))).toBe(true)
  expect(copies.some(text => text.includes(typed) || text.includes('Weak') || text.includes('Held'))).toBe(false)
  console.log('Object action checks: New Login opens from Security › New and Logins with SSMS\'s pages and defaults, greys the password rows\' labels under Windows authentication, scrolls General in the narrow frame with its fields aligned, keeps its masked password across pages, maps a database (Select Schema, a role, keys) but never an offline one, scripts PASSWORD=<password> to the clipboard and a query window without sending the password, keeps the dialog on PASSWORD_POLICY with focus back on Password, Stops, and selects the new login.')

  // 9. Tasks › Take Offline and Bring Online (D3a). The submenu greys by the listing's state; Take Database Offline lists the
  // sessions in the database (one in a transaction, which Drop All Active Connections rolls back) and keeps OK disabled, saying
  // why, until the box is checked or Check Again finds none; Script Action shows SET OFFLINE; Success leaves Close, focused, and
  // Databases lists it "(Offline)". A SET OFFLINE that waits on a session says so and Stops; Bring Online runs as it opens.
  const offlineDialog = () => page.getByRole('dialog', { name: 'Take Database Offline - AppData', exact: true })
  const onlineDialog = () => page.getByRole('dialog', { name: 'Bring Database Online - AppData', exact: true })
  const stateCells = dialog => dialog.getByRole('grid', { name: 'Databases', exact: true }).locator('tbody td')
  const dropBox = () => offlineDialog().getByLabel('Drop All Active Connections', { exact: true })
  const okButton = dialog => dialog.getByRole('button', { name: 'OK', exact: true })
  /** The row's Status chip shows its whole label: its width is the column's CSS share, never the font's. */
  const statusChipFits = async dialog => {
    const label = stateCells(dialog).nth(2).locator(part.statusPillLabel)
    await expect(label).toHaveCount(1)
    return label.evaluate(element => element.scrollWidth <= element.clientWidth)
  }
  /** Tasks › an item on AppData; Databases may be reloading, so the helpers press until the row's own menu opens. */
  const task = async (name, states) => {
    expect((await explorerSubmenuItems(page, appData, ['Tasks'])).disabled, 'greyed Tasks items').toEqual(states)
    await chooseExplorerMenuItem(page, appData, ['Tasks', name])
  }
  await task('Take Offline', ['Bring Online'])
  await expect(offlineDialog()).toBeVisible()
  await expect(objectDialogProgress(offlineDialog())).toHaveText('Ready')
  await expect(stateCells(offlineDialog())).toHaveText(['AppData', '', 'Not ready', '2 active connections (1 with an open transaction)'])
  await expect(offlineDialog().getByRole('grid', { name: 'Sessions', exact: true }).locator('tbody tr')).toHaveText(stubSessions.map(session => [session.sessionId, session.login, session.program, session.host, session.openTransactions].join('')))
  await expect(offlineDialog().getByRole('note').first()).toHaveText('Drop All Active Connections rolls back the open transaction of 1 session.')
  await expect(okButton(offlineDialog())).toBeDisabled()
  await expect(okButton(offlineDialog())).toHaveAccessibleDescription('2 sessions are connected: check Drop All Active Connections, or Check Again once they leave.')
  // The chip fits its column, with the border forced colours add too; a session's names are in full on hover.
  expect(await statusChipFits(offlineDialog()), 'the Not ready chip fits').toBe(true)
  await page.emulateMedia({ forcedColors: 'active' })
  expect(await statusChipFits(offlineDialog()), 'the Not ready chip fits under forced colours').toBe(true)
  await page.emulateMedia({ forcedColors: 'none' })
  await expect(offlineDialog().getByRole('grid', { name: 'Sessions', exact: true }).getByRole('gridcell', { name: stubSessions[0].program, exact: true })).toHaveAttribute('title', stubSessions[0].program)
  await page.screenshot({ path: resolve('artifacts', 'object-actions-take-offline-dark.png') })
  // Script Action shows the statement OK would run, with ROLLBACK IMMEDIATE only once the box is checked.
  await dropBox().check()
  await expect(okButton(offlineDialog())).toBeEnabled()
  await expect(stateCells(offlineDialog()).nth(2)).toHaveText('Ready')
  await offlineDialog().getByRole('button', { name: 'Script options', exact: true }).click()
  await offlineDialog().getByRole('option', { name: 'Script Action to Clipboard', exact: true }).click()
  await expect.poll(clipboard).toBe(offlineScript(true))
  expect((await stubCalls('actions.script')).at(-1)).toMatchObject({ action: 'takeOffline', target: { kind: 'database', name: 'AppData' }, dropConnections: true })
  // Check Again: the sessions left meanwhile, so OK runs without dropping anyone; one that joined since holds SET OFFLINE,
  // which the row says once it has waited a moment, and Stop leaves the database online.
  await dropBox().uncheck()
  await application.evaluate(() => { globalThis.variaStub.sessions = []; globalThis.variaStub.holding = true })
  await offlineDialog().getByRole('button', { name: 'Check Again', exact: true }).click()
  await expect(stateCells(offlineDialog())).toHaveText(['AppData', '', 'Ready', 'No active connections.'])
  await expect(dropBox()).toBeDisabled()
  // Enter on OK: OK disables itself as the run starts, so focus moves to Stop, the only way out of a wait.
  await okButton(offlineDialog()).focus()
  await page.keyboard.press('Enter')
  await expect(offlineDialog().getByRole('button', { name: 'Stop', exact: true })).toBeFocused()
  await expect(stateCells(offlineDialog()).nth(3)).toHaveText('Waiting for other connections to leave the database. Stop to give up.')
  expect(await stateCells(offlineDialog()).nth(3).evaluate(cell => cell.firstElementChild?.getAttribute('aria-live')), 'the waiting message is announced').toBe('polite')
  await expect(stateCells(offlineDialog()).nth(2)).toHaveText('In progress')
  expect(await statusChipFits(offlineDialog()), 'the In progress chip fits').toBe(true)
  await page.emulateMedia({ forcedColors: 'active' })
  expect(await statusChipFits(offlineDialog()), 'the In progress chip fits under forced colours').toBe(true)
  await page.emulateMedia({ forcedColors: 'none' })
  await offlineDialog().getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(objectDialogProgress(offlineDialog())).toHaveText('Stopped')
  // The count read before OK no longer holds: a session held the database.
  await expect(stateCells(offlineDialog())).toHaveText(['AppData', '', 'Stopped', 'Stopped. Check Again to see who is connected now.'])
  expect((await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'takeOffline', dropConnections: false, identity: { id: 7, created: '2026-01-02T03:04:05.000' } })
  // OK again once nothing holds it: Success, the steps, and Close as the one button, focused.
  await application.evaluate(() => { globalThis.variaStub.holding = false })
  await okButton(offlineDialog()).click()
  await expect(objectDialogProgress(offlineDialog())).toHaveText('Success')
  await expect(stateCells(offlineDialog())).toHaveText(['AppData', '', 'Success', 'The database is offline.'])
  await expect(okButton(offlineDialog())).toHaveCount(0)
  await expect(offlineDialog().getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  // Only Close is left to act: Script and its options are greyed.
  await expect(offlineDialog().getByRole('button', { name: 'Script', exact: true })).toBeDisabled()
  await expect(offlineDialog().getByRole('button', { name: 'Script options', exact: true })).toBeDisabled()
  await page.screenshot({ path: resolve('artifacts', 'object-actions-take-offline-success-dark.png') })
  await page.keyboard.press('Enter')
  await expect(offlineDialog()).toHaveCount(0)
  await expect(explorerTree(page).getByRole('treeitem', { name: /^AppData\b.*Offline/ })).toHaveCount(1)
  // Offline: Take Offline greys and Bring Online runs as soon as its dialog has read the database.
  await task('Bring Online', ['Take Offline'])
  await expect(objectDialogProgress(onlineDialog())).toHaveText('Success')
  await expect(stateCells(onlineDialog())).toHaveText(['AppData', 'Success', 'The database is online.'])
  expect((await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'bringOnline', target: { kind: 'database', name: 'AppData' } })
  await onlineDialog().getByRole('button', { name: 'Close', exact: true }).click()
  await expect(onlineDialog()).toHaveCount(0)
  await expect(explorerTree(page).getByRole('treeitem', { name: /^AppData\b.*Offline/ })).toHaveCount(0)
  console.log('Object action checks: Tasks › Take Offline lists the sessions and open transactions, holds OK until Drop All Active Connections or Check Again, scripts SET OFFLINE, Stops a wait and stays open on Success; Bring Online runs as it opens.')

  // Tasks › Detach… (D3b). Detach Database lists AppData with Drop Connections and Update Statistics (both unchecked, as SSMS
  // opens it) and the files that stay on the server; OK waits for Drop Connections while sessions are connected. Script Action
  // shows SINGLE_USER and sp_detach_db's @skipchecks; Success stays open on its steps, AppData leaves Databases, and a toast says
  // its files stay on the server, with Copy paths.
  const detachDialog = () => page.getByRole('dialog', { name: 'Detach Database - AppData', exact: true })
  const detachRow = () => detachDialog().getByRole('grid', { name: 'Databases to detach', exact: true }).locator('tbody td')
  const detachDrop = () => detachDialog().getByLabel('Drop Connections', { exact: true })
  const detachStatistics = () => detachDialog().getByLabel('Update Statistics', { exact: true })
  const filePaths = detachFiles.map(file => file.path)
  await application.evaluate((_electron, sessions) => { globalThis.variaStub.sessions = sessions }, stubSessions)
  await task('Detach…', ['Bring Online'])
  await expect(objectDialogProgress(detachDialog())).toHaveText('Ready')
  await expect(detachRow()).toHaveText(['AppData', '', '', 'Not ready', '2 active connections (1 with an open transaction)'])
  await expect(detachDrop()).not.toBeChecked()
  await expect(detachStatistics()).not.toBeChecked()
  await expect(detachDialog().getByRole('note').first()).toHaveText('Drop Connections rolls back the open transaction of 1 session.')
  // A read-only table, not a grid: it has no cells to move between.
  await expect(detachDialog().getByRole('table', { name: 'Files that stay on the server', exact: true }).locator('tbody tr'))
    .toHaveText(detachFiles.map(file => file.name + { rows: 'ROWS Data', log: 'LOG' }[file.type] + file.path))
  await expect(okButton(detachDialog())).toBeDisabled()
  await expect(okButton(detachDialog())).toHaveAccessibleDescription('2 sessions are connected: check Drop Connections, or Check Again once they leave.')
  await page.screenshot({ path: resolve('artifacts', 'object-actions-detach-dark.png') })
  await detachDrop().check()
  await detachStatistics().check()
  await expect(okButton(detachDialog())).toBeEnabled()
  await expect(detachRow().nth(3)).toHaveText('Ready')
  // Enter on the closed Sessions list opens it, as a disclosure does, and never runs the detach.
  const detachSessions = () => detachDialog().getByText(/^Sessions in AppData \(2\)$/)
  const executesBefore = (await stubCalls('actions.execute')).length
  await expect(detachDialog().getByRole('grid', { name: 'Sessions', exact: true })).toBeHidden()
  await detachSessions().focus()
  await page.keyboard.press('Enter')
  await expect(detachDialog().getByRole('grid', { name: 'Sessions', exact: true })).toBeVisible()
  await expect(objectDialogProgress(detachDialog())).toHaveText('Ready')
  expect((await stubCalls('actions.execute')).length).toBe(executesBefore)
  await detachDialog().getByRole('button', { name: 'Script options', exact: true }).click()
  await detachDialog().getByRole('option', { name: 'Script Action to Clipboard', exact: true }).click()
  await expect.poll(clipboard).toBe(detachScript(true, true))
  expect((await stubCalls('actions.script')).at(-1)).toMatchObject({ action: 'detach', target: { kind: 'database', name: 'AppData' }, dropConnections: true, updateStatistics: true })
  // The dialog's Copy paths copies one path per line.
  await detachDialog().getByRole('button', { name: 'Copy paths', exact: true }).click()
  await expect.poll(clipboard).toBe(filePaths.join('\n'))
  await detachStatistics().uncheck()
  await okButton(detachDialog()).click()
  await expect(objectDialogProgress(detachDialog())).toHaveText('Success')
  await expect(detachRow()).toHaveText(['AppData', '', '', 'Success', 'The database was detached.'])
  expect((await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'detach', dropConnections: true, updateStatistics: false, identity: { id: 7, created: '2026-01-02T03:04:05.000' } })
  expect((await stubCalls('actions.execute')).at(-1)).not.toHaveProperty('detachOffline')
  await expect(okButton(detachDialog())).toHaveCount(0)
  await expect(detachDialog().getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  // The database is gone: no word on its sessions or what closing them rolls back, and the boxes change nothing now.
  await expect(detachSessions()).toHaveCount(0)
  await expect(detachDialog().getByRole('note')).toHaveCount(0)
  await expect(detachDrop()).toBeDisabled()
  await expect(detachStatistics()).toBeDisabled()
  const detachedToast = toasts(page).filter({ hasText: 'AppData was detached.' })
  await expect(toastMessage(detachedToast)).toContainText('AppData was detached. Its 2 files stay on the server.')
  await page.screenshot({ path: resolve('artifacts', 'object-actions-detach-success-dark.png') })
  await page.keyboard.press('Enter')
  await expect(detachDialog()).toHaveCount(0)
  await expect(explorerTree(page).getByRole('treeitem', { name: /^AppData\b/ })).toHaveCount(0)
  await application.evaluate(({ clipboard }) => clipboard.writeText(''))
  await detachedToast.getByRole('button', { name: 'Copy paths', exact: true }).click()
  await expect.poll(clipboard).toBe(filePaths.join('\n'))
  // Attached again (as another tool would): Refresh on Databases lists it once more for the checks below.
  await application.evaluate(() => { globalThis.variaStub.databases = ['AppData', ...globalThis.variaStub.databases.filter(name => name !== 'AppData')] })
  await expect(async () => {
    await chooseExplorerMenuItem(page, ['server-a', 'Databases'], 'Refresh')
    await expect(explorerTree(page).getByRole('treeitem', { name: /^AppData\b/ })).toHaveCount(1, { timeout: 2000 })
  }).toPass()
  console.log('Object action checks: Tasks › Detach… lists the sessions and the files that stay, holds OK until Drop Connections, scripts SINGLE_USER and sp_detach_db, stays open on Success, removes AppData and toasts with Copy paths.')

  // A database row's menu item. Databases may have just reloaded (after Database Properties' Apply, or a Delete), so the
  // helper presses until its row's own menu opens.
  const databaseItem = (path, item) => chooseExplorerMenuItem(page, path, item)

  // 6a. D3d: offline Archive's Delete Object says that its files stay on disk and counts the query window on it. Deleting it
  // drops it from Databases, a toast counts that window, and its Properties document turns orphan with only Close.
  const archive = ['server-a', 'Databases', 'Archive']
  const archiveProperties = () => documentFrame(page, 'Archive')
  const archiveTab = () => documentTab(page, 'Database Properties - Archive')
  await databaseItem(archive, 'Properties')
  await expect(archiveTab()).toHaveAttribute('aria-selected', 'true')
  const archiveTabsBefore = await tabs().count()
  await databaseItem(archive, 'New Query')
  await expect(tabs()).toHaveCount(archiveTabsBefore + 1)
  await databaseItem(archive, 'Delete')
  await expect(objectDialogProgress(dialog())).toHaveText('Ready')
  await expect(objectDialogWarnings(dialog())).toHaveText([offlineWarning])
  await expect(dialog().getByText('1 query window uses this database.', { exact: true })).toBeVisible()
  await expect(objectDialogSessions(dialog())).toHaveCount(0)
  // An offline database has no connections to close: the option is greyed with its reason, and its label greys with it.
  const closeOption = () => dialog().getByLabel('Close existing connections', { exact: true })
  const historyOption = () => dialog().getByLabel('Delete backup and restore history information for databases', { exact: true })
  const labelColour = option => option.evaluate(input => getComputedStyle(input.closest('label')).color)
  await expect(closeOption()).toBeDisabled()
  await expect(closeOption()).toHaveAccessibleDescription('An offline database has no connections to close.')
  expect(await labelColour(closeOption())).not.toBe(await labelColour(historyOption()))
  await page.screenshot({ path: resolve('artifacts', 'object-actions-delete-offline-dark.png') })
  await dialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  expect((await stubCalls('actions.execute')).at(-1)).toMatchObject({ action: 'delete', target: { kind: 'database', name: 'Archive' }, closeConnections: false, deleteHistory: true })
  await expect(explorerTree(page).locator(part.explorerLabel, { hasText: /^Archive$/ })).toHaveCount(0)
  await expect(toastMessage(toasts(page).filter({ hasText: 'Archive' }))).toHaveText('1 query window was using Archive.')
  await archiveTab().click()
  await expect(documentBanner(archiveProperties())).toContainText('This database no longer exists on server-a.')
  await expect(documentBanner(archiveProperties()).getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0)
  await expect(documentState(archiveProperties())).toHaveCount(0)
  await page.screenshot({ path: resolve('artifacts', 'object-actions-properties-orphan-dark.png') })
  await documentBanner(archiveProperties()).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(archiveTab()).toHaveCount(0)
  console.log('Object action checks: an offline database\'s Delete Object warns that its files stay, and deleting it leaves a toast for its query window and an orphaned Properties document with Close.')

  // 6. A database: SSMS's two options (backup history checked, Close existing connections not), the sessions using it and
  // how many hold a transaction that closing them rolls back, then a lost server leaves only Close. The right-click can
  // scroll AppData into view first. Chromium sends that scroll's event with a later frame, which must not close the menu:
  // on a Windows run it did, and the forced click on Delete selected the row under the closed menu instead.
  await openExplorerMenu(page, ...appData)
  await explorerTree(page).evaluate(tree => { tree.dispatchEvent(new Event('scroll')) })
  await expect(explorerMenu()).toBeVisible()
  await chooseExplorerMenuItem(page, appData, 'Delete')
  await expect(objectDialogProgress(dialog())).toHaveText('Ready')
  await expect(historyOption()).toBeChecked()
  await expect(closeOption()).not.toBeChecked()
  // Eight sessions with long program and host names sit in a headed disclosure whose grid scrolls by itself, so the options
  // and what closing rolls back stay in view; the rollback note describes the option it is about.
  const rollback = '4 sessions have open transactions, which Close existing connections rolls back.'
  await expect(objectDialogSessionsToggle(dialog())).toHaveText('Sessions using AppData (23)')
  await expect(objectDialogSessionsToggle(dialog())).toHaveAttribute('aria-expanded', 'true')
  await expect(objectDialogSessions(dialog())).toHaveCount(8)
  await expect(objectDialogSessions(dialog()).first().getByRole('cell')).toHaveText(['61', /^Report Builder 1 p+$/, /^BUILD-1-h+$/, 'Yes'])
  await expect(dialog().getByText('More sessions are connected than are listed.', { exact: true })).toBeVisible()
  await expect(closeOption()).toHaveAccessibleDescription(rollback)
  /** Whether the option's box and the note under it show inside the page without scrolling it. */
  const optionsInView = () => objectDialogPage(dialog()).evaluate(area => {
    const shown = area.getBoundingClientRect(), close = [...area.querySelectorAll('label')].find(label => label.textContent === 'Close existing connections')
    const notes = [close, ...[...area.querySelectorAll('[id^="delete-object-"][id$="-note"]')]].map(element => element.getBoundingClientRect())
    return area.scrollTop === 0 && notes.length > 1 && notes.every(rect => rect.top >= shown.top && rect.bottom <= shown.bottom)
  })
  await expect.poll(optionsInView, 'Close existing connections and its notes show without scrolling the page').toBe(true)
  await page.screenshot({ path: resolve('artifacts', 'object-actions-database-dark.png') })
  await objectDialogSessionsToggle(dialog()).click()
  await expect(objectDialogSessions(dialog())).toHaveCount(0)
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  // On Managed Instance the option is greyed with its reason, and the note only counts the transactions it cannot roll back.
  await application.evaluate(() => { globalThis.variaStub.managed = true })
  await databaseItem(appData, 'Delete')
  await expect(objectDialogProgress(dialog())).toHaveText('Ready')
  await expect(closeOption()).toBeDisabled()
  await expect(closeOption()).toHaveAccessibleDescription('Managed Instance cannot set SINGLE_USER. 4 sessions have open transactions.')
  expect(await labelColour(closeOption())).not.toBe(await labelColour(historyOption()))
  await expect.poll(optionsInView, 'on Managed Instance too').toBe(true)
  await page.screenshot({ path: resolve('artifacts', 'object-actions-database-managed-dark.png') })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('varia:backend-state', {
    status: 'restarting', generation: 1, lost: { generation: 1, reason: 'crash', connections: 1, queries: 0 }, retryInMs: 60000
  }))
  await expect(dialog().getByRole('alert')).toHaveText('The server was disconnected.')
  await expect(dialog().getByRole('button', { name: 'OK', exact: true })).toBeDisabled()
  await dialog().getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  console.log('Object action checks: a database\'s Delete Object offers SSMS\'s options with their defaults, and a lost server leaves only Close.')

  expect(failures).toEqual([])
  console.log('Object action checks passed: menus, Select Top for views, inline Rename, the Delete Object dialog with Script and errors, Database Properties, database options, and a lost server.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'object-actions-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
