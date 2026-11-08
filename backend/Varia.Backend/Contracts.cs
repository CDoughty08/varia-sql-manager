using System.Text.Json;
using System.Text.Json.Serialization;
using Varia.Backend.Activity;

namespace Varia.Backend;

/// <summary>Environment is the profile's label (Production, Staging, a custom one of at most 32 characters); the backend only
/// bounds it, since the workbench shows it and SQL Server never sees it.</summary>
internal sealed record ConnectOptions(string Server, string Database, string Authentication, string? Username, string? Password, bool TrustServerCertificate,
    string Encrypt = "mandatory", string? HostNameInCertificate = null, string? DisplayName = null, string? Color = null, string? Environment = null, AdvancedConnectionOptions? Advanced = null);
internal sealed record AdvancedConnectionOptions(
    int CommandTimeout = 0, int ConnectTimeout = 15, bool ColumnEncryption = false, bool SecureEnclaves = false,
    string AttestationProtocol = "None", string EnclaveAttestationUrl = "", bool MultipleActiveResultSets = false,
    string NetworkProtocol = "default", int PacketSize = 8000, string TransactionBinding = "Implicit Unbind", string TypeSystemVersion = "Latest",
    int ConnectRetryCount = 1, int ConnectRetryInterval = 10, string ApplicationName = "Varia SQL Manager", string WorkstationId = "",
    string ApplicationIntent = "ReadWrite", string CurrentLanguage = "", bool Replication = false, string IpAddressPreference = "IPv4First",
    string ServerCertificate = "", string AttachDbFilename = "", string FailoverPartner = "", string FailoverPartnerSpn = "",
    bool MultiSubnetFailover = false, string ServerSpn = "", bool UserInstance = false);
/// <summary>ProductVersion, Login, EngineEdition and Linux come from the server profile probed at connect; they are absent when the probe failed.</summary>
internal sealed record ConnectionInfo(string Id, string Server, string Database, string ServerVersion, string? DisplayName = null, string? Color = null, int CommandTimeout = 0,
    string? ProductVersion = null, string? Login = null, int? EngineEdition = null, bool? Linux = null);
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
    bool StopOnError = false, bool IncludeActualPlan = false, bool IncludeClientStatistics = false, bool IncludeLivePlan = false);
/// <summary>query.session.close: Transaction "commit" commits the session's open transaction first; "rollback" is a plain close,
/// since SQL Server rolls back what a closed session left open.</summary>
internal sealed record SessionArgs(string SessionId, string? Transaction = null);
internal sealed record CancelArgs(string QueryId);
internal sealed record DatabaseInfo(string Name, bool IsSystem, bool IsSnapshot);
/// <summary>A result column as the grid sees it: wire is "text" (SSMS display text) or "binary"; role marks documents
/// (xml, json, plan), CLR UDTs and vectors.</summary>
internal sealed record ResultColumn(string Name, string DataType, string Wire, string? Role = null, int? MaxLength = null, int? Precision = null, int? Scale = null, bool Nullable = true,
    ResultCollation? Collation = null);
/// <summary>A char, varchar, text, nchar, nvarchar or ntext column's collation as SqlClient read it from the result's
/// metadata (SqlClientCollation): its Windows locale id, SQL sort id (non-zero for SQL_ collations), the code page SqlClient
/// decodes char and varchar with (0 for UTF-8), whether it is a _UTF8 collation, and its comparison flags, SqlCompareOptions'
/// bits (IgnoreCase 1, IgnoreNonSpace 2, IgnoreKanaType 8, IgnoreWidth 16, BinarySort2 16384, BinarySort 32768).</summary>
internal sealed record ResultCollation(int Lcid, int SortId, int CodePage, bool Utf8, int Options);
/// <summary>A stored result set. rowsAvailable counts rows in sealed pages (what results.read can serve); main adds the
/// backend generation before the renderer sees it.</summary>
internal sealed record ResultDescriptor(uint ResultId, int Index, int BatchNumber, int Iteration, string Kind, IReadOnlyList<ResultColumn> Columns,
    long RowsRead, long RowsStored, long RowsAvailable, long BytesStored, long TruncatedCells, string State, string? Truncated, bool Incomplete);
internal sealed record ColumnInfo(string Name, string DataType);
internal sealed record TableColumnsResult(List<ColumnInfo> Columns, bool Truncated);
internal sealed record QueryFailure(string Code, string Message, int BatchNumber, int Iteration);
/// <summary>Seq orders it with the results.memory events: the status bar applies only a figure newer than the last it showed.</summary>
internal sealed record ResultBudget(long UsedBytes, long GlobalBytes, long QueryBytes, long Seq);
/// <summary>One line of the Messages tab: kind is "info" (Varia's row counts and notes), "print" (PRINT and RAISERROR with
/// severity 10 or less), "server" (SQL Server's other informational messages: warnings, SET STATISTICS output, DBCC) or "error"
/// (SQL errors, cancellation and timeout, shown in red).</summary>
internal sealed record MessageEntry(string Text, string Kind);
/// <summary>The query.execute summary: rows stay in the backend's result store and are read with results.read. CompletedAt
/// is the backend's local time with 7 fractional digits, as SSMS prints "Completion time:". Status is completed, completedWithErrors
/// (every batch ran and at least one raised an error; Error holds the errors and the first such batch), failed (an error
/// stopped execution: before the first batch, with stopOnError, or by closing the session), cancelled, or timedOut.
/// Spid (SqlConnection.ServerProcessId) and Login (SUSER_SNAME(), read with the SET prologue) are the session's, read once when
/// it opened; both are present while it is still open after the script.</summary>
internal sealed record QueryResult(List<ResultDescriptor> ResultSets, int DiscardedResultSets, List<MessageEntry> Messages, long RecordsAffected, long ElapsedMs,
    string Status, QueryFailure? Error, int CompletedBatches, int TotalBatches, string Database, bool MessagesTruncated, ResultBudget Budget, string CompletedAt,
    int? Spid = null, string? Login = null, List<ResultDescriptor>? PlanSets = null, List<uint>? PlanOrder = null, Statistics.ClientStatisticsSample? ClientStatistics = null);
internal sealed record SessionStateArgs(string SessionId);
/// <summary>query.session.state: an idle session's @@TRANCOUNT, read on demand before it ends. Checked is false when the
/// session's SET options (SHOWPLAN_*, NOEXEC, PARSEONLY, FMTONLY) kept the SELECT from returning it; TransactionCount is
/// then 0 and the session may hold a transaction.</summary>
internal sealed record SessionState(int TransactionCount, bool Checked);
internal sealed record ResultsReadArgs(uint ResultId, long FirstRow, int MaxRows);
internal sealed record ResultsReadResult(long NextRow, long RowsAvailable, bool Complete, int Pages, int Rows);
internal sealed record ResultsCloseArgs(uint[] ResultIds);
internal sealed record ResultsCloseResult(int Closed, long UsedBytes);
internal sealed record ResultsRowBytesArgs(uint ResultId, long FirstRow, int Count);
/// <summary>results.rowBytes: Bytes[k] is row FirstRow + k's sum of DATALENGTH over its cells (NULL counts 0; xml and json
/// as their text, some sql_variant base types estimated: docs/ipc.md, Cell lengths and row sizes); it stops at the rows sealed
/// so far. Estimated lists, in order, the rows of the range whose sum includes an estimate.</summary>
internal sealed record ResultsRowBytesResult(long FirstRow, long[] Bytes, long RowsAvailable, long[] Estimated);
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
/// <summary>A sort key; Table (a snapshot table's index) limits it to that table, else it sorts every snapshot table with the column.</summary>
internal sealed record LiveSortArgs(string Column, bool Descending, int? Table = null);
internal sealed record LiveFilterArgs(string Text, string[]? Columns = null);
/// <summary>live.update: Source repeats the subscription's.</summary>
internal sealed record LiveUpdateArgs(string SubscriptionId, string Source, bool? Paused = null, LiveProbeArgs[]? Probes = null, bool? Refresh = null, LiveTrackArgs[]? Track = null,
    JsonElement? Args = null);
