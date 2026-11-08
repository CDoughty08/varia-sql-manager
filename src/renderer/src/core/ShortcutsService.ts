import type { ApiResult, ShortcutsApi, ShortcutsSnapshot as MainShortcutsSnapshot } from '../../../shared/contracts'
import { effectiveRules, type EffectiveShortcuts } from '../../../shared/commands/effective'
import { gestureOverrides } from '../../../shared/commands/gesture-choices'
import type { GestureId, GestureModifiers } from '../../../shared/commands/gestures'
import type { Platform, ResolvedRule } from '../../../shared/commands/keybindings'
import { emptyShortcutFile, shortcutFileSchema, type ShortcutFile } from '../../../shared/commands/shortcut-schema'
import { onUnexpectedError } from './errors'
import { SnapshotStore } from './store'
import type { Disposable } from './types'

/** Main's shortcuts as the page receives them (`varia:shortcuts-changed`). */
export type ShortcutsFileSnapshot = Readonly<MainShortcutsSnapshot>
/** `window.varia.shortcuts`, the preload API main serves (src/main/shortcut-store.ts). */
export type { ShortcutsApi }

export interface ShortcutsSnapshot extends ShortcutsFileSnapshot {
  /** What the workbench applies: the catalogue ⊕ scheme ⊕ the file's entries, with the entries it did not apply. */
  readonly effective: EffectiveShortcuts
  /** Main's first answer has arrived (or failed: then the catalogue's keys apply). */
  readonly loaded: boolean
  /** Main set part or all of the file aside on reading it; `notice` says so in fixed words, for a banner. */
  readonly salvaged: boolean
  readonly notice?: string
}
/** What applying a snapshot reaches: the dispatcher (and through it labels, menus, the palette and the editor bridge) and gestures. */
export interface ShortcutsTargets {
  readonly keybindings?: { setRules(rules: readonly ResolvedRule[]): void }
  readonly gestures?: { setModifiers(choices: ReadonlyMap<GestureId, GestureModifiers | null>): void }
}
export interface ShortcutsServiceOptions extends ShortcutsTargets {
  readonly api: ShortcutsApi
  readonly platform: Platform
  /** The snapshot before main answers; the empty file at revision 0 by default. */
  readonly initial?: ShortcutsFileSnapshot
  /** The initial snapshot is main's already (tests), so no load is needed. */
  readonly loaded?: boolean
}

type ShortcutsReport = (message: string, kind: 'error' | 'warning') => void
const errorText = (error: unknown) => error instanceof Error && error.message ? error.message : 'The operation failed.'

/**
 * The user's keyboard and mouse shortcuts in the renderer. Main owns `shortcuts.json`; this holds the file and revision
 * main last sent, the effective rules built from them, and applies each new snapshot to the keybinding service (keys,
 * menus, the palette, labels, the editor bridge) and the gesture service. Every file from main is validated, and a push
 * no newer than the revision held is ignored. One service serves the main window and its popouts.
 */
