// language.parse (AG-6b): the step editor's Parse. The backend parses T-SQL with ScriptDom only; no connection, nothing runs.
import { z } from 'zod'
import { agentLimits } from './catalog.ts'

/** The longest message one parse error carries; ScriptDom's are a sentence. */
export const parseMessageChars = 2_048

export const languageParseSchema = z.object({ text: z.string().max(agentLimits.parseChars) }).strict()
export type LanguageParseRequest = z.infer<typeof languageParseSchema>

export const languageParseErrorSchema = z.object({
  line: z.number().int().min(1).max(2 ** 31 - 1),
  column: z.number().int().min(1).max(2 ** 31 - 1),
  number: z.number().int().min(0).max(2 ** 31 - 1),
  message: z.string().max(parseMessageChars)
}).strict()
export type LanguageParseError = z.infer<typeof languageParseErrorSchema>

export const languageParseResultSchema = z.object({
  errors: z.array(languageParseErrorSchema).max(agentLimits.parseErrors),
  truncated: z.boolean()
}).strict()
export type LanguageParseResult = z.infer<typeof languageParseResultSchema>
