import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { bigQueryProjectSchema, connectionAutoReconnectSchema, connectionKey } from '../shared/connections'
import {
  bigQueryCostPromptInputSchema, bigQueryCostThresholdInputSchema, bigQueryEnvironmentInputSchema, bigQueryLibraryFileSchema, bigQueryLibraryLimits, bigQueryProfileInputSchema,
  bigQueryStarProjectInputSchema, bigQueryStarredPrincipalSchema,
  type BigQueryConnectionProfile, type BigQueryLibraryFile, type BigQueryLibraryView, type BigQueryProfileInput, type BigQueryStarredProjectsView, type BigQueryStoredProfile
} from '../shared/bigquery-connections'
import type { BigQueryConnectionOptions } from '../shared/contracts'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'
import type { BigQueryKeyFiles } from './bigquery-credentials'

const limit = 2_000_000
const empty = (): BigQueryLibraryFile => ({ version: 1, profiles: [] })
/** The options a profile keeps: the validated BigQuery options (they hold no secret; the key file is a reference). */
const stored = (options: BigQueryConnectionOptions): BigQueryConnectionOptions => bigQueryProfileInputSchema.shape.options.parse(options)
const keyOf = (options: BigQueryConnectionOptions) => connectionKey(options)

/**
 * Tolerates pre-upgrade `bigquery-connections.json` files whose saved BigQuery profiles still carry `extraProjects`:
 * strips `extraProjects` from each profile's options and collects those valid project IDs into `migratedProjects`, so
 * they are claimed into `starredProjects` on the next BigQuery connect instead of quarantining the library.
 */
function migrateLegacyLibrary(raw: unknown): { value: unknown; migrated: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, migrated: false }
  const record = raw as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.profiles)) return { value: raw, migrated: false }
  const collected: string[] = []
  let migrated = false
  const profiles = record.profiles.map(profile => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile
    const entry = profile as Record<string, unknown>
    const options = entry.options
    if (!options || typeof options !== 'object' || Array.isArray(options)) return profile
    const opts = options as Record<string, unknown>
    if (opts.provider !== 'bigquery' || !Object.hasOwn(opts, 'extraProjects')) return profile
    const extra = opts.extraProjects
    if (extra !== undefined && (!Array.isArray(extra) || !extra.every(item => typeof item === 'string' && bigQueryProjectSchema.safeParse(item).success))) return profile
    migrated = true
    const billing = typeof opts.project === 'string' ? opts.project : ''
    if (Array.isArray(extra)) {
      for (const project of extra) if (project !== billing && !collected.includes(project)) collected.push(project)
    }
    const { extraProjects: _extraProjects, ...rest } = opts
    return { ...entry, options: rest }
  })
  if (!migrated) return { value: raw, migrated: false }
  const existing = Array.isArray(record.migratedProjects) ? record.migratedProjects.filter((item): item is string => typeof item === 'string' && bigQueryProjectSchema.safeParse(item).success) : []
  const merged: string[] = [...existing]
  for (const project of collected) if (!merged.includes(project) && merged.length < bigQueryLibraryLimits.starredPerPrincipal) merged.push(project)
  const next: Record<string, unknown> = { ...record, profiles }
  if (merged.length) next.migratedProjects = merged
  return { value: next, migrated: true }
}

/** Merges valid, deduplicated project IDs into `principal`'s starred list within `bigQueryLibraryLimits`. Returns true when changed. */
function mergeStarred(library: BigQueryLibraryFile, principal: string, projects: readonly string[]): boolean {
  const valid: string[] = []
  for (const project of projects) if (bigQueryProjectSchema.safeParse(project).success && !valid.includes(project)) valid.push(project)
  if (!valid.length) return false
  const list = library.starredProjects ?? []
  const entry = list.find(item => item.principal === principal)
  if (entry) {
    let changed = false
    for (const project of valid) {
      if (entry.projects.includes(project)) continue
      if (entry.projects.length >= bigQueryLibraryLimits.starredPerPrincipal) break
      entry.projects.push(project)
      changed = true
    }
    return changed
  }
  if (list.length >= bigQueryLibraryLimits.starredPrincipals) return false
  const added = valid.slice(0, bigQueryLibraryLimits.starredPerPrincipal)
  library.starredProjects = [...list, { principal, projects: added }]
  return true
}

/** The cost-prompt choice of every entry with these settings (one connection, however many entries name it); true, the
 *  default, is not stored. */
