import { expect } from './smoke.mjs'
import { documentTab, helpPage, quickInputBox } from './ui.mjs'

/** Shares the updates suite's isolated app/profile; no extra CI job, server or launch. */
export async function gettingStartedSmoke(page, menu, application) {
  await menu('help.gettingStarted')
  const home = helpPage(page), search = home.getByRole('searchbox', { name: 'Find a guide' })
  await expect(search).toBeFocused()
  await home.screenshot({ path: 'artifacts/getting-started.png' })
  await search.fill('no-such-guide')
  await expect(home.getByText('No guides match', { exact: true })).toBeVisible()
  await home.getByRole('button', { name: 'Clear search', exact: true }).click()
  await search.fill('authentication')
  await home.getByRole('button', { name: /Connect to SQL Server/ }).click()
  const connect = helpPage(page, 'Connect to SQL Server')
  await expect(connect.getByRole('button', { name: 'All guides', exact: true })).toBeFocused()
  await connect.getByRole('combobox', { name: 'Sample authentication', exact: true }).selectOption('entraMfa')
  await expect(connect).toContainText('Connecting opens your browser for sign-in.')
  await connect.screenshot({ path: 'artifacts/getting-started-connect.png' })
  await connect.getByRole('button', { name: 'All guides', exact: true }).click()
  await home.getByRole('button', { name: /Run your first query/ }).click()
  const query = helpPage(page, 'Run your first query')
  await query.getByRole('button', { name: 'Select second statement', exact: true }).click()
  await expect(query).toContainText('Only the selected second statement would run: one result set.')
  await query.getByRole('navigation', { name: 'Sections', exact: true }).getByRole('button', { name: 'Choose what runs', exact: true }).click()
  await query.screenshot({ path: 'artifacts/getting-started-query.png' })

  // The reference stays mounted while main pushes an effective keyboard change and then restores it.
  const changed = await page.evaluate(async () => {
    const before = await window.varia.shortcuts.get()
    if (!before.ok) throw new Error(before.error)
    const next = { ...before.value.file, bindings: [
      ...before.value.file.bindings,
      ...['f5', 'mod+enter', 'ctrl+e'].map(key => ({ command: 'query.execute', key, remove: true })),
      { command: 'query.execute', key: 'shift+f9', scope: 'queryEditor' }
    ], gestures: { ...before.value.file.gestures, 'grid.addToSelection': 'off' } }
    const saved = await window.varia.shortcuts.save(next, before.value.revision)
    if (!saved.ok) throw new Error(saved.error)
    return before.value.file
  })
  try {
    await expect(query.getByText('Shift+F9', { exact: true })).toBeVisible()
    await query.getByRole('button', { name: 'All guides', exact: true }).click()
    await home.getByRole('button', { name: /Work with query results/ }).click()
    const results = helpPage(page, 'Work with query results')
    await results.getByRole('button', { name: 'Show Open rows only', exact: true }).click()
    await results.getByRole('button', { name: 'Sort Name ascending', exact: true }).click()
    await expect(results.getByRole('table', { name: 'Fictional returned rows' }).getByRole('row')).toHaveCount(3)
    await expect(results).toContainText('2 of 3 sample rows shown.')
    await expect(results.getByText('Off', { exact: true })).toBeVisible()
    const saved = await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.includeColumnHeaders': true }))
    if (!saved.ok) throw new Error(saved.error)
    await expect(results).toContainText('Ordinary Copy currently includes column headers.')
    await expect(results).toContainText('Include column headers when copying or saving the results: On')
    await results.getByRole('button', { name: 'Open this Options page', exact: true }).click()
    const options = page.getByRole('dialog', { name: 'Options', exact: true })
    await expect(options).toBeVisible()
    await expect(options.getByRole('checkbox', { name: 'Include column headers when copying or saving the results', exact: true })).toBeChecked()
    await options.getByRole('button', { name: 'Cancel', exact: true }).click()
    await results.getByRole('navigation', { name: 'Sections', exact: true }).getByRole('button', { name: 'Explore returned rows', exact: true }).click()
    await results.screenshot({ path: 'artifacts/getting-started-results.png' })
    await menu('theme.mode.light')
    await results.screenshot({ path: 'artifacts/getting-started-results-light.png' })
    await menu('theme.mode.dark')
    const main = await application.browserWindow(page), bounds = await main.evaluate(win => win.getBounds())
    try {
      await main.evaluate(win => win.setSize(900, 700, false))
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(results.getByRole('table', { name: 'Fictional returned rows' })).toBeVisible()
      await expect.poll(() => results.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      await results.screenshot({ path: 'artifacts/getting-started-narrow.png' })
    } finally {
      await main.evaluate((win, previous) => win.setBounds(previous), bounds)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
    }
    await expect(documentTab(page, 'Getting Started')).toHaveCount(1)
  } finally {
    await page.evaluate(async file => {
      const current = await window.varia.shortcuts.get()
      if (!current.ok) throw new Error(current.error)
      const saved = await window.varia.shortcuts.save(file, current.value.revision)
      if (!saved.ok) throw new Error(saved.error)
      const settings = await window.varia.updateSettings({ 'queryResults.grid.includeColumnHeaders': false })
      if (!settings.ok) throw new Error(settings.error)
    }, changed)
  }
  await page.keyboard.press('F1')
  await quickInputBox(page).fill('> Getting Started')
  await page.keyboard.press('Enter')
  await expect(search).toBeFocused()
}