/// <summary>The rows to follow across revisions of one keyed snapshot table: key texts joined with U+001F. Linger: how many
/// of the first keys stay one revision when they leave (a table that keeps departed rows); all of them when absent.</summary>
internal sealed record LiveTrackArgs(string Probe, int Table, int Seq, string[] Keys, int? Linger = null);
/// <summary>debug.synthetic's args (test hooks only). Start is a live start (Live/LiveStart.cs): "beginning", {tail} or {before}.</summary>
internal sealed record SyntheticLiveArgs(int? Rows = null, int? TickMs = null, int? EndAfterTicks = null, int? ErrorEvery = null, int? LogRows = null, int? LogLevel = null,
    int? LateEvery = null, JsonElement? Start = null);
/// <summary>The Activity Monitor's args (src/shared/activity/schema.ts, activityLiveArgsSchema): one filter per table, and the
/// session the sessions probe's two series follow (0: none). Activity/ActivityReader.cs checks them as zod does.</summary>
internal sealed record ActivityLiveArgs(List<ActivityFilterDto?>? Filters = null, int? FocusSession = null);
/// <summary>ssis.operations' args (src/shared/ssis/schema.ts SsisOperationsArgs): the Operations view's filters, each absent one
/// no filter. Live/SsisOperations.cs re-checks every member and bound.</summary>
internal sealed record SsisOperationsLiveArgs(string[]? Kinds = null, int[]? Statuses = null, string? Folder = null, string? Project = null, string? Package = null, bool? Prefix = null,
    string? Caller = null, int? WindowHours = null, int? Limit = null);

/// <summary>explorer.children: refs are flat records (no polymorphic converters), validated by ExplorerRefs against the catalogue.</summary>
/// <summary>GroupBySchema: Group by Schema is on (true only), for a database and the folders below it.</summary>
internal sealed record ExplorerChildrenArgs(string ConnectionId, string RequestId, NodeRefDto Node, string? Subtype = null, string? Cursor = null, int? PageSize = null,
    ExplorerFilterDto? Filter = null, bool? GroupBySchema = null);
/// <summary>An object node (Type "object", Object) or a folder below its nearest object (Type "folder", Owner, Folder).</summary>
internal sealed record NodeRefDto(string Type, ObjectRefDto? Object = null, ObjectRefDto? Owner = null, string? Folder = null);
/// <summary>SsisFolder and SsisProject name an SSIS Catalog object's folder and project (the ssis* scopes); null elsewhere.</summary>
internal sealed record ObjectRefDto(string Kind, string? Database = null, string? Schema = null, string? Name = null, ParentRefDto? Parent = null, string? SsisFolder = null,
    string? SsisProject = null);
internal sealed record ParentRefDto(string Kind, string Schema, string Name);
internal sealed record ExplorerFilterDto(TextFilterDto? Name = null, TextFilterDto? Schema = null, TextFilterDto? Owner = null, DateFilterDto? Created = null);
internal sealed record TextFilterDto(string Op, string Value);
internal sealed record DateFilterDto(string Op, string Value, string? Value2 = null);
/// <summary>One tree node. Created is server local time, yyyy-MM-ddTHH:mm:ss. Database: a database node's runtime state.
/// ConnectDenied: a login denied CONNECT SQL, sent only when true (Status says disabled when it is disabled too).</summary>
internal sealed record ExplorerNode(NodeRefDto Ref, string Label, string Icon, bool HasChildren, string? Sublabel = null, string? Detail = null, string? Subtype = null,
    string? Status = null, string? Created = null, ExplorerDatabase? Database = null, bool? ConnectDenied = null);
/// <summary>A database's runtime state as the listing read it (sys.databases' state, user_access, is_read_only and
/// is_in_standby), in the shape of the live status rows, so the renderer's action rules can take the newer of the two.</summary>
internal sealed record ExplorerDatabase(int State, int UserAccess, bool ReadOnly, bool Standby);
/// <summary>A catalog failure, returned as a value so its code reaches the tree row.</summary>
internal sealed record ExplorerError(string Code, string Message, bool Retryable, string? Action = null);
/// <summary>A page of children: static folders first (first page only), then rows. Total is on the first page only.</summary>
internal sealed record ExplorerChildrenResult(List<ExplorerNode> Nodes, long ElapsedMs, string? Cursor = null, int? Total = null, ExplorerError? Error = null);
/// <summary>explorer.peek (src/shared/explorer/peek.ts): an object's Properties facts and lists and, for modules, its text. Cancellation is a CANCEL frame for the request (or varia:explorer-cancel), as explorer.children's.</summary>
internal sealed record PeekArgs(string ConnectionId, string RequestId, ObjectRefDto Target);
/// <summary>Facts: fact id to a string, bool, whole number or null, for the facts the server's band has. Definition: a module's
/// text, absent when it is encrypted or hidden; DefinitionTruncated is true only when it was cut. Facts are empty with an Error.
/// Lists: the kind's lists by id. Refused: the optional groups whose statement the login was refused (their facts are absent).</summary>
internal sealed record PeekResult(Dictionary<string, object?> Facts, long ElapsedMs, string? Definition = null, bool? DefinitionTruncated = null, ExplorerError? Error = null,
    Dictionary<string, PeekList>? Lists = null, List<string>? Refused = null);
/// <summary>One of a peek's lists: its rows (values by the list's column formats); Truncated when there were more than the
/// catalogue keeps; Unread, for a login's User mapping, the databases that could not be read.</summary>
internal sealed record PeekList(List<object?[]> Rows, bool? Truncated = null, int? Unread = null);
/// <summary>explorer.peekDependencies (its args are PeekArgs): what the object references and the tables its foreign keys
/// point at (Uses), and what references it or points at it by a foreign key (UsedBy), each truncated when there were more.
/// Both lists are empty with an Error.</summary>
internal sealed record PeekDependenciesResult(List<PeekDependency> Uses, List<PeekDependency> UsedBy, long ElapsedMs, bool? UsesTruncated = null, bool? UsedByTruncated = null, ExplorerError? Error = null);
/// <summary>One object on Peek's Dependencies tab: Database and Server name another database or a linked server; Kind is its
/// Object Explorer kind when it is in this database and listed by name, with the Subtype the tree gives it; ForeignKey is true
/// when a foreign key makes the link.</summary>
internal sealed record PeekDependency(string Name, string? Schema = null, string? Database = null, string? Server = null, string? Kind = null, bool? ForeignKey = null, string? Subtype = null);
/// <summary>explorer.peekRows: a table's or view's first rows (SELECT TOP (n) *), on Peek's slot and within its budget.</summary>
internal sealed record PeekRowsArgs(string ConnectionId, string RequestId, ObjectRefDto Target);
internal sealed record PeekRowsColumn(string Name, string Type);
/// <summary>Columns: the first RowColumns of them (MoreColumns: how many were left out). Rows: each value as the grid shows it,
/// null for NULL, cut to RowCellChars; Cut lists the [row, column] values that were cut, Unread those that could not be read.</summary>
internal sealed record PeekRowsResult(List<PeekRowsColumn> Columns, List<string?[]> Rows, long ElapsedMs, int? MoreColumns = null, List<int[]>? Cut = null, ExplorerError? Error = null, List<int[]>? Unread = null);

