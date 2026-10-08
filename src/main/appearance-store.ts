import { defaultThemePreference, themeLimits, themePreferenceSchema } from '../shared/theme/format'
import type { ThemePreference } from '../shared/theme/types'
import { quarantine, readJsonFile, writeJsonAtomic, type JsonInvalidReason } from './json-file'

export interface AppearanceLoad { preference: ThemePreference; warning?: string }

const reasons: Record<JsonInvalidReason | 'values', string> = {
  size: `larger than ${themeLimits.appearanceBytes / 1024} KiB`, encoding: 'not UTF-8', json: 'not valid JSON', values: 'unsupported values'
}

/** `<userData>/appearance.json`: the theme mode and the selected dark and light themes, following `LayoutStore`. */
export class AppearanceStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private path: string) {}
  async load(): Promise<AppearanceLoad> {
    await this.writes
    const read = await readJsonFile(this.path, themeLimits.appearanceBytes)
    if (read.kind === 'missing') return { preference: { ...defaultThemePreference } }
    if (read.kind === 'ok') {
      const parsed = themePreferenceSchema.safeParse(read.value)
      if (parsed.success) return { preference: parsed.data }
    }
    await quarantine(this.path)
    const reason = reasons[read.kind === 'invalid' ? read.reason ?? 'json' : 'values']
    return { preference: { ...defaultThemePreference }, warning: `Theme preferences were invalid (${reason}) and were reset; the original file was kept.` }
  }
  save(preference: ThemePreference): Promise<void> {
    const valid = themePreferenceSchema.parse(preference)
    const next = this.writes.then(() => writeJsonAtomic(this.path, valid, themeLimits.appearanceBytes, 'Theme preferences exceed their size limit.'))
    this.writes = next.catch(() => {})
    return next
  }
}
