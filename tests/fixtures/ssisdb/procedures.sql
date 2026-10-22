-- The fake SSIS catalog's procedures, run after schema.sql in a marked VariaScratch_…_ssis database (D-ssis 12.2).
-- Hand-written. Each catalog.* stub keeps the real procedure's signature (manifest.json; the live checks compare them),
-- refuses SQL Server authentication with 27123 where the real one does, raises the real catalog's error numbers, and writes
-- the rows the real catalog would, but never starts ISServerExec: there is no package, so nothing runs. The varia_* objects
-- are the fake's own and are never in a real catalog: varia_fake_seed adds a folder, project and package, varia_fake_run
-- writes an execution's messages from several sessions with commits held back (out-of-order commits, D-ssis 14.3), and
-- varia_fake_finish ends an operation the way ISServerExec would.
CREATE TABLE [catalog].[varia_fake_settings] ([refuse_sql_auth] bit NOT NULL);
INSERT [catalog].[varia_fake_settings] ([refuse_sql_auth]) VALUES (1);
-- The order in which varia_fake_run's messages committed, next to their ids.
CREATE TABLE [catalog].[varia_fake_commits] ([commit_sequence] bigint IDENTITY(1, 1) NOT NULL PRIMARY KEY, [operation_message_id] bigint NOT NULL, [thread] int NOT NULL);
GO

-- The real catalog's test (internal.get_user_info, then sys.server_principals and sys.database_principals by SUSER_SID()),
-- switched off only when a run connected with SQL Server authentication needs the stubs' other paths.
CREATE FUNCTION [catalog].[varia_fake_sql_auth] ()
RETURNS bit
AS
BEGIN
    IF (SELECT [refuse_sql_auth] FROM [catalog].[varia_fake_settings]) = 1
        AND (EXISTS (SELECT 1 FROM sys.server_principals WHERE [sid] = SUSER_SID() AND [type] = 'S')
            OR EXISTS (SELECT 1 FROM sys.database_principals WHERE [sid] = SUSER_SID() AND [type] = 'S'))
        RETURN 1;
    RETURN 0;
END
GO

CREATE PROCEDURE [catalog].[varia_fake_seed]
    @folder_name nvarchar(128),
    @project_name nvarchar(128),
    @package_name nvarchar(260),
    @entry_point bit = 1
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @now datetimeoffset(7) = SYSDATETIMEOFFSET(), @folder_id bigint, @project_id bigint;
    SELECT @folder_id = [folder_id] FROM [catalog].[folders] WHERE [name] = @folder_name;
    IF @folder_id IS NULL
    BEGIN
        INSERT [catalog].[folders] ([name], [description], [created_by_sid], [created_by_name], [created_time])
        VALUES (@folder_name, N'Fake catalog folder', SUSER_SID(), SUSER_SNAME(), @now);
        SET @folder_id = SCOPE_IDENTITY();
    END
    SELECT @project_id = [project_id] FROM [catalog].[projects] WHERE [folder_id] = @folder_id AND [name] = @project_name;
    IF @project_id IS NULL
    BEGIN
        INSERT [catalog].[projects] ([folder_id], [name], [project_format_version], [deployed_by_sid], [deployed_by_name], [last_deployed_time], [created_time],
            [object_version_lsn], [validation_status])
        VALUES (@folder_id, @project_name, 1, SUSER_SID(), SUSER_SNAME(), @now, @now, 1, 'N');
        SET @project_id = SCOPE_IDENTITY();
    END
    IF NOT EXISTS (SELECT 1 FROM [catalog].[packages] WHERE [project_id] = @project_id AND [name] = @package_name)
        INSERT [catalog].[packages] ([name], [package_guid], [package_format_version], [version_major], [version_minor], [version_build], [version_guid],
            [project_id], [entry_point], [validation_status])
        VALUES (@package_name, NEWID(), 8, 1, 0, 1, NEWID(), @project_id, @entry_point, 'N');
    SELECT @folder_id AS [folder_id], @project_id AS [project_id];
END
GO

