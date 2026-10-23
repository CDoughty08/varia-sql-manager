# Scripting catalogue

<!-- Generated from src/shared/scripting/catalog.ts and options.ts. Regenerate with: npx vitest run tests/scripting-catalog.test.ts -u -->

Script As, as SSMS offers it on Object Explorer nodes: a "Script … as" submenu with one submenu per verb and
one item per destination. Which verbs each kind offers, the menu titles, the SMO URN types and the backend's preflight
queries are data in `src/shared/scripting/catalog.ts`; the backend embeds the same data as
`backend/Varia.Backend/Scripting/scripting-catalog.json`, and re-derives the subtype before it scripts anything.

## Verbs

DDL verbs run SMO's Scripter with the listed flag (every other verb flag is off); DML and EXECUTE verbs are SSMS's
templates, built from one catalog query. A verb a kind does not support is shown greyed (○) or not offered (–).

| Verb | Submenu | Mnemonic | Group | Produced by |
| --- | --- | --- | --- | --- |
| `create` | CREATE To | c | `1_ddl` 1 | SMO |
| `alter` | ALTER To | a | `1_ddl` 2 | SMO, `ScriptForAlter` |
| `createOrAlter` | CREATE OR ALTER To | r | `1_ddl` 3 | SMO, `ScriptForCreateOrAlter` |
| `drop` | DROP To | d | `1_ddl` 4 | SMO, `ScriptDrops` |
| `dropAndCreate` | DROP And CREATE To | n | `1_ddl` 5 | SMO, `ScriptForCreateDrop` |
| `select` | SELECT To | s | `2_dml` 1 | Template |
| `insert` | INSERT To | i | `2_dml` 2 | Template |
| `update` | UPDATE To | u | `2_dml` 3 | Template |
| `delete` | DELETE To | e | `2_dml` 4 | Template |
| `execute` | EXECUTE To | x | `3_execute` 1 | Template |

## Destinations

Each verb submenu holds the three destinations. Their commands are `explorer.script<Verb>To<Destination>`, from
`explorer.scriptCreateToNewQuery` to `explorer.scriptExecuteToClipboard`; they stay out of the palette, where Script As… lists the enabled ones.

| Destination | Menu title | Mnemonic | Icon | Waits for document tasks | Script drawer button |
| --- | --- | --- | --- | --- | --- |
| `newQuery` | New Query Editor Window | n | `file-code` | Yes | Open in Query Window |
| `file` | File… | f | `save-as` | Yes | Save Script As… |
| `clipboard` | Clipboard | l | `clippy` | No | Copy |

New Query Editor Window opens the script in a new query on the object's server and database (`master` for databases
and server objects), not marked unsaved. File… suggests `<schema>.<name>.sql` (`<schema>.<table>.<name>.sql` for an
index, key, constraint, statistic or trigger, `<name>.sql` without a schema), which main makes safe for every platform.
Modify is ALTER To › New Query Editor Window for the kinds marked Mod below.
A document's Script drawer (the document frame) offers the same destinations as buttons with the same icons, named in the
last column; each takes the whole script, not the preview.

A request that takes longer than 300 ms shows in the status bar with Cancel (also Object Explorer: Cancel
Scripting in the palette). At most 4 run at once; a cancelled request, or one whose server disconnects, opens nothing.

## Object kinds

✓ enabled, ○ shown greyed, – not offered. Columns: C = CREATE, A = ALTER, CoA = CREATE OR ALTER, D = DROP, DC = DROP And
CREATE, S = SELECT, I = INSERT, U = UPDATE, Del = DELETE, E = EXECUTE, Mod = Modify (ALTER in a new query window).

