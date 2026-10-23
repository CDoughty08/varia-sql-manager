# Integration Services (SSIS Catalog)

Object Explorer shows the SSIS Catalog (`SSISDB`) read-only: its folders, projects, packages and environments, kept current
while SSISDB is open by a live catalog probe (The live tree, below), and `ssis.describe` reads each of them for the
properties documents that follow. Nothing in Varia changes the catalog yet.
This page records what is known about the catalog that the SSIS work builds on, how it was found out, and the test
fixtures that stand in for a catalog where there is none; its last part, generated from `src/shared/ssis/catalog.ts`,
is the reference for the tree, the reads, the catalog's code tables and the limits. The design is D-ssis (wave 4).

## Fixtures

Everything is in `tests/fixtures/ssisdb/`:

| File | What it is | How it changes |
| --- | --- | --- |
| `manifest.json` | The catalog's shape per SQL Server band: every `catalog` view's columns, every `catalog` procedure's and function's parameters, the `internal` tables' identities, indexes and foreign keys, the procedures that refuse SQL Server authentication, SSISDB's SSIS-to-SQL type map, the catalog's error texts, and, for the record only, where it was read, the database settings and the catalog properties | Rewritten by the .NET checks with `VARIA_TEST_SQL_SCRATCH=1 VARIA_TEST_SSIS=1 VARIA_UPDATE_SSIS_MANIFEST=1` (from `SSISDB` when it exists, otherwise from the catalog backup); never by hand |
| `schema.sql` | The fake catalog's tables, one per catalog view, with the view's columns, types and nullability, identities where the view reads its internal table's identity, and that table's indexes | Generated from the newest manifest entry: `npx vitest run tests/ssisdb-fixtures.test.ts -u` |
| `procedures.sql` | The fake's procedures: stubs of `create_execution`, `set_execution_parameter_value`, `start_execution` and `stop_operation` with the real signatures, refusals and error numbers, and the fake's own `varia_fake_seed`, `varia_fake_run` and `varia_fake_finish` | By hand; the checks below keep it honest |
| `probe.sql` | The read-only probe for a person to run against a real catalog (`sqlcmd -S <server> -E -C -v CatalogDatabase=SSISDB -i tests/fixtures/ssisdb/probe.sql`). It changes nothing, and unlike Varia's own SQL it uses metadata built-ins | By hand |

