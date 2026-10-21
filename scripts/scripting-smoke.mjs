import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { expandExplorerPath, explorerRow, explorerTree, revealExplorerRow } from './fixtures/explorer-tree.mjs'
import { encryptedMessage, installScriptingStub, scriptingStubData, viewDefinitionWarning } from './fixtures/scripting-stub.mjs'

// Same rules as the backend live checks: SQL authentication when a test login is supplied, otherwise Windows authentication.
const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (process.env.VARIA_TEST_SQL_SERVER && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'scripting-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const settingsFile = join(profile, 'settings.json'), legacyFile = join(profile, 'scripting-options.json')
const mac = process.platform === 'darwin'
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Scripting suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 480000)

async function launch() {
  application = await electron.launch(launchOptions)
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
}
// Unsaved queries make a normal exit ask first; answer Don't Save.
async function close() {
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
}
async function menu(id) {
  await application.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId)
    if (!item) throw new Error('Menu item missing: ' + itemId)
    item.click()
  }, id)
}
const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const dialog = () => page.getByRole('dialog', { name: 'Options', exact: true })
const option = label => dialog().getByLabel(label, { exact: true })
const stored = () => readFile(settingsFile, 'utf8').then(JSON.parse, () => null)
const scriptingKey = key => 'objectExplorer.scripting.' + key
const weight = label => option(label).evaluate(element => getComputedStyle(element).fontWeight)
const disabledRows = () => dialog().locator('.options-row select:disabled').evaluateAll(selects => selects.map(select => select.labels[0]?.textContent))
/**
 * Opens Tools › Options… on its Scripting page: Alt+T, O on Windows and Linux (⌘, on macOS is a manual check), or the
 * menu item; the dialog opens on the page last shown, else Environment › General, so the tree goes there.
 */
async function openOptions({ keyboard = !mac } = {}) {
  if (keyboard) {
    await textbox().focus()
    await page.keyboard.press('Alt+t')
    const tools = page.getByRole('menu', { name: 'Tools', exact: true })
    await expect(tools.getByRole('menuitem', { name: 'Options…', exact: true })).toBeFocused()
    await page.keyboard.press('o')
  } else await menu('preferences.options')
  await expect(dialog()).toBeVisible()
  const heading = dialog().locator('.options-heading')
  if (await heading.textContent() !== 'SQL Server Object Explorer › Scripting') {
    await dialog().getByRole('treeitem', { name: 'SQL Server Object Explorer', exact: true }).click()
    await dialog().getByRole('treeitem', { name: 'Scripting', exact: true }).click()
    await expect(heading).toHaveText('SQL Server Object Explorer › Scripting')
  }
  await option('Delimit individual statements').focus()
}
/** Where the dialog lies in the window, and whether the page itself overflows. */
const layout = () => page.evaluate(() => {
  const box = document.querySelector('[role="dialog"]').getBoundingClientRect(), list = document.querySelector('.options-page')
  return { inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
    width: Math.round(box.width), height: Math.round(box.height), innerWidth, innerHeight, listScrolls: list.scrollHeight > list.clientHeight }
})

