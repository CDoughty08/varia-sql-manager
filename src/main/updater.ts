import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { assetFor, compareVersions, updateErrors, updateLimits, updateManifestSchema, type InstallKind, type UpdateAsset, type UpdateErrorCode, type UpdateManifest, type UpdatePhase, type UpdateState } from '../shared/updates'

/** A failure the updater recognised, with its code and a short detail for Copy details (never a path or a URL's query). */
export class UpdateFailure extends Error {
  constructor(readonly code: UpdateErrorCode, readonly detail?: string) { super(updateErrors[code].message) }
}

// Chromium's network errors (net.fetch rejects with "net::ERR_…"), grouped by what a person can do about them.
const netErrors: readonly [RegExp, UpdateErrorCode][] = [
  [/^ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|NETWORK_IO_SUSPENDED)$/, 'offline'],
  [/^ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_[A-Z_]+)$/, 'dns'],
  [/^ERR_(PROXY_AUTH_[A-Z_]+|INVALID_AUTH_CREDENTIALS|MISCONFIGURED_AUTH_ENVIRONMENT|UNEXPECTED_PROXY_AUTH)$/, 'proxyAuth'],
  [/^ERR_(PROXY_[A-Z_]+|TUNNEL_CONNECTION_FAILED|MANDATORY_PROXY_CONFIGURATION_FAILED|PAC_[A-Z_]+|NO_SUPPORTED_PROXIES|SOCKS_[A-Z_]+)$/, 'proxy'],
  [/^ERR_(CERT_[A-Z_]+|SSL_[A-Z_]+|BAD_SSL_CLIENT_AUTH_CERT|CERTIFICATE_TRANSPARENCY_REQUIRED|TLS_[A-Z_]+)$/, 'tls'],
  [/^ERR_(TIMED_OUT|CONNECTION_TIMED_OUT)$/, 'timeout'],
  [/^ERR_(BLOCKED_BY_[A-Z_]+|CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED|EMPTY_RESPONSE|ACCESS_DENIED|NETWORK_ACCESS_DENIED|UNSAFE_REDIRECT|INVALID_REDIRECT|TOO_MANY_REDIRECTS|ADDRESS_INVALID)$/, 'blocked']
]
const fsErrors: Readonly<Record<string, UpdateErrorCode>> = { ENOSPC: 'disk', EDQUOT: 'disk', EACCES: 'notWritable', EPERM: 'notWritable', EROFS: 'notWritable', EBUSY: 'notWritable' }

/** An HTTP answer that is not 200, by what it most likely means on a managed network. */
export function httpFailure(status: number, what: 'manifest' | 'asset'): UpdateFailure {
  const detail = `HTTP ${status}`
  if (status === 407) return new UpdateFailure('proxyAuth', detail)
  if (status === 404) return new UpdateFailure(what === 'manifest' ? 'notFound' : 'server', detail)
  if (status === 403 || status === 451) return new UpdateFailure('blocked', detail)
  if (status === 408 || status === 504) return new UpdateFailure('timeout', detail)
  if (status === 429 || status >= 500) return new UpdateFailure('server', detail)
  return new UpdateFailure('unknown', detail)
}

/** Any failure as a code and a detail fit to show: Chromium's error name, an HTTP status or a file system code. */
export function classifyUpdateError(error: unknown): { code: UpdateErrorCode; detail?: string } {
  if (error instanceof UpdateFailure) return { code: error.code, ...(error.detail ? { detail: error.detail } : {}) }
  const fsCode = (error as { code?: unknown } | null)?.code
  if (typeof fsCode === 'string' && fsErrors[fsCode]) return { code: fsErrors[fsCode], detail: fsCode }
  for (let cause: unknown = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
    const net = /net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1]
    if (net) return { code: netErrors.find(([pattern]) => pattern.test(net))?.[1] ?? 'unknown', detail: `net::${net}` }
  }
  if (error instanceof Error && error.name === 'AbortError') return { code: 'timeout', detail: 'No answer in time' }
  const name = error instanceof Error ? error.name : undefined
  return { code: 'unknown', ...(name ? { detail: name } : {}) }
}

