// The Integration Services Operations document (D-ssis 6.2): what opens it, the presets SSMS's Active Operations dialog and
// All Executions, All Validations and All Operations reports become, and its commands. The live source it shows, ssis.operations,
// is in src/shared/live/catalog.ts; its kinds, statuses, tiles and tones are in ./catalog.ts. Erasable TypeScript (no enums).
import { openStatuses, operationStatuses, operationTypes, stoppableOperationTypes, type OperationKind } from './catalog.ts'

/** The document's title (its crumbs name the server and SSISDB), and its tab's: "Operations - SQL01". */
export const operationsTitle = 'Operations'
export const operationsTabName = (server: string): string => `Operations - ${server}`

/** What opens the document, and the filters each opens it with (its window and limit come from the settings). */
export const operationsPresets = ['active', 'executions', 'validations', 'operations'] as const
export type OperationsPreset = typeof operationsPresets[number]
export interface OperationsPresetSpec {
  readonly title: string
  readonly command: 'ssis.activeOperations' | 'ssis.allExecutions' | 'ssis.allValidations' | 'ssis.allOperations'
  readonly kinds?: readonly OperationKind[]
  readonly statuses?: readonly number[]
  readonly mnemonic: string
}
export const operationsPresetSpecs: { readonly [P in OperationsPreset]: OperationsPresetSpec } = {
  // SSMS's Active Operations lists what has not ended: created, running, pending and stopping operations.
  active: { title: 'Active Operations', command: 'ssis.activeOperations', statuses: openStatuses, mnemonic: 'c' },
  executions: { title: 'All Executions', command: 'ssis.allExecutions', kinds: ['execution'], mnemonic: 'x' },
  validations: { title: 'All Validations', command: 'ssis.allValidations', kinds: ['validation'], mnemonic: 'd' },
  operations: { title: 'All Operations', command: 'ssis.allOperations', mnemonic: 'p' }
}

/** The Window filter's choices, in hours (D-ssis 6.2: 1 h, 24 h, 7 days, and longer up to the catalog's default retention of a
 *  year); a window from Tools › Options that is none of them is offered beside them. */
export const operationsWindows: readonly { readonly hours: number; readonly label: string }[] = [
  { hours: 1, label: 'Last hour' }, { hours: 24, label: 'Last 24 hours' }, { hours: 168, label: 'Last 7 days' }, { hours: 720, label: 'Last 30 days' }, { hours: 8760, label: 'Last 365 days' }
]
/** A window's words: one of the choices', else "Last 36 hours". */
export const windowLabel = (hours: number): string => operationsWindows.find(choice => choice.hours === hours)?.label ?? `Last ${hours} hours`

/** The status filter's chips, in the tiles' order: the open statuses first (Running, Pending, then Created and Stopping), then the
 *  final ones (Failed and Ended unexpectedly, Succeeded and Completed, Canceled). */
export const operationStatusOrder: readonly number[] = [2, 5, 1, 8, 4, 6, 7, 9, 3]

/** The statuses whose label a row shows, by label: the grid holds display text, so the document reads codes back from it. */
export const operationStatusByLabel: ReadonlyMap<string, number> = new Map(operationStatuses.map(status => [status.label, status.code]))
export const operationTypeByLabel: ReadonlyMap<string, number> = new Map(operationTypes.map(type => [type.label, type.code]))
/**
 * Whether Stop Operation applies to an operation: an execution or validation that is running or pending. The backend checks
 * again (a created one that never started answers NOT_STARTED, a stopping or ended one ALREADY_FINAL), so this only decides
 * whether the verb is offered.
 */
export const operationStoppable = (type: number | undefined, status: number | undefined): boolean =>
  type !== undefined && status !== undefined && (stoppableOperationTypes as readonly number[]).includes(type) && (status === 2 || status === 5)

export type OperationsCommandId = OperationsPresetSpec['command'] | 'ssis.stopOperation' | 'ssis.refreshOperations' | 'ssis.pauseOperations' | 'ssis.copyOperations' | 'ssis.copyOperationsWithHeaders'
/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface OperationsCommandEntry {
  readonly title: string
  readonly category: 'Integration Services'
  readonly icon: 'pulse' | 'debug-stop' | 'refresh' | 'debug-pause' | 'copy'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly toggled?: string
  readonly unavailableHint: string
  readonly keybindings?: readonly { readonly key: string; readonly when: string }[]
  readonly menus?: readonly { readonly menu: 'explorer.context' | 'view' | 'ssis.operation.context'; readonly group: string; readonly order: number; readonly title?: string; readonly mnemonic?: string; readonly when?: string }[]
}
const openOperations = 'Open Integration Services Operations first.'
/**
 * The document's commands: one per preset on the SSISDB node's menu (as SSMS places Active Operations and its reports), View ›
 * Integration Services Operations, and the document's Stop Operation, Refresh (F5 in the document, as in Object Explorer),
 * Pause and Copy.
 */
