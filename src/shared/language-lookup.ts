import { z } from 'zod'

/**
 * language.lookup (docs/object-search.md, Editor lookup): the editor's completion and hover read the Search Objects index by
 * path, whatever the engine. A path names a container level by level: none for the connection's top level, then one segment
 * per level below it (BigQuery: project, dataset, object). `prefix` keeps names that start with it, case ignored; `exact`
 * keeps the one name it resolves to; `details` adds columns' descriptions. The backend's EditorLookupLimits mirror these.
 */
export const languageLookupLimits = { requests: 16, segments: 3, segmentChars: 1024, prefixChars: 4608, items: 2000, defaultItems: 500, totalItems: 4000 } as const

const segment = z.string().min(1).max(languageLookupLimits.segmentChars)
export const languageLookupPathSchema = z.object({
  path: z.array(segment).max(languageLookupLimits.segments),
  prefix: z.string().max(languageLookupLimits.prefixChars).optional(),
  exact: z.boolean().optional(),
  limit: z.number().int().min(1).max(languageLookupLimits.items).optional(),
  details: z.boolean().optional()
}).strict().refine(request => !request.exact || !!request.prefix, { message: 'exact needs a prefix' })
export type LanguageLookupPath = z.infer<typeof languageLookupPathSchema>
export const languageLookupRequestSchema = z.object({
  connectionId: z.uuid(),
  requests: z.array(languageLookupPathSchema).min(1).max(languageLookupLimits.requests)
}).strict()
export type LanguageLookupRequest = z.infer<typeof languageLookupRequestSchema>

/** ready: read whole; partial: names without some details (columns left out, a project read by name only, details that failed);
 *  building: a build has not reached it yet; skipped: its last read failed; absent: the index holds no such container. */
export const languageLookupStates = ['ready', 'partial', 'building', 'skipped', 'absent'] as const
export type LanguageLookupState = typeof languageLookupStates[number]
const shardsSchema = z.object({ prefix: z.string().max(1024), count: z.number().int().min(0), first: z.string().max(8), last: z.string().max(8) }).strict()
// A column by its field path: 15 names of up to 300 characters, joined by dots.
const name = z.string().min(1).max(languageLookupLimits.prefixChars)
export const languageLookupItemSchema = z.object({
  name, kind: z.string().min(1).max(64), subtype: z.string().max(64).optional(),
  type: z.string().max(4096).optional(), nullable: z.boolean().optional(),
  detail: z.string().max(4096).optional(), description: z.string().max(4096).optional(), shards: shardsSchema.optional()
}).strict()
export type LanguageLookupItem = z.infer<typeof languageLookupItemSchema>
export const languageLookupObjectSchema = z.object({
  name, kind: z.string().min(1).max(64), subtype: z.string().max(64).optional(), detailed: z.boolean(),
  rows: z.number().int().min(0).optional(), bytes: z.number().int().min(0).optional(),
  partitioning: z.string().max(4096).optional(), clustering: z.string().max(4096).optional(), signature: z.string().max(4096).optional(),
  shards: shardsSchema.optional(), columnsCut: z.boolean().optional(), modified: z.string().max(64).optional()
}).strict()
export type LanguageLookupObject = z.infer<typeof languageLookupObjectSchema>
export const languageLookupAnswerSchema = z.object({
  state: z.enum(languageLookupStates), path: z.array(name).max(languageLookupLimits.segments),
  items: z.array(languageLookupItemSchema).max(languageLookupLimits.items), truncated: z.boolean(),
  object: languageLookupObjectSchema.optional(), skip: z.string().max(128).optional()
}).strict()
export type LanguageLookupAnswer = z.infer<typeof languageLookupAnswerSchema>
export const languageLookupResultSchema = z.object({
  index: z.enum(['none', 'building', 'ready']),
  answers: z.array(languageLookupAnswerSchema).max(languageLookupLimits.requests)
}).strict().refine(result => result.answers.reduce((sum, answer) => sum + answer.items.length, 0) <= languageLookupLimits.totalItems, { message: 'too many items' })
export type LanguageLookupResult = z.infer<typeof languageLookupResultSchema>
