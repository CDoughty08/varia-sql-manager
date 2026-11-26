using System.Text.Json;
using System.Text.Json.Serialization;
using Varia.Backend.Activity;

namespace Varia.Backend;

/// <summary>Environment is the profile's label (Production, Staging, a custom one of at most 32 characters); the backend only
/// bounds it, since the workbench shows it and SQL Server never sees it.</summary>
internal sealed record ConnectOptions(string Server, string Database, string Authentication, string? Username, string? Password, bool TrustServerCertificate,
    string Encrypt = "mandatory", string? HostNameInCertificate = null, string? DisplayName = null, string? Color = null, string? Environment = null, AdvancedConnectionOptions? Advanced = null, bool NonInteractive = false,
    // Read for the options union and cleared at once (SqlService.ReadConnect); never written, so serialised options stay 0.9.0's.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Provider = null);
internal sealed record AdvancedConnectionOptions(
    int CommandTimeout = 0, int ConnectTimeout = 15, bool ColumnEncryption = false, bool SecureEnclaves = false,
    string AttestationProtocol = "None", string EnclaveAttestationUrl = "", bool MultipleActiveResultSets = false,
    string NetworkProtocol = "default", int PacketSize = 8000, string TransactionBinding = "Implicit Unbind", string TypeSystemVersion = "Latest",
    int ConnectRetryCount = 1, int ConnectRetryInterval = 10, string ApplicationName = "Varia SQL Manager", string WorkstationId = "",
    string ApplicationIntent = "ReadWrite", string CurrentLanguage = "", bool Replication = false, string IpAddressPreference = "IPv4First",
    string ServerCertificate = "", string AttachDbFilename = "", string FailoverPartner = "", string FailoverPartnerSpn = "",
    bool MultiSubnetFailover = false, string ServerSpn = "", bool UserInstance = false);
/// <summary>ProductVersion, Login, EngineEdition and Linux come from the server profile probed at connect. PrincipalId is
/// nonsecret authenticated-account evidence (SQL/Windows SID or Entra tenant/object GUIDs), at most 256 characters.
/// ProviderId is the connection's engine (Providers).</summary>
internal sealed record ConnectionInfo(string Id, string Server, string Database, string ServerVersion, string? DisplayName = null, string? Color = null, int CommandTimeout = 0,
    string? ProductVersion = null, string? Login = null, int? EngineEdition = null, bool? Linux = null, string? PrincipalId = null, long BindingRevision = 0, string ProviderId = Providers.SqlServer);
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
/// :on error exit); by default execution continues with the next batch, as SSMS does. DiscardResults reads every row
/// and keeps none (SSMS's Discard results after execution): result sets are counted, execution plans are kept.</summary>
/// <summary>query.execute. Database is SQL Server's and required there; Dataset is a BigQuery query's default dataset
/// (the connection's when left out), which SQL Server refuses.</summary>
internal sealed record QueryArgs(string ConnectionId, string SessionId, string? Database, string Sql, string QueryId, int MaxRows, int TimeoutSeconds, int StartLine = 1, int MaxResultSets = 10,
    bool StopOnError = false, bool IncludeActualPlan = false, bool IncludeClientStatistics = false, bool IncludeLivePlan = false, bool DiscardResults = false, string? Dataset = null,
    long? MaximumBytesBilled = null, bool? Prices = null, int StartColumn = 1, string? Residence = null, int? WindowCacheMiB = null, BigQuery.BigQueryPreviewTarget? Preview = null,
    string? JobKey = null);
/// <summary>query.session.close: Transaction "commit" commits the session's open transaction first; "rollback" is a plain close,
/// since SQL Server rolls back what a closed session left open. AbortOnRefusedCommit (default true) lets a BigQuery commit
/// refused on an unchecked session fall through to ending the session (docs/bigquery.md, Sessions); SQL Server ignores it,
/// since its failed commit keeps the session either way.</summary>
/// KeepJob (Leave it running) detaches a BigQuery job still running and leaves its session; CancelJob (Cancel the job) cancels
/// it, waits for its DONE and ends the session (docs/bigquery.md, Re-attaching to jobs). SQL Server refuses both.
internal sealed record SessionArgs(string SessionId, string? Transaction = null, bool? AbortOnRefusedCommit = null, bool? KeepJob = null, bool? CancelJob = null);
/// <summary>query.session.close's answer: Closed says a session was ended; Note, a BigQuery close's fixed code (with
/// BigQuery's message or the job id it names), tells what became of a commit or of the session's end.</summary>
internal sealed record SessionCloseResult(bool Closed, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SessionCloseNote? Note = null);
/// <summary>commitNotApplied, committedBeforeCancel, outcomeUnknown, abortFailed or sessionExpired (src/shared/sessions.ts
/// turns each into text).</summary>
internal sealed record SessionCloseNote(string Code, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Message = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? JobId = null);
/// <summary>query.cancel. Detach (BigQuery only) ends the request with status detached and leaves its job running in
/// BigQuery, holding the tab's session (Close Results' Leave it running).</summary>
internal sealed record CancelArgs(string QueryId, bool? Detach = null);
/// <summary>connections.disconnect's answer: FailedAborts counts the idle BigQuery sessions whose ABORT_SESSION failed.</summary>
internal sealed record DisconnectResult(bool Disconnected, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? FailedAborts = null);
/// <summary>A database, or for BigQuery a dataset with its location (absent when BigQuery names none).</summary>
internal sealed record DatabaseInfo(string Name, bool IsSystem, bool IsSnapshot, string? Location = null);
internal enum BigQueryDecimalKind { None, Numeric, BigNumeric }
/// <summary>A result column as the grid sees it: wire is "text" (SSMS display text) or "binary"; role marks documents
/// (xml, json, plan), CLR UDTs and vectors, which are data, and the hidden columns (ResultTextWriter.Hidden): a row's tone
/// and a diff's suffix (old, mark, leftRow, rightRow). Of is the pair a diff's previous-value column (role old) belongs to.
/// SortKind is how its values compare (Results.ColumnTypes), set from DataType whoever builds the column; a provider with
/// another type system sets it when it does.</summary>
internal sealed record ResultColumn(string Name, string DataType, string Wire, string? Role = null, int? MaxLength = null, int? Precision = null, int? Scale = null, bool Nullable = true,
    ResultCollation? Collation = null, int? Of = null)
{
    public string SortKind { get; init; } = Results.ColumnTypes.SortKindOf(DataType);
    // A local pivot needs the provider's aggregate range even when both providers call a column NUMERIC.
    internal BigQueryDecimalKind BigQueryDecimal { get; init; }
}
/// <summary>A char, varchar, text, nchar, nvarchar or ntext column's collation as SqlClient read it from the result's
/// metadata (SqlClientCollation): its Windows locale id, SQL sort id (non-zero for SQL_ collations), the code page SqlClient
/// decodes char and varchar with (0 for UTF-8), whether it is a _UTF8 collation, and its comparison flags, SqlCompareOptions'
/// bits (IgnoreCase 1, IgnoreNonSpace 2, IgnoreKanaType 8, IgnoreWidth 16, BinarySort2 16384, BinarySort 32768).</summary>
internal sealed record ResultCollation(int Lcid, int SortId, int CodePage, bool Utf8, int Options);
/// <summary>A stored result set. rowsAvailable counts rows in sealed pages (what results.read can serve); main adds the
/// backend generation before the renderer sees it. Name is the query's own name for the set, from a #Name="…" marker comment
/// (ResultNames.cs): 1 to ResultNames.MaxChars characters, none of the refused ones; null (left out) when it has none.
/// ProjectedBytes is a windowed result's projected size in memory (its measured row cost times its rows), which the
/// renderer offers Load into memory under; null for any other result.</summary>
internal sealed record ResultDescriptor(uint ResultId, int Index, int BatchNumber, int Iteration, string Kind, IReadOnlyList<ResultColumn> Columns,
    long RowsRead, long RowsStored, long RowsAvailable, long BytesStored, long TruncatedCells, string State, string? Truncated, bool Incomplete, string? Name = null,
    string? Residence = null, long? RowsTotal = null, int? Revision = null, long? ProjectedBytes = null);
internal sealed record ColumnInfo(string Name, string DataType);
internal sealed record TableColumnsResult(List<ColumnInfo> Columns, bool Truncated);
internal sealed record QueryFailure(string Code, string Message, int BatchNumber, int Iteration);
/// <summary>Seq orders it with the results.memory events: the status bar applies only a figure newer than the last it showed.
/// StoppedBytes is the figure the query stopped at for a budget reason, which a later limit change does not alter; null
/// (left out) otherwise.</summary>
internal sealed record ResultBudget(long UsedBytes, long GlobalBytes, long QueryBytes, long Seq, long? StoppedBytes = null);
/// <summary>The global results.memory EVENT: the budget's figures (what the status bar's ring charges) and, for the Memory
/// panel's Nerd metrics, what the store holds. It goes out at the same moments as before (docs/ipc.md, Global memory
/// events); the detail is read when it does.</summary>
internal sealed record ResultsMemoryEvent(long UsedBytes, long GlobalBytes, long Seq, ResultMemoryDetail Detail)
{
    [JsonPropertyOrder(-1)] public string Type => "results.memory";
}
/// <summary>LogicalBytes is the rows as read (their uncompressed pages), StoredBytes what holds them now: raw pages plus
/// compressed ones. CompressedBytes is the packed pages' size and PackedLogicalBytes the rows they hold; CacheBytes the
/// decompressed pages kept for reads. Largest names at most <see cref="Results.ResultStore.MaxLargest"/> results, largest
/// as read first.</summary>
internal sealed record ResultMemoryDetail(long LogicalBytes, long StoredBytes, long CompressedBytes, long PackedLogicalBytes, long CacheBytes,
    IReadOnlyList<ResultMemoryEntry> Largest, ResultCodecCounters Codec, ManagedHeap Heap, long WindowCacheBytes = 0);
/// <summary>State is "raw", "partial" (a pass stopped part way), "packed" or "unpacking"; Progress (0 to 100) only while unpacking. Live is true for a live
/// view's table, which no Results tab names; left out otherwise.</summary>
internal sealed record ResultMemoryEntry(uint ResultId, long LogicalBytes, long StoredBytes, string State, int? Progress = null, bool? Live = null);
/// <summary>The page codec's counters since the backend started. Name and Level are left out while compression is off.
/// Times are in microseconds; LastUnpackMicroseconds is the last operation that unpacked a result (0 before one).</summary>
internal sealed record ResultCodecCounters(string? Name, int? Level, long PagesPacked, long PagesUnpacked, long PackInputBytes, long PackMicroseconds,
    long UnpackOutputBytes, long UnpackMicroseconds, long CacheHits, long CacheLookups, long LastUnpackMicroseconds)
{
    public static readonly ResultCodecCounters Off = new(null, null, 0, 0, 0, 0, 0, 0, 0, 0, 0);
}
/// <summary>The global explorer.index.memory EVENT: the shared index budget's figures and, for the Memory panel's Nerd metrics,
/// what the index holds (docs/ipc.md, Global memory events); the detail is read when the event goes out.</summary>
internal sealed record IndexMemoryEvent(long UsedBytes, long GlobalBytes, long Seq, IndexMemoryDetail Detail)
{
    [JsonPropertyOrder(-1)] public string Type => "explorer.index.memory";
}
/// <summary>What every connection's index holds. Objects and definitions count each held table once (a shared resource set once);
/// Definitions and PackedDefinitions are objects, DefinitionTexts and PackedTexts the distinct texts behind them. PackedBytes is
/// what the packed texts cost and PackedTextBytes what they would as strings. Texts and References are the pool's distinct texts
/// and the references to them. RecordBytes (records, their slots, column types and keys), NameBytes, DefinitionBytes and ReadingBytes (what reads
/// still running added) add up to the budget's use. Cut is definitions left out or cut short, ChildrenLeftOut the held databases
/// read without their children. Connections counts those whose index holds something. LastBuildMs and LastSearchMs are left out
/// before the first.</summary>
internal sealed record IndexMemoryDetail(int Connections, long Objects, int Texts, long References, long Definitions, long PackedDefinitions, long DefinitionTexts,
    long PackedTexts, long PackedBytes, long PackedTextBytes, long Cut, int ChildrenLeftOut, long RecordBytes, long NameBytes, long DefinitionBytes, long ReadingBytes,
    long? LastBuildMs = null, long? LastSearchMs = null);
/// <summary>The managed heap after the last collection (GC.GetGCMemoryInfo): committed bytes, and the free space inside
/// them the runtime keeps for reuse rather than returning to the operating system.</summary>
internal sealed record ManagedHeap(long CommittedBytes, long FreeBytes);
/// <summary>One line of the Messages tab: kind is "info" (Varia's row counts and notes), "print" (PRINT and RAISERROR with
/// severity 10 or less), "server" (SQL Server's other informational messages: warnings, SET STATISTICS output, DBCC) or "error"
/// (SQL errors, cancellation and timeout, shown in red).</summary>
internal sealed record MessageEntry(string Text, string Kind, int? Line = null);
/// <summary>The query.execute summary: rows stay in the backend's result store and are read with results.read. CompletedAt
/// is the backend's local time with 7 fractional digits, as SSMS prints "Completion time:". Status is completed, completedWithErrors
/// (every batch ran and at least one raised an error; Error holds the errors and the first such batch), failed (an error
/// stopped execution: before the first batch, with stopOnError, or by closing the session), cancelled, or timedOut.
/// Spid (SqlConnection.ServerProcessId) and Login (SUSER_SNAME(), read with the SET prologue) are the session's, read once when
/// it opened; both are present while it is still open after the script. IndexStale (BigQuery) numbers the newest stale mark the
/// connection's Search Objects index has not spent yet, so the renderer asks one stale-only build per new mark.</summary>
internal sealed record QueryResult(List<ResultDescriptor> ResultSets, int DiscardedResultSets, List<MessageEntry> Messages, long RecordsAffected, long ElapsedMs,
    string Status, QueryFailure? Error, int CompletedBatches, int TotalBatches, string Database, bool MessagesTruncated, ResultBudget Budget, string CompletedAt,
    int? Spid = null, string? Login = null, List<ResultDescriptor>? PlanSets = null, List<uint>? PlanOrder = null, Statistics.ClientStatisticsSample? ClientStatistics = null,
    BigQuery.BigQueryJobSummary? Job = null, long? IndexStale = null);

internal sealed record SessionStateArgs(string SessionId);
/// <summary>query.session.state: an idle session's @@TRANCOUNT, read on demand before it ends. Checked is false when the
/// session's SET options (SHOWPLAN_*, NOEXEC, PARSEONLY, FMTONLY) kept the SELECT from returning it; TransactionCount is
/// then 0 and the session may hold a transaction.</summary>
/// <summary>Job (BigQuery only): "running" while the tab's session holds a job running or detached in BigQuery, else "none".</summary>
internal sealed record SessionState(int TransactionCount, bool Checked, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Job = null);
/// <summary>results.read: ViewId reads through a view of the result (results.view), FirstRow then counting view positions.</summary>
/// <summary>Viewer (1 to 2^31 - 1) names the grid, popout or Transpose reading, so a windowed result reads ahead for each apart.</summary>
internal sealed record ResultsReadArgs(uint ResultId, long FirstRow, int MaxRows, uint? ViewId = null, uint? Viewer = null);
internal sealed record ResultsReadResult(long NextRow, long RowsAvailable, bool Complete, int Pages, int Rows);
/// <summary>results.remoteQuery: a query over a windowed BigQuery result (docs/ipc.md). QueryId is its own, for query.cancel;
/// Generation is the source result's, which main checks before sending. Kind "load" (Load into memory) takes nothing more;
/// "view" (a sort or filter) takes 0 to 16 Sort keys and 0 to 16 Filters, at least one of either; "distinct" (a value list)
/// takes the Column, the other columns' Filters and, optionally, the Kept filters whose rows tick its values. JobKey (load only)
/// records its job for re-attaching. Fallback runs the original query again when its result table expired (BigQueryViewSql.CanFallBack).
/// "sample" (Load sample) takes Rows (1 to BigQueryViewSql.MaxSampleRows) and Method: "first" reads the first rows (tabledata.list,
/// free), "random" runs a TABLESAMPLE SYSTEM query. "rerun" takes nothing more: it runs the result's own statement again.</summary>
internal sealed record RemoteQueryArgs(string QueryId, uint ResultId, int Generation, string Kind, RemoteSortArgs[]? Sort = null, RemoteFilterArgs[]? Filters = null,
    int? Column = null, RemoteFilterArgs[]? Kept = null, bool? Fallback = null, string? JobKey = null, int? Rows = null, string? Method = null);
/// <summary>One sort key of a remote view: a column of the windowed result, ascending (NULL first) or descending (NULL last).</summary>
internal sealed record RemoteSortArgs(int Column, bool Descending);
/// <summary>One filter of a remote view or value list (results.view's ViewFilter, its values in a value list): Op "in" or
/// "notIn" keeps or drops the values at Rows of the value list List (a result a distinct query made for this column), and
/// NULL when Nulls says; "between" keeps the values from Rows[0]'s to Rows[1]'s of List; "groups" keeps what the ticks of
/// SnapshotId, a value list snapshot of List, keep. "in" and "notIn" with no Rows name no list.</summary>
internal sealed record RemoteFilterArgs(string Op, int Column, uint? List = null, int[]? Rows = null, bool? Nulls = null, uint? SnapshotId = null);
internal sealed record ResultsCloseArgs(uint[] ResultIds);
internal sealed record ResultsCloseResult(int Closed, long UsedBytes);
/// <summary>results.visibility: the results whose grids are shown in any window now, at most ResultVisibility.MaxResults
/// distinct ids. Source names the renderer load and Seq (1 to 2^31 - 1) orders its sets, so a late set never undoes a
/// newer one. Visible is how many ids the visible set holds; Applied is false for such a late set.</summary>
internal sealed record ResultsVisibilityArgs(string? Source, long? Seq, uint[]? Visible);
internal sealed record ResultsVisibilityResult(int Visible, bool Applied);
/// <summary>results.setMemoryLimit (main only): Tools › Options' limit in GiB, 0 for automatic, 0 to 1024.</summary>
internal sealed record ResultsMemoryLimitArgs(int? LimitGiB);
/// <summary>results.setMemoryLimit: whether the limit applied (false with the test hooks' fixed budget) and the figures now.</summary>
internal sealed record ResultsMemoryLimitResult(bool Applied, long GlobalBytes, long QueryBytes);
internal sealed record ResultsRowBytesArgs(uint ResultId, long FirstRow, int Count, uint? ViewId = null);
/// <summary>One results.view sort key: a column, its direction, and Mode "value" (by SQL type and collation), "chars" or
/// "bytes" (each cell's length; text and binary columns only, others sort by value).</summary>
internal sealed record ViewSortArgs(int Column, bool Descending, string Mode);
/// <summary>results.view: a view of a result sorted by 1 to 16 keys (distinct columns); Replaces names a view of the same
/// result that it supersedes (closed once this one exists).</summary>
internal sealed record ResultsViewArgs(uint ResultId, ViewSortArgs[] Sort, uint? Replaces = null, ViewFilterArgs[]? Filters = null);
/// <summary>One results.view filter (ViewFilter): Op "in", "notIn" or "between" on Column, with its values as base Rows
/// (and Nulls) or as the selected Cells; Op "duplicates" on Columns; Op "groups" on Column: the values a distinct
/// snapshot of that column (SnapshotId) ticks; or Op "keepRows", which names no column: the base Rows to keep (1 to 4,095),
/// or the rows the selected Cells cover; or Op "kind", only on a comparison (kind diff), which names no column: the Kinds of
/// row it keeps (1 to 4 of "same", "changed", "added", "removed"; a changed entry's halves are changed).</summary>
internal sealed record ViewFilterArgs(string Op, int? Column = null, int[]? Rows = null, bool? Nulls = null, ViewCellsArgs? Cells = null, int[]? Columns = null, uint? SnapshotId = null, string[]? Kinds = null);
/// <summary>Selected cells: 1 to 256 [first, count] ranges of positions in ViewId's order, or in the result's own.</summary>
internal sealed record ViewCellsArgs(long[][] Ranges, uint? ViewId = null);
/// <summary>A filter as the view applied it, its cells resolved to one base row per distinct value (Between: the lowest
/// and highest). A "groups" filter comes back as it was asked, with whether it keeps (else drops) the Values it names, NULL
/// among them (Nulls), and the one value's representative Row when it names exactly one besides NULL. A "keepRows" filter
/// comes back as the base Rows it keeps, ascending; a "kind" filter as its Kinds, in the order same, changed, added, removed.</summary>
internal sealed record ViewFilterResult(string Op, int? Column = null, int[]? Rows = null, bool? Nulls = null, int[]? Columns = null, uint? SnapshotId = null, bool? Keep = null, int? Values = null, int? Row = null, string? Digest = null,
    string[]? Kinds = null);
/// <summary>Rows is the view's row count; BaseRows the result's rows it was built from (those sealed then, Rows when it has
/// no filter); Complete says those were all the result's rows; Approximate says a key compared a truncated value's prefix
/// or an estimated length.</summary>
internal sealed record ResultsViewResult(uint ViewId, long Rows, long BaseRows, bool Complete, bool Approximate, ViewFilterResult[]? Filters = null);
internal sealed record ResultsViewCloseArgs(uint ResultId, uint[] ViewIds);
internal sealed record ResultsViewCloseResult(int Closed);
/// <summary>results.identify: how the result's rows are told apart, for highlights. By "auto" picks a unique key column, else
/// the whole row; "column" uses Column (unique or not); "row" hashes every value. The result must have finished loading.</summary>
internal sealed record ResultsIdentifyArgs(uint ResultId, string By, int? Column = null);
/// <summary>Column is the key column, or -1 for the whole row; Unique says no two rows share an identity; Approximate that a
/// truncated value's stored prefix was hashed.</summary>
internal sealed record ResultsIdentifyResult(int Column, bool Unique, bool Approximate, long Rows);
/// <summary>results.rowIds: the identities (results.identify) of up to 16,384 rows from FirstRow, view positions with ViewId.</summary>
internal sealed record ResultsRowIdsArgs(uint ResultId, long FirstRow, int Count, uint? ViewId = null);
internal sealed record ResultsRowIdsResult(long FirstRow, long[] Ids, long Rows);
/// <summary>results.findRows: every row (view position with ViewId) whose identity is one of Ids (1 to 10,000).</summary>
internal sealed record ResultsFindRowsArgs(uint ResultId, long[] Ids, uint? ViewId = null);
/// <summary>Positions ascend; Marks[k] is the index in Ids of position k's identity. Truncated: more than 100,000 rows matched
/// and only the first are listed.</summary>
internal sealed record ResultsFindRowsResult(long[] Positions, int[] Marks, bool Truncated, long Rows);
/// <summary>results.diff: compares two complete results of the same query (Left the earlier, Right the later) and stores
/// the unified diff as a new result of that query (UnifiedDiff). Context is how many unchanged rows show around each change
/// (-1: all); Exact compares text character for character instead of by collation. Layout is "unified" (absent: two rows a
/// change) or "entry" (one row an entry, its old values in previous-value columns; at most UnifiedDiff.MaxEntryPairs pairs).
/// Replaces names a comparison of the same two results (either order) that this one replaces: while it is written the
/// query's limit is raised by that comparison's whole charge (ResultStore.Allow).</summary>
internal sealed record ResultsDiffArgs(uint Left, uint Right, bool Exact = false, int Context = 1, DiffMatchArgs? Match = null, string? Layout = null, uint? Replaces = null);
/// <summary>How results.diff matches rows: Mode "auto" (absent: auto), "position", "rows", or "columns" with 1 to 16
/// distinct pair indexes (ResultDiffer.MaxKeyColumns).</summary>
internal sealed record DiffMatchArgs(string Mode, int[]? Columns = null);
/// <summary>What matched rows: Mode "auto" with its key's name, "rows" (asked, or when auto found no key), "position", or
/// "columns" with the key columns' names (the second result's).</summary>
internal sealed record DiffMatchResult(string Mode, string[] Columns);
/// <summary>One pair's changed and soft (collation-only) cells.</summary>
internal sealed record DiffColumnChange(long Changed, long Soft);
/// <summary>Match is what matched rows; LeftOnly and RightOnly are the columns (at most 64 names each) without a namesake in
/// the other result, which are not compared; Soft counts values equal only by collation (case or trailing spaces, say).
/// Repeated counts entries whose key repeats (flagged dup), Possible the pairs of removed and added rows that look alike
/// (flagged poss), PossibleSkipped that too many unmatched rows were left to look; NothingPaired that both results have
/// rows and none matched. ColumnChanges is per pair; TrailingHidden the unchanged entries left out after the last row;
/// Layout the layout written ("unified" or "entry").</summary>
internal sealed record ResultsDiffResult(ResultDescriptor Descriptor, DiffMatchResult Match, long Same, long Changed, long Added, long Removed, long Soft, bool Approximate,
    string[] LeftOnly, string[] RightOnly, long Repeated, long Possible, bool PossibleSkipped, bool NothingPaired, DiffColumnChange[] ColumnChanges, long TrailingHidden,
    int[] Overview, long Units, string Layout = "unified");
/// <summary>results.diffSeek: either From (a position, -1 before the first) and Direction "next" or "previous", or PartnerOf
/// (a look-alike row's position); positions are a view's with ViewId, else stored rows of the comparison.</summary>
internal sealed record ResultsDiffSeekArgs(uint ResultId, uint? ViewId = null, long? From = null, string? Direction = null, long? PartnerOf = null);
/// <summary>The position landed on (Row), the pair index of its cell (Column: an added, removed or cut unit's is 0), the
/// unit's number (Index, 1 to Total), the change units in the view (Total) and the rows shown (Rows: the set's or the
/// view's, which main checks Row against); or None (nothing found), or Hidden (the partner exists but the view hides it).</summary>
internal sealed record ResultsDiffSeekResult(long? Row = null, int? Column = null, long? Index = null, long? Total = null, bool? None = null, bool? Hidden = null, long? Rows = null);
/// <summary>One results.pivot value: Aggregate "count", "countDistinct", "sum", "avg", "min" or "max" of Column; "count"
/// without a column counts rows.</summary>
internal sealed record PivotValueArgs(string Aggregate, int? Column = null);
/// <summary>results.pivot: groups a complete result's rows (ViewId's, in its order, when given) by up to 8 Rows columns and
/// a Column column, and stores 1 to 16 Values of each group as a new result of the query (PivotOutput).</summary>
internal sealed record ResultsPivotArgs(uint ResultId, int[] Rows, PivotValueArgs[] Values, int? Column = null, uint? ViewId = null);
/// <summary>Descriptor is the pivot's result (kind "pivot"); Rows the source rows pivoted; RowGroups and ColumnGroups how many
/// distinct groups it has (all shown: a pivot past its bounds is refused); Approximate that a value compared was a truncated
/// value's stored prefix.</summary>
internal sealed record ResultsPivotResult(ResultDescriptor Descriptor, long Rows, long RowGroups, long ColumnGroups, bool Approximate);
/// <summary>results.search: the cells whose grid text contains Text (1 to 1,024 characters), searched through ViewId's order
/// when it is given (rows are then view positions). It returns up to MaxMatches (1 to 10,000) of them in whole rows: from
/// FromRow on, or with Backward the last ones before FromRow.</summary>
internal sealed record ResultsSearchArgs(uint ResultId, string Text, long FromRow, int MaxMatches, bool Backward = false, uint? ViewId = null);
/// <summary>Rows is how many rows were searched (the rows sealed so far, or the view's); Total counts every match among them;
/// MatchRows[k] and MatchColumns[k] are the run's matches in row then column order, First the matches before the run's
/// first (when it is empty, those before FromRow). Complete says the rows searched were all the result's; Approximate that
/// a truncated value was searched by its stored prefix.</summary>
internal sealed record ResultsSearchResult(long Rows, long Total, long First, long[] MatchRows, int[] MatchColumns, bool Complete, bool Approximate);
/// <summary>results.profile: aggregates for 0 to 32 distinct columns over a result's rows, or its view's (ViewId); 0 columns
/// answers only the rows' byte sizes.</summary>
internal sealed record ResultsProfileArgs(uint ResultId, int[] Columns, uint? ViewId = null);
/// <summary>Minimum, maximum and average of a length (characters, DATALENGTH, or a row's bytes); Exact is false when any
/// figure counted was an estimate.</summary>
internal sealed record ProfileLengths(long Min, long Max, double Average, bool Exact);
/// <summary>Counts in equal buckets from Low to High (both included) of a column's values ("value"), instants in .NET
/// ticks ("time"), characters ("chars") or bytes ("bytes").</summary>
internal sealed record ProfileHistogram(string Basis, double Low, double High, long[] Counts);
/// <summary>One column's profile: Values non-NULL cells and Nulls the rest; Distinct, exact unless DistinctExact is false (an
/// estimate past 16,384); Min and Max as display text (binary as 0x hex), at most 256 characters and "…"; Approximate
/// when a truncated cell's stored prefix took part. Chars and Bytes are null for columns that are neither text nor
/// binary, Histogram for those with nothing to bucket.</summary>
internal sealed record ColumnProfile(int Column, long Values, long Nulls, long Distinct, bool DistinctExact, string? Min, string? Max, bool Approximate,
    ProfileLengths? Chars, ProfileLengths? Bytes, ProfileHistogram? Histogram);
/// <summary>Rows profiled (the view's, or the rows sealed when it ran), whether they were all the result's, the rows' byte
/// sizes (null without rows), and the columns asked for, in order.</summary>
internal sealed record ResultsProfileResult(long Rows, bool Complete, ProfileLengths? RowBytes, ColumnProfile[] Columns);
/// <summary>results.distinct: keeps one column's distinct values over a result's rows, or its view's (ViewId), as a
/// snapshot read by window. KeptViewId, another view of the result, starts each value (and NULL) ticked when one of that
/// view's rows holds it; without it every value starts ticked.</summary>
internal sealed record ResultsDistinctArgs(uint ResultId, int Column, uint? ViewId = null, uint? KeptViewId = null);
/// <summary>The snapshot's id; rows grouped (the view's, or the rows sealed when it ran) and whether they were all the
/// result's; Nulls counts NULL and unreadable cells; Distinct the values; Approximate when a truncated value compared by
/// its stored prefix; Checked the values ticked and NullsChecked NULL's tick.</summary>
internal sealed record ResultsDistinctResult(uint SnapshotId, long Rows, bool Complete, long Nulls, long Distinct, bool Approximate, long Checked, bool NullsChecked);
/// <summary>results.distinctRead: 1 to 512 values from Offset in Order ("count" or "value"), among those whose display text
/// contains Search (1 to 1,024 characters) when given.</summary>
internal sealed record ResultsDistinctReadArgs(uint ResultId, uint SnapshotId, string Order, long Offset, int Count, string? Search = null);
/// <summary>A distinct value: its group (its place in value order), its representative base row (the lowest holding it),
/// its display text (binary as 0x hex, at most 256 characters and "…"), how many rows hold it, and its tick.</summary>
internal sealed record DistinctValue(int Group, int Row, string Text, long Count, bool Checked);
/// <summary>Total counts the values the search kept (every value without one); Values are the window asked, at most Count
/// of them from Offset; Checked and NullsChecked are the ticks as results.distinct reports them.</summary>
internal sealed record ResultsDistinctReadResult(long Total, long Offset, DistinctValue[] Values, long Checked, bool NullsChecked);
/// <summary>results.distinctTick: ticks (Checked) or clears values in one mode at most: 1 to 512 Groups; every value (All),
/// only those whose text contains Search with one; 1 to 512 sorted, disjoint Ranges of [offset, count] in the list Order
/// reads (searched with Search), which Toggle ticks when any of them, or NULL when Nulls is given, is cleared and else clears;
/// or Invert, which flips every value. Nulls sets NULL's tick, alone or with a mode.</summary>
internal sealed record ResultsDistinctTickArgs(uint ResultId, uint SnapshotId, bool Checked, int[]? Groups = null, bool? All = null, string? Search = null, bool? Nulls = null,
    string? Order = null, long[][]? Ranges = null, bool? Toggle = null, bool? Invert = null);
internal sealed record ResultsDistinctTickResult(long Checked, bool NullsChecked);
/// <summary>results.distinctClose: 1 to 64 snapshot ids of one result.</summary>
internal sealed record ResultsDistinctCloseArgs(uint ResultId, uint[] SnapshotIds);
internal sealed record ResultsDistinctCloseResult(int Closed);
/// <summary>results.rowBytes: Bytes[k] is row FirstRow + k's sum of DATALENGTH over its cells (NULL counts 0; xml and json
/// as their text, some sql_variant base types estimated: docs/ipc.md, Cell lengths and row sizes); it stops at the rows sealed
/// so far. Estimated lists, in order, the rows of the range whose sum includes an estimate.</summary>
internal sealed record ResultsRowBytesResult(long FirstRow, long[] Bytes, long RowsAvailable, long[] Estimated);
/// <summary>A piece of a copy: inclusive row ranges (a last row of 2^53 - 1 runs to the end) by inclusive column ranges.</summary>
internal sealed record CopyPartArgs(long[][] Rows, int[][] Columns);
/// <summary>results.copy (main only): the parts' text streams as DATA; eol is "crlf" or "lf".</summary>
/// ViewId copies through a view of the result (results.view): rows are view positions.
/// Transposed copies the parts as a transposed grid draws them: a line per column and a field per row, for the rows at the
/// view's first 4,095 positions; HeaderColumn (with Transposed only) names the fields by that column's values.
internal sealed record ResultsCopyArgs(uint ResultId, CopyPartArgs[] Parts, bool Headers, string Eol, long MaxBytes, uint? ViewId = null, bool Transposed = false, int? HeaderColumn = null);
/// <summary>results.export (main only): Path comes from main's save dialog; Format is csv, tsv or json; NullText is
/// "empty" or "NULL"; TemporaryId (32 hex digits) names the temporary file, .varia-{id}.tmp beside the target, which main
/// removes if the backend dies while writing it.</summary>
/// ViewId saves a view's rows, in its order.
/// Transposed and HeaderColumn are as results.copy's.
internal sealed record ResultsExportArgs(uint ResultId, string Path, string Format, bool Headers, string NullText, string TemporaryId, uint? ViewId = null, bool Transposed = false, int? HeaderColumn = null);
/// <summary>Rows are the source rows written; Capped those a transposed job left out for lying past the rows a transposed
/// grid draws (0 otherwise).</summary>
internal sealed record ResultsJobResult(long Rows, long Bytes, long TruncatedCells, bool Partial, long Capped = 0);
/// <summary>debug.results.synthesize (VARIA_BACKEND_TEST_HOOKS=1 only). Pack packs the stored result's pages before it
/// answers (the benchmarks' packed result), as the policy would once it went idle.</summary>
internal sealed record SynthesizeArgs(string Shape, int Rows, bool Pack = false);

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
/// <summary>SsisFolder and SsisProject name an SSIS Catalog object's folder and project (the ssis* scopes); Project, Dataset and
/// Table a BigQuery object's project, dataset and (for a column) table (the bq* scopes); null elsewhere.</summary>
internal sealed record ObjectRefDto(string Kind, string? Database = null, string? Schema = null, string? Name = null, ParentRefDto? Parent = null, string? SsisFolder = null,
    string? SsisProject = null, string? Project = null, string? Dataset = null, string? Table = null);
internal sealed record ParentRefDto(string Kind, string Schema, string Name);
internal sealed record ExplorerFilterDto(TextFilterDto? Name = null, TextFilterDto? Schema = null, TextFilterDto? Owner = null, DateFilterDto? Created = null);
internal sealed record TextFilterDto(string Op, string Value);
internal sealed record DateFilterDto(string Op, string Value, string? Value2 = null);
/// <summary>One tree node. Created is server local time, yyyy-MM-ddTHH:mm:ss. Database: a database node's runtime state.
/// ConnectDenied: a login denied CONNECT SQL, sent only when true (Status says disabled when it is disabled too).</summary>
internal sealed record ExplorerNode(NodeRefDto Ref, string Label, string Icon, bool HasChildren, string? Sublabel = null, string? Detail = null, string? Subtype = null,
    string? Status = null, string? Created = null, ExplorerDatabase? Database = null, bool? ConnectDenied = null, string? JobId = null);
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
/// text, absent when it is encrypted or hidden, or only its first page when DefinitionLength is set: the whole text's length in
/// UTF-16 code units, with DefinitionStamp, its modify_date in Unix ms (explorer.peekDefinition reads the rest). Facts are empty
/// with an Error. Lists: the kind's lists by id. Refused: the optional groups whose statement the login was refused (their facts are absent).</summary>
internal sealed record PeekResult(Dictionary<string, object?> Facts, long ElapsedMs, string? Definition = null, long? DefinitionLength = null, long? DefinitionStamp = null,
    ExplorerError? Error = null, Dictionary<string, PeekList>? Lists = null, List<string>? Refused = null);
/// <summary>explorer.peekDefinition: a page of a module kind's text from Offset (UTF-16 code units, past explorer.peek's first page,
/// below the catalogue's longest text). Cancellation as explorer.peek's.</summary>
internal sealed record PeekDefinitionArgs(string ConnectionId, string RequestId, ObjectRefDto Target, int Offset);
/// <summary>At most the catalogue's page of text from the offset (absent when the module has no visible text now), never ending
/// inside a surrogate pair before the end, with the whole text's length and modify_date (Unix ms) now. Length and Stamp are 0 with an Error.</summary>
internal sealed record PeekDefinitionResult(string? Text, long Length, long Stamp, long ElapsedMs, ExplorerError? Error = null);
/// <summary>One of a peek's lists: its rows (values by the list's column formats); Truncated when there were more than the
/// catalogue keeps; Unread, for a login's User mapping, the databases that could not be read.</summary>
internal sealed record PeekList(List<object?[]> Rows, bool? Truncated = null, int? Unread = null);
/// <summary>explorer.peekDependencies (its args are PeekArgs): what the object references and the tables its foreign keys
/// point at (Uses), and what references it or points at it by a foreign key (UsedBy), each truncated when there were more.
/// Both lists are empty with an Error.</summary>
internal sealed record PeekDependenciesResult(List<PeekDependency> Uses, List<PeekDependency> UsedBy, long ElapsedMs, bool? UsesTruncated = null, bool? UsedByTruncated = null, ExplorerError? Error = null);
/// <summary>One object on Peek's Dependencies tab and in View Dependencies' tree: Database and Server name another database or a
/// linked server; Kind is its Object Explorer kind when it is in this database and listed by name (a DML trigger with its table's
/// or view's Parent), with the Subtype the tree gives it; ForeignKey is true when a foreign key makes the link. Type is the
/// object's sys.objects type (trimmed; absent when SQL Server did not resolve the reference here), and SchemaBound is true for a
/// schema-bound reference (sys.sql_expression_dependencies, or a column or parameter of a type).</summary>
internal sealed record PeekDependency(string Name, string? Schema = null, string? Database = null, string? Server = null, string? Kind = null, bool? ForeignKey = null, string? Subtype = null,
    string? Type = null, bool? SchemaBound = null, ParentRefDto? Parent = null, string? ParentSubtype = null);
/// <summary>explorer.dependencies (src/shared/explorer/dependencies.ts): one level of View Dependencies' tree for an object of a kind
/// whose Peek has the Dependencies tab, Direction "uses" (what it depends on) or "usedBy" (what depends on it). Cancellation as explorer.peek's.</summary>
internal sealed record DependenciesArgs(string ConnectionId, string RequestId, ObjectRefDto Target, string Direction);
/// <summary>At most the catalogue's level of objects in name order, Truncated when there were more; empty with an Error.</summary>
internal sealed record DependenciesResult(List<PeekDependency> Items, long ElapsedMs, bool? Truncated = null, ExplorerError? Error = null);

/// <summary>explorer.index: (re)builds the connection's object index, with module definitions unless Definitions is false. It
/// sends droppable explorer.index.progress EVENTs and answers once every database was read or skipped; a newer build of the
/// same connection, Stop, or a disconnect ends it (CANCELLED), keeping what it read.</summary>
/// <summary>BigQuery only (SQL Server refuses them): StarredProjects names the user's starred projects (indexed with details even if
/// projects.list does not return them), AllProjects discovers every accessible project via projects.list (default true), MaxProjects
/// caps how many accessible projects discovery keeps (1..BigQueryIndexLimits.MaxProjectsCap, default BigQueryIndexLimits.MaxProjects),
/// Scope re-reads one project or dataset (Object Explorer's Refresh, re-reading every object in it), and Stale re-reads only the datasets DDL marked.</summary>
/// <summary>Bulk: pass 2 reads these locations' details with the billed INFORMATION_SCHEMA queries (a full build only, after
/// bigquery.indexEstimate and the cost prompts).</summary>
/// <summary>MemoryLimitMiB (either engine): the memory every connection's index shares, as Options sets it
/// (ObjectIndexLimits.MinMemoryMiB..MaxMemoryMiB); it applies from this build on, and absent leaves the limit as it is.</summary>
internal sealed record ObjectIndexArgs(string ConnectionId, string RequestId, bool? Definitions = null, List<string>? StarredProjects = null, bool? AllProjects = null,
    BigQueryIndexScope? Scope = null, bool? Stale = null, BigQueryBulkArgs? Bulk = null, int? MaxProjects = null, bool? MissingOnly = null, int? MemoryLimitMiB = null);
/// <summary>A BigQuery refresh's scope: a project, or one of its datasets.</summary>
internal sealed record BigQueryIndexScope(string Project, string? Dataset = null);
/// <summary>The bulk path's locations, as bigquery.indexEstimate answered them; the cap every job carries (a connection's own wins); and
/// the estimate the cost prompts showed (BudgetBytes), which the build's jobs together never bill more than.</summary>
internal sealed record BigQueryBulkArgs(List<BigQueryIndexLocation> Locations, long? MaximumBytesBilled = null, long? BudgetBytes = null);
/// <summary>A project's location (US, EU, us-central1, …), whose region-scoped INFORMATION_SCHEMA the bulk path reads.</summary>
internal sealed record BigQueryIndexLocation(string Project, string Location);
/// <summary>bigquery.indexEstimate: what a full build's bulk path would bill, for the cost prompts: Definitions and StarredProjects as the
/// build will send them.</summary>
internal sealed record BigQueryIndexEstimateArgs(string ConnectionId, bool? Definitions = null, List<string>? StarredProjects = null);
/// <summary>The locations to read (datasets.list's, at most 64; Cut when there were more, whose datasets pass 2 reads with free calls)
/// and their queries' estimate, each at least BigQuery's 10 MiB per view read. A location whose dry run failed is left out.</summary>
internal sealed record BigQueryIndexEstimateResult(List<BigQueryIndexLocation> Locations, BigQuery.BigQueryDryRunResult Estimate, bool Cut, long ElapsedMs);
/// <summary>The last full build's bulk path: the locations read billed, and the first failure of those that fell back to free calls.</summary>
internal sealed record BigQueryBulkStatus(int Locations, int Failed = 0, string? Code = null, string? Message = null);
/// <summary>A database the index could not read: its code (NO_DB_ACCESS, TIMEOUT, TOO_LARGE, CATALOG_ERROR) and a sentence.</summary>
/// <summary>Agent: SQL Server Agent's objects were left out, not the database named (msdb, where they are read).</summary>
/// <summary>Project: a BigQuery dataset's project (Database is the dataset, or empty when the project's listing failed).</summary>
internal sealed record ObjectIndexSkip(string Database, string Code, string Message, bool? Agent = null, string? Project = null, bool? Details = null);
/// <summary>The index as a search finds it. State: none (never built), building, or ready. BuiltAt: UTC, when the last build ended.</summary>
/// <summary>BigQuery: Databases and Indexed count datasets; Phase is projects, names (pass 1) or details (pass 2) while building; NamesOnly lists
/// projects whose details could not be read due to the memory budget; Bulk is the last full build's billed bulk path, when it ran;
/// Projects counts the distinct projects held in the index; StaleMark numbers the newest DDL stale mark a stale-only build has not spent yet (absent when none is left);
/// Stopped is true when the last full build was stopped before it finished, so the index holds only what it read (absent otherwise).</summary>
/// <summary>LeftOut: the definitions (counted in Cut too) left out whole because the index's memory ran out, and LeftOutIn the
/// databases (BigQuery: datasets) they belong to, the server's own and the system objects each counting as one; both absent when none was.</summary>
internal sealed record ObjectIndexStatus(string State, int Databases, int Indexed, int Objects, int Modules, int Cut, List<ObjectIndexSkip> Skipped, bool Definitions, string? BuiltAt = null,
    string? Provider = null, string? Phase = null, List<string>? NamesOnly = null, BigQueryBulkStatus? Bulk = null, int? Projects = null, long? StaleMark = null, bool? Stopped = null,
    int? LeftOut = null, int? LeftOutIn = null);
internal sealed record ObjectIndexResult(ObjectIndexStatus Status, long ElapsedMs);
/// <summary>explorer.indexStatus: what a connection's index holds now, without building or searching.</summary>
internal sealed record ObjectIndexStatusArgs(string ConnectionId);
/// <summary>explorer.search: In is names, definitions or all; Kinds and Database narrow it; Limit is at most 1000 hits; Match is
/// exact (the default) or fuzzy, which adds approximate name matches and cannot go with Regex.</summary>
internal sealed record ObjectSearchArgs(string ConnectionId, string RequestId, string Text, bool? CaseSensitive = null, bool? WholeWord = null, bool? Regex = null, string? In = null,
    List<string>? Kinds = null, string? Database = null, int? Limit = null, string? Match = null, string? Project = null, string? Dataset = null);
/// <summary>A definition's first match: its line and column (1-based), part of its line with the match's [start, length] in it,
/// whether the line goes on before or after the part, the matches counted (at most 999), and whether the definition was cut.
/// Uncounted (true or absent): the search's budget ran out before the count reached the definition's end, so Matches is only
/// a lower bound.</summary>
internal sealed record DefinitionMatch(int Line, int Column, string Preview, int[] Range, bool Before, bool After, int Matches, bool Cut, bool? Uncounted = null);
/// <summary>One object found: Range is the name match's [start, length] in Label; Modified is server local time; Subtype is its
/// node's where the index knows it; ParentFolder is the folder that lists a child's parent (Tables › Graph Tables, say); Via is
/// the table (in its database, in Folder) that shows a history table, or a history table's parent, as its history row;
/// Approximate marks a Fuzzy Match name hit, whose Range spans its first to last matched word.
/// Type is a BigQuery column's type (INT64, ARRAY&lt;STRING&gt;); Shards a date-sharded group the hit's table (its newest shard) stands for.</summary>
internal sealed record ObjectSearchHit(ObjectRefDto Object, string Folder, string Label, int[]? Range, string? Modified, DefinitionMatch? Definition, string? Subtype = null,
    string? ParentFolder = null, ViaRefDto? Via = null, bool? Approximate = null, string? Type = null, BigQueryShardsDto? Shards = null);
/// <summary>A date-sharded table group (events_20260101, events_20260102, …): its prefix, how many shards, and the first and last date suffix.</summary>
internal sealed record BigQueryShardsDto(string Prefix, int Count, string First, string Last);
internal sealed record ViaRefDto(string Schema, string Name, string Folder);
/// <summary>The best Limit hits of Total; Partial when the search stopped at its budget or candidate cap. Problem: why the
/// pattern cannot be searched for (no hits then).</summary>
internal sealed record ObjectSearchResult(List<ObjectSearchHit> Hits, int Total, bool Partial, long ElapsedMs, ObjectIndexStatus Index, string? Problem = null);

/// <summary>scripting.script: one object for Script As (the wizard will send many), a verb of the catalogue, and every
/// scripting option (src/shared/scripting/schema.ts). Cancellation is a CANCEL frame for the request.</summary>
/// <summary>EstimateOnly and MaximumBytesBilled: a BigQuery CREATE's free estimate, and the cap its billed query runs under; SQL Server refuses them.</summary>
internal sealed record ScriptArgs(string ConnectionId, string RequestId, List<ObjectRefDto> Targets, string Verb, ScriptingOptionsDto Options, bool? EstimateOnly = null,
    long? MaximumBytesBilled = null);
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
/// <para>Estimate: a BigQuery CREATE's estimate, answered instead of Text when EstimateOnly asked for it.</para>
internal sealed record ScriptResult(string? Text, string Database, List<string> Warnings, int Commands, long ElapsedMs, ScriptError? Error = null,
    BigQuery.BigQueryDryRunResult? Estimate = null);

/// <summary>actions.describe: what an object dialog shows (deleteObject: Delete Object's row; databaseProperties: Database Properties' pages),
/// what an inline action reads first (renameDatabase), what the table designer needs of a database (tableDesigner), one database's roles and schemas for User Mapping (loginDatabaseRoles), the server's folders (serverFiles, the server as Target, with Files),
/// what Restore Database restores from (restoreDatabase, the server as Target, with Restore), or Attach Databases' server facts and,
/// with Attach, one primary data file's database (attachDatabase, the server as Target), or a login's facts (loginFacts, before Disable; unlockLogin, with its lock-out state). Login names the login whose user loginDatabaseRoles
/// reads too (Login Properties' User Mapping, D2c), and Securable the one securable loginEffective reads as the login (Login Properties'
/// Securables page, D2d); no other describe takes either.</summary>
internal sealed record ActionDescribeArgs(string ConnectionId, string RequestId, string Dialog, ObjectRefDto Target, ServerFilesArgsDto? Files = null, RestoreSourceDto? Restore = null,
    AttachDescribeArgsDto? Attach = null, string? Login = null, SecurableRefDto? Securable = null, int? Schedule = null);
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
    string? RecoveryModel = null, string? FirstForkGuid = null, string? ForkGuid = null, string? Problem = null, string? ForkPointLsn = null, string? FamilyGuid = null, string? BackupSetGuid = null);
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
/// <summary>One set of a restore plan. Guid is the BackupSetGUID the plan was reviewed against (null: the header had none); the run
/// refuses a set at that position whose GUID differs, so a backup file overwritten after review never restores in its place.</summary>
internal sealed record RestorePlanSetDto(string Id, List<string> Devices, int File, string Type, string? Name = null, string? Guid = null);
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
    bool? DropMappedUsers = null, string? Mode = null, LoginChangesDto? LoginChanges = null, List<PermissionDto>? Permissions = null, TableChangesDto? TableChanges = null,
    AgentIdentityDto? AgentIdentity = null, string? StepName = null, bool? DeleteUnusedSchedule = null,
    AgentPropertiesChangesDto? AgentProperties = null, AgentHistoryPurgeDto? AgentPurge = null, AgentHistoryDeleteDto? AgentHistory = null, AgentJobSaveDto? AgentJob = null,
    AgentAlertSaveDto? AgentAlert = null, AgentOperatorSaveDto? AgentOperator = null, AgentRecommendedDto? AgentRecommended = null, int? AgentObjectId = null, string? ReassignTo = null,
    AgentScheduleSaveDto? AgentSchedule = null, AgentProxySaveDto? AgentProxy = null, CredentialSaveDto? Credential = null, int? ProxyId = null,
    string? JobOwner = null);
