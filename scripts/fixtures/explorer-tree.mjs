// Object Explorer helpers for the smoke suites: finding rows of the windowed tree by their path, and the static part of
// the tree for suites that answer explorer.children in main instead of through a backend.
import { expect } from './smoke.mjs'
import { folderIds, folderSpecs, nodeKinds, staticChildren } from '../../src/shared/explorer/catalog.ts'
import { explorerCovers, explorerOutline, findExplorerPath } from './explorer-outline.ts'
import { explorerTree, menuItemNames, part } from './ui.mjs'

export { explorerTree }

/**
 * The tree's rendered rows (explorer-outline.ts's OutlineRow), each with its offset from the top of the tree's content, not
 * the viewport, so rows read at different scroll positions line up.
 */
const renderedRows = page => page.evaluate(part => {
  const tree = document.querySelector(part.explorerTree)
  if (!tree) return []
  const origin = tree.getBoundingClientRect().top + tree.clientTop - tree.scrollTop
  return [...tree.querySelectorAll('[role="treeitem"]')].map(row => {
    const box = row.getBoundingClientRect()
    return {
      id: row.id, top: Math.round(box.top - origin), height: Math.round(box.height), level: Number(row.getAttribute('aria-level')),
      label: row.querySelector(part.explorerLabel)?.textContent ?? row.querySelector(part.explorerText)?.textContent ?? ''
    }
  })
}, part)

/**
 * The row at a path of labels from a server down (`'server-a', 'Databases', 'AppData'`), once it is rendered with its
 * ancestors: rows are windowed, so the path must be in or near view (revealExplorerRow finds one whose ancestors are out of
 * the window). Matching is by each row's label, without its sublabel, through adjacent rows only (findExplorerPath), so the
 * selected row, which is rendered wherever it is, never stands in for another row's ancestor. An options object last sets
 * the wait (`{ timeout }`).
 */
export async function explorerRow(page, ...path) {
  const options = typeof path.at(-1) === 'object' ? path.pop() : {}, labels = path
  let id = null
  await expect.poll(async () => {
    id = findExplorerPath(await renderedRows(page), labels)?.id ?? null
    return id
  }, { message: 'Object Explorer row ' + labels.join(' › '), ...options }).not.toBeNull()
  return page.locator('#' + id)
}

/**
 * The row at a path, scrolled into the tree's rendered rows first when it is not among them with its ancestors. The tree
 * renders a window of rows around its viewport, so a row far below its server (server-a › Security under an expanded
 * Databases) is never rendered with it. The scan therefore reads the tree from the top, half a viewport at a time, joins
 * the windows into an outline by each row's offset (explorerOutline), finds the path there (findExplorerPath), and scrolls
 * to that row's offset; the row returned is the one rendered there with the path's label and level, once the window read
 * there agrees with the outline. The tree re-windows on its scroll event, which Chromium dispatches with a frame, and a
 * window that draws few frames (a hidden or occluded one) can keep a stale window for long, so each step sends the scroll
 * event too and waits until the rendered rows cover the viewport. The tree's geometry and rendered rows are logged first.
 */
export async function revealExplorerRow(page, ...path) {
  const found = await explorerRow(page, ...path, { timeout: 2000 }).catch(() => null)
  if (found) return found
  const tree = explorerTree(page), label = path.join(' › ')
  const state = () => tree.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight }))
  const before = await state()
  console.log(`Object Explorer row ${label} was not rendered (scrollTop ${before.top}, height ${before.height}, scroll height ${before.scrollHeight}; rows: ${(await explorerLines(page)).join(' | ')}); scrolling to it.`)
  /** Scrolls to `top` and returns the rows rendered for it, once they cover the viewport (or what is rendered after 2 s). */
  const windowAt = async top => {
    const view = await tree.evaluate((element, top) => {
      element.scrollTop = top
      element.dispatchEvent(new Event('scroll'))
      return { top: element.scrollTop, bottom: Math.min(element.scrollTop + element.clientHeight, element.scrollHeight) }
    }, top)
    let rows = []
    await expect.poll(async () => explorerCovers(rows = await renderedRows(page), view.top, view.bottom), { timeout: 2000 }).toBe(true).catch(() => {})
    return { view, rows }
  }
  const step = Math.max(22, Math.floor(before.height / 2)), windows = [await renderedRows(page)]
  for (let top = 0; ; top += step) {
    const { view, rows } = await windowAt(top)
    windows.push(rows)
    const target = findExplorerPath(explorerOutline(windows), path)
    if (target) {
      // In view, then the row rendered at its offset, once that window agrees with the outline.
      const { rows: there } = await windowAt(Math.max(0, target.top - Math.floor(before.height / 2)))
      const row = there.find(row => Math.abs(row.top - target.top) <= 1 && row.level === target.level && row.label === target.label)
      if (row && Math.abs((findExplorerPath(explorerOutline([...windows, there]), path)?.top ?? -2) - target.top) <= 1) {
        console.log(`Object Explorer row ${label} found at offset ${target.top} in an outline of ${windows.length} windows.`)
        return page.locator('#' + row.id)
      }
      break
    }
    if (view.bottom >= (await state()).scrollHeight) break
  }
  const after = await state()
  throw new Error(`Object Explorer row ${label} is not in the tree (scrollTop ${after.top}, height ${after.height}, scroll height ${after.scrollHeight}): ${(await explorerLines(page)).join(' | ')}`)
}

