import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { RecentFilesStore } from '../src/main/recent-files-store'
import { applicationMenuTemplate, type ApplicationMenuActions } from '../src/main/application-menu'
import { recentFilesFileSchema, recentFilesMenuModel, shortenPath, type RecentFile } from '../src/shared/files/recent'
import { recentFileMenuItems } from '../src/renderer/src/menus/MenuService'
import { workbenchFixture } from './fixtures/workbench'

let directory: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'recent-files-test-'))
})
afterEach(async () => {
  expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
  await rm(directory, { recursive: true, force: true })
})
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('the recent files store', () => {
  const at = (minute: number) => () => new Date(Date.UTC(2026, 9, 19, 9, minute))
  it('keeps files most recent first, once each, and remembers them across runs under new ids', async () => {
    const path = join(directory, 'recent-files.json'), system = { add: vi.fn(), clear: vi.fn() }
    const store = new RecentFilesStore(path, { platform: 'linux', now: at(1), system })
    await store.load()
    expect(store.list()).toEqual([])
    await store.add('/q/a.sql')
    await store.add('/q/b.sql')
    await store.add('/q/a.sql')
    // POSIX paths differ by case.
    await store.add('/q/A.sql')
    expect(store.list().map(file => file.path)).toEqual(['/q/A.sql', '/q/a.sql', '/q/b.sql'])
    expect(store.list().map(file => file.name)).toEqual(['A.sql', 'a.sql', 'b.sql'])
    expect(store.list(2)).toHaveLength(2)
    const ids = store.list().map(file => file.id)
    expect(ids.every(id => uuid.test(id))).toBe(true)
    expect(store.list().map(file => file.id)).toEqual(ids)
    expect(system.add.mock.calls.map(([added]) => added)).toEqual(['/q/a.sql', '/q/b.sql', '/q/a.sql', '/q/A.sql'])
    // The file holds paths and times only, never ids.
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(recentFilesFileSchema.parse(stored)).toEqual({ version: 1, files: ['/q/A.sql', '/q/a.sql', '/q/b.sql'].map(file => ({ path: file, openedAt: '2026-10-19T09:01:00.000Z' })) })
    expect(JSON.stringify(stored)).not.toContain(ids[0])
    const next = new RecentFilesStore(path, { platform: 'linux' })
    await next.load()
    expect(next.list().map(file => file.path)).toEqual(['/q/A.sql', '/q/a.sql', '/q/b.sql'])
    expect(next.list().map(file => file.id).some(id => ids.includes(id))).toBe(false)
  })
  it('folds case on Windows, keeping the latest spelling', async () => {
    const store = new RecentFilesStore(join(directory, 'recent-files.json'), { platform: 'win32' })
    await store.add('C:\\Q\\Orders.sql')
    const id = store.list()[0].id
    await store.add('c:\\q\\ORDERS.SQL')
    expect(store.list().map(file => file.path)).toEqual(['c:\\q\\ORDERS.SQL'])
    // The entry keeps its id, so an open menu's item still opens it.
    expect(store.list()[0].id).toBe(id)
    expect(store.pathOf(id)).toBe('c:\\q\\ORDERS.SQL')
  })
  it('keeps the 50 most recent', async () => {
    const store = new RecentFilesStore(join(directory, 'recent-files.json'), { platform: 'linux' })
    for (let index = 0; index < 55; index++) await store.add(`/q/${index}.sql`)
    expect(store.list().map(file => file.path)).toEqual(Array.from({ length: 50 }, (_, index) => `/q/${54 - index}.sql`))
  })
  it('removes one entry by id, clears them all, and opens nothing for an unknown id', async () => {
    const system = { add: vi.fn(), clear: vi.fn() }
    const store = new RecentFilesStore(join(directory, 'recent-files.json'), { platform: 'linux', system })
    await store.add('/q/a.sql')
    await store.add('/q/b.sql')
    const [b] = store.list()
    expect(store.pathOf(crypto.randomUUID())).toBeUndefined()
    await store.remove(b.id)
    expect(store.list().map(file => file.path)).toEqual(['/q/a.sql'])
    expect(store.pathOf(b.id)).toBeUndefined()
    const changes = vi.fn()
    store.onDidChange(changes)
    await store.clear()
    expect(store.list()).toEqual([])
    expect(system.clear).toHaveBeenCalledTimes(1)
    expect(changes).toHaveBeenCalledTimes(1)
  })
  it('quarantines a file it does not understand and starts empty', async () => {
    const path = join(directory, 'recent-files.json')
    await writeFile(path, JSON.stringify({ version: 1, files: [{ path: '/q/a.sql', openedAt: 'yesterday' }] }))
    const store = new RecentFilesStore(path, { platform: 'linux' })
    await store.load()
    expect(store.list()).toEqual([])
    expect((await readdir(directory)).filter(name => name.startsWith('recent-files.json.invalid-'))).toHaveLength(1)
    await store.add('/q/b.sql')
    expect(recentFilesFileSchema.parse(JSON.parse(await readFile(path, 'utf8'))).files.map(file => file.path)).toEqual(['/q/b.sql'])
  })
  it('never writes over a file it could not read', async () => {
    // A folder where the file should be: reading it fails, which is not a file to replace.
    const path = join(directory, 'recent-files.json')
    await mkdir(path)
    const store = new RecentFilesStore(path, { platform: 'linux' })
    await store.add('/q/a.sql')
    expect(store.list().map(file => file.path)).toEqual(['/q/a.sql'])
    expect((await stat(path)).isDirectory()).toBe(true)
  })
  it('accepts only its own strict shape', () => {
    const entry = { path: '/q/a.sql', openedAt: '2026-10-19T09:01:00.000Z' }
    expect(recentFilesFileSchema.safeParse({ version: 1, files: [entry] }).success).toBe(true)
    for (const value of [
      { version: 2, files: [] }, { version: 1, files: [], extra: true }, { version: 1, files: [{ ...entry, id: 'x' }] }, { version: 1, files: [{ ...entry, path: '' }] },
      { version: 1, files: [{ ...entry, path: 'x'.repeat(4097) }] }, { version: 1, files: Array.from({ length: 51 }, () => entry) }
    ]) expect(recentFilesFileSchema.safeParse(value).success).toBe(false)
  })
})

