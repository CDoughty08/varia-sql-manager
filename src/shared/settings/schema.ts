// The zod schemas of settings, built from the definitions: main validates every update and the file, and the renderer
// every state it receives.
import { z } from 'zod'
import { defaultSettings, settingDefs, settingKeyPattern, settingsLimits, type SettingKey, type SettingsValues, type SettingValue } from './catalog'
import type { SettingDef } from './types'

export const valueSchema = (def: SettingDef) => def.type === 'boolean' ? z.boolean()
  : def.type === 'integer' ? z.number().int().min(def.min).max(def.max)
    : z.enum(def.values.map(item => item.value) as [string, ...string[]])

/** Every setting, and nothing else. */
export const settingsValuesSchema = z.object(Object.fromEntries(settingDefs.map(def => [def.key, valueSchema(def)]))).strict() as unknown as z.ZodType<SettingsValues>
/** Changed settings; `null` resets one to its default. */
export type SettingsPatch = { readonly [K in SettingKey]?: SettingValue<K> | null }
export const settingsPatchSchema = z.object(Object.fromEntries(settingDefs.map(def => [def.key, valueSchema(def).nullable()]))).partial().strict()
  .refine(patch => Object.keys(patch).length > 0, 'Change at least one setting.') as unknown as z.ZodType<SettingsPatch>
export interface SettingsState { readonly revision: number; readonly values: SettingsValues }
/** What a load answers; `warning` reports a file that was reset or salvaged. */
export type SettingsLoad = SettingsState & { readonly warning?: string }
export const settingsStateSchema = z.object({ revision: z.number().int().min(0), values: settingsValuesSchema }).strict() as unknown as z.ZodType<SettingsState>

/** A value a newer version stored under a key this one does not know: kept verbatim so a downgrade never deletes it. */
export type UnknownSettingValue = boolean | number | string
/** What `<userData>/settings.json` holds: the values that differ from their defaults, and unknown keys, sorted by key. */
export interface StoredSettings { readonly version: 1; readonly values: Readonly<Record<string, unknown>> }
export interface ParsedSettings {
  readonly overrides: Partial<Record<SettingKey, unknown>>
  readonly unknown: Readonly<Record<string, UnknownSettingValue>>
  /** Known keys whose stored value this version does not support: dropped, so they take their defaults. */
  readonly invalidKeys: readonly SettingKey[]
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const keepUnknown = (key: string, value: unknown): value is UnknownSettingValue => key.length <= settingsLimits.keyChars && settingKeyPattern.test(key)
  && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= settingsLimits.unknownStringChars))

/**
 * The settings in a stored file, or undefined when its top level is not `{ version: 1, values: {...} }`. Only own
 * properties are read, so `__proto__` is just an unknown key. Overrides equal to their default are dropped.
 */
export function parseStoredSettings(value: unknown): ParsedSettings | undefined {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.values) || Object.keys(value).some(key => key !== 'version' && key !== 'values')) return undefined
  const source = value.values, overrides: Partial<Record<SettingKey, unknown>> = {}, unknown: Record<string, UnknownSettingValue> = {}, invalidKeys: SettingKey[] = []
  for (const def of settingDefs) {
    const key = def.key as SettingKey
    if (!Object.hasOwn(source, key)) continue
    const parsed = valueSchema(def).safeParse(source[key])
    if (!parsed.success) invalidKeys.push(key)
    else if (parsed.data !== defaultSettings[key]) overrides[key] = parsed.data
  }
  let kept = 0
  for (const key of Object.keys(source)) {
    if (Object.hasOwn(defaultSettings, key) || kept >= settingsLimits.unknownKeys) continue
    const item = source[key]
    // defineProperty, so a stored `__proto__` becomes an own key instead of the object's prototype.
    if (keepUnknown(key, item)) { Object.defineProperty(unknown, key, { value: item, enumerable: true, writable: true, configurable: true }); kept++ }
  }
  return { overrides, unknown, invalidKeys }
}

/** The complete values: defaults with `overrides` applied. */
export const withDefaults = (overrides: Partial<Record<SettingKey, unknown>>): SettingsValues => ({ ...defaultSettings, ...overrides }) as SettingsValues

/** The file for `overrides` and `unknown`: keys sorted, so the file diffs cleanly. */
export function storedSettings(overrides: Partial<Record<SettingKey, unknown>>, unknown: Readonly<Record<string, UnknownSettingValue>> = {}): StoredSettings {
  const values: Record<string, unknown> = {}
  const entries = [...Object.entries(overrides), ...Object.entries(unknown)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  for (const [key, item] of entries) Object.defineProperty(values, key, { value: item, enumerable: true, writable: true, configurable: true })
  return { version: 1, values }
}