/// <summary>explorer.index: (re)builds the connection's object index, with module definitions unless Definitions is false. It
/// sends droppable explorer.index.progress EVENTs and answers once every database was read or skipped; a newer build of the
/// same connection, Stop, or a disconnect ends it (CANCELLED), keeping what it read.</summary>
internal sealed record ObjectIndexArgs(string ConnectionId, string RequestId, bool? Definitions = null);
/// <summary>A database the index could not read: its code (NO_DB_ACCESS, TIMEOUT, TOO_LARGE, CATALOG_ERROR) and a sentence.</summary>
internal sealed record ObjectIndexSkip(string Database, string Code, string Message);
/// <summary>The index as a search finds it. State: none (never built), building, or ready. BuiltAt: UTC, when the last build ended.</summary>
internal sealed record ObjectIndexStatus(string State, int Databases, int Indexed, int Objects, int Modules, int Cut, List<ObjectIndexSkip> Skipped, bool Definitions, string? BuiltAt = null);
internal sealed record ObjectIndexResult(ObjectIndexStatus Status, long ElapsedMs);
/// <summary>explorer.search: In is names, definitions or all; Kinds and Database narrow it; Limit is at most 1000 hits; Match is
/// exact (the default) or fuzzy, which adds approximate name matches and cannot go with Regex.</summary>
internal sealed record ObjectSearchArgs(string ConnectionId, string RequestId, string Text, bool? CaseSensitive = null, bool? WholeWord = null, bool? Regex = null, string? In = null,
    List<string>? Kinds = null, string? Database = null, int? Limit = null, string? Match = null);
/// <summary>A definition's first match: its line and column (1-based), part of its line with the match's [start, length] in it,
/// whether the line goes on before or after the part, the matches counted (at most 999), and whether the definition was cut.
/// Uncounted (true or absent): the search's budget ran out before the count reached the definition's end, so Matches is only
/// a lower bound.</summary>
internal sealed record DefinitionMatch(int Line, int Column, string Preview, int[] Range, bool Before, bool After, int Matches, bool Cut, bool? Uncounted = null);
/// <summary>One object found: Range is the name match's [start, length] in Label; Modified is server local time; Subtype is its
/// node's where the index knows it; ParentFolder is the folder that lists a child's parent (Tables › Graph Tables, say); Via is
/// the table (in its database, in Folder) that shows a history table, or a history table's parent, as its history row;
/// Approximate marks a Fuzzy Match name hit, whose Range spans its first to last matched word.</summary>
internal sealed record ObjectSearchHit(ObjectRefDto Object, string Folder, string Label, int[]? Range, string? Modified, DefinitionMatch? Definition, string? Subtype = null,
    string? ParentFolder = null, ViaRefDto? Via = null, bool? Approximate = null);
internal sealed record ViaRefDto(string Schema, string Name, string Folder);
/// <summary>The best Limit hits of Total; Partial when the search stopped at its budget or candidate cap. Problem: why the
/// pattern cannot be searched for (no hits then).</summary>
internal sealed record ObjectSearchResult(List<ObjectSearchHit> Hits, int Total, bool Partial, long ElapsedMs, ObjectIndexStatus Index, string? Problem = null);

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
/// what an inline action reads first (renameDatabase), what the table designer needs of a database (tableDesigner), one database's roles and schemas for User Mapping (loginDatabaseRoles), the server's folders (serverFiles, the server as Target, with Files),
/// what Restore Database restores from (restoreDatabase, the server as Target, with Restore), or Attach Databases' server facts and,
/// with Attach, one primary data file's database (attachDatabase, the server as Target), or a login's facts (loginFacts, before Disable; unlockLogin, with its lock-out state). Login names the login whose user loginDatabaseRoles
/// reads too (Login Properties' User Mapping, D2c), and Securable the one securable loginEffective reads as the login (Login Properties'
/// Securables page, D2d); no other describe takes either.</summary>
internal sealed record ActionDescribeArgs(string ConnectionId, string RequestId, string Dialog, ObjectRefDto Target, ServerFilesArgsDto? Files = null, RestoreSourceDto? Restore = null,
    AttachDescribeArgsDto? Attach = null, string? Login = null, SecurableRefDto? Securable = null);
/// <summary>A securable of a login's Securables page (src/shared/actions/securables.ts SecurableRef, D2d): a catalogue type, and a name
/// (at most 128 UTF-16 units) exactly when it is not the server.</summary>
internal sealed record SecurableRefDto(string Type, string? Name = null);
/// <summary>One permission statement (securables.ts PermissionChoice): a permission of the securable's class from the catalogue, never
/// free text; State grant, withGrant, deny, revoke or revokeGrantOption; Cascade (true or absent) only with deny and revoke.</summary>
internal sealed record PermissionDto(SecurableRefDto Securable, string Permission, string State, bool? Cascade = null);
/// <summary>One explicit permission of a login (securables.ts ExplicitPermission): its securable, permission, state (grant, withGrant
/// or deny) and grantor.</summary>
internal sealed record ExplicitPermissionDto(SecurableRefDto Securable, string Permission, string State, string Grantor);
/// <summary>New Login's Securables lists (securables.ts SecurablesModel): the server's name, the permissions each type takes on this
/// server (keyed by type), and the objects Add Objects lists per named type (Truncated when a list was cut short).</summary>
internal sealed record SecurablesModelDto(string Server, Dictionary<string, List<string>> Permissions, Dictionary<string, List<string>> Objects, bool Truncated);
/// <summary>The Effective tab's read (securables.ts EffectivePermissions).</summary>
internal sealed record EffectivePermissionsDto(List<string> Permissions, bool Truncated);
/// <summary>Restore Database's describe (src/shared/actions/restore.ts RestoreSource): Kind history (Database, optional), devices
/// (Devices, 1–64 server paths), historyFiles (SetId, a backup_set_uuid) or mediaFiles (Devices and File, the set's position).</summary>
internal sealed record RestoreSourceDto(string Kind, string? Database = null, List<string>? Devices = null, string? SetId = null, int? File = null);
/// <summary>One backup set (restore.ts BackupSetRow): Type full, differential, log, file, fileDifferential, partial or partialDifferential;
/// LSNs as decimal text; dates as the server's local yyyy-MM-ddTHH:mm:ss; Devices the media set's disk files in family order; ForkPointLsn
/// where the recovery fork changed inside the set (FirstForkGuid ≠ ForkGuid); FamilyGuid the database's family across restores.</summary>
internal sealed record BackupSetDto(string Id, string Name, string Type, string Server, string Database, int Position, string FirstLsn, string LastLsn, string CheckpointLsn,
    string DatabaseBackupLsn, string Start, string Finish, long SizeBytes, string UserName, bool CopyOnly, bool Damaged, List<string> Devices, string? Expiration = null,
    string? RecoveryModel = null, string? FirstForkGuid = null, string? ForkGuid = null, string? Problem = null, string? ForkPointLsn = null, string? FamilyGuid = null);
