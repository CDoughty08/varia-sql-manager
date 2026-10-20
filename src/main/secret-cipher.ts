import type { SecretStorageState } from '../shared/connections'

/**
 * The operating system's protection for secrets Varia keeps on disk: DPAPI on Windows, the Keychain on macOS, the Secret
 * Service or KWallet on Linux. The only module that uses Electron's safeStorage, and only its async API: the sync calls
 * can block main on a Keychain prompt, which would freeze IPC and the backend's liveness timers.
 *
 * Errors carry fixed messages, never the text, the ciphertext or the operating system's error. The cipher bounds
 * nothing; each store bounds its own data.
 */
export interface SecretCipher {
  state(): Promise<SecretStorageState>
  encrypt(text: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<{ text: string; reEncrypt: boolean }>
}
export type SafeStorageApi = Pick<Electron.SafeStorage, 'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync' | 'getSelectedStorageBackend'>

const unavailable = 'The operating system could not protect the secret.'
const unreadable = 'The operating system could not read the protected secret.'

/** Call state() only once the app is ready: before that, Linux reports no backend. */
export function safeStorageCipher(storage: SafeStorageApi, platform: NodeJS.Platform): SecretCipher {
  let known: Promise<SecretStorageState> | undefined
  const check = async (): Promise<SecretStorageState> => {
    // Windows and macOS answer without starting the encryptor, so opening the Connect dialog never asks for the Keychain.
    if (platform === 'win32' || platform === 'darwin') return { available: true }
    if (platform === 'linux') {
      const backend = storage.getSelectedStorageBackend()
      // basic_text encrypts with a key hard-coded in Chromium, which protects nothing.
      if (backend === 'basic_text') return { available: false, reason: 'no-keyring' }
      if (backend === 'unknown') return { available: false, reason: 'unknown-backend' }
    }
    try { return await storage.isAsyncEncryptionAvailable() ? { available: true } : { available: false, reason: 'unavailable' } }
    catch { return { available: false, reason: 'unavailable' } }
  }
  const state = (): Promise<SecretStorageState> => {
    known ??= check()
    // A keyring that was locked or not yet running may be there later: Linux asks again rather than keep the answer.
    if (platform === 'linux') void known.then(value => { if (!value.available) known = undefined })
    return known
  }
  const failed = () => { if (platform === 'linux') known = undefined }
  return {
    state,
    async encrypt(text) {
      if (!(await state()).available) throw new Error(unavailable)
      try { return await storage.encryptStringAsync(text) } catch { failed(); throw new Error(unavailable) }
    },
    async decrypt(data) {
      if (!(await state()).available) throw new Error(unreadable)
      try {
        const { result, shouldReEncrypt } = await storage.decryptStringAsync(data)
        return { text: result, reEncrypt: shouldReEncrypt }
      } catch { failed(); throw new Error(unreadable) }
    }
  }
}

const testPrefix = Buffer.from('varia-test:')
/**
 * A reversible stand-in for smoke runs on machines without a keyring (VARIA_TEST_SAFE_STORAGE=test, unpackaged smoke
 * runs only). It protects nothing; it only keeps the plaintext and its base64 out of the file, as the real one does.
 */
export function testCipher(): SecretCipher {
  const flip = (bytes: Uint8Array) => Buffer.from(bytes.map(byte => byte ^ 0x5a))
  return {
    state: async () => ({ available: true }),
    encrypt: async text => Buffer.concat([testPrefix, flip(Buffer.from(text, 'utf8'))]),
    async decrypt(data) {
      if (data.length < testPrefix.length || !data.subarray(0, testPrefix.length).equals(testPrefix)) throw new Error(unreadable)
      return { text: flip(data.subarray(testPrefix.length)).toString('utf8'), reEncrypt: false }
    }
  }
}
