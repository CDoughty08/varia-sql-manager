using System.Text.Json;

namespace Varia.Backend;

internal sealed record ConnectOptions(string Server, string Database, string Authentication, string? Username, string? Password, bool TrustServerCertificate,
    string Encrypt = "mandatory", string? HostNameInCertificate = null, string? DisplayName = null, string? Color = null, AdvancedConnectionOptions? Advanced = null);
internal sealed record AdvancedConnectionOptions(
    int CommandTimeout = 0, int ConnectTimeout = 15, bool ColumnEncryption = false, bool SecureEnclaves = false,
    string AttestationProtocol = "None", string EnclaveAttestationUrl = "", bool MultipleActiveResultSets = false,
    string NetworkProtocol = "default", int PacketSize = 8000, string TransactionBinding = "Implicit Unbind", string TypeSystemVersion = "Latest",
    int ConnectRetryCount = 1, int ConnectRetryInterval = 10, string ApplicationName = "Varia SQL Manager", string WorkstationId = "",
    string ApplicationIntent = "ReadWrite", string CurrentLanguage = "", bool Replication = false, string IpAddressPreference = "IPv4First",
    string ServerCertificate = "", string AttachDbFilename = "", string FailoverPartner = "", string FailoverPartnerSpn = "",
    bool MultiSubnetFailover = false, string ServerSpn = "", bool UserInstance = false);
/// <summary>ProductVersion, Login and EngineEdition come from the server profile probed at connect; they are absent when the probe failed.</summary>
internal sealed record ConnectionInfo(string Id, string Server, string Database, string ServerVersion, string? DisplayName = null, string? Color = null, int CommandTimeout = 0,
    string? ProductVersion = null, string? Login = null, int? EngineEdition = null);
/// <summary>connections.identity: the Kerberos principal integrated authentication would use off Windows, when the default
/// credential cache holds a ticket (at most 256 characters). Windows, and Linux or macOS without a ticket, answer none.</summary>
internal sealed record IntegratedIdentity(string? Principal);
/// <summary>connections.identity takes no parameters; reading them into this record refuses unknown members.</summary>
internal sealed record IdentityArgs;
/// <summary>entra.cache.clear (main only) takes no parameters; reading them into this record refuses unknown members.</summary>
internal sealed record EntraCacheArgs;
/// <summary>entra.cache.clear: every Microsoft Entra token and credential in this process is gone.</summary>
internal sealed record EntraCacheClearResult(bool Cleared);
internal sealed record DiscoveryArgs(string Scope);
internal sealed record DiscoveredServer(string Server, string Version, string Source);
internal sealed record DiscoveryResult(List<DiscoveredServer> Servers, string? Warning = null);
internal sealed record ConnectionArgs(string ConnectionId);
internal sealed record TableArgs(string ConnectionId, string Database, string Schema, string Name);
/// <summary>query.execute. StopOnError keeps the remaining batches from running after one that raised an error (for SQLCMD's
/// :on error exit); by default execution continues with the next batch, as SSMS does.</summary>
internal sealed record QueryArgs(string ConnectionId, string SessionId, string Database, string Sql, string QueryId, int MaxRows, int TimeoutSeconds, int StartLine = 1, int MaxResultSets = 10,
    bool StopOnError = false);
/// <summary>query.session.close: Transaction "commit" commits the session's open transaction first; "rollback" is a plain close,
/// since SQL Server rolls back what a closed session left open.</summary>
internal sealed record SessionArgs(string SessionId, string? Transaction = null);
internal sealed record CancelArgs(string QueryId);
internal sealed record DatabaseInfo(string Name, bool IsSystem, bool IsSnapshot);
/// <summary>A result column as the grid sees it: wire is "text" (SSMS display text) or "binary"; role marks documents
/// (xml, json, plan), CLR UDTs and vectors.</summary>
internal sealed record ResultColumn(string Name, string DataType, string Wire, string? Role = null, int? MaxLength = null, int? Precision = null, int? Scale = null, bool Nullable = true);
/// <summary>A stored result set. rowsAvailable counts rows in sealed pages (what results.read can serve); main adds the
/// backend generation before the renderer sees it.</summary>
internal sealed record ResultDescriptor(uint ResultId, int Index, int BatchNumber, int Iteration, string Kind, IReadOnlyList<ResultColumn> Columns,
    long RowsRead, long RowsStored, long RowsAvailable, long BytesStored, long TruncatedCells, string State, string? Truncated, bool Incomplete);
