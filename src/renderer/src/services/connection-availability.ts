import type { ConnectionLifecycle } from '../../../shared/connection-targets'

export interface ConnectionAvailability {
  readonly lost?: boolean
  readonly lifecycle?: ConnectionLifecycle
}

/** A retained handle cannot admit new work while its disconnect is in progress. */
/** A BigQuery connection: SQL Server's catalog features (Search Objects, Explorer status probes) leave it out. */
export function isBigQueryConnection(connection: { readonly providerId?: string; readonly options?: { readonly provider?: string } }): boolean {
  return connection.providerId === 'bigquery' || connection.options?.provider === 'bigquery'
}

export function isLiveConnection<T extends ConnectionAvailability>(connection: T | undefined): connection is T & { readonly lost?: false; readonly lifecycle?: Extract<ConnectionLifecycle, { state: 'connected' }> } {
  return !!connection && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected')
}