/// <summary>One file of a backup set: Type data, log, filestream, fulltext or other.</summary>
internal sealed record BackupFileDto(string Logical, string Physical, string Type, long SizeBytes, int FileId, string? Filegroup = null, bool? Absent = null);
/// <summary>A database a restore can overwrite: Sessions in it and WithTransaction of them with an open transaction (critic A7), with VIEW SERVER STATE.</summary>
internal sealed record RestoreDestinationDto(string Name, int Id, string Created, string State, string RecoveryModel, int? Sessions = null, int? WithTransaction = null, string? FamilyGuid = null);
internal sealed record RestoreServerFileDto(string Database, string Path);
internal sealed record RestoreServerDto(string Separator, bool CanRestore, List<RestoreDestinationDto> Destinations, bool DestinationsTruncated, List<RestoreServerFileDto> Files, bool FilesTruncated,
    string? DataPath = null, string? LogPath = null, string? BackupPath = null);
internal sealed record RestoreModelDto(RestoreServerDto? Server = null, List<string>? HistoryDatabases = null, bool? HistoryTruncated = null, List<BackupSetDto>? Sets = null,
    bool? SetsTruncated = null, List<BackupFileDto>? Files = null, bool? FilesTruncated = null);
/// <summary>A restore (restore.ts RestoreOptions): the sets in order, the moves, and the options SSMS's pages set. Recovery is
/// recovery, norecovery or standby (with StandbyFile); StopAt the server's local yyyy-MM-ddTHH:mm:ss on the last log.</summary>
internal sealed record RestoreOptionsDto(List<RestorePlanSetDto> Sets, List<RestoreMoveDto> Relocate, bool Replace, bool KeepReplication, bool RestrictedUser, string Recovery,
    bool CloseConnections, string? StopAt = null, string? StandbyFile = null, RestoreTailLogDto? TailLog = null);
internal sealed record RestorePlanSetDto(string Id, List<string> Devices, int File, string Type, string? Name = null);
internal sealed record RestoreMoveDto(string Logical, string Physical);
internal sealed record RestoreTailLogDto(string File, bool NoRecovery);
/// <summary>Attach Databases' Add: the primary data file to read (a server path of at most 260 UTF-16 units).</summary>
internal sealed record AttachDescribeArgsDto(string Mdf);
/// <summary>One database to attach (src/shared/actions/schema.ts AttachDatabaseSpec): Attach As, the owner's login (null: the
/// attaching login), its files in order (the primary data file first), and whether SQL Server rebuilds the log.</summary>
internal sealed record AttachDatabaseDto(string Name, List<string> Files, bool RebuildLog, string? Owner = null);
/// <summary>The server facts Attach Databases opens with (the Owner list, the path separator, the default data folder) and, for
/// an Add, the primary file's database: its name, version and files as DBCC CHECKPRIMARYFILE records them.</summary>
internal sealed record AttachServerDto(List<string> Logins, bool LoginsTruncated, string Separator, string? DataPath = null);
/// <summary>Type data or log; Current is where the file is now (the .mdf as added); Found null when SQL Server 2016 will not tell.</summary>
internal sealed record AttachFileDto(string Original, string Type, string Current, bool? Found = null);
internal sealed record AttachDatabaseInfoDto(string Mdf, string DatabaseName, List<AttachFileDto> Files, int? Version = null);
internal sealed record AttachDescribeDto(AttachServerDto Server, AttachDatabaseInfoDto? Database = null);
/// <summary>A file restore (restore.ts RestoreFilesOptions, D1g): the sets (a full or file backup, then logs), the files (FILE) and filegroups
/// (FILEGROUP) to restore, the moves, SSMS's options, and LogBackup: a COPY_ONLY log backup to a new file after the sets, restored WITH RECOVERY.</summary>
internal sealed record RestoreFilesOptionsDto(List<RestorePlanSetDto> Sets, List<string> Files, List<string> Filegroups, List<RestoreMoveDto> Relocate, bool Replace, bool RestrictedUser,
    string Recovery, string? StandbyFile = null, RestoreLogBackupDto? LogBackup = null);
internal sealed record RestoreLogBackupDto(string File);
/// <summary>The server file picker's request (src/shared/actions/files.ts): Purpose backup, database, log or folder; Path the folder
/// to list (at most 260 UTF-16 units; absent for the drives and default folders); AllFiles lists every file, not the purpose's;
/// Exists asks whether Path itself (a file or a folder) exists rather than listing it.</summary>
internal sealed record ServerFilesArgsDto(string Purpose, string? Path = null, bool? AllFiles = null, bool? Exists = null);
/// <summary>A drive or default folder: Kind drive or folder, Defaults data, log and backup.</summary>
internal sealed record ServerRootDto(string Path, string Kind, List<string>? Defaults = null, long? FreeMb = null);
/// <summary>Modified is the server's local time as yyyy-MM-ddTHH:mm:ss.</summary>
internal sealed record ServerFileEntryDto(string Name, bool Directory, long? SizeBytes = null, string? Modified = null);
/// <summary>One listing: Separator \ or /, Path the folder listed (ending with it), Roots only without a path, Notice legacyEmpty.
/// For Exists, Path is the path checked and Entries its own entry when it exists (none when it does not, or with legacyEmpty when
/// SQL Server 2016 will not tell a login outside sysadmin).</summary>
internal sealed record ServerFilesDto(string Separator, string? Path, List<ServerRootDto> Roots, List<ServerFileEntryDto> Entries, bool Truncated, string? Notice = null);
/// <summary>actions.script and actions.execute: rename takes NewName (a database's also CloseConnections and Identity), delete the two database options, properties
/// CloseConnections and Changes, createTable (Target the database) and createDatabase (Target the new database) Design, restore
/// (Target the destination database) Restore and Identity, restoreFiles (Target the database) RestoreFiles and Identity, attach (Target
/// the server) Databases, createLogin (Target the server) Login, ServerRoles, Mappings, Status and, on execute only, Secrets, takeOffline
/// DropConnections, detach DropConnections, UpdateStatistics and DetachOffline; a login's disable and enable take only LoginIdentity, and a
/// login's delete LoginIdentity and DropMappedUsers (D4c: also drop the database users mapped to it), and its unlock Mode (keepPassword; the
/// request's `mode`) and LoginIdentity; loginProperties (D2c) LoginIdentity, LoginChanges and, on execute only, Secrets. createLogin's
/// Permissions are its Securables page's (D2d). Validate refuses the rest.</summary>
internal sealed record ActionArgs(string Action, string ConnectionId, string RequestId, ObjectRefDto Target, string? NewName = null, bool? CloseConnections = null, bool? DeleteHistory = null,
    DatabaseChangesDto? Changes = null, ActionDesign? Design = null, DatabaseIdentityDto? Identity = null, LoginSecretsDto? Secrets = null, RestoreOptionsDto? Restore = null,
    List<AttachDatabaseDto>? Databases = null, NewLoginDto? Login = null, List<string>? ServerRoles = null, LoginStatusDto? Status = null,
    bool? DropConnections = null, RestoreFilesOptionsDto? RestoreFiles = null, List<UserMappingDto>? Mappings = null, bool? UpdateStatistics = null, bool? DetachOffline = null, LoginIdentityDto? LoginIdentity = null,
    bool? DropMappedUsers = null, string? Mode = null, LoginChangesDto? LoginChanges = null, List<PermissionDto>? Permissions = null);
