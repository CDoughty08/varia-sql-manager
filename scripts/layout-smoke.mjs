import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'layout-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
let application = await electron.launch(launchOptions)
let page
const watchdog = setTimeout(() => { console.error('Layout test exceeded its time limit.'); application.process().kill(); process.exitCode = 1 }, 360000)
const preferencesPath = resolve(profile, 'workspace-layouts.json')
const preferences = async () => JSON.parse(await readFile(preferencesPath, 'utf8'))
async function dialogs(settings = {}) {
  await application.evaluate(({ dialog }, values) => {
    globalThis.layoutDialogs = { ...globalThis.layoutDialogs, ...values }
    dialog.showSaveDialog = async () => ({ canceled: !globalThis.layoutDialogs.savePath, filePath: globalThis.layoutDialogs.savePath })
    dialog.showOpenDialog = async () => ({ canceled: !globalThis.layoutDialogs.openPath, filePaths: globalThis.layoutDialogs.openPath ? [globalThis.layoutDialogs.openPath] : [] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }, settings)
}
async function ready(editorVisible = true) {
  page = await application.firstWindow()
  await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toHaveCount(1, { timeout: 30000 })
  if (editorVisible) await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  else await expect(page.locator('.monaco-editor')).toBeHidden()
  await expect(page.locator('.layout-error')).toHaveCount(0)
  await dialogs()
}
const pane = id => page.locator('[data-pane="' + id + '"]')
async function text() { return page.locator('.monaco-editor .view-lines').innerText() }
async function typeSql(sql) {
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+A'); await page.keyboard.insertText(sql)
  await expect.poll(text).toContain(sql.replaceAll(' ', '\u00a0'))
}
async function drag(locator, dx, dy) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up()
}
async function manage() { await page.getByRole('button', { name: 'Layouts', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Workspace layouts' })).toBeVisible() }
async function done() { await page.getByRole('button', { name: 'Done', exact: true }).click() }
async function windowPane(id) { await application.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById('window.' + id).click(), id) }
async function aimGuide(source, destination, position, scope = 'panel') {
  const headerBox = await source.boundingBox(), target = await pane(destination).boundingBox()
  await page.mouse.move(headerBox.x + 20, headerBox.y + headerBox.height / 2); await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2 + 95, target.y + target.height / 2, { steps: 5 })
  await expect(page.locator('.docking-guides')).toBeVisible()
  await expect(page.locator('.docking-guide-cell')).toHaveCount(9)
  const guide = await page.locator(`[data-guide-position="${position}"][data-guide-scope="${scope}"]`).boundingBox()
  await page.mouse.move(guide.x + guide.width / 2, guide.y + guide.height / 2, { steps: 3 })
  await expect(page.locator('.docking-preview')).toBeVisible()
  await expect(page.locator('.docking-guide-cell.active')).toHaveAttribute('data-guide-position', position)
}

try {
  await ready()
  await expect(page.getByRole('menuitem', { name: 'Window', exact: true })).toBeVisible()
  await typeSql('SELECT 42 AS preserved;')
  const typed = await text()
  await page.evaluate(() => { globalThis.layoutEditor = document.querySelector('.monaco-editor') })
  const originalWidth = (await pane('explorer').boundingBox()).width
  const vertical = page.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled').first()
  await drag(vertical, 90, 0)
  await expect.poll(async () => (await pane('explorer').boundingBox()).width).toBeGreaterThan(originalWidth + 60)
  const resizedWidth = (await pane('explorer').boundingBox()).width
  const originalHeight = (await pane('output').boundingBox()).height
  await drag(page.locator('.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash.dv-enabled').first(), 0, -50)
  await expect.poll(async () => (await pane('output').boundingBox()).height).toBeGreaterThan(originalHeight + 30)

  await manage(); await page.getByLabel('Layout name', { exact: true }).fill('Analysis')
  const sashBox = await vertical.boundingBox()
  expect(await page.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest('.modal-backdrop'), { x: sashBox.x + sashBox.width / 2, y: sashBox.y + sashBox.height / 2 })).toBe(true)
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Layout saved.')
  const exportedPath = resolve('artifacts', 'analysis.varia-layout.json')
  await dialogs({ savePath: exportedPath })
  await page.getByRole('button', { name: 'Export current layout…', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('exported')
  const exported = JSON.parse(await readFile(exportedPath, 'utf8'))
  expect(exported.kind).toBe('varia-workspace-layout')
  expect(JSON.stringify(exported)).not.toContain('SELECT 42')
  expect(Object.keys(exported.layout.panels).sort()).toEqual(['editor', 'explorer', 'output'])
  await done()
  console.log('Layout checks: splitter resizing, named save, and export passed.')

  // Real pointer docking, followed by a keyboard-accessible move action.
  await aimGuide(page.locator('[data-pane-tab="explorer"]'), 'editor', 'right')
  await page.screenshot({ path: resolve('artifacts', 'docking-guides.png') })
  await page.mouse.up()
  await expect.poll(async () => (await pane('explorer').boundingBox()).x).toBeGreaterThan((await pane('editor').boundingBox()).x)
  await expect(page.locator('.docking-guides')).toBeHidden()
  console.log('Layout checks: pointer docking passed.')
  await page.getByLabel('Move Query output', { exact: true }).selectOption('float')
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  // The floating container appears before its next-frame content resize.
  await expect.poll(async () => (await pane('output').boundingBox()).width).toBeLessThan(600)
  const floatingWidth = (await pane('output').boundingBox()).width
  await drag(page.locator('.dv-resize-handle-right'), 60, 0)
  await expect.poll(async () => (await pane('output').boundingBox()).width).toBeGreaterThan(floatingWidth + 40)
  const floatingX = (await pane('output').boundingBox()).x
  await drag(page.locator('.dv-floating-titlebar'), 35, 25)
  await expect.poll(async () => (await pane('output').boundingBox()).x).toBeGreaterThan(floatingX + 20)
  await aimGuide(page.locator('.dv-floating-titlebar'), 'editor', 'left')
  await page.mouse.up()
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  await expect.poll(async () => (await pane('output').boundingBox()).x - (await pane('editor').boundingBox()).x).toBeLessThan(0)
  await page.getByLabel('Move Query output', { exact: true }).selectOption('float')
  console.log('Layout checks: floating movement and resizing passed.')

  await manage()
  const malformedPath = resolve('artifacts', 'invalid.varia-layout.json')
  await writeFile(malformedPath, JSON.stringify({ ...exported, layout: { ...exported.layout, popoutGroups: [{ url: 'https://example.com' }] } }))
  await dialogs({ openPath: malformedPath })
  await page.getByRole('button', { name: 'Import layout…', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Invalid or unsupported')
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  await dialogs({ openPath: exportedPath })
  await page.getByRole('button', { name: 'Import layout…', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('imported')
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  await expect.poll(async () => (await pane('explorer').boundingBox()).width).toBeCloseTo(resizedWidth, 0)
  await done()
  console.log('Layout checks: import and invalid-file recovery passed.')

  await aimGuide(page.locator('[data-pane-tab="explorer"]'), 'output', 'center')
  await page.mouse.up()
  await expect.poll(() => page.locator('.dv-groupview').filter({ has: page.locator('[data-pane-tab="explorer"]') }).locator('[data-pane-tab="output"]').count()).toBe(1)
  await manage()
  await page.getByLabel('Saved layouts', { exact: true }).selectOption({ label: 'Analysis' })
  await page.getByRole('button', { name: 'Load layout', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Layout loaded.')
  await done()
  await expect(pane('explorer')).toBeVisible()
  expect(await page.evaluate(() => globalThis.layoutEditor === document.querySelector('.monaco-editor'))).toBe(true)
  expect(await text()).toBe(typed)
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('edit.undo').click())
  await expect.poll(text).not.toBe(typed)
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('edit.redo').click())
  await expect.poll(text).toBe(typed)
  const selectionRules = await page.evaluate(() => ({
    tabs: getComputedStyle(document.querySelector('.tab-name')).userSelect,
    heading: getComputedStyle(document.querySelector('.panel-heading')).userSelect,
    status: getComputedStyle(document.querySelector('.status-bar')).userSelect,
    editor: getComputedStyle(document.querySelector('.monaco-editor')).userSelect
  }))
  expect(selectionRules).toEqual({ tabs: 'none', heading: 'none', status: 'none', editor: 'text' })
  await page.getByRole('button', { name: 'Close Query editor', exact: true }).click()
  await expect(pane('editor')).toBeHidden()
  await windowPane('editor')
  await expect(pane('editor')).toBeVisible()
  expect(await page.evaluate(() => globalThis.layoutEditor === document.querySelector('.monaco-editor'))).toBe(true)
  expect(await text()).toBe(typed)
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('edit.undo').click())
  await expect.poll(text).not.toBe(typed)
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('edit.redo').click())
  await expect.poll(text).toBe(typed)
  // Ctrl-drag floats even when passing over a docking target.
  const explorerHeader = await page.locator('[data-pane-tab="explorer"]').boundingBox(), destination = await pane('editor').boundingBox()
  await page.mouse.move(explorerHeader.x + 20, explorerHeader.y + explorerHeader.height / 2); await page.keyboard.down('Control'); await page.mouse.down()
  await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 5 })
  await expect(page.locator('.docking-guides')).toBeHidden()
  await page.mouse.up(); await page.keyboard.up('Control')
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  await page.locator('[data-pane-tab="explorer"]').dblclick({ modifiers: ['Control'] })
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  // Outer cells split the entire workspace, not just the hovered destination.
  await aimGuide(page.locator('[data-pane-tab="explorer"]'), 'editor', 'left', 'workspace')
  await page.mouse.up()
  // Relative to the workspace rather than a pixel height: Windows shrinks the window to fit small displays (1024x768 on CI).
  await expect.poll(async () => (await page.locator('.workbench').boundingBox()).height - (await pane('explorer').boundingBox()).height).toBeLessThan(40)
  await expect(page.locator('.layout-error')).toHaveCount(0)
  console.log('Layout checks: tab grouping, named load, and Monaco undo preservation passed.')
  await page.getByLabel('Move Object Explorer', { exact: true }).selectOption('right')
  await page.getByLabel('Move Query output', { exact: true }).selectOption('float')
  await manage(); await page.getByLabel('Layout name', { exact: true }).fill('Floating analysis')
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Layout saved.')
  await done()
  await page.screenshot({ path: resolve('artifacts', 'docked-workspace.png') })
  await application.close()
  const remembered = await preferences()
  expect(remembered.current.floatingGroups).toHaveLength(1)
  expect(remembered.saved.map(layout => layout.name)).toEqual(['Analysis', 'Floating analysis'])
  expect(JSON.stringify(remembered)).not.toContain('SELECT 42')
  console.log('Layout checks: normal exit flushed current and named layouts.')

  application = await electron.launch(launchOptions)
  await ready()
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  expect((await pane('explorer').boundingBox()).x).toBeGreaterThan((await pane('editor').boundingBox()).x)
  await manage()
  expect(await page.getByLabel('Saved layouts', { exact: true }).locator('option').allTextContents()).toEqual(['Choose a layout', 'Analysis', 'Floating analysis'])
  await page.getByRole('button', { name: 'Reset default layout', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Default layout restored.')
  await done()
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  expect((await pane('explorer').boundingBox()).x).toBeLessThan((await pane('editor').boundingBox()).x)
  await expect(page.locator('.layout-error')).toHaveCount(0)
  // Closing every panel is a valid, persisted layout; Window can recover each one.
  for (const id of ['explorer', 'output', 'editor']) {
    await page.getByRole('button', { name: 'Close ' + ({ explorer: 'Object Explorer', editor: 'Query editor', output: 'Query output' })[id], exact: true }).click()
    await expect(pane(id)).toBeHidden()
  }
  await manage(); await page.getByLabel('Layout name', { exact: true }).fill('Closed panels')
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Layout saved.')
  await done(); await application.close()
  expect((await preferences()).current.panels).toEqual({})
  application = await electron.launch(launchOptions)
  await ready(false)
  await expect(page.getByText('All panels are closed.', { exact: true })).toBeVisible()
  // The saved layout loads after the window shows, and opening the file can take seconds on Windows. Main's read of it
  // is held here across a reload: the workspace shows nothing rather than "All panels are closed", and a Window choice
  // made meanwhile applies once the layout has loaded instead of being dropped.
  await application.evaluate(({ ipcMain }) => {
    const fs = process.getBuiltinModule('node:fs/promises'), { syncBuiltinESMExports } = process.getBuiltinModule('node:module'), open = fs.open
    let release
    const gate = new Promise(resolve => { release = resolve })
    const state = globalThis.variaLayoutRead = { held: false, commandsReady: false, release: () => { fs.open = open; syncBuiltinESMExports(); release() } }
    ipcMain.on('varia:commands-ready', (_event, value) => { state.commandsReady = value === true })
    fs.open = async (path, ...rest) => {
      if (String(path).endsWith('workspace-layouts.json')) { state.held = true; await gate }
      return open(path, ...rest)
    }
    // The bundled main imports fs/promises by name; this points its bindings at the wrapper.
    syncBuiltinESMExports()
  })
  await page.reload()
  await expect.poll(() => application.evaluate(() => [globalThis.variaLayoutRead.held, globalThis.variaLayoutRead.commandsReady])).toEqual([true, true])
  await expect(page.getByText('All panels are closed.', { exact: true })).toHaveCount(0)
  await windowPane('explorer')
  await expect(pane('explorer')).toBeHidden()
  await application.evaluate(() => globalThis.variaLayoutRead.release())
  await expect(pane('explorer')).toBeVisible()
  await expect(page.locator('.layout-error')).toHaveCount(0)
  for (const id of ['explorer', 'editor', 'output']) { await windowPane(id); await expect(pane(id)).toBeVisible() }
  await expect(page.locator('.layout-error')).toHaveCount(0)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 700))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
  await expect.poll(async () => Math.round((await pane('explorer').boundingBox()).width + (await pane('editor').boundingBox()).width)).toBe(1024)
  const compactWidth = (await pane('explorer').boundingBox()).width
  await drag(page.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled').first(), 50, 0)
  await expect.poll(async () => (await pane('explorer').boundingBox()).width).toBeGreaterThan(compactWidth + 30)
  await expect.poll(() => page.locator('.explorer').evaluate(element => element.clientWidth === element.parentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: resolve('artifacts', 'default-dock-layout.png') })
  console.log('Layout checks passed: splitters, nine-cell docking guides and previews, local/whole-workspace splits, tab drops, plain floating-titlebar redocking, Ctrl-drag and Ctrl-double-click, close/reopen without losing Monaco undo, named layouts, file round trips and invalid import recovery, closed-panel and empty-workspace restart persistence, Window recovery, selection rules, and reset.')
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve('artifacts', 'layout-failure.png') }).catch(() => {})
    console.log(await page.locator('[role="alert"]').allTextContents().catch(() => []))
  }
  throw error
} finally { clearTimeout(watchdog); await dialogs().catch(() => {}); await application.close().catch(() => {}); await rm(profile, { recursive: true, force: true }) }
