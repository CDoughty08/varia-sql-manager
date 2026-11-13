import { z } from 'zod'
import type { ConnectionInfo, ConnectionOptions } from '../shared/contracts'
import { connectionAuthenticationSchema, type ConnectionAuthentication } from '../shared/connection-targets'

/** Server-verified SID or provider tenant/object pair. Display logins and token/session identifiers are not proof. */
export const connectionPrincipalIdSchema = z.string().max(256).regex(/^(?:sid:[\da-f]{2,170}|entra:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i)
  .refine(value => value.slice(0, 4).toLowerCase() !== 'sid:' || (value.length - 4) % 2 === 0, 'A SID must contain complete hex bytes.')

export function verifiedConnectionAuthentication(info: ConnectionInfo, authentication: ConnectionOptions['authentication']): ConnectionAuthentication | undefined {
  const id = connectionPrincipalIdSchema.safeParse(info.principalId)
  if (!id.success) return undefined
  const canonical = id.data.toLowerCase()
  if (authentication.startsWith('entra') ? !canonical.startsWith('entra:') : !canonical.startsWith('sid:')) return undefined
  return connectionAuthenticationSchema.parse({ principal: { provider: 'sqlServer', authentication, id: canonical } })
}