/**
 * Expands each row of a path that is collapsed, from the server down, by its chevron. A row moves whenever a folder above
 * it finishes loading (expanding Tables, then Views below it, moves Views down by the tables that arrive), so a click aimed
 * at a chevron can land on another row and expand nothing. The click is therefore not forced: Playwright waits for the
 * chevron to stop moving and retries a press that another row receives. A row that still moves between the press and the
 * release loses the click, so the step clicks again, only while the row still reads collapsed, until it is expanded.
 */
export async function expandExplorerPath(page, ...path) {
  const options = typeof path.at(-1) === 'object' ? path.pop() : {}
  // Room for a lost click, the 2 s that notice it and a second click, on slow Linux runners too (CI ran out at 5 s).
  const timeout = options.timeout ?? (process.platform === 'win32' ? 15000 : 10000)
  for (let length = 1; length <= path.length; length++) {
    const row = await explorerRow(page, ...path.slice(0, length), options)
    if (await row.getAttribute('aria-expanded') !== 'false') {
      await expect(row).toHaveAttribute('aria-expanded', 'true', options)
      continue
    }
    let clicks = 0
    await expect(async () => {
      if (await row.getAttribute('aria-expanded') === 'false') {
        clicks++
        await row.locator(part.explorerTwistie).click({ timeout: Math.min(timeout, 5000) })
      }
      // An expansion shows within a frame of the click; a lost click leaves the row collapsed for the next attempt.
      await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 2000 })
    }).toPass({ timeout, intervals: [100, 250, 500] })
    if (clicks > 1) console.log(`Object Explorer row ${path.slice(0, length).join(' › ')} took ${clicks} clicks to expand: an earlier one was lost while the row moved.`)
  }
}

/** The open Object Explorer context menu. */
export const explorerMenu = page => page.getByRole('menu', { name: 'Object Explorer', exact: true })

/**
 * Opens the context menu of the row at a path and returns the menu, once it shows marked for that row (the menus mark
 * the element a menu is for with `data-menu-target`). A row can move between the press, which selects it, and the
 * release, which opens the menu on Windows, so a menu for another row (or none) is closed and the press repeats. The press
 * is forced, as Playwright's wait for a stable row needs frames a hidden or locked window draws seconds apart.
 */
export async function openExplorerMenu(page, ...path) {
  const menu = explorerMenu(page)
  let presses = 0
  await expect(async () => {
    if (await menu.count()) {
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0, { timeout: 1000 })
    }
    const row = await revealExplorerRow(page, ...path)
    presses++
    await row.click({ button: 'right', force: true })
    await expect(menu).toBeVisible({ timeout: 1000 })
    await expect(row).toHaveAttribute('data-menu-target', '', { timeout: 1000 })
  }).toPass({ timeout: process.platform === 'win32' ? 30000 : 15000, intervals: [100, 250, 500] })
  if (presses > 1) console.log(`Object Explorer row ${path.join(' › ')} took ${presses} right-clicks to open its menu.`)
  return menu
}

/**
 * The item names of the row's context menu (openExplorerMenu), and those greyed, read while it is open; the menu stays
 * open. A menu shows only with items and never changes them while open, so an empty read is a menu that closed between
 * opening and the read (a PR #78 run read none so): it opens again.
 */
