// Tools › Options: every setting, aggregated from one file per area so later areas merge line by line. Main stores the
// values (settings.json), the renderer applies them, and docs/settings.md is generated from here.
import { commandDescriptor, type CommandId } from '../commands/catalog'
import type { Platform } from '../commands/keybindings'
import type { ScriptingOptions } from '../scripting/options.ts'
import { scriptingOptionKeys } from '../scripting/options.ts'
import { documentSettings } from './documents'
import { environmentSettings } from './environment'
import { integrationServicesSettings } from './integration-services'
import { liveDataSettings } from './live-data'
import { objectExplorerSettings, scriptingSettingPrefix } from './object-explorer'
import { settingPages as pages } from './pages'
import { queryExecutionSettings } from './query-execution'
import { queryResultsSettings } from './query-results'
import { statusBarSettings } from './status-bar'
import { textEditorSettings } from './text-editor'
import type { SettingDef, SettingPage } from './types'

export type { SettingDef, SettingPage } from './types'

/** One import and one entry a line: each area belongs to the PR that owns it. */
const settingAreas = [
  environmentSettings,
  documentSettings,
  textEditorSettings,
  statusBarSettings,
  queryExecutionSettings,
  queryResultsSettings,
  objectExplorerSettings,
  liveDataSettings,
  integrationServicesSettings
] as const

type Def = typeof settingAreas[number][number]
export type SettingKey = Def['key']
type ValueOf<D> = D extends { readonly type: 'enum'; readonly values: readonly { readonly value: infer V }[] } ? V : D extends { readonly type: 'integer' } ? number : boolean
/** Every setting's value: a boolean, an integer, or one of an enum's values. */
export type SettingsValues = { readonly [D in Def as D['key']]: ValueOf<D> }
export type SettingValue<K extends SettingKey> = SettingsValues[K]
/** The keys of boolean settings: the ones commands toggle. */
export type BooleanSettingKey = { [K in SettingKey]: SettingsValues[K] extends boolean ? K : never }[SettingKey]

export const settingDefs: readonly SettingDef[] = settingAreas.flat()
export const settingKeys: readonly SettingKey[] = settingDefs.map(def => def.key as SettingKey)
const byKey = new Map(settingDefs.map(def => [def.key, def]))
export const isSettingKey = (value: unknown): value is SettingKey => typeof value === 'string' && byKey.has(value)
export const settingDef = (key: SettingKey): SettingDef => byKey.get(key)!
export const defaultSettings: SettingsValues = Object.freeze(Object.fromEntries(settingDefs.map(def => [def.key, def.default])) as SettingsValues)

export const settingKeyPattern = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){1,4}$/
export const settingsLimits = {
  /** settings.json, read and written. */
  fileBytes: 131_072,
  /** Keys a newer version wrote that this one keeps without knowing them. */
  unknownKeys: 128,
  keyChars: 96,
  unknownStringChars: 512,
  /** The Options search box. */
  searchChars: 256,
  /** Setting labels a salvage warning names before "and N more". */
  warningLabels: 3
} as const

export const settingPages: readonly SettingPage[] = pages
const pagesById = new Map(settingPages.map(page => [page.id, page]))
export const pageById = (id: string): SettingPage | undefined => pagesById.get(id)
/** The page and its ancestors, root first: the breadcrumb. */
export function pagePath(pageId: string): readonly SettingPage[] {
  const path: SettingPage[] = []
  for (let page = pageById(pageId); page; page = page.parent ? pageById(page.parent) : undefined) path.unshift(page)
  return path
}
/** The settings Options shows on `platform`: not hidden, and not limited to other platforms. */
export const visibleSettings = (platform: Platform, defs: readonly SettingDef[] = settingDefs): readonly SettingDef[] =>
  defs.filter(def => !def.hidden && (!def.platforms || def.platforms.includes(platform)))

/**
 * A command's title with its setting filled in ("Select Top 50 Rows"), else `title`. Only an integer from validated
 * settings is substituted, so no renderer string reaches main's menus.
 */
export function commandTitle(id: CommandId, values: SettingsValues = defaultSettings, title: string = commandDescriptor(id).title): string {
  const titled = commandDescriptor(id).titleSetting
  if (!titled) return title
  const value: unknown = values[titled.setting]
  return Number.isSafeInteger(value) ? titled.template.replace('{n}', String(value)) : title
}

/** What every Script As request carries: the Scripting page's values. */
export const scriptingOptionsFrom = (values: SettingsValues): ScriptingOptions =>
  Object.fromEntries(scriptingOptionKeys.map(key => [key, values[(scriptingSettingPrefix + key) as SettingKey]])) as unknown as ScriptingOptions
