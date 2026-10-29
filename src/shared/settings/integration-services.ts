import { liveProbes } from '../live/catalog'
import { ssisLimits } from '../ssis/catalog'
import type { SettingDef } from './types'

/** The tree probe's and the Operations view's interval bounds come from their live catalogue entries, so the settings can
 *  never ask for what they refuse. */
const tree = liveProbes['ssis.catalogProbe'].intervalMs
const operations = liveProbes['ssis.operations.list'].intervalMs

/**
 * SQL Server Integration Services: how Varia follows the SSIS Catalog. SSMS has no such page; its Object Explorer shows
 * catalog changes made elsewhere only after Refresh, and its Active Operations dialog and catalog reports show new operations
 * only after Refresh.
 */
export const integrationServicesSettings = [
  {
    key: 'integrationServices.treeLive', page: 'integrationServices', label: 'Update the SSIS Catalog in Object Explorer as it changes', type: 'boolean', default: true, varia: true,
    keywords: ['ssis', 'ssisdb', 'catalog', 'live', 'refresh', 'deploy', 'object explorer', 'tree'],
    description: 'While a connection\'s SSISDB node is open in Object Explorer, Varia checks the catalog for changes made elsewhere, such as a deployment or a new folder, project or environment, and updates only the folders that changed, keeping what is expanded and selected. The check is one small query that pauses while Object Explorer is hidden. While it is False, the tree changes only on Refresh (F5) and after Varia\'s own changes.'
  },
  {
    key: 'integrationServices.treeRefreshSeconds', page: 'integrationServices', label: 'Check the catalog for changes every', type: 'integer',
    min: tree.min / 1000, max: tree.max / 1000, default: tree.default / 1000, unit: 'seconds', varia: true, enabledBy: 'integrationServices.treeLive',
    keywords: ['ssis', 'ssisdb', 'catalog', 'interval', 'seconds', 'refresh'],
    description: 'How often an open SSISDB node checks the catalog for changes. Each check reads every catalog folder, project, package, environment, variable, reference and parameter the login may see, so a large catalog on a busy server may want a longer interval.'
  },
  {
    key: 'integrationServices.operationsRefreshSeconds', page: 'integrationServices', label: 'Update Operations every', type: 'integer',
    min: operations.min / 1000, max: operations.max / 1000, default: operations.default / 1000, unit: 'seconds', varia: true,
    keywords: ['ssis', 'ssisdb', 'operations', 'active operations', 'executions', 'interval', 'refresh', 'live'],
    description: 'How often an open Integration Services Operations document reads the catalog for new operations and the open ones\' status. It pauses while the document is hidden. A busy catalog on a busy server may want a longer interval.'
  },
  {
    key: 'integrationServices.operationsWindowHours', page: 'integrationServices', label: 'Show operations created in the last', type: 'integer',
    min: 1, max: ssisLimits.operationsWindowHours, default: ssisLimits.operationsDefaultWindowHours, unit: 'hours', varia: true,
    keywords: ['ssis', 'operations', 'window', 'hours', 'history', 'executions'],
    description: 'The window a new Operations document opens on. Its Window filter changes it for that document only. The catalog keeps operations for its own retention period (365 days by default), so a longer window shows nothing older than that.'
  },
  {
    key: 'integrationServices.operationsLimit', page: 'integrationServices', label: 'Show at most', type: 'integer',
    min: 100, max: ssisLimits.operationsRows, default: ssisLimits.operationsDefaultRows, unit: 'operations', varia: true,
    keywords: ['ssis', 'operations', 'rows', 'limit', 'maximum'],
    description: 'The most operations an Operations document holds: the newest ones of its window that pass its filters, open ones first. Open documents read their window again with the new limit. The tiles count every operation the login may see, whatever this limit and the filters are.'
  },
  {
    key: 'integrationServices.confirmStop', page: 'integrationServices', label: 'Ask before Stop Operation', type: 'boolean', default: true, varia: true,
    keywords: ['ssis', 'stop', 'operation', 'confirm', 'cancel', 'package'],
    description: 'Asks before Stop Operation ends a running package or validation. The package stops after its current work; the catalog then lists it as Stopping, and Canceled once it has ended. While it is False, Stop Operation stops at once.'
  }
] as const satisfies readonly SettingDef[]
