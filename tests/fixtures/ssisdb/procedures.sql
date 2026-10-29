-- The fake SSIS catalog's procedures, run after schema.sql in a marked VariaScratch_…_ssis database (D-ssis 12.2).
-- Hand-written. Each catalog.* stub keeps the real procedure's signature and defaults (manifest.json; vitest and the live
-- checks compare them), refuses SQL Server authentication with 27123 where the real one does, raises the real catalog's
-- error numbers in its order, and writes the rows the real catalog would, a Failed (4) operation included when it refuses,
-- but never starts ISServerExec: there is no package, so nothing runs. The varia_* objects are the fake's own and are never
-- in a real catalog: varia_fake_seed adds a folder, project and package, varia_fake_run writes an execution's messages from
-- several sessions with commits held back (out-of-order commits and event rows written after their messages, D-ssis 14.3),
-- and varia_fake_finish ends an operation the way ISServerExec would.
-- The catalog's roles that every view's row-level security and D-ssis 4.1's SsisProfile read with IS_MEMBER.
CREATE ROLE [ssis_admin];
CREATE ROLE [ssis_logreader];
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

-- As the real one: the operation (type 200, Created, no object yet) commits before the transaction that looks the package
-- up, by name only (any package, entry point or not), so a refusal leaves that operation Failed (4) with no execution.
CREATE PROCEDURE [catalog].[create_execution]
    @folder_name nvarchar(128),
    @project_name nvarchar(128),
    @package_name nvarchar(260),
    @reference_id bigint = NULL,
    @use32bitruntime bit = 0,
    @runinscaleout bit = NULL,
    @useanyworker bit = 1,
    @execution_id bigint OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    IF [catalog].[varia_fake_sql_auth]() = 1
    BEGIN
        RAISERROR(27123, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    IF @folder_name IS NULL OR @project_name IS NULL OR @package_name IS NULL OR @use32bitruntime IS NULL
    BEGIN
        RAISERROR(27138, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @now datetimeoffset(7) = SYSDATETIMEOFFSET(), @operation_id bigint;
    INSERT [catalog].[operations] ([operation_type], [created_time], [object_type], [object_id], [object_name], [status], [caller_sid], [caller_name],
        [server_name], [machine_name], [operation_guid])
    VALUES (200, @now, 20, NULL, @project_name, 1, SUSER_SID(), SUSER_SNAME(), CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')),
        CONVERT(nvarchar(128), SERVERPROPERTY('MachineName')), NEWID());
    SET @operation_id = SCOPE_IDENTITY();
    SET @execution_id = @operation_id;
    BEGIN TRANSACTION;
    DECLARE @project_id bigint, @project_lsn bigint;
    SELECT @project_id = p.[project_id], @project_lsn = p.[object_version_lsn]
    FROM [catalog].[folders] AS f
    JOIN [catalog].[projects] AS p ON p.[folder_id] = f.[folder_id]
    JOIN [catalog].[packages] AS k ON k.[project_id] = p.[project_id]
    WHERE f.[name] = @folder_name AND p.[name] = @project_name AND k.[name] = @package_name;
    IF @project_id IS NULL
    BEGIN
        ROLLBACK TRANSACTION;
        UPDATE [catalog].[operations] SET [status] = 4, [end_time] = SYSDATETIMEOFFSET() WHERE [operation_id] = @operation_id;
        RAISERROR(27146, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    UPDATE [catalog].[operations] SET [object_id] = @project_id WHERE [operation_id] = @operation_id;
    INSERT [catalog].[executions] ([execution_id], [folder_name], [project_name], [package_name], [reference_id], [project_lsn], [executed_as_sid],
        [executed_as_name], [use32bitruntime], [operation_type], [created_time], [object_type], [object_id], [status], [caller_sid], [caller_name],
        [server_name], [machine_name])
    SELECT o.[operation_id], @folder_name, @project_name, @package_name, @reference_id, @project_lsn, o.[caller_sid], o.[caller_name],
        @use32bitruntime, o.[operation_type], o.[created_time], o.[object_type], o.[object_id], o.[status], o.[caller_sid], o.[caller_name],
        o.[server_name], o.[machine_name]
    FROM [catalog].[operations] AS o WHERE o.[operation_id] = @operation_id;
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

-- As the real one and its internal.prepare_stop: the null check comes before the refusal, and the stop is an operation of its
-- own (type 202, Running, no object yet) committed before anything is checked, so a refused stop leaves it Failed (4). Only a
-- running (2) or stopping (8) execution or validation with a process can be stopped; the target goes to Stopping (8) until
-- ISServerExec ends it, and the stop gets the target's object and ends Succeeded (7).
CREATE PROCEDURE [catalog].[stop_operation]
    @operation_id bigint
AS
BEGIN
    SET NOCOUNT ON;
    IF @operation_id IS NULL
    BEGIN
        RAISERROR(27100, 16, 11, 'operation_id') WITH NOWAIT;
        RETURN 1;
    END
    IF [catalog].[varia_fake_sql_auth]() = 1
    BEGIN
        RAISERROR(27123, 16, 11) WITH NOWAIT;
        RETURN 1;
    END
    INSERT [catalog].[operations] ([operation_type], [created_time], [object_type], [object_id], [object_name], [status], [start_time], [caller_sid], [caller_name])
    VALUES (202, SYSDATETIMEOFFSET(), 20, NULL, NULL, 2, SYSDATETIMEOFFSET(), SUSER_SID(), SUSER_SNAME());
    DECLARE @stop_id bigint = SCOPE_IDENTITY(), @status int, @object_id bigint, @object_name nvarchar(260), @process_id int, @error int = 0;
    BEGIN TRANSACTION;
    SELECT @status = [status], @object_id = [object_id], @object_name = [object_name], @process_id = [process_id]
    FROM [catalog].[operations]
    WHERE [operation_id] = @operation_id AND [status] IN (2, 8) AND [operation_type] IN (200, 300, 301);
    SET @error = CASE WHEN @status IS NULL OR @object_id IS NULL THEN 27124 WHEN @status = 8 THEN 27126 WHEN @process_id IS NULL THEN 27125 ELSE 0 END;
    IF @error <> 0
    BEGIN
        ROLLBACK TRANSACTION;
        UPDATE [catalog].[operations] SET [status] = 4, [end_time] = SYSDATETIMEOFFSET() WHERE [operation_id] = @stop_id;
        IF @error = 27124 RAISERROR(27124, 16, 1, @operation_id) WITH NOWAIT;
        ELSE IF @error = 27126 RAISERROR(27126, 16, 1) WITH NOWAIT;
        ELSE RAISERROR(27125, 16, 1) WITH NOWAIT;
        RETURN 1;
    END
    UPDATE [catalog].[operations] SET [status] = 8, [stopped_by_sid] = SUSER_SID(), [stopped_by_name] = SUSER_SNAME() WHERE [operation_id] = @operation_id;
    UPDATE [catalog].[executions] SET [status] = 8, [stopped_by_sid] = SUSER_SID(), [stopped_by_name] = SUSER_SNAME() WHERE [execution_id] = @operation_id;
    UPDATE [catalog].[operations] SET [object_id] = @object_id, [object_name] = @object_name WHERE [operation_id] = @stop_id;
    COMMIT TRANSACTION;
    UPDATE [catalog].[operations] SET [status] = 7, [end_time] = SYSDATETIMEOFFSET() WHERE [operation_id] = @stop_id;
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
-- @thread, so @threads sessions calling it at once interleave their identities as ISServerExec's threads do. A message is
-- written as the real internal.append_event_message writes it: an operation_messages row, then, in a statement of its own,
-- its varia_event_messages row with the same id (catalog.event_messages is operation_messages LEFT JOIN those rows), so a
-- reader can see the message with NULL event columns in between. Every @operation_only_every-th message (1-based) is an
-- operation message only, as internal.append_operation_message writes one. Holds, to make the hazards wide enough to read:
-- - @hold_first_lock: the first message's two rows go in one transaction that waits, before it commits, for a shared
--   application lock of that name (the test holds it exclusively until it has read what it needs);
-- - @hold_every and @hold_ms: every @hold_every-th message after the first likewise waits @hold_ms before it commits, so
--   later ids commit before earlier ones;
-- - @event_after_lock: the first message's operation row commits, and its event row is inserted only once a shared
--   application lock of that name is granted.
CREATE PROCEDURE [catalog].[varia_fake_run]
    @operation_id bigint,
    @messages int,
    @threads int,
    @thread int = 0,
    @hold_first_lock nvarchar(255) = NULL,
    @hold_every int = 0,
    @hold_ms int = 0,
    @event_after_lock nvarchar(255) = NULL,
    @operation_only_every int = 0
AS
BEGIN
    SET NOCOUNT ON;
    IF @messages < 0 OR @messages > 1000000 OR @threads < 1 OR @threads > 64 OR @thread < 0 OR @thread >= @threads
        OR @hold_ms NOT BETWEEN 0 AND 60000 OR @hold_every < 0 OR @operation_only_every < 0
        OR (@hold_first_lock IS NOT NULL AND @event_after_lock IS NOT NULL)
    BEGIN
        RAISERROR(27101, 16, 1, N'varia_fake_run') WITH NOWAIT;
        RETURN 1;
    END
    DECLARE @index int = @thread, @written int = 0, @id bigint, @now datetimeoffset(7), @hold int, @delay char(12), @granted int, @held bit, @event bit;
    WHILE @index < @messages
    BEGIN
        SET @now = SYSDATETIMEOFFSET();
        SET @hold = CASE WHEN @hold_every > 0 AND @written > 0 AND @written % @hold_every = 0 THEN @hold_ms ELSE 0 END;
        SET @held = CASE WHEN @hold > 0 OR (@written = 0 AND @hold_first_lock IS NOT NULL) THEN 1 ELSE 0 END;
        SET @event = CASE WHEN @operation_only_every > 0 AND (@index + 1) % @operation_only_every = 0 THEN 0 ELSE 1 END;
        IF @held = 1 BEGIN TRANSACTION;
        INSERT [catalog].[operation_messages] ([operation_id], [message_time], [message_type], [message_source_type], [message])
        VALUES (@operation_id, @now, 70, 40, N'Fake message ' + CONVERT(nvarchar(12), @index) + N' from thread ' + CONVERT(nvarchar(12), @thread));
        SET @id = SCOPE_IDENTITY();
        IF @written = 0 AND @event_after_lock IS NOT NULL
        BEGIN
            EXEC @granted = sys.sp_getapplock @Resource = @event_after_lock, @LockMode = N'Shared', @LockOwner = N'Session', @LockTimeout = 120000;
            IF @granted < 0
            BEGIN
                RAISERROR(27101, 16, 1, N'event_after_lock') WITH NOWAIT;
                RETURN 1;
            END
            EXEC sys.sp_releaseapplock @Resource = @event_after_lock, @LockOwner = N'Session';
        END
        IF @event = 1
            INSERT [catalog].[varia_event_messages] ([event_message_id], [operation_id], [package_name], [event_name], [message_source_name], [message_source_id],
                [subcomponent_name], [package_path], [execution_path], [threadID], [message_code])
            VALUES (@id, @operation_id, N'Fake.dtsx', N'OnInformation', N'Fake task ' + CONVERT(nvarchar(12), @thread), N'{00000000-0000-0000-0000-000000000000}', NULL,
                N'\Package\Fake task ' + CONVERT(nvarchar(12), @thread), N'\Fake\Fake task ' + CONVERT(nvarchar(12), @thread), @thread, 0);
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
        IF @hold > 0
        BEGIN
            SET @delay = CONVERT(char(12), DATEADD(millisecond, @hold, CONVERT(datetime, 0)), 114);
            WAITFOR DELAY @delay;
        END
        IF @held = 1 COMMIT TRANSACTION;
        INSERT [catalog].[varia_fake_commits] ([operation_message_id], [thread]) VALUES (@id, @thread);
        SET @written += 1;
        SET @index += @threads;
    END
    RETURN 0;
END
GO
