import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BackendMethods, BackendState } from '../src/shared/contracts'
import { IndexStoreConfig, indexStoreFolder, indexStoreSettingKeys, indexStoreSettings, type IndexStoreSettings } from '../src/main/backend/index-store'
import { SearchIndexKeyStore, searchIndexKeyBytes, searchIndexKeyFile, type SearchIndexKey } from '../src/main/search-index-key'
import { lockedCipher, safeStorageCipher, testCipher, type SafeStorageApi, type SecretCipher } from '../src/main/secret-cipher'
import { indexStoreClearedSchema, indexStoreConfigureSchema, requestSchemas, secretStorageStateSchema, validateRequest } from '../src/main/validation'
import { objectSearchLimits } from '../src/shared/explorer/search'
import { mainOnlyMethods, methodPolicies, methodProviders } from '../src/shared/ipc/methods'
import { indexStoreStatusSchema, memoryEventSchema, memoryReport, portRequestSchema } from '../src/shared/ipc/port-messages'
import { settingDef } from '../src/shared/settings/catalog'

const directories: string[] = []
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'varia-search-index-key-'))
  directories.push(directory)
  return directory
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

/** Everything main wrote under the folder, as one buffer per file. */
async function written(directory: string): Promise<{ name: string; bytes: Buffer }[]> {
  return Promise.all((await readdir(directory)).map(async name => ({ name, bytes: await readFile(join(directory, name)) })))
}
/** Whether any form the key could take on disk (its bytes, base64, base64url, hex) is in a file. */
function holdsKey(files: { bytes: Buffer }[], key: Buffer): boolean {
  const forms = [key, Buffer.from(key.toString('base64')), Buffer.from(key.toString('base64url')), Buffer.from(key.toString('hex')), Buffer.from(key.toString('hex').toUpperCase())]
  return files.some(file => forms.some(form => file.bytes.includes(form)))
}
const keyOf = (answer: SearchIndexKey): Buffer => {
  if (answer.kind !== 'key') throw new Error('Expected a key, got ' + JSON.stringify(answer))
  return answer.key
}
/** safeStorage as a Linux desktop with a reachable keyring answers it. */
const linuxKeyring = (backend: ReturnType<SafeStorageApi['getSelectedStorageBackend']>, available = true): SafeStorageApi => ({
  getSelectedStorageBackend: () => backend,
  isAsyncEncryptionAvailable: async () => available,
  encryptStringAsync: async (text: string) => Buffer.concat([Buffer.from('v11'), Buffer.from(Buffer.from(text).map(byte => byte ^ 0x33))]),
  decryptStringAsync: async (data: Buffer) => ({ result: Buffer.from(data.subarray(3).map(byte => byte ^ 0x33)).toString(), shouldReEncrypt: false })
})