export interface UpdateSettings { readonly checkAutomatically: boolean; readonly downloadAutomatically: boolean }
type Timer = ReturnType<typeof setTimeout>
export interface UpdaterOptions {
  readonly currentVersion: string
  readonly kind: InstallKind
  readonly arch: string
  /** Packaged builds (and smoke runs with a test feed); otherwise no check ever runs. */
  readonly enabled: boolean
  readonly feedUrl: string
  readonly assetUrl: (version: string, name: string) => string
  /** Chromium's fetch, through the system proxy and certificate store; tests pass their own. */
  readonly fetch: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>
  /** Refuse an answer that ended on anything but https (the real feed); a test feed on loopback allows http. */
  readonly secureOnly: boolean
  /** The folder the download goes to: the profile's, or the portable app's or AppImage's own (to swap it in place). */
  readonly downloadDir: string
  /** Whether `downloadDir` is the updater's alone; otherwise only its own hidden files there are touched. */
  readonly privateDir: boolean
  readonly settings: () => UpdateSettings
  readonly publish: (state: UpdateState) => void
  readonly now?: () => number
  readonly timers?: { setTimeout(callback: () => void, ms: number): Timer; clearTimeout(timer: Timer): void }
}

const hashFile = (path: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash('sha512')
  createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('base64')))
})
const exists = (path: string) => stat(path).then(info => info.isFile() ? info.size : -1, () => -1)

/**
 * Help › Check for Updates and the automatic checks: reads the release manifest, downloads this build's file beside a
 * partial name while hashing it, and keeps it only when its size and SHA-512 match the manifest. Restart to Update arms
 * the verified file; main applies it once the app has closed (`update-install.ts`). One check or download at a time.
 */
export class Updater {
  private phase: UpdatePhase = { status: 'idle' }
  private running: Promise<UpdateState> | undefined
  private abort: AbortController | undefined
  private timer: Timer | undefined
  private ready: { readonly file: string; readonly version: string } | undefined
  private release: { readonly manifest: UpdateManifest; readonly asset: UpdateAsset } | undefined
  private armed = false
  private disposed = false
  private readonly now: () => number
  private readonly timers: NonNullable<UpdaterOptions['timers']>

