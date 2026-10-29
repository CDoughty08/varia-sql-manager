-- The SSIS catalog probe (D-ssis S0). READ ONLY: no DDL, no DML, no catalog procedure calls. For a person to run against a
-- created catalog, or against the catalog backup restored under another name, with Windows authentication:
--   sqlcmd -S <server> -E -C -v CatalogDatabase=SSISDB -i tests/fixtures/ssisdb/probe.sql -o probe.out
-- Each section answers one item of D-ssis 14 (docs/integration-services.md, Verified on). Unlike Varia's own SQL it uses
-- metadata built-ins; the .NET drift check (SsisManifest) reads the same facts without them.
SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
SET LOCK_TIMEOUT 5000;

PRINT '== 1. Server, host platform, SSISDB state, RCSI, compatibility level (D-ssis 14.1, 14.8)';
SELECT SERVERPROPERTY('ProductVersion') AS product_version, SERVERPROPERTY('EngineEdition') AS engine_edition;
SELECT host_platform, host_distribution FROM sys.dm_os_host_info;
SELECT name, state_desc, compatibility_level, is_read_committed_snapshot_on, snapshot_isolation_state_desc, user_access_desc,
       is_trustworthy_on, collation_name
FROM sys.databases WHERE name = N'$(CatalogDatabase)';
SELECT servicename, filename, service_account FROM sys.dm_server_services;
SELECT SERVERPROPERTY('InstanceDefaultDataPath') AS data_path, SERVERPROPERTY('InstanceDefaultLogPath') AS log_path;
SELECT name, value_in_use FROM sys.configurations WHERE name IN (N'clr enabled', N'clr strict security');
SELECT description, hash FROM sys.trusted_assemblies;

USE [$(CatalogDatabase)];

PRINT '== 2. Indexes of the internal tables the tails read (D-ssis 14.2)';
SELECT t.name AS table_name, i.name AS index_name, i.type_desc, i.is_primary_key, i.is_unique,
       STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS keys
FROM sys.tables AS t
JOIN sys.schemas AS s ON s.schema_id = t.schema_id AND s.name = N'internal'
JOIN sys.indexes AS i ON i.object_id = t.object_id
JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE t.name IN (N'operations', N'executions', N'validations', N'operation_messages', N'event_messages', N'event_message_context',
                 N'executable_statistics', N'executables', N'execution_data_statistics', N'execution_component_phases',
                 N'execution_parameter_values', N'object_parameters', N'folders', N'projects', N'packages', N'environments',
                 N'environment_variables', N'environment_references')
GROUP BY t.name, i.name, i.type_desc, i.is_primary_key, i.is_unique
ORDER BY t.name, i.name;

PRINT '== 3. Foreign keys into operations and operation_messages (cascade chain; event_message_id = operation_message_id?)';
SELECT fk.name, OBJECT_SCHEMA_NAME(fk.parent_object_id) + N'.' + OBJECT_NAME(fk.parent_object_id) AS child,
       OBJECT_SCHEMA_NAME(fk.referenced_object_id) + N'.' + OBJECT_NAME(fk.referenced_object_id) AS parent,
       fk.delete_referential_action_desc,
       STRING_AGG(pc.name + N' -> ' + rc.name, ', ') AS columns
FROM sys.foreign_keys AS fk
JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns AS pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE OBJECT_SCHEMA_NAME(fk.referenced_object_id) = N'internal'
GROUP BY fk.name, fk.parent_object_id, fk.referenced_object_id, fk.delete_referential_action_desc
ORDER BY parent, child;

PRINT '== 4. Identity columns of the log tables';
SELECT OBJECT_SCHEMA_NAME(ic.object_id) + N'.' + OBJECT_NAME(ic.object_id) AS table_name, ic.name, TYPE_NAME(ic.system_type_id) AS type_name,
       ic.seed_value, ic.increment_value, ic.last_value
FROM sys.identity_columns AS ic
WHERE OBJECT_SCHEMA_NAME(ic.object_id) = N'internal';

PRINT '== 5. Columns of every catalog view Varia reads (feeds tests/fixtures/ssisdb/manifest.json)';
SELECT v.name AS view_name, c.column_id, c.name AS column_name, TYPE_NAME(c.user_type_id) AS type_name, c.max_length, c.precision, c.scale, c.is_nullable
FROM sys.views AS v
JOIN sys.schemas AS s ON s.schema_id = v.schema_id AND s.name = N'catalog'
JOIN sys.columns AS c ON c.object_id = v.object_id
ORDER BY v.name, c.column_id;

