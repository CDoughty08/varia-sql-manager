import { scriptingOptionDefs, scriptingOptionGroupLabels } from '../scripting/options.ts'
import type { BooleanSettingDef, EnumSettingDef, SettingDef } from './types'

type ScriptingDef = typeof scriptingOptionDefs[number]
/** The Scripting page's entry for one scripting option, keeping its key and enum values as literal types. */
type ScriptingEntry<D> = D extends ScriptingDef
  ? (D extends { readonly type: 'enum' } ? Omit<EnumSettingDef, 'key' | 'values'> & { readonly values: D['values'] } : Omit<BooleanSettingDef, 'key'>)
    & { readonly key: `objectExplorer.scripting.${D['key']}` }
  : never
export const scriptingSettingPrefix = 'objectExplorer.scripting.'

/**
 * SQL Server Object Explorer › Scripting: one entry per option of src/shared/scripting/options.ts, in its order and
 * groups. That file stays the options' source of truth, and the backend's embedded catalogue's. `docsDefault` is SSMS's.
 */
export function scriptingSettingEntries(): readonly ScriptingEntry<ScriptingDef>[] {
  return scriptingOptionDefs.map(def => {
    const common = {
      key: scriptingSettingPrefix + def.key, page: 'objectExplorer.scripting', group: scriptingOptionGroupLabels[def.group], label: def.label, description: def.description,
      ...'disabledWhen' in def ? { disabledWhen: scriptingSettingPrefix + def.disabledWhen } : {}
    }
    return def.type === 'boolean'
      ? { ...common, type: 'boolean', default: def.default, ...'docsDefault' in def ? { ssmsDefault: def.docsDefault } : {} }
      : { ...common, type: 'enum', values: def.values, default: def.default }
  }) as unknown as readonly ScriptingEntry<ScriptingDef>[]
}

/** SQL Server Object Explorer pages. */
export const objectExplorerSettings = [
  {
    key: 'objectExplorer.selectTopRows', page: 'objectExplorer.commands', group: 'Table and View Options', label: 'Value for Select Top <n> Rows command', type: 'integer',
    min: 1, max: 2_147_483_647, default: 1000, keywords: ['select top', 'rows'],
    description: 'How many rows Select Top Rows reads, and the number its menu item shows.'
  },
  {
    key: 'objectExplorer.search.indexOnConnect', page: 'objectExplorer.commands', group: 'Search Objects', label: 'Index objects when a server connects', type: 'boolean', default: true, varia: true,
    keywords: ['search', 'index', 'objects', 'find', 'definitions'],
    description: 'Reads the names of every table, view, procedure, function, synonym, sequence, trigger and type you may see in each database, one database at a time on a session of its own, so Search Objects finds them whether or not Object Explorer has loaded them. The index stays in memory and is dropped when the server disconnects. While it is False, Search Objects indexes a server the first time you search it.'
  },
  {
    key: 'objectExplorer.search.definitions', page: 'objectExplorer.commands', group: 'Search Objects', label: 'Index module definitions', type: 'boolean', default: true, varia: true,
    keywords: ['search', 'index', 'definitions', 'procedures', 'text'],
    description: 'Also keeps the text of procedures, functions, views and triggers you may VIEW DEFINITION of, so Search Objects can find text inside them (up to 1,000,000 characters of each, and 64 Mi characters in all). Applies to the next build.'
  },
  ...scriptingSettingEntries()
] as const satisfies readonly SettingDef[]
