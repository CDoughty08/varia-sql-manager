import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serverFilePurposeSpecs, serverFileTypesLabel } from '../src/shared/actions/catalog'
import {
  folderPath, sameServerPath, serverFolder, serverPathChain, serverPathProblem, serverPathRoot, splitServerPath, type ServerFileEntry, type ServerFilesListing, type ServerRoot
} from '../src/shared/actions/files'
import type { ActionDescribeRequest, ActionDescribeResult } from '../src/shared/actions/schema'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import {
  formatFree, formatModified, formatSize, pickerMessages, pickerRows, pickerStatus, pickerTreeLabel, rootLabel, selectedFolder, ServerFilePickerService, slowListingMs, type PickerRow
} from '../src/renderer/src/server-files/ServerFilePickerService'
import { serverFilesTestHook } from '../src/renderer/src/server-files/test-hook'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const fixture = JSON.parse(readFileSync('tests/fixtures/server-paths.json', 'utf8')) as { valid: string[]; invalid: string[]; folders: { path: string; linux: boolean; folder: string | null }[] }

describe('server paths', () => {
  it('follows tests/fixtures/server-paths.json, which ServerFilesChecks holds C# to', () => {
    expect(fixture.valid.filter(path => serverPathProblem(path))).toEqual([])
    expect(fixture.invalid.filter(path => !serverPathProblem(path))).toEqual([])
    expect(fixture.folders.filter(item => (serverFolder(item.path, item.linux ? '/' : '\\') ?? null) !== item.folder)).toEqual([])
    expect([serverPathProblem('C:\\' + 'x'.repeat(257)), serverPathProblem('C:\\' + 'x'.repeat(258))]).toEqual([undefined, 'A path is at most 260 characters.'])
    expect([serverPathProblem('C:\\a\uD800b'), serverPathProblem('C:\\a\uD83D\uDE00')]).toEqual(['The path holds a broken character (half of a surrogate pair).', undefined])
  })
  it('splits paths into the folders a typed path lists, by the server\'s separator', () => {
    expect(serverPathChain('C:\\Program Files\\\\Microsoft SQL Server\\', '\\')).toEqual(['C:\\', 'C:\\Program Files\\', 'C:\\Program Files\\Microsoft SQL Server\\'])
    expect(serverPathChain('//files/share/nightly/', '\\')).toEqual(['\\\\files\\share\\', '\\\\files\\share\\nightly\\'])
    expect(serverPathChain('/var/opt/mssql/', '/')).toEqual(['/', '/var/', '/var/opt/', '/var/opt/mssql/'])
    expect([serverPathChain('Backups\\', '\\'), serverPathChain('C:\\x\\', '/')]).toEqual([[], []])
    expect([serverPathRoot('c:/x', '\\'), serverPathRoot('\\\\files\\share\\x', '\\'), serverPathRoot('/x', '/'), serverPathRoot('\\\\files', '\\')]).toEqual(['c:\\', '\\\\files\\share\\', '/', undefined])
    expect(splitServerPath('D:/Backups/AppData.bak', '\\')).toEqual({ folder: 'D:\\Backups\\', name: 'AppData.bak' })
    expect([folderPath('/var/opt', '/'), sameServerPath('C:\\A', 'c:\\a', '\\'), sameServerPath('/A', '/a', '/')]).toEqual(['/var/opt/', true, false])
  })
  it('formats sizes, free space and times as the picker shows them, and words Files of type as SSMS does', () => {
    expect([formatSize(512), formatSize(4 * 1024 * 1024), formatSize(15 * 1024 * 1024), formatFree(217_088)]).toEqual(['512 bytes', '4.0 MB', '15 MB', '212 GB free'])
    expect(formatModified('2026-10-12T14:03:05')).toBe('2026-10-12 14:03')
    expect([serverFileTypesLabel('backup'), serverFileTypesLabel('database'), serverFileTypesLabel('log'), serverFileTypesLabel('folder')])
      .toEqual(['Backup Files(*.bak;*.trn)', 'Database Data Files(*.mdf)', 'Database Log Files(*.ldf)', undefined])
    expect(Object.values(serverFilePurposeSpecs).map(spec => spec.title)).toEqual(['Locate Backup File', 'Locate Database Files', 'Locate Database Files', 'Locate Folder'])
  })
})

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers() })

