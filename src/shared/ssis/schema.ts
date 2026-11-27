// Strict zod schemas for SSIS Catalog requests, and the shapes of their answers. Main validates every request with them
// before the backend re-checks it against its embedded catalogue (Ssis/ssis-catalog.json).
import { z } from 'zod'
import type { ObjectRef } from '../explorer/refs.ts'
import { objectRefSchema } from '../explorer/schema.ts'
import {
  describeTargets, describeViews, messageTypes, operationKinds, operationStatuses, ssisActions, ssisLimits, type OperationKind, type SsisActionVerb, type SsisDescribeView, type SsisErrorCode, type SsisFeature
} from './catalog.ts'
import type { ActionStep } from '../actions/schema.ts'

export interface SsisDescribeRequest { readonly connectionId: string; readonly requestId: string; readonly view: SsisDescribeView; readonly target: ObjectRef }
export interface SsisCancelRequest { readonly requestIds: readonly string[] }

export const ssisDescribeSchema = z.object({ connectionId: z.uuid(), requestId: z.uuid(), view: z.enum(describeViews), target: objectRefSchema }).strict()
  .superRefine((request, context) => {
    if (request.target.kind !== describeTargets[request.view]) context.addIssue({ code: 'custom', path: ['target'], message: `The ${request.view} view describes a ${describeTargets[request.view]}.` })
  }) satisfies z.ZodType<SsisDescribeRequest>

/** Stop Operation: the operation's id (`catalog.operations.operation_id`, a bigint; ids past 2^53 - 1 cannot cross JSON exactly). */
export interface SsisStopOperation { readonly verb: 'stopOperation'; readonly operationId: number }
/** Create Catalog: the master key's encryption password (a secret: the request is sensitive, and nothing stores or logs it),
 *  whether the user agreed to enable CLR integration (needed only when it is off), and whether `sp_ssis_startup` runs at
 *  SQL Server startup (SSMS's "Enable automatic execution of Integration Services stored procedure at SQL Server startup"). */
export interface SsisCreateCatalog { readonly verb: 'createCatalog'; readonly password: string; readonly enableClr: boolean; readonly startupProcedure: boolean }
/** What ssis.execute runs, by verb (src/shared/ssis/catalog.ts `ssisActions`); later verbs join the union. */
export type SsisAction = SsisStopOperation | SsisCreateCatalog
/** `revision` is a describe's, for a verb that changes what a document showed (`ssisActions[verb].revision`); others refuse it. */
export interface SsisExecuteRequest { readonly connectionId: string; readonly requestId: string; readonly action: SsisAction; readonly revision?: string }

const operationId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
/** Whether text is well-formed UTF-16 (every surrogate in a pair). The wire encodes UTF-8, which turns a lone surrogate into
 *  U+FFFD, so a password holding one would create a master key whose password is not the one typed. */
export const wellFormed = (value: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
// UTF-16 code units, as C# counts them (zod's max() counts code points). A NUL would end the password early in some client
// libraries; SQL Server's own policy decides the rest.
const catalogPassword = z.string().min(1).refine(value => value.length <= ssisLimits.catalogPassword, `At most ${ssisLimits.catalogPassword} UTF-16 code units.`).refine(value => !value.includes('\0'), 'The password cannot contain a NUL character.')
  .refine(wellFormed, 'The password holds a broken character (half of a surrogate pair).')
export const ssisActionSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('stopOperation'), operationId }).strict(),
  z.object({ verb: z.literal('createCatalog'), password: catalogPassword, enableClr: z.boolean(), startupProcedure: z.boolean() }).strict()
]) satisfies z.ZodType<SsisAction>
export const ssisExecuteSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), action: ssisActionSchema, revision: z.string().length(ssisLimits.revision).regex(/^[0-9a-f]+$/).optional()
}).strict().superRefine((request, context) => {
  const verb: SsisActionVerb = request.action.verb
  if (request.revision !== undefined && !ssisActions[verb].revision) context.addIssue({ code: 'custom', path: ['revision'], message: `${ssisActions[verb].title} takes no revision.` })
}) satisfies z.ZodType<SsisExecuteRequest>

/** What the Create Catalog dialog reads before it opens (`ssis.catalogSetup`). */
export interface SsisCatalogSetupRequest { readonly connectionId: string; readonly requestId: string }
export const ssisCatalogSetupSchema = z.object({ connectionId: z.uuid(), requestId: z.uuid() }).strict() satisfies z.ZodType<SsisCatalogSetupRequest>

