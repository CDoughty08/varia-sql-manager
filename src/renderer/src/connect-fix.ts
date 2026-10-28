import type { ConnectionOptions, ErrorDetails } from '../../shared/contracts'

export type ConnectFix = 'trust' | 'strict' | 'pinned'

/**
 * The fix a failed connect offers: an untrusted server certificate (`reason` 'certificate') can be trusted for this
 * connection, as checking Trust server certificate does, unless Strict encryption ignores that setting ('strict'), or the
 * person pinned the certificate (Advanced › Server Certificate) or the name it must carry (Host Name in Certificate):
 * trusting would skip exactly the check they set up, and an unexpected certificate there may be an interception
 * ('pinned'). In both cases the dialog only explains. Nothing else has a fix the dialog can apply.
 */
export function connectFix(options: Pick<ConnectionOptions, 'encrypt' | 'trustServerCertificate' | 'hostNameInCertificate' | 'advanced'>, details: ErrorDetails | undefined): ConnectFix | undefined {
  if (details?.reason !== 'certificate') return undefined
  if (options.encrypt === 'strict') return 'strict'
  if (options.hostNameInCertificate?.trim() || options.advanced?.serverCertificate?.trim()) return 'pinned'
  return options.trustServerCertificate ? undefined : 'trust'
}