const roots: ServerRoot[] = [{ path: 'C:\\', kind: 'drive', freeMb: 217_088 }, { path: 'D:\\SQLData\\', kind: 'folder', defaults: ['data', 'log'] }, { path: 'D:\\Backups\\', kind: 'folder', defaults: ['backup'] }]
const dir = (name: string): ServerFileEntry => ({ name, directory: true })
const file = (name: string, sizeBytes = 4096): ServerFileEntry => ({ name, directory: false, sizeBytes, modified: '2026-10-12T14:03:05' })
/** A Windows server's folders, by lower-case path; listings filter as the backend does. */
const tree: Record<string, ServerFileEntry[]> = {
  'c:\\': [dir('Program Files'), file('pagefile.sys')],
  'd:\\': [dir('Backups'), dir('SQLData')],
  'd:\\backups\\': [dir('Nightly'), file('AppData.bak'), file('AppData_log.trn'), file('notes.txt')],
  'd:\\backups\\nightly\\': [file('Sales.bak')],
  'd:\\sqldata\\': [file('master.mdf'), file('mastlog.ldf')],
  'd:\\empty\\': [],
  '\\\\files\\share\\': [file('Shared.bak')]
}

/** `limit` truncates listings as the backend's browseEntries does; `legacy` answers as SQL Server 2016 does a login outside sysadmin. */
function setup(options: { legacy?: boolean; limit?: number } = {}) {
  const held = new Map<string, ReturnType<typeof deferred<ApiResult<ActionDescribeResult>>>>()
  /** Held requests by id, which a cancel answers CANCELLED as the backend does. */
  const waiting = new Map<string, { path: string; wait: ReturnType<typeof deferred<ApiResult<ActionDescribeResult>>> }>()
  const answer = (params: ActionDescribeRequest): ApiResult<ActionDescribeResult> => {
    const files = params.files!
    if (files.path === undefined) return { ok: true, value: { elapsedMs: 1, serverFiles: { separator: '\\', roots, entries: [], truncated: false } } }
    if (files.exists) {
      const { folder, name } = splitServerPath(files.path, '\\')
      const own = tree[folder.toLowerCase()]?.find(entry => sameServerPath(entry.name, name, '\\'))
      const entries = options.legacy || !own ? [] : [{ name: own.name, directory: own.directory }]
      return { ok: true, value: { elapsedMs: 1, serverFiles: { separator: '\\', path: files.path, roots: [], entries, truncated: false, ...(options.legacy ? { notice: 'legacyEmpty' as const } : {}) } } }
    }
    const folder = folderPath(files.path, '\\')
    const entries = tree[folder.toLowerCase()]
    if (!entries) return { ok: true, value: { elapsedMs: 1, error: { code: 'PATH_NOT_FOUND', message: `The folder ${folder} does not exist, or SQL Server's service account cannot see it.`, retryable: false } } }
    const extensions = serverFilePurposeSpecs[files.purpose].extensions
    const listed = options.legacy ? [] : entries.filter(entry => entry.directory || (extensions.length > 0 || files.allFiles) && (files.allFiles || extensions.some(extension => entry.name.toLowerCase().endsWith(extension))))
    const limit = options.limit ?? listed.length
    const listing: ServerFilesListing = { separator: '\\', path: folder, roots: [], entries: listed.slice(0, limit), truncated: listed.length > limit, ...(options.legacy ? { notice: 'legacyEmpty' as const } : {}) }
    return { ok: true, value: { elapsedMs: 1, serverFiles: listing } }
  }
  const api = {
    describeObject: vi.fn<VariaApi['describeObject']>(async params => {
      const wait = held.get(params.files?.path ?? '')
      if (wait) { waiting.set(params.requestId, { path: params.files?.path ?? '', wait }); return wait.promise }
      return answer(params)
    }),
    cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async ids => {
      for (const id of ids) {
        const request = waiting.get(id)
        if (!request) continue
        waiting.delete(id)
        held.delete(request.path)
        request.wait.resolve({ ok: false, error: 'The operation was cancelled.', code: 'CANCELLED' })
      }
      return { ok: true, value: { cancelled: ids.length } }
    })
  }
  const connections = new ConnectionService()
  connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
  let ids = 0, clock = 0
  const service = new ServerFilePickerService({ api, connections, newId: () => `id-${++ids}`, now: () => (clock += 5) })
  cleanups.push(() => service.dispose())
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const hold = (path: string) => { const wait = deferred<ApiResult<ActionDescribeResult>>(); held.set(path, wait); return { release: () => { held.delete(path); wait.resolve(answer({ ...api.describeObject.mock.calls.at(-1)![0] })) }, wait } }
  const paths = () => api.describeObject.mock.calls.map(([params]) => params.files?.path ?? null)
  const items = () => pickerRows(service.current!).flatMap(row => row.type === 'item' ? [`${'  '.repeat(row.level - 1)}${row.name}${row.expanded ? ' (open)' : ''}`] : [`${'  '.repeat(row.level - 1)}— ${row.text}`])
  return { service, api, connections, settle, hold, paths, items }
}

