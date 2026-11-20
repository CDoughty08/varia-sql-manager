import { z } from 'zod'
import type { BigQueryConnectionOptions, ConnectionInfo, ConnectionOptions } from '../shared/contracts'
import { connectionAuthenticationSchema, type ConnectionAuthentication, type ExpectedConnectionPrincipal, type SqlServerPrincipal } from '../shared/connection-targets'
type BigQueryPrincipal = Extract<ExpectedConnectionPrincipal, { readonly provider: 'bigquery' }>

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

/**
 * BigQuery's proof: the pin the backend verified with Google (`bigquery:` and the identity, case kept, since an email's
 * local part and a federated subject may differ by case), for the billing project the options name. A SQL Server answer,
 * or an anonymous pin outside emulator mode's own answers, is not proof for a BigQuery connection.
 */
export function verifiedBigQueryAuthentication(info: ConnectionInfo, options: Pick<BigQueryConnectionOptions, 'project'>): (ConnectionAuthentication & { readonly principal: BigQueryPrincipal }) | undefined {
  if (info.providerId !== 'bigquery') return undefined
  const id = connectionPrincipalIdSchema.safeParse(info.principalId)
  if (!id.success || !id.data.startsWith('bigquery:')) return undefined
  const parsed = connectionAuthenticationSchema.safeParse({ principal: { provider: 'bigquery', project: options.project, principal: id.data } })
  return parsed.success ? parsed.data as ConnectionAuthentication & { readonly principal: BigQueryPrincipal } : undefined
}
