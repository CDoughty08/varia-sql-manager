# Integration Services (SSIS Catalog)

Object Explorer shows the SSIS Catalog (`SSISDB`) read-only: its folders, projects, packages and environments. Properties
on any of them (and Enter or a double-click on a package or environment, as in SSMS) opens its properties as a read-only
document tab, which `ssis.describe` reads. Varia changes it in two ways so far: Create Catalog (Integration Services
Catalogs › Create Catalog…, S9a), which creates `SSISDB` as SSMS 22 does, and Stop Operation (`ssis.execute`), which the
backend runs and the Operations view (S3) will offer.
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
- **Stop Operation against the fake** (`SsisActionLiveChecks`, `VARIA_TEST_SQL_SCRATCH=1`): a running execution stops
  (Stopping, with the catalog's own stop operation Succeeded); a second stop and an ended execution answer `ALREADY_FINAL`
  from the preflight, so the catalog records no failed stop; a missing operation answers `NOT_FOUND`, a stop operation
  `NOT_SUPPORTED`; a created execution nobody started answers `NOT_STARTED` from the preflight, twice, with no failed stop
  recorded; one that ends between the preflight and the stop answers `ALREADY_FINAL`, and, when the second look loses its
  connection, the catalog's refusal with the step failed; the write's own session is named " - Integration Services Actions",
  in the catalog's database, at READ COMMITTED with no lock timeout, and Stop ends it waiting on a lock with its step
  cancelled, the execution unchanged, and the catalog's own Stop operation left Running, which the reply says; the
  preflight behind a lock answers `TIMEOUT` within its budget, `BLOCKED` after 10 s, and `CONNECTION_LOST` saying nothing
  changed when its session is ended; the scratch SQL Server login is refused before connecting, gets
  `PERMISSION_DENIED` without EXECUTE, and the catalog's own 27123 answers `WINDOWS_AUTH_REQUIRED`; a missing catalog
  answers `CATALOG_MISSING`; and no actions session is left behind. On CI's SQL Server authentication the internal
  `SsisOptions.IgnoreSqlAuthentication` lets them run.
- **Create Catalog, offline** (`SsisCreateChecks`, `tests/ssis-schema.test.ts`, `tests/create-catalog-service.test.ts`): the
  verb and the backup's file name (`SSISDBBackup.bak` on every version) come from the catalogue; every server verb runs only commands
  `SsisCreateSql.ServerCommands` lists for it, and every command passes its lint, which rejects the password or a parameter
  concatenated into SQL or wrapped in anything but `QUOTENAME` or the server's quote escape (`REPLACE` in
  `Latin1_General_BIN2`), the password anywhere but once in the master key, unquoted dynamic text, a `WITH REPLACE`
  restore, a restore, drop or `ROLLBACK IMMEDIATE` outside Create Catalog's own commands (those instances, for that verb
  only, so Delete Catalog cannot reuse them unchecked; literals included, where text that runs would hide them),
  `RECONFIGURE` or `sp_procoption` before the pending-configuration guard, format placeholders, unknown variables and
  the shell (each caught case is in its mutation list); the commands keep SSMS 22's reads, restore, master key quoting, version test for the
  assembly (whose hash is read before a statement of its own adds it), startup procedure and maintenance job; the refusals come in SSMS's
  order and words, then `CONFIGURATION_PENDING` while other configuration changes wait, CLR in use or not, and every statement that
  reconfigures the server (enabling CLR, each `sp_procoption`) carries the guard whose error is told apart from the server's;
  Azure, Managed Instance, the other cloud editions (6, 9, 11, 12), Linux and servers before 2016 are refused before connecting;
  the plan the write follows after its preflight (`SsisCreate.Plan`: `CLR_REQUIRED` with no step when CLR is off and the request
  did not agree, CLR enabled first only when it is off, agreed and not a dry run, and the steps in order) is checked, but not
  that `CreateCatalogAsync` follows it: no offline check gets past opening a connection, so only the live dry run's
  `CLR_REQUIRED` case (Windows, CLR off) runs the write's own wiring; the startup choice reaches `sp_procoption` as chosen; the
  removal after a Stop or failure lists exactly what was made, in DropCatalog's order, its step's message is clipped to 2,048
  characters, and a failed removal's message names only what is left (the trusted assembly and the 2016 loading login
  included) and that CLR stays enabled; Stop's reply (`AfterStopAsync`, which a disconnect of a committed job uses too) is the job's
  answer within the grace, waits past it up to `createDrainMs` for a job that answers Stop itself (a job that never ends answers
  `CANCELLED` as not known yet) and otherwise answers `CANCELLED`; a backend that shuts down
  waits, within `createDrainMs`, for committed jobs only (`CommittedJobs`, and `HostChecks`: stdin EOF drains before the service is
  disposed); main lets a closing generation with a pending Create Catalog run `createCatalogDrainMs` before the kill, and others the
  usual 2 s (`tests/backend-connection.test.ts`); requests validate in zod and C# alike (UTF-16 lengths, no lone surrogate); the
  request's records never print the password; the dialog's state never holds it, refuses a broken password, and cancels its setup
  read when it closes while loading, sends the startup box as left (checked by default or by hand), shows a Stop whose removal
  failed as an alert, and refuses a window close while it runs (and `FileService.closeWindow` refuses before asking anything);
  and the command is disabled on a lost node or server, and hidden from a lost server's context menu.
