import type { VariaApi } from '../../../shared/contracts'
import { defaultSettings, type BooleanSettingKey, type SettingKey, type SettingsValues, type SettingValue } from '../../../shared/settings/catalog'
import { settingsPatchSchema, settingsStateSchema, type SettingsPatch, type SettingsState } from '../../../shared/settings/schema'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'

export interface SettingsSnapshot {
  /** What the workbench applies: main's values, the defaults until they arrive, with this session's unsaved toggles. */
  readonly values: SettingsValues
  /** Main's revision of `values`; 0 until main's first answer. */
  readonly revision: number
  readonly loaded: boolean
  /** Main reset or salvaged the file; shown once in the command banner, as a warning. */
  readonly warning?: string
}
export type SettingsApi = Pick<VariaApi, 'getSettings' | 'updateSettings' | 'onSettingsChanged'>
export interface OptionsDialogState { readonly open: boolean; readonly page?: string }
type Report = (message: string, kind: 'error' | 'warning') => void

class DialogStore extends SnapshotStore<OptionsDialogState> {
  set(value: OptionsDialogState) { this.publish(value) }
  clear() { this.clearListeners() }
}
const errorText = (error: unknown) => error instanceof Error && error.message ? error.message : 'The operation failed.'

/**
 * Tools › Options in the renderer: main stores the settings, and this holds the values the workbench applies, and
 * whether the Options dialog is open. Every state from main is validated; a push no newer than the values held is
 * ignored. Changes go to main only as patches, and the snapshot follows main's answer.
 */
export class SettingsService extends SnapshotStore<SettingsSnapshot> implements Disposable {
  private readonly dialogStore = new DialogStore({ open: false })
  private loading?: Promise<boolean>
  /** Main's last values, without session overrides. */
  private stored: SettingsValues
  /** Toggles whose save failed: they apply until this window closes or a later save of the key succeeds. */
  private readonly session = new Map<SettingKey, unknown>()
  /** Toggles on their way to main, so a second press flips the first's result rather than repeating it. */
  private readonly toggling = new Map<SettingKey, boolean>()
  private toggleWarned = false
  private report?: Report
  private readonly queued: [string, 'error' | 'warning'][] = []
  private lastPage?: string
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly api: SettingsApi, initial: SettingsValues = defaultSettings) {
    super({ values: initial, revision: 0, loaded: false })
    this.stored = initial
    let unsubscribe = () => {}
    try { unsubscribe = api.onSettingsChanged(state => this.accept(state)) } catch (error) { onUnexpectedError(error) }
    this.unsubscribe = unsubscribe
  }
  /**
   * Starts a load and resolves once main answers or after `timeout` ms, whichever comes first: startup never waits
   * longer for main, and values that arrive later apply then.
   */
  static async create(api: SettingsApi, { timeout = 1500 }: { timeout?: number } = {}): Promise<SettingsService> {
    const service = new SettingsService(api)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([service.load(), new Promise(resolve => { timer = setTimeout(resolve, timeout) })])
    clearTimeout(timer)
    return service
  }
  /** Where failures and main's warning go: the command banner. Messages from before this are shown now. */
  setReporter(report: Report): void {
    this.report = report
    for (const [message, kind] of this.queued.splice(0)) report(message, kind)
  }
  private notify(message: string, kind: 'error' | 'warning'): void {
    if (this.report) this.report(message, kind)
    else this.queued.push([message, kind])
  }

  get<K extends SettingKey>(key: K): SettingValue<K> { return this.getSnapshot().values[key] }
  /**
   * Reads main's settings; later calls share a read that succeeded or is in flight, and the next call after a failure
   * reads again. Resolves to whether main's values are in: a failure keeps the defaults and is reported.
   */
  load(): Promise<boolean> {
    const pending = this.loading ??= this.read()
    return pending.then(ok => {
      if (!ok && this.loading === pending) this.loading = undefined
      return ok
    })
  }
  private async read(): Promise<boolean> {
    let failure: string | undefined, state: SettingsState | undefined, warning: string | undefined
    try {
      const result = await this.api.getSettings()
      if (!result.ok) failure = result.error
      else {
        const parsed = settingsStateSchema.safeParse({ revision: result.value.revision, values: result.value.values })
        if (parsed.success) state = parsed.data
        else failure = 'Main sent settings this version does not support.'
        warning = typeof result.value.warning === 'string' ? result.value.warning : undefined
      }
    } catch (error) { failure = errorText(error) }
    if (this.disposed) return false
    this.accept(state, { loaded: true, ...warning ? { warning } : {} })
    if (failure) this.notify(`Settings could not be loaded, so the defaults are used: ${failure}`, 'error')
    else if (warning) this.notify(warning, 'warning')
    return !failure
  }
  /** Takes main's state when it is valid and newer than what is held, and publishes what changed. */
  private accept(value: unknown, extra: Partial<Pick<SettingsSnapshot, 'loaded' | 'warning'>> = {}): void {
    if (this.disposed) return
    const current = this.getSnapshot()
    const parsed = value === undefined ? undefined : settingsStateSchema.safeParse(value)
    const state = parsed?.success && parsed.data.revision > current.revision ? parsed.data : undefined
    if (state) this.stored = state.values
    const values = this.session.size ? { ...this.stored, ...Object.fromEntries(this.session) } as SettingsValues : this.stored
    const next = { ...current, ...extra, values, revision: state?.revision ?? current.revision }
    const changed = next.revision !== current.revision || next.loaded !== current.loaded || next.warning !== current.warning
      || Object.keys(values).some(key => values[key as SettingKey] !== current.values[key as SettingKey])
    if (changed) this.publish(next)
  }
  /** Saves a patch through main and publishes main's answer; throws main's error, leaving the snapshot as it was. */
  async update(patch: SettingsPatch): Promise<void> {
    const parsed = settingsPatchSchema.safeParse(patch)
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'The settings are not valid.')
    const result = await this.api.updateSettings(parsed.data)
    if (!result.ok) throw new Error(result.error)
    const state = settingsStateSchema.safeParse(result.value)
    if (!state.success) throw new Error('Main sent settings this version does not support.')
    for (const key of Object.keys(parsed.data)) this.session.delete(key as SettingKey)
    this.accept(state.data)
  }
  /**
   * Flips a boolean setting (a command's toggle) and saves it. Never throws: when the save fails the new value applies
   * for this session only, and the first such failure is reported.
   */
  async toggle(key: BooleanSettingKey): Promise<void> {
    const next = !(this.toggling.get(key) ?? this.get(key))
    this.toggling.set(key, next)
    try { await this.update({ [key]: next }) }
    catch (error) {
      if (this.disposed) return
      this.session.set(key, next)
      this.accept(undefined)
      if (!this.toggleWarned) {
        this.toggleWarned = true
        this.notify(`Settings could not be saved: ${errorText(error).replace(/\.$/, '')}. The change applies until you close Varia SQL Manager.`, 'warning')
      }
    } finally { if (this.toggling.get(key) === next) this.toggling.delete(key) }
  }

  get dialog(): ExternalStore<OptionsDialogState> { return this.dialogStore }
  /** Opens Options on `page`, else the page last shown in this session, else Environment › General. */
  openDialog(page?: string): void { this.dialogStore.set({ open: true, page: page ?? this.lastPage ?? 'environment.general' }) }
  closeDialog(): void { this.dialogStore.set({ open: false }) }
  /** The dialog reports the page it shows, so the next open returns to it. */
  showedPage(page: string): void { this.lastPage = page }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.dialogStore.clear()
    this.clearListeners()
  }
}
