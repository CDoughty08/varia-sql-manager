import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { connectionAutoReconnectSchema, connectionKey } from '../shared/connections'
import {
  bigQueryEnvironmentInputSchema, bigQueryLibraryFileSchema, bigQueryLibraryLimits, bigQueryProfileInputSchema,
  type BigQueryConnectionProfile, type BigQueryLibraryFile, type BigQueryLibraryView, type BigQueryProfileInput, type BigQueryStoredProfile
} from '../shared/bigquery-connections'
import type { BigQueryConnectionOptions } from '../shared/contracts'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'
import type { BigQueryKeyFiles } from './bigquery-credentials'

const limit = 2_000_000
const empty = (): BigQueryLibraryFile => ({ version: 1, profiles: [] })
/** The options a profile keeps: the validated BigQuery options (they hold no secret; the key file is a reference). */
const stored = (options: BigQueryConnectionOptions): BigQueryConnectionOptions => bigQueryProfileInputSchema.shape.options.parse(options)
const keyOf = (options: BigQueryConnectionOptions) => connectionKey(options)

/** History keeps the 30 most recent connections; an entry that is not a favourite, saved or recent is dropped. */
function prune(library: BigQueryLibraryFile) {
  const recent = library.profiles.filter(item => item.lastConnected).sort((a, b) => b.lastConnected!.localeCompare(a.lastConnected!))
  for (const item of recent.slice(bigQueryLibraryLimits.recent)) delete item.lastConnected
  library.profiles = library.profiles.filter(item => item.favorite || item.saved || item.lastConnected)
  if (library.profiles.length > bigQueryLibraryLimits.profiles) throw new Error('The connection library supports up to 200 saved BigQuery connections.')
}

/**
 * BigQuery's saved connections in `bigquery-connections.json` (docs/bigquery.md, Saved connections), written atomically and
 * quarantined when unreadable, as SQL Server's library is. Each saved key file reference is registered with `keyFiles` at
 * every read, so a saved profile (and a target restored from one) finds its path after a restart.
 */
