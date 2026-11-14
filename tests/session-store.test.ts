import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { encodeReloadSession, SessionStore, sessionCapMessage, sessionWriteSchema, type SessionInput } from '../src/main/session-store'
import * as jsonFile from '../src/main/json-file'
import { maxSqlFileBytes } from '../src/main/sql-files'
import { saveDefaultPath } from '../src/main/file-names'
import { cleanTabName, sessionLimits, tabNameChars } from '../src/shared/files/session'
import { connectionDefaults } from '../src/shared/connections'
import { connectionWorkspaceSchema } from '../src/shared/connection-targets'

let directory: string, folder: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'session-test-'))
  folder = join(directory, 'Session')
})
afterEach(async () => {
  vi.restoreAllMocks()
  expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
  await rm(directory, { recursive: true, force: true })
})
const posix = process.platform !== 'win32'
const files = async () => (await readdir(folder).catch(() => [] as string[])).sort()
const tabs: SessionInput = {
  activeIndex: 1,
  documents: [
    { name: 'SQLQuery2.sql', kind: 'sql', eol: 'crlf', dirty: true, pinned: true, text: 'SELECT 2', server: 'sql01', database: 'Sales' },
    { name: 'Month end', baseName: 'SQLQuery3.sql', kind: 'sql', eol: 'lf', dirty: false, text: 'SELECT 3' },
    { name: 'orders.sql', kind: 'sql', eol: 'crlf', dirty: false, path: 'C:\\Queries\\orders.sql' },
    { name: 'value.xml', kind: 'xml', eol: 'lf', dirty: false, text: '<a/>' }
  ]
}

