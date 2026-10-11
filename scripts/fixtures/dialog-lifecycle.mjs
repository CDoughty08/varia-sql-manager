// Main's dialogs across the page's lifecycle (menus-smoke.mjs step 16), in three fresh apps on the fake backend, each
// with its own profile: Restart SQL Backend asked for twice restarts once; a renderer crash while Save Grid Results is
// open waits for it before its prompt, and drops the dead page's queued Script As save without showing it; a crash
// while the page's Unsaved query prompt is open closes that prompt, and the crash prompt follows at once; a reload asks
// first (Cancel keeps the page, Reload reloads it); a quit while a Script As File… waits behind Save Grid Results exits
// once the dialogs are answered; and a quit while the reload prompt is open, answered Reload, still exits.
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { electron, expect } from './smoke.mjs'
import { expandExplorerPath, explorerRow } from './explorer-tree.mjs'

const createScript = 'CREATE TABLE dbo.Orders (Id int);'
const wait = ms => new Promise(done => setTimeout(done, ms))
const exists = path => access(path).then(() => true, () => false)

/** Mocks main's dialogs, recording each as it is shown with how many are open. Save Grid Results stays open until
 *  released; other saves choose `path`; Restart is answered after 300 ms; the crash prompt Reload; the reload prompt
 *  `globalThis.variaReloadAnswer`; every other prompt its second button (Don't Save, Cancel). A message box titled in
 *  `hold` stays open until answer() or, as Electron's does, until its signal aborts it (it then answers its cancelId and
 *  is listed in `globalThis.variaAborted`). */
async function mockDialogs(application, path, hold = []) {
  await application.evaluate(({ dialog }, [filePath, held]) => {
    const log = globalThis.variaDialogs = [], { appendFileSync } = process.getBuiltinModule('node:fs')
    const answers = globalThis.variaAnswers = {}, aborted = globalThis.variaAborted = []
    let open = 0
    const track = async (options, answer) => {
      log.push({ title: options.title, open: ++open })
      // Kept on disk too, for after the app has quit.
      appendFileSync(filePath + '.dialogs', options.title + '\n')
      try { return await answer() } finally { open-- }
    }
    dialog.showSaveDialog = (_window, options) => track(options, async () => {
      if (options.title !== 'Save Grid Results') return { canceled: false, filePath }
      await new Promise(done => { globalThis.variaReleaseGridSave = done })
      return { canceled: true, filePath: '' }
    })
    dialog.showOpenDialog = (_window, options) => track(options, async () => ({ canceled: true, filePaths: [] }))
    dialog.showMessageBox = (_window, options) => track(options, async () => {
      if (held.includes(options.title)) {
        return new Promise(resolve => {
          answers[options.title] = response => resolve({ response, checkboxChecked: false })
          options.signal?.addEventListener('abort', () => { aborted.push(options.title); resolve({ response: options.cancelId, checkboxChecked: false }) })
        })
      }
      if (options.title === 'Restart SQL backend') { await new Promise(done => setTimeout(done, 300)); return { response: 0, checkboxChecked: false } }
      if (options.title === 'Reload workbench') return { response: globalThis.variaReloadAnswer ?? 1, checkboxChecked: false }
      return { response: options.title === 'Workbench stopped' ? 0 : 1, checkboxChecked: false }
    })
  }, [path, hold])
}
const shown = application => application.evaluate(() => globalThis.variaDialogs.map(entry => entry.title))
/** Answers a held message box, as a person would; false when it is not open (it was aborted, or never shown). */
const answer = (application, title, response) => application.evaluate((_electron, [name, value]) => {
  const reply = globalThis.variaAnswers[name]
  delete globalThis.variaAnswers[name]
  reply?.(value)
  return !!reply
}, [title, response])
const crash = application => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
// Electron turns SIGTERM into app.quit() on Linux and macOS. On Windows Playwright starts Electron through cmd.exe, so the
// child is that shell and kill() terminates only it: main is asked to quit instead. The child still exits with the app.
const quit = (application, child) => process.platform === 'win32'
  ? application.evaluate(({ app }) => { setImmediate(() => app.quit()) })
  : child.kill('SIGTERM')

async function launch(launchOptions, name) {
  const profile = await mkdtemp(resolve('artifacts', `menus-${name}-profile-`)), control = await mkdtemp(resolve('artifacts', `menus-${name}-backend-`))
  const env = { ...launchOptions.env, VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND_DIR: control }
  const application = await electron.launch({ ...launchOptions, env })
  const child = application.process()
  const page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // A blocked unload is Electron's to answer (main's reload prompt). Playwright reports it as a dialog too, and with no
  // listener would try to answer it as well, after Electron has.
  page.on('dialog', () => {})
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  const cleanup = async () => {
    await Promise.race([application.close(), wait(10000)]).catch(() => {})
    child.kill()
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    await rm(control, { recursive: true, force: true }).catch(() => {})
  }
  return { application, child, page, profile, control, errors, cleanup }
}

