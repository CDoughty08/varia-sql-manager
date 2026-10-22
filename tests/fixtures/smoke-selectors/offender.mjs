// A suite as they were: '.status-bar' in a comment is not a selector.
await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click()
await expect(page.locator('.query-tab.active .dirty-dot')).toHaveCount(1)
await page.evaluate(column => document.querySelector(`.rg-c[aria-colindex="${column}"]`), 2)
await expect(page.locator('.monaco-editor .view-lines')).toContainText('saved-query.sql')
await expect(page.getByText(/\.toolbar · Ready/)).toBeVisible()
await expect(cell(0, 0)).toHaveClass(/is-sel/)
const error = item.classList.contains('error')
await expect(findWidget).toHaveClass(/\bvisible\b/)
