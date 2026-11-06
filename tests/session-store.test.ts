import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionStore, sessionCapMessage, sessionWriteSchema, type SessionInput } from '../src/main/session-store'
import { saveDefaultPath } from '../src/main/file-names'
import { cleanTabName, sessionLimits, tabNameChars } from '../src/shared/files/session'

let directory: string, folder: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'session-test-'))
  folder = join(directory, 'Session')
})
afterEach(async () => {
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
  it('keeps the tabs in order for the next start, which takes them once and keeps a copy until its own close', async () => {
    const store = new SessionStore(folder, { now: () => new Date('2026-11-04T09:00:00Z') })
    await store.write(tabs, 3)
    expect(store.keptBy(3)).toBe(true)
    expect(store.keptBy(4)).toBe(false)
    expect(await files()).toEqual(['session.json'])
    const stored = JSON.parse(await readFile(join(folder, 'session.json'), 'utf8'))
    expect(stored).toEqual({ version: 1, savedAt: '2026-11-04T09:00:00.000Z', activeIndex: 1, documents: tabs.documents })
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

  it('drops a clean tab whose file main no longer knows, and moves the active index with the tabs that stay', async () => {
    const store = new SessionStore(folder)
    await store.write({ activeIndex: 2, documents: [{ name: 'gone.sql', kind: 'sql', eol: 'lf', dirty: false }, tabs.documents[0], tabs.documents[1]] }, 1)
    expect(await store.take(true)).toMatchObject({ activeIndex: 1, documents: [{ name: 'SQLQuery2.sql' }, { name: 'Month end' }] })
    await store.write({ activeIndex: 0, documents: [{ name: 'gone.sql', kind: 'sql', eol: 'lf', dirty: false }, tabs.documents[0]] }, 1)
    expect((await store.take(true))?.activeIndex).toBe(-1)
  })

  it('refuses a session past its byte cap, writing nothing', async () => {
    const store = new SessionStore(folder, { totalBytes: 1024 })
    await expect(store.write({ activeIndex: 0, documents: [{ name: 'big.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'x'.repeat(2048) }] }, 1)).rejects.toThrow(sessionCapMessage)
    expect(await files()).toEqual([])
    expect(store.keptBy(1)).toBe(false)
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
