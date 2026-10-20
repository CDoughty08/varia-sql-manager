import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { SavedPasswordStore, savedPasswordMessages } from '../src/main/saved-passwords'
import { safeStorageCipher, testCipher, type SafeStorageApi, type SecretCipher } from '../src/main/secret-cipher'
import { ConnectionStore } from '../src/main/connection-store'
import { credentialBinding, type ConnectionLibrary, type ConnectionProfile } from '../src/shared/connections'
import type { ConnectionOptions } from '../src/shared/contracts'

const marker = 'correct-horse-marker'
const options: ConnectionOptions = { server: 'Secret-Server.contoso.com', database: 'master', authentication: 'sql', username: 'secret-login', password: marker, trustServerCertificate: false, encrypt: 'mandatory' }
const directories: string[] = []
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'varia-saved-passwords-'))
  directories.push(directory)
  return directory
}
async function store(cipher: SecretCipher = testCipher()) {
  const directory = await folder()
  const path = join(directory, 'saved-passwords.json')
  return { store: new SavedPasswordStore(path, cipher), path, directory }
}
const profile = (id: string, value: Omit<ConnectionOptions, 'password'>, patch: Partial<ConnectionProfile> = {}): ConnectionProfile => {
  const { password: _password, ...saved } = value as ConnectionOptions
  return { id, options: saved, favorite: false, registered: false, lastConnected: new Date().toISOString(), ...patch }
}
const library = (...profiles: ConnectionProfile[]): ConnectionLibrary => ({ version: 1, profiles })
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('saved passwords', () => {
  it('round-trips a password, keeping it, its base64 and the server and login names out of the file', async () => {
    const { store: saved, path } = await store()
    const id = randomUUID()
    await saved.set(id, options)
    expect(await saved.get(id, { ...options, password: '' })).toBe(marker)
    expect(await new SavedPasswordStore(path, testCipher()).get(id, options)).toBe(marker)
    const text = await readFile(path, 'utf8')
    for (const secret of [marker, Buffer.from(marker).toString('base64'), 'Secret-Server', 'secret-server', 'secret-login']) expect(text).not.toContain(secret)
    const file = JSON.parse(text)
    expect(file).toMatchObject({ version: 1, entries: [{ profileId: id, binding: expect.stringMatching(/^[0-9a-f]{64}$/), cipher: expect.any(String), savedAt: expect.any(String) }] })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await saved.load()).toEqual({ ids: [id] })
  })
  it('gives the password only to a request with the credentials it was saved with', async () => {
    const { store: saved } = await store()
    const id = randomUUID()
    await saved.set(id, { ...options, advanced: { networkProtocol: 'tcp', serverCertificate: '/certs/server.cer', failoverPartner: 'mirror', packetSize: 4096 } })
    const base: ConnectionOptions = { ...options, password: '', advanced: { networkProtocol: 'tcp', serverCertificate: '/certs/server.cer', failoverPartner: 'mirror', packetSize: 4096 } }
    for (const [name, changed] of [
      ['server', { server: 'evil-server' }], ['username', { username: 'other-login' }], ['authentication', { authentication: 'windows' }],
      ['encrypt optional', { encrypt: 'optional' }], ['encrypt strict', { encrypt: 'strict' }], ['trustServerCertificate', { trustServerCertificate: true }],
      ['hostNameInCertificate', { hostNameInCertificate: 'evil.example' }], ['serverCertificate', { advanced: { ...base.advanced, serverCertificate: '/tmp/evil.cer' } }],
      ['failoverPartner', { advanced: { ...base.advanced, failoverPartner: 'evil-partner' } }], ['networkProtocol', { advanced: { ...base.advanced, networkProtocol: 'np' } }]
    ] as const) expect(await saved.get(id, { ...base, ...changed } as ConnectionOptions), name).toBeUndefined()
    // The database, the name, the color and the other advanced properties do not decide where the password goes.
    for (const changed of [{ database: 'Sales' }, { displayName: 'Production' }, { color: '#abcdef' }, { server: ' SECRET-SERVER.contoso.com ' }, { advanced: { ...base.advanced, packetSize: 8000 } }]) {
      expect(await saved.get(id, { ...base, ...changed })).toBe(marker)
    }
    expect(await saved.get(randomUUID(), base)).toBeUndefined()
  })
  it('binds the password inside its ciphertext, so moving a ciphertext or rewriting a binding hash gets nothing', async () => {
    const { store: saved, path } = await store()
    const prod = randomUUID(), evil = randomUUID()
    const prodOptions: ConnectionOptions = { ...options, server: 'prod-sql', username: 'sa', password: 'prod-secret' }
    const evilOptions: ConnectionOptions = { ...options, server: 'evil-sql', username: 'x', trustServerCertificate: true, encrypt: 'optional', password: 'evil-known' }
    await saved.set(prod, prodOptions)
    await saved.set(evil, evilOptions)
    const file = JSON.parse(await readFile(path, 'utf8'))
    const original = JSON.stringify(file)
    const [first, second] = file.entries
    ;[first.cipher, second.cipher] = [second.cipher, first.cipher]
    await writeFile(path, JSON.stringify(file))
    // A process that can write the file but not use the OS key swapped the two ciphertexts.
    for (const [id, value] of [[evil, evilOptions], [prod, prodOptions]] as const) {
      await expect(new SavedPasswordStore(path, testCipher()).get(id, { ...value, password: '' })).rejects.toThrow(savedPasswordMessages.unreadable)
    }
    // Or it rewrote the prod entry's binding hash for its own server, as Save changes would have.
    const rebound = JSON.parse(original)
    const target = rebound.entries.find((entry: { profileId: string }) => entry.profileId === prod)
    target.binding = createHash('sha256').update(credentialBinding(evilOptions)).digest('hex')
    await writeFile(path, JSON.stringify(rebound))
    await expect(new SavedPasswordStore(path, testCipher()).get(prod, { ...evilOptions, password: '' })).rejects.toThrow(savedPasswordMessages.unreadable)
    await writeFile(path, original)
    expect(await new SavedPasswordStore(path, testCipher()).get(prod, { ...prodOptions, password: '' })).toBe('prod-secret')
  })
  it('keeps one password per server and login: saving one replaces it in every entry with those credentials', async () => {
    const { store: saved } = await store()
    const [a, b, other] = [randomUUID(), randomUUID(), randomUUID()]
    await saved.set(a, { ...options, password: 'old-pass' })
    await saved.set(other, { ...options, username: 'other-login', password: 'other-pass' })
    await saved.set(b, { ...options, database: 'Sales', password: 'new-pass' })
    expect(await saved.get(a, { ...options, password: '' })).toBe('new-pass')
    expect(await saved.get(b, { ...options, password: '' })).toBe('new-pass')
    expect(await saved.get(other, { ...options, username: 'other-login', password: '' })).toBe('other-pass')
  })
  it('reconciles with the library: removed, pruned, re-bound and Windows authentication entries lose their password', async () => {
    const { store: saved, directory } = await store()
    const connections = new ConnectionStore(join(directory, 'connections.json'))
    const kept = (await connections.rememberEntry(options)).id
    const moved = (await connections.rememberEntry({ ...options, database: 'Moved' })).id
    const removed = (await connections.rememberEntry({ ...options, database: 'Removed' })).id
    const pruned = (await connections.rememberEntry({ ...options, database: 'Pruned' })).id
    const integrated = (await connections.save({ options: { ...options, database: 'Integrated' }, favorite: true }))
    const integratedId = integrated.profiles.find(item => item.options.database === 'Integrated')!.id
    for (const id of [kept, moved, removed, pruned, integratedId]) await saved.set(id, options)
    await connections.remove(removed)
    // Save changes moved this entry (a favorite, so it outlives the pruning below) to another login, and that one to
    // Windows authentication.
    await connections.save({ id: moved, options: { ...options, database: 'Moved', username: 'someone-else' }, favorite: true })
    await connections.save({ id: integratedId, options: { ...options, database: 'Integrated', authentication: 'windows' } })
    // 30 newer connections push the oldest out of Recent Connections.
    for (let index = 0; index < 30; index++) await connections.rememberEntry({ ...options, database: 'db' + index })
    const current = (await connections.load()).library
    expect(current.profiles.some(item => item.id === pruned)).toBe(false)
    expect(current.profiles.some(item => item.id === kept)).toBe(false)
    expect(current.profiles.some(item => item.id === moved)).toBe(true)
    expect(current.profiles.some(item => item.id === integratedId)).toBe(true)
    // A favorite with the same credentials keeps its password.
    const pinned = await connections.save({ options: { ...options, database: 'Pinned' }, favorite: true })
    const pinnedId = pinned.profiles.find(item => item.options.database === 'Pinned')!.id
    await saved.set(pinnedId, options)
    expect((await saved.reconcile(() => connections.load().then(value => value.library))).ids).toEqual([pinnedId])
    // A plain library works too, and an unknown id in the file (a crash between the two writes) is swept.
    await saved.set(randomUUID(), options)
    expect((await saved.reconcile(library(profile(pinnedId, options)))).ids).toEqual([pinnedId])
  })
  it('quarantines an invalid file with a fixed warning, and never replaces a directory', async () => {
    const id = randomUUID(), binding = 'a'.repeat(64), savedAt = new Date().toISOString()
    const entry = (patch: Record<string, unknown> = {}) => ({ profileId: randomUUID(), binding, cipher: Buffer.from('x').toString('base64'), savedAt, ...patch })
    for (const content of [
      '{ broken', JSON.stringify({ version: 1, entries: [entry({ cipher: 'A'.repeat(10_928) })] }),
      JSON.stringify({ version: 1, entries: Array.from({ length: 201 }, () => entry()) }),
      JSON.stringify({ version: 1, entries: [entry({ profileId: id }), entry({ profileId: id })] }),
      JSON.stringify({ version: 1, entries: [entry({ server: 'leak' })] }), JSON.stringify({ version: 2, entries: [] })
    ]) {
      const { store: saved, path, directory } = await store()
      await writeFile(path, content)
      const loaded = await saved.load()
      expect(loaded).toEqual({ ids: [], warning: savedPasswordMessages.invalid })
      expect(loaded.warning).not.toContain('leak')
      expect((await readdir(directory)).filter(name => name.includes('.invalid-'))).toHaveLength(1)
    }
    // 200 entries at the 8 KiB ciphertext bound are valid.
    const { store: full, path: fullPath } = await store()
    await writeFile(fullPath, JSON.stringify({ version: 1, entries: Array.from({ length: 200 }, () => entry({ cipher: Buffer.alloc(8192, 1).toString('base64') })) }))
    expect((await full.load()).ids).toHaveLength(200)
    const directory = await folder()
    const blocked = new SavedPasswordStore(directory, testCipher())
    await expect(blocked.load()).rejects.toThrow('regular file')
    await expect(blocked.set(randomUUID(), options)).rejects.toThrow('regular file')
    expect(await readdir(directory)).toEqual([])
  })
  it('keeps an entry whose password cannot be decrypted, re-encrypts a rotated one, and refuses as values what it cannot save', async () => {
    let failDecrypt = false, rotate = false, unavailable = false, huge = false
    const real = testCipher()
    const cipher: SecretCipher = {
      state: async () => unavailable ? { available: false, reason: 'unavailable' } : { available: true },
      encrypt: async text => { if (unavailable) throw new Error('no'); return huge ? Buffer.alloc(8193) : Buffer.concat([await real.encrypt(text), Buffer.from(rotate ? 'v2' : '')]) },
      decrypt: async data => {
        if (failDecrypt) throw new Error('denied ' + marker)
        const v2 = data.subarray(-2).toString() === 'v2'
        return { text: (await real.decrypt(v2 ? data.subarray(0, -2) : data)).text, reEncrypt: !v2 && rotate }
      }
    }
    const { store: saved, path } = await store(cipher)
    const id = randomUUID()
    await saved.set(id, options)
    failDecrypt = true
    await expect(saved.get(id, options)).rejects.toThrow(savedPasswordMessages.unreadable)
    await expect(saved.get(id, options)).rejects.not.toThrow(marker)
    expect((await saved.load()).ids).toEqual([id])
    failDecrypt = false; rotate = true
    const before = JSON.parse(await readFile(path, 'utf8')).entries[0].cipher
    expect(await saved.get(id, options)).toBe(marker)
    const after = JSON.parse(await readFile(path, 'utf8')).entries[0].cipher
    expect(after).not.toBe(before)
    expect(Buffer.from(after, 'base64').subarray(-2).toString()).toBe('v2')
    expect(await saved.get(id, options)).toBe(marker)
    huge = true
    await expect(saved.set(randomUUID(), options)).rejects.toThrow(savedPasswordMessages.notSaved)
    huge = false
    await expect(saved.set(randomUUID(), { ...options, authentication: 'windows' })).rejects.toThrow(savedPasswordMessages.notSaved)
    await expect(saved.set(randomUUID(), { ...options, password: '' })).rejects.toThrow(savedPasswordMessages.notSaved)
    // Unavailable: nothing is read or written, and the file stays as it was.
    unavailable = true
    const content = await readFile(path, 'utf8')
    await expect(saved.set(randomUUID(), options)).rejects.toThrow(savedPasswordMessages.notSaved)
    expect(await saved.get(id, options)).toBeUndefined()
    expect(await saved.load()).toEqual({ ids: [] })
    await saved.forget(id)
    expect(await saved.reconcile(library())).toEqual({ ids: [] })
    expect(await readFile(path, 'utf8')).toBe(content)
  })
  it('forgets by entry and by credentials, and writes no file for nothing', async () => {
    const { store: saved, path, directory } = await store()
    expect(await saved.reconcile(library())).toEqual({ ids: [] })
    await saved.forget(randomUUID())
    expect(await readdir(directory)).toEqual([])
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()]
    await saved.set(a, options); await saved.set(b, { ...options, database: 'Other' }); await saved.set(c, { ...options, username: 'other-login' })
    await saved.forget(a)
    expect((await saved.load()).ids).toEqual([b, c])
    await saved.forgetCredentials({ ...options, database: 'Third' })
    expect((await saved.load()).ids).toEqual([c])
    expect(JSON.parse(await readFile(path, 'utf8')).entries).toHaveLength(1)
  })
})