/**
 * The ssis.operations live source's args (src/shared/live/catalog.ts): the Operations view's filters. Kinds and statuses keep
 * the operations of any of theirs; folder, project and package match an execution's names exactly, or from their start with
 * `prefix`; caller matches the caller's name exactly; windowHours keeps the operations created in the last hours (24 by
 * default) and limit the newest of them (1,000 by default). An absent member does not filter.
 */
export interface SsisOperationsArgs {
  readonly kinds?: OperationKind[]
  readonly statuses?: number[]
  readonly folder?: string
  readonly project?: string
  readonly package?: string
  readonly prefix?: boolean
  readonly caller?: string
  readonly windowHours?: number
  readonly limit?: number
}
const distinct = (items: readonly unknown[]) => new Set(items).size === items.length
export const ssisOperationsArgsSchema = z.object({
  kinds: z.array(z.enum(operationKinds)).min(1).max(operationKinds.length).refine(distinct, 'Each kind may be named once.').optional(),
  statuses: z.array(z.number().int().refine(code => operationStatuses.some(status => status.code === code), 'Unknown operation status.')).min(1).max(operationStatuses.length)
    .refine(distinct, 'Each status may be named once.').optional(),
  folder: z.string().min(1).max(ssisLimits.name).optional(),
  project: z.string().min(1).max(ssisLimits.name).optional(),
  package: z.string().min(1).max(ssisLimits.packageName).optional(),
  prefix: z.boolean().optional(),
  caller: z.string().min(1).max(ssisLimits.name).optional(),
  windowHours: z.number().int().min(1).max(ssisLimits.operationsWindowHours).optional(),
  limit: z.number().int().min(1).max(ssisLimits.operationsRows).optional()
}).strict() satisfies z.ZodType<SsisOperationsArgs>

/**
 * One execution's run page (ssis.execution): `executionId` is `catalog.executions.execution_id`; `types` keeps the messages of those
 * message types (every type when absent; -1, Unknown, also keeps the types the catalogue does not name), and `source` the messages
 * one task logged (`message_source_name`, the task timeline's filter). The counts always cover every message of the execution.
 */
export interface SsisExecutionRequest {
  readonly connectionId: string
  readonly requestId: string
  readonly executionId: number
  readonly types?: readonly number[]
  readonly source?: string
}
const messageTypeCodes = messageTypes.map(type => type.code) as [number, ...number[]]
export const ssisExecutionSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), executionId: operationId,
  types: z.array(z.number().int().refine(code => messageTypeCodes.includes(code), 'Unknown message type.')).min(1).max(messageTypeCodes.length)
    .refine(distinct, 'Each type may be named once.').optional(),
  source: z.string().min(1).max(ssisLimits.executionMessageChars).optional()
}).strict() satisfies z.ZodType<SsisExecutionRequest>

/** One package's runs, newest first (ssis.packageRuns: the Integration Services document's package step). */
export interface SsisPackageRunsRequest { readonly connectionId: string; readonly requestId: string; readonly folder: string; readonly project: string; readonly package: string }
export const ssisPackageRunsSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(),
  folder: z.string().min(1).max(ssisLimits.name), project: z.string().min(1).max(ssisLimits.name), package: z.string().min(1).max(ssisLimits.packageName)
}).strict() satisfies z.ZodType<SsisPackageRunsRequest>

export const ssisCancelSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(ssisLimits.cancelIds).refine(ids => new Set(ids).size === ids.length, 'Duplicate request id.')
}).strict() satisfies z.ZodType<SsisCancelRequest>

export interface SsisError { readonly code: SsisErrorCode; readonly message: string; readonly retryable: boolean }

/** How a connection reaches the catalog (D-ssis 4.1). `auth` is how it signed in: SQL Server authentication, Windows
 *  (Kerberos off Windows), or Microsoft Entra ID; on SQL Server, SSISDB starts nothing for SQL Server logins (error 27123). */