internal sealed record ColumnInfo(string Name, string DataType);
internal sealed record TableColumnsResult(List<ColumnInfo> Columns, bool Truncated);
internal sealed record QueryFailure(string Code, string Message, int BatchNumber, int Iteration);
/// <summary>Seq orders it with the results.memory events: the status bar applies only a figure newer than the last it showed.</summary>
internal sealed record ResultBudget(long UsedBytes, long GlobalBytes, long QueryBytes, long Seq);
/// <summary>One line of the Messages tab: kind is "info" or "error" (SQL errors, cancellation and timeout, shown in red).</summary>
internal sealed record MessageEntry(string Text, string Kind);
/// <summary>The query.execute summary: rows stay in the backend's result store and are read with results.read. CompletedAt
/// is the backend's local time with 7 fractional digits, as SSMS prints "Completion time:". Status is completed, completedWithErrors
/// (every batch ran and at least one raised an error; Error holds the errors and the first such batch), failed (an error
/// stopped execution: before the first batch, with stopOnError, or by closing the session), cancelled, or timedOut.
/// Spid (SqlConnection.ServerProcessId) and Login (SUSER_SNAME(), read with the SET prologue) are the session's, read once when
/// it opened; both are present while it is still open after the script.</summary>
internal sealed record QueryResult(List<ResultDescriptor> ResultSets, int DiscardedResultSets, List<MessageEntry> Messages, long RecordsAffected, long ElapsedMs,
    string Status, QueryFailure? Error, int CompletedBatches, int TotalBatches, string Database, bool MessagesTruncated, ResultBudget Budget, string CompletedAt,
    int? Spid = null, string? Login = null);
internal sealed record SessionStateArgs(string SessionId);
/// <summary>query.session.state: an idle session's @@TRANCOUNT, read on demand before it ends. Checked is false when the
/// session's SET options (SHOWPLAN_*, NOEXEC, PARSEONLY, FMTONLY) kept the SELECT from returning it; TransactionCount is
/// then 0 and the session may hold a transaction.</summary>
internal sealed record SessionState(int TransactionCount, bool Checked);
internal sealed record ResultsReadArgs(uint ResultId, long FirstRow, int MaxRows);
internal sealed record ResultsReadResult(long NextRow, long RowsAvailable, bool Complete, int Pages, int Rows);
internal sealed record ResultsCloseArgs(uint[] ResultIds);
internal sealed record ResultsCloseResult(int Closed, long UsedBytes);
/// <summary>A piece of a copy: inclusive row ranges (a last row of 2^53 - 1 runs to the end) by inclusive column ranges.</summary>
internal sealed record CopyPartArgs(long[][] Rows, int[][] Columns);
/// <summary>results.copy (main only): the parts' text streams as DATA; eol is "crlf" or "lf".</summary>
internal sealed record ResultsCopyArgs(uint ResultId, CopyPartArgs[] Parts, bool Headers, string Eol, long MaxBytes);
/// <summary>results.export (main only): Path comes from main's save dialog; Format is csv, tsv or json; NullText is
/// "empty" or "NULL"; TemporaryId (32 hex digits) names the temporary file, .varia-{id}.tmp beside the target, which main
/// removes if the backend dies while writing it.</summary>
internal sealed record ResultsExportArgs(uint ResultId, string Path, string Format, bool Headers, string NullText, string TemporaryId);
internal sealed record ResultsJobResult(long Rows, long Bytes, long TruncatedCells, bool Partial);
/// <summary>debug.results.synthesize (VARIA_BACKEND_TEST_HOOKS=1 only).</summary>
internal sealed record SynthesizeArgs(string Shape, int Rows);

