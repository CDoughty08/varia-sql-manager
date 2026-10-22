// Strict zod schemas for SSIS Catalog requests, and the shapes of their answers. Main validates every request with them
// before the backend re-checks it against its embedded catalogue (Ssis/ssis-catalog.json).
import { z } from 'zod'
import type { ObjectRef } from '../explorer/refs.ts'
import { objectRefSchema } from '../explorer/schema.ts'
import { describeTargets, describeViews, ssisLimits, type SsisDescribeView, type SsisErrorCode, type SsisFeature } from './catalog.ts'

export interface SsisDescribeRequest { readonly connectionId: string; readonly requestId: string; readonly view: SsisDescribeView; readonly target: ObjectRef }
export interface SsisCancelRequest { readonly requestIds: readonly string[] }

export const ssisDescribeSchema = z.object({ connectionId: z.uuid(), requestId: z.uuid(), view: z.enum(describeViews), target: objectRefSchema }).strict()
  .superRefine((request, context) => {
    if (request.target.kind !== describeTargets[request.view]) context.addIssue({ code: 'custom', path: ['target'], message: `The ${request.view} view describes a ${describeTargets[request.view]}.` })
  }) satisfies z.ZodType<SsisDescribeRequest>

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
  readonly roles: { readonly sysadmin: boolean; readonly ssisAdmin: boolean; readonly ssisLogreader: boolean }
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