const recent = (count: number, prefix = 'C:\\Queries\\'): RecentFile[] => Array.from({ length: count }, (_, index) => ({ id: `id-${index + 1}`, name: `q${index + 1}.sql`, path: `${prefix}q${index + 1}.sql` }))
describe('File › Recent Files items', () => {
  it('shortens paths in the middle, keeping the root and the folders nearest the file', () => {
    expect(shortenPath('C:\\Queries\\orders.sql')).toBe('C:\\Queries\\orders.sql')
    const long = 'C:\\Users\\someone\\OneDrive - Contoso\\Documents\\SQL Server Management Studio\\Queries\\Reporting\\orders.sql'
    expect(shortenPath(long)).toBe('C:\\…\\Queries\\Reporting\\orders.sql')
    expect(shortenPath(long).length).toBeLessThanOrEqual(60)
    expect(shortenPath('/home/someone/projects/warehouse/reporting/monthly/sql/queries/orders-by-region.sql')).toBe('/…/reporting/monthly/sql/queries/orders-by-region.sql')
    expect(shortenPath('\\\\server\\share\\' + 'x'.repeat(80) + '.sql')).toMatch(/^x+….*\.sql$/)
    expect(shortenPath('\\\\server\\share\\' + 'x'.repeat(80) + '.sql').length).toBeLessThanOrEqual(60)
  })
  it('numbers files with access keys 1–9 and 0, then none, and ends with Clear Recent Files', () => {
    const items = recentFilesMenuModel(recent(11), 'win32')
    expect(items.slice(0, 2)).toEqual([{ kind: 'file', id: 'id-1', label: '1 C:\\Queries\\q1.sql', mnemonic: '1' }, { kind: 'file', id: 'id-2', label: '2 C:\\Queries\\q2.sql', mnemonic: '2' }])
    expect(items[9]).toEqual({ kind: 'file', id: 'id-10', label: '10 C:\\Queries\\q10.sql', mnemonic: '0' })
    expect(items[10]).toEqual({ kind: 'file', id: 'id-11', label: '11 C:\\Queries\\q11.sql' })
    expect(items.slice(11)).toEqual([{ kind: 'separator' }, { kind: 'clear', label: 'Clear Recent Files' }])
    // macOS shows the path alone, with no access keys.
    expect(recentFilesMenuModel(recent(1, '/q/'), 'darwin')[0]).toEqual({ kind: 'file', id: 'id-1', label: '/q/q1.sql' })
  })
  it('shows a disabled No Recent Files for an empty list', () => {
    expect(recentFilesMenuModel([], 'linux')).toEqual([{ kind: 'empty', label: 'No Recent Files' }])
  })
  it('strips control and bidi characters a file name could hide behind', () => {
    const [item] = recentFilesMenuModel([{ id: 'x', name: 'n', path: '/q/\u202Egnp.sql\nexe' }], 'linux')
    expect(item).toMatchObject({ label: '1 /q/gnp.sqlexe' })
  })
  it('becomes native items whose paths keep their ampersands and whose number is the access key', () => {
    const actions: ApplicationMenuActions = {
      command: vi.fn(), isChecked: () => false, pageHasKeyFocus: () => true, sendActionToFirstResponder: vi.fn(), setTheme: vi.fn(), createTheme: vi.fn(), openThemesFolder: vi.fn(), reloadThemes: vi.fn(),
      openRecent: vi.fn(), clearRecent: vi.fn()
    }
    const list = [...recent(9), { id: 'id-10', name: 'r&d.sql', path: 'C:\\R&D\\r&d.sql' }]
    const submenu = (platform: NodeJS.Platform) => {
      const file = applicationMenuTemplate({ theme: { preference: { version: 1, mode: 'dark', darkTheme: 'dark', lightTheme: 'light' }, themes: [] }, recentFiles: recentFilesMenuModel(list, platform) }, actions, platform)
        .find(item => item.id === 'menu.file')!.submenu as MenuItemConstructorOptions[]
      return file.find(item => item.id === 'file.recent')!.submenu as MenuItemConstructorOptions[]
    }
    const items = submenu('win32')
    expect(items.map(item => [item.id ?? item.type, item.label])).toEqual([
      ...list.slice(0, 9).map((file, index) => [`file.recent.${index + 1}`, `&${index + 1} ${file.path}`]), ['file.recent.10', '1&0 C:\\R&&D\\r&&d.sql'], ['separator', undefined], ['file.recent.clear', 'Clear Recent Files']
    ])
    ;(items[9].click as () => void)()
    expect(actions.openRecent).toHaveBeenCalledWith('id-10')
    ;(items.at(-1)!.click as () => void)()
    expect(actions.clearRecent).toHaveBeenCalledTimes(1)
    expect(submenu('darwin')[9].label).toBe('C:\\R&D\\r&d.sql')
  })
  it('becomes the renderer\'s items, which open an entry by its id', () => {
    expect(recentFileMenuItems(recent(1), 'win32')).toEqual([
      { kind: 'command', key: 'recent.id-1', id: 'file.openRecent', args: { recentFile: 'id-1' }, title: '1 C:\\Queries\\q1.sql', mnemonic: '1', icon: null },
      { kind: 'separator' },
      { kind: 'command', key: 'recent.clear', id: 'file.clearRecent', title: 'Clear Recent Files', mnemonic: 'c', icon: null }
    ])
    expect(recentFileMenuItems([], 'win32')).toEqual([{ kind: 'command', key: 'recent.empty', id: 'file.openRecent', title: 'No Recent Files', mnemonic: null, enabled: false, icon: null }])
  })
})