export function operationsCommandEntries(): { readonly [K in OperationsCommandId]: OperationsCommandEntry } {
  const presets = Object.fromEntries(operationsPresets.map((preset, index) => {
    const spec = operationsPresetSpecs[preset]
    const entry: OperationsCommandEntry = {
      title: spec.title, category: 'Integration Services', icon: 'pulse', keywords: ['ssis', 'ssisdb', 'catalog', 'operations', 'executions', 'monitor', 'live'],
      precondition: 'backendReady && hasConnection', unavailableHint: 'Connect to a server with an SSIS Catalog first.',
      menus: [
        { menu: 'explorer.context', group: '1_operations', order: index + 1, mnemonic: spec.mnemonic, when: "explorerNode == 'ssisCatalog' && !explorerServerLost" },
        // View's live monitors share a group: Activity Monitor, then Integration Services Operations.
        ...preset === 'operations' ? [{ menu: 'view' as const, group: '2_monitor', order: 2, title: 'Integration Services Operations', mnemonic: 'n' }] : []
      ]
    }
    return [spec.command, entry]
  })) as { readonly [K in OperationsPresetSpec['command']]: OperationsCommandEntry }
  return {
    ...presets,
    'ssis.stopOperation': {
      title: 'Stop Operation', category: 'Integration Services', icon: 'debug-stop', keywords: ['ssis', 'stop', 'cancel', 'execution', 'package', 'validation'],
      precondition: 'backendReady && ssisOperationStoppable', unavailableHint: 'Select a running execution or validation in Integration Services Operations.',
      menus: [{ menu: 'ssis.operation.context', group: '1_operation', order: 1, mnemonic: 's' }]
    },
    // The document's own F5, as Refresh is in Object Explorer; a query's F5 (editorFocus, or its query bar's) still executes,
    // and an Activity Monitor's F5 (activityMonitorFocus) is its Refresh Now. The conflict check reads each state key on its
    // own, so the clause also says what holds anyway: an Operations document is never an SSIS properties document.
    'ssis.refreshOperations': {
      title: 'Refresh Operations', category: 'Integration Services', icon: 'refresh', keywords: ['ssis', 'reload', 'update', 'now'], precondition: 'backendReady && activeDocumentIsSsisOperations && ssisOperationsRefreshable',
      unavailableHint: openOperations,
      keybindings: [{ key: 'f5', when: "activeDocumentIsSsisOperations && !activeDocumentIsSsis && activePanel != 'explorer' && !editorFocus && !queryBarFocus && !activityMonitorFocus" }],
      menus: [{ menu: 'ssis.operation.context', group: '8_view', order: 1, title: 'Refresh', mnemonic: 'r' }]
    },
    'ssis.pauseOperations': {
      title: 'Pause Operations', category: 'Integration Services', icon: 'debug-pause', keywords: ['ssis', 'pause', 'resume', 'freeze', 'live'], precondition: 'activeDocumentIsSsisOperations && ssisOperationsPausable',
      toggled: 'ssisOperationsPaused', unavailableHint: openOperations, menus: [{ menu: 'ssis.operation.context', group: '8_view', order: 2, title: 'Pause', mnemonic: 'p' }]
    },
    'ssis.copyOperations': {
      title: 'Copy Operations', category: 'Integration Services', icon: 'copy', keywords: ['ssis', 'copy', 'clipboard', 'rows'], precondition: 'activeDocumentIsSsisOperations',
      unavailableHint: openOperations, menus: [{ menu: 'ssis.operation.context', group: '5_copy', order: 1, title: 'Copy', mnemonic: 'c' }]
    },
    'ssis.copyOperationsWithHeaders': {
      title: 'Copy Operations with Headers', category: 'Integration Services', icon: 'copy', keywords: ['ssis', 'copy', 'clipboard', 'columns'], precondition: 'activeDocumentIsSsisOperations',
      unavailableHint: openOperations, menus: [{ menu: 'ssis.operation.context', group: '5_copy', order: 2, title: 'Copy with Headers', mnemonic: 'h' }]
    }
  }
}