- **Create Catalog, live** (`SsisCreateLiveChecks`): every live run reads `ssis.catalogSetup` and compares it with an
  independent read (CLR in use, scan for startup procs, the catalog backup from the registry's `DTSPath`, the files
  beside `master.mdf`, or the refusal), and checks that it left what only Create Catalog makes as it was, within the read's own budget. With `VARIA_TEST_SQL_SCRATCH=1` on Windows
  with Integration Services, the dry run (the internal `SsisOptions.CreateScratch`) runs Varia's own restore and master
  key steps into a marked `VariaScratch_…_ssiscc` database with a 128-character password made to break out of quotes,
  brackets and comments and holding U+FF07, U+2019 and U+02BC, which opens the master key exactly as typed (not with those
  made ASCII) while another password does not; a second run answers
  `CATALOG_EXISTS`; on a server with CLR off, a request that did not agree to it answers `CLR_REQUIRED` and creates nothing; a
  database another session creates between the preflight and the restore is refused by the restore's own check
  (`CATALOG_EXISTS`, no removal step) and stays online, and the destructive check's guarded drop leaves it alone unless its
  recorded identity matches; the removal after a failed restore drops a database still RESTORING and keeps an online one; a
  step that fails after the restore (the database made read-only from another session) removes the database; Stop during
  the restore lets it end (within `restoreStopMs`) and then removes the database; a shutdown during the restore (`CancelAll` then `DrainCommitted`,
  as `ProtocolHost` does on stdin EOF) returns only after the removal, and the request still answers its steps; Stop while
  the master key waits for another session's lock answers within the grace with the database removed; Stop before the
  restore creates nothing; and the server's CLR, assembly trust, `sp_ssis_startup`, SSIS jobs and logins are as before. Every
  case that restores marks the database right after its restore, before a Stop's removal begins, so a run killed before its
  removal leaves one the scratch sweep drops. With `VARIA_TEST_SSIS=1` on a Windows server that has an `SSISDB`, a read-only
  check compares it and what it left on the server with what SSMS's Create leaves (online, master key, schema version, the
  `ISSERVER` assembly, CLR in use, `sp_ssis_startup`, the trusted assembly from 2017, the disabled cleanup login with
  `VIEW SERVER STATE`, its user's two grants, the maintenance job with two steps and its daily schedule, owned by that login). With
  `VARIA_TEST_SSIS_CREATE=1` only (never set by default; a server whose owner allows it) and only on a server without
  `SSISDB`, the destructive check creates the catalog with Varia, checks what SSMS's Create leaves (online, read-write, master
  key opening with the password, CLR in use, `sp_ssis_startup` not at startup when not chosen, the disabled cleanup login and
  its user's grants, the maintenance job's two steps and schedule, a readable catalog), refuses a second Create, removes the
  catalog, then creates it again with the startup procedure chosen (checked) and its last step made to fail, and checks that
  the removal left the server as before. It never drops a catalog it did not create, whose projects, history and master key
  password would be lost: it records the identity (`database_id`, `create_date`) of the SSISDB its own Create restored and
  drops only that, and checks for SSISDB again before each Create, stopping when another session made one. It puts CLR back
  off only when its own Create enabled it, and refuses to when other configuration changes wait for `RECONFIGURE`. Because
  it skips a server that has SSISDB, it must run before the owner creates the local catalog, or on a disposable server.
