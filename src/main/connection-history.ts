import { connectionKey, type ConnectionLibrary, type ConnectionProfile } from '../shared/connections'
import type { BigQueryConnectionOptions, ConnectionOptions, ProviderConnectionOptions } from '../shared/contracts'
import type { BigQueryConnectionStore } from './bigquery-connection-store'
import type { ConnectionStore } from './connection-store'

/**
 * Where a connect records its history entry: SQL Server's library (`mssql-connections.json`) or BigQuery's
 * (`bigquery-connections.json`), by the options' provider. `load` is SQL Server's library, which remembered passwords are
 * reconciled against (BigQuery keeps no secret). Method syntax, so a plain ConnectionStore still fits where only SQL
 * Server's options reach it.
 */
export interface ConnectionHistory {
  rememberEntry(options: ProviderConnectionOptions, keepEnvironment?: boolean, autoReconnect?: ConnectionProfile['autoReconnect'], selectedProfileId?: string): Promise<{ id: string; environment?: string }>
  setAutoReconnect(options: ProviderConnectionOptions, value: NonNullable<ConnectionProfile['autoReconnect']>, selectedProfileId?: string): Promise<boolean>
  load(): Promise<{ library: ConnectionLibrary; warning?: string; trusted: boolean }>
  /** Saves a BigQuery connection's cost-prompt choice (docs/bigquery.md, Cost); resolves whether it holds. */
  setBigQueryCostPrompt?(options: BigQueryConnectionOptions, costPrompt: boolean): Promise<boolean>
}

export function connectionHistory(sqlServer: ConnectionStore, bigQuery: BigQueryConnectionStore): ConnectionHistory {
  return {
    rememberEntry: (options, keepEnvironment, autoReconnect, selectedProfileId) => options.provider === 'bigquery'
      ? bigQuery.rememberEntry(options, keepEnvironment, autoReconnect, selectedProfileId)
      : sqlServer.rememberEntry(options as ConnectionOptions, keepEnvironment, autoReconnect, selectedProfileId),
    setAutoReconnect: (options, value, selectedProfileId) => options.provider === 'bigquery'
      ? bigQuery.setAutoReconnect(options, value, selectedProfileId)
      : sqlServer.setAutoReconnect(options as ConnectionOptions, value, selectedProfileId),
    load: () => sqlServer.load(),
    async setBigQueryCostPrompt(options, costPrompt) {
      const { costPrompt: _costPrompt, ...rest } = options, key = connectionKey(rest)
      const library = await bigQuery.setCostPrompt({ options: rest, costPrompt })
      return library.profiles.some(profile => connectionKey(profile.options) === key && (profile.options.costPrompt !== false) === costPrompt)
    }
  }
}
