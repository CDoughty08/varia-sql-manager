import type { ConnectionOptions, ErrorDetails } from '../../shared/contracts'

/**
 * The fix a failed connect offers: an untrusted server certificate (`reason` 'certificate') can be trusted for this
 * connection, as checking Trust server certificate does, unless Strict encryption ignores that setting ('strict': the
 * dialog explains instead). Nothing else has a fix the dialog can apply.
 */
export function connectFix(options: Pick<ConnectionOptions, 'encrypt' | 'trustServerCertificate'>, details: ErrorDetails | undefined): 'trust' | 'strict' | undefined {
  if (details?.reason !== 'certificate') return undefined
  if (options.encrypt === 'strict') return 'strict'
  return options.trustServerCertificate ? undefined : 'trust'
}