| Kind | Subtypes | Title | C | A | CoA | D | DC | S | I | U | Del | E | Mod | SMO URN | Preflight |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `login` | — | Script Login as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Login` | `serverObject` |
| `serverRole` | — | Script Server Role as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Role` | `serverObject` |
| `credential` | — | Script Credential as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Credential` | `serverObject` |
| `audit` | — | Script Audit as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Audit` | `serverObject` |
| `serverAuditSpecification` | — | Script Server Audit Specification as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `ServerAuditSpecification` | `serverObject` |
| `backupDevice` | — | Script Backup Device as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `BackupDevice` | `serverObject` |
| `linkedServer` | — | Script Linked Server as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `LinkedServer` | `serverObject` |
| `serverTrigger` | — | Script Server Trigger as | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | ✓ | `DdlTrigger` | `serverObject` |
| `database` | none, `system` | Script Database as | ✓ | ✓ | – | ✓ | ✓ | – | – | – | – | – | – | `Database` | `database` |
| `database` | `snapshot` | Script Database as | ✓ | ○ | – | ✓ | ✓ | – | – | – | – | – | – | `Database` | `database` |
| `user` | — | Script User as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `User` | `databaseObject` |
| `databaseRole` | — | Script Role as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Role` | `databaseObject` |
| `applicationRole` | — | Script Application Role as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `ApplicationRole` | `databaseObject` |
| `schema` | — | Script Schema as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Schema` | `databaseObject` |
| `databaseAuditSpecification` | — | Script Database Audit Specification as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `DatabaseAuditSpecification` | `databaseObject` |
| `databaseTrigger` | — | Script Database Trigger as | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | ✓ | `DdlTrigger` | `databaseObject` |
| `fullTextCatalog` | — | Script Full-Text Catalog as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `FullTextCatalog` | `databaseObject` |
| `fullTextStoplist` | — | Script Full-Text Stoplist as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `FullTextStopList` | `databaseObject` |
| `partitionScheme` | — | Script Partition Scheme as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `PartitionScheme` | `databaseObject` |
| `partitionFunction` | — | Script Partition Function as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `PartitionFunction` | `databaseObject` |
| `searchPropertyList` | — | Script Search Property List as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `SearchPropertyList` | `databaseObject` |
| `planGuide` | — | Script Plan Guide as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `PlanGuide` | `databaseObject` |
| `table` | none, `systemVersioned`, `history`, `updatableLedger`, `appendOnlyLedger`, `graphNode`, `graphEdge`, `fileTable`, `external`, `system` | Script Table as | ✓ | ○ | ○ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | `Table` | `table` |
| `table` | `ledgerHistory` | Script Table as | ○ | ○ | ○ | ○ | ○ | ✓ | ○ | ○ | ○ | ○ | – | `Table` | `table` |
| `view` | none, `system` | Script View as | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | `View` | `module` |
| `view` | `ledger` | Script View as | ✓ | ○ | ○ | ○ | ○ | ✓ | ○ | ○ | ○ | ○ | – | `View` | `module` |
| `synonym` | — | Script Synonym as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Synonym` | `schemaObject` |
| `procedure` | none, `clr`, `system` | Script Stored Procedure as | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ | – | `StoredProcedure` | `module` |
| `procedure` | `sql` | Script Stored Procedure as | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ | ✓ | `StoredProcedure` | `module` |
| `function` | none, `clrTableValued` | Script Function as | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ○ | – | `UserDefinedFunction` | `module` |
| `function` | `inline`, `tableValued` | Script Function as | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ○ | ✓ | `UserDefinedFunction` | `module` |
| `function` | `scalar` | Script Function as | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ✓ | ✓ | `UserDefinedFunction` | `module` |
| `function` | `clrScalar` | Script Function as | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ✓ | – | `UserDefinedFunction` | `module` |
| `function` | `aggregate` | Script Function as | ✓ | ○ | ○ | ✓ | ✓ | ○ | – | – | – | ○ | – | `UserDefinedAggregate` | `module` |
| `sequence` | — | Script Sequence as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Sequence` | `schemaObject` |
| `type` | none, `alias` | Script User-Defined Data Type as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `UserDefinedDataType` | `type` |
| `type` | `clr` | Script User-Defined Type as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `UserDefinedType` | `type` |
| `tableType` | — | Script User-Defined Table Type as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `UserDefinedTableType` | `type` |
| `xmlSchemaCollection` | — | Script XML Schema Collection as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `XmlSchemaCollection` | `schemaObject` |
| `rule` | — | Script Rule as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Rule` | `module` |
| `default` | — | Script Default as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Default` | `module` |
| `securityPolicy` | — | Script Security Policy as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `SecurityPolicy` | `schemaObject` |
| `key` | none, `primary`, `unique` | Script Key as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Index` | `child` |
| `key` | `foreign` | Script Key as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `ForeignKey` | `child` |
| `constraint` | none, `check` | Script Constraint as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Check` | `child` |
| `constraint` | `default` | Script Constraint as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Column/Default` | `child` |
| `constraint` | `edge` | Script Constraint as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `EdgeConstraint` | `child` |
| `trigger` | — | Script Trigger as | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | ✓ | `Trigger` | `child` |
| `index` | none, `clustered`, `nonclustered`, `clusteredColumnstore`, `nonclusteredColumnstore`, `xml`, `spatial`, `hash`, `other` | Script Index as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Index` | `child` |
| `statistic` | — | Script Statistics as | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – | `Statistic` | `child` |