/// <summary>The alert document's Save (AG-7, src/shared/actions/agent-alert.ts AgentAlertSave): an existing alert's changed arguments, New Alert's every one
/// it sets. NewOperators are created first and Notifications applied last, each one msdb call.</summary>
internal sealed record AgentAlertSaveDto(string? Name = null, bool? Enabled = null, int? MessageId = null, int? Severity = null, string? Database = null, string? Keyword = null,
    string? Condition = null, string? JobId = null, int? Delay = null, int? IncludeIn = null, string? Message = null, bool? ResetCount = null, List<AgentNewOperatorDto>? NewOperators = null,
    List<AgentNotificationChangeDto>? Notifications = null);
internal sealed record AgentNewOperatorDto(string Name, string? Email = null, string? Pager = null);
/// <summary>One notification change: Name is the other side's (the operator in an alert's save, the alert in an operator's); Change add, update or delete.</summary>
internal sealed record AgentNotificationChangeDto(string Name, int Methods, string Change);
/// <summary>The operator document's Save (AG-7, agent-operator.ts AgentOperatorSave); pager duty goes as its days and six times together.</summary>
internal sealed record AgentOperatorSaveDto(string? Name = null, bool? Enabled = null, string? Email = null, string? Pager = null, string? NetSend = null, int? PagerDays = null,
    int? WeekdayStart = null, int? WeekdayEnd = null, int? SaturdayStart = null, int? SaturdayEnd = null, int? SundayStart = null, int? SundayEnd = null,
    List<AgentNotificationChangeDto>? Notifications = null);
