# Object Explorer catalogue

<!-- Generated from src/shared/explorer/catalog.ts. Regenerate with: npx vitest run tests/explorer-catalog.test.ts -u -->

The tree Object Explorer serves, in SSMS order. Each folder lists its static subfolders first, then its rows. "Since" is
the first SQL Server version (ProductMajorVersion) that has a folder; older servers do not show it. Planned folders are
part of SSMS's tree but not served yet. Cloud editions (EngineEdition 5, 6, 9, 11 and 12) show only the folders marked
for them. A server whose catalog columns are newer than its reported version, such as Azure SQL Database or Managed
Instance (both report version 12), is treated as the version those columns belong to. The backend embeds the same data
as `backend/Varia.Backend/Explorer/explorer-catalog.json`.

## Server

The server row expands on connect; its folders stay collapsed.

| Folder | Id | Since | Cloud editions | Lists (query) | Filters |
| --- | --- | --- | --- | --- | --- |
| Databases | `databases` | — | Yes | Database (`userDatabases`) | Name, Owner, Creation Date |
| Databases › System Databases | `systemDatabases` | — | Yes | Database (`systemDatabases`) | — |
| Databases › Database Snapshots | `databaseSnapshots` | — | No | Database (`databaseSnapshots`) | Name, Creation Date |
| Security | `serverSecurity` | — | No | — | — |
| Security › Logins | `logins` | — | No | Login (`logins`) | Name, Creation Date |
| Security › Server Roles | `serverRoles` | — | No | Server Role (`serverRoles`) | Name |
| Security › Credentials | `credentials` | — | No | Credential (`credentials`) | Name |
| Security › Cryptographic Providers | `cryptographicProviders` | — | No | Cryptographic Provider (`cryptographicProviders`) | — |
| Security › Audits | `audits` | — | No | Audit (`audits`) | — |
| Security › Server Audit Specifications | `serverAuditSpecifications` | — | No | Server Audit Specification (`serverAuditSpecifications`) | — |
| Server Objects | `serverObjects` | — | No | — | — |
| Server Objects › Backup Devices | `backupDevices` | — | No | Backup Device (`backupDevices`) | — |
| Server Objects › Endpoints | — | — | — | Planned: System Endpoints, Database Mirroring, Service Broker, TSQL | — |
| Server Objects › Linked Servers | `linkedServers` | — | No | Linked Server (`linkedServers`) | Name |
| Server Objects › Linked Servers › Providers | — | — | — | Planned | — |
| Server Objects › Triggers | `serverTriggers` | — | No | Trigger (`serverTriggers`) | — |
| Replication | — | — | — | Planned | — |
| PolyBase | — | 2019 (15) | — | Planned | — |
| Always On High Availability | — | — | — | Planned | — |
| Management | — | — | — | Planned: Policy Management, Data Collection, Resource Governor, Extended Events, Maintenance Plans, SQL Server Logs, Database Mail, Distributed Transaction Coordinator, Legacy | — |
| Integration Services Catalogs | `integrationServicesCatalogs` | 2016 (13) | Yes | Integration Services Catalog (`ssisCatalogs`) | — |
| SQL Server Agent | — | — | — | Planned | — |
| XEvent Profiler | — | — | — | Planned | — |

## Database

A database expands only while it is online (or in emergency mode). Expanding one the login cannot open shows why on a row below it. Snapshots have the same folders.

