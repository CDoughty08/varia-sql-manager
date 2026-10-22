# Integration Services (SSIS Catalog)

Varia does not show the SSIS Catalog yet. This page records what is known about the catalog (`SSISDB`) that the SSIS
work builds on, how it was found out, and the test fixtures that stand in for a catalog where there is none. The design
is D-ssis (wave 4); this page is PR S0's part of it: verification and fixtures, no product code.

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
execution to Running and `varia_fake_finish` ends it as the package runner would. Later SSIS work points the backend at it
through an internal test option, never a request field. Checks against it never claim real SSIS behaviour.

What the checks prove:

- **Offline, every run** (`SsisFixtureChecks`, `tests/ssisdb-fixtures.test.ts`): the manifest is in canonical form and
  valid; the drift comparison reports a missing column, a changed length or nullability, an added parameter, a lost
  refusal, a lost foreign key and an extra view; `schema.sql` matches the manifest; the stubs keep the real signatures
  and raise only real catalog error numbers, and the fake names no real catalog, process, server setting or assembly;
  and the manifest still proves each fact the next section lists.
- **Fake catalog** (`SsisLiveChecks`, `VARIA_TEST_SQL_SCRATCH=1`): its tables match every view of the manifest and its
  stubs match the real procedures; it refuses a SQL Server login with 27123 (impersonated, or the run's own login);
  create, parameter, start, stop and finish move through the real statuses with the real errors (27146, 27101, 27103,
  27138, 27124, 27121, 27224, 27126); a later message id commits before an earlier one, a READ COMMITTED tail with
  `LOCK_TIMEOUT 1000` waits on the held row and ends with 1222, READ UNCOMMITTED reads it before it commits, and under
  RCSI a tail that keeps only the highest id it read never reads that message; and four sessions write 2,000 messages
  of one execution with none lost or duplicated, each with its event message under the same id.
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
| 14.3 | Out-of-order identity commits; is `event_message_id` the `operation_message_id`? | Yes: `FK_EventMessages_OperationMessageId_OperationMessage` (`event_messages.event_message_id` to `operation_messages.operation_message_id`, cascade), and `internal.event_messages` has no identity. More: `catalog.event_messages` is `operation_messages LEFT JOIN event_messages` on that id, so it lists every operation message (event columns NULL when there is no event), and one tail of `catalog.event_messages` is the whole log. Scale Out messages come from `*_scaleout` tables with `operation_message_id = -1` and `event_message_id` NULL, so an id keyset never reads them; a Scale Out execution needs `event_message_guid`. `operation_message_id` is an identity, so concurrent writers can commit out of id order; the fake reproduces that, while ISServerExec's real ordering under load is not measured | Backup and fake; open for real load (fixture package Chatty) |
| 14.4 | `execution_id` = `operation_id`, and for validations | Yes: `FK_Executions_ExecutionId_Operations` and `FK_Validations_ValidationId_Operations`, both cascading from `internal.operations`. A Stop Operation is an operation of its own (type 202) | Backup |
| 14.5 | Does `validate_*` hold the call, does `deploy_project` return before ISServerExec finishes, can the procedures run inside a caller's transaction? | `deploy_project` holds it: after starting the deployment it polls every second until the deploy operation leaves Running (or its ISServerExec process is gone). It runs at SERIALIZABLE, and like `internal.prepare_stop` it takes a savepoint when the caller has a transaction open. `create_execution` serializes on the application lock `MS_ISServer_Create_Execution` (5 s, twice, then 27195). `start_execution` moves an execution to Pending (5) and leaves Running (2) to ISServerExec. Validation runs in CLR (`internal.validate_project_internal`), so whether it waits is not visible | Backup for deploy, create and start; open for validate and nesting in general |
| 14.6 | Catalog property defaults, ranges, the startup-procedure default, `get_operation_log_size` and `check_schema_version` | 2025's backup: `RETENTION_WINDOW` 365, `MAX_PROJECT_VERSIONS` 10, `SERVER_LOGGING_LEVEL` 1, `OPERATION_CLEANUP_ENABLED` and `VERSION_CLEANUP_ENABLED` TRUE, `ENCRYPTION_ALGORITHM` AES_256, `SERVER_OPERATION_ENCRYPTION_LEVEL` 2, `DEFAULT_EXECUTION_MODE` 0, `SERVER_CUSTOMIZED_LOGGING_LEVEL` empty, `SCHEMA_VERSION` 8. There is no `VALIDATION_TIMEOUT` property. `catalog.get_operation_log_size()` and `get_version_log_size()` are scalar functions without parameters returning bigint; `check_schema_version` is a procedure taking `@use32bitruntime smallint`. Ranges and SSMS's startup-procedure default are not known | Backup; open for ranges and the dialog |
| 14.7 | The SQL Server authentication error, and which procedures refuse | Error 27123, "The operation cannot be started by an account that uses SQL Server Authentication. Start the operation with an account that uses Integrated Authentication." 42 of the 56 catalog procedures raise it, themselves or through what they call (manifest `sqlAuthRefused`): every execution, validation, deployment, Export (`get_project`), version, folder, project, environment, reference, parameter, permission and Stop Operation procedure, `configure_catalog`, `check_schema_version` and the data-tap procedures. Only `get_parameter_values`, the customized logging level procedures, the Scale Out worker procedures, `update_logdb_info`, `update_master_address` and `startup` do not. The test is the caller's login being a SQL Server login, or a database user of type SQL with the login's sid. So D-ssis 8.3's "allowed" row (Configure, Environments, Folders, Stop Operation, Catalog Properties) is wrong for box servers: everything that changes the catalog needs Windows authentication | Backup and fake; open for a live call with a SQL login |
| 14.8 | SSIS data type to SQL type mapping | `internal.data_type_mapping` (58 rows, manifest `typeMapping`): Boolean and the integer types accept bigint, bit, int, smallint and tinyint; DateTime datetime, datetime2 and smalldatetime; Decimal, Double and Single decimal, float, numeric and real; String char, nchar and nvarchar. The `SqlDbType` Varia must send for `set_execution_parameter_value` (sql_variant) is not checked yet | Backup; open (S6) |
| 14.9 | Create Catalog: finding the backup and assembly, and post-restore steps | The backup is in the version's `DTS\Binn` folder next to `Microsoft.SqlServer.IntegrationServices.Server.dll` (see 14.12). It holds the `ISSERVER` and `Microsoft.SqlServer.Types` assemblies (UNSAFE), the `MS_SQLISSigningCertificate` certificate, the `ssis_admin`, `ssis_logreader`, `ssis_cluster_executor`, `ssis_cluster_worker` and `ssis_failover_monitoring_agent` roles and the `ddl_cleanup_object_permissions` database trigger, but no master key or symmetric key, and its `dbo` is `sa`. Restoring it upgrades it from database version 984 to the engine's. What else SSMS 22 does after the restore is the S9 golden comparison's | Backup; open (S9) |
| 14.10 | Azure: SQL authentication and Entra for writes, a stopped IR, `SCHEMA_VERSION_AZURE` | Not checked: no Azure-SSIS IR was available | Open |
| 14.11 | Lock behaviour of the row-level security under READ UNCOMMITTED, and error 601 during cleanup | The security filter reads `internal.current_user_readable_operations` and role functions (14.2). In the fake, a READ COMMITTED read waits on a writer's row until `LOCK_TIMEOUT` (1222) while READ UNCOMMITTED reads through; how the real views behave under load and how often 601 occurs during the nightly cleanup are not measured | Fake; open for a real catalog |
| 14.12 | The default path of `SSISDBBackup.bak` | From the engine's service command line (`sys.dm_server_services`): the folder above `MSSQL<n>.<instance>`, then `<major>0\DTS\Binn\`, and on SQL Server 2025 the file `SSISDBBackup.bak` (U3's `SSISDB.bak` is the earlier versions' name). The .NET check derives it this way and restores it on this machine | Backup on 2025; open for earlier versions' file name |

Not yet done: the probe against a created catalog, the drift check against it, and the fixture project
(`tests/fixtures/ssis/VariaFixtures/` with its `.ispac`), which needs Visual Studio's SSIS Projects extension. Each
"open" item above is settled by one of them or by the PR named.