/// <summary>Add recommended alerts (AG-7): the alerts to create, and one operator (with its methods) and one delay for all.</summary>
internal sealed record AgentRecommendedDto(List<AgentRecommendedAlertDto>? Alerts = null, int Methods = 0, int Delay = 0, string? Operator = null);
internal sealed record AgentRecommendedAlertDto(string Name, int MessageId, int Severity);
/// <summary>agent.counterValues (AG-7): one performance counter's current values per instance.</summary>
internal sealed record AgentCounterValuesArgs(string ConnectionId, string RequestId, string Object, string Counter);
internal sealed record AgentCounterValueDto(string Instance, double Value);
internal sealed record AgentCounterValuesResult(List<AgentCounterValueDto>? Values, long ElapsedMs, ActionError? Error = null, bool? Truncated = null, string? ReadAt = null);
/// <summary>The proxy document's Save (AG-8b, src/shared/actions/agent-proxy.ts AgentProxySave): an existing proxy's changes (the request's
/// ProxyId names it), or New Proxy's name and credential (an existing one, or NewCredential, created first in the same transaction, whose secret
/// is the request's Secrets.Secret). Subsystems are syssubsystems ids; principals are granted by kind and revoked by name.</summary>
internal sealed record AgentProxySaveDto(string? Name = null, bool? Enabled = null, string? Description = null, string? Credential = null, NewCredentialDto? NewCredential = null,
    List<int>? GrantSubsystems = null, List<int>? RevokeSubsystems = null, List<ProxyPrincipalDto>? GrantPrincipals = null, List<string>? RevokePrincipals = null);