describe('the hot exit session store', () => {
  it('remaps reload recovery copies when main cannot reopen a preceding unpinned file', () => {
    const checkpoint = encodeReloadSession({ activeIndex: 1, documents: [
      { name: 'gone.sql', kind: 'sql', eol: 'lf', dirty: false },
      { name: 'kept.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'SELECT fresh' }
    ] }, ['gone-copy', 'kept-copy'])
    expect(checkpoint.record.documents.map(document => document.name)).toEqual(['kept.sql'])
    expect(checkpoint.record.activeIndex).toBe(0)
    expect(checkpoint.recoveryIds).toEqual(['kept-copy'])
  })

  it.each(['session.json', 'previous.json'])('preserves %s after a temporary read failure instead of replacing or clearing it', async file => {
    const store = new SessionStore(folder)
    await store.write(tabs, 1)
    if (file === 'previous.json') await store.take(true)
    const path = join(folder, file), before = await readFile(path, 'utf8'), originalRead = jsonFile.readJsonFile
    const read = vi.spyOn(jsonFile, 'readJsonFile').mockImplementation((requested, limit) => requested === path
      ? Promise.reject(new Error('Temporary access failure.')) : originalRead(requested, limit))
    await expect(store.take(true)).rejects.toThrow('Temporary access failure.')
    await expect(store.write({ activeIndex: 0, documents: [tabs.documents[1]] }, 2)).rejects.toThrow('Temporary access failure.')
    await expect(store.clear()).rejects.toThrow('Temporary access failure.')
    expect(await readFile(path, 'utf8')).toBe(before)
    read.mockRestore()
    expect((await store.take(true))?.documents).toEqual(tabs.documents)
  })

  it('preserves invalid bytes when quarantine is temporarily unavailable and retries safely', async () => {
    await mkdir(folder, { recursive: true })
    const path = join(folder, 'session.json'), before = '{ invalid but unrecovered'
    await writeFile(path, before)
    const store = new SessionStore(folder), quarantine = vi.spyOn(jsonFile, 'quarantine').mockRejectedValue(new Error('Temporary rename failure.'))
    await expect(store.take(true)).rejects.toThrow('Temporary rename failure.')
    await expect(store.write(tabs, 1)).rejects.toThrow('Temporary rename failure.')
    await expect(store.clear()).rejects.toThrow('Temporary rename failure.')
    expect(await readFile(path, 'utf8')).toBe(before)
    quarantine.mockRestore()
    await store.write(tabs, 2)
    const preserved = (await files()).find(name => name.startsWith('session.json.invalid-'))!
    expect(await readFile(join(folder, preserved), 'utf8')).toBe(before)
    expect((await store.take(true))?.documents).toEqual(tabs.documents)
  })

  it('does not replace an unrecovered previous checkpoint while taking a newer valid session', async () => {
    const store = new SessionStore(folder)
    await store.write(tabs, 1)
    const current = await readFile(join(folder, 'session.json'), 'utf8')
    const previous = '{ unrecovered previous checkpoint'
    await writeFile(join(folder, 'previous.json'), previous)
    const quarantine = vi.spyOn(jsonFile, 'quarantine').mockRejectedValue(new Error('Temporary rename failure.'))
    await expect(store.take(true)).rejects.toThrow('Temporary rename failure.')
    expect(await readFile(join(folder, 'session.json'), 'utf8')).toBe(current)
    expect(await readFile(join(folder, 'previous.json'), 'utf8')).toBe(previous)
    quarantine.mockRestore()
    expect((await store.take(true))?.documents).toEqual(tabs.documents)
  })

  const workspace = () => connectionWorkspaceSchema.parse({ version: 1, targets: [
    { id: randomUUID(), options: { ...connectionDefaults('win32'), server: 'sql01' }, details: { displayName: 'Production', environment: 'Production', autoReconnect: 'off' }, inExplorer: true, resumeWanted: false },
    { id: randomUUID(), options: { ...connectionDefaults('win32'), server: 'sql01' }, details: {}, inExplorer: false, resumeWanted: true }
  ] })

  it('round-trips distinct unresolved targets, per-query databases and deliberate query disconnects across repeated starts', async () => {
    const targets = workspace(), [first, second] = targets.targets
    const session: SessionInput = { activeIndex: 0, workspace: targets, documents: [
      { ...tabs.documents[0], targetId: first.id, database: 'Sales', attachWanted: true },
      { ...tabs.documents[1], targetId: first.id, database: 'Reports', attachWanted: false },
      { ...tabs.documents[0], targetId: second.id, database: '', attachWanted: true }
    ] }
    await new SessionStore(folder).write(session, 1)
    for (let start = 0; start < 3; start++) {
      const store = new SessionStore(folder), restored = await store.take(true)
      expect(restored).toMatchObject({ version: 2, ...session })
      expect(restored?.workspace?.targets.map(target => target.id)).toEqual([first.id, second.id])
      expect(JSON.stringify(restored)).not.toMatch(/connectionId|sessionId|lifecycle|password|accessToken/)
      await store.write(restored!, start + 2)
    }
  })

  it('keeps a target workspace when no query tabs are open', async () => {
    const targets = workspace()
    await new SessionStore(folder).write({ activeIndex: -1, documents: [], workspace: targets }, 1)
    expect(await new SessionStore(folder).take(true)).toMatchObject({ documents: [], workspace: targets })
  })

  it('migrates version 1 as display hints without guessing a target or attachment intent', async () => {
    await mkdir(folder, { recursive: true })
    const legacy = { version: 1, savedAt: '2026-11-04T09:00:00.000Z', activeIndex: 0, documents: [tabs.documents[0]] }
    await writeFile(join(folder, 'session.json'), JSON.stringify(legacy))
    const restored = await new SessionStore(folder).take(true)
    expect(restored).toEqual({ ...legacy, version: 2 })
    expect(restored?.documents[0]).not.toHaveProperty('targetId')
    expect(restored?.documents[0]).not.toHaveProperty('attachWanted')
    expect(restored).not.toHaveProperty('workspace')
  })

  it('rejects dangling associations, partial attachment fields, value-document targets and secret workspace fields', async () => {
    const targets = workspace(), document = { ...tabs.documents[0], targetId: targets.targets[0].id, attachWanted: true }
    const session = { activeIndex: 0, workspace: targets, documents: [document] }
    expect(sessionWriteSchema.safeParse(session).success).toBe(true)
    for (const invalid of [
      { ...session, workspace: undefined },
      { ...session, documents: [{ ...document, targetId: randomUUID() }] },
      { ...session, documents: [{ ...document, attachWanted: undefined }] },
      { ...session, documents: [{ ...document, targetId: undefined }] },
      { ...session, documents: [{ ...document, database: undefined }] },
      { ...session, documents: [{ ...document, kind: 'xml' }] },
      { ...session, workspace: { ...targets, targets: [{ ...targets.targets[0], options: { ...targets.targets[0].options, password: 'secret' } }] } },
      { ...session, workspace: { ...targets, targets: [{ ...targets.targets[0], lifecycle: { state: 'connected', handle: { id: randomUUID(), generation: 1 } } }] } }
    ]) expect(sessionWriteSchema.safeParse(invalid).success).toBe(false)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'session.json'), JSON.stringify({ ...session, version: 2, savedAt: '2026-11-04T09:00:00.000Z', documents: [{ ...document, targetId: randomUUID() }] }))
    expect(await new SessionStore(folder).take(true)).toBeUndefined()
    expect((await files()).some(name => name.startsWith('session.json.invalid-'))).toBe(true)
  })

  it('keeps a single group’s requested shelf heights through the disk session checkpoint', async () => {
    const groups = {
      root: { type: 'branch' as const, children: [{ type: 'leaf' as const, views: [0], active: 0, tabRows: { pinned: 3, unpinned: 80 } }] },
      orientation: 'HORIZONTAL' as const, width: 800, height: 600, activeGroup: 0
    }
    const store = new SessionStore(folder)
    await store.write(sessionWriteSchema.parse({ activeIndex: 0, documents: [tabs.documents[0]], groups }), 1)
    const stored = JSON.parse(await readFile(join(folder, 'session.json'), 'utf8'))
    expect(stored.groups.root.children[0].tabRows).toEqual({ pinned: 3, unpinned: 80 })
    expect((await new SessionStore(folder).take(true))?.groups).toEqual(groups)
  })

  it('round-trips a plan larger than the SQL file limit without widening the limit for queries', async () => {
    const plan = { name: 'big.sqlplan', kind: 'sqlplan', eol: 'lf', dirty: true, pinned: true, text: 'x'.repeat(maxSqlFileBytes + 1) } as const
    const session = { activeIndex: 0, documents: [plan] }
    expect(sessionWriteSchema.safeParse({ ...session, documents: [{ ...plan, kind: 'sql' }] }).success).toBe(false)
    const store = new SessionStore(folder)
    await store.write(sessionWriteSchema.parse(session), 1)
    expect((await new SessionStore(folder).take(true))?.documents[0]).toEqual(plan)
  })

  it('keeps the tabs in order for the next start, which takes them once and keeps a copy until its own close', async () => {
    const store = new SessionStore(folder, { now: () => new Date('2026-11-04T09:00:00Z') })
    await store.write(tabs, 3)
    expect(store.keptBy(3)).toBe(true)
    expect(store.keptBy(4)).toBe(false)
    expect(await files()).toEqual(['session.json'])
    const stored = JSON.parse(await readFile(join(folder, 'session.json'), 'utf8'))
    expect(stored).toEqual({ version: 2, savedAt: '2026-11-04T09:00:00.000Z', activeIndex: 1, documents: tabs.documents })
    if (posix) {
      expect((await stat(folder)).mode & 0o777).toBe(0o700)
      expect((await stat(join(folder, 'session.json'))).mode & 0o777).toBe(0o600)
    }
    // The next run's first page takes it; it stays on disk as previous.json until that run closes.
    const next = new SessionStore(folder)
    expect(await next.take(true)).toMatchObject({ activeIndex: 1, documents: tabs.documents })
    expect(await files()).toEqual(['previous.json'])
    // A reload of that run's page does not reopen it again.
    expect(await next.take(false)).toBeUndefined()
    // A run that crashed after restoring it: the next process's first page reopens it again, and text is never lost.
    const afterCrash = new SessionStore(folder)
    expect((await afterCrash.take(true))?.documents.map(document => document.name)).toEqual(['SQLQuery2.sql', 'Month end', 'orders.sql', 'value.xml'])
    // Its close keeps a new session in place of both.
    await afterCrash.write({ activeIndex: 0, documents: [tabs.documents[0]] }, 1)
    expect(await files()).toEqual(['session.json'])
    // A close with hot exit off clears everything.
    await afterCrash.clear()
    expect(await files()).toEqual([])
    expect(afterCrash.keptBy(1)).toBe(false)
    expect(await new SessionStore(folder).take(true)).toBeUndefined()
  })

  // sandbox-guard.ts's profilePathsRefused: a packaged smoke run's profile belongs to whoever started it.
  it('hands out no file path or baseline while paths are refused, from session.json or previous.json', async () => {
    const baseline = 'a'.repeat(64)
    const kept = { ...tabs, documents: [...tabs.documents, { name: 'edited.sql', kind: 'sql', eol: 'lf', dirty: true, path: 'C:\\Queries\\edited.sql', fileSha256: baseline, text: 'SELECT 5' } as const] }
    await new SessionStore(folder).write(kept, 1)
    const refusing = new SessionStore(folder, { pathsRefused: true })
    const taken = await refusing.take(true)
    // Every tab is still there, in order, with the text it kept: only the files are gone.
    expect(taken).toMatchObject({ activeIndex: 1, documents: kept.documents.map(({ name }) => ({ name })) })
    expect(taken?.documents.map(document => [document.path, document.fileSha256, document.text])).toEqual([[undefined, undefined, 'SELECT 2'], [undefined, undefined, 'SELECT 3'], [undefined, undefined, undefined], [undefined, undefined, '<a/>'], [undefined, undefined, 'SELECT 5']])
    expect(JSON.stringify(taken)).not.toContain('Queries')
    // The copy a crashed run leaves is the same file under another name.
    expect(JSON.stringify(await new SessionStore(folder, { pathsRefused: true }).take(true))).not.toContain('Queries')
    // The file itself is as it was written: a normal run still reopens the files.
    expect((await new SessionStore(folder).take(true))?.documents.map(document => document.path)).toEqual([undefined, undefined, 'C:\\Queries\\orders.sql', undefined, 'C:\\Queries\\edited.sql'])
  })

  it('drops a clean tab whose file main no longer knows, and moves the active index with the tabs that stay', async () => {
    const store = new SessionStore(folder)
    await store.write({ activeIndex: 2, documents: [{ name: 'gone.sql', kind: 'sql', eol: 'lf', dirty: false }, tabs.documents[0], tabs.documents[1]] }, 1)
    expect(await store.take(true)).toMatchObject({ activeIndex: 1, documents: [{ name: 'SQLQuery2.sql' }, { name: 'Month end' }] })
    await store.write({ activeIndex: 0, documents: [{ name: 'gone.sql', kind: 'sql', eol: 'lf', dirty: false }, tabs.documents[0]] }, 1)
    expect((await store.take(true))?.activeIndex).toBe(-1)
  })
  it('refuses to replace the session if a clean pin cannot reopen from its file', async () => {
    const store = new SessionStore(folder)
    await store.write(tabs, 1)
    const before = await readFile(join(folder, 'session.json'), 'utf8')
    const pinnedFile = { name: 'gone.sql', kind: 'sql', eol: 'lf', dirty: false, pinned: true } as const
    await expect(store.write({ activeIndex: 0, documents: [pinnedFile] }, 2)).rejects.toThrow('Pinned tab “gone.sql”')
    await expect(store.write({ activeIndex: 0, documents: [{ ...pinnedFile, path: 'x'.repeat(sessionLimits.pathChars + 1) }] }, 2)).rejects.toThrow('Pinned tab “gone.sql”')
    expect(await readFile(join(folder, 'session.json'), 'utf8')).toBe(before)
  })

  it('keeps the editor groups with their documents, following them to their places and dropping a group left empty', async () => {
    const store = new SessionStore(folder)
    const gone = { name: 'gone.sql', kind: 'sql' as const, eol: 'lf' as const, dirty: false }
    const groups = { root: { type: 'branch' as const, children: [{ type: 'leaf' as const, views: [0] }, { type: 'leaf' as const, views: [2, 1], active: 1 }, { type: 'leaf' as const, views: [3] }] }, orientation: 'HORIZONTAL' as const, width: 800, height: 600, activeGroup: 1 }
    await store.write({ activeIndex: 1, documents: [gone, tabs.documents[0], tabs.documents[1], tabs.documents[3]], groups }, 1)
    expect(await store.take(true)).toMatchObject({ activeIndex: 0, groups: { root: { type: 'branch', children: [{ type: 'leaf', views: [1, 0], active: 0 }, { type: 'leaf', views: [2] }] }, activeGroup: 0 } })
    // Groups that name a tab the session does not hold are refused.
    expect(sessionWriteSchema.safeParse({ activeIndex: 0, documents: [tabs.documents[0]], groups: { ...groups, root: { type: 'branch', children: [{ type: 'leaf', views: [0] }, { type: 'leaf', views: [1] }] } } }).success).toBe(false)
  })

  it('refuses a session past its byte cap, writing nothing', async () => {
    const store = new SessionStore(folder, { totalBytes: 1024 })
    await expect(store.write({ activeIndex: 0, documents: [{ name: 'big.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'x'.repeat(2048) }] }, 1)).rejects.toThrow(sessionCapMessage)
    expect(await files()).toEqual([])
    expect(store.keptBy(1)).toBe(false)
  })

  it('keeps a file baseline only with a path and buffered text', async () => {
    const store = new SessionStore(folder), fileSha256 = '0'.repeat(64)
    const dirty = { ...tabs.documents[0], path: tabs.documents[2].path, fileSha256 }
    const clean = { ...tabs.documents[2], fileSha256 }
    await store.write({ activeIndex: 0, documents: [dirty, clean, tabs.documents[0]] }, 1)
    expect((await store.take(true))?.documents).toEqual([dirty, tabs.documents[2], tabs.documents[0]])
  })

  it('quarantines an unreadable or invalid session rather than reopen it', async () => {
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'session.json'), '{ not json')
    expect(await new SessionStore(folder).take(true)).toBeUndefined()
    expect((await files()).every(name => /^session\.json\.invalid-[0-9a-f-]{36}\.json$/.test(name))).toBe(true)
    // A tab without text must have a clean file to reopen from.
    await writeFile(join(folder, 'session.json'), JSON.stringify({ version: 1, savedAt: '2026-11-04T09:00:00.000Z', activeIndex: 0, documents: [{ name: 'a.sql', kind: 'sql', eol: 'lf', dirty: true }] }))
    expect(await new SessionStore(folder).take(true)).toBeUndefined()
    expect((await files()).filter(name => name === 'session.json')).toEqual([])
  })

  it('purges quarantined sessions by Keep AutoRecover information for and interrupted writes always, keeping both sessions', async () => {
    const day = 86_400_000, now = Date.now()
    await mkdir(folder, { recursive: true })
    const old = `session.json.invalid-${randomUUID()}.json`, oldPrevious = `previous.json.invalid-${randomUUID()}.json`, recent = `session.json.invalid-${randomUUID()}.json`
    const interrupted = `.varia-${randomUUID()}.tmp`
    for (const name of [old, oldPrevious, recent, interrupted, 'session.json', 'previous.json', 'notes.txt']) await writeFile(join(folder, name), 'SELECT 1')
    for (const name of [old, oldPrevious, 'session.json', 'previous.json', 'notes.txt']) await utimes(join(folder, name), new Date(now - 30 * day), new Date(now - 30 * day))
    await utimes(join(folder, recent), new Date(now - 3 * day), new Date(now - 3 * day))
    const store = new SessionStore(folder, { now: () => new Date(now) })
    await store.purge(Promise.reject(new Error('settings.json could not be read')))
    expect(await files()).toHaveLength(7)
    await store.purge(Promise.resolve(7))
    expect(await files()).toEqual(['notes.txt', 'previous.json', recent, 'session.json'].sort())
    await store.purge(Promise.resolve(2))
    expect(await files()).toEqual(['notes.txt', 'previous.json', 'session.json'])
    // A missing folder is nothing to purge.
    await rm(folder, { recursive: true })
    await store.purge(Promise.resolve(1))
  })

  it('purges the folder at startup, by the same retention as AutoRecover', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')
    expect(main).toContain('void openSession.purge(retentionDays(settings))')
  })

  it('validates what the page sends: bounded names, kinds, ids and counts, and text unless a clean file reopens it', () => {
    const fileId = randomUUID(), valid = { activeIndex: 0, documents: [{ name: 'a.sql', kind: 'sql', eol: 'lf', dirty: false, fileId }] }
    expect(sessionWriteSchema.parse(valid)).toEqual(valid)
    const refused = (patch: object, document: object = {}) => sessionWriteSchema.safeParse({ ...valid, ...patch, documents: [{ ...valid.documents[0], ...document }] }).success
    expect(refused({}, { dirty: true })).toBe(false)
    expect(refused({}, { pinned: 'true' })).toBe(false)
    expect(refused({}, { fileId: undefined })).toBe(false)
    expect(refused({}, { name: '' })).toBe(false)
    expect(refused({}, { name: 'x'.repeat(sessionLimits.nameChars + 1) })).toBe(false)
    expect(refused({}, { baseName: 'x'.repeat(sessionLimits.nameChars + 1) })).toBe(false)
    expect(refused({}, { kind: 'tableDesigner' })).toBe(false)
    expect(refused({}, { fileId: 'C:/a.sql' })).toBe(false)
    expect(refused({}, { path: 'C:/a.sql' })).toBe(false)
    expect(refused({}, { fileSha256: '0'.repeat(64) })).toBe(false)
    expect(refused({}, { password: 'x' })).toBe(false)
    expect(refused({}, { server: 'x'.repeat(sessionLimits.serverChars + 1) })).toBe(false)
    expect(refused({}, { text: 'x'.repeat(4_194_305), kind: 'xml' })).toBe(false)
    expect(refused({ activeIndex: sessionLimits.documents })).toBe(false)
    expect(sessionWriteSchema.safeParse({ activeIndex: 0, documents: Array.from({ length: sessionLimits.documents + 1 }, () => valid.documents[0]) }).success).toBe(false)
    expect(sessionWriteSchema.safeParse({ ...valid, extra: true }).success).toBe(false)
  })
})

describe('tab names', () => {
  it('trims a rename, drops control characters and keeps at most 128 characters', () => {
    expect(cleanTabName('  Month end\r\n')).toBe('Month end')
    expect(cleanTabName('a\tb\u0000c')).toBe('a b c')
    expect(cleanTabName('x'.repeat(200))).toHaveLength(tabNameChars)
    expect(cleanTabName(' \n ')).toBe('')
  })
  it('suggests a renamed tab\'s name in Save As, beside its file, with the kind\'s extension', () => {
    const documents = join('home', 'Documents'), folder = join('q')
    expect(saveDefaultPath(undefined, 'SQLQuery2.sql', documents, 'sql')).toBe(join(documents, 'SQLQuery2.sql'))
    expect(saveDefaultPath(undefined, 'Month end', documents, 'sql')).toBe(join(documents, 'Month end.sql'))
    expect(saveDefaultPath(undefined, 'a/b: c', documents, 'sql')).toBe(join(documents, 'a_b_ c.sql'))
    expect(saveDefaultPath(join(folder, 'orders.sql'), 'orders.sql', documents, 'sql')).toBe(join(folder, 'orders.sql'))
    expect(saveDefaultPath(join(folder, 'orders.sql'), 'Orders by month', documents, 'sql')).toBe(join(folder, 'Orders by month.sql'))
    expect(saveDefaultPath(undefined, 'plan', documents, 'sqlplan')).toBe(join(documents, 'plan.sqlplan'))
  })
})
