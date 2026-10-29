// The SSIS Catalog (SSISDB): its code tables, the views ssis.describe reads, the kinds each view describes, error codes and
// limits. It is the only declaration of SSIS semantics: main's zod schemas, docs/integration-services.md and the backend
// read it, the backend embedding ssisCatalogJson() as Ssis/ssis-catalog.json (a vitest file snapshot keeps that copy in
// sync). The tree's SSIS kinds and folders are Object Explorer's (src/shared/explorer/catalog.ts). Erasable TypeScript (no
// enums), so Node's type stripping can load it too.
import type { NodeKind } from '../explorer/catalog.ts'
import type { IconId } from '../icons.ts'

/** SSMS fixes the catalog's name; only the backend's internal test option points it at a fake catalog. */
export const catalogDatabase = 'SSISDB'

export interface CodeLabel { readonly code: number; readonly label: string }

/** catalog.operations.operation_type, with SSMS's names for them. */
export const operationTypes: readonly CodeLabel[] = [
  { code: 1, label: 'Integration Services initialization' },
  { code: 2, label: 'Operation cleanup' },
  { code: 3, label: 'Project version cleanup' },
  { code: 101, label: 'Deploy project' },
  { code: 102, label: 'Export project' },
  { code: 106, label: 'Restore project' },
  { code: 200, label: 'Create and start execution' },
  { code: 202, label: 'Stop operation' },
  { code: 300, label: 'Validate project' },
  { code: 301, label: 'Validate package' },
  { code: 1000, label: 'Configure catalog' }
]
/** catalog.operations.status. */
export const operationStatuses: readonly CodeLabel[] = [
  { code: 1, label: 'Created' },
  { code: 2, label: 'Running' },
  { code: 3, label: 'Canceled' },
  { code: 4, label: 'Failed' },
  { code: 5, label: 'Pending' },
  { code: 6, label: 'Ended unexpectedly' },
  { code: 7, label: 'Succeeded' },
  { code: 8, label: 'Stopping' },
  { code: 9, label: 'Completed' }
]
/** Statuses an operation can still leave, and those it cannot. */
export const openStatuses = [1, 2, 5, 8] as const
export const finalStatuses = [3, 4, 6, 7, 9] as const

export type MessageTone = 'error' | 'warning' | 'info' | 'muted'
/** catalog.operation_messages.message_type, with the tone a log row takes. */
export const messageTypes: readonly (CodeLabel & { readonly tone: MessageTone })[] = [
  { code: -1, label: 'Unknown', tone: 'info' },
  { code: 10, label: 'Pre-validate', tone: 'info' },
  { code: 20, label: 'Post-validate', tone: 'info' },
  { code: 30, label: 'Pre-execute', tone: 'info' },
  { code: 40, label: 'Post-execute', tone: 'info' },
  { code: 50, label: 'Status change', tone: 'info' },
  { code: 60, label: 'Progress', tone: 'muted' },
  { code: 70, label: 'Information', tone: 'info' },
  { code: 80, label: 'Variable value changed', tone: 'info' },
  { code: 90, label: 'Diagnostic', tone: 'muted' },
  { code: 100, label: 'Query cancel', tone: 'info' },
  { code: 110, label: 'Warning', tone: 'warning' },
  { code: 120, label: 'Error', tone: 'error' },
  { code: 130, label: 'Task failed', tone: 'error' },
  { code: 140, label: 'Diagnostic (extended)', tone: 'info' },
  { code: 200, label: 'Custom', tone: 'info' },
  { code: 400, label: 'Non-diagnostic', tone: 'info' }
]
/** catalog.operation_messages.message_source_type. */
export const messageSourceTypes: readonly CodeLabel[] = [
  { code: 10, label: 'Entry APIs' },
  { code: 20, label: 'External process' },
  { code: 30, label: 'Package' },
  { code: 40, label: 'Control flow task' },
  { code: 50, label: 'Control flow container' },
  { code: 60, label: 'Data flow task' }
]
/** catalog.executable_statistics.execution_result. */
export const executableResults: readonly CodeLabel[] = [
  { code: 0, label: 'Success' },
  { code: 1, label: 'Failure' },
  { code: 2, label: 'Completion' },
  { code: 3, label: 'Cancelled' }
]
/** The LOGGING_LEVEL system parameter and the catalog's SERVER_LOGGING_LEVEL; `since` is the first band that has it. */
export const loggingLevels: readonly (CodeLabel & { readonly since?: number })[] = [
  { code: 0, label: 'None' },
  { code: 1, label: 'Basic' },
  { code: 2, label: 'Performance' },
  { code: 3, label: 'Verbose' },
  { code: 4, label: 'Runtime lineage', since: 13 },
  { code: 100, label: 'Custom', since: 13 }
]
/** catalog.object_parameters.object_type (and execution parameters' 50). */
export const parameterObjectTypes: readonly CodeLabel[] = [
  { code: 20, label: 'Project' },
  { code: 30, label: 'Package' },
  { code: 50, label: 'System' }
]
/** The system parameters an execution may set. CALLER_INFO is the catalog's own, and SYNCHRONIZED is absent by design: a
 *  synchronous execution would hold the request until the package ends, so no request can carry it. */
