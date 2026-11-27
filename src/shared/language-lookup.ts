import { z } from 'zod'
import { isBigQueryName } from './bigquery/names.ts'

/**
 * language.lookup (docs/object-search.md, Editor lookup): the editor's completion and hover read the Search Objects index by
 * path, whatever the engine. A path names a container level by level: none for the connection's top level, then one segment
 * per level below it (BigQuery: project, dataset, object). `prefix` keeps names that start with it, case ignored; `exact`
 * keeps the one name it resolves to; `details` adds columns' descriptions; `mode: 'jump'` searches across RAM-indexed
 * datasets (top 50 hits, ranked Default dataset → Billing → ★ Starred → Recent → Discovered).
 * The backend's EditorLookupLimits / JumpLookupLimits / LanguageHydrateLimits mirror these.
 */
export const languageLookupLimits = { requests: 16, segments: 3, segmentChars: 1024, prefixChars: 4608, items: 2000, defaultItems: 500, totalItems: 4000, totalBytes: 12 * 1024 * 1024 } as const
export const jumpLookupLimits = { minPrefixChars: 2, maxPrefixChars: 128, items: 50, maxScanObjects: 100_000 } as const
export const languageHydrateLimits = { targets: 8, maxNegativeEntries: 256, maxPerMinute: 30, maxConcurrent: 4 } as const

const segment = z.string().min(1).max(languageLookupLimits.segmentChars)
export const languageLookupModes = ['children', 'jump'] as const
export type LanguageLookupMode = typeof languageLookupModes[number]
export const languageLookupPathSchema = z.object({
  path: z.array(segment).max(languageLookupLimits.segments),
  prefix: z.string().max(languageLookupLimits.prefixChars).optional(),
  exact: z.boolean().optional(),
  limit: z.number().int().min(1).max(languageLookupLimits.items).optional(),
  details: z.boolean().optional(),
  mode: z.enum(languageLookupModes).optional(),
  dataset: segment.optional()
}).strict().superRefine((request, ctx) => {
  if (request.mode === 'jump') {
    if (request.path.length !== 0) ctx.addIssue({ code: 'custom', path: ['path'], message: 'jump needs an empty path' })
    if (request.exact) ctx.addIssue({ code: 'custom', path: ['exact'], message: 'jump does not support exact' })
    const trimmed = request.prefix?.trim() ?? ''
    if (trimmed.length < jumpLookupLimits.minPrefixChars || (request.prefix?.length ?? 0) > jumpLookupLimits.maxPrefixChars) {
      ctx.addIssue({ code: 'custom', path: ['prefix'], message: 'jump needs a prefix of 2 to 128 characters' })
    }
    if (request.limit !== undefined && request.limit > jumpLookupLimits.items) {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: 'jump limit exceeds maximum' })
    }
    return
  }
  if (request.dataset !== undefined) ctx.addIssue({ code: 'custom', path: ['dataset'], message: 'dataset is only allowed in jump mode' })
  if (request.exact && !request.prefix) ctx.addIssue({ code: 'custom', path: ['exact'], message: 'exact needs a prefix' })
})
export type LanguageLookupPath = z.infer<typeof languageLookupPathSchema>
export const languageLookupRequestSchema = z.object({
  connectionId: z.uuid(),
  requests: z.array(languageLookupPathSchema).min(1).max(languageLookupLimits.requests)
}).strict()
export type LanguageLookupRequest = z.infer<typeof languageLookupRequestSchema>

/** ready: read whole; partial: names without some details (columns left out, a dataset of a project read by name only, details
 *  that failed) or a project's list that may be short (a listing or a dataset's read failed);
 *  building: a build has not reached it yet; skipped: its last read failed; absent: the index holds no such container. */
