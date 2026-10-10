import { describe, expect, it, vi } from 'vitest'
import { serverObjectKinds } from '../src/shared/contracts'
import { contextKeys } from '../src/shared/commands/context-keys'
import type { ExplorerNode } from '../src/renderer/src/menus/targets'
import { ExplorerService, explorerPaths, refreshPath, type ExplorerPath } from '../src/renderer/src/services/explorer'

const lists = (id: string) => ({
  databases: explorerPaths.databases(id), appTables: explorerPaths.tables(id, 'AppData'), masterTables: explorerPaths.tables(id, 'master'),
  logins: explorerPaths.serverObjects(id, 'logins'), roles: explorerPaths.serverObjects(id, 'serverRoles')
})
/** Which of the lists changed version after `action`. */
function changed(explorer: ExplorerService, paths: Record<string, ExplorerPath>, action: () => void): string[] {
  const before = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, explorer.version(path)]))
  action()
  return Object.entries(paths).filter(([name, path]) => explorer.version(path) !== before[name]).map(([name]) => name)
}

describe('Object Explorer refresh', () => {
  it('reloads the lists at and below the refreshed path, and no others', () => {
    const explorer = new ExplorerService(), a = lists('a'), b = lists('b'), all = { ...prefixed('a', a), ...prefixed('b', b) }
    expect(changed(explorer, all, () => explorer.refresh(explorerPaths.tables('a', 'AppData')))).toEqual(['a.appTables'])
    expect(changed(explorer, all, () => explorer.refresh(['s', 'a', 'd', 'master']))).toEqual(['a.masterTables'])
    expect(changed(explorer, all, () => explorer.refresh(['s', 'a', 'd']))).toEqual(['a.databases', 'a.appTables', 'a.masterTables'])
    expect(changed(explorer, all, () => explorer.refresh(['s', 'a', 'x']))).toEqual(['a.logins', 'a.roles'])
    expect(changed(explorer, all, () => explorer.refresh(explorerPaths.serverObjects('a', 'serverRoles')))).toEqual(['a.roles'])
    expect(changed(explorer, all, () => explorer.refresh(['s', 'a']))).toEqual(['a.databases', 'a.appTables', 'a.masterTables', 'a.logins', 'a.roles'])
    expect(changed(explorer, all, () => explorer.refresh())).toEqual(Object.keys(all))
    // A list refreshed twice, or after its server, never returns to a version it had.
    const seen = new Set([explorer.version(a.appTables)])
    for (const path of [a.appTables, ['s', 'a'], a.appTables, undefined, a.appTables]) {
      explorer.refresh(path)
      expect(seen.has(explorer.version(a.appTables))).toBe(false)
      seen.add(explorer.version(a.appTables))
    }
  })
  it('keeps names with dots, quotes, and brackets apart', () => {
    const explorer = new ExplorerService()
    const paths = { dotted: explorerPaths.tables('a', 'x.y'), split: ['s', 'a', 'd', 'x', 'y', 't'], quoted: explorerPaths.tables('a', '"],["t'), plain: explorerPaths.tables('a', 'x') }
    expect(changed(explorer, paths, () => explorer.refresh(['s', 'a', 'd', 'x.y']))).toEqual(['dotted'])
    expect(changed(explorer, paths, () => explorer.refresh(['s', 'a', 'd', '"],["t']))).toEqual(['quoted'])
  })
  it('tells subscribers about every refresh', () => {
    const explorer = new ExplorerService(), listener = vi.fn()
    explorer.subscribe(listener)
    explorer.refresh(['s', 'a'])
    explorer.refresh()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(explorer.getSnapshot().revision).toBe(2)
    explorer.dispose()
    explorer.refresh()
    expect(listener).toHaveBeenCalledTimes(2)
  })
  it('forgets a disconnected server\'s refreshes, and only that server\'s', () => {
    const explorer = new ExplorerService()
    explorer.refresh(explorerPaths.tables('a', 'AppData'))
    explorer.refresh(['s', 'a'])
    explorer.refresh(['s', 'ab'])
    const other = explorer.version(explorerPaths.databases('ab'))
    explorer.forget('a')
    expect(explorer.version(explorerPaths.tables('a', 'AppData'))).toBe(0)
    expect(explorer.version(explorerPaths.databases('ab'))).toBe(other)
  })
  it('reloads everything once more than 10,000 paths were refreshed, and starts counting again', () => {
    const explorer = new ExplorerService(), a = lists('a')
    for (let index = 0; index < 10_000; index++) explorer.refresh(explorerPaths.tables('b', `db${index}`))
    expect(changed(explorer, a, () => explorer.refresh(explorerPaths.tables('b', 'one more')))).toEqual(Object.keys(a))
    expect(changed(explorer, a, () => explorer.refresh(a.logins))).toEqual(['logins'])
  })
})

describe('refresh paths', () => {
  it('refresh a node\'s own lists, a leaf\'s parent list, and everything for the empty area', () => {
    const server = { connectionId: 'a' }, database = { ...server, database: 'AppData' }
    const cases: [ExplorerNode | undefined, ExplorerPath | undefined][] = [
      [{ kind: 'background' }, undefined], [undefined, undefined], [{ kind: 'server', ...server }, ['s', 'a']], [{ kind: 'lostServer', ...server }, undefined],
      [{ kind: 'databasesFolder', ...server }, ['s', 'a', 'd']], [{ kind: 'systemDatabasesFolder', ...server }, ['s', 'a', 'd']], [{ kind: 'snapshotsFolder', ...server }, ['s', 'a', 'd']],
      [{ kind: 'database', ...database }, ['s', 'a', 'd', 'AppData']], [{ kind: 'tablesFolder', ...database }, ['s', 'a', 'd', 'AppData', 't']],
      [{ kind: 'table', ...database, schema: 'dbo', name: 'Orders' }, ['s', 'a', 'd', 'AppData', 't']], [{ kind: 'securityFolder', ...server }, ['s', 'a', 'x']],
      [{ kind: 'serverObjectsFolder', ...server, objectKind: 'logins' }, ['s', 'a', 'x', 'logins']], [{ kind: 'serverObject', ...server, objectKind: 'audits', name: 'LoginAudit' }, ['s', 'a', 'x', 'audits']]
    ]
    for (const [node, path] of cases) expect(refreshPath(node), node?.kind).toEqual(path)
    // Every kind of node is covered.
    expect(new Set(cases.flatMap(([node]) => node ? [node.kind] : []))).toEqual(new Set(contextKeys.explorerNode.values.filter(value => value)))
    for (const kind of serverObjectKinds) expect(refreshPath({ kind: 'serverObjectsFolder', ...server, objectKind: kind })).toEqual(explorerPaths.serverObjects('a', kind))
  })
})

function prefixed(prefix: string, paths: Record<string, ExplorerPath>): Record<string, ExplorerPath> {
  return Object.fromEntries(Object.entries(paths).map(([name, path]) => [`${prefix}.${name}`, path]))
}
