// Files and status bars on the fake backend: encodings and line endings kept on save, the Save as Unicode and Save of
// Read-Only File prompts, Save files with a specific encoding, Save All, the IDE status bar's Ln/Col/Ch, INS/OVR, line ending and encoding, and the query
// status bar with its Options; then files from the command line and a second instance, File › Recent Files, changes
// made outside, drops, and AutoRecover across a renderer crash, a reload and a killed app. Native dialogs are stubbed in main, as
// electron-smoke does; files live under artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { crashRenderer } from './fixtures/dialog-lifecycle.mjs'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { codePageName, legacyCodePage } from '../src/main/text-encoding.ts'
import { activeDocument, backendReady, banner as bannerOf, caretStatus, documentTab, documentTabs, encodingStatus, inputModeStatus, lineEndingStatus, part, queryFact, queryFacts, queryStatus, readOnlyMark, readOnlyStatus, statusBar, toolbarButton, unsavedMark } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'files-profile-'))
const control = await mkdtemp(resolve('artifacts', 'files-control-'))
const folder = await mkdtemp(resolve('artifacts', 'files-documents-'))
await mkdir(join(control, 'hold'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
const windows = process.platform === 'win32', mac = process.platform === 'darwin'
// A file named on the command line opens once the workbench is ready.
const launched = join(folder, 'launched.sql')
await writeFile(launched, 'SELECT 42')
const chromiumSandbox = process.getuid?.() !== 0
// Replaced by a new launch on the same profile when AutoRecover's step kills the app.
let application = await electron.launch({ args: ['.', launched], env, chromiumSandbox })
const watchdog = setTimeout(() => { console.error('Files suite exceeded its time limit.'); application.process()?.kill(); process.exit(1) }, 420_000)
const failures = []
let page

/** Main's dialogs answer from a queue: the next path for Open and Save, the next button for a message box (else Cancel). */
async function stubDialogs() {
  await application.evaluate(({ dialog }) => {
    const state = globalThis.variaFiles = { open: [], save: [], answers: [], prompts: [], saveDialogs: 0 }
    dialog.showOpenDialog = async () => { const paths = state.open.shift() ?? []; return { canceled: !paths.length, filePaths: paths } }
    dialog.showSaveDialog = async () => { state.saveDialogs++; const path = state.save.shift(); return { canceled: !path, filePath: path ?? '' } }
    dialog.showMessageBox = async (_window, options) => {
      state.prompts.push({ title: options.title, message: options.message, detail: options.detail, buttons: options.buttons })
      return { response: state.answers.shift() ?? options.cancelId ?? 0, checkboxChecked: false }
    }
  })
}
const queue = (key, ...values) => application.evaluate((_, [name, items]) => { globalThis.variaFiles[name].push(...items) }, [key, values])
const prompts = () => application.evaluate(() => globalThis.variaFiles.prompts.splice(0))
const saveDialogs = () => application.evaluate(() => globalThis.variaFiles.saveDialogs)
const textbox = () => page.locator('.monaco-editor [role="textbox"]')
const tabs = () => documentTabs(page).getByRole('tab')
const activeTab = () => activeDocument(page)
const queryBar = () => queryStatus(page)
const banner = () => bannerOf(page)
const bytes = async path => [...await readFile(path)]
const writable = path => access(path, constants.W_OK).then(() => true, () => false)
const be = text => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
/** Opens files through File › Open (Ctrl+O, ⌘O) and waits for the last one's tab. */
async function open(...paths) {
  await queue('open', paths)
  await page.keyboard.press(mac ? 'Meta+O' : 'Control+O')
  await expect(tabs().last()).toHaveAttribute('aria-label', paths.at(-1).split(/[\\/]/).at(-1))
}
/** Types at the end of the active query. */
async function typeAtEnd(text) {
  await textbox().focus()
  await page.keyboard.press(mac ? 'Meta+End' : 'Control+End')
  await page.keyboard.insertText(text)
  await expect(unsavedMark(activeTab())).toHaveCount(1)
}
const save = () => page.keyboard.press(mac ? 'Meta+S' : 'Control+S')

try {
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  await stubDialogs()

  // 0. The command line's file opens in its own tab, after the first query; closing it leaves that query active.
  await expect(tabs()).toHaveCount(2)
  await expect(activeTab()).toHaveAttribute('aria-label', 'launched.sql')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('SELECT 42')
  await page.keyboard.press(mac ? 'Meta+W' : 'Control+W')
  await expect(tabs()).toHaveCount(1)
  console.log('Files checks: a file named on the command line opens once the workbench is ready.')

  // 1. Main has a strict decoder for every ANSI code page Varia reads (Electron's ICU), so no table is bundled.
  const labels = [...new Set(['en-US', 'cs', 'ru', 'el', 'tr', 'he', 'ar', 'lt', 'vi', 'th', 'ja', 'zh-CN', 'zh-TW', 'ko'].map(legacyCodePage))]
  expect(await application.evaluate((_, list) => list.filter(label => { try { new TextDecoder(label, { fatal: true }); return false } catch { return true } }), labels)).toEqual([])
  const locale = await application.evaluate(({ app }) => app.getSystemLocale())
  console.log(`Files checks: main decodes all ${labels.length} ANSI code pages; this system (${locale}) reads legacy files as ${codePageName(legacyCodePage(locale))}.`)

  // 2. A new query: the platform's line ending, UTF-8 (SSMS 22's new-query template has no BOM), insert mode. Ln, Col
  // and Ch follow the caret, a tab counting four columns.
  await expect(lineEndingStatus(page)).toHaveText(windows ? 'CRLF' : 'LF')
  await expect(encodingStatus(page)).toHaveText('UTF-8')
  await expect(inputModeStatus(page)).toHaveText('INS')
  await textbox().focus()
  await page.keyboard.press(mac ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText('\tSELECT 1')
  await expect(caretStatus(page)).toHaveText('Ln 1Col 13Ch 10')
  await page.keyboard.press('Home')
  await expect(caretStatus(page)).toHaveText('Ln 1Col 5Ch 2')
  // 3. Insert switches to overtype: typing replaces the character after the caret, and Insert switches back.
  if (!mac) {
    await page.keyboard.press('Insert')
    await expect(inputModeStatus(page)).toHaveText('OVR')
    await page.keyboard.type('W')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('WELECT')
    await expect(caretStatus(page)).toHaveText('Ln 1Col 6Ch 3')
    await page.keyboard.press('Insert')
    await expect(inputModeStatus(page)).toHaveText('INS')
    await page.keyboard.type('X')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('WXELECT')
    console.log('Files checks: Ln/Col/Ch follow the caret with a tab as four columns, and Insert toggles INS and OVR.')
  }

  // 4. A UTF-16 BE file with CRLF keeps its byte order mark, byte order and line endings when saved.
  const bigEndian = join(folder, 'big-endian.sql')
  await writeFile(bigEndian, be("SELECT N'Grüße';\r\nGO\r\n"))
  await open(bigEndian)
  await expect(encodingStatus(page)).toHaveText('UTF-16 BE')
  await expect(lineEndingStatus(page)).toHaveText('CRLF')
  await typeAtEnd('SELECT 2;\nGO')
  await save()
  await expect(unsavedMark(activeTab())).toHaveCount(0)
  expect(await bytes(bigEndian)).toEqual([...be("SELECT N'Grüße';\r\nGO\r\nSELECT 2;\r\nGO")])
  console.log('Files checks: a UTF-16 BE file with CRLF is saved as UTF-16 BE with CRLF.')

  // 5. Mixed line endings open as the most common kind, with a notice, and are saved that way.
  const mixed = join(folder, 'mixed.sql')
  await writeFile(mixed, 'SELECT 1\r\nGO\nSELECT 2\r\n')
  await open(mixed)
  await expect(banner()).toHaveText('Line endings in mixed.sql were mixed; it will be saved with CRLF line endings.')
  await expect(banner()).toHaveAttribute('role', 'status')
  await typeAtEnd('GO')
  await save()
  await expect(unsavedMark(activeTab())).toHaveCount(0)
  expect(await readFile(mixed, 'utf8')).toBe('SELECT 1\r\nGO\r\nSELECT 2\r\nGO')
  await expect(banner()).toHaveCount(0)

  // 6. A file in the ANSI code page is read, and saved only as UTF-8 with a BOM once the user agrees.
  const legacy = join(folder, 'legacy.sql'), label = legacyCodePage(locale), legacyBytes = [0x2d, 0x2d, 0x20, 0x53, 0xe9, 0x80, 0x0d, 0x0a]
  const legacyText = new TextDecoder(label).decode(Uint8Array.from(legacyBytes))
  await writeFile(legacy, Uint8Array.from(legacyBytes))
  await open(legacy)
  await expect(encodingStatus(page)).toHaveText(codePageName(label))
  await typeAtEnd('SELECT 1')
  await queue('answers', 1)
  await save()
  await expect.poll(prompts).toEqual([{ title: 'Save as Unicode', message: `legacy.sql was read as ${codePageName(label)}.`, detail: 'Varia SQL Manager saves only Unicode. Save it as UTF-8 with a byte order mark, which SSMS and other tools read correctly?', buttons: ['Save as UTF-8', 'Cancel'] }])
  await expect(unsavedMark(activeTab())).toHaveCount(1)
  expect(await bytes(legacy)).toEqual(legacyBytes)
  await queue('answers', 0)
  await save()
  await expect(unsavedMark(activeTab())).toHaveCount(0)
  expect(await bytes(legacy)).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from(legacyText + 'SELECT 1')])
  await expect(encodingStatus(page)).toHaveText('UTF-8 with BOM')
  expect((await prompts()).map(prompt => prompt.title)).toEqual(['Save as Unicode'])
  console.log(`Files checks: a ${codePageName(label)} file is saved as UTF-8 with a BOM only after Save as Unicode.`)

  // 7. A read-only file: the tab and the status bar say so, Save asks (Save As, Overwrite, Cancel), Cancel writes nothing,
  // and Overwrite clears the attribute and saves. Root can write any file, so cloud sessions skip this step.
  if (process.getuid?.() !== 0) {
    const locked = join(folder, 'locked.sql')
    await writeFile(locked, 'SELECT 1')
    await chmod(locked, 0o444)
    await open(locked)
    await expect(readOnlyMark(activeTab())).toHaveCount(1)
    await expect(activeTab()).toHaveAttribute('title', /locked\.sql \(read-only\)$/)
    await expect(readOnlyStatus(page)).toHaveText('Read-only')
    await typeAtEnd(' AS one')
    await save()
    const readOnlyPrompt = { title: 'Save of Read-Only File', message: `The file ${locked} cannot be saved because it is write-protected.`,
      detail: 'You can either save the file in a different location or Varia SQL Manager can attempt to remove the write-protection and overwrite the file in its current location.', buttons: ['Save As…', 'Overwrite', 'Cancel'] }
    await expect.poll(prompts).toEqual([readOnlyPrompt])
    expect(await readFile(locked, 'utf8')).toBe('SELECT 1')
    await expect(unsavedMark(activeTab())).toHaveCount(1)
    await queue('answers', 1)
    await save()
    await expect(unsavedMark(activeTab())).toHaveCount(0)
    expect(await readFile(locked, 'utf8')).toBe('SELECT 1 AS one')
    await expect(readOnlyStatus(page)).toHaveCount(0)
    await expect(readOnlyMark(activeTab())).toHaveCount(0)
    expect(await prompts()).toEqual([readOnlyPrompt])
    console.log('Files checks: Save of Read-Only File cancels without writing, and Overwrite clears the attribute and saves.')

    // A read-only file in the ANSI code page: Overwrite, then Cancel at Save as Unicode, leaves it read-only and as it
    // was; Save As… asks Save as Unicode, opens one Save dialog and writes the new file, leaving the original alone.
    const lockedLegacy = join(folder, 'locked-legacy.sql'), copy = join(folder, 'locked-copy.sql')
    await writeFile(lockedLegacy, Uint8Array.from(legacyBytes))
    await chmod(lockedLegacy, 0o444)
    await open(lockedLegacy)
    await typeAtEnd('SELECT 1')
    await queue('answers', 1)
    await save()
    await expect.poll(() => application.evaluate(() => globalThis.variaFiles.prompts.length)).toBe(2)
    expect((await prompts()).map(prompt => prompt.title)).toEqual(['Save of Read-Only File', 'Save as Unicode'])
    await expect(unsavedMark(activeTab())).toHaveCount(1)
    expect(await writable(lockedLegacy)).toBe(false)
    expect(await bytes(lockedLegacy)).toEqual(legacyBytes)
    const dialogs = await saveDialogs()
    await queue('answers', 0, 0)
    await queue('save', copy)
    await save()
    await expect(activeTab()).toHaveAttribute('aria-label', 'locked-copy.sql')
    await expect(unsavedMark(activeTab())).toHaveCount(0)
    expect((await prompts()).map(prompt => prompt.title)).toEqual(['Save of Read-Only File', 'Save as Unicode'])
    expect(await saveDialogs()).toBe(dialogs + 1)
    expect(await bytes(copy)).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from(legacyText + 'SELECT 1')])
    expect(await bytes(lockedLegacy)).toEqual(legacyBytes)
    expect(await writable(lockedLegacy)).toBe(false)
    console.log('Files checks: Cancel after Overwrite keeps the file read-only, and Save As… writes a new file and leaves the original alone.')
  }

  // 7b. Save files with a specific encoding: a new query says, and is saved in, the Save encoding; a legacy file is
  // converted to it without Save as Unicode. A file already open keeps showing what it was read as until it is saved.
  expect(await page.evaluate(() => window.varia.updateSettings({ 'environment.documents.saveWithSpecificEncoding': true, 'environment.documents.saveEncoding': 'utf16be' }))).toMatchObject({ ok: true })
  await toolbarButton(page, 'New query').click()
  await expect(encodingStatus(page)).toHaveText('UTF-16 BE')
  await textbox().focus()
  await page.keyboard.insertText('SELECT 5')
  const specific = join(folder, 'specific.sql')
  await queue('save', specific)
  await save()
  await expect(activeTab()).toHaveAttribute('aria-label', 'specific.sql')
  expect(await bytes(specific)).toEqual([...be('SELECT 5')])
  await expect(encodingStatus(page)).toHaveText('UTF-16 BE')
  const converted = join(folder, 'converted.sql')
  await writeFile(converted, Uint8Array.from(legacyBytes))
  await open(converted)
  await expect(encodingStatus(page)).toHaveText(codePageName(label))
  await typeAtEnd('SELECT 6')
  await save()
  await expect(unsavedMark(activeTab())).toHaveCount(0)
  expect(await bytes(converted)).toEqual([...be(legacyText + 'SELECT 6')])
  await expect(encodingStatus(page)).toHaveText('UTF-16 BE')
  expect(await prompts()).toEqual([])
  expect(await page.evaluate(() => window.varia.updateSettings({ 'environment.documents.saveWithSpecificEncoding': null, 'environment.documents.saveEncoding': null }))).toMatchObject({ ok: true })
  await toolbarButton(page, 'New query').click()
  await expect(encodingStatus(page)).toHaveText('UTF-8')
  await page.keyboard.press(mac ? 'Meta+W' : 'Control+W')
  await expect(activeTab()).toHaveAttribute('aria-label', 'converted.sql')
  console.log('Files checks: Save files with a specific encoding labels and saves a new query in its encoding, and converts a legacy file without asking.')

  // 8. Save All (Ctrl+Shift+S, ⌥⌘S) in tab order: the first, untitled query asks for its file, the saved one is saved,
  // and the last, untitled one asks in turn; all end clean.
  await documentTab(page, 'mixed.sql').click()
  await typeAtEnd('\nSELECT 3')
  await toolbarButton(page, 'New query').click()
  await textbox().focus()
  await page.keyboard.insertText('SELECT 4')
  await expect(unsavedMark(activeTab())).toHaveCount(1)
  await expect(toolbarButton(page, 'Save All')).toBeEnabled()
  const before = await saveDialogs(), first = join(folder, 'first.sql'), untitled = join(folder, 'untitled.sql')
  await queue('save', first, untitled)
  await page.keyboard.press(mac ? 'Alt+Meta+S' : 'Control+Shift+S')
  await expect(unsavedMark(documentTabs(page))).toHaveCount(0)
  expect(await saveDialogs()).toBe(before + 2)
  expect(await readFile(first, 'utf8')).toBe(mac ? '\tSELECT 1' : '\tWXELECT 1')
  expect(await readFile(mixed, 'utf8')).toBe('SELECT 1\r\nGO\r\nSELECT 2\r\nGO\r\nSELECT 3')
  expect(await readFile(untitled, 'utf8')).toBe('SELECT 4')
  await expect(activeTab()).toHaveAttribute('aria-label', 'untitled.sql')
  await expect(toolbarButton(page, 'Save All')).toBeDisabled()
  console.log('Files checks: Save All saves every changed query in tab order, asking for each untitled one\'s file in turn.')

  // 9. The query's facts: SSMS's state sentence, then server (version), login (SPID), database, elapsed time and rows, in
  // the window's status bar. Options bring SSMS's query window status bar back below the query, place it on top, and
  // switch segments off.
  await toolbarButton(page, 'Connect').click()
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(queryBar()).toHaveAttribute('role', 'status')
  await expect(queryBar().locator(part.queryStatusText)).toHaveText('Connected.')
  await textbox().focus()
  await page.keyboard.press(mac ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText('-- varia-fake: sets=W1*10')
  await page.keyboard.press('F5')
  await expect(queryBar().locator(part.queryStatusText)).toHaveText('Query executed successfully.')
  await expect(queryBar()).toHaveAttribute('data-tone', 'ready')
  await expect(queryFact(page, 'server')).toHaveText('Server: server-a (16.0)')
  await expect(queryFact(page, 'login')).toHaveText(/^Login: fake \(\d+\)$/)
  await expect(queryFact(page, 'database')).toHaveText('Database: master')
  await expect(queryFact(page, 'time')).toHaveText(/^Elapsed time: \d\d:\d\d:\d\d$/)
  await expect(queryFact(page, 'rows')).toHaveText('Rows: 10 rows')
  const order = () => page.getByRole('main').evaluate((main, part) => [...main.children].map(child => child.matches(part.queryStatus) ? 'bar' : child.matches(part.editorPane) ? 'editor' : 'tabs'), part)
  expect(await order()).toEqual(['tabs', 'editor'])
  expect(await queryBar().evaluate((bar, status) => !!bar.parentElement?.matches(status), part.statusBar)).toBe(true)
  await statusBar(page).screenshot({ path: resolve('artifacts', 'files-status-bar.png') })
  expect(await page.evaluate(() => window.varia.updateSettings({ 'textEditor.statusBar.queryWindow': true }))).toMatchObject({ ok: true })
  await expect(queryBar()).toHaveAttribute('data-location', 'bottom')
  expect(await order()).toEqual(['tabs', 'editor', 'bar'])
  await expect(queryFact(page, 'rows')).toHaveText('Rows: 10 rows')
  expect(await page.evaluate(() => window.varia.updateSettings({ 'textEditor.statusBar.location': 'top', 'textEditor.statusBar.showRowCount': false, 'textEditor.statusBar.showLogin': false }))).toMatchObject({ ok: true })
  await expect(queryBar()).toHaveAttribute('data-location', 'top')
  expect(await order()).toEqual(['tabs', 'bar', 'editor'])
  await expect(queryBar().locator(part.querySegment)).toHaveCount(3)
  await expect(queryFact(page, 'rows')).toHaveCount(0)
  expect(await page.evaluate(() => window.varia.updateSettings({ 'textEditor.statusBar.location': null, 'textEditor.statusBar.showRowCount': null, 'textEditor.statusBar.showLogin': null }))).toMatchObject({ ok: true })
  await expect(queryBar().locator(part.querySegment)).toHaveCount(5)
  expect(await order()).toEqual(['tabs', 'editor', 'bar'])
  await queryBar().screenshot({ path: resolve('artifacts', 'files-query-status.png') })
  expect(await page.evaluate(() => window.varia.updateSettings({ 'textEditor.statusBar.queryWindow': null }))).toMatchObject({ ok: true })
  expect(await order()).toEqual(['tabs', 'editor'])
  await expect(queryFact(page, 'rows')).toHaveText('Rows: 10 rows')
  console.log('Files checks: the status bar shows the query\'s SSMS segments, and Options bring back the query window status bar, move it and switch segments off.')

  // 10. In a small window a long server name gives way first, and the database stays whole; a 127-character database
  // name gives way too (both whole in the tooltip), while the time and rows always stay whole inside the bar.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 700))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024)
  const longServer = 'sqlprod-analytics-warehouse-cluster-01.' + 'reporting-'.repeat(6) + 'corp.contoso.com\\INSTANCE01', longDatabase = 'Warehouse_'.repeat(12) + 'Archive'
  /** Connects to the long server (a new query on it) and runs a query there. */
  async function connectAndRun(database) {
    await toolbarButton(page, 'Connect').click()
    await page.getByLabel('Server Name', { exact: true }).fill(longServer)
    await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await page.getByLabel('Database Name', { exact: true }).fill(database)
    await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(queryFact(page, 'database')).toHaveText(`Database: ${database || 'master'}`)
    await textbox().focus()
    await page.keyboard.insertText('-- varia-fake: sets=W1*10')
    await page.keyboard.press('F5')
    await expect(queryFact(page, 'rows')).toHaveText('Rows: 10 rows')
    await expect(queryBar()).toHaveAttribute('title', new RegExp(`\\| ${database || 'master'}(\\n|$)`))
  }
  /** Which segments lie inside the bar, and which show their whole text. */
  const layout = () => page.evaluate(([part, facts]) => {
    const bar = document.querySelector(part.queryStatus).getBoundingClientRect()
    const segments = { state: part.queryState, ...facts }
    const segment = name => document.querySelector(segments[name])
    const inside = element => { const box = element.getBoundingClientRect(); return box.left >= bar.left - 0.5 && box.right <= bar.right + 0.5 }
    const whole = element => element.scrollWidth <= element.clientWidth
    return { inside: ['state', 'server', 'login', 'database', 'time', 'rows'].every(name => inside(segment(name))), whole: ['server', 'login', 'database', 'time', 'rows'].filter(name => whole(segment(name))), page: document.documentElement.scrollWidth <= innerWidth }
  }, [part, queryFacts])
  await connectAndRun('')
  expect(await layout()).toEqual({ inside: true, whole: ['login', 'database', 'time', 'rows'], page: true })
  await connectAndRun(longDatabase)
  expect(await layout()).toEqual({ inside: true, whole: ['time', 'rows'], page: true })
  await queryBar().screenshot({ path: resolve('artifacts', 'files-query-status-small.png') })
  console.log('Files checks: in a small window the server, then the login and database, give way in the status bar, and the time and rows stay whole.')

  // 11. A second instance, started with a file, hands it to this one and quits; the file opens here.
  const second = join(folder, 'second.sql')
  await writeFile(second, 'SELECT 2 AS second')
  const instance = spawn(electronPath, ['.', second, ...process.getuid?.() === 0 ? ['--no-sandbox'] : []], { env, stdio: 'ignore' })
  const exitCode = await new Promise((resolve, reject) => { instance.once('exit', resolve); instance.once('error', reject) })
  expect(exitCode).toBe(0)
  await expect(activeTab()).toHaveAttribute('aria-label', 'second.sql')
  console.log('Files checks: a second instance hands its file to the first and quits.')

  // 12. File › Recent Files lists what was opened and saved, newest first, as many as Options says, in the title-bar
  // menu and the native one, and reopens an entry; one that no longer exists offers to leave the list.
  const nativeRecent = () => application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.recent').submenu.items.map(item => ({ id: item.id, label: item.label, enabled: item.enabled })))
  const nativeFiles = async () => (await nativeRecent()).filter(item => /^file\.recent\.\d+$/.test(item.id))
  await expect.poll(async () => (await nativeRecent())[0]?.label ?? '').toMatch(/second\.sql$/)
  // More than ten files were opened or saved so far; the menu shows the default ten until Options shows more.
  expect(await nativeFiles()).toHaveLength(10)
  expect((await nativeRecent()).some(item => item.label.endsWith('launched.sql'))).toBe(false)
  expect(await page.evaluate(() => window.varia.updateSettings({ 'environment.recentFiles.count': 24 }))).toMatchObject({ ok: true })
  await expect.poll(async () => (await nativeFiles()).length).toBeGreaterThan(10)
  const recentLabels = (await nativeRecent()).map(item => item.label)
  expect(recentLabels.at(-1)).toBe('Clear Recent Files')
  expect(recentLabels.some(label => label.endsWith('launched.sql'))).toBe(true)
  if (!mac) {
    expect(recentLabels[0]).toMatch(/^&1 /)
    await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'File', exact: true }).click({ force: true })
    await page.getByRole('menu', { name: 'File', exact: true }).getByRole('menuitem', { name: 'Recent Files', exact: true }).hover({ force: true })
    const recentMenu = page.getByRole('menu', { name: 'Recent Files', exact: true })
    await expect(recentMenu.getByRole('menuitem').first()).toContainText('second.sql')
    await recentMenu.getByRole('menuitem', { name: /launched\.sql/ }).click({ force: true })
    await expect(activeTab()).toHaveAttribute('aria-label', 'launched.sql')
    await page.keyboard.press('Control+W')
  }
  // The native menu (macOS's menu bar) opens an entry through main.
  const launchedItem = (await nativeRecent()).find(item => item.label.endsWith('launched.sql'))
  await application.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), launchedItem.id)
  await expect(activeTab()).toHaveAttribute('aria-label', 'launched.sql')
  await page.keyboard.press(mac ? 'Meta+W' : 'Control+W')
  await expect.poll(async () => (await nativeRecent())[0].label).toMatch(/launched\.sql$/)
  // A deleted entry: Remove takes it off the list.
  await rm(launched)
  await prompts()
  await queue('answers', 0)
  const removed = (await nativeRecent()).find(item => item.label.endsWith('launched.sql'))
  await application.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), removed.id)
  await expect.poll(prompts).toEqual([{ title: 'Recent Files', message: 'launched.sql cannot be opened.', detail: `${launched} no longer exists. Remove it from the Recent Files list?`, buttons: ['Remove', 'Keep'] }])
  await expect.poll(async () => (await nativeRecent()).some(item => item.label.endsWith('launched.sql'))).toBe(false)
  console.log('Files checks: File › Recent Files lists opened and saved files, reopens one from either menu, and offers to remove a missing one.')

  // 13. A change made outside: focus asks File changed, and Yes reloads the query, clean. With unsaved changes, No keeps
  // them, and the next Save asks before replacing the outside change.
  const focusWindow = () => page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await documentTab(page, 'second.sql').click()
  await expect(activeTab()).toHaveAttribute('aria-label', 'second.sql')
  await writeFile(second, 'SELECT 3 AS changed')
  await utimes(second, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000))
  await queue('answers', 0)
  await focusWindow()
  await expect.poll(prompts).toEqual([{ title: 'File changed', message: second, detail: 'This file has been modified outside of the source editor. Do you want to reload it?', buttons: ['Yes', 'No'] }])
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('SELECT 3 AS changed')
  await expect(unsavedMark(activeTab())).toHaveCount(0)
  await typeAtEnd(' -- mine')
  await writeFile(second, 'SELECT 4 AS outside')
  await utimes(second, new Date(Date.now() + 20_000), new Date(Date.now() + 20_000))
  await queue('answers', 1)
  await focusWindow()
  await expect.poll(prompts).toEqual([{ title: 'File changed', message: second, detail: 'This file has been modified outside of the source editor. Do you want to reload it and lose the changes made in the source editor?', buttons: ['Yes', 'No'] }])
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('-- mine')
  await save()
  await expect.poll(prompts).toEqual([{ title: 'File changed', message: `The file ${second} was changed outside Varia SQL Manager.`, detail: 'Saving replaces those changes with this query.', buttons: ['Save', 'Cancel'] }])
  expect(await readFile(second, 'utf8')).toBe('SELECT 4 AS outside')
  await expect(unsavedMark(activeTab())).toHaveCount(1)
  // A file deleted outside makes its query unsaved, with a notice; Save writes it again.
  await rm(second)
  await focusWindow()
  await expect(banner()).toHaveText('second.sql was deleted or moved outside Varia SQL Manager. Save it to keep it.')
  await save()
  await expect(unsavedMark(activeTab())).toHaveCount(0)
  expect(await readFile(second, 'utf8')).toBe('SELECT 3 AS changed -- mine')
  console.log('Files checks: a file changed outside is reloaded on Yes, kept on No with Save asking first, and a deleted one is saved again.')

  // 14. Drops: a synthetic drop that page script makes opens nothing; a real drop of a file (Chromium's input, through
  // the DevTools protocol) opens it.
  const count = await tabs().count()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['SELECT 1'], 'forged.sql'))
    document.querySelector('.monaco-editor').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(500)
  await expect(tabs()).toHaveCount(count)
  const dropped = join(folder, 'dropped.sql')
  await writeFile(dropped, 'SELECT 5 AS dropped')
  const cdp = await application.context().newCDPSession(page)
  const box = await page.locator('.monaco-editor').boundingBox()
  const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
  const data = { items: [], files: [dropped], dragOperationsMask: 1 }
  const dropFile = async () => { for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, ...at, data }) }
  await dropFile()
  await expect(activeTab()).toHaveAttribute('aria-label', 'dropped.sql')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('SELECT 5 AS dropped')
  // Dropped again on its own query, the file keeps that tab, and Monaco, which never saw the drag, shows no drop caret
  // (one it started on dragover would stay, as only the drop it never gets ends it).
  const opened = await tabs().count()
  await dropFile()
  // Monaco draws on an animation frame, which a hidden or locked window delays: the caret must never show for 2 s.
  const carets = []
  for (let sample = 0; sample < 8; sample++) { await page.waitForTimeout(250); carets.push(await page.locator('.monaco-editor ' + part.dropCaret).count()) }
  expect(carets).toEqual(Array(8).fill(0))
  await expect(tabs()).toHaveCount(opened)
  await expect(activeTab()).toHaveAttribute('aria-label', 'dropped.sql')
  await cdp.detach()
  console.log('Files checks: a dropped file opens, and a drop page script makes opens nothing.')

  // 15. AutoRecover: a copy of a query with unsaved changes (saved now, not in five minutes) survives a renderer crash,
  // whose prompt says so, and the reloaded workbench offers it; Recover Selected opens it with its text, unsaved. Saved
  // again and then killed, the app offers it at the next start, and Discard Selected deletes every copy.
  const recoveryFolder = join(profile, 'AutoRecover')
  const recoverDialog = () => page.getByRole('dialog', { name: 'Recover Unsaved Queries', exact: true })
  /** Runs script in the page through main: Playwright's page for a crashed renderer cannot be used after its reload. */
  const js = source => application.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code).catch(error => 'error: ' + error.message), source)
  const activeTabSelector = part.documentTabs + ' [role="tab"][aria-selected="true"]'
  const checkedRows = () => js(`[...document.querySelectorAll(${JSON.stringify(part.recoveryGrid + ' tbody input')})].filter(box => box.checked).length`)
  /** How many of the kept copies hold `text`. */
  const keptWith = async text => (await Promise.all((await readdir(recoveryFolder)).map(name => readFile(join(recoveryFolder, name), 'utf8')))).filter(content => content.includes(text)).length
  await toolbarButton(page, 'New query').click()
  await textbox().focus()
  await page.keyboard.insertText('SELECT 15 AS recovered')
  await expect(unsavedMark(activeTab())).toHaveCount(1)
  const recovered = await activeTab().getAttribute('aria-label')
  await page.evaluate(() => window.__variaRecovery.flush())
  const kept = (await readdir(recoveryFolder)).length
  expect((await readdir(recoveryFolder)).every(name => /^[0-9a-f-]{36}\.json$/.test(name))).toBe(true)
  expect(await keptWith('SELECT 15 AS recovered')).toBe(1)
  await prompts()
  await queue('answers', 0)
  await crashRenderer(application)
  await expect.poll(prompts, { timeout: 15000 }).toEqual([{
    title: 'Workbench stopped', message: 'The workbench stopped unexpectedly.', buttons: ['Reload', 'Close'],
    detail: 'Queries saved by AutoRecover can be recovered after reloading; changes from the last 5 minutes may be lost. Connections were closed and uncommitted transactions were rolled back.'
  }])
  await expect.poll(() => js(`!!document.querySelector(${JSON.stringify(part.statusBar + ' [title^="SQL backend: fake"]')}) && !!document.querySelector(${JSON.stringify('[role="dialog"] ' + part.recoveryGrid)})`), { timeout: 30000 }).toBe(true)
  const rows = await js(`[...document.querySelectorAll(${JSON.stringify(part.recoveryGrid + ' tbody tr')})].map(row => [...row.cells].slice(1).map(cell => cell.textContent))`)
  expect(rows).toHaveLength(kept)
  const row = rows.find(cells => cells[0] === recovered)
  expect([row[0], row[1], row[3]]).toEqual([recovered, 'Not saved to a file', 'just now'])
  // Only this query: the others stay offered.
  await js("document.querySelector('[aria-label=\"Select all queries\"]').click()")
  await expect.poll(checkedRows).toBe(0)
  await js(`document.querySelector(${JSON.stringify(`[aria-label="Recover ${recovered}"]`)}).click()`)
  await expect.poll(checkedRows).toBe(1)
  await js("[...document.querySelectorAll('[role=\"dialog\"] button')].find(button => button.textContent === 'Recover Selected').click()")
  await expect.poll(() => js(`!document.querySelector(${JSON.stringify(part.recoveryGrid)}) && document.querySelector(${JSON.stringify(activeTabSelector)})?.getAttribute('aria-label')`)).toBe(recovered)
  expect(await js(`!!document.querySelector(${JSON.stringify(activeTabSelector + ' [role="img"][aria-label="Unsaved changes"]')})`)).toBe(true)
  // Monaco draws spaces as no-break spaces.
  const editorText = () => js("document.querySelector('.monaco-editor .view-lines').textContent.replaceAll(String.fromCharCode(160), ' ')")
  await expect.poll(editorText).toContain('SELECT 15 AS recovered')
  console.log('Files checks: after a renderer crash, Workbench stopped mentions AutoRecover, and Recover Selected opens the kept query unsaved.')

  // Changed and saved again by AutoRecover (the copy it took is the reopened query's now), then the app is killed.
  // Typed through main, as Chromium delivers keys to the editor's input element.
  await js("document.querySelector('.monaco-editor [role=\"textbox\"]').focus()")
  await application.evaluate(({ BrowserWindow }) => { const contents = BrowserWindow.getAllWindows()[0].webContents; contents.focus(); for (const keyCode of '-- again ') contents.sendInputEvent({ type: 'char', keyCode }) })
  await expect.poll(editorText).toContain('-- again')
  expect(await js('window.__variaRecovery.flush().then(() => true)')).toBe(true)
  expect(await keptWith('-- again')).toBe(1)
  expect((await readdir(recoveryFolder)).length).toBe(kept)
  const closed = new Promise(done => application.once('close', done))
  application.process().kill('SIGKILL')
  await closed
  application = await electron.launch({ args: ['.'], env, chromiumSandbox })
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  await stubDialogs()
  await expect(recoverDialog()).toBeVisible({ timeout: 30000 })
  await expect(recoverDialog().locator('tbody tr')).toHaveCount(kept)
  await expect(recoverDialog().locator('tbody tr').filter({ hasText: recovered })).toHaveCount(1)
  await recoverDialog().screenshot({ path: resolve('artifacts', 'files-recover-dialog.png') })
  await recoverDialog().getByRole('button', { name: 'Discard Selected', exact: true }).click()
  await expect(recoverDialog().getByRole('alert')).toContainText(`Discard ${kept === 1 ? '1 query' : `${kept} queries`}? This cannot be undone.`)
  await recoverDialog().getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(recoverDialog()).toHaveCount(0)
  expect(await readdir(recoveryFolder)).toEqual([])
  console.log('Files checks: a killed app offers AutoRecover\'s copies at the next start, and Discard Selected deletes them.')
  // A copy the page writes while a reload replaces it (the next query of a flush under way) is that page's: the reloaded
  // workbench offers it. The page's pagehide stands in for the flush, as it runs after the navigation started.
  const late = randomUUID()
  await page.evaluate(id => { addEventListener('pagehide', () => { void window.varia.writeRecovery({ id, name: 'late.sql', kind: 'sql', eol: 'lf', text: 'SELECT 17 AS late' }) }) }, late)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload())
  await expect(recoverDialog()).toBeVisible({ timeout: 30000 })
  await expect(recoverDialog().locator('tbody tr')).toHaveCount(1)
  await expect(recoverDialog().locator('tbody tr').filter({ hasText: 'late.sql' })).toHaveCount(1)
  expect(await readdir(recoveryFolder)).toEqual([late + '.json'])
  expect(await prompts()).toEqual([])
  await recoverDialog().getByRole('button', { name: 'Discard Selected', exact: true }).click()
  await recoverDialog().getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(recoverDialog()).toHaveCount(0)
  expect(await readdir(recoveryFolder)).toEqual([])
  console.log('Files checks: a copy written as a reload replaces the page is offered by the reloaded workbench.')
  // A normal exit (Don't Save) deletes the window's copies before the app quits.
  await toolbarButton(page, 'New query').click()
  await textbox().focus()
  await page.keyboard.insertText('SELECT 16')
  await page.evaluate(() => window.__variaRecovery.flush())
  expect(await readdir(recoveryFolder)).toHaveLength(1)
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  await application.close()
  expect(await readdir(recoveryFolder)).toEqual([])
  console.log('Files checks: a normal exit deletes AutoRecover\'s copies.')

  expect(failures).toEqual([])
  console.log('Files suite passed.')
} catch (error) {
  console.error(error)
  if (page) await page.screenshot({ path: resolve('artifacts', 'files-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  // Unsaved queries make a normal exit ask first; answer Don't Save.
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await application.close().catch(() => application.process()?.kill())
  await chmod(join(folder, 'locked.sql'), 0o644).catch(() => {})
  for (const path of [profile, control, folder]) await rm(path, { recursive: true, force: true }).catch(() => {})
}