/// <summary>Which login the loginFacts describe read (its SID as hexadecimal, at most loginLimits.sidHex characters, and
/// create_date as the describe writes it): Disable, Enable, Delete and Unlock refuse a principal that has taken the name since.</summary>
internal sealed record LoginIdentityDto(string Sid, string Created);
/// <summary>New Login's General page (src/shared/actions/logins.ts NewLoginGeneral): Auth windows, sql, entra, certificate or
/// asymmetricKey; the password policy options for sql on SQL Server (none on Managed Instance), in SQL Server's chain (MustChange
/// needs CheckExpiration, which needs CheckPolicy); the defaults for every kind but certificate and asymmetricKey, which name their
/// Certificate or AsymmetricKey instead; Credentials to map (D2e).</summary>
internal sealed record NewLoginDto(string Auth, string Name, string? DefaultDatabase, string? DefaultLanguage = null, bool? CheckPolicy = null, bool? CheckExpiration = null, bool? MustChange = null,
    string? Certificate = null, string? AsymmetricKey = null, List<string>? Credentials = null);
/// <summary>One database New Login's User Mapping maps (src/shared/actions/logins.ts UserMappingChoice): the user to create for the login,
/// its default schema (none when null), and the database roles to add it to, public never.</summary>
internal sealed record UserMappingDto(string Database, string User, string? DefaultSchema, List<string> RolesAdd);
/// <summary>New Login's Status page: Connect grant or deny; Enabled.</summary>
internal sealed record LoginStatusDto(string Connect, bool Enabled);
/// <summary>An action's design, whose shape is the action's: the table designer's (TableDesignDto) or New Database's
/// (NewDatabaseDesignDto). STJ reads an object's members in no fixed order, so the member stays JSON until the action's validator
/// reads it with the request's own strict options (unknown members refused, as everywhere).</summary>
[JsonConverter(typeof(ActionDesignConverter))]
internal sealed class ActionDesign
{
    /// <summary>The protocol's options (Program.cs), for designs the checks build in C#.</summary>
    internal static readonly JsonSerializerOptions Strict = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    private readonly JsonElement element;
    private readonly JsonSerializerOptions options;

    public ActionDesign(JsonElement element, JsonSerializerOptions? options = null)
    {
        this.element = element.Clone();
        this.options = options ?? Strict;
    }

    /// <summary>The design as <typeparamref name="T"/>; INVALID_PARAMS when it is not one (a member another design has, a wrong type).</summary>
    public T? As<T>() where T : class
    {
        try { return element.ValueKind == JsonValueKind.Null ? null : element.Deserialize<T>(options); }
        catch (JsonException) { throw new RequestException("INVALID_PARAMS", "Invalid object action request: design."); }
    }

    internal void WriteTo(Utf8JsonWriter writer) => element.WriteTo(writer);
    public static implicit operator ActionDesign?(TableDesignDto? design) => design is null ? null : new(JsonSerializer.SerializeToElement(design, Strict));
    public static implicit operator ActionDesign?(NewDatabaseDesignDto? design) => design is null ? null : new(JsonSerializer.SerializeToElement(design, Strict));
}

internal sealed class ActionDesignConverter : JsonConverter<ActionDesign>
{
    public override ActionDesign Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        return new ActionDesign(document.RootElement, options);
    }

    public override void Write(Utf8JsonWriter writer, ActionDesign value, JsonSerializerOptions options) => value.WriteTo(writer);
}
/// <summary>Passwords an action needs (New Login and Login Properties, later): only actions.execute carries them, which is
/// sensitive as a whole (its frame is zeroed once read); Validate refuses them on actions.script and on every other action.
/// Never logged, echoed or persisted; ActionService.Validate bounds them. The record never prints them, so neither does an ActionArgs.</summary>
internal sealed record LoginSecretsDto(string? Password = null, string? OldPassword = null)
{
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append("Password = ").Append(Password is null ? "null" : "<redacted>").Append(", OldPassword = ").Append(OldPassword is null ? "null" : "<redacted>");
        return true;
    }
}
/// <summary>Login Properties' changes (src/shared/actions/logins.ts LoginChanges, D2c): only what differs from its describe. The
/// options are General's (CheckPolicy and CheckExpiration for a SQL Server login only); Password says a new password is set (the
/// value travels in Secrets) with the old one, or with UNLOCK and MUST_CHANGE; RolesAdd and RolesDrop are server roles; Mappings
/// are User Mapping's changed databases; Connect is grant or deny.</summary>
internal sealed record LoginChangesDto(string? DefaultDatabase = null, string? DefaultLanguage = null, bool? CheckPolicy = null, bool? CheckExpiration = null,
    LoginPasswordChangeDto? Password = null, List<string>? RolesAdd = null, List<string>? RolesDrop = null, List<LoginMappingChangeDto>? Mappings = null, string? Connect = null,
    bool? Enabled = null, List<PermissionDto>? Permissions = null, List<string>? CredentialsAdd = null, List<string>? CredentialsDrop = null);
/// <summary>A new password: OldPassword when the user gave the old one (then neither Unlock nor MustChange: T-SQL's grammar takes
/// one or the others), Unlock to clear a lock-out, MustChange to require a change at the next sign-in.</summary>
internal sealed record LoginPasswordChangeDto(bool OldPassword, bool Unlock, bool MustChange);
/// <summary>One database's User Mapping change: map (CREATE USER for the login, User the new user), unmap (DROP USER User, the user
/// the describe read) or update (User the user the describe read, NewName to rename it); DefaultSchema, RolesAdd and RolesDrop for
/// map and update.</summary>
internal sealed record LoginMappingChangeDto(string Database, string Change, string User, string? NewName = null, string? DefaultSchema = null, List<string>? RolesAdd = null,
    List<string>? RolesDrop = null);
/// <summary>Which database Database Properties read (database_id and create_date as the describe writes it): its preflight
/// refuses a database that has taken the name since, after a rename, a drop or a restore.</summary>
internal sealed record DatabaseIdentityDto(int Id, string Created);
/// <summary>Database Properties' changes: only what differs from the describe. Options and Scoped map a catalogue key to a token.</summary>
internal sealed record DatabaseChangesDto(string? Owner = null, Dictionary<string, string>? Options = null, Dictionary<string, string>? Scoped = null);
internal sealed record ActionError(string Code, string Message, bool Retryable);
/// <summary>What the login preflight (ActionSql.Login) reads in the action's own connection (src/shared/actions/logins.ts LoginFacts).
/// Service (at most loginLimits.serviceName characters) is the guarded service lookup of the loginFacts, Delete Object and Login
/// Properties describes only. The owned
/// counts are null where the preflight leaves them out (ActionSql.LoginAlter, before an ALTER LOGIN). OwnedJobs (Delete Object's
/// describe only) is null when msdb could not be read. GrantedPermissions (with the owned counts) counts the server permissions it granted
/// to other principals, which DROP LOGIN fails on (15173).</summary>
internal sealed record LoginFactsDto(int PrincipalId, string Type, string Subtype, bool Disabled, string Sid, string Created, bool? PolicyChecked, bool? ExpirationChecked, bool ConnectDenied,
    bool Own, bool Sysadmin, int? Sessions, int? OwnedDatabases, List<string> OwnedDatabaseNames, int? OwnedServerObjects, bool CanAlter, bool CanControlServer, bool NameInUse, string? Service = null,
    int? OwnedJobs = null, int? GrantedPermissions = null);
