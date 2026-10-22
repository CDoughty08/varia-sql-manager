import { liveProbes } from '../live/catalog'
import type { SettingDef } from './types'

/** The tree probe's interval bounds come from its live catalogue entry, so the setting can never ask for what it refuses. */
const tree = liveProbes['ssis.catalogProbe'].intervalMs

/**
 * SQL Server Integration Services: how Varia follows the SSIS Catalog. SSMS has no such page; its Object Explorer shows
 * catalog changes made elsewhere only after Refresh.
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
  }
] as const satisfies readonly SettingDef[]