| Folder | Id | Since | Cloud editions | Lists (query) | Filters |
| --- | --- | --- | --- | --- | --- |
| Database Diagrams | — | — | — | Planned | — |
| Tables | `tables` | — | Yes | Table (`tables`) | Name, Schema, Owner, Creation Date |
| Tables › System Tables | `systemTables` | — | Yes | Table (`systemTables`) | Name, Schema |
| Tables › FileTables | `fileTables` | — | Yes | Table (`fileTables`) | Name, Schema, Owner, Creation Date |
| Tables › External Tables | `externalTables` | 2016 (13) | Yes | Table (`externalTables`) | Name, Schema, Owner, Creation Date |
| Tables › Graph Tables | `graphTables` | 2017 (14) | Yes | Table (`graphTables`) | Name, Schema, Owner, Creation Date |
| Tables › Dropped Ledger Tables | `droppedLedgerTables` | 2022 (16) | Yes | Table (`droppedLedgerTables`) | Name, Schema |
| Views | `views` | — | Yes | View (`views`) | Name, Schema, Owner, Creation Date |
| Views › System Views | `systemViews` | — | Yes | View (`systemViews`) | Name, Schema |
| Views › Dropped Ledger Views | `droppedLedgerViews` | 2022 (16) | Yes | View (`droppedLedgerViews`) | Name, Schema |
| External Resources | `externalResources` | 2016 (13) | Yes | — | — |
| External Resources › External Data Sources | `externalDataSources` | 2016 (13) | Yes | External Data Source (`externalDataSources`) | Name |
| External Resources › External File Formats | `externalFileFormats` | 2016 (13) | Yes | External File Format (`externalFileFormats`) | Name |
| External Resources › External Libraries | — | — | — | Planned | — |
| External Resources › External Languages | — | — | — | Planned | — |
| External Resources › External Models | — | — | — | Planned | — |
| Synonyms | `synonyms` | — | Yes | Synonym (`synonyms`) | Name, Schema, Owner, Creation Date |
| Programmability | `programmability` | — | Yes | — | — |
| Programmability › Stored Procedures | `storedProcedures` | — | Yes | Stored Procedure (`procedures`) | Name, Schema, Owner, Creation Date |
| Programmability › Stored Procedures › System Stored Procedures | `systemStoredProcedures` | — | Yes | Stored Procedure (`systemProcedures`) | Name, Schema |
| Programmability › Functions | `functions` | — | Yes | — | — |
| Programmability › Functions › Table-valued Functions | `tableValuedFunctions` | — | Yes | Function (`tableValuedFunctions`) | Name, Schema, Owner, Creation Date |
| Programmability › Functions › Scalar-valued Functions | `scalarValuedFunctions` | — | Yes | Function (`scalarFunctions`) | Name, Schema, Owner, Creation Date |
| Programmability › Functions › Aggregate Functions | `aggregateFunctions` | — | Yes | Function (`aggregateFunctions`) | Name, Schema |
| Programmability › Functions › System Functions | — | — | — | Planned | — |
| Programmability › Database Triggers | `databaseTriggers` | — | Yes | Trigger (`databaseTriggers`) | Name |
| Programmability › Assemblies | `assemblies` | — | Yes | Assembly (`assemblies`) | Name, Owner, Creation Date |
| Programmability › Types | `types` | — | Yes | — | — |
| Programmability › Types › System Data Types | — | — | — | Planned | — |
| Programmability › Types › User-Defined Data Types | `userDefinedDataTypes` | — | Yes | Type (`aliasTypes`) | Name, Schema |
| Programmability › Types › User-Defined Table Types | `userDefinedTableTypes` | — | Yes | Table Type (`tableTypes`) | Name, Schema |
| Programmability › Types › User-Defined Types | `userDefinedTypes` | — | Yes | Type (`clrTypes`) | Name, Schema |
| Programmability › Types › XML Schema Collections | `xmlSchemaCollections` | — | Yes | XML Schema Collection (`xmlSchemaCollections`) | Name, Schema |
| Programmability › Rules | `rules` | — | Yes | Rule (`rules`) | Name, Schema |
| Programmability › Defaults | `defaults` | — | Yes | Default (`defaults`) | Name, Schema |
| Programmability › Plan Guides | `planGuides` | — | Yes | Plan Guide (`planGuides`) | Name |
| Programmability › Sequences | `sequences` | — | Yes | Sequence (`sequences`) | Name, Schema, Owner, Creation Date |
| Query Store | — | 2016 (13) | — | Planned | — |
| Service Broker | — | — | — | Planned | — |
| Storage | `storage` | — | Yes | — | — |
| Storage › Full Text Catalogs | `fullTextCatalogs` | — | Yes | Full-Text Catalog (`fullTextCatalogs`) | Name |
| Storage › Partition Schemes | `partitionSchemes` | — | Yes | Partition Scheme (`partitionSchemes`) | Name |
| Storage › Partition Functions | `partitionFunctions` | — | Yes | Partition Function (`partitionFunctions`) | Name, Creation Date |
| Storage › Full Text Stoplists | `fullTextStoplists` | — | Yes | Full-Text Stoplist (`fullTextStoplists`) | Name |
| Storage › Search Property Lists | `searchPropertyLists` | — | Yes | Search Property List (`searchPropertyLists`) | Name |
| Security | `databaseSecurity` | — | Yes | — | — |
| Security › Users | `users` | — | Yes | User (`users`) | Name, Creation Date |
| Security › Roles | `roles` | — | Yes | — | — |
| Security › Roles › Database Roles | `databaseRoles` | — | Yes | Database Role (`databaseRoles`) | Name, Owner |
| Security › Roles › Application Roles | `applicationRoles` | — | Yes | Application Role (`applicationRoles`) | Name |
| Security › Schemas | `schemas` | — | Yes | Schema (`schemas`) | Name, Owner |
| Security › Asymmetric Keys | `asymmetricKeys` | — | Yes | Asymmetric Key (`asymmetricKeys`) | Name |
| Security › Certificates | `certificates` | — | Yes | Certificate (`certificates`) | Name |
| Security › Symmetric Keys | `symmetricKeys` | — | Yes | Symmetric Key (`symmetricKeys`) | Name |
| Security › Always Encrypted Keys | `alwaysEncryptedKeys` | 2016 (13) | Yes | — | — |
| Security › Always Encrypted Keys › Column Master Keys | `columnMasterKeys` | 2016 (13) | Yes | Column Master Key (`columnMasterKeys`) | Name |
| Security › Always Encrypted Keys › Column Encryption Keys | `columnEncryptionKeys` | 2016 (13) | Yes | Column Encryption Key (`columnEncryptionKeys`) | Name |
| Security › Database Audit Specifications | `databaseAuditSpecifications` | — | Yes | Database Audit Specification (`databaseAuditSpecifications`) | Name |
| Security › Security Policies | `securityPolicies` | 2016 (13) | Yes | Security Policy (`securityPolicies`) | Name, Schema |
| Security › Database Scoped Credentials | — | 2016 (13) | — | Planned | — |

## Group by Schema

SSMS 2022's Group by Schema (Options › SQL Server Object Explorer › Commands, `objectExplorer.groupBySchema`, or the
toolbar's Group by Schema button) moves a database's schema-scoped folders below one row per schema. The database lists
the folders that stay below it, then its schemas (query `schemaGroups`): every schema but the fixed database roles'
ones, and `guest`, `INFORMATION_SCHEMA` and `sys` only while they hold an object. A schema row has the folders below,
listing that schema's objects by name alone (the row already says the schema). A folder below a schema row is filtered on
its own and offers every filter property of the folder but Schema. Children requests for a database and its folders say
that grouping is on (`groupBySchema`); a schema row and its folders are named by their schema, so they need not.
Search Objects' Reveal walks the grouped path while the option is on.

