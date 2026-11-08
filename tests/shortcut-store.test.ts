import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { resetNotice, salvageNotice, shortcutHandlers, shortcutSentences, ShortcutStore, type ShortcutDialogs } from '../src/main/shortcut-store'
import { emptyShortcutFile, shortcutLimits, type ShortcutFile } from '../src/shared/commands/shortcut-schema'
import type { ShortcutsSnapshot } from '../src/shared/contracts'
import { BackendError } from '../src/main/backend/errors'
import { heavyTimeout, meterWork } from './fixtures/work-meter'

// Writes fail, with the system's kind of message (it names the path), while `failWrites` is set.
let failWrites = false
vi.mock('../src/main/json-file', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/json-file')>()
  return { ...actual, writeJsonAtomic: (...args: Parameters<typeof actual.writeJsonAtomic>) => failWrites ? Promise.reject(new Error(`EACCES: permission denied, open '${args[0]}'`)) : actual.writeJsonAtomic(...args) }
})

let directory: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'shortcuts-test-'))
})
afterEach(async () => {
  failWrites = false
  expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
  await rm(directory, { recursive: true, force: true })
})

const path = () => join(directory, 'shortcuts.json')
const store = () => new ShortcutStore(path())
const onDisk = async () => JSON.parse(await readFile(path(), 'utf8')) as ShortcutFile
const quarantined = async () => (await readdir(directory)).filter(entry => entry.startsWith('shortcuts.json.invalid-'))
const withBindings = (bindings: ShortcutFile['bindings'], extra: Partial<ShortcutFile> = {}): ShortcutFile => ({ ...emptyShortcutFile, bindings, ...extra })
const remap: ShortcutFile = withBindings([{ command: 'query.execute', key: 'ctrl+e', scope: 'global' }, { command: 'query.execute', key: 'f5', remove: true }])
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a failure') }, (error: unknown) => error)

