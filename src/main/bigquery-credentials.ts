import { randomUUID } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import type { BigQueryCredentialMaterial, BigQueryCredentialParams } from '../shared/contracts'
import { usesKeyFile } from '../shared/auth'
import { BackendError } from './backend/errors'

/** The largest key, configuration or ADC file main reads (BigQueryLimits.CredentialBytes in C#). */
export const maxCredentialBytes = 64 * 1024
const maxKeyFiles = 256

/**
 * The key and federation configuration files the renderer may name, by opaque reference (docs/bigquery.md,
 * Authentication): main keeps the path behind a token, so the renderer never sends or sees a path. The picker
 * (connections.pickKeyFile) and saved profiles register paths here; a forgotten token answers AUTH_KEY_FILE.
 */
export class BigQueryKeyFiles {
  private readonly paths = new Map<string, string>()

  /** A new reference for an absolute path; the oldest is forgotten past 256. */
  register(path: string): string {
    if (!isAbsolute(path)) throw new Error('A key file path must be absolute.')
    const token = randomUUID()
    this.paths.set(token, path)
    if (this.paths.size > maxKeyFiles) this.paths.delete(this.paths.keys().next().value!)
    return token
  }

  /** Keeps `path` under a saved profile's id (its reference from then on). */
  remember(reference: string, path: string): void {
    if (!isAbsolute(path)) throw new Error('A key file path must be absolute.')
    this.paths.delete(reference)
    this.paths.set(reference, path)
    if (this.paths.size > maxKeyFiles) this.paths.delete(this.paths.keys().next().value!)
  }

  forget(reference: string): void { this.paths.delete(reference) }
  path(reference: string): string | undefined { return this.paths.get(reference) }
}

const unreadable = (what: string) => new BackendError('AUTH_KEY_FILE', `${what} could not be read. Choose it again.`)

/**
 * Reads a credential file under main's rules: an absolute path to a regular file (after links) of at most 64 KiB, and,
 * for a picked key or configuration file, named `.json`. Its content goes only to the backend, in a sensitive request;
 * no message names its path or content.
 */
export async function readCredentialFile(path: string, options: { json: boolean; what: string }): Promise<string> {
  // A UNC share or device path: opening one sends the user's Windows credentials to that host, or reads a device.
  if (/^[\\/]{2}/.test(path)) throw new BackendError('AUTH_KEY_FILE', `${options.what} must be on a local disk.`)
  if (!isAbsolute(path)) throw unreadable(options.what)
  if (options.json && extname(path).toLowerCase() !== '.json') throw new BackendError('AUTH_KEY_FILE', `${options.what} must be a .json file.`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const resolved = await realpath(path)
    if (/^[\\/]{2}/.test(resolved)) throw new BackendError('AUTH_KEY_FILE', `${options.what} must be on a local disk.`)
    // Check the type before opening: opening a FIFO waits for a writer.
    if (!(await stat(resolved)).isFile()) throw new BackendError('AUTH_KEY_FILE', `${options.what} is not a file.`)
    handle = await open(resolved, 'r')
    const opened = await handle.stat()
    if (!opened.isFile()) throw new BackendError('AUTH_KEY_FILE', `${options.what} is not a file.`)
    if (opened.size > maxCredentialBytes) throw new BackendError('AUTH_KEY_FILE', `${options.what} is larger than 64 KiB, so it is not a Google credential file.`)
    // Read at most one byte past the limit: the file may grow after stat.
    const buffer = Buffer.alloc(maxCredentialBytes + 1)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    if (read > maxCredentialBytes) throw new BackendError('AUTH_KEY_FILE', `${options.what} is larger than 64 KiB, so it is not a Google credential file.`)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, read))
    if (text.trim().length === 0) throw new BackendError('AUTH_KEY_FILE', `${options.what} is empty.`)
    return text
  } catch (error) {
    if (error instanceof BackendError) throw error
    throw unreadable(options.what)
  } finally { await handle?.close().catch(() => {}) }
}

export interface BigQueryCredentialEnvironment {
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly home: string
  /** Emulator mode (VARIA_TEST_BIGQUERY_ENDPOINT in an unpackaged build): anonymous credentials, no Google token. */
  readonly emulator: boolean
}

/**
 * Where Application Default Credentials come from, in ADC's order: GOOGLE_APPLICATION_CREDENTIALS, then the file
 * `gcloud auth application-default login` writes (under CLOUDSDK_CONFIG when set). `explicit` says the variable named it.
 */
export function adcFile(environment: Pick<BigQueryCredentialEnvironment, 'env' | 'platform' | 'home'>): { path: string; explicit: boolean } {
  const named = environment.env.GOOGLE_APPLICATION_CREDENTIALS
  if (named) return { path: named, explicit: true }
  const config = environment.env.CLOUDSDK_CONFIG || (environment.platform === 'win32'
    ? join(environment.env.APPDATA || join(environment.home, 'AppData', 'Roaming'), 'gcloud')
    : join(environment.home, '.config', 'gcloud'))
  return { path: join(config, 'application_default_credentials.json'), explicit: false }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR' }
}

/**
 * The credential material for a BigQuery request (docs/bigquery.md, Authentication). Main finds and reads the files;
 * the backend checks their type and every URL they name, and signs in. Emulator mode sends anonymous material only.
 */
export class BigQueryCredentials {
  constructor(private readonly keyFiles: BigQueryKeyFiles, private readonly environment: BigQueryCredentialEnvironment) {}

  get emulator(): boolean { return this.environment.emulator }

  async material(params: Pick<BigQueryCredentialParams, 'authentication' | 'keyFile'>): Promise<BigQueryCredentialMaterial> {
    if (this.environment.emulator) return { source: 'anonymous' }
    if (usesKeyFile(params.authentication)) {
      const what = params.authentication === 'serviceAccountKey' ? 'The key file' : 'The federation configuration file'
      const path = params.keyFile === undefined ? undefined : this.keyFiles.path(params.keyFile)
      if (path === undefined) throw new BackendError('AUTH_KEY_FILE', `${what} is no longer available. Choose it again.`)
      return { source: 'file', json: await readCredentialFile(path, { json: true, what }) }
    }
    const adc = adcFile(this.environment)
    // No gcloud file: ADC's last step is the metadata server, which the backend asks. A file the variable names but
    // Varia cannot use is an error, as it is for ADC itself.
    if (!adc.explicit && !await exists(adc.path)) return { source: 'metadata' }
    return { source: 'adc', json: await readCredentialFile(adc.path, { json: false, what: adc.explicit ? 'The file GOOGLE_APPLICATION_CREDENTIALS names' : 'The gcloud credentials file' }) }
  }
}