- **Operations against the fake** (`SsisOperationsLiveChecks`, `VARIA_TEST_SQL_SCRATCH=1`): the `ssis.operations` source
  shows the fake catalog's operations newest first on the SSIS read pool at READ UNCOMMITTED, in the catalog's words, with
  their times to the second with their offsets, durations and tones, a validation's folder and project and a deployment's
  project; the tiles count the running operations and the last 24 hours' failures, the same whatever the filters; a new
  execution appears, turns Running when started, Stopping with its stopper when Stop Operation stops it, and Canceled when it
  ends; new args read the window again under a status filter, a kind, a folder whose name holds LIKE's wildcards by its
  prefix, and the project or folder a validation or deployment carries; a writer's open transaction on an operation's row
  never blocks the view (READ UNCOMMITTED reads its uncommitted status through it; with READ_COMMITTED_SNAPSHOT on, READ
  COMMITTED reads the committed one), which keeps sampling; a window of 10,000 rows arrives within the probe's statement
  budget; a catalog that does not exist ends the view `CATALOG_MISSING`; and the scratch login, denied the fake's database,
  ends it `PERMISSION_DENIED`, as it does a missing catalog once denied VIEW ANY DATABASE (it cannot tell the two apart).
  Offline (`SsisOperationsChecks`), the window's state machine is driven without SQL Server: settling ids that commit out of
  order (after the catalogue's settle window), open operations refreshed in turns of 256, rows a refresh no longer finds,
  followed operations a status filter hides, open operations older than the window or behind more than twice the limit of
  finished ones, and the limit with open operations first; the args against `tests/fixtures/live/ssis-operations-args.json`,
  which the zod schema must accept and refuse alike; why a connection cannot open the catalog; and the Linux and pre-2016
  notes.
- **Operations against the real catalog** (`SsisOperationsLiveChecks.RealAsync`, `VARIA_TEST_SSIS=1`, when SSISDB exists):
  the source reads the real views at the isolation the catalog's READ_COMMITTED_SNAPSHOT picks, with every column and tile,
  and reports the probe's cost. It only reads. It has not run yet: this server has no SSISDB until Create Catalog (S9a).
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
| 14.6 | Catalog property defaults, ranges, the startup-procedure default, `get_operation_log_size` and `check_schema_version` | 2025's backup: `RETENTION_WINDOW` 365, `MAX_PROJECT_VERSIONS` 10, `SERVER_LOGGING_LEVEL` 1, `OPERATION_CLEANUP_ENABLED` and `VERSION_CLEANUP_ENABLED` TRUE, `ENCRYPTION_ALGORITHM` AES_256, `SERVER_OPERATION_ENCRYPTION_LEVEL` 2, `DEFAULT_EXECUTION_MODE` 0, `SERVER_CUSTOMIZED_LOGGING_LEVEL` empty, `SCHEMA_VERSION` 8. There is no `VALIDATION_TIMEOUT` property. `catalog.get_operation_log_size()` and `get_version_log_size()` are scalar functions without parameters returning bigint; `check_schema_version` is a procedure taking `@use32bitruntime smallint`. Ranges are not known. SSMS 22's Create Catalog dialog checks its startup-procedure box when the server's `scan for startup procs` is on (its object model, S9a), so Varia's does too | Backup and SSMS's object model; open for ranges |
| 14.7 | The SQL Server authentication error, and which procedures refuse | Error 27123, "The operation cannot be started by an account that uses SQL Server Authentication. Start the operation with an account that uses Integrated Authentication." 42 of the 56 catalog procedures raise it, themselves or through what they call (manifest `sqlAuthRefused`): every execution, validation, deployment, Export (`get_project`), version, folder, project, environment, reference, parameter, permission and Stop Operation procedure, `configure_catalog`, `check_schema_version` and the data-tap procedures. Only `get_parameter_values`, the customized logging level procedures, the Scale Out worker procedures, `update_logdb_info`, `update_master_address` and `startup` do not. The test is the caller's login being a SQL Server login, or a database user of type SQL with the login's sid. So D-ssis 8.3's "allowed" row (Configure, Environments, Folders, Stop Operation, Catalog Properties) is wrong for box servers: everything that changes the catalog needs Windows authentication | Backup and fake; open for a live call with a SQL login |
| 14.8 | SSIS data type to SQL type mapping | `internal.data_type_mapping` (58 rows, manifest `typeMapping`): Boolean and the integer types accept bigint, bit, int, smallint and tinyint; DateTime datetime, datetime2 and smalldatetime; Decimal, Double and Single decimal, float, numeric and real; String char, nchar and nvarchar. The `SqlDbType` Varia must send for `set_execution_parameter_value` (sql_variant) is not checked yet | Backup; open (S6) |
| 14.9 | Create Catalog: finding the backup and assembly, and post-restore steps | The backup is in the version's `DTS\Binn` folder next to `Microsoft.SqlServer.IntegrationServices.Server.dll` (see 14.12). It holds the `ISSERVER` and `Microsoft.SqlServer.Types` assemblies (UNSAFE), the `MS_SQLISSigningCertificate` certificate, the `ssis_admin`, `ssis_logreader`, `ssis_cluster_executor`, `ssis_cluster_worker` and `ssis_failover_monitoring_agent` roles and the `ddl_cleanup_object_permissions` database trigger, but no master key or symmetric key, and its `dbo` is `sa`. Restoring it upgrades it from database version 984 to the engine's. S9a read SSMS 22's object model (`Catalog.Create` and `CatalogHelper` in its Integration Services assemblies): sysadmin; the backup from the registry's `DTSPath` (`xp_regread` on the server, so a remote server works) checked with `xp_fileexist`; `DatabaseCheck.sql`; CLR in use; the new files beside `master.mdf`, refused if they exist; `RESTORE FILELISTONLY` and `RESTORE DATABASE … WITH REPLACE, MOVE …` with parameters, then `SET READ_WRITE` if needed; `DropMasterKey.sql` and the master key; `CreateCatalog.sql` (assembly trust, `sp_ssis_startup`, `sp_procoption`); `CreateCleanupJobLogin.sql` and `CreateMaintenanceJob.sql`; and on a failure from the restore on, `DropCatalog.sql` and `DropSSISDB.sql`. The dialog enables CLR through SMO first. Varia's Create Catalog does the same, except where noted under Create Catalog below; its dry run restores the backup and creates the master key on this machine, and its destructive live check (`VARIA_TEST_SSIS_CREATE=1`) the rest | SSMS's object model; dry run on 2025; open for the full create (the owner's first Create Catalog) |
| 14.10 | Azure: SQL authentication and Entra for writes, a stopped IR, `SCHEMA_VERSION_AZURE` | Not checked: no Azure-SSIS IR was available | Open |
| 14.11 | Lock behaviour of the row-level security under READ UNCOMMITTED, and error 601 during cleanup | The security filter reads `internal.current_user_readable_operations` and role functions (14.2), and `IS_MEMBER` waits on an uncommitted change to its role's members even under READ UNCOMMITTED (see the role functions below). In the fake, a READ COMMITTED read waits on a writer's row until `LOCK_TIMEOUT` (1222) while READ UNCOMMITTED reads through; how the real views behave under load and how often 601 occurs during the nightly cleanup are not measured | Fake; open for a real catalog |
| 14.12 | The default path of `SSISDBBackup.bak` | `<shared features>\<major>0\DTS\Binn\SSISDBBackup.bak` on every version: SSMS 22's `Catalog.Create` and `EnableSupportForAlwaysOnSecondary` pass the one literal `SSISDBBackup.bak` to `CatalogHelper.GetCatalogBackupPath`, with no version branch, and no SSMS assembly names `SSISDB.bak` (U3's name, which an earlier S9a draft and owner decision "Create Catalog moves forward" took for the files of 2016 to 2022). The .NET check takes the shared-features folder to be the folder above `MSSQL<n>.<instance>` in the engine's service command line (`sys.dm_server_services`), which holds only when Setup put the instance root (`INSTANCEDIR`) and the shared features (`INSTALLSHAREDDIR`, where `DTS` goes) in one folder, as the defaults do and as on this machine; with custom folders it finds no backup and skips its drift check, saying why. The authoritative location is the registry's `HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\<major>0\SSIS\Setup\DTSPath` (`C:\Program Files\Microsoft SQL Server\170\DTS\` here). Create Catalog reads `DTSPath` on the server as SSMS 22 does, so custom folders work; the path is not editable (SSMS's is not either) | Backup on 2025 with default folders; SSMS 22's object model for the name on 2016 to 2022 (no such server here) |

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
`catalog.catalog_properties` is read only for a login that is sysadmin or in ssis_admin (the only ones SSIS lets read it): anyone
else's sample runs a second constant query without it, so its fingerprint stays 0 and 0 for them. The first sample of a connection
is its baseline, unless it came late: when SSISDB was already listed as the view opened (a view refused or ended and opened again,
live updates turned on while browsing) or the view failed or paused before it sampled, that sample reloads SSISDB deeply, since
what changed meanwhile would otherwise never show. A later sample, or the first of a new view on the same connection (SSISDB closed
and opened again, Object Explorer shown again), reloads in the background only the listed nodes that show a view whose fingerprint
changed, keeping expansion and selection and announcing what was added or removed; a reload never opens a node, one that a
collapsed node hides waits until it shows, and one with a listing on its way in it, above it or below it (a first listing, the
user's Refresh, an earlier reload, any of which may have read the catalog before the change) reloads once those listings answer, so
a Refresh is never restarted or made shallower. The view pauses 2 s
after Object Explorer or the window hides, as every live view does. It runs on the SSIS read pool in the catalog's database, READ
UNCOMMITTED (READ COMMITTED with READ_COMMITTED_SNAPSHOT on), `LOCK_TIMEOUT 1000`. A catalog that no longer exists ends the view
(`CATALOG_MISSING`) and the Integration Services Catalogs folder lists again; one that is offline, restoring, single-user or
restricted, or a replica that cannot be read, is retried (`DATABASE_UNAVAILABLE`). A view that ends for another reason (the server
or the window has no room for another live view, the backend restarted it) opens again after 2 s, doubling to 60 s while it keeps
ending before a sample. One that no retry would fix stops for good: the login cannot read the catalog or its sign-in is refused, the
catalog lacks a view or column the probe reads, the request was refused as malformed, or the window closed
(`PERMISSION_DENIED`, `LOGIN_FAILED`, `NOT_SUPPORTED`, `INVALID_PARAMS`, `PORT_CLOSED`). SSISDB then reads "(not updating)", its tooltip says why, and a Refresh of SSISDB, of anything in it, of
the Integration Services Catalogs folder or of its server, or closing and opening SSISDB, tries again (a Refresh elsewhere does not).

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
| `WINDOWS_AUTH_REQUIRED` | No |
| `ALREADY_FINAL` | No |
| `NOT_STARTED` | No |
| `NOT_RUNNING` | Yes |
| `CANCELLED` | Yes |
| `CATALOG_EXISTS` | No |
| `CLR_REQUIRED` | No |
| `CONFIGURATION_PENDING` | No |
| `SQL_ERROR` | Yes |

### Verbs and documents

Each verb is one command (the palette shows it under Integration Services), on Object Explorer's menu for the kinds that offer it,
and enabled by its context key, which the selected node sets. A verb marked as the default action runs on Enter and a double-click,
as in SSMS. None of them changes the catalog yet. docs/commands.md lists the commands with their keys and menus.

| Verb | Command | Menu item | Offered on | Opens | Default action | Context key |
| --- | --- | --- | --- | --- | --- | --- |
| `folderProperties` | `ssis.folderProperties` | Properties | Folder | Folder Properties | No | `ssisVerbFolderProperties` |
| `projectProperties` | `ssis.projectProperties` | Properties | Project | Project Properties | No | `ssisVerbProjectProperties` |
| `packageProperties` | `ssis.packageProperties` | Properties | Package | Package Properties | Yes | `ssisVerbPackageProperties` |
| `environmentProperties` | `ssis.environmentProperties` | Properties | Environment | Environment Properties | Yes | `ssisVerbEnvironmentProperties` |

A properties document is a read-only document tab named as SSMS names the dialog ("Folder Properties - Finance"), with one
section per page. Opening an object that has a tab shows that tab and reads it again, and Refresh (F5 in the document,
`ssis.refreshProperties`) reads it again while the last model stays on screen. A sensitive value always shows as `********`.

| Document | Title | Reads (view) | Sections |
| --- | --- | --- | --- |
| `ssisFolder` | Folder Properties | `folder` | General |
| `ssisProject` | Project Properties | `project` | General, Packages, Parameters, References |
| `ssisPackage` | Package Properties | `package` | General, Parameters |
| `ssisEnvironment` | Environment Properties | `environment` | General, Variables |

Validation statuses shown in words: `N` Not validated; any other code shows as the catalog stores it.
Commands: `ssis.folderProperties`, `ssis.projectProperties`, `ssis.packageProperties`, `ssis.environmentProperties`, `ssis.refreshProperties`.

### Writes (`ssis.execute`)

A write runs on a connection of its own, opened for the request and closed after it: unpooled, never retried, in the catalog's
database (Create Catalog's in `master`), under the program name plus " - Integration Services Actions", so DBAs can tell it from the
read pool. It takes the SSIS write gates (1 per connection, 2 in all), then runs a preflight in the same connection at READ
COMMITTED with `LOCK_TIMEOUT 10000` (within 25 s), then its steps in order, from `SsisSql`'s constant templates (Create
Catalog's from `SsisCreateSql`) with values as parameters, waiting for locks as SSMS does (`LOCK_TIMEOUT -1`), with no outer transaction.
Stop (`varia:ssis-cancel`) ends it at any time (Create Catalog at any statement but its restore): the reply waits up to 10 s for SQL Server to
end the statement and lists the steps that completed (done, failed, cancelled, skipped). On a box server SSISDB changes nothing for a SQL Server login (error 27123), so a verb that needs
Windows authentication answers `WINDOWS_AUTH_REQUIRED` before it connects. Nothing is logged: not names, values, SQL or messages.

| Verb | Title | Runs in | Steps | Calls | Takes a revision | On a box server |
| --- | --- | --- | --- | --- | --- | --- |
| `stopOperation` | Stop Operation | The catalog's database | Stop the operation | `catalog.stop_operation` | No | Windows authentication only |
| `createCatalog` | Create Catalog | `master` | Enable CLR integration; Restore the catalog database; Create the master key; Register the Integration Services assembly and startup procedure; Create the maintenance job | — | No | Any authentication |

Stop Operation's preflight reads the operation from `catalog.operations`: one this login cannot see, or that no longer exists,
answers `NOT_FOUND`; one that is not an execution or validation (types `200`, `300`, `301`), `NOT_SUPPORTED`; one that has
ended or is already stopping, `ALREADY_FINAL`; an execution that was created and never started (it never runs), `NOT_STARTED`. Otherwise
it calls `catalog.stop_operation`, which records a stop operation (type 202) of its own and makes the operation Stopping (8) until
the package ends (Canceled, 3). When the catalog refuses because the operation is not running (27124) or already stopping (27126),
the operation is read again: `ALREADY_FINAL` if it ended or is stopping, `NOT_RUNNING` (retry once it runs) if it is pending, and
the catalog's own refusal if that second look fails. A lost connection before the stop is sent says nothing changed; after, that
its outcome is unknown. The catalog records its stop operation as Running before its own transaction, and a cancelled statement
never reaches its error path, so Stop during `catalog.stop_operation` (waiting on a lock) rolls the stop back but may leave that
Stop operation Running until SQL Server restarts and the catalog's startup procedure ends it; the `CANCELLED` reply says so.

#### Create Catalog

Create Catalog does what SSMS 22's `Catalog.Create` does (read from its object model), on a write connection of its own in `master`.
Its dialog first reads `ssis.catalogSetup` on the SSIS read pool, and the write reads the same again before its first step:
sysadmin, whether the catalog's database exists, `clr enabled` in use and `scan for startup procs` (SSMS's default for the startup
procedure), the Integration Services folder from the registry value
`HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\<major>0\SSIS\Setup\DTSPath` (`xp_regread` on the server, as SSMS reads it),
the catalog backup in its `Binn` folder (`SSISDBBackup.bak` from 2016: the one name SSMS 22's `Catalog.Create` passes for every version) and `Microsoft.SqlServer.IntegrationServices.Server.dll`
beside it, whether the backup exists (`xp_fileexist`), the database files' folder (the master database's, from `SERVERPROPERTY('MasterFile')`,
where SSMS puts them) and that `SSISDB.mdf` and `SSISDB.ldf` are not there yet, and the backup's logical files (`RESTORE FILELISTONLY`).
It is refused before it connects on Azure SQL Database and Managed Instance (an Azure-SSIS integration runtime creates that catalog),
on the explorer catalogue's other cloud editions (Synapse, Azure SQL Edge, SQL database in Fabric), on SQL Server before 2016 and on
Linux; then without sysadmin (`PERMISSION_DENIED`), when the catalog exists (`CATALOG_EXISTS`), when the backup or the folders cannot
be found or the files exist (`NOT_SUPPORTED`, in SSMS's words), when CLR integration is off and the request did not agree to enable it
(`CLR_REQUIRED`), and, CLR in use or not, when other dynamic `sp_configure` changes wait for a `RECONFIGURE` (`CONFIGURATION_PENDING`,
naming them; `min server memory (MB)` at 0 never counts, because SQL Server always shows it in use as 16): enabling CLR runs
`RECONFIGURE`, and `sys.sp_procoption` (the startup procedure, an earlier `sp_ssis_startup`'s removal, the removal after a failure)
ends with `RECONFIGURE WITH OVERRIDE`, and the user agreed to CLR integration, not to them. Each of those statements runs behind a
guard in its own batch that refuses the same way when a change was staged after the preflight. Then, in order:

1. **Enable CLR integration** (only when it is off): `sp_configure 'clr enabled', 1` and `RECONFIGURE`, as SMO does for SSMS's dialog.
2. **Restore the catalog database**: `RESTORE DATABASE` with the name, the backup, the logical names and the new files as parameters,
   refused (27135) if the database appeared meanwhile, then `SET READ_WRITE` if it restored read-only. Unlike SSMS it does not use
   `WITH REPLACE`, so nothing that appeared meanwhile is overwritten.
3. **Create the master key**: SSMS's statement, after dropping a master key the backup might hold, with the password a parameter
   that the server quotes (`REPLACE` of each quote inside `EXEC`). Unlike SSMS the literal is an `N` literal, so a password with
   characters outside the server's code page keeps them, and the `REPLACE` compares in `Latin1_General_BIN2`: in a width-insensitive
   collation it would double U+FF07 (fullwidth apostrophe), which the literal reads as an ASCII quote, so the key's password would
   not be the one typed. The assembly's path and the cleanup login's random password are quoted the same way.
4. **Register the Integration Services assembly and startup procedure**: after 14.0.800.11 (SQL Server 2017 and later, as SSMS
   decides it) the assembly's SHA2_512 hash with `sys.sp_add_trusted_assembly`, read (and kept for the removal) in one statement
   before another adds it, so an add that Stop or a lost reply cuts short is still removed; before, the asymmetric key
   `MS_SQLEnableSystemAssemblyLoadingKey`, its login and `UNSAFE ASSEMBLY`. Then `master.dbo.sp_ssis_startup` (SSMS's text), and
   `sp_procoption` when the startup procedure was chosen. An `sp_ssis_startup` that was there before is dropped first, and is not
   this request's to remove.
5. **Create the maintenance job**: `##MS_SSISServerCleanupJobLogin##` with a random password the server generates, disabled, its user
   in the catalog with EXECUTE on the two cleanup procedures, `VIEW SERVER STATE`, and the `SSIS Server Maintenance Job` (two T-SQL
   steps, daily at 00:00), as SSMS's CreateCleanupJobLogin.sql and CreateMaintenanceJob.sql do. Like SSMS it creates no
   `SSIS Failover Monitor Job`: that belongs to Always On support.

When a step after the restore fails or is stopped, Create Catalog does what SSMS does after a failure and adds the step "Remove the incomplete catalog":
it ends a transaction the cancelled statement left open, then drops what this request made: the trusted assembly hash it added (or,
before 14.0.800.11, the assembly loading login), `sp_ssis_startup`, both SSIS jobs and the cleanup login, and then the database it
restored, so the server is as before (CLR stays enabled, as in SSMS, and the message says so). Its statements wait at most 30 s for a
lock, because nothing can stop them; when one fails, the message names only what is left to delete. A refused restore (the database
appeared meanwhile) removes nothing, and a database left restoring by a failed restore is dropped only while no other session holds a
lock on it (another restore of the same name holds an exclusive one). Stop ends any statement after the restore at once, waiting for
a lock or not; the restore itself (and its switch to read-write) gets 30 s more to end, because a half-restored catalog is worse than
waiting, and only a restore still running then (waiting for a lock on msdb's backup history, say) is cancelled too, the database it left
restoring dropped (one that turns out online is named for the user to delete). Then what was created is removed. The reply waits for
that past the usual grace, up to 120 s more, a disconnect included, and lists the steps (the removal's own failures clipped to
2,048 characters); past that it answers `CANCELLED` as not known yet, and the job goes on. Create Catalog is a long run
(docs/object-actions.md, Long runs): while it runs, closing the window or quitting, Disconnect of its server and Restart SQL
Backend (while the backend answers) are refused with a message naming it, which its dialog repeats, and the reload prompt names it. A backend that shuts down anyway (a confirmed reload, a crash) waits up to
120 s for a Create Catalog past its restore to finish or remove what it made, and main lets that generation run 130 s after its
stdin ends (2 s otherwise) before it kills it; only a kill or a crash in that window leaves an incomplete catalog, which Create Catalog then
refuses as `CATALOG_EXISTS` until its database is dropped. The CLR agreement is checked from the server's facts before any step, in a
dry run too, and the steps come only from one pure plan of those facts (`SsisCreate.Plan`). The password is a parameter only,
well-formed UTF-16 (a lone surrogate would reach the server as U+FFFD): it is never in
SQL text Varia builds, in messages, in logs or on disk, and the request's frame is zeroed on both sides.

### Operations (the `ssis.operations` live source)

The Operations document (Active Operations, All Executions, All Validations and All Operations) shows one live subscription of
the `ssis.operations` source per connection, on the SSIS read pool at the live prologue (docs/live.md). Its args are the
document's filters; new args read the window again. The backend keeps the window: `limit` operations that pass the filters
and are still open or were created in the last `windowHours`, the open ones first (an open one of any age stays, so Active
Operations finds a long run), then the newest, and the open ones the status filter hides, followed unseen since they can end
in a status it shows. A new window reads the open operations of its scope apart, whatever their age. Each sample reads the
operations above the newest id it has settled (2 samples and 5 s after it was first seen, the operations table's
settle in the live catalogue: an id is assigned before its row commits), refreshes the open ones it holds (at most 256 a
sample, in turn), counts the running and pending operations, and drops what it neither shows nor follows; every
30 s it counts the last 24 hours by status. The counts ignore the filters and the limit. A row a refresh no longer
finds (removed by the retention cleanup, or a dirty read rolled back) leaves the window. Folder and Project match an
execution's or a validation's names (`catalog.executions`, `catalog.validations`) and Project a deployment's project (its
`object_name`); Package matches an execution's.

| Kind | Label | Operation types |
| --- | --- | --- |
| `execution` | Executions | `200` |
| `validation` | Validations | `300`, `301` |
| `deploy` | Deployments | `101` |
| `other` | Other | every type but `200`, `300`, `301`, `101` |

A row's tone follows its status (none for one that is running, pending, succeeded or completed: the grid's running tone is
the selection's hue):

| Status | Meaning | Tone |
| --- | --- | --- |
| `1` | Created | muted |
| `2` | Running | — |
| `3` | Canceled | muted |
| `4` | Failed | error |
| `5` | Pending | — |
| `6` | Ended unexpectedly | error |
| `7` | Succeeded | — |
| `8` | Stopping | warning |
| `9` | Completed | — |

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
| `gateWaitMs` | 30,000 | How long a request waits for an SSIS read or write gate before `BUSY`, in ms |
| `readPerConnection` | 2 | SSIS reads at once per connection |
| `readTotal` | 4 | SSIS reads at once in all |
| `registered` | 256 | SSIS requests registered at once |
| `cancelIds` | 64 | Request ids per `varia:ssis-cancel` |
| `tombstones` | 64 | Ids main remembers that were cancelled before they were sent |
| `tombstoneMs` | 60,000 | How long main remembers them, in ms |
| `readLockTimeoutMs` | 5,000 | LOCK_TIMEOUT of the tree's and describe's reads, in ms |
| `profileLockTimeoutMs` | 1,000 | LOCK_TIMEOUT of the profile read (its role checks), in ms |
| `writePerConnection` | 1 | SSIS writes (`ssis.execute`) at once per connection |
| `writeTotal` | 2 | SSIS writes at once in all |
| `registeredWrites` | 64 | SSIS writes registered at once |
| `preflightLockTimeoutMs` | 10,000 | LOCK_TIMEOUT of a write's preflight, in ms (`BLOCKED`) |
| `preflightMs` | 25,000 | A write's preflight budget, in ms, answered as `TIMEOUT` |
| `stopGraceMs` | 10,000 | How long a stopped write's reply waits for SQL Server to end its statement, in ms, then answers `CANCELLED` (outcome unknown) |
| `createDrainMs` | 120,000 | How long a backend that is shutting down waits for a Create Catalog past its restore to finish, or to remove what it created, in ms; a Stop or a disconnect waits as long past `stopGraceMs` |
| `restoreStopMs` | 30,000 | How long Create Catalog's restore runs on after a Stop, a disconnect or a shutdown before SQL Server is asked to end it too, in ms |
| `catalogPassword` | 128 | UTF-16 code units in Create Catalog's encryption password (at least 1; the server's password policy applies too) |
| `serverPath` | 1,024 | Characters in a path Create Catalog reads on the server (the catalog backup, the assembly, the database files) |
| `operationsRows` | 10,000 | The most operations the Operations view's window holds (its `limit`) |
| `operationsDefaultRows` | 1,000 | The operations it holds unless told otherwise |
| `operationsRefresh` | 256 | Open operations one sample reads again; more take turns |
| `operationsWindowHours` | 8,760 | The longest window, in hours (`windowHours`) |
| `operationsDefaultWindowHours` | 24 | The window unless told otherwise, in hours |
| `operationsCountMs` | 30,000 | How often the 24-hour counts are read, in ms |
