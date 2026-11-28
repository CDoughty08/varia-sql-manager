// End-to-end Electron smoke checks for Multi-Server & Cross-Engine Query Execution:
// Object Explorer multi-select + engine-homogeneity lock, MultiTargetPopover + Apply database to all,
// MultiExecuteDialog (SQL Server Coordinated Transaction + BigQuery inline dry-run cost breakdown),
// composited results (Summary, Combined live grid, Messages server filter pills), 1-target shortcut,
// and Cross-Engine Dual-Dialect Split / -- #Dialect File sync + Layer 2 Read-Only Guard + execution.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { explorerRow, explorerStatics } from './fixtures/explorer-tree.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import {
  anyResultGrid, backendReady, connectDialogWindow, crossEngineBar, crossEngineGuardStrip, crossEnginePane,
  expectEditorShown, explorerMultiBar, gridCell, messagesFilterBar, multiExecuteDialog, multiRunSummary, multiTargetPopover,
  multiTargetTrigger, outputView, queryBarButton, quickInputBox, resultTab, submitConnect, toolbarButton
} from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'multi-server-query-profile-'))
const env = {
  ...process.env,
  VARIA_SMOKE_TEST: '1',
  VARIA_TEST_USER_DATA: profile,
  VARIA_BACKEND_TEST_HOOKS: '1',
  VARIA_RESULT_BUDGET_BYTES: String(256 * 1024 * 1024),
  VARIA_TEST_BIGQUERY_ENDPOINT: 'http://127.0.0.1:9050'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.VARIA_TEST_BACKEND
delete env.VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
let application, watchdog, page
const failures = []

async function setEditorValue(text, container = page) {
  const editor = container.locator('.monaco-editor[role="code"] .view-lines').filter({ visible: true }).first()
  await editor.click()
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.insertText(text)
}

try {
  application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  watchdog = setTimeout(() => { console.error('Multi-server query suite exceeded its time limit.'); application?.process()?.kill(); process.exit(1) }, 300_000)
  watchdog.unref?.()
  page = await application.firstWindow()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => failures.push(error.message))

  await expect(backendReady(page)).toBeVisible({ timeout: 30000 })
  await expectEditorShown(page)
  await application.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows()[0].showInactive()
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  await resizeContent(application, page, 1360, 860)

  const serverMeta = {
    'prod-sql-east-01': { providerId: 'sqlserver', server: 'prod-sql-east-01', database: 'OrdersDB', color: '#e66b73', environment: 'Production', login: 'sa', serverVersion: '16.00.4135' },
    'stage-sql-01': { providerId: 'sqlserver', server: 'stage-sql-01', database: 'OrdersDB_Stage', color: '#e6a15c', environment: 'Staging', login: 'sa', serverVersion: '16.00.4135' },
    'bq-analytics-01': { providerId: 'bigquery', server: 'bq-analytics-01', database: 'sales_prod', color: '#71a7df', environment: 'Production', login: 'analytics@corp.iam.gserviceaccount.com', serverVersion: 'BigQuery' },
    'bq-warehouse-02': { providerId: 'bigquery', server: 'bq-warehouse-02', database: 'warehouse_stage', color: '#79bb8b', environment: 'Staging', login: 'etl@corp.iam.gserviceaccount.com', serverVersion: 'BigQuery' }
  }

  await application.evaluate(({ ipcMain }, { statics, meta }) => {
    const ok = value => ({ ok: true, value })
    const folders = (owner, ids) => ids.map(folder => ({ ref: { type: 'folder', owner, folder }, label: statics.labels[folder], icon: 'folder', hasChildren: true }))
    const object = (value, label, icon, extra = {}) => ({ ref: { type: 'object', object: value }, label, icon, hasChildren: true, ...extra })
    const byConnId = new Map()
    const GiB = 1024 ** 3
    globalThis.__multiSmokeCalls = []
    globalThis.__multiSmokeUnhandled = []

    ipcMain.removeHandler('varia:connections-accept')
    ipcMain.handle('varia:connections-accept', () => ok({ accepted: true, retained: true }))
    ipcMain.removeHandler('varia:request')
    ipcMain.handle('varia:request', async (_event, method, params, context) => {
      switch (method) {
        case 'system.health':
          return ok({ protocolVersion: 2, runtime: 'stub', platform: process.platform, smoVersion: 'stub', sqlClientVersion: 'stub' })
        case 'connections.connect': {
          const key = params.provider === 'bigquery' ? params.project : params.server
          const m = meta[key]
          const isBq = params.provider === 'bigquery' || m?.providerId === 'bigquery'
          const principalId = isBq ? `bigquery:gcloud:${m?.login ?? 'analytics@corp.iam.gserviceaccount.com'}` : 'sid:01020304'
          const id = crypto.randomUUID()
          byConnId.set(id, { key, ...m, isBq })
          return ok({
            id,
            providerId: isBq ? 'bigquery' : 'sqlserver',
            server: m?.server ?? key,
            database: m?.database ?? (isBq ? 'sales_prod' : 'master'),
            color: m?.color,
            environment: m?.environment,
            serverVersion: m?.serverVersion ?? (isBq ? 'BigQuery' : '16.00.4135'),
            productVersion: isBq ? 'BigQuery' : '16.00.4135.4',
            login: m?.login ?? 'sa',
            engineEdition: isBq ? undefined : 3,
            generation: 1,
            targetId: context?.targetId ?? crypto.randomUUID(),
            principalId,
            authentication: isBq
              ? { principal: { provider: 'bigquery', project: key, principal: principalId } }
              : { principal: { provider: 'sqlserver', authentication: params.authentication || 'windows', id: principalId } }
          })
        }
        case 'connections.disconnect':
          return ok({ disconnected: true })
        case 'connections.identity':
          return ok({})
        case 'databases.list': {
          const info = byConnId.get(params.connectionId)
          if (info?.isBq) {
            return ok([
              { name: 'sales_prod', isSystem: false, isSnapshot: false },
              { name: 'warehouse_stage', isSystem: false, isSnapshot: false }
            ])
          }
          return ok([
            { name: 'OrdersDB', isSystem: false, isSnapshot: false },
            { name: 'OrdersDB_Stage', isSystem: false, isSnapshot: false },
            { name: 'Analytics', isSystem: false, isSnapshot: false },
            { name: 'master', isSystem: true, isSnapshot: false }
          ])
        }
        case 'bigquery.account':
          return ok({ kind: 'emulator', account: 'analytics@corp.iam.gserviceaccount.com' })
        case 'bigquery.projects':
        case 'bigquery.connectionProjects':
          return ok({ projects: [] })
        case 'bigquery.indexEstimate':
          return ok({ bytesProcessed: 0 })
        case 'bigquery.dryRun': {
          const info = byConnId.get(params.connectionId)
          const bytes = info?.key === 'bq-analytics-01' ? Math.round(14.6 * GiB) : Math.round(2.4 * GiB)
          return ok({ bytesProcessed: bytes })
        }
        case 'live.subscribe':
          return ok({ subscriptionId: crypto.randomUUID(), intervalMs: 10000 })
        case 'live.unsubscribe':
          return ok({ unsubscribed: true })
        case 'language.status':
          return ok({ available: false, state: 'unavailable' })
        case 'language.diagnostics':
          return ok({ diagnostics: [] })
        case 'language.close':
          return ok({ closed: true })
        case 'language.refresh':
          return ok({ refreshed: true })
        case 'explorer.children': {
          const { node } = params
          if (node.type === 'object') {
            const list = folders(node.object, statics.objects[node.object.kind] ?? [])
            return ok({ nodes: list, total: list.length, elapsedMs: 1 })
          }
          if (node.type === 'folder' && node.folder === 'databases') {
            const rows = [object({ kind: 'database', name: 'OrdersDB' }, 'OrdersDB', 'database')]
            const nodes = [...folders(node.owner, statics.folders.databases), ...rows]
            return ok({ nodes, total: nodes.length, elapsedMs: 1 })
          }
          if (node.type === 'folder') {
            const nodes = folders(node.owner, statics.folders[node.folder] ?? [])
            return ok({ nodes, total: nodes.length, elapsedMs: 1 })
          }
          return ok({ nodes: [], total: 0, elapsedMs: 1 })
        }
        case 'explorer.index':
          return ok({ status: { state: 'ready', databases: 1, indexed: 1, objects: 4, modules: 0, cut: 0, skipped: [], definitions: true, builtAt: '2026-11-27T12:00:00Z' }, elapsedMs: 1 })
        case 'query.session.close':
          return ok({ closed: true })
        case 'query.session.state':
          return ok({ transactionCount: 0, checked: true })
        case 'results.visibility':
          return ok({ applied: true })
        case 'query.executeMulti': {
          globalThis.__multiSmokeCalls.push({
            mode: params.mode,
            scripts: params.scripts,
            targets: (params.targets ?? []).map(t => ({ label: t.label, database: t.database, dataset: t.dataset }))
          })
          const targets = params.targets ?? []
          const mode = params.mode ?? 'transaction'
          const resultSets = []
          const outcomes = []
          const messages = []
          let idx = 0
          for (let i = 0; i < targets.length; i++) {
            const t = targets[i]
            const info = byConnId.get(t.connectionId)
            const synth = await globalThis.__variaTest.synthesize('W1', 4)
            const desc = { ...synth, index: idx++, kind: 'rows', targetKey: t.targetKey, statementSlot: 0, name: 'SummaryRows' }
            resultSets.push(desc)
            outcomes.push({
              targetKey: t.targetKey,
              provider: info?.isBq ? 'bigquery' : 'sqlserver',
              label: t.label ?? info?.server ?? t.targetKey,
              environment: t.environment ?? info?.environment,
              status: mode === 'transaction' ? 'committed' : 'succeeded',
              batchesCompleted: 1,
              batchesTotal: 1,
              rowsAffected: 10 + i * 5,
              elapsedMs: 40 + i * 10,
              resultSetIds: [desc.resultId]
            })
            messages.push({ text: `Completed on ${t.label ?? info?.server}.`, kind: 'info', targetKey: t.targetKey })
          }
          if (params.autoCombine !== false && targets.length >= 2) {
            const combSynth = await globalThis.__variaTest.synthesize('W1', targets.length * 4)
            resultSets.push({ ...combSynth, index: idx++, kind: 'combined', statementSlot: 0, name: 'SummaryRows' })
          }
          messages.unshift({ text: `Coordinator finished ${targets.length} targets.`, kind: 'info' })
          return ok({
            status: 'completed',
            mode,
            targets: outcomes,
            resultSets,
            discardedResultSets: 0,
            messages,
            messagesTruncated: false,
            elapsedMs: 95,
            budget: { usedBytes: 4096, globalBytes: 256 * 1024 * 1024, queryBytes: 128 * 1024 * 1024, generation: 1, seq: 1 },
            completedAt: new Date().toISOString()
          })
        }
        default:
          globalThis.__multiSmokeUnhandled.push(method)
          return { ok: false, error: 'Unsupported stub operation: ' + method }
      }
    })
  }, { statics: explorerStatics(), meta: serverMeta })

  async function connectSql(name) {
    await toolbarButton(page, 'Connect').click()
    const { window: connectWin, dialog } = await connectDialogWindow(application)
    await dialog.getByLabel('Server Name', { exact: true }).fill(name)
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
    await submitConnect(connectWin, dialog, { timeout: 15000 })
    await explorerRow(page, name)
  }

  async function connectBq(project) {
    await toolbarButton(page, 'Connect').click()
    const { window: connectWin, dialog } = await connectDialogWindow(application)
    await dialog.getByRole('group', { name: 'Server type', exact: true }).getByRole('button', { name: 'BigQuery', exact: true }).click()
    await expect(dialog.getByText(/^Emulator account /)).toBeVisible({ timeout: 15000 })
    await dialog.getByLabel('Project', { exact: true }).fill(project)
    await submitConnect(connectWin, dialog, { timeout: 15000 })
    await explorerRow(page, project)
  }

  await connectSql('prod-sql-east-01')
  await connectSql('stage-sql-01')
  await connectBq('bq-analytics-01')
  await connectBq('bq-warehouse-02')

  const rowEast = await explorerRow(page, 'prod-sql-east-01')
  const rowStage = await explorerRow(page, 'stage-sql-01')
  const rowBq1 = await explorerRow(page, 'bq-analytics-01')
  const rowBq2 = await explorerRow(page, 'bq-warehouse-02')

  // 1. Object Explorer multi-select + engine homogeneity lock + New Multi-Server Query.
  await rowEast.click()
  await rowStage.click({ modifiers: [mod] })
  const bar = explorerMultiBar(page)
  await expect(bar).toContainText('2 SQL Servers selected')
  await expect(rowBq1).toContainText('SQL only')
  await bar.getByRole('button', { name: 'New Query', exact: true }).click()
  await expect(multiTargetTrigger(page)).toContainText('2 SQL Servers')
  await expect(multiTargetTrigger(page)).toContainText('1 PROD')

  // 2. Multi-Target Popover + Apply database to all.
  await multiTargetTrigger(page).click()
  const popover = multiTargetPopover(page)
  await expect(popover).toBeVisible()
  await popover.getByLabel('Shared database for all SQL Servers', { exact: true }).selectOption('Analytics')
  await popover.getByRole('button', { name: 'Apply database to all', exact: true }).click()
  await expect(popover.getByLabel('prod-sql-east-01 database', { exact: true })).toHaveValue('Analytics')
  await expect(popover.getByLabel('stage-sql-01 database', { exact: true })).toHaveValue('Analytics')
  await popover.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(popover).toHaveCount(0)

  // 3. SQL Server Run Mode Prompt + Composited Results (Summary, Combined, Messages filter).
  await setEditorValue("UPDATE dbo.Orders SET Status = 'Archived' WHERE Id = 1;\nSELECT 1 AS Done;")
  await queryBarButton(page, 'Execute').click()
  const execDialog = multiExecuteDialog(page)
  await expect(execDialog).toBeVisible()
  await expect(execDialog).toContainText('1 DML (UPDATE)')
  await expect(execDialog).toContainText('1 SELECT')
  await execDialog.getByRole('button', { name: /Run Transaction on 2 Servers \(1 PROD\)/ }).click()
  await expect(execDialog).toHaveCount(0)

  const summary = multiRunSummary(page)
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('Committed')
  await expect(summary).toContainText('prod-sql-east-01')
  await expect(summary).toContainText('stage-sql-01')

  await resultTab(page, /^Combined \(2\/2\)/).click()
  await expect(anyResultGrid(page)).toHaveCount(1)
  await expect(gridCell(anyResultGrid(page), 0, 0)).toBeVisible()

  await outputView(page, /^Messages/).click()
  const filterBar = messagesFilterBar(page)
  await expect(filterBar).toBeVisible()
  await filterBar.getByRole('button', { name: 'stage-sql-01', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Messages', exact: true })).toContainText('Completed on stage-sql-01.')
  await expect(page.getByRole('log', { name: 'Messages', exact: true })).not.toContainText('Completed on prod-sql-east-01.')

  // 4. Single-enabled-target shortcut skips Run Mode prompt.
  const callsBeforeSingle = await application.evaluate(() => globalThis.__multiSmokeCalls.length)
  await multiTargetTrigger(page).click()
  await expect(popover).toBeVisible()
  await popover.getByLabel('Disable stage-sql-01', { exact: true }).click()
  await popover.getByRole('button', { name: 'Done', exact: true }).click()
  await queryBarButton(page, 'Execute').click()
  await expect(multiExecuteDialog(page)).toHaveCount(0)
  await expect(multiRunSummary(page)).toContainText('Completed')
  await expect(multiRunSummary(page)).toContainText('1 of 1 server')
  expect(await application.evaluate(() => globalThis.__multiSmokeCalls.length)).toBe(callsBeforeSingle + 1)
  const lastSingle = await application.evaluate(() => globalThis.__multiSmokeCalls.at(-1))
  expect(lastSingle.mode).toBe('fireAndForget')
  expect(lastSingle.targets).toHaveLength(1)
  expect(lastSingle.targets[0].database).toBe('Analytics')

  // 5. BigQuery Run Mode Prompt with live dry-run cost breakdown.
  await bar.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await rowBq1.click()
  await rowBq2.click({ modifiers: [mod] })
  await expect(bar).toContainText('2 BigQuery Projects selected')
  await bar.getByRole('button', { name: 'New Query', exact: true }).click()
  await expect(multiTargetTrigger(page)).toContainText('2 BigQuery projects')
  await setEditorValue('SELECT region, COUNT(*) AS n FROM sales_prod.orders GROUP BY region;')
  await queryBarButton(page, 'Execute').click()
  const bqDialog = multiExecuteDialog(page)
  await expect(bqDialog).toBeVisible()
  await expect(bqDialog).toContainText('Estimated BigQuery Cost')
  await expect(bqDialog).toContainText('Exceeds cost threshold')
  await expect(bqDialog.getByRole('button', { name: /Run on 2 Projects/ })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(bqDialog).toHaveCount(0)

  // 6. Cross-Engine Dual-Dialect Split, -- #Dialect File sync, Layer 2 Read-Only Guard, and valid execution.
  await bar.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await rowEast.click()
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await quickInputBox(page).fill('>New Cross-Engine SELECT')
  await page.getByRole('option', { name: /New Cross-Engine SELECT/i }).first().click()
  await expect(crossEngineBar(page)).toBeVisible()

  const sqlPane = crossEnginePane(page, 'sqlserver')
  const bqPane = crossEnginePane(page, 'bigquery')
  await expect(sqlPane).toBeVisible()
  await expect(bqPane).toBeVisible()
  await setEditorValue('SELECT TOP 5 1 AS Id;', sqlPane)
  await setEditorValue('SELECT 1 AS Id LIMIT 5;', bqPane)

  // Toggle Dual-Dialect Split -> -- #Dialect File -> Dual-Dialect Split and verify serialization round-trip.
  await crossEngineBar(page).getByRole('button', { name: '-- #Dialect File', exact: true }).click()
  const fileView = page.locator('.monaco-editor[role="code"] .view-lines').filter({ visible: true }).first()
  await expect(fileView).toContainText('#Dialect="sqlserver"')
  await expect(fileView).toContainText('SELECT TOP 5 1 AS Id;')
  await expect(fileView).toContainText('#Dialect="bigquery"')
  await expect(fileView).toContainText('SELECT 1 AS Id LIMIT 5;')
  await crossEngineBar(page).getByRole('button', { name: 'Dual-Dialect Split', exact: true }).click()
  await expect(sqlPane).toBeVisible()
  await expect(sqlPane.locator('.monaco-editor[role="code"] .view-lines').first()).toContainText('SELECT TOP 5 1 AS Id;')
  await expect(bqPane.locator('.monaco-editor[role="code"] .view-lines').first()).toContainText('SELECT 1 AS Id LIMIT 5;')

  // Layer 2 Read-Only Guard blocks DELETE with zero IPC sent and logs READ_ONLY_VIOLATION.
  const callsBeforeBlocked = await application.evaluate(() => globalThis.__multiSmokeCalls.length)
  await setEditorValue("DELETE FROM dbo.Orders WHERE Status = 'Cancelled';", sqlPane)
  const guardStrip = crossEngineGuardStrip(sqlPane)
  await expect(guardStrip).toBeVisible()
  await expect(guardStrip).toContainText('Read-only guard')
  await expect(guardStrip.getByRole('button', { name: 'Next blocked', exact: true })).toBeVisible()
  await expect(guardStrip.getByRole('button', { name: 'Open in SQL Server tab', exact: true })).toBeVisible()
  await queryBarButton(page, 'Execute').click()
  await expect(page.getByRole('log', { name: 'Messages', exact: true })).toContainText('READ_ONLY_VIOLATION')
  expect(await application.evaluate(() => globalThis.__multiSmokeCalls.length)).toBe(callsBeforeBlocked)

  // Restore read-only SELECT and execute Cross-Engine run (confirms aggregated BigQuery cost prompt first).
  const callsBeforeCross = await application.evaluate(() => globalThis.__multiSmokeCalls.length)
  await setEditorValue('SELECT TOP 5 1 AS Id;', sqlPane)
  await expect(guardStrip).toHaveCount(0)
  await queryBarButton(page, 'Execute').click()
  const costDialog = page.getByRole('alertdialog', { name: 'Run this query?', exact: true })
  await expect(costDialog).toBeVisible()
  await expect(costDialog).toContainText('bq-analytics-01')
  await expect(costDialog).toContainText('14.60 GiB')
  await costDialog.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(costDialog).toHaveCount(0)
  const crossSummary = multiRunSummary(page)
  await expect(crossSummary).toBeVisible()
  await expect(crossSummary).toContainText('Completed')
  await expect(crossSummary).toContainText('prod-sql-east-01')
  await expect(crossSummary).toContainText('bq-analytics-01')
  expect(await application.evaluate(() => globalThis.__multiSmokeCalls.length)).toBe(callsBeforeCross + 1)
  const lastCross = await application.evaluate(() => globalThis.__multiSmokeCalls.at(-1))
  expect(lastCross.mode).toBe('crossEngineReadOnly')
  expect(lastCross.targets.map(t => t.label)).toEqual(expect.arrayContaining(['prod-sql-east-01', 'bq-analytics-01']))
  expect(lastCross.scripts?.sqlserver).toContain('SELECT TOP 5 1 AS Id;')
  expect(lastCross.scripts?.bigquery).toContain('SELECT 1 AS Id LIMIT 5;')

  expect(await application.evaluate(() => globalThis.__multiSmokeUnhandled)).toEqual([])
  expect(failures).toEqual([])
  console.log('Multi-server & Cross-Engine smoke checks passed.')
} catch (error) {
  const unhandled = await application?.evaluate(() => globalThis.__multiSmokeUnhandled ?? []).catch(() => [])
  if (unhandled?.length) console.error('Unhandled stub RPCs:', unhandled)
  await page?.screenshot({ path: resolve('artifacts', 'multi-server-query-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.close().catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
