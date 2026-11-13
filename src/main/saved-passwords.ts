import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { canRememberPassword, credentialBinding, type ConnectionLibrary, type SecretStorageState } from '../shared/connections'
import type { ConnectionOptions } from '../shared/contracts'
import type { ConnectionCredentialReference } from '../shared/connection-targets'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'
import type { SecretCipher } from './secret-cipher'

const fileLimit = 4 * 1024 * 1024
const maxEntries = 200
/** Decoded ciphertext; a 1,024-character password encrypts to far less on every platform. */
export const maxCipherBytes = 8192
const entrySchema = z.object({
  profileId: z.uuid(), revision: z.uuid().optional(), binding: z.string().regex(/^[0-9a-f]{64}$/), cipher: z.base64().max(Math.ceil(maxCipherBytes / 3) * 4), savedAt: z.iso.datetime()
}).strict()
const fileSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(maxEntries) }).strict()
  .refine(value => new Set(value.entries.map(entry => entry.profileId)).size === value.entries.length, 'Duplicate saved password IDs.')
type SavedPasswordFile = z.infer<typeof fileSchema>
type Entry = SavedPasswordFile['entries'][number]

export const savedPasswordMessages = {
  invalid: 'The saved passwords file was invalid, so the saved passwords were removed. Its original file was preserved.',
  unreadable: 'The saved password could not be read. Enter the password.',
  notSaved: 'The password could not be saved.'
} as const

/** The file holds a hash of the binding, so neither the server nor the login is stored in clear beside the ciphertext. */
const bindingHash = (options: Omit<ConnectionOptions, 'password'>) => createHash('sha256').update(credentialBinding(options)).digest('hex')
/**
 * What is encrypted: a check over the binding and the password, then the password. The outer hash is plain JSON that a
 * process able to write the file (but not to use the OS key) could rewrite, or it could swap ciphertexts between entries;
 * the check, inside the ciphertext, still refuses a password for any other credentials. It covers the password too because
 * the Keychain's and the Linux keyring's encryption (AES-CBC) has no integrity check of its own, so spliced blocks must not
 * be able to keep it valid.
 */
const sealCheck = (options: Omit<ConnectionOptions, 'password'>, password: string, revision?: string) => createHash('sha256').update(JSON.stringify([credentialBinding(options), password, ...revision ? [revision] : []])).digest('hex')
const checkLength = 64
const seal = (options: Omit<ConnectionOptions, 'password'>, password: string, revision: string) => sealCheck(options, password, revision) + password
function unseal(text: string, options: Omit<ConnectionOptions, 'password'>, revision?: string): string {
  const check = Buffer.from(text.slice(0, checkLength)), password = text.slice(checkLength)
  const expected = Buffer.from(sealCheck(options, password, revision))
  if (!password || check.length !== expected.length || !timingSafeEqual(check, expected)) throw new Error(savedPasswordMessages.unreadable)
  return password
}
/** The library to reconcile against; a loader answers null when the library could not be read (it was quarantined), and then
 *  nothing is pruned. */
type LibrarySource = ConnectionLibrary | (() => Promise<ConnectionLibrary | null>)

/**
 * Remembered passwords, as OS-protected ciphertext in their own file (never connections.json), keyed by the history
 * entry's id and bound to the credentials they were saved with. Only main reads it. While the cipher is unavailable the
 * file is neither read nor written, so a keyring that is missing for one run loses nothing.
 */
