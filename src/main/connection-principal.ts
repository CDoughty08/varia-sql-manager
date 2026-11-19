import { z } from 'zod'
import type { ConnectionInfo, ConnectionOptions } from '../shared/contracts'
import { connectionAuthenticationSchema, type ConnectionAuthentication, type SqlServerPrincipal } from '../shared/connection-targets'

const sqlServerPrincipalId = /^(?:sid:[\da-f]{2,170}|entra:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i
/** BigQuery's pin (BigQueryIdentity.Pin): the kind and the identity Google verified, one visible line, case kept. */
const bigQueryPrincipalId = /^bigquery:(?:serviceAccount|user|computeEngine|external|aws|externalUser|impersonated|anonymous):[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u
/** Server-verified SID or provider tenant/object pair, or BigQuery's verified principal. Display logins and token/session identifiers are not proof. */
export const connectionPrincipalIdSchema = z.string().max(256).refine(value => sqlServerPrincipalId.test(value) || bigQueryPrincipalId.test(value), 'Invalid principal id.')
  .refine(value => value.slice(0, 4).toLowerCase() !== 'sid:' || (value.length - 4) % 2 === 0, 'A SID must contain complete hex bytes.')

export function verifiedConnectionAuthentication(info: ConnectionInfo, authentication: ConnectionOptions['authentication']): (ConnectionAuthentication & { readonly principal: SqlServerPrincipal }) | undefined {
  const id = connectionPrincipalIdSchema.safeParse(info.principalId)
  if (!id.success) return undefined
  const canonical = id.data.toLowerCase()
  if (authentication.startsWith('entra') ? !canonical.startsWith('entra:') : !canonical.startsWith('sid:')) return undefined
  return connectionAuthenticationSchema.parse({ principal: { provider: 'sqlserver', authentication, id: canonical } }) as ConnectionAuthentication & { readonly principal: SqlServerPrincipal }
}