export const languageLookupStates = ['ready', 'partial', 'building', 'skipped', 'absent'] as const
export type LanguageLookupState = typeof languageLookupStates[number]
export const languageLookupProjectTiers = ['billing', 'starred', 'discovered'] as const
export type LanguageLookupProjectTier = typeof languageLookupProjectTiers[number]
const shardsSchema = z.object({ prefix: z.string().max(1024), count: z.number().int().min(0), first: z.string().max(8), last: z.string().max(8) }).strict()
// A column by its field path: 15 names of up to 300 characters, joined by dots.
const name = z.string().min(1).max(languageLookupLimits.prefixChars)
export const languageLookupItemSchema = z.object({
  name, kind: z.string().min(1).max(64), subtype: z.string().max(64).optional(),
  type: z.string().max(4096).optional(), nullable: z.boolean().optional(),
  detail: z.string().max(4096).optional(), description: z.string().max(4096).optional(), shards: shardsSchema.optional(),
  tier: z.enum(languageLookupProjectTiers).optional(), namesOnly: z.boolean().optional(), partial: z.boolean().optional(),
  rows: z.number().int().min(0).optional(), bytes: z.number().int().min(0).optional(),
  partitioning: z.string().max(4096).optional(), clustering: z.string().max(4096).optional(),
  recent: z.boolean().optional(), indexing: z.boolean().optional(),
  project: segment.optional(), dataset: segment.optional()
}).strict()
export type LanguageLookupItem = z.infer<typeof languageLookupItemSchema>
export const languageLookupObjectSchema = z.object({
  name, kind: z.string().min(1).max(64), subtype: z.string().max(64).optional(), detailed: z.boolean(),
  rows: z.number().int().min(0).optional(), bytes: z.number().int().min(0).optional(),
  partitioning: z.string().max(4096).optional(), clustering: z.string().max(4096).optional(), signature: z.string().max(4096).optional(),
  shards: shardsSchema.optional(), columnsCut: z.boolean().optional(), modified: z.string().max(64).optional(),
  description: z.string().max(4096).optional()
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

/**
 * language.hydrate: free on-demand REST tables.get / routines.get hydration of referenced BigQuery objects into the in-memory
 * Search Objects index under the shared memory budget. Never runs billed queries.
 */
const hydrateProject = z.string().min(1).max(128).refine(value => isBigQueryName('project', value), { message: 'invalid project' })
const hydrateDataset = z.string().min(1).max(1024).refine(value => isBigQueryName('dataset', value), { message: 'invalid dataset' })
const hydrateObject = z.string().min(1).max(1024).refine(value => isBigQueryName('table', value) || isBigQueryName('routine', value), { message: 'invalid object name' })
export const languageHydrateKinds = ['table', 'routine'] as const
export type LanguageHydrateKind = typeof languageHydrateKinds[number]
export const languageHydrateTargetSchema = z.object({
  project: hydrateProject,
  dataset: hydrateDataset,
  name: hydrateObject,
  kind: z.enum(languageHydrateKinds).optional(),
  allowExternal: z.boolean().optional()
}).strict().superRefine((target, ctx) => {
  if (target.kind === 'routine' && !isBigQueryName('routine', target.name)) {
    ctx.addIssue({ code: 'custom', path: ['name'], message: 'invalid routine name' })
  } else if (target.kind === 'table' && !isBigQueryName('table', target.name)) {
    ctx.addIssue({ code: 'custom', path: ['name'], message: 'invalid table name' })
  }
})
export type LanguageHydrateTarget = z.infer<typeof languageHydrateTargetSchema>
export const languageHydrateRequestSchema = z.object({
  connectionId: z.uuid(),
  targets: z.array(languageHydrateTargetSchema).min(1).max(languageHydrateLimits.targets)
}).strict()
export type LanguageHydrateRequest = z.infer<typeof languageHydrateRequestSchema>

export const languageHydrateStatuses = ['hydrated', 'cached', 'notFound', 'forbidden', 'external', 'budget', 'throttled', 'error'] as const
export type LanguageHydrateStatus = typeof languageHydrateStatuses[number]
export const languageHydrateOutcomeSchema = z.object({
  project: z.string().min(1).max(128),
  dataset: z.string().min(1).max(1024),
  name: z.string().min(1).max(1024),
  status: z.enum(languageHydrateStatuses),
  code: z.string().min(1).max(64).optional()
}).strict()
export type LanguageHydrateOutcome = z.infer<typeof languageHydrateOutcomeSchema>
export const languageHydrateResultSchema = z.object({
  outcomes: z.array(languageHydrateOutcomeSchema).min(1).max(languageHydrateLimits.targets)
}).strict()
export type LanguageHydrateResult = z.infer<typeof languageHydrateResultSchema>
