import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BigQueryConnectionStore } from '../src/main/bigquery-connection-store'
import { BigQueryCredentials, BigQueryKeyFiles, federationSource } from '../src/main/bigquery-credentials'
import { connectionHistory } from '../src/main/connection-history'
import { connectionLibrary } from '../src/main/connection-library'
import { BackendError } from '../src/main/backend/errors'
import type { BigQueryConnectionOptions } from '../src/shared/contracts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'varia-bigquery-store-'))
  directories.push(directory)
  return directory
}
const gcloud = (project = 'varia-alpha'): BigQueryConnectionOptions => ({ provider: 'bigquery', project, authentication: 'gcloud' })

describe('BigQuery saved connections (bigquery-connections.json)', () => {
  it('saves, favourites and removes entries, keeping a key file\'s path for main and showing the renderer only its name', async () => {
    const directory = await folder(), keyFiles = new BigQueryKeyFiles(), path = join(directory, 'bigquery-connections.json')
    const keyPath = join(directory, 'reader.json'), keyFile = keyFiles.register(keyPath)
    const store = new BigQueryConnectionStore(path, keyFiles)
    const options: BigQueryConnectionOptions = { provider: 'bigquery', project: 'varia-alpha', dataset: 'sales', authentication: 'serviceAccountKey', keyFile }
    const saved = await store.upsert({ options, saved: true })
    expect(saved.library.profiles).toEqual([expect.objectContaining({ id: saved.id, options, saved: true, keyPath })])
    // The renderer's view never holds the path.
    const view = BigQueryConnectionStore.view(saved.library)
    expect(view.profiles[0]).toMatchObject({ keyFileName: 'reader.json', options })
    expect(JSON.stringify(view)).not.toContain(directory.replaceAll('\\', '\\\\'))
    // The same settings name the same entry; a star changes only it.
    const starred = await store.upsert({ options, favorite: true })
    expect(starred.id).toBe(saved.id)
    expect(starred.library.profiles).toHaveLength(1)
    // A connect records recency and clears Saved.
    const connected = await store.rememberEntry(options)
    expect(connected.library.profiles[0]).toMatchObject({ favorite: true, lastConnected: expect.any(String) })
    expect(connected.library.profiles[0]).not.toHaveProperty('saved')
    // After a restart the saved reference finds its path again.
    const restarted = new BigQueryKeyFiles(), again = new BigQueryConnectionStore(path, restarted)
    await again.load()
    expect(restarted.path(keyFile)).toBe(keyPath)
    expect(await again.remove(saved.id)).toMatchObject({ removed: true, library: { profiles: [] } })
    expect((await again.remove(saved.id)).removed).toBe(false)
  })

  it('refuses a key file reference main no longer knows, keeps at most 30 recent entries, and labels by entry', async () => {
    const directory = await folder(), store = new BigQueryConnectionStore(join(directory, 'bigquery-connections.json'), new BigQueryKeyFiles())
    await expect(store.upsert({ options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'serviceAccountKey', keyFile: '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f' } })).rejects.toThrow('The key file is no longer available. Choose it again.')
    vi.useFakeTimers()
    try {
      for (let index = 0; index < 32; index++) { vi.setSystemTime(Date.UTC(2026, 10, 1, 0, index)); await store.rememberEntry(gcloud(`varia-project-${String(index).padStart(2, '0')}`)) }
    } finally { vi.useRealTimers() }
    const { library } = await store.load()
    expect(library.profiles).toHaveLength(30)
    expect(library.profiles.map(profile => profile.options.project)).not.toContain('varia-project-00')
    const labelled = await store.setEnvironment({ options: gcloud('varia-project-31'), environment: 'Production' })
    expect(labelled.profiles.find(profile => profile.options.project === 'varia-project-31')?.options.environment).toBe('Production')
    // A connect without an environment keeps the entry's when asked to.
    const kept = await store.rememberEntry(gcloud('varia-project-31'), true)
    expect(kept.environment).toBe('Production')
  })

  it('quarantines a file whose key file path is not absolute, rather than failing every later read', async () => {
    const directory = await folder(), path = join(directory, 'bigquery-connections.json')
    await writeFile(path, JSON.stringify({ version: 1, profiles: [{ id: '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f', options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'serviceAccountKey', keyFile: '7f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f' }, favorite: false, keyPath: 'relative/reader.json' }] }))
    const read = await new BigQueryConnectionStore(path, new BigQueryKeyFiles()).load()
    expect(read.warning).toBe('The saved BigQuery connections were invalid. Their original file was preserved.')
    expect(read.library.profiles).toEqual([])
    // A path the schema allows but this platform cannot use (here: one main refuses) is quarantined the same way.
    const foreign = process.platform === 'win32' ? '/keys/reader.json' : 'C:\\keys\\reader.json'
    await writeFile(path, JSON.stringify({ version: 1, profiles: [{ id: '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f', options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'serviceAccountKey', keyFile: '7f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f' }, favorite: false, keyPath: foreign }] }))
    const keyFiles = new BigQueryKeyFiles(), remember = vi.spyOn(keyFiles, 'remember').mockImplementation(() => { throw new Error('A key file path must be absolute.') })
    const again = await new BigQueryConnectionStore(path, keyFiles).load()
    expect(remember).toHaveBeenCalled()
    expect(again).toMatchObject({ warning: 'The saved BigQuery connections were invalid. Their original file was preserved.', library: { profiles: [] } })
  })

  it('quarantines an unreadable file instead of overwriting it', async () => {
    const directory = await folder(), path = join(directory, 'bigquery-connections.json')
    await writeFile(path, JSON.stringify({ version: 1, profiles: [{ id: 'not-a-uuid' }] }))
    const store = new BigQueryConnectionStore(path, new BigQueryKeyFiles())
    const read = await store.load()
    expect(read.warning).toBe('The saved BigQuery connections were invalid. Their original file was preserved.')
    expect(read.library.profiles).toEqual([])
    expect((await readdir(directory)).some(name => name !== 'bigquery-connections.json')).toBe(true)
  })

  it('remembers confirmed federation token files by configuration, the newest 64', async () => {
    const directory = await folder(), store = new BigQueryConnectionStore(join(directory, 'bigquery-connections.json'), new BigQueryKeyFiles())
    const config = join(directory, 'federation.json'), token = join(directory, 'token')
    expect(await store.sourceConfirmed(config, token)).toBe(false)
    await store.confirmSource(config, token)
    expect(await store.sourceConfirmed(config, token)).toBe(true)
    // A changed source asks again.
    expect(await store.sourceConfirmed(config, join(directory, 'other'))).toBe(false)
    await store.confirmSource(config, join(directory, 'other'))
    expect(await store.sourceConfirmed(config, token)).toBe(false)
    for (let index = 0; index < 70; index++) await store.confirmSource(join(directory, `${index}.json`), token)
    const file = JSON.parse(await readFile(join(directory, 'bigquery-connections.json'), 'utf8')) as { confirmedSources: unknown[] }
    expect(file.confirmedSources).toHaveLength(64)
  })
})

