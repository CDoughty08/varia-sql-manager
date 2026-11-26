import { join } from 'node:path'
import type { BackendMethods, BackendState } from '../../shared/contracts'
import { objectSearchLimits } from '../../shared/explorer/search.ts'
import type { SearchIndexKey } from '../search-index-key'
import { indexStoreConfigureSchema } from '../validation'

type ConfigureParams = BackendMethods['explorer.indexStore.configure']['params']

/** The saved index's folder: always this name directly under the user-data directory, which the backend checks again. */
export const indexStoreFolder = (userData: string): string => join(userData, objectSearchLimits.store.folder)

export const indexStoreSettingKeys = ['objectExplorer.search.saveIndex', 'objectExplorer.search.diskLimitMiB', 'objectExplorer.search.saveUnencrypted'] as const

/** The three Options values as the settings hold them, read loosely: anything out of range is the default. */
export interface IndexStoreSettings { save: boolean; limitMiB: number; clearText: boolean }
export function indexStoreSettings(values: { readonly [key: string]: unknown }): IndexStoreSettings {
  const { min, max, default: fallback } = objectSearchLimits.store.diskMiB
  const limit = values['objectExplorer.search.diskLimitMiB']
  return {
    save: values['objectExplorer.search.saveIndex'] !== false,
    limitMiB: typeof limit === 'number' && Number.isInteger(limit) && limit >= min && limit <= max ? limit : fallback,
    clearText: values['objectExplorer.search.saveUnencrypted'] === true
  }
}

export interface IndexStoreConfigDeps {
  /** The supervisor's request, bound to one generation so a later one is never sent another's configuration. */
  request(params: ConfigureParams, generation: number): Promise<unknown>
  onState(listener: (state: BackendState) => void): () => void
  /** The backend's state now: this is made after the supervisor has started. */
  state(): BackendState
  /** Undefined until the settings have been read, and while one of the three holds its default only because settings.json
   *  could not be read (SettingsStore.wasReset): a default acted on then could delete what the user's value kept. */
  settings(): IndexStoreSettings | undefined
  /** The store's folder (indexStoreFolder of the user-data directory). */
  folder: string
  keys: { key(): Promise<SearchIndexKey>; names(): Promise<Buffer | undefined> }
  /** How long to wait before asking a key store that did not answer again; doubles each time up to 10 minutes. */
  retryMs?: number
}

const maxRetryMs = 10 * 60_000

/**
 * Tells each backend how the saved Search Objects index stands (explorer.indexStore.configure): as each generation
 * becomes ready, and again when one of its three settings changes. The key travels only here, main to backend, in a
 * sensitive request whose frame is zeroed once written; no renderer sees the key, its ciphertext or the folder.
 *
 * Saving off sends `disabled` (the backend deletes what was saved). With saving on, a usable key store gives `encrypted`
 * with the data key; without one (no keyring, no backend), `clearText` only when the user opted in, else `noKeyStore`. A key
 * store that does not answer or is not reachable yet, settings not yet read, or a setting reset because settings.json was
 * unreadable, send nothing: an unconfigured backend saves nothing and deletes nothing. The key store is asked again later.
 * One request is in flight at a time and none is re-sent: a failure waits for the next change, recovery or launch, as
 * ResultMemoryLimit's does.
 */
export class IndexStoreConfig {
  private generation: number | undefined
  private applied: string | undefined
  private sending = false
  /** A change arrived while a configuration was being worked out: it is worked out again before giving up. */
  private dirty = false
  private disposed = false
  private retry: ReturnType<typeof setTimeout> | undefined
  private retryMs: number
  private readonly unsubscribe: () => void

  constructor(private readonly deps: IndexStoreConfigDeps) {
    this.retryMs = deps.retryMs ?? 30_000
    const follow = (state: BackendState): void => {
      if (state.status === 'ready') {
        if (state.generation === this.generation) return void this.flush()
        this.generation = state.generation
        this.applied = undefined
        void this.flush()
      } else if (state.status !== 'unresponsive') this.generation = undefined
    }
    this.unsubscribe = deps.onState(follow)
    follow(deps.state())
  }

  /** The settings changed: sends the configuration if it differs from what the ready generation applied. */
  settingsChanged(): void {
    this.dirty = true
    void this.flush()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.retry)
    this.unsubscribe()
  }

  /** The key store did not answer: asks again after a while, backing off, unless a change or recovery asks first. */
  private later(): void {
    if (this.retry !== undefined || this.disposed) return
    const wait = this.retryMs
    this.retryMs = Math.min(wait * 2, maxRetryMs)
    this.retry = setTimeout(() => { this.retry = undefined; void this.flush() }, wait)
    this.retry.unref?.()
  }

  /** The configuration as the settings and the key store stand now; undefined when it cannot be said (settings unread or
   *  reset, or the folder's path is past the limit) and 'later' when the key store did not answer: nothing is then sent. */
  private async params(): Promise<ConfigureParams | 'later' | undefined> {
    const settings = this.deps.settings()
    if (!settings) return undefined
    const { save, limitMiB, clearText } = settings
    const base = { folder: this.deps.folder, limitMiB }
    let params: ConfigureParams
    if (!save) params = { mode: 'disabled', ...base }
    else {
      const key = await this.deps.keys.key()
      if (key.kind === 'unanswered') return 'later'
      if (key.kind === 'key') { this.retryMs = this.deps.retryMs ?? 30_000; params = { mode: 'encrypted', ...base, key: key.key.toString('base64') } }
      else {
        if (!clearText) params = { mode: 'noKeyStore', ...base }
        else {
          // Opted in, but the value that names files could not be read or written: noKeyStore would sweep the clear-text
          // files the user chose to keep, so nothing is sent and it is tried again.
          const names = await this.deps.keys.names()
          if (!names) return 'later'
          params = { mode: 'clearText', ...base, key: names.toString('base64') }
        }
      }
    }
    const checked = indexStoreConfigureSchema.safeParse(params)
    return checked.success ? checked.data : undefined
  }

  private async flush(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      for (;;) {
        const generation = this.generation
        if (this.disposed || generation === undefined) return
        this.dirty = false
        const params = await this.params().catch(() => undefined)
        if (this.disposed) return
        // Settings changed while the key store was asked (saving turned off, say): what they want now is worked out at once.
        if (this.dirty) continue
        if (!params) return
        if (params === 'later') return void this.later()
        if (this.generation !== generation) continue
        const wanted = JSON.stringify(params)
        if (wanted === this.applied) return
        const sent = await this.deps.request(params, generation).then(() => true, () => false)
        // A generation that went meanwhile is the next one's to configure.
        if (this.generation !== generation) continue
        if (sent) { this.applied = wanted; continue }
        // What a failed request left the backend with is unknown (its answer may be what was lost), so whatever is wanted
        // next is sent, even what was applied before. It waits for the next change or recovery, unless the settings
        // changed while the request was in flight.
        this.applied = undefined
        const next = await this.params().catch(() => undefined)
        if (!this.dirty && JSON.stringify(next) === wanted) return
      }
    } finally {
      this.sending = false
    }
  }
}
