-- Generated from manifest.json (band 17, backup 17.0.1000.7, schema version 8) by
-- tests/ssisdb-fixtures.test.ts; regenerate with npx vitest run tests/ssisdb-fixtures.test.ts -u, never by hand. The fake catalog:
-- one table per catalog view with its columns, an identity where the view reads its internal table's identity, and that
-- table's indexes where the view has their keys; catalog.event_messages is a view of operation_messages LEFT JOIN the
-- fake's varia_event_messages, as the real view is. No row-level security, no internal schema, no CLR.
CREATE SCHEMA [catalog];
GO
CREATE TABLE [catalog].[alwayson_replicas] (
    [server_name] nvarchar(256) NOT NULL,
    [state] tinyint NOT NULL
);
CREATE TABLE [catalog].[catalog_properties] (
    [property_name] nvarchar(256) NOT NULL,
    [property_value] nvarchar(max) NOT NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_ISServer_Property] ON [catalog].[catalog_properties] ([property_name]);
CREATE TABLE [catalog].[customized_logging_levels] (
    [level_id] bigint IDENTITY(1, 1) NOT NULL,
    [name] sysname NOT NULL,
    [description] nvarchar(1024) NULL,
    [profile_value] bigint NOT NULL,
    [events_value] bigint NOT NULL,
    [created_by_sid] varbinary(85) NOT NULL,
    [created_by_name] nvarchar(128) NOT NULL,
    [created_time] datetimeoffset(7) NOT NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Levels] ON [catalog].[customized_logging_levels] ([level_id]);
CREATE UNIQUE NONCLUSTERED INDEX [Unique_level_name] ON [catalog].[customized_logging_levels] ([name]);
CREATE TABLE [catalog].[effective_object_permissions] (
    [object_type] smallint NULL,
    [object_id] bigint NOT NULL,
    [permission_type] smallint NULL
);
CREATE TABLE [catalog].[environment_references] (
    [reference_id] bigint IDENTITY(1, 1) NOT NULL,
    [project_id] bigint NOT NULL,
    [reference_type] char(1) NOT NULL,
    [environment_folder_name] nvarchar(128) NULL,
    [environment_name] sysname NOT NULL,
    [validation_status] char(1) NOT NULL,
    [last_validation_time] datetimeoffset(7) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_environment_references] ON [catalog].[environment_references] ([reference_id]);
CREATE TABLE [catalog].[environment_variables] (
    [variable_id] bigint IDENTITY(1, 1) NOT NULL,
    [environment_id] bigint NOT NULL,
    [name] sysname NOT NULL,
    [description] nvarchar(1024) NULL,
    [type] nvarchar(128) NOT NULL,
    [sensitive] bit NOT NULL,
    [value] sql_variant NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Environment_Variables] ON [catalog].[environment_variables] ([variable_id]);
CREATE UNIQUE NONCLUSTERED INDEX [Unique_Environment_Variable] ON [catalog].[environment_variables] ([environment_id], [name]);
CREATE TABLE [catalog].[environments] (
    [environment_id] bigint IDENTITY(1, 1) NOT NULL,
    [name] sysname NOT NULL,
    [folder_id] bigint NOT NULL,
    [description] nvarchar(1024) NULL,
    [created_by_sid] varbinary(85) NOT NULL,
    [created_by_name] nvarchar(128) NOT NULL,
    [created_time] datetimeoffset(7) NOT NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Environments] ON [catalog].[environments] ([environment_id]);
CREATE TABLE [catalog].[event_message_context] (
    [context_id] bigint IDENTITY(1, 1) NOT NULL,
    [event_message_id] bigint NULL,
    [context_depth] int NULL,
    [package_path] nvarchar(max) NULL,
    [context_type] smallint NULL,
    [context_source_name] nvarchar(4000) NULL,
    [context_source_id] nvarchar(38) NULL,
    [property_name] nvarchar(4000) NULL,
    [property_value] sql_variant NULL,
    [event_message_guid] uniqueidentifier NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Event_Message_Context] ON [catalog].[event_message_context] ([context_id]);
