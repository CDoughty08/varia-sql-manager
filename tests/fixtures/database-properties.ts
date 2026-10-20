import type { DatabasePropertiesModel } from '../../src/shared/actions/schema'

/** A user database on SQL Server 2022 as the describe answers it, for a sysadmin; `patch` changes parts of it. */
export function databaseModel(patch: Partial<DatabasePropertiesModel> = {}, options: Record<string, string> = {}): DatabasePropertiesModel {
  return {
    general: { name: 'AppData', status: 'ONLINE', owner: 'sa', created: '2026-01-02T03:04:05.000', sizeMb: 16, spaceAvailableMb: 5.25, users: 4, lastBackup: 'None', lastLogBackup: 'None', collation: 'Latin1_General_CI_AS' },
    options: {
      collation: 'Latin1_General_CI_AS', recoveryModel: 'FULL', compatibilityLevel: '160', containmentType: 'NONE', autoClose: 'false', autoCreateIncrementalStatistics: 'false',
      autoCreateStatistics: 'true', autoShrink: 'false', autoUpdateStatistics: 'true', autoUpdateStatisticsAsync: 'false', closeCursorOnCommit: 'false', defaultCursor: 'GLOBAL',
      filestreamNonTransactedAccess: 'OFF', isLedgerDatabase: 'false', allowSnapshotIsolation: 'false', ansiNullDefault: 'false', ansiNulls: 'false', ansiPadding: 'false',
      ansiWarnings: 'false', arithmeticAbort: 'false', concatNullYieldsNull: 'false', dbChaining: 'false', dateCorrelationOptimization: 'false', delayedDurability: 'DISABLED',
      readCommittedSnapshot: 'false', numericRoundAbort: 'false', parameterization: 'SIMPLE', quotedIdentifiers: 'false', recursiveTriggers: 'false', trustworthy: 'false',
      varDecimalStorageFormat: 'true', pageVerify: 'CHECKSUM', targetRecoveryTime: '60', brokerEnabled: 'false', honorBrokerPriority: 'false',
      serviceBrokerIdentifier: '6F9619FF-8B86-D011-B42D-00C04FC964FF', readOnly: 'false', databaseState: 'ONLINE', encryptionEnabled: 'false', restrictAccess: 'MULTI_USER', ...options
    },
    scoped: {
      maxDop: '0', maxDopForSecondary: 'PRIMARY', legacyCardinalityEstimation: 'OFF', legacyCardinalityEstimationForSecondary: 'PRIMARY', parameterSniffing: 'ON',
      parameterSniffingForSecondary: 'PRIMARY', queryOptimizerFixes: 'OFF', queryOptimizerFixesForSecondary: 'PRIMARY'
    },
    compatibilityLevels: [100, 110, 120, 130, 140, 150, 160],
    collations: ['Latin1_General_BIN2', 'Latin1_General_CI_AS', 'SQL_Latin1_General_CP1_CI_AS'],
    logins: ['AppUser', 'sa'],
    files: [
      { name: 'AppData', type: 'rows', filegroup: 'PRIMARY', sizeMb: 8, growth: { enabled: true, unit: 'mb', by: 64 }, path: 'C:\\Data', fileName: 'AppData.mdf', isPrimary: true },
      { name: 'AppData_log', type: 'log', sizeMb: 8, growth: { enabled: true, unit: 'percent', by: 10, maxMb: 2_097_152 }, path: 'C:\\Data', fileName: 'AppData_log.ldf', isPrimary: false }
    ],
    filesTruncated: false,
    filegroups: [{ name: 'PRIMARY', type: 'rows', files: 1, readOnly: false, isDefault: true, autogrowAllFiles: false }],
    filegroupsTruncated: false,
    server: { level: 16, sysadmin: true, filestreamLevel: 0, pathSeparator: '\\', edition: 3, containedAuthentication: false },
    sessions: 1,
    ...patch
  }
}
