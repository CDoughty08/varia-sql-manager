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

/// <summary>What the Connect dialog shows under a failed connection: SQL Server's error number, state and class (level), and
/// the server that answered. Never the connection string or the password.</summary>
internal sealed record ErrorDetails(int? Number, int? State, int? Class, string? Server);

internal sealed class RequestException(string code, string message, ErrorDetails? details = null) : Exception(message)
{
    public string Code { get; } = code;
    public ErrorDetails? Details { get; } = details;
}