CREATE NONCLUSTERED INDEX [IX_EventMessageContext_EventMessageId] ON [catalog].[event_message_context] ([event_message_id]);
CREATE TABLE [catalog].[varia_event_messages] (
    [event_message_id] bigint NOT NULL,
    [operation_id] bigint NOT NULL,
    [package_name] nvarchar(260) NULL,
    [event_name] nvarchar(1024) NULL,
    [message_source_name] nvarchar(4000) NULL,
    [message_source_id] nvarchar(38) NULL,
    [subcomponent_name] nvarchar(4000) NULL,
    [package_path] nvarchar(max) NULL,
    [execution_path] nvarchar(max) NULL,
    [threadID] int NULL,
    [message_code] int NULL,
    [event_message_guid] uniqueidentifier NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Event_Messages] ON [catalog].[varia_event_messages] ([event_message_id]);
CREATE NONCLUSTERED INDEX [IX_EventMessages_Operation_id] ON [catalog].[varia_event_messages] ([operation_id]);
CREATE TABLE [catalog].[executable_statistics] (
    [statistics_id] bigint IDENTITY(1, 1) NOT NULL,
    [execution_id] bigint NOT NULL,
    [executable_id] bigint NOT NULL,
    [execution_path] nvarchar(max) NULL,
    [start_time] datetimeoffset(7) NULL,
    [end_time] datetimeoffset(7) NULL,
    [execution_duration] int NULL,
    [execution_result] smallint NULL,
    [execution_value] sql_variant NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Executable_statistics] ON [catalog].[executable_statistics] ([statistics_id]);
CREATE NONCLUSTERED INDEX [IX_ExecutableStatistics_Execution_id] ON [catalog].[executable_statistics] ([execution_id]);
CREATE TABLE [catalog].[executables] (
    [executable_id] bigint IDENTITY(1, 1) NOT NULL,
    [execution_id] bigint NOT NULL,
    [executable_name] nvarchar(4000) NULL,
    [executable_guid] nvarchar(38) NULL,
    [package_name] nvarchar(260) NOT NULL,
    [package_path] nvarchar(max) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Executables] ON [catalog].[executables] ([executable_id]);
CREATE TABLE [catalog].[execution_component_phases] (
    [phase_stats_id] bigint IDENTITY(1, 1) NOT NULL,
    [execution_id] bigint NOT NULL,
    [package_name] nvarchar(260) NOT NULL,
    [task_name] nvarchar(4000) NOT NULL,
    [subcomponent_name] nvarchar(4000) NULL,
    [phase] sysname NOT NULL,
    [start_time] datetimeoffset(7) NULL,
    [end_time] datetimeoffset(7) NULL,
    [execution_path] nvarchar(max) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Execution_component_phases] ON [catalog].[execution_component_phases] ([phase_stats_id]);
CREATE TABLE [catalog].[execution_data_statistics] (
    [data_stats_id] bigint IDENTITY(1, 1) NOT NULL,
    [execution_id] bigint NOT NULL,
    [package_name] nvarchar(260) NOT NULL,
    [task_name] nvarchar(4000) NULL,
    [dataflow_path_id_string] nvarchar(4000) NULL,
    [dataflow_path_name] nvarchar(4000) NULL,
    [source_component_name] nvarchar(4000) NULL,
    [destination_component_name] nvarchar(4000) NULL,
    [rows_sent] bigint NULL,
    [created_time] datetimeoffset(7) NULL,
    [execution_path] nvarchar(max) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Execution_data_statistics] ON [catalog].[execution_data_statistics] ([data_stats_id]);
CREATE TABLE [catalog].[execution_data_taps] (
    [data_tap_id] bigint IDENTITY(1, 1) NOT NULL,
    [execution_id] bigint NOT NULL,
    [package_path] nvarchar(max) NULL,
    [dataflow_path_id_string] nvarchar(4000) NULL,
    [dataflow_task_guid] uniqueidentifier NULL,
    [max_rows] int NULL,
    [filename] nvarchar(4000) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Execution_data_taps] ON [catalog].[execution_data_taps] ([data_tap_id]);
CREATE TABLE [catalog].[execution_parameter_values] (
    [execution_parameter_id] bigint IDENTITY(1, 1) NOT NULL,
    [execution_id] bigint NOT NULL,
    [object_type] smallint NOT NULL,
    [parameter_data_type] nvarchar(128) NOT NULL,
    [parameter_name] sysname NOT NULL,
    [parameter_value] sql_variant NULL,
    [sensitive] bit NOT NULL,
    [required] bit NOT NULL,
    [value_set] bit NOT NULL,
    [runtime_override] bit NOT NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Execution_Parameter_value] ON [catalog].[execution_parameter_values] ([execution_parameter_id]);