internal sealed record NewCredentialDto(string Name, string Identity);
/// <summary>A principal that may use a proxy: Kind is login, serverRole or msdbRole.</summary>
internal sealed record ProxyPrincipalDto(string Name, string Kind);
/// <summary>The credential document's Save (AG-8b): New Credential's Name, Identity and Provider, or an existing credential's Id and Modified
/// (yyyy-MM-ddTHH:mm:ss.fff, the STALE guard) with its Identity. The secret is the request's Secrets.Secret, always sent with the identity.</summary>
internal sealed record CredentialSaveDto(string Identity, int? Id = null, string? Modified = null, string? Name = null, string? Provider = null);
/// <summary>The job document's Save (AG-6a, src/shared/actions/agent-job.ts AgentJobSave). An existing job's carries the Version and Modified
/// (yyyy-MM-ddTHH:mm:ss.fff) its describe read, which the STALE guard compares, and only what changed; New Job's (target the Agent node) every
/// field it sets and no version. A notification goes as its level (0 to 3) and operator together, the operator '' exactly with level 0.
/// RemoveAlerts (at most agentLimits.jobAlerts) detaches alerts from the job, each guarded by its id still running this job.</summary>
internal sealed record AgentJobSaveDto(int? Version = null, string? Modified = null, string? Name = null, bool? Enabled = null, string? Description = null, string? Category = null,
    string? Owner = null, int? EmailLevel = null, string? EmailOperator = null, int? PageLevel = null, string? PageOperator = null, int? NetSendLevel = null, string? NetSendOperator = null,
    int? EventLogLevel = null, int? DeleteLevel = null, List<AgentAlertRefDto>? RemoveAlerts = null, AgentStepsSaveDto? Steps = null, AgentJobSchedulesSaveDto? Schedules = null);