export class BigQueryConnectionStore {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string, private readonly keyFiles: BigQueryKeyFiles) {}

  private async read(): Promise<{ library: BigQueryLibraryFile; warning?: string }> {
    const read = await readJsonFile(this.path, limit)
    let library: BigQueryLibraryFile | undefined
    if (read.kind === 'missing') library = empty()
    else if (read.kind === 'ok') {
      const parsed = bigQueryLibraryFileSchema.safeParse(read.value)
      if (parsed.success) library = parsed.data
    }
    if (!library) {
      await quarantine(this.path)
      return { library: empty(), warning: 'The saved BigQuery connections were invalid. Their original file was preserved.' }
    }
    // A path this platform cannot use (a Windows path read on Linux or macOS) makes the file invalid too, rather than
    // failing every later read.
    try { for (const profile of library.profiles) if (profile.options.keyFile && profile.keyPath) this.keyFiles.remember(profile.options.keyFile, profile.keyPath) }
    catch {
      await quarantine(this.path)
      return { library: empty(), warning: 'The saved BigQuery connections were invalid. Their original file was preserved.' }
    }
    return { library }
  }

  /** The library as the renderer sees it: key files by reference and name, never their paths. */
  static view(library: BigQueryLibraryFile): BigQueryLibraryView {
    return { profiles: library.profiles.map(({ keyPath, ...profile }): BigQueryConnectionProfile => ({ ...profile, ...keyPath ? { keyFileName: basename(keyPath) } : {} })) }
  }

  async load(): Promise<{ library: BigQueryLibraryFile; warning?: string }> { await this.writes; return this.read() }

  /** Reads, applies `update` and writes the result, unless `unchanged` says the update changed nothing. */
  private change<T>(update: (value: BigQueryLibraryFile) => T, unchanged?: (value: T) => boolean): Promise<{ library: BigQueryLibraryFile; value: T }> {
    const next = this.writes.then(async () => {
      const { library } = await this.read()
      const value = update(library)
      const valid = bigQueryLibraryFileSchema.parse(library)
      if (unchanged?.(value)) return { library: valid, value }
      await writeJsonAtomic(this.path, valid, limit, 'Too many saved BigQuery connections.')
      return { library: valid, value }
    })
    this.writes = next.catch(() => {})
    return next
  }

  /** The path a profile's key file reference stands for, from the picker's registry: a reference main no longer knows
   *  cannot be saved, since its path could not be found again. */
  private keyPath(options: BigQueryConnectionOptions): string | undefined {
    if (options.keyFile === undefined) return undefined
    const path = this.keyFiles.path(options.keyFile)
    if (path === undefined) throw new Error('The key file is no longer available. Choose it again.')
    return path
  }

  /** Save, a favourite star, or (`connected`) a connect's history entry; resolves the entry's id and environment. With
   *  `keepEnvironment`, options without an environment keep the entry's label, as SQL Server's library does. */
  async upsert(value: BigQueryProfileInput, connected = false, keepEnvironment = false, selectedProfileId?: string): Promise<{ library: BigQueryLibraryFile; id: string; environment?: string }> {
    const input = bigQueryProfileInputSchema.parse(value)
    const options = stored(input.options), keyPath = this.keyPath(options), key = keyOf(options)
    const changed = await this.change(library => {
      const selected = selectedProfileId ? library.profiles.find(item => item.id === selectedProfileId && keyOf(item.options) === key) : undefined
      let profile: BigQueryStoredProfile | undefined = input.id ? library.profiles.find(item => item.id === input.id) : selected ?? library.profiles.find(item => keyOf(item.options) === key)
      if (input.id && !profile) throw new Error('This saved connection no longer exists.')
      if (!profile) { profile = { id: randomUUID(), options, favorite: false, autoReconnect: 'inherit' }; library.profiles.push(profile) }
      const kept = keepEnvironment && options.environment === undefined ? profile.options.environment : undefined
      profile.options = kept ? { ...options, environment: kept } : options
      if (keyPath) profile.keyPath = keyPath
      else delete profile.keyPath
      if (input.favorite !== undefined) profile.favorite = input.favorite
      if (input.saved && !profile.lastConnected) profile.saved = true
      if (input.autoReconnect !== undefined) profile.autoReconnect = input.autoReconnect
      if (connected) { profile.lastConnected = new Date().toISOString(); delete profile.saved }
      prune(library)
      return { id: profile.id, environment: profile.options.environment }
    })
    return { library: changed.library, ...changed.value }
  }

  rememberEntry(options: BigQueryConnectionOptions, keepEnvironment = false, autoReconnect?: BigQueryStoredProfile['autoReconnect'], selectedProfileId?: string) {
    return this.upsert({ options, autoReconnect }, true, keepEnvironment, selectedProfileId)
  }

  async setAutoReconnect(options: BigQueryConnectionOptions, value: NonNullable<BigQueryStoredProfile['autoReconnect']>, selectedProfileId?: string): Promise<boolean> {
    const preference = connectionAutoReconnectSchema.parse(value), key = keyOf(stored(options))
    return (await this.change(library => {
      const profile = (selectedProfileId ? library.profiles.find(item => item.id === selectedProfileId && keyOf(item.options) === key) : undefined) ?? library.profiles.find(item => keyOf(item.options) === key)
      if (!profile) return false
      profile.autoReconnect = preference
      return true
    })).value
  }

  /** Set Connection Environment for a live BigQuery connection: only its entry's label changes. */
  async setEnvironment(value: unknown): Promise<BigQueryLibraryFile> {
    const input = bigQueryEnvironmentInputSchema.parse(value)
    const options = stored(input.options), key = keyOf(options), keyPath = this.keyPath(options)
    return (await this.change(library => {
      let profile = library.profiles.find(item => keyOf(item.options) === key)
      if (!profile) { profile = { id: randomUUID(), options, favorite: false, autoReconnect: 'inherit', lastConnected: new Date().toISOString(), ...keyPath ? { keyPath } : {} }; library.profiles.push(profile) }
      const next = { ...profile.options }
      if (input.environment) next.environment = input.environment
      else delete next.environment
      profile.options = next
      prune(library)
      if (!library.profiles.includes(profile)) throw new Error('The connection could not be kept in the saved connections.')
    })).library
  }

  /** Removes an entry; resolves whether this library had it (SQL Server's library has the others). */
  async remove(id: string): Promise<{ library: BigQueryLibraryFile; removed: boolean }> {
    const changed = await this.change(library => {
      const before = library.profiles.length
      library.profiles = library.profiles.filter(item => item.id !== id)
      return library.profiles.length !== before
    }, removed => !removed)
    return { library: changed.library, removed: changed.value }
  }

  /** Whether the user confirmed `source` for the configuration at `keyPath` (decision 49). */
  async sourceConfirmed(keyPath: string, source: string): Promise<boolean> {
    const { library } = await this.load()
    return !!library.confirmedSources?.some(item => item.keyPath === keyPath && item.source === source)
  }

  /** Records the user's confirmation; the oldest is forgotten past 64. */
  async confirmSource(keyPath: string, source: string): Promise<void> {
    await this.change(library => {
      const kept = (library.confirmedSources ?? []).filter(item => item.keyPath !== keyPath)
      kept.push({ keyPath, source })
      library.confirmedSources = kept.slice(-bigQueryLibraryLimits.confirmedSources)
    })
  }
}
