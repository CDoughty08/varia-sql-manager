import { scriptLimits } from '../shared/scripting/catalog'
import { defaultScriptingOptions, parseStoredScriptingOptions, storedScriptingOptions, type ScriptingOptions } from '../shared/scripting/options'
import { quarantine, readJsonFile, writeJsonAtomic, type JsonInvalidReason } from './json-file'

export interface ScriptingOptionsLoad { options: ScriptingOptions; warning?: string }

const reasons: Record<JsonInvalidReason | 'values', string> = {
  size: `larger than ${scriptLimits.prefsBytes / 1024} KiB`, encoding: 'not UTF-8', json: 'not valid JSON', values: 'unsupported values'
}

/**
 * `<userData>/scripting-options.json`: Tools › Options › Scripting, following `AppearanceStore`. The file is read once;
 * an invalid one is quarantined, and its warning goes only to the calls waiting for that read, so a reloaded window
 * does not show it again. A read that fails (permissions, a folder at the path) is not cached, and nothing is overwritten.
 */
export class ScriptingOptionsStore {
  private writes: Promise<void> = Promise.resolve()
  private loaded?: Promise<ScriptingOptionsLoad>
  constructor(private path: string) {}
  async load(): Promise<ScriptingOptionsLoad> {
    this.loaded ??= this.read()
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
  /** Validates strictly, then writes atomically after earlier writes; resolves to what the file now holds. */
  save(options: unknown): Promise<ScriptingOptions> {
    const stored = storedScriptingOptions(options as ScriptingOptions)
    const next = this.writes.then(() => writeJsonAtomic(this.path, stored, scriptLimits.prefsBytes, 'Scripting options exceed their size limit.'))
    this.writes = next.catch(() => {})
    return next.then(() => {
      this.loaded = Promise.resolve({ options: stored.options })
      return stored.options
    })
  }
  private async read(): Promise<ScriptingOptionsLoad> {
    await this.writes
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