function setChoice(library: BigQueryLibraryFile, key: string, costPrompt: boolean) {
  for (const item of library.profiles) {
    if (keyOf(item.options) !== key) continue
    const { costPrompt: _costPrompt, ...next } = item.options
    item.options = costPrompt ? next : { ...next, costPrompt: false }
  }
}

/** The cost-prompt threshold of every entry with these settings, like the choice; 0 (Options' threshold) is not stored. */
function setThreshold(library: BigQueryLibraryFile, key: string, costThreshold: number) {
  for (const item of library.profiles) {
    if (keyOf(item.options) !== key) continue
    const { costThreshold: _costThreshold, ...next } = item.options
    item.options = costThreshold ? { ...next, costThreshold } : next
  }
}
/** The threshold entries with these settings share, if any. */
const sharedThreshold = (library: BigQueryLibraryFile, key: string) => library.profiles.find(item => item.options.costThreshold && keyOf(item.options) === key)?.options.costThreshold

/** History keeps the 30 most recent connections; an entry that is not a favourite, saved or recent is dropped. A dropped
 *  entry's key file stays known by its reference (`keptKeyFiles`, newest last), so a target restored from it still finds
 *  the file; a reference an entry holds again is the entry's. */
function prune(library: BigQueryLibraryFile) {
  const recent = library.profiles.filter(item => item.lastConnected).sort((a, b) => b.lastConnected!.localeCompare(a.lastConnected!))
  for (const item of recent.slice(bigQueryLibraryLimits.recent)) delete item.lastConnected
  const dropped = library.profiles.filter(item => !(item.favorite || item.saved || item.lastConnected))
  library.profiles = library.profiles.filter(item => item.favorite || item.saved || item.lastConnected)
  const held = new Set(library.profiles.flatMap(item => item.options.keyFile ? [item.options.keyFile] : []))
  const kept = (library.keptKeyFiles ?? []).filter(item => !held.has(item.reference))
  for (const item of dropped) {
    const reference = item.options.keyFile
    if (!reference || !item.keyPath || held.has(reference)) continue
    const at = kept.findIndex(other => other.reference === reference)
    if (at >= 0) kept.splice(at, 1)
    kept.push({ reference, keyPath: item.keyPath })
  }
  if (kept.length) library.keptKeyFiles = kept.slice(-bigQueryLibraryLimits.keptKeyFiles)
  else delete library.keptKeyFiles
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

  private async read(): Promise<{ library: BigQueryLibraryFile; warning?: string; migrated?: boolean }> {
    const read = await readJsonFile(this.path, limit)
    let library: BigQueryLibraryFile | undefined
    let migrated = false
    if (read.kind === 'missing') library = empty()
    else if (read.kind === 'ok') {
      const legacy = migrateLegacyLibrary(read.value)
      migrated = legacy.migrated
      const parsed = bigQueryLibraryFileSchema.safeParse(legacy.value)
      if (parsed.success) library = parsed.data
    }
    if (!library) {
      await quarantine(this.path)
      return { library: empty(), warning: 'The saved BigQuery connections were invalid. Their original file was preserved.' }
    }
    // A path this platform cannot use (a Windows path read on Linux or macOS) makes the file invalid too, rather than
    // failing every later read.
    try {
      for (const kept of library.keptKeyFiles ?? []) this.keyFiles.remember(kept.reference, kept.keyPath)
      for (const profile of library.profiles) if (profile.options.keyFile && profile.keyPath) this.keyFiles.remember(profile.options.keyFile, profile.keyPath)
    }
    catch {
      await quarantine(this.path)
      return { library: empty(), warning: 'The saved BigQuery connections were invalid. Their original file was preserved.' }
    }
    return { library, ...migrated ? { migrated: true } : {} }
  }

  /** The library as the renderer sees it: key files by reference and name, never their paths. */
  static view(library: BigQueryLibraryFile): BigQueryLibraryView {
    return { profiles: library.profiles.map(({ keyPath, ...profile }): BigQueryConnectionProfile => ({ ...profile, ...keyPath ? { keyFileName: basename(keyPath) } : {} })) }
  }

  /** Starred projects indexed by verified principal, as the renderer sees them. */
  static starredView(library: BigQueryLibraryFile): BigQueryStarredProjectsView {
    const byPrincipal: Record<string, readonly string[]> = {}
    for (const entry of library.starredProjects ?? []) byPrincipal[entry.principal] = [...entry.projects]
    return { byPrincipal }
  }

  async load(): Promise<{ library: BigQueryLibraryFile; warning?: string }> {
    await this.writes
    const result = await this.read()
    // Persist the stripped pre-upgrade library so disk stays migrated even before the next write.
    if (result.migrated) await this.change(() => {}).catch(() => {})
    return { library: result.library, ...result.warning ? { warning: result.warning } : {} }
  }

  /** Reads, applies `update` and writes the result, unless `unchanged` says the update changed nothing. */
  private change<T>(update: (value: BigQueryLibraryFile) => T, unchanged?: (value: T) => boolean): Promise<{ library: BigQueryLibraryFile; value: T }> {
    const next = this.writes.then(async () => {
      const { library, migrated } = await this.read()
      const value = update(library)
      const valid = bigQueryLibraryFileSchema.parse(library)
      if (!migrated && unchanged?.(value)) return { library: valid, value }
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
      // Options that do not name the cost-prompt choice take the one entries with these settings share (the choice is the
      // connection's, not the entry's: an entry edited to new settings leaves its old choice behind); true is the default.
      const shared = library.profiles.some(item => item.options.costPrompt === false && keyOf(item.options) === key) ? false : undefined
      const costPrompt = options.costPrompt ?? shared
      // The threshold likewise: options that name none (a connect from a live connection's settings) keep the shared one,
      // and 0 clears it.
      const costThreshold = options.costThreshold ?? sharedThreshold(library, key)
      const { costPrompt: _costPrompt, costThreshold: _costThreshold, ...rest } = kept ? { ...options, environment: kept } : options
      profile.options = { ...rest, ...costPrompt === false ? { costPrompt: false } : {}, ...costThreshold ? { costThreshold } : {} }
      // A choice the options name is the connection's: entries with the same settings take it too.
      if (options.costPrompt !== undefined) setChoice(library, key, options.costPrompt)
      if (options.costThreshold !== undefined) setThreshold(library, key, options.costThreshold)
      if (keyPath) profile.keyPath = keyPath
      else delete profile.keyPath
      if (input.favorite !== undefined) profile.favorite = input.favorite
      if (input.lastConnected !== undefined && !connected) { profile.lastConnected = input.lastConnected; delete profile.saved }
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
      if (!profile) {
        // Only the label changes: the cost preferences take their defaults until set.
        const { costPrompt: _costPrompt, costThreshold: _costThreshold, ...plain } = options
        profile = { id: randomUUID(), options: plain, favorite: false, autoReconnect: 'inherit', lastConnected: new Date().toISOString(), ...keyPath ? { keyPath } : {} }
        library.profiles.push(profile)
      }
      const next = { ...profile.options }
      if (input.environment) next.environment = input.environment
      else delete next.environment
      profile.options = next
      prune(library)
      if (!library.profiles.includes(profile)) throw new Error('The connection could not be kept in the saved connections.')
    })).library
  }

  /** "Don't ask again for this connection" for a live BigQuery connection: only its entry's cost-prompt choice changes. */
  async setCostPrompt(value: unknown): Promise<BigQueryLibraryFile> {
    const input = bigQueryCostPromptInputSchema.parse(value)
    return this.setForEntry(input.options, (library, key) => setChoice(library, key, input.costPrompt))
  }

  /** The connection's own cost-prompt threshold, named by a connect that reused a live connection: only its entry's
   *  threshold changes (0 clears it). */
  async setCostThreshold(value: unknown): Promise<BigQueryLibraryFile> {
    const input = bigQueryCostThresholdInputSchema.parse(value)
    // Clearing a threshold settings with no entry never had adds no History entry.
    return this.setForEntry(input.options, (library, key) => setThreshold(library, key, input.costThreshold), input.costThreshold !== 0)
  }

  /** Applies `apply` to the entries with these settings, adding an entry for them first when there is none. */
  private async setForEntry(value: BigQueryConnectionOptions, apply: (library: BigQueryLibraryFile, key: string) => void, create = true): Promise<BigQueryLibraryFile> {
    const options = stored(value), key = keyOf(options), keyPath = this.keyPath(options)
    return (await this.change(library => {
      let profile = library.profiles.find(item => keyOf(item.options) === key)
      if (!profile && !create) return
      if (!profile) {
        // A new entry keeps only what the options name for it: the other preferences take their defaults until set.
        const { costPrompt: _costPrompt, costThreshold: _costThreshold, ...plain } = options
        profile = { id: randomUUID(), options: plain, favorite: false, autoReconnect: 'inherit', lastConnected: new Date().toISOString(), ...keyPath ? { keyPath } : {} }
        library.profiles.push(profile)
      }
      apply(library, key)
      prune(library)
      if (!library.profiles.includes(profile)) throw new Error('The connection could not be kept in the saved connections.')
    })).library
  }

  /** Removes an entry; resolves whether this library had it (SQL Server's library has the others). */
  async remove(id: string): Promise<{ library: BigQueryLibraryFile; removed: boolean }> {
    const changed = await this.change(library => {
      const before = library.profiles.length
      const gone = library.profiles.find(item => item.id === id)
      library.profiles = library.profiles.filter(item => item.id !== id)
      // Removing an entry forgets its key file's path, a pruned copy of it included.
      if (gone?.keyPath && library.keptKeyFiles) library.keptKeyFiles = library.keptKeyFiles.filter(item => item.keyPath !== gone.keyPath)
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

  /** Per-principal starred projects persisted in `bigquery-connections.json`. */
  async loadStarredProjects(): Promise<BigQueryStarredProjectsView> {
    const { library } = await this.load()
    return BigQueryConnectionStore.starredView(library)
  }

  /** Stars or unstars `project` for a verified BigQuery principal, bounded by `bigQueryLibraryLimits`. */
  async setProjectStar(value: unknown): Promise<BigQueryStarredProjectsView> {
    const input = bigQueryStarProjectInputSchema.parse(value)
    const changed = await this.change(library => {
      const list = library.starredProjects ?? []
      const entry = list.find(item => item.principal === input.principal)
      if (input.starred) {
        if (entry) {
          if (entry.projects.includes(input.project)) return false
          if (entry.projects.length >= bigQueryLibraryLimits.starredPerPrincipal) throw new Error(`You can star at most ${bigQueryLibraryLimits.starredPerPrincipal} projects per account.`)
          entry.projects.push(input.project)
          return true
        }
        if (list.length >= bigQueryLibraryLimits.starredPrincipals) throw new Error(`Too many BigQuery accounts have starred projects (at most ${bigQueryLibraryLimits.starredPrincipals}).`)
        library.starredProjects = [...list, { principal: input.principal, projects: [input.project] }]
        return true
      }
      if (!entry || !entry.projects.includes(input.project)) return false
      entry.projects = entry.projects.filter(project => project !== input.project)
      if (!entry.projects.length) {
        const remaining = list.filter(item => item !== entry)
        if (remaining.length) library.starredProjects = remaining
        else delete library.starredProjects
      }
      return true
    }, changed => !changed)
    return BigQueryConnectionStore.starredView(changed.library)
  }

  /** Bulk-adds starred projects for a verified principal (used when migrating legacy workspace `extraProjects`). */
  async addStarredProjects(principal: string, projects: readonly string[]): Promise<BigQueryStarredProjectsView> {
    const validPrincipal = bigQueryStarredPrincipalSchema.parse(principal)
    const changed = await this.change(library => mergeStarred(library, validPrincipal, projects), changed => !changed)
    return BigQueryConnectionStore.starredView(changed.library)
  }

  /** Records legacy `extraProjects` whose principal was not yet known, to be claimed on the next BigQuery connect. */
  async addMigratedProjects(projects: readonly string[]): Promise<void> {
    const valid = projects.filter(project => bigQueryProjectSchema.safeParse(project).success)
    if (!valid.length) return
    await this.change(library => {
      const current = library.migratedProjects ?? []
      let changed = false
      const next = [...current]
      for (const project of valid) {
        if (next.includes(project)) continue
        if (next.length >= bigQueryLibraryLimits.starredPerPrincipal) break
        next.push(project)
        changed = true
      }
      if (changed) library.migratedProjects = next
      return changed
    }, changed => !changed)
  }

  /** Claims any pending `migratedProjects` into `principal`'s `starredProjects` on BigQuery connect. */
  async claimMigratedProjects(principal: string): Promise<{ claimed: readonly string[]; view: BigQueryStarredProjectsView }> {
    const validPrincipal = bigQueryStarredPrincipalSchema.parse(principal)
    const changed = await this.change(library => {
      const pending = library.migratedProjects
      if (!pending?.length) return [] as string[]
      delete library.migratedProjects
      mergeStarred(library, validPrincipal, pending)
      return pending
    }, claimed => !claimed.length)
    return { claimed: changed.value, view: BigQueryConnectionStore.starredView(changed.library) }
  }
}