describe('Recent Files in the workbench', () => {
  it('follows main\'s list in File › Recent Files, opens an entry by id, and clears the list', async () => {
    const fixture = workbenchFixture()
    try {
      const { api, menus, context, commands } = fixture
      const recentMenu = () => (menus.resolve('file').find(item => item.key === 'file.recent') as { items: readonly { kind: string; title?: string; enabled?: boolean; key: string }[] }).items
      expect(context.getState().hasRecentFiles).toBe(false)
      expect(recentMenu().map(item => [item.title, item.enabled])).toEqual([['No Recent Files', false]])
      expect(commands.canRun('file.openRecent')).toBe(false)
      api.pushRecent(recent(2))
      expect(context.getState().hasRecentFiles).toBe(true)
      expect(recentMenu().map(item => item.kind === 'separator' ? '-' : [item.title, item.enabled])).toEqual([['1 C:\\Queries\\q1.sql', true], ['2 C:\\Queries\\q2.sql', true], '-', ['Clear Recent Files', true]])
      await commands.run('file.openRecent', { recentFile: 'id-2' })
      expect(api.openRecentFile).toHaveBeenCalledWith('id-2')
      // An id no longer in the list (the menu was open while it changed) is not run.
      expect(commands.canRun('file.openRecent', { recentFile: 'gone' })).toBe(false)
      await commands.run('file.clearRecent')
      expect(api.clearRecentFiles).toHaveBeenCalledTimes(1)
      expect(context.getState().hasRecentFiles).toBe(false)
    } finally { fixture.dispose() }
  })
  it('picks from the list in the palette, by name or path', async () => {
    const fixture = workbenchFixture()
    try {
      const { api, commands, quickInput } = fixture
      api.pushRecent(recent(2))
      const running = commands.run('file.openRecent')
      await vi.waitFor(() => expect(quickInput.getSnapshot().visible).toBe(true))
      expect(quickInput.getSnapshot().rows.map(row => [row.item.label, row.item.description])).toEqual([['q1.sql', 'C:\\Queries\\q1.sql'], ['q2.sql', 'C:\\Queries\\q2.sql']])
      quickInput.accept(1)
      await running
      await vi.waitFor(() => expect(api.openRecentFile).toHaveBeenCalledWith('id-2'))
    } finally { fixture.dispose() }
  })
  it('takes the first list main sends, unless a push came first', async () => {
    const { RecentFilesService } = await import('../src/renderer/src/services/recent-files')
    let answer!: (files: RecentFile[]) => void, push!: (files: RecentFile[]) => void
    const service = new RecentFilesService({
      recentFiles: () => new Promise(resolve => { answer = files => resolve({ ok: true, value: files }) }),
      onRecentFiles: callback => { push = callback; return () => {} }
    })
    push(recent(1))
    answer(recent(3))
    await Promise.resolve(); await Promise.resolve()
    expect(service.getSnapshot()).toHaveLength(1)
    service.dispose()
  })
})