describe('BigQuery key files and federation sources (main)', () => {
  it('names the same path by the same reference, so a picked file names the same saved connection', async () => {
    const directory = await folder(), files = new BigQueryKeyFiles()
    const first = files.register(join(directory, 'a.json'))
    files.register(join(directory, 'b.json'))
    expect(files.register(join(directory, 'a.json'))).toBe(first)
  })

  it('reads the absolute token file a federation configuration names, and nothing else', async () => {
    const directory = await folder(), token = join(directory, 'token')
    await writeFile(token, 'x')
    // As written: main never resolves or opens the path (a mount or link would reach another host before confirmation).
    expect(await federationSource(JSON.stringify({ type: 'external_account', credential_source: { file: token } }))).toBe(token)
    expect(await federationSource(JSON.stringify({ type: 'external_account', credential_source: { file: '/net/host.example/export/token' } }))).toBe('/net/host.example/export/token')
    expect(await federationSource(JSON.stringify({ type: 'external_account', credential_source: { url: 'http://169.254.169.254/token' } }))).toBeUndefined()
    expect(await federationSource('not json')).toBeUndefined()
    // A file source main cannot show as one full path is refused, never passed on unconfirmed.
    for (const file of ['relative/token', token + '\n', token + '\u0001', 42, '', '\\\\host\\share\\token', '\\\\?\\UNC\\host\\share\\token', '//host/share/token'])
      await expect(federationSource(JSON.stringify({ credential_source: { file } }))).rejects.toThrow('not a full local path')
  })

  it('refuses a federation configuration whose token file the user has not confirmed (decision 49)', async () => {
    const directory = await folder(), files = new BigQueryKeyFiles(), token = join(directory, 'token'), config = join(directory, 'federation.json')
    await writeFile(token, 'x')
    await writeFile(config, JSON.stringify({ type: 'external_account', audience: '//iam.googleapis.com/x', credential_source: { file: token } }))
    const keyFile = files.register(config)
    let confirmed = false
    const credentials = new BigQueryCredentials(files, { env: {}, platform: process.platform, home: directory, emulator: false, sourceConfirmed: async () => confirmed })
    const refused = await credentials.material({ authentication: 'externalAccount', keyFile }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(BackendError)
    expect((refused as BackendError).code).toBe('AUTH_KEY_FILE')
    confirmed = true
    expect(await credentials.material({ authentication: 'externalAccount', keyFile })).toMatchObject({ source: 'file' })
    // After a restart, a saved reference is found through the saved connections, which are read on demand.
    const restarted = new BigQueryKeyFiles(), restore = vi.fn(async () => { restarted.remember(keyFile, config) })
    const later = new BigQueryCredentials(restarted, { env: {}, platform: process.platform, home: directory, emulator: false, sourceConfirmed: async () => true, restoreKeyFiles: restore })
    expect(await later.material({ authentication: 'externalAccount', keyFile })).toMatchObject({ source: 'file' })
    expect(restore).toHaveBeenCalledTimes(1)
    // With no way to ask, it is refused (fail closed).
    const unasked = new BigQueryCredentials(files, { env: {}, platform: process.platform, home: directory, emulator: false })
    await expect(unasked.material({ authentication: 'externalAccount', keyFile })).rejects.toThrow('has not been confirmed')
  })
})

describe('Connection library and history across both engines', () => {
  const sqlStore = () => {
    const library = { version: 1 as const, profiles: [] }
    return {
      load: vi.fn(async () => ({ library })), save: vi.fn(), saveEntry: vi.fn(), remove: vi.fn(async () => ({ library })), setEnvironment: vi.fn(),
      rememberEntry: vi.fn(async () => ({ library, id: 'sql', environment: undefined })), setAutoReconnect: vi.fn(async () => true)
    }
  }
  const passwords = { reconcile: vi.fn(async () => ({ ids: [] as string[] })), forget: vi.fn(), forgetCredentials: vi.fn(), state: vi.fn(async () => ({ available: true })), set: vi.fn(), storageAvailable: vi.fn(() => true), list: vi.fn(async () => []) }

  it('loads both libraries, saves and removes BigQuery entries in BigQuery\'s, and answers with SQL Server\'s as it is', async () => {
    const directory = await folder(), bigQuery = new BigQueryConnectionStore(join(directory, 'bigquery-connections.json'), new BigQueryKeyFiles()), sql = sqlStore()
    const library = connectionLibrary({ connections: sql as never, savedPasswords: passwords as never, bigQuery })
    expect((await library.load()).bigQuery).toEqual({ profiles: [] })
    const saved = await library.save({ options: gcloud(), saved: true })
    expect(saved.bigQuery?.profiles).toEqual([expect.objectContaining({ options: gcloud(), saved: true })])
    expect(sql.save).not.toHaveBeenCalled()
    const removed = await library.remove(saved.bigQuery!.profiles[0]!.id)
    expect(removed.bigQuery?.profiles).toEqual([])
    expect(sql.remove).not.toHaveBeenCalled()
  })

  it("keeps Don't ask again on the entry: a connect that does not name it keeps it, and Advanced Properties clears it", async () => {
    const directory = await folder(), bigQuery = new BigQueryConnectionStore(join(directory, 'bigquery-connections.json'), new BigQueryKeyFiles()), sql = sqlStore()
    const library = connectionLibrary({ connections: sql as never, savedPasswords: passwords as never, bigQuery })
    await bigQuery.rememberEntry(gcloud())
    expect(await library.setBigQueryCostPrompt({ options: gcloud(), costPrompt: false })).toBe(true)
    const entry = async () => (await bigQuery.load()).library.profiles.find(profile => profile.options.project === 'varia-alpha')!
    expect((await entry()).options.costPrompt).toBe(false)
    // The same connection typed again (no choice named) is the same entry, and keeps the choice.
    await bigQuery.rememberEntry(gcloud())
    expect((await entry()).options.costPrompt).toBe(false)
    expect((await bigQuery.load()).library.profiles).toHaveLength(1)
    // Turned back on in Advanced Properties (true): the default is not stored.
    await bigQuery.rememberEntry({ ...gcloud(), costPrompt: true })
    expect((await entry()).options).not.toHaveProperty('costPrompt')
    // A live connection with no saved entry gets one; anything else in the input is refused.
    expect(await library.setBigQueryCostPrompt({ options: gcloud('varia-beta'), costPrompt: false })).toBe(true)
    await expect(library.setBigQueryCostPrompt({ options: gcloud(), costPrompt: false, environment: 'Production' })).rejects.toThrow()
  })

  it('keeps one cost-prompt choice for entries with the same settings', async () => {
    const directory = await folder(), store = new BigQueryConnectionStore(join(directory, 'bigquery-connections.json'), new BigQueryKeyFiles())
    // Save with an id can edit an entry until its settings equal another's: two entries, one connection.
    const first = await store.upsert({ options: { ...gcloud(), displayName: 'A' }, saved: true })
    const second = await store.upsert({ options: { ...gcloud('varia-beta'), displayName: 'B' }, saved: true })
    await store.upsert({ id: second.id, options: { ...gcloud(), displayName: 'B' }, saved: true })
    const choices = async () => (await store.load()).library.profiles.map(profile => profile.options.costPrompt)
    await store.setCostPrompt({ options: gcloud(), costPrompt: false })
    expect(await choices()).toEqual([false, false])
    // Turned back on through either entry, both ask again.
    await store.upsert({ options: { ...gcloud(), displayName: 'B', costPrompt: true } }, true, false, second.id)
    expect(await choices()).toEqual([undefined, undefined])
    expect(first.id).not.toBe(second.id)
  })

  it('keeps SQL Server\'s library working when BigQuery\'s file cannot be read', async () => {
    const sql = sqlStore(), bigQuery = { load: vi.fn(async () => { throw new Error('EBUSY') }), remove: vi.fn(async () => { throw new Error('EBUSY') }) }
    const sqlId = '00000000-0000-4000-8000-000000000009'
    sql.load.mockResolvedValue({ library: { version: 1, profiles: [{ id: sqlId }] } } as never)
    const library = connectionLibrary({ connections: sql as never, savedPasswords: passwords as never, bigQuery: bigQuery as never })
    expect(await library.load()).toMatchObject({ bigQuery: { profiles: [] }, warning: 'The saved BigQuery connections could not be read.' })
    await library.remove(sqlId)
    expect(sql.remove).toHaveBeenCalledWith(sqlId)
    expect(bigQuery.remove).not.toHaveBeenCalled()
  })

  it('records a connect in the library of its engine', async () => {
    const directory = await folder(), bigQuery = new BigQueryConnectionStore(join(directory, 'bigquery-connections.json'), new BigQueryKeyFiles()), sql = sqlStore()
    const history = connectionHistory(sql as never, bigQuery)
    await history.rememberEntry(gcloud())
    expect(sql.rememberEntry).not.toHaveBeenCalled()
    expect((await bigQuery.load()).library.profiles).toEqual([expect.objectContaining({ options: gcloud(), lastConnected: expect.any(String) })])
    await history.rememberEntry({ server: 'sql01', database: '', authentication: 'windows', trustServerCertificate: false })
    expect(sql.rememberEntry).toHaveBeenCalledTimes(1)
  })
})
