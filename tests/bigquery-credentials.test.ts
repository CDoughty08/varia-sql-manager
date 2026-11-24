import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adcFile, BigQueryCredentials, BigQueryKeyFiles, maxCredentialBytes, readCredentialFile } from '../src/main/bigquery-credentials'
import { backendSpawnSpec, bigQueryEmulatorEndpoint, bigQueryEmulatorStorageEndpoint } from '../src/main/backend/spawn-spec'
import { validateRequest, validateResult } from '../src/main/validation'
import { BackendError } from '../src/main/backend/errors'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'varia-bigquery-'))
  directories.push(directory)
  return directory
}
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await promise } catch (error) { if (error instanceof BackendError) return { code: error.code, message: error.message }; throw error }
  throw new Error('Expected a refusal.')
}
const secret = 'do-not-echo-this-secret'
const userFile = JSON.stringify({ type: 'authorized_user', client_id: 'id', client_secret: secret, refresh_token: '1//' + secret })

describe('BigQuery credential material (main)', () => {
  it('keeps key file paths behind opaque references, at most 256 of them', () => {
    const files = new BigQueryKeyFiles()
    const first = files.register(resolve('keys', 'sa.json'))
    expect(first).toMatch(/^[\da-f-]{36}$/)
    expect(files.path(first)).toBe(resolve('keys', 'sa.json'))
    expect(() => files.register('keys/sa.json')).toThrow()
    for (let index = 0; index < 256; index++) files.register(resolve('keys', `${index}.json`))
    expect(files.path(first)).toBeUndefined()
    const profile = '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f'
    files.remember(profile, resolve('keys', 'saved.json'))
    expect(files.path(profile)).toBe(resolve('keys', 'saved.json'))
    files.forget(profile)
    expect(files.path(profile)).toBeUndefined()
  })

  it('reads only a regular .json file of at most 64 KiB, and no refusal names the path or the content', async () => {
    const directory = await folder()
    const ok = join(directory, 'sa.json')
    await writeFile(ok, userFile)
    expect(await readCredentialFile(ok, { json: true, what: 'The key file' })).toBe(userFile)
    const cases: [string, string | Buffer | undefined, string][] = [
      ['key.txt', userFile, 'must be a .json file'],
      ['big.json', '{"a":"' + 'x'.repeat(maxCredentialBytes) + '"}', 'larger than 64 KiB'],
      ['empty.json', '  \n', 'is empty'],
      ['latin1.json', Buffer.from([0x7b, 0xe9, 0x7d]), 'could not be read'],
      ['missing.json', undefined, 'could not be read']
    ]
    for (const [name, content, text] of cases) {
      const path = join(directory, name)
      if (content !== undefined) await writeFile(path, content)
      const outcome = await refusal(readCredentialFile(path, { json: true, what: 'The key file' }))
      expect(outcome.code, name).toBe('AUTH_KEY_FILE')
      expect(outcome.message, name).toContain(text)
      expect(outcome.message).not.toContain(directory)
      expect(outcome.message).not.toContain(secret)
    }
    await mkdir(join(directory, 'folder.json'))
    expect(await refusal(readCredentialFile(join(directory, 'folder.json'), { json: true, what: 'The key file' }))).toMatchObject({ code: 'AUTH_KEY_FILE' })
    expect(await refusal(readCredentialFile('relative.json', { json: true, what: 'The key file' }))).toMatchObject({ code: 'AUTH_KEY_FILE' })
    // The ADC file need not be named .json (GOOGLE_APPLICATION_CREDENTIALS may name any file).
    await writeFile(join(directory, 'adc'), userFile)
    expect(await readCredentialFile(join(directory, 'adc'), { json: false, what: 'The ADC file' })).toBe(userFile)
  })

  it('reads a key file saved with a byte order mark as the same credential', async () => {
    const directory = await folder()
    const path = join(directory, 'bom.json')
    await writeFile(path, '﻿' + userFile)
    expect(await readCredentialFile(path, { json: true, what: 'The key file' })).toBe(userFile)
  })

  it('refuses UNC shares and device paths unopened, and a FIFO without waiting for a writer', async () => {
    for (const path of ['\\\\files.example.com\\share\\key.json', '//files.example.com/share/key.json', '\\\\?\\C:\\key.json', '\\\\.\\pipe\\key.json']) {
      const outcome = await refusal(readCredentialFile(path, { json: true, what: 'The key file' }))
      expect(outcome).toMatchObject({ code: 'AUTH_KEY_FILE', message: 'The key file must be on a local disk.' })
    }
    if (process.platform === 'win32') return
    const directory = await folder()
    const fifo = join(directory, 'fifo.json')
    execFileSync('mkfifo', [fifo])
    expect(await refusal(readCredentialFile(fifo, { json: true, what: 'The key file' }))).toMatchObject({ code: 'AUTH_KEY_FILE', message: 'The key file is not a file.' })
  })

  it('finds Application Default Credentials in ADC\'s order', () => {
    expect(adcFile({ env: { GOOGLE_APPLICATION_CREDENTIALS: '/keys/adc.json', CLOUDSDK_CONFIG: '/gc' }, platform: 'linux', home: '/home/ada' })).toEqual({ path: '/keys/adc.json', explicit: true })
    expect(adcFile({ env: { CLOUDSDK_CONFIG: '/gc' }, platform: 'linux', home: '/home/ada' })).toEqual({ path: join('/gc', 'application_default_credentials.json'), explicit: false })
    expect(adcFile({ env: {}, platform: 'linux', home: '/home/ada' }).path).toBe(join('/home/ada', '.config', 'gcloud', 'application_default_credentials.json'))
    expect(adcFile({ env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\ada' }).path).toBe(join('C:\\Users\\ada\\AppData\\Roaming', 'gcloud', 'application_default_credentials.json'))
  })

  it('sends the ADC file, the metadata server when there is none, a picked key file by reference, and only anonymous material to the emulator', async () => {
    const directory = await folder()
    const files = new BigQueryKeyFiles()
    const environment = { env: { CLOUDSDK_CONFIG: directory }, platform: process.platform, home: directory, emulator: false }
    const credentials = new BigQueryCredentials(files, environment)
    expect(await credentials.material({ authentication: 'gcloud' })).toEqual({ source: 'metadata' })
    await writeFile(join(directory, 'application_default_credentials.json'), userFile)
    expect(await credentials.material({ authentication: 'gcloud' })).toEqual({ source: 'adc', json: userFile })
    // A file the variable names but that cannot be read is an error, as it is for ADC itself, not a fall back to the metadata server.
    const named = new BigQueryCredentials(files, { ...environment, env: { GOOGLE_APPLICATION_CREDENTIALS: join(directory, 'gone.json') } })
    expect(await refusal(named.material({ authentication: 'gcloud' }))).toMatchObject({ code: 'AUTH_KEY_FILE', message: expect.stringContaining('GOOGLE_APPLICATION_CREDENTIALS') })
    const key = join(directory, 'sa.json')
    await writeFile(key, '{"type":"service_account"}')
    const token = files.register(key)
    expect(await credentials.material({ authentication: 'serviceAccountKey', keyFile: token })).toEqual({ source: 'file', json: '{"type":"service_account"}' })
    expect(await refusal(credentials.material({ authentication: 'externalAccount', keyFile: '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f' })))
      .toEqual({ code: 'AUTH_KEY_FILE', message: 'The federation configuration file is no longer available. Choose it again.' })
    const emulator = new BigQueryCredentials(files, { ...environment, emulator: true })
    expect(await emulator.material({ authentication: 'serviceAccountKey', keyFile: token })).toEqual({ source: 'anonymous' })
    expect(await emulator.material({ authentication: 'gcloud' })).toEqual({ source: 'anonymous' })
  })

  it('asks once about the token file a gcloud ADC federation configuration reads, and refuses it unasked in the background', async () => {
    const directory = await folder()
    const token = join(directory, 'token.txt'), adc = join(directory, 'application_default_credentials.json')
    const federation = JSON.stringify({ type: 'external_account', audience: '//iam.googleapis.com/x', subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_url: 'https://sts.googleapis.com/v1/token', credential_source: { file: token } })
    await writeFile(adc, federation)
    const confirmed = new Set<string>()
    const askSource = vi.fn(async (keyPath: string, source: string) => { confirmed.add(`${keyPath}|${source}`); return true })
    const environment = { env: { CLOUDSDK_CONFIG: directory }, platform: process.platform, home: directory, emulator: false,
      sourceConfirmed: async (keyPath: string, source: string) => confirmed.has(`${keyPath}|${source}`), askSource }
    const credentials = new BigQueryCredentials(new BigQueryKeyFiles(), environment)
    // A background reconnect cannot ask: refused, and nothing is asked.
    expect(await refusal(credentials.material({ authentication: 'gcloud' }))).toMatchObject({ code: 'AUTH_KEY_FILE', message: expect.stringContaining('token file') })
    expect(askSource).not.toHaveBeenCalled()
    // A Connect asks, naming the ADC file and its token file; Use It is remembered, so the next request asks nothing.
    expect(await credentials.material({ authentication: 'gcloud' }, { interactive: true })).toEqual({ source: 'adc', json: federation })
    expect(askSource).toHaveBeenCalledExactlyOnceWith(adc, token)
    expect(await credentials.material({ authentication: 'gcloud' })).toEqual({ source: 'adc', json: federation })
    expect(askSource).toHaveBeenCalledTimes(1)
    // Cancel refuses the sign-in; an ADC file without a file source (gcloud's user credentials) asks nothing.
    askSource.mockClear()
    confirmed.clear()
    askSource.mockResolvedValueOnce(false)
    expect(await refusal(credentials.material({ authentication: 'gcloud' }, { interactive: true }))).toMatchObject({ code: 'AUTH_KEY_FILE' })
    await writeFile(adc, userFile)
    expect(await credentials.material({ authentication: 'gcloud' }, { interactive: true })).toEqual({ source: 'adc', json: userFile })
    expect(askSource).toHaveBeenCalledTimes(1)
  })

  it('honours VARIA_TEST_BIGQUERY_ENDPOINT only in unpackaged builds and only as a loopback http address', () => {
    expect(bigQueryEmulatorEndpoint({ packaged: false, env: { VARIA_TEST_BIGQUERY_ENDPOINT: 'http://localhost:9050' } })).toBe('http://localhost:9050/')
    expect(bigQueryEmulatorEndpoint({ packaged: false, env: { VARIA_TEST_BIGQUERY_ENDPOINT: 'http://127.0.0.1:9050/' } })).toBe('http://127.0.0.1:9050/')
    expect(bigQueryEmulatorEndpoint({ packaged: true, env: { VARIA_TEST_BIGQUERY_ENDPOINT: 'http://localhost:9050' } })).toBeUndefined()
    for (const value of ['https://localhost:9050', 'http://emulator.example.com:9050', 'http://localhost:9050/bigquery', 'http://user:pw@localhost:9050', 'localhost:9050', 'http://localhost:9050/?x=1', 'http://localhost:9050/?', 'http://localhost:9050/#', 'http://localhost:9050#'])
      expect(bigQueryEmulatorEndpoint({ packaged: false, env: { VARIA_TEST_BIGQUERY_ENDPOINT: value } }), value).toBeUndefined()
    const base = { root: resolve('app'), resourcesPath: resolve('resources'), platform: process.platform, smokeTest: false }
    const env = { PATH: '/bin', VARIA_TEST_BIGQUERY_ENDPOINT: 'http://localhost:9050' }
    expect(backendSpawnSpec({ ...base, packaged: false, env }).env?.VARIA_TEST_BIGQUERY_ENDPOINT).toBe('http://localhost:9050/')
    expect(backendSpawnSpec({ ...base, packaged: false, smokeTest: true, env }).env?.VARIA_TEST_BIGQUERY_ENDPOINT).toBe('http://localhost:9050/')
    expect(Object.keys(backendSpawnSpec({ ...base, packaged: true, env: { PATH: '/bin', varia_test_bigquery_endpoint: 'http://localhost:9050' } }).env ?? {}).map(name => name.toUpperCase())).not.toContain('VARIA_TEST_BIGQUERY_ENDPOINT')
    // The backend learns Varia's own folder from main alone, so no federation file source can be read from it.
    expect(backendSpawnSpec({ ...base, packaged: true, env: { PATH: '/bin', VARIA_USER_DATA: '/elsewhere' }, userData: resolve('profile') }).env?.VARIA_USER_DATA).toBe(resolve('profile'))
    expect(backendSpawnSpec({ ...base, packaged: false, env: { PATH: '/bin', VARIA_USER_DATA: '/elsewhere' } }).env?.VARIA_USER_DATA).toBeUndefined()
    // An address the backend would refuse to start with never reaches it.
    expect(backendSpawnSpec({ ...base, packaged: false, env: { PATH: '/bin', VARIA_TEST_BIGQUERY_ENDPOINT: 'http://emulator.example.com:9050' } }).env?.VARIA_TEST_BIGQUERY_ENDPOINT).toBeUndefined()
  })

  it("forwards the emulator's Storage Read port beside its endpoint, so the app reads emulator results through Storage Read", () => {
    const base = { root: resolve('app'), resourcesPath: resolve('resources'), platform: process.platform, smokeTest: false }
    const env = { PATH: '/bin', VARIA_TEST_BIGQUERY_ENDPOINT: 'http://localhost:9050', VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT: ' http://localhost:9060 ' }
    expect(bigQueryEmulatorStorageEndpoint({ packaged: false, env })).toBe('http://localhost:9060/')
    expect(backendSpawnSpec({ ...base, packaged: false, env }).env?.VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT).toBe('http://localhost:9060/')
    expect(backendSpawnSpec({ ...base, packaged: false, smokeTest: true, env }).env?.VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT).toBe('http://localhost:9060/')
    const names = (spec: ReturnType<typeof backendSpawnSpec>) => Object.keys(spec.env ?? {}).map(name => name.toUpperCase())
    // Never without the emulator endpoint, never in a packaged build, never an address the backend would refuse to start with.
    expect(names(backendSpawnSpec({ ...base, packaged: false, env: { PATH: '/bin', varia_test_bigquery_storage_endpoint: 'http://localhost:9060' } }))).not.toContain('VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT')
    expect(names(backendSpawnSpec({ ...base, packaged: true, env }))).not.toContain('VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT')
    for (const value of ['http://emulator.example.com:9060', 'https://localhost:9060', 'http://localhost:9060/grpc', 'localhost:9060'])
      expect(names(backendSpawnSpec({ ...base, packaged: false, env: { ...env, VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT: value } })), value).not.toContain('VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT')
  })

  it('takes the pre-connect methods\' parameters without credential material, and checks their answers', () => {
    const keyFile = '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f'
    expect(() => validateRequest('bigquery.account', { authentication: 'gcloud' })).not.toThrow()
    expect(() => validateRequest('bigquery.account', { authentication: 'serviceAccountKey', keyFile, impersonateServiceAccount: 'reader@varia-alpha.iam.gserviceaccount.com' })).not.toThrow()
    expect(() => validateRequest('bigquery.projects', { authentication: 'gcloud', pageToken: 'page-2' })).not.toThrow()
    for (const params of [
      { authentication: 'gcloud', credential: { source: 'adc', json: userFile } }, { authentication: 'serviceAccountKey' }, { authentication: 'gcloud', keyFile },
      { authentication: 'serviceAccountKey', keyFile: 'C:/keys/sa.json' }, { authentication: 'sql' }, { authentication: 'gcloud', impersonateServiceAccount: 'not an email' }
    ]) expect(() => validateRequest('bigquery.account', params), JSON.stringify(params)).toThrow()
    expect(() => validateRequest('bigquery.projects', { authentication: 'gcloud', pageToken: 'a\nb' })).toThrow()
    expect(() => validateRequest('bigquery.projects', { authentication: 'gcloud', pageToken: 'x'.repeat(1025) })).toThrow()
    expect(validateResult('bigquery.account', { kind: 'user', account: 'ada@example.com' })).toEqual({ kind: 'user', account: 'ada@example.com' })
    expect(() => validateResult('bigquery.account', { kind: 'user', account: 'ada\n@example.com' })).toThrow()
    expect(() => validateResult('bigquery.account', { kind: 'root', account: 'ada' })).toThrow()
    expect(validateResult('bigquery.projects', { projects: [{ id: 'example.com:varia-beta', friendlyName: 'Beta' }], nextPageToken: 'page-2' })).toMatchObject({ nextPageToken: 'page-2' })
    expect(() => validateResult('bigquery.projects', { projects: [{ id: 'NOT A PROJECT' }] })).toThrow()
  })

  it('adds the credential in main when the connection owner sends a BigQuery connect or dataset list, and for the pre-connect methods', () => {
    const main = readFileSync(join('src', 'main', 'index.ts'), 'utf8')
    // BigQuery connects through ConnectionOpenService like SQL Server; main adds the material only as the owner sends it.
    expect(main).not.toContain('bigQueryHandles')
    expect(main).toContain('await connectionOpen.connect(validated as ProviderConnectionOptions, context)')
    expect(main).toContain(`backend.request('connections.connect', await withBigQueryCredential(params) as ConnectionOptions`)
    expect(main).toContain(`backend.request('connections.databases', await withBigQueryCredential(params) as ConnectionOptions`)
    // A background reconnect never asks about an ADC token file (decision 49 fails closed); a request the user waits on may.
    expect(main).toContain('credential: await bigQueryCredentials.material(params as BigQueryConnectionOptions, { interactive: !(params as { nonInteractive?: boolean }).nonInteractive })')
    expect(main).toContain(`if (method === 'bigquery.account' || method === 'bigquery.projects') {`)
    // The account line reads itself as fields change, so it never asks; Browse may.
    expect(main).toContain(`const credential = await bigQueryCredentials.material(params, { interactive: method === 'bigquery.projects' })`)
    // A second ask queued behind an open box shows nothing once the first's Use It confirmed the same file.
    expect(main).toContain('await store.sourceConfirmed(keyPath, source) ? { response: 0, checkboxChecked: false } : dialog.showMessageBox(window, {')
    // Main's recorded-job cancels have no one waiting on a question: they never ask.
    expect(main).toContain('const credential = await bigQueryCredentials.material(params)\n')
    expect(main).toContain(`['connections.connect', 'connections.databases', 'actions.execute', 'bigquery.account', 'bigquery.projects'].includes(method)`)
  })

  it('accepts a BigQuery connect answer with its dataset and pinned principal, and keeps SQL Server\'s bounds', () => {
    const answer = { id: '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f', server: 'varia-alpha', database: 'd'.repeat(1024), serverVersion: 'BigQuery', generation: 1, login: 'ada@example.com', providerId: 'bigquery', principalId: 'bigquery:user:ada@example.com' }
    expect(() => validateResult('connections.connect', answer)).not.toThrow()
    expect(() => validateResult('connections.connect', { ...answer, principalId: 'bigquery:impersonated:reader@x.iam.gserviceaccount.com|external:sha256:ab' })).not.toThrow()
    expect(() => validateResult('connections.connect', { ...answer, principalId: 'bigquery:user:ada\n@example.com' })).toThrow()
    expect(() => validateResult('connections.connect', { ...answer, principalId: 'bigquery:root:ada' })).toThrow()
    expect(() => validateResult('connections.connect', { ...answer, principalId: 'sid:0105' })).toThrow()
    expect(() => validateResult('connections.connect', { ...answer, providerId: 'sqlserver' })).toThrow()
    expect(() => validateResult('connections.connect', { ...answer, providerId: undefined, database: 'Sales', principalId: 'sid:0105' })).not.toThrow()
    expect(() => validateResult('connections.connect', { ...answer, providerId: undefined, principalId: undefined })).toThrow()
  })
})