| Folder | Id | Shows below |
| --- | --- | --- |
| Tables | `tables` | A schema row |
| Tables › System Tables | `systemTables` | A schema row |
| Tables › FileTables | `fileTables` | A schema row |
| Tables › External Tables | `externalTables` | A schema row |
| Tables › Graph Tables | `graphTables` | A schema row |
| Tables › Dropped Ledger Tables | `droppedLedgerTables` | A schema row |
| Views | `views` | A schema row |
| Views › System Views | `systemViews` | A schema row |
| Views › Dropped Ledger Views | `droppedLedgerViews` | A schema row |
| Synonyms | `synonyms` | A schema row |
| Programmability | `programmability` | A schema row and the database |
| Programmability › Stored Procedures | `storedProcedures` | A schema row |
| Programmability › Stored Procedures › System Stored Procedures | `systemStoredProcedures` | A schema row |
| Programmability › Functions | `functions` | A schema row |
| Programmability › Functions › Table-valued Functions | `tableValuedFunctions` | A schema row |
| Programmability › Functions › Scalar-valued Functions | `scalarValuedFunctions` | A schema row |
| Programmability › Functions › Aggregate Functions | `aggregateFunctions` | A schema row |
| Programmability › Database Triggers | `databaseTriggers` | The database |
| Programmability › Assemblies | `assemblies` | The database |
| Programmability › Types | `types` | A schema row |
| Programmability › Types › User-Defined Data Types | `userDefinedDataTypes` | A schema row |
| Programmability › Types › User-Defined Table Types | `userDefinedTableTypes` | A schema row |
| Programmability › Types › User-Defined Types | `userDefinedTypes` | A schema row |
| Programmability › Types › XML Schema Collections | `xmlSchemaCollections` | A schema row |
| Programmability › Rules | `rules` | A schema row |
| Programmability › Defaults | `defaults` | A schema row |
| Programmability › Plan Guides | `planGuides` | The database |
| Programmability › Sequences | `sequences` | A schema row |

The folders that move are those below Tables, Views, Synonyms, Programmability; every other database folder stays below the database.

## Object children

Child folders list their rows by name, except Columns and Parameters, which keep the object's order, and an SSIS project's Packages,
which list in deployment order (`package_id`: a package name can be longer than a sysname cursor key). Every other kind is a leaf.

| Kind | Subtypes | Children |
| --- | --- | --- |
| `table` | none, `appendOnlyLedger`, `graphNode`, `graphEdge`, `fileTable`, `system` | Columns, Keys, Constraints, Triggers, Indexes, Statistics |
| `table` | `systemVersioned`, `updatableLedger` | Its history table first, then Columns, Keys, Constraints, Triggers, Indexes, Statistics |
| `table` | `history`, `ledgerHistory`, `droppedLedger` | Columns, Indexes, Statistics |
| `table` | `external` | Columns, Statistics |
| `view` | none, `system`, `ledger`, `droppedLedger` | Columns, Triggers, Indexes, Statistics |
| `procedure` | none, `sql`, `clr`, `extended`, `replicationFilter`, `system` | Parameters |
| `function` | none, `scalar`, `clrScalar`, `aggregate` | Parameters |
| `function` | `inline`, `tableValued`, `clrTableValued` | Columns, Parameters |
| `tableType` | any | Columns, Keys, Constraints, Indexes |
| `ssisCatalog` | any | Folder rows (`ssisFolders`) |
| `ssisFolder` | any | Projects, Environments |
| `ssisProject` | any | Packages |

| Folder | Id | Below | Lists (query) |
| --- | --- | --- | --- |
| Columns | `columns` | `table`, `view`, `function`, `tableType` | Column (`columns`) |
| Keys | `keys` | `table`, `tableType` | Key (`keys`) |
| Constraints | `constraints` | `table`, `tableType` | Constraint (`constraints`) |
| Triggers | `tableTriggers` | `table`, `view` | Trigger (`tableTriggers`) |
| Indexes | `indexes` | `table`, `view`, `tableType` | Index (`indexes`) |
| Statistics | `statistics` | `table`, `view` | Statistic (`statistics`) |
| Parameters | `parameters` | `procedure`, `function` | Parameter, Return value (`parameters`) |
| Projects | `ssisProjects` | `ssisFolder` | Project (`ssisProjects`) |
| Environments | `ssisEnvironments` | `ssisFolder` | Environment (`ssisEnvironments`) |
| Packages | `ssisPackages` | `ssisProject` | Package (`ssisPackages`) |

## Node kinds (56)

Icons are ids of the [icon registry](icons.md): Varia's own stroke icons or codicons. Folders show `folder` (`folder-opened` while expanded).
Inserts is what dragging the node into a query or Copy Name produces; names are bracket-quoted with `]` doubled.

