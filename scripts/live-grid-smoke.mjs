// Live grids in the real app, on the real backend's debug.synthetic source (its test hooks; no SQL Server), through
// window.__variaLive.mountGrid: a snapshot table's rows are toned and its tone column is hidden; the selected row keeps
// its key as revisions swap in, stays one revision muted once it leaves, and then the selection moves to a neighbour,
// which the grid reports to its owner with the row's key; Copy leaves the tone out; a Save whose dialog stays open across
// samples saves the newest revision; the sort hook reorders the next revision; an append log follows its tail, counts the
// rows that arrive while it is scrolled up, opens where it was when mounted again over its kept state, and jumps back to
// the tail; a view that stops says its rows are gone, as Copy does; a killed backend's grid says it lost its rows.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gridPart, gridTones, liveGrid, liveGridFrame, liveGridNewRows, liveGridOverlay, liveGridSelector, liveGridStrip, backendReady } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'live-grid-profile-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_BACKEND_TEST_HOOKS: '1' }
delete env.ELECTRON_RUN_AS_NODE
let step = 'launch'
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error(`Live grid suite timed out during: ${step}.`); app.process()?.kill(); process.exit(1) }, 300_000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
page.on('pageerror', error => failures.push(error.message))

const live = (method, ...args) => page.evaluate(([name, values]) => window.__variaLive[name](...values), [method, args])
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
const gridName = 'Live grid'
const grid = liveGrid(page, gridName)
const frame = liveGridFrame(page, gridName)
const parts = { grid: liveGridSelector(gridName), row: gridPart.row, cell: gridPart.cell, tones: gridTones }
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
/** The rows shown, top to bottom: their row number, tone (or 'none'), and cell texts. */
const rows = () => page.evaluate(({ grid, row, cell, tones }) => {
  const toneOf = element => Object.keys(tones).find(tone => element.matches(tones[tone])) ?? 'none'
  return [...document.querySelectorAll(`${grid} ${row}`)].filter(element => element.style.display !== 'none' && element.hasAttribute('aria-rowindex'))
    .map(element => ({ index: Number(element.getAttribute('aria-rowindex')) - 2, tone: toneOf(element), top: parseFloat(element.style.top), cells: [...element.querySelectorAll(cell)].filter(item => item.style.display !== 'none').sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left)).map(item => item.textContent) }))
    .sort((a, b) => a.index - b.index)
}, parts)
/** The active cell: its row's index, tone and item id (the first column), and what a screen reader hears. */
const active = () => page.evaluate(({ grid, cell: cellPart, tones }) => {
  const root = document.querySelector(grid), cell = root && document.getElementById(root.getAttribute('aria-activedescendant') ?? '')
  const row = cell?.closest('[role="row"]')
  const first = row && [...row.querySelectorAll(cellPart)].find(item => item.getAttribute('aria-colindex') === '2')
  return cell ? { index: Number(row.getAttribute('aria-rowindex')) - 2, id: first?.textContent ?? null, label: cell.getAttribute('aria-label'), tone: Object.keys(tones).find(tone => row.matches(tones[tone])) ?? 'none' } : undefined
}, parts)