Children are scripted only below these parents: `key` below `table`; `constraint` below `table`; `trigger` below `table` or `view`; `index` below `table` or `view`; `statistic` below `table` or `view`. A table type's keys, constraints and indexes are not.

Module preflights find the object by these `sys.objects.type` codes: `view`: V; `procedure`: P, PC, X, RF; `function`: FN, IF, TF, FS, FT, AF; `rule`: R; `default`: D.

Deferred, with no Script submenu yet (key material, binaries or external integrations): `cryptographicProvider`, `assembly`, `asymmetricKey`, `certificate`, `symmetricKey`, `columnMasterKey`, `columnEncryptionKey`, `externalDataSource`, `externalFileFormat`, `table` (`droppedLedger`), `view` (`droppedLedger`), `procedure` (`extended`), `procedure` (`replicationFilter`).

Not scriptable: folders, and `server`, `column`, `parameter`, `returnValue`.

## Options

Tools › Options › SQL Server Object Explorer › Scripting, with the docs page's labels and order. Defaults follow what
SSMS's Script As produces; where the docs page states another default, it is shown in parentheses. Every request
carries all of them.

They are settings like any other (`objectExplorer.scripting.<key>`; see [settings.md](settings.md)): main stores the
ones that differ from their defaults in `settings.json` in the user data folder. Earlier versions kept them in
`scripting-options.json`, which is imported once when `settings.json` does not exist yet and then left as it was; an
invalid one is renamed to `scripting-options.json.invalid-<uuid>.json`, and the defaults are used with a warning.

### General scripting options

| # | Option | Key | Default | Description | SMO |
| --- | --- | --- | --- | --- | --- |
| 1 | Delimit individual statements | `delimitStatements` | True (docs page: False) | Separates the statements of the script with the batch separator, GO. | Formatter: `GO` after each batch |
| 2 | Include descriptive headers | `includeHeaders` | True | Adds a comment before each object's script that names the object and the date the script was generated. | `IncludeHeaders` (left out when a name contains `/*` or `*/`) |
| 3 | Include enabling vardecimal compression | `includeVarDecimal` | False | Includes the statements that enable the vardecimal storage format on tables that use it. | `NoVardecimal = !value` |
| 4 | Script change tracking | `scriptChangeTracking` | False | Includes the change tracking settings of tables and databases that use change tracking. | `ChangeTracking` |
| 5 | Script full-text catalogs | `scriptFullTextCatalogs` | False | Includes full-text catalogs. | `FullTextCatalogs` |
| 6 | Script USE &lt;database> | `scriptUseDatabase` | True | Starts the script with a USE statement, so it runs in the object's database. Turn it off for a script meant for another database. | `IncludeDatabaseContext`; templates add `USE` |

### Object scripting options

