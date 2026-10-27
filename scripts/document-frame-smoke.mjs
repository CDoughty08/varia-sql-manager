// The document frame (src/renderer/src/kit/DocumentFrame.tsx) in real Chromium, before any document uses it: the section
// list's keys, tab stop, tooltips and scroll, the scroll spy, a collapsed section chosen from the list, the section toggle,
// paging the column by keyboard, the Script drawer's splitter (keys, mouse, touch, a cancelled drag), toggle and ways out,
// the header's verbs, and the narrow layout. The fixture page (tests/fixtures/document-frame) is built here with Vite and
// runs in a hidden, sandboxed window of its own.
import { electron, expect } from './fixtures/smoke.mjs'
import { currentSectionItem, documentCrumbs, documentFrame, documentHeader, frameSection, scriptActions, scriptDrawer, scriptNotice, scriptSplitter, scriptText, scriptToggle, sectionColumn, sectionItem, sectionList, sectionTabStop, sectionToggle } from './fixtures/ui.mjs'
import react from '@vitejs/plugin-react'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'vite'

await mkdir('artifacts', { recursive: true })
const fixtureDir = resolve('artifacts', 'document-frame-fixture')
await build({ configFile: false, root: resolve('tests/fixtures/document-frame'), base: './', logLevel: 'error', plugins: [react()], build: { outDir: fixtureDir, emptyOutDir: true, minify: false } })

const profile = await mkdtemp(resolve('artifacts', 'document-frame-profile-'))
const failures = []
const title = 'AdventureWorks'
let application
let page
let frame
const watchdog = setTimeout(() => { console.error('Document frame suite exceeded its time limit.'); application?.process()?.kill(); process.exitCode = 1 }, 180000)

