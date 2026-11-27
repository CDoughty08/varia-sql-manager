import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { bigQueryProjectSchema, connectionAutoReconnectSchema, connectionKey } from '../shared/connections'
import {
  bigQueryCostPromptInputSchema, bigQueryCostThresholdInputSchema, bigQueryEnvironmentInputSchema, bigQueryLibraryFileSchema, bigQueryLibraryLimits, bigQueryProfileInputSchema,
  bigQueryStarredPrincipalSchema, bigQueryStoredProfileSchema,
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
 * strips `extraProjects` from each profile's options and keeps those valid project IDs attached to that originating
 * profile (`migratedProjects`), so each account claims only its own legacy projects on reconnect instead of pooling
 * across accounts or quarantining the library.
 */
function migrateLegacyLibrary(raw: unknown): { value: unknown; migrated: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, migrated: false }
  const record = raw as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.profiles)) return { value: raw, migrated: false }
  let migrated = false
  let invalidExisting = false
  const profiles = record.profiles.map(profile => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile
    const entry = profile as Record<string, unknown>
    const options = entry.options
    if (!options || typeof options !== 'object' || Array.isArray(options)) return profile
    const opts = options as Record<string, unknown>
    if (opts.provider !== 'bigquery' || !Object.hasOwn(opts, 'extraProjects')) return profile
    const extra = opts.extraProjects
    // Pre-upgrade bigQueryLimits.extraProjects was 16; oversized or malformed arrays still quarantine.
    if (extra !== undefined && (!Array.isArray(extra) || extra.length > bigQueryLibraryLimits.legacyExtraProjects || !extra.every(item => typeof item === 'string' && bigQueryProjectSchema.safeParse(item).success))) return profile
    const existingMigrated = bigQueryStoredProfileSchema.shape.migratedProjects.safeParse(entry.migratedProjects)
    if (!existingMigrated.success) { invalidExisting = true; return profile }
    const existingMigratedKey = bigQueryStoredProfileSchema.shape.migratedKey.safeParse(entry.migratedKey)
    if (!existingMigratedKey.success) { invalidExisting = true; return profile }
    migrated = true
    const billing = typeof opts.project === 'string' ? opts.project : ''
    const merged: string[] = [...existingMigrated.data ?? []]
    if (Array.isArray(extra)) {
      for (const project of extra) if (project !== billing && !merged.includes(project) && merged.length < bigQueryLibraryLimits.legacyExtraProjects) merged.push(project)
    }
    const { extraProjects: _extraProjects, ...rest } = opts
    const nextEntry: Record<string, unknown> = { ...entry, options: rest }
    if (merged.length) {
      nextEntry.migratedProjects = merged
      const parsedOptions = bigQueryProfileInputSchema.shape.options.safeParse(rest)
      if (!existingMigratedKey.data && parsedOptions.success) nextEntry.migratedKey = keyOf(parsedOptions.data)
    } else {
      delete nextEntry.migratedProjects
      delete nextEntry.migratedKey
    }
    return nextEntry
  })
  if (!migrated || invalidExisting) return { value: raw, migrated: false }
  return { value: { ...record, profiles }, migrated: true }
}