CREATE PROCEDURE [catalog].[create_execution]
    @folder_name nvarchar(128),
    @project_name nvarchar(128),
    @package_name nvarchar(260),
    @reference_id bigint = NULL,
    @use32bitruntime bit = 0,
    @runinscaleout bit = NULL,
    @useanyworker bit = NULL,
    @execution_id bigint OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    IF [catalog].[varia_fake_sql_auth]() = 1
    BEGIN
        RAISERROR(27123, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    IF @folder_name IS NULL OR @project_name IS NULL OR @package_name IS NULL
    BEGIN
        RAISERROR(27138, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @project_id bigint, @project_lsn bigint;
    SELECT @project_id = p.[project_id], @project_lsn = p.[object_version_lsn]
    FROM [catalog].[folders] AS f
    JOIN [catalog].[projects] AS p ON p.[folder_id] = f.[folder_id]
    JOIN [catalog].[packages] AS k ON k.[project_id] = p.[project_id]
    WHERE f.[name] = @folder_name AND p.[name] = @project_name AND k.[name] = @package_name AND k.[entry_point] = 1;
    IF @project_id IS NULL
    BEGIN
        RAISERROR(27146, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @now datetimeoffset(7) = SYSDATETIMEOFFSET();
    BEGIN TRANSACTION;
    INSERT [catalog].[operations] ([operation_type], [created_time], [object_type], [object_id], [object_name], [status], [caller_sid], [caller_name],
        [server_name], [machine_name], [operation_guid])
    VALUES (200, @now, 20, @project_id, @project_name, 1, SUSER_SID(), SUSER_SNAME(), CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')),
        CONVERT(nvarchar(128), SERVERPROPERTY('MachineName')), NEWID());
    SET @execution_id = SCOPE_IDENTITY();
    INSERT [catalog].[executions] ([execution_id], [folder_name], [project_name], [package_name], [reference_id], [project_lsn], [executed_as_sid],
        [executed_as_name], [use32bitruntime], [operation_type], [created_time], [object_type], [object_id], [status], [caller_sid], [caller_name],
        [server_name], [machine_name])
    SELECT o.[operation_id], @folder_name, @project_name, @package_name, @reference_id, @project_lsn, o.[caller_sid], o.[caller_name],
        ISNULL(@use32bitruntime, 0), o.[operation_type], o.[created_time], o.[object_type], o.[object_id], o.[status], o.[caller_sid], o.[caller_name],
        o.[server_name], o.[machine_name]
    FROM [catalog].[operations] AS o WHERE o.[operation_id] = @execution_id;
    COMMIT TRANSACTION;
    RETURN 0;
END
GO

CREATE PROCEDURE [catalog].[set_execution_parameter_value]
    @execution_id bigint,
    @object_type smallint,
    @parameter_name nvarchar(128),
    @parameter_value sql_variant
AS
BEGIN
    SET NOCOUNT ON;
    IF [catalog].[varia_fake_sql_auth]() = 1
    BEGIN
        RAISERROR(27123, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    IF @execution_id IS NULL OR @object_type IS NULL OR @parameter_name IS NULL
    BEGIN
        RAISERROR(27138, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    IF @object_type NOT IN (20, 30, 50)
    BEGIN
        RAISERROR(27101, 16, 1, N'object type') WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @status int = (SELECT [status] FROM [catalog].[executions] WHERE [execution_id] = @execution_id);
    IF @status IS NULL
    BEGIN
        RAISERROR(27103, 16, 1, @execution_id) WITH NOWAIT;
        RETURN 1;
    END
    IF @status <> 1
    BEGIN
        RAISERROR(27224, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    DELETE [catalog].[execution_parameter_values] WHERE [execution_id] = @execution_id AND [object_type] = @object_type AND [parameter_name] = @parameter_name;
    INSERT [catalog].[execution_parameter_values] ([execution_id], [object_type], [parameter_data_type], [parameter_name], [parameter_value], [sensitive],
        [required], [value_set], [runtime_override])
    VALUES (@execution_id, @object_type, CONVERT(nvarchar(128), SQL_VARIANT_PROPERTY(@parameter_value, 'BaseType')), @parameter_name, @parameter_value, 0, 0, 1, 1);
    RETURN 0;
END
GO

-- The real start_execution moves the execution to Pending (5) and hands it to ISServerExec, which sets Running (2); with
-- nothing to run, the fake goes straight to Running.
CREATE PROCEDURE [catalog].[start_execution]
    @execution_id bigint,
    @retry_count int = 0
AS
BEGIN
    SET NOCOUNT ON;
    IF [catalog].[varia_fake_sql_auth]() = 1
    BEGIN
        RAISERROR(27123, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    IF @execution_id IS NULL
    BEGIN
        RAISERROR(27138, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    IF @execution_id <= 0
    BEGIN
        RAISERROR(27101, 16, 1, N'execution_id') WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @status int = (SELECT [status] FROM [catalog].[executions] WHERE [execution_id] = @execution_id);
    IF @status IS NULL
    BEGIN
        RAISERROR(27103, 16, 1, @execution_id) WITH NOWAIT;
        RETURN 1;
    END
    IF @status <> 1
    BEGIN
        RAISERROR(27121, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @now datetimeoffset(7) = SYSDATETIMEOFFSET();
    BEGIN TRANSACTION;
    UPDATE [catalog].[operations] SET [status] = 2, [start_time] = @now, [process_id] = @@SPID WHERE [operation_id] = @execution_id;
    UPDATE [catalog].[executions] SET [status] = 2, [start_time] = @now, [process_id] = @@SPID, [executed_count] = 1 WHERE [execution_id] = @execution_id;
    COMMIT TRANSACTION;
    RETURN 0;
END
GO

-- As the real internal.prepare_stop: only a running (2) or stopping (8) execution or validation can be stopped; the stop is
-- an operation of its own (type 202), and the target goes to Stopping (8) until ISServerExec ends it.
CREATE PROCEDURE [catalog].[stop_operation]
    @operation_id bigint
AS
BEGIN
    SET NOCOUNT ON;
    IF [catalog].[varia_fake_sql_auth]() = 1
    BEGIN
        RAISERROR(27123, 16, 11) WITH NOWAIT;
        RETURN 1;
    END
    IF @operation_id IS NULL
    BEGIN
        RAISERROR(27100, 16, 11, 'operation_id') WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @status int, @object_id bigint, @object_name nvarchar(260);
    SELECT @status = [status], @object_id = [object_id], @object_name = [object_name]
    FROM [catalog].[operations]
    WHERE [operation_id] = @operation_id AND [status] IN (2, 8) AND [operation_type] IN (200, 300, 301);
    IF @status IS NULL
    BEGIN
        RAISERROR(27124, 16, 1, @operation_id) WITH NOWAIT;
        RETURN 1;
    END
    IF @status = 8
    BEGIN
        RAISERROR(27126, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @now datetimeoffset(7) = SYSDATETIMEOFFSET();
    BEGIN TRANSACTION;
    INSERT [catalog].[operations] ([operation_type], [created_time], [object_type], [object_id], [object_name], [status], [start_time], [end_time],
        [caller_sid], [caller_name], [server_name], [machine_name], [operation_guid])
    VALUES (202, @now, 20, @object_id, @object_name, 7, @now, @now, SUSER_SID(), SUSER_SNAME(), CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')),
        CONVERT(nvarchar(128), SERVERPROPERTY('MachineName')), NEWID());
    UPDATE [catalog].[operations] SET [status] = 8, [stopped_by_sid] = SUSER_SID(), [stopped_by_name] = SUSER_SNAME() WHERE [operation_id] = @operation_id;
    UPDATE [catalog].[executions] SET [status] = 8, [stopped_by_sid] = SUSER_SID(), [stopped_by_name] = SUSER_SNAME() WHERE [execution_id] = @operation_id;
    COMMIT TRANSACTION;
    RETURN 0;
END
GO

-- Ends an operation as ISServerExec would: a final status (3 Canceled, 4 Failed, 6 Ended unexpectedly, 7 Succeeded,
-- 9 Completed) and its end time.
CREATE PROCEDURE [catalog].[varia_fake_finish]
    @operation_id bigint,
    @status int
AS
BEGIN
    SET NOCOUNT ON;
    IF @status NOT IN (3, 4, 6, 7, 9)
    BEGIN
        RAISERROR(27101, 16, 1, N'status') WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @now datetimeoffset(7) = SYSDATETIMEOFFSET();
    BEGIN TRANSACTION;
    UPDATE [catalog].[operations] SET [status] = @status, [end_time] = @now WHERE [operation_id] = @operation_id;
    UPDATE [catalog].[executions] SET [status] = @status, [end_time] = @now WHERE [execution_id] = @operation_id;
    COMMIT TRANSACTION;
    RETURN 0;
END
GO

-- Writes this session's share of an execution's messages: of @messages in all, those whose index modulo @threads is
-- @thread, so @threads sessions calling it at once interleave their identities as ISServerExec's threads do. Each message
-- is one operation_messages row and its event_messages row with the same id (catalog.event_messages is operation_messages
-- LEFT JOIN event_messages on that id), in a transaction of its own. Before its first message commits, the session waits
-- for a shared application lock named @hold_first_lock (the test holds it exclusively until it has read what it needs), and
-- every @hold_every-th message after that waits @hold_ms, so later ids commit before earlier ones.
CREATE PROCEDURE [catalog].[varia_fake_run]
    @operation_id bigint,
    @messages int,
    @threads int,
    @thread int = 0,
    @hold_first_lock nvarchar(255) = NULL,
    @hold_every int = 0,
    @hold_ms int = 0
AS
BEGIN
    SET NOCOUNT ON;
    IF @messages < 0 OR @messages > 1000000 OR @threads < 1 OR @threads > 64 OR @thread < 0 OR @thread >= @threads
        OR @hold_ms NOT BETWEEN 0 AND 60000 OR @hold_every < 0
    BEGIN
        RAISERROR(27101, 16, 1, N'varia_fake_run') WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @index int = @thread, @written int = 0, @id bigint, @now datetimeoffset(7), @hold int, @delay char(12), @granted int;
    WHILE @index < @messages
    BEGIN
        SET @now = SYSDATETIMEOFFSET();
        BEGIN TRANSACTION;
        INSERT [catalog].[operation_messages] ([operation_id], [message_time], [message_type], [message_source_type], [message])
        VALUES (@operation_id, @now, 70, 40, N'Fake message ' + CONVERT(nvarchar(12), @index) + N' from thread ' + CONVERT(nvarchar(12), @thread));
        SET @id = SCOPE_IDENTITY();
        INSERT [catalog].[event_messages] ([event_message_id], [operation_id], [message_time], [message_type], [message_source_type], [message],
            [package_name], [event_name], [message_source_name], [message_source_id], [subcomponent_name], [package_path], [execution_path], [threadID], [message_code])
        SELECT [operation_message_id], [operation_id], [message_time], [message_type], [message_source_type], [message],
            N'Fake.dtsx', N'OnInformation', N'Fake task ' + CONVERT(nvarchar(12), @thread), N'{00000000-0000-0000-0000-000000000000}', NULL,
            N'\Package\Fake task ' + CONVERT(nvarchar(12), @thread), N'\Fake\Fake task ' + CONVERT(nvarchar(12), @thread), @thread, 0
        FROM [catalog].[operation_messages] WHERE [operation_message_id] = @id;
        IF @written = 0 AND @hold_first_lock IS NOT NULL
        BEGIN
            EXEC @granted = sys.sp_getapplock @Resource = @hold_first_lock, @LockMode = N'Shared', @LockOwner = N'Transaction', @LockTimeout = 120000;
            IF @granted < 0
            BEGIN
                ROLLBACK TRANSACTION;
                RAISERROR(27101, 16, 1, N'hold_first_lock') WITH NOWAIT;
                RETURN 1;
            END
        END
        SET @hold = CASE WHEN @hold_every > 0 AND @written > 0 AND @written % @hold_every = 0 THEN @hold_ms ELSE 0 END;
        IF @hold > 0
        BEGIN
            SET @delay = CONVERT(char(12), DATEADD(millisecond, @hold, CONVERT(datetime, 0)), 114);
            WAITFOR DELAY @delay;
        END
        COMMIT TRANSACTION;
        INSERT [catalog].[varia_fake_commits] ([operation_message_id], [thread]) VALUES (@id, @thread);
        SET @written += 1;
        SET @index += @threads;
    END
    RETURN 0;
END
GO
