import { z } from 'zod'
import { backendConnectionHandleSchema, connectionAuthenticationSchema, connectionTargetOptionsSchema } from './connection-targets'

export { backendConnectionBindingChangeSchema, type BackendConnectionBindingChange } from './connection-binding-receipts.ts'

/** Main's revision is distinct from backend mutation ordering, so an unknown outcome can safely clear an obsolete ref. */
export const connectionBindingsChangedSchema = z.object({
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  warning: z.string().max(512).optional(),
  changes: z.array(z.object({
    targetId: z.uuid(), handle: backendConnectionHandleSchema, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    options: connectionTargetOptionsSchema, authentication: connectionAuthenticationSchema
  }).strict()).min(1).max(200)
}).strict().refine(value => value.changes.every(change => change.handle.generation === value.generation), 'Binding updates belong to one backend generation.')
export type ConnectionBindingsChanged = z.infer<typeof connectionBindingsChangedSchema>