/// <summary>live.subscribe (results port only; docs/ipc.md, Live subscriptions). Args are read per source
/// (Live/LiveService.cs), so each source's members are checked and unknown ones refused.</summary>
internal sealed record LiveSubscribeArgs(string SubscriptionId, string ConnectionId, string Source, LiveProbeArgs[] Probes, JsonElement? Args = null, string? Resume = null);
/// <summary>One probe's settings: IntervalMs is required on subscribe and optional in an update. Clear (updates only) names
/// settings to drop (sort, view, filter): an absent member keeps its setting, so null cannot mean "none".</summary>
internal sealed record LiveProbeArgs(string Probe, int? IntervalMs = null, bool? Paused = null, LiveSortArgs[]? Sort = null, string? View = null, LiveFilterArgs? Filter = null,
    string[]? Clear = null);
internal sealed record LiveSortArgs(string Column, bool Descending);
internal sealed record LiveFilterArgs(string Text, string[]? Columns = null);
/// <summary>live.update: Source repeats the subscription's.</summary>
internal sealed record LiveUpdateArgs(string SubscriptionId, string Source, bool? Paused = null, LiveProbeArgs[]? Probes = null, bool? Refresh = null, LiveTrackArgs[]? Track = null,
    JsonElement? Args = null);
/// <summary>The rows to follow across revisions of one keyed snapshot table: key texts joined with U+001F.</summary>
internal sealed record LiveTrackArgs(string Probe, int Table, int Seq, string[] Keys);
/// <summary>debug.synthetic's args (test hooks only).</summary>
internal sealed record SyntheticLiveArgs(int? Rows = null, int? TickMs = null, int? EndAfterTicks = null, int? ErrorEvery = null);

/// <summary>explorer.children: refs are flat records (no polymorphic converters), validated by ExplorerRefs against the catalogue.</summary>
internal sealed record ExplorerChildrenArgs(string ConnectionId, string RequestId, NodeRefDto Node, string? Subtype = null, string? Cursor = null, int? PageSize = null,
    ExplorerFilterDto? Filter = null);
/// <summary>An object node (Type "object", Object) or a folder below its nearest object (Type "folder", Owner, Folder).</summary>
internal sealed record NodeRefDto(string Type, ObjectRefDto? Object = null, ObjectRefDto? Owner = null, string? Folder = null);
internal sealed record ObjectRefDto(string Kind, string? Database = null, string? Schema = null, string? Name = null, ParentRefDto? Parent = null);
internal sealed record ParentRefDto(string Kind, string Schema, string Name);
internal sealed record ExplorerFilterDto(TextFilterDto? Name = null, TextFilterDto? Schema = null, TextFilterDto? Owner = null, DateFilterDto? Created = null);
internal sealed record TextFilterDto(string Op, string Value);
internal sealed record DateFilterDto(string Op, string Value, string? Value2 = null);
/// <summary>One tree node. Created is server local time, yyyy-MM-ddTHH:mm:ss.</summary>
internal sealed record ExplorerNode(NodeRefDto Ref, string Label, string Icon, bool HasChildren, string? Sublabel = null, string? Detail = null, string? Subtype = null,
    string? Status = null, string? Created = null);
/// <summary>A catalog failure, returned as a value so its code reaches the tree row.</summary>
internal sealed record ExplorerError(string Code, string Message, bool Retryable, string? Action = null);
/// <summary>A page of children: static folders first (first page only), then rows. Total is on the first page only.</summary>
internal sealed record ExplorerChildrenResult(List<ExplorerNode> Nodes, long ElapsedMs, string? Cursor = null, int? Total = null, ExplorerError? Error = null);

