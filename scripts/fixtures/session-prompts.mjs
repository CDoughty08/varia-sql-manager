// Main's prompts about open transactions and running queries (menus-smoke.mjs step 17), in fresh apps on the fake
// backend, which counts each session's BEGIN TRAN, COMMIT and ROLLBACK and answers query.session.state from them
// (tests/fixtures/backend.mjs): F5 on a disconnected query opens Connect and runs the query once connected, and no
// execution reads the session's transaction; closing a query with an open transaction reads it then and asks SSMS's
// question (Yes commits, No rolls back, Cancel), and a commit that fails keeps it open; disconnecting the query (where SET
// NOEXEC ON leaves the transaction unchecked, so it asks whether there may be one) and disconnecting the server ask too;
// an executing query is cancelled only on Cancel Query and Close; a quit asks first about an executing query, then once
// about every open transaction, and commits each before the app exits; and a crash closes the open prompt, so a dead
// page cannot hold it.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { electron, expect } from './smoke.mjs'
import { explorerRow } from './explorer-tree.mjs'

const wait = ms => new Promise(done => setTimeout(done, ms))

/** Answers main's message boxes: Unsaved query with Don't Save and Workbench stopped with Reload; any other is recorded
 *  and answered with the next queued label (its cancel button when none is queued). The label `hold` keeps it open until
 *  its signal aborts it, as Electron's does, which `globalThis.variaAborted` records. */
async function mockPrompts(application) {
  await application.evaluate(({ dialog }) => {
    const prompts = globalThis.variaPrompts = [], answers = globalThis.variaAnswers = [], aborted = globalThis.variaAborted = []
    dialog.showMessageBox = async (_window, options) => {
      if (options.title === 'Unsaved query') return { response: 1, checkboxChecked: false }
      if (options.title === 'Workbench stopped') { prompts.push({ title: options.title }); return { response: 0, checkboxChecked: false } }
      prompts.push({ title: options.title, message: options.message, detail: options.detail, buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId })
      const label = answers.shift()
      if (label === 'hold') {
        return new Promise(done => options.signal?.addEventListener('abort', () => { aborted.push(options.title); done({ response: options.cancelId, checkboxChecked: false }) }))
      }
      const index = label === undefined ? options.cancelId : options.buttons.indexOf(label)
      return { response: index < 0 ? options.cancelId : index, checkboxChecked: false }
    }
  })
}
const messages = application => application.evaluate(() => globalThis.variaPrompts.map(prompt => prompt.message))
const titles = application => application.evaluate(() => globalThis.variaPrompts.map(prompt => prompt.title))
const lastPrompt = application => application.evaluate(() => globalThis.variaPrompts.at(-1))
const answerNext = (application, ...labels) => application.evaluate((_electron, queued) => { globalThis.variaAnswers.push(...queued) }, labels)
const calls = async (control, method) => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.method === method)
// Electron turns SIGTERM into app.quit() on Linux and macOS; on Windows the child is cmd.exe, so main is asked to quit.
const quit = (application, child) => process.platform === 'win32' ? application.evaluate(({ app }) => { setImmediate(() => app.quit()) }) : child.kill('SIGTERM')

/** A fresh app on the fake backend with its own profile and control directory, its prompts mocked, and the helpers the
 *  steps share. */
