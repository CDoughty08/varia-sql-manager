import { z } from 'zod'

/** Provider IDs describe a dialect, not a transport. Only sqlserver is implemented initially. */
export const databaseProviderIdSchema = z.enum(['sqlserver', 'postgresql', 'bigquery'])
export type DatabaseProviderId = z.infer<typeof databaseProviderIdSchema>
export const languageLimits = { documentCharacters: 250_000, completionItems: 2_000, diagnostics: 1_000, diagnosticMessageCharacters: 4_096 } as const
const identifier = z.string().min(1).max(128)
export const languageContextSchema = z.object({
  providerId: databaseProviderIdSchema,
  connectionId: z.uuid().optional(),
  database: identifier.optional(),
  defaultSchema: identifier.optional(),
  project: z.string().min(1).max(1024).optional(),
  dataset: z.string().min(1).max(1024).optional()
}).strict()
export type LanguageContext = z.infer<typeof languageContextSchema>
/** LSP positions count UTF-16 code units, from zero, just as Monaco does from one. */
export const languagePositionSchema = z.object({ line: z.number().int().min(0).max(languageLimits.documentCharacters), character: z.number().int().min(0).max(languageLimits.documentCharacters) }).strict()
export const languageRangeSchema = z.object({ start: languagePositionSchema, end: languagePositionSchema }).strict()
export type LanguageRange = z.infer<typeof languageRangeSchema>
export const languageRequestSchema = z.object({
  documentId: z.uuid(), version: z.number().int().min(1).max(2 ** 31 - 1),
  text: z.string().max(languageLimits.documentCharacters), context: languageContextSchema, position: languagePositionSchema
}).strict()
export type LanguageRequest = z.infer<typeof languageRequestSchema>
export const languageRefreshRequestSchema = languageRequestSchema.omit({ position: true })
export type LanguageRefreshRequest = z.infer<typeof languageRefreshRequestSchema>
export const languageRefreshResultSchema = z.object({ refreshed: z.boolean() }).strict()
export type LanguageRefreshResult = z.infer<typeof languageRefreshResultSchema>
export const languageCloseSchema = z.object({ documentId: z.uuid() }).strict()
export const languageCompletionItemSchema = z.object({
  label: z.string().max(16_384), kind: z.number().int().min(1).max(25).optional(),
  detail: z.string().max(65_536).optional(), documentation: z.string().max(65_536).optional(),
  insertText: z.string().max(65_536).optional(), insertTextFormat: z.union([z.literal(1), z.literal(2)]).optional(),
  sortText: z.string().max(16_384).optional(), filterText: z.string().max(16_384).optional(),
  textEdit: z.object({ range: languageRangeSchema, newText: z.string().max(65_536) }).strict().optional()
}).strict()
export const languageCompletionsSchema = z.object({ items: z.array(languageCompletionItemSchema).max(languageLimits.completionItems), isIncomplete: z.boolean() }).strict()
export type LanguageCompletionItem = z.infer<typeof languageCompletionItemSchema>
export type LanguageCompletions = z.infer<typeof languageCompletionsSchema>
export const languageHoverSchema = z.object({ contents: z.string().max(65_536), range: languageRangeSchema.optional() }).strict().nullable()
export type LanguageHover = z.infer<typeof languageHoverSchema>
export const languageDiagnosticSchema = z.object({
  range: languageRangeSchema, message: z.string().max(languageLimits.diagnosticMessageCharacters),
  severity: z.number().int().min(1).max(4), code: z.string().max(128).optional(), source: z.string().max(128).optional()
}).strict()
export type LanguageDiagnostic = z.infer<typeof languageDiagnosticSchema>
export const languageDiagnosticResultSchema = z.object({
  version: z.number().int().min(1).max(2 ** 31 - 1), items: z.array(languageDiagnosticSchema).max(languageLimits.diagnostics), isIncomplete: z.boolean()
}).strict()
export type LanguageDiagnosticResult = z.infer<typeof languageDiagnosticResultSchema>
export const languageStatusSchema = z.object({ providers: z.array(z.object({
  id: databaseProviderIdSchema, configured: z.boolean(), completion: z.boolean(), hover: z.boolean(), refresh: z.boolean().optional(), diagnostics: z.boolean().optional(), reason: z.string().max(1024).optional()
}).strict()).max(16) }).strict()
export type LanguageStatus = z.infer<typeof languageStatusSchema>
