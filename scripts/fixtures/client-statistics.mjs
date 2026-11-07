import { outputView, queryBarButton, paneMenuButton } from './ui.mjs'

/** Exercise the feature through its normal query toolbar and output tab, within the results suite's existing launch. */
export async function checkClientStatistics(page, expect, run, live) {
  const toggle = queryBarButton(page, 'Include Client Statistics')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  const sql = live ? 'SET NOCOUNT OFF; SELECT n FROM (VALUES(1),(2),(3)) v(n);' : '-- varia-fake: sets=W1*3'
  const show = () => outputView(page, 'Client Statistics').click()
  const table = page.getByRole('table', { name: 'Client statistics comparison', exact: true })
  const row = label => table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) })
  await run(sql); await show()
  await expect(table).toBeVisible()
  await expect(row('Provider processing time (ms)').getByRole('cell').first()).toHaveText('Unavailable')
  if (live) {
    await expect(row('Server round trips').getByRole('cell').first()).toHaveText('1')
    await expect(row('SELECT rows').getByRole('cell').first()).toHaveText('3')
    expect(Number((await row('Bytes received').getByRole('cell').first().innerText()).replaceAll(',', ''))).toBeGreaterThan(0)
  } else await expect(table).toContainText('Unavailable')
  await run(sql); await show()
  await expect(page.getByLabel('Statistics execution')).toHaveValue(/.+/)
  await expect(table.getByRole('columnheader', { name: 'Previous (run 1)', exact: true })).toBeVisible({ timeout: 15000 })
  // A stub without optional statistics cannot contribute to the mean.
  await expect(table.getByRole('columnheader', { name: `Average (${live ? 2 : 0} runs)`, exact: true })).toBeVisible()
  if (live) await expect(row('Server round trips').getByRole('cell').nth(2)).toHaveText('0')
  await page.screenshot({ path: `artifacts/client-statistics-${live ? 'live' : 'fallback'}.png` })
  if (live) {
    await run("SELECT 1; RAISERROR('statistics test',16,1);")
    await show()
    await expect(table.getByRole('columnheader', { name: 'Average (2 runs)', exact: true })).toBeVisible()
    await run("SELECT 1; WAITFOR DELAY '00:00:05'; SELECT 2;", { running: true })
    await show()
    await expect(toggle).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Reset Statistics', exact: true })).toBeDisabled()
    await queryBarButton(page, 'Cancel').click()
    await expect(page.getByRole('status').filter({ hasText: /^Run 4: cancelled/ })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: 'Average (2 runs)', exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: 'Reset Statistics', exact: true }).click()
  await expect(table).toHaveCount(0)
  await expect(page.getByLabel('Statistics execution')).toBeDisabled()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  // Return the host suite to its existing three output panels.
  await paneMenuButton(page, 'statistics').click()
  await page.getByRole('menuitem', { name: 'Close', exact: true }).click()
  console.log(`Client statistics Electron checks passed (${live ? 'SQL Server' : 'optional-summary fallback'}).`)
}
