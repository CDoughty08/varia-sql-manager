import { scriptLimits } from '../shared/scripting/catalog'
import { defaultScriptingOptions, parseStoredScriptingOptions, storedScriptingOptions, type ScriptingOptions } from '../shared/scripting/options'
import { quarantine, readJsonFile, writeJsonAtomic, type JsonInvalidReason, type JsonRead } from './json-file'

export interface ScriptingOptionsLoad { options: ScriptingOptions; warning?: string }

const reasons: Record<JsonInvalidReason | 'values', string> = {
  size: `larger than ${scriptLimits.prefsBytes / 1024} KiB`, encoding: 'not UTF-8', json: 'not valid JSON', values: 'unsupported values'
}

export const unreadableScriptingOptions = 'Scripting options could not be read, so changes are not saved.'

/**
 * `<userData>/scripting-options.json`: Tools › Options › Scripting, following `AppearanceStore`. The file is read once;
 * an invalid one is quarantined, and its warning goes only to the calls waiting for that read, so a reloaded window
 * does not show it again. A read that fails (permissions, a folder at the path) is not cached. Every save reads the
 * file again first, as ConnectionStore does: one it cannot read may hold the user's options and is never replaced.
 */
export class ScriptingOptionsStore {
  /** Reads, quarantines and writes run one at a time. */
  private queue: Promise<void> = Promise.resolve()
  private loaded?: Promise<ScriptingOptionsLoad>
  constructor(private path: string) {}
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.then(() => {}, () => {})
    return next
  }
  async load(): Promise<ScriptingOptionsLoad> {
    this.loaded ??= this.serial(() => this.read())
    const pending = this.loaded
    try {
      const { options, warning } = await pending
      if (warning && this.loaded === pending) this.loaded = Promise.resolve({ options })
      return warning ? { options, warning } : { options }
    } catch (error) {
      if (this.loaded === pending) this.loaded = undefined
      throw error
    }
  }
  /**
   * Validates strictly, then writes atomically after earlier work; resolves to what the file now holds. The file is
   * read first: content a load would quarantine is quarantined, and a file that cannot be read is left as it is.
   */
  save(options: unknown): Promise<ScriptingOptions> {
    const stored = storedScriptingOptions(options as ScriptingOptions)
    return this.serial(async () => {
      let current: JsonRead
      try { current = await readJsonFile(this.path, scriptLimits.prefsBytes) } catch { throw new Error(unreadableScriptingOptions) }
      if (current.kind === 'invalid' || current.kind === 'ok' && !parseStoredScriptingOptions(current.value)) await quarantine(this.path)
      await writeJsonAtomic(this.path, stored, scriptLimits.prefsBytes, 'Scripting options exceed their size limit.')
      this.loaded = Promise.resolve({ options: stored.options })
      return stored.options
    })
  }
  private async read(): Promise<ScriptingOptionsLoad> {
    const read = await readJsonFile(this.path, scriptLimits.prefsBytes)
    if (read.kind === 'missing') return { options: defaultScriptingOptions }
    if (read.kind === 'ok') {
      const options = parseStoredScriptingOptions(read.value)
      if (options) return { options }
    }
    await quarantine(this.path)
    const reason = reasons[read.kind === 'invalid' ? read.reason ?? 'json' : 'values']
    return { options: defaultScriptingOptions, warning: `Scripting options were invalid (${reason}) and were reset; the original file was kept.` }
  }
}
