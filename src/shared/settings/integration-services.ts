import { liveProbes } from '../live/catalog'
import { ssisLimits } from '../ssis/catalog'
import type { SettingDef } from './types'

/** The Operations view's interval bounds come from its live catalogue entry, so the setting can never ask for what it refuses. */
const operations = liveProbes['ssis.operations.list'].intervalMs

/**
 * SQL Server Integration Services: how Varia follows the SSIS Catalog. SSMS has no such page; its Active Operations dialog and
 * catalog reports show new operations only after Refresh.
 */
export const integrationServicesSettings = [
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
    description: 'The most operations an Operations document holds: the newest ones of its window that pass its filters. The tiles count every operation whatever this limit is.'
  },
  {
    key: 'integrationServices.confirmStop', page: 'integrationServices', label: 'Ask before Stop Operation', type: 'boolean', default: true, varia: true,
    keywords: ['ssis', 'stop', 'operation', 'confirm', 'cancel', 'package'],
    description: 'Asks before Stop Operation ends a running package or validation. The package stops after its current work; the catalog then lists it as Stopping, and Canceled once it has ended. While it is False, Stop Operation stops at once.'
  }
] as const satisfies readonly SettingDef[]