| Kind | Title | Scope | Icons | SMO | Scriptable | Inserts |
| --- | --- | --- | --- | --- | --- | --- |
| `server` | Server | `server` | `server` | Server | No | — |
| `login` | Login | `serverObject` | `login` | Login | Yes | `[name]` |
| `serverRole` | Server Role | `serverObject` | `role` | ServerRole | Yes | `[name]` |
| `credential` | Credential | `serverObject` | `key` | Credential | Yes | `[name]` |
| `cryptographicProvider` | Cryptographic Provider | `serverObject` | `circuit-board` | CryptographicProvider | Yes | `[name]` |
| `audit` | Audit | `serverObject` | `shield` | Audit | Yes | `[name]` |
| `serverAuditSpecification` | Server Audit Specification | `serverObject` | `shield` | ServerAuditSpecification | Yes | `[name]` |
| `backupDevice` | Backup Device | `serverObject` | `archive` | BackupDevice | Yes | `[name]` |
| `linkedServer` | Linked Server | `serverObject` | `remote` | LinkedServer | Yes | `[name]` |
| `serverTrigger` | Trigger | `serverObject` | `zap` | ServerDdlTrigger | Yes | `[name]` |
| `database` | Database | `database` | `database`; `snapshot` → `device-camera` | Database | Yes | `[name]` |
| `user` | User | `databaseObject` | `person` | User | Yes | `[name]` |
| `databaseRole` | Database Role | `databaseObject` | `role` | DatabaseRole | Yes | `[name]` |
| `applicationRole` | Application Role | `databaseObject` | `role` | ApplicationRole | Yes | `[name]` |
| `schema` | Schema | `databaseObject` | `symbol-namespace` | Schema | Yes | `[name]` |
| `assembly` | Assembly | `databaseObject` | `package` | SqlAssembly | Yes | `[name]` |
| `asymmetricKey` | Asymmetric Key | `databaseObject` | `key` | AsymmetricKey | Yes | `[name]` |
| `certificate` | Certificate | `databaseObject` | `workspace-trusted` | Certificate | Yes | `[name]` |
| `symmetricKey` | Symmetric Key | `databaseObject` | `key` | SymmetricKey | Yes | `[name]` |
| `columnMasterKey` | Column Master Key | `databaseObject` | `key` | ColumnMasterKey | Yes | `[name]` |
| `columnEncryptionKey` | Column Encryption Key | `databaseObject` | `key` | ColumnEncryptionKey | Yes | `[name]` |
| `databaseAuditSpecification` | Database Audit Specification | `databaseObject` | `shield` | DatabaseAuditSpecification | Yes | `[name]` |
| `databaseTrigger` | Trigger | `databaseObject` | `zap` | DatabaseDdlTrigger | Yes | `[name]` |
| `externalDataSource` | External Data Source | `databaseObject` | `cloud` | ExternalDataSource | Yes | `[name]` |
| `externalFileFormat` | External File Format | `databaseObject` | `file-code` | ExternalFileFormat | Yes | `[name]` |
| `fullTextCatalog` | Full-Text Catalog | `databaseObject` | `book` | FullTextCatalog | Yes | `[name]` |
| `fullTextStoplist` | Full-Text Stoplist | `databaseObject` | `circle-slash` | FullTextStopList | Yes | `[name]` |
| `partitionScheme` | Partition Scheme | `databaseObject` | `split-horizontal` | PartitionScheme | Yes | `[name]` |
| `partitionFunction` | Partition Function | `databaseObject` | `symbol-ruler` | PartitionFunction | Yes | `[name]` |
| `searchPropertyList` | Search Property List | `databaseObject` | `list-flat` | SearchPropertyList | Yes | `[name]` |
| `planGuide` | Plan Guide | `databaseObject` | `milestone` | PlanGuide | Yes | `[name]` |
| `table` | Table | `schemaObject` | `table`; `history` → `history`; `ledgerHistory` → `history`; `updatableLedger` → `verified`; `appendOnlyLedger` → `verified`; `graphNode` → `type-hierarchy`; `graphEdge` → `git-compare`; `fileTable` → `file`; `external` → `cloud`; `droppedLedger` → `trash` | Table | Yes | `[schema].[name]` |
| `view` | View | `schemaObject` | `view`; `ledger` → `verified`; `droppedLedger` → `trash` | View | Yes | `[schema].[name]` |
| `synonym` | Synonym | `schemaObject` | `link` | Synonym | Yes | `[schema].[name]` |
| `procedure` | Stored Procedure | `schemaObject` | `procedure` | StoredProcedure | Yes | `[schema].[name]` |
| `function` | Function | `schemaObject` | `symbol-function` | UserDefinedFunction; `aggregate` → UserDefinedAggregate | Yes | `[schema].[name]` |
| `sequence` | Sequence | `schemaObject` | `symbol-numeric` | Sequence | Yes | `[schema].[name]` |
| `type` | Type | `schemaObject` | `symbol-structure` | UserDefinedDataType; `clr` → UserDefinedType | Yes | `[schema].[name]` |
| `tableType` | Table Type | `schemaObject` | `table` | UserDefinedTableType | Yes | `[schema].[name]` |
| `xmlSchemaCollection` | XML Schema Collection | `schemaObject` | `code` | XmlSchemaCollection | Yes | `[schema].[name]` |
| `rule` | Rule | `schemaObject` | `law` | Rule | Yes | `[schema].[name]` |
| `default` | Default | `schemaObject` | `symbol-constant` | Default | Yes | `[schema].[name]` |
| `securityPolicy` | Security Policy | `schemaObject` | `shield` | SecurityPolicy | Yes | `[schema].[name]` |
| `column` | Column | `child` | `symbol-field`; `primaryKey` → `key`; `foreignKey` → `references`; `computed` → `symbol-operator` | Column | No | `[name]` |
| `key` | Key | `child` | `key`; `unique` → `symbol-key`; `foreign` → `references` | Index; `foreign` → ForeignKey | Yes | `[name]` |
| `constraint` | Constraint | `child` | `pass`; `default` → `symbol-constant`; `edge` → `link` | Check; `default` → DefaultConstraint; `edge` → EdgeConstraint | Yes | `[name]` |
| `trigger` | Trigger | `child` | `zap` | Trigger | Yes | `[name]` |
| `index` | Index | `child` | `list-ordered`; `clusteredColumnstore` → `layers`; `nonclusteredColumnstore` → `layers` | Index | Yes | `[name]` |
| `statistic` | Statistic | `child` | `graph` | Statistic | Yes | `[name]` |
| `parameter` | Parameter | `child` | `symbol-parameter` | Parameter | No | the name as is (`@name`) |
| `returnValue` | Return value | `childUnnamed` | `arrow-left` | — | No | — |
| `ssisCatalog` | Integration Services Catalog | `ssisCatalog` | `database` | — | No | — |
| `ssisFolder` | Folder | `ssisFolder` | `folder-library` | — | No | — |
| `ssisProject` | Project | `ssisFolderObject` | `project` | — | No | — |
| `ssisPackage` | Package | `ssisProjectObject` | `package`; `child` → `symbol-file` | — | No | — |
| `ssisEnvironment` | Environment | `ssisFolderObject` | `symbol-variable` | — | No | — |

