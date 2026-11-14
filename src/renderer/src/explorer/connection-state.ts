import type { ConnectionFailureReason, ConnectionLifecycle } from '../../../shared/connection-targets'

const failures: Readonly<Record<ConnectionFailureReason, { label?: string; sentence: string; action?: string }>> = {
  'credentials-required': { label: 'Credentials required', sentence: 'Choose Reconnect to enter credentials for this connection.', action: 'Enter credentials' },
  'sign-in-required': { label: 'Sign-in required', sentence: 'Choose Reconnect to sign in. Automatic reconnect never opens a browser.', action: 'Sign in' },
  'secret-storage-unavailable': { label: 'Password storage unavailable', sentence: 'The saved password could not be unlocked. Choose Reconnect to enter credentials.', action: 'Enter credentials' },
  network: { label: 'Network unavailable', sentence: 'The server could not be reached. Check the server and network, then choose Reconnect.' },
  certificate: { label: 'Certificate rejected', sentence: 'The server certificate could not be verified. Choose Reconnect to review the connection settings.' },
  'database-unavailable': { label: 'Database unavailable', sentence: 'The requested database could not be opened. Choose Reconnect to review the connection settings.' },
  'identity-changed': { label: 'Account changed', sentence: 'The authenticated account did not match this connection. Choose Reconnect to review the account.' },
  cancelled: { sentence: 'This connection attempt was cancelled. Choose Reconnect to try again.' },
  'backend-lost': { label: 'Backend restarted', sentence: 'The SQL backend restarted. Choose Reconnect to open a new session.' },
  unknown: { label: 'Connection failed', sentence: 'This connection could not be opened. Choose Reconnect to review its settings and try again.' }
}

/** Text for the canonical target lifecycle. The tree holds no separate connection state. */
export function serverConnectionStatus(node: { readonly lost: boolean; readonly connectionLifecycle?: ConnectionLifecycle }): { label: string; sentence: string; action: string; busy: boolean } | undefined {
  const state = node.connectionLifecycle
  if (state?.state === 'connecting') return { label: 'Connecting…', sentence: 'A connection attempt is in progress.', action: 'Reconnect', busy: true }
  if (state?.state === 'disconnecting') return { label: 'Disconnecting…', sentence: 'This connection is being disconnected.', action: 'Reconnect', busy: true }
  if (!node.lost) return undefined
  const reason = state?.state === 'lost' || state?.state === 'disconnected' ? state.reason : undefined
  const failure = reason ? failures[reason] : undefined
  return { label: `Disconnected${failure?.label ? ' · ' + failure.label : ''}`, sentence: failure?.sentence ?? 'This server is disconnected. Reconnect to browse fresh metadata, or remove it from Object Explorer.', action: failure?.action ?? 'Reconnect', busy: false }
}
