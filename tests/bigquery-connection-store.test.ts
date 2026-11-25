import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BigQueryConnectionStore } from '../src/main/bigquery-connection-store'
import { BigQueryCredentials, BigQueryKeyFiles, federationSource, maxKeyFiles } from '../src/main/bigquery-credentials'
import { connectionHistory } from '../src/main/connection-history'
import { connectionLibrary } from '../src/main/connection-library'
import { BackendError } from '../src/main/backend/errors'
import { bigQueryLibraryLimits } from '../src/shared/bigquery-connections'
import type { BigQueryConnectionOptions } from '../src/shared/contracts'
import { bigQueryStoredProfileSchema } from '../src/shared/bigquery-connections'

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

  it('keeps the key file of a history entry pruned past 30, so a target restored from it does not ask for the file again', async () => {
    const directory = await folder(), path = join(directory, 'bigquery-connections.json'), keyFiles = new BigQueryKeyFiles()
    const keyPath = join(directory, 'reader.json'), keyFile = keyFiles.register(keyPath)
    const keyed: BigQueryConnectionOptions = { provider: 'bigquery', project: 'varia-keyed', authentication: 'serviceAccountKey', keyFile }
    const store = new BigQueryConnectionStore(path, keyFiles)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.UTC(2026, 10, 1))
      await store.rememberEntry(keyed)
      for (let index = 1; index <= 30; index++) { vi.setSystemTime(Date.UTC(2026, 10, 1, 0, index)); await store.rememberEntry(gcloud(`varia-project-${String(index).padStart(2, '0')}`)) }
    } finally { vi.useRealTimers() }
    const { library } = await store.load()
    expect(library.profiles.map(profile => profile.options.project)).not.toContain('varia-keyed')
    expect(library.keptKeyFiles).toEqual([{ reference: keyFile, keyPath }])
    // After a restart main knows the reference again from the file alone, so the restored target's connect finds its path.
    const restarted = new BigQueryKeyFiles()
    await new BigQueryConnectionStore(path, restarted).load()
    expect(restarted.path(keyFile)).toBe(keyPath)
    // Connecting through it again makes it an entry's once more, and the kept reference goes.
    const again = await new BigQueryConnectionStore(path, restarted).rememberEntry(keyed)
    expect(again.library.profiles.find(profile => profile.options.project === 'varia-keyed')).toMatchObject({ keyPath })
    expect(again.library.keptKeyFiles).toBeUndefined()
    // The renderer's view never carries kept paths.
    expect(JSON.stringify(BigQueryConnectionStore.view(library))).not.toContain('keptKeyFiles')
    // Removing an entry forgets its key file's path, a kept copy of it included.
    const entry = again.library.profiles.find(profile => profile.options.project === 'varia-keyed')!
    await writeFile(path, JSON.stringify({ ...again.library, keptKeyFiles: [{ reference: '0b6f2f8e-0b0e-4f6a-9d61-6d8c2b7f1e22', keyPath }] }))
    const removed = await new BigQueryConnectionStore(path, new BigQueryKeyFiles()).remove(entry.id)
    expect(removed.removed).toBe(true)
    expect(removed.library.keptKeyFiles ?? []).toEqual([])
    expect(await readFile(path, 'utf8')).not.toContain(JSON.stringify(keyPath).slice(1, -1))
    // Kept references and every saved entry's fit main's key file registry together, so loading never evicts one of them.
    expect(bigQueryLibraryLimits.profiles + bigQueryLibraryLimits.keptKeyFiles).toBeLessThanOrEqual(maxKeyFiles)
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

  it('persists per-principal starred projects, enforces bounds, filters by allowed principals, and rejects invalid input', async () => {
    const directory = await folder(), path = join(directory, 'bigquery-connections.json')
    const store = new BigQueryConnectionStore(path, new BigQueryKeyFiles())
    const ada = 'bigquery:user:ada@example.com', grace = 'bigquery:user:grace@example.com'
    expect(await store.loadStarredProjects()).toEqual({ byPrincipal: {} })
    expect(await store.setProjectStarForPrincipal(ada, 'bigquery-public-data', true)).toEqual({
      byPrincipal: { [ada]: ['bigquery-public-data'] }
    })
    // Starring again is idempotent; a second principal keeps its own independent list.
    expect(await store.setProjectStarForPrincipal(ada, 'bigquery-public-data', true)).toEqual({
      byPrincipal: { [ada]: ['bigquery-public-data'] }
    })
    expect(await store.setProjectStarForPrincipal(grace, 'varia-gamma', true)).toEqual({
      byPrincipal: { [ada]: ['bigquery-public-data'], [grace]: ['varia-gamma'] }
    })
    // Survives reload from disk and respects allowedPrincipals scoping.
    const reloaded = new BigQueryConnectionStore(path, new BigQueryKeyFiles())
    expect(await reloaded.loadStarredProjects()).toEqual({
      byPrincipal: { [ada]: ['bigquery-public-data'], [grace]: ['varia-gamma'] }
    })
    expect(await reloaded.loadStarredProjects(new Set([ada]))).toEqual({
      byPrincipal: { [ada]: ['bigquery-public-data'] }
    })
    expect(await reloaded.starredProjectsFor(ada)).toEqual(['bigquery-public-data'])
    expect(await reloaded.starredProjectsFor('bigquery:anonymous:emulator')).toEqual([])
    // Unstarring the last project drops that principal's entry cleanly; allowedPrincipals scopes the returned view.
    expect(await reloaded.setProjectStarForPrincipal(ada, 'bigquery-public-data', false, new Set([ada]))).toEqual({
      byPrincipal: {}
    })
    expect(await reloaded.loadStarredProjects()).toEqual({
      byPrincipal: { [grace]: ['varia-gamma'] }
    })
    await expect(reloaded.setProjectStarForPrincipal('not-bigquery', 'varia-alpha', true)).rejects.toThrow()
    await expect(reloaded.setProjectStarForPrincipal('bigquery:anonymous:emulator', 'varia-alpha', true)).rejects.toThrow()
    await expect(reloaded.setProjectStarForPrincipal(ada, 'Bad_Project', true)).rejects.toThrow()
  })

  it('migrates legacy extraProjects onto their originating profile without pooling across accounts or dropping past 200', async () => {
    const directory = await folder(), path = join(directory, 'bigquery-connections.json')
    const profileAId = '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f'
    const profileBId = '7f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f'
    const optionsA: BigQueryConnectionOptions = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', impersonateServiceAccount: 'a@proj.iam.gserviceaccount.com' }
    const optionsB: BigQueryConnectionOptions = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', impersonateServiceAccount: 'b@proj.iam.gserviceaccount.com' }
    await writeFile(path, JSON.stringify({
      version: 1,
      profiles: [
        { id: profileAId, options: { ...optionsA, extraProjects: ['reports-alpha', 'varia-alpha'] }, favorite: true },
        { id: profileBId, options: { ...optionsB, extraProjects: ['reports-bravo'] }, favorite: false }
      ]
    }))
    const store = new BigQueryConnectionStore(path, new BigQueryKeyFiles())
    const loaded = await store.load()
    expect(loaded.warning).toBeUndefined()
    expect(loaded.library.profiles).toHaveLength(2)
    expect(loaded.library.profiles[0]?.options).toEqual(optionsA)
    expect(loaded.library.profiles[0]?.migratedProjects).toEqual(['reports-alpha'])
    expect(loaded.library.profiles[1]?.migratedProjects).toEqual(['reports-bravo'])
    // Renderer view strips migratedProjects alongside keyPath.
    expect(JSON.stringify(BigQueryConnectionStore.view(loaded.library))).not.toContain('migratedProjects')
    // Disk was upgraded without quarantining.
    expect(await readdir(directory)).toEqual(['bigquery-connections.json'])
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { profiles: { options: Record<string, unknown>; migratedProjects?: string[] }[] }
    expect(onDisk.profiles[0]?.options).not.toHaveProperty('extraProjects')
    expect(onDisk.profiles[0]?.migratedProjects).toEqual(['reports-alpha'])
    expect(onDisk.profiles[1]?.migratedProjects).toEqual(['reports-bravo'])

    // Connecting account A claims ONLY profile A's migratedProjects, leaving profile B's intact for account B.
    const acctA = 'bigquery:impersonated:a@proj.iam.gserviceaccount.com'
    const acctB = 'bigquery:impersonated:b@proj.iam.gserviceaccount.com'
    const claimedA = await store.claimMigratedProjects(acctA, { profileId: profileAId, options: optionsA })
    expect(claimedA.claimed).toEqual(['reports-alpha'])
    expect(await store.starredProjectsFor(acctA)).toEqual(['reports-alpha'])
    expect(await store.starredProjectsFor(acctB)).toEqual([])
    const afterA = (await store.load()).library.profiles
    expect(afterA.find(p => p.id === profileAId)?.migratedProjects).toBeUndefined()
    expect(afterA.find(p => p.id === profileBId)?.migratedProjects).toEqual(['reports-bravo'])
    // Second claim for A is a no-op.
    expect((await store.claimMigratedProjects(acctA, { options: optionsA })).claimed).toEqual([])
    // Connecting account B by matching options claims profile B's migratedProjects.
    const claimedB = await store.claimMigratedProjects(acctB, { options: optionsB })
    expect(claimedB.claimed).toEqual(['reports-bravo'])
    expect(await store.starredProjectsFor(acctB)).toEqual(['reports-bravo'])
    expect((await store.load()).library.profiles.find(p => p.id === profileBId)?.migratedProjects).toBeUndefined()

    // Unpinned session target migration is keyed by targetId: anonymous principals do not claim, another target does not claim.
    const target1 = '8f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f'
    const target2 = '9f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f'
    await store.addMigratedTargetProjects(target1, ['varia-delta'])
    expect((await store.claimMigratedProjects('bigquery:anonymous:emulator', { targetId: target1 })).claimed).toEqual([])
    expect((await store.claimMigratedProjects(acctA, { targetId: target2 })).claimed).toEqual([])
    expect((await store.claimMigratedProjects(acctA, { targetId: target1 })).claimed).toEqual(['varia-delta'])
    expect((await store.load()).library.migratedTargets).toBeUndefined()

    // Across many profiles (>200 total extraProjects combined), every profile keeps its full list without a cross-account 200 cap.
    const manyPath = join(directory, 'many.json')
    const manyProfiles = Array.from({ length: 15 }, (_, p) => ({
      id: `00000000-0000-4000-8000-${String(p + 1).padStart(12, '0')}`,
      options: { provider: 'bigquery', project: `billing-proj-${p}`, authentication: 'gcloud' },
      favorite: false,
      ...(p === 0 ? {} : {})
    })).map((entry, p) => ({
      ...entry,
      options: { ...entry.options, extraProjects: Array.from({ length: 16 }, (_, j) => `legacy-p${p}-x${j}`) }
    }))
    await writeFile(manyPath, JSON.stringify({ version: 1, profiles: manyProfiles }))
    const manyLoaded = await new BigQueryConnectionStore(manyPath, new BigQueryKeyFiles()).load()
    expect(manyLoaded.warning).toBeUndefined()
    const totalMigrated = manyLoaded.library.profiles.reduce((sum, p) => sum + (p.migratedProjects?.length ?? 0), 0)
    expect(totalMigrated).toBe(15 * 16)

    // Corrupt non-array extraProjects still quarantines the file.
    await writeFile(path, JSON.stringify({
      version: 1,
      profiles: [{ id: profileAId, options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', extraProjects: 'not-an-array' }, favorite: false }]
    }))
    const corrupt = await new BigQueryConnectionStore(path, new BigQueryKeyFiles()).load()
    expect(corrupt.warning).toContain('invalid')
    // Corrupt per-profile migratedProjects alongside valid extraProjects also quarantines.
    await writeFile(path, JSON.stringify({
      version: 1,
      profiles: [{ id: profileAId, options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', extraProjects: ['varia-beta'] }, favorite: false, migratedProjects: [123, 'NOT A PROJECT'] }]
    }))
    const corruptMigrated = await new BigQueryConnectionStore(path, new BigQueryKeyFiles()).load()
    expect(corruptMigrated.warning).toContain('invalid')
    // Oversized legacy extraProjects (> 16) also quarantines instead of bypassing the pre-upgrade cap.
    await writeFile(path, JSON.stringify({
      version: 1,
      profiles: [{ id: profileAId, options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', extraProjects: Array.from({ length: 17 }, (_, i) => `varia-extra-${String(i).padStart(2, '0')}`) }, favorite: false }]
    }))
    const oversized = await new BigQueryConnectionStore(path, new BigQueryKeyFiles()).load()
    expect(oversized.warning).toContain('invalid')
    // Duplicate migratedTargets quarantines instead of silently deduplicating.
    await writeFile(path, JSON.stringify({
      version: 1,
      profiles: [{ id: profileAId, options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' }, favorite: false }],
      migratedTargets: [{ targetId: target1, projects: ['varia-gamma', 'varia-gamma'] }]
    }))
    const duplicateMigrated = await new BigQueryConnectionStore(path, new BigQueryKeyFiles()).load()
    expect(duplicateMigrated.warning).toContain('invalid')
  })

  it('retains the recovery warning across internal peek() and starred reads so load() still surfaces it to Connect', async () => {
    const directory = await folder(), path = join(directory, 'bigquery-connections.json')
    await writeFile(path, '{not valid json')
    const store = new BigQueryConnectionStore(path, new BigQueryKeyFiles())
    // Internal startup reads quarantine the bad file and preserve the warning without consuming it.
    expect(await store.loadStarredProjects()).toEqual({ byPrincipal: {} })
    expect((await store.peek()).library.profiles).toEqual([])
    // Subsequent Connect-dialog library load surfaces the preserved recovery warning once, then clears it.
    const first = await store.load()
    expect(first.warning).toBe('The saved BigQuery connections were invalid. Their original file was preserved.')
    expect(first.library.profiles).toEqual([])
    const second = await store.load()
    expect(second.warning).toBeUndefined()
  })

  it('keeps legacy migratedProjects bound to the original account identity even if the saved profile is edited to another account', async () => {
    const directory = await folder(), path = join(directory, 'bigquery-connections.json')
    const profileId = '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f'
    const aliceOptions: BigQueryConnectionOptions = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', impersonateServiceAccount: 'alice@proj.iam.gserviceaccount.com' }
    const bobOptions: BigQueryConnectionOptions = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', impersonateServiceAccount: 'bob@proj.iam.gserviceaccount.com' }
    await writeFile(path, JSON.stringify({
      version: 1,
      profiles: [{ id: profileId, options: { ...aliceOptions, extraProjects: ['alice-only-proj'] }, favorite: true }]
    }))
    const store = new BigQueryConnectionStore(path, new BigQueryKeyFiles())
    const loaded = await store.load()
    expect(loaded.library.profiles[0]?.migratedProjects).toEqual(['alice-only-proj'])
    expect(loaded.library.profiles[0]?.migratedKey).toBeTruthy()
    expect(JSON.stringify(BigQueryConnectionStore.view(loaded.library))).not.toContain('migratedKey')

    // Edit the existing saved profile from Alice to Bob before first reconnect.
    await store.upsert({ id: profileId, options: bobOptions, favorite: true })
    // Reconnecting as Bob using that same profile ID must NOT claim Alice's pending projects.
    const bob = 'bigquery:impersonated:bob@proj.iam.gserviceaccount.com'
    const bobClaim = await store.claimMigratedProjects(bob, { profileId, options: bobOptions })
    expect(bobClaim.claimed).toEqual([])
    expect(await store.starredProjectsFor(bob)).toEqual([])
    // Later connecting as Alice still claims Alice's projects and clears migratedProjects + migratedKey.
    const alice = 'bigquery:impersonated:alice@proj.iam.gserviceaccount.com'
    const aliceClaim = await store.claimMigratedProjects(alice, { options: aliceOptions })
    expect(aliceClaim.claimed).toEqual(['alice-only-proj'])
    expect(await store.starredProjectsFor(alice)).toEqual(['alice-only-proj'])
    const finalProfile = (await store.peek()).library.profiles.find(p => p.id === profileId)
    expect(finalProfile?.migratedProjects).toBeUndefined()
    expect(finalProfile?.migratedKey).toBeUndefined()
  })

  it('preserves pinned session overflow past 200 stars under the originating targetId until capacity is freed', async () => {
    const directory = await folder(), path = join(directory, 'bigquery-connections.json')
    const store = new BigQueryConnectionStore(path, new BigQueryKeyFiles())
    const ada = 'bigquery:user:ada@example.com'
    const targetIds = Array.from({ length: 13 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
    // 13 targets * 16 distinct projects = 208 projects -> 200 starred + 8 preserved on target 13.
    let overflow: readonly string[] = []
    for (let t = 0; t < 13; t++) {
      const batch = Array.from({ length: 16 }, (_, j) => `sess-t${String(t).padStart(2, '0')}-p${String(j).padStart(2, '0')}`)
      const res = await store.migrateTargetStarredProjects(ada, targetIds[t]!, batch)
      if (t === 12) overflow = res.remaining
    }
    expect(await store.starredProjectsFor(ada)).toHaveLength(200)
    expect(overflow).toHaveLength(8)
    expect((await store.peek()).library.migratedTargets).toEqual([{ targetId: targetIds[12], projects: [...overflow] }])
    // Free 8 star slots and reconnect target 13 -> all 8 overflow projects are claimed automatically.
    const current = await store.starredProjectsFor(ada)
    for (const drop of current.slice(0, 8)) await store.setProjectStarForPrincipal(ada, drop, false)
    const claimed = await store.claimMigratedProjects(ada, { targetId: targetIds[12] })
    expect(claimed.claimed).toEqual(overflow)
    expect((await store.peek()).library.migratedTargets).toBeUndefined()
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

  it('refuses a federation configuration whose token file the user has not confirmed', async () => {
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
    // Restoring a removed recent BigQuery entry preserves its original lastConnected instead of marking it saved-only.
    const restored = await library.save({ options: gcloud(), favorite: false, lastConnected: '2026-11-10T10:00:00.000Z' })
    expect(restored.bigQuery?.profiles).toEqual([expect.objectContaining({ options: gcloud(), favorite: false, lastConnected: '2026-11-10T10:00:00.000Z' })])
    expect(restored.bigQuery?.profiles[0]?.saved).toBeUndefined()
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

  it('keeps the cost-prompt choice with the settings when Save edits an entry to new ones', async () => {
    const directory = await folder(), store = new BigQueryConnectionStore(join(directory, 'bigquery-connections.json'), new BigQueryKeyFiles())
    const alpha = await store.upsert({ options: { ...gcloud(), displayName: 'A' }, saved: true })
    await store.upsert({ options: { ...gcloud('varia-beta'), displayName: 'B' }, saved: true })
    await store.setCostPrompt({ options: gcloud(), costPrompt: false })
    const choice = async (id: string) => (await store.load()).library.profiles.find(profile => profile.id === id)?.options.costPrompt
    // Edited to varia-beta's settings, the entry takes varia-beta's choice (asks), not varia-alpha's.
    await store.upsert({ id: alpha.id, options: { ...gcloud('varia-beta'), displayName: 'A' }, saved: true })
    expect(await choice(alpha.id)).toBeUndefined()
    // Edited back, it takes the choice entries with those settings share.
    await store.setCostPrompt({ options: gcloud('varia-beta'), costPrompt: false })
    const gamma = await store.upsert({ options: { ...gcloud('varia-gamma'), displayName: 'C' }, saved: true })
    await store.upsert({ id: gamma.id, options: { ...gcloud('varia-beta'), displayName: 'C' }, saved: true })
    expect(await choice(gamma.id)).toBe(false)
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

  it("keeps the connection's own threshold on its entries: a connect that names none keeps it, 0 clears it", async () => {
    const directory = await folder(), store = new BigQueryConnectionStore(join(directory, 'bigquery-connections.json'), new BigQueryKeyFiles())
    const thresholds = async () => (await store.load()).library.profiles.map(profile => profile.options.costThreshold)
    const first = await store.upsert({ options: { ...gcloud(), displayName: 'A', costThreshold: 50 }, saved: true })
    expect(await thresholds()).toEqual([50])
    // A live connection's settings (which never carry it) connect again: the entry keeps it.
    await store.rememberEntry(gcloud())
    expect(await thresholds()).toEqual([50])
    // Another entry with the same settings shares it, and a new value set through either reaches both.
    const second = await store.upsert({ options: { ...gcloud('varia-beta'), displayName: 'B' }, saved: true })
    await store.upsert({ id: second.id, options: { ...gcloud(), displayName: 'B' }, saved: true })
    expect(await thresholds()).toEqual([50, 50])
    await store.upsert({ id: second.id, options: { ...gcloud(), displayName: 'B', costThreshold: 20 }, saved: true })
    expect(await thresholds()).toEqual([20, 20])
    // 0 (Options' threshold) clears it and is never kept; a file holding 0 is invalid.
    await store.upsert({ id: first.id, options: { ...gcloud(), displayName: 'A', costThreshold: 0 }, saved: true })
    expect(await thresholds()).toEqual([undefined, undefined])
    expect(bigQueryStoredProfileSchema.safeParse({ id: first.id, options: { ...gcloud(), costThreshold: 0 }, favorite: false }).success).toBe(false)
    // A connect that reused a live connection sets it through setCostThreshold, adding an entry when there is none.
    await store.setCostThreshold({ options: gcloud(), costThreshold: 8 })
    expect(await thresholds()).toEqual([8, 8])
    await store.setCostThreshold({ options: gcloud('varia-gamma'), costThreshold: 3 })
    expect((await store.load()).library.profiles.find(profile => profile.options.project === 'varia-gamma')?.options.costThreshold).toBe(3)
    await store.setCostThreshold({ options: gcloud(), costThreshold: 0 })
    expect((await thresholds()).slice(0, 2)).toEqual([undefined, undefined])
    // Clearing one for settings with no entry adds none.
    const count = (await store.load()).library.profiles.length
    await store.setCostThreshold({ options: gcloud('varia-omega'), costThreshold: 0 })
    expect((await store.load()).library.profiles).toHaveLength(count)
    // Bounded: whole GiB up to 1,048,576.
    await expect(store.setCostThreshold({ options: gcloud(), costThreshold: 1_048_577 })).rejects.toThrow()
    await expect(store.setCostThreshold({ options: gcloud(), costThreshold: 1.5 })).rejects.toThrow()
    await expect(store.upsert({ options: { ...gcloud(), costThreshold: -1 } })).rejects.toThrow()
    // Set Connection Environment for settings with no entry never keeps a 0.
    await store.setEnvironment({ options: { ...gcloud('varia-delta'), costThreshold: 0 }, environment: 'Production' })
    expect((await store.load()).library.profiles.find(profile => profile.options.project === 'varia-delta')?.options).not.toHaveProperty('costThreshold')
  })

  it('keeps SQL Server\'s library working when BigQuery\'s file cannot be read', async () => {
    const sql = sqlStore(), bigQuery = { load: vi.fn(async () => { throw new Error('EBUSY') }), remove: vi.fn(async () => { throw new Error('EBUSY') }) }
    const sqlId = '00000000-0000-4000-8000-000000000009'
    sql.load.mockResolvedValue({ library: { version: 1, profiles: [{ id: sqlId }] } } as never)
    const library = connectionLibrary({ connections: sql as never, savedPasswords: passwords as never, bigQuery: bigQuery as never })
    expect(await library.load()).toMatchObject({ bigQuery: { profiles: [] }, warning: 'The saved BigQuery connections could not be read.', bigQueryUnreadable: true })
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
    // A reused connect's threshold: set, cleared, and cleared for settings with no entry all hold.
    expect(await history.setBigQueryCostThreshold!({ ...gcloud(), costThreshold: 12 }, 12)).toBe(true)
    expect((await bigQuery.load()).library.profiles[0]?.options.costThreshold).toBe(12)
    expect(await history.setBigQueryCostThreshold!(gcloud(), 0)).toBe(true)
    expect(await history.setBigQueryCostThreshold!(gcloud('varia-omega'), 0)).toBe(true)
    expect((await bigQuery.load()).library.profiles).toHaveLength(1)
  })
})
