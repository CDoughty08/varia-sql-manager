import type { VariaApi } from '../../../shared/contracts'
import { defaultScriptingOptions, scriptingOptionsSchema, type ScriptingOptions } from '../../../shared/scripting/options.ts'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'

export interface ScriptingOptionsSnapshot {
  /** What every Script As request carries: the defaults until `load` resolves. */
  readonly options: ScriptingOptions
  readonly loaded: boolean
  /** Main reset an invalid options file; shown once in the command banner, as a warning. */
  readonly warning?: string
}
export type ScriptingOptionsApi = Pick<VariaApi, 'getScriptingOptions' | 'setScriptingOptions'>

class FlagStore extends SnapshotStore<boolean> {
  set(value: boolean) { if (value !== this.getSnapshot()) this.publish(value) }
  clear() { this.clearListeners() }
}
const errorText = (error: unknown) => error instanceof Error && error.message ? error.message : 'The operation failed.'

/** Tools › Options › Scripting: main stores the options, and this holds the copy requests use and whether the dialog is open. */
export class ScriptingOptionsService extends SnapshotStore<ScriptingOptionsSnapshot> implements Disposable {
  private readonly dialogStore = new FlagStore(false)
  private loading?: Promise<boolean>
  private saved = false
  private disposed = false
  constructor(private readonly api: ScriptingOptionsApi, private readonly report: (message: string, kind: 'error' | 'warning') => void) {
    super({ options: defaultScriptingOptions, loaded: false })
  }
  get dialog(): ExternalStore<boolean> { return this.dialogStore }
  openDialog(): void { this.dialogStore.set(true) }
  closeDialog(): void { this.dialogStore.set(false) }
  /**
   * Reads main's options; later calls share a read that succeeded or is in flight, and the next call after a failure
   * reads again. Resolves to whether the stored options are in: a failure keeps the defaults and is reported.
   */
  load(): Promise<boolean> {
    const pending = this.loading ??= this.read()
    return pending.then(ok => {
      if (!ok && this.loading === pending) this.loading = undefined
      return ok
    })
  }
  /** Stores a complete set through main, then publishes what main stored; throws main's error, leaving the snapshot as it was. */
  async save(next: ScriptingOptions): Promise<ScriptingOptions> {
    const parsed = scriptingOptionsSchema.safeParse(next)
    if (!parsed.success) throw new Error('The scripting options are not valid.')
    const result = await this.api.setScriptingOptions(parsed.data)
    if (!result.ok) throw new Error(result.error)
    const stored = scriptingOptionsSchema.parse(result.value)
    if (!this.disposed) {
      this.saved = true
      this.publish({ options: stored, loaded: true })
    }
    return stored
  }
  private async read(): Promise<boolean> {
    let options: ScriptingOptions | undefined, warning: string | undefined, failure: string | undefined
    try {
      const result = await this.api.getScriptingOptions()
      if (!result.ok) failure = result.error
      else {
        const parsed = scriptingOptionsSchema.safeParse(result.value.options)
        if (parsed.success) options = parsed.data
        else failure = 'Main sent options this version does not support.'
        warning = typeof result.value.warning === 'string' ? result.value.warning : undefined
      }
    } catch (error) { failure = errorText(error) }
    if (this.disposed) return false
    // Options saved while the read was in flight are newer than what it returns.
    this.publish({ options: this.saved || !options ? this.getSnapshot().options : options, loaded: true, ...(warning ? { warning } : {}) })
    if (failure) this.report(`Scripting options could not be loaded, so the defaults are used: ${failure}`, 'error')
    else if (warning) this.report(warning, 'warning')
    return !failure
  }
  dispose(): void {
    this.disposed = true
    this.dialogStore.clear()
    this.clearListeners()
  }
}