const stubCalls = method => application.evaluate((_electron, name) => globalThis.variaStub.calls.filter(call => call.method === name).map(call => call.params), method)
const stubCancels = () => application.evaluate(() => globalThis.variaStub.cancels)
const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText())
const menuNamed = name => page.getByRole('menu', { name, exact: true })
const explorerMenu = () => menuNamed('Object Explorer')
const openMenus = () => page.locator('.menu')
const tabs = () => page.locator('.query-tabs').getByRole('tab')
const nbsp = String.fromCharCode(160)
const editorText = async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll(nbsp, ' ')
const scriptStatus = () => page.locator('.status-scripting')
const commandBanner = () => page.locator('.global-error[role="alert"]')
const warningBanner = () => page.locator('.global-error.warning[role="status"]')
const focusInDialog = () => dialog().evaluate(element => element.contains(document.activeElement))
const quickInput = () => page.locator('.quick-input')
// The smoke window is hidden, so animation frames come once a second; nothing in the menus animates, so presses skip
// Playwright's stability wait, and assertions still wait for each result.
const fast = { force: true }
const ordersPath = ['server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders']
/** Connects from the main toolbar: Windows authentication for the stub, the test login for a real server. */
async function connect(server) {
  await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click()
  const connectDialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(connectDialog.getByText('Loading saved connections…')).toHaveCount(0)
  await connectDialog.getByLabel('Server Name', { exact: true }).fill(server)
  if (server === process.env.VARIA_TEST_SQL_SERVER && liveUser) {
    await connectDialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await connectDialog.getByLabel('Login', { exact: true }).fill(liveUser)
    await connectDialog.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD)
  } else await connectDialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  if (server === process.env.VARIA_TEST_SQL_SERVER) await connectDialog.getByLabel('Trust server certificate', { exact: true }).check()
  await connectDialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(connectDialog).toHaveCount(0, { timeout: 30000 })
}
/** Right-clicks the row at `path` and clicks through `items`, one menu level after the other. */
async function scriptFrom(path, ...items) {
  await (await revealExplorerRow(page, ...path)).click({ button: 'right', force: true })
  let level = explorerMenu()
  for (const [index, name] of items.entries()) {
    await level.getByRole('menuitem', { name, exact: true }).click(fast)
    level = menuNamed(name)
    if (index === items.length - 1) await expect(openMenus()).toHaveCount(0)
  }
}
/** Whether every status bar segment lies within the bar (none wraps to a second line), whether the page overflows, and
 *  whether the scripting text is cut with an ellipsis. */
const statusLayout = () => page.evaluate(() => {
  const bar = document.querySelector('.status-bar'), box = bar.getBoundingClientRect(), text = bar.querySelector('.status-scripting-text')
  return {
    fits: [...bar.children].every(child => { const part = child.getBoundingClientRect(); return part.top >= box.top - 0.5 && part.bottom <= box.bottom + 0.5 && part.left >= box.left - 0.5 && part.right <= box.right + 0.5 }),
    overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, cut: !!text && text.scrollWidth > text.clientWidth
  }
})
/** Whether every open menu lies inside the window, and whether the page itself overflows. */
const menusInside = () => page.evaluate(() => ({
  inside: [...document.querySelectorAll('.menu')].every(menu => { const box = menu.getBoundingClientRect(); return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight }),
  count: document.querySelectorAll('.menu').length, overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight
}))
/** Whether the query tab strip scrolls, and whether the active tab lies wholly inside its visible part. */
const activeTabInView = () => page.evaluate(() => {
  const strip = document.querySelector('.query-tabs'), tab = strip.querySelector('.query-tab.active')
  const box = tab.getBoundingClientRect(), view = strip.getBoundingClientRect()
  return { overflows: strip.scrollWidth > strip.clientWidth, inView: box.left >= view.left - 1 && box.right <= view.right + 1 }
})
/** Opens Script Table as › CREATE To on dbo.Orders by mouse, with Clipboard under the pointer. */
async function openNestedScriptMenu() {
  await (await explorerRow(page, ...ordersPath)).click({ button: 'right', force: true })
  await explorerMenu().getByRole('menuitem', { name: 'Script Table as', exact: true }).click(fast)
  await menuNamed('Script Table as').getByRole('menuitem', { name: 'CREATE To', exact: true }).click(fast)
  await menuNamed('CREATE To').getByRole('menuitem', { name: 'Clipboard', exact: true }).hover(fast)
  await expect(menuNamed('CREATE To').getByRole('menuitem', { name: 'Clipboard', exact: true })).toBeFocused()
}