async function launch(query) {
  const env = { ...process.env, VARIA_FRAME_FIXTURE_DIR: fixtureDir, VARIA_FRAME_FIXTURE_QUERY: query, VARIA_TEST_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  // Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it.
  application = await electron.launch({ args: [resolve('tests/fixtures/document-frame/main.cjs')], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => failures.push(error.message))
  frame = documentFrame(page, title)
  await expect(frame).toBeVisible()
}
async function close() {
  await application?.close()
  application = undefined
}

const item = id => sectionItem(frame, id)
const current = () => currentSectionItem(frame)
const column = () => sectionColumn(frame, title)
const focused = () => page.evaluate(() => document.activeElement?.closest('[data-section]')?.getAttribute('data-section') ?? document.activeElement?.textContent ?? null)
const columnFocused = () => column().evaluate(element => element === document.activeElement)
const scrollTop = () => column().evaluate(element => element.scrollTop)
const sectionTop = name => frameSection(frame, name).evaluate(element => element.offsetTop)
const atEnd = () => column().evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)
/** Scrolls the column to its start, its end, or a section's heading (by the section's title). */
const scrollColumn = async target => {
  const top = target === 'start' ? 0 : target === 'end' ? Number.MAX_SAFE_INTEGER : await sectionTop(target)
  await column().evaluate((element, value) => { element.scrollTop = value }, top)
}
const headingAtTop = name => expect.poll(async () => Math.abs(await scrollTop() - await sectionTop(name))).toBeLessThanOrEqual(1)
const fixtureState = () => page.evaluate(() => window.__frameFixture)
const splitterValue = async () => Number(await scriptSplitter(frame).getAttribute('aria-valuenow'))
const frameHeight = async () => (await frame.boundingBox()).height
/** Whether the item's box lies inside the section list's visible box. */
const insideList = async id => {
  const list = await sectionList(frame).boundingBox(), box = await item(id).boundingBox()
  return box.y >= list.y - 1 && box.y + box.height <= list.y + list.height + 1 && box.x >= list.x - 1 && box.x + box.width <= list.x + list.width + 1
}
const options = () => frameSection(frame, 'Options')

try {
  await launch('theme=dark')
  await expect(current()).toHaveAttribute('data-section', 'general')
  // The list is one tab stop, on the current section.
  await expect(sectionTabStop(frame)).toHaveCount(1)

  // The scroll spy marks the section whose heading reached the top, and moves the tab stop with it.
  await scrollColumn('Filegroups')
  await expect(current()).toHaveAttribute('data-section', 'filegroups')
  await page.getByRole('button', { name: 'Save', exact: true }).focus()
  await page.keyboard.press('Tab')
  expect(await focused(), 'Tab enters the list on the current section').toBe('filegroups')

  // The keys move from the focused item, though the scroll has marked another: Down from General is Files.
  await item('general').focus()
  await page.keyboard.press('ArrowDown')
  await expect(current()).toHaveAttribute('data-section', 'files')
  expect(await focused(), 'Down moves focus to the next item').toBe('files')
  await headingAtTop('Files')

  // Past the list, the column is a tab stop of its own: PageDown pages through a section taller than the view, which
  // the list's keys (heading to heading) never show the middle of, and on to the end of the column.
  await page.keyboard.press('Tab')
  expect(await columnFocused(), 'Tab from the list reaches the column').toBe(true)
  await headingAtTop('Files')
  const filesTop = await sectionTop('Files'), filegroupsTop = await sectionTop('Filegroups')
  await page.keyboard.press('PageDown')
  await expect.poll(scrollTop, 'PageDown shows the middle of Files').toBeGreaterThan(filesTop + 100)
  expect(await scrollTop()).toBeLessThan(filegroupsTop)
  for (let press = 0; press < 40 && !await atEnd(); press++) {
    const before = await scrollTop()
    await page.keyboard.press('PageDown')
    await expect.poll(scrollTop).toBeGreaterThan(before)
  }
  await expect.poll(atEnd, 'PageDown reaches the end of the column').toBe(true)
  await page.keyboard.press('PageUp')
  await expect.poll(atEnd, 'PageUp pages back').toBe(false)

  await item('files').focus()
  await page.keyboard.press('End')
  await expect(current()).toHaveAttribute('data-section', 'extended')
  expect(await focused()).toBe('extended')
  await page.keyboard.press('Home')
  await expect(current()).toHaveAttribute('data-section', 'general')
  expect(await focused()).toBe('general')
  await headingAtTop('General')

  // Choosing a collapsed section opens it and scrolls its heading to the top once it has rendered.
  await expect(options().getByRole('table')).toHaveCount(0)
  await item('options').click()
  await expect(options().getByRole('table')).toHaveCount(1)
  await expect(sectionToggle(options())).toHaveAttribute('aria-expanded', 'true')
  await headingAtTop('Options')
  await expect(current()).toHaveAttribute('data-section', 'options')

  // Near the end, where Permissions cannot reach the top, the section chosen stays marked; away from the end the scroll
  // decides again, so coming back to the end marks the last section.
  await item('permissions').click()
  await expect(frameSection(frame, 'Permissions').getByRole('table')).toHaveCount(1)
  await page.waitForTimeout(300)
  await expect(current()).toHaveAttribute('data-section', 'permissions')
  await scrollColumn('start')
  await expect(current()).toHaveAttribute('data-section', 'general')
  await scrollColumn('end')
  await expect(current()).toHaveAttribute('data-section', 'extended')

  // A collapsible section's heading closes and opens it.
  await sectionToggle(options()).click()
  await expect(options().getByRole('table')).toHaveCount(0)
  await expect(sectionToggle(options())).toHaveAttribute('aria-expanded', 'false')
  await sectionToggle(options()).click()
  await expect(options().getByRole('table')).toHaveCount(1)

  // The drawer's ways out each deliver their own destination.
  for (const name of ['Open in Query Window', 'Save Script As…', 'Copy']) await scriptActions(frame, name).click()
  expect((await fixtureState()).delivered).toEqual(['newQuery', 'file', 'clipboard'])
  await expect(scriptNotice(frame)).toHaveText('Delivered to clipboard.')

  // The splitter by key: Up makes the drawer taller, Down shorter, Home and End go to its ends.
  const splitter = scriptSplitter(frame)
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
  for (let press = 0; press < 4; press++) await page.keyboard.press('ArrowUp')
  await expect(splitter).toHaveAttribute('aria-valuenow', '35')
  // By pointer: dragging the splitter up 80 px makes the drawer taller by that share of the frame.
  const height = await frameHeight()
  const centre = async () => { const bar = await splitter.boundingBox(); return { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 } }
  let at = await centre()
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x, at.y - 40, { steps: 4 })
  await page.mouse.move(at.x, at.y - 80, { steps: 4 })
  await page.mouse.up()
  await expect.poll(splitterValue).toBeGreaterThan(35)
  expect(Math.abs(await splitterValue() - (35 + 80 / height * 100)), 'the drawer follows the pointer').toBeLessThanOrEqual(2)
  const share = (await scriptDrawer(frame).boundingBox()).height / height
  expect(Math.abs(share * 100 - await splitterValue()), 'the drawer takes its share of the height').toBeLessThanOrEqual(3)
  // The right button does not drag it.
  let held = await splitterValue()
  at = await centre()
  await page.mouse.move(at.x, at.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(at.x, at.y - 60, { steps: 4 })
  await page.mouse.up({ button: 'right' })
  expect(await splitterValue(), 'a right-button drag leaves the drawer alone').toBe(held)
  // A drag the browser cancels (a touch drag turned pan) stops there: its listeners do not outlive it.
  await page.evaluate(() => document.addEventListener('pointerdown', event => { window.__framePointer = event.pointerId }, true))
  at = await centre()
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  held = await splitterValue()
  await splitter.evaluate(element => element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__framePointer, bubbles: true })))
  await page.mouse.move(at.x, at.y - 60, { steps: 4 })
  await page.mouse.up()
  expect(await splitterValue(), 'a cancelled drag stops following the pointer').toBe(held)
  // By touch: the splitter takes the drag rather than letting it start a pan, so the drawer follows the finger.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  held = await splitterValue()
  at = await centre()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] })
  for (let step = 1; step <= 10; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y - step * 10 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await cdp.detach()
  await expect.poll(splitterValue, 'a touch drag moves the splitter as far as the finger').toBeGreaterThanOrEqual(held + 100 / height * 100 - 3)

  // Closing the drawer leaves its bar; opening it shows the script again.
  await scriptToggle(frame).click()
  await expect(scriptToggle(frame)).toHaveAttribute('aria-expanded', 'false')
  await expect(scriptText(frame)).toHaveCount(0)
  await expect(scriptActions(frame)).toHaveCount(3)
  await scriptToggle(frame).click()
  await expect(scriptText(frame)).toBeVisible()

  // Header verbs: borderless unless outlined, a danger verb's words in the error colour (hovered or not) inside the
  // neutral border, a toggle that says whether it is on, a long crumb with its tooltip.
  const stop = page.getByRole('button', { name: 'Stop', exact: true }), refresh = page.getByRole('button', { name: 'Refresh', exact: true })
  const colors = locator => locator.evaluate(element => [getComputedStyle(element).color, getComputedStyle(element).borderTopColor])
  const rest = await colors(stop)
  await stop.hover()
  expect(await colors(stop), 'a hovered danger verb keeps the error colour').toEqual(rest)
  // The error colour, as the Files section's problem glyph draws it, and the outline verb's border.
  const errorColor = await item('files').locator('[data-icon="error"]').evaluate(element => getComputedStyle(element).color)
  const outline = (await colors(refresh))[1]
  expect(outline, 'an outline verb has a border').not.toBe('rgba(0, 0, 0, 0)')
  expect(rest, 'a danger verb is drawn in the error colour inside the neutral border').toEqual([errorColor, outline])
  await stop.click()
  const split = page.getByRole('button', { name: 'Split View' })
  await expect(split).toHaveAttribute('aria-pressed', 'true')
  await split.click()
  await expect(split).toHaveAttribute('aria-pressed', 'false')
  await page.mouse.move(0, 0)
  expect((await colors(split))[1], 'a secondary verb is borderless').toBe('rgba(0, 0, 0, 0)')
  expect((await fixtureState()).ran).toEqual(['Stop', 'Split View'])
  await expect(documentCrumbs(frame).first()).toHaveAttribute('title', 'sqlprod-cluster-node-01.corp.example.com\\INSTANCE2025')
  expect((await documentHeader(frame).boundingBox()).height, 'the header is one row at 1280 px').toBeLessThan(60)
  await page.screenshot({ path: join('artifacts', 'document-frame-dark.png') })

  // Where the list is narrow (a 700 px window), a long title is cut; its tooltip carries it whole.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 800))
  await expect.poll(() => item('shipping').evaluate(element => element.firstElementChild.scrollWidth > element.firstElementChild.clientWidth), 'the long title is cut').toBe(true)
  await expect(item('shipping')).toHaveAttribute('title', 'Transaction Log Shipping')
  await expect(item('files')).toHaveAttribute('title', 'Files (needs attention)')

  // A narrow document lays the list across the top, where Right and Left move as Down and Up do, and the list scrolls
  // to show the section the keys reach.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 800))
  await expect.poll(() => sectionList(frame).evaluate(element => getComputedStyle(element).flexDirection)).toBe('row')
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
  await scrollColumn('Section 31')
  await expect(current()).toHaveAttribute('data-section', 's31')
  await expect.poll(() => insideList('s31'), 'the current section is visible in the list').toBe(true)
  expect(await sectionList(frame).evaluate(element => element.scrollTop)).toBeGreaterThan(0)
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