| # | Option | Key | Default | Description | SMO |
| --- | --- | --- | --- | --- | --- |
| 7 | Check for object existence | `checkExistence` | False | Runs each statement only when the object exists (for DROP and ALTER) or does not exist yet (for CREATE). | `IncludeIfNotExists` |
| 8 | Generate script for dependent objects | `generateDependentObjects` | False | Also scripts the objects that must exist before the selected object's script can run. | `WithDependencies`: what the object refers to for CREATE, what refers to it (database DDL triggers included) for CREATE OR ALTER and DROP, nothing for ALTER (SMO's comments for references it cannot resolve are left out and named in a warning) |
| 9 | Schema qualify object names | `schemaQualify` | True (docs page: False) | Prefixes object names with their schema. | `SchemaQualify`; templates |
| 10 | Script data compression options | `scriptDataCompression` | False | Includes the data compression and XML compression settings of tables and indexes. | `ScriptDataCompression`, `ScriptXmlCompression` |
| 11 | Script extended properties | `scriptExtendedProperties` | True (docs page: False) | Includes the object's extended properties. | `ExtendedProperties` |
| 12 | Script owner | `scriptOwner` | False | Includes the object's owner. | `ScriptOwner` |
| 13 | Script permissions | `scriptPermissions` | False (docs page: True) | Includes the permissions granted or denied on the object. | `Permissions` |

### Table/View options

| # | Option | Key | Default | Description | SMO |
| --- | --- | --- | --- | --- | --- |
| 14 | Convert user-defined data types to base types | `convertUserDefinedDataTypes` | False | Replaces user-defined data types with the base types they are built on. | `ConvertUserDefinedDataTypesToBaseType` |
| 15 | Generate SET ANSI PADDING commands | `generateAnsiPadding` | True | Surrounds CREATE TABLE statements with SET ANSI_PADDING statements. | `AnsiPadding` |
| 16 | Include collation | `includeCollation` | False (docs page: True) | Includes each column's collation. | `NoCollation = !value` |
| 17 | Include IDENTITY property | `includeIdentity` | True | Includes the IDENTITY property, with its seed and increment. | `NoIdentities = !value` |
| 18 | Schema qualify foreign key references | `schemaQualifyForeignKeys` | True | Prefixes the table a foreign key references with its schema. | `SchemaQualifyForeignKeysReferences` |
| 19 | Script bound defaults and rules | `scriptBindings` | True | Includes the sp_bindefault and sp_bindrule statements of defaults and rules bound to columns. | `Bindings` |
| 20 | Script CHECK constraints | `scriptCheckConstraints` | True | Includes CHECK constraints. | `DriChecks` |
| 21 | Script defaults | `scriptDefaults` | True (docs page: False) | Includes column default constraints. | `DriDefaults` |
| 22 | Script file groups | `scriptFileGroups` | True (docs page: False) | Includes the ON &lt;filegroup> clause of tables and indexes. | `NoFileGroup = !value` |
| 23 | Script foreign keys | `scriptForeignKeys` | True (docs page: False) | Includes foreign keys. | `DriForeignKeys` |
| 24 | Script full-text indexes | `scriptFullTextIndexes` | False | Includes full-text indexes. | `FullTextIndexes` |
| 25 | Script indexes | `scriptIndexes` | True | Includes clustered, nonclustered, XML, spatial and columnstore indexes. | `Indexes` (clustered, nonclustered, XML, spatial and columnstore) |
| 26 | Script partition schemes | `scriptPartitionSchemes` | False | Includes the partition scheme clause of partitioned tables and indexes. | `NoTablePartitioningSchemes = NoIndexPartitioningSchemes = !value` |
| 27 | Script primary keys | `scriptPrimaryKeys` | True | Includes primary keys. | `DriPrimaryKey` |
| 28 | Script statistics | `scriptStatistics` | False | Includes statistics, without their histograms. | `Statistics`; `OptimizerData = false` |
| 29 | Script triggers | `scriptTriggers` | False | Includes the DML triggers of tables and views. | `Triggers` |
| 30 | Script unique keys | `scriptUniqueKeys` | True (docs page: False) | Includes unique keys. | `DriUniqueKeys` |
| 31 | Script view columns | `scriptViewColumns` | False | Lists a view's column names in its CREATE VIEW header. | `NoViewColumns = !value` |
| 32 | Include DRI system names | `includeDriSystemNames` | False | Includes the names of constraints whose names SQL Server generated. | `DriIncludeSystemNames` |

### Version options