/// <summary>scripting.script: one object for Script As (the wizard will send many), a verb of the catalogue, and every
/// scripting option (src/shared/scripting/schema.ts). Cancellation is a CANCEL frame for the request.</summary>
internal sealed record ScriptArgs(string ConnectionId, string RequestId, List<ObjectRefDto> Targets, string Verb, ScriptingOptionsDto Options);
/// <summary>The 36 options of src/shared/scripting/options.ts in its order; a missing member fails deserialization.</summary>
internal sealed record ScriptingOptionsDto
{
    public required bool DelimitStatements { get; init; }
    public required bool IncludeHeaders { get; init; }
    public required bool IncludeVarDecimal { get; init; }
    public required bool ScriptChangeTracking { get; init; }
    public required bool ScriptFullTextCatalogs { get; init; }
    public required bool ScriptUseDatabase { get; init; }
    public required bool CheckExistence { get; init; }
    public required bool GenerateDependentObjects { get; init; }
    public required bool SchemaQualify { get; init; }
    public required bool ScriptDataCompression { get; init; }
    public required bool ScriptExtendedProperties { get; init; }
    public required bool ScriptOwner { get; init; }
    public required bool ScriptPermissions { get; init; }
    public required bool ConvertUserDefinedDataTypes { get; init; }
    public required bool GenerateAnsiPadding { get; init; }
    public required bool IncludeCollation { get; init; }
    public required bool IncludeIdentity { get; init; }
    public required bool SchemaQualifyForeignKeys { get; init; }
    public required bool ScriptBindings { get; init; }
    public required bool ScriptCheckConstraints { get; init; }
    public required bool ScriptDefaults { get; init; }
    public required bool ScriptFileGroups { get; init; }
    public required bool ScriptForeignKeys { get; init; }
    public required bool ScriptFullTextIndexes { get; init; }
    public required bool ScriptIndexes { get; init; }
    public required bool ScriptPartitionSchemes { get; init; }
    public required bool ScriptPrimaryKeys { get; init; }
    public required bool ScriptStatistics { get; init; }
    public required bool ScriptTriggers { get; init; }
    public required bool ScriptUniqueKeys { get; init; }
    public required bool ScriptViewColumns { get; init; }
    public required bool IncludeDriSystemNames { get; init; }
    public required bool MatchSourceSettings { get; init; }
    public required string TargetEngineEdition { get; init; }
    public required string TargetEngineType { get; init; }
    public required string TargetServerVersion { get; init; }
}
/// <summary>A scripting failure, returned as a value so its code reaches the renderer.</summary>
internal sealed record ScriptError(string Code, string Message, bool Retryable);
/// <summary>The whole script (at most 4,000,000 characters) or an error. Database is where a new query window should
/// run it: the object's, or master for databases and server objects. Commands counts the SQL commands the job sent.</summary>
internal sealed record ScriptResult(string? Text, string Database, List<string> Warnings, int Commands, long ElapsedMs, ScriptError? Error = null);

/// <summary>actions.describe: what an object dialog shows (deleteObject: Delete Object's row; databaseProperties: Database Properties' pages),
/// or what the table designer needs of a database (tableDesigner).</summary>
internal sealed record ActionDescribeArgs(string ConnectionId, string RequestId, string Dialog, ObjectRefDto Target);
/// <summary>actions.script and actions.execute: rename takes NewName, delete the two database options, properties
/// CloseConnections and Changes, createTable (Target the database) Design; Validate refuses the rest.</summary>
internal sealed record ActionArgs(string Action, string ConnectionId, string RequestId, ObjectRefDto Target, string? NewName = null, bool? CloseConnections = null, bool? DeleteHistory = null,
    DatabaseChangesDto? Changes = null, TableDesignDto? Design = null);
