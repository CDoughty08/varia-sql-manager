import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  backendReady, closePaneButton, dockEmpty, editorText, emptyState, emptyStateDetail, emptyStateIcon, emptyStateTitle, layoutError, movePane, outputPaneIds, pane as paneOf, paneMenuButton, paneTab,
  part, primaryAction
} from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'layout-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const preferencesPath = resolve(profile, 'workspace-layouts.json')
const preferences = async () => JSON.parse(await readFile(preferencesPath, 'utf8'))
// Preferences a version 1 Varia wrote: Object Explorer at the right, the editor over its one Query output panel, and a saved
// layout. Version 2 reads Query output as Results, Messages and Execution plan, tabbed where it was.
const legacyPanel = (id, title, minimumWidth = 200, minimumHeight = 100) => ({ id, title, contentComponent: 'workbench', tabComponent: 'props.defaultTabComponent', renderer: 'always', minimumWidth, minimumHeight })
const legacyLayout = {
  grid: { width: 1200, height: 700, orientation: 'HORIZONTAL', root: { type: 'branch', size: 700, data: [
    { type: 'branch', size: 900, data: [{ type: 'leaf', size: 450, data: { id: '1', views: ['editor'], activeView: 'editor' } }, { type: 'leaf', size: 250, data: { id: '2', views: ['output'], activeView: 'output' } }] },
    { type: 'leaf', size: 300, data: { id: '3', views: ['explorer'], activeView: 'explorer' } }
  ] } },
  panels: { editor: legacyPanel('editor', 'Query editor', 320, 180), output: legacyPanel('output', 'Query output'), explorer: legacyPanel('explorer', 'Object Explorer') }, activeGroup: '1'
}
await writeFile(preferencesPath, JSON.stringify({ version: 1, current: legacyLayout, saved: [{ id: randomUUID(), name: 'Legacy', layout: legacyLayout }] }))
let application = await electron.launch(launchOptions)
let page
const watchdog = setTimeout(() => { console.error('Layout test exceeded its time limit.'); application.process().kill(); process.exitCode = 1 }, 360000)
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
  await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toHaveCount(1, { timeout: 30000 })
  if (editorVisible) await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  else await expect(page.locator('.monaco-editor')).toBeHidden()
  await expect(layoutError(page)).toHaveCount(0)
  await dialogs()
}
const pane = id => paneOf(page, id)
async function text() { return editorText(page) }
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
  // Dockview starts the drag on the first move and measures from there: a 1 px nudge keeps the whole distance.
  await page.mouse.move(x + 1, y)
  await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up()
}
async function manage() { await menu('layout.load'); await expect(page.getByRole('dialog', { name: 'Workspace layouts' })).toBeVisible() }
async function done() { await page.getByRole('button', { name: 'Done', exact: true }).click() }
async function menu(id) { await application.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), id) }
async function windowPane(id) { await menu('window.' + id) }
const x = async id => (await pane(id).boundingBox()).x
/** Drags a locator from near its left end, which stays in the window while the rest of it hangs past the edge. */
/** Moves a floating group by its titlebar, holding Ctrl so the move never ends on a docking guide (small windows put one
 * under almost every point). */
async function dragStart(locator, dx, dy) {
  const box = await locator.boundingBox()
  const x = box.x + 20, y = box.y + box.height / 2
  await page.mouse.move(x, y); await page.keyboard.down('Control'); await page.mouse.down()
  // Dockview starts the drag on the first move and measures from there: a 1 px nudge keeps the whole distance.
  await page.mouse.move(x + 1, y)
  await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Control')
}
async function aimGuide(source, destination, position, scope = 'panel') {
  // Dockview finishes laying out a moved or redocked panel over the next frames; the drag starts where its tab ends up.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const headerBox = await source.boundingBox(), target = await pane(destination).boundingBox()
  await page.mouse.move(headerBox.x + 20, headerBox.y + headerBox.height / 2); await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2 + 95, target.y + target.height / 2, { steps: 5 })
  await expect(page.locator(part.dockingGuides)).toBeVisible()
  await expect(page.locator(part.dockingGuideCell)).toHaveCount(9)
  const guide = await page.locator(`[data-guide-position="${position}"][data-guide-scope="${scope}"]`).boundingBox()
  await page.mouse.move(guide.x + guide.width / 2, guide.y + guide.height / 2, { steps: 3 })
  await expect(page.locator(part.dockingPreview)).toBeVisible()
  await expect(page.locator(part.activeDockingGuideCell)).toHaveAttribute('data-guide-position', position)
}