describe('shortcuts file', () => {
  it('reads a missing file as empty at revision 1 without writing one', async () => {
    expect(await store().load()).toEqual({ file: emptyShortcutFile, revision: 1, salvaged: false })
    expect(await readdir(directory)).toEqual([])
  })

  it('saves a file, moves the revision on, and announces the change', async () => {
    const shortcuts = store(), events: ShortcutsSnapshot[] = []
    shortcuts.onDidChange(snapshot => events.push(snapshot))
    const { revision } = await shortcuts.load()
    expect(await shortcuts.save(remap, revision)).toEqual({ revision: 2 })
    expect(await onDisk()).toEqual(remap)
    expect(events).toEqual([{ file: remap, revision: 2 }])
    expect(shortcuts.current()).toEqual(remap)
    // Saving the same content again writes nothing and announces nothing.
    expect(await shortcuts.save(remap, 2)).toEqual({ revision: 2 })
    expect(events).toHaveLength(1)
  })

  it('refuses a save based on a stale revision with STALE', async () => {
    const shortcuts = store()
    await shortcuts.load()
    await shortcuts.save(remap, 1)
    const error = await failure(shortcuts.save(emptyShortcutFile, 1))
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: 'STALE', message: shortcutSentences.stale })
    expect(await onDisk()).toEqual(remap)
  })

  it('reads the file again before every write, so a hand edit is a new revision and an older save is refused', async () => {
    const shortcuts = store(), events: ShortcutsSnapshot[] = []
    shortcuts.onDidChange(snapshot => events.push(snapshot))
    await shortcuts.load()
    await shortcuts.save(remap, 1)
    const edited = withBindings([{ command: 'query.execute', key: 'ctrl+shift+e' }])
    await writeFile(path(), JSON.stringify(edited))
    expect(await failure(shortcuts.save(emptyShortcutFile, 2))).toMatchObject({ code: 'STALE' })
    // The hand edit survives, is announced, and a save based on it goes through.
    expect(await onDisk()).toEqual(edited)
    expect(events.at(-1)).toEqual({ file: edited, revision: 3 })
    expect(await shortcuts.save(emptyShortcutFile, 3)).toEqual({ revision: 4 })
    expect(await onDisk()).toEqual(emptyShortcutFile)
  })

  it('sees a hand edit on the next load', async () => {
    const shortcuts = store()
    await shortcuts.load()
    await writeFile(path(), JSON.stringify(remap))
    expect(await shortcuts.load()).toMatchObject({ file: remap, revision: 2 })
  })

  it('quarantines an unreadable file, replaces it with an empty one, and says so in fixed words', async () => {
    const cases: [Buffer, Parameters<typeof resetNotice>[0]][] = [
      [Buffer.from('{ not json'), 'json'], [Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), 'encoding'], [Buffer.from(JSON.stringify([1, 2])), 'values'], [Buffer.alloc(shortcutLimits.fileBytes + 1, 0x20), 'size']
    ]
    for (const [content, reason] of cases) {
      await rm(path(), { force: true })
      for (const name of await quarantined()) await rm(join(directory, name))
      await writeFile(path(), content)
      expect(await store().load()).toEqual({ file: emptyShortcutFile, revision: 1, salvaged: true, notice: resetNotice(reason) })
      expect(await onDisk()).toEqual(emptyShortcutFile)
      const [original] = await quarantined()
      expect((await readFile(join(directory, original))).equals(content)).toBe(true)
    }
  })

  it('salvages the valid entries, keeps unknown ones verbatim, and keeps the original', async () => {
    const foreign = { command: 'future.command', key: 'ctrl+alt+q' }
    const raw = {
      version: 1, scheme: 'default',
      bindings: [{ command: 'query.execute', key: 'ctrl+e' }, 42, foreign, { command: 'query.execute', key: 'f5', remove: true, extra: 1 }],
      gestures: { 'explorer.peekHover': 'alt' }, unknown: [{ kept: true }], futureMember: [1]
    }
    await writeFile(path(), JSON.stringify(raw))
    const load = await store().load()
    expect(load.salvaged).toBe(true)
    expect(load.notice).toBe(salvageNotice)
    expect(load.file.bindings).toEqual([{ command: 'query.execute', key: 'ctrl+e' }])
    expect(load.file.gestures).toEqual({ 'explorer.peekHover': 'alt' })
    // The unknown record, the newer build's command, the newer member and the binding with an unknown member are kept.
    expect(load.file.unknown).toEqual([{ kept: true }, foreign, { command: 'query.execute', key: 'f5', remove: true, extra: 1 }, { futureMember: [1] }])
    expect(await onDisk()).toEqual(load.file)
    expect(JSON.parse(await readFile(join(directory, (await quarantined())[0]), 'utf8'))).toEqual(raw)
  })

  it('keeps unknown entries through a load and save without setting anything aside', async () => {
    const file = withBindings([{ command: 'query.execute', key: 'ctrl+e' }], { unknown: [{ command: 'future.command', key: 'ctrl+alt+q' }] })
    await writeFile(path(), JSON.stringify(file))
    const shortcuts = store()
    expect(await shortcuts.load()).toEqual({ file, revision: 1, salvaged: false })
    const next = { ...file, gestures: { 'grid.addToSelection': 'ctrl' } }
    await shortcuts.save(next, 1)
    expect(await onDisk()).toEqual(next)
    expect(await quarantined()).toEqual([])
  })

  it('clears the salvage notice once a save succeeds', async () => {
    await writeFile(path(), '{ broken')
    const shortcuts = store()
    expect((await shortcuts.load()).salvaged).toBe(true)
    await shortcuts.save(remap, 1)
    expect(await shortcuts.load()).toEqual({ file: remap, revision: 2, salvaged: false })
  })

  it('announces the first successful read after a failed one, so main rebuilds its menus', async () => {
    await mkdir(path())
    const shortcuts = store(), events: ShortcutsSnapshot[] = []
    shortcuts.onDidChange(snapshot => events.push(snapshot))
    await expect(shortcuts.load()).rejects.toThrow(shortcutSentences.unreadable)
    await rm(path(), { recursive: true })
    await writeFile(path(), JSON.stringify(remap))
    expect(await shortcuts.load()).toMatchObject({ file: remap, revision: 1 })
    expect(events).toEqual([{ file: remap, revision: 1 }])
    // Later loads of the same content announce nothing.
    await shortcuts.load()
    expect(events).toHaveLength(1)
  })

  it("keeps the notice when a save's own re-read set part of a hand edit aside", async () => {
    const shortcuts = store()
    await shortcuts.load()
    await shortcuts.save(remap, 1)
    // A hand edit that keeps the same readable entries and adds a damaged one: no new revision, so the save goes ahead.
    await writeFile(path(), JSON.stringify({ ...remap, bindings: [...remap.bindings, 42] }))
    const next = withBindings([{ command: 'query.execute', key: 'ctrl+shift+e' }])
    expect(await shortcuts.save(next, 2)).toEqual({ revision: 3 })
    expect(await quarantined()).toHaveLength(1)
    expect(await shortcuts.load()).toEqual({ file: next, revision: 3, salvaged: true, notice: salvageNotice })
    // A later save clears it.
    await shortcuts.save(remap, 3)
    expect(await shortcuts.load()).toMatchObject({ salvaged: false })
  })

  it('leaves a newer version\'s file alone and refuses to write over it', async () => {
    const newer = JSON.stringify({ version: 2, bindings: [] })
    await writeFile(path(), newer)
    const shortcuts = store()
    expect(await shortcuts.load()).toEqual({ file: emptyShortcutFile, revision: 1, salvaged: false, notice: shortcutSentences.newer })
    expect((await failure(shortcuts.save(remap, 1)) as Error).message).toBe(shortcutSentences.newer)
    expect(await readFile(path(), 'utf8')).toBe(newer)
    expect(await quarantined()).toEqual([])
  })

  it('writes nothing when the file cannot be read', async () => {
    await mkdir(path())
    const shortcuts = store()
    expect((await failure(shortcuts.load()) as Error).message).toBe(shortcutSentences.unreadable)
    expect((await failure(shortcuts.save(remap, 1)) as Error).message).toBe(shortcutSentences.unreadable)
    expect(await readdir(directory)).toEqual(['shortcuts.json'])
  })

  it('enforces the limits on what it saves', async () => {
    const shortcuts = store()
    await shortcuts.load()
    const many = withBindings(Array.from({ length: shortcutLimits.bindings + 1 }, () => ({ command: 'query.execute' as const, key: 'ctrl+e' })))
    await expect(shortcuts.save(many, 1)).rejects.toThrow()
    await expect(shortcuts.save({ ...remap, bindings: [{ command: 'query.execute', key: 'x'.repeat(shortcutLimits.key + 1) }] }, 1)).rejects.toThrow()
    await expect(shortcuts.save({ ...remap, bindings: [{ command: 'not.a.command' as never, key: 'ctrl+e' }] }, 1)).rejects.toThrow()
    await expect(shortcuts.save({ ...remap, extra: true } as ShortcutFile, 1)).rejects.toThrow()
    // Within each count, still over the file's size: 256 unknown records of about 1 KiB.
    const big = { ...emptyShortcutFile, unknown: Array.from({ length: shortcutLimits.unknown }, (_, index) => ({ filler: 'x'.repeat(shortcutLimits.unknownBytes - 40), index })) }
    expect((await failure(shortcuts.save(big, 1)) as Error).message).toBe(shortcutSentences.tooLarge)
    expect(await readdir(directory)).toEqual([])
  })

  it('runs work one task at a time, so two saves from the same revision cannot both win', async () => {
    const shortcuts = store()
    await shortcuts.load()
    const results = await Promise.allSettled([shortcuts.save(remap, 1), shortcuts.save(withBindings([{ command: 'query.execute', key: 'ctrl+shift+e' }]), 1)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await onDisk()).toEqual(remap)
  })
})