/// <summary>A database user mapped to a login (D4 §5.4): its database and name, the schemas, roles and other securables it owns, the
/// permissions it granted to others, whether its database is read-only, and whether this connection may drop users there (ALTER ANY
/// USER). A Delete that drops the mapped users keeps those whose DROP USER would fail (ActionService.Kept).</summary>
internal sealed record MappedUserDto(string Database, string User, int OwnedSchemas, int OwnedRoles, bool ReadOnly, int OwnedSecurables, int GrantedPermissions, bool CanDrop);
/// <summary>The mapped-user scan's answer: at most loginLimits.mappedUsers users, how many it found in all (Mapped), and how many databases it
/// read (Checked) and did not (NotChecked: offline, restoring, not accessible, failed, or past the scan's bound or budget).</summary>
internal sealed record LoginMappingsDto(List<MappedUserDto> Users, int Mapped, int Checked, int NotChecked);
/// <summary>A login's lock-out state (src/shared/actions/logins.ts LoginLockFacts), from ActionSql.LoginLock: LockoutTime (the
/// server's clock) only while locked, DaysUntilExpiration only while the password expires.</summary>
internal sealed record LoginLockFactsDto(bool Locked, int? BadPasswords, string? LockoutTime, bool MustChange, bool Expired, int? DaysUntilExpiration);
internal sealed record ActionWarningDto(string Text, bool Blocking);
/// <summary>A session in a database that its DROP waits for and Close existing connections ends (D3 §8): never the backend's own
/// pooled sessions. Program and host are clipped to the catalogue's blockerChars.</summary>
internal sealed record BlockerDto(int SessionId, string? Program, string? Host, bool OpenTransaction);
/// <summary>Delete Object's target. For a database: Sessions and WithTransaction (sessions in it or with a transaction in it, and those
/// with an open transaction) are absent without VIEW SERVER STATE, as are Blockers (at most the catalogue's blockers; BlockersTruncated
/// when more exist) and TransactionTabs (the query tabs, by session id, whose session has an open transaction there, at most
/// ActionService.TransactionTabLimit); CloseConnectionsNote is why Close existing connections is unavailable (Managed Instance, an
/// offline database). For a login (D4c): Login, its facts with what it owns, and Mappings, the database users mapped to it.</summary>
internal sealed record DeleteTargetDto(string Name, string Type, string? Owner, List<ActionWarningDto> Warnings, bool DependentsTruncated, bool? IsSnapshot = null, int? Sessions = null,
    int? WithTransaction = null, List<BlockerDto>? Blockers = null, bool? BlockersTruncated = null, string? CloseConnectionsNote = null, List<string>? TransactionTabs = null,
    LoginFactsDto? Login = null, LoginMappingsDto? Mappings = null);
/// <summary>Database Properties' General page; sizes in MB, dates as ISO 8601, a backup of "None" when msdb has no history.</summary>
internal sealed record DatabaseGeneralDto(string Name, string Status, bool Standby, string? Owner, string Created, double SizeMb, double? SpaceAvailableMb = null, int? Users = null,
    string? LastBackup = null, string? LastLogBackup = null, string? Collation = null, double? MemoryAllocatedMb = null, double? MemoryUsedMb = null, int? Id = null);
internal sealed record GrowthDto(bool Enabled, string? Unit = null, long? By = null, long? MaxMb = null);
/// <summary>Type: rows, log or filestream. Path is the folder and FileName the file of physical_name.</summary>
internal sealed record DatabaseFileDto(string Name, string Type, string? Filegroup, double SizeMb, GrowthDto Growth, string Path, string FileName, bool IsPrimary);
/// <summary>Type: rows, filestream or memoryOptimized.</summary>
internal sealed record DatabaseFilegroupDto(string Name, string Type, int Files, bool ReadOnly, bool IsDefault, bool? AutogrowAllFiles = null);
internal sealed record DatabaseServerFactsDto(int Level, bool Sysadmin, int FilestreamLevel, string PathSeparator, int Edition, bool ContainedAuthentication);
internal sealed record DatabasePropertiesDto(DatabaseGeneralDto General, Dictionary<string, string> Options, Dictionary<string, string> Scoped, List<int> CompatibilityLevels,
    List<string> Collations, List<string> Logins, List<DatabaseFileDto> Files, bool FilesTruncated, List<DatabaseFilegroupDto> Filegroups, bool FilegroupsTruncated,
    DatabaseServerFactsDto Server, int? Sessions = null, string? ReadOnlyReason = null);
/// <summary>A session in a database as Take Database Offline lists it (VIEW SERVER STATE): names clipped to the catalogue's sessionText.</summary>
internal sealed record DatabaseSessionDto(int SessionId, string? Login, string? Program, string? Host, int OpenTransactions);
/// <summary>Take Database Offline's and Bring Database Online's row (src/shared/actions/schema.ts DatabaseStateModel): the database read,
/// its sys.databases state, user_access, is_read_only and is_in_standby, and the sessions in it without the backend's own pooled
/// ones (null counts: no VIEW SERVER STATE), at most the catalogue's sessions listed.
/// Detach adds the files that stay on the server (at most the catalogue's detachFiles) and ConfirmOffline: the database is offline on
/// a Windows server, so OK waits for Detach while offline.</summary>
internal sealed record DatabaseStateDto(string Name, DatabaseIdentityDto Identity, int State, int UserAccess, bool ReadOnly, bool Standby, int? Sessions, int? WithTransaction,
    List<DatabaseSessionDto> SessionList, bool SessionsTruncated, List<ActionWarningDto> Warnings, List<DatabaseFileRefDto>? Files = null, bool? FilesTruncated = null,
    bool? ConfirmOffline = null);
/// <summary>What a database's rename reads first (src/shared/actions/schema.ts RenameDatabaseFacts): the database read, its user_access,
/// the sessions in it without the backend's own pooled ones (null counts: no VIEW SERVER STATE), the logins whose default database it
/// is, whether Varia may close the sessions (not on Managed Instance, nor in a SINGLE_USER database), and the backend's connections to the
/// same server (by SERVERPROPERTY('ServerName')), at most the catalogue's serverConnections, this one first.</summary>
internal sealed record RenameDatabaseDto(string Name, DatabaseIdentityDto Identity, int UserAccess, int? Sessions, int? WithTransaction, int LoginsDefaulting, bool CanClose,
    List<string> Connections);