/// <summary>Database Properties' changes: only what differs from the describe. Options and Scoped map a catalogue key to a token.</summary>
internal sealed record DatabaseChangesDto(string? Owner = null, Dictionary<string, string>? Options = null, Dictionary<string, string>? Scoped = null);
internal sealed record ActionError(string Code, string Message, bool Retryable);
internal sealed record ActionWarningDto(string Text, bool Blocking);
internal sealed record DeleteTargetDto(string Name, string Type, string? Owner, List<ActionWarningDto> Warnings, bool DependentsTruncated, bool? IsSnapshot = null, int? Sessions = null);
/// <summary>Database Properties' General page; sizes in MB, dates as ISO 8601, a backup of "None" when msdb has no history.</summary>
internal sealed record DatabaseGeneralDto(string Name, string Status, bool Standby, string? Owner, string Created, double SizeMb, double? SpaceAvailableMb = null, int? Users = null,
    string? LastBackup = null, string? LastLogBackup = null, string? Collation = null, double? MemoryAllocatedMb = null, double? MemoryUsedMb = null);
internal sealed record GrowthDto(bool Enabled, string? Unit = null, long? By = null, long? MaxMb = null);
/// <summary>Type: rows, log or filestream. Path is the folder and FileName the file of physical_name.</summary>
internal sealed record DatabaseFileDto(string Name, string Type, string? Filegroup, double SizeMb, GrowthDto Growth, string Path, string FileName, bool IsPrimary);
/// <summary>Type: rows, filestream or memoryOptimized.</summary>
internal sealed record DatabaseFilegroupDto(string Name, string Type, int Files, bool ReadOnly, bool IsDefault, bool? AutogrowAllFiles = null);
internal sealed record DatabaseServerFactsDto(int Level, bool Sysadmin, int FilestreamLevel, string PathSeparator, int Edition, bool ContainedAuthentication);
internal sealed record DatabasePropertiesDto(DatabaseGeneralDto General, Dictionary<string, string> Options, Dictionary<string, string> Scoped, List<int> CompatibilityLevels,
    List<string> Collations, List<string> Logins, List<DatabaseFileDto> Files, bool FilesTruncated, List<DatabaseFilegroupDto> Filegroups, bool FilegroupsTruncated,
    DatabaseServerFactsDto Server, int? Sessions = null, string? ReadOnlyReason = null);
internal sealed record ActionDescribeResult(DeleteTargetDto? DeleteTarget, long ElapsedMs, ActionError? Error = null, DatabasePropertiesDto? DatabaseProperties = null,
    TableDesignerModelDto? TableDesigner = null);
/// <summary>The table designer's new table (src/shared/designer/schema.ts): columns in order and the primary key as column indexes in key order.</summary>
internal sealed record TableDesignDto(string Schema, string Name, List<DesignColumnDto> Columns, List<int> PrimaryKey);
internal sealed record DesignColumnDto(string Name, DesignTypeDto Type, bool AllowNulls, DesignIdentityDto? Identity = null);
/// <summary>A system type from the designer catalogue and the parameters its kind takes.</summary>
internal sealed record DesignTypeDto(string System, int? Length = null, bool? Max = null, int? Precision = null, int? Scale = null, int? Dimensions = null);
/// <summary>Whole numbers of at most 38 digits, as text (decimal(38, 0) does not fit a C# number).</summary>
internal sealed record DesignIdentityDto(string Seed, string Increment);
internal sealed record TableDesignerModelDto(string Database, int Band, List<string> Schemas, bool SchemasTruncated, string DefaultSchema, string DefaultFilegroup,
    bool CaseSensitiveNames, bool AccentSensitiveNames, bool? CanCreate = null);
internal sealed record ActionScriptResult(string? Text, string Database, List<string> Warnings, ActionError? Error = null);
/// <summary>Status: done, failed, skipped or cancelled; Message: the step's title, or SQL Server's text for a failed one.</summary>
internal sealed record ActionStepDto(string Status, string? Message = null);
internal sealed record ActionExecuteResult(List<ActionStepDto> Steps, List<string> Messages, long ElapsedMs, ActionError? Error = null);