| # | Option | Key | Default | Description | SMO |
| --- | --- | --- | --- | --- | --- |
| 33 | Match script settings to source | `matchSourceSettings` | True | Scripts for the version, edition and engine type of the object's server. Turn it off to choose them below. | True: `TargetServerVersion`, `TargetDatabaseEngineEdition` and `TargetDatabaseEngineType` follow the server |
| 34 | Script for database engine edition | `targetEngineEdition` | Microsoft SQL Server Enterprise Edition | The database engine edition the script is for. Used when Match script settings to source is False. Values: `personal` Microsoft SQL Server Personal Edition; `standard` Microsoft SQL Server Standard Edition; `enterprise` Microsoft SQL Server Enterprise Edition; `express` Microsoft SQL Server Express Edition. | `TargetDatabaseEngineEdition` |
| 35 | Script for database engine type | `targetEngineType` | Stand-alone instance | The database engine type the script is for. Used when Match script settings to source is False. Values: `standalone` Stand-alone instance. | `TargetDatabaseEngineType` |
| 36 | Script for server version | `targetServerVersion` | SQL Server 2022 | The SQL Server version the script is for; features it lacks cannot be scripted. Used when Match script settings to source is False. Values: `130` SQL Server 2016; `140` SQL Server 2017; `150` SQL Server 2019; `160` SQL Server 2022; `170` SQL Server 2025. | `TargetServerVersion = Version<value>` |

## Errors

Failures come back as values in the result. Retryable ones can succeed when tried again.

| Code | Retryable |
| --- | --- |
| `NOT_FOUND` | No |
| `NOT_SUPPORTED` | No |
| `ENCRYPTED` | No |
| `NO_DEFINITION` | No |
| `PERMISSION_DENIED` | Yes |
| `DATABASE_UNAVAILABLE` | Yes |
| `TOO_LARGE` | No |
| `EMPTY` | No |
| `BLOCKED` | Yes |
| `TIMEOUT` | Yes |
| `CONNECTION_LOST` | Yes |
| `UNREPRESENTABLE` | No |
| `SMO_ERROR` | Yes |
| `SQL_ERROR` | Yes |
| `AUTH_KERBEROS` | Yes |
| `AUTH_UNSUPPORTED` | Yes |
| `AUTH_ENTRA` | Yes |

## Limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `maxScriptChars` | 4,000,000 | Characters in a script; a longer one fails with `TOO_LARGE` |
| `maxDefinitionBytes` | 8,000,000 | Bytes of a module definition, checked before SMO reads it |
| `maxColumns` | 30,000 | Columns a SELECT, INSERT or UPDATE template lists |
| `maxParameters` | 2,100 | Parameters an EXECUTE or function SELECT template lists |
| `requestMs` | 60,000 | Main's deadline for one request, in ms |
| `budgetMs` | 55,000 | The backend's budget for one request, in ms; then `TIMEOUT` |
| `statementTimeoutS` | 30 | Timeout of each SMO statement, in seconds |
| `preflightTimeoutS` | 30 | Timeout of the preflight query, in seconds |
| `lockTimeoutMs` | 10,000 | `LOCK_TIMEOUT` of the scripting session, in ms; then `BLOCKED` |
| `gatePerConnection` | 2 | Requests scripting at once per server |
| `gateTotal` | 4 | Requests scripting at once in total |
| `registered` | 256 | Requests the backend tracks; more fail with `BUSY` |
| `tombstones` | 256 | Cancelled request ids remembered for requests that have not arrived yet |
| `tombstoneMs` | 60,000 | How long a cancelled request id is remembered, in ms |
| `cancelIds` | 64 | Request ids per cancellation |
| `rendererJobs` | 4 | Scripting operations a window runs at once |
| `statusDelayMs` | 300 | Delay before the status bar shows a running script, in ms |
| `noticeMs` | 4,000 | How long a notice stays in the status bar, in ms |
| `warningNoticeMs` | 8,000 | How long a warning notice stays, in ms |
| `warnings` | 8 | Warnings per result |
| `warningChars` | 512 | Characters in a warning |
| `messageChars` | 2,048 | Characters in an error message |
| `prefsBytes` | 16,384 | Bytes read from a legacy `scripting-options.json` when migrating to settings.json |
| `fileNameChars` | 200 | UTF-16 code units in a suggested file name |
