// Strict zod schemas for Object Explorer requests. Main validates every request with them before the backend re-checks
// it against the catalogue and the server's profile.
import { z } from 'zod'
import { maxIdentifierLength } from '../sql/identifiers.ts'
import {
  childParentKinds, dateFilterOps, explorerLimits, filterProperties, folderIds, folderOwnerKinds, folderSpecs, kindSpecs, nodeKinds, nodeSubtypes, parentKinds,
  queryIds, scopeFields, textFilterOps, type FilterProperty, type RefField
} from './catalog.ts'
import type { ExplorerCancelParams, ExplorerChildrenParams, ExplorerFilter, ExplorerNodeRef, ObjectRef } from './refs.ts'

// zod's max() counts code points, while sysname holds 128 UTF-16 code units.
const utf16 = (max: number) => z.string().min(1).refine(value => value.length <= max, `At most ${max} UTF-16 code units.`)
/** An identifier as the server stores it: 1–128 UTF-16 code units, used verbatim (`' '` is a legal name), never U+0000. */
export const ident = utf16(maxIdentifierLength).refine(value => !value.includes('\u0000'), 'A name cannot contain U+0000.')

const parentRefSchema = z.object({ kind: z.enum(parentKinds), schema: ident, name: ident }).strict()
/** Problems with a ref's shape: the fields its kind's scope requires or forbids, and a child's parent kind. */
export function objectRefProblems(ref: ObjectRef): string[] {
  if (!Object.hasOwn(kindSpecs, ref.kind)) return ['Unknown kind.']
  const { required, forbidden } = scopeFields[kindSpecs[ref.kind].scope]
  const has = (field: RefField) => ref[field] !== undefined
  const problems = [
    ...required.filter(field => !has(field)).map(field => `A ${ref.kind} needs a ${field}.`),
    ...forbidden.filter(has).map(field => `A ${ref.kind} has no ${field}.`)
  ]
  if (ref.parent && !childParentKinds(ref.kind).includes(ref.parent.kind)) problems.push(`A ${ref.kind} cannot belong to a ${ref.parent.kind}.`)
  return problems
}
export const objectRefSchema = z.object({ kind: z.enum(nodeKinds), database: ident.optional(), schema: ident.optional(), name: ident.optional(), parent: parentRefSchema.optional() })
  .strict().superRefine((ref, context) => { for (const message of objectRefProblems(ref)) context.addIssue({ code: 'custom', message }) }) satisfies z.ZodType<ObjectRef>
export const nodeRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('object'), object: objectRefSchema }).strict(),
  z.object({ type: z.literal('folder'), owner: objectRefSchema, folder: z.enum(folderIds) }).strict()
]).superRefine((ref, context) => {
  if (ref.type === 'folder' && !folderOwnerKinds(ref.folder).includes(ref.owner.kind)) context.addIssue({ code: 'custom', path: ['folder'], message: `A ${ref.owner.kind} has no ${ref.folder} folder.` })
}) satisfies z.ZodType<ExplorerNodeRef>

const textFilterSchema = z.object({ op: z.enum(textFilterOps), value: utf16(maxIdentifierLength) }).strict()
// SQL Server's datetime range, so every filter date converts on any server.
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00Z')
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value) && value >= '1753-01-01' && value <= '9999-12-31'
}, 'Enter a date from 1753-01-01 to 9999-12-31.')
const dateFilterSchema = z.object({ op: z.enum(dateFilterOps), value: date, value2: date.optional() }).strict().superRefine((filter, context) => {
  const range = filter.op === 'between' || filter.op === 'notBetween'
  if (range !== (filter.value2 !== undefined)) context.addIssue({ code: 'custom', path: ['value2'], message: range ? 'Enter the second date.' : 'Only a range has a second date.' })
  else if (filter.value2 !== undefined && filter.value2 < filter.value) context.addIssue({ code: 'custom', path: ['value2'], message: 'The second date cannot be before the first.' })
})
export const explorerFilterSchema = z.object({ name: textFilterSchema.optional(), schema: textFilterSchema.optional(), owner: textFilterSchema.optional(), created: dateFilterSchema.optional() })
  .strict().refine(filter => filterProperties.some(property => filter[property] !== undefined), 'A filter needs at least one property.') satisfies z.ZodType<ExplorerFilter>

const cursorPattern = new RegExp(`^v1\\.(${queryIds.join('|')})\\.[A-Za-z0-9_-]{1,1600}$`)
export const explorerChildrenParamsSchema = z.object({
  connectionId: z.uuid(), requestId: z.uuid(), node: nodeRefSchema, subtype: z.enum(nodeSubtypes).optional(),
  cursor: z.string().max(explorerLimits.cursorLength).regex(cursorPattern).optional(), pageSize: z.number().int().min(1).max(explorerLimits.pageSize).optional(),
  filter: explorerFilterSchema.optional()
}).strict().superRefine((params, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message })
  const { node } = params
  if (params.subtype !== undefined && (node.type !== 'object' || !kindSpecs[node.object.kind].subtypes?.includes(params.subtype))) issue('subtype', 'This node has no such subtype.')
  const folder = node.type === 'folder' ? folderSpecs[node.folder] : undefined
  if (params.cursor !== undefined && (!folder?.list || params.cursor.split('.')[1] !== folder.list)) issue('cursor', 'The cursor is not for this folder.')
  if (params.filter) {
    const allowed: readonly FilterProperty[] = folder?.filter ?? []
    for (const property of filterProperties) if (params.filter[property] !== undefined && !allowed.includes(property)) issue('filter', `This folder cannot be filtered by ${property}.`)
  }
}) satisfies z.ZodType<ExplorerChildrenParams>

export const explorerCancelParamsSchema = z.object({
  requestIds: z.array(z.uuid()).min(1).max(explorerLimits.cancelBatch).refine(ids => new Set(ids).size === ids.length, 'Duplicate request id.')
}).strict() satisfies z.ZodType<ExplorerCancelParams>
