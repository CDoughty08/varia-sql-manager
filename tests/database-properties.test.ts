import { describe, expect, it } from 'vitest'
import {
  afterReadOnlyProblem, autogrowthText, compatibilityLabel, compatibilityLevelsFor, databaseOptionDefs, databaseStatusText, fileTypeLabel, optionDef, scopedConfigurationDefs, tokenProblem
} from '../src/shared/actions/database'
import { actionRequestSchema } from '../src/shared/actions/schema'
import {
  afterDatabaseFailure, databaseConfirm, databaseRequest, draftErrors, greyNotes, initialDatabaseDraft, optionChoices, optionGroups, optionShown, optionState, ownerState, setOption, type DatabaseRequest
} from '../src/renderer/src/dialogs/database-properties'
import { databaseModel } from './fixtures/database-properties'

const target = { kind: 'database', name: 'AppData' } as const
const all = [...databaseOptionDefs, ...scopedConfigurationDefs]
const request = (model = databaseModel(), edit: (draft: ReturnType<typeof initialDatabaseDraft>) => ReturnType<typeof initialDatabaseDraft> = draft => draft, on = target) =>
  databaseRequest(on, model, edit(initialDatabaseDraft(model)))

describe('Database Properties catalogue', () => {
  it('declares each option once, in one strict SMO order that puts the header, the SET options, scoped configurations and snapshot isolation where SSMS writes them', () => {
    expect(new Set(all.map(def => def.key)).size).toBe(all.length)
    expect(new Set(all.map(def => def.smoOrder)).size).toBe(all.length)
    const order = (key: string) => optionDef(key)!.smoOrder
    expect(['containmentType', 'compatibilityLevel', 'collation', 'ansiNullDefault', 'autoClose', 'autoCreateStatistics', 'defaultCursor', 'brokerEnabled', 'parameterization', 'readOnly',
      'recoveryModel', 'restrictAccess', 'pageVerify', 'filestreamNonTransactedAccess', 'targetRecoveryTime', 'delayedDurability', 'legacyCardinalityEstimation', 'maxDop', 'maxDopForSecondary', 'queryOptimizerFixesForSecondary',
      'allowSnapshotIsolation'].map(order)).toEqual([...['containmentType', 'compatibilityLevel', 'collation', 'ansiNullDefault', 'autoClose', 'autoCreateStatistics', 'defaultCursor', 'brokerEnabled',
      'parameterization', 'readOnly', 'recoveryModel', 'restrictAccess', 'pageVerify', 'filestreamNonTransactedAccess', 'targetRecoveryTime', 'delayedDurability', 'legacyCardinalityEstimation', 'maxDop', 'maxDopForSecondary',
      'queryOptimizerFixesForSecondary', 'allowSnapshotIsolation'].map(order)].sort((a, b) => a - b))
    for (const def of all.filter(item => item.settable)) {
      expect(def.sql, def.key).toBeDefined()
      if (def.sql?.kind === 'set' && !def.sql.seconds) expect(Object.keys(def.sql.tokens ?? {}).sort(), def.key).toEqual(def.choices!.map(choice => choice.token).sort())
    }
    expect(all.filter(def => def.exclusive).map(def => def.key)).toEqual(['filestreamNonTransactedAccess', 'dateCorrelationOptimization', 'readCommittedSnapshot', 'readOnly', 'restrictAccess'])
  })
  it('labels every row as Learn\'s Options page does', () => {
    expect(all.map(def => def.label)).toEqual([
      'Collation', 'Recovery model', 'Compatibility level', 'Containment type',
      'Auto Close', 'Auto Create Incremental Statistics', 'Auto Create Statistics', 'Auto Shrink', 'Auto Update Statistics', 'Auto Update Statistics Asynchronously',
      'Default Fulltext Language LCID', 'Default Language', 'Nested Triggers Enabled', 'Transform Noise Words', 'Two Digit Year Cutoff',
      'Close Cursor on Commit Enabled', 'Default Cursor', 'FILESTREAM Directory Name', 'FILESTREAM Non-Transacted Access', 'Is Ledger Database',
      'Allow Snapshot Isolation', 'ANSI NULL Default', 'ANSI NULLS Enabled', 'ANSI Padding Enabled', 'ANSI Warnings Enabled', 'Arithmetic Abort Enabled', 'Concatenate Null Yields Null',
      'Cross-database Ownership Chaining Enabled', 'Date Correlation Optimization Enabled', 'Delayed Durability', 'Is Read Committed Snapshot On', 'Numeric Round-Abort', 'Parameterization',
      'Quoted Identifiers Enabled', 'Recursive Triggers Enabled', 'Trustworthy', 'VarDecimal Storage Format Enabled', 'Page Verify', 'Target Recovery Time (Seconds)',
      'Broker Enabled', 'Honor Broker Priority', 'Service Broker Identifier', 'Database Read-Only', 'Database State', 'Encryption Enabled', 'Restrict Access',
      'Legacy Cardinality Estimation', 'Legacy Cardinality Estimation for Secondary', 'Max DOP', 'Max DOP for Secondary', 'Parameter Sniffing', 'Parameter Sniffing for Secondary',
      'Query Optimizer Fixes', 'Query Optimizer Fixes for Secondary'
    ])
    // SSMS shows these read-only (Trustworthy and cross-database chaining are not saved by its dialog).
    expect(all.filter(def => !def.settable).map(def => def.key)).toEqual(['defaultFulltextLanguageLcid', 'defaultLanguage', 'nestedTriggersEnabled', 'transformNoiseWords', 'twoDigitYearCutoff',
      'filestreamDirectoryName', 'isLedgerDatabase', 'dbChaining', 'trustworthy', 'varDecimalStorageFormat', 'honorBrokerPriority', 'serviceBrokerIdentifier', 'databaseState', 'encryptionEnabled'])
  })
  it('words compatibility levels, autogrowth, file types and status as SSMS does', () => {
    expect([100, 110, 120, 130, 140, 150, 160, 170].map(compatibilityLabel)).toEqual(['SQL Server 2008 (100)', 'SQL Server 2012 (110)', 'SQL Server 2014 (120)', 'SQL Server 2016 (130)',
      'SQL Server 2017 (140)', 'SQL Server 2019 (150)', 'SQL Server 2022 (160)', 'SQL Server 2025 (170)'])
    expect([13, 14, 15, 16, 17].map(major => compatibilityLevelsFor(major).at(-1))).toEqual([130, 140, 150, 160, 170])
    expect([
      autogrowthText({ enabled: false }), autogrowthText({ enabled: true, unit: 'mb', by: 64 }), autogrowthText({ enabled: true, unit: 'percent', by: 10 }),
      autogrowthText({ enabled: true, unit: 'mb', by: 64, maxMb: 1024 }), autogrowthText({ enabled: true, unit: 'percent', by: 10, maxMb: 2_097_152 }),
      autogrowthText({ enabled: true, unit: 'mb', by: 0 }, 'filestream'), autogrowthText({ enabled: true, unit: 'mb', by: 0, maxMb: 500 }, 'filestream')
    ]).toEqual(['None', 'By 64 MB, Unlimited', 'By 10 percent, Unlimited', 'By 64 MB, Limited to 1024 MB', 'By 10 percent, Limited to 2097152 MB', 'Unlimited', 'Limited to 500 MB'])
    expect(Object.values(fileTypeLabel)).toEqual(['ROWS Data', 'LOG', 'FILESTREAM Data'])
    expect([databaseStatusText('ONLINE'), databaseStatusText('ONLINE', { readOnly: true }), databaseStatusText('RESTORING', { standby: true }), databaseStatusText('RECOVERY_PENDING')])
      .toEqual(['Normal', 'Normal, Read-Only', 'Restoring, Standby', 'Recovery Pending'])
  })
  it('takes each option\'s tokens, and integers only as plain decimal text in range', () => {
    const def = (key: string) => optionDef(key)!
    expect([tokenProblem(def('maxDop'), '0'), tokenProblem(def('maxDop'), '32767'), tokenProblem(def('maxDopForSecondary'), 'PRIMARY'), tokenProblem(def('collation'), 'Latin1_General_BIN2')]).toEqual([undefined, undefined, undefined, undefined])
    for (const [key, token] of [['maxDop', '32768'], ['maxDop', '01'], ['maxDop', ' 1'], ['maxDop', '-0'], ['autoClose', 'True'], ['recoveryModel', 'full'], ['collation', 'Latin1 General']]) {
      expect(tokenProblem(def(key), token), key + ' ' + token).toBeDefined()
    }
  })
})