try {
  await launch()
  // 1. Tools › Options… from the keyboard, on the Scripting page: the first row's description shows below it.
  await openOptions()
  await expect(option('Delimit individual statements')).toBeFocused()
  await expect(dialog().locator('.options-description')).toContainText('Delimit individual statements')
  await expect(dialog().getByRole('tree', { name: 'Options pages' }).locator('[aria-selected="true"]')).toHaveText('Scripting')
  for (const name of ['General scripting options', 'Object scripting options', 'Table/View options', 'Version options']) await expect(dialog().getByRole('group', { name, exact: true })).toBeVisible()
  expect(await dialog().locator('.options-row').count()).toBe(36)
  // The version rows are greyed while Match script settings to source is True.
  expect(await disabledRows()).toEqual(['Script for database engine edition', 'Script for database engine type', 'Script for server version'])
  await expect(option('Script for server version')).toHaveValue('160')
  expect(await weight('Script USE <database>')).toBe('400')
  // A greyed row cannot take focus; pressing its label still shows its description (Playwright counts a disabled
  // control's label as disabled, so the press is forced).
  await dialog().locator('label', { hasText: 'Script for server version' }).click({ force: true })
  await expect(dialog().locator('.options-description strong')).toHaveText('Script for server version')
  // The press leaves focus in the dialog, so Escape still cancels it; so does a press on the greyed list itself.
  expect(await focusInDialog()).toBe(true)
  await option('Delimit individual statements').focus()
  await option('Script for database engine type').click({ force: true })
  await expect(dialog().locator('.options-description strong')).toHaveText('Script for database engine type')
  expect(await focusInDialog()).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  await openOptions()
  await expect(option('Delimit individual statements')).toBeFocused()
  console.log('Scripting checks: Alt+T, O opens Tools › Options on the Scripting page, with the version rows greyed and their descriptions a click away that keeps Escape working.')

  // 2. A changed value is bold and its description shows; Reset to Defaults restores the draft only, and Escape discards it.
  await option('Script USE <database>').selectOption('false')
  await option('Script USE <database>').focus()
  await expect(dialog().locator('.options-description')).toContainText('Starts the script with a USE statement')
  await expect.poll(() => weight('Script USE <database>')).toBe('700')
  await option('Match script settings to source').selectOption('false')
  expect(await disabledRows()).toEqual([])
  await option('Script for server version').selectOption('130')
  await dialog().getByRole('button', { name: 'Reset to Defaults', exact: true }).click()
  await expect(option('Script USE <database>')).toHaveValue('true')
  await expect(option('Script for server version')).toHaveValue('160')
  expect(await weight('Script USE <database>')).toBe('400')
  expect(await disabledRows()).toHaveLength(3)
  await option('Script owner').selectOption('true')
  await option('Script owner').focus()
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  expect(await stored()).toBeNull()
  console.log('Scripting checks: bold changed values, the description pane, Reset to Defaults, and Escape discarding the draft.')

  // 3. Tab stays in the dialog; Enter on a select does not submit, and OK stores the options in the user data folder.
  await openOptions({ keyboard: false })
  await expect(option('Script owner')).toHaveValue('false')
  await option('Script USE <database>').selectOption('false')
  await option('Script USE <database>').focus()
  await page.keyboard.press('Enter')
  await expect(dialog()).toBeVisible()
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).focus()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true)
  await dialog().getByRole('button', { name: 'Close options', exact: true }).focus()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog().getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await dialog().getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  // Only what differs from the defaults is stored.
  await expect.poll(stored).toEqual({ version: 1, values: { [scriptingKey('scriptUseDatabase')]: false } })
  expect((await page.evaluate(() => window.varia.getSettings())).value.values[scriptingKey('scriptUseDatabase')]).toBe(false)
  // Main validates what the page sends: an unknown key and a wrong-typed value are refused, and the file is unchanged.
  const refused = await page.evaluate(key => Promise.all([window.varia.updateSettings({ [key + 'Unknown']: true }), window.varia.updateSettings({ [key]: 'no' })]), scriptingKey('scriptUseDatabase'))
  expect(refused.map(result => result.ok)).toEqual([false, false])
  expect(await stored()).toEqual({ version: 1, values: { [scriptingKey('scriptUseDatabase')]: false } })
  console.log('Scripting checks: focus stays in the dialog, Enter on a list does not submit, and OK stores the changed option; main refuses unknown keys and wrong types.')

  // 4. Script As over a stubbed server. A table's menu: Script Table as, with the verbs a table does not support greyed
  // (they open nothing on hover or →), and Shift+F10 and the arrows reaching CREATE To › New Query Editor Window, which
  // opens an unmarked query on AppData. The request carries the options saved above.
  await application.evaluate(installScriptingStub, scriptingStubData())
  await connect('server-a')
  await expandExplorerPath(page, ...ordersPath.slice(0, -1))
  const orders = await explorerRow(page, ...ordersPath)
  await orders.click({ button: 'right', force: true })
  expect(await explorerMenu().locator('.menu-item .menu-label').allTextContents()).toEqual(['Select Top 1000 Rows', 'Script Table as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  await explorerMenu().getByRole('menuitem', { name: 'Script Table as', exact: true }).click(fast)
  const scriptMenu = menuNamed('Script Table as')
  expect(await scriptMenu.locator('.menu-item .menu-label').allTextContents()).toEqual(['CREATE To', 'ALTER To', 'CREATE OR ALTER To', 'DROP To', 'DROP And CREATE To', 'SELECT To', 'INSERT To', 'UPDATE To', 'DELETE To', 'EXECUTE To'])
  await expect(scriptMenu.locator('.menu-separator')).toHaveCount(2)
  expect(await scriptMenu.locator('.menu-item[aria-disabled="true"] .menu-label').allTextContents()).toEqual(['ALTER To', 'CREATE OR ALTER To', 'EXECUTE To'])
  const alter = scriptMenu.getByRole('menuitem', { name: 'ALTER To', exact: true })
  await expect(alter).toHaveAttribute('aria-haspopup', 'menu')
  await alter.hover(fast)
  await expect(alter).toBeFocused()
  // Longer than the hover delay, so a submenu would have opened by now.
  await page.waitForTimeout(700)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await expect(openMenus()).toHaveCount(2)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(openMenus()).toHaveCount(0)
  await expect(explorerTree(page)).toBeFocused()
  const before = await tabs().count()
  await page.keyboard.press('Shift+F10')
  await expect(explorerMenu().getByRole('menuitem', { name: 'Select Top 1000 Rows', exact: true })).toBeFocused()
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowRight', 'Enter']) await page.keyboard.press(key)
  await expect(tabs()).toHaveCount(before + 1)
  await expect.poll(editorText).toBe('-- create dbo.Orders')
  await expect(page.locator('#query-database')).toHaveValue('AppData')
  await expect(page.locator('.query-tabs [aria-selected="true"] .dirty-dot')).toHaveCount(0)
  expect((await stubCalls('scripting.script')).at(-1)).toMatchObject({ targets: [{ kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' }], verb: 'create', options: { scriptUseDatabase: false } })
  console.log('Scripting checks: Script Table as greys ALTER, CREATE OR ALTER and EXECUTE, and the keyboard opens CREATE in an unmarked query on AppData with the saved options.')

  // 5. DROP To › Clipboard, and CREATE To › File…, which suggests dbo.Orders.sql and writes the script; each says so.
  await scriptFrom(ordersPath, 'Script Table as', 'DROP To', 'Clipboard')
  await expect.poll(clipboard).toBe('-- drop dbo.Orders')
  await expect(scriptStatus()).toHaveText('Script copied to the clipboard.')
  const scriptFile = join(profile, 'dbo.Orders.sql')
  await application.evaluate(({ dialog }, path) => {
    globalThis.variaSaveDialogs = []
    dialog.showSaveDialog = async (_window, options) => { globalThis.variaSaveDialogs.push(options.defaultPath); return { canceled: false, filePath: path } }
  }, scriptFile)
  const queries = await tabs().count()
  await scriptFrom(ordersPath, 'Script Table as', 'CREATE To', 'File…')
  await expect.poll(() => readFile(scriptFile, 'utf8').catch(() => null)).toBe('-- create dbo.Orders')
  expect(await application.evaluate(() => globalThis.variaSaveDialogs.map(path => path.split(/[\\/]/).at(-1)))).toEqual(['dbo.Orders.sql'])
  await expect(scriptStatus()).toHaveText('Saved dbo.Orders.sql.')
  await expect(tabs()).toHaveCount(queries)
  console.log('Scripting checks: DROP to the clipboard and CREATE to a file named dbo.Orders.sql, each with its notice.')

  // 6. A view is Script View as; a stored procedure offers Modify and EXECUTE To but no SELECT To, and Modify scripts ALTER.
  await expandExplorerPath(page, 'server-a', 'Databases', 'AppData', 'Views')
  await (await explorerRow(page, 'server-a', 'Databases', 'AppData', 'Views', 'dbo.OrderSummary')).click({ button: 'right', force: true })
  await expect(explorerMenu().getByRole('menuitem', { name: 'Script View as', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  const procedurePath = ['server-a', 'Databases', 'AppData', 'Programmability', 'Stored Procedures', 'dbo.ShipOrder']
  await expandExplorerPath(page, ...procedurePath.slice(0, -1))
  await (await explorerRow(page, ...procedurePath)).click({ button: 'right', force: true })
  expect(await explorerMenu().locator('.menu-item .menu-label').allTextContents()).toEqual(['Modify', 'Script Stored Procedure as', 'Copy Name', 'Rename', 'Delete', 'Refresh'])
  await explorerMenu().getByRole('menuitem', { name: 'Script Stored Procedure as', exact: true }).click(fast)
  expect(await menuNamed('Script Stored Procedure as').locator('.menu-item .menu-label').allTextContents()).toEqual(['CREATE To', 'ALTER To', 'CREATE OR ALTER To', 'DROP To', 'DROP And CREATE To', 'EXECUTE To'])
  await page.keyboard.press('ArrowLeft')
  await explorerMenu().getByRole('menuitem', { name: 'Modify', exact: true }).click(fast)
  await expect.poll(editorText).toBe('-- alter dbo.ShipOrder')
  expect((await stubCalls('scripting.script')).at(-1)).toMatchObject({ verb: 'alter', targets: [{ kind: 'procedure', name: 'ShipOrder' }] })
  console.log('Scripting checks: Script View as, Script Stored Procedure as with EXECUTE and without SELECT, and Modify opening ALTER.')

  // 7. The palette's Script As… lists only what the selection can be scripted with, by verb; SELECT to Clipboard runs.
  await (await explorerRow(page, ...ordersPath)).locator('.oe-label').click()
  await expect(explorerTree(page)).toBeFocused()
  await page.keyboard.press('F1')
  await page.keyboard.insertText('script as')
  await quickInput().getByRole('option', { name: /^Object Explorer: Script As…/ }).click()
  await expect(quickInput().locator('.quick-input-title')).toHaveText('Script Table as')
  expect(await quickInput().locator('.quick-input-group').allTextContents()).toEqual(['CREATE To', 'DROP To', 'DROP And CREATE To', 'SELECT To', 'INSERT To', 'UPDATE To', 'DELETE To'])
  await expect(quickInput().getByRole('option')).toHaveCount(21)
  await page.keyboard.insertText('SELECT to Clipboard')
  await expect(quickInput().locator('.quick-input-row.active .quick-input-label')).toHaveText('SELECT to Clipboard')
  await page.keyboard.press('Enter')
  await expect.poll(clipboard).toBe('-- select dbo.Orders')
  await expect(quickInput()).toHaveCount(0)
  console.log('Scripting checks: Script As… in the palette lists 21 enabled scripts in 7 verb groups and runs SELECT to Clipboard.')

  // 8. An error value reaches the command banner as the backend wrote it; nothing opens.
  const secretPath = [...procedurePath.slice(0, -1), 'dbo.Secret']
  const opened = await tabs().count()
  await scriptFrom(secretPath, 'Script Stored Procedure as', 'CREATE To', 'New Query Editor Window')
  await expect(commandBanner()).toHaveText('Could not run “Object Explorer: Script as CREATE to New Query Editor Window”: ' + encryptedMessage('dbo.Secret'))
  await expect(tabs()).toHaveCount(opened)
  await page.getByRole('button', { name: 'Dismiss command error', exact: true }).click()
  console.log('Scripting checks: an encrypted procedure\'s CREATE shows the backend\'s message in the banner.')

  // 9. A slow script shows in the status bar with Cancel, which cancels it in main and opens nothing.
  await scriptFrom(['server-a', 'Databases', 'AppData', 'Tables', 'dbo.Slow'], 'Script Table as', 'CREATE To', 'New Query Editor Window')
  await expect(scriptStatus()).toContainText('Scripting dbo.Slow…')
  const slow = (await stubCalls('scripting.script')).at(-1)
  expect(slow.targets[0].name).toBe('Slow')
  // From the keyboard: the button goes with its request, and focus returns to the tree it came from, not to the page.
  await expect(explorerTree(page)).toBeFocused()
  await scriptStatus().getByRole('button', { name: 'Cancel scripting', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(stubCancels).toEqual([slow.requestId])
  await expect(scriptStatus()).toHaveText('Scripting cancelled.')
  await expect(explorerTree(page)).toBeFocused()
  await expect(tabs()).toHaveCount(opened)
  await expect(commandBanner()).toHaveCount(0)
  expect(failures).toEqual([])
  console.log('Scripting checks: a slow script shows in the status bar, and Cancel from the keyboard cancels it in main, opens nothing, and returns focus to the tree.')

  // 10. 1024×768 (Windows CI's display): the dialog and Script As's nested menus fit inside the window, and the dialog's
  // list scrolls; screenshots in Dark and Light.
  // Menus close on a resize event, which Chromium dispatches with a frame after the viewport changes (about one a second
  // in a hidden window): wait for the event that carries the final size, or it would close the menu opened next.
  const contentSize = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  await page.evaluate(() => { addEventListener('resize', () => { window.variaResized = [innerWidth, innerHeight] }) })
  const sizeBefore = await contentSize()
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1024, 768) })
  await expect.poll(async () => {
    const [size, resized] = await Promise.all([contentSize(), page.evaluate(() => window.variaResized ?? null)])
    // A window already at that size (a screen that clamps it) has no resize event to wait for.
    return size[0] === 1024 && (size[0] === sizeBefore[0] && size[1] === sizeBefore[1] || resized?.[0] === size[0] && resized[1] === size[1])
  }).toBe(true)
  // A long warning is cut in the middle of the status bar; the other segments keep their one line, and the page never
  // scrolls. Enter on the notice shows the whole warning in the banner. (Before any new query opens here: its editor
  // takes focus on a later frame, which would close a context menu.)
  await scriptFrom(['server-a', 'Databases', 'AppData', 'Tables', 'dbo.Warned'], 'Script Table as', 'CREATE To', 'Clipboard')
  await expect(scriptStatus()).toHaveText('Scripted dbo.Warned with a warning: ' + viewDefinitionWarning('dbo.Warned'))
  expect(await statusLayout()).toEqual({ fits: true, overflow: false, cut: true })
  await scriptStatus().getByRole('button').focus()
  await page.keyboard.press('Enter')
  // A warning, not a failure: the banner's polite variant, with no alert.
  await expect(warningBanner()).toHaveText(viewDefinitionWarning('dbo.Warned'))
  await expect(commandBanner()).toHaveCount(0)
  await page.getByRole('button', { name: 'Dismiss warning', exact: true }).click()
  await expect(warningBanner()).toHaveCount(0)
  // A script's new query opens past the end of a full tab strip, which scrolls to show its tab.
  // From the editor, so New Query does not defer focus to a frame that a hidden window only renders for the screenshot.
  await textbox().focus()
  const strip = await tabs().count()
  for (let index = 0; index < 4; index++) await menu('file.new')
  await expect(tabs()).toHaveCount(strip + 4)
  await scriptFrom(ordersPath, 'Script Table as', 'CREATE To', 'New Query Editor Window')
  await expect(tabs()).toHaveCount(strip + 5)
  await expect.poll(activeTabInView).toEqual({ overflows: true, inView: true })
  await openOptions()
  await expect(option('Script USE <database>')).toHaveValue('false')
  expect(await weight('Script USE <database>')).toBe('700')
  const small = await layout()
  expect(small).toMatchObject({ inside: true, overflow: false, listScrolls: true })
  expect(small.width).toBeLessThanOrEqual(820)
  expect(small.height).toBeLessThanOrEqual(600)
  await option('Script USE <database>').focus()
  await page.screenshot({ path: resolve('artifacts', 'scripting-options-dark.png') })
  // The new script's editor asked for focus on a frame this hidden window renders only now; the dialog keeps it.
  await expect(option('Script USE <database>')).toBeFocused()
  await page.keyboard.press('Escape')
  await openNestedScriptMenu()
  expect(await menusInside()).toEqual({ inside: true, count: 3, overflow: false })
  await page.screenshot({ path: resolve('artifacts', 'scripting-dark.png') })
  for (let presses = 0; presses < 3; presses++) await page.keyboard.press('Escape')
  await expect(openMenus()).toHaveCount(0)
  await menu('theme.mode.light')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe('light')
  await openOptions()
  await option('Match script settings to source').selectOption('false')
  await option('Script for server version').selectOption('170')
  await option('Script for server version').focus()
  await page.screenshot({ path: resolve('artifacts', 'scripting-options-light.png') })
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  await openNestedScriptMenu()
  expect(await menusInside()).toEqual({ inside: true, count: 3, overflow: false })
  await page.screenshot({ path: resolve('artifacts', 'scripting-light.png') })
  for (let presses = 0; presses < 3; presses++) await page.keyboard.press('Escape')
  await expect(openMenus()).toHaveCount(0)
  console.log('Scripting checks: at 1024×768 a new script\'s tab scrolls into view, a long warning stays on the status bar\'s one line, the dialog and the nested Script menus fit, the dialog\'s list scrolls; screenshots in Dark and Light.')

  // 11. The options persist across a restart. An earlier version's invalid scripting-options.json, with no settings.json,
  // is set aside with a warning and the defaults are used.
  await close()
  await launch()
  await openOptions()
  await expect(option('Script USE <database>')).toHaveValue('false')
  await expect(option('Script for server version')).toHaveValue('160')
  await page.keyboard.press('Escape')
  await close()
  await unlink(settingsFile)
  await writeFile(legacyFile, '{ "version": 1, "options": { "scriptUseDatabase": "no" } }')
  await launch()
  const banner = warningBanner().filter({ hasText: 'Scripting options' })
  await expect(banner).toHaveText('Scripting options were invalid (unsupported values) and were reset; the original file was kept.')
  const files = (await readdir(profile)).filter(name => name.startsWith('scripting-options.json'))
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^scripting-options\.json\.invalid-[0-9a-f-]{36}\.json$/)
  await openOptions()
  await expect(option('Script USE <database>')).toHaveValue('true')
  await page.keyboard.press('Escape')
  // A reload of the window does not report the same file again.
  await page.reload()
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  // The workbench asked main for its options before this call, so its answer is in once this one is; a banner would render within a frame.
  await page.evaluate(async () => { await window.varia.getSettings(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  await expect(banner).toHaveCount(0)
  expect(failures).toEqual([])

  // 12. A real server: Script Table as › CREATE To on a scratch table opens it in a new query on that database, and the
  // same script, pointed at a second scratch database by its USE line, creates the table there.
  if (process.env.VARIA_TEST_SQL_SERVER && process.env.VARIA_TEST_SQL_SCRATCH === '1') {
    await close()
    await launch()
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14), name = `VariaScratch_${stamp}_${randomBytes(4).toString('hex')}`, copy = `${name}_rt`
    const wait = { timeout: 30000 }
    async function run(sql, marker) {
      await textbox().focus()
      await page.keyboard.press('Control+A')
      await page.keyboard.insertText(`${sql}\nPRINT '${marker}';`)
      await page.keyboard.press('F5')
      await page.locator('.output-toolbar').getByRole('tab', { name: /^Messages/ }).click()
      await expect(page.locator('.messages')).toContainText(marker, wait)
      await expect(page.locator('.messages .msg.error')).toHaveCount(0)
    }
    await connect(process.env.VARIA_TEST_SQL_SERVER)
    const live = page.locator('.explorer-row.server').first()
    await expect(live).toBeVisible(wait)
    const server = await live.locator('.oe-label').textContent()
    // Each database is marked in the batch that creates it, so ScratchDatabase's sweep can drop it if this run cannot.
    const created = []
    try {
      for (const database of [name, copy]) {
        created.push(database)
        await run(`CREATE DATABASE [${database}];\nEXEC [${database}].sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;`, 'created')
      }
      await run(`USE [${name}];\nCREATE TABLE dbo.Widgets (Id int NOT NULL CONSTRAINT PK_Widgets PRIMARY KEY, Name nvarchar(40) NULL);\nUSE master;`, 'tabled')
      const widgets = [server, 'Databases', name, 'Tables', 'dbo.Widgets']
      await expandExplorerPath(page, ...widgets.slice(0, -1), wait)
      const queriesBefore = await tabs().count()
      await scriptFrom(widgets, 'Script Table as', 'CREATE To', 'New Query Editor Window')
      await expect(tabs()).toHaveCount(queriesBefore + 1, wait)
      await expect.poll(editorText, wait).toContain('CREATE TABLE [dbo].[Widgets]')
      await expect(page.locator('#query-database')).toHaveValue(name)
      await scriptFrom(widgets, 'Script Table as', 'CREATE To', 'Clipboard')
      await expect(scriptStatus()).toHaveText('Script copied to the clipboard.', wait)
      const script = await clipboard()
      expect(script.startsWith(`USE [${name}]`)).toBe(true)
      await run(script.replace(`USE [${name}]`, `USE [${copy}]`), 'copied')
      await run(`IF OBJECT_ID(N'[${copy}].dbo.Widgets', N'U') IS NULL THROW 50000, N'The scripted table is missing.', 1;`, 'verified')
      console.log('Scripting checks: a real server\'s table, scripted to a new query and to the clipboard, creates the same table in another database.')
    } finally {
      for (const database of created) await run(`USE master;\nIF DB_ID(N'${database}') IS NOT NULL\nBEGIN\n  ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n  DROP DATABASE [${database}];\nEND`, 'dropped')
    }
  } else console.log('Scripting checks: the live slice was skipped (it needs VARIA_TEST_SQL_SERVER and VARIA_TEST_SQL_SCRATCH=1).')

  expect(failures).toEqual([])
  console.log('Scripting checks passed: Tools › Options, Script As menus with greyed verbs, every destination, Modify, the palette, errors, cancellation, 1024×768, persistence, an invalid options file, and a real server when configured.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'scripting-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
