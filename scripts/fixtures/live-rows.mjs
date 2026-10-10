// Numbered rows shaped like W1 from a real SQL Server (results-smoke part B and grid-bench --live): eight columns of int,
// text, datetime2(7), decimal, uniqueidentifier, a longer text, bit and an int that is NULL in every fifth row, with the
// text SSMS shows for each, so a copy or a saved file can be compared exactly. The rows come from a cross join every
// version from 2016 has (about 2,600² rows on SQL Server 2022), cheap for the server to produce.

export const liveColumns = ['id', 'name', 'created', 'amount', 'key', 'note', 'active', 'score']

/** `top` rows numbered from 1; `ordered` sorts by the number (no sort is needed: the numbers come in order). */
export const liveRowsSql = (top, { ordered = true } = {}) => `SELECT TOP (${top}) n AS id, CONCAT(N'Customer ', n) AS name,
  DATEADD(SECOND, n, CAST('2026-01-01' AS datetime2(7))) AS created, CAST(n % 100000 / 100.0 AS decimal(18,2)) AS amount,
  CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS uniqueidentifier) AS [key],
  CONCAT(N'Note ', n, N': Lorem ipsum dolor sit amet, consectetur adipiscing elit') AS note,
  CAST(n % 2 AS bit) AS active, CASE WHEN n % 5 = 0 THEN NULL ELSE n % 1000 END AS score
FROM (SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b) AS numbers${ordered ? '\nORDER BY n' : ''};`

/** Row `n`'s cells as the grid shows them (NULL as null). */
export function liveRow(n) {
  const created = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString().slice(0, 19).replace('T', ' ') + '.0000000'
  const cents = n % 100000
  return [String(n), `Customer ${n}`, created, `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`, '6F9619FF-8B86-D011-B42D-00C04FC964FF',
    `Note ${n}: Lorem ipsum dolor sit amet, consectetur adipiscing elit`, String(n % 2), n % 5 === 0 ? null : String(n % 1000)]
}

/** Fills the Connect dialog for VARIA_TEST_SQL_SERVER (SQL authentication when a test login is set) and connects. */
export async function connectLive(page, expect) {
  const user = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
  await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
  await dialog.getByLabel('Server Name', { exact: true }).fill(process.env.VARIA_TEST_SQL_SERVER)
  if (user) {
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
    await dialog.getByLabel('User Name', { exact: true }).fill(user)
    await dialog.getByLabel('Password', { exact: true }).fill(process.env.VARIA_TEST_SQL_PASSWORD)
  } else await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await dialog.getByLabel('Trust server certificate', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30000 })
}
