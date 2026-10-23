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

Icons are codicons, or `svg:` stroke icons drawn by `Icon.tsx`. Folders show `folder` (`folder-opened` while expanded).
Inserts is what dragging the node into a query or Copy Name produces; names are bracket-quoted with `]` doubled.

| Kind | Title | Scope | Icons | SMO | Scriptable | Inserts |
| --- | --- | --- | --- | --- | --- | --- |
| `server` | Server | `server` | `svg:server` | Server | No | — |
| `login` | Login | `serverObject` | `svg:login` | Login | Yes | `[name]` |
| `serverRole` | Server Role | `serverObject` | `svg:role` | ServerRole | Yes | `[name]` |
| `credential` | Credential | `serverObject` | `svg:key` | Credential | Yes | `[name]` |
| `cryptographicProvider` | Cryptographic Provider | `serverObject` | `circuit-board` | CryptographicProvider | Yes | `[name]` |
| `audit` | Audit | `serverObject` | `svg:shield` | Audit | Yes | `[name]` |
| `serverAuditSpecification` | Server Audit Specification | `serverObject` | `svg:shield` | ServerAuditSpecification | Yes | `[name]` |
| `backupDevice` | Backup Device | `serverObject` | `archive` | BackupDevice | Yes | `[name]` |
| `linkedServer` | Linked Server | `serverObject` | `remote` | LinkedServer | Yes | `[name]` |
| `serverTrigger` | Trigger | `serverObject` | `zap` | ServerDdlTrigger | Yes | `[name]` |
| `database` | Database | `database` | `svg:database`; `snapshot` → `device-camera` | Database | Yes | `[name]` |
| `user` | User | `databaseObject` | `person` | User | Yes | `[name]` |
| `databaseRole` | Database Role | `databaseObject` | `svg:role` | DatabaseRole | Yes | `[name]` |
| `applicationRole` | Application Role | `databaseObject` | `svg:role` | ApplicationRole | Yes | `[name]` |
| `schema` | Schema | `databaseObject` | `symbol-namespace` | Schema | Yes | `[name]` |
| `assembly` | Assembly | `databaseObject` | `package` | SqlAssembly | Yes | `[name]` |
| `asymmetricKey` | Asymmetric Key | `databaseObject` | `svg:key` | AsymmetricKey | Yes | `[name]` |
| `certificate` | Certificate | `databaseObject` | `workspace-trusted` | Certificate | Yes | `[name]` |
| `symmetricKey` | Symmetric Key | `databaseObject` | `svg:key` | SymmetricKey | Yes | `[name]` |
| `columnMasterKey` | Column Master Key | `databaseObject` | `svg:key` | ColumnMasterKey | Yes | `[name]` |
| `columnEncryptionKey` | Column Encryption Key | `databaseObject` | `svg:key` | ColumnEncryptionKey | Yes | `[name]` |
| `databaseAuditSpecification` | Database Audit Specification | `databaseObject` | `svg:shield` | DatabaseAuditSpecification | Yes | `[name]` |
| `databaseTrigger` | Trigger | `databaseObject` | `zap` | DatabaseDdlTrigger | Yes | `[name]` |
| `externalDataSource` | External Data Source | `databaseObject` | `cloud` | ExternalDataSource | Yes | `[name]` |
| `externalFileFormat` | External File Format | `databaseObject` | `file-code` | ExternalFileFormat | Yes | `[name]` |
| `fullTextCatalog` | Full-Text Catalog | `databaseObject` | `book` | FullTextCatalog | Yes | `[name]` |
| `fullTextStoplist` | Full-Text Stoplist | `databaseObject` | `circle-slash` | FullTextStopList | Yes | `[name]` |
| `partitionScheme` | Partition Scheme | `databaseObject` | `split-horizontal` | PartitionScheme | Yes | `[name]` |
| `partitionFunction` | Partition Function | `databaseObject` | `symbol-ruler` | PartitionFunction | Yes | `[name]` |
| `searchPropertyList` | Search Property List | `databaseObject` | `list-flat` | SearchPropertyList | Yes | `[name]` |
| `planGuide` | Plan Guide | `databaseObject` | `milestone` | PlanGuide | Yes | `[name]` |
| `table` | Table | `schemaObject` | `svg:table`; `history` → `history`; `ledgerHistory` → `history`; `updatableLedger` → `verified`; `appendOnlyLedger` → `verified`; `graphNode` → `type-hierarchy`; `graphEdge` → `git-compare`; `fileTable` → `file`; `external` → `cloud`; `droppedLedger` → `trash` | Table | Yes | `[schema].[name]` |
| `view` | View | `schemaObject` | `eye`; `ledger` → `verified`; `droppedLedger` → `trash` | View | Yes | `[schema].[name]` |
| `synonym` | Synonym | `schemaObject` | `link` | Synonym | Yes | `[schema].[name]` |
| `procedure` | Stored Procedure | `schemaObject` | `symbol-method` | StoredProcedure | Yes | `[schema].[name]` |
| `function` | Function | `schemaObject` | `symbol-function` | UserDefinedFunction; `aggregate` → UserDefinedAggregate | Yes | `[schema].[name]` |
| `sequence` | Sequence | `schemaObject` | `symbol-numeric` | Sequence | Yes | `[schema].[name]` |
| `type` | Type | `schemaObject` | `symbol-structure` | UserDefinedDataType; `clr` → UserDefinedType | Yes | `[schema].[name]` |
| `tableType` | Table Type | `schemaObject` | `svg:table` | UserDefinedTableType | Yes | `[schema].[name]` |
| `xmlSchemaCollection` | XML Schema Collection | `schemaObject` | `code` | XmlSchemaCollection | Yes | `[schema].[name]` |
| `rule` | Rule | `schemaObject` | `law` | Rule | Yes | `[schema].[name]` |
| `default` | Default | `schemaObject` | `symbol-constant` | Default | Yes | `[schema].[name]` |
| `securityPolicy` | Security Policy | `schemaObject` | `svg:shield` | SecurityPolicy | Yes | `[schema].[name]` |
| `column` | Column | `child` | `symbol-field`; `primaryKey` → `svg:key`; `foreignKey` → `references`; `computed` → `symbol-operator` | Column | No | `[name]` |
| `key` | Key | `child` | `svg:key`; `unique` → `symbol-key`; `foreign` → `references` | Index; `foreign` → ForeignKey | Yes | `[name]` |
| `constraint` | Constraint | `child` | `pass`; `default` → `symbol-constant`; `edge` → `link` | Check; `default` → DefaultConstraint; `edge` → EdgeConstraint | Yes | `[name]` |
| `trigger` | Trigger | `child` | `zap` | Trigger | Yes | `[name]` |
| `index` | Index | `child` | `list-ordered`; `clusteredColumnstore` → `layers`; `nonclusteredColumnstore` → `layers` | Index | Yes | `[name]` |
| `statistic` | Statistic | `child` | `graph` | Statistic | Yes | `[name]` |
| `parameter` | Parameter | `child` | `symbol-parameter` | Parameter | No | the name as is (`@name`) |
| `returnValue` | Return value | `childUnnamed` | `arrow-left` | — | No | — |
| `ssisCatalog` | Integration Services Catalog | `ssisCatalog` | `svg:database` | — | No | — |
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

An 8×8 badge at the bottom right of the row icon. Disabled, unavailable and inaccessible nodes are dimmed as well;
read-only databases are not, because their sublabel says it.

| Status | Badge |
| --- | --- |
| `disabled` | `arrow-small-down` |
| `unavailable` | `arrow-small-down` |
| `noAccess` | `circle-slash` |
| `error` | `error` |
| `loading` | `loading` |

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
| `indent` | 16 | Indentation per level, in px |
| `overscan` | 10 | Rows rendered beyond each edge of the viewport |
| `deleteSlice` | 10,000 | Nodes removed per task when a subtree is dropped |
| `cursorLength` | 1,650 | Characters in a page cursor |
| `label` | 300 | Characters in a node label |
| `sublabel` | 200 | Characters in a sublabel |
| `detail` | 512 | Characters in tooltip details |
| `message` | 512 | Characters in an error message |
| `maxName` | 260 | UTF-16 code units in the longest name a kind may declare; every other kind keeps 128 |