try {
  await expect(backendReady(page, /\.NET 10\./)).toHaveText('Ready', { timeout: 30000 })
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })

  step = 'tones'
  // Twelve items a sample, moving on by one id each time: the lowest id leaves at the top, a new one arrives at the bottom.
  const items = await live('subscribeSynthetic', { probes: ['debug.synthetic.grid'], tickMs: 1200, rows: 12 })
  expect(await live('mountGrid', items, 'debug.synthetic.grid', 0)).toBe(true)
  // Twelve rows of four read cells: the tone column is hidden.
  await expect.poll(async () => { const shown = await rows(); return shown.length === 12 && shown.every(row => row.cells.length === 4 && /^G\d$/.test(row.cells[1])) }).toBe(true)
  await expect(grid.locator(gridPart.columnHeader).filter({ visible: true })).toHaveText(['itemId', 'group', 'name', 'amount'])
  // Screen readers hear the owner's name for the grid, with its rows and shown columns.
  await expect(grid).toHaveAttribute('aria-label', 'Live grid, 12 rows, 4 columns')
  // G0 rows are toned error, G1 warning, G2 running, the others not at all (every group is among twelve items).
  const tones = { G0: 'error', G1: 'warning', G2: 'running' }
  await expect.poll(async () => (await rows()).map(row => `${row.cells[1]}:${row.tone === (tones[row.cells[1]] ?? 'none') ? 'ok' : row.tone}`).filter(text => !text.endsWith(':ok'))).toEqual([])
  expect(new Set((await rows()).map(row => row.tone))).toEqual(new Set(['error', 'warning', 'running', 'none']))
  await page.screenshot({ path: 'artifacts/live-grid-tones.png' })
  console.log('Tones passed: the tone column is hidden and each row has its tone.')

  step = 'key-stable selection'
  // Select the seventh row's name; as revisions swap in, the selection stays on the same item while its row moves up.
  const before = await rows()
  const chosen = before[6]
  await grid.locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^Item ${chosen.cells[0]}$`) }) }).locator(gridPart.cell).nth(2).click()
  await expect.poll(async () => (await active())?.id).toBe(chosen.cells[0])
  await expect.poll(async () => (await active())?.index, { timeout: 20000 }).toBeLessThanOrEqual(chosen.index - 2)
  expect((await active()).id).toBe(chosen.cells[0])
  // The row's tone is part of what a screen reader hears.
  const group = chosen.cells[1]
  if (tones[group]) expect((await active()).label).toContain(tones[group])
  // At the top it leaves the source: it stays one revision, muted ("ended"), then the selection moves to its neighbour.
  await expect.poll(async () => { const now = await active(); return now?.id === chosen.cells[0] && now.tone === 'muted' }, { timeout: 20000 }).toBe(true)
  expect((await active()).label).toContain('ended')
  await page.screenshot({ path: 'artifacts/live-grid-departed.png' })
  await expect.poll(async () => (await rows()).some(row => row.cells[0] === chosen.cells[0]), { timeout: 10000 }).toBe(false)
  const moved = await active()
  // The next item down, the neighbour the grid tracked with it; or, when that one left too (each sample moves the items
  // on by one, and only the selected item lingers), the row now at the old index, the one after it: at the top, where
  // the user was, never a row the grid only guessed the place of.
  expect(Number(moved.id) - Number(chosen.cells[0])).toBeGreaterThanOrEqual(1)
  expect(Number(moved.id) - Number(chosen.cells[0])).toBeLessThanOrEqual(2)
  expect(moved.index).toBeLessThanOrEqual(1)
  // The owner hears where the swap moved the selection, and the key of the row it is on now.
  await expect.poll(async () => { const state = await live('grid'); return [state.activeRow, state.activeKey] }).toEqual([moved.index, moved.id])
  console.log('Key-stable selection passed: the selected item kept its selection across revisions, lingered muted, then the selection moved on.')

  step = 'copy'
  // Copy a whole row (Shift+Space): its four values, never its tone.
  await grid.press('Shift+Space')
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
  await grid.press(`${mod}+C`)
  await expect.poll(clipboard).not.toBe('before')
  const copied = (await clipboard()).split('\t')
  expect(copied).toHaveLength(4)
  expect(copied.some(text => ['error', 'warning', 'running'].includes(text))).toBe(false)
  console.log('Copy passed: a row copies its shown columns only.')

  step = 'save'
  // The dialog stays open for more than two samples, which retire the revision shown when Save was chosen.
  const saved = resolve(profile, 'live-grid.csv')
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = () => new Promise(done => setTimeout(() => done({ canceled: false, filePath: path }), 4000)) }, saved)
  const shownRevision = (await live('grid')).revision
  const result = await live('saveGrid', 'Live grid')
  // Twelve items, and one more while a tracked item that left lingers.
  expect(result).toMatchObject({ ok: true, value: { fileName: 'live-grid.csv' } })
  expect([12, 13]).toContain(result.value.rows)
  expect((await live('grid')).revision).toBeGreaterThanOrEqual(shownRevision + 2)
  const lines = (await readFile(saved, 'utf8')).trim().split(/\r?\n/)
  // Column headers are off by default (Tools › Options), and the tone column is never saved.
  expect(lines).toHaveLength(result.value.rows)
  expect(lines.filter(line => !/^\d+,G\d,Item \d+,\d+$/.test(line))).toEqual([])
  console.log('Save passed: a dialog open across samples saved the newest revision.')

  step = 'sort'
  await live('sortGrid', 'amount', true)
  await expect.poll(async () => { const amounts = (await rows()).map(row => Number(row.cells[3])); return amounts.length === 12 && amounts.every((value, index) => index === 0 || amounts[index - 1] >= value) }, { timeout: 20000 }).toBe(true)
  expect((await live('grid')).sort).toEqual([{ column: 'amount', descending: true }])
  await live('unmountGrid')
  await live('dispose', items)
  console.log('Sort passed: the next revision came sorted by the catalogue column.')

  step = 'follow tail'
  const log = await live('subscribeSynthetic', { probes: ['debug.synthetic.log'], tickMs: 300, logRows: 25 })
  // Mounted as an owner document mounts it, with a state it keeps across remounts (a tab switch).
  expect(await live('mountGrid', log, 'debug.synthetic.log', 0, { keepState: true })).toBe(true)
  await expect.poll(async () => (await live('grid'))?.rows ?? 0).toBeGreaterThan(100)
  // At the tail, the last row stays in view as rows arrive.
  await expect.poll(async () => { const state = await live('grid'), shown = await rows(); return state.following && shown.at(-1)?.index === state.rows - 1 }).toBe(true)
  await expect.poll(async () => (await rows()).some(row => row.tone === 'error' && row.cells[1] === '3')).toBe(true)
  // Scrolled up, the view stays and counts what arrives.
  await grid.click({ position: { x: 120, y: 60 } })
  await grid.press(`${mod}+Home`)
  await expect.poll(async () => (await live('grid')).following).toBe(false)
  await expect.poll(async () => (await live('grid')).newRows).toBeGreaterThan(25)
  const button = liveGridNewRows(frame)
  await expect(button).toHaveText(/^[\d,]+ new rows · Jump to latest$/)
  expect((await rows())[0].index).toBe(0)
  await page.screenshot({ path: 'artifacts/live-grid-new-rows.png' })
  // Mounted again over the kept state: the view opens where the user was, not at the tail, still counting what arrived
  // since it left the tail, and its owner hears the selection it restored.
  const left = await live('grid')
  expect(left.activeRow).toBe(0)
  await live('unmountGrid')
  expect(await live('mountGrid', log, 'debug.synthetic.log', 0, { keepState: true })).toBe(true)
  await expect.poll(async () => (await rows())[0]?.index).toBe(0)
  const back = await live('grid')
  expect(back).toMatchObject({ following: false, activeRow: 0 })
  expect(back.newRows).toBeGreaterThanOrEqual(left.newRows)
  await expect(button).toHaveText(/^[\d,]+ new rows · Jump to latest$/)
  // It stays there as rows keep arriving.
  await expect.poll(async () => (await live('grid')).newRows).toBeGreaterThan(back.newRows)
  expect((await rows())[0].index).toBe(0)
  expect((await live('grid')).following).toBe(false)
  await button.click()
  await expect.poll(async () => (await live('grid')).following).toBe(true)
  await expect(button).toHaveCount(0)
  await expect.poll(async () => { const state = await live('grid'), shown = await rows(); return shown.at(-1)?.index === state.rows - 1 }).toBe(true)
  await live('unmountGrid')
  await live('dispose', log)
  await expect.poll(() => page.evaluate(() => window.__variaResults.liveStreams)).toBe(0)
  console.log('Follow tail passed: the log followed its tail, counted new rows while scrolled up, and jumped back.')

  step = 'stopped'
  // The view ends while its grid is shown (its owner closed it): the rows are released, and the grid says so rather than
  // leave cells that read as loading; Copy says it in the live view's words.
  const stopped = await live('subscribeSynthetic', { probes: ['debug.synthetic.grid'], tickMs: 1200, rows: 12 })
  expect(await live('mountGrid', stopped, 'debug.synthetic.grid', 0)).toBe(true)
  await expect.poll(async () => (await rows()).length).toBe(12)
  await live('dispose', stopped)
  await expect(liveGridOverlay(frame)).toHaveText('This live view stopped; its rows are no longer available.')
  expect((await live('grid')).released).toBe('stopped')
  await grid.press(`${mod}+C`)
  await expect(liveGridStrip(frame)).toHaveText('Could not copy the rows: This live view stopped; its rows are no longer available.')
  await page.screenshot({ path: 'artifacts/live-grid-stopped.png' })
  await live('unmountGrid')
  console.log('Stopped passed: a view that ended says its rows are gone, and so does Copy.')

  step = 'lost'
  // The backend restarts: the grid can no longer read its rows, and says so over them.
  const lost = await live('subscribeSynthetic', { probes: ['debug.synthetic.grid'], tickMs: 1200, rows: 12 })
  expect(await live('mountGrid', lost, 'debug.synthetic.grid', 0)).toBe(true)
  await expect.poll(async () => (await rows()).length).toBe(12)
  await expect(liveGridOverlay(frame)).toHaveCount(0)
  await app.evaluate(() => globalThis.__variaTest.kill())
  await expect(liveGridOverlay(frame)).toHaveText('This live view lost its rows because the SQL backend restarted.')
  expect((await live('grid')).lost).toBe(true)
  await page.screenshot({ path: 'artifacts/live-grid-lost.png' })
  await live('unmountGrid')
  await live('dispose', lost)
  console.log('Lost passed: the grid of a killed backend shows that it lost its rows.')

  expect(failures).toEqual([])
  console.log('Live grids passed.')
} finally {
  clearTimeout(watchdog)
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await Promise.race([app.close(), new Promise(done => setTimeout(done, 15000)).then(() => app.process()?.kill())]).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
