// Hot exit and Rename Tab on the fake backend: tabs renamed by F2, a double-click and the tab menu (Escape keeps the old
// name), Save As suggesting a renamed tab's name, then a quit that asks nothing and a relaunch on the same profile that
// reopens every tab in order, with its text, unsaved state and name, the active one active, a clean file read again from
// disk, and no Recover dialog. Native message boxes are stubbed in main and recorded; files live under artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { activeDocumentName, backendReady, documentShelf, documentTab, documentTabs, editorText, editorTextbox, gridCell, menubar, outputStatus, pinDocumentButton, queryStatus, quickInputBox, quickInputRows, resultGrid, tabNameBox, toolbarButton, unsavedMark } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'hot-exit-profile-'))
const control = await mkdtemp(resolve('artifacts', 'hot-exit-control-'))
const folder = await mkdtemp(resolve('artifacts', 'hot-exit-documents-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control, VARIA_TEST_HOT_EXIT: '1' }
delete env.ELECTRON_RUN_AS_NODE
const chromiumSandbox = process.getuid?.() !== 0
const orders = join(folder, 'orders.sql')
await writeFile(orders, 'SELECT 1 AS orders')
let application, page
const failures = []
const watchdog = setTimeout(() => { console.error('Hot exit suite exceeded its time limit.'); application?.process()?.kill(); process.exit(1) }, 180_000)

/** Launches on the suite's profile, with main's message boxes recorded (and answered Cancel) and its Save dialog cancelled. */
async function launch(args) {
  application = await electron.launch({ args: ['.', ...args], env, chromiumSandbox })
  await application.evaluate(({ dialog }) => {
    const state = globalThis.variaHotExit = { prompts: [], saveDefaults: [], reloadAnswer: 1, savePath: '' }
    dialog.showMessageBox = async (_window, options) => {
      const prompt = options ?? _window
      state.prompts.push(prompt.message)
      return { response: prompt.title === 'Reload workbench' ? state.reloadAnswer : prompt.cancelId ?? 2, checkboxChecked: false }
    }
    dialog.showSaveDialog = async (_window, options) => {
      state.saveDefaults.push((options ?? _window).defaultPath)
      return { canceled: !state.savePath, filePath: state.savePath }
    }
  })
  page = await application.firstWindow()
  page.on('pageerror', error => failures.push(error.message))
  // Electron owns beforeunload and its native Reload dialog. Do not let Playwright dismiss it first.
  page.on('dialog', () => {})
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
}
const tabNames = () => documentTabs(page).getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))
// Monaco draws spaces as no-break spaces.
const text = async () => (await editorText(page)).replaceAll('\u00a0', ' ')
const prompts = () => application.evaluate(() => globalThis.variaHotExit.prompts)
const typeInNew = async text => {
  await toolbarButton(page, 'New query').click()
  await editorTextbox(page).focus()
  await page.keyboard.insertText(text)
}
const tabMenuItem = async (tab, name) => {
  await documentTab(page, tab).click({ button: 'right' })
  await page.getByRole('menuitem', { name, exact: true }).click()
}