describe('ServerFilePickerService', () => {
  it('opens on the server\'s drives and default folders, at the purpose\'s default folder, one request per folder', async () => {
    const { service, api, settle, paths, items } = setup()
    const picked = service.pick({ connectionId: 'server-a', purpose: 'backup' })
    expect(service.current).toMatchObject({ title: 'Locate Backup File - server-a.example', server: 'server-a.example', mustExist: true, allFiles: false, fileName: '' })
    expect(api.describeObject.mock.calls[0][0]).toEqual({ connectionId: 'server-a', requestId: 'id-1', dialog: 'serverFiles', target: { kind: 'server' }, files: { purpose: 'backup' } })
    await settle()
    expect(paths()).toEqual([null, 'D:\\Backups\\'])
    expect(items()).toEqual(['C:\\', 'D:\\SQLData\\', 'D:\\Backups\\ (open)', '  Nightly', '  AppData.bak', '  AppData_log.trn'])
    expect(service.current).toMatchObject({ selected: 'D:\\Backups\\', separator: '\\' })
    expect(pickerStatus(service.current!)).toBe('3 items · listed in 5 ms · type a path or a UNC name to go there')
    expect(await service.pick({ connectionId: 'server-a', purpose: 'log' })).toBeUndefined()
    // A folder is listed once: collapsing and expanding again reads the cache.
    service.toggle('D:\\Backups\\')
    service.toggle('D:\\Backups\\')
    service.toggle('D:\\Backups\\Nightly\\')
    await settle()
    expect(paths()).toEqual([null, 'D:\\Backups\\', 'D:\\Backups\\Nightly\\'])
    service.select('D:\\Backups\\Nightly\\Sales.bak')
    expect(service.current).toMatchObject({ fileName: 'Sales.bak' })
    expect(selectedFolder(service.current!)).toBe('D:\\Backups\\Nightly\\')
    await service.ok()
    expect(await picked).toBe('D:\\Backups\\Nightly\\Sales.bak')
    expect(service.current).toBeUndefined()
  })
  it('goes to a typed path folder by folder, in the server\'s spelling, and chooses a file the folder lists', async () => {
    const { service, settle, paths } = setup()
    const picked = service.pick({ connectionId: 'server-a', purpose: 'backup' })
    await settle()
    service.setFileName('d:/backups/nightly/sales.BAK')
    await service.ok()
    expect(paths()).toEqual([null, 'D:\\Backups\\', 'D:\\Backups\\Nightly\\'])
    expect(await picked).toBe('D:\\Backups\\Nightly\\Sales.bak')
  })
  it('lists a typed share as a root of its own, and opens a typed folder rather than choosing it', async () => {
    const { service, settle, items } = setup()
    void service.pick({ connectionId: 'server-a', purpose: 'backup' })
    await settle()
    service.setFileName('\\\\files\\share\\')
    await service.ok()
    expect(items().slice(-2)).toEqual(['\\\\files\\share\\ (open)', '  Shared.bak'])
    expect(service.current).toMatchObject({ selected: '\\\\files\\share\\', fileName: '' })
    service.select('D:\\Backups\\')
    service.setFileName('Nightly')
    await service.ok()
    expect(service.current).toMatchObject({ selected: 'D:\\Backups\\Nightly\\', fileName: '' })
  })
  it('refuses a name the server says does not exist unless the file is still to be written, and reports a missing folder as a value', async () => {
    const { service, settle, api } = setup()
    const picked = service.pick({ connectionId: 'server-a', purpose: 'backup' })
    await settle()
    service.setFileName('nope.bak')
    await service.ok()
    expect(api.describeObject.mock.calls.at(-1)![0].files).toEqual({ purpose: 'backup', path: 'D:\\Backups\\nope.bak', exists: true })
    expect(service.current?.error).toMatchObject({ code: 'PATH_NOT_FOUND', message: 'D:\\Backups\\nope.bak does not exist, or SQL Server\'s service account cannot see it.' })
    expect(pickerMessages.notFound('D:\\Backups\\nope.bak')).toBe(service.current?.error?.message)
    service.setFileName('D:\\Missing\\x.bak')
    await service.ok()
    expect(service.current?.error).toMatchObject({ code: 'PATH_NOT_FOUND', message: 'The folder D:\\Missing\\ does not exist, or SQL Server\'s service account cannot see it.' })
    service.setFileName('C:\\a|b.bak')
    await service.ok()
    expect(service.current?.error?.message).toBe('A path cannot contain control characters or * ? " < > |.')
    service.cancel()
    expect(await picked).toBeUndefined()
    const later = service.pick({ connectionId: 'server-a', purpose: 'backup', mustExist: false })
    await settle()
    service.setFileName('Tonight.bak')
    await service.ok()
    expect(await later).toBe('D:\\Backups\\Tonight.bak')
  })
  it('opens an initial path with its file selected, Locate Folder lists folders only and chooses one, and Files of type lists again', async () => {
    const { service, settle, items, api } = setup()
    const first = service.pick({ connectionId: 'server-a', purpose: 'database', initialPath: 'd:\\sqldata\\MASTER.mdf' })
    await settle()
    expect(service.current).toMatchObject({ selected: 'D:\\SQLData\\master.mdf', fileName: 'master.mdf' })
    service.setAllFiles(true)
    await settle()
    expect(api.describeObject.mock.calls.at(-1)![0].files).toEqual({ purpose: 'database', path: 'D:\\SQLData\\', allFiles: true })
    expect(items()).toEqual(['C:\\', 'D:\\SQLData\\ (open)', '  master.mdf', '  mastlog.ldf', 'D:\\Backups\\'])
    service.cancel()
    expect(await first).toBeUndefined()
    const folder = service.pick({ connectionId: 'server-a', purpose: 'folder', initialPath: 'D:\\Backups' })
    await settle()
    expect(items()).toEqual(['C:\\', 'D:\\SQLData\\', 'D:\\Backups\\ (open)', '  Nightly'])
    service.select('D:\\Backups\\Nightly\\')
    await service.ok()
    expect(await folder).toBe('D:\\Backups\\Nightly\\')
  })
  it('says why a folder shows nothing: empty, or SQL Server 2016 listing only for sysadmin', async () => {
    const { service, settle } = setup({ legacy: true })
    void service.pick({ connectionId: 'server-a', purpose: 'backup' })
    await settle()
    const notes = (rows: PickerRow[]) => rows.flatMap(row => row.type === 'note' ? [row.text] : [])
    expect(notes(pickerRows(service.current!))).toEqual([pickerMessages.legacyEmpty])
    expect(pickerMessages.legacyEmpty).toBe('SQL Server 2016 lists folders only to members of sysadmin. Type the path instead.')
    const plain = setup()
    void plain.service.pick({ connectionId: 'server-a', purpose: 'backup', initialPath: 'D:\\Empty\\' })
    await plain.settle()
    expect(notes(pickerRows(plain.service.current!))).toEqual(['This folder is empty, or the server\'s account cannot list it.'])
  })
  it('marks a listing slow after 300 ms, cancels what runs on Cancel, and leaves only Cancel when the server disconnects', async () => {
    vi.useFakeTimers()
    const { service, api, connections, settle, hold } = setup()
    const held = hold('D:\\Backups\\')
    const picked = service.pick({ connectionId: 'server-a', purpose: 'backup' })
    await settle()
    const busy = () => pickerRows(service.current!).find(row => row.type === 'note' && row.tone === 'busy')
    expect(busy()).toMatchObject({ text: 'Listing…', slow: false })
    vi.advanceTimersByTime(slowListingMs)
    expect(busy()).toMatchObject({ slow: true })
    held.release()
    await settle()
    expect(busy()).toBeUndefined()
    hold('D:\\Backups\\Nightly\\')
    service.toggle('D:\\Backups\\Nightly\\')
    connections.remove('server-a')
    await settle()
    expect(service.current).toMatchObject({ disconnected: true, error: { code: 'CONNECTION_LOST', message: 'The server was disconnected.' } })
    expect(api.cancelObjectActions).toHaveBeenCalledWith(['id-3'])
    await service.ok()
    expect(await picked).toBeUndefined()
  })
  it('asks the server about a typed name the listing does not show: past its limit, or outside Files of type', async () => {
    const { service, settle, api, items } = setup({ limit: 2 })
    const truncated = service.pick({ connectionId: 'server-a', purpose: 'backup' })
    await settle()
    expect(items()).toEqual(['C:\\', 'D:\\SQLData\\', 'D:\\Backups\\ (open)', '  Nightly', '  AppData.bak', `  — ${pickerMessages.truncated}`])
    service.setFileName('appdata_log.TRN')
    await service.ok()
    expect(api.describeObject.mock.calls.at(-1)![0].files).toEqual({ purpose: 'backup', path: 'D:\\Backups\\appdata_log.TRN', exists: true })
    expect(await truncated).toBe('D:\\Backups\\appdata_log.TRN')
    const filtered = service.pick({ connectionId: 'server-a', purpose: 'database' })
    await settle()
    expect(service.current).toMatchObject({ selected: 'D:\\SQLData\\' })
    service.setFileName('mastlog.ldf')
    await service.ok()
    expect(await filtered).toBe('D:\\SQLData\\mastlog.ldf')
    // A folder the listing cut off is opened, not chosen.
    const cut = setup({ limit: 1 })
    const folder = cut.service.pick({ connectionId: 'server-a', purpose: 'backup', initialPath: 'D:\\' })
    await cut.settle()
    expect(cut.items()).toContain('  Backups')
    expect(cut.items()).not.toContain('  SQLData')
    cut.service.setFileName('SQLData')
    await cut.service.ok()
    expect(cut.service.current).toMatchObject({ selected: 'D:\\SQLData\\', fileName: '' })
    cut.service.cancel()
    expect(await folder).toBeUndefined()
  })
  it('accepts a typed name on SQL Server 2016 for a login outside sysadmin, whose listing is empty and which cannot be asked', async () => {
    const { service, settle, api } = setup({ legacy: true })
    const picked = service.pick({ connectionId: 'server-a', purpose: 'backup' })
    await settle()
    service.setFileName('D:\\Backups\\AppData.bak')
    await service.ok()
    expect(api.describeObject.mock.calls.some(([params]) => params.files?.exists)).toBe(false)
    expect(await picked).toBe('D:\\Backups\\AppData.bak')
    // A name typed in an initial path goes to File name, and OK takes it.
    const initial = service.pick({ connectionId: 'server-a', purpose: 'backup', initialPath: 'D:\\Backups\\Sales.bak' })
    await settle()
    expect(service.current).toMatchObject({ fileName: 'Sales.bak' })
    await service.ok()
    expect(await initial).toBe('D:\\Backups\\Sales.bak')
  })
  it('never chooses a path a later request would refuse: a listed name past 260 units stays in the picker with the reason', async () => {
    const deep = 'D:\\' + 'x'.repeat(246) + '\\'
    tree[deep.toLowerCase()] = [file('AppData_2026-10-30.bak')]
    cleanups.push(() => { delete tree[deep.toLowerCase()] })
    const { service, settle } = setup()
    const picked = service.pick({ connectionId: 'server-a', purpose: 'backup', initialPath: deep })
    await settle()
    service.select(deep + 'AppData_2026-10-30.bak')
    service.setFileName('')
    await service.ok()
    expect(service.current?.error).toMatchObject({ code: 'PATH_NOT_FOUND', message: 'A path is at most 260 characters.' })
    service.cancel()
    expect(await picked).toBeUndefined()
  })
  it('runs one listing at a time, and cancels a listing no longer wanted: a collapsed folder, the old Files of type, one still waiting', async () => {
    const { service, settle, api, hold, paths, items } = setup()
    void service.pick({ connectionId: 'server-a', purpose: 'backup' })
    await settle()
    const nightly = hold('D:\\Backups\\Nightly\\')
    service.toggle('D:\\Backups\\Nightly\\')
    service.toggle('C:\\')
    await settle()
    // C:\ waits its turn behind Nightly.
    expect(paths()).toEqual([null, 'D:\\Backups\\', 'D:\\Backups\\Nightly\\'])
    // Collapsed while it waits, C:\ is never sent; collapsed while it lists, Nightly is cancelled in SQL Server.
    service.toggle('C:\\')
    service.toggle('D:\\Backups\\Nightly\\')
    await settle()
    expect(api.cancelObjectActions.mock.calls).toEqual([[['id-3']]])
    expect(paths()).toEqual([null, 'D:\\Backups\\', 'D:\\Backups\\Nightly\\'])
    expect(service.current?.error).toBeUndefined()
    nightly.release()
    service.toggle('D:\\Backups\\Nightly\\')
    await settle()
    expect(items()).toContain('    Sales.bak')
    // Files of type cancels what still lists for the old filter, then lists again with the new one.
    hold('D:\\Backups\\Nightly\\')
    service.setAllFiles(true)
    await settle()
    const old = api.describeObject.mock.calls.find(([params]) => params.files?.path === 'D:\\Backups\\Nightly\\' && params.files.allFiles)![0]
    service.setAllFiles(false)
    await settle()
    expect(api.cancelObjectActions.mock.calls.at(-1)).toEqual([[old.requestId]])
    expect(items()).toContain('    Sales.bak')
  })
  it('labels default folders by their own name and the tree by purpose; a folder picker says when a folder has no subfolders', async () => {
    expect([rootLabel(roots[0], '\\'), rootLabel(roots[1], '\\'), rootLabel({ path: '/var/opt/mssql/data/', kind: 'folder', defaults: ['data'] }, '/'), rootLabel({ path: '\\\\files\\share\\', kind: 'folder' }, '\\')])
      .toEqual(['C:\\', 'SQLData', 'data', '\\\\files\\share\\'])
    expect([pickerTreeLabel('backup'), pickerTreeLabel('database'), pickerTreeLabel('folder')]).toEqual(['Select the file', 'Select the file', 'Select the folder'])
    const { service, settle } = setup()
    void service.pick({ connectionId: 'server-a', purpose: 'folder', initialPath: 'D:\\SQLData\\' })
    await settle()
    const rows = pickerRows(service.current!)
    expect(rows.flatMap(row => row.type === 'note' ? [row.text] : [])).toEqual(['This folder has no subfolders, or the server\'s account cannot list it.'])
    expect(rows.flatMap(row => row.type === 'item' ? [[row.name, row.label]] : [])).toEqual([['C:\\', 'C:\\'], ['D:\\SQLData\\', 'SQLData'], ['D:\\Backups\\', 'Backups']])
  })
  it('opens from the test hook on the first live connection and records each answer', async () => {
    const { service, connections, settle } = setup()
    const hook = serverFilesTestHook(service, connections)
    expect(hook.pick('backup')).toBe(true)
    expect(hook.pick('backup')).toBe(false)
    await settle()
    service.cancel()
    await settle()
    expect(hook.answers()).toEqual([null])
  })
})