async function launch(launchOptions, name) {
  const profile = await mkdtemp(resolve('artifacts', `menus-${name}-profile-`)), control = await mkdtemp(resolve('artifacts', `menus-${name}-backend-`))
  const application = await electron.launch({ ...launchOptions, env: { ...launchOptions.env, VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND_DIR: control } })
  const child = application.process(), state = { exited: false }
  child.once('exit', () => { state.exited = true })
  const page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', () => {})
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  await mockPrompts(application)
  const run = async sql => {
    await page.locator('.monaco-editor [role="textbox"]').focus()
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText(sql)
    await page.keyboard.press('F5')
  }
  const connectDialog = async () => {
    const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Server Name', { exact: true }).fill('server-a')
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  }
  const cleanup = async () => {
    await Promise.race([application.close(), wait(10000)]).catch(() => {})
    child.kill()
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    await rm(control, { recursive: true, force: true }).catch(() => {})
  }
  return {
    application, child, page, control, errors, state, run, connectDialog, cleanup,
    tabs: page.locator('.query-tabs').getByRole('tab'), server: page.getByLabel('Query server', { exact: true }), session: page.locator('.status-session'),
    newQuery: () => page.locator('.toolbar').getByRole('button', { name: 'New query', exact: true }).click(),
    activeName: () => page.locator('.query-tabs').getByRole('tab', { selected: true }).getAttribute('aria-label'),
    closeTab: name => page.getByRole('button', { name: 'Close ' + name, exact: true }).click(),
    idle: () => expect(page.locator('.toolbar').getByRole('button', { name: 'Open', exact: true })).toBeEnabled(),
    // How sessions ended with a transaction to end; choosing a server for a disconnected query also closes its (empty) session.
    sessionCloses: async () => (await calls(control, 'query.session.close')).flatMap(call => call.params.transaction ? [call.params.transaction] : [])
  }
}

