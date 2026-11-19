import { gridCell, localGrid, menuItemNames, outputView, queryBarButton, paneMenuButton } from './ui.mjs'

/**
 * Exercise the feature through its normal query toolbar and output tab, within the results suite's existing launch. The
 * report is a results grid (LocalGrid, page): it is read as Copy with Headers writes it, through the app's clipboard.
 */
export async function checkClientStatistics(page, expect, run, live, app) {
  const toggle = queryBarButton(page, 'Include Client Statistics')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  const sql = live ? 'SET NOCOUNT OFF; SELECT n FROM (VALUES(1),(2),(3)) v(n);' : '-- varia-fake: sets=W1*3'
  const show = () => outputView(page, 'Client Statistics').click()
  const table = localGrid(page, 'Client statistics comparison')
  const header = name => table.getByRole('columnheader', { name, exact: true })
  const eol = process.platform === 'win32' ? '\r\n' : '\n'
  /** Ctrl+A, Ctrl+Shift+C: the header line, then each measurement's cells by its label (Run, Previous, Change, Average, Definition). */
  const report = async run => {
    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
    await gridCell(table, 0, 0).click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Control+Shift+C')
    let text = ''
    await expect.poll(async () => (text = await app.evaluate(({ clipboard }) => clipboard.readText())).split(eol)[0]).toMatch(new RegExp(`^Measurement\\tRun ${run}\\t`))
    const lines = text.split(eol).map(line => line.split('\t'))
    return { header: lines[0], labels: lines.slice(1).map(cells => cells[0]), row: label => lines.find(cells => cells[0] === label)?.slice(1) ?? [] }
  }
  await run(sql); await show()
  await expect(table).toBeVisible()
  await expect(table).toHaveAttribute('aria-label', /^Client statistics comparison, \d+ rows, 6 columns/)
  let copied = await report(1)
  expect(copied.header).toEqual(['Measurement', 'Run 1', 'Previous', 'Change', 'Average (1 runs)', 'Definition'].map(name => live || !name.startsWith('Average') ? name : 'Average (0 runs)'))
  // The rows are an ordered report: the provider's measurements in its order, then the backend's wall time.
  expect(copied.labels[0]).toBe('Bytes sent')
  expect(copied.labels.at(-1)).toBe('Collection wall time (ms)')
  expect(copied.row('Provider processing time (ms)')[0]).toBe('Unavailable')
  if (live) {
    expect(copied.row('Server round trips')[0]).toBe('1')
    expect(copied.row('SELECT rows')[0]).toBe('3')
    expect(Number(copied.row('Bytes received')[0].replaceAll(',', ''))).toBeGreaterThan(0)
  } else expect(copied.row('Bytes sent')).toContain('Unavailable')
  // Query Output's menu without sorting (the report keeps its order), and Save Results As for this page.
  await gridCell(table, 1, 1).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Query output', exact: true })
  await expect(menu).toBeVisible()
  const items = await menuItemNames(menu)
  for (const item of ['Copy', 'Copy with Headers', 'Select All', 'Save Results As…']) expect(items).toContain(item)
  for (const item of ['Sort Ascending', 'Sort Descending', 'Clear Sort']) expect(items).not.toContain(item)
  await page.keyboard.press('Escape')
  await run(sql); await show()
  await expect(page.getByLabel('Statistics execution')).toHaveValue(/.+/)
  await expect(header('Previous (run 1)')).toBeVisible({ timeout: 15000 })
  // A stub without optional statistics cannot contribute to the mean.
  await expect(header(`Average (${live ? 2 : 0} runs)`)).toBeVisible()
  copied = await report(2)
  expect(copied.header.slice(1, 5)).toEqual(['Run 2', 'Previous (run 1)', 'Change', `Average (${live ? 2 : 0} runs)`])
  if (live) expect(copied.row('Server round trips')[2]).toBe('0')
  if (!live) {
    // An older run's report stays the same grid while another run comes and goes: its selection and drawn cells stay.
    await page.getByLabel('Statistics execution').selectOption({ index: 0 })
    await expect(header('Run 1')).toBeVisible()
    await gridCell(table, 2, 1).click()
    const kept = await gridCell(table, 2, 1).elementHandle()
    await run(sql); await show()
    await expect(page.getByLabel('Statistics execution').getByRole('option')).toHaveCount(3)
    await expect(header('Run 1')).toBeVisible()
    expect(await kept.evaluate(element => element.isConnected), 'the same grid after another run').toBe(true)
  }
  await page.screenshot({ path: `artifacts/client-statistics-${live ? 'live' : 'fallback'}.png` })
  if (live) {
    await run("SELECT 1; RAISERROR('statistics test',16,1);")
    await show()
    await expect(header('Average (2 runs)')).toBeVisible()
    await run("SELECT 1; WAITFOR DELAY '00:00:05'; SELECT 2;", { running: true })
    await show()
    await expect(toggle).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Reset Statistics', exact: true })).toBeDisabled()
    await queryBarButton(page, 'Cancel').click()
    await expect(page.getByRole('status').filter({ hasText: /^Run 4: cancelled/ })).toBeVisible()
    await expect(header('Average (2 runs)')).toBeVisible()
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