CREATE NONCLUSTERED INDEX [IX_ExecutionParameterValue_ExecutionId] ON [catalog].[execution_parameter_values] ([execution_id]);
CREATE NONCLUSTERED INDEX [IX_ExecutionParameterValue_ExecutionIdObjectType] ON [catalog].[execution_parameter_values] ([execution_id], [object_type]);
CREATE TABLE [catalog].[execution_property_override_values] (
    [property_id] bigint IDENTITY(1, 1) NOT NULL,
    [execution_id] bigint NOT NULL,
    [property_path] nvarchar(4000) NOT NULL,
    [property_value] nvarchar(max) NULL,
    [sensitive] bit NOT NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Execution_Property_Override_Value] ON [catalog].[execution_property_override_values] ([property_id]);
CREATE NONCLUSTERED INDEX [IX_ExecutionPropertyOverrideValues_ExecutionId] ON [catalog].[execution_property_override_values] ([execution_id]);
CREATE TABLE [catalog].[executions] (
    [execution_id] bigint NOT NULL,
    [folder_name] sysname NOT NULL,
    [project_name] sysname NOT NULL,
    [package_name] nvarchar(260) NOT NULL,
    [reference_id] bigint NULL,
    [reference_type] char(1) NULL,
    [environment_folder_name] nvarchar(128) NULL,
    [environment_name] nvarchar(128) NULL,
    [project_lsn] bigint NULL,
    [executed_as_sid] varbinary(85) NOT NULL,
    [executed_as_name] nvarchar(128) NOT NULL,
    [use32bitruntime] bit NOT NULL,
    [operation_type] smallint NOT NULL,
    [created_time] datetimeoffset(7) NULL,
    [object_type] smallint NULL,
    [object_id] bigint NULL,
    [status] int NOT NULL,
    [start_time] datetimeoffset(7) NULL,
    [end_time] datetimeoffset(7) NULL,
    [caller_sid] varbinary(85) NOT NULL,
    [caller_name] sysname NOT NULL,
    [process_id] int NULL,
    [stopped_by_sid] varbinary(85) NULL,
    [stopped_by_name] nvarchar(128) NULL,
    [dump_id] uniqueidentifier NULL,
    [server_name] nvarchar(128) NULL,
    [machine_name] nvarchar(128) NULL,
    [worker_agent_id] uniqueidentifier NULL,
    [total_physical_memory_kb] bigint NULL,
    [available_physical_memory_kb] bigint NULL,
    [total_page_file_kb] bigint NULL,
    [available_page_file_kb] bigint NULL,
    [cpu_count] int NULL,
    [executed_count] int NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Executions] ON [catalog].[executions] ([execution_id]);
CREATE TABLE [catalog].[explicit_object_permissions] (
    [object_type] smallint NULL,
    [object_id] bigint NOT NULL,
    [principal_id] int NULL,
    [permission_type] smallint NOT NULL,
    [is_deny] bit NOT NULL,
    [grantor_id] int NULL
);
CREATE TABLE [catalog].[extended_operation_info] (
    [info_id] bigint IDENTITY(1, 1) NOT NULL,
    [operation_id] bigint NOT NULL,
    [object_name] nvarchar(260) NOT NULL,
    [object_type] smallint NULL,
    [reference_id] bigint NULL,
    [status] int NOT NULL,
    [start_time] datetimeoffset(7) NOT NULL,
    [end_time] datetimeoffset(7) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Operation_Info] ON [catalog].[extended_operation_info] ([info_id]);
CREATE TABLE [catalog].[folders] (
    [folder_id] bigint IDENTITY(1, 1) NOT NULL,
    [name] sysname NOT NULL,
    [description] nvarchar(1024) NULL,
    [created_by_sid] varbinary(85) NOT NULL,
    [created_by_name] nvarchar(128) NOT NULL,
    [created_time] datetimeoffset(7) NOT NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Folders] ON [catalog].[folders] ([folder_id]);