try {
  await launch([orders])
  await expect(documentTab(page, 'orders.sql')).toBeVisible()
  expect(await tabNames()).toEqual(['SQLQuery1.sql', 'orders.sql'])

  // F2 on the focused tab renames it in place; Enter keeps the name and focus returns to the tab.
  await typeInNew('SELECT 2 AS month_end')
  await documentTab(page, 'SQLQuery2.sql').focus()
  await page.keyboard.press('F2')
  await expect(tabNameBox(page)).toBeFocused()
  await expect(tabNameBox(page)).toHaveValue('SQLQuery2.sql')
  await page.keyboard.insertText('Month end')
  await page.keyboard.press('Enter')
  await expect(documentTab(page, 'Month end')).toBeFocused()
  await expect(tabNameBox(page)).toHaveCount(0)
  // A double-click renames too; the tooltip names what it would be called otherwise.
  await typeInNew('SELECT 3 AS totals')
  await documentTab(page, 'SQLQuery3.sql').dblclick()
  await page.keyboard.insertText('Totals')
  await page.keyboard.press('Enter')
  await expect(documentTab(page, 'Totals')).toHaveAttribute('title', 'SQLQuery3.sql (unsaved changes)')
  // The tab menu's Rename Tab…; Escape keeps the old name, and so does an empty one, which takes a rename away.
  await tabMenuItem('SQLQuery1.sql', 'Rename Tab…')
  await page.keyboard.insertText('Ignored')
  await page.keyboard.press('Escape')
  await expect(documentTab(page, 'SQLQuery1.sql')).toBeVisible()
  await tabMenuItem('SQLQuery1.sql', 'Rename Tab…')
  await page.keyboard.insertText('Welcome')
  await page.keyboard.press('Enter')
  await tabMenuItem('orders.sql', 'Rename Tab…')
  await page.keyboard.insertText('Orders report')
  await page.keyboard.press('Enter')
  await expect(documentTab(page, 'Orders report')).toHaveAttribute('title', orders)
  expect(await tabNames()).toEqual(['Welcome', 'Orders report', 'Month end', 'Totals'])
  console.log('Hot exit checks: Rename Tab by F2, a double-click and the tab menu, Escape keeping the old name.')

  // Save As suggests a renamed tab's name, beside its file when it has one.
  await tabMenuItem('Month end', 'Save As…')
  await tabMenuItem('Orders report', 'Save As…')
  await expect.poll(() => application.evaluate(() => globalThis.variaHotExit.saveDefaults.map(path => path.split(/[\\/]/).at(-1)))).toEqual(['Month end.sql', 'Orders report.sql'])
  expect((await application.evaluate(() => globalThis.variaHotExit.saveDefaults))[1]).toBe(join(folder, 'Orders report.sql'))

  // Totals moves first, and Month end is the active tab as the app quits; nothing asks to save.
  await documentTab(page, 'Totals').click()
  for (let step = 0; step < 3; step++) await page.keyboard.press('Control+Shift+PageUp')
  await documentTab(page, 'Month end').click()
  await pinDocumentButton(page, 'Totals').click()
  await expect(documentShelf(page, true).getByRole('tab', { name: 'Totals', exact: true })).toBeFocused()
  expect(await activeDocumentName(page)).toBe('Month end')
  await page.keyboard.press('F2')
  await expect(tabNameBox(page)).toHaveValue('Totals')
  await page.keyboard.press('Escape')
  await expect(tabNameBox(page)).toHaveCount(0)
  expect(await tabNames()).toEqual(['Totals', 'Welcome', 'Orders report', 'Month end'])
  const exited = new Promise(done => application.process().once('exit', done))
  await application.evaluate(({ app }) => app.quit())
  await exited
  const kept = JSON.parse(await readFile(join(profile, 'Session', 'session.json'), 'utf8'))
  expect(kept.documents.map(document => [document.name, document.baseName, document.dirty, document.text])).toEqual([
    ['Totals', 'SQLQuery3.sql', true, 'SELECT 3 AS totals'], ['Welcome', 'SQLQuery1.sql', false, expect.stringContaining('@@SERVERNAME')],
    ['Orders report', 'orders.sql', false, undefined], ['Month end', 'SQLQuery2.sql', true, 'SELECT 2 AS month_end']
  ])
  expect(kept.documents[2].path).toBe(orders)
  expect(kept.documents[0].pinned).toBe(true)
  expect(kept.activeIndex).toBe(3)
  console.log('Hot exit checks: a quit asks nothing and keeps the tabs, in order, with their text and names.')

  // Changed on disk meanwhile: a clean file reopens with what is there now.
  await writeFile(orders, 'SELECT 2 AS orders')
  await launch([])
  await expect.poll(tabNames).toEqual(['Totals', 'Welcome', 'Orders report', 'Month end'])
  await expect(documentShelf(page, true).getByRole('tab', { name: 'Totals', exact: true })).toBeVisible()
  await expect(pinDocumentButton(page, 'Totals', true)).toBeVisible()
  expect(await activeDocumentName(page)).toBe('Month end')
  await expect.poll(text).toContain('SELECT 2 AS month_end')
  await expect(unsavedMark(documentTab(page, 'Month end'))).toBeVisible()
  await expect(unsavedMark(documentTab(page, 'Totals'))).toBeVisible()
  await expect(unsavedMark(documentTab(page, 'Welcome'))).toHaveCount(0)
  await documentTab(page, 'Orders report').click()
  await expect.poll(text).toContain('SELECT 2 AS orders')
  await expect(unsavedMark(documentTab(page, 'Orders report'))).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Recover Unsaved Queries', exact: true })).toHaveCount(0)
  // New queries are numbered after the reopened ones.
  await toolbarButton(page, 'New query').click()
  expect(await activeDocumentName(page)).toBe('SQLQuery4.sql')
  console.log('Hot exit checks: a relaunch reopens every tab in order, with its text, unsaved state and name, and no Recover dialog.')

  expect(await prompts()).toEqual([])
  // A canceled reload leaves the current page and its pins intact. An accepted reload reopens just the pins.
  await pinDocumentButton(page, 'Orders report').click()
  await documentTab(page, 'Orders report').click()
  await page.evaluate(() => window.__variaRecovery.flush())
  const reload = async () => {
    await page.keyboard.press('F1')
    await quickInputBox(page).fill('>Reload Window')
    await expect(quickInputRows(page).filter({ hasText: 'Reload Window' })).toBeVisible()
    await quickInputBox(page).press('Enter')
  }
  await reload()
  await expect.poll(prompts).toEqual(['Reload Varia SQL Manager?'])
  expect(await tabNames()).toEqual(['Totals', 'Orders report', 'Welcome', 'Month end', 'SQLQuery4.sql'])
  // Hold the saved pin's read so the replacement page can issue another reload during the restore.
  await application.evaluate((_electron, path) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
    const original = fs.open, state = globalThis.variaHotExit
    state.reloadAnswer = 0
    fs.open = async (file, ...args) => {
      if (file === path && !state.releaseRead) {
        await new Promise(resolve => { state.releaseRead = resolve })
      }
      return original(file, ...args)
    }
    syncBuiltinESMExports()
    state.restoreOpen = () => { fs.open = original; syncBuiltinESMExports(); state.releaseRead?.() }
  }, orders)
  try {
    const reloaded = page.waitForEvent('domcontentloaded')
    await reload()
    await reloaded
    await expect.poll(() => application.evaluate(() => !!globalThis.variaHotExit.releaseRead)).toBe(true)
    expect(await tabNames()).toEqual([])
    await reload()
    await expect(page.getByRole('alert').filter({ hasText: 'Wait for the current document operation to finish before reloading.' })).toBeVisible()
    expect(await page.evaluate(() => window.varia.runRole('reload'))).toMatchObject({
      ok: false, error: 'Wait for the pinned tabs to reopen before reloading.'
    })
  } finally {
    await application.evaluate(() => globalThis.variaHotExit.restoreOpen())
  }
  await expect.poll(tabNames).toEqual(['Totals', 'Orders report'])
  const recover = page.getByRole('dialog', { name: 'Recover Unsaved Queries', exact: true })
  await expect(recover.getByRole('checkbox', { name: 'Recover Month end', exact: true })).toBeVisible()
  await expect(recover.getByRole('checkbox', { name: 'Recover Totals', exact: true })).toHaveCount(0)
  await recover.getByRole('button', { name: 'Later', exact: true }).click()
  expect(await activeDocumentName(page)).toBe('Orders report')
  await expect.poll(text).toContain('SELECT 2 AS orders')
  await documentTab(page, 'Totals').click()
  await expect.poll(text).toContain('SELECT 3 AS totals')
  await expect(unsavedMark(documentTab(page, 'Totals'))).toBeVisible()
  console.log('Hot exit checks: canceling Reload Window keeps the page, and a second reload during restore preserves both pins.')

  expect(await page.evaluate(() => window.varia.updateSettings({
    'environment.documents.hotExit': false, 'environment.documents.detectExternalChanges': true
  }))).toMatchObject({ ok: true })
  await documentTab(page, 'Orders report').click()
  await editorTextbox(page).focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT 4 AS pinned_orders')
  await expect(unsavedMark(documentTab(page, 'Orders report'))).toBeVisible()

  // The value editor can save multibyte XML above the SQL file limit. A path-only pin must reopen it with its own limit.
  await toolbarButton(page, 'Connect').click()
  const connect = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(connect.getByText('Loading saved connections…')).toHaveCount(0)
  await connect.getByLabel('Server Name', { exact: true }).fill('hot-exit-test')
  await connect.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await connect.getByLabel('Trust server certificate', { exact: true }).check()
  await connect.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(connect).toHaveCount(0)
  await typeInNew('SELECT 1 -- FOR_XML_FIXTURE')
  await page.keyboard.press('F5')
  await expect(outputStatus(page)).toContainText(/^Completed/)
  await gridCell(resultGrid(page), 0, 0).click()
  await expect(queryStatus(page)).toHaveText('XML document')
  const xmlPath = join(folder, 'large-pin.xml')
  const xml = '<pinnedRoot>\r\n' + ('  <row>' + '\u6f22'.repeat(600) + '</row>\r\n').repeat(2830) + '</pinnedRoot>'
  await application.evaluate(({ clipboard }, { xml, xmlPath }) => {
    clipboard.writeText(xml)
    globalThis.variaHotExit.savePath = xmlPath
  }, { xml, xmlPath })
  await editorTextbox(page).focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+V')
  await expect(unsavedMark(documentTab(page, /\.xml$/))).toBeVisible()
  await page.keyboard.press('Control+S')
  await expect(documentTab(page, 'large-pin.xml')).toBeVisible()
  expect((await stat(xmlPath)).size).toBeGreaterThan(5_000_000)
  await pinDocumentButton(page, 'large-pin.xml').click()
  // Close the unpinned test query without saving it. The close stub chooses Don't Save for a query prompt below.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  const restarted = new Promise(done => application.process().once('exit', done))
  await application.evaluate(({ app }) => app.quit())
  await restarted
  const pinnedRecord = JSON.parse(await readFile(join(profile, 'Session', 'session.json'), 'utf8'))
  expect(pinnedRecord.documents.map(tab => tab.name)).toEqual(['Totals', 'Orders report', 'large-pin.xml'])
  expect(pinnedRecord.documents[1]).toMatchObject({
    path: orders, dirty: true, text: 'SELECT 4 AS pinned_orders', fileSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
  })
  expect(pinnedRecord.documents[2]).toMatchObject({ kind: 'xml', path: xmlPath, dirty: false, pinned: true })
  expect(pinnedRecord.documents[2].text).toBeUndefined()
  const externalOrders = 'SELECT 5 AS external_orders'
  await writeFile(orders, externalOrders)
  await launch([])
  await expect(documentShelf(page, true).getByRole('tab', { name: 'large-pin.xml', exact: true })).toBeVisible()
  expect(await activeDocumentName(page)).toBe('large-pin.xml')
  await expect(queryStatus(page)).toHaveText('XML document')
  await expect.poll(text).toContain('<pinnedRoot>')
  console.log('Hot exit checks: a saved XML pin above 5 MB reopens with startup restore off.')

  const recoverAgain = page.getByRole('dialog', { name: 'Recover Unsaved Queries', exact: true })
  await expect(recoverAgain.getByRole('checkbox', { name: 'Recover Month end', exact: true })).toBeVisible()
  await recoverAgain.getByRole('button', { name: 'Later', exact: true }).click()

  // Save from the restored dirty pin sees the disk change made while the app was closed.
  await documentTab(page, 'Orders report').click()
  await expect.poll(text).toContain('SELECT 4 AS pinned_orders')
  await editorTextbox(page).focus()
  await page.keyboard.press('Control+S')
  await expect.poll(prompts).toContain(`The file ${orders} was changed outside Varia SQL Manager.`)
  expect(await readFile(orders, 'utf8')).toBe(externalOrders)
  await expect(unsavedMark(documentTab(page, 'Orders report'))).toBeVisible()
  console.log('Hot exit checks: saving a restored dirty pin warns about external changes, and Cancel leaves both versions intact.')

  // A quit during navigation must reach the replacement page after it reopens the pins.
  await application.evaluate(({ app, BrowserWindow }) => {
    globalThis.variaHotExit.reloadAnswer = 0
    BrowserWindow.getAllWindows()[0].webContents.once('did-start-navigation', () => app.quit())
  })
  const quitDuringReload = new Promise(done => application.process().once('exit', done))
  await menubar(page).getByRole('menuitem', { name: 'View', exact: true }).click()
  await page.getByRole('menu', { name: 'View', exact: true }).getByRole('menuitem', { name: 'Reload Window', exact: true }).click()
  await quitDuringReload
  const afterReloadQuit = JSON.parse(await readFile(join(profile, 'Session', 'session.json'), 'utf8'))
  expect(afterReloadQuit.documents).toEqual(pinnedRecord.documents)
  console.log('Hot exit checks: quitting during a pinned reload keeps the pins for the next start.')
  expect(failures).toEqual([])
  console.log('Hot exit suite passed.')
} catch (error) {
  console.error(error)
  if (page) await page.screenshot({ path: resolve('artifacts', 'hot-exit-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await application?.close().catch(() => {})
  for (const directory of [profile, control, folder]) if (basename(directory).startsWith('hot-exit-')) await rm(directory, { recursive: true, force: true }).catch(() => {})
}