internal sealed record AgentAlertRefDto(int Id, string Name);
/// <summary>The steps' save (AG-6b, src/shared/agent/steps.ts AgentStepsSave), in the order the batch calls it: Deletes (described ids, highest
/// first), Temporary (every surviving step's temporary name at its id after the deletes), Adds (new steps at their final ids, ascending, under
/// temporary names), Writes (each step's whole content into its final id; New Job's are its sp_add_jobstep calls, ids 1..n), StartStepId.</summary>
internal sealed record AgentStepsSaveDto(List<int>? Deletes = null, List<AgentStepNameDto>? Temporary = null, List<AgentStepNameDto>? Adds = null, List<AgentStepWriteDto>? Writes = null,
    int? StartStepId = null);
internal sealed record AgentStepNameDto(int Id, string Name);
/// <summary>language.parse (AG-6b, src/shared/agent/parse.ts): the job step editor's Parse of one T-SQL text.</summary>
internal sealed record LanguageParseArgs(string Text);

/// <summary>
/// language.lookup (docs/object-search.md, Editor lookup): the editor's completion and hover read the Search Objects index by
/// path, whatever the engine. A path names a container level by level: none for the connection's top level, then one segment per
/// level below it. For BigQuery the levels are project, dataset and object: [] lists projects, [project] datasets,
/// [project, dataset] objects, [project, dataset, object] the object's facts and its columns with nested fields by path. Prefix
/// keeps the names that start with it (case ignored); Exact keeps the one name it resolves to; Details adds columns' descriptions.
/// </summary>
internal sealed record LanguageLookupArgs(string ConnectionId, List<LanguageLookupPath> Requests);
internal sealed record LanguageLookupPath(List<string> Path, string? Prefix = null, bool? Exact = null, int? Limit = null, bool? Details = null);
/// <summary>Index is none (never built), building or ready; one answer per request, in order.</summary>
internal sealed record LanguageLookupResult(string Index, List<LanguageLookupAnswer> Answers);
/// <summary>State is ready, partial, building, skipped or absent. Path is the request's as the index names it (case resolved) as far
/// as it resolved. Object is the object a path to one names, when the index holds it. Truncated: more names matched than came back.</summary>
internal sealed record LanguageLookupAnswer(string State, List<string> Path, List<LanguageLookupItem> Items, bool Truncated, LanguageLookupObject? Object = null, string? Skip = null);
/// <summary>A name below the path: its kind and subtype as Object Explorer names them, a column's type and nullability, a routine's
/// signature (Detail), a sharded group, and with Details a column's description.</summary>
internal sealed record LanguageLookupItem(string Name, string Kind, string? Subtype = null, string? Type = null, bool? Nullable = null, string? Detail = null,
    string? Description = null, BigQueryShardsDto? Shards = null);