CREATE UNIQUE NONCLUSTERED INDEX [Unique_folder_name] ON [catalog].[folders] ([name]);
CREATE TABLE [catalog].[master_properties] (
    [property_name] nvarchar(256) NOT NULL,
    [property_value] nvarchar(max) NOT NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Master_Property] ON [catalog].[master_properties] ([property_name]);
CREATE TABLE [catalog].[object_parameters] (
    [parameter_id] bigint IDENTITY(1, 1) NOT NULL,
    [project_id] bigint NOT NULL,
    [object_type] smallint NOT NULL,
    [object_name] nvarchar(260) NOT NULL,
    [parameter_name] sysname NOT NULL,
    [data_type] nvarchar(128) NOT NULL,
    [required] bit NOT NULL,
    [sensitive] bit NOT NULL,
    [description] nvarchar(1024) NULL,
    [design_default_value] sql_variant NULL,
    [default_value] sql_variant NULL,
    [value_type] char(1) NOT NULL,
    [value_set] bit NOT NULL,
    [referenced_variable_name] nvarchar(128) NULL,
    [validation_status] char(1) NOT NULL,
    [last_validation_time] datetimeoffset(7) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Object_Parameters] ON [catalog].[object_parameters] ([parameter_id]);
CREATE TABLE [catalog].[object_versions] (
    [object_version_lsn] bigint IDENTITY(1, 1) NOT NULL,
    [object_id] bigint NOT NULL,
    [object_type] smallint NOT NULL,
    [object_name] sysname NOT NULL,
    [description] nvarchar(1024) NULL,
    [created_by] nvarchar(128) NOT NULL,
    [created_time] datetimeoffset(7) NOT NULL,
    [restored_by] nvarchar(128) NULL,
    [last_restored_time] datetimeoffset(7) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Object_Versions] ON [catalog].[object_versions] ([object_version_lsn]);
CREATE TABLE [catalog].[operation_messages] (
    [operation_message_id] bigint IDENTITY(1, 1) NOT NULL,
    [operation_id] bigint NOT NULL,
    [message_time] datetimeoffset(7) NOT NULL,
    [message_type] smallint NOT NULL,
    [message_source_type] smallint NULL,
    [message] nvarchar(max) NULL,
    [extended_info_id] bigint NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Operation_Messages] ON [catalog].[operation_messages] ([operation_message_id]);
CREATE NONCLUSTERED INDEX [IX_OperationMessages_Operation_id] ON [catalog].[operation_messages] ([operation_id]);
CREATE TABLE [catalog].[operations] (
    [operation_id] bigint IDENTITY(1, 1) NOT NULL,
    [operation_type] smallint NOT NULL,
    [created_time] datetimeoffset(7) NULL,
    [object_type] smallint NULL,
    [object_id] bigint NULL,
    [object_name] nvarchar(260) NULL,
    [status] int NOT NULL,
    [start_time] datetimeoffset(7) NULL,
    [end_time] datetimeoffset(7) NULL,
    [caller_sid] varbinary(85) NOT NULL,
    [caller_name] sysname NOT NULL,
    [process_id] int NULL,
    [stopped_by_sid] varbinary(85) NULL,
    [stopped_by_name] nvarchar(128) NULL,
    [server_name] nvarchar(128) NULL,
    [machine_name] nvarchar(128) NULL,
    [operation_guid] uniqueidentifier NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Operations] ON [catalog].[operations] ([operation_id]);
CREATE NONCLUSTERED INDEX [IX_Operations_object_id] ON [catalog].[operations] ([object_id]);
CREATE TABLE [catalog].[packages] (
    [package_id] bigint IDENTITY(1, 1) NOT NULL,
    [name] nvarchar(260) NOT NULL,
    [package_guid] uniqueidentifier NOT NULL,
    [description] nvarchar(1024) NULL,
    [package_format_version] int NOT NULL,
    [version_major] int NOT NULL,
    [version_minor] int NOT NULL,
    [version_build] int NOT NULL,
    [version_comments] nvarchar(1024) NULL,
    [version_guid] uniqueidentifier NOT NULL,
    [project_id] bigint NOT NULL,
    [entry_point] bit NOT NULL,
    [validation_status] char(1) NOT NULL,
    [last_validation_time] datetimeoffset(7) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Packages] ON [catalog].[packages] ([package_id]);