export class SavedPasswordStore {
  private writes: Promise<unknown> = Promise.resolve()
  private secrets: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string, private readonly cipher: SecretCipher) {}
  state(): Promise<SecretStorageState> { return this.cipher.state() }
  private async read(): Promise<{ file: SavedPasswordFile; exists: boolean; warning?: string }> {
    const read = await readJsonFile(this.path, fileLimit)
    if (read.kind === 'missing') return { file: { version: 1, entries: [] }, exists: false }
    if (read.kind === 'ok') {
      const parsed = fileSchema.safeParse(read.value)
      if (parsed.success) return { file: parsed.data, exists: true }
    }
    await quarantine(this.path)
    return { file: { version: 1, entries: [] }, exists: false, warning: savedPasswordMessages.invalid }
  }
  /** Runs `update` on the file in order with every other change, and writes it only when `update` changed something. */
  private change<T>(update: (entries: Entry[]) => Promise<{ entries: Entry[]; value: T }> | { entries: Entry[]; value: T }): Promise<{ ids: string[]; value: T; warning?: string }> {
    const next = this.writes.then(async () => {
      const { file, exists, warning } = await this.read()
      const before = JSON.stringify(file.entries)
      const { entries, value } = await update(file.entries.slice())
      const after = fileSchema.parse({ version: 1, entries })
      if (JSON.stringify(after.entries) !== before && (exists || after.entries.length)) {
        await writeJsonAtomic(this.path, after, fileLimit, 'Too many saved passwords.', { mode: 0o600 })
      }
      return { ids: after.entries.map(entry => entry.profileId), value, ...(warning ? { warning } : {}) }
    })
    this.writes = next.catch(() => {})
    return next
  }
  private async available(): Promise<boolean> { return (await this.cipher.state()).available }
  /** An explicit Forget must report unavailable storage rather than claim ciphertext was removed. Main only. */
  async storageAvailable(): Promise<boolean> { return this.available() }
  /** The ids of the entries with a remembered password. Never decrypts. */
  async load(): Promise<{ ids: string[]; warning?: string }> {
    if (!await this.available()) return { ids: [] }
    const { ids, warning } = await this.change(entries => ({ entries, value: undefined }))
    return { ids, ...(warning ? { warning } : {}) }
  }
  /**
   * Remembers `options.password` for the entry `profileId`, replacing what it had, and in every other entry with the
   * same credentials: the dialog uses any of them for those credentials, so none may keep an older password to replay.
   */
  private secret<T>(work: () => Promise<T>): Promise<T> {
    const next = this.secrets.then(work)
    this.secrets = next.catch(() => {})
    return next
  }
  async set(profileId: string, options: ConnectionOptions): Promise<void> {
    return this.secret(() => this.setSecret(profileId, options))
  }
  private async setSecret(profileId: string, options: ConnectionOptions): Promise<void> {
    const password = options.password
    if (!canRememberPassword(options.authentication) || !password || !await this.available()) throw new Error(savedPasswordMessages.notSaved)
    let cipher: Buffer
    let revision: string = randomUUID()
    const binding = bindingHash(options)
    const { value: previous } = await this.change(entries => ({ entries, value: entries.find(item => item.binding === binding && item.revision) }))
    let unchanged = false
    if (previous?.revision) {
      try {
        const original = unseal((await this.cipher.decrypt(Buffer.from(previous.cipher, 'base64'))).text, options, previous.revision)
        const before = Buffer.from(original), after = Buffer.from(password)
        unchanged = before.length === after.length && timingSafeEqual(before, after)
        if (unchanged) revision = previous.revision
      } catch { /* An explicit replacement can recover a credential encrypted under an older unavailable key. */ }
    }
    try { cipher = unchanged ? Buffer.from(previous!.cipher, 'base64') : await this.cipher.encrypt(seal(options, password, revision)) } catch { throw new Error(savedPasswordMessages.notSaved) }
    if (cipher.length > maxCipherBytes) throw new Error(savedPasswordMessages.notSaved)
    const entry: Entry = { profileId: z.uuid().parse(profileId), revision, binding, cipher: cipher.toString('base64'), savedAt: new Date().toISOString() }
    await this.change(entries => {
      const others = entries.filter(item => item.profileId !== profileId).map(item => item.binding === entry.binding ? { ...item, revision: entry.revision, cipher: entry.cipher, savedAt: entry.savedAt } : item)
      if (others.length >= maxEntries) throw new Error(savedPasswordMessages.notSaved)
      return { entries: [...others, entry], value: undefined }
    })
  }
  /**
   * The password remembered for `profileId`, only when `options` has the credentials it was saved with: a request for
   * another server, login or certificate check gets nothing. A password that cannot be decrypted (a Keychain prompt
   * denied, a reset keyring) is a failure, and its entry stays.
   */
  async get(profileId: string, options: ConnectionOptions): Promise<string | undefined> {
    return this.secret(() => this.getSecret(profileId, options))
  }
  /** An old entry without a revision remains available to the picker, never to a restored target. */
  async reference(profileId: string, options: ConnectionOptions): Promise<ConnectionCredentialReference | undefined> {
    if (!canRememberPassword(options.authentication) || !await this.available()) return undefined
    const { value: entry } = await this.change(entries => ({ entries, value: entries.find(item => item.profileId === profileId && item.binding === bindingHash(options)) }))
    return entry?.revision ? { profileId, revision: entry.revision } : undefined
  }
  async getReferenced(reference: ConnectionCredentialReference, options: ConnectionOptions): Promise<string | undefined> {
    return this.secret(() => this.getSecret(reference.profileId, options, reference.revision))
  }
  private async getSecret(profileId: string, options: ConnectionOptions, revision?: string): Promise<string | undefined> {
    if (!canRememberPassword(options.authentication) || !await this.available()) return undefined
    // Looked up in turn with the writes; the decrypt, which may wait for a Keychain prompt, holds none of them.
    const { value: entry } = await this.change(entries => ({ entries, value: entries.find(item => item.profileId === profileId) }))
    if (!entry || entry.binding !== bindingHash(options) || revision !== undefined && entry.revision !== revision) return undefined
    let decrypted: { text: string; reEncrypt: boolean }
    try { decrypted = await this.cipher.decrypt(Buffer.from(entry.cipher, 'base64')) } catch { throw new Error(savedPasswordMessages.unreadable) }
    const password = unseal(decrypted.text, options, entry.revision)
    if (decrypted.reEncrypt) {
      // The key was rotated: store the password under the new one. Failing that, the old ciphertext still decrypts.
      try {
        const cipher = await this.cipher.encrypt(decrypted.text)
        if (cipher.length <= maxCipherBytes) {
          // Every entry that shares this ciphertext (the same credentials) moves to the new one.
          await this.change(entries => ({ entries: entries.map(item => item.cipher === entry.cipher ? { ...item, cipher: cipher.toString('base64') } : item), value: undefined }))
        }
      } catch { /* Kept as it was. */ }
    }
    return password
  }
  async forget(...profileIds: string[]): Promise<void> {
    if (!profileIds.length || !await this.available()) return
    const forgotten = new Set(profileIds)
    await this.change(entries => ({ entries: entries.filter(item => !forgotten.has(item.profileId)), value: undefined }))
  }
  /** Forgets every password remembered for these credentials, whichever entry holds it: SQL Server rejected it. */
  async forgetCredentials(options: Omit<ConnectionOptions, 'password'>): Promise<void> {
    if (!await this.available()) return
    const binding = bindingHash(options)
    await this.change(entries => ({ entries: entries.filter(item => item.binding !== binding), value: undefined }))
  }
  /** An older failed attempt cannot erase a replacement saved while it was connecting. */
  async forgetRejected(reference: ConnectionCredentialReference, options: Omit<ConnectionOptions, 'password'>): Promise<void> {
    if (!await this.available()) return
    const binding = bindingHash(options)
    await this.change(entries => ({ entries: entries.filter(item => item.binding !== binding || item.revision !== reference.revision), value: undefined }))
  }
  /**
   * Drops the passwords whose entry is gone (removed, or pruned from history), whose entry now points elsewhere (Save
   * changes moved its server or login), or whose authentication cannot remember one; it sweeps orphans a crash left
   * between the two files' writes too. Never decrypts. Pass a loader so the library is read in turn with this store's
   * writes: a library read earlier could miss an entry whose password was saved since, and drop it.
   */
  async reconcile(source: LibrarySource): Promise<{ ids: string[]; warning?: string }> {
    if (!await this.available()) return { ids: [] }
    const { ids, warning } = await this.change(async entries => {
      const library = typeof source === 'function' ? await source() : source
      // An unreadable library is not an empty one: its entries' passwords stay for when the user restores the file.
      if (!library) return { entries, value: undefined }
      const bindings = new Map(library.profiles.filter(profile => canRememberPassword(profile.options.authentication)).map(profile => [profile.id, bindingHash(profile.options)]))
      return { entries: entries.filter(item => bindings.get(item.profileId) === item.binding), value: undefined }
    })
    return { ids, ...(warning ? { warning } : {}) }
  }
}
