-- Script As server objects for the scratch run (spec G4), run in master. {{scratch}} is the scratch database's name, so
-- every object carries it and ScriptingGoldenChecks drops them all afterwards (and sweeps a crashed run's leftovers).
-- The linked server points at localhost so its script does not depend on the host's name; SQL Server 2017 on Linux
-- accepts only SQL Server providers, named SQLNCLI there and in later versions.
EXEC master.dbo.sp_addlinkedserver @server = N'{{scratch}}_ls', @srvproduct = N'', @provider = N'SQLNCLI', @datasrc = N'localhost';
CREATE CREDENTIAL [{{scratch}}_cred] WITH IDENTITY = N'scratch-identity', SECRET = N'not-a-secret';
CREATE SERVER ROLE [{{scratch}}_role];
DECLARE @path nvarchar(4000) = CONVERT(nvarchar(4000), ISNULL(SERVERPROPERTY('InstanceDefaultBackupPath'), SERVERPROPERTY('InstanceDefaultDataPath')));
DECLARE @device nvarchar(4000) = @path + CASE WHEN RIGHT(@path, 1) IN (N'/', N'\') THEN N'' ELSE N'/' END + N'{{scratch}}_dev.bak';
EXEC master.dbo.sp_addumpdevice @devtype = N'disk', @logicalname = N'{{scratch}}_dev', @physicalname = @device;
DECLARE @log nvarchar(4000) = CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultLogPath'));
DECLARE @sql nvarchar(max) = N'CREATE SERVER AUDIT [{{scratch}}_audit] TO FILE (FILEPATH = N''' + REPLACE(@log, N'''', N'''''') + N''');';
EXEC (@sql);
GO
CREATE SERVER AUDIT SPECIFICATION [{{scratch}}_sas] FOR SERVER AUDIT [{{scratch}}_audit] ADD (FAILED_LOGIN_GROUP);
GO
CREATE TRIGGER [{{scratch}}_trg] ON ALL SERVER FOR CREATE_CREDENTIAL AS SET NOCOUNT ON;
GO
DISABLE TRIGGER [{{scratch}}_trg] ON ALL SERVER;
GO
EXEC [{{scratch}}].sys.sp_executesql N'CREATE DATABASE AUDIT SPECIFICATION ScratchAuditSpecification FOR SERVER AUDIT [{{scratch}}_audit] ADD (SELECT ON SCHEMA::Sales BY public);';
GO