/// <summary>An object's facts: Detailed is false until the index has read its details (columns, size, layout).</summary>
internal sealed record LanguageLookupObject(string Name, string Kind, string? Subtype, bool Detailed, long? Rows = null, long? Bytes = null, string? Partitioning = null,
    string? Clustering = null, string? Signature = null, BigQueryShardsDto? Shards = null, bool? ColumnsCut = null, DateTime? Modified = null);
internal sealed record LanguageParseError(int Line, int Column, int Number, string Message);
internal sealed record LanguageParseResult(IReadOnlyList<LanguageParseError> Errors, bool Truncated);
/// <summary>One step's whole content (src/shared/agent/steps.ts AgentStepWrite): strings '' for none, ProxyId 0 for the service account.</summary>
internal sealed record AgentStepWriteDto(int Id, string Name, string Subsystem, string Command, string DatabaseName, string DatabaseUserName, int OnSuccessAction, int OnSuccessStepId,
    int OnFailAction, int OnFailStepId, int RetryAttempts, int RetryInterval, string OutputFileName, int Flags, int CmdexecSuccessCode, int ProxyId, string Server, int OsRunPriority);
/// <summary>A schedule's timing as sysschedules stores it (src/shared/agent/schedule.ts AgentScheduleTiming); ActionService.ScheduleTimingValid
/// refuses what sp_verify_schedule would.</summary>
internal sealed record AgentScheduleTimingDto(int FreqType, int FreqInterval, int FreqSubdayType, int FreqSubdayInterval, int FreqRelativeInterval, int FreqRecurrenceFactor,
    int ActiveStartDate, int ActiveEndDate, int ActiveStartTime, int ActiveEndTime);
/// <summary>A schedule a save names with the version_number and date_modified (yyyy-MM-ddTHH:mm:ss.fff) its describe read: the guard checks both.</summary>
internal sealed record AgentScheduleGuardDto(int Id, int Version, string Modified);
/// <summary>A schedule's change in a job's save (Id, Version, Modified: its guard) or a new one (no guard): only what changed, the whole
/// timing whenever any of it changes.</summary>
internal sealed record AgentScheduleChangeDto(int? Id = null, int? Version = null, string? Modified = null, string? Name = null, bool? Enabled = null, AgentScheduleTimingDto? Timing = null);
internal sealed record AgentScheduleDetachDto(int Id, bool DeleteUnused);
/// <summary>The job document's Schedules section in a job's save (AG-6c, src/shared/actions/agent-schedule.ts AgentJobSchedulesSave): detach,
/// update, attach, add, each at most agentLimits.schedulesPerJob.</summary>
internal sealed record AgentJobSchedulesSaveDto(List<AgentScheduleDetachDto>? Detach = null, List<AgentScheduleChangeDto>? Update = null, List<AgentScheduleGuardDto>? Attach = null,
    List<AgentScheduleChangeDto>? Add = null);
/// <summary>The Schedules document's save (AG-6c, agent-schedule.ts AgentScheduleSave): Op create, update, enable, disable or delete; Schedule its guard
/// (not for create); Jobs (at most agentLimits.scheduleJobChanges) each attached or detached under its job's version_number.</summary>
internal sealed record AgentScheduleSaveDto(string Op, AgentScheduleGuardDto? Schedule = null, string? Name = null, bool? Enabled = null, AgentScheduleTimingDto? Timing = null,
    List<AgentScheduleJobChangeDto>? Jobs = null);