export interface SsisProfileView {
  readonly band: number
  readonly cloud: boolean
  readonly hostPlatform: 'Windows' | 'Linux'
  readonly auth: 'sql' | 'integrated' | 'entra'
  /** SSISDB reads committed rows only when READ_COMMITTED_SNAPSHOT is on; otherwise reads run READ UNCOMMITTED. */
  readonly rcsi: boolean
  readonly features: { readonly [F in SsisFeature]: boolean }
  /** `ssisAdmin` and `ssisLogreader` are read only for logins that are not sysadmin (a sysadmin's IS_MEMBER is not evaluated, so
   *  both are false for one): gate on `admin` (sysadmin or ssis_admin) for what ssis_admin may do. */
  readonly roles: { readonly sysadmin: boolean; readonly admin: boolean; readonly ssisAdmin: boolean; readonly ssisLogreader: boolean }
}
/** Times are datetimeoffset in ISO 8601 with their offset, as the catalog stores them (never converted to datetime). */
export interface SsisCatalogModel {
  readonly view: 'catalog'
  readonly name: string
  readonly profile: SsisProfileView
  /** The folders this login may read. */
  readonly folders: number
  /** catalog_properties, read only for ssis_admin and sysadmin (others: absent). */
  readonly properties?: readonly { readonly name: string; readonly value: string }[]
  readonly truncated: boolean
}
export interface SsisFolderModel {
  readonly view: 'folder'
  readonly id: number
  readonly name: string
  readonly description?: string
  readonly createdBy: string
  readonly created: string
  readonly projects: number
  readonly environments: number
}
/** A project's or package's parameter. Values are text; a sensitive one never has a value here. */
export interface SsisParameter {
  readonly name: string
  readonly dataType: string
  readonly required: boolean
  readonly sensitive: boolean
  readonly description?: string
  readonly designDefault?: string
  readonly value?: string
  /** 'V' a literal, 'R' an environment variable named by `variable`. */
  readonly valueType: 'V' | 'R'
  readonly valueSet: boolean
  readonly variable?: string
}
export interface SsisProjectModel {
  readonly view: 'project'
  readonly id: number
  readonly folder: string
  readonly name: string
  readonly description?: string
  readonly formatVersion?: number
  readonly deployedBy: string
  readonly deployed: string
  readonly created: string
  readonly versionLsn: number
  readonly validationStatus: string
  readonly validated?: string
  readonly packages: readonly { readonly name: string; readonly entryPoint: boolean; readonly description?: string; readonly version: string }[]
  readonly parameters: readonly SsisParameter[]
  readonly references: readonly { readonly id: number; readonly type: 'R' | 'A'; readonly folder?: string; readonly environment: string; readonly validationStatus: string }[]
  readonly truncated: boolean
}
export interface SsisPackageModel {
  readonly view: 'package'
  readonly id: number
  readonly folder: string
  readonly project: string
  readonly name: string
  readonly description?: string
  readonly formatVersion: number
  readonly version: string
  readonly versionComments?: string
  readonly entryPoint: boolean
  readonly validationStatus: string
  readonly validated?: string
  readonly parameters: readonly SsisParameter[]
  readonly truncated: boolean
}
export interface SsisEnvironmentModel {
  readonly view: 'environment'
  readonly id: number
  readonly folder: string
  readonly name: string
  readonly description?: string
  readonly createdBy: string
  readonly created: string
  /** A sensitive variable's value is never read (the catalog returns NULL for it too). */
  readonly variables: readonly { readonly name: string; readonly type: string; readonly description?: string; readonly sensitive: boolean; readonly value?: string }[]
  readonly truncated: boolean
}
export type SsisModel = SsisCatalogModel | SsisFolderModel | SsisProjectModel | SsisPackageModel | SsisEnvironmentModel
/** One describe: the model and its `revision` (a hash of what a later write depends on), or `error`. */
export interface SsisDescribeResult {
  readonly model?: SsisModel
  readonly revision?: string
  readonly elapsedMs: number
  readonly error?: SsisError
}
/** One execution (`catalog.executions`), as the execution messages view's header and General show it. Times keep their offset;
 *  `now` is the server's clock when it was read, so a running execution's duration needs no local clock. */
export interface SsisExecutionOverview {
  readonly id: number
  readonly folder: string
  readonly project: string
  readonly package: string
  readonly environmentFolder?: string
  readonly environment?: string
  readonly executedAs: string
  readonly caller: string
  readonly use32bit: boolean
  /** catalog.operations.status's codes (operationStatuses). */
  readonly status: number
  readonly created?: string
  readonly started?: string
  readonly ended?: string
  readonly stoppedBy?: string
  readonly server?: string
  readonly machine?: string
  readonly now: string
}
/** One message (`catalog.event_messages`); the event columns are absent for an operation-only message, and `message` is at most
 *  ssisLimits.executionMessageChars characters, the last an ellipsis when it was cut. */
export interface SsisExecutionMessage {
  readonly id?: number
  readonly time: string
  /** catalog.operation_messages.message_type (messageTypes). */
  readonly type: number
  readonly sourceType?: number
  readonly source?: string
  readonly package?: string
  readonly event?: string
  readonly path?: string
  readonly code?: number
  readonly message: string
}
/** One executable of the run (`catalog.executables`, with its `catalog.executable_statistics` rows summed): the task timeline. A task
 *  the run never reached has no times. `usualMs` is the median duration in the package's earlier succeeded runs (the run strip's). */
