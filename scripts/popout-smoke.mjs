// Popout windows (docs/popout-windows.md): a panel moves into an OS window of its own by its menu and by dragging its tab
// past the window's edge, works there (the grid's keys and copy, its context menu, the palette, the theme), docks back by
// its menu, its window's button, a drop on the main window and closing its window, and comes back after a restart.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { shapes } from '../tests/fixtures/backend/shapes.mjs'
import {
  backendReady, gridCell, movePane, openMenus, pane, paneTab, part, popoutDockButton, popoutTab, popoutTabs, quickInput, resultGrid, toolbarButton
} from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'popout-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const eol = process.platform === 'win32' ? '\r\n' : '\n'
const w1 = row => shapes.W1.row(row).map(value => value ?? 'NULL')
const tsv = rows => rows.map(row => row.join('\t')).join(eol)
let application = await electron.launch(launchOptions)
let page
const watchdog = setTimeout(() => { console.error('Popout suite exceeded its time limit.'); application.process().kill(); process.exitCode = 1 }, 180000)
const failures = []
const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText())
const setClipboard = text => application.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
const menu = id => application.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId).click(), id)
const windowCount = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
const variable = (target, name) => target.evaluate(key => getComputedStyle(document.documentElement).getPropertyValue(key).trim(), name)
async function ready() {
  page = await application.firstWindow()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
}
/** Runs `move` and answers the popout window's page it opened. */
async function popsOut(move) {
  const opened = application.waitForEvent('window')
  await move()
  const popout = await opened
  popout.setDefaultTimeout(30000)
  popout.on('pageerror', error => failures.push(error.message))
  await expect(popoutTabs(popout)).toBeVisible()
  return popout
}
/**
 * A popout tab's drag over the main window: the browser's own drag and drop, which Playwright cannot carry across windows,
 * so its events are dispatched where the OS would deliver them. `types` are the events at (x, y), in order.
 */
async function dragOnMain(id, x, y, types) {
  await page.evaluate(({ id, x, y, types }) => {
    const transfer = globalThis.popoutTransfer ??= new DataTransfer()
    if (!transfer.types.includes('application/x-varia-pane')) transfer.setData('application/x-varia-pane', id)
    const target = document.elementFromPoint(x, y)
    for (const type of types) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer }))
  }, { id, x, y, types })
}
const center = box => [box.x + box.width / 2, box.y + box.height / 2]

