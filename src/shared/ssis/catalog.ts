// The SSIS Catalog (SSISDB): its code tables, the views ssis.describe reads, the kinds each view describes, error codes and
// limits. It is the only declaration of SSIS semantics: main's zod schemas, docs/integration-services.md and the backend
// read it, the backend embedding ssisCatalogJson() as Ssis/ssis-catalog.json (a vitest file snapshot keeps that copy in
// sync). The tree's SSIS kinds and folders are Object Explorer's (src/shared/explorer/catalog.ts). Erasable TypeScript (no
// enums), so Node's type stripping can load it too.
import type { FolderId, NodeKind } from '../explorer/catalog.ts'

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

/**
 * What the tree's live probe (`ssis.catalogProbe` in src/shared/live/catalog.ts) fingerprints: one catalog view each, sent
 * as two status values, `<id>Count` (its rows) and `<id>Checksum` (a checksum of the columns the tree and its documents
 * show), and what Object Explorer reloads when one changes: rows of these kinds, or these folders. References, parameters
 * and catalog properties show in no tree row; documents that show them read the same fingerprints.
 */
export interface CatalogFingerprint {
  readonly id: string
  readonly view: string
  readonly reloads: { readonly kinds?: readonly NodeKind[]; readonly folders?: readonly FolderId[] }
}
export const catalogFingerprints: readonly CatalogFingerprint[] = [
  { id: 'folders', view: 'catalog.folders', reloads: { kinds: ['ssisCatalog'] } },
  { id: 'projects', view: 'catalog.projects', reloads: { folders: ['ssisProjects'] } },
  { id: 'packages', view: 'catalog.packages', reloads: { folders: ['ssisPackages'] } },
  { id: 'environments', view: 'catalog.environments', reloads: { folders: ['ssisEnvironments'] } },
  // An environment's row shows its variable count.
  { id: 'variables', view: 'catalog.environment_variables', reloads: { folders: ['ssisEnvironments'] } },
  { id: 'references', view: 'catalog.environment_references', reloads: {} },
  { id: 'parameters', view: 'catalog.object_parameters', reloads: {} },
  { id: 'properties', view: 'catalog.catalog_properties', reloads: {} }
]
/** A tree view of the catalog that ended for now (no room for it on the server or in the window, the backend restarted it)
 *  opens again after `first` ms, doubling to `max` while it keeps ending before a sample. */
export const catalogProbeRetryMs = { first: 2_000, max: 60_000 } as const
/** The status values of `ssis.catalogProbe`, in order: each fingerprint's count, then its checksum. */
export const catalogFingerprintStatus: readonly string[] = catalogFingerprints.flatMap(fingerprint => [fingerprint.id + 'Count', fingerprint.id + 'Checksum'])

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
  profileLockTimeoutMs: 1_000
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
    `  "catalogDatabase": ${line(catalogDatabase)},`,
    `  "errors": ${block(ssisErrorCodes.map(code => ({ code, retryable: ssisErrorRetryable[code] })))},`,
    `  "features": ${line(ssisFeatures)},`,
    `  "limits": ${line(ssisLimits)},`,
    `  "loggingLevels": ${line(loggingLevels)},`,
    `  "messageTypes": ${line(messageTypes)},`,
    `  "operationStatuses": ${line(operationStatuses)},`,
    `  "operationTypes": ${line(operationTypes)},`,
    `  "parameterObjectTypes": ${line(parameterObjectTypes)},`,
    `  "version": 1,`,
    `  "views": ${block(describeViews.map(view => ({ view, kind: describeTargets[view] })))}`,
    '}',
    ''
  ].join('\n')
}