export async function explorerMenuItems(page, ...path) {
  let items
  await expect(async () => {
    const menu = await openExplorerMenu(page, ...path)
    const [names, disabled] = await Promise.all([menuItemNames(menu), menuItemNames(menu, { disabled: true })])
    expect(names.length, `items of the menu of ${path.join(' › ')}`).toBeGreaterThan(0)
    await expect(menu).toBeVisible({ timeout: 1000 })
    items = { names, disabled }
  }).toPass({ timeout: process.platform === 'win32' ? 60000 : 30000, intervals: [100, 250, 500] })
  return items
}

/**
 * Opens the submenus `submenus` (menuitem names, outermost first) of the context menu of the row at a path
 * (openExplorerMenu) and returns the innermost, once it shows. A press on a submenu only opens it, so a press that missed
 * (its menu closed meanwhile and it landed on the tree) is safe to repeat: the row's menu then opens again.
 */
export async function openExplorerSubmenu(page, path, submenus) {
  let menu
  await expect(async () => {
    menu = await openExplorerMenu(page, ...path)
    for (const name of submenus) {
      const parent = menu.getByRole('menuitem', { name, exact: true })
      await parent.click({ force: true, timeout: 2000 })
      await expect(parent).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 })
      menu = page.getByRole('menu', { name, exact: true })
      await expect(menu).toBeVisible({ timeout: 1000 })
    }
  }).toPass({ timeout: process.platform === 'win32' ? 60000 : 30000, intervals: [100, 250, 500] })
  return menu
}

/**
 * Chooses item `name` (a menuitem's accessible name) from the context menu of the row at a path (openExplorerMenu), or,
 * when `name` is a list, from the submenus it names first (['New', 'Login…'] is New › Login…, openExplorerSubmenu). The
 * click is forced, so it goes where the item was even if the menu closed meanwhile: it then lands on the tree below,
 * selects another row and runs nothing (a Windows run lost Delete so). The press is therefore checked where it landed:
 * only a press that missed the item opens the menu again; once one reaches it, what it runs is the caller's to check.
 */
export async function chooseExplorerMenuItem(page, path, name) {
  const names = [name].flat(), submenus = names.slice(0, -1)
  name = names.join(' › ')
  let presses = 0
  await expect(async () => {
    const menu = submenus.length ? await openExplorerSubmenu(page, path, submenus) : await openExplorerMenu(page, ...path)
    const item = menu.getByRole('menuitem', { name: names.at(-1), exact: true })
    // The item by its command, not its element: a menu that renders again keeps the item's id.
    await item.evaluate(element => {
      const id = element.getAttribute('data-item-id')
      window.__variaMenuPress = 'none'
      addEventListener('pointerdown', event => { window.__variaMenuPress = event.target.closest?.('[role="menuitem"]')?.getAttribute('data-item-id') === id ? 'item' : 'elsewhere' }, { capture: true, once: true })
    }, undefined, { timeout: 2000 })
    presses++
    // A press that reached the item chose it, even if the click then reports a failure: it is never pressed again.
    const failure = await item.click({ force: true, timeout: 2000 }).then(() => undefined, error => error)
    const landed = await page.evaluate(() => window.__variaMenuPress)
    if (landed !== 'item' && failure) throw failure
    expect(landed, `where the press on ${name} landed`).toBe('item')
  }).toPass({ timeout: process.platform === 'win32' ? 60000 : 30000, intervals: [100, 250, 500] })
  if (presses > 1) console.log(`Object Explorer row ${path.join(' › ')} took ${presses} presses on ${name}: an earlier one missed its closed menu.`)
}

/** The visible rows as `level label [expanded]` lines, for failure messages and screenshots of the structure. */
export const explorerLines = page => page.evaluate(part => [...document.querySelectorAll(part.explorerTree + ' [role="treeitem"]')]
  .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  .map(row => `${row.getAttribute('aria-level')} ${row.querySelector(part.explorerRowText)?.textContent}${row.hasAttribute('aria-expanded') ? ` [${row.getAttribute('aria-expanded')}]` : ''}`), part)

/**
 * The static folders a SQL Server 2022 box serves below each kind and folder, with their labels, as plain data: a stub
 * that replaces main's request handler receives it as an argument to answer explorer.children.
 */
export function explorerStatics() {
  const profile = { band: 16, engine: 'box' }
  return {
    objects: Object.fromEntries(nodeKinds.map(kind => [kind, staticChildren({ kind }, profile)])),
    folders: Object.fromEntries(folderIds.map(folder => [folder, staticChildren({ folder }, profile)])),
    labels: Object.fromEntries(folderIds.map(folder => [folder, folderSpecs[folder].label]))
  }
}
