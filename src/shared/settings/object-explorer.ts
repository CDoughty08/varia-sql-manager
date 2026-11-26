import { objectSearchLimits } from '../explorer/search.ts'
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
    key: 'objectExplorer.autoExpandSingleChild', page: 'environment.objectExplorer', label: 'Auto-expand single children',
    type: 'boolean', default: true, varia: true, keywords: ['expand', 'tree', 'folders', 'chain', 'only child'],
    description: 'When you expand a node whose only child can expand too, keep expanding down to the first node with more than one child, and select it. Each level loads as it goes; selecting another row stops it.'
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
    description: 'Reads the names of every object Object Explorer lists that you may see, from logins and databases down to columns and parameters, two databases at a time on a session of their own, so Search Objects finds them whether or not Object Explorer has loaded them. The index stays in memory and is dropped when the server disconnects. While it is False, a server is indexed only when you ask: Build index in Search Objects, or Rebuild Search Index.'
  },
  {
    key: 'objectExplorer.search.definitions', page: 'objectExplorer.commands', group: 'Search Objects', label: 'Index module definitions', type: 'boolean', default: true, varia: true,
    keywords: ['search', 'index', 'definitions', 'procedures', 'text'],
    description: 'Also keeps the text of procedures, functions, views and triggers you may VIEW DEFINITION of, so Search Objects can find text inside them (up to 1,000,000 characters of each, within the index memory limit). Applies to the next build.'
  },
  {
    key: 'objectExplorer.search.memoryLimitMiB', page: 'objectExplorer.commands', group: 'Search Objects', label: 'Index memory limit',
    type: 'integer', min: objectSearchLimits.memoryMiB.min, max: objectSearchLimits.memoryMiB.max, default: objectSearchLimits.memoryMiB.default, unit: 'MiB', varia: true,
    keywords: ['search', 'index', 'memory', 'limit', 'definitions', 'bigquery', 'ram'],
    description: 'The most memory the Search Objects indexes of all connections hold together. Definitions stop being kept once less than a quarter of it is free, and BigQuery indexes take at most five eighths of it between them (less what SQL Server holds), so SQL Server’s definitions keep their room; Search Objects says when anything was left out for memory. Applies to the next build. Lowering it drops nothing an index already holds: disconnect the server to give its memory back.'
  },
  {
    key: 'objectExplorer.search.bigQueryAccessibleProjects', page: 'objectExplorer.commands', group: 'Search Objects', label: 'Index all accessible BigQuery projects', type: 'boolean', default: true, varia: true,
    keywords: ['search', 'index', 'bigquery', 'projects', 'accessible', 'starred', 'columns', 'schemas'],
    description: 'A BigQuery connection’s Search Objects index discovers and indexes every accessible BigQuery project (up to the configured project limit, including tables, views, routines, models, columns and definitions) in addition to the billing project and starred projects. When False, only the billing project and starred projects are indexed. Applies to the next build.'
  },
  {
    key: 'objectExplorer.search.bigQueryMaxProjects', page: 'objectExplorer.commands', group: 'Search Objects', label: 'Maximum accessible BigQuery projects',
    type: 'integer', min: 1, max: objectSearchLimits.bigQuery.maxProjectsCap, default: objectSearchLimits.bigQuery.maxProjects, varia: true,
    enabledBy: 'objectExplorer.search.bigQueryAccessibleProjects', keywords: ['search', 'index', 'bigquery', 'projects', 'limit', 'maximum', 'cap'],
    description: 'The maximum number of accessible BigQuery projects discovered via projects.list during a Search Objects index build. Starred projects and the billing project are always indexed even when this cap is reached. Applies to the next build.'
  },
  ...scriptingSettingEntries()
] as const satisfies readonly SettingDef[]