export const systemParameters = ['LOGGING_LEVEL', 'CUSTOMIZED_LOGGING_LEVEL', 'DUMP_ON_ERROR', 'DUMP_ON_EVENT', 'DUMP_EVENT_CODE'] as const
/** catalog.explicit_object_permissions.object_type: what a permission is granted on. */
export const securableTypes: readonly CodeLabel[] = [
  { code: 1, label: 'Folder' },
  { code: 2, label: 'Project' },
  { code: 3, label: 'Environment' },
  { code: 4, label: 'Operation' }
]
/** catalog.grant_permission's permission types, with the securable types each applies to (Learn). */
export const permissionTypes: readonly (CodeLabel & { readonly on: readonly number[] })[] = [
  { code: 1, label: 'READ', on: [1, 2, 3, 4] },
  { code: 2, label: 'MODIFY', on: [1, 2, 3, 4] },
  { code: 3, label: 'EXECUTE', on: [2] },
  { code: 4, label: 'MANAGE_PERMISSIONS', on: [1, 2, 3, 4] },
  { code: 100, label: 'CREATE_OBJECTS', on: [1] },
  { code: 101, label: 'READ_OBJECTS', on: [1] },
  { code: 102, label: 'MODIFY_OBJECTS', on: [1] },
  { code: 103, label: 'EXECUTE_OBJECTS', on: [1] },
  { code: 104, label: 'MANAGE_OBJECT_PERMISSIONS', on: [1] }
]
/** catalog.environment_references.reference_type: a reference to an environment in the project's own folder, or in a named one. */
export const referenceTypes = [{ code: 'R', label: 'Relative' }, { code: 'A', label: 'Absolute' }] as const
/** catalog.object_parameters.value_type: a literal value, or an environment variable's. */
export const valueTypes = [{ code: 'V', label: 'Literal' }, { code: 'R', label: 'Environment variable' }] as const

/** What the catalog lets a feature probe find (SsisProfile.Features): each is a catalog view, view column or module the
 *  backend looks up through sys.objects and sys.columns in SSISDB, never a metadata function. */
export const ssisFeatures = ['customizedLoggingLevels', 'scaleOut', 'eventMessageGuid', 'executedCount', 'operationLogSize', 'checkSchemaVersion'] as const
export type SsisFeature = typeof ssisFeatures[number]
export const ssisFeatureSources: { readonly [F in SsisFeature]: string } = {
  customizedLoggingLevels: 'catalog.customized_logging_levels',
  scaleOut: 'catalog.worker_agents',
  eventMessageGuid: 'catalog.event_messages.event_message_guid',
  executedCount: 'catalog.executions.executed_count',
  operationLogSize: 'catalog.get_operation_log_size',
  checkSchemaVersion: 'catalog.check_schema_version'
}

