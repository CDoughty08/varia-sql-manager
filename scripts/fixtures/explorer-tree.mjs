// Object Explorer helpers for the smoke suites: finding rows of the windowed tree by their path, and the static part of
// the tree for suites that answer explorer.children in main instead of through a backend.
import { expect } from '@playwright/test'
import { folderIds, folderSpecs, nodeKinds, staticChildren } from '../../src/shared/explorer/catalog.ts'

export const explorerTree = page => page.getByRole('tree', { name: 'Object Explorer', exact: true })

/**
 * The row at a path of labels from a server down (`'server-a', 'Databases', 'AppData'`), once it is rendered: rows are
 * windowed, so the path must be in or near view. Matching is by each row's label, without its sublabel. An options
 * object last sets the wait (`{ timeout }`).
 */
export async function explorerRow(page, ...path) {
  const options = typeof path.at(-1) === 'object' ? path.pop() : {}, labels = path
  let id = null
  await expect.poll(async () => {
    id = await page.evaluate(path => {
      const rows = [...document.querySelectorAll('.explorer-tree [role="treeitem"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const stack = []
      for (const row of rows) {
        const level = Number(row.getAttribute('aria-level'))
        stack.length = level - 1
        stack[level - 1] = row.querySelector('.oe-label')?.textContent ?? row.querySelector('.oe-text')?.textContent ?? ''
        if (level === path.length && path.every((label, index) => stack[index] === label)) return row.id
      }
      return null
    }, labels)
    return id
  }, { message: 'Object Explorer row ' + labels.join(' › '), ...options }).not.toBeNull()
  return page.locator('#' + id)
}

/** Expands each row of a path that is collapsed, from the server down, by its chevron. */
export async function expandExplorerPath(page, ...path) {
  const options = typeof path.at(-1) === 'object' ? path.pop() : {}
  for (let length = 1; length <= path.length; length++) {
    const row = await explorerRow(page, ...path.slice(0, length), options)
    if (await row.getAttribute('aria-expanded') === 'false') await row.locator('.oe-twistie').click({ force: true })
    await expect(row).toHaveAttribute('aria-expanded', 'true', options)
  }
}

/** The visible rows as `level label [expanded]` lines, for failure messages and screenshots of the structure. */
export const explorerLines = page => page.evaluate(() => [...document.querySelectorAll('.explorer-tree [role="treeitem"]')]
  .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  .map(row => `${row.getAttribute('aria-level')} ${row.querySelector('.oe-label, .oe-text')?.textContent}${row.hasAttribute('aria-expanded') ? ` [${row.getAttribute('aria-expanded')}]` : ''}`))

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