## Node identity

A node is an object ref, or a folder below its nearest object (the server, a database, or a parent object). Refs carry
names, never paths or object ids, and each scope fixes which fields a ref has. Names are 1 to 128 UTF-16 code units,
used verbatim (never trimmed), without U+0000; a kind may allow a longer name of its own, up to 260, if it
owns no folders, history row or rows (those name their owner as a sysname, so the backend refuses such a catalogue).
SSIS Catalog objects carry their folder (`ssisFolder`) and project (`ssisProject`) by name instead of a database.

| Scope | Requires | Forbids | Kinds |
| --- | --- | --- | --- |
| `server` | — | `database`, `schema`, `name`, `parent`, `ssisFolder`, `ssisProject` | `server` |
| `serverObject` | `name` | `database`, `schema`, `parent`, `ssisFolder`, `ssisProject` | `login`, `serverRole`, `credential`, `cryptographicProvider`, `audit`, `serverAuditSpecification`, `backupDevice`, `linkedServer`, `serverTrigger` |
| `database` | `name` | `database`, `schema`, `parent`, `ssisFolder`, `ssisProject` | `database` |
| `databaseObject` | `database`, `name` | `schema`, `parent`, `ssisFolder`, `ssisProject` | `user`, `databaseRole`, `applicationRole`, `schema`, `assembly`, `asymmetricKey`, `certificate`, `symmetricKey`, `columnMasterKey`, `columnEncryptionKey`, `databaseAuditSpecification`, `databaseTrigger`, `externalDataSource`, `externalFileFormat`, `fullTextCatalog`, `fullTextStoplist`, `partitionScheme`, `partitionFunction`, `searchPropertyList`, `planGuide` |
| `schemaObject` | `database`, `schema`, `name` | `parent`, `ssisFolder`, `ssisProject` | `table`, `view`, `synonym`, `procedure`, `function`, `sequence`, `type`, `tableType`, `xmlSchemaCollection`, `rule`, `default`, `securityPolicy` |
| `child` | `database`, `parent`, `name` | `schema`, `ssisFolder`, `ssisProject` | `column`, `key`, `constraint`, `trigger`, `index`, `statistic`, `parameter` |
| `childUnnamed` | `database`, `parent` | `schema`, `name`, `ssisFolder`, `ssisProject` | `returnValue` |
| `ssisCatalog` | `name` | `database`, `schema`, `parent`, `ssisFolder`, `ssisProject` | `ssisCatalog` |
| `ssisFolder` | `name` | `database`, `schema`, `parent`, `ssisFolder`, `ssisProject` | `ssisFolder` |
| `ssisFolderObject` | `ssisFolder`, `name` | `database`, `schema`, `parent`, `ssisProject` | `ssisProject`, `ssisEnvironment` |
| `ssisProjectObject` | `ssisFolder`, `ssisProject`, `name` | `database`, `schema`, `parent` | `ssisPackage` |

| Child kind | Parent kinds |
| --- | --- |
| `column` | `table`, `view`, `tableType`, `function` |
| `key` | `table`, `tableType` |
| `constraint` | `table`, `tableType` |
| `trigger` | `table`, `view` |
| `index` | `table`, `view`, `tableType` |
| `statistic` | `table`, `view` |
| `parameter` | `procedure`, `function` |
| `returnValue` | `procedure`, `function` |

## Status badges

A 9 px badge (`--varia-glyph-badge`) at the bottom right of the row icon.
Disabled, unavailable and inaccessible nodes are dimmed as well; read-only databases are not, because their sublabel says it.
The badge is red (`errorForeground`) for a disabled node and an error, amber (`warningForeground`) for `noAccess` (a database
the current login cannot open, a login denied permission to connect), grey (`disabledForeground`) for an unavailable
database and a lost server, and the icon's colour while loading. It sits on a disc of the row's own fill, hovered and
selected included, so the icon under it does not show through.

