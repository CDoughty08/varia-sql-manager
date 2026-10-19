import { scriptLimits } from '../shared/scripting/catalog'
import { parseStoredScriptingOptions, scriptingOptionKeys, type ScriptingOptions } from '../shared/scripting/options'
import { defaultSettings, settingDef, settingsLimits, type SettingKey, type SettingsValues } from '../shared/settings/catalog'
import { scriptingSettingPrefix } from '../shared/settings/object-explorer'
import {
  parseStoredSettings, settingsPatchSchema, storedSettings, withDefaults, type SettingsLoad, type SettingsPatch, type SettingsState, type UnknownSettingValue
} from '../shared/settings/schema'
import { quarantine, readJsonFile, writeJsonAtomic, type JsonInvalidReason } from './json-file'

type Overrides = Partial<Record<SettingKey, unknown>>
/** What settings.json holds, or will: the values that differ from their defaults, and a newer version's keys. */
interface Content { readonly overrides: Overrides; readonly unknown: Readonly<Record<string, UnknownSettingValue>> }
const empty: Content = { overrides: {}, unknown: {} }

const reasons = (bytes: number): Record<JsonInvalidReason | 'values', string> => ({
  size: `larger than ${bytes / 1024} KiB`, encoding: 'not UTF-8', json: 'not valid JSON', values: 'unsupported values'
})
export const unreadableSettings = 'Settings could not be read, so changes are not saved.'
/** The salvage warning, naming at most `settingsLimits.warningLabels` settings. */
export function salvageWarning(keys: readonly SettingKey[]): string {
  const labels = keys.map(key => settingDef(key).label), shown = labels.slice(0, settingsLimits.warningLabels).join(', ')
  const more = labels.length > settingsLimits.warningLabels ? ` and ${labels.length - settingsLimits.warningLabels} more` : ''
  return `Some settings had values this version does not support (${shown}${more}) and were reset to their defaults; the original file was kept.`
}
/** An earlier version's Tools › Options › Scripting, as overrides of the Scripting page's settings. */
function legacyOverrides(options: ScriptingOptions): Overrides {
  const overrides: Overrides = {}
  for (const key of scriptingOptionKeys) {
    const setting = (scriptingSettingPrefix + key) as SettingKey
    if (options[key] !== defaultSettings[setting]) overrides[setting] = options[key]
  }
  return overrides
}
function merged(overrides: Overrides, patch: SettingsPatch): Overrides {
  const next: Overrides = { ...overrides }
  for (const [key, value] of Object.entries(patch) as [SettingKey, unknown][]) {
    if (value === null || value === defaultSettings[key]) delete next[key]
    else next[key] = value
  }
  return next
}
const sameOverrides = (a: Overrides, b: Overrides) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key as SettingKey] === value)

/**
 * `<userData>/settings.json`, Tools › Options' store of record, following ScriptingOptionsStore before it. Reads and
 * writes run one at a time. The file is read once: an invalid one is quarantined, and one with values this version does
 * not support is salvaged (quarantined, then written back without them). A read that fails (permissions, a folder at
 * the path) is not cached and nothing is written. Every update reads the file again first, so a file it cannot read is
 * never replaced and hand edits made meanwhile are merged, not lost.
 *
 * Only while settings.json has never been seen, an earlier version's scripting-options.json is imported; it is left as
 * it was. A quarantined file is replaced at once (an invalid one by an empty file), so the legacy file is not imported
 * again, now or on the next start; when that write fails, the next update writes the values held instead.
 *
 * `current()` is the last values known, synchronously: the defaults until the first load. It is only for menu titles.
 * Main code that acts on a value (Save Results As headers, and later AutoRecover and file encodings) awaits `load()`,
 * which is cached, so a choice made just after startup is never ignored.
 */
