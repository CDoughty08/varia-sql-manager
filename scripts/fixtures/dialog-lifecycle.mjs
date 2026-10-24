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
import { anyResultGrid, editorTextbox, gridCell, lostServerRows, outputStatus, queryServer, toolbarButton } from './ui.mjs'

const createScript = 'CREATE TABLE dbo.Orders (Id int);'
const wait = ms => new Promise(done => setTimeout(done, ms))
const exists = path => access(path).then(() => true, () => false)

/** Mocks main's dialogs, recording each as it is shown with how many are open. Save Grid Results stays open until
 *  released; other saves choose `path`; Restart is answered after 300 ms; the crash prompt Reload; the reload prompt
 *  `globalThis.variaReloadAnswer`; every other prompt its second button (Don't Save, Cancel). A message box titled in
 *  `hold` stays open until answer() or, as Electron's does, until its signal aborts it (it then answers its cancelId and
 *  is listed in `globalThis.variaAborted`). */
async function mockDialogs(application, path, hold = []) {
  await application.evaluate(({ BrowserWindow, dialog, ipcMain }, [filePath, held]) => {
    const log = globalThis.variaDialogs = [], { appendFileSync } = process.getBuiltinModule('node:fs')
    const answers = globalThis.variaAnswers = {}, aborted = globalThis.variaAborted = []
    if (!globalThis.variaObservingCommands) {
      globalThis.variaObservingCommands = true
      // Main's listener runs first. A rendered workbench can precede its command subscription's IPC, which main's
      // close guard needs before it can ask that page about unsaved queries.
      ipcMain.on('varia:commands-ready', (event, ready) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents
        if (contents && event.sender === contents && event.senderFrame === contents.mainFrame) globalThis.variaCommandsReady = ready === true
      })
    }
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
const crash = application => application.evaluate(({ BrowserWindow }) => {
  const contents = BrowserWindow.getAllWindows()[0].webContents
  globalThis.variaCommandsReady = false
  if (process.platform !== 'linux') { contents.forcefullyCrashRenderer(); return }
  // Electron's Linux API sends crash IPC to the renderer's IO thread; CI observed that process still alive afterward.
  // These checks need an exited renderer before testing dialog invalidation, so terminate its known OS process.
  const pid = contents.getOSProcessId()
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('The renderer has no OS process to terminate.')
  process.kill(pid, 'SIGKILL')
})
export { crash as crashRenderer, crashAndAwaitLoss as crashRendererAndAwaitLoss }
/** Native crash state for CI diagnostics, including Linux zombies which still answer signal 0. */
const rendererSnapshot = (application, previousPid = 0) => application.evaluate(({ BrowserWindow }, previous) => {
  const contents = BrowserWindow.getAllWindows()[0]?.webContents
  if (contents && !globalThis.variaNativeLosses) {
    globalThis.variaNativeLosses = []
    contents.on('render-process-gone', (_event, details) => globalThis.variaNativeLosses.push(details))
  }
  const pid = contents && !contents.isDestroyed() ? contents.getOSProcessId() : 0
  const observed = pid || previous
  let alive = false, state
  if (observed) {
    try { process.kill(observed, 0); alive = true } catch {}
    if (process.platform === 'linux') {
      try { state = process.getBuiltinModule('node:fs').readFileSync(`/proc/${observed}/status`, 'utf8').match(/^State:\s*(.+)$/m)?.[1] } catch {}
    }
  }
  return { pid, observed, alive, state, crashed: contents?.isCrashed(), destroyed: contents?.isDestroyed(), losses: globalThis.__variaTest.rendererLosses, nativeLosses: globalThis.variaNativeLosses }
}, previousPid)
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
  await toolbarButton(page, 'Connect').click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await dialog.getByLabel('Server Name', { exact: true }).fill('server-a')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** Results on server-a with Save Grid Results open over them, and a Script As File… whose save dialog waits behind it
 *  (the page is busy with it). The typed script leaves the query unsaved. */
async function holdSaveWithScriptWaiting(application, page) {
  await queryServer(page).selectOption({ label: 'server-a' })
  await editorTextbox(page).focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('-- varia-fake: sets=W1*10')
  await page.keyboard.press('F5')
  await expect(outputStatus(page)).toContainText(/^Query executed successfully/)
  await gridCell(anyResultGrid(page), 0, 0).first().click()
  await page.keyboard.press('Control+S')
  await expect.poll(() => shown(application)).toEqual(['Save Grid Results'])
  const ordersPath = ['server-a', 'Databases', 'AppData', 'Tables', 'dbo.Orders']
  await expandExplorerPath(page, ...ordersPath.slice(0, -1))
  await (await explorerRow(page, ...ordersPath)).click({ button: 'right', force: true })
  const menu = name => page.getByRole('menu', { name, exact: true })
  await menu('Object Explorer').getByRole('menuitem', { name: 'Script Table as', exact: true }).click({ force: true })
  await menu('Script Table as').getByRole('menuitem', { name: 'CREATE To', exact: true }).click({ force: true })
  await menu('CREATE To').getByRole('menuitem', { name: 'File…', exact: true }).click({ force: true })
  await expect(toolbarButton(page, 'Open')).toBeDisabled()
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
    await lostServerRows(page).getByRole('button', { name: /^Reconnect/ }).click()
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
    const beforeCrash = await spawns()
    const beforeLoss = (await rendererLosses(application)).length
    const beforeRenderer = await rendererSnapshot(application)
    await crash(application)
    // Requesting the crash returns before Chromium reports it (or the watchdog observes it). Keep the file
    // chooser open until main has handled that loss; shared runners can take longer than a fixed one-second delay.
    try {
      await expect.poll(async () => (await rendererLosses(application)).slice(beforeLoss).some(loss => loss.handled), { timeout: 15000 }).toBe(true)
    } catch (error) {
      console.error('Renderer loss was not handled: ' + JSON.stringify({ before: beforeRenderer, after: await rendererSnapshot(application, beforeRenderer.pid) }))
      throw error
    }
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
    // The crash restarted the backend once; the reload after it must not restart it again. On Windows a backend spawned
    // while Chromium launches the new renderer holds that renderer's channel, and the renderer's next crash goes unseen.
    expect(await spawns() - beforeCrash).toBe(1)
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
    await editorTextbox(page).focus()
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

const onWindows = process.platform === 'win32'
const rendererLosses = application => application.evaluate(() => globalThis.__variaTest.rendererLosses)
const windowIdsOf = application => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.id))
// A renderer only the watchdog saw go never answers, so each script gets a second.
const workbenchReady = application => application.evaluate(({ BrowserWindow }) => {
  const contents = BrowserWindow.getAllWindows()[0]?.webContents
  if (!contents || contents.isCrashed() || !globalThis.variaCommandsReady) return false
  const script = contents.executeJavaScript("document.body.innerText.includes('fake · Ready') && !!document.querySelector('.monaco-editor')").catch(() => false)
  return Promise.race([script, new Promise(resolve => setTimeout(resolve, 1000, false))])
})
/** Fences one crash before another can target its recovered renderer; keeps native state if main misses the loss. */
async function crashAndAwaitLoss(application, stage, lossIndex) {
  const before = await rendererSnapshot(application)
  const losing = lossIndex ?? before.losses.length
  await crash(application)
  try {
    await expect.poll(async () => (await rendererLosses(application))[losing], { timeout: 15000 }).toMatchObject({ handled: true })
  } catch (error) {
    const after = await rendererSnapshot(application, before.pid).catch(snapshotError => ({ unavailable: snapshotError.message }))
    console.error(`Renderer watchdog loss was not handled (${stage}): ` + JSON.stringify({ losing, before, after }))
    throw error
  }
  return losing
}
/** A crash Chromium sees, answered Reload (the crash prompt is held); the reload launches the renderer `holder` takes. */
async function crashToHolder(application, holder) {
  await application.evaluate((_electron, kind) => globalThis.__variaTest.holdNextRenderer(kind), holder)
  await crashAndAwaitLoss(application, `setup held ${holder}`)
  await expect.poll(() => answer(application, 'Workbench stopped', 0), { timeout: 15000 }).toBe(true)
  await expect.poll(() => workbenchReady(application), { timeout: 30000 }).toBe(true)
}
/** Crashes the held renderer; returns who saw it go once its crash prompt (held) is open. */
async function crashHeldRenderer(application) {
  const losing = await crashAndAwaitLoss(application, 'held renderer')
  await expect.poll(() => application.evaluate(() => 'Workbench stopped' in globalThis.variaAnswers), { timeout: 15000 }).toBe(true)
  return (await rendererLosses(application))[losing].source
}

/** Records Chromium's report and whether it was still blind when recovery created a replacement window. The file also
 *  survives a pending quit, whose recovered page exits before Playwright can inspect it. */
const observeRecovery = (application, file) => application.evaluate(({ app, BrowserWindow }, path) => {
  globalThis.variaStopObservingRecovery?.()
  const contents = BrowserWindow.getAllWindows()[0].webContents
  const { appendFileSync } = process.getBuiltinModule('node:fs')
  const record = value => appendFileSync(path, JSON.stringify(value) + '\n')
  const nativeLoss = (_event, details) => { if (details.reason !== 'clean-exit') record({ kind: 'event' }) }
  const replacement = () => record({ kind: 'replacement', nativeSeen: contents.isCrashed() })
  contents.on('render-process-gone', nativeLoss)
  app.on('browser-window-created', replacement)
  globalThis.variaStopObservingRecovery = () => {
    contents.off('render-process-gone', nativeLoss)
    app.off('browser-window-created', replacement)
  }
}, file)
const recoveryRecords = async file => (await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
/** Same-window reload needs Chromium's report; replacement must occur while only the watchdog knows the process died. */
function recoveryReplaced(records, source) {
  const replaced = records[0]?.kind === 'replacement'
  expect(records).toEqual([
    ...replaced ? [{ kind: 'replacement', nativeSeen: false }] : [],
    ...records.some(record => record.kind === 'event') ? [{ kind: 'event' }] : []
  ])
  if (replaced) expect(source).toBe('watchdog')
  else expect(records).toEqual([{ kind: 'event' }])
  return replaced
}

/**
 * The renderer watchdog (menus-smoke.mjs step 16), in fresh apps on the fake backend. A process spawned as the reload
 * after a crash launches the new renderer inherits that renderer's channel on Windows, so the renderer's own crash
 * raises no render-process-gone: only main's watchdog sees it, and it shows the crash prompt once. With the backend as
 * the holder (as when a backend restart coincided with the launch), the prompt's reset ends that backend, Chromium then
 * reports the crash too (main ignores it), and Reload reloads the page. An idle process that never lets go leaves
 * Chromium blind for good, so Reload opens the workbench in a new window instead, which takes over a quit the lost page
 * could not finish; and Close closes the window at once instead of waiting for an unload the dead renderer never
 * answers. Linux may also leave an unseen zombie renderer; recovery follows Chromium's observed report there too.
 */
export async function rendererWatchdog(launchOptions) {
  const run = await launch(launchOptions, 'watchdog')
  try {
    const { application, child, profile, errors } = run
    await mockDialogs(application, join(profile, 'watchdog'))
    const losses = () => rendererLosses(application), windowIds = () => windowIdsOf(application), ready = () => workbenchReady(application)
    for (const holder of ['backend', 'process']) {
      // The spawn races Chromium's launch; it has always won on Windows so far, but a lost race (Chromium sees the crash
      // itself) is tried again rather than taken for a pass. Without the watchdog a won race gets no prompt at all.
      let unseen = false
      for (let attempt = 1; attempt <= 3 && !unseen; attempt++) {
        // Chromium sees this crash; the reload after it launches the renderer the holder takes.
        await application.evaluate((_electron, kind) => globalThis.__variaTest.holdNextRenderer(kind), holder)
        await crashAndAwaitLoss(application, `setup ${holder} attempt ${attempt}`)
        await expect.poll(ready, { timeout: 30000 }).toBe(true)
        const [losing, prompts, [before]] = [(await losses()).length, (await shown(application)).length, await windowIds()]
        const recoveryFile = join(profile, `recovery-${holder}-${attempt}.jsonl`)
        await observeRecovery(application, recoveryFile)
        await crashAndAwaitLoss(application, `${holder} attempt ${attempt}`, losing)
        await expect.poll(() => shown(application), { timeout: 15000 }).toHaveLength(prompts + 1)
        // Reload: in place once Chromium has seen the crash too, or in a new window when it never does.
        await expect.poll(ready, { timeout: 30000 }).toBe(true)
        unseen = (await losses())[losing].source === 'watchdog'
        const released = holder === 'process' ? await application.evaluate(() => globalThis.__variaTest.releaseHolders()) : 0
        await application.evaluate(() => globalThis.variaStopObservingRecovery())
        if (onWindows && !unseen) { console.log(`Renderer watchdog: Chromium saw the ${holder} holder's crash itself (attempt ${attempt}); trying again.`); continue }
        const replaced = recoveryReplaced(await recoveryRecords(recoveryFile), (await losses())[losing].source)
        expect({ windows: (await windowIds()).map(id => id === before ? 'same' : 'new'), prompts: (await shown(application)).slice(prompts), released })
          .toEqual({ windows: [onWindows ? unseen && holder === 'process' ? 'new' : 'same' : replaced ? 'new' : 'same'], prompts: ['Workbench stopped'], released: holder === 'process' ? 1 : 0 })
        const reported = (await losses()).slice(losing)
        expect(reported).toEqual(onWindows
          ? holder === 'backend' ? [{ source: 'watchdog', handled: true }, { source: 'event', handled: false }] : [{ source: 'watchdog', handled: true }]
          : [{ source: unseen ? 'watchdog' : 'event', handled: true }, ...unseen && reported.length > 1 ? [{ source: 'event', handled: false }] : []])
        unseen = true
      }
      expect(unseen, `a crash Chromium could not see, held by the ${holder}`).toBe(true)
    }
    expect(errors).toEqual([])
    // Close in the crash prompt: the window goes within seconds and, as the last window (outside macOS), ends the app.
    let exited = false
    child.once('exit', () => { exited = true })
    await mockDialogs(application, join(profile, 'watchdog'), ['Workbench stopped'])
    let closed = false
    for (let attempt = 1; attempt <= 3 && !closed; attempt++) {
      await crashToHolder(application, 'process')
      const source = await crashHeldRenderer(application)
      if (onWindows && source !== 'watchdog') {
        console.log(`Renderer watchdog: Chromium saw the crash before Close itself (attempt ${attempt}); trying again.`)
        expect(await answer(application, 'Workbench stopped', 0)).toBe(true)
        await expect.poll(ready, { timeout: 30000 }).toBe(true)
        await application.evaluate(() => globalThis.__variaTest.releaseHolders())
        continue
      }
      expect(await answer(application, 'Workbench stopped', 1)).toBe(true)
      if (process.platform === 'darwin') await expect.poll(windowIds, { timeout: 10000 }).toEqual([])
      else await expect.poll(() => exited, { timeout: 10000 }).toBe(true)
      closed = true
    }
    expect(closed, 'Close after a crash Chromium could not see').toBe(true)
  } finally { await run.cleanup() }

  // A quit the page could not finish (its Unsaved query prompt was open when its renderer went) goes to the next page,
  // in the new window too: that page has nothing unsaved, so the app exits. The prompt the lost page asked for closes.
  let handedOver = false
  for (let attempt = 1; attempt <= 3 && !handedOver; attempt++) {
    const quitRun = await launch(launchOptions, 'watchdog-quit')
    try {
      const { application, child, profile, errors } = quitRun
      const dialogs = join(profile, 'watchdog-quit')
      await mockDialogs(application, dialogs, ['Workbench stopped', 'Unsaved query'])
      await crashToHolder(application, 'process')
      await observeRecovery(application, dialogs + '.recovery')
      // Playwright gives up on a page whose renderer crashed, so the query is typed through Electron.
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("(() => { const input = document.querySelector('.monaco-editor [role=\"textbox\"]'); input?.focus(); return !!input && document.activeElement === input })()")), { timeout: 15000 }).toBe(true)
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.insertText('SELECT 1 -- unsaved'))
      // insertText resolves before Monaco has necessarily applied the input. A clean document would let quit finish,
      // so wait for both the edit and the document's accessible dirty mark before testing its pending close prompt.
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("document.querySelector('.monaco-editor .view-lines')?.textContent?.replaceAll('\\u00a0', ' ').includes('SELECT 1 -- unsaved') && !!document.querySelector('[role=\"img\"][aria-label=\"Unsaved changes\"]')")), { timeout: 15000 }).toBe(true)
      let exited = false
      child.once('exit', () => { exited = true })
      await quit(application, child)
      await expect.poll(() => shown(application)).toEqual(['Workbench stopped', 'Unsaved query'])
      const source = await crashHeldRenderer(application)
      if (onWindows && source !== 'watchdog') { console.log(`Renderer watchdog: Chromium saw the crash during a quit itself (attempt ${attempt}); trying again.`); continue }
      expect(await application.evaluate(() => globalThis.variaAborted)).toEqual(['Unsaved query'])
      expect(await answer(application, 'Workbench stopped', 0)).toBe(true)
      await expect.poll(() => exited, { timeout: 30000 }).toBe(true)
      expect((await readFile(dialogs + '.dialogs', 'utf8')).trim().split('\n')).toEqual(['Workbench stopped', 'Unsaved query', 'Workbench stopped'])
      // Reload opened the workbench in a new window only where Chromium could not see the crash.
      const replaced = recoveryReplaced(await recoveryRecords(dialogs + '.recovery'), source)
      if (onWindows) expect(replaced).toBe(source === 'watchdog')
      expect(errors).toEqual([])
      handedOver = true
    } finally { await quitRun.cleanup() }
  }
  expect(handedOver, 'a quit handed to the page that replaced a lost one').toBe(true)
}
