// Files and status bars on the fake backend: encodings and line endings kept on save, the Save as Unicode and Save of
// Read-Only File prompts, Save files with a specific encoding, Save All, the IDE status bar's Ln/Col/Ch, INS/OVR, line ending and encoding, and the query
// status bar with its Options. Native dialogs are stubbed in main, as electron-smoke does; files live under artifacts/.
import { electron, expect } from './fixtures/smoke.mjs'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { codePageName, legacyCodePage } from '../src/main/text-encoding.ts'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'files-profile-'))
const control = await mkdtemp(resolve('artifacts', 'files-control-'))
const folder = await mkdtemp(resolve('artifacts', 'files-documents-'))
await mkdir(join(control, 'hold'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
const windows = process.platform === 'win32', mac = process.platform === 'darwin'
const application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error('Files suite exceeded its time limit.'); application.process()?.kill(); process.exit(1) }, 300_000)
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
const tabs = () => page.locator('.query-tabs').getByRole('tab')
const activeTab = () => page.locator('.query-tab.active')
const footer = () => page.locator('.status-bar .editor-status')
const queryBar = () => page.locator('.query-status-bar')
const banner = () => page.locator('.global-error')
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
  await expect(activeTab().locator('.dirty-dot')).toHaveCount(1)
}
const save = () => page.keyboard.press(mac ? 'Meta+S' : 'Control+S')

