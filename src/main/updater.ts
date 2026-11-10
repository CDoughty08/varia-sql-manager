import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { assetFor, compareVersions, stagedAssetFor, updateErrors, updateLimits, updateManifestSchema, type InstallKind, type UpdateAsset, type UpdateErrorCode, type UpdateManifest, type UpdatePhase, type UpdateState } from '../shared/updates'

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
/**
 * Unpacking a release beside the installation while Varia runs, so that Restart to Update only swaps two folders
 * (`update-staging.ts`, for the installed Windows build). Anything it cannot do falls back to the installer.
 */
export interface UpdateStaging {
  /** Whether a release can be staged here at all: the installation's folder is this user's to write. */
  available(): Promise<boolean>
  /** Whether `version`, unpacked from the archive with this checksum, is in place and whole. */
  staged(version: string, sha512: string): Promise<boolean>
  /** Checks the archive against `sha512` again and unpacks it; rejects when it cannot. */
  stage(archive: string, version: string, sha512: string, signal: AbortSignal): Promise<void>
  /** Removes the staged release, keeping the record of a failure and the helper's log. */
  clear(): Promise<void>
  /** Removes everything staging left: the running version is the latest. */
  remove(): Promise<void>
  /** The release that could not be staged or swapped in, and whether the user has been told. It stays until `remove`. */
  failure(): Promise<{ readonly version: string; readonly reported: boolean } | undefined>
  /** Records that `version` installs with the installer from now on, in this run and later ones. */
  markFailed(version: string, reported: boolean): Promise<void>
}
/** What Restart to Update installs: the installer or executable to run, or (staged) the release unpacked from `file`. */
export interface ReadyUpdate { readonly file: string; readonly version: string; readonly staged: boolean; readonly sha512: string }
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
  readonly staging?: UpdateStaging
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
 * partial name while hashing it, and keeps it only when its size and SHA-512 match the manifest. Where the release can be
 * staged, its archive is then unpacked beside the installation. Restart to Update arms the verified file (hashed again)
 * or the staged release; main applies it once the app has closed (`update-install.ts`). One check or download at a time.
 */
export class Updater {
  private phase: UpdatePhase = { status: 'idle' }
  private running: Promise<UpdateState> | undefined
  private abort: AbortController | undefined
  private timer: Timer | undefined
  private ready: ReadyUpdate | undefined
  private release: { readonly manifest: UpdateManifest; readonly asset: UpdateAsset; readonly archive: UpdateAsset | undefined } | undefined
  // The release whose staging or swap failed: it installs with the installer instead (staging keeps the record, so
  // later runs do too, until a newer release or this one is running).
  private unstageable: string | undefined
  private recovered: Promise<void> | undefined
  private armed = false
  private arming: Promise<boolean> | undefined
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
  get readyFile(): ReadyUpdate | undefined { return this.ready }

  /** Schedules the first automatic check (when they are on), and reports a swap that failed at the last restart. */
  start(): void {
    void this.recover()
    this.schedule(updateLimits.firstCheckMs)
  }