try {
  await ready()
  // The version 1 layout came back as it was, its Query output now Results, Messages and Execution plan in one group.
  expect(await x('explorer')).toBeGreaterThan(await x('editor'))
  await expect(pane('results')).toBeVisible()
  const legacyOutput = await pane('results').boundingBox(), legacyEditor = await pane('editor').boundingBox()
  expect(legacyOutput.y).toBeGreaterThan(legacyEditor.y + legacyEditor.height - 2)
  await windowPane('messages')
  await expect(pane('messages')).toBeVisible()
  await expect(pane('results')).toBeHidden()
  expect(await pane('messages').boundingBox()).toEqual(legacyOutput)
  await menu('layout.reset')
  await expect.poll(async () => (await preferences()).version).toBe(2)
  expect((await preferences()).saved.map(layout => [layout.name, Object.keys(layout.layout.panels).sort()])).toEqual([['Legacy', ['editor', 'explorer', 'messages', 'plan', 'results']]])
  console.log('Layout checks: a version 1 layout and its saved layouts read Query output as Results, Messages and Execution plan.')
  await expect(page.getByRole('menuitem', { name: 'Window', exact: true })).toBeVisible()
  // A panel alone in its dock group shows no dock tab: its own header names it and holds its ⋯ menu, which moves it. The
  // output panels share a group whose toolbar tabs between them, so it shows none either.
  for (const id of ['explorer', 'editor', 'results']) {
    await expect(paneTab(page, id)).toBeHidden()
    await expect(paneMenuButton(page, id)).toBeVisible()
  }
  for (const id of ['messages', 'plan']) { await expect(paneTab(page, id)).toBeHidden(); await expect(pane(id)).toBeHidden() }
  await movePane(page, 'explorer', 'right')
  await expect.poll(async () => await x('explorer') > await x('editor')).toBe(true)
  await expect(paneTab(page, 'explorer')).toBeHidden()
  // Tabbed together, a group shows its tabs again; back with the other output panels, it hides them.
  await movePane(page, 'results', 'tab:explorer')
  await expect(paneTab(page, 'results')).toBeVisible()
  await expect(paneTab(page, 'explorer')).toBeVisible()
  await expect(pane('explorer')).toBeHidden()
  await movePane(page, 'results', 'tab:messages')
  await expect(paneTab(page, 'results')).toBeHidden()
  await expect(paneTab(page, 'explorer')).toBeHidden()
  // Each output panel docks on its own: Messages beside the editor shows with Results, and returns to their group as a tab.
  await windowPane('messages')
  await expect(pane('messages')).toBeVisible()
  await movePane(page, 'messages', 'right')
  await expect(pane('results')).toBeVisible()
  await expect(pane('messages')).toBeVisible()
  await expect.poll(async () => await x('messages') > await x('editor')).toBe(true)
  expect((await pane('messages').boundingBox()).y).toBeLessThan((await pane('results').boundingBox()).y)
  await expect(paneTab(page, 'messages')).toBeHidden()
  await movePane(page, 'messages', 'tab:results')
  await expect(pane('results')).toBeHidden()
  await expect(paneTab(page, 'messages')).toBeHidden()
  // Tab with puts an output panel back in its place among the others.
  await expect.poll(() => page.locator('.dv-groupview').filter({ has: paneTab(page, 'results') }).locator('[data-pane-tab]').evaluateAll(tabs => tabs.map(tab => tab.dataset.paneTab))).toEqual(outputPaneIds)
  await windowPane('results')
  await expect(pane('results')).toBeVisible()
  await movePane(page, 'explorer', 'left')
  await expect.poll(async () => await x('explorer') < await x('editor')).toBe(true)
  await expect(paneTab(page, 'explorer')).toBeHidden()
  console.log('Layout checks: panels alone in a group hide their tabs and move through their ⋯ menus.')
  await typeSql('SELECT 42 AS preserved;')
  const typed = await text()
  await page.evaluate(() => { globalThis.layoutEditor = document.querySelector('.monaco-editor') })
  const originalWidth = (await pane('explorer').boundingBox()).width
  const vertical = page.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled').first()
  await drag(vertical, 90, 0)
  await expect.poll(async () => (await pane('explorer').boundingBox()).width).toBeGreaterThan(originalWidth + 60)
  const resizedWidth = (await pane('explorer').boundingBox()).width
  const originalHeight = (await pane('results').boundingBox()).height
  await drag(page.locator('.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash.dv-enabled').first(), 0, -50)
  await expect.poll(async () => (await pane('results').boundingBox()).height).toBeGreaterThan(originalHeight + 30)

  await manage(); await page.getByLabel('Layout name', { exact: true }).fill('Analysis')
  const sashBox = await vertical.boundingBox()
  expect(await page.evaluate(({ x, y, backdrop }) => !!document.elementFromPoint(x, y)?.closest(backdrop), { x: sashBox.x + sashBox.width / 2, y: sashBox.y + sashBox.height / 2, backdrop: part.modalBackdrop })).toBe(true)
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Layout saved.')
  const exportedPath = resolve('artifacts', 'analysis.varia-layout.json')
  await dialogs({ savePath: exportedPath })
  await page.getByRole('button', { name: 'Export current layout…', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('exported')
  const exported = JSON.parse(await readFile(exportedPath, 'utf8'))
  expect(exported.kind).toBe('varia-workspace-layout')
  expect(JSON.stringify(exported)).not.toContain('SELECT 42')
  expect(exported.version).toBe(2)
  expect(Object.keys(exported.layout.panels).sort()).toEqual(['editor', 'explorer', 'messages', 'plan', 'results'])
  // Which tabs hide follows Window › Panel Tabs, not the layout.
  expect(JSON.stringify(exported)).not.toContain('hideHeader')
  await done()
  console.log('Layout checks: splitter resizing, named save, and export passed.')

  // Dragging a panel by its tab needs the tab: Window › Panel Tabs shows it, and stays on for the rest of the suite.
  await menu('window.togglePanelTabs')
  await expect(paneTab(page, 'explorer')).toBeVisible()
  await expect.poll(() => application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('window.togglePanelTabs').checked)).toBe(true)
  // Real pointer docking, followed by a keyboard-accessible move action.
  await aimGuide(paneTab(page, 'explorer'), 'editor', 'right')
  await page.screenshot({ path: resolve('artifacts', 'docking-guides.png') })
  await page.mouse.up()
  await expect.poll(async () => await x('explorer') > await x('editor')).toBe(true)
  await expect(page.locator(part.dockingGuides)).toBeHidden()
  console.log('Layout checks: pointer docking passed.')
  // Results floats alone; Messages and Execution plan stay docked.
  await movePane(page, 'results', 'float')
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  await expect.poll(() => page.locator('.dv-resize-container').filter({ has: paneTab(page, 'messages') }).count()).toBe(0)
  // The floating container appears before its next-frame content resize.
  await expect.poll(async () => (await pane('results').boundingBox()).width).toBeLessThan(600)
  const floatingWidth = (await pane('results').boundingBox()).width
  await drag(page.locator('.dv-resize-handle-right'), 60, 0)
  await expect.poll(async () => (await pane('results').boundingBox()).width).toBeGreaterThan(floatingWidth + 40)
  const floatingX = (await pane('results').boundingBox()).x
  await drag(page.locator('.dv-floating-titlebar'), 35, 25)
  await expect.poll(async () => (await pane('results').boundingBox()).x).toBeGreaterThan(floatingX + 20)
  // It hangs past the window's right edge, keeping a part to grab; past the top it stops, so its titlebar stays in reach.
  const windowWidth = await page.evaluate(() => window.innerWidth), titlebar = page.locator('.dv-floating-titlebar')
  await dragStart(titlebar, windowWidth, 0)
  await expect.poll(async () => { const box = await pane('results').boundingBox(); return box.x + box.width }).toBeGreaterThan(windowWidth + 40)
  const hanging = await pane('results').boundingBox()
  expect(hanging.x).toBeLessThan(windowWidth - 60)
  await dragStart(titlebar, 0, -2000)
  await expect.poll(async () => (await titlebar.boundingBox()).y - (await page.locator(part.workbench).boundingBox()).y).toBeGreaterThanOrEqual(-1)
  // Back inside, aiming its right edge at three quarters of the window, so it fits whatever the window's width (CI's
  // Windows runners show 1024 px).
  const out = await pane('results').boundingBox()
  await dragStart(titlebar, Math.round(windowWidth * 0.75 - out.x - out.width), 120)
  await expect(titlebar).toHaveCount(1)
  await expect.poll(async () => { const box = await pane('results').boundingBox(); return box.x + box.width }).toBeLessThan(windowWidth)
  await page.screenshot({ path: resolve('artifacts', 'floating-off-edge.png') })
  await aimGuide(page.locator('.dv-floating-titlebar'), 'editor', 'left')
  await page.mouse.up()
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  await expect.poll(async () => (await pane('results').boundingBox()).x - (await pane('editor').boundingBox()).x).toBeLessThan(0)
  await movePane(page, 'results', 'float')
  console.log('Layout checks: floating movement and resizing, past the window\'s edge too, passed.')

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

  await aimGuide(paneTab(page, 'explorer'), 'results', 'center')
  await page.mouse.up()
  await expect.poll(() => page.locator('.dv-groupview').filter({ has: paneTab(page, 'explorer') }).locator(paneTab(page, 'results')).count()).toBe(1)
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
  const selectionRules = await page.evaluate(part => ({
    tabs: getComputedStyle(document.querySelector(part.documentTabs + ' ' + part.tabName)).userSelect,
    heading: getComputedStyle(document.querySelector(part.explorerToolbar)).userSelect,
    status: getComputedStyle(document.querySelector(part.statusBar)).userSelect,
    editor: getComputedStyle(document.querySelector('.monaco-editor')).userSelect
  }), part)
  expect(selectionRules).toEqual({ tabs: 'none', heading: 'none', status: 'none', editor: 'text' })
  await closePaneButton(page, 'editor').click()
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
  const explorerHeader = await paneTab(page, 'explorer').boundingBox(), destination = await pane('editor').boundingBox()
  await page.mouse.move(explorerHeader.x + 20, explorerHeader.y + explorerHeader.height / 2); await page.keyboard.down('Control'); await page.mouse.down()
  await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 5 })
  await expect(page.locator(part.dockingGuides)).toBeHidden()
  await page.mouse.up(); await page.keyboard.up('Control')
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  await paneTab(page, 'explorer').dblclick({ modifiers: ['Control'] })
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  // Outer cells split the entire workspace, not just the hovered destination.
  await aimGuide(paneTab(page, 'explorer'), 'editor', 'left', 'workspace')
  await page.mouse.up()
  // Relative to the workspace rather than a pixel height: Windows shrinks the window to fit small displays (1024x768 on CI).
  await expect.poll(async () => (await page.locator(part.workbench).boundingBox()).height - (await pane('explorer').boundingBox()).height).toBeLessThan(40)
  await expect(layoutError(page)).toHaveCount(0)
  console.log('Layout checks: tab grouping, named load, and Monaco undo preservation passed.')
  await movePane(page, 'explorer', 'right')
  await movePane(page, 'results', 'float')
  await manage(); await page.getByLabel('Layout name', { exact: true }).fill('Floating analysis')
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Layout saved.')
  await done()
  await page.screenshot({ path: resolve('artifacts', 'docked-workspace.png') })
  await application.close()
  const remembered = await preferences()
  expect(remembered.current.floatingGroups).toHaveLength(1)
  expect(remembered.version).toBe(2)
  expect(remembered.saved.map(layout => layout.name)).toEqual(['Legacy', 'Analysis', 'Floating analysis'])
  expect(JSON.stringify(remembered)).not.toContain('SELECT 42')
  console.log('Layout checks: normal exit flushed current and named layouts.')

  application = await electron.launch(launchOptions)
  await ready()
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(1)
  expect((await pane('explorer').boundingBox()).x).toBeGreaterThan((await pane('editor').boundingBox()).x)
  await manage()
  expect(await page.getByLabel('Saved layouts', { exact: true }).locator('option').allTextContents()).toEqual(['Choose a layout', 'Legacy', 'Analysis', 'Floating analysis'])
  await page.getByRole('button', { name: 'Reset default layout', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Default layout restored.')
  await done()
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  expect((await pane('explorer').boundingBox()).x).toBeLessThan((await pane('editor').boundingBox()).x)
  await expect(layoutError(page)).toHaveCount(0)
  // Dock Left beside a floating panel docks in the window's grid, not in the floating window; a floating panel's ⋯ menu
  // offers Dock in place of Float, and docks it.
  // Panel content renders in an overlay above its group, so a floating window is known by the dock tab it holds.
  const floating = id => page.locator('.dv-resize-container').filter({ has: paneTab(page, id) }).count()
  await movePane(page, 'explorer', 'float')
  await expect.poll(() => floating('explorer')).toBe(1)
  await movePane(page, 'editor', 'left')
  await expect.poll(async () => [await floating('editor'), await floating('explorer')]).toEqual([0, 1])
  await expect(pane('editor')).toBeVisible()
  await expect.poll(async () => await x('editor') < await x('results')).toBe(true)
  await paneMenuButton(page, 'explorer').click()
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Float', exact: true })).toHaveCount(0)
  await page.getByRole('menu').getByRole('menuitem', { name: 'Dock', exact: true }).click()
  await expect.poll(() => floating('explorer')).toBe(0)
  await expect(page.locator('.dv-floating-titlebar')).toHaveCount(0)
  await manage()
  await page.getByRole('button', { name: 'Reset default layout', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Default layout restored.')
  await done()
  console.log('Layout checks: Dock at a side never lands in a floating window, and a floating panel docks through its ⋯ menu.')
  // Closing every panel is a valid, persisted layout; Window can recover each one.
  for (const id of ['explorer', ...outputPaneIds, 'editor']) {
    await closePaneButton(page, id).click()
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
  // The closed-panels view is the states kit's empty state: a glyph, the title, a line, and an outlined (not filled) action.
  const closedPanels = emptyState(dockEmpty(page))
  await expect(emptyStateIcon(closedPanels)).toHaveAttribute('data-icon', 'layout')
  await expect(emptyStateTitle(closedPanels)).toHaveText('All panels are closed.')
  await expect(emptyStateDetail(closedPanels)).toHaveText('Open a panel from the Window menu.')
  await expect(closedPanels.getByRole('button', { name: 'Open Query editor', exact: true })).toBeVisible()
  await expect(primaryAction(closedPanels)).toHaveCount(0)
  await expect(closedPanels).toHaveCSS('justify-content', 'center')
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
  await expect(layoutError(page)).toHaveCount(0)
  for (const id of ['explorer', 'editor', ...outputPaneIds]) { await windowPane(id); await expect(pane(id)).toBeVisible() }
  // Reopened with nowhere to return to, the output panels share one group again, in their order.
  await expect.poll(() => page.locator('.dv-groupview').filter({ has: paneTab(page, 'results') }).locator('[data-pane-tab]').evaluateAll(tabs => tabs.map(tab => tab.dataset.paneTab))).toEqual(outputPaneIds)
  await expect(layoutError(page)).toHaveCount(0)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 700))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
  await expect.poll(async () => Math.round((await pane('explorer').boundingBox()).width + (await pane('editor').boundingBox()).width)).toBe(1024)
  const compactWidth = (await pane('explorer').boundingBox()).width
  await drag(page.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled').first(), 50, 0)
  await expect.poll(async () => (await pane('explorer').boundingBox()).width).toBeGreaterThan(compactWidth + 30)
  await expect.poll(() => page.locator(part.explorerPane).evaluate(element => element.clientWidth === element.parentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: resolve('artifacts', 'default-dock-layout.png') })
  console.log('Layout checks passed: splitters, nine-cell docking guides and previews, local/whole-workspace splits, tab drops, plain floating-titlebar redocking, Ctrl-drag and Ctrl-double-click, close/reopen without losing Monaco undo, named layouts, file round trips and invalid import recovery, closed-panel and empty-workspace restart persistence, Window recovery, selection rules, and reset.')
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve('artifacts', 'layout-failure.png') }).catch(() => {})
    console.log(await page.locator('[role="alert"]').allTextContents().catch(() => []))
  }
  throw error
} finally { clearTimeout(watchdog); await dialogs().catch(() => {}); await application.close().catch(() => {}); await rm(profile, { recursive: true, force: true }) }