export async function sessionPrompts(launchOptions) {
  let app = await launch(launchOptions, 'sessions')
  try {
    const { application, child, page, control, errors, state, run, connectDialog, tabs, server, session, newQuery, activeName, closeTab, idle, sessionCloses } = app

    // 1. F5 on a disconnected query opens Connect, and the query runs once connected; the status bar shows its login
    // and SPID, as SSMS does.
    await run('BEGIN TRAN; SELECT 1')
    await expect(page.getByRole('dialog', { name: 'Connect', exact: true })).toBeVisible()
    expect(await calls(control, 'query.execute')).toEqual([])
    await connectDialog()
    await expect.poll(async () => (await calls(control, 'query.execute')).map(call => call.params.sql)).toEqual(['BEGIN TRAN; SELECT 1'])
    await expect(page.locator('.results-grid')).toContainText('server-a')
    await expect(session).toHaveText('fake (51)')
    // As in SSMS, nothing asks the session about its transaction after a script; only ending it does.
    expect(await calls(control, 'query.session.state')).toEqual([])
    console.log('Session checks: F5 on a disconnected query connects it, then runs it; the status bar shows the login and SPID, and no state is read.')

    // 2. Closing it reads its transaction and asks SSMS's question after Don't Save: Cancel keeps it; a commit that fails
    // keeps it and says why; Yes commits in its session and closes it.
    const first = await activeName()
    await closeTab(first)
    const closing = 'There are uncommitted transactions. Do you wish to commit these transactions before closing the window?'
    await expect.poll(() => messages(application)).toEqual([closing])
    expect(await lastPrompt(application)).toEqual({ title: 'Uncommitted transactions', message: closing, detail: `• ${first}\n\nYes commits every nesting level; No rolls back.`,
      buttons: ['Yes', 'No', 'Cancel'], defaultId: 0, cancelId: 2 })
    expect((await calls(control, 'query.session.state')).map(call => call.params)).toEqual([{ sessionId: expect.any(String) }])
    await idle()
    await expect(tabs).toHaveCount(1)
    expect(await sessionCloses()).toEqual([])
    await writeFile(join(control, 'fail-commit'), '')
    await answerNext(application, 'Yes')
    await closeTab(first)
    await expect(page.locator('.global-error')).toContainText('The transaction was not committed, and the query stays open.')
    await expect(tabs).toHaveCount(1)
    await rm(join(control, 'fail-commit'))
    await answerNext(application, 'Yes')
    await closeTab(first)
    await expect(tabs).toHaveCount(0)
    expect(await sessionCloses()).toEqual(['commit', 'commit'])
    console.log('Session checks: closing a query with an open transaction asks SSMS\'s question; Cancel keeps it, a failed commit keeps it and says why, and Yes commits it.')

    // 3. Disconnecting the query (the toolbar's Disconnected) asks too. SET NOEXEC ON keeps the session from reporting
    // its transaction, so it asks whether there may be one; No ends it in its session before the query moves.
    await newQuery()
    await server.selectOption({ label: 'server-a' })
    await run('BEGIN TRANSACTION; SELECT 2')
    await expect(session).toHaveText('fake (52)')
    await run('SET NOEXEC ON')
    const second = await activeName()
    await answerNext(application, 'No')
    await server.selectOption('')
    await expect(server).toHaveValue('')
    expect(await lastPrompt(application)).toMatchObject({ message: 'There may be uncommitted transactions. Do you wish to commit these transactions before disconnecting?',
      detail: `• ${second} (not checked)\n\nA query marked "not checked" could not be checked: SET SHOWPLAN, NOEXEC, PARSEONLY or FMTONLY may be ON in its session, or it did not answer.\n\nYes commits every nesting level; No rolls back.` })
    expect(await sessionCloses()).toEqual(['commit', 'commit', 'rollback'])
    await expect(session).toHaveCount(0)
    console.log('Session checks: disconnecting the query asks whether an unchecked session may hold a transaction, and No rolls it back in its session.')

    // 4. A query still executing: Keep Running keeps it; Cancel Query and Close cancels it, then rolls back and closes.
    await server.selectOption({ label: 'server-a' })
    await run('BEGIN TRAN\nWAIT_FOR_CANCEL')
    await expect(page.locator('.query-tabs .online')).toHaveCount(1)
    await closeTab(second)
    await expect.poll(async () => (await lastPrompt(application))?.title).toBe('Query executing')
    expect(await lastPrompt(application)).toMatchObject({ message: `${second} is still executing.`, buttons: ['Cancel Query and Close', 'Keep Running'], defaultId: 1, cancelId: 1 })
    await idle()
    await expect(page.locator('.query-tabs .online')).toHaveCount(1)
    expect(await calls(control, 'query.cancel')).toEqual([])
    await answerNext(application, 'Cancel Query and Close')
    await closeTab(second)
    await expect(tabs).toHaveCount(0)
    expect((await calls(control, 'query.cancel')).length).toBe(1)
    expect(await sessionCloses()).toEqual(['commit', 'commit', 'rollback', 'rollback'])
    console.log('Session checks: closing an executing query asks first, and cancels it only on Cancel Query and Close.')

    // 5. Disconnecting the server from Object Explorer asks too: Cancel keeps it connected; Commit commits, then it
    // disconnects.
    await newQuery()
    await server.selectOption({ label: 'server-a' })
    await run('BEGIN TRAN')
    await expect(session).toHaveText('fake (54)')
    const fifth = await activeName()
    await (await explorerRow(page, 'server-a')).click()
    const disconnect = page.locator('.explorer-toolbar').getByRole('button', { name: 'Disconnect', exact: true })
    await disconnect.click()
    await expect.poll(async () => (await lastPrompt(application))?.message).toBe('There are uncommitted transactions. Do you wish to commit these transactions before disconnecting the server?')
    expect(await lastPrompt(application)).toMatchObject({ detail: `• ${fifth}\n\nYes commits every nesting level; No rolls back.` })
    await idle()
    expect(await calls(control, 'connections.disconnect')).toEqual([])
    await answerNext(application, 'Yes')
    await disconnect.click()
    await expect(server).toHaveValue('')
    expect((await calls(control, 'connections.disconnect')).length).toBe(1)
    expect(await sessionCloses()).toEqual(['commit', 'commit', 'rollback', 'rollback', 'commit'])
    console.log('Session checks: disconnecting a server asks about its queries\' open transactions, and commits them first.')

    // 6. A quit asks once for every open transaction: Cancel keeps the app; Yes commits each in its session, then it exits.
    await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click()
    await connectDialog()
    await run('BEGIN TRAN')
    await expect(session).toHaveText('fake (55)')
    const third = await activeName()
    await newQuery()
    await run('BEGIN TRAN; BEGIN TRAN')
    await expect(session).toHaveText('fake (56)')
    const fourth = await activeName()
    const asked = (await messages(application)).length
    await quit(application, child)
    await expect.poll(async () => (await messages(application)).length).toBe(asked + 1)
    await wait(1000)
    expect(state.exited).toBe(false)
    expect(await lastPrompt(application)).toEqual({ title: 'Uncommitted transactions', message: 'There are uncommitted transactions in 2 queries. Do you wish to commit these transactions before closing Varia SQL Manager?',
      detail: `• ${third}\n• ${fourth} (2 nested levels)\n\nYes commits every nesting level; No rolls back.`, buttons: ['Yes', 'No', 'Cancel'], defaultId: 0, cancelId: 2 })
    await idle()
    // With a query also executing, it is asked about first, as SSMS asks each window: Keep Running (the default) keeps
    // the app; Cancel Query and Close then asks about the transactions, whose Cancel still cancels nothing.
    await newQuery()
    await run('WAIT_FOR_CANCEL')
    await expect(page.locator('.query-tabs .online')).toHaveCount(1)
    const executing = await activeName()
    const cancels = (await calls(control, 'query.cancel')).length
    await quit(application, child)
    await expect.poll(async () => (await messages(application)).length).toBe(asked + 2)
    expect(await lastPrompt(application)).toMatchObject({ title: 'Query executing', message: `${executing} is still executing.`, buttons: ['Cancel Query and Close', 'Keep Running'], defaultId: 1, cancelId: 1 })
    await idle()
    expect((await messages(application)).length).toBe(asked + 2)
    await answerNext(application, 'Cancel Query and Close')
    await quit(application, child)
    await expect.poll(async () => (await messages(application)).length).toBe(asked + 4)
    expect(await lastPrompt(application)).toMatchObject({ title: 'Uncommitted transactions', detail: `• ${third}\n• ${fourth} (2 nested levels)\n\nYes commits every nesting level; No rolls back.`, defaultId: 0, cancelId: 2 })
    await idle()
    expect((await calls(control, 'query.cancel')).length).toBe(cancels)
    await expect(page.locator('.query-tabs .online')).toHaveCount(1)
    expect(state.exited).toBe(false)
    await answerNext(application, 'Cancel Query and Close', 'Yes')
    await quit(application, child)
    await expect.poll(() => state.exited, { timeout: 30000 }).toBe(true)
    expect((await calls(control, 'query.cancel')).length).toBe(cancels + 1)
    expect((await sessionCloses()).slice(5)).toEqual(['commit', 'commit', 'rollback'])
    expect(errors).toEqual([])
    console.log('Session checks: a quit asks first about an executing query, then once about every open transaction, and Yes commits each before the app exits.')
  } finally { await app.cleanup() }

  // 7. A crash while the prompt is open closes it, so the dead page cannot hold it open; the crash prompt follows.
  app = await launch(launchOptions, 'sessions-crash')
  try {
    const { application, run, connectDialog, session, activeName, closeTab } = app
    await run('BEGIN TRAN')
    await connectDialog()
    await expect(session).toHaveText('fake (51)')
    await answerNext(application, 'hold')
    await closeTab(await activeName())
    await expect.poll(() => titles(application)).toEqual(['Uncommitted transactions'])
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    await expect.poll(() => titles(application)).toEqual(['Uncommitted transactions', 'Workbench stopped'])
    expect(await application.evaluate(() => globalThis.variaAborted)).toEqual(['Uncommitted transactions'])
    // The page that asked is gone; the new one loads (Playwright's page for the crashed one cannot be used, so main asks).
    const js = source => application.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code).catch(error => 'error: ' + error.message), source)
    await expect.poll(() => js("document.body.innerText.includes('fake · Ready') && !!document.querySelector('.monaco-editor')"), { timeout: 30000 }).toBe(true)
    console.log('Session checks: a crash closes the open transaction prompt.')
  } finally { await app.cleanup() }
}
