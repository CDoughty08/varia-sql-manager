import { electron, expect } from './fixtures/smoke.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { activeDocumentName, backendReady, closeDocumentButton, documentTab, documentTabs, editorGroups, editorGroupTabs, floatingEditorGroups, menubar, part, pinDocumentButton, planCanvas, planViewer, quickInput, quickInputActive, selectOpenDocument, tabNameBox, tabShelf, tabShelfControls, tabShelfRows, unsavedMark } from './fixtures/ui.mjs'

// SSMS's editing commands in the real query editor, over the fake backend (no SQL Server): Comment and Uncomment
// Selection, Make Uppercase and Lowercase, Increase and Decrease Line Indent from Edit › Advanced, Go To Line, Bookmarks
// across queries, Insert Snippet and Surround With, View White Space and Word Wrap kept across a relaunch, Quick Find in a
// selection with F3 and its search text from the caret, and Ctrl+K's chord timeout. Windows and Linux; macOS's menus and keys are checked by hand.
if (process.platform === 'darwin') {
  console.log('Editor suite skipped on macOS.')
  process.exit(0)
}
await mkdir('artifacts', { recursive: true })
const control = await mkdtemp(resolve('artifacts', 'editor-backend-'))
const profile = await mkdtemp(resolve('artifacts', 'editor-profile-'))
let application, page
const failures = []
const watchdog = setTimeout(() => { console.error('Editor suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 300000)

async function launch() {
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
  delete env.ELECTRON_RUN_AS_NODE
  // Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it.
  application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
}
// Unsaved queries make a normal exit ask first; answer Don't Save.
async function close() {
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
}
const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const menu = name => page.getByRole('menu', { name, exact: true })
const nbsp = String.fromCharCode(160)
/** The visible lines in line order (Monaco reuses line elements, so DOM order is not line order); tabs render as spaces. */
const editorText = () => page.locator('.monaco-editor .view-lines').evaluate(lines => [...lines.querySelectorAll('.view-line')]
  .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map(line => line.textContent).join('\n')).then(text => text.replaceAll(nbsp, ' ').replaceAll('·', ' ').replaceAll('→', ' '))
/** Replaces the whole query with `text`, leaving the caret at its end. */
async function setText(text) {
  await textbox().focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
}
const chord = async second => { await page.keyboard.press('Control+K'); await page.keyboard.press(`Control+${second}`) }
/** Edit › Advanced › <access key>, from the keyboard as SSMS users do. */
async function advanced(key) {
  await page.keyboard.press('Alt+e')
  await expect(menu('Edit')).toBeVisible()
  await page.keyboard.press('v')
  await expect(menu('Advanced')).toBeVisible()
  await page.keyboard.press(key)
  await expect(menu('Edit')).toHaveCount(0)
}
const advancedItem = async name => {
  await page.keyboard.press('Alt+e')
  await page.keyboard.press('v')
  return menu('Advanced').getByRole('menuitemcheckbox', { name, exact: true })
}
const closeMenus = async () => { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0) }
const glyphs = () => page.locator('.monaco-editor ' + part.bookmarkGlyph)
/** How many view lines Monaco draws: one per line, or more for a line that word wrap breaks. */
const viewLines = () => page.locator('.monaco-editor .view-lines .view-line').count()

try {
  await launch()

  // 1. Comment Selection writes -- with no space, as SSMS does; Uncomment Selection restores the text.
  await setText('select a\nselect b\nselect c')
  await page.keyboard.press('Control+A')
  await chord('C')
  await expect.poll(editorText).toBe('--select a\n--select b\n--select c')
  await chord('U')
  await expect.poll(editorText).toBe('select a\nselect b\nselect c')
  console.log('Editor checks: Ctrl+K Ctrl+C comments every line with --, no space, and Ctrl+K Ctrl+U uncomments them.')

  // 2. Make Uppercase and Make Lowercase change the selection.
  await setText('select 1')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Control+Shift+U')
  await expect.poll(editorText).toBe('SELECT 1')
  await page.keyboard.press('Control+Shift+L')
  await expect.poll(editorText).toBe('select 1')
  console.log('Editor checks: Ctrl+Shift+U and Ctrl+Shift+L change the selection\'s case.')

  // 3. Edit › Advanced › Increase Line Indent inserts a tab under Keep tabs (SSMS's default): an x typed at column 1
  // leaves the tab filling to column 5. Decrease Line Indent removes it.
  await setText('select 1')
  await advanced('i')
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('Home')
  await page.keyboard.insertText('x')
  await expect.poll(editorText).toBe('x   select 1')
  await page.keyboard.press('Backspace')
  await advanced('d')
  await expect.poll(editorText).toBe('select 1')
  console.log('Editor checks: Edit › Advanced › Increase and Decrease Line Indent add and remove a tab.')

  // 4. Go To Line (Ctrl+G): SSMS's dialog, the line range in its label; OK puts the caret at the start of the line, and
  // Escape on a reopened dialog returns focus to the editor.
  await setText('one\ntwo\nthree')
  await page.keyboard.press('Control+G')
  const goTo = page.getByRole('dialog', { name: 'Go To Line', exact: true })
  await expect(goTo).toBeVisible()
  await expect(goTo.getByLabel('Line number (1 - 3):', { exact: true })).toHaveValue('3')
  await page.keyboard.type('4')
  await expect(goTo.getByRole('button', { name: 'OK', exact: true })).toBeDisabled()
  await expect(goTo.getByText('Enter a number from 1 to 3.', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('3')
  await page.keyboard.press('Enter')
  await expect(goTo).toHaveCount(0)
  await page.keyboard.insertText('X')
  await expect.poll(editorText).toBe('one\ntwo\nXthree')
  await page.keyboard.press('Control+G')
  await expect(goTo).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(goTo).toHaveCount(0)
  await expect(textbox()).toBeFocused()
  console.log('Editor checks: Ctrl+G goes to a line; the dialog refuses one past the end, and Escape returns to the editor.')

  // 5. Bookmarks: Ctrl+K Ctrl+K on lines 1 and 3 shows two glyphs; Ctrl+K Ctrl+N goes to the next, wrapping around, then
  // on to another query's; Ctrl+K Ctrl+L clears them all, and Next Bookmark is then disabled.
  await setText('one\ntwo\nthree')
  await page.keyboard.press('Control+Home')
  await chord('K')
  await page.keyboard.press('Control+End')
  await chord('K')
  await expect(glyphs()).toHaveCount(2)
  await page.keyboard.press('ArrowUp')
  await chord('N')
  await page.keyboard.insertText('N')
  await expect.poll(editorText).toBe('one\ntwo\nNthree')
  await chord('N')
  await page.keyboard.insertText('W')
  await expect.poll(editorText).toBe('Wone\ntwo\nNthree')
  const firstTab = await activeDocumentName(page)
  await page.keyboard.press('Control+N')
  await expect.poll(() => activeDocumentName(page)).not.toBe(firstTab)
  const secondTab = await activeDocumentName(page)
  await textbox().focus()
  await page.keyboard.insertText('second')
  await chord('K')
  await expect(glyphs()).toHaveCount(1)
  await page.keyboard.press('Control+Tab')
  await expect.poll(() => activeDocumentName(page)).toBe(firstTab)
  // The caret is on line 1 after W; the next bookmarks are line 3, then the second query's line 1.
  await textbox().focus()
  await chord('N')
  await page.keyboard.insertText('3')
  await expect.poll(editorText).toBe('Wone\ntwo\n3Nthree')
  await chord('N')
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  await chord('L')
  await expect(glyphs()).toHaveCount(0)
  // Query tabs reorder: Ctrl+Shift+PageUp moves the active tab left and keeps it shown, Ctrl+Tab follows the new order,
  // and dragging a tab onto the left part of another drops it before that one, showing it with its text as it was.
  const order = () => documentTabs(page).getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))
  const pair = async () => (await order()).filter(name => name === firstTab || name === secondTab)
  const groupNames = index => editorGroupTabs(editorGroups(page).nth(index)).evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))
  expect(await pair()).toEqual([firstTab, secondTab])
  await textbox().focus()
  await page.keyboard.press('Control+Shift+PageUp')
  await expect.poll(pair).toEqual([secondTab, firstTab])
  expect(await activeDocumentName(page)).toBe(secondTab)
  const releaseTab = async () => {
    // Input can arrive before the deferred cleanup, while Dockview still needs the resolver to commit its drop.
    await page.evaluate(() => document.addEventListener('pointerup', event => {
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, buttons: 0 }))
      document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Control' }))
    }, { capture: true, once: true }))
    await page.mouse.up()
    await expect(page.locator(part.dockingGuides).filter({ visible: true })).toHaveCount(0)
    await expect(page.locator(part.dockingPreview).filter({ visible: true })).toHaveCount(0)
    await expect(page.locator('.dv-drop-target-dropzone').filter({ visible: true })).toHaveCount(0)
  }
  /** Drags with the pointer (Dockview's pointer strategy), in steps so its drag starts and its targets follow. */
  const drag = async (from, to) => {
    const start = await from.boundingBox(), x = start.x + start.width / 2, y = start.y + start.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let step = 1; step <= 10; step++) await page.mouse.move(x + (to.x - x) * step / 10, y + (to.y - y) * step / 10)
    await releaseTab()
  }
  const targetBox = await documentTab(page, secondTab).boundingBox()
  await drag(documentTab(page, firstTab), { x: targetBox.x + 4, y: targetBox.y + targetBox.height / 2 })
  await expect.poll(pair).toEqual([firstTab, secondTab])
  expect(await editorGroups(page).count()).toBe(1)
  await expect.poll(() => activeDocumentName(page)).toBe(firstTab)
  expect(await editorText()).toBe('Wone\ntwo\n3Nthree')
  // The last tab has nowhere further right to go.
  await selectOpenDocument(page, secondTab)
  await textbox().focus()
  await page.keyboard.press('Control+Shift+PageDown')
  await expect.poll(pair).toEqual([firstTab, secondTab])
  // On a shelf too full to show every tab, the tab Ctrl+Shift+PageUp moves stays in view as it goes.
  for (let opened = 0; opened < 12; opened++) await page.keyboard.press('Control+N')
  const moving = await activeDocumentName(page)
  await expect.poll(async () => (await order()).length).toBeGreaterThanOrEqual(14)
  await expect(documentTabs(page).getByRole('button', { name: /^Show [1-9]\d* more query tabs?$/ })).toBeEnabled()
  await textbox().focus()
  for (let step = 0; step < 14; step++) await page.keyboard.press('Control+Shift+PageUp')
  await expect.poll(async () => (await order())[0]).toBe(moving)
  const shown = () => documentTab(page, moving).evaluate(tab => { const box = tab.getBoundingClientRect(), view = tab.closest('[role="tablist"]').getBoundingClientRect(); return box.left >= view.left - 1 && box.right <= view.right + 1 })
  await expect.poll(shown).toBe(true)
  // A pinned tab moves into its group's upper shelf, an unpinned one cannot move before it, and unpinning leaves it
  // first among the unpinned. The overflow list reaches a tab whose native element is outside the shown rows.
  const last = (await order()).at(-1)
  await selectOpenDocument(page, last)
  await pinDocumentButton(page, last).click()
  await expect.poll(async () => (await order())[0]).toBe(last)
  await expect(documentTab(page, last)).toBeFocused()
  await expect(pinDocumentButton(page, last, true)).toBeVisible()
  await selectOpenDocument(page, moving)
  await textbox().focus()
  await page.keyboard.press('Control+Shift+PageUp')
  await expect.poll(async () => (await order()).slice(0, 2)).toEqual([last, moving])
  await pinDocumentButton(page, last, true).click()
  await expect(pinDocumentButton(page, last)).toBeVisible()
  expect((await order())[0]).toBe(last)

  const shelfGroup = editorGroups(page).first()
  const rowCounts = async group => Promise.all([tabShelfRows(group, true).innerText(), tabShelfRows(group).innerText()])
  const wheelShelf = async (group, pinned, delta) => {
    const box = await tabShelf(group, pinned).boundingBox()
    await page.mouse.move(box.x + 24, box.y + Math.min(12, box.height / 2))
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, delta)
    await page.keyboard.up('Control')
  }
  const pins = (await order()).filter(name => name !== firstTab && name !== secondTab).slice(0, 5)
  for (const name of pins) {
    await selectOpenDocument(page, name)
    await pinDocumentButton(page, name).click()
    await expect(documentTab(page, name)).toHaveAttribute('data-tab-shelf', 'pinned')
  }
  await expect.poll(() => rowCounts(shelfGroup)).toEqual(['1', '1'])
  const zoom = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
  await expect(tabShelfControls(shelfGroup, true).getByRole('button', { name: 'More pinned rows', exact: true })).toBeEnabled()
  await wheelShelf(shelfGroup, true, 120)
  await expect.poll(() => rowCounts(shelfGroup)).toEqual(['2', '1'])
  await wheelShelf(shelfGroup, false, 120)
  await expect.poll(() => rowCounts(shelfGroup)).toEqual(['2', '2'])
  await wheelShelf(shelfGroup, true, -120)
  await expect.poll(() => rowCounts(shelfGroup)).toEqual(['1', '2'])
  await tabShelfControls(shelfGroup).getByRole('button', { name: 'Fewer query rows', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => rowCounts(shelfGroup)).toEqual(['1', '1'])
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(zoom)
  // Plain wheel input leaves the row counts alone.
  const queryShelfBox = await tabShelf(shelfGroup).boundingBox()
  await page.mouse.move(queryShelfBox.x + 24, queryShelfBox.y + 12)
  await page.mouse.wheel(0, 120)
  await expect.poll(() => rowCounts(shelfGroup)).toEqual(['1', '1'])
  for (const pinned of [true, false]) {
    const section = pinned ? 'pinned' : 'unpinned'
    const hidden = editorGroupTabs(shelfGroup).and(shelfGroup.locator(`[data-tab-shelf="${section}"][data-tab-overflow]`)).first()
    const name = await hidden.getAttribute('aria-label')
    await selectOpenDocument(page, name)
    await expect.poll(() => activeDocumentName(page)).toBe(name)
    await expect(documentTab(page, name)).not.toHaveAttribute('data-tab-overflow', '')
  }
  // Native End can focus a tab outside the shelf and immediately bring it into the shown rows.
  const end = (await order()).at(-1), firstPinned = (await order())[0]
  await selectOpenDocument(page, firstPinned)
  await expect(documentTab(page, end)).toHaveAttribute('data-tab-overflow', '')
  await documentTab(page, firstPinned).focus()
  await page.keyboard.press('End')
  await expect.poll(() => activeDocumentName(page)).toBe(end)
  await expect(documentTab(page, end)).toBeFocused()
  await expect(documentTab(page, end)).not.toHaveAttribute('data-tab-overflow', '')
  const pinnedOrder = () => shelfGroup.getByRole('tab').and(shelfGroup.locator('[data-tab-shelf="pinned"]')).evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))
  // Starting a drag activates its source. An overflow tab promoted into the last slot must stay there as a target.
  const singleRowOrder = await pinnedOrder(), promoted = singleRowOrder.at(-1)
  await selectOpenDocument(page, promoted)
  const promotedBox = await documentTab(page, promoted).boundingBox()
  await drag(documentTab(page, singleRowOrder[0]), { x: promotedBox.x + promotedBox.width - 4, y: promotedBox.y + promotedBox.height / 2 })
  await expect.poll(pinnedOrder).toEqual([...singleRowOrder.slice(1), singleRowOrder[0]])
  // Native drag also reorders a pinned tab while the shelf has several rows.
  await tabShelfControls(shelfGroup, true).getByRole('button', { name: 'More pinned rows', exact: true }).click()
  const beforeDrag = await pinnedOrder(), pinnedTarget = await documentTab(page, beforeDrag[0]).boundingBox()
  await drag(documentTab(page, beforeDrag[1]), { x: pinnedTarget.x + 4, y: pinnedTarget.y + pinnedTarget.height / 2 })
  await expect.poll(async () => (await pinnedOrder()).slice(0, 2)).toEqual([beforeDrag[1], beforeDrag[0]])

  // Row choices belong to their editor group. A new split starts with one row and expands independently.
  await selectOpenDocument(page, end)
  await page.keyboard.press('Control+\\')
  await expect(editorGroups(page)).toHaveCount(2)
  const leftGroup = editorGroups(page).nth(0), rightGroup = editorGroups(page).nth(1)
  await expect.poll(() => rowCounts(leftGroup)).toEqual(['2', '1'])
  await expect(tabShelfRows(rightGroup)).toHaveText('1')
  for (let opened = 0; opened < 3; opened++) {
    await page.keyboard.press('Control+N')
    await expect.poll(async () => (await groupNames(1)).length).toBe(opened + 2)
  }
  await wheelShelf(rightGroup, false, 120)
  await expect(tabShelfRows(rightGroup)).toHaveText('2')
  await expect.poll(() => rowCounts(leftGroup)).toEqual(['2', '1'])
  await tabShelfControls(leftGroup).getByRole('button', { name: 'More query rows', exact: true }).click()
  await expect.poll(() => rowCounts(leftGroup)).toEqual(['2', '2'])
  await expect(tabShelfRows(rightGroup)).toHaveText('2')
  await page.keyboard.press('Alt+w')
  await menu('Window').getByRole('menuitem', { name: 'Join All Editor Groups', exact: true }).click()
  await expect(editorGroups(page)).toHaveCount(1)
  for (const name of (await order()).filter(name => name !== firstTab && name !== secondTab)) {
    await selectOpenDocument(page, name)
    await closeDocumentButton(page, name).click()
  }
  await expect.poll(pair).toEqual([firstTab, secondTab])
  console.log('Editor checks: tabs reorder by keys and dragging, pinned and query shelves stack independently with Ctrl+scroll, overflow and End reach hidden tabs, and editor groups keep independent row counts.')
  // Keyboard focus on tabs across a split, on CI's compact size: F2 renames a clean query whose tab moved into a new group
  // (#364), and Ctrl+Tab from a focused tab takes focus to the next query's tab, shown in its strip, so Ctrl+W closes that
  // one (#363).
  const focusSize = await page.evaluate(() => [innerWidth, innerHeight])
  await resizeContent(application, page, 1024, 720)
  const clean = []
  for (let opened = 0; opened < 4; opened++) {
    await page.keyboard.press('Control+N')
    await expect.poll(async () => (await order()).length).toBe(opened + 3)
    clean.push(await activeDocumentName(page))
  }
  await textbox().focus()
  await page.keyboard.press('Control+Backslash')
  await expect(editorGroups(page)).toHaveCount(2)
  expect(await groupNames(1)).toEqual([clean[3]])
  await documentTab(page, clean[3]).focus()
  await page.keyboard.press('F2')
  await expect(tabNameBox(page)).toBeFocused()
  await expect(tabNameBox(page)).toHaveValue(clean[3])
  await page.keyboard.press('Escape')
  await expect(documentTab(page, clean[3])).toBeFocused()
  await selectOpenDocument(page, clean[0])
  await documentTab(page, clean[0]).focus()
  await expect.poll(() => activeDocumentName(page)).toBe(clean[0])
  await expect(documentTab(page, clean[0])).toBeFocused()
  await page.keyboard.press('Control+Tab')
  await expect.poll(() => activeDocumentName(page)).toBe(clean[1])
  await expect(documentTab(page, clean[1])).toBeFocused()
  const inStrip = name => documentTab(page, name).evaluate(tab => { const box = tab.getBoundingClientRect(), view = tab.closest('[role="tablist"]').getBoundingClientRect(); return getComputedStyle(tab).opacity !== '0' && box.left >= view.left - 1 && box.right <= view.right + 1 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1 })
  expect(await inStrip(clean[1])).toBe(true)
  await page.keyboard.press('Control+W')
  await expect(documentTab(page, clean[1])).toHaveCount(0)
  await expect(documentTab(page, clean[0])).toHaveCount(1)
  for (const name of [clean[0], clean[2], clean[3]]) {
    await selectOpenDocument(page, name)
    await closeDocumentButton(page, name).click()
  }
  await expect(editorGroups(page)).toHaveCount(1)
  await expect.poll(pair).toEqual([firstTab, secondTab])
  await resizeContent(application, page, ...focusSize)
  console.log('Editor checks: F2 renames a clean query moved into a new group, and Ctrl+Tab from a focused tab moves focus to the next shown tab, which Ctrl+W closes.')
  // Editor groups: Split Editor Right (Ctrl+\) moves the active query into a new group on the right, with its own strip
  // and editor; Ctrl+K Ctrl+Left and Right focus the groups; Move Editor into Previous Group (Ctrl+Alt+Left) joins them
  // again, and the empty group goes.
  await selectOpenDocument(page, secondTab)
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  const groupText = index => editorGroups(page).nth(index).locator('.monaco-editor .view-lines').innerText()
  // Monaco draws the shown query's lines on its next frame.
  const drawnText = async index => (await groupText(index)).replace(/\s+/g, '')
  await expect.poll(() => drawnText(0)).not.toBe('')
  const secondText = await drawnText(0)
  await textbox().focus()
  await page.keyboard.press('Control+\\')
  await expect(editorGroups(page)).toHaveCount(2)
  expect(await groupNames(0)).toEqual([firstTab])
  expect(await groupNames(1)).toEqual([secondTab])
  await expect(page.locator(part.editorPane)).toHaveCount(2)
  // Each group is a region named for its shown query, apart from the document frames named for theirs.
  await expect(page.getByRole('region', { name: 'Editor group: ' + secondTab, exact: true })).toHaveCount(1)
  await expect(page.getByRole('region', { name: secondTab, exact: true })).toHaveCount(0)
  expect(await activeDocumentName(page)).toBe(secondTab)
  const lefts = await editorGroups(page).evaluateAll(groups => groups.map(group => group.getBoundingClientRect().left))
  expect(lefts[1]).toBeGreaterThan(lefts[0])
  // Each group's editor shows its own query, side by side.
  await expect.poll(() => drawnText(1)).toBe(secondText)
  await chord('ArrowLeft')
  await expect.poll(() => activeDocumentName(page)).toBe(firstTab)
  await expect(editorGroups(page).nth(0).locator('.monaco-editor [role="textbox"]')).toBeFocused()
  await chord('ArrowRight')
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  await page.keyboard.press('Control+Alt+ArrowLeft')
  await expect(editorGroups(page)).toHaveCount(1)
  await expect.poll(pair).toEqual([firstTab, secondTab])
  expect(await activeDocumentName(page)).toBe(secondTab)
  // Dragging a tab onto the docking compass's Dock right of panel splits its group there, as the workspace's panels
  // dock; Window › Join All Editor Groups puts every query back in one group.
  const area = await editorGroups(page).first().boundingBox(), tabBox = await documentTab(page, secondTab).boundingBox()
  await page.mouse.move(tabBox.x + 20, tabBox.y + tabBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(area.x + area.width / 2 + 95, area.y + area.height / 2, { steps: 8 })
  await expect(page.locator(part.dockingGuides).filter({ visible: true })).toHaveCount(1)
  const guide = await page.locator('[data-guide-position="right"][data-guide-scope="panel"]').boundingBox()
  await page.mouse.move(guide.x + guide.width / 2, guide.y + guide.height / 2, { steps: 3 })
  await expect(page.locator(part.activeDockingGuideCell)).toHaveAttribute('data-guide-position', 'right')
  await expect(page.locator(part.dockingPreview)).toBeVisible()
  await releaseTab()
  await expect(editorGroups(page)).toHaveCount(2)
  expect(await groupNames(1)).toEqual([secondTab])
  await page.keyboard.press('Alt+w')
  await menu('Window').getByRole('menuitem', { name: 'Join All Editor Groups', exact: true }).click()
  await expect(editorGroups(page)).toHaveCount(1)
  await expect.poll(pair).toEqual([firstTab, secondTab])
  // The release can contain a newer position than the last move: an old right-split highlight must not beat center.
  const releaseArea = await editorGroups(page).first().boundingBox(), releaseFrom = await documentTab(page, secondTab).boundingBox()
  await page.mouse.move(releaseFrom.x + 20, releaseFrom.y + releaseFrom.height / 2)
  await page.mouse.down()
  await page.mouse.move(releaseArea.x + releaseArea.width / 2 + 36, releaseArea.y + releaseArea.height / 2, { steps: 8 })
  await expect(page.locator(part.activeDockingGuideCell)).toHaveAttribute('data-guide-position', 'right')
  await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: x, clientY: y, buttons: 0 })),
    { x: releaseArea.x + releaseArea.width / 2, y: releaseArea.y + releaseArea.height / 2 })
  await expect(editorGroups(page)).toHaveCount(1)
  await expect(page.locator(part.dockingGuides).filter({ visible: true })).toHaveCount(0)
  await expect(page.locator(part.dockingPreview).filter({ visible: true })).toHaveCount(0)
  await page.mouse.up()
  // Moving a query onto another split's tab strip also clears the compass after release.
  await textbox().focus()
  await page.keyboard.press('Control+\\')
  await expect(editorGroups(page)).toHaveCount(2)
  const otherStrip = await documentTab(page, firstTab).boundingBox()
  await drag(documentTab(page, secondTab), { x: otherStrip.x + 4, y: otherStrip.y + otherStrip.height / 2 })
  await expect(editorGroups(page)).toHaveCount(1)
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  // Float from the tab's menu: the query floats over the editor area in a group of its own; Dock puts it back.
  await documentTab(page, secondTab).click({ button: 'right' })
  await menu('Query tab').getByRole('menuitem', { name: 'Float', exact: true }).click()
  await expect(floatingEditorGroups(page)).toHaveCount(1)
  await expect(editorGroupTabs(floatingEditorGroups(page))).toHaveCount(1)
  // The dragged float covers the destination's compass. Its content must not steal the drop from the shown target.
  const destinationGroup = editorGroups(page).filter({ has: documentTab(page, firstTab) })
  const destinationBox = await destinationGroup.boundingBox(), titlebar = page.locator('.dv-resize-container').filter({ has: documentTab(page, secondTab) }).locator('.dv-floating-titlebar')
  const floatingHeader = await titlebar.boundingBox()
  await page.mouse.move(floatingHeader.x + 20, floatingHeader.y + floatingHeader.height / 2)
  await page.mouse.down()
  await page.mouse.move(destinationBox.x + destinationBox.width / 2 - 100, destinationBox.y + destinationBox.height / 2 - 120, { steps: 6 })
  await releaseTab()
  const overlappingTab = await documentTab(page, secondTab).boundingBox()
  await page.mouse.move(overlappingTab.x + 20, overlappingTab.y + overlappingTab.height / 2)
  await page.mouse.down()
  await page.mouse.move(destinationBox.x + destinationBox.width / 2, destinationBox.y + destinationBox.height / 2, { steps: 8 })
  await expect(page.locator(part.activeDockingGuideCell)).toHaveAttribute('data-guide-position', 'center')
  const floatingBox = await floatingEditorGroups(page).boundingBox()
  expect(destinationBox.x + destinationBox.width / 2).toBeGreaterThan(floatingBox.x)
  expect(destinationBox.x + destinationBox.width / 2).toBeLessThan(floatingBox.x + floatingBox.width)
  expect(destinationBox.y + destinationBox.height / 2).toBeGreaterThan(floatingBox.y)
  expect(destinationBox.y + destinationBox.height / 2).toBeLessThan(floatingBox.y + floatingBox.height)
  await releaseTab()
  await expect(floatingEditorGroups(page)).toHaveCount(0)
  await expect(editorGroups(page)).toHaveCount(1)
  await expect.poll(pair).toEqual([firstTab, secondTab])
  await documentTab(page, secondTab).click({ button: 'right' })
  await menu('Query tab').getByRole('menuitem', { name: 'Float', exact: true }).click()
  await expect(floatingEditorGroups(page)).toHaveCount(1)
  await documentTab(page, secondTab).click({ button: 'right' })
  await expect(menu('Query tab').getByRole('menuitem', { name: 'Float', exact: true })).toHaveCount(0)
  await menu('Query tab').getByRole('menuitem', { name: 'Dock', exact: true }).click()
  await expect(floatingEditorGroups(page)).toHaveCount(0)
  // Docked, it joins the grid's group, as the last tab there.
  await expect(editorGroups(page)).toHaveCount(1)
  await expect.poll(pair).toEqual([firstTab, secondTab])
  await selectOpenDocument(page, secondTab)
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  // Raising an older floating window must also raise it as a compass destination.
  // Use CI's compact size and its default split proportions even on a larger desktop.
  const overlapSize = await page.evaluate(() => [innerWidth, innerHeight])
  await resizeContent(application, page, 1024, 720)
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('layout.reset').click())
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await textbox().focus()
  await page.keyboard.press('Control+N')
  const overlapProbe = await activeDocumentName(page)
  const chooseQuery = async name => {
    await page.keyboard.press('Control+P')
    await quickInput(page).getByRole('combobox').fill(name)
    await expect(quickInputActive(page)).toContainText(name)
    await page.keyboard.press('Enter')
    await expect(quickInput(page)).toHaveCount(0)
    await expect.poll(() => activeDocumentName(page)).toBe(name)
  }
  for (const [index, name] of [secondTab, overlapProbe].entries()) {
    // The first float can cover the next tab's pointer target. Arrange the fixture through its keyboard menu.
    await chooseQuery(name)
    await documentTab(page, name).focus()
    await expect(documentTab(page, name)).toBeFocused()
    await page.keyboard.press('Shift+F10')
    await menu('Query tab').getByRole('menuitem', { name: 'Float', exact: true }).click()
    await expect(floatingEditorGroups(page)).toHaveCount(index + 1)
    await expect(floatingEditorGroups(page).filter({ has: documentTab(page, name) }).locator('.monaco-editor [role="textbox"]')).toBeFocused()
  }
  await expect(floatingEditorGroups(page)).toHaveCount(2)
  await chooseQuery(secondTab)
  const olderFloat = floatingEditorGroups(page).filter({ has: documentTab(page, secondTab) })
  const newerFloat = floatingEditorGroups(page).filter({ has: documentTab(page, overlapProbe) })
  const level = group => group.evaluate(element => Number(getComputedStyle(element.closest('.dv-resize-container')).zIndex))
  expect(await level(olderFloat)).toBeGreaterThan(await level(newerFloat))
  const raisedBox = await olderFloat.boundingBox(), sourceBox = await documentTab(page, firstTab).boundingBox()
  await page.mouse.move(sourceBox.x + 20, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(raisedBox.x + raisedBox.width / 2, raisedBox.y + raisedBox.height / 2, { steps: 8 })
  await expect(page.locator(part.activeDockingGuideCell)).toHaveAttribute('data-guide-position', 'center')
  await releaseTab()
  await expect(editorGroupTabs(olderFloat)).toHaveCount(2)
  await expect(editorGroupTabs(newerFloat)).toHaveCount(1)
  await page.keyboard.press('Alt+w')
  await menu('Window').getByRole('menuitem', { name: 'Join All Editor Groups', exact: true }).click()
  await expect(editorGroups(page)).toHaveCount(1)
  await selectOpenDocument(page, overlapProbe)
  await closeDocumentButton(page, overlapProbe).click()
  await selectOpenDocument(page, firstTab)
  await page.keyboard.press('Control+Shift+PageUp')
  await expect.poll(pair).toEqual([firstTab, secondTab])
  await selectOpenDocument(page, secondTab)
  await resizeContent(application, page, ...overlapSize)
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('layout.reset').click())
  // Closing a group's shown query shows the next one in that group (the one before, at the strip's end), not the next in
  // order, which is in another group.
  await textbox().focus()
  await page.keyboard.press('Control+N')
  await expect.poll(async () => (await order()).length).toBe(3)
  const third = await activeDocumentName(page)
  await page.keyboard.press('Control+N')
  await expect.poll(async () => (await order()).length).toBe(4)
  const fourth = await activeDocumentName(page)
  await page.keyboard.press('Control+\\')
  await expect(editorGroups(page)).toHaveCount(2)
  expect(await groupNames(1)).toEqual([fourth])
  await selectOpenDocument(page, third)
  await expect.poll(() => activeDocumentName(page)).toBe(third)
  await page.keyboard.press('Control+W')
  await expect(documentTab(page, third)).toHaveCount(0)
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  // Ctrl+W closed it while its tab had focus: the keyboard stays in the strip, on the tab shown next.
  await expect(documentTab(page, secondTab)).toBeFocused()
  await closeDocumentButton(page, fourth).click()
  await expect(editorGroups(page)).toHaveCount(1)
  // A focused tab is the chosen one: Home, End and the arrows (Dockview's roving focus) show the tab they reach.
  await documentTab(page, secondTab).focus()
  await page.keyboard.press('Home')
  await expect(documentTab(page, firstTab)).toBeFocused()
  await expect.poll(() => activeDocumentName(page)).toBe(firstTab)
  await page.keyboard.press('End')
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => activeDocumentName(page)).toBe(firstTab)
  // Delete on a focused tab is File › Close's catalogue key: the tab closes, and focus moves to the tab shown next.
  await textbox().focus()
  await page.keyboard.press('Control+N')
  await expect.poll(async () => (await order()).length).toBe(3)
  const fifth = await activeDocumentName(page)
  await documentTab(page, fifth).focus()
  await page.keyboard.press('Delete')
  await expect(documentTab(page, fifth)).toHaveCount(0)
  await expect(documentTab(page, secondTab)).toBeFocused()
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  // A closing menu gives focus back to the tab it was opened on without showing it: Delete there closes that tab, not
  // the shown one.
  await textbox().focus()
  await page.keyboard.press('Control+N')
  await expect.poll(async () => (await order()).length).toBe(3)
  const sixth = await activeDocumentName(page)
  await page.keyboard.press('Control+N')
  await expect.poll(async () => (await order()).length).toBe(4)
  const seventh = await activeDocumentName(page)
  await documentTab(page, sixth).focus()
  await documentTab(page, sixth).click({ button: 'right' })
  await expect(menu('Query tab')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(documentTab(page, sixth)).toBeFocused()
  expect(await activeDocumentName(page)).toBe(seventh)
  await page.keyboard.press('Delete')
  await expect(documentTab(page, sixth)).toHaveCount(0)
  await expect(documentTab(page, seventh)).toHaveCount(1)
  expect(await activeDocumentName(page)).toBe(seventh)
  // A title bar menu gives focus back to such a tab too, but its Close Query closes the query on screen, as it says.
  await page.keyboard.press('Control+N')
  await expect.poll(async () => (await order()).length).toBe(4)
  const eighth = await activeDocumentName(page)
  await documentTab(page, seventh).focus()
  await documentTab(page, seventh).click({ button: 'right' })
  await expect(menu('Query tab')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(documentTab(page, seventh)).toBeFocused()
  await menubar(page).getByRole('menuitem', { name: 'File', exact: true }).click()
  await menu('File').getByRole('menuitem', { name: 'Close Query', exact: true }).click()
  await expect(documentTab(page, eighth)).toHaveCount(0)
  await expect(documentTab(page, seventh)).toHaveCount(1)
  await closeDocumentButton(page, seventh).click()
  await expect.poll(async () => (await order()).length).toBe(2)
  // Dockview floats a group's last tab on a Shift-drag. With every query floating, the empty grid says so and offers
  // Dock query rather than "No open queries".
  await documentTab(page, secondTab).click({ button: 'right' })
  await menu('Query tab').getByRole('menuitem', { name: 'Float', exact: true }).click()
  await expect(floatingEditorGroups(page)).toHaveCount(1)
  // The grid's only query does not float from the menu. A float can cover its pointer target on a compact display.
  await documentTab(page, firstTab).focus()
  await expect(documentTab(page, firstTab)).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(menu('Query tab').getByRole('menuitem', { name: 'Float', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  const firstBox = await documentTab(page, firstTab).boundingBox()
  await page.keyboard.down('Shift')
  await page.mouse.move(firstBox.x + 20, firstBox.y + firstBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(firstBox.x + 120, firstBox.y + 140, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await expect(floatingEditorGroups(page)).toHaveCount(2)
  await expect(page.getByText('All open queries float', { exact: true })).toBeVisible()
  await expect(page.getByText('No open queries', { exact: true })).toHaveCount(0)
  // The floating groups may cover it: its button works from the keyboard too.
  await page.getByRole('button', { name: 'Dock query', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(floatingEditorGroups(page)).toHaveCount(1)
  await expect(page.getByText('All open queries float', { exact: true })).toHaveCount(0)
  const floating = await editorGroupTabs(floatingEditorGroups(page)).first().getAttribute('aria-label')
  await documentTab(page, floating).click({ button: 'right' })
  await menu('Query tab').getByRole('menuitem', { name: 'Dock', exact: true }).click()
  await expect(floatingEditorGroups(page)).toHaveCount(0)
  await expect(editorGroups(page)).toHaveCount(1)
  await selectOpenDocument(page, secondTab)
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  // At the 16-group cap the grid has no room for an empty group: Shift-dragging its last tab out floats it while the
  // pointer is down, and it docks again once released. The tab menu (Shift+F10 on a focused tab) works under the floats.
  const tabMenu = async (tab, item) => {
    await documentTab(page, tab).focus()
    await page.keyboard.press('Shift+F10')
    await menu('Query tab').getByRole('menuitem', { name: item, exact: true }).click()
  }
  const extra = []
  for (let step = 0; step < 14; step++) {
    await page.keyboard.press('Control+N')
    await expect.poll(async () => (await order()).length).toBe(3 + step)
    extra.push(await activeDocumentName(page))
  }
  for (const [index, tab] of [firstTab, ...extra].entries()) {
    await tabMenu(tab, 'Float')
    await expect(floatingEditorGroups(page)).toHaveCount(index + 1)
  }
  await expect(editorGroups(page)).toHaveCount(16)
  // The floating groups may cover the grid's strip on a small display (Windows CI's 1024x768), so the Shift-press goes to
  // the tab itself; Dockview's float then follows the pointer until the window hears it go up.
  const lastBox = await documentTab(page, secondTab).boundingBox()
  const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: lastBox.x + 20, clientY: lastBox.y + lastBox.height / 2 }
  await documentTab(page, secondTab).dispatchEvent('pointerdown', { ...pointer, shiftKey: true, button: 0, buttons: 1 })
  // The float moves with the pointer, and the moves report the layout while the pointer is still down: the cap's dock
  // must wait for the release (without that wait this check fails every run).
  await page.evaluate(async init => {
    for (let step = 1; step <= 6; step++) {
      window.dispatchEvent(new PointerEvent('pointermove', { ...init, bubbles: true, buttons: 1, clientX: init.clientX + step * 20, clientY: init.clientY + step * 25 }))
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
  }, pointer)
  await expect(floatingEditorGroups(page)).toHaveCount(16)
  await page.evaluate(init => { window.dispatchEvent(new PointerEvent('pointerup', { ...init, bubbles: true, button: 0, buttons: 0 })) }, pointer)
  await expect(floatingEditorGroups(page)).toHaveCount(15)
  await expect(editorGroups(page)).toHaveCount(16)
  await expect(page.getByText('The query editor shows at most 16 editor groups.', { exact: true })).toBeVisible()
  expect(failures).toEqual([])
  for (const tab of extra) {
    await documentTab(page, tab).focus()
    await page.keyboard.press('Delete')
    await expect(documentTab(page, tab)).toHaveCount(0)
  }
  await tabMenu(firstTab, 'Dock')
  await expect(floatingEditorGroups(page)).toHaveCount(0)
  await expect(editorGroups(page)).toHaveCount(1)
  await selectOpenDocument(page, secondTab)
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  // A document's own regions keep their names as their titles change; only the groups are named "Editor group: …".
  const renamed = await page.locator(part.editorArea).evaluate(async root => {
    const region = document.createElement('div')
    region.setAttribute('role', 'region')
    region.setAttribute('aria-label', 'Before sections')
    root.append(region)
    region.setAttribute('aria-label', 'After sections')
    await new Promise(resolve => setTimeout(resolve, 0))
    const label = region.getAttribute('aria-label')
    region.remove()
    return label
  })
  expect(renamed).toBe('After sections')
  console.log('Editor checks: Split Editor Right, focus between groups, Move Editor into Previous Group, compass drops and moves between split tab strips clear both guides and highlights, Join All Editor Groups, Float and Dock, a close showing its own group\'s next tab, tab keys, Delete on a focused tab (the shown one or not) while File › Close Query closes the shown one, every query floating, and the 16-group cap under a Shift-drag.')

  // A plan panel moves with its Graph / XML choice and edits, while its group borrows the same Monaco editor as a query.
  const planName = 'multiple.sqlplan'
  const planPath = join(profile, planName)
  await writeFile(planPath, await readFile(resolve('tests/fixtures/plans', planName)))
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, planPath)
  await page.keyboard.press('Control+O')
  await expect.poll(() => activeDocumentName(page)).toBe(planName)
  await expect(planCanvas(page).locator('canvas')).toBeVisible()
  await documentTab(page, planName).focus()
  await page.keyboard.press('Control+\\')
  await expect(editorGroups(page)).toHaveCount(2)
  const planGroup = () => editorGroups(page).filter({ has: page.getByRole('tab', { name: planName, exact: true }) })
  const otherGroup = () => editorGroups(page).filter({ hasNot: page.getByRole('tab', { name: planName, exact: true }) })
  const graph = () => planGroup().getByRole('button', { name: 'Graph', exact: true })
  const xml = () => planGroup().getByRole('button', { name: 'XML source', exact: true })
  const planText = () => planGroup().locator('.monaco-editor .view-lines')
  const returnToGraph = async () => {
    await planCanvas(planGroup()).focus()
    await page.keyboard.press('F6')
    await expect(page.getByRole('button', { name: 'Results panel menu', exact: true })).toBeFocused()
    await page.keyboard.press('F6')
    await expect(planCanvas(planGroup())).toBeFocused()
  }
  await expect(planCanvas(planGroup()).locator('canvas')).toBeVisible()
  await expect(planCanvas(planGroup())).toBeFocused()
  await returnToGraph()
  await otherGroup().locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+P')
  await quickInput(page).getByRole('combobox').fill(planName)
  await expect(quickInputActive(page)).toContainText(planName)
  await page.keyboard.press('Enter')
  await expect(quickInput(page)).toHaveCount(0)
  await expect.poll(() => activeDocumentName(page)).toBe(planName)
  await expect(planCanvas(planGroup())).toBeFocused()
  await otherGroup().locator('.monaco-editor [role="textbox"]').focus()
  await expect.poll(() => activeDocumentName(page)).toBe(secondTab)
  await xml().click()
  await expect.poll(() => activeDocumentName(page)).toBe(planName)
  await expect(xml()).toHaveAttribute('aria-pressed', 'true')
  await expect(planText()).toContainText('ShowPlanXML')
  await planGroup().locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('End')
  await page.keyboard.insertText('\n<!-- group edit -->')
  await expect(planText()).toContainText('group edit')
  await tabMenu(planName, 'Float')
  await expect(editorGroupTabs(floatingEditorGroups(page))).toHaveAttribute('aria-label', planName)
  await expect(xml()).toHaveAttribute('aria-pressed', 'true')
  await expect(planText()).toContainText('group edit')
  await graph().click()
  await expect(planCanvas(floatingEditorGroups(page)).locator('canvas')).toBeVisible()
  await expect(planText()).toBeHidden()
  await returnToGraph()
  await xml().click()
  await expect(planText()).toContainText('group edit')
  await tabMenu(planName, 'Dock')
  await expect(floatingEditorGroups(page)).toHaveCount(0)
  await expect(xml()).toHaveAttribute('aria-pressed', 'true')
  await expect(planText()).toContainText('group edit')
  await planGroup().locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+S')
  await expect.poll(() => readFile(planPath, 'utf8')).toContain('group edit')
  await expect(unsavedMark(documentTab(page, planName))).toHaveCount(0)
  await page.keyboard.press('F6')
  await expect(page.getByRole('button', { name: 'Results panel menu', exact: true })).toBeFocused()
  await page.keyboard.press('F6')
  await expect(planGroup().locator('.monaco-editor [role="textbox"]')).toBeFocused()
  await closeDocumentButton(page, planName).click()
  await expect(editorGroups(page)).toHaveCount(1)
  await selectOpenDocument(page, secondTab)
  console.log('Editor checks: an execution plan switches between Graph and editable XML when split, floated and docked, and F6 and Quick Open focus its visible view.')

  // A reopened outline restores the DOM scroll position as well as the virtual rows.
  const outlineName = 'outline.sqlplan', outlinePath = join(profile, outlineName)
  const outlineXml = await readFile(resolve('tests/fixtures/plans', planName), 'utf8')
  await writeFile(outlinePath, outlineXml.replace('<BatchSequence>', '<!-- large-outline -->\n<BatchSequence>'))
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, outlinePath)
  await page.keyboard.press('Control+O')
  await expect.poll(() => activeDocumentName(page)).toBe(outlineName)
  const outlineTree = () => planViewer(page).getByRole('tree', { name: 'Plan operators', exact: true })
  await expect(planViewer(page).getByRole('status')).toHaveText('101 operators')
  await outlineTree().evaluate(element => { element.scrollTop = element.scrollHeight / 2 })
  const outlineScroll = await outlineTree().evaluate(element => element.scrollTop)
  expect(outlineScroll).toBeGreaterThan(0)
  await expect.poll(() => outlineTree().getByRole('treeitem').first().getAttribute('aria-posinset')).not.toBe('1')
  await planViewer(page).getByRole('button', { name: 'Outline', exact: true }).click()
  await expect(outlineTree()).toHaveCount(0)
  await planViewer(page).getByRole('button', { name: 'Outline', exact: true }).click()
  await expect.poll(() => outlineTree().evaluate(element => element.scrollTop)).toBe(outlineScroll)
  await expect.poll(() => outlineTree().evaluate(element => {
    const viewport = element.getBoundingClientRect()
    return [...element.querySelectorAll('[role="treeitem"]')].some(row => { const box = row.getBoundingClientRect(); return box.top < viewport.bottom && box.bottom > viewport.top })
  })).toBe(true)
  await closeDocumentButton(page, outlineName).click()
  console.log('Editor checks: toggling a scrolled plan outline restores its position with operators visible.')

  await page.keyboard.press('Alt+e')
  await page.keyboard.press('k')
  await expect(menu('Bookmarks').getByRole('menuitem', { name: 'Next Bookmark', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(menu('Bookmarks').getByRole('menuitem', { name: 'Toggle Bookmark', exact: true })).not.toHaveAttribute('aria-disabled', 'true')
  await closeMenus()
  console.log('Editor checks: bookmarks toggle, show in the margin, go next with wrap and across queries, and clear.')

  // 6. Insert Snippet (Ctrl+K Ctrl+X) lists the snippets by category; Create Table inserts with its placeholders as tab stops.
  await setText('')
  await chord('X')
  const picker = quickInput(page)
  await expect(picker).toBeVisible()
  await expect(picker.locator(part.quickInputGroup, { hasText: /^Table$/ })).toBeVisible()
  await page.keyboard.type('create table')
  await expect(quickInputActive(page).locator(part.quickInputLabel)).toHaveText('Create Table')
  await page.keyboard.press('Enter')
  await expect(picker).toHaveCount(0)
  await expect.poll(editorText).toContain('CREATE TABLE dbo.TableName')
  await page.keyboard.insertText('sales')
  await page.keyboard.press('Tab')
  await page.keyboard.insertText('Orders')
  await expect.poll(editorText).toContain('CREATE TABLE sales.Orders')
  await page.keyboard.press('Escape')
  console.log('Editor checks: Ctrl+K Ctrl+X inserts Create Table, whose placeholders take typing and Tab.')

  // 7. Surround With (Ctrl+K Ctrl+S) › Begin puts BEGIN and END around the selection, indented with a tab.
  await setText('SELECT 1')
  await page.keyboard.press('Control+A')
  await chord('S')
  await expect(picker).toBeVisible()
  await page.keyboard.type('begin')
  await page.keyboard.press('Enter')
  await expect.poll(editorText).toBe('BEGIN\n    SELECT 1\nEND')
  console.log('Editor checks: Ctrl+K Ctrl+S › Begin surrounds the selection with BEGIN … END.')

  // 8. Edit › Advanced › View White Space shows whitespace glyphs and is checked; Word Wrap is there too.
  // A line far wider than the editor: wrapped, it takes several view lines.
  const longLine = 'a b\tc' + ' wrap'.repeat(400)
  await setText(longLine)
  await expect.poll(viewLines).toBe(1)
  await advanced('h')
  // Monaco draws the glyphs in its overlay layer: an SVG path per line, or .mwh characters.
  await expect(page.locator('.monaco-editor .view-overlays svg path, .monaco-editor .view-overlays .mwh').first()).toBeAttached()
  await expect(await advancedItem('View White Space')).toHaveAttribute('aria-checked', 'true')
  await closeMenus()
  await textbox().focus()
  await advanced('w')
  await expect.poll(async () => JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).values).toMatchObject({ 'textEditor.sql.viewWhiteSpace': true, 'textEditor.sql.wordWrap': true })
  // An open menu shows the state it opened with, so it opens once the editor wraps. The file alone is too early: main
  // writes it before the page hears of the change, and Chromium runs the menu's key presses before that message.
  await expect.poll(viewLines).toBeGreaterThan(1)
  await expect(await advancedItem('Word Wrap')).toHaveAttribute('aria-checked', 'true')
  await closeMenus()
  console.log('Editor checks: View White Space and Word Wrap are Edit › Advanced toggles, saved to settings.json.')

  // 9. Both stay on after a relaunch with the same profile.
  expect(failures).toEqual([])
  await close()
  await launch()
  // The page may start before main's settings arrive (SettingsService waits 1.5 s at most), so the menu opens once the
  // editor shows them.
  await setText(longLine)
  await expect.poll(viewLines).toBeGreaterThan(1)
  await expect(page.locator('.monaco-editor .view-overlays svg path, .monaco-editor .view-overlays .mwh').first()).toBeAttached()
  await expect(await advancedItem('View White Space')).toHaveAttribute('aria-checked', 'true')
  await expect(menu('Advanced').getByRole('menuitemcheckbox', { name: 'Word Wrap', exact: true })).toHaveAttribute('aria-checked', 'true')
  await closeMenus()
  // Back to SSMS's defaults for the rest.
  await advanced('h')
  await advanced('w')
  console.log('Editor checks: View White Space and Word Wrap are still on after a relaunch.')

  // 10. Quick Find and Quick Replace seed as SSMS's: the word the caret is inside or at the start of, selected so typing
  // replaces it; with the caret just after a word (where Monaco would take that word), the find box keeps its text. With
  // two lines selected Quick Find searches in the selection; F3 and Shift+F3 move between matches. F3 with no search text
  // yet (the app has just relaunched) seeds by the same rule and finds the word, leaving focus in the editor.
  const findInput = page.locator('.find-widget .find-part textarea'), replaceInput = page.locator('.find-widget .replace-part textarea')
  const count = page.locator('.find-widget .matchesCount')
  await setText('Orders, Orders')
  await page.keyboard.press('F3')
  await expect(page.locator('.find-widget.visible')).toBeVisible()
  await expect(findInput).toHaveValue('')
  await page.keyboard.press('Home')
  await page.keyboard.press('F3')
  await expect(findInput).toHaveValue('Orders')
  await expect(count).toHaveText(/of 2$/)
  await expect(textbox()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.find-widget.visible')).toHaveCount(0)
  await setText('select * from Orders')
  /**
   * Ctrl+F or Ctrl+H with the caret where `moves` take it from Home: the find box's text, focused and selected after
   * Ctrl+F, then Escape to the editor. Monaco's Quick Replace focuses the find or the replace box depending on whether it
   * still counts the find box as focused from before Escape, so after Ctrl+H either may have focus.
   */
  async function seeded(key, moves, expected) {
    await page.keyboard.press('Home')
    for (const move of moves) await page.keyboard.press(move)
    await page.keyboard.press(key)
    await expect(key === 'Control+F' ? findInput : page.locator('.find-widget textarea:focus')).toBeFocused()
    await expect(findInput).toHaveValue(expected)
    if (key === 'Control+F') expect(await findInput.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([0, expected.length])
    await expect(replaceInput).toBeVisible({ visible: key === 'Control+H' })
    await page.keyboard.press('Escape')
    await expect(textbox()).toBeFocused()
  }
  const right = count => Array(count).fill('ArrowRight')
  await seeded('Control+F', ['End', 'ArrowLeft', 'ArrowLeft'], 'Orders')
  await seeded('Control+F', [], 'select')
  // After "Orders" at the end of the line, and after "from" before a space: the previous search stays.
  await seeded('Control+F', ['End'], 'select')
  await seeded('Control+H', right(13), 'select')
  // Monaco's own Ctrl+H seeds no word, so "from" shows that the key runs Varia's Quick Replace.
  await seeded('Control+H', right(9), 'from')
  await setText('a b a\na b a\na')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Control+F')
  await expect(page.locator('.find-widget [role="checkbox"][aria-label^="Find in Selection"]')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.type('a')
  await expect(count).toHaveText(/of 4$/)
  const first = await count.textContent()
  await page.keyboard.press('F3')
  await expect(count).not.toHaveText(first)
  await page.keyboard.press('Shift+F3')
  await expect(count).toHaveText(first)
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  console.log('Editor checks: Ctrl+F and Ctrl+H seed the word the caret is in or at the start of, and keep the previous search after a word; F3 with no search text seeds by the same rule; Ctrl+F on a multi-line selection finds in it (4 of the 5 a\'s), and F3 and Shift+F3 move between matches.')

  // 11. Ctrl+K with nothing after it for 6 s: Monaco has left chord mode, and the next key types.
  await setText('')
  await page.keyboard.press('Control+K')
  await page.waitForTimeout(6000)
  await page.keyboard.type('a')
  await expect.poll(editorText).toBe('a')
  console.log('Editor checks: a key 6 s after Ctrl+K types, so the chord timeout eats nothing.')

  expect(failures).toEqual([])
  await close()
  console.log('Editor suite passed.')
} catch (error) {
  console.error(error)
  if (page) await page.screenshot({ path: resolve('artifacts', 'editor-failure.png') }).catch(() => {})
  process.exitCode = 1
  await close().catch(() => application?.process()?.kill())
} finally {
  clearTimeout(watchdog)
}
