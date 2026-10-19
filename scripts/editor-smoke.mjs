import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
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
const glyphs = () => page.locator('.monaco-editor .varia-bookmark')
const activeTab = () => page.locator('.query-tabs [role="tab"][aria-selected="true"] .tab-name')

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
  const firstTab = await activeTab().textContent()
  await page.keyboard.press('Control+N')
  await expect.poll(() => activeTab().textContent()).not.toBe(firstTab)
  const secondTab = await activeTab().textContent()
  await textbox().focus()
  await page.keyboard.insertText('second')
  await chord('K')
  await expect(glyphs()).toHaveCount(1)
  await page.keyboard.press('Control+Tab')
  await expect.poll(() => activeTab().textContent()).toBe(firstTab)
  // The caret is on line 1 after W; the next bookmarks are line 3, then the second query's line 1.
  await textbox().focus()
  await chord('N')
  await page.keyboard.insertText('3')
  await expect.poll(editorText).toBe('Wone\ntwo\n3Nthree')
  await chord('N')
  await expect.poll(() => activeTab().textContent()).toBe(secondTab)
  await chord('L')
  await expect(glyphs()).toHaveCount(0)
  await page.keyboard.press('Alt+e')
  await page.keyboard.press('k')
  await expect(menu('Bookmarks').getByRole('menuitem', { name: 'Next Bookmark', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(menu('Bookmarks').getByRole('menuitem', { name: 'Toggle Bookmark', exact: true })).not.toHaveAttribute('aria-disabled', 'true')
  await closeMenus()
  console.log('Editor checks: bookmarks toggle, show in the margin, go next with wrap and across queries, and clear.')

  // 6. Insert Snippet (Ctrl+K Ctrl+X) lists the snippets by category; Create Table inserts with its placeholders as tab stops.
  await setText('')
  await chord('X')
  const picker = page.locator('.quick-input')
  await expect(picker).toBeVisible()
  await expect(picker.locator('.quick-input-group', { hasText: /^Table$/ })).toBeVisible()
  await page.keyboard.type('create table')
  await expect(picker.locator('.quick-input-row.active .quick-input-label')).toHaveText('Create Table')
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
  await setText('a b\tc')
  await advanced('h')
  // Monaco draws the glyphs in its overlay layer: an SVG path per line, or .mwh characters.
  await expect(page.locator('.monaco-editor .view-overlays svg path, .monaco-editor .view-overlays .mwh').first()).toBeAttached()
  await expect(await advancedItem('View White Space')).toHaveAttribute('aria-checked', 'true')
  await closeMenus()
  await textbox().focus()
  await advanced('w')
  // An open menu shows the state it opened with, so it opens once main has saved the change.
  await expect.poll(async () => JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).values).toMatchObject({ 'textEditor.sql.viewWhiteSpace': true, 'textEditor.sql.wordWrap': true })
  await expect(await advancedItem('Word Wrap')).toHaveAttribute('aria-checked', 'true')
  await closeMenus()
  console.log('Editor checks: View White Space and Word Wrap are Edit › Advanced toggles, saved to settings.json.')

  // 9. Both stay on after a relaunch with the same profile.
  expect(failures).toEqual([])
  await close()
  await launch()
  await textbox().focus()
  await expect(await advancedItem('View White Space')).toHaveAttribute('aria-checked', 'true')
  await expect(menu('Advanced').getByRole('menuitemcheckbox', { name: 'Word Wrap', exact: true })).toHaveAttribute('aria-checked', 'true')
  await closeMenus()
  // Back to SSMS's defaults for the rest.
  await advanced('h')
  await advanced('w')
  console.log('Editor checks: View White Space and Word Wrap are still on after a relaunch.')

  // 10. Quick Find and Quick Replace seed as SSMS's: the word the caret is inside or at the start of, selected so typing
  // replaces it; with the caret just after a word (where Monaco would take that word), the find box keeps its text. With
  // two lines selected Quick Find searches in the selection; F3 and Shift+F3 move between matches.
  await setText('select * from Orders')
  const findInput = page.locator('.find-widget .find-part textarea'), replaceInput = page.locator('.find-widget .replace-part textarea')
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
  const count = page.locator('.find-widget .matchesCount')
  await expect(count).toHaveText(/of 4$/)
  const first = await count.textContent()
  await page.keyboard.press('F3')
  await expect(count).not.toHaveText(first)
  await page.keyboard.press('Shift+F3')
  await expect(count).toHaveText(first)
  await page.keyboard.press('Escape')
  await expect(textbox()).toBeFocused()
  console.log('Editor checks: Ctrl+F and Ctrl+H seed the word the caret is in or at the start of, and keep the previous search after a word; Ctrl+F on a multi-line selection finds in it (4 of the 5 a\'s), and F3 and Shift+F3 move between matches.')

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