/// <summary>A database file by id (src/shared/actions/schema.ts DatabaseFileRef): Type rows, log or filestream; Path as the server
/// names it (at most the catalogue's filePath characters), never logged.</summary>
internal sealed record DatabaseFileRefDto(int FileId, string Name, string Type, string Path);
internal sealed record ActionDescribeResult(DeleteTargetDto? DeleteTarget, long ElapsedMs, ActionError? Error = null, DatabasePropertiesDto? DatabaseProperties = null,
    TableDesignerModelDto? TableDesigner = null, ServerFilesDto? ServerFiles = null, RestoreModelDto? Restore = null, NewDatabaseModelDto? NewDatabase = null,
    AttachDescribeDto? AttachDatabase = null, NewLoginModelDto? NewLogin = null, DatabaseStateDto? DatabaseState = null, LoginDatabaseRolesDto? LoginDatabaseRoles = null,
    RenameDatabaseDto? RenameDatabase = null, LoginFactsDto? Login = null, LoginLockFactsDto? Lock = null,
    LoginPropertiesDto? LoginProperties = null, EffectivePermissionsDto? EffectivePermissions = null, WindowsPrincipalDto? WindowsPrincipal = null);
/// <summary>Check Names (the windowsPrincipal describe, D2e; logins.ts WindowsPrincipal): the account as typed (xp_logininfo echoes it), whether a
/// login gives it access (no row: the server found the account but none does), its type (user or group) and the path of its access.</summary>
internal sealed record WindowsPrincipalDto(string AccountName, bool Access, string? Type = null, string? Via = null);
/// <summary>What Login Properties reads of the login besides its facts and New Login's lists (src/shared/actions/logins.ts
/// LoginPropertiesFacts): its default database and language, the server roles it is a member of (at most loginLimits.serverRoles),
/// the database users mapped to it in the databases the scan read (Read, by name; a database it did not read shows "Not read"), its
/// explicit server-level permissions (D2d; none read for SQL Server's own logins), at most loginLimits.explicitPermissions, its mapped
/// credentials and, for a certificate or asymmetric key login, the certificate or key it is mapped to (D2e).</summary>
internal sealed record LoginPropertiesDto(string DefaultDatabase, string? DefaultLanguage, List<string> ServerRoles, bool ServerRolesTruncated, List<LoginMappedUserDto> Users, List<string> Read,
    List<ExplicitPermissionDto> Permissions, bool PermissionsTruncated, List<string> Credentials, bool CredentialsTruncated, string? Certificate = null, string? AsymmetricKey = null);
/// <summary>A user mapped to the login in one database: its name and default schema, and whether it is dbo (the login owns the database).</summary>
internal sealed record LoginMappedUserDto(string Database, string User, string? DefaultSchema, bool Owner);
/// <summary>The user mapped to a login in one database, as User Mapping's read with a login finds it.</summary>
internal sealed record LoginDatabaseUserDto(string Name, string? DefaultSchema, bool Owner);
/// <summary>User Mapping's read of one database (src/shared/actions/logins.ts LoginDatabaseRoles): its roles and schemas by name, each
/// bounded by loginLimits, and whether guest has CONNECT there. With a login (Login Properties): User, the user mapped to it there
/// (none when absent), and MemberOf, the roles that user is a member of (empty without a user).</summary>
internal sealed record LoginDatabaseRolesDto(List<string> Roles, bool RolesTruncated, bool Guest, List<string> Schemas, bool SchemasTruncated, LoginDatabaseUserDto? User = null,
    List<string>? MemberOf = null);
/// <summary>New Database's file (src/shared/actions/new-database.ts): Type rows, log or filestream; Filegroup none for a log; SizeMb none
/// for a container; Path the folder and FileName the file (a container's folder) in it.</summary>
internal sealed record NewDatabaseFileDto(string Name, string Type, GrowthDto Growth, string Path, string FileName, string? Filegroup = null, long? SizeMb = null);
/// <summary>Type rows, filestream or memoryOptimized; PRIMARY first.</summary>
internal sealed record NewDatabaseFilegroupDto(string Name, string Type, bool? ReadOnly = null, bool? IsDefault = null, bool? AutogrowAllFiles = null);
/// <summary>New Database's design: Containment NONE or PARTIAL; Options and Scoped only what differs from model, as tokens.</summary>
internal sealed record NewDatabaseDesignDto(List<NewDatabaseFileDto> Files, List<NewDatabaseFilegroupDto> Filegroups, string Containment, Dictionary<string, string> Options,
    Dictionary<string, string> Scoped, string? Owner = null, string? Collation = null, bool? Ledger = null);
/// <summary>What New Database reads: model as Database Properties reads it, the default folders, the server's collation, whether the
/// login may create a database (CREATE ANY DATABASE), master's compatibility level and whether the server runs on Linux.</summary>
internal sealed record NewDatabaseModelDto(DatabasePropertiesDto Model, string DataPath, string LogPath, string ServerCollation, bool CanCreate, int MasterLevel, bool Linux);
/// <summary>New Login's describe (src/shared/actions/logins.ts NewLoginModel): the server's facts, then the databases, languages and
/// server roles its lists offer, each bounded by loginLimits (a truncation flag says more exist).</summary>
internal sealed record NewLoginModelDto(NewLoginServerDto Server, List<NewLoginDatabaseDto> Databases, bool DatabasesTruncated, List<NewLoginLanguageDto> Languages,
    List<NewLoginServerRoleDto> ServerRoles, bool ServerRolesTruncated, SecurablesModelDto Securables, List<string> Certificates, bool CertificatesTruncated, List<string> AsymmetricKeys,
    bool AsymmetricKeysTruncated, List<NewLoginCredentialDto> Credentials, bool CredentialsTruncated);
/// <summary>Engine: box or managedInstance (the actions' ServerEngine), which decides the kinds and options New Login offers (D2e).</summary>
internal sealed record NewLoginServerDto(int Level, bool Linux, bool WindowsOnly, bool CanCreate, string Engine);
/// <summary>A credential New Login's Map to Credential lists: its name and, for an EKM credential, its cryptographic provider's.</summary>
internal sealed record NewLoginCredentialDto(string Name, string? Provider = null);
/// <summary>A database User Mapping lists: its sys.databases state, whether this login can open it, and whether it is read-only (set
/// READ_ONLY, a standby or a snapshot), where no user can be created.</summary>
internal sealed record NewLoginDatabaseDto(string Name, int State, bool Accessible, bool ReadOnly);
internal sealed record NewLoginLanguageDto(string Name, string Alias);
internal sealed record NewLoginServerRoleDto(string Name, bool Fixed);
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
/// <summary>One step of an action's reply (src/shared/actions/schema.ts ActionStep). Status: done, failed, skipped or cancelled;
/// Title: what the step does (at most 64 characters, constant text); Message: SQL Server's text for a failed one; Detail: a name
/// the step acts on (at most 128 characters, never a secret); Compensates: it undid an earlier step's change, or cleaned up,
/// after a failure or Stop; Progress: percent done (0-100) of a long step. ActionSteps.Bound clips them all.</summary>
internal sealed record ActionStepDto(string Status, string Title, string? Message = null, string? Detail = null, bool? Compensates = null, int? Progress = null);
/// <summary>A restore's destination after the run (schema.ts RestoredDatabase), read last (critic A12): sys.databases' state and user_access;
/// or Absent when no database has the name, with the files a dropped partly restored database left on disk (FilesUnknown: whether
/// they are could not be asked). The reply leaves it out when it could not be read. After a file restore, FilesRestoring names the database's files
/// still RESTORING (sys.master_files.state 1), by logical name.</summary>
internal sealed record RestoredDatabaseDto(int? State, int? UserAccess, bool? Absent = null, List<string>? FilesLeft = null, bool? FilesUnknown = null, List<string>? FilesRestoring = null);
/// <summary>FilesKept: Detach's files left on the server once the database was detached (at most the catalogue's detachFiles); Identity: a
/// renamed database's under its new name (src/shared/actions/schema.ts ActionExecuteResult); Sessions: a login action's count of the sessions
/// connected as the login (VIEW SERVER STATE), which Disable leaves connected.</summary>
internal sealed record ActionExecuteResult(List<ActionStepDto> Steps, List<string> Messages, long ElapsedMs, ActionError? Error = null, RestoredDatabaseDto? Restored = null,
    List<DatabaseFileRefDto>? FilesKept = null, DatabaseIdentityDto? Identity = null, int? Sessions = null);