internal sealed record AgentScheduleJobChangeDto(string JobId, int Version, bool Attach);
/// <summary>SQL Server Agent Properties' changes (AG-8a, src/shared/actions/agent-properties.ts): only the settings that differ, each an
/// sp_set_sqlagent_properties argument; HistoryMaxRows -1 is no limit (and takes no rows per job), else 2 to agentLimits.historyMaxRows.</summary>
internal sealed record AgentPropertiesChangesDto(bool? SqlserverRestart = null, bool? MonitorAutostart = null, int? HistoryMaxRows = null, int? HistoryMaxRowsPerJob = null);
/// <summary>SQL Server Agent Properties' "Delete old history now": every job's history older than Count (1 to agentLimits.purgeCount) days,
/// weeks or months (Unit 1, 2 or 3) before the server's clock, which the batch computes.</summary>
/// <summary>Before: the cut-off the confirmation showed (server time, yyyy-MM-ddTHH:mm:ss), which the purge never deletes past.</summary>
internal sealed record AgentHistoryPurgeDto(int Count, int Unit, string? Before = null);
/// <summary>The Log File Viewer's Delete History (AG-5a, src/shared/agent/history.ts agentHistoryDeleteSchema): the checked jobs by id (1 to
/// agentLimits.historyJobs, each once), and either All (true) or OlderThan, a cut-off as Agent Properties' purge takes it.</summary>
internal sealed record AgentHistoryDeleteDto(List<string>? Jobs, bool? All = null, AgentHistoryPurgeDto? OlderThan = null);
/// <summary>agent.historyMessage (AG-5a): one job history row's whole message, by its job and instance_id.</summary>
internal sealed record AgentHistoryMessageArgs(string ConnectionId, string RequestId, string JobId, int InstanceId);
/// <summary>The row's message (null when the row has none), or why it could not be read.</summary>
internal sealed record AgentHistoryMessageResult(string? Message, long ElapsedMs, ActionError? Error = null);
/// <summary>agent.errorLogs (AG-5b): the Log File Viewer's SQL Server Agent error logs.</summary>
internal sealed record AgentErrorLogsArgs(string ConnectionId, string RequestId);
/// <summary>One error log: its archive number (0 is Current), its date (server time, yyyy-MM-ddTHH:mm:ss) and size, where listed.</summary>
internal sealed record AgentErrorLogDto(int Archive, string? Date = null, long? Bytes = null);
/// <summary>The logs in archive order; Archives is false where the server lists none (Current alone).</summary>
internal sealed record AgentErrorLogsResult(List<AgentErrorLogDto> Logs, bool Archives, long ElapsedMs, ActionError? Error = null);
/// <summary>A SQL Server Agent job's verbs (AG-2: startJob, stopJob, a job's disable, enable, rename and delete) name the job they act on by
/// its sysjobs job_id, as the tree lists it; the batch refuses a job that has taken the name since.
/// startJob may name a StepName (sysname); a job's delete may set DeleteUnusedSchedule. startAgent, stopAgent and restartAgent take only the
/// Agent node as their target, on actions.execute only.</summary>
internal sealed record AgentIdentityDto(string JobId);
/// <summary>Table Properties' changes (src/shared/actions/tables.ts TableChanges): LockEscalation TABLE, AUTO or DISABLE; ChangeTracking
/// on or off with Track columns updated (only with it on); extended properties to add, update (each with a text Value of at most the
/// catalogue's extendedPropertyValue UTF-16 units) or drop (no Value), each name once. The tableProperties action takes them with Identity
/// (the table's object_id and create_date).</summary>
internal sealed record TableChangesDto(string? LockEscalation = null, TableTrackingDto? ChangeTracking = null, List<ExtendedPropertyChangeDto>? ExtendedProperties = null);
internal sealed record TableTrackingDto(bool Enabled, bool? TrackColumnsUpdated = null);
internal sealed record ExtendedPropertyChangeDto(string Op, string Name, string? Value = null);
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
internal sealed record LoginSecretsDto(string? Password = null, string? OldPassword = null, string? Secret = null)
{
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append("Password = ").Append(Password is null ? "null" : "<redacted>").Append(", OldPassword = ").Append(OldPassword is null ? "null" : "<redacted>")
            .Append(", Secret = ").Append(Secret is null ? "null" : "<redacted>");
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
/// <summary>Column: the table designer's column (index in the design) a refusal is about, such as a name used twice. Field: the job
/// document's field a refused save is about (src/shared/actions/agent-job.ts agentJobFields).</summary>
internal sealed record ActionError(string Code, string Message, bool Retryable, int? Column = null, string? Field = null);
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
/// offline database); Identity is the database it read (database_id and create_date), which the Delete request names. For a login
/// (D4c): Login, its facts with what it owns, and Mappings, the database users mapped to it.</summary>
internal sealed record DeleteTargetDto(string Name, string Type, string? Owner, List<ActionWarningDto> Warnings, bool DependentsTruncated, bool? IsSnapshot = null, int? Sessions = null,
    int? WithTransaction = null, List<BlockerDto>? Blockers = null, bool? BlockersTruncated = null, string? CloseConnectionsNote = null, List<string>? TransactionTabs = null,
    LoginFactsDto? Login = null, LoginMappingsDto? Mappings = null, DatabaseIdentityDto? Identity = null, AgentIdentityDto? AgentIdentity = null,
    int? AgentObjectId = null, List<string>? ReassignChoices = null, AgentNotifiedByDto? NotifiedBy = null, int? ProxyId = null);
internal sealed record AgentNotifiedByDto(int Alerts, int Jobs);
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
    LoginPropertiesDto? LoginProperties = null, EffectivePermissionsDto? EffectivePermissions = null, WindowsPrincipalDto? WindowsPrincipal = null,
    TablePropertiesDto? TableProperties = null, AgentJobFactsDto? AgentJob = null, AgentServiceFactsDto? AgentService = null, AgentPropertiesDto? AgentProperties = null,
    AgentJobDocumentDto? AgentJobDocument = null, AgentAlertDocumentDto? AgentAlertDocument = null, AgentOperatorDocumentDto? AgentOperatorDocument = null,
    AgentOperatorsDto? AgentOperators = null, AgentSchedulesDto? AgentSchedules = null, AgentProxyDocumentDto? AgentProxyDocument = null, CredentialDocumentDto? CredentialDocument = null);
/// <summary>The alert document's describe (AG-7, agent-alert.ts AgentAlertDocumentModel). Dates are yyyy-MM-ddTHH:mm:ss, server time.</summary>
internal sealed record AgentAlertDocumentDto(AgentAlertRecordDto? Alert, string Login, bool Sysadmin, string Platform, List<AgentAlertNotifyDto> Notifications, List<string> Databases,
    AgentJobMailDto Mail, string? ReadOnly = null, List<AgentJobOperatorDto>? Operators = null, List<AgentAlertJobDto>? Jobs = null, List<AgentCounterDto>? Counters = null,
    bool? CountersTruncated = null, string? MessageText = null, bool? OperatorsTruncated = null);
internal sealed record AgentAlertRecordDto(int Id, string Name, bool Enabled, string Kind, int MessageId, int Severity, string Database, string Keyword, string Condition, string WmiNamespace,
    string WmiQuery, string JobId, string JobName, int Delay, int IncludeIn, string Message, int Occurrences, string? LastOccurred = null, string? LastResponse = null, string? CountReset = null);
internal sealed record AgentAlertNotifyDto(string Operator, int Methods);
internal sealed record AgentAlertJobDto(string Id, string Name);
internal sealed record AgentCounterDto(string Object, string Counter);
/// <summary>The operator document's describe (AG-7, agent-operator.ts AgentOperatorDocumentModel).</summary>
internal sealed record AgentOperatorDocumentDto(AgentOperatorRecordDto? Operator, string Login, bool Sysadmin, string Platform, List<AgentNotificationRowDto> Notifications, AgentJobMailDto Mail,
    string? ReadOnly = null, List<AgentAlertRowDto>? Alerts = null, bool? AlertsTruncated = null, List<AgentJobNotifyRowDto>? Jobs = null);
internal sealed record AgentOperatorRecordDto(int Id, string Name, bool Enabled, string Email, string Pager, string NetSend, int PagerDays, AgentDutyHoursDto Weekday, AgentDutyHoursDto Saturday,
    AgentDutyHoursDto Sunday, string? LastEmail = null, string? LastPager = null, string? LastNetSend = null);
internal sealed record AgentAlertRowDto(int Id, string Name, bool Enabled, string Kind, int MessageId, int Severity);
internal sealed record AgentNotificationRowDto(int AlertId, int OperatorId, int Methods);
internal sealed record AgentJobNotifyRowDto(string Id, string Name, string Email, string Page, string NetSend);
/// <summary>The Operators and notifications grid's describe (AG-7, agent-operator.ts AgentOperatorsModel).</summary>
internal sealed record AgentOperatorsDto(string Login, bool Sysadmin, string Platform, List<AgentOperatorRecordDto> Operators, List<AgentNotificationRowDto> Notifications, AgentJobMailDto Mail,
    string? ReadOnly = null, bool? OperatorsTruncated = null, List<AgentAlertRowDto>? Alerts = null, bool? AlertsTruncated = null, List<AgentJobNotifyRowDto>? Jobs = null);
/// <summary>The proxy document's describe (AG-8b, src/shared/actions/agent-proxy.ts AgentProxyDocumentModel).</summary>
internal sealed record AgentProxyDocumentDto(AgentProxyRecordDto? Proxy, string Platform, List<ProxySubsystemDto> Subsystems, List<ProxyCredentialDto> Credentials, bool CredentialsTruncated,
    bool CanCreateCredential, List<ProxyPrincipalDto> PrincipalChoices, List<ProxyReferenceDto>? References = null, bool? ReferencesTruncated = null,
    bool? PrincipalsTruncated = null);
internal sealed record AgentProxyRecordDto(int Id, string Name, bool Enabled, string Description, string Credential, List<int> Subsystems, List<ProxyPrincipalDto> Principals, string? CredentialIdentity = null);
internal sealed record ProxySubsystemDto(int Id, string Name);
internal sealed record ProxyCredentialDto(string Name, string Identity);
internal sealed record ProxyReferenceDto(string Job, int StepId, string Step, string Subsystem);
/// <summary>The credential document's describe (AG-8b, CredentialDocumentModel). The secret is never read.</summary>
internal sealed record CredentialDocumentDto(CredentialRecordDto? Credential, string Platform, List<string> Providers, string? ReadOnly = null, List<CredentialUseDto>? UsedBy = null, bool? UsedByTruncated = null);
internal sealed record CredentialRecordDto(int Id, string Name, string Identity, string Created, string Modified, string? Provider = null);
internal sealed record CredentialUseDto(string Proxy, List<string> Subsystems, List<CredentialStepDto> Steps);
internal sealed record CredentialStepDto(string Job, int StepId, string Step);
/// <summary>The job document's describe (AG-6a, src/shared/actions/agent-job.ts AgentJobDocumentModel). Job is null for New Job; Operators null
/// when the login may not read them; Owners for sysadmin only; Alerts null where the section is hidden (below SQLAgentOperatorRole, or a
/// platform without alerts).</summary>
internal sealed record AgentJobDocumentDto(AgentJobRecordDto? Job, string Login, bool Sysadmin, string Platform, List<string> Categories, List<AgentJobStepRowDto> Steps, bool AlertsEditable,
    AgentJobMailDto Mail, string? ReadOnly = null, List<AgentJobOperatorDto>? Operators = null, List<string>? Owners = null, List<AgentJobAlertDto>? Alerts = null,
    List<string>? Jobs = null, List<string>? JobIds = null, List<string>? Subsystems = null, List<AgentJobProxyDto>? Proxies = null, List<string>? Databases = null,
    bool? StepsTruncated = null, List<AgentScheduleRecordDto>? Schedules = null, string? Now = null);
/// <summary>A proxy the step editor's Run as offers (AG-6b): the step types sp_help_proxy @subsystem_name lists it for.</summary>
internal sealed record AgentJobProxyDto(int Id, string Name, bool Enabled, List<string> Subsystems, string? Identity = null);
/// <summary>A schedule as sp_help_schedule or sp_help_jobschedule list it (agent-schedule.ts AgentScheduleRecord), with its owner, version and
/// modified date from sysschedules_localserver_view where that lists it.</summary>
internal sealed record AgentScheduleRecordDto(int Id, string Name, bool Enabled, int FreqType, int FreqInterval, int FreqSubdayType, int FreqSubdayInterval, int FreqRelativeInterval,
    int FreqRecurrenceFactor, int ActiveStartDate, int ActiveEndDate, int ActiveStartTime, int ActiveEndTime, int JobCount, string? Owner = null, int? Version = null, string? Modified = null);
/// <summary>The Schedules describe (AG-6c, agent-schedule.ts AgentSchedulesModel).</summary>
internal sealed record AgentSchedulesDto(string Login, bool Sysadmin, string Platform, string Now, List<AgentScheduleRecordDto> Schedules, bool? IdleDefined = null, bool? Truncated = null,
    List<AgentScheduleJobDto>? Jobs = null, List<AgentScheduleLinkDto>? Links = null, List<AgentJobDurationDto>? Durations = null, List<AgentScheduleJobDto>? ScheduleJobs = null);