/** What ssis.describe reads, and the tree kind each view describes. Later views (run, configure, permissions, …) append. */
export const describeViews = [
  'catalog',
  'folder',
  'project',
  'package',
  'environment'
] as const
export type SsisDescribeView = typeof describeViews[number]
export const describeTargets: { readonly [V in SsisDescribeView]: NodeKind } = {
  catalog: 'ssisCatalog', folder: 'ssisFolder', project: 'ssisProject', package: 'ssisPackage', environment: 'ssisEnvironment'
}

/** `validation_status` of a project, package or reference: the catalog writes 'N' when it deploys one (the fake catalog's
 *  procedures do as the real ones). Other codes are shown as the catalog stores them until a real catalog records them. */
export const validationStatuses: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'N', label: 'Not validated' }
]

/**
 * The documents SSIS verbs open: one per tree kind they describe, a non-modal tab named as SSMS names the dialog
 * ("Folder Properties - Finance"), read with `view`. Each document kind is the node kind it shows.
 */
export const ssisDocumentKinds = ['ssisFolder', 'ssisProject', 'ssisPackage', 'ssisEnvironment'] as const
export type SsisDocumentKind = typeof ssisDocumentKinds[number]
export type SsisPropertiesView = Exclude<SsisDescribeView, 'catalog'>
export interface SsisDocumentSpec {
  readonly title: string
  readonly view: SsisPropertiesView
  /** The tab's icon: the tree kind's own. */
  readonly icon: IconId
  /** What the object is, as a sentence names it ("the folder"). */
  readonly noun: string
  /** Its sections, in order; the list beside them names them. */
  readonly sections: readonly { readonly id: string; readonly title: string }[]
}
const general = { id: 'general', title: 'General' }, parameterSection = { id: 'parameters', title: 'Parameters' }
export const ssisDocumentSpecs: { readonly [K in SsisDocumentKind]: SsisDocumentSpec } = {
  ssisFolder: { title: 'Folder Properties', view: 'folder', icon: 'folder-library', noun: 'folder', sections: [general] },
  ssisProject: {
    title: 'Project Properties', view: 'project', icon: 'project', noun: 'project',
    sections: [general, { id: 'packages', title: 'Packages' }, parameterSection, { id: 'references', title: 'References' }]
  },
  ssisPackage: { title: 'Package Properties', view: 'package', icon: 'package', noun: 'package', sections: [general, parameterSection] },
  ssisEnvironment: { title: 'Environment Properties', view: 'environment', icon: 'symbol-variable', noun: 'environment', sections: [general, { id: 'variables', title: 'Variables' }] }
}
export const isSsisDocumentKind = (kind: unknown): kind is SsisDocumentKind => typeof kind === 'string' && (ssisDocumentKinds as readonly string[]).includes(kind)
/** The tab's name, as SSMS titles the dialog: "Package Properties - Daily.dtsx". */
export const ssisDocumentName = (kind: SsisDocumentKind, name: string): string => `${ssisDocumentSpecs[kind].title} - ${name}`

/**
 * SSIS verbs (D-ssis 3.1): what Object Explorer's SSIS nodes offer, one command each. `document` verbs open a document,
 * `confirm` ones ask first and `inline` ones edit the tree row; `writes` marks those that change the catalog (none yet).
 * `defaultAction` is what Enter and a double-click on the node do, as in SSMS. Later verbs (Active Operations, Execute,
 * Configure, …) append, with their gates.
 */