export interface SsisExecutionTask {
  /** `package_path`, such as `\Package\Load facts`; its depth places the task under its container. */
  readonly path: string
  readonly name: string
  readonly started?: string
  readonly ended?: string
  /** The executable's statistics rows summed: a task in a loop runs more than once. */
  readonly durationMs?: number
  readonly runs: number
  /** One of its runs failed (`execution_result` 1). */
  readonly failed: boolean
  readonly usualMs?: number
}
/** One parameter value the run used (`catalog.execution_parameter_values`); a sensitive parameter's value is never read. */
export interface SsisExecutionParameter {
  /** 20 project, 30 package, 50 execution (system) parameters (parameterObjectTypes). */
  readonly objectType: number
  readonly name: string
  readonly dataType: string
  readonly value?: string
  readonly sensitive: boolean
  readonly required: boolean
  readonly valueSet: boolean
  readonly runtimeOverride: boolean
}
/** One run of a package: the run strip's bar, or the package step's row. */
export interface SsisPackageRun {
  readonly id: number
  readonly status: number
  readonly created?: string
  readonly started?: string
  readonly ended?: string
  readonly caller?: string
  readonly errors?: number
  readonly warnings?: number
}
export interface SsisExecutionModel {
  readonly overview: SsisExecutionOverview
  /** Every message of the execution by type, whatever `types` kept. */
  readonly counts: readonly { readonly type: number; readonly count: number }[]
  /** The types the messages were read for (absent: every type). */
  readonly types?: readonly number[]
  /** The task the messages were read for (absent: every source). */
  readonly source?: string
  /** The newest messages of those types, newest first. */
  readonly messages: readonly SsisExecutionMessage[]
  /** More messages of those types than one read holds (ssisLimits.executionMessages, or the answer's size): the oldest are left out. */
  readonly truncated: boolean
  /** The executables in the order they started (those that never ran last, by path). */
  readonly tasks: readonly SsisExecutionTask[]
  readonly tasksTruncated: boolean
  readonly parameters: readonly SsisExecutionParameter[]
  /** This run and the package's runs before it, newest first (ssisLimits.executionRuns). */
  readonly runs: readonly SsisPackageRun[]
  /** The package's next run after this one, for Newer run. */
  readonly newer?: number
  /** The execution's earliest error message across all messages, regardless of message filters or truncation. */
  readonly firstError?: SsisExecutionMessage
}
export interface SsisPackageRunsModel {
  readonly folder: string
  readonly project: string
  readonly package: string
  /** Newest first, with each run's error and warning counts. */
  readonly runs: readonly SsisPackageRun[]
  readonly truncated: boolean
  readonly now: string
}
/** `model` (no runs is an empty list: the catalog keeps none, or this login may read none), or `error`: the catalog's failures. */
export interface SsisPackageRunsResult {
  readonly model?: SsisPackageRunsModel
  readonly elapsedMs: number
  readonly error?: SsisError
}
/** `model`, or `error`: NOT_FOUND for an execution the catalog no longer has (its retention cleanup removed it) or this login may
 *  not read, CATALOG_MISSING without SSISDB, PERMISSION_DENIED or NO_DB_ACCESS without access. */
export interface SsisExecutionResult {
  readonly model?: SsisExecutionModel
  readonly elapsedMs: number
  readonly error?: SsisError
}
/** What Create Catalog will do on this server, as its dialog shows it. */
export interface SsisCatalogSetup {
  /** The catalog's database: SSISDB (SSMS fixes the name). */
  readonly catalog: string
  /** `clr enabled` is in use. When it is not, the dialog asks before Create Catalog enables it. */
  readonly clrEnabled: boolean
  /** SSMS's default for the startup procedure: the server's `scan for startup procs` setting. */
  readonly startupDefault: boolean
  /** The Integration Services catalog backup Create Catalog restores, on the server. */
  readonly backupFile: string
  /** Where the catalog's files go: the master database's folder, as SSMS puts them. */
  readonly dataFile: string
  readonly logFile: string
}
/** `setup`, or `error` when Create Catalog cannot run here (`NOT_SUPPORTED`, `PERMISSION_DENIED` without sysadmin,
 *  `CATALOG_EXISTS`, or a read's failure). */
export interface SsisCatalogSetupResult {
  readonly setup?: SsisCatalogSetup
  readonly elapsedMs: number
  readonly error?: SsisError
}
/** One ssis.execute: the steps it ran in order (done, failed, cancelled or skipped; a refusal before any step has none), or
 *  `error`. ALREADY_FINAL and NOT_STARTED are information (Stop Operation found nothing running), not failures. */
export interface SsisExecuteResult {
  readonly steps: readonly ActionStep[]
  readonly elapsedMs: number
  readonly error?: SsisError
}