describe('the saved search index key (search-index-key.json)', () => {
  it('is 32 random bytes made once, reused by a later start, and on disk only as ciphertext', async () => {
    const directory = await folder(), path = join(directory, searchIndexKeyFile)
    const first = new SearchIndexKeyStore(path, testCipher())
    const key = keyOf(await first.key())
    expect(key).toHaveLength(searchIndexKeyBytes)
    expect(keyOf(await first.key()).equals(key)).toBe(true)
    // A new process reads the same key back from the file.
    const second = new SearchIndexKeyStore(path, testCipher())
    expect(keyOf(await second.key()).equals(key)).toBe(true)
    // Another profile's key is another key.
    const other = await folder()
    expect(keyOf(await new SearchIndexKeyStore(join(other, searchIndexKeyFile), testCipher()).key()).equals(key)).toBe(false)
    const files = await written(directory)
    expect(files.map(file => file.name)).toEqual([searchIndexKeyFile])
    const file = JSON.parse(files[0].bytes.toString())
    expect(Object.keys(file).sort()).toEqual(['key', 'version'])
    expect(file.version).toBe(1)
    // The test cipher XORs, so the plain forms would show if main had written the key itself anywhere.
    expect(holdsKey(files, key)).toBe(false)
    expect(Buffer.from(file.key, 'base64').includes(key)).toBe(false)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  it('never writes the key in clear under a real key store either, and never asks the key store twice in one process', async () => {
    const directory = await folder(), path = join(directory, searchIndexKeyFile)
    const storage = linuxKeyring('gnome_libsecret')
    const encrypt = vi.spyOn(storage, 'encryptStringAsync'), decrypt = vi.spyOn(storage, 'decryptStringAsync')
    const store = new SearchIndexKeyStore(path, safeStorageCipher(storage, 'linux'))
    const key = keyOf(await store.key())
    const sealed = encrypt.mock.calls.filter(([text]) => text.startsWith('varia-search-index:'))
    expect(sealed).toHaveLength(1)
    await store.key()
    await store.key()
    expect(encrypt.mock.calls.filter(([text]) => text.startsWith('varia-search-index:'))).toHaveLength(1)
    expect(decrypt).not.toHaveBeenCalled()
    expect(holdsKey(await written(directory), key)).toBe(false)
    const again = new SearchIndexKeyStore(path, safeStorageCipher(storage, 'linux'))
    expect(keyOf(await again.key()).equals(key)).toBe(true)
    expect(decrypt).toHaveBeenCalledTimes(1)
  })
  it('has no key where the system has no usable key store, waits where it is not reachable yet, and touches no file', async () => {
    const cases: [SecretCipher, string][] = [
      [safeStorageCipher(linuxKeyring('basic_text'), 'linux'), 'no-keyring'],
      [safeStorageCipher(linuxKeyring('unknown'), 'linux'), 'unknown-backend'],
      [safeStorageCipher(linuxKeyring('gnome_libsecret', false), 'linux'), 'unavailable'],
      [safeStorageCipher({ ...linuxKeyring('kwallet6'), encryptStringAsync: async (text: string) => Buffer.from('v10' + text) }, 'linux'), 'unavailable'],
      [lockedCipher(), 'unavailable'],
      [lockedCipher('no-keyring'), 'no-keyring']
    ]
    for (const [cipher, reason] of cases) {
      const directory = await folder(), path = join(directory, searchIndexKeyFile)
      // A key saved while the key store worked is left exactly as it is while it does not.
      const earlier = keyOf(await new SearchIndexKeyStore(path, testCipher()).key())
      const before = await readFile(path)
      const store = new SearchIndexKeyStore(path, cipher)
      // Only a reason that lasts is no key store; a keyring not reachable yet (locked, or only the fallback key) may answer later.
      expect(await store.key(), reason).toEqual(reason === 'unavailable' ? { kind: 'unanswered' } : { kind: 'none', reason })
      expect(await store.storage(), reason).toEqual({ available: false, reason })
      expect((await readFile(path)).equals(before)).toBe(true)
      expect(await readdir(directory)).toEqual([searchIndexKeyFile])
      expect(keyOf(await new SearchIndexKeyStore(path, testCipher()).key()).equals(earlier)).toBe(true)
    }
    const empty = await folder()
    expect(await new SearchIndexKeyStore(join(empty, searchIndexKeyFile), lockedCipher('no-keyring')).key()).toEqual({ kind: 'none', reason: 'no-keyring' })
    expect(await readdir(empty)).toEqual([])
  })
  it('quarantines a file it cannot parse and a ciphertext the key store no longer opens, and makes a new key', async () => {
    const unreadable: [string, (path: string, cipher: SecretCipher) => Promise<void>][] = [
      ['not JSON', path => writeFile(path, '{ not json')],
      ['another shape', path => writeFile(path, JSON.stringify({ version: 1, key: 'AAAA', extra: true }))],
      ['a newer version', path => writeFile(path, JSON.stringify({ version: 2, key: 'AAAA' }))],
      ['a ciphertext the key store no longer opens', path => writeFile(path, JSON.stringify({ version: 1, key: Buffer.from('not what this key store wrote').toString('base64') }))],
      ['a ciphertext of something else', async (path, cipher) => writeFile(path, JSON.stringify({ version: 1, key: (await cipher.encrypt('varia-workspace-seal:' + Buffer.alloc(32, 7).toString('base64'))).toString('base64') }))],
      ['a key of another length', async (path, cipher) => writeFile(path, JSON.stringify({ version: 1, key: (await cipher.encrypt('varia-search-index:' + Buffer.alloc(31, 7).toString('base64'))).toString('base64') }))]
    ]
    for (const [what, damage] of unreadable) {
      const directory = await folder(), path = join(directory, searchIndexKeyFile)
      const old = keyOf(await new SearchIndexKeyStore(path, testCipher()).key())
      await damage(path, testCipher())
      const damaged = await readFile(path)
      const key = keyOf(await new SearchIndexKeyStore(path, testCipher()).key())
      expect(key.equals(old), what).toBe(false)
      const names = (await readdir(directory)).sort()
      const kept = names.filter(name => name.startsWith(searchIndexKeyFile + '.invalid-'))
      expect(names, what).toHaveLength(2)
      expect(kept, what).toHaveLength(1)
      // The unreadable file is preserved as it was, never overwritten; the new file opens to the new key.
      expect((await readFile(join(directory, kept[0]))).equals(damaged), what).toBe(true)
      expect(keyOf(await new SearchIndexKeyStore(path, testCipher()).key()).equals(key), what).toBe(true)
      expect(holdsKey(await written(directory), key), what).toBe(false)
    }
  })
  it('leaves the file alone when the key store refuses to seal a new key (a declined Keychain prompt)', async () => {
    const directory = await folder(), path = join(directory, searchIndexKeyFile)
    await writeFile(path, JSON.stringify({ version: 1, key: Buffer.from('a ciphertext from before').toString('base64') }))
    const before = await readFile(path)
    const refusing: SecretCipher = { state: async () => ({ available: true }), encrypt: async () => { throw new Error('declined') }, decrypt: async () => { throw new Error('declined') } }
    expect(await new SearchIndexKeyStore(path, refusing).key()).toEqual({ kind: 'unanswered' })
    expect(await readdir(directory)).toEqual([searchIndexKeyFile])
    expect((await readFile(path)).equals(before)).toBe(true)
  })
  it('stores the same key again when the key store has rotated its own', async () => {
    const directory = await folder(), path = join(directory, searchIndexKeyFile)
    const base = testCipher()
    const key = keyOf(await new SearchIndexKeyStore(path, base).key())
    const before = await readFile(path, 'utf8')
    const encrypt = vi.fn(async (text: string) => Buffer.concat([Buffer.from('rotated:'), await base.encrypt(text)]))
    const rotated: SecretCipher = {
      state: base.state, encrypt,
      decrypt: async data => data.subarray(0, 8).toString() === 'rotated:' ? { ...await base.decrypt(data.subarray(8)), reEncrypt: false } : { ...await base.decrypt(data), reEncrypt: true }
    }
    expect(keyOf(await new SearchIndexKeyStore(path, rotated).key()).equals(key)).toBe(true)
    expect(encrypt).toHaveBeenCalledTimes(1)
    expect(await readFile(path, 'utf8')).not.toBe(before)
    expect(keyOf(await new SearchIndexKeyStore(path, rotated).key()).equals(key)).toBe(true)
    expect(encrypt).toHaveBeenCalledTimes(1)
  })
  it('does not wait on a key store that never answers', async () => {
    const directory = await folder()
    const silent: SecretCipher = { state: () => new Promise(() => {}), encrypt: () => new Promise(() => {}), decrypt: () => new Promise(() => {}) }
    const store = new SearchIndexKeyStore(join(directory, searchIndexKeyFile), silent, { timeoutMs: 5 })
    expect(await store.storage()).toEqual({ available: false, reason: 'unavailable' })
    expect(await store.key()).toEqual({ kind: 'unanswered' })
    expect(await readdir(directory)).toEqual([])
  })
  it('does not take an unanswered Keychain prompt for an unreadable key: nothing is quarantined, and a later start reads the key', async () => {
    const directory = await folder(), path = join(directory, searchIndexKeyFile)
    const key = keyOf(await new SearchIndexKeyStore(path, testCipher()).key())
    const before = await readFile(path)
    const base = testCipher()
    const prompting: SecretCipher = { state: base.state, encrypt: base.encrypt, decrypt: () => new Promise(() => {}) }
    expect(await new SearchIndexKeyStore(path, prompting, { timeoutMs: 5 }).key()).toEqual({ kind: 'unanswered' })
    expect(await readdir(directory)).toEqual([searchIndexKeyFile])
    expect((await readFile(path)).equals(before)).toBe(true)
    // The same when a first key cannot be sealed in time: no file appears.
    const empty = await folder()
    const sealing: SecretCipher = { state: base.state, encrypt: () => new Promise(() => {}), decrypt: base.decrypt }
    expect(await new SearchIndexKeyStore(join(empty, searchIndexKeyFile), sealing, { timeoutMs: 5 }).key()).toEqual({ kind: 'unanswered' })
    expect(await readdir(empty)).toEqual([])
    expect(keyOf(await new SearchIndexKeyStore(path, testCipher()).key()).equals(key)).toBe(true)
  })
  it('keeps a separate value, in clear, that only names files in the unencrypted mode', async () => {
    const directory = await folder(), path = join(directory, searchIndexKeyFile)
    const store = new SearchIndexKeyStore(path, lockedCipher('no-keyring'))
    const names = (await store.names())!
    expect(names).toHaveLength(searchIndexKeyBytes)
    expect((await store.names())!.equals(names)).toBe(true)
    expect((await new SearchIndexKeyStore(path, lockedCipher('no-keyring')).names())!.equals(names)).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, names: names.toString('base64') })
    // Once a key store is there, the data key is added beside it and is another value, still only as ciphertext.
    const key = keyOf(await new SearchIndexKeyStore(path, testCipher()).key())
    expect(key.equals(names)).toBe(false)
    const file = JSON.parse(await readFile(path, 'utf8'))
    expect(file.names).toBe(names.toString('base64'))
    expect(holdsKey(await written(directory), key)).toBe(false)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  it('answers no names value, rather than throw, when its file cannot be written', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const directory = await folder()
    await chmod(directory, 0o500)
    try { expect(await new SearchIndexKeyStore(join(directory, searchIndexKeyFile), lockedCipher('no-keyring')).names()).toBeUndefined() }
    finally { await chmod(directory, 0o700) }
  })
})

const ready = (generation: number): BackendState => ({ status: 'ready', generation, pid: 1, runtime: 'test', platform: 'test' })
type Configure = BackendMethods['explorer.indexStore.configure']['params']
const dataKey = Buffer.alloc(32, 0xa7), namesKey = Buffer.alloc(32, 0x1d)

/** A supervisor's state and request, with each request answered by hand. */
function harness(options: { settings?: Partial<IndexStoreSettings>; unread?: boolean; key?: SearchIndexKey; names?: Buffer | undefined; folder?: string; initial?: BackendState; retryMs?: number } = {}) {
  let settings: IndexStoreSettings = { save: true, limitMiB: 2048, clearText: false, ...options.settings }
  let read = !options.unread
  let key: SearchIndexKey = options.key ?? { kind: 'key', key: dataKey }
  const listeners = new Set<(state: BackendState) => void>()
  const sent: (Configure & { generation: number })[] = []
  const pending: ((ok: boolean) => void)[] = []
  const config = new IndexStoreConfig({
    request: (params, generation) => new Promise((resolve, reject) => {
      sent.push({ ...params, generation })
      pending.push(ok => ok ? resolve({}) : reject(new Error('lost')))
    }),
    onState: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    state: () => options.initial ?? { status: 'starting', generation: 0 } as BackendState,
    settings: () => read ? settings : undefined,
    folder: options.folder ?? indexStoreFolder(resolve('profile')),
    keys: { key: async () => key, names: async () => 'names' in options ? options.names : namesKey },
    retryMs: options.retryMs
  })
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
  return {
    config, sent, flush,
    state: async (state: BackendState) => { for (const listener of listeners) listener(state); await flush() },
    set: async (next: Partial<IndexStoreSettings>) => { settings = { ...settings, ...next }; config.settingsChanged(); await flush() },
    keyStore: (next: SearchIndexKey) => { key = next },
    read: async (known = true) => { read = known; config.settingsChanged(); await flush() },
    answer: async (ok = true) => { pending.shift()?.(ok); await flush() }
  }
}

describe('configuring the backend\'s saved index (explorer.indexStore.configure)', () => {
  it('sends the key, the folder under the user-data directory and the limit as each backend becomes ready', async () => {
    const h = harness()
    expect(h.sent).toEqual([])
    await h.state(ready(1))
    expect(h.sent).toEqual([{ mode: 'encrypted', folder: join(resolve('profile'), 'SearchIndex'), limitMiB: 2048, key: dataKey.toString('base64'), generation: 1 }])
    await h.answer()
    // Nothing changed: nothing more is sent, also when the same generation reports ready again.
    await h.state(ready(1))
    h.config.settingsChanged()
    await h.flush()
    expect(h.sent).toHaveLength(1)
    // A restarted backend knows nothing: it is told again.
    await h.state({ status: 'starting', generation: 2 } as BackendState)
    await h.state(ready(2))
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toMatchObject({ mode: 'encrypted', generation: 2, key: dataKey.toString('base64') })
  })
  it('configures a backend that was already ready when it was made', async () => {
    const h = harness({ initial: ready(4) })
    await h.flush()
    expect(h.sent).toMatchObject([{ mode: 'encrypted', generation: 4 }])
  })
  it('sends disabled without a key when saving is off, and no key without a key store unless the user opted in', async () => {
    const off = harness({ settings: { save: false } })
    await off.state(ready(1))
    expect(off.sent).toEqual([{ mode: 'disabled', folder: join(resolve('profile'), 'SearchIndex'), limitMiB: 2048, generation: 1 }])
    const none = harness({ key: { kind: 'none', reason: 'no-keyring' } })
    await none.state(ready(1))
    expect(none.sent).toEqual([{ mode: 'noKeyStore', folder: join(resolve('profile'), 'SearchIndex'), limitMiB: 2048, generation: 1 }])
    const opted = harness({ key: { kind: 'none', reason: 'no-keyring' }, settings: { clearText: true } })
    await opted.state(ready(1))
    expect(opted.sent).toEqual([{ mode: 'clearText', folder: join(resolve('profile'), 'SearchIndex'), limitMiB: 2048, key: namesKey.toString('base64'), generation: 1 }])
    // The opt-in changes nothing while there is a key store: the index is encrypted.
    const both = harness({ settings: { clearText: true } })
    await both.state(ready(1))
    expect(both.sent).toMatchObject([{ mode: 'encrypted', key: dataKey.toString('base64') }])
    // Opted in, but the names value could not be written: nothing is sent, since noKeyStore would sweep the clear-text files.
    const unwritable = harness({ key: { kind: 'none', reason: 'no-keyring' }, settings: { clearText: true }, names: undefined })
    await unwritable.state(ready(1))
    expect(unwritable.sent).toEqual([])
    unwritable.config.dispose()
  })
  it('sends again when one of the three settings changes, one request at a time, and never re-sends a failed one', async () => {
    const h = harness()
    await h.state(ready(1))
    await h.set({ limitMiB: 512 })
    // The first is still in flight: the change waits for its answer.
    expect(h.sent).toHaveLength(1)
    await h.answer()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toMatchObject({ mode: 'encrypted', limitMiB: 512 })
    await h.answer()
    await h.set({ save: false })
    expect(h.sent[2]).toMatchObject({ mode: 'disabled', limitMiB: 512 })
    expect(h.sent[2]).not.toHaveProperty('key')
    // A failure is a value: nothing is re-sent until something changes.
    await h.answer(false)
    await h.flush()
    expect(h.sent).toHaveLength(3)
    await h.set({ save: true })
    expect(h.sent).toHaveLength(4)
    await h.answer()
    // A failed request is tried again when the generation recovers from unresponsive.
    await h.set({ limitMiB: 1024 })
    await h.answer(false)
    await h.state({ status: 'unresponsive', generation: 1 } as BackendState)
    await h.state(ready(1))
    expect(h.sent).toHaveLength(6)
    expect(h.sent[5]).toMatchObject({ limitMiB: 1024, generation: 1 })
    await h.answer()
    // A change made while a request is in flight that then fails is sent at once, not at the next change.
    await h.set({ limitMiB: 2048 })
    expect(h.sent).toHaveLength(7)
    await h.set({ limitMiB: 4096 })
    await h.answer(false)
    expect(h.sent).toHaveLength(8)
    expect(h.sent[7]).toMatchObject({ limitMiB: 4096 })
  })
  it('sends nothing while the configuration cannot be said, and nothing once disposed', async () => {
    const long = harness({ folder: join(resolve('p'.repeat(objectSearchLimits.store.folderChars)), 'SearchIndex') })
    await long.state(ready(1))
    expect(long.sent).toEqual([])
    const disposed = harness()
    disposed.config.dispose()
    await disposed.state(ready(1))
    expect(disposed.sent).toEqual([])
  })
  it('sends nothing while the key store has not answered or is not reachable yet, never clear text, and asks it again later', async () => {
    vi.useFakeTimers()
    try {
      // Opted in to clear text, with a key store that is there but locked: nothing is sent, so nothing encrypted is swept.
      const h = harness({ key: { kind: 'unanswered' }, settings: { clearText: true }, retryMs: 1000 })
      await h.state(ready(1))
      expect(h.sent).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      await h.flush()
      expect(h.sent).toEqual([])
      // It unlocks: the next ask (after twice the wait) sends the key.
      h.keyStore({ kind: 'key', key: dataKey })
      await vi.advanceTimersByTimeAsync(1999)
      await h.flush()
      expect(h.sent).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await h.flush()
      expect(h.sent).toMatchObject([{ mode: 'encrypted', key: dataKey.toString('base64'), generation: 1 }])
      await h.answer()
      // Saving turned off while the key store is being asked: disabled goes at once, not at the next retry.
      let answer: (key: SearchIndexKey) => void = () => {}
      const slowSent: string[] = []
      let slowSettings: IndexStoreSettings = { save: true, limitMiB: 2048, clearText: false }
      const slow = new IndexStoreConfig({
        request: async params => { slowSent.push(params.mode); return {} }, onState: () => () => {}, state: () => ready(1), settings: () => slowSettings,
        folder: indexStoreFolder(resolve('profile')), keys: { key: () => new Promise(resolve => { answer = resolve }), names: async () => namesKey }, retryMs: 60_000
      })
      await Promise.resolve()
      slowSettings = { ...slowSettings, save: false }
      slow.settingsChanged()
      answer({ kind: 'unanswered' })
      for (let i = 0; i < 40; i++) await Promise.resolve()
      expect(slowSent).toEqual(['disabled'])
      slow.dispose()
      // A change asks at once, without waiting for the timer.
      const changed = harness({ key: { kind: 'unanswered' }, retryMs: 60_000 })
      await changed.state(ready(1))
      changed.keyStore({ kind: 'key', key: dataKey })
      await changed.set({ limitMiB: 512 })
      expect(changed.sent).toMatchObject([{ mode: 'encrypted', limitMiB: 512 }])
      // Disposed: the timer asks nothing.
      const disposed = harness({ key: { kind: 'unanswered' }, retryMs: 1000 })
      await disposed.state(ready(1))
      disposed.config.dispose()
      disposed.keyStore({ kind: 'key', key: dataKey })
      await vi.advanceTimersByTimeAsync(5000)
      await disposed.flush()
      expect(disposed.sent).toEqual([])
    } finally { vi.useRealTimers() }
  })
  it('sends nothing until the settings are read, nor while one of the three was reset by an unreadable settings.json', async () => {
    // A user who chose a larger limit, unencrypted files or no saving must not have a default acted on: it could delete.
    const h = harness({ unread: true, settings: { limitMiB: 20_000 } })
    await h.state(ready(1))
    expect(h.sent).toEqual([])
    await h.read()
    expect(h.sent).toMatchObject([{ mode: 'encrypted', limitMiB: 20_000 }])
    await h.answer()
    // Reset (main's settings() answers undefined while SettingsStore.wasReset holds one of the three): nothing more is sent.
    await h.read(false)
    await h.set({ limitMiB: 64 })
    expect(h.sent).toHaveLength(1)
    const main = readFileSync(join('src', 'main', 'index.ts'), 'utf8')
    expect(main).toContain('settings: () => indexSettingsRead && !indexStoreSettingKeys.some(key => settings.wasReset(key)) ? indexStoreSettings(settings.current()) : undefined,')
    expect(indexStoreSettingKeys.every(key => settingDef(key).page === 'objectExplorer.commands')).toBe(true)
  })
  it('reads the three settings loosely: anything out of range is the default', () => {
    const { min, max, default: fallback } = objectSearchLimits.store.diskMiB
    expect(indexStoreSettings({})).toEqual({ save: true, limitMiB: fallback, clearText: false })
    expect(indexStoreSettings({ 'objectExplorer.search.saveIndex': false, 'objectExplorer.search.diskLimitMiB': min, 'objectExplorer.search.saveUnencrypted': true })).toEqual({ save: false, limitMiB: min, clearText: true })
    for (const limit of [min - 1, max + 1, 100.5, '2048', null, NaN]) expect(indexStoreSettings({ 'objectExplorer.search.diskLimitMiB': limit }).limitMiB).toBe(fallback)
    expect(indexStoreSettings({ 'objectExplorer.search.saveUnencrypted': 'true', 'objectExplorer.search.saveIndex': 0 })).toMatchObject({ save: true, clearText: false })
    expect(indexStoreFolder(resolve('user-data'))).toBe(join(resolve('user-data'), 'SearchIndex'))
  })
})

describe('the saved index\'s inputs and what the renderer may see', () => {
  const folderPath = join(resolve('profile'), 'SearchIndex')
  const valid = { mode: 'encrypted', folder: folderPath, limitMiB: 2048, key: dataKey.toString('base64') }
  it('bounds every input of explorer.indexStore.configure', () => {
    const { min, max } = objectSearchLimits.store.diskMiB
    const accepts = (value: unknown) => indexStoreConfigureSchema.safeParse(value).success
    expect(accepts(valid)).toBe(true)
    for (const limitMiB of [min, max]) expect(accepts({ ...valid, limitMiB })).toBe(true)
    for (const limitMiB of [min - 1, max + 1, 0, -1, 2048.5, '2048', null, undefined]) expect(accepts({ ...valid, limitMiB }), String(limitMiB)).toBe(false)
    expect(accepts({ ...valid, folder: 'x'.repeat(objectSearchLimits.store.folderChars) })).toBe(true)
    for (const folder of ['', 'x'.repeat(objectSearchLimits.store.folderChars + 1), 'a\0b', 7, null, undefined]) expect(accepts({ ...valid, folder }), String(folder)).toBe(false)
    for (const key of [dataKey.subarray(1).toString('base64'), Buffer.alloc(33).toString('base64'), dataKey.toString('hex'), '!'.repeat(44), '', 7, null]) expect(accepts({ ...valid, key }), String(key)).toBe(false)
    for (const mode of ['unavailable', 'plain', '', 7, null, undefined]) expect(accepts({ ...valid, mode }), String(mode)).toBe(false)
    // A key comes exactly with a mode that saves.
    expect(accepts({ ...valid, key: undefined })).toBe(false)
    expect(accepts({ mode: 'clearText', folder: folderPath, limitMiB: 2048 })).toBe(false)
    expect(accepts({ mode: 'clearText', folder: folderPath, limitMiB: 2048, key: namesKey.toString('base64') })).toBe(true)
    for (const mode of ['disabled', 'noKeyStore']) {
      expect(accepts({ mode, folder: folderPath, limitMiB: 2048 })).toBe(true)
      expect(accepts({ mode, folder: folderPath, limitMiB: 2048, key: valid.key })).toBe(false)
    }
    expect(accepts({ ...valid, path: folderPath })).toBe(false)
  })
  it('mirrors the backend\'s bounds (IndexStoreLimits)', () => {
    const limits = readFileSync(join('backend', 'Varia.Backend', 'Search', 'IndexStoreNames.cs'), 'utf8')
    const { diskMiB, unusedDays, folder, folderChars, keyChars } = objectSearchLimits.store
    expect(limits).toContain(`public const int DefaultDiskMiB = ${diskMiB.default};`)
    expect(limits).toContain(`public const int MinDiskMiB = ${diskMiB.min};`)
    expect(limits).toContain(`public const int MaxDiskMiB = ${diskMiB.max.toLocaleString('en-US').replaceAll(',', '_')};`)
    expect(limits).toContain(`public const int FolderChars = ${folderChars};`)
    expect(limits).toContain(`public const string FolderName = "${folder}";`)
    expect(limits).toContain(`public const int KeyChars = ${keyChars};`)
    expect(limits).toContain(`public const int UnusedDays = ${unusedDays};`)
    expect(Buffer.alloc(32).toString('base64')).toHaveLength(keyChars)
    expect(settingDef('objectExplorer.search.diskLimitMiB')).toMatchObject({ type: 'integer', min: diskMiB.min, max: diskMiB.max, default: diskMiB.default, enabledBy: 'objectExplorer.search.saveIndex' })
    expect(settingDef('objectExplorer.search.saveIndex')).toMatchObject({ type: 'boolean', default: true })
    expect(settingDef('objectExplorer.search.saveUnencrypted')).toMatchObject({ type: 'boolean', default: false, enabledBy: 'objectExplorer.search.saveIndex' })
    expect(settingDef('objectExplorer.search.saveUnencrypted').description).toMatch(/readable by any program or person that can read your files/)
    expect(settingDef('objectExplorer.search.saveIndex').description).toMatch(/While it is False nothing is saved, and the indexes already saved are deleted/)
  })
  it('keeps both methods to main: no renderer or port schema accepts them, and the one with the key is sensitive', () => {
    for (const method of ['explorer.indexStore.configure', 'explorer.indexStore.clear'] as const) {
      expect(mainOnlyMethods).toContain(method)
      expect(Object.hasOwn(requestSchemas, method)).toBe(false)
      expect(() => validateRequest(method as never, valid)).toThrow('Unsupported backend method')
      expect(portRequestSchema.safeParse({ t: method, rid: 1 }).success).toBe(false)
      expect(methodProviders(method)).toEqual(['sqlserver', 'bigquery'])
      expect(methodPolicies[method]).toMatchObject({ kind: 'unary', lane: 'control' })
    }
    expect(methodPolicies['explorer.indexStore.configure'].sensitive).toBe(true)
    expect(methodPolicies['explorer.indexStore.clear'].sensitive).toBeUndefined()
  })
  it('exposes to the page only a clear and a key-store question, neither taking nor answering a key or a path', () => {
    const preload = readFileSync(join('src', 'preload', 'index.ts'), 'utf8')
    expect(preload).toContain("clearSavedSearchIndexes: () => ipcRenderer.invoke('varia:index-store-clear'),")
    expect(preload).toContain("searchIndexStorage: () => ipcRenderer.invoke('varia:index-store-storage'),")
    expect(preload.match(/index-store|indexStore|searchIndex|SearchIndex/g)).toHaveLength(4)
    const main = readFileSync(join('src', 'main', 'index.ts'), 'utf8')
    // Main sends the configuration itself, once, and hands the page only validated counts and the key store's state.
    expect(main.match(/explorer\.indexStore\.configure/g)).toHaveLength(1)
    expect(main).toContain("request: (params, generation) => backend.request('explorer.indexStore.configure', params, { generation }),")
    expect(main).toContain("handle('varia:index-store-clear', async () => indexStoreClearedSchema.parse(await backend.request('explorer.indexStore.clear', {})))")
    expect(main).toContain("handle('varia:index-store-storage', async () => secretStorageStateSchema.parse(await searchIndexKeys.storage()))")
    // The key store and the folder are named nowhere else in main: not in an event, a result or a window message.
    expect(main.match(/searchIndexKeys/g)).toHaveLength(3)
    expect(main.match(/indexStoreFolder\(/g)).toHaveLength(1)
    expect(main.match(/varia:index-store-/g)).toHaveLength(2)
    for (const line of main.split('\n').filter(line => /webContents\.send|postMessage/.test(line))) expect(line).not.toMatch(/searchIndexKeys|indexStoreFolder|SearchIndex/)
    // What the two handlers answer is strict: an answer with anything more is refused, not passed on.
    expect(indexStoreClearedSchema.safeParse({ files: 3, bytes: 10, kept: 0 }).success).toBe(true)
    expect(indexStoreClearedSchema.safeParse({ files: 3, bytes: 10, kept: 0, folder: folderPath }).success).toBe(false)
    expect(secretStorageStateSchema.safeParse({ available: false, reason: 'no-keyring' }).success).toBe(true)
    expect(secretStorageStateSchema.safeParse({ available: true, key: valid.key }).success).toBe(false)
  })
  it('lets the memory event carry the store\'s mode and figures and nothing else', () => {
    const store = { mode: 'encrypted', files: 12, bytes: 3 * 1048576, limitBytes: 2048 * 1048576 }
    const event = { type: 'explorer.index.memory', usedBytes: 1, globalBytes: 512 * 1048576, seq: 1, store }
    const parsed = memoryEventSchema.parse(event)
    expect(memoryReport(parsed, 3)).toEqual({ feature: 'index', report: { usedBytes: 1, globalBytes: 512 * 1048576, seq: 1, generation: 3, store } })
    expect(memoryReport(memoryEventSchema.parse({ ...event, store: undefined }), 3).report).not.toHaveProperty('store')
    for (const mode of ['encrypted', 'clearText', 'disabled', 'noKeyStore', 'unavailable']) expect(indexStoreStatusSchema.safeParse({ ...store, mode }).success).toBe(true)
    for (const extra of [{ folder: folderPath }, { key: valid.key }, { path: 'x' }, { name: 'Sales' }]) {
      expect(indexStoreStatusSchema.safeParse({ ...store, ...extra }).success).toBe(false)
      expect(memoryEventSchema.safeParse({ ...event, store: { ...store, ...extra } }).success).toBe(false)
      expect(memoryEventSchema.safeParse({ ...event, ...extra }).success).toBe(false)
    }
    for (const bad of [{ mode: 'plain' }, { files: -1 }, { bytes: 1.5 }, { limitBytes: '1' }]) expect(indexStoreStatusSchema.safeParse({ ...store, ...bad }).success).toBe(false)
    // Results' event has no store.
    expect(memoryEventSchema.safeParse({ type: 'results.memory', usedBytes: 1, globalBytes: 2, seq: 1, store }).success).toBe(false)
  })
})