export const ssisVerbs = [
  'folderProperties',
  'projectProperties',
  'packageProperties',
  'environmentProperties'
] as const
export type SsisVerb = typeof ssisVerbs[number]
export type SsisVerbClass = 'document' | 'confirm' | 'inline'
export type SsisCommandId = 'ssis.folderProperties' | 'ssis.projectProperties' | 'ssis.packageProperties' | 'ssis.environmentProperties' | 'ssis.refreshProperties'
export interface SsisVerbSpec {
  /** The palette's title; menus show `menuTitle`. */
  readonly title: string
  readonly menuTitle: string
  readonly mnemonic: string
  readonly group: string
  readonly order: number
  /** The tree kinds that offer it. */
  readonly kinds: readonly NodeKind[]
  readonly class: SsisVerbClass
  readonly document?: SsisDocumentKind
  readonly writes: boolean
  readonly defaultAction?: true
  readonly command: SsisCommandId
}
// The access key is Object Explorer's Properties (P), which these nodes do not offer.
const properties = (kind: SsisDocumentKind, extra: Partial<SsisVerbSpec> = {}): Omit<SsisVerbSpec, 'command'> => ({
  title: ssisDocumentSpecs[kind].title, menuTitle: 'Properties', mnemonic: 'p', group: '9_properties', order: 1, kinds: [kind], class: 'document', document: kind, writes: false, ...extra
})
export const ssisVerbSpecs: { readonly [V in SsisVerb]: SsisVerbSpec } = {
  folderProperties: { ...properties('ssisFolder'), command: 'ssis.folderProperties' },
  projectProperties: { ...properties('ssisProject'), command: 'ssis.projectProperties' },
  // SSMS opens a package's and an environment's properties on a double-click (U3 section 1).
  packageProperties: { ...properties('ssisPackage', { defaultAction: true }), command: 'ssis.packageProperties' },
  environmentProperties: { ...properties('ssisEnvironment', { defaultAction: true }), command: 'ssis.environmentProperties' }
}
/** '' = not offered; 'disabled' = shown greyed (for a later gate, such as Windows authentication); 'enabled'. */
export type SsisVerbState = '' | 'disabled' | 'enabled'
/** Each verb's state for a node kind. */
export function ssisVerbMenuState(kind: NodeKind | 'folder' | undefined): Readonly<Record<SsisVerb, SsisVerbState>> {
  return Object.fromEntries(ssisVerbs.map(verb => [verb, kind !== undefined && kind !== 'folder' && ssisVerbSpecs[verb].kinds.includes(kind) ? 'enabled' : ''])) as Record<SsisVerb, SsisVerbState>
}
/** The verb Enter and a double-click run on a node of this kind, if any. */
export function ssisDefaultVerb(kind: NodeKind | 'folder' | undefined): SsisVerb | undefined {
  return kind === undefined || kind === 'folder' ? undefined : ssisVerbs.find(verb => ssisVerbSpecs[verb].defaultAction && ssisVerbSpecs[verb].kinds.includes(kind))
}
const pascal = <S extends string>(text: S) => (text.charAt(0).toUpperCase() + text.slice(1)) as Capitalize<S>
export type SsisVerbContextKey = `ssisVerb${Capitalize<SsisVerb>}`
export const ssisVerbContextKey = (verb: SsisVerb): SsisVerbContextKey => `ssisVerb${pascal(verb)}`
export type SsisVerbContextValues = { readonly [K in SsisVerbContextKey]: SsisVerbState }
/** The state context keys a selection publishes: `ssisVerb<Verb>`. */
export const ssisVerbContextValues = (state: Readonly<Record<SsisVerb, SsisVerbState>>): SsisVerbContextValues =>
  Object.fromEntries(ssisVerbs.map(verb => [ssisVerbContextKey(verb), state[verb]])) as SsisVerbContextValues