try {
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  await stubDialogs()

  // 1. Main has a strict decoder for every ANSI code page Varia reads (Electron's ICU), so no table is bundled.
  const labels = [...new Set(['en-US', 'cs', 'ru', 'el', 'tr', 'he', 'ar', 'lt', 'vi', 'th', 'ja', 'zh-CN', 'zh-TW', 'ko'].map(legacyCodePage))]
  expect(await application.evaluate((_, list) => list.filter(label => { try { new TextDecoder(label, { fatal: true }); return false } catch { return true } }), labels)).toEqual([])
  const locale = await application.evaluate(({ app }) => app.getSystemLocale())
  console.log(`Files checks: main decodes all ${labels.length} ANSI code pages; this system (${locale}) reads legacy files as ${codePageName(legacyCodePage(locale))}.`)

  // 2. A new query: the platform's line ending, UTF-8 (SSMS 22's new-query template has no BOM), insert mode. Ln, Col
  // and Ch follow the caret, a tab counting four columns.
  await expect(footer().locator('.editor-status-eol')).toHaveText(windows ? 'CRLF' : 'LF')
  await expect(footer().locator('.editor-status-encoding')).toHaveText('UTF-8')
  await expect(footer().locator('.editor-status-mode')).toHaveText('INS')
  await textbox().focus()
  await page.keyboard.press(mac ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText('\tSELECT 1')
  await expect(footer().locator('.editor-status-position')).toHaveText('Ln 1Col 13Ch 10')
  await page.keyboard.press('Home')
  await expect(footer().locator('.editor-status-position')).toHaveText('Ln 1Col 5Ch 2')
  // 3. Insert switches to overtype: typing replaces the character after the caret, and Insert switches back.
  if (!mac) {
    await page.keyboard.press('Insert')
    await expect(footer().locator('.editor-status-mode')).toHaveText('OVR')
    await page.keyboard.type('W')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('WELECT')
    await expect(footer().locator('.editor-status-position')).toHaveText('Ln 1Col 6Ch 3')
    await page.keyboard.press('Insert')
    await expect(footer().locator('.editor-status-mode')).toHaveText('INS')
    await page.keyboard.type('X')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('WXELECT')
    console.log('Files checks: Ln/Col/Ch follow the caret with a tab as four columns, and Insert toggles INS and OVR.')
  }

  // 4. A UTF-16 BE file with CRLF keeps its byte order mark, byte order and line endings when saved.
  const bigEndian = join(folder, 'big-endian.sql')
  await writeFile(bigEndian, be("SELECT N'Grüße';\r\nGO\r\n"))
  await open(bigEndian)
  await expect(footer().locator('.editor-status-encoding')).toHaveText('UTF-16 BE')
  await expect(footer().locator('.editor-status-eol')).toHaveText('CRLF')
  await typeAtEnd('SELECT 2;\nGO')
  await save()
  await expect(activeTab().locator('.dirty-dot')).toHaveCount(0)
  expect(await bytes(bigEndian)).toEqual([...be("SELECT N'Grüße';\r\nGO\r\nSELECT 2;\r\nGO")])
  console.log('Files checks: a UTF-16 BE file with CRLF is saved as UTF-16 BE with CRLF.')

  // 5. Mixed line endings open as the most common kind, with a notice, and are saved that way.
  const mixed = join(folder, 'mixed.sql')
  await writeFile(mixed, 'SELECT 1\r\nGO\nSELECT 2\r\n')
  await open(mixed)
  await expect(banner()).toHaveText('Line endings in mixed.sql were mixed; it will be saved with CRLF line endings.')
  await expect(banner()).toHaveClass(/warning/)
  await typeAtEnd('GO')
  await save()
  await expect(activeTab().locator('.dirty-dot')).toHaveCount(0)
  expect(await readFile(mixed, 'utf8')).toBe('SELECT 1\r\nGO\r\nSELECT 2\r\nGO')
  await expect(banner()).toHaveCount(0)

  // 6. A file in the ANSI code page is read, and saved only as UTF-8 with a BOM once the user agrees.
  const legacy = join(folder, 'legacy.sql'), label = legacyCodePage(locale), legacyBytes = [0x2d, 0x2d, 0x20, 0x53, 0xe9, 0x80, 0x0d, 0x0a]
  const legacyText = new TextDecoder(label).decode(Uint8Array.from(legacyBytes))
  await writeFile(legacy, Uint8Array.from(legacyBytes))
  await open(legacy)
  await expect(footer().locator('.editor-status-encoding')).toHaveText(codePageName(label))
  await typeAtEnd('SELECT 1')
  await queue('answers', 1)
  await save()
  await expect.poll(prompts).toEqual([{ title: 'Save as Unicode', message: `legacy.sql was read as ${codePageName(label)}.`, detail: 'Varia SQL Manager saves only Unicode. Save it as UTF-8 with a byte order mark, which SSMS and other tools read correctly?', buttons: ['Save as UTF-8', 'Cancel'] }])
  await expect(activeTab().locator('.dirty-dot')).toHaveCount(1)
  expect(await bytes(legacy)).toEqual(legacyBytes)
  await queue('answers', 0)
  await save()
  await expect(activeTab().locator('.dirty-dot')).toHaveCount(0)
  expect(await bytes(legacy)).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from(legacyText + 'SELECT 1')])
  await expect(footer().locator('.editor-status-encoding')).toHaveText('UTF-8 with BOM')
  expect((await prompts()).map(prompt => prompt.title)).toEqual(['Save as Unicode'])
  console.log(`Files checks: a ${codePageName(label)} file is saved as UTF-8 with a BOM only after Save as Unicode.`)

  // 7. A read-only file: the tab and the status bar say so, Save asks (Save As, Overwrite, Cancel), Cancel writes nothing,
  // and Overwrite clears the attribute and saves. Root can write any file, so cloud sessions skip this step.
  if (process.getuid?.() !== 0) {
    const locked = join(folder, 'locked.sql')
    await writeFile(locked, 'SELECT 1')
    await chmod(locked, 0o444)
    await open(locked)
    await expect(activeTab().locator('.tab-readonly')).toHaveCount(1)
    await expect(activeTab().getByRole('tab')).toHaveAttribute('title', /locked\.sql \(read-only\)$/)
    await expect(footer().locator('.editor-status-readonly')).toHaveText('Read-only')
    await typeAtEnd(' AS one')
    await save()
    const readOnlyPrompt = { title: 'Save of Read-Only File', message: `The file ${locked} cannot be saved because it is write-protected.`,
      detail: 'You can either save the file in a different location or Varia SQL Manager can attempt to remove the write-protection and overwrite the file in its current location.', buttons: ['Save As…', 'Overwrite', 'Cancel'] }
    await expect.poll(prompts).toEqual([readOnlyPrompt])
    expect(await readFile(locked, 'utf8')).toBe('SELECT 1')
    await expect(activeTab().locator('.dirty-dot')).toHaveCount(1)
    await queue('answers', 1)
    await save()
    await expect(activeTab().locator('.dirty-dot')).toHaveCount(0)
    expect(await readFile(locked, 'utf8')).toBe('SELECT 1 AS one')
    await expect(footer().locator('.editor-status-readonly')).toHaveCount(0)
    await expect(activeTab().locator('.tab-readonly')).toHaveCount(0)
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
    await expect(activeTab().locator('.dirty-dot')).toHaveCount(1)
    expect(await writable(lockedLegacy)).toBe(false)
    expect(await bytes(lockedLegacy)).toEqual(legacyBytes)
    const dialogs = await saveDialogs()
    await queue('answers', 0, 0)
    await queue('save', copy)
    await save()
    await expect(activeTab().getByRole('tab')).toHaveAttribute('aria-label', 'locked-copy.sql')
    await expect(activeTab().locator('.dirty-dot')).toHaveCount(0)
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
  await page.getByRole('button', { name: 'New query', exact: true }).click()
  await expect(footer().locator('.editor-status-encoding')).toHaveText('UTF-16 BE')
  await textbox().focus()
  await page.keyboard.insertText('SELECT 5')
  const specific = join(folder, 'specific.sql')
  await queue('save', specific)
  await save()
  await expect(activeTab().getByRole('tab')).toHaveAttribute('aria-label', 'specific.sql')
  expect(await bytes(specific)).toEqual([...be('SELECT 5')])
  await expect(footer().locator('.editor-status-encoding')).toHaveText('UTF-16 BE')
  const converted = join(folder, 'converted.sql')
  await writeFile(converted, Uint8Array.from(legacyBytes))
  await open(converted)
  await expect(footer().locator('.editor-status-encoding')).toHaveText(codePageName(label))
  await typeAtEnd('SELECT 6')
  await save()
  await expect(activeTab().locator('.dirty-dot')).toHaveCount(0)
  expect(await bytes(converted)).toEqual([...be(legacyText + 'SELECT 6')])
  await expect(footer().locator('.editor-status-encoding')).toHaveText('UTF-16 BE')
  expect(await prompts()).toEqual([])
  expect(await page.evaluate(() => window.varia.updateSettings({ 'environment.documents.saveWithSpecificEncoding': null, 'environment.documents.saveEncoding': null }))).toMatchObject({ ok: true })
  await page.getByRole('button', { name: 'New query', exact: true }).click()
  await expect(footer().locator('.editor-status-encoding')).toHaveText('UTF-8')
  await page.keyboard.press(mac ? 'Meta+W' : 'Control+W')
  await expect(activeTab().getByRole('tab')).toHaveAttribute('aria-label', 'converted.sql')
  console.log('Files checks: Save files with a specific encoding labels and saves a new query in its encoding, and converts a legacy file without asking.')

  // 8. Save All (Ctrl+Shift+S, ⌥⌘S) in tab order: the first, untitled query asks for its file, the saved one is saved,
  // and the last, untitled one asks in turn; all end clean.
  await page.locator('.query-tabs').getByRole('tab', { name: 'mixed.sql', exact: true }).click()
  await typeAtEnd('\nSELECT 3')
  await page.getByRole('button', { name: 'New query', exact: true }).click()
  await textbox().focus()
  await page.keyboard.insertText('SELECT 4')
  await expect(activeTab().locator('.dirty-dot')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Save All', exact: true })).toBeEnabled()
  const before = await saveDialogs(), first = join(folder, 'first.sql'), untitled = join(folder, 'untitled.sql')
  await queue('save', first, untitled)
  await page.keyboard.press(mac ? 'Alt+Meta+S' : 'Control+Shift+S')
  await expect(page.locator('.query-tab .dirty-dot')).toHaveCount(0)
  expect(await saveDialogs()).toBe(before + 2)
  expect(await readFile(first, 'utf8')).toBe(mac ? '\tSELECT 1' : '\tWXELECT 1')
  expect(await readFile(mixed, 'utf8')).toBe('SELECT 1\r\nGO\r\nSELECT 2\r\nGO\r\nSELECT 3')
  expect(await readFile(untitled, 'utf8')).toBe('SELECT 4')
  await expect(activeTab().getByRole('tab')).toHaveAttribute('aria-label', 'untitled.sql')
  await expect(page.getByRole('button', { name: 'Save All', exact: true })).toBeDisabled()
  console.log('Files checks: Save All saves every changed query in tab order, asking for each untitled one\'s file in turn.')

  // 9. The query status bar: below the query, SSMS's state sentence, then server (version), login (SPID), database,
  // elapsed time and rows; the Options place it on top and switch segments off.
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByLabel('Server Name', { exact: true }).fill('server-a')
  await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(queryBar()).toHaveAttribute('role', 'status')
  await expect(queryBar().locator('.query-status-text')).toHaveText('Connected.')
  await textbox().focus()
  await page.keyboard.press(mac ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText('-- varia-fake: sets=W1*10')
  await page.keyboard.press('F5')
  await expect(queryBar().locator('.query-status-text')).toHaveText('Query executed successfully.')
  await expect(queryBar()).toHaveAttribute('data-tone', 'ready')
  await expect(queryBar().locator('.query-status-server')).toHaveText('Server: server-a (16.0)')
  await expect(queryBar().locator('.query-status-login')).toHaveText(/^Login: fake \(\d+\)$/)
  await expect(queryBar().locator('.query-status-database')).toHaveText('Database: master')
  await expect(queryBar().locator('.query-status-time')).toHaveText(/^Elapsed time: \d\d:\d\d:\d\d$/)
  await expect(queryBar().locator('.query-status-rows')).toHaveText('Rows: 10 rows')
  const order = () => page.locator('main.workspace').evaluate(main => [...main.children].map(child => child.classList.contains('query-status-bar') ? 'bar' : child.classList.contains('editor-container') ? 'editor' : 'tabs'))
  expect(await order()).toEqual(['tabs', 'editor', 'bar'])
  expect(await page.evaluate(() => window.varia.updateSettings({ 'textEditor.statusBar.location': 'top', 'textEditor.statusBar.showRowCount': false, 'textEditor.statusBar.showLogin': false }))).toMatchObject({ ok: true })
  await expect(queryBar()).toHaveAttribute('data-location', 'top')
  expect(await order()).toEqual(['tabs', 'bar', 'editor'])
  await expect(queryBar().locator('.query-status-segment')).toHaveCount(3)
  await expect(queryBar().locator('.query-status-rows')).toHaveCount(0)
  expect(await page.evaluate(() => window.varia.updateSettings({ 'textEditor.statusBar.location': null, 'textEditor.statusBar.showRowCount': null, 'textEditor.statusBar.showLogin': null }))).toMatchObject({ ok: true })
  await expect(queryBar().locator('.query-status-segment')).toHaveCount(5)
  expect(await order()).toEqual(['tabs', 'editor', 'bar'])
  await page.locator('.query-status-bar').screenshot({ path: resolve('artifacts', 'files-query-status.png') })
  await page.locator('.status-bar').screenshot({ path: resolve('artifacts', 'files-status-bar.png') })
  console.log('Files checks: the query status bar shows SSMS\'s segments below the query, and its Options move it and switch segments off.')

  // 10. In a small window a long server name gives way first, and the database stays whole; a 127-character database
  // name gives way too (both whole in the tooltip), while the time and rows always stay whole inside the bar.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 700))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024)
  const longServer = 'sqlprod-analytics-warehouse-cluster-01.' + 'reporting-'.repeat(6) + 'corp.contoso.com\\INSTANCE01', longDatabase = 'Warehouse_'.repeat(12) + 'Archive'
  /** Connects to the long server (a new query on it) and runs a query there. */
  async function connectAndRun(database) {
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await page.getByLabel('Server Name', { exact: true }).fill(longServer)
    await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await page.getByLabel('Database Name', { exact: true }).fill(database)
    await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(queryBar().locator('.query-status-database')).toHaveText(`Database: ${database || 'master'}`)
    await textbox().focus()
    await page.keyboard.insertText('-- varia-fake: sets=W1*10')
    await page.keyboard.press('F5')
    await expect(queryBar().locator('.query-status-rows')).toHaveText('Rows: 10 rows')
    await expect(queryBar()).toHaveAttribute('title', new RegExp(`\\| ${database || 'master'}(\\n|$)`))
  }
  /** Which segments lie inside the bar, and which show their whole text. */
  const layout = () => page.evaluate(() => {
    const bar = document.querySelector('.query-status-bar').getBoundingClientRect()
    const part = name => document.querySelector(`.query-status-${name}`)
    const inside = element => { const box = element.getBoundingClientRect(); return box.left >= bar.left - 0.5 && box.right <= bar.right + 0.5 }
    const whole = element => element.scrollWidth <= element.clientWidth
    return { inside: ['state', 'server', 'login', 'database', 'time', 'rows'].every(name => inside(part(name))), whole: ['server', 'login', 'database', 'time', 'rows'].filter(name => whole(part(name))), page: document.documentElement.scrollWidth <= innerWidth }
  })
  await connectAndRun('')
  expect(await layout()).toEqual({ inside: true, whole: ['login', 'database', 'time', 'rows'], page: true })
  await connectAndRun(longDatabase)
  expect(await layout()).toEqual({ inside: true, whole: ['time', 'rows'], page: true })
  await queryBar().screenshot({ path: resolve('artifacts', 'files-query-status-small.png') })
  console.log('Files checks: in a small window the server, then the login and database, give way in the query status bar, and the time and rows stay whole.')

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
