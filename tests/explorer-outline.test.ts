import { describe, expect, it } from 'vitest'
import { explorerCovers, explorerOutline, explorerRuns, findExplorerPath, type OutlineRow } from '../scripts/fixtures/explorer-outline.ts'
import { explorerLimits } from '../src/shared/explorer/catalog'

// The smoke suites find Object Explorer rows by path (scripts/fixtures/explorer-tree.mjs). The tree is windowed: it renders the
// rows around its viewport plus the selected row, at their offsets in the tree's content.

const { rowHeight, serverRowHeight, overscan } = explorerLimits

/** A tree from `level label` lines, laid out as the tree lays its rows out (servers taller). */
function tree(lines: string[]): OutlineRow[] {
  let top = 0
  return lines.map((line, index) => {
    const [level, ...label] = line.split(' '), height = level === '1' ? serverRowHeight : rowHeight
    const row = { id: 'row-' + index, top, height, level: Number(level), label: label.join(' ') }
    top += height
    return row
  })
}

/** The rows the tree renders at `scrollTop` (its layoutWindow plus overscan), and the selected row wherever it is. */
function rendered(rows: OutlineRow[], scrollTop: number, viewport: number, selected?: string): OutlineRow[] {
  const indexAt = (offset: number) => Math.max(0, rows.findLastIndex(row => row.top <= offset))
  const first = Math.max(0, indexAt(scrollTop) - overscan), end = Math.min(rows.length, indexAt(scrollTop + viewport - 1) + 1 + overscan)
  const window = rows.slice(first, end), extra = rows.find(row => row.id === selected)
  return extra && !window.includes(extra) ? [...window, extra] : window
}

// PR #82's Windows run: one server, 1020 px of rows in a 553 px view, server-a › Security near the bottom.
const ciTree = tree([
  '1 server-a', '2 Databases', '3 System Databases', '4 master', '3 Database Snapshots', '3 AppData', '4 Tables', '5 System Tables', '5 FileTables',
  '5 External Tables', '5 Graph Tables', '5 Dropped Ledger Tables', '5 dbo.Lines', '4 Views', '5 System Views', '5 Dropped Ledger Views',
  '5 dbo.OrderSummary', '4 External Resources', '4 Synonyms', '4 Programmability', '5 Stored Procedures', '6 System Stored Procedures',
  '6 dbo.ShipOrder', '5 Functions', '5 Database Triggers', '5 Assemblies', '5 Types', '5 Rules', '5 Defaults', '5 Plan Guides', '5 Sequences',
  '4 Storage', '4 Security', '3 Sales', '3 Sales3', '3 SalesCopy', '2 Security', '3 Logins', '4 sa', '3 Server Roles', '3 Credentials',
  '3 Cryptographic Providers', '3 Audits', '3 Server Audit Specifications', '2 Server Objects', '2 Integration Services Catalogs'
])

// Two servers: server-b's Security is level 2 as well, far below server-b itself.
const twoServers = tree([
  '1 server-a', '2 Databases', '2 Security', '2 Server Objects',
  '1 server-b', '2 Databases', ...Array.from({ length: 40 }, (_, index) => '3 Db' + index), '2 Security', '3 Logins', '2 Server Objects'
])

describe('Object Explorer outline', () => {
  it('lays the fixture trees out as the tree does', () => {
    expect(ciTree.at(-1)!.top + ciTree.at(-1)!.height).toBe(1020)
    expect(rendered(ciTree, 467, 553).map(row => row.label).slice(0, 2)).toEqual(['Graph Tables', 'Dropped Ledger Tables'])
  })

  it('finds a row whose server is out of the rendered window through an outline read from the top', () => {
    const path = ['server-a', 'Security'], security = ciTree.find(row => row.level === 2 && row.label === 'Security')!
    // No window holds both server-a and its Security, so a match within one window's rows (as explorerRow made) never finds it.
    const windows = [467, 0, 276, 552].map(top => rendered(ciTree, Math.min(top, 1020 - 553), 553))
    expect(windows.map(rows => findExplorerPath(rows, path))).toEqual([undefined, undefined, undefined, undefined])
    expect(findExplorerPath(explorerOutline(windows), path)).toEqual(security)
    // The CI window alone, or windows that leave a gap between server-a and Security, never match.
    expect(findExplorerPath(explorerOutline([windows[0]]), path)).toBeUndefined()
    expect(findExplorerPath(explorerOutline([ciTree.slice(0, 4), windows[0]]), path)).toBeUndefined()
    // The rows the tree already shows together still match within one window.
    expect(findExplorerPath(rendered(ciTree, 0, 553), ['server-a', 'Databases', 'AppData'])?.id).toBe(ciTree[5].id)
  })

  it('never matches a row through the selected row rendered apart from the window', () => {
    // server-a selected (always rendered) while the window shows server-b's Security without server-b: rows read in order
    // without their offsets put server-a right above server-b's Security.
    const bottom = twoServers.at(-1)!.top + twoServers.at(-1)!.height, window = rendered(twoServers, bottom - 200, 200, 'row-0')
    const ownSecurity = twoServers[2], otherSecurity = twoServers.find((row, index) => index > 4 && row.label === 'Security')!
    expect(window).toContain(twoServers[0])
    expect(window).toContain(otherSecurity)
    expect(window).not.toContain(twoServers[4])
    expect(findExplorerPath(window, ['server-a', 'Security'])).toBeUndefined()
    expect(explorerRuns(window).map(run => run.length)).toEqual([1, window.length - 1])
    // Read from the top, each server's Security is its own.
    const windows = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map(top => rendered(twoServers, Math.min(top, bottom - 200), 200, 'row-0'))
    expect(findExplorerPath(explorerOutline(windows), ['server-a', 'Security'])).toEqual(ownSecurity)
    expect(findExplorerPath(explorerOutline(windows), ['server-b', 'Security'])).toEqual(otherSecurity)
  })

  it('lets a later window replace the rows an earlier one read where they overlap', () => {
    // AppData's Tables collapsed between two reads: the rows below it moved up, and the earlier window's rows there are stale.
    const collapsed = tree(['1 server-a', '2 Databases', '3 AppData', '4 Tables', '2 Security', '3 Logins'])
    const expanded = tree(['1 server-a', '2 Databases', '3 AppData', '4 Tables', '5 dbo.A', '5 dbo.B', '2 Security', '3 Logins'])
    const outline = explorerOutline([expanded, collapsed.slice(1)])
    expect(outline.slice(0, collapsed.length)).toEqual(collapsed)
    expect(findExplorerPath(outline, ['server-a', 'Security'])).toEqual(collapsed[4])
    expect(findExplorerPath(outline, ['server-a', 'Databases', 'AppData', 'Tables', 'dbo.A'])).toBeUndefined()
  })

  it('knows when the rendered rows cover the viewport', () => {
    expect(explorerCovers(rendered(ciTree, 467, 553), 467, 1020)).toBe(true)
    // A stale window from the top, with the selected row rendered below it, does not cover the bottom.
    expect(explorerCovers(rendered(ciTree, 0, 553, ciTree.at(-1)!.id), 467, 1020)).toBe(false)
  })
})