/** A command catalogue entry, in the shape of `CommandDescriptor`. */
export interface SsisCommandEntry {
  readonly title: string
  readonly category: 'Integration Services'
  readonly icon: 'settings-gear' | 'refresh'
  readonly keywords: readonly string[]
  readonly precondition: string
  readonly unavailableHint: string
  readonly keybindings?: readonly { readonly key: string; readonly when: string }[]
  readonly menus?: readonly { readonly menu: 'explorer.context'; readonly group: string; readonly order: number; readonly title: string; readonly mnemonic: string; readonly when: string }[]
}
const nodeIs = (kinds: readonly NodeKind[]) => kinds.length === 1 ? `explorerNode == '${kinds[0]}'` : `(${kinds.map(kind => `explorerNode == '${kind}'`).join(' || ')})`
/** The SSIS commands: one per verb, and Refresh for the properties documents (F5 there, as in Object Explorer). */
export function ssisCommandEntries(): { readonly [K in SsisCommandId]: SsisCommandEntry } {
  const verbs = Object.fromEntries(ssisVerbs.map(verb => {
    const spec = ssisVerbSpecs[verb], key = ssisVerbContextKey(verb), noun = spec.document ? ssisDocumentSpecs[spec.document].noun : 'object'
    const entry: SsisCommandEntry = {
      title: spec.title, category: 'Integration Services', icon: 'settings-gear', keywords: ['ssis', 'properties', 'catalog', noun], precondition: `backendReady && ${key} == 'enabled'`,
      unavailableHint: `Select an SSIS Catalog ${noun} in Object Explorer.`,
      // The keys describe the selection, which a node's menu has just selected; naming the node's kind too keeps the item off
      // the empty area's menu, and says it never shows beside Object Explorer's own Properties (same access key).
      menus: [{ menu: 'explorer.context', group: spec.group, order: spec.order, title: spec.menuTitle, mnemonic: spec.mnemonic, when: `${nodeIs(spec.kinds)} && ${key} != ''` }]
    }
    return [spec.command, entry]
  }))
  // The document's own F5, as Refresh is in Object Explorer; a query's F5 (editorFocus) still executes.
  const refresh: SsisCommandEntry = {
    title: 'Refresh Properties', category: 'Integration Services', icon: 'refresh', keywords: ['ssis', 'reload', 'catalog'], precondition: 'backendReady && activeDocumentIsSsis',
    unavailableHint: 'Open the properties of an SSIS Catalog object first.', keybindings: [{ key: 'f5', when: "activeDocumentIsSsis && activePanel != 'explorer' && !editorFocus" }]
  }
  return { ...verbs, 'ssis.refreshProperties': refresh } as { readonly [K in SsisCommandId]: SsisCommandEntry }
}
/** What ssis.execute does (D-ssis 4.4), by verb: its title, the steps it runs in order (one statement each, reported back
 *  as done, failed, cancelled or skipped), the only catalog procedures its statements may call (SsisSql's write lint),
 *  whether it takes a describe's `revision` (a write that changes what a document showed compares it first), and whether
 *  SSISDB refuses it to a SQL Server login on a box server (S0, docs/integration-services.md 14.7: error 27123), which the
 *  backend answers WINDOWS_AUTH_REQUIRED before it connects. Later verbs (execute, validate, configure, …) append. */
export interface SsisActionSpec {
  readonly title: string
  readonly steps: readonly string[]
  readonly procedures: readonly string[]
  readonly revision: boolean
  readonly windowsAuthOnBox: boolean
}
export const ssisActions = {
  /** catalog.stop_operation: an execution or validation that runs stops after its current work (Stopping, then Canceled). */
  stopOperation: { title: 'Stop Operation', steps: ['Stop the operation'], procedures: ['stop_operation'], revision: false, windowsAuthOnBox: true }
} as const satisfies { readonly [verb: string]: SsisActionSpec }
export type SsisActionVerb = keyof typeof ssisActions
export const ssisActionVerbs = Object.keys(ssisActions) as SsisActionVerb[]
/** catalog.operations.operation_type values Stop Operation applies to: executions and validations. */
export const stoppableOperationTypes = [200, 300, 301] as const

/** SSIS failures as values (D-ssis 5.2), and whether retrying can help. */
export const ssisErrorRetryable = {
  CATALOG_MISSING: false,
  NO_DB_ACCESS: false,
  /** The catalog's database exists but is offline, restoring, recovering or single-user in use: it can come back. */
  DATABASE_UNAVAILABLE: true,
  BLOCKED: true,
  TIMEOUT: true,
  PERMISSION_DENIED: false,
  NOT_FOUND: false,
  NOT_SUPPORTED: false,
  CONNECTION_LOST: true,
  AUTH_KERBEROS: true,
  AUTH_UNSUPPORTED: false,
  AUTH_ENTRA: false,
  /** A box server's SSISDB changes nothing for a SQL Server login (27123): reconnect with Windows authentication. */
  WINDOWS_AUTH_REQUIRED: false,
  /** Stop Operation on an operation that has ended or is already stopping: nothing to do, shown as information. */
  ALREADY_FINAL: false,
  /** Stop Operation on an execution that was created and never started: it never runs, so there is nothing to stop. */
  NOT_STARTED: false,
  /** Stop Operation on an execution that is pending, not running yet: it can be stopped once it runs. */
  NOT_RUNNING: true,
  /** Varia's Stop ended a write's request before it changed anything, or at the step the reply names (for Stop Operation, the
   *  catalog may then list its own Stop operation as Running until SQL Server restarts). */
  CANCELLED: true,
  SQL_ERROR: true
} as const
export type SsisErrorCode = keyof typeof ssisErrorRetryable
export const ssisErrorCodes = Object.keys(ssisErrorRetryable) as SsisErrorCode[]