The fake catalog is a marked scratch database, `VariaScratch_…_ssis`, that the .NET checks create from `schema.sql` and
`procedures.sql` with `VARIA_TEST_SQL_SCRATCH=1` (CI's Linux job included) and drop when they finish. It has no
row-level security, no `internal` schema and no CLR, and nothing in it runs a package: `start_execution` moves an
execution to Running and `varia_fake_finish` ends it as the package runner would. `catalog.event_messages` is a view of
`operation_messages` LEFT JOIN the fake's `varia_event_messages`, as the real view joins `internal.event_messages`, so
a message whose event row is not there yet, or an operation-only message, reads with NULL event columns there as it
does in a real catalog (14.3). The fake has the catalog's `ssis_admin` and `ssis_logreader` roles. Later SSIS work
points the backend at it through an internal test option, never a request field. Checks against it never claim real
SSIS behaviour.

The fake has no `internal` schema, so `SsisProfile` finds its features in the catalog's views instead, which the fake
has as tables with the manifest's columns: `eventMessageGuid` is `catalog.event_messages.event_message_guid` and
`executedCount` is `catalog.executions.executed_count` (D-ssis 4.1 named `internal` tables), so the fake reads as the
2025 catalog does. It has none of the catalog's functions and only four of its procedures, so `operationLogSize` and
`checkSchemaVersion` read as absent there.

What the checks prove:

- **Offline, every run** (`SsisFixtureChecks`, `tests/ssisdb-fixtures.test.ts`): the manifest is in canonical form and
  valid; the drift comparison reports a missing view, procedure, function or column, a changed length, nullability or
  parameter default, an added parameter, a lost refusal, a lost foreign key and an extra view; `schema.sql` matches the
  manifest; the stubs keep the real signatures and defaults, refuse SQL Server authentication before any other error
  (`stop_operation` after its null check, as the real one) and raise only real catalog error numbers, and the fake names
  no real catalog, process, server setting or assembly; and the manifest still proves each fact the next section lists.
- **Fake catalog** (`SsisLiveChecks`, `VARIA_TEST_SQL_SCRATCH=1`): its tables match every view of the manifest and its
  stubs match the real procedures; it refuses a SQL Server login with 27123 (impersonated, or the run's own login);
  create, parameter, start, stop and finish move through the real statuses with the real errors (27146, 27101, 27103,
  27138, 27124, 27121, 27224, 27126), and as in the real catalog a refused create or stop leaves its operation (200 or
  202) Failed (4), and a package that is not an entry point still gets an execution; a message can read in
  `catalog.event_messages` with NULL event columns before its event row is written, in READ COMMITTED as in READ
  UNCOMMITTED, and operation-only messages read that way for good; `IS_MEMBER` of a role whose members another
  session is changing waits until `LOCK_TIMEOUT` even under READ UNCOMMITTED, while `IS_SRVROLEMEMBER('sysadmin')`
  answers; a later message id commits before an earlier one, a READ COMMITTED tail with
  `LOCK_TIMEOUT 1000` waits on the held row and ends with 1222, READ UNCOMMITTED reads it before it commits, and under
  RCSI a tail that keeps only the highest id it read never reads that message; and four sessions write 2,000 messages
  of one execution with none lost or duplicated, each with its event message under the same id.
- **The tree and `ssis.describe` against the fake** (`SsisCatalogLiveChecks`, `VARIA_TEST_SQL_SCRATCH=1`): Object
  Explorer lists the fake as the catalog, its folders, projects, environments and packages (one page per package by
  `package_id`, a 260-character name included), with names made to break out of brackets, strings, comments and LIKE
  patterns; a listing below a folder or project that is gone, and a catalog whose database does not exist, answer
  `NOT_FOUND` (`CATALOG_MISSING` for a describe); every view reads its object, a sensitive parameter or variable without
  its value; a read under a writer's held row returns at once, the committed row under RCSI and the change without it;
  a describe past its budget answers `TIMEOUT` and a cancelled one ends at once; and, as the scratch SQL Server login,
  the profile answers `BLOCKED` while another session holds a change to `ssis_admin`'s members, then reads the login's
  roles and, for ssis_admin, `catalog_properties`. Every connection those reads leave in the catalog's database is the
  SSIS read pool's.
- **Drift check** (`VARIA_TEST_SSIS=1`): the real `SSISDB`'s shape equals its band's manifest entry. With
  `VARIA_TEST_SQL_SCRATCH=1` too, so does the Integration Services feature's own catalog backup, restored as a marked
  `VariaScratch_…_ssisref` database. Neither creates, changes or drops `SSISDB`; the restored copy is never named
  `SSISDB` and gets no master key, CLR, logins or jobs. Run it once per server version that has Integration Services.

## Verified on

SQL Server 2025 RTM (17.0.1000.7) Enterprise Developer on Windows 11, with Integration Services 2025 installed
(`MsDtsServer170`). The catalog had not been created yet (2026-10-21), so the facts below come from its catalog backup,
`C:\Program Files\Microsoft SQL Server\170\DTS\Binn\SSISDBBackup.bak` (catalog schema version 8, build 17.0.1000.7),
restored under a scratch name: the same file Create Catalog restores. They describe the catalog's schema and procedure
code, not its behaviour under load. "Backup" marks what the backup shows, "fake" what the fake catalog reproduces, and
"open" what still needs a real catalog (the probe, the drift check and the fixture project), another version or Azure.

| Item | Question (D-ssis 14) | Answer | Status |
| --- | --- | --- | --- |
| 14.1 | SSISDB's compatibility level, RCSI default and collation | 2025's backup: compatibility level 170, READ_COMMITTED_SNAPSHOT off, snapshot isolation off, `SQL_Latin1_General_CP1_CI_AS`. So live reads default to READ UNCOMMITTED with `LOCK_TIMEOUT 1000` (owner decision 4). Whether Create Catalog changes any of these, and other versions, are not known; the drift check prints the real catalog's | Backup; open for a created catalog and 2016 to 2022 |
| 14.2 | Indexes the tails read, and the cost of row-level security | `internal.operation_messages`: clustered `operation_message_id`, nonclustered `operation_id` (whose key carries the clustered key, so `operation_id = @op AND operation_message_id > @after` is a range seek); the same pair on `event_messages`; `executable_statistics` has `execution_id`; `execution_component_phases` has (`execution_id`, `sequence_id`); `execution_data_statistics` has only its clustered `data_stats_id`. Every view filters with `operation_id IN (SELECT id FROM internal.current_user_readable_operations) OR IS_MEMBER('ssis_admin') = 1 OR IS_SRVROLEMEMBER('sysadmin') = 1 OR IS_MEMBER('ssis_logreader') = 1`. Its cost on a large catalog is not measured | Backup; open for timings |
| 14.3 | Out-of-order identity commits; is `event_message_id` the `operation_message_id`? | Yes: `FK_EventMessages_OperationMessageId_OperationMessage` (`event_messages.event_message_id` to `operation_messages.operation_message_id`, cascade), and `internal.event_messages` has no identity. More: `catalog.event_messages` is `operation_messages LEFT JOIN event_messages` on that id, so it lists every operation message (event columns NULL when there is no event, as for the operation-only messages `internal.append_operation_message` writes), and one tail of `catalog.event_messages` reads every message. But `internal.append_event_message` inserts the operation message and then the event row as two separate statements, with no transaction, so the operation message commits first: for a moment, in every isolation mode, the view lists the message with its `message` and NULL `package_name`, `event_name`, `message_source_name`, `execution_path`, `threadID` and `message_code`. A tail that keys on the id must read again the rows whose event columns were NULL within the settle window (S4), or it keeps the incomplete row and drops the complete one as a duplicate; the fake reproduces it (`varia_fake_run @event_after_lock`). Scale Out messages come from `*_scaleout` tables with `operation_message_id = -1` and `event_message_id` NULL, so an id keyset never reads them; a Scale Out execution needs `event_message_guid`. `operation_message_id` is an identity, so concurrent writers can commit out of id order; the fake reproduces that, while ISServerExec's real ordering under load is not measured | Backup and fake; open for real load (fixture package Chatty) |
| 14.4 | `execution_id` = `operation_id`, and for validations | Yes: `FK_Executions_ExecutionId_Operations` and `FK_Validations_ValidationId_Operations`, both cascading from `internal.operations`. A Stop Operation is an operation of its own (type 202) | Backup |
| 14.5 | Does `validate_*` hold the call, does `deploy_project` return before ISServerExec finishes, can the procedures run inside a caller's transaction? | `deploy_project` holds it: after starting the deployment it polls every second until the deploy operation leaves Running (or its ISServerExec process is gone). It runs at SERIALIZABLE, and like `internal.prepare_stop` it takes a savepoint when the caller has a transaction open. `create_execution` serializes on the application lock `MS_ISServer_Create_Execution` (5 s, twice, then 27195). `start_execution` moves an execution to Pending (5) and leaves Running (2) to ISServerExec. Validation runs in CLR (`internal.validate_project_internal`), so whether it waits is not visible | Backup for deploy, create and start; open for validate and nesting in general |
| 14.6 | Catalog property defaults, ranges, the startup-procedure default, `get_operation_log_size` and `check_schema_version` | 2025's backup: `RETENTION_WINDOW` 365, `MAX_PROJECT_VERSIONS` 10, `SERVER_LOGGING_LEVEL` 1, `OPERATION_CLEANUP_ENABLED` and `VERSION_CLEANUP_ENABLED` TRUE, `ENCRYPTION_ALGORITHM` AES_256, `SERVER_OPERATION_ENCRYPTION_LEVEL` 2, `DEFAULT_EXECUTION_MODE` 0, `SERVER_CUSTOMIZED_LOGGING_LEVEL` empty, `SCHEMA_VERSION` 8. There is no `VALIDATION_TIMEOUT` property. `catalog.get_operation_log_size()` and `get_version_log_size()` are scalar functions without parameters returning bigint; `check_schema_version` is a procedure taking `@use32bitruntime smallint`. Ranges and SSMS's startup-procedure default are not known | Backup; open for ranges and the dialog |
| 14.7 | The SQL Server authentication error, and which procedures refuse | Error 27123, "The operation cannot be started by an account that uses SQL Server Authentication. Start the operation with an account that uses Integrated Authentication." 42 of the 56 catalog procedures raise it, themselves or through what they call (manifest `sqlAuthRefused`): every execution, validation, deployment, Export (`get_project`), version, folder, project, environment, reference, parameter, permission and Stop Operation procedure, `configure_catalog`, `check_schema_version` and the data-tap procedures. Only `get_parameter_values`, the customized logging level procedures, the Scale Out worker procedures, `update_logdb_info`, `update_master_address` and `startup` do not. The test is the caller's login being a SQL Server login, or a database user of type SQL with the login's sid. So D-ssis 8.3's "allowed" row (Configure, Environments, Folders, Stop Operation, Catalog Properties) is wrong for box servers: everything that changes the catalog needs Windows authentication | Backup and fake; open for a live call with a SQL login |
| 14.8 | SSIS data type to SQL type mapping | `internal.data_type_mapping` (58 rows, manifest `typeMapping`): Boolean and the integer types accept bigint, bit, int, smallint and tinyint; DateTime datetime, datetime2 and smalldatetime; Decimal, Double and Single decimal, float, numeric and real; String char, nchar and nvarchar. The `SqlDbType` Varia must send for `set_execution_parameter_value` (sql_variant) is not checked yet | Backup; open (S6) |
| 14.9 | Create Catalog: finding the backup and assembly, and post-restore steps | The backup is in the version's `DTS\Binn` folder next to `Microsoft.SqlServer.IntegrationServices.Server.dll` (see 14.12). It holds the `ISSERVER` and `Microsoft.SqlServer.Types` assemblies (UNSAFE), the `MS_SQLISSigningCertificate` certificate, the `ssis_admin`, `ssis_logreader`, `ssis_cluster_executor`, `ssis_cluster_worker` and `ssis_failover_monitoring_agent` roles and the `ddl_cleanup_object_permissions` database trigger, but no master key or symmetric key, and its `dbo` is `sa`. Restoring it upgrades it from database version 984 to the engine's. The steps after the restore (CLR, master key, startup procedure, maintenance job) are S9a's to verify: the owner creates this machine's catalog with Varia's Create Catalog, whose destructive live check runs only with `VARIA_TEST_SSIS_CREATE=1` | Backup; open (S9a) |
| 14.10 | Azure: SQL authentication and Entra for writes, a stopped IR, `SCHEMA_VERSION_AZURE` | Not checked: no Azure-SSIS IR was available | Open |
| 14.11 | Lock behaviour of the row-level security under READ UNCOMMITTED, and error 601 during cleanup | The security filter reads `internal.current_user_readable_operations` and role functions (14.2), and `IS_MEMBER` waits on an uncommitted change to its role's members even under READ UNCOMMITTED (see the role functions below). In the fake, a READ COMMITTED read waits on a writer's row until `LOCK_TIMEOUT` (1222) while READ UNCOMMITTED reads through; how the real views behave under load and how often 601 occurs during the nightly cleanup are not measured | Fake; open for a real catalog |
| 14.12 | The default path of `SSISDBBackup.bak` | `<shared features>\<major>0\DTS\Binn\`, and on SQL Server 2025 the file `SSISDBBackup.bak` (U3's `SSISDB.bak` is the earlier versions' name). The .NET check takes the shared-features folder to be the folder above `MSSQL<n>.<instance>` in the engine's service command line (`sys.dm_server_services`), which holds only when Setup put the instance root (`INSTANCEDIR`) and the shared features (`INSTALLSHAREDDIR`, where `DTS` goes) in one folder, as the defaults do and as on this machine; with custom folders it finds no backup and skips its drift check, saying why. The authoritative location is the registry's `HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\<major>0\SSIS\Setup\DTSPath` (`C:\Program Files\Microsoft SQL Server\170\DTS\` here). How Create Catalog finds it (`DTSPath`, or SSMS's own way), with the path kept editable as D-ssis says, is S9a's | Backup on 2025 with default folders; open (S9a) for custom folders and earlier versions' file name |

Not yet done: the probe against a created catalog, the drift check against it, and the fixture project
(`tests/fixtures/ssis/VariaFixtures/` with its `.ispac`), which needs Visual Studio's SSIS Projects extension. Each
"open" item above is settled by one of them or by the PR named. Two more belong to later PRs:

- **The settle window (C-critic G15).** Whether 2 ticks and 5,000 ms, with a dedupe bound of 10,000 ids, cover how late
  a real catalog's messages commit (14.3) and how long an event row trails its operation message. The fake only
  reproduces the hazards; measuring them needs the fixture project's Chatty package on a created catalog. S4 settles
  it before it ships the defaults.
- **Role functions under locks (D-ssis 4.1).** D-ssis assumed `IS_MEMBER('ssis_admin')`, `IS_SRVROLEMEMBER('sysadmin')`
  and `IS_MEMBER('ssis_logreader')` never wait on locks. Not so: while another session holds an uncommitted change to
  a role's members, `IS_MEMBER` of that role waits for it, under READ UNCOMMITTED too (1222 at `LOCK_TIMEOUT 1000`;
  without a timeout, until the change ends), as the fake catalog checks and a probe in tempdb showed for a sysadmin
  caller. `IS_SRVROLEMEMBER('sysadmin')` and fixed database roles answered. That is the engine's behaviour, so
  `SsisProfile` reads the roles under the live reads' `LOCK_TIMEOUT 1000`, evaluates `IS_MEMBER` only for logins that
  are not sysadmin, and answers a lock timeout `BLOCKED` like any other read (checked against the fake with a SQL
  Server login). S1b found that it reaches further: while another session's transaction creates a user in the
  catalog's database and adds it to a role, a new connection that a login without sysadmin opens into that database
  waits in the post-login phase until its connect timeout (15 s by default), which no `LOCK_TIMEOUT` bounds; the SSIS
  pool answers that as `CONNECTION_LOST` ("Could not connect to the server"), retryable, and a pooled connection opened
  before is reused without the wait. The fake checks warm the pool before they hold the change.
  Every catalog view's row-level security filter calls the same `IS_MEMBER`s (14.2), so a view read can wait on such
  a change too (14.11); how the real catalog's `grant_permission` and cleanup touch the roles is not checked.

<!-- Generated below from src/shared/ssis/catalog.ts. Regenerate with: npx vitest run tests/ssis-catalog.test.ts -u -->

## Catalogue reference

Everything below comes from `src/shared/ssis/catalog.ts`, which the backend embeds as `backend/Varia.Backend/Ssis/ssis-catalog.json`.
The catalog is the database `SSISDB` (SSMS fixes the name; only an internal test option points the backend at a fake catalog).

### The tree

Object Explorer serves the catalog as SSMS does, from SQL Server 2016: the server's Integration Services Catalogs folder lists the
catalog's database when it exists, the catalog lists its folders directly, a folder has Projects and Environments, and a project
has Packages. Packages list in deployment order (`package_id`), because a package name can be longer than a sysname cursor key; a
package that is not an entry point has the subtype `child`. On SQL Server on Linux the folder says the catalog is not supported. The
kinds, folders and their identity are in docs/object-explorer.md.

| Folder | Id | Lists (query) | Filters |
| --- | --- | --- | --- |
| Integration Services Catalogs | `integrationServicesCatalogs` | Integration Services Catalog (`ssisCatalogs`) | — |
| Projects | `ssisProjects` | Project (`ssisProjects`) | Name |
| Environments | `ssisEnvironments` | Environment (`ssisEnvironments`) | Name |
| Packages | `ssisPackages` | Package (`ssisPackages`) | Name |

The catalog's listings run on the SSIS read pool (the program name plus " - Integration Services"), whose connections are in the
catalog's database, at READ UNCOMMITTED with `LOCK_TIMEOUT 5000`. The catalog row itself is read from `sys.databases` on the Object
Explorer pool. A catalog that was dropped answers `NOT_FOUND` (refresh the parent); one that is offline, restoring or single-user in
use, `DATABASE_UNAVAILABLE` (retry); one the login cannot open, `NO_DB_ACCESS`.

### The live tree (`ssis.catalogProbe`)

While a connection's SSISDB node is open (expanded, or listed with no folders) and shows (its server and Integration Services
Catalogs folder are expanded), Object Explorer holds one live view of the `ssis.catalog` source for that connection (docs/live.md):
every 30 s by default (Tools › Options › SQL Server Integration Services; 10 to 300 s, or off), one
query fingerprints each catalog view below as its row count and a checksum (the sum of a SHA-256 prefix per row, over the columns
the tree and its documents show, sql_variant values as their bytes), over the rows row-level security lets the login see.
`catalog.catalog_properties` is read only for a login that is sysadmin or in ssis_admin (the only ones SSIS lets read it), in a
statement of its own; for anyone else its fingerprint stays 0 and 0. The first sample of a connection is its baseline; a later one,
or the first of a new view on the same connection (SSISDB closed and opened again, Object Explorer shown again), reloads in the
background only the listed nodes that show a view whose fingerprint changed, keeping expansion and selection and announcing what
was added or removed; a reload never opens a node, and one that a collapsed node hides waits until it shows. The view pauses 2 s
after Object Explorer or the window hides, as every live view does. It runs on the SSIS read pool in the catalog's database, READ
UNCOMMITTED (READ COMMITTED with READ_COMMITTED_SNAPSHOT on), `LOCK_TIMEOUT 1000`. A catalog that no longer exists ends the view
(`CATALOG_MISSING`) and the Integration Services Catalogs folder lists again; one that is offline, restoring, single-user or
restricted, or a replica that cannot be read, is retried (`DATABASE_UNAVAILABLE`). A view that ends for another reason (the server
or the window has no room for another live view, the backend restarted it) opens again after 2 s, doubling to 60 s while it keeps
ending before a sample. One that the login cannot read or open, or whose sign-in is refused, stops for good (`PERMISSION_DENIED`,
`LOGIN_FAILED`): SSISDB reads "(not updating)", its tooltip says why, and a Refresh of SSISDB, of anything in it or of its server,
or closing and opening SSISDB, tries again.

| Fingerprint | Catalog view | Object Explorer reloads |
| --- | --- | --- |
| `folders` | `catalog.folders` | Integration Services Catalog (deeply) |
| `projects` | `catalog.projects` | Projects |
| `packages` | `catalog.packages` | Packages |
| `environments` | `catalog.environments` | Environments |
| `variables` | `catalog.environment_variables` | Environments |
| `references` | `catalog.environment_references` | Nothing in the tree (documents) |
| `parameters` | `catalog.object_parameters` | Nothing in the tree (documents) |
| `properties` | `catalog.catalog_properties` | Nothing in the tree (documents) |

### Reads (`ssis.describe`)

One request reads one view in one batch, under the SSIS gates, and answers its model with a `revision`, or an error value. The
revision is a SHA-256 of what a later write depends on (names, descriptions, a project's deployment, parameter values,
references, variables, catalog properties), not of validation results or counts, which change without a write; a truncated answer
has none.
Reads run READ COMMITTED when the catalog's database has READ_COMMITTED_SNAPSHOT on, otherwise READ UNCOMMITTED, with
`LOCK_TIMEOUT 5000`; a read that meets the catalog's cleanup moving rows (error 601) reads once more. The first read on a
connection also reads its profile, with the role checks at the live reads' `LOCK_TIMEOUT 1000`, because `IS_MEMBER` waits on a pending
change to a role's members; a sysadmin's are not evaluated.

| View | Describes | Model |
| --- | --- | --- |
| `catalog` | `ssisCatalog` | The connection's profile (band, engine, host platform, authentication, RCSI, features, roles), the folders the login may read, and `catalog_properties` for ssis_admin and sysadmin |
| `folder` | `ssisFolder` | Id, name, description, creator, created time, and its project and environment counts |
| `project` | `ssisProject` | Its row (deployment, version LSN, validation), its packages, its parameters (object type 20) and its environment references |
| `package` | `ssisPackage` | Its row (format, version, entry point, validation) and its parameters (object type 30) |
| `environment` | `ssisEnvironment` | Its row and its variables; a sensitive variable's value is never read |

| Feature | Found when the catalog has |
| --- | --- |
| `customizedLoggingLevels` | `catalog.customized_logging_levels` |
| `scaleOut` | `catalog.worker_agents` |
| `eventMessageGuid` | `catalog.event_messages.event_message_guid` |
| `executedCount` | `catalog.executions.executed_count` |
| `operationLogSize` | `catalog.get_operation_log_size` |
| `checkSchemaVersion` | `catalog.check_schema_version` |

| Error | Retry helps |
| --- | --- |
| `CATALOG_MISSING` | No |
| `NO_DB_ACCESS` | No |
| `DATABASE_UNAVAILABLE` | Yes |
| `BLOCKED` | Yes |
| `TIMEOUT` | Yes |
| `PERMISSION_DENIED` | No |
| `NOT_FOUND` | No |
| `NOT_SUPPORTED` | No |
| `CONNECTION_LOST` | Yes |
| `AUTH_KERBEROS` | Yes |
| `AUTH_UNSUPPORTED` | No |
| `AUTH_ENTRA` | No |
| `SQL_ERROR` | Yes |

### Code tables

Operation types (`catalog.operations.operation_type`):

| Code | Meaning |
| --- | --- |
| `1` | Integration Services initialization |
| `2` | Operation cleanup |
| `3` | Project version cleanup |
| `101` | Deploy project |
| `102` | Export project |
| `106` | Restore project |
| `200` | Create and start execution |
| `202` | Stop operation |
| `300` | Validate project |
| `301` | Validate package |
| `1000` | Configure catalog |

Operation statuses; open: `1`, `2`, `5`, `8`, final: `3`, `4`, `6`, `7`, `9`:

| Code | Meaning |
| --- | --- |
| `1` | Created |
| `2` | Running |
| `3` | Canceled |
| `4` | Failed |
| `5` | Pending |
| `6` | Ended unexpectedly |
| `7` | Succeeded |
| `8` | Stopping |
| `9` | Completed |

Message types, with the tone a log row takes:

| Code | Meaning | Tone |
| --- | --- | --- |
| `-1` | Unknown | info |
| `10` | Pre-validate | info |
| `20` | Post-validate | info |
| `30` | Pre-execute | info |
| `40` | Post-execute | info |
| `50` | Status change | info |
| `60` | Progress | muted |
| `70` | Information | info |
| `80` | Variable value changed | info |
| `90` | Diagnostic | muted |
| `100` | Query cancel | info |
| `110` | Warning | warning |
| `120` | Error | error |
| `130` | Task failed | error |
| `140` | Diagnostic (extended) | info |
| `200` | Custom | info |
| `400` | Non-diagnostic | info |

Message source types:

| Code | Meaning |
| --- | --- |
| `10` | Entry APIs |
| `20` | External process |
| `30` | Package |
| `40` | Control flow task |
| `50` | Control flow container |
| `60` | Data flow task |

Executable results:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Failure |
| `2` | Completion |
| `3` | Cancelled |

Logging levels:

| Code | Meaning | Since |
| --- | --- | --- |
| `0` | None | — |
| `1` | Basic | — |
| `2` | Performance | — |
| `3` | Verbose | — |
| `4` | Runtime lineage | 2016 (13) |
| `100` | Custom | 2016 (13) |

Parameter object types:

| Code | Meaning |
| --- | --- |
| `20` | Project |
| `30` | Package |
| `50` | System |

System parameters an execution may set: `LOGGING_LEVEL`, `CUSTOMIZED_LOGGING_LEVEL`, `DUMP_ON_ERROR`, `DUMP_ON_EVENT`, `DUMP_EVENT_CODE`. `SYNCHRONIZED` is absent by design.

Securable types and permissions:

| Code | Meaning |
| --- | --- |
| `1` | Folder |
| `2` | Project |
| `3` | Environment |
| `4` | Operation |

| Code | Permission | On |
| --- | --- | --- |
| `1` | READ | Folder, Project, Environment, Operation |
| `2` | MODIFY | Folder, Project, Environment, Operation |
| `3` | EXECUTE | Project |
| `4` | MANAGE_PERMISSIONS | Folder, Project, Environment, Operation |
| `100` | CREATE_OBJECTS | Folder |
| `101` | READ_OBJECTS | Folder |
| `102` | MODIFY_OBJECTS | Folder |
| `103` | EXECUTE_OBJECTS | Folder |
| `104` | MANAGE_OBJECT_PERMISSIONS | Folder |

Environment reference types: `R` Relative, `A` Absolute. Parameter value types: `V` Literal, `R` Environment variable.

### Limits

| Limit | Value | Meaning |
| --- | --- | --- |
| `name` | 128 | UTF-16 code units in a folder, project, environment, parameter or variable name (sysname) |
| `packageName` | 260 | UTF-16 code units in a package name (`catalog.packages.name` is nvarchar(260)) |
| `description` | 1,024 | Characters in a description |
| `value` | 4,000 | Characters of a parameter, variable or catalog property value; a longer one ends in "…" |
| `rows` | 2,048 | Rows one describe list holds (packages, parameters, references, variables, properties); more set `truncated` |
| `describeBytes` | 4,000,000 | Estimated bytes of one describe answer; rows past it set `truncated` |
| `revision` | 64 | Characters in a revision (a SHA-256 in hex) |
| `messageChars` | 2,048 | Characters in an error message |
| `describeMs` | 40,000 | A describe's budget, in ms, answered as `TIMEOUT` |
| `gateWaitMs` | 30,000 | How long a request waits for an SSIS read gate before `BUSY`, in ms |
| `readPerConnection` | 2 | SSIS reads at once per connection |
| `readTotal` | 4 | SSIS reads at once in all |
| `registered` | 256 | SSIS requests registered at once |
| `cancelIds` | 64 | Request ids per `varia:ssis-cancel` |
| `tombstones` | 64 | Ids main remembers that were cancelled before they were sent |
| `tombstoneMs` | 60,000 | How long main remembers them, in ms |
| `readLockTimeoutMs` | 5,000 | LOCK_TIMEOUT of the tree's and describe's reads, in ms |
| `profileLockTimeoutMs` | 1,000 | LOCK_TIMEOUT of the profile read (its role checks), in ms |