/// <summary>ssis.describe (src/shared/ssis/schema.ts): a view of the SSIS catalogue and the tree object it describes.</summary>
internal sealed record SsisDescribeArgs(string ConnectionId, string RequestId, string View, ObjectRefDto Target);
internal sealed record SsisError(string Code, string Message, bool Retryable);
/// <summary>Model is one of the Ssis*Model records below, whose View names it; Revision is a SHA-256 of what a later write
/// depends on (SsisService.Revision), absent when the model is truncated.</summary>
internal sealed record SsisDescribeResult(object? Model, string? Revision, long ElapsedMs, SsisError? Error = null);
/// <summary>Admin is sysadmin or ssis_admin; SsisAdmin and SsisLogreader are read only for logins that are not sysadmin.</summary>
internal sealed record SsisRolesDto(bool Sysadmin, bool Admin, bool SsisAdmin, bool SsisLogreader);
/// <summary>Auth: sql, integrated or entra. Features: src/shared/ssis/catalog.ts ssisFeatures, each found or not.</summary>
internal sealed record SsisProfileDto(int Band, bool Cloud, string HostPlatform, string Auth, bool Rcsi, Dictionary<string, bool> Features, SsisRolesDto Roles);
internal sealed record SsisPropertyDto(string Name, string Value);
/// <summary>Times are datetimeoffset in ISO 8601 with their offset (never converted to datetime).</summary>
internal sealed record SsisCatalogModel(string View, string Name, SsisProfileDto Profile, long Folders, List<SsisPropertyDto>? Properties, bool Truncated);
internal sealed record SsisFolderModel(string View, long Id, string Name, string? Description, string CreatedBy, string Created, long Projects, long Environments);
/// <summary>A sensitive parameter never carries a value.</summary>
internal sealed record SsisParameterDto(string Name, string DataType, bool Required, bool Sensitive, string? Description, string? DesignDefault, string? Value, string ValueType, bool ValueSet,
    string? Variable);
internal sealed record SsisPackageRowDto(string Name, bool EntryPoint, string? Description, string Version);
internal sealed record SsisReferenceDto(long Id, string Type, string? Folder, string Environment, string ValidationStatus);
internal sealed record SsisProjectModel(string View, long Id, string Folder, string Name, string? Description, int? FormatVersion, string DeployedBy, string Deployed, string Created,
    long VersionLsn, string ValidationStatus, string? Validated, List<SsisPackageRowDto> Packages, List<SsisParameterDto> Parameters, List<SsisReferenceDto> References, bool Truncated);
internal sealed record SsisPackageModel(string View, long Id, string Folder, string Project, string Name, string? Description, int FormatVersion, string Version, string? VersionComments,
    bool EntryPoint, string ValidationStatus, string? Validated, List<SsisParameterDto> Parameters, bool Truncated);
internal sealed record SsisVariableDto(string Name, string Type, string? Description, bool Sensitive, string? Value);
internal sealed record SsisEnvironmentModel(string View, long Id, string Folder, string Name, string? Description, string CreatedBy, string Created, List<SsisVariableDto> Variables, bool Truncated);
/// <summary>ssis.execute's action (src/shared/ssis/schema.ts SsisAction): the verb and its own members, null for other verbs'.
/// SsisActionService.Validate refuses a member its verb does not take.
/// Create Catalog's Password is the catalog's encryption password: the request is sensitive, and the record never prints it.</summary>
internal sealed record SsisActionDto(string Verb, long? OperationId = null, string? Password = null, bool? EnableClr = null, bool? StartupProcedure = null)
{
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append("Verb = ").Append(Verb).Append(", OperationId = ").Append(OperationId).Append(", Password = ").Append(Password is null ? "null" : "<redacted>")
            .Append(", EnableClr = ").Append(EnableClr).Append(", StartupProcedure = ").Append(StartupProcedure);
        return true;
    }
}
/// <summary>ssis.execute: Revision is a describe's, only for a verb that takes one.</summary>
internal sealed record SsisExecuteArgs(string ConnectionId, string RequestId, SsisActionDto Action, string? Revision = null);
/// <summary>The steps the write ran, in order (none when it was refused first), or Error.</summary>
internal sealed record SsisExecuteResult(List<ActionStepDto> Steps, long ElapsedMs, SsisError? Error = null);
/// <summary>ssis.catalogSetup (src/shared/ssis/schema.ts): what Create Catalog's dialog reads.</summary>
internal sealed record SsisCatalogSetupArgs(string ConnectionId, string RequestId);
/// <summary>What Create Catalog will do on the server: SsisCatalogSetup in src/shared/ssis/schema.ts.</summary>
internal sealed record SsisCatalogSetupDto(string Catalog, bool ClrEnabled, bool StartupDefault, string BackupFile, string DataFile, string LogFile);
internal sealed record SsisCatalogSetupResult(SsisCatalogSetupDto? Setup, long ElapsedMs, SsisError? Error = null);
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
/// the server that answered, plus <c>Reason</c> "certificate" when the server's TLS certificate was not trusted (the dialog
/// offers to trust it). <c>Exception</c> comes only with BACKEND_ERROR: the unexpected exception's types and HRESULTs for
/// Copy details (<see cref="ErrorDetailsLimits.Summary"/>), never its message. Never the connection string or the password.</summary>
internal sealed record ErrorDetails(int? Number, int? State, int? Class, string? Server, string? Reason = null, string? Exception = null);

internal static class ErrorDetailsLimits
{
    /// <summary>The longest exception summary the details carry; main refuses a longer one.</summary>
    internal const int MaxExceptionLength = 512;
    /// <summary>The reason a certificate failure carries, the only reason there is.</summary>
    internal const string Certificate = "certificate";

    /// <summary>"System.InvalidOperationException (0x80131509) &gt; System.DllNotFoundException (0x80131524)": the types and
    /// HRESULTs from the outer exception inwards, at most four, cut at 512 characters. Messages are left out because they can
    /// hold paths, names or SQL text.</summary>
    internal static string Summary(Exception error)
    {
        var parts = new List<string>();
        for (Exception? current = error; current is not null && parts.Count < 4; current = current.InnerException)
            parts.Add($"{current.GetType().FullName} (0x{current.HResult:X8})");
        var text = string.Join(" > ", parts);
        return text.Length > MaxExceptionLength ? text[..MaxExceptionLength] : text;
    }
}

internal sealed class RequestException(string code, string message, ErrorDetails? details = null) : Exception(message)
{
    public string Code { get; } = code;
    public ErrorDetails? Details { get; } = details;
}
