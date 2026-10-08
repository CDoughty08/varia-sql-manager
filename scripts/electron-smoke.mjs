import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'electron-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
// Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it, as Chromium will not start sandboxed there.
const launchOptions = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
const application = await electron.launch(launchOptions)
const artifact = name => resolve('artifacts', name)
await mkdir('artifacts', { recursive: true })
async function menu(id) {
  await application.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId)
    if (!item) throw new Error('Menu item missing: ' + itemId)
    item.click()
  }, id)
}
async function nativeKey(keyCode, modifiers = []) {
  await application.evaluate(({ BrowserWindow }, key) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', ...key })
    contents.sendInputEvent({ type: 'keyUp', ...key })
  }, { keyCode, modifiers })
}
async function dialogs(settings) {
  await application.evaluate(({ dialog }, values) => {
    globalThis.variaDialogs = { ...globalThis.variaDialogs, ...values }
    globalThis.variaDialogs.prompts ??= []
    dialog.showSaveDialog = async () => {
      if (globalThis.variaDialogs.holdSave) await new Promise(resolve => { globalThis.variaReleaseSave = resolve })
      return { canceled: !globalThis.variaDialogs.savePath, filePath: globalThis.variaDialogs.savePath }
    }
    dialog.showOpenDialog = async () => ({ canceled: !globalThis.variaDialogs.openPaths?.length, filePaths: globalThis.variaDialogs.openPaths ?? [] })
    dialog.showMessageBox = async (_window, options) => {
      globalThis.variaDialogs.prompts.push(options.message)
      if (globalThis.variaDialogs.holdConfirm) await new Promise(resolve => { globalThis.variaReleaseConfirm = resolve })
      return { response: globalThis.variaDialogs.closeResponse ?? 2, checkboxChecked: false }
    }
  }, settings)
}
async function chooseMenu(page, name, action) {
  await application.evaluate((_electron, id) => { globalThis.variaMenuAction = id }, action)
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name, exact: true }).click()
  await expect.poll(() => application.evaluate(() => globalThis.variaMenuPopups.at(-1)?.menu)).toBe('menu.' + name.toLowerCase())
  await expect(page.getByRole('menuitem', { name, exact: true })).toHaveAttribute('aria-expanded', 'false')
}
try {
  const page = await application.firstWindow()
  const failures = []
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByText(/\.NET 10\..*Ready/)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  const health = await page.evaluate(() => window.varia.health())
  expect(health.ok).toBe(true)
  expect(health.value.protocolVersion).toBe(1)
  expect(await page.evaluate(() => ({ node: typeof window.require, process: typeof window.process, invoke: typeof window.varia.invoke }))).toEqual({ node: 'undefined', process: 'undefined', invoke: 'undefined' })
  expect(await application.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox'))).toBe(process.platform === 'linux' && !launchOptions.chromiumSandbox)
  await expect(page.locator('.app-header')).toHaveCount(0)
  await expect(page.getByRole('menubar', { name: 'Application menu' })).toBeVisible()
  const chrome = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { menuVisible: window.isMenuBarVisible(), menuAutoHide: window.isMenuBarAutoHide(), resizable: window.isResizable() }
  })
  expect(chrome).toEqual({ menuVisible: false, menuAutoHide: false, resizable: true })
  const titleBar = await page.evaluate(() => {
    const overlay = navigator.windowControlsOverlay
    const safe = overlay.getTitlebarAreaRect()
    const content = document.querySelector('.title-bar-content')
    const rect = content.getBoundingClientRect()
    return { nativeControls: overlay.visible, top: rect.top, right: rect.right, safeRight: safe.x + safe.width, drag: getComputedStyle(content).webkitAppRegion, menus: getComputedStyle(document.querySelector('.title-bar-menus')).webkitAppRegion, toolbarTop: document.querySelector('.toolbar').getBoundingClientRect().top, height: document.querySelector('.title-bar').getBoundingClientRect().height }
  })
  expect(titleBar.nativeControls).toBe(true)
  expect(titleBar.top).toBe(0)
  expect(titleBar.right).toBeLessThanOrEqual(titleBar.safeRight + 1)
  expect(titleBar.drag).toBe('drag')
  expect(titleBar.menus).toBe('no-drag')
  expect(titleBar.toolbarTop).toBe(titleBar.height)
  expect(titleBar.height).toBeLessThanOrEqual(34)
  // Spy on OS popups while keeping the real validated IPC and menu item callbacks.
  await application.evaluate(({ Menu }) => {
    globalThis.variaMenuPopups = []
    for (const id of ['menu.file', 'menu.edit', 'menu.view', 'menu.window']) {
      const menu = Menu.getApplicationMenu().getMenuItemById(id).submenu
      menu.popup = options => {
        globalThis.variaMenuPopups.push({ menu: id, x: options.x, y: options.y, windowId: options.window.id })
        const action = globalThis.variaMenuAction
        globalThis.variaMenuAction = null
        if (action) menu.getMenuItemById(action).click()
        options.callback()
      }
    }
  })
  expect((await page.evaluate(() => window.varia.showMenu({ menu: 'shell', x: 0, y: 0 }))).ok).toBe(false)
  expect((await page.evaluate(() => window.varia.showMenu({ menu: 'file', x: -1, y: 0 }))).ok).toBe(false)
  expect(await application.evaluate(() => globalThis.variaMenuPopups)).toEqual([])
  const editorText = () => page.locator('.monaco-editor .view-lines').innerText()
  async function typeSql(sql) {
    await page.locator('.monaco-editor [role="textbox"]').focus()
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText(sql)
    await expect.poll(editorText).toContain(sql.replaceAll(' ', '\u00a0'))
  }
  async function undoToClean() {
    for (let step = 0; step < 20 && await page.locator('.query-tab.active .dirty-dot').count(); step++) await page.keyboard.press('Control+Z')
    await expect(page.locator('.query-tab.active .dirty-dot')).toHaveCount(0)
  }
  async function redoToText(expected) {
    for (let step = 0; step < 20 && await editorText() !== expected; step++) await page.keyboard.press('Control+Y')
    await expect.poll(editorText).toBe(expected)
  }

  // Real menu callbacks, native-dialog IPC, and filesystem services; no database required.
  await dialogs({ savePath: null, openPaths: [], closeResponse: 2 })
  await chooseMenu(page, 'File', 'file.new')
  await expect(page.locator('.query-tabs').getByRole('tab')).toHaveCount(2)
  await typeSql('SELECT 42 AS answer;')
  const typed = await editorText()
  await chooseMenu(page, 'Edit', 'edit.undo')
  await expect.poll(editorText).not.toBe(typed)
  await chooseMenu(page, 'Edit', 'edit.redo')
  await expect.poll(editorText).toBe(typed)
  await page.keyboard.press('Control+Z')
  await expect.poll(editorText).not.toBe(typed)
  await page.keyboard.press('Control+Y')
  await expect.poll(editorText).toBe(typed)
  const historyTab = await page.locator('.query-tabs').getByRole('tab', { selected: true }).getAttribute('aria-label')
  await page.locator('.query-tabs').getByRole('tab', { name: 'SQLQuery1.sql', exact: true }).click()
  await page.locator('.query-tabs').getByRole('tab', { name: historyTab, exact: true }).click()
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+Z')
  await expect.poll(editorText).not.toBe(typed)
  await undoToClean()
  await redoToText(typed)
  await expect(page.locator('.query-tab.active .dirty-dot')).toHaveCount(1)
  await page.keyboard.press('F10')
  await expect(page.getByRole('menuitem', { name: 'File', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.monaco-editor [role="textbox"]')).toBeFocused()
  await nativeKey('F10')
  await expect(page.getByRole('menuitem', { name: 'File', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Alt+v')
  await expect.poll(() => application.evaluate(() => globalThis.variaMenuPopups.at(-1)?.menu)).toBe('menu.view')
  await page.keyboard.press('Alt+w')
  await expect.poll(() => application.evaluate(() => globalThis.variaMenuPopups.at(-1)?.menu)).toBe('menu.window')
  await page.keyboard.press('Alt')
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false)
  await page.locator('.query-tabs').getByRole('tab', { selected: true }).focus()
  await page.keyboard.press('Space')
  expect(await page.locator('.query-tabs').getByRole('tab', { selected: true }).evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none')
  await menu('file.save')
  await expect(page.locator('.query-tab.active .dirty-dot')).toHaveCount(1)
  const originalName = await page.locator('.query-tabs').getByRole('tab', { selected: true }).getAttribute('aria-label')
  await page.getByRole('button', { name: 'Close ' + originalName, exact: true }).click()
  await expect(page.locator('.query-tabs').getByRole('tab')).toHaveCount(2)
  const savedPath = artifact('saved-query.sql')
  await dialogs({ savePath: savedPath })
  await menu('file.save')
  await expect(page.locator('.query-tabs').getByRole('tab', { name: 'saved-query.sql', exact: true })).toBeVisible()
  await expect(page.locator('.title-bar-caption')).toContainText('saved-query.sql')
  expect(await readFile(savedPath, 'utf8')).toBe('SELECT 42 AS answer;')
  await expect(page.locator('.query-tab.active .dirty-dot')).toHaveCount(0)
  // Delay Save As while typing; the revision written stays the saved undo boundary.
  await dialogs({ holdSave: true })
  await menu('file.saveAs')
  await expect.poll(() => application.evaluate(() => typeof globalThis.variaReleaseSave)).toBe('function')
  await typeSql('SELECT 99 AS later;')
  const laterTyped = await editorText()
  await application.evaluate(() => { globalThis.variaDialogs.holdSave = false; globalThis.variaReleaseSave(); delete globalThis.variaReleaseSave })
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  expect(await readFile(savedPath, 'utf8')).toBe('SELECT 42 AS answer;')
  await expect(page.locator('.query-tab.active .dirty-dot')).toHaveCount(1)
  await undoToClean()
  await expect.poll(editorText).toBe(typed)
  await redoToText(laterTyped)
  await expect(page.locator('.query-tab.active .dirty-dot')).toHaveCount(1)
  await typeSql('SELECT 43 AS answer;')
  await menu('file.save')
  await expect.poll(() => readFile(savedPath, 'utf8')).toBe('SELECT 43 AS answer;')
  const copyPath = artifact('saved-as.sql')
  await dialogs({ savePath: copyPath })
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('Control+Shift+S')
  await expect(page.locator('.query-tabs').getByRole('tab', { name: 'saved-as.sql', exact: true })).toBeVisible()
  expect(await readFile(copyPath, 'utf8')).toBe('SELECT 43 AS answer;')
  // Close an inactive document, then change activation while its confirmation is pending.
  await page.getByRole('button', { name: 'New query', exact: true }).click()
  await typeSql('SELECT 88 AS close_me;')
  const closeTarget = await page.locator('.query-tabs').getByRole('tab', { selected: true }).getAttribute('aria-label')
  await page.locator('.query-tabs').getByRole('tab', { name: 'saved-as.sql', exact: true }).click()
  await dialogs({ holdConfirm: true, closeResponse: 1 })
  await page.getByRole('button', { name: 'Close ' + closeTarget, exact: true }).click()
  await expect.poll(() => application.evaluate(() => typeof globalThis.variaReleaseConfirm)).toBe('function')
  expect(await application.evaluate(() => globalThis.variaDialogs.prompts.at(-1))).toContain(closeTarget)
  await page.locator('.query-tabs').getByRole('tab', { name: 'SQLQuery1.sql', exact: true }).click()
  await application.evaluate(() => { globalThis.variaDialogs.holdConfirm = false; globalThis.variaReleaseConfirm(); delete globalThis.variaReleaseConfirm })
  await expect(page.locator('.query-tabs').getByRole('tab', { name: closeTarget, exact: true })).toHaveCount(0)
  await expect(page.locator('.query-tabs').getByRole('tab', { selected: true })).toHaveAttribute('aria-label', 'SQLQuery1.sql')
  await expect(page.locator('.query-tabs').getByRole('tab', { name: 'saved-as.sql', exact: true })).toBeVisible()
  await dialogs({ closeResponse: 2 })
  await page.locator('.query-tabs').getByRole('tab', { name: 'saved-as.sql', exact: true }).click()
  await menu('file.close')
  await expect(page.locator('.query-tabs').getByRole('tab')).toHaveCount(1)
  const unicodePath = artifact('unicode-query.sql')
  await writeFile(unicodePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("SELECT N'日本語';", 'utf16le')]))
  await dialogs({ openPaths: [savedPath, unicodePath] })
  await page.keyboard.press('Control+O')
  await expect(page.locator('.query-tabs').getByRole('tab')).toHaveCount(3)
  await expect.poll(editorText).toContain('日本語')
  await typeSql("SELECT N'Français';")
  await application.evaluate(({ app }) => app.quit())
  await expect.poll(() => application.evaluate(() => globalThis.variaDialogs.prompts.length)).toBeGreaterThan(1)
  expect((await page.evaluate(() => window.varia.health())).ok).toBe(true)
  await expect(page.locator('.query-tabs').getByRole('tab', { name: 'unicode-query.sql', exact: true })).toBeVisible()
  await dialogs({ closeResponse: 0 })
  await menu('file.close')
  await expect(page.locator('.query-tabs').getByRole('tab')).toHaveCount(2)
  const unicodeSaved = await readFile(unicodePath)
  expect([...unicodeSaved.subarray(0, 2)]).toEqual([0xff, 0xfe])
  expect(unicodeSaved.subarray(2).toString('utf16le')).toBe("SELECT N'Français';")
  await dialogs({ openPaths: [savedPath] })
  await menu('file.open')
  await expect(page.locator('.query-tabs').getByRole('tab')).toHaveCount(2)
  await dialogs({ closeResponse: 1 })
  for (const name of await page.locator('.query-tabs').getByRole('tab').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))) {
    await page.getByRole('button', { name: 'Close ' + name, exact: true }).click()
    await expect(page.locator('.query-tabs').getByRole('tab', { name, exact: true })).toHaveCount(0)
  }
  await expect(page.getByText('No open queries', { exact: true })).toBeVisible()
  await nativeKey('N', ['control'])
  await expect(page.locator('.query-tabs').getByRole('tab')).toHaveCount(1)
  await expect(page.locator('.monaco-editor')).toBeVisible()

  // Stub SQL responses to exercise multi-server UI routing without external credentials.
  await application.evaluate(({ ipcMain }, realHealth) => {
    globalThis.variaCalls = []
    globalThis.variaConnections = {}
    globalThis.variaPending = {}
    ipcMain.removeHandler('varia:request')
    ipcMain.handle('varia:request', async (_event, method, params) => {
      globalThis.variaCalls.push({ method, params })
      if (method === 'system.health') return { ok: true, value: realHealth }
      if (method === 'connections.connect') {
        const info = { id: crypto.randomUUID(), server: params.server, database: params.database || 'master', serverVersion: '17.0.test' }
        globalThis.variaConnections[info.id] = info
        return { ok: true, value: info }
      }
      if (method === 'connections.disconnect') { delete globalThis.variaConnections[params.connectionId]; return { ok: true, value: { disconnected: true } } }
      if (method === 'databases.list') return { ok: true, value: [
        { name: 'master', isSystem: true, isSnapshot: false },
        { name: 'model', isSystem: true, isSnapshot: false },
        { name: 'msdb', isSystem: true, isSnapshot: false },
        { name: 'tempdb', isSystem: true, isSnapshot: false },
        { name: 'AppData', isSystem: false, isSnapshot: false },
        { name: 'AppData_Snapshot', isSystem: false, isSnapshot: true }
      ] }
      if (method === 'server.objects.list') {
        if (params.kind === 'audits' && !globalThis.variaAuditAllowed) return { ok: false, error: 'Test permission denied for server audits.' }
        const objects = {
          logins: [{ name: 'sa', description: 'SQL_LOGIN' }],
          serverRoles: ['##MS_DatabaseConnector##', '##MS_LoginManager##', 'bulkadmin', 'dbcreator', 'public', 'securityadmin', 'serveradmin', 'sysadmin'].map(name => ({ name, description: 'Fixed server role' })),
          credentials: [],
          cryptographicProviders: [{ name: 'Test EKM Provider', description: 'Enabled' }],
          audits: [{ name: 'LoginAudit', description: 'FILE · Enabled' }],
          serverAuditSpecifications: [{ name: 'LoginAuditSpec', description: 'Enabled' }]
        }
        return { ok: true, value: objects[params.kind] }
      }
      if (method === 'tables.list') return { ok: true, value: [{ schema: 'dbo', name: 'Orders' }] }
      if (method === 'tables.script') return { ok: true, value: { sql: 'CREATE TABLE dbo.Orders (Id int);' } }
      if (method === 'query.cancel') {
        globalThis.variaPending[params.queryId]?.({ ok: false, error: 'The query was cancelled.' })
        delete globalThis.variaPending[params.queryId]
        return { ok: true, value: { cancelled: true } }
      }
      if (method === 'query.session.close') {
        if (globalThis.variaHoldSessionClose) await new Promise(resolve => { globalThis.variaReleaseSessionClose = resolve })
        return { ok: true, value: { closed: true } }
      }
      if (method === 'query.execute') {
        if (params.sql.includes('BATCH_STATS_FIXTURE')) return { ok: true, value: {
          resultSets: [{ columns: [{ name: 'retained', dataType: 'int' }], rows: [[42]], truncated: false, batchNumber: 1, iteration: 1 }],
          messages: ['SQL Server Execution Times: CPU time = 1 ms, elapsed time = 2 ms.', "Table '#temp'. Scan count 1, logical reads 2."], recordsAffected: -1, elapsedMs: 3,
          status: 'failed', error: { code: 'SQL_ERROR', message: 'Msg 137, Level 15, State 2, Line 8: Must declare the scalar variable.', batchNumber: 2, iteration: 1 }, completedBatches: 1, totalBatches: 3, database: params.database, messagesTruncated: false
        } }
        if (params.sql.includes('XML_PLAN_FIXTURE')) return { ok: true, value: {
          resultSets: [{ columns: [{ name: 'answer', dataType: 'int' }], rows: [[1]], truncated: false, batchNumber: 2 }, { columns: [{ name: 'Microsoft SQL Server 2005 XML Showplan', dataType: 'nvarchar' }], rows: [['<ShowPlanXML><BatchSequence><Batch /></BatchSequence></ShowPlanXML>']], truncated: false, kind: 'executionPlan', batchNumber: 2 }],
          messages: [], recordsAffected: -1, elapsedMs: 1, status: 'completed', completedBatches: 3, totalBatches: 3, database: params.database, messagesTruncated: false
        } }
        if (params.sql.includes('WAIT_FOR_CANCEL')) return new Promise(resolve => { globalThis.variaPending[params.queryId] = resolve })
        return { ok: true, value: { resultSets: [{ columns: [{ name: 'server', dataType: 'nvarchar' }, { name: 'database', dataType: 'nvarchar' }], rows: [[globalThis.variaConnections[params.connectionId].server, params.database]], truncated: false }], messages: [], recordsAffected: -1, elapsedMs: 1 } }
      }
      return { ok: false, error: 'Unsupported test operation.' }
    })
  }, health.value)
  async function connect(server) {
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await page.getByLabel('Server Name', { exact: true }).fill(server)
    await page.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Server ' + server, exact: true })).toBeVisible()
  }
  await connect('server-a')
  const tabA = await page.locator('.query-tabs').getByRole('tab', { selected: true }).getAttribute('aria-label')
  const idA = await page.getByLabel('Query server', { exact: true }).inputValue()
  await page.getByLabel('Query database', { exact: true }).selectOption('AppData')
  await typeSql('SELECT 1;')
  await connect('server-b')
  const tabB = await page.locator('.query-tabs').getByRole('tab', { selected: true }).getAttribute('aria-label')
  const idB = await page.getByLabel('Query server', { exact: true }).inputValue()
  expect(idA).not.toBe(idB)
  await expect(page.locator('.query-tabs').getByRole('tab')).toHaveCount(2)
  await typeSql('SELECT 2;')
  await page.getByRole('button', { name: /Execute/ }).click()
  await expect(page.locator('.results-grid')).toContainText('server-b')
  await page.locator('.query-tabs').getByRole('tab', { name: tabA, exact: true }).click()
  await expect(page.getByLabel('Query server', { exact: true })).toHaveValue(idA)
  await expect(page.getByLabel('Query database', { exact: true })).toHaveValue('AppData')
  await page.getByRole('button', { name: /Execute/ }).click()
  await expect(page.locator('.results-grid')).toContainText('server-a')
  await expect(page.locator('.results-grid')).toContainText('AppData')
  const executed = await application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'query.execute').map(call => call.params))
  expect(executed.map(call => [call.connectionId, call.database])).toEqual([[idB, 'master'], [idA, 'AppData']])
  expect(executed.every(call => !!call.sessionId && call.startLine === 1)).toBe(true)
  expect(executed.every(call => call.timeoutSeconds === 0)).toBe(true)
  // Selection line offsets and both editor shortcuts use the same query command.
  await typeSql('-- heading\nSELECT 10;\nSELECT 20;')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+End')
  await page.locator('.query-tabs').getByRole('tab', { name: tabB, exact: true }).click()
  await page.locator('.query-tabs').getByRole('tab', { name: tabA, exact: true }).click()
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('F5')
  await expect.poll(() => application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'query.execute').at(-1)?.params.sql)).toBe('SELECT 20;')
  expect(await application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'query.execute').at(-1).params.startLine)).toBe(3)
  await expect(page.getByRole('button', { name: /Execute/ })).toBeEnabled()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'query.execute').at(-1)?.params.sql.replaceAll('\r\n', '\n'))).toBe('-- heading\nSELECT 10;\nSELECT 20;')
  const beforeRetarget = await application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'query.execute').length)
  await application.evaluate(() => { globalThis.variaHoldSessionClose = true })
  await page.getByLabel('Query server', { exact: true }).selectOption(idB)
  await expect.poll(() => application.evaluate(() => typeof globalThis.variaReleaseSessionClose)).toBe('function')
  await page.locator('.monaco-editor [role="textbox"]').focus()
  await page.keyboard.press('F5')
  expect(await application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'query.execute').length)).toBe(beforeRetarget)
  await application.evaluate(() => { globalThis.variaHoldSessionClose = false; globalThis.variaReleaseSessionClose(); delete globalThis.variaReleaseSessionClose })
  await expect(page.getByLabel('Query server', { exact: true })).toBeEnabled()
  await expect(page.getByLabel('Query server', { exact: true })).toHaveValue(idB)
  await page.getByLabel('Query server', { exact: true }).selectOption(idA)
  await expect(page.getByLabel('Query server', { exact: true })).toBeEnabled()
  await page.getByLabel('Query database', { exact: true }).selectOption('AppData')
  await typeSql('BATCH_STATS_FIXTURE')
  await page.getByRole('button', { name: /Execute/ }).click()
  await expect(page.locator('.messages')).toContainText('logical reads 2')
  await expect(page.locator('.messages')).toContainText('CPU time = 1 ms')
  await expect(page.locator('.messages .query-error')).toContainText('Batch 2, repetition 1')
  await page.locator('.output-toolbar').getByRole('button', { name: /Results/ }).click()
  await expect(page.locator('.results-grid')).toContainText('42')
  await typeSql('XML_PLAN_FIXTURE')
  await page.getByRole('button', { name: /Execute/ }).click()
  await page.getByRole('button', { name: /XML plan/ }).click()
  await expect(page.locator('.plan-xml')).toContainText('<ShowPlanXML>')
  await expect(page.locator('ShowPlanXML')).toHaveCount(0)
  await typeSql('SELECT 1;')
  await page.getByRole('button', { name: /Execute/ }).click()

  // SSMS folder hierarchy, lazy catalog reads, and independent per-folder failures.
  const explorerA = page.getByRole('region', { name: 'Server server-a', exact: true })
  const folder = label => explorerA.locator('[data-folder="' + label + '"]').first()
  const heading = label => folder(label).getByRole('button', { name: label, exact: true })
  await expect(folder('System Databases').locator('[data-database="master"]')).toBeVisible()
  await expect(folder('System Databases').locator('[data-database="AppData"]')).toHaveCount(0)
  await expect(explorerA.locator('[data-database="AppData"]')).toBeVisible()
  await expect(folder('Database Snapshots').locator('[data-database="AppData_Snapshot"]')).toBeHidden()
  await heading('Database Snapshots').click()
  await expect(folder('Database Snapshots').locator('[data-database="AppData_Snapshot"]')).toBeVisible()
  await heading('Databases').click()
  await expect(explorerA.locator('[data-database="AppData"]')).toBeHidden()
  await heading('Databases').click()
  await heading('System Databases').click()
  await expect(folder('System Databases').locator('[data-database="master"]')).toBeHidden()
  await heading('Database Snapshots').click()
  expect(await application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'server.objects.list').length)).toBe(0)
  await heading('Security').click()
  for (const label of ['Logins', 'Server Roles', 'Credentials', 'Cryptographic Providers', 'Audits', 'Server Audit Specifications']) await expect(heading(label)).toBeVisible()
  expect(await application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'server.objects.list').length)).toBe(0)
  await heading('Server Roles').click()
  await expect(folder('Server Roles').getByText('sysadmin', { exact: true })).toBeVisible()
  await heading('Server Roles').click()
  await expect(folder('Server Roles').getByText('sysadmin', { exact: true })).toBeHidden()
  await heading('Server Roles').click()
  expect(await application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'server.objects.list' && call.params.kind === 'serverRoles').length)).toBe(1)
  await heading('Logins').click()
  await expect(folder('Logins').getByText('sa', { exact: true })).toBeVisible()
  await heading('Credentials').click()
  await expect(folder('Credentials').getByText('No visible objects.', { exact: true })).toBeVisible()
  await heading('Cryptographic Providers').click()
  await expect(folder('Cryptographic Providers').getByText('Test EKM Provider', { exact: true })).toBeVisible()
  await heading('Audits').click()
  await expect(folder('Audits').getByRole('alert')).toContainText('permission denied')
  await expect(folder('Audits').getByText('No visible objects.', { exact: true })).toHaveCount(0)
  await expect(folder('Server Roles').getByText('sysadmin', { exact: true })).toBeVisible()
  await heading('Server Audit Specifications').click()
  await expect(folder('Server Audit Specifications').getByText('LoginAuditSpec', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Query server', { exact: true })).toHaveValue(idA)
  await expect(page.getByLabel('Query database', { exact: true })).toHaveValue('AppData')
  await application.evaluate(() => { globalThis.variaAuditAllowed = true })
  await page.getByRole('button', { name: 'Refresh Object Explorer', exact: true }).click()
  await expect(folder('Audits').getByText('LoginAudit', { exact: true })).toBeVisible()
  await expect(folder('Audits').getByRole('alert')).toHaveCount(0)
  expect(await application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'server.objects.list' && call.params.kind === 'serverRoles').length)).toBe(2)
  const explorerB = page.getByRole('region', { name: 'Server server-b', exact: true })
  await explorerB.getByRole('button', { name: 'Security', exact: true }).click()
  await explorerB.getByRole('button', { name: 'Server Roles', exact: true }).click()
  await expect(explorerB.getByText('sysadmin', { exact: true })).toBeVisible()
  expect(await application.evaluate(() => globalThis.variaCalls.filter(call => call.method === 'server.objects.list' && call.params.kind === 'serverRoles').map(call => call.params.connectionId))).toEqual([idA, idA, idB])
  await explorerB.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(folder('Server Roles').getByText('sysadmin', { exact: true })).toBeVisible()
  for (const label of ['Logins', 'Credentials', 'Cryptographic Providers', 'Audits', 'Server Audit Specifications']) await heading(label).click()
  await page.screenshot({ path: artifact('object-explorer.png') })

  // Independent running state and cancellation for queries on two servers.
  await typeSql('WAIT_FOR_CANCEL')
  await page.getByRole('button', { name: /Execute/ }).click()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
  await page.locator('.query-tabs').getByRole('tab', { name: tabB, exact: true }).click()
  await typeSql('WAIT_FOR_CANCEL')
  await page.getByRole('button', { name: /Execute/ }).click()
  await expect(page.locator('.query-tabs .online')).toHaveCount(2)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.query-tabs .online')).toHaveCount(1)
  await page.locator('.query-tabs').getByRole('tab', { name: tabA, exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.query-tabs .online')).toHaveCount(0)
  await typeSql('SELECT 1;')
  await page.getByRole('button', { name: /Execute/ }).click()
  await expect(page.locator('.results-grid')).toContainText('server-a')
  await page.locator('.query-tabs').getByRole('tab', { selected: true }).focus()
  await page.keyboard.press('Space')
  await page.screenshot({ path: artifact('workbench.png') })
  await page.getByRole('button', { name: 'Disconnect server-b', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Server server-b', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Query server', { exact: true })).toHaveValue(idA)
  await page.locator('.query-tabs').getByRole('tab', { name: tabB, exact: true }).click()
  await expect(page.getByLabel('Query server', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: /Execute/ })).toBeDisabled()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 700))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
  const alignment = await page.evaluate(() => {
    const center = element => { const box = element.getBoundingClientRect(); return box.y + box.height / 2 }
    const label = document.querySelector('label[for="query-database"]')
    const select = document.querySelector('#query-database')
    const headings = [...document.querySelectorAll('.tree-heading')].filter(element => element.getBoundingClientRect().height > 0)
    const distances = headings.flatMap(element => [element.querySelector('.node-label'), element.querySelector('.tree-count')].filter(Boolean).map(part => Math.abs(center(element.querySelector('.icon')) - center(part))))
    const safe = navigator.windowControlsOverlay.getTitlebarAreaRect()
    return { field: Math.abs(center(label) - center(select)), tree: Math.max(...distances), headingCount: headings.length, titleBarFits: document.querySelector('.title-bar-content').getBoundingClientRect().right <= safe.x + safe.width + 1, overflow: document.documentElement.scrollWidth > window.innerWidth }
  })
  expect(alignment.field).toBeLessThan(1)
  expect(alignment.headingCount).toBeGreaterThan(6)
  expect(alignment.tree).toBeLessThan(1)
  expect(alignment.overflow).toBe(false)
  expect(alignment.titleBarFits).toBe(true)
  await page.screenshot({ path: artifact('workbench-compact.png') })
  expect(failures).toEqual([])
  console.log('Electron regression checks passed: integrated title bar and native controls, menu IPC and keyboard access, real .NET health, tab-switch undo/redo, save while typing and saved undo boundaries, file shortcuts and round trips, inactive-tab close with pending confirmation, unsaved close/quit, tab focus, selection execution and query shortcuts, zero timeout, retarget execution guard, two-server routing, SSMS explorer catalogs, per-tab execution sessions, partial results with statistics and batch errors, escaped XML plans, concurrent cancellation, and alignment.')
} catch (error) {
  const page = await application.firstWindow()
  await page.screenshot({ path: artifact('workbench-failure.png') }).catch(() => {})
  console.log(await page.evaluate(() => ({ title: document.title, focused: document.activeElement?.outerHTML.slice(0, 500), hasFocus: document.hasFocus(), errors: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent) })))
  throw error
} finally {
  await dialogs({ closeResponse: 1, holdSave: false, holdConfirm: false }).catch(() => {})
  await application.evaluate(() => {
    globalThis.variaReleaseSave?.(); globalThis.variaReleaseConfirm?.(); globalThis.variaReleaseSessionClose?.()
    globalThis.variaHoldSessionClose = false
    for (const resolve of Object.values(globalThis.variaPending ?? {})) resolve({ ok: false, error: 'Test cleanup' })
  }).catch(() => {})
  const cleanupPage = await application.firstWindow().catch(() => undefined)
  if (cleanupPage) await expect(cleanupPage.getByRole('button', { name: 'Open', exact: true })).toBeEnabled().catch(() => {})
  await application.close()
  await rm(profile, { recursive: true, force: true })
}
