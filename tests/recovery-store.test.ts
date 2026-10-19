import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RecoveryStore, recoveryDiscardSchema, recoveryTakeSchema, recoveryWriteSchema } from '../src/main/recovery-store'
import { writeJsonAtomic } from '../src/main/json-file'
import { SqlFileStore } from '../src/main/sql-files'
import { lossDetails, recoveryCapMessage, recoveryLimits, type RecoveryWrite } from '../src/shared/files/recovery'

let directory: string, folder: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'recovery-test-'))
  folder = join(directory, 'AutoRecover')
})
afterEach(async () => {
  expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
  await rm(directory, { recursive: true, force: true })
})
const posix = process.platform !== 'win32'
const query = (patch: Partial<RecoveryWrite> = {}): RecoveryWrite => ({ id: randomUUID(), name: 'SQLQuery2.sql', kind: 'sql', eol: 'crlf', text: 'SELECT 1', ...patch })
const day = 86_400_000
const records = async () => (await readdir(folder).catch(() => [] as string[])).sort()

describe('the AutoRecover store', () => {
  it('keeps a query, lists it for a later page or run without its text, and hands its text to whoever takes it', async () => {
    const store = new RecoveryStore(folder, { now: () => new Date('2026-10-19T09:00:00Z') })
    const kept = query({ server: 'sql01', database: 'Sales', text: 'SELECT secret FROM dbo.T' })
    await store.write({ ...kept, path: 'C:\\Queries\\orders.sql' }, 1)
    expect(store.hasRecords(1)).toBe(true)
    expect(store.hasRecords(2)).toBe(false)
    // The page that wrote it is not offered its own copies.
    expect(await store.list(1)).toEqual([])
    const entry = { id: kept.id, name: 'SQLQuery2.sql', kind: 'sql', path: 'C:\\Queries\\orders.sql', savedAt: '2026-10-19T09:00:00.000Z', characters: 24, server: 'sql01', database: 'Sales' }
    // The next page (a crash's reload) and the next run are.
    expect(await store.list(2)).toEqual([entry])
    expect(JSON.stringify(await store.list(2))).not.toContain('secret')
    const next = new RecoveryStore(folder)
    expect(await next.list(1)).toEqual([entry])
    // The record names its owner and holds the text; it is the only file there.
    const stored = JSON.parse(await readFile(join(folder, kept.id + '.json'), 'utf8'))
    expect(stored).toMatchObject({ version: 1, id: kept.id, owner: { instance: store.instance, generation: 1 }, text: 'SELECT secret FROM dbo.T', eol: 'crlf' })
    expect(await records()).toEqual([kept.id + '.json'])
    // Taken, it is the taker's: no longer offered to it, and it may write and discard it.
    expect(await next.take(kept.id, 1)).toMatchObject({ text: 'SELECT secret FROM dbo.T', name: 'SQLQuery2.sql', kind: 'sql', eol: 'crlf', path: 'C:\\Queries\\orders.sql' })
    expect(await next.list(1)).toEqual([])
    expect(next.hasRecords(1)).toBe(true)
    await next.write({ ...kept, text: 'SELECT 2' }, 1)
    // A later generation of that run is offered it again (the reopened query's page crashed too).
    expect((await next.list(2)).map(item => item.characters)).toEqual([8])
    await next.discard([kept.id], 1)
    expect(await records()).toEqual([])
  })

  it('refuses writes to records another run or generation owns, and takes or discards only what it offered or owns', async () => {
    const first = new RecoveryStore(folder), kept = query()
    await first.write(kept, 1)
    // A later page cannot overwrite what an earlier one left before it is offered, nor can another run.
    await expect(first.write({ ...kept, text: 'DROP TABLE x' }, 2)).rejects.toThrow('This AutoRecover copy belongs to an earlier window.')
    const second = new RecoveryStore(folder)
    await expect(second.write({ ...kept, text: 'DROP TABLE x' }, 1)).rejects.toThrow('This AutoRecover copy belongs to an earlier window.')
    // Not listed to it yet: nothing to take or discard.
    await expect(second.take(kept.id, 1)).rejects.toThrow('This query is no longer offered for recovery.')
    await second.discard([kept.id], 1)
    expect(await records()).toEqual([kept.id + '.json'])
    await second.list(1)
    // Offered to generation 1: generation 2 still cannot take it.
    await expect(second.take(kept.id, 2)).rejects.toThrow('This query is no longer offered for recovery.')
    expect((await second.take(kept.id, 1)).text).toBe('SELECT 1')
    // Taking it moved it to generation 1 of this run, which deletes it as its window closes.
    await second.discardOwned(1)
    expect(await records()).toEqual([])
  })

  it('deletes the copies a closing page owns, and leaves those it was offered and did not take', async () => {
    const earlier = new RecoveryStore(folder), left = query()
    await earlier.write(left, 1)
    const store = new RecoveryStore(folder), mine = query(), other = query()
    await store.write(mine, 3)
    await store.write(other, 4)
    expect((await store.list(3)).map(entry => entry.id).sort()).toEqual([left.id, other.id].sort())
    await store.discardOwned(3)
    expect(await records()).toEqual([left.id, other.id].map(id => id + '.json').sort())
    expect(store.hasRecords(3)).toBe(false)
  })

  it('refuses a write past 64 records or 256 MB in all, counting the copy it replaces once', async () => {
    const store = new RecoveryStore(folder, { caps: { records: 3, totalBytes: 2000 } })
    const kept = [query(), query(), query()]
    for (const item of kept) await store.write(item, 1)
    await expect(store.write(query(), 1)).rejects.toThrow(recoveryCapMessage)
    await store.write({ ...kept[0], text: 'SELECT 2' }, 1)
    await expect(store.write({ ...kept[0], text: 'x'.repeat(2000) }, 1)).rejects.toThrow(recoveryCapMessage)
    expect(await records()).toHaveLength(3)
    expect(recoveryCapMessage).toBe('AutoRecover keeps at most 64 queries (256 MB).')
    expect([recoveryLimits.records, recoveryLimits.totalBytes, recoveryLimits.recordBytes]).toEqual([64, 268_435_456, 33_554_432])
    // The largest query, escaped as JSON could be, fits one record.
    expect(JSON.stringify({ text: '\u0001'.repeat(5_000_000) }).length).toBeLessThan(recoveryLimits.recordBytes)
  })

  it('quarantines an invalid record, never offers it, and purges it with the others', async () => {
    const store = new RecoveryStore(folder, { now: () => new Date(Date.now() + 8 * day) }), id = randomUUID()
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, id + '.json'), '{"version":1,"id":"' + id + '"}')
    // Another record's name in a file, and one in another's.
    const swapped = randomUUID(), good = query()
    await store.write(good, 1)
    await writeFile(join(folder, swapped + '.json'), await readFile(join(folder, good.id + '.json')))
    expect((await store.list(2)).map(entry => entry.id)).toEqual([good.id])
    const names = await records()
    expect(names.filter(name => name.includes('.invalid-')).length).toBe(2)
    expect(names).toContain(good.id + '.json')
    // A week later (the default) they are all purged but this run's own copy.
    await store.purge(Promise.resolve(7))
    expect(await records()).toEqual([good.id + '.json'])
  })

  it('purges by Keep AutoRecover information for, after settings load, and not at all when they cannot be read', async () => {
    let now = Date.now()
    const writer = new RecoveryStore(folder), old = query(), recent = query()
    await writer.write(old, 1)
    await writer.write(recent, 1)
    await utimes(join(folder, old.id + '.json'), new Date(now - 3 * day), new Date(now - 3 * day))
    // An interrupted write's temporary file holds query text and is never offered: it always goes.
    await writeFile(join(folder, `.varia-${randomUUID()}.tmp`), 'SELECT 1')
    const unrelated = join(folder, 'notes.txt')
    await writeFile(unrelated, 'kept')
    const store = new RecoveryStore(folder, { now: () => new Date(now) })
    await store.purge(Promise.reject(new Error('settings.json could not be read')))
    expect(await records()).toHaveLength(4)
    await store.purge(Promise.resolve(7))
    expect(await records()).toEqual([old.id + '.json', recent.id + '.json', 'notes.txt'].sort())
    await store.purge(Promise.resolve(2))
    expect(await records()).toEqual([recent.id + '.json', 'notes.txt'].sort())
    now += 10 * day
    // A purge waits for the setting, and list waits for the purge.
    let resolveDays!: (days: number) => void
    const purged = store.purge(new Promise<number>(done => { resolveDays = done }))
    const listed = store.list(1)
    resolveDays(9)
    await purged
    expect(await listed).toEqual([])
    expect(await records()).toEqual(['notes.txt'])
  })

  it.skipIf(!posix)('makes the folder 0700 and each record 0600', async () => {
    await mkdir(folder, { recursive: true, mode: 0o755 })
    const store = new RecoveryStore(folder), kept = query()
    await store.write(kept, 1)
    expect((await stat(folder)).mode & 0o777).toBe(0o700)
    expect((await stat(join(folder, kept.id + '.json'))).mode & 0o777).toBe(0o600)
  })

  it('validates what the page sends: ids, kinds, bounds and no path of its own', () => {
    const fileId = randomUUID(), valid = { ...query(), fileId, server: 's', database: 'd' }
    expect(recoveryWriteSchema.safeParse(valid).success).toBe(true)
    for (const patch of [{ id: 'x' }, { fileId: 'x' }, { kind: 'txt' }, { eol: 'cr' }, { name: '' }, { name: 'x'.repeat(513) }, { server: 'x'.repeat(257) }, { database: 'x'.repeat(129) },
      { path: 'C:\\x.sql' }, { owner: { instance: randomUUID(), generation: 0 } }, { text: 'x'.repeat(5_000_001) }, { kind: 'xml', text: 'x'.repeat(4_194_305) }]) {
      expect(recoveryWriteSchema.safeParse({ ...valid, ...patch }).success, JSON.stringify(Object.keys(patch))).toBe(false)
    }
    expect(recoveryWriteSchema.safeParse({ ...valid, kind: 'xml', text: 'x'.repeat(4_194_304) }).success).toBe(true)
    expect(recoveryDiscardSchema.safeParse({ ids: [fileId] }).success).toBe(true)
    for (const value of [{ ids: [] }, { ids: ['x'] }, { ids: Array.from({ length: 257 }, () => fileId) }, { ids: [fileId], extra: 1 }, [fileId]]) expect(recoveryDiscardSchema.safeParse(value).success).toBe(false)
    expect(recoveryTakeSchema.safeParse({ id: fileId }).success).toBe(true)
    for (const value of [{ id: 'x' }, fileId, { id: fileId, path: 'C:\\x.sql' }]) expect(recoveryTakeSchema.safeParse(value).success).toBe(false)
  })

  it('words the crash, hang and reload prompts for AutoRecover only once it kept the page\'s queries', () => {
    const lost = lossDetails({ enabled: true, minutes: 5, saved: false })
    expect(lossDetails({ enabled: false, minutes: 5, saved: true })).toEqual(lost)
    expect(lost).toEqual({
      stopped: 'Unsaved queries were lost. Connections were closed and uncommitted transactions were rolled back.',
      unresponsive: 'The workbench is not responding. Unsaved queries will be lost.',
      reload: 'Unsaved queries will be lost. Connections are closed and uncommitted transactions are rolled back.'
    })
    expect(lossDetails({ enabled: true, minutes: 5, saved: true })).toEqual({
      stopped: 'Queries saved by AutoRecover can be recovered after reloading; changes from the last 5 minutes may be lost. Connections were closed and uncommitted transactions were rolled back.',
      unresponsive: 'The workbench is not responding. Changes since the last AutoRecover save will be lost; the rest is offered when Varia SQL Manager starts again.',
      reload: 'Changes since the last AutoRecover save will be lost. Connections are closed and uncommitted transactions are rolled back.'
    })
    expect(lossDetails({ enabled: true, minutes: 1, saved: true }).stopped).toContain('changes from the last minute may be lost')
  })
})

describe('atomic writes with a mode', () => {
  it.skipIf(!posix)('creates the file with the mode before any content reaches it', async () => {
    const path = join(directory, 'private.json')
    await writeJsonAtomic(path, { secret: 1 }, 1024, 'Too large.', { mode: 0o600 })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    // Without one, the umask decides, as before.
    await writeJsonAtomic(path, { secret: 2 }, 1024, 'Too large.')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ secret: 2 })
  })
})

describe('registering a recovered query\'s file', () => {
  it('registers the file again without a tab, and refuses one a tab already has or that is gone', async () => {
    const files = new SqlFileStore(), path = join(directory, 'orders.sql')
    await writeFile(path, Buffer.from('\ufeffSELECT 1', 'utf8'))
    const registered = await files.register(path)
    expect(registered).toMatchObject({ name: 'orders.sql', path, encoding: 'utf8bom', readOnly: false })
    expect(registered).not.toHaveProperty('content')
    expect(files.get(registered!.id).path).toBe(path)
    // One file, one registration (and one tab): a second recovered copy of it opens without a file.
    expect(await files.register(path)).toBeUndefined()
    expect(await files.register(join(directory, 'missing.sql'))).toBeUndefined()
  })
})
