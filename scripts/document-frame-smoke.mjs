// The document frame (src/renderer/src/kit/DocumentFrame.tsx) in real Chromium, before any document uses it: the section
// list's keys, tab stop, tooltips and scroll, the scroll spy, a collapsed section chosen from the list, the section toggle,
// paging the column by keyboard, the Script drawer's splitter (keys, mouse, touch, a cancelled drag), toggle and ways out,
// the header's verbs, its one row whatever its words, its icons and chevrons, and the narrow layout. The fixture page (tests/fixtures/document-frame) is built here with Vite and
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
/** How far the section's box sits below the top of the column's visible box, on screen (not the offsets the frame scrolls by). */
const headingOffset = async name => {
  const box = await frameSection(frame, name).boundingBox()
  return box.y - await column().evaluate(element => element.getBoundingClientRect().top + element.clientTop)
}
const headingAtTop = name => expect.poll(async () => Math.abs(await headingOffset(name))).toBeLessThanOrEqual(1)
const fixtureState = () => page.evaluate(() => window.__frameFixture)
/** Past the scroll spy's next check (a frame, or 50 ms in a hidden window), so what it decides has rendered. */
const settle = () => page.waitForTimeout(300)
/** What a codicon draws: its glyph rule's content, `none` without Monaco's rules. */
const glyph = locator => locator.evaluate(element => getComputedStyle(element, '::before').content)
const drawn = async (locator, name) => expect(await glyph(locator), `${name} draws its glyph`).toMatch(/^"[^"]+"$/)
/** The space before and after each crumb's chevron: after it comes the next crumb, or the title. */
const chevronSpacing = async () => {
  const titleLeft = (await frame.getByRole('heading', { level: 1 }).boundingBox()).x
  const crumbs = await documentCrumbs(frame).evaluateAll(items => items.map(item => {
    const [text, chevron] = [...item.children].map(child => child.getBoundingClientRect())
    return { textRight: text.right, left: chevron.left, right: chevron.right, nextLeft: item.nextElementSibling?.firstElementChild?.getBoundingClientRect().left }
  }))
  return crumbs.map(crumb => [crumb.left - crumb.textRight, (crumb.nextLeft ?? titleLeft) - crumb.right])
}
const headerHeight = async () => (await documentHeader(frame).boundingBox()).height
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
  // Keys with a modifier are not the list's: they go on to the workbench (Shift+Down, Ctrl+End) and leave the section.
  for (const key of ['Shift+ArrowDown', 'Control+End', 'Alt+ArrowDown', 'Shift+End']) await page.keyboard.press(key)
  await settle()
  expect((await fixtureState()).frame.section, 'a modified key does not move the list').toBe('general')
  expect(await focused()).toBe('general')
  await headingAtTop('General')

  // Choosing a collapsed section opens it and scrolls its heading to the top once it has rendered.
  await expect(options().getByRole('table')).toHaveCount(0)
  await item('options').click()
  await expect(options().getByRole('table')).toHaveCount(1)
  await expect(sectionToggle(options())).toHaveAttribute('aria-expanded', 'true')
  await headingAtTop('Options')
  await expect(current()).toHaveAttribute('data-section', 'options')
  // It stays open once the scroll spy has seen the scroll: the spy works from the latest state, not the first render's.
  await settle()
  await expect(options().getByRole('table')).toHaveCount(1)
  expect((await fixtureState()).frame.collapsed, 'the scroll spy keeps a section the list opened').toEqual(['permissions'])

  // Near the end, where Permissions cannot reach the top, the section chosen stays marked; away from the end the scroll
  // decides again, so coming back to the end marks the last section.
  await item('permissions').click()
  await expect(frameSection(frame, 'Permissions').getByRole('table')).toHaveCount(1)
  await settle()
  await expect(current()).toHaveAttribute('data-section', 'permissions')
  await expect(frameSection(frame, 'Permissions').getByRole('table')).toHaveCount(1)
  expect((await fixtureState()).frame.collapsed).toEqual([])
  await scrollColumn('start')
  await expect(current()).toHaveAttribute('data-section', 'general')
  await scrollColumn('end')
  await expect(current()).toHaveAttribute('data-section', 'extended')

  // A collapsible section's heading closes and opens it.
  await sectionToggle(options()).click()
  await expect(options().getByRole('table')).toHaveCount(0)
  await expect(sectionToggle(options())).toHaveAttribute('aria-expanded', 'false')
  // A scroll after the toggle keeps it: the spy changes only the current section.
  await scrollColumn('start')
  await settle()
  await expect(options().getByRole('table')).toHaveCount(0)
  expect((await fixtureState()).frame.collapsed, 'a scroll after a toggle keeps the sections as they were left').toEqual(['options'])
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
  // A scroll after a resize keeps the drawer's size.
  const resized = await splitterValue()
  await scrollColumn('Filegroups')
  await settle()
  expect(await splitterValue(), 'a scroll after a resize keeps the drawer as tall').toBe(resized)
  expect(Math.round((await fixtureState()).frame.scriptSize * 100)).toBe(resized)

  // Closing the drawer leaves its bar, and a scroll leaves it closed; opening it shows the script again.
  await scriptToggle(frame).click()
  await expect(scriptToggle(frame)).toHaveAttribute('aria-expanded', 'false')
  await expect(scriptText(frame)).toHaveCount(0)
  await expect(scriptActions(frame)).toHaveCount(3)
  await scrollColumn('start')
  await settle()
  await expect(scriptToggle(frame)).toHaveAttribute('aria-expanded', 'false')
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
  const oneRow = await headerHeight()
  expect(oneRow, 'the header is one row at 1280 px').toBeLessThan(60)

  // Every icon draws its glyph (the codicon font and Monaco's glyph rules, as the app loads them).
  await expect.poll(() => page.evaluate(() => [...document.fonts].some(font => font.family.replace(/"/g, '') === 'codicon' && font.status === 'loaded')), 'the codicon font loads').toBe(true)
  await drawn(documentCrumbs(frame).first().locator('[data-icon]'), 'a crumb chevron')
  await drawn(item('files').locator('[data-icon="error"]'), 'the problem glyph')
  for (const name of ['Stop', 'Refresh']) await drawn(page.getByRole('button', { name, exact: true }).locator('[data-icon]'), name)
  for (const name of ['Open in Query Window', 'Save Script As…', 'Copy']) await drawn(scriptActions(frame, name).locator('[data-icon]'), name)
  await drawn(sectionToggle(options()).locator('[data-icon]'), 'a section toggle')
  // Each chevron sits as far from the crumb before it as from what follows, the title included.
  for (const [before, after] of await chevronSpacing()) {
    expect(before, 'a chevron is apart from its crumb').toBeGreaterThan(0)
    expect(Math.abs(before - after), `a chevron is spaced evenly (${before} and ${after} px)`).toBeLessThanOrEqual(0.5)
  }

  // Sections are groups, not landmarks: the frame's regions are its column and its Script drawer.
  await expect(frame.getByRole('region')).toHaveCount(2)

  // The header stays one row whatever its words: a long subtitle is cut rather than pushing the verbs under the title,
  // and a live document's pill changing its words does not move the content under the header.
  const longSubtitle = 'Database Properties of a database with a long name on a server far away from here at the end of the hall'
  await page.evaluate(subtitle => window.__frameFixture.setSubtitle(subtitle), longSubtitle)
  await expect(frame.getByText(longSubtitle)).toBeVisible()
  expect(await headerHeight(), 'a long subtitle keeps the header on one row').toBe(oneRow)
  expect(await frame.getByText(longSubtitle).evaluate(element => element.scrollWidth > element.clientWidth), 'the subtitle is cut').toBe(true)
  const verbRow = async () => { const verb = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox(), heading = await frame.getByRole('heading', { level: 1 }).boundingBox(); return Math.abs((verb.y + verb.height / 2) - (heading.y + heading.height / 2)) }
  expect(await verbRow(), 'the verbs stay on the title\'s row').toBeLessThanOrEqual(4)
  for (const label of ['Stopped · backend unavailable', 'Live · every 2 s', 'Paused · resumes when shown again in this window']) {
    await page.evaluate(text => window.__frameFixture.setState(text), label)
    await expect(frame.getByText(label)).toBeVisible()
    expect(await headerHeight(), `the header keeps its height with "${label}"`).toBe(oneRow)
  }
  await page.evaluate(() => { window.__frameFixture.setSubtitle('Database Properties'); window.__frameFixture.setState('Unsaved changes') })
  await expect(frame.getByText('Unsaved changes')).toBeVisible()
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
  // The strip's scrollbar is thin, as the query tab strip's: a classic one would crowd the current item's underline.
  const strip = await sectionList(frame).evaluate(element => { const style = getComputedStyle(element); return { overflows: element.scrollWidth > element.clientWidth, bar: element.offsetHeight - element.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth) } })
  const classicBar = await page.evaluate(() => { const probe = document.createElement('div'); probe.style.cssText = 'position: absolute; width: 100px; height: 50px; overflow-x: scroll'; document.body.append(probe); const size = probe.offsetHeight - probe.clientHeight; probe.remove(); return size })
  expect(strip.overflows, 'the strip scrolls at 560 px').toBe(true)
  if (classicBar > 0) expect(strip.bar, `the strip's scrollbar is thinner than a classic one (${classicBar} px)`).toBeLessThan(classicBar)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal page scroll when narrow').toBe(true)
  await page.screenshot({ path: join('artifacts', 'document-frame-narrow.png') })
  await close()

  // A list longer than its box follows the scroll: the section the content shows stays in view in the list. The frame
  // runs past the bottom of an overflow: hidden box here, as it can in a dock panel.
  await launch('theme=light&sections=many&wrap=clipped')
  const clipTop = () => page.evaluate(() => document.getElementById('clip').scrollTop)
  // The list's keys show the item inside the list only: focus alone would scroll the clipping box to show it.
  await item('s1').evaluate(element => element.focus({ preventScroll: true }))
  expect(await clipTop()).toBe(0)
  await page.keyboard.press('End')
  await expect(current()).toHaveAttribute('data-section', 's40')
  expect(await focused()).toBe('s40')
  await expect.poll(() => insideList('s40')).toBe(true)
  expect(await clipTop(), 'a key in the list scrolls nothing outside the frame').toBe(0)
  await page.keyboard.press('Home')
  await expect(current()).toHaveAttribute('data-section', 's1')
  expect(await clipTop()).toBe(0)
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