internal sealed record AgentScheduleJobDto(string Id, string Name, bool Enabled, string Owner, int Version);
/// <summary>Which job uses which schedule, with sysjobschedules' next run (yyyymmdd, hhmmss) once Agent has written one, and the job's own
/// next run from sysjobactivity (AG-14).</summary>
internal sealed record AgentScheduleLinkDto(int ScheduleId, string JobId, int? NextRunDate = null, int? NextRunTime = null, int? JobNextRunDate = null, int? JobNextRunTime = null);
internal sealed record AgentJobDurationDto(string JobId, int Seconds);
internal sealed record AgentJobRecordDto(string JobId, string Name, bool Enabled, string Description, string Category, string Owner, int EmailLevel, string EmailOperator, int PageLevel,
    string PageOperator, int NetSendLevel, string NetSendOperator, int EventLogLevel, int DeleteLevel, string Created, string Modified, int Version, int StartStepId,
    string? LastRun = null, int? LastOutcome = null);
/// <summary>A step as sp_help_jobstep reads it: AG-6a's id, name and type, and AG-6b's whole content.</summary>
internal sealed record AgentJobStepRowDto(int Id, string Name, string Subsystem, string? Command = null, int? Flags = null, int? CmdexecSuccessCode = null, int? OnSuccessAction = null,
    int? OnSuccessStepId = null, int? OnFailAction = null, int? OnFailStepId = null, string? Server = null, string? DatabaseName = null, string? DatabaseUserName = null,
    int? RetryAttempts = null, int? RetryInterval = null, int? OsRunPriority = null, string? OutputFileName = null, int? ProxyId = null, bool? CommandTruncated = null);
internal sealed record AgentDutyHoursDto(int Start, int End);
internal sealed record AgentJobOperatorDto(string Name, bool Enabled, bool Email, bool Pager, bool NetSend, int PagerDays, AgentDutyHoursDto Weekday, AgentDutyHoursDto Saturday, AgentDutyHoursDto Sunday);
internal sealed record AgentJobAlertDto(int Id, string Name, bool Enabled, int Severity, int MessageId);
internal sealed record AgentJobMailDto(bool Checked, bool Sysadmin, bool? Xps = null, int? Profiles = null, bool? UseDatabaseMail = null, string? AgentProfile = null);
/// <summary>SQL Server Agent Properties' describe (AG-8a, src/shared/actions/agent-properties.ts AgentPropertiesModel).</summary>
internal sealed record AgentPropertiesDto(AgentSettingsDto Settings, string ServerNow, int ServerOffsetMinutes, string? ReadOnly = null, AgentHistoryFactsDto? History = null, string? HistoryNote = null,
    string? SettingsNote = null);
internal sealed record AgentSettingsDto(bool SqlserverRestart, bool MonitorAutostart, int HistoryMaxRows, int HistoryMaxRowsPerJob, bool? AutoStart = null, string? StartupAccount = null,
    string? ErrorLogFile = null, int? ErrorLoggingLevel = null);
internal sealed record AgentHistoryFactsDto(long Total, long Recent, List<AgentRetentionJobDto> Jobs, bool JobsTruncated, List<AgentHistoryAgeDto> Ages);
internal sealed record AgentRetentionJobDto(string Name, long Rows, long Recent);
internal sealed record AgentHistoryAgeDto(int Days, long Rows);
/// <summary>Start Job at Step's facts (AG-2): the job it read, whether it is enabled and running, and its steps (at most agentLimits.stepsPerJob).</summary>
internal sealed record AgentJobFactsDto(string Name, AgentIdentityDto AgentIdentity, bool Enabled, bool Running, List<AgentJobStepDto> Steps, bool StepsTruncated);
internal sealed record AgentJobStepDto(int Id, string Name);
/// <summary>The Agent service dialogs' facts (AG-2): the machine and service they act on, and the state the Service Control Manager reports
/// (src/shared/actions/schema.ts agentServiceStates).</summary>
internal sealed record AgentServiceFactsDto(string Machine, string Service, string State);
/// <summary>Table Properties' describe (src/shared/actions/tables.ts TablePropertiesModel): every page's facts, the lists clipped to the
/// catalogue's limits (the flags say so), and why nothing can change, when nothing can.</summary>
internal sealed record TablePropertiesDto(TableGeneralDto General, TableStorageDto Storage, TableChangeTrackingDto ChangeTracking, List<TablePermissionDto> Permissions, bool PermissionsTruncated,
    List<TableExtendedPropertyDto> ExtendedProperties, bool ExtendedPropertiesTruncated, int Level, TableTemporalDto? Temporal = null, TableLedgerDto? Ledger = null,
    List<TableSecurityPredicateDto>? SecurityPredicates = null, bool? SecurityPredicatesTruncated = null, string? ReadOnlyReason = null);
internal sealed record TableGeneralDto(string Name, string Schema, string Created, bool SystemObject, bool Replicated, string LockEscalation, bool MemoryOptimized, bool FileTable, bool External,
    int Id, string? Modified = null, bool? AnsiNulls = null, string? Durability = null, string? Graph = null);
internal sealed record TableStorageDto(bool Partitioned, List<TablePartitionDto> Partitions, bool PartitionsTruncated, long? RowCount = null, long? DataSpaceKb = null, long? IndexSpaceKb = null,
    string? Compression = null, string? Filegroup = null, string? TextFilegroup = null, string? FilestreamFilegroup = null, string? PartitionScheme = null, string? PartitionColumn = null);
internal sealed record TablePartitionDto(int Number, long Rows, string Compression, string? Filegroup = null);
internal sealed record TableTemporalDto(string Type, string? Other = null, string? PeriodStart = null, string? PeriodEnd = null, string? Retention = null);
internal sealed record TableLedgerDto(string Type, bool Dropped, string? View = null, string? History = null);
internal sealed record TableChangeTrackingDto(bool DatabaseEnabled, bool Enabled, bool TrackColumnsUpdated, bool PrimaryKey);
internal sealed record TablePermissionDto(string Principal, string PrincipalType, string Permission, string State, string Grantor, string? Column = null);
internal sealed record TableSecurityPredicateDto(string Policy, string Type, string Predicate, bool Enabled, string? Operation = null, bool? PredicateTruncated = null);
internal sealed record TableExtendedPropertyDto(string Name, string Value, string? Type = null, bool? Truncated = null);
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
    bool? CanCreate = null);
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
    List<DatabaseFileRefDto>? FilesKept = null, DatabaseIdentityDto? Identity = null, int? Sessions = null,
    List<ConnectionBindingChange>? BindingChanges = null, bool? BindingChangesComplete = null, string? AgentService = null);
/// <summary>A confirmed action-induced change to one live handle's backend settings. Monotonic safe-integer revision;
/// initial connect is revision 0. At most 256 distinct handles per result. PasswordChanged carries no secret: main uses
/// only the matching validated action's transient password. NewDatabase is the resulting catalog, at most 128 characters.</summary>
internal sealed record ConnectionBindingChange(string ConnectionId, long BindingRevision, string? NewDatabase = null, bool? PasswordChanged = null);

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
/// <summary>ssis.execution (src/shared/ssis/schema.ts SsisExecutionRequest): one execution's run page; Types null keeps every type, Source null every task.</summary>
internal sealed record SsisExecutionArgs(string ConnectionId, string RequestId, long ExecutionId, List<int>? Types = null, string? Source = null);
/// <summary>SsisExecutionOverview in src/shared/ssis/schema.ts.</summary>
internal sealed record SsisExecutionOverviewDto(long Id, string Folder, string Project, string Package, string? EnvironmentFolder, string? Environment, string ExecutedAs, string Caller,
    bool Use32bit, int Status, string? Created, string? Started, string? Ended, string? StoppedBy, string? Server, string? Machine, string Now);
/// <summary>SsisExecutionMessage in src/shared/ssis/schema.ts.</summary>
internal sealed record SsisExecutionMessageDto(long? Id, string Time, int Type, int? SourceType, string? Source, string? Package, string? Event, string? Path, int? Code, string Message);
internal sealed record SsisMessageCountDto(int Type, long Count);
/// <summary>SsisExecutionTask in src/shared/ssis/schema.ts.</summary>
internal sealed record SsisExecutionTaskDto(string Path, string Name, string? Started, string? Ended, long? DurationMs, long Runs, bool Failed, long? UsualMs);
/// <summary>SsisExecutionParameter in src/shared/ssis/schema.ts; Value is null for a sensitive parameter.</summary>
internal sealed record SsisExecutionParameterDto(int ObjectType, string Name, string DataType, string? Value, bool Sensitive, bool Required, bool ValueSet, bool RuntimeOverride);
/// <summary>SsisPackageRun in src/shared/ssis/schema.ts.</summary>
internal sealed record SsisPackageRunDto(long Id, int Status, string? Created, string? Started, string? Ended, string? Caller = null, long? Errors = null, long? Warnings = null);
internal sealed record SsisExecutionModel(SsisExecutionOverviewDto Overview, List<SsisMessageCountDto> Counts, List<int>? Types, string? Source, List<SsisExecutionMessageDto> Messages, bool Truncated,
    List<SsisExecutionTaskDto> Tasks, bool TasksTruncated, List<SsisExecutionParameterDto> Parameters, List<SsisPackageRunDto> Runs, long? Newer);
internal sealed record SsisExecutionResult(SsisExecutionModel? Model, long ElapsedMs, SsisError? Error = null);
/// <summary>ssis.packageRuns (src/shared/ssis/schema.ts SsisPackageRunsRequest): one package's newest runs.</summary>
internal sealed record SsisPackageRunsArgs(string ConnectionId, string RequestId, string Folder, string Project, string Package);
internal sealed record SsisPackageRunsModel(string Folder, string Project, string Package, List<SsisPackageRunDto> Runs, bool Truncated, string Now);
internal sealed record SsisPackageRunsResult(SsisPackageRunsModel? Model, long ElapsedMs, SsisError? Error = null);
/// <summary>agent.profile (src/shared/agent/profile.ts): one login's SQL Server Agent facts on one server.</summary>
internal sealed record AgentProfileArgs(string ConnectionId, string RequestId);
/// <summary>AgentProfile in src/shared/agent/profile.ts; AgentXps and DatabaseMailXps are absent when unreadable: msdb refused the login and the server-scope read failed too.</summary>
internal sealed record AgentProfileDto(string Platform, int EngineEdition, bool MsdbAccess, bool Sysadmin, bool UserRole, bool ReaderRole, bool OperatorRole, bool PurgeHistory,
    bool ServerServices, bool Sessions, bool AlterAnyCredential, bool Clustered, bool? AgentXps, bool? DatabaseMailXps, bool DatabaseMail);
internal sealed record AgentProfileResult(AgentProfileDto? Profile, long ElapsedMs, ExplorerError? Error = null);
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

/// <summary>A droppable op.progress EVENT on a results request (view, profile, distinct, pivot, diff): its phase, and a
/// percentage of the whole 0 – 99 that never goes back, absent while the phase has no total.</summary>
internal sealed record OperationProgressEvent(string Type, string Phase, int? Percent);