export class ShortcutsService extends SnapshotStore<ShortcutsSnapshot> implements Disposable {
  private targets: ShortcutsTargets
  private report?: ShortcutsReport
  private readonly queued: [string, 'error' | 'warning'][] = []
  private loading?: Promise<boolean>
  /**
   * The notice the banner last showed: main repeats a notice on every read until a save, in the same words and across
   * revisions (a valid hand edit after a salvage keeps it), and names each one (`noticeId`; the revision for a main that
   * does not).
   */
  private noticeShown?: string
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly options: ShortcutsServiceOptions) {
    const initial = options.initial ?? { file: emptyShortcutFile, revision: 0 }
    super({ ...initial, effective: effectiveRules(options.platform, initial.file), loaded: options.loaded ?? false, salvaged: false })
    this.targets = { keybindings: options.keybindings, gestures: options.gestures }
    let unsubscribe = () => {}
    try { unsubscribe = options.api.onChanged(snapshot => this.accept(snapshot)) } catch (error) { onUnexpectedError(error) }
    this.unsubscribe = unsubscribe
    if (options.initial) this.applyTargets()
  }
  /** Starts a load and resolves once main answers or after `timeout` ms, whichever is first, as `SettingsService.create`. */
  static async create(options: ShortcutsServiceOptions, { timeout = 1500 }: { timeout?: number } = {}): Promise<ShortcutsService> {
    const service = new ShortcutsService(options)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([service.load(), new Promise(resolve => { timer = setTimeout(resolve, timeout) })])
    clearTimeout(timer)
    return service
  }
  /** The contract's name for `getSnapshot`. */
  snapshot(): ShortcutsSnapshot { return this.getSnapshot() }
  /** Where load failures and main's notice go: the command banner. Messages from before this are shown now. */
  setReporter(report: ShortcutsReport): void {
    this.report = report
    for (const [message, kind] of this.queued.splice(0)) report(message, kind)
  }
  private notify(message: string, kind: 'error' | 'warning'): void {
    if (this.report) this.report(message, kind)
    else this.queued.push([message, kind])
  }
  /** Connects the services a snapshot applies to (the workbench creates them after this) and applies the current one. */
  bind(targets: ShortcutsTargets): Disposable {
    this.targets = { ...this.targets, ...targets }
    this.applyTargets()
    return { dispose: () => { this.targets = {} } }
  }
  private applyTargets(): void {
    const { effective } = this.getSnapshot()
    try { this.targets.keybindings?.setRules(effective.rules) } catch (error) { onUnexpectedError(error) }
    try { this.targets.gestures?.setModifiers(gestureOverrides(effective.gestures)) } catch (error) { onUnexpectedError(error) }
  }

  /**
   * Reads main's shortcuts; later calls share a read that succeeded or is in flight, and the next call after a failure
   * reads again. Resolves to whether main's file is in: on failure the catalogue's keys stay.
   */
  load(): Promise<boolean> {
    const pending = this.loading ??= this.read()
    return pending.then(ok => {
      if (!ok && this.loading === pending) this.loading = undefined
      return ok
    })
  }
  /**
   * Reads main's shortcuts again even after a successful load: main re-reads the file on every get, so the Shortcuts page
   * calls this when it opens to see a hand edit (a newer revision) before the user starts editing.
   */
  reload(): Promise<boolean> {
    const pending = this.loading = this.read()
    return pending.then(ok => {
      if (!ok && this.loading === pending) this.loading = undefined
      return ok
    })
  }
  private async read(): Promise<boolean> {
    let ok = false, failure: string | undefined, notice: string | undefined
    // What applied before this read: main's file (from an earlier load or push) or still the catalogue's keys.
    const before = this.getSnapshot(), hadFile = before.loaded && before.revision > 0
    try {
      const result = await this.options.api.get()
      if (!result.ok) failure = result.error
      else {
        const { salvaged, revision } = result.value
        const text = typeof result.value.notice === 'string' ? result.value.notice : undefined
        const noticeKey = typeof result.value.noticeId === 'number' ? `id ${result.value.noticeId}` : `revision ${revision}`
        ok = this.accept(result.value, { loaded: true, salvaged: salvaged === true, notice: text })
        if (!ok) failure = 'Main sent shortcuts this version does not support.'
        // An answer older than what is held (a save or push overtook it) is old news; so is a notice already shown. A new
        // damaged edit raises a new notice, so it shows even in the same words.
        else if (text && revision >= this.getSnapshot().revision && noticeKey !== this.noticeShown) { notice = text; this.noticeShown = noticeKey }
      }
    } catch (error) { failure = errorText(error) }
    if (this.disposed) return false
    if (!ok && !this.getSnapshot().loaded) this.publish({ ...this.getSnapshot(), loaded: true })
    if (failure) this.notify(hadFile ? `Your shortcuts could not be read again, so the ones already loaded stay: ${failure}` : `Your shortcuts could not be loaded, so the default keys are used: ${failure}`, 'error')
    else if (notice) this.notify(notice, 'warning')
    return ok
  }
  /**
   * Takes main's file when it is valid and newer than what is held, publishes it and applies its rules. Returns whether
   * the value was valid (an old revision is valid, just not newer). `extra` comes with a get answer (`loaded` and main's
   * notice, which replaces the held one) or a save (which clears it); a push has none and keeps the notice, since main
   * may keep a notice across the change it pushes (a save's re-read that set a hand edit aside).
   */
  private accept(value: unknown, extra: Partial<Pick<ShortcutsSnapshot, 'loaded' | 'salvaged' | 'notice'>> = {}): boolean {
    if (this.disposed) return false
    const current = this.getSnapshot()
    const record = typeof value === 'object' && value !== null ? value as Partial<ShortcutsFileSnapshot> : {}
    const parsed = shortcutFileSchema.safeParse(record.file)
    const revision = record.revision
    if (!parsed.success || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return false
    const newer = revision > current.revision || (revision === current.revision && !current.loaded && extra.loaded === true)
    if (!newer) {
      // An answer for the revision held is main's current word on it: a get's notice (one a save's re-read kept arrives
      // so, after its push), or a save's reply clearing the notice (main pushes the saved file before it replies, so the
      // reply is never newer). An older answer is late: a save or push overtook it, and its notice may be one main has
      // since cleared.
      const fresh = revision === current.revision && (extra.loaded === true || 'notice' in extra)
      if (fresh && (!current.loaded || extra.salvaged !== current.salvaged || extra.notice !== current.notice)) this.publish({ ...current, ...extra })
      else if (!fresh && extra.loaded && !current.loaded) this.publish({ ...current, loaded: true })
      return true
    }
    // The same content again (an echo, a re-push) keeps the file object, so its memoised rules and labels stay put.
    if (JSON.stringify(parsed.data) === JSON.stringify(current.file)) {
      this.publish({ ...current, ...extra, revision })
      return true
    }
    const file = parsed.data as ShortcutFile
    this.publish({ ...current, ...extra, file, revision, effective: effectiveRules(this.options.platform, file) })
    this.applyTargets()
    return true
  }
  /**
   * Saves `file` through main and applies it once main answers. `baseRevision` is the revision the caller's draft was
   * based on (the snapshot the Shortcuts page opened with), not the latest one: main refuses a save from an older
   * revision with code `STALE` (another window saved, or the file was edited by hand), so a draft never silently replaces
   * a change the user has not seen. After `STALE` the service reads main again and adopts its file, so the caller can show
   * it and the next save can start from it.
   */
  async save(file: ShortcutFile, baseRevision: number): Promise<ApiResult<{ revision: number }>> {
    const parsed = shortcutFileSchema.safeParse(file)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'The shortcuts are not valid.' }
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) return { ok: false, error: 'The shortcuts have no valid base revision.' }
    try {
      const result = await this.options.api.save(file, baseRevision)
      if (!result.ok) {
        // Main pushes a newer file only when it saw a change; a renderer behind for another reason (a failed first get)
        // would otherwise stay behind and every save would be STALE.
        if (result.code === 'STALE') await this.reload()
        return result
      }
      if (typeof result.value?.revision !== 'number') return { ok: false, error: 'Main sent an answer this version does not support.' }
      // Main clears its notice on a save. A save whose own re-read set a hand edit aside is refused with STALE instead, and
      // the reload above shows that notice.
      this.accept({ file, revision: result.value.revision }, { salvaged: false, notice: undefined })
      return { ok: true, value: { revision: result.value.revision } }
    } catch (error) { return { ok: false, error: errorText(error) } }
  }
  /** Main's open dialog; the file is read and validated but not saved (the page previews it, then saves). */
  async importFile(): ReturnType<ShortcutsApi['importFile']> {
    try { return await this.options.api.importFile() } catch (error) { return { ok: false, error: errorText(error) } }
  }
  /** Main's save dialog, writing `file`. */
  async exportFile(file: ShortcutFile): ReturnType<ShortcutsApi['exportFile']> {
    try { return await this.options.api.exportFile(file) } catch (error) { return { ok: false, error: errorText(error) } }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.targets = {}
    try { this.unsubscribe() } catch (error) { onUnexpectedError(error) }
    this.clearListeners()
  }
}