PRINT '== 6. Catalog procedures and their parameters (signatures for SsisSql templates)';
SELECT p.name AS procedure_name, pr.parameter_id, pr.name AS parameter_name, TYPE_NAME(pr.user_type_id) AS type_name, pr.max_length, pr.is_output
FROM sys.procedures AS p
JOIN sys.schemas AS s ON s.schema_id = p.schema_id AND s.name = N'catalog'
LEFT JOIN sys.parameters AS pr ON pr.object_id = p.object_id
ORDER BY p.name, pr.parameter_id;

PRINT '== 7. Catalog property values on a fresh catalog (defaults; ssis_admin or sysadmin only)';
SELECT property_name, property_value FROM [catalog].[catalog_properties] ORDER BY property_name;

PRINT '== 8. View text of the views the live tails read (row-level security filter shape)';
SELECT v.name, LEN(m.definition) AS definition_length, m.definition
FROM sys.views AS v
JOIN sys.schemas AS s ON s.schema_id = v.schema_id AND s.name = N'catalog'
JOIN sys.sql_modules AS m ON m.object_id = v.object_id
WHERE v.name IN (N'operations', N'executions', N'operation_messages', N'event_messages', N'executable_statistics',
                 N'execution_data_statistics', N'execution_component_phases', N'folders', N'projects');

PRINT '== 9. Feature probes Varia will use instead of OBJECT_ID/COL_LENGTH (no metadata built-ins)';
SELECT o.name, o.type_desc FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE (s.name = N'internal' AND o.name IN (N'event_messages_scaleout', N'operations'))
   OR (s.name = N'catalog' AND o.name IN (N'customized_logging_levels', N'worker_agents', N'master_properties', N'get_operation_log_size', N'check_schema_version'));
SELECT c.name FROM sys.columns AS c JOIN sys.objects AS o ON o.object_id = c.object_id JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = N'internal' AND o.name = N'operations' AND c.name = N'executed_count';

PRINT '== 10. Agent jobs and logins the catalog created (golden for Create Catalog)';
SELECT j.name, j.enabled, SUSER_SNAME(j.owner_sid) AS owner FROM msdb.dbo.sysjobs AS j WHERE j.name LIKE N'SSIS%';
SELECT name, type_desc, is_disabled FROM sys.server_principals WHERE name LIKE N'##MS[_]SSIS%';
SELECT name, is_auto_executed = OBJECTPROPERTY(object_id, 'ExecIsStartup') FROM master.sys.procedures WHERE name = N'sp_ssis_startup';
SELECT name, is_master_key_encrypted_by_server FROM sys.databases WHERE name = N'$(CatalogDatabase)';
SELECT name, algorithm_desc FROM sys.symmetric_keys;

PRINT '== 11. Size of the log tables (cost of the tails on this catalog)';
SELECT t.name, SUM(p.rows) AS rows
FROM sys.tables AS t JOIN sys.schemas AS s ON s.schema_id = t.schema_id AND s.name = N'internal'
JOIN sys.partitions AS p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY t.name ORDER BY rows DESC;

PRINT '== 12. Catalog procedures that refuse SQL Server authentication (27123), themselves or through what they call (D-ssis 14.7)';
WITH refusing AS (
    SELECT m.object_id, 0 AS depth FROM sys.sql_modules AS m WHERE REPLACE(m.definition, N' ', N'') LIKE N'%RAISERROR(27123,%'
    UNION ALL
    SELECT d.referencing_id, r.depth + 1 FROM sys.sql_expression_dependencies AS d JOIN refusing AS r ON r.object_id = d.referenced_id WHERE r.depth < 6
)
SELECT p.name, CASE WHEN EXISTS (SELECT 1 FROM refusing AS r WHERE r.object_id = p.object_id) THEN 'refuses SQL Server authentication' ELSE '' END AS refusal
FROM sys.procedures AS p WHERE SCHEMA_NAME(p.schema_id) = N'catalog' ORDER BY refusal, p.name;

PRINT '== 13. SSISDB type map and the catalog errors Varia maps (D-ssis 14.8, 5.2)';
SELECT ssis_data_type, sql_data_type FROM [internal].[data_type_mapping] ORDER BY ssis_data_type, sql_data_type;
SELECT message_id, text FROM sys.messages WHERE language_id = 1033 AND message_id BETWEEN 27100 AND 27299 ORDER BY message_id;

PRINT '== 14. Database owner inside and outside, and the dbo user (D-ssis 14.9)';
SELECT SUSER_SNAME(owner_sid) AS owner FROM sys.databases WHERE name = N'$(CatalogDatabase)';
SELECT name, type, sid FROM sys.database_principals WHERE name = N'dbo';