describe('shortcuts requests from the page', () => {
  it('refuses a list over its limit before checking its entries', async () => {
    const shortcuts = store()
    await shortcuts.load()
    // Counts the entries read, not a clock: refusing at the length reads none of the 200,000.
    let reads = 0
    const entries = Array.from({ length: 200_000 }, () => ({ command: 'query.execute', key: 'ctrl+e' }))
    const bindings = new Proxy(entries, { get: (target, key, receiver) => { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver) } })
    const huge = { ...emptyShortcutFile, bindings }
    const { result, work } = await meterWork(() => failure(shortcuts.save(huge, 1)))
    expect((result as unknown as Error).message).toBe(shortcutSentences.overLimit)
    expect(reads).toBeLessThan(1000)
    expect(work.elements).toBeLessThan(10_000)
    const handlers = shortcutHandlers(store(), { chooseImport: async () => undefined, chooseExport: async () => join(directory, 'never.json') })
    for (const file of [huge, { ...emptyShortcutFile, unknown: Array.from({ length: shortcutLimits.unknown + 1 }, () => 1) }, { ...emptyShortcutFile, gestures: Object.fromEntries(Array.from({ length: shortcutLimits.gestures + 1 }, (_, index) => [`g${index}`, 'alt'])) }]) {
      expect((await failure(handlers.exportFile({ file })) as Error).message).toBe(shortcutSentences.overLimit)
    }
    expect(await readdir(directory)).toEqual([])
  }, heavyTimeout)

  it('keeps only plain JSON values, so a cloned buffer or map cannot hide from the limits', async () => {
    // Structured clone (IPC) carries these; each looks like {} to the size checks.
    const cloned = structuredClone({ ...remap, unknown: [new ArrayBuffer(8 * 1024 * 1024), new Map(Array.from({ length: 1000 }, (_, index) => [index, index])), { at: new Date(0) }] })
    const shortcuts = store(), events: ShortcutsSnapshot[] = []
    shortcuts.onDidChange(snapshot => events.push(snapshot))
    await shortcuts.load()
    await shortcuts.save(cloned, 1)
    const plain = { ...remap, unknown: [{}, {}, { at: '1970-01-01T00:00:00.000Z' }] }
    expect(shortcuts.current()).toEqual(plain)
    expect(shortcuts.current().unknown[0]).not.toBeInstanceOf(ArrayBuffer)
    expect(events.at(-1)?.file).toEqual(plain)
    expect(await onDisk()).toEqual(plain)
    // What main holds is what the file holds, so a load sees no change.
    expect(await shortcuts.load()).toMatchObject({ revision: 2 })
  })

  it('answers a failed write with a fixed sentence that names no path', async () => {
    // A folder where the export goes makes the real write fail; a mocked failure stands in for a denied save.
    const taken = join(directory, 'taken.json')
    await mkdir(taken)
    const handlers = shortcutHandlers(store(), { chooseImport: async () => undefined, chooseExport: async () => taken })
    const exported = await failure(handlers.exportFile({ file: remap })) as Error
    expect(exported.message).toBe(shortcutSentences.exportFailed)
    const shortcuts = store()
    await shortcuts.load()
    failWrites = true
    const saved = await failure(shortcuts.save(remap, 1)) as Error
    expect(saved.message).toBe(shortcutSentences.saveFailed)
    const failedExport = await failure(shortcutHandlers(store(), { chooseImport: async () => undefined, chooseExport: async () => join(directory, 'export.json') }).exportFile({ file: remap })) as Error
    expect(failedExport.message).toBe(shortcutSentences.exportFailed)
    failWrites = false
    // Nothing changed: the same revision still saves.
    expect(await shortcuts.save(remap, 1)).toEqual({ revision: 2 })
  })
})