async function connect(page) {
  await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await dialog.getByLabel('Server Name', { exact: true }).fill('server-a')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** Results on server-a with Save Grid Results open over them, and a Script As File… whose save dialog waits behind it
 *  (the page is busy with it). The typed script leaves the query unsaved. */
async function holdSaveWithScriptWaiting(application, page) {
  await page.getByLabel('Query server', { exact: true }).selectOption({ label: 'server-a' })
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('-- varia-fake: sets=W1*10')
  await page.keyboard.press('F5')
  await expect(page.locator('.output-status')).toContainText(/^Query executed successfully/)
  await page.locator('[data-result-grid] .rg-row[aria-rowindex="2"] .rg-c[aria-colindex="2"]').first().click()
  await page.keyboard.press('Control+S')
  await expect.poll(() => shown(application)).toEqual(['Save Grid Results'])
  const ordersPath = ['server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders']
  await expandExplorerPath(page, ...ordersPath.slice(0, -1))
  await (await explorerRow(page, ...ordersPath)).click({ button: 'right', force: true })
  const menu = name => page.getByRole('menu', { name, exact: true })
  await menu('Object Explorer').getByRole('menuitem', { name: 'Script Table as', exact: true }).click({ force: true })
  await menu('Script Table as').getByRole('menuitem', { name: 'CREATE To', exact: true }).click({ force: true })
  await menu('CREATE To').getByRole('menuitem', { name: 'File…', exact: true }).click({ force: true })
  await expect(page.locator('.toolbar').getByRole('button', { name: 'Open', exact: true })).toBeDisabled()
}

export async function dialogLifecycle(launchOptions) {
  // A: Restart twice, then a crash.
  let run = await launch(launchOptions, 'crash')
  try {
    const { application, page, profile, control, errors } = run
    const scriptFile = join(profile, 'from-crashed-page.sql')
    await mockDialogs(application, scriptFile)
    await connect(page)
    // A double-click on Restart (or the command twice) asks once and starts one backend; the count is taken when the
    // prompt's turn comes.
    const spawns = async () => (await readFile(join(control, 'spawns.jsonl'), 'utf8')).trim().split('\n').length
    const before = await spawns()
    expect(await page.evaluate(() => Promise.all([window.varia.restartBackend(), window.varia.restartBackend()]))).toEqual([{ ok: true, value: true }, { ok: true, value: true }])
    await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
    await wait(500)
    expect({ prompts: await shown(application), spawned: await spawns() - before }).toEqual({ prompts: ['Restart SQL backend'], spawned: 1 })
    await mockDialogs(application, scriptFile)
    await page.locator('.explorer-row.lost').getByRole('button', { name: /^Reconnect/ }).click()
    const reconnect = page.getByRole('dialog', { name: 'Connect', exact: true })
    await reconnect.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(reconnect).toHaveCount(0)
    await holdSaveWithScriptWaiting(application, page)
    // Closing while the workbench does not respond asks first, but after the open dialog; the workbench recovers.
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.emit('unresponsive'); window.close() })
    await wait(500)
    expect(await shown(application)).toEqual(['Save Grid Results'])
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('responsive') })
    // The renderer crashes while Save Grid Results is open: the crash prompt waits for it rather than opening over it,
    // and what the dead page asked for and was not shown yet (the Script As save, the close prompt) never is.
    await crash(application)
    await wait(1000)
    expect(await shown(application)).toEqual(['Save Grid Results'])
    await application.evaluate(() => globalThis.variaReleaseGridSave())
    await expect.poll(() => shown(application), { timeout: 15000 }).toEqual(['Save Grid Results', 'Workbench stopped'])
    // Reload: the new page's File › Open opens at once, alone; no file is written for the page that crashed.
    const js = source => application.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code).catch(error => 'error: ' + error.message), source)
    await expect.poll(() => js("document.body.innerText.includes('fake · Ready') && !!document.querySelector('.monaco-editor')"), { timeout: 30000 }).toBe(true)
    await js('void window.varia.openSqlFiles(); 0')
    await expect.poll(() => shown(application)).toEqual(['Save Grid Results', 'Workbench stopped', 'Open SQL query'])
    await wait(500)
    expect(await application.evaluate(() => globalThis.variaDialogs)).toEqual([
      { title: 'Save Grid Results', open: 1 }, { title: 'Workbench stopped', open: 1 }, { title: 'Open SQL query', open: 1 }
    ])
    expect(await exists(scriptFile)).toBe(false)
    // A message box the page asked for is closed when the page crashes (a file chooser cannot be): the crash prompt
    // follows at once instead of waiting for an answer that page can no longer use.
    await expect.poll(() => js("document.body.innerText.includes('fake · Ready') && !!document.querySelector('.monaco-editor')"), { timeout: 30000 }).toBe(true)
    await mockDialogs(application, scriptFile, ['Unsaved query'])
    await js("void window.varia.confirmClose('Query 1.sql'); 0")
    await expect.poll(() => shown(application)).toEqual(['Unsaved query'])
    await crash(application)
    await expect.poll(() => shown(application), { timeout: 5000 }).toEqual(['Unsaved query', 'Workbench stopped'])
    expect(await application.evaluate(() => ({ dialogs: globalThis.variaDialogs, aborted: globalThis.variaAborted }))).toEqual({
      dialogs: [{ title: 'Unsaved query', open: 1 }, { title: 'Workbench stopped', open: 1 }], aborted: ['Unsaved query']
    })
    await expect.poll(() => js("document.body.innerText.includes('fake · Ready') && !!document.querySelector('.monaco-editor')"), { timeout: 30000 }).toBe(true)
    expect(errors).toEqual([])
  } finally { await run.cleanup() }

  // B: a quit (SIGTERM, which Electron turns into app.quit; app.quit itself on Windows) while the Script As save waits:
  // the app stays until the dialogs are answered, then saves the script, asks about the unsaved query (Don't Save), and
  // exits. A close asked for while the workbench did not respond, which has recovered by its turn, closes as usual
  // instead of asking.
  run = await launch(launchOptions, 'quit')
  try {
    const { application, child, page, profile, errors } = run
    const scriptFile = join(profile, 'dbo.Orders.sql')
    await mockDialogs(application, join(profile, 'reload.sql'))
    await connect(page)
    // With a server connected, a reload asks first: Cancel keeps the page, and Reload (answered at once) reloads it.
    const reload = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload())
    const marked = () => page.evaluate(() => window.variaBeforeReload === true).catch(() => false)
    await page.evaluate(() => { window.variaBeforeReload = true })
    await reload()
    await expect.poll(() => shown(application)).toEqual(['Reload workbench'])
    await wait(500)
    expect(await marked()).toBe(true)
    await application.evaluate(() => { globalThis.variaReloadAnswer = 0 })
    await reload()
    await expect.poll(marked, { timeout: 15000 }).toBe(false)
    expect(await shown(application)).toEqual(['Reload workbench', 'Reload workbench'])
    await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
    await mockDialogs(application, scriptFile)
    await connect(page)
    await holdSaveWithScriptWaiting(application, page)
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.emit('unresponsive'); window.close(); window.emit('responsive') })
    let exited = false
    child.once('exit', () => { exited = true })
    await quit(application, child)
    await wait(1500)
    expect({ exited, shown: await shown(application) }).toEqual({ exited: false, shown: ['Save Grid Results'] })
    await application.evaluate(() => globalThis.variaReleaseGridSave())
    await expect.poll(() => exited, { timeout: 30000 }).toBe(true)
    expect(await readFile(scriptFile, 'utf8')).toBe(createScript)
    expect((await readFile(scriptFile + '.dialogs', 'utf8')).trim().split('\n')).toEqual(['Save Grid Results', 'Save SQL query', 'Unsaved query'])
    expect(errors).toEqual([])
  } finally { await run.cleanup() }

  // C: a quit (as in B) while the reload prompt is open with a query unsaved. Its Unsaved query prompt waits behind the
  // reload prompt, which is answered Reload: that prompt belongs to the page that reloads, so main closes it then and
  // hands the quit to the new page, which has nothing unsaved, so the app exits. A person who still sees the prompt a
  // moment later answers Don't Save, which on its own would not exit: that page is gone.
  run = await launch(launchOptions, 'reload-quit')
  try {
    const { application, child, page, profile, errors } = run
    const dialogs = join(profile, 'reload-quit')
    await mockDialogs(application, dialogs, ['Reload workbench', 'Unsaved query'])
    await page.locator('.monaco-editor [role="textbox"]').focus()
    await page.keyboard.insertText('SELECT 1 -- unsaved')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload())
    await expect.poll(() => shown(application)).toEqual(['Reload workbench'])
    let exited = false
    child.once('exit', () => { exited = true })
    await quit(application, child)
    await wait(1000)
    expect({ exited, shown: await shown(application) }).toEqual({ exited: false, shown: ['Reload workbench'] })
    expect(await answer(application, 'Reload workbench', 0)).toBe(true)
    await wait(2000)
    if (!exited) await answer(application, 'Unsaved query', 1).catch(() => false)
    await expect.poll(() => exited, { timeout: 30000 }).toBe(true)
    expect((await readFile(dialogs + '.dialogs', 'utf8')).trim().split('\n')).toEqual(['Reload workbench', 'Unsaved query'])
    expect(errors).toEqual([])
  } finally { await run.cleanup() }
}