/// <summary>activity.details (src/shared/activity/schema.ts): one session by its id and login time (server local time,
/// yyyy-MM-ddTHH:mm:ss.fffffff); Text asks for one text whole, Locks also reads its locks. SessionActions re-checks every bound.</summary>
internal sealed record ActivityDetailsArgs(string ConnectionId, string RequestId, int SessionId, string LoginTime, string? Text = null, bool? Locks = null);
/// <summary>activity.kill: 1 to 64 distinct sessions, each with the login time and host process id its row showed.</summary>
internal sealed record ActivityKillArgs(string ConnectionId, List<ActivityKillSessionDto?> Sessions);
internal sealed record ActivityKillSessionDto(int SessionId, string LoginTime, int? HostProcessId);
/// <summary>A failure as a value (a live error code), as Object Explorer's are.</summary>
internal sealed record ActivityError(string Code, string Message, bool Retryable);
internal sealed record ActivitySectionError(string Section, string Code, string Message);
internal sealed record ActivityText(string Text, long Chars, bool Truncated);
internal sealed record ActivitySessionDto(int SessionId, string LoginTime, bool IsUserProcess, string Login, string IsolationLevel, string Status, int RequestCount, long CpuMs,
    long LogicalReads, long Reads, long Writes, long MemoryKb, int OpenTransactions, string? OriginalLogin = null, string? HostName = null, int? HostProcessId = null,
    string? Application = null, string? Interface = null, string? NetAddress = null, string? Transport = null, bool? Encrypted = null, string? AuthScheme = null,
    string? Database = null, string? Command = null, int? RequestId = null, string? WaitType = null, long? WaitTimeMs = null, string? WaitResource = null, int? BlockedBy = null,
    long? ElapsedMs = null, double? PercentComplete = null, int? Dop = null, long? GrantedMemoryKb = null, string? LastRequestStart = null, string? LastRequestEnd = null);
internal sealed record ActivityInputBufferDto(ActivityText Text, string? EventType = null, int? Parameters = null);
internal sealed record ActivitySessionWaitDto(string WaitType, long WaitingTasks, long WaitTimeMs, long MaxWaitTimeMs, long SignalWaitTimeMs);
internal sealed record ActivityTransactionDto(long TransactionId, string Type, string State, bool UserTransaction, string? Name = null, string? BeginTime = null, string? Database = null,
    long? LogBytesUsed = null, long? LogBytesReserved = null);
internal sealed record ActivityTempdbDto(long UserObjectsKb, long InternalObjectsKb);
internal sealed record ActivityLockDto(string ResourceType, string Mode, string Status, long Count, string? Database = null, int? DatabaseId = null);
/// <summary>State: present, ended, changed (nothing else read), or unknown with Error. Sections are null when not read.</summary>
internal sealed record ActivityDetailsResult(int SessionId, string State, long ElapsedMs, ActivitySessionDto? Session = null, ActivityText? Statement = null, ActivityText? Batch = null,
    ActivityInputBufferDto? InputBuffer = null, List<ActivitySessionWaitDto>? Waits = null, List<ActivityTransactionDto>? Transactions = null, bool? TransactionsTruncated = null,
    ActivityTempdbDto? Tempdb = null, List<ActivityLockDto>? Locks = null, bool? LocksTruncated = null, List<ActivitySectionError>? SectionErrors = null, string? ReadAt = null,
    ActivityError? Error = null);
internal sealed record ActivityKillOutcomeDto(int SessionId, string Outcome, string? Message = null);
/// <summary>Results: the sessions tried, in order; Error says why the rest were not.</summary>
internal sealed record ActivityKillResult(List<ActivityKillOutcomeDto> Results, long ElapsedMs, ActivityError? Error = null);

/// <summary>What the Connect dialog shows under a failed connection: SQL Server's error number, state and class (level), and
/// the server that answered. Never the connection string or the password.</summary>
internal sealed record ErrorDetails(int? Number, int? State, int? Class, string? Server);

internal sealed class RequestException(string code, string message, ErrorDetails? details = null) : Exception(message)
{
    public string Code { get; } = code;
    public ErrorDetails? Details { get; } = details;
}