  /** Once a run: a staged release that could not be swapped in is said, and installs with the installer from now on. */
  private recover(): Promise<void> {
    return this.recovered ??= (async () => {
      if (!this.options.enabled || !this.options.staging) return
      const staging = this.options.staging
      const failure = await staging.failure().catch(() => undefined)
      // A failure that a later, successful restart left behind is not this version's.
      if (!failure || compareVersions(failure.version, this.options.currentVersion) <= 0) return
      this.unstageable = failure.version
      if (failure.reported) return
      await staging.clear().catch(() => {})
      await staging.markFailed(failure.version, true).catch(() => {})
      if (this.phase.status === 'idle' && !this.disposed) this.fail(new UpdateFailure('staged'), 'install', false, failure.version)
    })()
  }

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
    const run = this.running = this.obtain(release.manifest, release.asset, release.archive, true).finally(() => { if (this.running === run) this.running = undefined })
    return run
  }

  /** Restart to Update: true when a verified update is ready, which `takeArmed` then hands over at exit. */
  arm(): Promise<boolean> {
    // Restart to Update chosen again while the first is still verifying shares its answer.
    if (this.arming) return this.arming
    if (this.phase.status !== 'ready' || !this.ready) return Promise.resolve(false)
    // A quiet re-check of the feed is under way (the status bar still offers the restart): it is waited for.
    if (this.running) return this.running.then(() => this.arm(), () => this.arm())
    if (this.armed) return Promise.resolve(true)
    const ready = this.ready
    // It was verified as it was written, but it is run from a folder other programs can write to: it is hashed again
    // now (a staged release: its marker and executable are looked for), and no check or download starts meanwhile.
    const run = this.running = (async () => {
      const whole = ready.staged
        ? !!this.options.staging && await this.options.staging.staged(ready.version, ready.sha512).catch(() => false)
        : await hashFile(ready.file).then(hash => hash === ready.sha512, () => false)
      if (whole) { this.armed = true; return this.state }
      this.ready = undefined
      if (ready.staged) await this.options.staging?.clear().catch(() => {})
      return this.fail(new UpdateFailure('integrity', 'The downloaded file changed'), 'install', true, ready.version)
    })().finally(() => { if (this.running === run) this.running = undefined })
    const arming = this.arming = run.then(() => this.armed).finally(() => { if (this.arming === arming) this.arming = undefined })
    return arming
  }

  /** The quit that Restart to Update started was cancelled (a query with unsaved changes was kept). */
  disarm(): void { this.armed = false }

  /** At exit: the file to install, once, if Restart to Update armed it. */
  takeArmed(): ReadyUpdate | undefined {
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
    await this.recover()
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
      void this.options.staging?.remove().catch(() => {})
      return this.set({ status: 'upToDate', checkedAt: this.now() })
    }
    const asset = assetFor(manifest, this.options.kind, this.options.arch)
    if (!asset) {
      this.release = undefined
      this.ready = undefined
      this.armed = false
      return this.set({ status: 'available', version: manifest.version })
    }
    const version = manifest.version
    const archive = await this.stageable(manifest)
    this.release = { manifest, asset, archive }
    // A newer release than the one that is ready replaces it; until it is ready too, Restart to Update has nothing (one
    // chosen just before, still waiting on the unsaved-changes prompt, then closes Varia without installing).
    if (this.ready?.version === version) return this.set({ status: 'ready', version })
    this.ready = undefined
    this.armed = false
    // What a previous run left (the app was closed before Restart to Update) is used again: a staged release whose
    // marker names this archive, or a file that hashes right.
    if (archive && await this.options.staging!.staged(version, archive.sha512).catch(() => false)) {
      this.ready = { file: this.stagedPath(archive), version, staged: true, sha512: archive.sha512 }
      void this.sweep(undefined)
      return this.set({ status: 'ready', version })
    }
    if (!archive && await this.verified(asset)) return this.readyToInstall(version, asset)
    if (!this.options.settings().downloadAutomatically) return this.set({ status: 'available', version, size: (archive ?? asset).size })
    return this.obtain(manifest, asset, archive, manual)
  }

  /** The release's archive, when this installation can stage it and has not failed to before. */
  private async stageable(manifest: UpdateManifest): Promise<UpdateAsset | undefined> {
    const staging = this.options.staging
    if (!staging || this.unstageable === manifest.version) return undefined
    const archive = stagedAssetFor(manifest, this.options.kind, this.options.arch)
    return archive && await staging.available().catch(() => false) ? archive : undefined
  }

  /** Downloads and stages the archive where that is possible; otherwise, or when staging fails, downloads the installer. */
  private async obtain(manifest: UpdateManifest, asset: UpdateAsset, archive: UpdateAsset | undefined, manual: boolean): Promise<UpdateState> {
    const version = manifest.version
    if (archive) {
      const staged = await this.stage(version, archive, manual)
      if (staged) return staged
    }
    // Varia is closing: nothing more is downloaded.
    if (this.disposed) return this.state
    try {
      // The installer an earlier run downloaded (when staging failed then, too) is not downloaded again.
      if (!await this.verified(asset)) await this.downloadAsset(version, asset)
      return await this.readyToInstall(version, asset)
    } catch (error) { return this.fail(error, 'download', manual, version) }
  }

  /** Whether `asset` is already in the download folder, whole: a file an earlier run verified is used again once it hashes right. */
  private async verified(asset: UpdateAsset): Promise<boolean> {
    const file = this.stagedPath(asset)
    try { return await exists(file) === asset.size && await hashFile(file) === asset.sha512 } catch { return false }
  }

  private async readyToInstall(version: string, asset: UpdateAsset): Promise<UpdateState> {
    const file = this.stagedPath(asset)
    // The AppImage runs as it is; the Windows files run by their extension.
    if (this.options.kind === 'appimage') await chmod(file, 0o755)
    this.ready = { file, version, staged: false, sha512: asset.sha512 }
    void this.sweep(asset)
    return this.set({ status: 'ready', version })
  }

  /**
   * The state once the archive is downloaded and unpacked, or a download's failure (the installer would meet the same
   * network). Undefined when only the unpacking failed: the installer can still install this release.
   */
  private async stage(version: string, archive: UpdateAsset, manual: boolean): Promise<UpdateState | undefined> {
    const staging = this.options.staging!
    const file = this.stagedPath(archive)
    // An archive an earlier run downloaded (Varia was closed while it was being unpacked) is not downloaded again.
    try { if (!await this.verified(archive)) await this.downloadAsset(version, archive) } catch (error) { return this.fail(error, 'download', manual, version) }
    // Varia is closing: the archive stays for the next run, and no helper is started that nothing could stop.
    if (this.disposed) return this.state
    this.set({ status: 'preparing', version })
    const controller = this.abort = new AbortController()
    try {
      await staging.stage(file, version, archive.sha512, controller.signal)
    } catch {
      if (this.disposed) return this.state
      await rm(file, { force: true }).catch(() => {})
      this.unstageable = version
      await staging.clear().catch(() => {})
      // Remembered across runs: each would otherwise download the archive, fail to unpack it, and download the installer.
      await staging.markFailed(version, true).catch(() => {})
      return undefined
    }
    // The unpacked copy is what installs.
    await rm(file, { force: true }).catch(() => {})
    this.ready = { file, version, staged: true, sha512: archive.sha512 }
    void this.sweep(undefined)
    return this.set({ status: 'ready', version })
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

  /** Downloads `asset` to its place in the download folder, verified; a failure leaves nothing behind. */
  private async downloadAsset(version: string, asset: UpdateAsset): Promise<string> {
    const staged = this.stagedPath(asset)
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
      return staged
    } catch (error) {
      await file?.close().catch(() => {})
      await rm(partial, { force: true }).catch(() => {})
      throw error
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
