// Restore Database's strict zod schemas: the describe's `restore` source and actions.script's restore request. Main
// validates both before the backend re-checks them (RestoreRequest.Validate in C#), and the document checks its draft
// with restoreOptionsProblems, so it refuses exactly what main and the backend refuse.
import { z } from 'zod'
import { ident } from '../explorer/schema.ts'
import type { ObjectRef } from '../explorer/refs.ts'
import { serverPathProblem } from './files.ts'
import {
  restoreLimits, restoreRecoveryStates, restoreSetIdPattern, restoreTargetProblem, restoreTimePattern, plannedSetTypes, type RestoreOptions, type RestoreSource
} from './restore.ts'

const path = z.string().superRefine((value, context) => { const problem = serverPathProblem(value); if (problem) context.addIssue({ code: 'custom', message: problem }) })
const devices = z.array(path).min(1).max(restoreLimits.backupDevices)
/** A backup_set_uuid as SQL Server writes it, lower-cased by the backend. */
const uuid = z.string().max(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const position = z.number().int().min(1).max(restoreLimits.position)

export const restoreSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('history'), database: ident.optional() }).strict(),
  z.object({ kind: z.literal('devices'), devices }).strict(),
  z.object({ kind: z.literal('historyFiles'), setId: uuid }).strict(),
  z.object({ kind: z.literal('mediaFiles'), devices, file: position }).strict()
]) satisfies z.ZodType<RestoreSource>

const setSchema = z.object({
  id: z.string().max(restoreLimits.setId).regex(restoreSetIdPattern), devices, file: position, type: z.enum(plannedSetTypes),
  name: z.string().max(restoreLimits.setName).refine(value => !value.includes('\u0000'), 'A name cannot contain U+0000.').optional()
}).strict()
const moveSchema = z.object({ logical: ident, physical: path }).strict()

/** Why restore options cannot be scripted (or run): the plan's shape, STOPAT, the moves and the recovery state's own rules. */
export function restoreOptionsProblems(options: RestoreOptions): { readonly path: string; readonly message: string }[] {
  const problems: { path: string; message: string }[] = []
  const { sets } = options
  if (sets.length > 0 && sets[0].type !== 'full') problems.push({ path: 'sets', message: 'A restore starts with a full backup.' })
  sets.forEach((set, index) => {
    if (index > 0 && set.type === 'full') problems.push({ path: 'sets', message: 'A restore has one full backup.' })
    if (set.type === 'differential' && index !== 1) problems.push({ path: 'sets', message: 'A differential backup restores right after its full backup.' })
  })
  if (new Set(sets.map(set => set.id)).size !== sets.length) problems.push({ path: 'sets', message: 'A backup set is listed twice.' })
  if (options.stopAt !== undefined && sets.at(-1)?.type !== 'log') problems.push({ path: 'stopAt', message: 'Only a log backup restores to a point in time.' })
  const logical = new Set(options.relocate.map(move => move.logical)), physical = new Set(options.relocate.map(move => move.physical.toLowerCase()))
  if (logical.size !== options.relocate.length) problems.push({ path: 'relocate', message: 'A file is moved twice.' })
  if (physical.size !== options.relocate.length) problems.push({ path: 'relocate', message: 'Two files would restore to one path.' })
  if ((options.recovery === 'standby') !== (options.standbyFile !== undefined)) problems.push({ path: 'standbyFile', message: 'RESTORE WITH STANDBY needs a standby file, and only it takes one.' })
  // KEEP_REPLICATION cannot leave a database restoring (Learn); SMO scripts it with STANDBY (probed).
  if (options.keepReplication && options.recovery === 'norecovery') problems.push({ path: 'keepReplication', message: 'Preserve the replication settings cannot be used with RESTORE WITH NORECOVERY.' })
  return problems
}

export const restoreOptionsSchema = z.object({
  sets: z.array(setSchema).min(1).max(restoreLimits.planSets),
  stopAt: z.string().max(19).regex(restoreTimePattern).optional(),
  relocate: z.array(moveSchema).max(restoreLimits.restoreMoves),
  replace: z.boolean(), keepReplication: z.boolean(), restrictedUser: z.boolean(),
  recovery: z.enum(restoreRecoveryStates), standbyFile: path.optional(),
  tailLog: z.object({ file: path, noRecovery: z.boolean() }).strict().optional(),
  closeConnections: z.boolean()
}).strict().superRefine((options, context) => {
  for (const problem of restoreOptionsProblems(options)) context.addIssue({ code: 'custom', path: [problem.path], message: problem.message })
}) satisfies z.ZodType<RestoreOptions>

/** Database Properties' identity form (schema.ts), repeated here so this module needs nothing of schema.ts. */
const identitySchema = z.object({ id: z.number().int().min(1).max(2_147_483_647), created: z.string().max(23).regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/) }).strict()

/** The destination is a database by name: a new one, or one of the server's (with its identity), never SQL Server's own (critic A19). */
const targetSchema = z.object({ kind: z.literal('database'), name: ident }).strict().superRefine((target, context) => {
  const problem = restoreTargetProblem(target.name)
  if (problem) context.addIssue({ code: 'custom', path: ['name'], message: problem })
})

export interface RestoreRequest {
  readonly action: 'restore'; readonly connectionId: string; readonly requestId: string
  readonly target: ObjectRef & { readonly kind: 'database'; readonly name: string }
  readonly identity?: { readonly id: number; readonly created: string }
  readonly restore: RestoreOptions
}
export const restoreRequestSchema = z.object({
  action: z.literal('restore'), connectionId: z.uuid(), requestId: z.uuid(), target: targetSchema, identity: identitySchema.optional(), restore: restoreOptionsSchema
}).strict() satisfies z.ZodType<RestoreRequest>