/** Merges valid, deduplicated project IDs into `principal`'s starred list within `bigQueryLibraryLimits`. */
function mergeStarred(library: BigQueryLibraryFile, principal: string, projects: readonly string[]): { changed: boolean; claimed: string[]; remaining: string[] } {
  const valid: string[] = []
  for (const project of projects) if (bigQueryProjectSchema.safeParse(project).success && !valid.includes(project)) valid.push(project)
  if (!valid.length) return { changed: false, claimed: [], remaining: [] }
  const list = library.starredProjects ?? []
  const entry = list.find(item => item.principal === principal)
  if (entry) {
    let changed = false
    const claimed: string[] = []
    const remaining: string[] = []
    for (const project of valid) {
      if (entry.projects.includes(project)) { claimed.push(project); continue }
      if (entry.projects.length >= bigQueryLibraryLimits.starredPerPrincipal) { remaining.push(project); continue }
      entry.projects.push(project)
      claimed.push(project)
      changed = true
    }
    return { changed, claimed, remaining }
  }
  if (list.length >= bigQueryLibraryLimits.starredPrincipals) return { changed: false, claimed: [], remaining: valid }
  const added = valid.slice(0, bigQueryLibraryLimits.starredPerPrincipal)
  const remaining = valid.slice(bigQueryLibraryLimits.starredPerPrincipal)
  library.starredProjects = [...list, { principal, projects: added }]
  return { changed: true, claimed: added, remaining }
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
 *  the file; a reference an entry holds again is the entry's. Same-millisecond ties keep `touched`, then later entries. */
function prune(library: BigQueryLibraryFile, touched?: BigQueryStoredProfile) {
  const order = new Map(library.profiles.map((item, at) => [item, at]))
  const recent = library.profiles.filter(item => item.lastConnected).sort((a, b) =>
    b.lastConnected!.localeCompare(a.lastConnected!)
    || (b === touched ? 1 : a === touched ? -1 : 0)
    || order.get(b)! - order.get(a)!)
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
/** A recency timestamp strictly newer than existing same-millisecond entries without reordering `library.profiles`
 *  (which preserves Favorites order and duplicate-key lookup order). Bounded to 60 s ahead of `now()` so a far-future
 *  timestamp on disk cannot skew new writes. */
function recentTimestamp(profiles: readonly BigQueryStoredProfile[], now: () => Date): string {
  const current = now().getTime(), cap = current + 60_000
  let latest = current
  for (const item of profiles) {
    if (!item.lastConnected) continue
    const ms = Date.parse(item.lastConnected)
    if (Number.isFinite(ms) && ms >= latest && ms <= cap) latest = Math.min(ms + 1, cap)
  }
  return new Date(latest).toISOString()
}

/**
 * BigQuery's saved connections in `bigquery-connections.json` (docs/bigquery.md, Saved connections), written atomically and
 * quarantined when unreadable, as SQL Server's library is. Each saved key file reference is registered with `keyFiles` at
 * every read, so a saved profile (and a target restored from one) finds its path after a restart.
 */
export class BigQueryConnectionStore {
  private writes: Promise<unknown> = Promise.resolve()
  /** Retained when an internal startup read (e.g. starred projects) quarantines an invalid library so the Connect dialog still surfaces the recovery warning. */
  private pendingWarning: string | undefined
  constructor(private readonly path: string, private readonly keyFiles: BigQueryKeyFiles, private readonly now: () => Date = () => new Date()) {}

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
      const warning = 'The saved BigQuery connections were invalid. Their original file was preserved.'
      this.pendingWarning = warning
      return { library: empty(), warning }
    }
    // A path this platform cannot use (a Windows path read on Linux or macOS) makes the file invalid too, rather than
    // failing every later read.
    try {
      for (const kept of library.keptKeyFiles ?? []) this.keyFiles.remember(kept.reference, kept.keyPath)
      for (const profile of library.profiles) if (profile.options.keyFile && profile.keyPath) this.keyFiles.remember(profile.options.keyFile, profile.keyPath)
    }
    catch {
      await quarantine(this.path)
      const warning = 'The saved BigQuery connections were invalid. Their original file was preserved.'
      this.pendingWarning = warning
      return { library: empty(), warning }
    }
    return { library, ...migrated ? { migrated: true } : {} }
  }

  /** Records valid projects into `library.migratedTargets` under `targetId` within bounds; returns whether the library changed. */
  private static recordMigratedTarget(library: BigQueryLibraryFile, targetId: string, projects: readonly string[]): boolean {
    const valid: string[] = []
    for (const project of projects) if (bigQueryProjectSchema.safeParse(project).success && !valid.includes(project) && valid.length < bigQueryLibraryLimits.legacyExtraProjects) valid.push(project)
    if (!valid.length) return false
    const list = library.migratedTargets ?? []
    const existing = list.find(entry => entry.targetId === targetId)
    if (existing) {
      let changed = false
      for (const project of valid) {
        if (existing.projects.includes(project)) continue
        if (existing.projects.length >= bigQueryLibraryLimits.legacyExtraProjects) break
        existing.projects.push(project)
        changed = true
      }
      return changed
    }
    if (list.length >= bigQueryLibraryLimits.migratedTargets) return false
    library.migratedTargets = [...list, { targetId, projects: valid }]
    return true
  }

  /** Retained in memory when a disk write fails during session migration so untransferred target projects flush on the next successful write or claim. */
  private readonly pendingTargetProjects = new Map<string, string[]>()

  private rememberPendingTarget(targetId: string, projects: readonly string[]): void {
    const valid: string[] = []
    for (const project of projects) if (bigQueryProjectSchema.safeParse(project).success && !valid.includes(project) && valid.length < bigQueryLibraryLimits.legacyExtraProjects) valid.push(project)
    if (!valid.length) return
    const existing = this.pendingTargetProjects.get(targetId)
    if (existing) {
      for (const project of valid) if (!existing.includes(project) && existing.length < bigQueryLibraryLimits.legacyExtraProjects) existing.push(project)
      return
    }
    if (this.pendingTargetProjects.size < bigQueryLibraryLimits.migratedTargets) this.pendingTargetProjects.set(targetId, valid)
  }

  /** The library as the renderer sees it: key files by reference and name, never their paths or internal migration state. */
  static view(library: BigQueryLibraryFile): BigQueryLibraryView {
    return { profiles: library.profiles.map(({ keyPath, migratedProjects: _migratedProjects, migratedKey: _migratedKey, ...profile }): BigQueryConnectionProfile => ({ ...profile, ...keyPath ? { keyFileName: basename(keyPath) } : {} })) }
  }

  /** Starred projects indexed by verified principal, optionally filtered to a live-connection allowlist. */
  static starredView(library: BigQueryLibraryFile, allowedPrincipals?: ReadonlySet<string>): BigQueryStarredProjectsView {
    const byPrincipal: Record<string, readonly string[]> = Object.create(null)
    for (const entry of library.starredProjects ?? []) {
      if (allowedPrincipals && !allowedPrincipals.has(entry.principal)) continue
      byPrincipal[entry.principal] = [...entry.projects]
    }
    return { byPrincipal }
  }

  /** Serialized read that persists legacy migration without consuming `pendingWarning` (used by internal callers). */
  private readSerialized(): Promise<{ library: BigQueryLibraryFile; warning?: string }> {
    const next = this.writes.then(async () => {
      const result = await this.read()
      // Persist the stripped pre-upgrade library inside the same serialized slot so concurrent callers see the migrated state and never race on quarantine.
      if (result.migrated) {
        const valid = bigQueryLibraryFileSchema.parse(result.library)
        try { await writeJsonAtomic(this.path, valid, limit, 'Too many saved BigQuery connections.') } catch { /* Best-effort migration persistence. */ }
        return { library: valid, ...result.warning ? { warning: result.warning } : {} }
      }
      return { library: result.library, ...result.warning ? { warning: result.warning } : {} }
    })
    this.writes = next.catch(() => {})
    return next
  }

  /** Non-consuming read for internal callers (job cancellation, key-file restore, profile lookup) that preserves any pending recovery warning for the Connect dialog. */
  async peek(): Promise<{ library: BigQueryLibraryFile }> {
    const { library } = await this.readSerialized()
    return { library }
  }

  async load(): Promise<{ library: BigQueryLibraryFile; warning?: string }> {
    const result = await this.readSerialized()
    const warning = result.warning ?? this.pendingWarning
    this.pendingWarning = undefined
    return { library: result.library, ...warning ? { warning } : {} }
  }

  /** Reads, applies `update` and writes the result, unless `unchanged` says the update changed nothing. */
  private change<T>(update: (value: BigQueryLibraryFile) => T, unchanged?: (value: T) => boolean): Promise<{ library: BigQueryLibraryFile; value: T }> {
    const next = this.writes.then(async () => {
      const { library, migrated } = await this.read()
      let flushedPending = false
      const pendingSnapshot = [...this.pendingTargetProjects.entries()].map(([id, projects]) => [id, [...projects]] as const)
      for (const [targetId, projects] of pendingSnapshot) {
        if (BigQueryConnectionStore.recordMigratedTarget(library, targetId, projects)) flushedPending = true
      }
      const value = update(library)
      const valid = bigQueryLibraryFileSchema.parse(library)
      if (!migrated && !flushedPending && unchanged?.(value)) return { library: valid, value }
      await writeJsonAtomic(this.path, valid, limit, 'Too many saved BigQuery connections.')
      for (const [targetId, projects] of pendingSnapshot) {
        const current = this.pendingTargetProjects.get(targetId)
        if (!current) continue
        const remaining = current.filter(project => !projects.includes(project))
        if (remaining.length) this.pendingTargetProjects.set(targetId, remaining)
        else this.pendingTargetProjects.delete(targetId)
      }
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
      else if (profile.migratedProjects?.length && !profile.migratedKey) {
        // Bind pending legacy projects to the profile's original connection identity before options are edited.
        profile.migratedKey = keyOf(profile.options)
      }
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
      if (connected) { profile.lastConnected = recentTimestamp(library.profiles, this.now); delete profile.saved }
      prune(library, profile)
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
        profile = { id: randomUUID(), options: plain, favorite: false, autoReconnect: 'inherit', lastConnected: recentTimestamp(library.profiles, this.now), ...keyPath ? { keyPath } : {} }
        library.profiles.push(profile)
      }
      const next = { ...profile.options }
      if (input.environment) next.environment = input.environment
      else delete next.environment
      profile.options = next
      prune(library, profile)
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
        profile = { id: randomUUID(), options: plain, favorite: false, autoReconnect: 'inherit', lastConnected: recentTimestamp(library.profiles, this.now), ...keyPath ? { keyPath } : {} }
        library.profiles.push(profile)
      }
      apply(library, key)
      prune(library, profile)
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

  /** Whether the user confirmed `source` for the configuration at `keyPath`, so its token file goes to Google's STS only after a yes. */
  async sourceConfirmed(keyPath: string, source: string): Promise<boolean> {
    const { library } = await this.readSerialized()
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

  /** Per-principal starred projects persisted in `bigquery-connections.json`, filtered to currently live verified principals when `allowedPrincipals` is provided. */
  async loadStarredProjects(allowedPrincipals?: ReadonlySet<string>): Promise<BigQueryStarredProjectsView> {
    const { library } = await this.readSerialized()
    return BigQueryConnectionStore.starredView(library, allowedPrincipals)
  }

  /** Authoritative persisted starred projects for a single verified BigQuery principal (used by main to validate index and bulk requests). */
  async starredProjectsFor(principal: string): Promise<readonly string[]> {
    if (principal.startsWith('bigquery:anonymous:')) return []
    const { library } = await this.readSerialized()
    const entry = library.starredProjects?.find(item => item.principal === principal)
    return entry ? [...entry.projects] : []
  }

  /** Stars or unstars `project` for a main-verified BigQuery principal, bounded by `bigQueryLibraryLimits`. */
  async setProjectStarForPrincipal(principal: string, project: string, starred: boolean, allowedPrincipals?: ReadonlySet<string>): Promise<BigQueryStarredProjectsView> {
    const validPrincipal = bigQueryStarredPrincipalSchema.parse(principal)
    if (validPrincipal.startsWith('bigquery:anonymous:')) throw new Error('Connect to BigQuery with a verified account to star projects.')
    const validProject = bigQueryProjectSchema.parse(project)
    const changed = await this.change(library => {
      const list = library.starredProjects ?? []
      const entry = list.find(item => item.principal === validPrincipal)
      if (starred) {
        if (entry) {
          if (entry.projects.includes(validProject)) return false
          if (entry.projects.length >= bigQueryLibraryLimits.starredPerPrincipal) throw new Error(`You can star at most ${bigQueryLibraryLimits.starredPerPrincipal} projects per account.`)
          entry.projects.push(validProject)
          return true
        }
        if (list.length >= bigQueryLibraryLimits.starredPrincipals) throw new Error(`Too many BigQuery accounts have starred projects (at most ${bigQueryLibraryLimits.starredPrincipals}).`)
        library.starredProjects = [...list, { principal: validPrincipal, projects: [validProject] }]
        return true
      }
      if (!entry || !entry.projects.includes(validProject)) return false
      entry.projects = entry.projects.filter(item => item !== validProject)
      if (!entry.projects.length) {
        const remaining = list.filter(item => item !== entry)
        if (remaining.length) library.starredProjects = remaining
        else delete library.starredProjects
      }
      return true
    }, changed => !changed)
    return BigQueryConnectionStore.starredView(changed.library, allowedPrincipals)
  }

  /** Bulk-adds starred projects for a verified principal (used when migrating legacy workspace `extraProjects`). */
  async addStarredProjects(principal: string, projects: readonly string[]): Promise<BigQueryStarredProjectsView> {
    const validPrincipal = bigQueryStarredPrincipalSchema.parse(principal)
    const changed = await this.change(library => mergeStarred(library, validPrincipal, projects).changed, changed => !changed)
    return BigQueryConnectionStore.starredView(changed.library)
  }

  /**
   * Migrates a pinned legacy session target's `extraProjects` into `principal`'s `starredProjects`, retaining any cap overflow
   * under `targetId` in `migratedTargets` (or in memory if disk persistence fails) so nothing is silently dropped.
   */
  async migrateTargetStarredProjects(principal: string, targetId: string, projects: readonly string[]): Promise<{ view: BigQueryStarredProjectsView; remaining: readonly string[] }> {
    const validPrincipal = bigQueryStarredPrincipalSchema.parse(principal)
    try {
      const changed = await this.change(library => {
        const merged = mergeStarred(library, validPrincipal, projects)
        const keptOverflow = merged.remaining.length ? BigQueryConnectionStore.recordMigratedTarget(library, targetId, merged.remaining) : false
        return { changed: merged.changed || keptOverflow, remaining: merged.remaining }
      }, result => !result.changed)
      return { view: BigQueryConnectionStore.starredView(changed.library), remaining: changed.value.remaining }
    } catch (error) {
      this.rememberPendingTarget(targetId, projects)
      throw error
    }
  }

  /** Records legacy `extraProjects` for an unpinned pre-upgrade session target, keyed by `targetId` so only that target claims them on reconnect. */
  async addMigratedTargetProjects(targetId: string, projects: readonly string[]): Promise<void> {
    try {
      await this.change(library => BigQueryConnectionStore.recordMigratedTarget(library, targetId, projects), changed => !changed)
    } catch (error) {
      this.rememberPendingTarget(targetId, projects)
      throw error
    }
  }

  /**
   * Claims pending legacy `migratedProjects` belonging ONLY to the originating profile's original connection identity
   * (`migratedKey ?? keyOf(profile.options)`) and/or originating session target (`targetId`) into `principal`'s
   * `starredProjects` (never across accounts, never for emulator anonymous pins, keeping any cap overflow on the originating entry).
   */
  async claimMigratedProjects(
    principal: string,
    match: { readonly profileId?: string; readonly options?: BigQueryConnectionOptions; readonly targetId?: string }
  ): Promise<{ claimed: readonly string[]; view: BigQueryStarredProjectsView }> {
    const validPrincipal = bigQueryStarredPrincipalSchema.parse(principal)
    if (validPrincipal.startsWith('bigquery:anonymous:')) {
      const { library } = await this.readSerialized()
      return { claimed: [], view: BigQueryConnectionStore.starredView(library) }
    }
    const normalizedKey = match.options ? keyOf(stored(match.options)) : undefined
    const changed = await this.change(library => {
      let anyChanged = false
      const claimed: string[] = []
      const matchedProfiles = normalizedKey
        ? library.profiles.filter(profile => !!profile.migratedProjects?.length && (profile.migratedKey ?? keyOf(profile.options)) === normalizedKey)
        : []
      for (const profile of matchedProfiles) {
        const pending = profile.migratedProjects!
        const merged = mergeStarred(library, validPrincipal, pending)
        if (merged.remaining.length) profile.migratedProjects = merged.remaining
        else {
          delete profile.migratedProjects
          delete profile.migratedKey
        }
        if (merged.changed || merged.remaining.length !== pending.length) anyChanged = true
        for (const project of merged.claimed) if (!claimed.includes(project)) claimed.push(project)
      }
      if (match.targetId && library.migratedTargets?.length) {
        const targetEntry = library.migratedTargets.find(entry => entry.targetId === match.targetId)
        if (targetEntry) {
          const pending = targetEntry.projects
          const merged = mergeStarred(library, validPrincipal, pending)
          if (merged.remaining.length) targetEntry.projects = merged.remaining
          else {
            const remaining = library.migratedTargets.filter(entry => entry !== targetEntry)
            if (remaining.length) library.migratedTargets = remaining
            else delete library.migratedTargets
          }
          if (merged.changed || merged.remaining.length !== pending.length) anyChanged = true
          for (const project of merged.claimed) if (!claimed.includes(project)) claimed.push(project)
        }
      }
      return { changed: anyChanged, claimed }
    }, result => !result.changed)
    return { claimed: changed.value.claimed, view: BigQueryConnectionStore.starredView(changed.library) }
  }
}
