// Integrated coverage through the real main request, credential, target, query and disconnect owners. Called by the
// existing connections suite; the direct entry point is useful when diagnosing this phase alone.
import { electron, expect } from './smoke.mjs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { explorerRow, explorerTree } from './explorer-tree.mjs'
import {
  activeDocumentName, backendReady, documentTab, documentTabs, editorTextbox, explorerLabel, outputStatus,
  queryServer, queryStatus, resultGrid, selectOpenDocument, toolbarButton
} from './ui.mjs'

export async function connectionLifecycle() {
  await mkdir('artifacts', { recursive: true })
  const folder = await mkdtemp(resolve('artifacts', 'connection-lifecycle-'))
  const profile = join(folder, 'profile'), control = join(folder, 'control')
  await mkdir(control, { recursive: true })
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench',
    VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control, VARIA_TEST_SAFE_STORAGE: 'test', VARIA_TEST_HOT_EXIT: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const secret = 'lifecycle-secret-marker'
  let app, page, passed = false
  const failures = []
  const watchdog = setTimeout(() => { console.error('Integrated connection lifecycle timed out.'); app?.process()?.kill(); process.exitCode = 1 }, 180_000)
  const calls = async () => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const roots = () => explorerTree(page).locator('[role="treeitem"][aria-level="1"]')
  const disconnectDialog = () => page.getByRole('dialog', { name: /^Disconnect Lifecycle production\?$/ })
  async function launch() {
    app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
    await app.evaluate(({ dialog }) => {
      const state = globalThis.variaLifecycle = { answers: [], prompts: [] }
      dialog.showMessageBox = async (_window, options) => {
        const prompt = options ?? _window, choice = state.answers.shift()
        state.prompts.push({ title: prompt.title, message: prompt.message, buttons: prompt.buttons })
        const discard = prompt.buttons?.findIndex(button => /Don.t Save/i.test(button)) ?? -1
        return { response: choice === 'discard' && discard >= 0 ? discard : prompt.cancelId ?? 2, checkboxChecked: false }
      }
      dialog.showSaveDialog = async () => ({ canceled: true })
    })
    page = await app.firstWindow()
    page.on('pageerror', error => failures.push(error.message))
    await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
    await expect(toolbarButton(page, 'Connect')).toBeEnabled()
  }
  async function open() {
    await toolbarButton(page, 'Connect').click()
    const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
    return dialog
  }
  async function custom(dialog) {
    const button = dialog.getByRole('button', { name: 'Custom Properties', exact: true })
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
  }
  async function connect({ server = 'lifecycle-main', username = 'reader', password = secret, name = 'Lifecycle production', environment = 'Production' } = {}) {
    const dialog = await open()
    await dialog.getByLabel('Server Name', { exact: true }).fill(server)
    await dialog.getByLabel('Database Name', { exact: true }).fill('AppData')
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await dialog.getByLabel('Login', { exact: true }).fill(username)
    await dialog.getByLabel('Password', { exact: true }).fill(password)
    await dialog.getByLabel('Remember password', { exact: true }).check()
    await custom(dialog)
    await dialog.getByLabel('Name', { exact: true }).fill(name)
    await dialog.getByLabel('Environment', { exact: true }).selectOption(environment)
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    return dialog
  }
  async function serverAction(name, action) {
    const row = await explorerRow(page, name)
    await explorerLabel(row).click({ button: 'right' })
    await page.getByRole('menu', { name: 'Object Explorer', exact: true }).getByRole('menuitem', { name: action }).click()
  }
  async function type(text) {
    await editorTextbox(page).focus()
    await page.keyboard.insertText(text)
  }
  async function answers(choices) {
    await app.evaluate((_electron, choices) => { globalThis.variaLifecycle.answers = choices; globalThis.variaLifecycle.prompts = [] }, choices)
  }
  try {
    await launch()
    // Profile policy is saved independently of transport identity, and a prior draft never bleeds into another profile.
    let policyDialog = await open()
    await policyDialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await policyDialog.getByLabel('Login', { exact: true }).fill('policy-reader')
    await policyDialog.getByLabel('Server Name', { exact: true }).fill('policy-one')
    await custom(policyDialog)
    await policyDialog.getByLabel('Name', { exact: true }).fill('Policy one')
    await policyDialog.getByLabel('Reconnect on startup', { exact: true }).selectOption('off')
    await policyDialog.getByRole('button', { name: 'Add favorite', exact: true }).click()
    await expect(policyDialog.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled()
    await policyDialog.getByLabel('Reconnect on startup', { exact: true }).selectOption('on')
    await policyDialog.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(policyDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
    await policyDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    policyDialog = await open()
    await policyDialog.getByRole('button', { name: /^Policy one/ }).first().click()
    await custom(policyDialog)
    await expect(policyDialog.getByLabel('Reconnect on startup', { exact: true })).toHaveValue('on')
    await policyDialog.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(policyDialog.getByLabel('Reconnect on startup', { exact: true })).toHaveValue('inherit')
    await policyDialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await policyDialog.getByLabel('Login', { exact: true }).fill('policy-reader')
    await policyDialog.getByLabel('Server Name', { exact: true }).fill('policy-two')
    await policyDialog.getByLabel('Name', { exact: true }).fill('Policy two')
    await policyDialog.getByRole('button', { name: 'Add favorite', exact: true }).click()
    await expect(policyDialog.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled()
    await policyDialog.getByRole('button', { name: /^Policy one/ }).first().click()
    await expect(policyDialog.getByLabel('Reconnect on startup', { exact: true })).toHaveValue('on')
    await policyDialog.getByRole('button', { name: /^Policy two/ }).first().click()
    await expect(policyDialog.getByLabel('Reconnect on startup', { exact: true })).toHaveValue('inherit')
    await policyDialog.getByRole('button', { name: 'Remove saved Policy one', exact: true }).first().click()
    await expect(policyDialog.getByRole('button', { name: 'Remove saved Policy one', exact: true })).toHaveCount(0)
    await policyDialog.getByRole('button', { name: 'Remove saved Policy two', exact: true }).first().click()
    await expect(policyDialog.getByRole('button', { name: 'Remove saved Policy two', exact: true })).toHaveCount(0)
    await policyDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    let dialog = await connect()
    await expect(dialog).toHaveCount(0)
    await expect(roots()).toHaveCount(1)
    const first = await activeDocumentName(page)
    await type('SELECT 1 AS lifecycle_first;')
    await page.getByRole('button', { name: /^Execute(?:\s|$)/ }).click()
    await expect(outputStatus(page)).toContainText('Completed')
    await expect(resultGrid(page)).toContainText('lifecycle-main')
    await toolbarButton(page, 'New query').click()
    const second = await activeDocumentName(page)
    await type('SELECT 2 AS lifecycle_second;')
    const queryCount = await documentTabs(page).getByRole('tab').count()
    const opens = (await calls()).filter(call => call.method === 'connections.connect').length
    dialog = await connect()
    await expect(dialog).toHaveCount(0)
    await expect(roots()).toHaveCount(1)
    expect(await documentTabs(page).getByRole('tab').count()).toBe(queryCount)
    expect((await calls()).filter(call => call.method === 'connections.connect')).toHaveLength(opens)

    // Details-only changes reuse the transport, and every explicit outcome is exercised.
    for (const action of ['Cancel', 'Keep Current Details', 'Use Selected Details']) {
      dialog = await connect({ name: 'Lifecycle renamed', environment: 'Staging' })
      const confirmation = page.getByRole('dialog', { name: 'Use selected connection details?', exact: true })
      await expect(confirmation).toBeVisible()
      await expect(confirmation).toContainText('Lifecycle production')
      if (action === 'Cancel') await page.screenshot({ path: resolve('artifacts', 'connections-details-confirmation.png') })
      await confirmation.getByRole('button', { name: action, exact: true }).click()
      if (action === 'Cancel') {
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      } else await expect(dialog).toHaveCount(0)
      await expect(roots()).toHaveCount(1)
      await expect(await explorerRow(page, action === 'Use Selected Details' ? 'Lifecycle renamed' : 'Lifecycle production')).toBeVisible()
    }
    // Restore the original name for the disconnect prompt, still without another backend connection.
    dialog = await connect()
    await page.getByRole('dialog', { name: 'Use selected connection details?', exact: true }).getByRole('button', { name: 'Use Selected Details', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await calls()).filter(call => call.method === 'connections.connect')).toHaveLength(opens)
    dialog = await connect({ username: 'other-reader', name: 'Lifecycle reader', environment: 'Staging' })
    await expect(dialog).toHaveCount(0)
    await expect(roots()).toHaveCount(2)
    // Ordinary connection reuse/creation never steals the current remembered query from another target.
    await selectOpenDocument(page, second)
    await expect(queryServer(page).locator('option:checked')).toContainText('Lifecycle production')
    await serverAction('Lifecycle reader', 'New Query')
    const readerQuery = await activeDocumentName(page)
    await type('SELECT 3 AS reader_query;')
    dialog = await connect({ server: 'password-check', username: 'reader', password: 'correct-horse-marker', name: 'Lifecycle retry', environment: 'Test' })
    await expect(dialog).toHaveCount(0)
    await expect(roots()).toHaveCount(3)

    await serverAction('Lifecycle production', /^Disconnect(?:…)?$/)
    await expect(disconnectDialog()).toBeVisible()
    await expect(disconnectDialog().getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await page.screenshot({ path: resolve('artifacts', 'connections-disconnect-confirmation.png') })
    await disconnectDialog().getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(await explorerRow(page, 'Lifecycle production')).toHaveAttribute('aria-expanded', 'true')
    // A later dirty prompt cancellation preserves every tab and the live connection.
    await answers(['discard', 'cancel'])
    await serverAction('Lifecycle production', /^Disconnect(?:…)?$/)
    await disconnectDialog().getByRole('button', { name: 'Disconnect and Close Query Tabs', exact: true }).click()
    await expect.poll(() => app.evaluate(() => globalThis.variaLifecycle.prompts.length)).toBe(2)
    await expect(documentTab(page, first)).toBeVisible()
    await expect(documentTab(page, second)).toBeVisible()
    await expect(await explorerRow(page, 'Lifecycle production')).toHaveAttribute('aria-expanded', 'true')

    await selectOpenDocument(page, first)
    await serverAction('Lifecycle production', /^Disconnect(?:…)?$/)
    await disconnectDialog().getByRole('button', { name: 'Disconnect and Keep Tabs', exact: true }).click()
    await expect(disconnectDialog()).toHaveCount(0)
    await expect(await explorerRow(page, 'Lifecycle production')).toHaveAccessibleName(/Disconnected/)
    await expect(await explorerRow(page, 'Lifecycle production')).not.toHaveAttribute('aria-expanded', 'true')
    await expect(queryServer(page).locator('option:checked')).toContainText('Disconnected')
    await expect(resultGrid(page)).toContainText('lifecycle-main')
    await expect(queryStatus(page)).toContainText('Disconnected')
    await page.screenshot({ path: resolve('artifacts', 'connections-retained-results.png') })
    await serverAction('Lifecycle production', /^Reconnect/)
    dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(queryServer(page).locator('option:checked')).not.toContainText('Disconnected')
    await expect(resultGrid(page)).toContainText('lifecycle-main')
    await serverAction('Lifecycle production', 'Disconnect and Remove from Explorer')
    await disconnectDialog().getByRole('button', { name: 'Disconnect and Keep Tabs', exact: true }).click()
    await expect(roots()).toHaveCount(2)
    await expect(queryServer(page).locator('option:checked')).toContainText('Lifecycle production')
    await expect(queryServer(page).locator('option:checked')).toContainText('Disconnected')
    await expect(resultGrid(page)).toContainText('lifecycle-main')
    dialog = await connect()
    await expect(dialog).toHaveCount(0)
    await expect(roots()).toHaveCount(3)
    await expect(queryServer(page).locator('option:checked')).not.toContainText('Disconnected')
    await expect(resultGrid(page)).toContainText('lifecycle-main')
    await answers(['discard', 'discard'])
    await serverAction('Lifecycle production', /^Disconnect(?:…)?$/)
    await disconnectDialog().getByRole('button', { name: 'Disconnect and Close Query Tabs', exact: true }).click()
    await expect(documentTab(page, first)).toHaveCount(0)
    await expect(documentTab(page, second)).toHaveCount(0)
    await expect(documentTab(page, readerQuery)).toBeVisible()
    await expect(await explorerRow(page, 'Lifecycle production')).toHaveAccessibleName(/Disconnected/)
    await expect(await explorerRow(page, 'Lifecycle production')).not.toHaveAttribute('aria-expanded', 'true')

    // One remembered live server succeeds, one rejects its saved secret, and the explicit disconnect stays respected.
    const executions = (await calls()).filter(call => call.method === 'query.execute').length
    await writeFile(join(control, 'reject-passwords'), '')
    await app.close(); app = undefined
    const saved = await readFile(join(profile, 'Session', 'session.json'), 'utf8')
    expect(saved).not.toContain(secret)
    expect(saved).not.toContain('correct-horse-marker')
    await launch()
    await expect(roots()).toHaveCount(3)
    await expect(await explorerRow(page, 'Lifecycle production')).toHaveAccessibleName(/Disconnected/)
    await expect(await explorerRow(page, 'Lifecycle reader')).toHaveAttribute('aria-expanded', 'true')
    await expect(await explorerRow(page, 'Lifecycle retry')).not.toHaveAttribute('aria-expanded', 'true')
    await selectOpenDocument(page, readerQuery)
    await expect(queryServer(page).locator('option:checked')).toContainText('Lifecycle reader')
    await expect(queryServer(page).locator('option:checked')).not.toContainText('Disconnected')
    expect((await calls()).filter(call => call.method === 'query.execute')).toHaveLength(executions)
    expect((await calls()).filter(call => call.method === 'connections.connect' && call.params.nonInteractive)).toHaveLength(2)
    expect(await app.evaluate(() => globalThis.variaLifecycle.prompts)).toEqual([])
    expect(failures).toEqual([])
    await page.screenshot({ path: resolve('artifacts', 'connections-startup-recovery.png') })
    passed = true
    console.log('Integrated connection lifecycle passed: exact reuse, changed credentials, detail choices, dirty-close cancellation, retained results, reconnect, selective close, mixed startup outcomes and no automatic user SQL.')
  } catch (error) {
    await page?.screenshot({ path: resolve('artifacts', 'connection-lifecycle-failure.png') }).catch(() => {})
    console.error(`Connection lifecycle artifacts retained in ${folder}`)
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close().catch(() => app?.process()?.kill())
    if (passed) await rm(folder, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await connectionLifecycle()