export class SettingsStore {
  private queue: Promise<void> = Promise.resolve()
  /** The shared read, and the warning its waiters that show warnings get. */
  private loading?: Promise<{ warning?: string }>
  private values: SettingsValues = defaultSettings
  private revision = 0
  private listeners = new Set<(state: SettingsState) => void>()
  /** settings.json was read or written in this session: from then on a missing file holds nothing, not the legacy file. */
  private established = false
  /** What the store moved settings.json away from (quarantine, salvage) and could not write back. */
  private unsaved?: Content
  constructor(private readonly path: string, private readonly legacyPath: string) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.then(() => {}, () => {})
    return next
  }
  current(): SettingsValues { return this.values }
  private state(): SettingsState { return { revision: this.revision, values: this.values } }
  onDidChange(listener: (state: SettingsState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The complete values. A read that succeeded or is in flight is shared. A warning about the file goes only to waiters
   * of that read that show it (`showsWarning`: the renderer's request), so main's own reads never use it up and a
   * reloaded window does not show it again.
   */
  async load(reader: { readonly showsWarning?: boolean } = {}): Promise<SettingsLoad> {
    const pending = this.loading ??= this.serial(() => this.read())
    try {
      const { warning } = await pending
      if (!warning || !reader.showsWarning) return this.state()
      if (this.loading === pending) this.loading = Promise.resolve({})
      return { ...this.state(), warning }
    } catch (error) {
      if (this.loading === pending) this.loading = undefined
      throw error
    }
  }

  /**
   * Applies a strict patch (`null` resets a key) after earlier work, merging it into what the file holds now, and
   * resolves to the new state. A patch that changes nothing writes nothing.
   */
  update(value: unknown): Promise<SettingsState> {
    const patch = settingsPatchSchema.parse(value)
    return this.serial(async () => {
      let content: Content, rewrite = false
      try {
        const read = await readJsonFile(this.path, settingsLimits.fileBytes)
        if (read.kind === 'missing') {
          content = this.unsaved ?? (this.established ? empty : await this.legacyContent())
          rewrite = !!this.unsaved
        } else {
          this.established = true
          this.unsaved = undefined
          const parsed = read.kind === 'ok' ? parseStoredSettings(read.value) : undefined
          // What a load would quarantine is kept the same way before the file is replaced.
          if (!parsed || parsed.invalidKeys.length) { await quarantine(this.path); rewrite = true }
          content = parsed ? { overrides: parsed.overrides, unknown: parsed.unknown } : empty
        }
      } catch { throw new Error(unreadableSettings) }
      const next: Content = { overrides: merged(content.overrides, patch), unknown: content.unknown }
      if (rewrite || !sameOverrides(next.overrides, content.overrides)) {
        // The file may be quarantined by now: what it held stays for the next update, without this patch.
        try { await this.write(next) } catch (error) { if (rewrite) this.unsaved = content; throw error }
        this.unsaved = undefined
      }
      this.loading = Promise.resolve({})
      if (!this.apply(next)) return this.state()
      this.revision++
      const state = this.state()
      // The file is written; a listener's failure must not report the update as failed.
      for (const listener of [...this.listeners]) { try { listener(state) } catch (error) { console.error(error) } }
      return state
    })
  }

  /** Sets the cached values; whether they changed. */
  private apply(content: Content): boolean {
    const values = Object.freeze(withDefaults(content.overrides))
    const changed = Object.entries(values).some(([key, value]) => this.values[key as SettingKey] !== value)
    this.values = values
    if (this.revision === 0) this.revision = 1
    return changed
  }
  private async write(content: Content): Promise<void> {
    await writeJsonAtomic(this.path, storedSettings(content.overrides, content.unknown), settingsLimits.fileBytes, 'Settings exceed their size limit.')
    this.established = true
  }
  /** Replaces a file the store quarantined; a failed write leaves the content for the next update. */
  private async writeBack(content: Content): Promise<void> {
    try { await this.write(content); this.unsaved = undefined } catch { this.unsaved = content }
  }
  /** The legacy file's values for an update while settings.json is missing; an invalid one counts as none. */
  private async legacyContent(): Promise<Content> {
    const legacy = await readJsonFile(this.legacyPath, scriptLimits.prefsBytes)
    const options = legacy.kind === 'ok' ? parseStoredScriptingOptions(legacy.value) : undefined
    return options ? { overrides: legacyOverrides(options), unknown: {} } : empty
  }

  private async read(): Promise<{ warning?: string }> {
    const read = await readJsonFile(this.path, settingsLimits.fileBytes)
    if (read.kind === 'missing') return this.migrate()
    this.established = true
    const parsed = read.kind === 'ok' ? parseStoredSettings(read.value) : undefined
    if (!parsed) {
      await quarantine(this.path)
      this.apply(empty)
      await this.writeBack(empty)
      const reason = reasons(settingsLimits.fileBytes)[read.kind === 'invalid' ? read.reason ?? 'json' : 'values']
      return { warning: `Settings were invalid (${reason}) and were reset; the original file was kept.` }
    }
    const content: Content = { overrides: parsed.overrides, unknown: parsed.unknown }
    this.apply(content)
    if (!parsed.invalidKeys.length) return {}
    await quarantine(this.path)
    await this.writeBack(content)
    return { warning: salvageWarning(parsed.invalidKeys) }
  }
  /** settings.json is missing: import scripting-options.json once, if there is one, and leave it as it was. */
  private async migrate(): Promise<{ warning?: string }> {
    const legacy = await readJsonFile(this.legacyPath, scriptLimits.prefsBytes)
    if (legacy.kind === 'missing') { this.apply(empty); return {} }
    const options = legacy.kind === 'ok' ? parseStoredScriptingOptions(legacy.value) : undefined
    if (!options) {
      await quarantine(this.legacyPath)
      this.apply(empty)
      const reason = reasons(scriptLimits.prefsBytes)[legacy.kind === 'invalid' ? legacy.reason ?? 'json' : 'values']
      return { warning: `Scripting options were invalid (${reason}) and were reset; the original file was kept.` }
    }
    const content: Content = { overrides: legacyOverrides(options), unknown: {} }
    this.apply(content)
    // A failed write keeps the imported values for this session; settings.json is still missing, so the next start imports again.
    await this.write(content).catch(() => {})
    return {}
  }
}