/** Bounds of the SSIS read path, in zod, C# and docs/integration-services.md. */
export const ssisLimits = {
  /** Folder, project and environment names, and parameter and variable names: sysname. */
  name: 128,
  /** catalog.packages.name is nvarchar(260). */
  packageName: 260,
  description: 1_024,
  /** A parameter, variable or catalog property value, as text. */
  value: 4_000,
  /** Rows one describe list holds (packages, parameters, references, variables, properties); more set `truncated`. */
  rows: 2_048,
  /** A describe answer's estimated size; rows past it set `truncated`, well inside the 16 MiB response limit. */
  describeBytes: 4_000_000,
  revision: 64,
  messageChars: 2_048,
  describeMs: 40_000,
  gateWaitMs: 30_000,
  readPerConnection: 2,
  readTotal: 4,
  registered: 256,
  cancelIds: 64,
  tombstones: 64,
  tombstoneMs: 60_000,
  /** The tree's and describe's lock timeout; the profile's role checks use the live reads' 1 s (owner decision 4). */
  readLockTimeoutMs: 5_000,
  profileLockTimeoutMs: 1_000,
  /** ssis.execute: writes at once per connection and in all, on the actions connection (" - Integration Services Actions"). */
  writePerConnection: 1,
  writeTotal: 2,
  registeredWrites: 64,
  /** A write's preflight reads at READ COMMITTED with this LOCK_TIMEOUT, within this budget (TIMEOUT). The write itself waits
   *  for locks as SSMS does (LOCK_TIMEOUT -1) until Stop. */
  preflightLockTimeoutMs: 10_000,
  preflightMs: 25_000,
  /** How long a stopped write's reply waits for SQL Server to end its statement, then answers CANCELLED (outcome unknown). */
  stopGraceMs: 10_000
} as const

// Compact sorted-key JSON, as in explorerCatalogJson(), so each entry diffs as one line.
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortKeys(item)]))
  : value
const line = (value: unknown) => JSON.stringify(sortKeys(value))
const block = (items: readonly unknown[]) => '[\n' + items.map(item => '    ' + line(item)).join(',\n') + '\n  ]'

/** The catalogue as the backend embeds it, keys sorted, so C# holds no SSIS codes, views or bounds of its own. */
export function ssisCatalogJson(): string {
  return [
    '{',
    `  "actions": ${block(ssisActionVerbs.map(verb => ({ verb, ...ssisActions[verb] })))},`,
    `  "catalogDatabase": ${line(catalogDatabase)},`,
    `  "errors": ${block(ssisErrorCodes.map(code => ({ code, retryable: ssisErrorRetryable[code] })))},`,
    `  "features": ${line(ssisFeatures)},`,
    `  "finalStatuses": ${line(finalStatuses)},`,
    `  "limits": ${line(ssisLimits)},`,
    `  "loggingLevels": ${line(loggingLevels)},`,
    `  "messageTypes": ${line(messageTypes)},`,
    `  "openStatuses": ${line(openStatuses)},`,
    `  "operationStatuses": ${line(operationStatuses)},`,
    `  "operationTypes": ${line(operationTypes)},`,
    `  "parameterObjectTypes": ${line(parameterObjectTypes)},`,
    `  "stoppableOperationTypes": ${line(stoppableOperationTypes)},`,
    `  "version": 1,`,
    `  "views": ${block(describeViews.map(view => ({ view, kind: describeTargets[view] })))}`,
    '}',
    ''
  ].join('\n')
}
