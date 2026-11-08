import { activeDocumentName, backendReady, documentTabs, outputStatus, outputView, planCanvas, planViewer, queryBarButton, quickInputActive } from './ui.mjs'

/** Crash the real sidecar while one tab profiles, inspect only that run's collector from another query tab,
 * reconnect through the palette, and let the next toolbar capture recover it. No backend request starts a run. */
export async function checkCaptureRecovery({ application, page, expect, run, aggregate }) {
  let name, id, recovered = false
  try {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const original = await activeDocumentName(page)
    await run("SELECT CONVERT(varchar(36),connection_id) AS capture_physical_id FROM sys.dm_exec_connections WHERE session_id=@@SPID AND parent_connection_id IS NULL;\nGO\n"
      + aggregate.replace('CROSS JOIN source b', 'CROSS JOIN source b CROSS JOIN source c'))
    await outputView(page, /^Results/).click()
    const physical = page.getByRole('gridcell').filter({ hasText: /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i })
    await expect(physical).toHaveCount(1)
    id = (await physical.innerText()).replaceAll('-', '').toLowerCase()
    await outputView(page, /^Execution plan/).click()
    await expect(planViewer(page).getByRole('button', { name: 'Live', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    await page.keyboard.press(`${mod}+n`)
    await expect(queryBarButton(page, 'Include Live Execution Plan')).toHaveAttribute('aria-pressed', 'false')
    await expect(queryBarButton(page, 'Include Actual Execution Plan')).toHaveAttribute('aria-pressed', 'false')
    await run(`SELECT name AS isolated_collector FROM sys.server_event_sessions WHERE SUBSTRING(name,46,32)=N'${id}' AND name LIKE N'VariaActual[_]%';`)
    await expect(outputStatus(page)).toContainText(/^Completed/)
    await outputView(page, /^Results/).click()
    const collector = page.getByRole('gridcell').filter({ hasText: /^VariaActual_[0-9a-f]{32}_[0-9a-f]{32}_[0-9a-f]{32}$/ })
    await expect(collector).toHaveCount(1)
    name = await collector.innerText()
    const generation = await application.evaluate(() => globalThis.__variaTest.state().generation)
    await application.evaluate(() => globalThis.__variaTest.kill())
    await expect.poll(() => application.evaluate(() => globalThis.__variaTest.state().generation), { timeout: 30_000 }).toBe(generation + 1)
    await expect(backendReady(page)).toBeVisible({ timeout: 30_000 })
    await documentTabs(page).getByRole('tab', { name: original, exact: true }).click()
    await outputView(page, /^Execution plan/).click()
    await expect(planViewer(page)).toContainText(/partial/i)
    await outputView(page, 'Client Statistics').click()
    await expect(page.getByRole('status').filter({ hasText: /unavailable/ })).toBeVisible()
    // Reconnect retargets every query tab, while keeping its independent capture toggles.
    await page.keyboard.press('F1'); await page.keyboard.type('reconnect')
    await expect(quickInputActive(page)).toContainText('Connection: Reconnect')
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
    await expect(dialog).toBeVisible()
    if (process.env.VARIA_TEST_SQL_USER?.trim()) await dialog.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD)
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.keyboard.press(`${mod}+n`)
    const count = `SELECT COUNT(*) AS isolated_remaining FROM sys.server_event_sessions WHERE name=N'${name}';`
    await run(count)
    await expect(outputStatus(page)).toContainText(/^Completed/)
    await outputView(page, /^Results/).click()
    await expect(page.getByRole('gridcell', { name: '1', exact: true })).toBeVisible()
    // A killed client can precede SQL Server observing its socket loss. Recovery correctly preserves connections
    // the server still reports alive; wait on that condition before expecting the next capture to remove it.
    const ids = name.split('_').slice(2).map(value => value.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'))
    const alive = `SELECT 1 FROM sys.dm_exec_connections WHERE connection_id IN ('${ids[0]}','${ids[1]}') OR parent_connection_id IN ('${ids[0]}','${ids[1]}')`
    await run(`DECLARE @until datetime2=DATEADD(second,5,SYSDATETIME()); WHILE EXISTS(${alive}) AND SYSDATETIME()<@until WAITFOR DELAY '00:00:00.025'; SELECT COUNT(*) AS physical_connections_remaining FROM (${alive}) AS c(n);`)
    await outputView(page, /^Results/).click()
    await expect(page.getByRole('gridcell', { name: '0', exact: true })).toBeVisible()
    await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled()
    await queryBarButton(page, 'Include Actual Execution Plan').click()
    await run('SELECT TOP (1) name AS recovered_capture FROM sys.all_objects ORDER BY object_id;')
    await expect(queryBarButton(page, 'Display Estimated Execution Plan')).toBeEnabled()
    await outputView(page, /^Execution plan/).click()
    await expect(planCanvas(page).locator('canvas')).toHaveCount(1)
    await queryBarButton(page, 'Include Actual Execution Plan').click()
    await run(count)
    await expect(outputStatus(page)).toContainText(/^Completed/)
    await outputView(page, /^Results/).click()
    await expect(page.getByRole('gridcell', { name: '0', exact: true })).toBeVisible()
    recovered = true
    console.log('Capture recovery: real backend loss, partial live data, unavailable statistics, multiple tabs, reconnect and next-capture orphan removal passed.')
  } finally {
    if (id && !recovered) {
      // Teardown alone uses a direct, bounded request on a fresh connection so a UI assertion cannot leave the
      // deliberately orphaned fixture behind. Its physical target ID scopes the drop to this test's own collector.
      const options = { server: process.env.VARIA_TEST_SQL_SERVER, database: 'master', authentication: process.env.VARIA_TEST_SQL_USER?.trim() ? 'sql' : 'windows',
        username: process.env.VARIA_TEST_SQL_USER, password: process.env.VARIA_TEST_SQL_PASSWORD, trustServerCertificate: true }
      await page.evaluate(async ({ options, id }) => {
        const connection = await window.varia.connect(options)
        if (!connection.ok) throw new Error('Collector teardown could not connect.')
        const sessionId = crypto.randomUUID()
        try {
          const sql = `DECLARE @name sysname=(SELECT TOP(1) name FROM sys.server_event_sessions WHERE SUBSTRING(name,46,32)=N'${id}' AND name LIKE N'VariaActual[_]%' ORDER BY event_session_id);
            IF @name IS NOT NULL BEGIN DECLARE @sql nvarchar(max)=N'DROP EVENT SESSION '+QUOTENAME(@name)+N' ON SERVER;'; EXEC sys.sp_executesql @sql; END;`
          const result = await window.varia.execute({ connectionId: connection.value.id, sessionId, database: 'master', sql, queryId: crypto.randomUUID(), maxRows: 0, timeoutSeconds: 5, maxResultSets: 1 })
          if (!result.ok || result.value.status !== 'completed') throw new Error('Collector teardown failed.')
        } finally {
          await window.varia.closeQuerySession(sessionId)
          await window.varia.disconnect(connection.value.id)
        }
      }, { options, id })
    }
  }
}