describe('shortcuts IPC handlers', () => {
  const dialogs = (choice: { import?: string; export?: string } = {}) => {
    const calls: string[] = []
    const value: ShortcutDialogs = {
      chooseImport: async () => { calls.push('import'); return choice.import },
      chooseExport: async () => { calls.push('export'); return choice.export }
    }
    return { value, calls }
  }

  it('get takes no argument', async () => {
    const handlers = shortcutHandlers(store(), dialogs().value)
    expect(await handlers.get(undefined)).toMatchObject({ revision: 1 })
    await expect(handlers.get({ path: path() })).rejects.toThrow()
  })

  it('save takes only a strict file and a base revision', async () => {
    const handlers = shortcutHandlers(store(), dialogs().value)
    await handlers.get(undefined)
    expect(await handlers.save({ file: remap, baseRevision: 1 })).toEqual({ revision: 2 })
    await expect(handlers.save({ file: remap, baseRevision: 2, path: join(directory, 'elsewhere.json') })).rejects.toThrow()
    await expect(handlers.save({ file: remap, baseRevision: -1 })).rejects.toThrow()
    await expect(handlers.save({ file: remap, baseRevision: 1.5 })).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['shortcuts.json'])
  })

  it('imports only the file main\'s dialog chose, refuses any argument, and saves nothing', async () => {
    const chosen = join(directory, 'chosen.json'), offered = join(directory, 'offered.json')
    await writeFile(chosen, JSON.stringify({ ...remap, bindings: [...remap.bindings, 7] }))
    await writeFile(offered, JSON.stringify(withBindings([{ command: 'query.execute', key: 'ctrl+shift+e' }])))
    const { value, calls } = dialogs({ import: chosen })
    const handlers = shortcutHandlers(store(), value)
    // A path from the page is refused before any dialog opens.
    for (const argument of [offered, { path: offered }, [offered]]) await expect(handlers.importFile(argument)).rejects.toThrow()
    expect(calls).toEqual([])
    const imported = await handlers.importFile(undefined)
    expect(imported).toEqual({ file: remap, problems: ['Shortcut 3 was dropped: it is not a shortcut.'] })
    expect(calls).toEqual(['import'])
    expect(await readdir(directory)).not.toContain('shortcuts.json')
  })

  it('answers cancelled when the import dialog is cancelled, and fixed words for a file it cannot use', async () => {
    expect(await shortcutHandlers(store(), dialogs().value).importFile(undefined)).toEqual({ cancelled: true })
    const cases: [string, string][] = [['{ nope', shortcutSentences.importInvalid], [JSON.stringify({ version: 9 }), shortcutSentences.importNewer], ['x'.repeat(shortcutLimits.fileBytes + 1), shortcutSentences.importSize]]
    for (const [content, message] of cases) {
      const chosen = join(directory, 'chosen.json')
      await writeFile(chosen, content)
      expect((await failure(shortcutHandlers(store(), dialogs({ import: chosen }).value).importFile(undefined)) as Error).message).toBe(message)
    }
    expect((await failure(shortcutHandlers(store(), dialogs({ import: directory }).value).importFile(undefined)) as Error).message).toBe(shortcutSentences.importNotFile)
  })

  it('exports only to the path main\'s dialog chose, and validates the file first', async () => {
    const chosen = join(directory, 'export.json'), offered = join(directory, 'offered.json')
    const { value, calls } = dialogs({ export: chosen })
    const handlers = shortcutHandlers(store(), value)
    await expect(handlers.exportFile({ file: remap, path: offered })).rejects.toThrow()
    await expect(handlers.exportFile(offered)).rejects.toThrow()
    await expect(handlers.exportFile({ file: { ...remap, version: 7 } })).rejects.toThrow()
    expect(calls).toEqual([])
    expect(await handlers.exportFile({ file: remap })).toEqual({ cancelled: false })
    expect(JSON.parse(await readFile(chosen, 'utf8'))).toEqual(remap)
    expect(await readdir(directory)).toEqual(['export.json'])
    expect(await shortcutHandlers(store(), dialogs().value).exportFile({ file: remap })).toEqual({ cancelled: true })
  })

  it('round-trips an exported file through import', async () => {
    const chosen = join(directory, 'roundtrip.json')
    const handlers = shortcutHandlers(store(), dialogs({ import: chosen, export: chosen }).value)
    const file = withBindings(remap.bindings, { gestures: { 'grid.addToSelection': 'ctrl' }, unknown: [{ command: 'future.command', key: 'ctrl+alt+q' }] })
    await handlers.exportFile({ file })
    expect(await handlers.importFile(undefined)).toEqual({ file, problems: [] })
  })
})
