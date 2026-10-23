// The document frame (src/renderer/src/kit/DocumentFrame.tsx) in real Chromium, before any document uses it: the section
// list's keys, tab stop and scroll, the scroll spy, a collapsed section chosen from the list, the section toggle, the
// Script drawer's splitter, toggle and ways out, the header's verbs, and the narrow layout. The fixture page
// (tests/fixtures/document-frame) is built here with Vite and runs in a hidden, sandboxed window of its own.
import { electron, expect } from './fixtures/smoke.mjs'
import react from '@vitejs/plugin-react'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'vite'

await mkdir('artifacts', { recursive: true })
const fixtureDir = resolve('artifacts', 'document-frame-fixture')
await build({ configFile: false, root: resolve('tests/fixtures/document-frame'), base: './', logLevel: 'error', plugins: [react()], build: { outDir: fixtureDir, emptyOutDir: true, minify: false } })

const profile = await mkdtemp(resolve('artifacts', 'document-frame-profile-'))
const failures = []
let application
let page
const watchdog = setTimeout(() => { console.error('Document frame suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 180000)

async function launch(query) {
  const env = { ...process.env, VARIA_FRAME_FIXTURE_DIR: fixtureDir, VARIA_FRAME_FIXTURE_QUERY: query, VARIA_TEST_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  // Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it.
  application = await electron.launch({ args: [resolve('tests/fixtures/document-frame/main.cjs')], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  await expect(page.locator('.document-frame')).toBeVisible()
}
async function close() {
  await application?.close()
  application = undefined
}

const item = id => page.locator(`.document-nav-item[data-section="${id}"]`)
const current = () => page.locator('.document-nav-item[aria-current="location"]')
const focused = () => page.evaluate(() => document.activeElement?.closest('[data-section]')?.getAttribute('data-section') ?? document.activeElement?.textContent ?? null)
const column = '.document-sections'
const scrollColumn = top => page.$eval(column, (element, value) => { element.scrollTop = value === 'end' ? element.scrollHeight : value === 'start' ? 0 : element.querySelector(`#${value}`).offsetTop }, top)
const headingAtTop = async id => expect.poll(() => page.$eval(column, (element, target) => Math.abs(element.scrollTop - element.querySelector(`#doc-section-${target}`).offsetTop), id)).toBeLessThanOrEqual(1)
const fixtureState = () => page.evaluate(() => window.__frameFixture)
const splitterValue = async () => Number(await page.locator('.document-script-splitter').getAttribute('aria-valuenow'))
/** Whether the element's box lies inside the section list's visible box. */
const insideList = id => page.evaluate(target => {
  const list = document.querySelector('.document-nav').getBoundingClientRect(), box = document.querySelector(`.document-nav-item[data-section="${target}"]`).getBoundingClientRect()
  return box.top >= list.top - 1 && box.bottom <= list.bottom + 1 && box.left >= list.left - 1 && box.right <= list.right + 1
}, id)

try {
  await launch('theme=dark')
  await expect(current()).toHaveAttribute('data-section', 'general')
  // The list is one tab stop, on the current section.
  await expect(page.locator('.document-nav-item[tabindex="0"]')).toHaveCount(1)

  // The scroll spy marks the section whose heading reached the top, and moves the tab stop with it.
  await scrollColumn('doc-section-filegroups')
  await expect(current()).toHaveAttribute('data-section', 'filegroups')
  await page.getByRole('button', { name: 'Save', exact: true }).focus()
  await page.keyboard.press('Tab')
  expect(await focused(), 'Tab enters the list on the current section').toBe('filegroups')

  // The keys move from the focused item, though the scroll has marked another: Down from General is Files.
  await item('general').focus()
  await page.keyboard.press('ArrowDown')
  await expect(current()).toHaveAttribute('data-section', 'files')
  expect(await focused(), 'Down moves focus to the next item').toBe('files')
  await headingAtTop('files')
  await page.keyboard.press('End')
  await expect(current()).toHaveAttribute('data-section', 'extended')
  expect(await focused()).toBe('extended')
  await page.keyboard.press('Home')
  await expect(current()).toHaveAttribute('data-section', 'general')
  expect(await focused()).toBe('general')
  await headingAtTop('general')

  // Choosing a collapsed section opens it and scrolls its heading to the top once it has rendered.
  await expect(page.locator('#doc-section-options-body')).toHaveCount(0)
  await item('options').click()
  await expect(page.locator('#doc-section-options-body')).toHaveCount(1)
  await expect(page.locator('#doc-section-options .document-section-title button')).toHaveAttribute('aria-expanded', 'true')
  await headingAtTop('options')
  await expect(current()).toHaveAttribute('data-section', 'options')

  // Near the end, where Permissions cannot reach the top, the section chosen stays marked; away from the end the scroll
  // decides again, so coming back to the end marks the last section.
  await item('permissions').click()
  await expect(page.locator('#doc-section-permissions-body')).toHaveCount(1)
  await page.waitForTimeout(300)
  await expect(current()).toHaveAttribute('data-section', 'permissions')
  // Tab from the list goes into the section chosen (its heading's toggle), not to the first control in the column (Options').
  await item('permissions').focus()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.closest('.document-section')?.id), 'Tab enters the chosen section').toBe('doc-section-permissions')
  // A section with nothing to focus leaves Tab to the browser.
  await item('general').click()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.closest('.document-section')?.id)).toBe('doc-section-options')
  await item('permissions').click()
  await page.waitForTimeout(300)
  await expect(current()).toHaveAttribute('data-section', 'permissions')
  await scrollColumn('start')
  await expect(current()).toHaveAttribute('data-section', 'general')
  await scrollColumn('end')
  await expect(current()).toHaveAttribute('data-section', 'extended')

  // A collapsible section's heading closes and opens it.
  await page.locator('#doc-section-options .document-section-title button').click()
  await expect(page.locator('#doc-section-options-body')).toHaveCount(0)
  await expect(page.locator('#doc-section-options .document-section-title button')).toHaveAttribute('aria-expanded', 'false')
  await page.locator('#doc-section-options .document-section-title button').click()
  await expect(page.locator('#doc-section-options-body')).toHaveCount(1)

  // The drawer's ways out each deliver their own destination.
  for (const destination of ['newQuery', 'file', 'clipboard']) await page.locator(`.document-script-actions button[data-destination="${destination}"]`).click()
  expect((await fixtureState()).delivered).toEqual(['newQuery', 'file', 'clipboard'])
  await expect(page.locator('.document-script-notice')).toHaveText('Delivered to clipboard.')

  // The splitter by key: Up makes the drawer taller, Down shorter, Home and End go to its ends.
  const splitter = page.locator('.document-script-splitter')
  await splitter.focus()
  expect(await splitterValue()).toBe(35)
  await page.keyboard.press('ArrowUp')
  await expect(splitter).toHaveAttribute('aria-valuenow', '40')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(splitter).toHaveAttribute('aria-valuenow', '30')
  await page.keyboard.press('End')
  await expect(splitter).toHaveAttribute('aria-valuenow', '70')
  await page.keyboard.press('Home')
  await expect(splitter).toHaveAttribute('aria-valuenow', '15')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(splitter).toHaveAttribute('aria-valuenow', '35')
  // By pointer: dragging the splitter up 80 px makes the drawer taller by that share of the frame.
  const frameHeight = await page.$eval('.document-frame', element => element.getBoundingClientRect().height)
  const bar = await splitter.boundingBox()
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
  await page.mouse.down()
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2 - 40, { steps: 4 })
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2 - 80, { steps: 4 })
  await page.mouse.up()
  await expect.poll(splitterValue).toBeGreaterThan(35)
  expect(Math.abs(await splitterValue() - (35 + 80 / frameHeight * 100)), 'the drawer follows the pointer').toBeLessThanOrEqual(2)
  const share = await page.$eval('.document-frame', element => element.querySelector('.document-script').getBoundingClientRect().height / element.getBoundingClientRect().height)
  expect(Math.abs(share * 100 - await splitterValue()), 'the drawer takes its share of the height').toBeLessThanOrEqual(3)

  // Closing the drawer leaves its bar; opening it shows the script again.
  await page.locator('.document-script-toggle').click()
  await expect(page.locator('.document-script-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.document-script-text')).toHaveCount(0)
  await expect(page.locator('.document-script-actions button')).toHaveCount(3)
  await page.locator('.document-script-toggle').click()
  await expect(page.locator('.document-script-text')).toBeVisible()

  // Header verbs: a danger verb keeps its colour under the pointer, a toggle says whether it is on, a long crumb has its tooltip.
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  const colors = () => stop.evaluate(element => [getComputedStyle(element).color, getComputedStyle(element).borderTopColor])
  const rest = await colors()
  await stop.hover()
  expect(await colors(), 'a hovered danger verb keeps the error colour').toEqual(rest)
  // The error colour, as the Files section's problem glyph draws it.
  expect(rest, 'a danger verb is drawn in the error colour').toEqual(Array(2).fill(await page.$eval('.document-nav-item > .codicon-error', element => getComputedStyle(element).color)))
  await stop.click()
  const split = page.getByRole('button', { name: 'Split View' })
  await expect(split).toHaveAttribute('aria-pressed', 'true')
  await split.click()
  await expect(split).toHaveAttribute('aria-pressed', 'false')
  expect((await fixtureState()).ran).toEqual(['Stop', 'Split View'])
  await expect(page.locator('.document-crumbs li').first()).toHaveAttribute('title', 'sqlprod-cluster-node-01.corp.example.com\\INSTANCE2025')
  expect(await page.$eval('.document-header', element => element.getBoundingClientRect().height), 'the header is one row at 1280 px').toBeLessThan(60)
  await page.screenshot({ path: join('artifacts', 'document-frame-dark.png') })

  // A narrow document lays the list across the top, where Right and Left move as Down and Up do, and the list scrolls
  // to show the section the keys reach.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 800))
  await expect.poll(() => page.$eval('.document-nav', element => getComputedStyle(element).flexDirection)).toBe('row')
  await item('general').click()
  await expect(current()).toHaveAttribute('data-section', 'general')
  await page.keyboard.press('End')
  await expect(current()).toHaveAttribute('data-section', 'extended')
  expect(await focused()).toBe('extended')
  await expect.poll(() => insideList('extended'), 'the section End reaches is not cut off by the list').toBe(true)
  await page.keyboard.press('ArrowLeft')
  await expect(current()).toHaveAttribute('data-section', 'permissions')
  expect(await focused()).toBe('permissions')
  await page.keyboard.press('ArrowRight')
  await expect(current()).toHaveAttribute('data-section', 'extended')
  await page.keyboard.press('Home')
  await expect.poll(() => insideList('general')).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal page scroll when narrow').toBe(true)
  await page.screenshot({ path: join('artifacts', 'document-frame-narrow.png') })
  await close()

  // A list longer than its box follows the scroll: the section the content shows stays in view in the list.
  await launch('theme=light&sections=many')
  await scrollColumn('doc-section-s31')
  await expect(current()).toHaveAttribute('data-section', 's31')
  await expect.poll(() => insideList('s31'), 'the current section is visible in the list').toBe(true)
  expect(await page.$eval('.document-nav', element => element.scrollTop)).toBeGreaterThan(0)
  await scrollColumn('start')
  await expect(current()).toHaveAttribute('data-section', 's1')
  await expect.poll(() => insideList('s1')).toBe(true)
  // The page itself never scrolls to show it.
  expect(await page.evaluate(() => [document.documentElement.scrollTop, document.body.scrollTop])).toEqual([0, 0])
  await close()

  expect(failures, 'page errors').toEqual([])
  console.log('Document frame smoke test passed.')
} catch (error) {
  process.exitCode = 1
  console.error(error)
  if (page) await page.screenshot({ path: join('artifacts', 'document-frame-failure.png') }).catch(() => {})
  await close().catch(() => {})
} finally {
  clearTimeout(watchdog)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