| Status | Badge |
| --- | --- |
| `disabled` | `arrow-small-down` |
| `unavailable` | `arrow-small-down` |
| `noAccess` | `circle-slash` |
| `error` | `error` |
| `loading` | `loading` |

## Login status

Security › Logins reads catalog views only (`sys.server_principals`, `sys.server_permissions` and `sys.sql_logins`), never
`LOGINPROPERTY`, which waits for another session's open `ALTER LOGIN` whatever the isolation level. A disabled login is
`disabled`; otherwise one denied permission to connect (`DENY CONNECT SQL`) is `noAccess`. They keep apart, with their own
badge and chip, because they are lifted apart: Enable leaves a denial in place. A login that is both keeps the `disabled`
status and badge, and the listing also sends `connectDenied`, so its row shows both chips and says both, the denial first:
a narrow pane shows only the first chip, and the badge already says Disabled. The chips are static, from the listing (no
probe), and their words join the row's accessible name ("sa, Disabled"; "x, Permission to connect denied, Disabled");
their sentences are the tooltip's state. Beside them the name stays whole up to 65 % of the row, and the chips give way
first, each ending in an ellipsis, down to none. A row's subtype
comes from `src/shared/actions/logins.ts`: `sa` by principal_id 1 whatever its name, `system` for SQL Server's own `##…##`
logins, else by type. Its tooltip names its kind, then Disabled and Permission to connect denied (both when both apply),
then "Password policy enforced" and "Password expiration enforced" for a SQL login whose policy flags are on.
Lock-out, expiry and must-change are not shown: only LOGINPROPERTY knows them.
The live Logins listing checks (`LoginListingLiveChecks.cs`, with `VARIA_TEST_SQL_SCRATCH=1`) create a scratch login
(`VariaScratch_…`), take it through disabled, denied permission to connect, both, and password policy and expiration
enforced, and list it while another session holds an uncommitted `ALTER LOGIN … DISABLE` on it, then drop it;
`--login-listing-live` runs only them.

| Type | Subtype | Kind in the tooltip |
| --- | --- | --- |
| `S` | `sql` | SQL Server authentication |
| `U` | `windowsUser` | Windows user |
| `G` | `windowsGroup` | Windows group |
| `C` | `certificateMapped` | Mapped to certificate |
| `K` | `asymmetricKeyMapped` | Mapped to asymmetric key |
| `E` | `externalUser` | Microsoft Entra user or application |
| `X` | `externalGroup` | Microsoft Entra group |

| Status | Chip | Tone | Words | Tooltip |
| --- | --- | --- | --- | --- |
| `disabled` | DISABLED | neutral | Disabled | The login is disabled: new connections are refused; open sessions continue. |
| `noAccess` | CONNECT DENIED | warning | Permission to connect denied | CONNECT SQL is denied: the login cannot connect. |

## Live status

