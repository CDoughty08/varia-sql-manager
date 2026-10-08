import { randomUUID } from 'node:crypto'
import { connectionKey, connectionLibrarySchema, connectionProfileInputSchema, savedConnection, type ConnectionLibrary, type ConnectionProfileInput } from '../shared/connections'
import type { ConnectionOptions } from '../shared/contracts'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'

const limit = 2_000_000
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
  private change(update: (value: ConnectionLibrary) => void): Promise<ConnectionLibrary> {
    const next = this.writes.then(async () => {
      const { library } = await this.read()
      update(library)
      const valid = connectionLibrarySchema.parse(library)
      await writeJsonAtomic(this.path, valid, limit, 'Too many saved connections.')
      return valid
    })
    this.writes = next.catch(() => {})
    return next
  }
  save(value: ConnectionProfileInput, connected = false): Promise<ConnectionLibrary> {
    const input = connectionProfileInputSchema.parse(value)
    const options = savedConnection(input.options)
    return this.change(library => {
      let profile = input.id ? library.profiles.find(item => item.id === input.id) : library.profiles.find(item => connectionKey(item.options) === connectionKey(options))
      if (input.id && !profile) throw new Error('This saved connection no longer exists.')
      if (!profile) { profile = { id: randomUUID(), options, favorite: false, registered: false }; library.profiles.push(profile) }
      profile.options = options
      if (input.favorite !== undefined) profile.favorite = input.favorite
      if (input.registered !== undefined) profile.registered = input.registered
      if (connected) profile.lastConnected = new Date().toISOString()
      const recent = library.profiles.filter(item => item.lastConnected).sort((a, b) => b.lastConnected!.localeCompare(a.lastConnected!))
      for (const item of recent.slice(30)) delete item.lastConnected
      library.profiles = library.profiles.filter(item => item.favorite || item.registered || item.lastConnected)
      if (library.profiles.length > 200) throw new Error('The connection library supports up to 200 saved servers.')
    })
  }
  remember(options: ConnectionOptions) { return this.save({ options }, true) }
  remove(id: string) { return this.change(library => { library.profiles = library.profiles.filter(item => item.id !== id) }) }
}