describe('safeStorage cipher', () => {
  const api = (backend: ReturnType<SafeStorageApi['getSelectedStorageBackend']>, available = true) => ({
    getSelectedStorageBackend: vi.fn(() => backend),
    isAsyncEncryptionAvailable: vi.fn(async () => available),
    // v11: the tag of a key held by the Secret Service or KWallet.
    encryptStringAsync: vi.fn(async (text: string) => Buffer.from('v11' + text)),
    decryptStringAsync: vi.fn(async (data: Buffer) => ({ result: data.toString().slice(3), shouldReEncrypt: false }))
  })
  it('refuses a Linux keyring backend whose keyring cannot be reached, where Electron falls back to its hard-coded key', async () => {
    for (const fallback of ['v10', 'plain', '']) {
      const storage = api('gnome_libsecret')
      storage.encryptStringAsync.mockImplementation(async (text: string) => Buffer.from(fallback + text))
      expect(await safeStorageCipher(storage, 'linux').state(), fallback).toEqual({ available: false, reason: 'no-keyring' })
    }
    const throwing = api('kwallet6')
    throwing.encryptStringAsync.mockRejectedValue(new Error('dbus'))
    expect(await safeStorageCipher(throwing, 'linux').state()).toEqual({ available: false, reason: 'unavailable' })
    // The secret portal's key (v12) is held by the desktop too.
    const portal = api('gnome_libsecret')
    portal.encryptStringAsync.mockImplementation(async (text: string) => Buffer.from('v12' + text))
    expect(await safeStorageCipher(portal, 'linux').state()).toEqual({ available: true })
  })
  it('refuses Linux without a keyring before starting the encryptor', async () => {
    for (const [backend, reason] of [['basic_text', 'no-keyring'], ['unknown', 'unknown-backend']] as const) {
      const storage = api(backend)
      const cipher = safeStorageCipher(storage, 'linux')
      expect(await cipher.state()).toEqual({ available: false, reason })
      await expect(cipher.encrypt(marker)).rejects.toThrow('The operating system could not protect the secret.')
      await expect(cipher.decrypt(Buffer.from('x'))).rejects.toThrow()
      expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled()
      expect(storage.encryptStringAsync).not.toHaveBeenCalled()
    }
  })
  it('uses a Linux keyring the async encryptor can reach, and asks again after a failure', async () => {
    const storage = api('gnome_libsecret')
    const cipher = safeStorageCipher(storage, 'linux')
    expect(await cipher.state()).toEqual({ available: true })
    expect((await cipher.decrypt(await cipher.encrypt(marker))).text).toBe(marker)
    const locked = api('kwallet6', false)
    const refused = safeStorageCipher(locked, 'linux')
    expect(await refused.state()).toEqual({ available: false, reason: 'unavailable' })
    locked.isAsyncEncryptionAvailable.mockResolvedValue(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await refused.state()).toEqual({ available: true })
    expect(locked.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(2)
    // Cached while it works; an encrypt failure (with the OS's own text) is a fixed message, and the next call asks again.
    await refused.state()
    expect(locked.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(2)
    locked.encryptStringAsync.mockRejectedValueOnce(new Error('dbus said ' + marker))
    await expect(refused.encrypt(marker)).rejects.toThrow('The operating system could not protect the secret.')
    await expect(refused.encrypt(marker).then(() => 'ok')).resolves.toBe('ok')
    expect(locked.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(3)
    const throwing = api('kwallet5')
    throwing.isAsyncEncryptionAvailable.mockRejectedValue(new Error('broken'))
    expect(await safeStorageCipher(throwing, 'linux').state()).toEqual({ available: false, reason: 'unavailable' })
  })
  it('answers on Windows and macOS without starting the encryptor, so no Keychain prompt opens with the dialog', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const storage = api('unknown', false)
      const cipher = safeStorageCipher(storage, platform)
      expect(await cipher.state()).toEqual({ available: true })
      expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled()
      expect(storage.getSelectedStorageBackend).not.toHaveBeenCalled()
      storage.decryptStringAsync.mockRejectedValueOnce(new Error('User canceled ' + marker))
      const failure = await cipher.decrypt(Buffer.from('x')).catch(error => error as Error)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe('The operating system could not read the protected secret.')
      storage.decryptStringAsync.mockResolvedValueOnce({ result: marker, shouldReEncrypt: true })
      expect(await cipher.decrypt(Buffer.from('x'))).toEqual({ text: marker, reEncrypt: true })
    }
  })
  it('keeps the test cipher reversible without leaving the plaintext or its base64 in its output', async () => {
    const cipher = testCipher()
    const encrypted = await cipher.encrypt(marker)
    expect(encrypted.toString('latin1')).not.toContain(marker)
    expect(encrypted.toString('base64')).not.toContain(Buffer.from(marker).toString('base64'))
    expect(encrypted.subarray(0, 11).toString()).toBe('varia-test:')
    expect(await cipher.decrypt(encrypted)).toEqual({ text: marker, reEncrypt: false })
    await expect(cipher.decrypt(Buffer.from(marker))).rejects.toThrow()
  })
})

describe('secret storage lint', () => {
  const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : /\.(m?[jt]sx?)$/.test(entry.name) ? [join(directory, entry.name)] : [])
  it('uses safeStorage only in secret-cipher.ts, and only its async API', () => {
    const cipher = join('src', 'main', 'secret-cipher.ts'), main = join('src', 'main', 'index.ts')
    for (const file of sources('src')) {
      const text = readFileSync(file, 'utf8'), name = relative('.', file)
      // Sync calls can block main on a Keychain prompt; isEncryptionAvailable is the sync API's own check.
      expect(text, name).not.toMatch(/\b(?:encryptString|decryptString|isEncryptionAvailable)\s*\(/)
      expect(text, name).not.toMatch(/setUsePlainTextEncryption/)
      if (file === cipher) continue
      const named = text.match(/\bsafeStorage\b/g) ?? []
      // Main only imports it and hands it to the cipher, once.
      if (file === main) {
        expect(named, name).toHaveLength(2)
        expect(text).toMatch(/^import \{[^}]*\bsafeStorage\b[^}]*\} from 'electron'$/m)
        expect(text).toContain("const secretCipher = testSeams && process.env.VARIA_TEST_SAFE_STORAGE === 'test' ? testCipher() : safeStorageCipher(safeStorage, process.platform)")
      } else expect(named, name).toEqual([])
      expect(text, name).not.toMatch(/safeStorage\./)
    }
    expect(readFileSync(cipher, 'utf8')).not.toMatch(/from 'electron'/)
  })
  it('keeps passwords out of connections.json while remembering them beside it', async () => {
    const directory = await folder()
    await mkdir(directory, { recursive: true })
    const connections = new ConnectionStore(join(directory, 'connections.json'))
    const saved = new SavedPasswordStore(join(directory, 'saved-passwords.json'), testCipher())
    const { id } = await connections.rememberEntry(options)
    await saved.set(id, options)
    const text = await readFile(join(directory, 'connections.json'), 'utf8')
    expect(text).not.toContain(marker)
    expect(text).not.toContain('password')
  })
})
