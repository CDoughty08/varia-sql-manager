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

  /** The reference for an absolute path: the one it already has, so picking the same file again names the same saved
   *  connection, else a new one; the oldest is forgotten past 256. */
  register(path: string): string {
    if (!isAbsolute(path)) throw new Error('A key file path must be absolute.')
    for (const [token, known] of this.paths) if (known === path) { this.paths.delete(token); this.paths.set(token, path); return token }
    const token = randomUUID()
    this.paths.set(token, path)
    if (this.paths.size > maxKeyFiles) this.paths.delete(this.paths.keys().next().value!)
    return token
  }

  /** Keeps `path` under a saved entry's reference (the pick token it was saved with), after a restart. */
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
  /** Whether the user confirmed a federation configuration's file source in the Connect dialog (decision 49). Without
   *  it every file source is refused. */
  readonly sourceConfirmed?: (keyPath: string, source: string) => Promise<boolean>
  /** Reads the saved connections, which maps saved key file references back to their paths (a reconnect at startup
   *  may come before anything else has read them). */
  readonly restoreKeyFiles?: () => Promise<unknown>
}

/**
 * A federation configuration's `credential_source.file` as written, or undefined when the file is not a configuration with
 * a file source. Main never resolves or opens it: a link, mount or network path in untrusted content would reach another
 * host before anyone confirmed it; the backend judges the canonical path under its own rules when it reads. Decision 49 shows this path in the dialog
 * and asks before the file's content first goes to Google's STS. A file source main cannot show as one full path (not
 * a string, relative, too long or with a control character) is refused rather than passed on unconfirmed.
 */
export async function federationSource(json: string): Promise<string | undefined> {
  let credentialSource: unknown
  try { credentialSource = (JSON.parse(json) as { credential_source?: unknown } | null)?.credential_source }
  catch { return undefined }
  if (typeof credentialSource !== 'object' || credentialSource === null || !('file' in credentialSource)) return undefined
  const source = (credentialSource as { file: unknown }).file
  // A UNC share or device path (two leading slashes) is refused here too: the dialog shows only a full local path.
  if (typeof source !== 'string' || !source || source.length > 4096 || !isAbsolute(source) || /[\u0000-\u001f\u007f]/.test(source) || /^[\\/]{2}/.test(source))
    throw new BackendError('AUTH_KEY_FILE', "The federation configuration's token file is not a full local path.")
  return source
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
      let path = params.keyFile === undefined ? undefined : this.keyFiles.path(params.keyFile)
      if (path === undefined && params.keyFile !== undefined && this.environment.restoreKeyFiles) {
        await this.environment.restoreKeyFiles()
        path = this.keyFiles.path(params.keyFile)
      }
      if (path === undefined) throw new BackendError('AUTH_KEY_FILE', `${what} is no longer available. Choose it again.`)
      const json = await readCredentialFile(path, { json: true, what })
      if (params.authentication === 'externalAccount') {
        const source = await federationSource(json)
        if (source !== undefined && !await this.environment.sourceConfirmed?.(path, source))
          throw new BackendError('AUTH_KEY_FILE', 'This configuration reads a token file that has not been confirmed. Choose the configuration file again in Connect to review it.')
      }
      return { source: 'file', json }
    }
    const adc = adcFile(this.environment)
    // No gcloud file: ADC's last step is the metadata server, which the backend asks. A file the variable names but
    // Varia cannot use is an error, as it is for ADC itself.
    if (!adc.explicit && !await exists(adc.path)) return { source: 'metadata' }
    return { source: 'adc', json: await readCredentialFile(adc.path, { json: false, what: adc.explicit ? 'The file GOOGLE_APPLICATION_CREDENTIALS names' : 'The gcloud credentials file' }) }
  }
}
