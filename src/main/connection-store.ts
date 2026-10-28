import { randomUUID } from 'node:crypto'
import { connectionEnvironmentInputSchema, connectionKey, connectionLibrarySchema, connectionProfileInputSchema, savedConnection, type ConnectionEnvironmentInput, type ConnectionLibrary, type ConnectionProfileInput } from '../shared/connections'
import type { ConnectionOptions } from '../shared/contracts'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'

const limit = 2_000_000
/** History keeps the 30 most recent connections; an entry that is not a favorite, registered or recent is dropped. */
function prune(library: ConnectionLibrary) {
  const recent = library.profiles.filter(item => item.lastConnected).sort((a, b) => b.lastConnected!.localeCompare(a.lastConnected!))
  for (const item of recent.slice(30)) delete item.lastConnected
  library.profiles = library.profiles.filter(item => item.favorite || item.registered || item.lastConnected)
  if (library.profiles.length > 200) throw new Error('The connection library supports up to 200 saved servers.')
}
export class ConnectionStore {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private path: string) {}
  private async read(): Promise<{ library: ConnectionLibrary; warning?: string }> {
    const read = await readJsonFile(this.path, limit)
    if (read.kind === 'missing') return { library: { version: 1, profiles: [] } }
    if (read.kind === 'ok') {
      const parsed = connectionLibrarySchema.safeParse(read.value)
      if (parsed.success) return { library: parsed.data }
    }
    await quarantine(this.path)
    return { library: { version: 1, profiles: [] }, warning: 'The saved connection library was invalid. Its original file was preserved.' }
  }
  async load() { await this.writes; return this.read() }
  private change<T = undefined>(update: (value: ConnectionLibrary) => T): Promise<{ library: ConnectionLibrary; value: T }> {
    const next = this.writes.then(async () => {
      const { library } = await this.read()
      const value = update(library)
      const valid = connectionLibrarySchema.parse(library)
      await writeJsonAtomic(this.path, valid, limit, 'Too many saved connections.')
      return { library: valid, value }
    })
    this.writes = next.catch(() => {})
    return next
  }
  async save(value: ConnectionProfileInput, connected = false): Promise<ConnectionLibrary> { return (await this.upsert(value, connected)).library }
  /**
   * Saves the profile and returns the id of the entry it created or updated, with the environment it now has. With
   * `keepEnvironment`, options without an environment keep the entry's label: a connect only clears it when the user
   * cleared the form's Environment, so typing a production server's name never drops its PROD tag.
   */
  private async upsert(value: ConnectionProfileInput, connected: boolean, keepEnvironment = false): Promise<{ library: ConnectionLibrary; id: string; environment?: string }> {
    const input = connectionProfileInputSchema.parse(value)
    const options = savedConnection(input.options)
    const changed = await this.change(library => {
      let profile = input.id ? library.profiles.find(item => item.id === input.id) : library.profiles.find(item => connectionKey(item.options) === connectionKey(options))
      if (input.id && !profile) throw new Error('This saved connection no longer exists.')
      if (!profile) { profile = { id: randomUUID(), options, favorite: false, registered: false }; library.profiles.push(profile) }
      const kept = keepEnvironment && options.environment === undefined ? profile.options.environment : undefined
      profile.options = kept ? { ...options, environment: kept } : options
      if (input.favorite !== undefined) profile.favorite = input.favorite
      if (input.registered !== undefined) profile.registered = input.registered
      if (connected) profile.lastConnected = new Date().toISOString()
      prune(library)
      return { id: profile.id, environment: profile.options.environment }
    })
    return { library: changed.library, ...changed.value }
  }
  /**
   * Set Connection Environment: changes only the label of the entry the connection's options name, so its name, colour,
   * favorite and recency stay as saved (a later edit is not reverted to the connect-time options). A connected server
   * whose entry was removed or fell out of history is saved again as a recent entry, since it is connected now; the
   * entry is always in the library written, or the call fails.
   */
  async setEnvironment(value: ConnectionEnvironmentInput): Promise<ConnectionLibrary> {
    const input = connectionEnvironmentInputSchema.parse(value)
    const options = savedConnection(input.options), key = connectionKey(options)
    return (await this.change(library => {
      let profile = library.profiles.find(item => connectionKey(item.options) === key)
      if (!profile) { profile = { id: randomUUID(), options, favorite: false, registered: false, lastConnected: new Date().toISOString() }; library.profiles.push(profile) }
      const next = { ...profile.options }
      if (input.environment) next.environment = input.environment
      else delete next.environment
      profile.options = next
      prune(library)
      if (!library.profiles.includes(profile)) throw new Error('The connection could not be kept in the saved connections.')
    })).library
  }
  remember(options: ConnectionOptions) { return this.save({ options }, true) }
  /** remember(), with the id of the history entry it touched (a remembered password is kept under that id) and the
   *  environment that entry now has. */
  rememberEntry(options: ConnectionOptions, keepEnvironment = false) { return this.upsert({ options }, true, keepEnvironment) }
  async remove(id: string) { return (await this.change(library => { library.profiles = library.profiles.filter(item => item.id !== id) })).library }
}
