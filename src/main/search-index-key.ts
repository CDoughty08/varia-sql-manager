import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { SecretStorageState } from '../shared/connections'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'
import type { SecretCipher } from './secret-cipher'

export const searchIndexKeyFile = 'search-index-key.json'
export const searchIndexKeyBytes = 32
const fileLimit = 64 * 1024
/** Decoded ciphertext: a 44-character key with its prefix encrypts to far less on every platform. */
const maxCipherBytes = 8192
const keyPrefix = 'varia-search-index:'
const fileSchema = z.object({
  version: z.literal(1),
  /** The data key as the operating system's key store encrypted it. */
  key: z.base64().min(1).max(Math.ceil(maxCipherBytes / 3) * 4).optional(),
  /** 32 random bytes in clear that only name files when the index is kept unencrypted: no secret. */
  names: z.base64().length(44).optional()
}).strict()
type KeyFile = z.infer<typeof fileSchema>

const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => new Promise(resolve => {
  const timer = setTimeout(() => resolve(fallback), ms)
  promise.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(fallback) })
})

class Unanswered extends Error {}

/** What the saved Search Objects index is protected with: the data key; that the system has no key store (`none`, only
 *  for a reason that lasts: no keyring, no backend); or that the key store did not answer or refused for now
 *  (`unanswered`: locked, a prompt nobody answered, a failed write), which says nothing either way. */
export type SearchIndexKey = { kind: 'key'; key: Buffer } | { kind: 'none'; reason: 'no-keyring' | 'unknown-backend' } | { kind: 'unanswered' }

/**
 * The key the saved Search Objects index is encrypted under (docs/object-search.md, Saved index): 32 random bytes made
 * the first time they are needed and kept on disk only as the operating system key store's ciphertext, in their own
 * file beside the saved passwords (atomic, 0600). Only main reads the file or holds the key; it hands the key to each
 * backend in memory (IndexStoreConfig) and never to a renderer.
 *
 * No usable key store means no key: the cipher's own state decides (Electron's encryption unavailable, or Linux's `basic_text`
 * and fallback-key backends), and the file is then neither read nor written, so a keyring missing for one run loses
 * nothing. A file that cannot be parsed, or a ciphertext the key store no longer opens (the keychain was reset), is
 * quarantined like any unreadable preferences file and a new key is made: the index files written under the old key
 * no longer open, and the store's sweep removes them.
 *
 * `names` is a second value for the opt-in unencrypted mode, where there is nothing to encrypt it with: it only keys
 * the hashes that name files, so it is kept in clear.
 */
export class SearchIndexKeyStore {
  private work: Promise<unknown> = Promise.resolve()
  private held: Buffer | undefined
  private heldNames: Buffer | undefined
  private readonly timeoutMs: number
  constructor(private readonly path: string, private readonly cipher: SecretCipher, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  /** Whether the system has a key store to protect the index with. A check the operating system does not answer in
   *  time counts as unavailable for now. */
  storage(): Promise<SecretStorageState> {
    return within(this.cipher.state(), this.timeoutMs, { available: false, reason: 'unavailable' })
  }

  /** The data key: made, encrypted and written on first use, then read back and held for the process. */
  key(): Promise<SearchIndexKey> {
    return this.serial(async () => {
      if (this.held) return { kind: 'key', key: this.held }
      const state = await this.storage()
      // 'unavailable' is a keyring configured but not reachable yet, or a check that timed out: it may answer later.
      if (!state.available) return state.reason === 'no-keyring' || state.reason === 'unknown-backend' ? { kind: 'none', reason: state.reason } : { kind: 'unanswered' }
      try {
        const file = await this.read()
        const opened = file.key ? await this.open(file.key) : undefined
        // A key store that did not answer says nothing about the ciphertext: nothing is made, moved or written.
        if (opened === 'unanswered') return { kind: 'unanswered' }
        if (opened?.key) {
          // The key store rotated its own key: the same data key is stored again under the new one.
          if (opened.reEncrypt) await this.write({ ...file, key: await this.seal(opened.key) }).catch(() => {})
          return { kind: 'key', key: this.held = opened.key }
        }
        const key = randomBytes(searchIndexKeyBytes)
        // Sealed first: a key store that refuses now (a declined Keychain prompt) leaves the file as it is.
        const sealed = await this.seal(key)
        // A ciphertext that no longer opens is kept aside, never overwritten.
        if (file.key) await quarantine(this.path)
        await this.write({ version: 1, key: sealed, ...file.key ? {} : file.names ? { names: file.names } : {} })
        return { kind: 'key', key: this.held = key }
      } catch {
        // The key store or the file refused: nothing was overwritten, and it is asked again later.
        return { kind: 'unanswered' }
      }
    })
  }

  /** The value that names files in the unencrypted mode; undefined when the file could not be read or written. */
  names(): Promise<Buffer | undefined> {
    return this.serial(async () => {
      if (this.heldNames) return this.heldNames
      try {
        const file = await this.read()
        const stored = file.names ? Buffer.from(file.names, 'base64') : undefined
        if (stored?.length === searchIndexKeyBytes) return this.heldNames = stored
        const names = randomBytes(searchIndexKeyBytes)
        await this.write({ ...file, names: names.toString('base64') })
        return this.heldNames = names
      } catch { return undefined }
    })
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.work.then(run)
    this.work = next.catch(() => {})
    return next
  }

  private async read(): Promise<KeyFile> {
    const read = await readJsonFile(this.path, fileLimit)
    if (read.kind === 'missing') return { version: 1 }
    if (read.kind === 'ok') {
      const parsed = fileSchema.safeParse(read.value)
      if (parsed.success) return parsed.data
    }
    await quarantine(this.path)
    return { version: 1 }
  }

  private write(file: KeyFile): Promise<void> {
    return writeJsonAtomic(this.path, fileSchema.parse(file), fileLimit, 'The search index key file is too large.', { mode: 0o600 })
  }

  /** The key store's answer, or a rejection once it has not answered in time (a Keychain prompt nobody answers): a
   *  setting changed meanwhile must still reach the backend. */
  private answered<T>(promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Unanswered()), this.timeoutMs)
      promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
  }

  private async seal(key: Buffer): Promise<string> {
    return (await this.answered(this.cipher.encrypt(keyPrefix + key.toString('base64')))).toString('base64')
  }

  /** The key a ciphertext holds; undefined when it does not open to one, 'unanswered' when the key store did not say. */
  private async open(cipher: string): Promise<{ key: Buffer; reEncrypt: boolean } | 'unanswered' | undefined> {
    try {
      const { text, reEncrypt } = await this.answered(this.cipher.decrypt(Buffer.from(cipher, 'base64')))
      if (!text.startsWith(keyPrefix)) return undefined
      const key = Buffer.from(text.slice(keyPrefix.length), 'base64')
      return key.length === searchIndexKeyBytes ? { key, reEncrypt } : undefined
    } catch (error) { return error instanceof Unanswered ? 'unanswered' : undefined }
  }
}
