// Hot exit and Rename Tab on the fake backend: tabs renamed by F2, a double-click and the tab menu (Escape keeps the old
// name), Save As suggesting a renamed tab's name, then a quit that asks nothing and a relaunch on the same profile that
// reopens every tab in order, with its text, unsaved state and name, the active one active, a clean file read again from
// disk, and no Recover dialog. Native message boxes are stubbed in main and recorded; files live under artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { activeDocumentName, backendReady, documentTab, documentTabs, editorText, editorTextbox, tabNameBox, toolbarButton, unsavedMark } from './fixtures/ui.mjs'

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
    const state = globalThis.variaHotExit = { prompts: [], saveDefaults: [] }
    dialog.showMessageBox = async (_window, options) => { state.prompts.push((options ?? _window).message); return { response: 2, checkboxChecked: false } }
    dialog.showSaveDialog = async (_window, options) => { state.saveDefaults.push((options ?? _window).defaultPath); return { canceled: true, filePath: '' } }
  })
  page = await application.firstWindow()
  page.on('pageerror', error => failures.push(error.message))
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
  expect(kept.activeIndex).toBe(3)
  console.log('Hot exit checks: a quit asks nothing and keeps the tabs, in order, with their text and names.')

  // Changed on disk meanwhile: a clean file reopens with what is there now.
  await writeFile(orders, 'SELECT 2 AS orders')
  await launch([])
  await expect.poll(tabNames).toEqual(['Totals', 'Welcome', 'Orders report', 'Month end'])
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