  constructor(private readonly options: UpdaterOptions) {
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? { setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer }, clearTimeout: timer => clearTimeout(timer) }
  }

  get state(): UpdateState {
    return { ...this.phase, currentVersion: this.options.currentVersion, kind: this.options.kind, enabled: this.options.enabled }
  }

  /** The verified file Restart to Update would install. */
  get readyFile(): { readonly file: string; readonly version: string } | undefined { return this.ready }

  /** Schedules the first automatic check (when they are on). */
  start(): void { this.schedule(updateLimits.firstCheckMs) }

  /** Check for updates automatically may have changed: the next check follows it. */
  settingsChanged(): void {
    if (!this.timer) this.schedule(updateLimits.firstCheckMs)
    else if (!this.options.settings().checkAutomatically) this.unschedule()
  }

  /** Checks the feed, then downloads when Download updates automatically is on (or `manual` with nothing to wait for). */
  check(manual: boolean): Promise<UpdateState> {
    if (!this.options.enabled || this.disposed) return Promise.resolve(this.state)
    if (this.running) return this.running
    if (manual) this.schedule(updateLimits.checkIntervalMs)
    const run = this.running = this.run(manual).finally(() => { if (this.running === run) this.running = undefined })
    return run
  }

  /** Download Update, for a release found while Download updates automatically was off. */
  download(): Promise<UpdateState> {
    if (this.running || this.disposed || this.phase.status !== 'available' || !this.release) return this.running ?? Promise.resolve(this.state)
    const release = this.release
    const run = this.running = this.fetchAsset(release.manifest, release.asset, true).finally(() => { if (this.running === run) this.running = undefined })
    return run
  }

  /** Restart to Update: true when a verified file is ready, which `takeArmed` then hands over at exit. */
  async arm(): Promise<boolean> {
    if (this.phase.status !== 'ready' || !this.ready || this.running) return false
    // The file was verified as it was written; one deleted or cut short since then is not installed.
    const size = await exists(this.ready.file)
    if (size < 0 || (this.release && size !== this.release.asset.size)) {
      this.ready = undefined
      this.fail(new UpdateFailure('integrity', 'The downloaded file changed'), 'install', true)
      return false
    }
    this.armed = true
    return true
  }

  /** The quit that Restart to Update started was cancelled (a query with unsaved changes was kept). */
  disarm(): void { this.armed = false }

  /** At exit: the file to install, once, if Restart to Update armed it. */
  takeArmed(): { readonly file: string; readonly version: string } | undefined {
    if (!this.armed || !this.ready) return undefined
    this.armed = false
    return this.ready
  }

  dispose(): void {
    this.disposed = true
    this.unschedule()
    this.abort?.abort()
  }

  private schedule(ms: number): void {
    this.unschedule()
    if (!this.options.enabled || this.disposed || !this.options.settings().checkAutomatically) return
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      void this.check(false).then(state => { if (!this.timer) this.schedule(state.status === 'error' ? updateLimits.retryMs : updateLimits.checkIntervalMs) })
    }, ms)
  }

  private unschedule(): void {
    if (this.timer) this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }

  private set(phase: UpdatePhase): UpdateState {
    this.phase = phase
    const state = this.state
    if (!this.disposed) this.options.publish(state)
    return state
  }

  private fail(error: unknown, during: 'check' | 'download' | 'install', manual: boolean, version?: string): UpdateState {
    const { code, detail } = classifyUpdateError(error)
    return this.set({ status: 'error', code, during, manual, ...updateErrors[code], ...(detail ? { detail } : {}), ...(version ? { version } : {}) })
  }

  private async run(manual: boolean): Promise<UpdateState> {
    // A download in progress or a verified file stays what it is while the feed is read again.
    const previous = this.phase
    if (previous.status !== 'ready') this.set({ status: 'checking', manual })
    let manifest: UpdateManifest
    try { manifest = await this.readManifest() } catch (error) {
      return previous.status === 'ready' ? this.set(previous) : this.fail(error, 'check', manual)
    }
    if (compareVersions(manifest.version, this.options.currentVersion) <= 0) {
      this.release = undefined
      this.ready = undefined
      void this.sweep(undefined)
      return this.set({ status: 'upToDate', checkedAt: this.now() })
    }
    const asset = assetFor(manifest, this.options.kind, this.options.arch)
    if (!asset) {
      this.release = undefined
      return this.set({ status: 'available', version: manifest.version })
    }
    this.release = { manifest, asset }
    if (this.ready?.version === manifest.version) return this.set({ status: 'ready', version: manifest.version })
    this.ready = undefined
    const staged = this.stagedPath(asset)
    // A file a previous run verified (the app was closed before Restart to Update) is used again once it hashes right.
    try {
      if (await exists(staged) === asset.size && await hashFile(staged) === asset.sha512) {
        this.ready = { file: staged, version: manifest.version }
        void this.sweep(asset)
        return this.set({ status: 'ready', version: manifest.version })
      }
    } catch { /* Downloaded again below. */ }
    if (!this.options.settings().downloadAutomatically) return this.set({ status: 'available', version: manifest.version, size: asset.size })
    return this.fetchAsset(manifest, asset, manual)
  }

  private async request(url: string, timeoutMs: number, accept: string): Promise<{ response: Response; controller: AbortController; refresh: () => void; clear: () => void }> {
    const controller = this.abort = new AbortController()
    let timer: Timer | undefined
    const refresh = () => {
      if (timer) this.timers.clearTimeout(timer)
      timer = this.timers.setTimeout(() => controller.abort(new UpdateFailure('timeout', 'No answer in time')), timeoutMs)
    }
    const clear = () => { if (timer) this.timers.clearTimeout(timer); timer = undefined }
    refresh()
    try {
      const response = await this.options.fetch(url, { signal: controller.signal, headers: { Accept: accept } })
      if (this.options.secureOnly && response.url && !response.url.startsWith('https:')) throw new UpdateFailure('blocked', 'Redirected off https')
      return { response, controller, refresh, clear }
    } catch (error) {
      clear()
      throw controller.signal.aborted && controller.signal.reason instanceof UpdateFailure ? controller.signal.reason : error
    }
  }

  private async readManifest(): Promise<UpdateManifest> {
    const { response, controller, clear } = await this.request(this.options.feedUrl, updateLimits.manifestTimeoutMs, 'application/json, application/octet-stream')
    try {
      if (!response.ok) throw httpFailure(response.status, 'manifest')
      // A filter or captive portal answers 200 with its own page.
      if (/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new UpdateFailure('invalidFeed', 'An HTML page')
      const declared = Number(response.headers.get('content-length') ?? NaN)
      if (declared > updateLimits.manifestBytes) throw new UpdateFailure('invalidFeed', 'Too large')
      const chunks: Uint8Array[] = []
      let total = 0
      const reader = response.body?.getReader()
      for (let next = await reader?.read(); next && !next.done; next = await reader?.read()) {
        total += next.value.byteLength
        if (total > updateLimits.manifestBytes) { await reader?.cancel(); throw new UpdateFailure('invalidFeed', 'Too large') }
        chunks.push(next.value)
      }
      let json: unknown
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new UpdateFailure('invalidFeed', 'Not JSON') }
      const parsed = updateManifestSchema.safeParse(json)
      if (!parsed.success) throw new UpdateFailure('invalidFeed', 'Not a release manifest')
      return parsed.data
    } catch (error) {
      throw controller.signal.aborted && controller.signal.reason instanceof UpdateFailure ? controller.signal.reason : error
    } finally { clear() }
  }

  private stagedPath(asset: UpdateAsset): string {
    return join(this.options.downloadDir, this.options.privateDir ? asset.name : `.${asset.name}.update`)
  }

  private async fetchAsset(manifest: UpdateManifest, asset: UpdateAsset, manual: boolean): Promise<UpdateState> {
    const version = manifest.version, staged = this.stagedPath(asset)
    const partial = join(this.options.downloadDir, `.${asset.name}.partial`)
    this.set({ status: 'downloading', version, received: 0, total: asset.size })
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      if (this.options.privateDir) await mkdir(this.options.downloadDir, { recursive: true })
      // Before the request: a folder Varia cannot write to fails without spending the download.
      file = await open(partial, 'w', 0o600)
      const { response, controller, refresh, clear } = await this.request(this.options.assetUrl(version, asset.name), updateLimits.stallTimeoutMs, 'application/octet-stream')
      try {
        if (!response.ok) throw httpFailure(response.status, 'asset')
        if (/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new UpdateFailure('blocked', 'An HTML page instead of the file')
        const declared = response.headers.get('content-length')
        if (declared !== null && Number(declared) !== asset.size) throw new UpdateFailure('integrity', 'Unexpected size')
        const hash = createHash('sha512'), reader = response.body?.getReader()
        if (!reader) throw new UpdateFailure('integrity', 'Empty answer')
        let received = 0, shown = this.now()
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          refresh()
          received += next.value.byteLength
          if (received > asset.size) { await reader.cancel(); throw new UpdateFailure('integrity', 'Larger than the release says') }
          hash.update(next.value)
          await file.write(next.value)
          if (this.now() - shown >= updateLimits.progressIntervalMs) {
            shown = this.now()
            this.set({ status: 'downloading', version, received, total: asset.size })
          }
        }
        if (received !== asset.size) throw new UpdateFailure('integrity', 'Smaller than the release says')
        if (hash.digest('base64') !== asset.sha512) throw new UpdateFailure('integrity', 'SHA-512 mismatch')
      } catch (error) {
        throw controller.signal.aborted && controller.signal.reason instanceof UpdateFailure ? controller.signal.reason : error
      } finally { clear() }
      await file.close()
      file = undefined
      await rename(partial, staged)
      // The AppImage runs as it is; the Windows files run by their extension.
      if (this.options.kind === 'appimage') await chmod(staged, 0o755)
      this.ready = { file: staged, version }
      void this.sweep(asset)
      return this.set({ status: 'ready', version })
    } catch (error) {
      await file?.close().catch(() => {})
      await rm(partial, { force: true }).catch(() => {})
      return this.fail(error, 'download', manual, version)
    }
  }

  /** Removes earlier releases' files: the whole private folder but `keep`, or only Varia's own hidden files elsewhere. */
  private async sweep(keep: UpdateAsset | undefined): Promise<void> {
    const keepNames = keep ? new Set([this.stagedPath(keep).slice(this.options.downloadDir.length + 1), `.${keep.name}.partial`]) : new Set<string>()
    let names: string[]
    try { names = await readdir(this.options.downloadDir) } catch { return }
    for (const name of names) {
      if (keepNames.has(name)) continue
      if (!this.options.privateDir && !/^\.Varia-SQL-Manager-[0-9A-Za-z._-]+\.(?:exe|AppImage)\.(?:update|partial)$/.test(name)) continue
      await rm(join(this.options.downloadDir, name), { force: true, recursive: this.options.privateDir }).catch(() => {})
    }
  }
}
