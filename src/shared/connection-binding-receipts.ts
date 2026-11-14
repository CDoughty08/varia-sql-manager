import { z } from 'zod'

/** Backend proof of settings actually changed by one actions.execute, including confirmed steps before a later failure. */
export const backendConnectionBindingChangeSchema = z.object({
  connectionId: z.uuid(), bindingRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  newDatabase: z.string().max(128).optional(), passwordChanged: z.literal(true).optional()
}).strict().refine(value => value.newDatabase !== undefined || value.passwordChanged === true, 'A binding receipt must name its confirmed change.')
export type BackendConnectionBindingChange = z.infer<typeof backendConnectionBindingChangeSchema>
