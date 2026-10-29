import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expandExplorerPath, explorerRow, explorerTree, revealExplorerRow } from './fixtures/explorer-tree.mjs'
import { actionsStubData, caution, dependentsMessage, installActionsStub, propertiesScript, scriptText } from './fixtures/actions-stub.mjs'
import {
  backendReady, closeDocumentButton, documentBanner, documentCrumbs, documentFrame, documentState, documentSubtitle, documentTab, documentTabs, documentVerb, editorText, errorBanner,
  explorerLabel, fieldHint, frameSection, menuItemNames, objectDialogConnection, objectDialogProgress, objectDialogWarnings, openMenus as openMenusOf, part, propertyFact, propertyRow,
  renameBox, scriptActions, scriptNotice, scriptText as drawerText, scriptToggle, sectionList as sectionListOf, statusSegment, toolbarButton, unsavedMark,
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

const fast = { force: true }
const menuNamed = name => page.getByRole('menu', { name, exact: true })
const explorerMenu = () => menuNamed('Object Explorer')
const openMenus = () => openMenusOf(page)
const labels = () => menuItemNames(explorerMenu())
const disabled = () => menuItemNames(explorerMenu(), { disabled: true })
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
/** Right-clicks a row and returns its menu's item labels. */
async function menuOf(...path) {
  await (await revealExplorerRow(page, ...path)).click({ button: 'right', force: true })
  await expect(explorerMenu()).toBeVisible()
  return labels()
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
  expect(await menuOf(...appData)).toEqual(['New Query', 'Script Database as', 'Copy Name', 'Rename', 'Delete', 'Refresh', 'Properties'])
  await closeMenu()
  // SSMS offers Properties on its own databases too: only Rename and Delete are greyed.
  expect(await menuOf('server-a', 'Databases', 'System Databases', 'master')).toEqual(['New Query', 'Script Database as', 'Copy Name', 'Rename', 'Delete', 'Refresh', 'Properties'])
  expect(await disabled()).toEqual(['Rename', 'Delete'])
  await closeMenu()
  await select('server-a', 'Databases', 'System Databases', 'master')
  await page.keyboard.press('F2')
  await expect(renameBox(page)).toHaveCount(0)
  await page.keyboard.press('Delete')
  await expect(dialog()).toHaveCount(0)
  console.log('Object action checks: table, view, procedure and database menus in SSMS\'s order, Properties last, with master\'s Rename and Delete greyed and its keys inert.')

  // 2. Select Top 1000 Rows on a view lists its columns and runs on its database.
  const before = await tabs().count()
  await (await revealExplorerRow(page, ...appData, 'Views', 'dbo.OrderSummary')).click({ button: 'right', force: true })
  await explorerMenu().getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true }).click(fast)
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
  await (await explorerRow(page, ...tablesPath, 'dbo.Orders2')).click({ button: 'right', force: true })
  await explorerMenu().getByRole('menuitem', { name: 'Delete', exact: true }).click(fast)
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
  const windowSize = size => application.evaluate(({ BrowserWindow }, [width, height]) => { BrowserWindow.getAllWindows()[0].setSize(width, height) }, size)
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
  // Tables has just reloaded after the Delete, which can re-render the tree under the press, so it repeats until its row's menu opens.
  await expect(async () => {
    await (await revealExplorerRow(page, ...appData)).click({ button: 'right', force: true })
    await expect(explorerMenu()).toBeVisible({ timeout: 1000 })
  }).toPass()
  await explorerMenu().getByRole('menuitem', { name: 'Properties', exact: true }).click(fast)
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

  // 6. A database: SSMS's two options (backup history checked, Close existing connections not), then a lost server
  // leaves only Close. Databases has just reloaded after Database Properties' Apply, so the press repeats until its row's menu opens.
  await expect(async () => {
    await (await revealExplorerRow(page, ...appData)).click({ button: 'right', force: true })
    await expect(explorerMenu()).toBeVisible({ timeout: 1000 })
  }).toPass()
  await explorerMenu().getByRole('menuitem', { name: 'Delete', exact: true }).click(fast)
  await expect(objectDialogProgress(dialog())).toHaveText('Ready')
  await expect(dialog().getByLabel('Delete backup and restore history information for databases', { exact: true })).toBeChecked()
  await expect(dialog().getByLabel('Close existing connections', { exact: true })).not.toBeChecked()
  await page.screenshot({ path: resolve('artifacts', 'object-actions-database-dark.png') })
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
