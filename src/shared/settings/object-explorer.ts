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

/** Object Explorer navigation, commands and scripting settings. */
export const objectExplorerSettings = [
  {
    key: 'objectExplorer.selectTopRows', page: 'objectExplorer.commands', group: 'Table and View Options', label: 'Value for Select Top <n> Rows command', type: 'integer',
    min: 1, max: 2_147_483_647, default: 1000, keywords: ['select top', 'rows'],
    description: 'How many rows Select Top Rows reads, and the number its menu item shows.'
  },
  {
    key: 'objectExplorer.groupBySchema', page: 'objectExplorer.commands', group: 'Object Explorer', label: 'Group by Schema', type: 'boolean', default: false,
    keywords: ['schema', 'group', 'tree', 'folders'],
    description: 'Lists each database\'s schemas after its own folders, with the Tables, Views, Synonyms and Programmability folders of each schema below it; Database Triggers, Assemblies and Plan Guides stay in the database\'s Programmability folder. A filter below a schema applies to that schema\'s folder only. The Object Explorer toolbar\'s Group by Schema button turns it on and off.'
  },
  {
    key: 'objectExplorer.followActiveQuery', page: 'environment.objectExplorer', label: 'Follow active query',
    type: 'boolean', default: true, varia: true, keywords: ['server', 'connection', 'scroll', 'query tab'],
    description: 'When switching query tabs, bring the server into view if its header is off-screen.'
  },
  {
    key: 'objectExplorer.pinnedServerHeadersTop', page: 'environment.objectExplorer', label: 'Pinned server headers at top',
    type: 'integer', min: 0, max: 10, default: 2, varia: true, keywords: ['sticky', 'servers', 'scroll'],
    description: 'Maximum number of off-screen server headers to show at the top of the tree. Choose 0 to hide this edge. A short pane may fit fewer headers.'
  },
  {
    key: 'objectExplorer.pinnedServerHeadersBottom', page: 'environment.objectExplorer', label: 'Pinned server headers at bottom',
    type: 'integer', min: 0, max: 10, default: 2, varia: true, keywords: ['sticky', 'servers', 'scroll'],
    description: 'Maximum number of off-screen server headers to show at the bottom of the tree. Choose 0 to hide this edge. A short pane may fit fewer headers.'
  },
  {
    key: 'objectExplorer.search.indexOnConnect', page: 'objectExplorer.commands', group: 'Search Objects', label: 'Index objects when a server connects', type: 'boolean', default: true, varia: true,
    keywords: ['search', 'index', 'objects', 'find', 'definitions'],
    description: 'Reads the names of every object Object Explorer lists that you may see, from logins and databases down to columns and parameters, two databases at a time on a session of their own, so Search Objects finds them whether or not Object Explorer has loaded them. The index stays in memory and is dropped when the server disconnects. While it is False, Search Objects indexes a server the first time you search it.'
  },
  {
    key: 'objectExplorer.search.definitions', page: 'objectExplorer.commands', group: 'Search Objects', label: 'Index module definitions', type: 'boolean', default: true, varia: true,
    keywords: ['search', 'index', 'definitions', 'procedures', 'text'],
    description: 'Also keeps the text of procedures, functions, views and triggers you may VIEW DEFINITION of, so Search Objects can find text inside them (up to 1,000,000 characters of each, within the index’s 512 MiB). Applies to the next build.'
  },
  ...scriptingSettingEntries()
] as const satisfies readonly SettingDef[]