try {
  await ready()
  await toolbarButton(page, 'Connect').click()
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('-- varia-fake: sets=W1*50')
  await page.keyboard.press('F5')
  await expect(gridCell(resultGrid(page), 0, 1)).toHaveText(w1(0)[1])

  // 1. Results moves into a window of its own by its panel menu, with its grid and rows; the main window no longer shows it.
  const results = await popsOut(() => movePane(page, 'results', 'window'))
  expect(await windowCount()).toBe(2)
  await expect(pane(page, 'results')).toHaveCount(0)
  await expect(gridCell(resultGrid(results), 0, 1)).toHaveText(w1(0)[1])
  // The popout has no preload: no window.varia, so no IPC of its own.
  expect(await results.evaluate(() => typeof window.varia)).toBe('undefined')
  expect(await page.evaluate(() => typeof window.varia)).toBe('object')
  // The theme follows, now and when it changes.
  const background = '--varia-dock-background'
  expect(await variable(results, background)).toBe(await variable(page, background))
  const before = await variable(page, background)
  await menu('theme.mode.light')
  await expect.poll(() => variable(page, background)).not.toBe(before)
  await expect.poll(() => variable(results, background)).toBe(await variable(page, background))
  await menu('theme.mode.dark')
  console.log('Popout checks: Results moved into its own window by its menu, without a preload, in the current theme.')

  // 2. It works there: the grid's selection and Ctrl+C, its context menu in that window, the palette in that window.
  await gridCell(resultGrid(results), 1, 1).click()
  await gridCell(resultGrid(results), 2, 2).click({ modifiers: ['Shift'] })
  await setClipboard('')
  await results.keyboard.press('Control+C')
  await expect.poll(clipboard).toBe(tsv([1, 2].map(row => w1(row).slice(1, 3))))
  await gridCell(resultGrid(results), 1, 1).click({ button: 'right' })
  await expect(openMenus(results)).toBeVisible()
  await expect(openMenus(page)).toHaveCount(0)
  await setClipboard('')
  await openMenus(results).getByRole('menuitem', { name: 'Copy with Headers', exact: true }).click()
  await expect(openMenus(results)).toHaveCount(0)
  await expect.poll(clipboard).toBe(tsv([shapes.W1.columns.map(column => column.name).slice(1, 3), ...[1, 2].map(row => w1(row).slice(1, 3))]))
  await results.keyboard.press('F1')
  await expect(quickInput(results)).toBeVisible()
  await expect(quickInput(page)).toBeHidden()
  await results.keyboard.press('Escape')
  await expect(quickInput(results)).toBeHidden()
  await results.screenshot({ path: resolve('artifacts', 'popout-results.png') })
  console.log('Popout checks: the popped-out grid copies by keys and by its own context menu, and the palette opens in its window.')

  // 3. Its window's button docks it back, and its window closes.
  await popoutDockButton(results).click()
  await expect(pane(page, 'results')).toBeVisible()
  await expect.poll(windowCount).toBe(1)
  await expect(gridCell(resultGrid(page), 0, 1)).toHaveText(w1(0)[1])

  // 4. Object Explorer's tab dragged past the window's edge pops it out; dropped back on the main window, it docks there.
  await menu('window.togglePanelTabs')
  await expect(paneTab(page, 'explorer')).toBeVisible()
  const explorer = await popsOut(async () => {
    const tab = await paneTab(page, 'explorer').boundingBox(), width = await page.evaluate(() => window.innerWidth)
    await page.mouse.move(tab.x + 20, tab.y + tab.height / 2); await page.mouse.down()
    await page.mouse.move(tab.x + 21, tab.y + tab.height / 2)
    await page.mouse.move(width + 200, tab.y + 60, { steps: 6 }); await page.mouse.up()
  })
  await expect(pane(page, 'explorer')).toHaveCount(0)
  await expect(pane(explorer, 'explorer')).toBeVisible()
  const editor = await pane(page, 'editor').boundingBox()
  await popoutTab(explorer, 'explorer').dispatchEvent('dragstart', { dataTransfer: await explorer.evaluateHandle(() => new DataTransfer()) })
  // Over the editor the main window's compass shows; dropped on its right cell, the panel docks right of the editor.
  await dragOnMain('explorer', ...center(editor), ['dragenter', 'dragover'])
  await expect(page.locator(part.dockingGuides)).toBeVisible()
  const right = await page.locator('[data-guide-position="right"][data-guide-scope="panel"]').boundingBox()
  await dragOnMain('explorer', ...center(right), ['dragover'])
  await expect(page.locator(part.activeDockingGuideCell)).toHaveAttribute('data-guide-position', 'right')
  await dragOnMain('explorer', ...center(right), ['drop'])
  await expect(pane(page, 'explorer')).toBeVisible()
  await expect.poll(windowCount).toBe(1)
  await expect(page.locator(part.dockingGuides)).toBeHidden()
  expect((await pane(page, 'explorer').boundingBox()).x).toBeGreaterThan(editor.x)
  console.log('Popout checks: a tab dragged past the edge pops out, and a popout tab dropped on the main window docks there.')

  // 5. Closing its window docks a panel back, and its menu's Move Back does too.
  let messages = await popsOut(() => movePane(page, 'results', 'window'))
  await messages.close()
  await expect(pane(page, 'results')).toBeVisible()
  await expect.poll(windowCount).toBe(1)
  messages = await popsOut(() => movePane(page, 'results', 'window'))
  await movePane(messages, 'results', 'main')
  await expect(pane(page, 'results')).toBeVisible()
  await expect.poll(windowCount).toBe(1)
  console.log('Popout checks: closing a popout and its panel\'s Move Back dock the panel in the main window.')

  // 6. A popout survives a restart: the layout keeps its window, and the next launch opens it again.
  await popsOut(() => movePane(page, 'explorer', 'window'))
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
  const remembered = JSON.parse(await readFile(resolve(profile, 'workspace-layouts.json'), 'utf8'))
  expect(remembered.version).toBe(3)
  expect(remembered.current.windows.map(item => item.panes)).toEqual([['explorer']])
  expect(remembered.current.panels.explorer).toBeUndefined()
  application = await electron.launch(launchOptions)
  await ready()
  await expect.poll(() => application.windows().length).toBe(2)
  const back = application.windows().find(other => other !== page)
  await expect(popoutTabs(back)).toBeVisible()
  await expect(pane(back, 'explorer')).toBeVisible()
  await expect(pane(page, 'explorer')).toHaveCount(0)
  // Closing the main window closes its popouts.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
  expect(failures).toEqual([])
  console.log('Popout checks passed: menu and drag out, keys, copy, context menu, palette and theme in the popout, button, drop, close and menu back, and restart.')
} catch (error) {
  if (page) await page.screenshot({ path: resolve('artifacts', 'popout-failure.png') }).catch(() => {})
  throw error
} finally { clearTimeout(watchdog); await application.close().catch(() => {}); await rm(profile, { recursive: true, force: true }) }