describe('Database Properties draft', () => {
  it('sends nothing when nothing changed, and only the values that did', () => {
    expect(request()).toBeUndefined()
    expect(request(undefined, draft => setOption(draft, 'recoveryModel', 'SIMPLE'))).toEqual({ action: 'properties', target, closeConnections: false, changes: { options: { recoveryModel: 'SIMPLE' } } })
    // Changing a value and back sends nothing.
    expect(request(undefined, draft => setOption(setOption(draft, 'autoClose', 'true'), 'autoClose', 'false'))).toBeUndefined()
    expect(request(undefined, draft => setOption(setOption(draft, 'maxDop', '8'), 'legacyCardinalityEstimationForSecondary', 'ON')))
      .toEqual({ action: 'properties', target, closeConnections: false, changes: { scoped: { maxDop: '8', legacyCardinalityEstimationForSecondary: 'ON' } } })
    const owner = request(undefined, draft => ({ ...draft, owner: "q]'; --" }))
    expect(owner).toEqual({ action: 'properties', target, closeConnections: false, changes: { owner: "q]'; --" } })
    // What the draft sends, main's schema accepts.
    expect(actionRequestSchema.safeParse({ ...owner as DatabaseRequest, connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() }).success).toBe(true)
  })
  it('names the database it read, so a database that has taken the name since is never changed in its place', () => {
    const model = databaseModel({ general: { ...databaseModel().general, id: 7 } })
    const sent = request(model, draft => setOption(draft, 'autoClose', 'true')) as DatabaseRequest
    expect(sent).toEqual({ action: 'properties', target, closeConnections: false, changes: { options: { autoClose: 'true' } }, identity: { id: 7, created: '2026-01-02T03:04:05.000' } })
    const ids = { connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    expect(actionRequestSchema.safeParse({ ...sent, ...ids }).success).toBe(true)
    // Main refuses an identity the describe could not have written, and one on another action.
    for (const identity of [{ id: 0, created: sent.identity!.created }, { id: 7, created: '2026-01-02 03:04:05' }, { id: 7, created: `${sent.identity!.created}\n` }, { id: 7.5, created: sent.identity!.created }, { ...sent.identity, extra: 1 }]) {
      expect(actionRequestSchema.safeParse({ ...sent, ...ids, identity }).success, JSON.stringify(identity)).toBe(false)
    }
    expect(actionRequestSchema.safeParse({ action: 'rename', ...ids, target: { kind: 'database', name: 'AppData' }, newName: 'B', identity: sent.identity }).success).toBe(false)
  })
  it('shows a problem instead of sending a number out of range or an empty owner', () => {
    expect(request(undefined, draft => setOption(draft, 'maxDop', '40000'))).toEqual({ problem: 'Max DOP must be a whole number from 0 to 32,767.' })
    expect(request(undefined, draft => setOption(draft, 'maxDopForSecondary', 'all'))).toEqual({ problem: 'Max DOP for Secondary must be PRIMARY or a whole number from 0 to 32,767.' })
    expect(request(undefined, draft => setOption(draft, 'targetRecoveryTime', ' 60 '))).toEqual({ problem: 'Target Recovery Time (Seconds) must be a whole number from 0 to 2,147,483,647.' })
    expect(request(undefined, draft => ({ ...draft, owner: '' }))).toEqual({ problem: 'Owner must be a login name of 1 to 128 characters.' })
    const model = databaseModel()
    expect([...draftErrors(model, setOption(initialDatabaseDraft(model), 'maxDop', 'x'), target).keys()]).toEqual(['maxDop'])
  })
  it('greys Incremental while Auto Create Statistics is False, and sends no change it greys', () => {
    const model = databaseModel()
    const draft = setOption(setOption(initialDatabaseDraft(model), 'autoCreateIncrementalStatistics', 'true'), 'autoCreateStatistics', 'false')
    expect(optionState(optionDef('autoCreateIncrementalStatistics')!, model, draft, target)).toEqual({ disabled: true, note: greyNotes.incremental })
    expect(databaseRequest(target, model, draft)).toEqual({ action: 'properties', target, closeConnections: false, changes: { options: { autoCreateStatistics: 'false' } } })
  })
  it('greys Compatibility level outside sysadmin, Containment without contained authentication, and FILESTREAM when the server has none', () => {
    const plain = databaseModel({ server: { ...databaseModel().server, sysadmin: false } })
    expect(optionState(optionDef('compatibilityLevel')!, plain, initialDatabaseDraft(plain), target)).toEqual({ disabled: true, note: greyNotes.sysadmin })
    expect(request(plain, draft => setOption(draft, 'compatibilityLevel', '150'))).toBeUndefined()
    const model = databaseModel()
    expect(optionState(optionDef('containmentType')!, model, initialDatabaseDraft(model), target)).toEqual({ disabled: true, note: greyNotes.containment })
    expect(optionState(optionDef('filestreamNonTransactedAccess')!, model, initialDatabaseDraft(model), target)).toEqual({ disabled: true, note: greyNotes.filestream })
    const contained = databaseModel({ server: { ...model.server, containedAuthentication: true, filestreamLevel: 2 } })
    expect(optionState(optionDef('containmentType')!, contained, initialDatabaseDraft(contained), target).disabled).toBe(false)
    expect(optionState(optionDef('filestreamNonTransactedAccess')!, contained, initialDatabaseDraft(contained), target).disabled).toBe(false)
  })
  it('greys everything for a read-only dialog, all but Database Read-Only and Restrict Access for a read-only database, and what SQL Server refuses on its own databases', () => {
    const snapshot = databaseModel({ readOnlyReason: 'A database snapshot is read-only.' })
    expect(all.every(def => optionState(def, snapshot, initialDatabaseDraft(snapshot), target).disabled)).toBe(true)
    expect(ownerState(snapshot, target)).toEqual({ disabled: true, note: 'A database snapshot is read-only.' })
    expect(request(snapshot, draft => setOption(draft, 'autoClose', 'true'))).toBeUndefined()
    const readOnly = databaseModel({}, { readOnly: 'true' })
    expect(all.filter(def => !optionState(def, readOnly, initialDatabaseDraft(readOnly), target).disabled).map(def => def.key)).toEqual(['readOnly', 'restrictAccess'])
    expect(optionState(optionDef('autoClose')!, readOnly, initialDatabaseDraft(readOnly), target).note).toBe(greyNotes.readOnlyDatabase)
    const tempdb = { kind: 'database', name: 'tempdb' } as const, model = databaseModel()
    expect(optionState(optionDef('recoveryModel')!, model, initialDatabaseDraft(model), tempdb)).toEqual({ disabled: true, note: 'SQL Server does not allow this option on tempdb.' })
    expect(optionState(optionDef('autoUpdateStatistics')!, model, initialDatabaseDraft(model), tempdb).disabled).toBe(false)
    expect(ownerState(model, tempdb)).toEqual({ disabled: true, note: 'SQL Server does not allow changing the owner of tempdb.' })
    expect(ownerState(model, { kind: 'database', name: 'msdb' }).disabled).toBe(false)
    // SQL Server refuses ALTER AUTHORIZATION on a read-only database (3906).
    expect(ownerState(readOnly, target)).toEqual({ disabled: true, note: greyNotes.readOnlyDatabase })
    expect(request(readOnly, draft => ({ ...draft, owner: 'AppUser' }))).toBeUndefined()
  })
  it('refuses to turn Read-Only on in the same OK as a change SQL Server would refuse after it, which SSMS would leave half applied', () => {
    const model = databaseModel()
    const readOnly = (draft: ReturnType<typeof initialDatabaseDraft>) => setOption(draft, 'readOnly', 'true')
    expect(request(model, draft => setOption(readOnly(draft), 'maxDop', '4'))).toEqual({ problem: afterReadOnlyProblem('Max DOP') })
    expect(request(model, draft => ({ ...readOnly(draft), owner: 'AppUser' }))).toEqual({ problem: afterReadOnlyProblem('Owner') })
    expect(draftErrors(model, setOption(setOption(readOnly(initialDatabaseDraft(model)), 'targetRecoveryTime', '30'), 'delayedDurability', 'FORCED'), target))
      .toEqual(new Map([['delayedDurability', afterReadOnlyProblem('Delayed Durability')], ['targetRecoveryTime', afterReadOnlyProblem('Target Recovery Time (Seconds)')]]))
    // SET FILESTREAM fails with 3906 on a read-only database (measured on SQL Server 2025), and SMO writes it after READ_ONLY.
    const filestream = databaseModel({ server: { ...model.server, filestreamLevel: 2 } })
    expect(request(filestream, draft => setOption(readOnly(draft), 'filestreamNonTransactedAccess', 'FULL'))).toEqual({ problem: afterReadOnlyProblem('FILESTREAM Non-Transacted Access') })
    // What runs before READ_ONLY, and what SQL Server allows on a read-only database, still goes with it.
    const together = request(model, draft => ['compatibilityLevel:150', 'collation:Latin1_General_BIN2', 'dateCorrelationOptimization:true', 'recoveryModel:SIMPLE', 'restrictAccess:SINGLE_USER',
      'pageVerify:NONE', 'allowSnapshotIsolation:true'].reduce((next, pair) => setOption(next, pair.split(':')[0], pair.split(':')[1]), readOnly(draft))) as DatabaseRequest
    expect(Object.keys(together.changes.options!).sort()).toEqual(['allowSnapshotIsolation', 'collation', 'compatibilityLevel', 'dateCorrelationOptimization', 'pageVerify', 'readOnly', 'recoveryModel', 'restrictAccess'])
    // Turning it off, or a database that already is read-only, is not this rule.
    expect(request(model, draft => setOption(setOption(draft, 'readOnly', 'false'), 'maxDop', '4'))).toMatchObject({ changes: { scoped: { maxDop: '4' } } })
    expect(all.filter(def => def.settable && def.refusedReadOnly).map(def => def.key).sort()).toEqual(['collation', 'compatibilityLevel', 'dateCorrelationOptimization', 'delayedDurability', 'filestreamNonTransactedAccess',
      'legacyCardinalityEstimation', 'legacyCardinalityEstimationForSecondary', 'maxDop', 'maxDopForSecondary', 'parameterSniffing', 'parameterSniffingForSecondary', 'queryOptimizerFixes',
      'queryOptimizerFixesForSecondary', 'targetRecoveryTime'])
  })
  it('shows rows only where the server and the database have them', () => {
    const model = databaseModel()
    const shown = (key: string, value = model) => optionShown(optionDef(key)!, value)
    expect([shown('isLedgerDatabase'), shown('isLedgerDatabase', databaseModel({ server: { ...model.server, level: 15 } })), shown('defaultLanguage'),
      shown('defaultLanguage', databaseModel({}, { containmentType: 'PARTIAL' })), shown('maxDop'), shown('maxDop', databaseModel({ scoped: {} }))]).toEqual([true, false, false, true, true, false])
    expect(optionGroups(model).map(group => group.category)).toEqual(['Automatic', 'Cursor', 'Database Scoped Configurations', 'FILESTREAM', 'Ledger', 'Miscellaneous', 'Recovery', 'Service Broker', 'State'])
    // The lists keep a value the server no longer offers, so it shows as it is.
    expect(optionChoices(optionDef('collation')!, databaseModel({}, { collation: 'Old_Collation' })).map(choice => choice.value)).toEqual(['Old_Collation', ...model.collations])
    expect(optionChoices(optionDef('compatibilityLevel')!, databaseModel({}, { compatibilityLevel: '90' })).map(choice => choice.label)[0]).toBe('(90)')
  })
  it('asks Open Connections only for a change SSMS closes connections for, when the database has sessions or they cannot be counted', () => {
    const built = (model: ReturnType<typeof databaseModel>, key: string, token: string) => databaseRequest(target, model, setOption(initialDatabaseDraft(model), key, token)) as DatabaseRequest
    const busy = databaseModel(), idle = databaseModel({ sessions: 0 }), unknown = databaseModel({ sessions: undefined })
    expect(databaseConfirm(busy, built(busy, 'restrictAccess', 'SINGLE_USER'))).toBe('openConnections')
    expect(databaseConfirm(unknown, built(unknown, 'readOnly', 'true'))).toBe('openConnections')
    expect(databaseConfirm(idle, built(idle, 'readCommittedSnapshot', 'true'))).toBeUndefined()
    expect(databaseConfirm(busy, built(busy, 'recoveryModel', 'SIMPLE'))).toBeUndefined()
    // After IN_USE the count the dialog opened with is stale, so the next OK asks, as SSMS counts at OK.
    const inUse = { code: 'IN_USE', message: 'Other connections use the database.', retryable: true } as const
    const stale = afterDatabaseFailure(idle, inUse)
    expect(stale.sessions).toBeUndefined()
    expect(databaseConfirm(stale, built(stale, 'readOnly', 'true'))).toBe('openConnections')
    expect(afterDatabaseFailure(idle, { ...inUse, code: 'SQL_ERROR' })).toBe(idle)
  })
})
