// Object Explorer helpers for the smoke suites: finding rows of the windowed tree by their path, and the static part of
// the tree for suites that answer explorer.children in main instead of through a backend.
import { expect } from './smoke.mjs'
import { folderIds, folderSpecs, nodeKinds, staticChildren } from '../../src/shared/explorer/catalog.ts'
import { explorerTree, part } from './ui.mjs'

export { explorerTree }

/**
 * The row at a path of labels from a server down (`'server-a', 'Databases', 'AppData'`), once it is rendered: rows are
 * windowed, so the path must be in or near view. Matching is by each row's label, without its sublabel. An options
 * object last sets the wait (`{ timeout }`).
 */
export async function explorerRow(page, ...path) {
  const options = typeof path.at(-1) === 'object' ? path.pop() : {}, labels = path
  let id = null
  await expect.poll(async () => {
    id = await page.evaluate(({ path, part }) => {
      const rows = [...document.querySelectorAll(part.explorerTree + ' [role="treeitem"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const stack = []
      for (const row of rows) {
        const level = Number(row.getAttribute('aria-level'))
        stack.length = level - 1
        stack[level - 1] = row.querySelector(part.explorerLabel)?.textContent ?? row.querySelector(part.explorerText)?.textContent ?? ''
        if (level === path.length && path.every((label, index) => stack[index] === label)) return row.id
      }
      return null
    }, { path: labels, part })
    return id
  }, { message: 'Object Explorer row ' + labels.join(' › '), ...options }).not.toBeNull()
  return page.locator('#' + id)
}

/**
 * The row at a path, scrolled into the tree's rendered rows first when it is not among them. The tree renders a window of
 * rows around its viewport and re-windows on its scroll event, which Chromium dispatches with a frame: in a short window
 * an earlier step's scroll can leave the row outside, and a window that draws few frames (a hidden or occluded one) can
 * keep a stale window for long. So the scan sends the scroll event too, from the current position and then from the top,
 * half a viewport at a time, and the tree's geometry and rendered rows are logged first.
 */
export async function revealExplorerRow(page, ...path) {
  const found = await explorerRow(page, ...path, { timeout: 2000 }).catch(() => null)
  if (found) return found
  const tree = explorerTree(page), label = path.join(' › ')
  const state = () => tree.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight }))
  const before = await state()
  console.log(`Object Explorer row ${label} was not rendered (scrollTop ${before.top}, height ${before.height}, scroll height ${before.scrollHeight}; rows: ${(await explorerLines(page)).join(' | ')}); scrolling to it.`)
  const step = Math.max(22, Math.floor(before.height / 2))
  for (let index = -1, top = before.top; top < before.scrollHeight; top = ++index * step) {
    await tree.evaluate((element, top) => { element.scrollTop = top; element.dispatchEvent(new Event('scroll')) }, top)
    const row = await explorerRow(page, ...path, { timeout: 2000 }).catch(() => null)
    if (row) return row
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