While Object Explorer shows (and Environment › Live Data › Show live status in Object Explorer is on), each connected
server has one background live view of the `explorer` source ([docs/live.md](live.md)) per login, shared by every
connection to that server with that login, on one session of its own in master (so it never holds the database a
connection opened in; a contained database user's, or one whose server profile the connect could not read, stays in the
connection's database), paused while the pane or the window is hidden. Its samples become chips at the end of the rows
below; they never reload the tree. While chips show, a database row's state comes from them rather than its sublabel
(the state when the list loaded), and its tooltip says when the two differ. A probe that fails, is unavailable (no
permission, or an edition without the feature) or has no sample yet shows nothing, and the row shows its sublabel again;
so does a database past the 1,000 the probe lists, by name. A running-tone chip turns its glyph only while a restore or
recovery reports progress. Refresh (F5) samples the view at once and opens again one that ended (a sign-in that
failed). A window runs at most 8 such views and gives their slots to views the user opens, when the window's 16 are
taken or the backend refuses one at its 8 a server ([docs/ipc.md](ipc.md#live-subscriptions)), so a server can be
without chips until a slot frees. The chips are the only part of a row's end that gives way: the environment tag, item
count and connection dot keep their size, and the label gives up the row's empty space first.

| Kind | Probes |
| --- | --- |
| `server` | `explorer.agent`, `explorer.availability` |
| `database` | `explorer.databases`, `explorer.progress` |

| Node | Chip | Tone | When |
| --- | --- | --- | --- |
| database | RESTORING n % | running | state 1: The database is being restored, or waits for more backups to restore (WITH NORECOVERY). |
| database | RECOVERING n % | running | state 2: The database is recovering. It comes online when recovery ends. |
| database | RECOVERY PENDING | critical | state 3: Recovery could not start (a file or resource is missing). The database is not available. |
| database | SUSPECT | critical | state 4: Recovery failed: the database may be damaged and is not available. |
| database | EMERGENCY | critical | state 5: The database is in emergency mode: read-only, single user, for members of sysadmin. |
| database | OFFLINE | warning | state 6 or 10: The database is offline. Bring it online to use it. |
| database | COPYING | running | state 7: The database is being copied (Azure SQL Database copy). |
| database | READ-ONLY / STANDBY | warning | is_read_only, or is_in_standby (a log-shipping standby) |
| database | SINGLE USER / RESTRICTED USER | warning | user_access 1 or 2 |
| server | n Agent jobs running | running | SQL Server Agent jobs of its current session that started and have not stopped (none while none runs) |
| server | <group> healthy / partially healthy / not healthy | success, warning, critical | the least healthy availability group (several: "n AGs …"); its tooltip names each group with its health and this replica's role |

## Peek

Peek (the context menu's Peek, Space on the selected row, or resting the pointer on a row with Ctrl held, Cmd on macOS)
opens a card beside the row with the object's definition and its properties. One `explorer.peek` request reads the
properties (and a module's text) on the Object Explorer pool, in one constant batch per kind (`Explorer/PeekSql.cs`)
within 15,000 ms; the definition of a kind without stored text comes from Script As (CREATE). A fact whose
catalog column is newer than the server is left out. Esc, a click elsewhere or another peek closes the card, and
cancels a read still running. Each kind declares its tabs in the catalogue (`peekSpecs`), and the card shows exactly those.
Properties sit beside the definition; a card or tab narrower than 560px (a slim popped-out Object Explorer) stacks them
under it, so the editor of the definition always has room.

Database-scoped kinds are read in their database, as the tree reads them; a database, a login and a server trigger on the
server (sys.databases and sys.master_files, so an offline or restoring database still peeks). An index or a trigger is found
below its table or view. Some kinds have lists, read in the same batch as their facts and shown on tabs of their own, at most
1,024 rows each: an index's key and included columns, a trigger's events, a database's files, a login's server roles,
and its user mapping, read after the batch in each database the login may enter (at most 256, in name order), through
`QUOTENAME` as every database statement is, on the same connection; a database it cannot read is counted, not shown. Nothing
reads LOGINPROPERTY or a password hash. An index's usage comes from `sys.dm_db_index_usage_stats` in a statement of its own,
last in the batch, inside TRY…CATCH: a login without VIEW SERVER STATE gets the other facts and the card says why usage is missing.

| List | Kinds | Columns |
| --- | --- | --- |
| Columns | `index` | Column, Included, Descending, Type |
| Events | `trigger`, `databaseTrigger`, `serverTrigger` | Event, First, Last |
| Files | `database` | Logical name, Type, Size, Autogrowth / Maxsize, Path |
| Server roles | `login` | Role, Fixed role |
| User mapping | `login` | Database, User, Default schema |

**Definition** shows the text in the query editor itself (`createQueryEditor`, read-only), so Tools › Options, the theme
and Find reach it as they reach a query, and so will editor features added later. Each card or tab has one editor, and each
definition a model of its own carrying the view's connection and database (`peekModelContext`, for SQL language features
to read once they serve Peek; today they serve query documents only), disposed as soon as the view shows another object, goes Back or
refreshes; closing the card or tab disposes the editor. Its focus key is `peekEditorFocus`, never `editorFocus`, so query
commands (Execute, Parse and the rest) leave it alone, and F5 refreshes the Peek; Find, Copy and Select All are Monaco's
own. **Script to New Query** and, for a kind that offers it, **Modify** open the definition in a query tab through Script As.
A definition is never cut. A module's text comes in pages of 1,000,000 characters: the first with the
properties, the rest one page at a time (`explorer.peekDefinition`), and the tab shows the text once it has all of it. If the
module changes between pages, the tab says so and Refresh reads it again. While the pages come, the tab says how much has
come. Closing the card cancels the page still being read.
Only a text longer than 134,217,728 characters, the most Peek holds in memory, is not read:
the tab says so rather than showing part of it.

Beside Definition, the card has tabs. **Columns** (tables and views) or **Parameters** (procedures and functions) lists the
object's folder with `explorer.children`, as the tree does, up to 1,024 rows. **Dependencies**
(`explorer.peekDependencies`) lists what the object references (`sys.sql_expression_dependencies`, other databases and
linked servers included) and the tables its foreign keys point at, and what references it or points at it by a foreign key,
at most 200 each way in name order. It is its own request because reading `sys.sql_expression_dependencies`
takes more than VIEW DEFINITION (db_owner by default): a login refused it still sees the properties, and the tab says why. A
reference SQL Server resolved to an object in this database shows without a server or database, however the code spelled
them (the database in another case, or the local server's own name), so one made several ways lists once. A
dependency in the same database of a kind Peek describes opens in the same card, beside the same row, and Back returns.
Every tab but Definition is read the first time it is chosen, and again (or by Retry) when it is chosen after failing; the
arrow keys move between tabs without choosing them, and Enter or Space chooses. **Top rows** (tables and views) runs Select
Top N Rows' own script with N = 10 (the columns from `tables.columns`, as Select Top 1000 Rows lists them) through
`query.execute`, as a query tab runs it, and shows the rows in the results grid, where selection, Copy, Save Results As and
Open Value work as in a query's results. The run has a session of its own, which closes as soon as the run ends (the backend
keeps its results until they are released), and a results entry of its own, which is released when the card or tab closes,
shows another object or refreshes, and when the server or the backend is lost.

Open Peek as Tab (the card's button, Ctrl+Enter in the card or the tree, or Ctrl+click on a row, Cmd on macOS) shows the
same parts in a document tab with more room, with Refresh, Script As… and, for a kind that has one, the Properties dialog. A
tab owns its reads and its Top rows run as the card does; closing it releases them.

| Kind | Definition | Tabs |
| --- | --- | --- |
| `table` | Script As | Definition, Columns, Dependencies, Top rows |
| `view` | sys.sql_modules | Definition, Columns, Dependencies, Top rows |
| `procedure` | sys.sql_modules | Definition, Parameters, Dependencies |
| `function` | sys.sql_modules | Definition, Parameters, Dependencies |
| `index` | Script As | Definition, Columns |
| `trigger` | sys.sql_modules | Definition, Events, Dependencies |
| `databaseTrigger` | sys.sql_modules | Definition, Events |
| `serverTrigger` | sys.server_sql_modules | Definition, Events |
| `database` | Script As | Definition, Files |
| `login` | Script As | Definition, Server roles, User mapping |
| `synonym` | Script As | Definition, Dependencies |
| `sequence` | Script As | Definition, Dependencies |
| `type` | Script As | Definition, Dependencies |
| `tableType` | Script As | Definition, Columns, Dependencies |

| Kind | Group | Facts |
| --- | --- | --- |
| `table` | General | Schema, Created, Last modified, System object, Replicated, Lock escalation, Memory optimized, Temporal (band 13+), Ledger (band 16+) |
| `table` | Storage | Row count, Data space, Index space, Filegroup, Text filegroup, Partitioned, Data compression |
| `view` | General | Schema, Created, Last modified, System object |
| `view` | Options | Schema bound, Indexed, ANSI NULLs, Quoted identifier |
| `procedure` | General | Schema, Created, Last modified, System object |
| `procedure` | Options | Execute as, Recompile, Natively compiled, ANSI NULLs, Quoted identifier |
| `function` | General | Schema, Created, Last modified, System object, Function type |
| `function` | Options | Execute as, Schema bound, Natively compiled, Returns NULL on NULL input, ANSI NULLs, Quoted identifier |
| `index` | General | Index type, Unique, Primary key, Unique constraint, Disabled, Filter |
| `index` | Options | Fill factor, Pad index, Ignore duplicate values, Allow row locks, Allow page locks, Statistics not recomputed, Optimize for sequential key (band 15+) |
| `index` | Storage | Row count, Space used, Filegroup, Partition scheme, Partitions, Data compression |
| `index` | Usage since the server started (may be refused) | User seeks, User scans, User lookups, User updates, Last seek, Last scan, Last lookup, Last update |
| `trigger` | General | Created, Last modified, System object, Disabled, CLR, Instead of |
| `trigger` | Options | Not for replication, Execute as, ANSI NULLs, Quoted identifier |
| `databaseTrigger` | General | Created, Last modified, System object, Disabled, CLR |
| `databaseTrigger` | Options | Execute as, ANSI NULLs, Quoted identifier |
| `serverTrigger` | General | Created, Last modified, System object, Disabled, CLR |
| `serverTrigger` | Options | Execute as, ANSI NULLs, Quoted identifier |
| `database` | General | Status, Owner, Date created, Size, Data files, Log files, Restrict access, Read only |
| `database` | Options | Recovery model, Compatibility level, Collation, Containment type, Page verify, Auto close, Auto shrink, Auto create statistics, Auto update statistics, Auto update statistics asynchronously, Snapshot isolation, Read committed snapshot, Encryption enabled, Query Store (band 13+), Accelerated database recovery (band 15+), Ledger (band 16+) |
| `login` | General | Login type, Created, Last modified, Default database, Default language |
| `login` | Status | Disabled, Connect denied, Enforce password policy, Enforce password expiration |
| `synonym` | General | Schema, Created, Last modified, System object |
| `synonym` | Base object | Base object, Server, Database, Object schema, Object name |
| `sequence` | General | Schema, Created, Last modified, System object |
| `sequence` | Sequence | Data type, Start value, Increment by, Minimum value, Maximum value, Cycle, Cache, Current value, Last used value (band 14+), Exhausted |
| `type` | General | Schema, Allow NULLs, Bytes |
| `type` | Alias type (alias) | Data type, Collation, Default, Rule |
| `type` | CLR type (clr) | Assembly, Class, Binary ordered, Fixed length |
| `tableType` | General | Schema, Created, Last modified, Memory optimized |

## Limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `pageSize` | 2,000 | Rows per page, and the largest page a request may ask for |
| `folderCap` | 100,000 | Children a folder loads before it stops and suggests a filter |
| `nodeBudget` | 250,000 | Nodes held in the renderer before collapsed folders are evicted |
| `inFlightPerConnection` | 4 | Loads in flight per server (renderer and backend) |
| `inFlightTotal` | 8 | Loads in flight in total (renderer and backend) |
| `queuePerConnection` | 512 | Queued loads per server |
| `cancelBatch` | 256 | Request ids per cancellation |
| `siblingLoads` | 50 | Folders `*` (expand siblings) loads at once |
| `filters` | 64 | Filtered folders remembered per session |
| `watchdogMs` | 60,000 | Renderer timeout of one load, in ms |
| `loadingRowDelayMs` | 150 | Delay before a "Loading…" row appears, in ms |
| `typeAheadMs` | 1,000 | Type-ahead buffer reset, in ms |
| `typeAheadMax` | 64 | Type-ahead buffer length |
| `rowHeight` | 22 | Row height, in px |
| `serverRowHeight` | 30 | Height of a server row, in px |
| `indent` | 16 | Indentation per level, in px |
| `overscan` | 10 | Rows rendered beyond each edge of the viewport |
| `deleteSlice` | 10,000 | Nodes removed per task when a subtree is dropped |
| `cursorLength` | 1,650 | Characters in a page cursor |
| `label` | 300 | Characters in a node label |
| `sublabel` | 200 | Characters in a sublabel |
| `detail` | 512 | Characters in tooltip details |
| `message` | 512 | Characters in an error message |
| `maxName` | 260 | UTF-16 code units in the longest name a kind may declare; every other kind keeps 128 |
