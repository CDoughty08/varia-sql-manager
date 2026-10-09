import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'scripting-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const optionsFile = join(profile, 'scripting-options.json')
const mac = process.platform === 'darwin'
let application
let page
const failures = []
const watchdog = setTimeout(() => { console.error('Scripting suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 240000)

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
const stored = () => readFile(optionsFile, 'utf8').then(JSON.parse, () => null)
const weight = label => option(label).evaluate(element => getComputedStyle(element).fontWeight)
const disabledRows = () => dialog().locator('.options-row select:disabled').evaluateAll(selects => selects.map(select => select.labels[0]?.textContent))
/** Opens Tools › Options…: Alt+T, O on Windows and Linux (⌘, on macOS is a manual check), or the menu item. */
async function openOptions({ keyboard = !mac } = {}) {
  if (keyboard) {
    await textbox().focus()
    await page.keyboard.press('Alt+t')
    const tools = page.getByRole('menu', { name: 'Tools', exact: true })
    await expect(tools.getByRole('menuitem', { name: 'Options…', exact: true })).toBeFocused()
    await page.keyboard.press('o')
  } else await menu('preferences.options')
  await expect(dialog()).toBeVisible()
}
/** Where the dialog lies in the window, and whether the page itself overflows. */
const layout = () => page.evaluate(() => {
  const box = document.querySelector('[role="dialog"]').getBoundingClientRect(), list = document.querySelector('.options-list')
  return { inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
    width: Math.round(box.width), height: Math.round(box.height), innerWidth, innerHeight, listScrolls: list.scrollHeight > list.clientHeight }
})

try {
  await launch()
  // 1. Tools › Options… from the keyboard, on the Scripting page: the first row has focus and its description shows below.
  await openOptions()
  await expect(option('Delimit individual statements')).toBeFocused()
  await expect(dialog().locator('.options-description')).toContainText('Delimit individual statements')
  await expect(dialog().getByRole('navigation', { name: 'Options pages' }).locator('[aria-current="page"]')).toHaveText('Scripting')
  for (const name of ['General scripting options', 'Object scripting options', 'Table/View options', 'Version options']) await expect(dialog().getByRole('group', { name, exact: true })).toBeVisible()
  expect(await dialog().locator('.options-row').count()).toBe(36)
  // The version rows are greyed while Match script settings to source is True.
  expect(await disabledRows()).toEqual(['Script for database engine edition', 'Script for database engine type', 'Script for server version'])
  await expect(option('Script for server version')).toHaveValue('160')
  expect(await weight('Script USE <database>')).toBe('400')
  console.log('Scripting checks: Alt+T, O opens Tools › Options on the Scripting page, with the version rows greyed.')

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
  await expect.poll(stored).toMatchObject({ version: 1, options: { scriptUseDatabase: false, scriptOwner: false, matchSourceSettings: true, targetServerVersion: '160' } })
  expect(Object.keys((await stored()).options)).toHaveLength(36)
  expect((await page.evaluate(() => window.varia.getScriptingOptions())).value.options.scriptUseDatabase).toBe(false)
  // Main validates what the page sends: an incomplete set is refused and the file is unchanged.
  const refused = await page.evaluate(() => window.varia.setScriptingOptions({ scriptUseDatabase: true }))
  expect(refused.ok).toBe(false)
  expect((await stored()).options.scriptUseDatabase).toBe(false)
  console.log('Scripting checks: focus stays in the dialog, Enter on a list does not submit, and OK stores the options; main refuses partial sets.')

  // 4. 1024×768 (Windows CI's display): the dialog fits inside the window and its list scrolls; screenshots in Dark and Light.
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1024, 768) })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
  await openOptions()
  await expect(option('Script USE <database>')).toHaveValue('false')
  expect(await weight('Script USE <database>')).toBe('700')
  const small = await layout()
  expect(small).toMatchObject({ inside: true, overflow: false, listScrolls: true })
  expect(small.width).toBeLessThanOrEqual(820)
  expect(small.height).toBeLessThanOrEqual(600)
  await option('Script USE <database>').focus()
  await page.screenshot({ path: resolve('artifacts', 'scripting-options-dark.png') })
  await page.keyboard.press('Escape')
  await menu('theme.mode.light')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe('light')
  await openOptions()
  await option('Match script settings to source').selectOption('false')
  await option('Script for server version').selectOption('170')
  await option('Script for server version').focus()
  await page.screenshot({ path: resolve('artifacts', 'scripting-options-light.png') })
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  console.log('Scripting checks: at 1024×768 the dialog fits with a scrolling list; screenshots in Dark and Light.')

  // 5. The options persist across a restart; an invalid file is set aside with a warning and the defaults are used.
  await close()
  await launch()
  await openOptions()
  await expect(option('Script USE <database>')).toHaveValue('false')
  await expect(option('Script for server version')).toHaveValue('160')
  await page.keyboard.press('Escape')
  await close()
  await writeFile(optionsFile, '{ "version": 1, "options": { "scriptUseDatabase": "no" } }')
  await launch()
  const banner = page.locator('.global-error[role="alert"]').filter({ hasText: 'Scripting options' })
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
  await page.evaluate(async () => { await window.varia.getScriptingOptions(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  await expect(banner).toHaveCount(0)
  expect(failures).toEqual([])
  console.log('Scripting checks passed: Tools › Options from the keyboard and the menu, bold values, greyed version rows, Reset, Escape, OK, 1024×768, persistence, and an invalid file reset with one warning.')
} catch (error) {
  await page?.screenshot({ path: resolve('artifacts', 'scripting-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true })
}