CREATE NONCLUSTERED INDEX [IX_Packages_Name] ON [catalog].[packages] ([name]);
CREATE TABLE [catalog].[projects] (
    [project_id] bigint IDENTITY(1, 1) NOT NULL,
    [folder_id] bigint NOT NULL,
    [name] sysname NOT NULL,
    [description] nvarchar(1024) NULL,
    [project_format_version] int NULL,
    [deployed_by_sid] varbinary(85) NOT NULL,
    [deployed_by_name] nvarchar(128) NOT NULL,
    [last_deployed_time] datetimeoffset(7) NOT NULL,
    [created_time] datetimeoffset(7) NOT NULL,
    [object_version_lsn] bigint NOT NULL,
    [validation_status] char(1) NOT NULL,
    [last_validation_time] datetimeoffset(7) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Projects] ON [catalog].[projects] ([project_id]);
CREATE NONCLUSTERED INDEX [IX_Projects_Name] ON [catalog].[projects] ([name]);
CREATE UNIQUE NONCLUSTERED INDEX [Unique_Project_FolderName] ON [catalog].[projects] ([name], [folder_id]);
CREATE TABLE [catalog].[validations] (
    [validation_id] bigint NOT NULL,
    [environment_scope] char(1) NOT NULL,
    [validate_type] char(1) NOT NULL,
    [folder_name] sysname NOT NULL,
    [project_name] sysname NOT NULL,
    [project_lsn] bigint NULL,
    [use32bitruntime] bit NULL,
    [reference_id] bigint NULL,
    [operation_type] smallint NOT NULL,
    [object_name] nvarchar(260) NULL,
    [object_type] smallint NULL,
    [object_id] bigint NULL,
    [start_time] datetimeoffset(7) NULL,
    [end_time] datetimeoffset(7) NULL,
    [status] int NOT NULL,
    [caller_sid] varbinary(85) NOT NULL,
    [caller_name] sysname NOT NULL,
    [process_id] int NULL,
    [stopped_by_sid] varbinary(85) NULL,
    [stopped_by_name] nvarchar(128) NULL,
    [dump_id] uniqueidentifier NULL,
    [server_name] nvarchar(128) NULL,
    [machine_name] nvarchar(128) NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Validations] ON [catalog].[validations] ([validation_id]);
CREATE TABLE [catalog].[worker_agent_perfcounter] (
    [WorkerAgentId] uniqueidentifier NOT NULL,
    [PerfCounterName] nvarchar(max) NOT NULL,
    [PerfCounterValue] float NOT NULL,
    [TimeStamp] datetimeoffset(7) NOT NULL
);
CREATE NONCLUSTERED INDEX [index_worker_agent_perfcounter_TimeStampAndWorkerAgentId] ON [catalog].[worker_agent_perfcounter] ([WorkerAgentId], [TimeStamp]);
CREATE TABLE [catalog].[worker_agents] (
    [WorkerAgentId] uniqueidentifier NOT NULL,
    [IsEnabled] bit NOT NULL,
    [DisplayName] nvarchar(256) NULL,
    [Description] nvarchar(max) NULL,
    [MachineName] nvarchar(256) NULL,
    [Tags] nvarchar(max) NULL,
    [UserAccount] nvarchar(256) NULL,
    [LastOnlineTime] datetimeoffset(7) NOT NULL
);
CREATE UNIQUE CLUSTERED INDEX [PK_Worker_Agents] ON [catalog].[worker_agents] ([WorkerAgentId]);
GO
CREATE VIEW [catalog].[event_messages]
AS
SELECT
    CONVERT(bigint, m.[operation_message_id]) AS [event_message_id],
    m.[operation_id],
    m.[message_time],
    m.[message_type],
    m.[message_source_type],
    m.[message],
    m.[extended_info_id],
    e.[package_name],
    e.[event_name],
    e.[message_source_name],
    e.[message_source_id],
    e.[subcomponent_name],
    e.[package_path],
    e.[execution_path],
    e.[threadID],
    e.[message_code],
    e.[event_message_guid]
FROM [catalog].[operation_messages] AS m LEFT JOIN [catalog].[varia_event_messages] AS e ON e.[event_message_id] = m.[operation_message_id];
GO
