using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Ssis;

namespace Varia.Backend.Live;

/// <summary>How one series of a probe is read from its query's single row: the column holding its raw value, and for a
/// ratio or cpuPercent series the column holding its base (the base counter, or the scheduler count).</summary>
internal sealed record LiveSeriesColumn(string Series, string Column, string? Base = null);

/// <summary>One result set of a probe's batch that fills a table: the table's index in the catalogue entry, whose columns it
/// returns by name and type in catalogue order. An append table's read takes @after{i} (the settled id), @top{i} (how many
/// rows) and @before{i} (where the table ends, or NULL), i its index, and orders by its keyset id. Tail, for an append
/// table that can start at its last rows, is a statement returning one row (after_id, earlier) for @tail{i} rows before
/// @before{i}: the id to read after, and how many matching rows that leaves out. View gives the predicate of a view id the
/// probe declares (rows filtered in memory), or null for all rows.</summary>
internal sealed record LiveTableRead(int Table, string? Tail = null, Func<string, LiveRow, bool>? View = null);

/// <summary>A status value of a probe read from its query's single row: the catalogue's status id and its column.</summary>
internal sealed record LiveStatusColumn(string Status, string Column);

/// <summary>One probe's constant text for one band: the statement after the prologue, the columns its one metrics row has (in
/// order; none when the probe has no series), the server clock columns (ms_ticks and the start time in ticks, null where the
/// probe cannot read them), where each catalogue series comes from, each status value its row holds (whole numbers), and the
/// result sets that follow it, one per table, in order. <c>Restricted</c>, where there is one, is the statement for a login
/// that is not an admin of what the probe reads (SSISDB: sysadmin or ssis_admin): it leaves out what only admins may read,
/// as zeros, rather than gate it with a parameter, which would run the command through sp_executesql and scope the
/// prologue's SET options to it. Filtered: the text takes @filter, a LIKE pattern of a restart-mode filter's text (NULL without one), so the
/// statement's own columns are the ones it filters.</summary>
internal sealed record LiveQuery(string Probe, int Band, string Body, string[] Columns, string? MsTicks, string? StartTicks, LiveSeriesColumn[] Series, LiveStatusColumn[]? Status = null,
    string? Restricted = null)
{
    public LiveTableRead[] Tables { get; init; } = [];
    public bool Filtered { get; init; }

    public string Text(string prologue, bool admin = true) => prologue + (admin || Restricted is null ? Body : Restricted);

    /// <summary>Every command the probe runs: its batch (and the restricted one), and each append table's tail statement.</summary>
    public IEnumerable<string> Texts(string prologue) =>
        [Text(prologue), .. Restricted is null ? [] : new[] { Text(prologue, admin: false) }, .. Tables.Where(table => table.Tail is not null).Select(table => prologue + table.Tail)];

    /// <summary>Why this query does not fit its catalogue entry: its tables, in order, by index and mode, a tail only for an
    /// append table, and only column types live tables store.</summary>
    public List<string> Problems(LiveProbeJson spec)
    {
        var problems = new List<string>();
        if (Columns.Length == 0 != (spec.Series.Count == 0 && Status is not { Length: > 0 })) problems.Add("has a metrics row without series or status values, or series or status values without one");
        if (Status?.FirstOrDefault(status => !spec.Status.Contains(status.Status) || !Columns.Contains(status.Column)) is { } stray) problems.Add("reads a status value its entry does not declare, or from no column: " + stray.Status);
        var indexes = Tables.Select(table => table.Table).ToList();
        if (!indexes.SequenceEqual(Enumerable.Range(0, spec.Tables.Count))) problems.Add("does not read every table once, in order");
        foreach (var table in Tables.Where(table => table.Table >= 0 && table.Table < spec.Tables.Count))
        {
            var catalogTable = spec.Tables[table.Table];
            if (table.Tail is not null && catalogTable.Mode != "append") problems.Add("has a tail for a snapshot table");
            if (catalogTable.Columns.FirstOrDefault(column => !LiveCells.Supports(column.DataType)) is { } column) problems.Add("stores a type live tables do not: " + column.DataType);
        }
        return problems;
    }

    private static readonly Type[] Numeric = [typeof(byte), typeof(short), typeof(int), typeof(long), typeof(decimal), typeof(float), typeof(double)];

    /// <summary>Whether a result's columns are the ones declared, by name and in order, each a number: values are read by
    /// their declared position, so a SELECT list edited without its declaration would put one series' value in another's.</summary>
    public bool Returns(IReadOnlyList<(string Name, Type Type)> columns) =>
        columns.Count == Columns.Length && columns.Select((column, index) => column.Name == Columns[index] && Numeric.Contains(column.Type)).All(match => match);
}

/// <summary>The SQL of every one-batch live probe that reads SQL Server (docs/live.md; the Activity Monitor's probes run several
/// statements each, from Activity/ActivitySql.cs, which this lint also checks): constant text per probe and band, values only
/// as parameters, no metadata built-ins (they ignore LOCK_TIMEOUT and the isolation level), no temporary tables, writes,
/// transactions, waits or dynamic SQL. Every command starts with its scope's prologue, since a pooled connection can carry
/// another command's SET state. Lint renders every variant; the checks run it offline. Every read checks the columns it got
/// against the declaration (LiveQuery.Returns), and the live checks run every query at the server's band to compare them.</summary>
internal static partial class LiveSql
{
    /// <summary>SQL Server 2016, the oldest supported version, and 2025.</summary>
    public const int MinBand = 13;
    public const int MaxBand = 17;
    public const int LockTimeoutMs = 1000;

    /// <summary>Server DMVs, and SSISDB without READ_COMMITTED_SNAPSHOT: dirty reads are accepted, a lock wait is cut at 1 s
    /// (a BLOCKED value; the probe retries), and a live read loses any deadlock.</summary>
    public const string UncommittedPrologue = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;\n";
    /// <summary>SSISDB with READ_COMMITTED_SNAPSHOT: versioned reads never wait on writers.</summary>
    public const string CommittedPrologue = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;\n";

    /// <summary>Once per opened connection: its session id, whether the login may read server state (the permission name
    /// is a parameter: VIEW SERVER PERFORMANCE STATE from SQL Server 2022, VIEW SERVER STATE before and on Managed Instance),
    /// and for an SSISDB source (@catalog; NULL for server DMVs, which reads no row and no role) whether the catalog's database
    /// has READ_COMMITTED_SNAPSHOT on, which picks the prologue of its later commands, and whether the login is sysadmin or in
    /// ssis_admin, the only ones who may read catalog.catalog_properties. A sysadmin's IS_MEMBER is never evaluated, so a
    /// pending change to the role's members cannot block it; anyone else's waits at most the 1 s lock timeout (BLOCKED).</summary>
    public const string Session = "SELECT @@SPID, CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, @permission), 0)),"
        + " (SELECT CONVERT(int, d.is_read_committed_snapshot_on) FROM sys.databases AS d WHERE d.name = @catalog),"
        + " CASE WHEN @catalog IS NULL THEN 0 WHEN IS_SRVROLEMEMBER(N'sysadmin') = 1 THEN 1 ELSE CONVERT(int, ISNULL(IS_MEMBER(N'ssis_admin'), 0)) END;";

    /// <summary>An SSISDB source's session probe, in the catalog's database: its session id and whether that database has
    /// READ_COMMITTED_SNAPSHOT on (@catalog), which picks the prologue of its later commands. Catalog views need no server
    /// permission: row-level security shows the login what it may read.</summary>
    public const string SsisSession = "SELECT @@SPID, (SELECT CONVERT(int, d.is_read_committed_snapshot_on) FROM sys.databases AS d WHERE d.name = @catalog);";

    /// <summary>An SSISDB source whose connection could not open the catalog's database: its state and user access, read on
    /// a connection in the login's own database, and whether the login sees every database's row (VIEW ANY DATABASE). No row
    /// says there is no catalog only when it does: without the permission a login sees no row of a database it cannot open.</summary>
    public const string CatalogState = "SELECT d.state, d.user_access, x.sees_all FROM (SELECT CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW ANY DATABASE'), 0)) AS sees_all) AS x\n"
        + "LEFT JOIN sys.databases AS d ON d.name = @catalog;";

    public const string OperationsProbe = "ssis.operations.list";

    /// <summary>An operation's folder and project as the Operations view shows and filters them: an execution's, a validation's,
    /// and a deployment's project (its object). Package is an execution's only.</summary>
    private const string OperationNames = "CROSS APPLY (SELECT COALESCE(e.folder_name, v.folder_name) AS folder_name,\n"
        + "    COALESCE(e.project_name, v.project_name, CASE WHEN o.operation_type = 101 THEN o.object_name END) AS project_name) AS n\n";
    private const string OperationsFrom = "FROM [catalog].[operations] AS o LEFT JOIN [catalog].[executions] AS e ON e.execution_id = o.operation_id\n"
        + "LEFT JOIN [catalog].[validations] AS v ON v.validation_id = o.operation_id\n" + OperationNames;
    private const string OperationColumns = "SELECT TOP (@take) o.operation_id, o.operation_type, o.status, o.created_time, o.start_time, o.end_time, o.object_name, n.folder_name, n.project_name, e.package_name,\n"
        + "    o.caller_name, o.stopped_by_name, o.server_name, o.machine_name, DATEDIFF_BIG(millisecond, o.start_time, ISNULL(o.end_time, SYSDATETIMEOFFSET())) AS duration_ms\n";

    /// <summary>The Operations view's scope, as SsisOperationsReader binds it (NULL: no filter). Kinds are the operation types
    /// they name (@types, an xml list) plus every type no kind names when Other is on (@other); names match by LIKE with their
    /// wildcards escaped, from the start when a prefix asks for it; the caller exactly. The status filter and the window are
    /// not part of it.</summary>
    private static readonly string OperationScope =
        "    AND (@types IS NULL OR o.operation_type IN (SELECT t.i.value('.', 'int') FROM @types.nodes('/i') AS t(i))\n"
        + "        OR (@other = 1 AND o.operation_type NOT IN (" + string.Join(", ", SsisCatalog.Current.OperationKinds.Values.SelectMany(types => types)) + ")))\n"
        + "    AND (@folder IS NULL OR n.folder_name LIKE @folder ESCAPE N'\\') AND (@project IS NULL OR n.project_name LIKE @project ESCAPE N'\\')\n"
        + "    AND (@package IS NULL OR e.package_name LIKE @package ESCAPE N'\\') AND (@caller IS NULL OR o.caller_name = @caller)\n";

    private static string OpenStatuses => string.Join(", ", SsisCatalog.Current.OpenStatuses.Order());
    private static string CountOf(OperationTile tile) => "COUNT_BIG(CASE WHEN o.status IN (" + string.Join(", ", tile.Statuses) + ") THEN 1 END) AS " + tile.Series;

    /// <summary>One Operations sample (SsisOperationsReader), in the catalog's database, its result sets in this order:
    /// <list type="number">
    /// <item>the newest @take operations above @after in the scope that are open, or were created in the last @window hours and
    /// pass the status filter (@statuses, an xml list; an open one that does not pass it is read too, since it can still end in a
    /// status that does, and the window follows it unseen);</item>
    /// <item>on a <paramref name="baseline"/> only, the newest @take open operations in the scope whatever their age, so finished
    /// ones never crowd a long run out of a new window;</item>
    /// <item>the open ones the window holds (@open, an xml list of ids) as they are now;</item>
    /// <item>the server's time;</item>
    /// <item>the open tiles' counts (Running, Pending) over every operation the login may see, whatever the scope;</item>
    /// <item>when <paramref name="counts"/>, each final tile's count over its hours, also whatever the scope.</item>
    /// </list>
    /// An execution and a validation share their id with their operation. Durations are the server's, to its own time while an
    /// operation runs. Times stay datetimeoffset.</summary>
    public static string Operations(bool counts, bool baseline)
    {
        var tiles = SsisCatalog.Current.OperationTiles;
        var text = OperationColumns + OperationsFrom
            + "WHERE o.operation_id > @after AND (o.status IN (" + OpenStatuses + ")\n"
            + "    OR o.created_time >= DATEADD(hour, -@window, SYSDATETIMEOFFSET()) AND (@statuses IS NULL OR o.status IN (SELECT s.i.value('.', 'int') FROM @statuses.nodes('/i') AS s(i))))\n"
            + OperationScope
            + "ORDER BY o.operation_id DESC;\n";
        if (baseline) text += OperationColumns + OperationsFrom + "WHERE o.status IN (" + OpenStatuses + ")\n" + OperationScope + "ORDER BY o.operation_id DESC;\n";
        var open = tiles.Where(tile => tile.LastHours is null).ToList();
        text += "SELECT o.operation_id, o.status, o.start_time, o.end_time, o.stopped_by_name, DATEDIFF_BIG(millisecond, o.start_time, ISNULL(o.end_time, SYSDATETIMEOFFSET())) AS duration_ms\n"
            + "FROM [catalog].[operations] AS o WHERE o.operation_id IN (SELECT r.i.value('.', 'bigint') FROM @open.nodes('/i') AS r(i));\n"
            + "SELECT SYSDATETIMEOFFSET() AS server_now;\n"
            + "SELECT " + string.Join(", ", open.Select(CountOf)) + " FROM [catalog].[operations] AS o WHERE o.status IN (" + string.Join(", ", open.SelectMany(tile => tile.Statuses).Order()) + ");";
        if (!counts) return text;
        // The catalogue gives every final tile the same hours, so one read counts them all.
        var final = tiles.Where(tile => tile.LastHours is not null).ToList();
        var hours = final.Select(tile => tile.LastHours!.Value).Distinct().Single();
        return text + "\nSELECT " + string.Join(", ", final.Select(CountOf)) + " FROM [catalog].[operations] AS o\n"
            + "WHERE o.created_time >= DATEADD(hour, -" + hours.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", SYSDATETIMEOFFSET());";
    }

    public const string DatabasesProbe = "explorer.databases";
    public const string ProgressProbe = "explorer.progress";
    public const string AgentProbe = "explorer.agent";
    public const string AvailabilityProbe = "explorer.availability";
    public const string CatalogProbe = "ssis.catalogProbe";

    // Object Explorer's status chips (docs/object-explorer.md, Live status). Only the databases a chip is for: anything not
    // online, not open to every user, read-only or standby. Names come as they are; the renderer matches them to its nodes.
    private const string Databases =
        "SELECT d.name, CONVERT(tinyint, d.state) AS state, CONVERT(tinyint, d.user_access) AS userAccess, d.is_read_only AS readOnly, d.is_in_standby AS standby\n"
        + "FROM sys.databases AS d\n"
        + "WHERE d.state <> 0 OR d.user_access <> 0 OR d.is_read_only = 1 OR d.is_in_standby = 1\n"
        + "ORDER BY d.name;";

    // A database recovering at startup (DB STARTUP) is its request's own database. A RESTORE runs in its session's database
    // (master, usually) until its last phase, so the database it restores is the one its request holds an exclusive database
    // lock on. The lock DMV costs a scan of the lock manager each time it is read (tens of milliseconds on an idle server), so
    // only the RESTORE branch reads it, once per RESTORE request (the APPLY's outer rows are those requests alone): a server
    // with nothing restoring never scans it, however many databases recover.
    private const string Progress =
        "SELECT d.name, r.command, CONVERT(int, r.percent_complete) AS [percent]\n"
        + "FROM sys.dm_exec_requests AS r\n"
        + "JOIN sys.databases AS d ON d.database_id = r.database_id\n"
        + "WHERE r.command = N'DB STARTUP'\n"
        + "UNION ALL\n"
        + "SELECT d.name, r.command, CONVERT(int, r.percent_complete)\n"
        + "FROM sys.dm_exec_requests AS r\n"
        + "CROSS APPLY (SELECT TOP (1) l.resource_database_id FROM sys.dm_tran_locks AS l\n"
        + "    WHERE l.request_session_id = r.session_id AND l.resource_type = N'DATABASE' AND l.request_mode = N'X'\n"
        + "    ORDER BY l.resource_database_id) AS t\n"
        + "JOIN sys.databases AS d ON d.database_id = t.resource_database_id\n"
        + "WHERE r.command IN (N'RESTORE DATABASE', N'RESTORE LOG')\n"
        + "ORDER BY name;";

    // Job Activity Monitor's count: the Agent's current session (a new one starts with every Agent start), so rows a crashed
    // Agent left without a stop date in an older session are not counted.
    private const string Agent =
        "SELECT COUNT(*) AS running_jobs FROM msdb.dbo.sysjobactivity AS a\n"
        + "WHERE a.session_id = (SELECT MAX(s.session_id) FROM msdb.dbo.syssessions AS s) AND a.start_execution_date IS NOT NULL AND a.stop_execution_date IS NULL;";

    private const string Availability =
        "SELECT g.name, CONVERT(tinyint, s.synchronization_health) AS health, CONVERT(tinyint, ISNULL(r.role, 0)) AS role\n"
        + "FROM sys.availability_groups AS g\n"
        + "JOIN sys.dm_hadr_availability_group_states AS s ON s.group_id = g.group_id\n"
        + "LEFT JOIN sys.dm_hadr_availability_replica_states AS r ON r.group_id = g.group_id AND r.is_local = 1\n"
        + "ORDER BY g.name;";

    /// <summary>What ssis.catalogProbe fingerprints, in the catalogue's order (src/shared/ssis/catalog.ts catalogFingerprints):
    /// each view's columns that the tree and its documents show, as text, and its sql_variant values as their bytes (text would
    /// round a datetime to the minute). An admin-only view (catalog_properties: ssis_admin and sysadmin only) is left out of
    /// everyone else's text (LiveQuery.Restricted), so their samples never touch it (a permission error would end the view) and
    /// it reads 0 and 0 for them.</summary>
    private static readonly (string Id, string From, string Text, string[] Values, bool Admin)[] Fingerprints =
    [
        ("folders", "[catalog].[folders]", "x.folder_id, x.name, x.description", [], false),
        ("projects", "[catalog].[projects]", "x.project_id, x.folder_id, x.name, x.description, x.deployed_by_name, x.last_deployed_time, x.object_version_lsn", [], false),
        ("packages", "[catalog].[packages]", "x.package_id, x.project_id, x.name, x.entry_point, x.description", [], false),
        ("environments", "[catalog].[environments]", "x.environment_id, x.folder_id, x.name, x.description", [], false),
        ("variables", "[catalog].[environment_variables]", "x.variable_id, x.environment_id, x.name, x.description, x.type, x.sensitive", ["x.value"], false),
        ("references", "[catalog].[environment_references]", "x.reference_id, x.project_id, x.reference_type, x.environment_folder_name, x.environment_name", [], false),
        ("parameters", "[catalog].[object_parameters]",
            "x.parameter_id, x.project_id, x.object_type, x.object_name, x.parameter_name, x.data_type, x.required, x.sensitive, x.description, x.value_type, x.value_set, x.referenced_variable_name",
            ["x.design_default_value", "x.default_value"], false),
        ("properties", "[catalog].[catalog_properties]", "x.property_name, x.property_value", [], true)
    ];

    /// <summary>The view ids ssis.catalogProbe fingerprints, in order (the checks compare them with the catalogue).</summary>
    public static IEnumerable<string> FingerprintIds => Fingerprints.Select(view => view.Id);

    // One row: per view, its row count and a checksum, the sum of the first 3 bytes of each row's SHA-256 (under 2^53 for any
    // row count below 2^29, so it is exact in JavaScript). CHECKSUM_AGG would be cheaper, but it XORs: two equal rows cancel,
    // and BINARY_CHECKSUM misses changes past a long string's first characters. Rows are what row-level security shows the
    // login, so a fingerprint changes only when something it may see does.
    private static readonly string Catalog = BuildCatalog(admin: true);
    private static readonly string CatalogRestricted = BuildCatalog(admin: false);
    private static readonly string[] CatalogColumns = [.. Fingerprints.SelectMany(view => new[] { view.Id + "_count", view.Id + "_checksum" })];
    private static readonly LiveStatusColumn[] CatalogStatus = [.. Fingerprints.SelectMany(view => new LiveStatusColumn[] { new(view.Id + "Count", view.Id + "_count"), new(view.Id + "Checksum", view.Id + "_checksum") })];

    private static string BuildCatalog(bool admin)
    {
        static string Row((string Id, string From, string Text, string[] Values, bool Admin) view)
        {
            var text = "CONVERT(varbinary(max), CONCAT(" + string.Join(", NCHAR(31), ", view.Text.Split(", ")) + "))";
            return string.Concat(view.Values.Select(value => " + 0x1F + ISNULL(CONVERT(varbinary(8000), " + value + "), 0x)").Prepend(text));
        }
        var read = Fingerprints.Where(view => admin || !view.Admin).ToList();
        var selects = Fingerprints.Select(view => read.IndexOf(view) is var index and >= 0
            ? "v" + (index + 1) + ".n AS " + view.Id + "_count, v" + (index + 1) + ".h AS " + view.Id + "_checksum"
            : "CONVERT(bigint, 0) AS " + view.Id + "_count, CONVERT(bigint, 0) AS " + view.Id + "_checksum");
        var sources = read.Select((view, index) => "(SELECT COUNT_BIG(*) AS n, ISNULL(SUM(CONVERT(bigint, SUBSTRING(HASHBYTES('SHA2_256', " + Row(view) + "), 1, 3))), 0) AS h\n"
            + "    FROM " + view.From + " AS x) AS v" + (index + 1));
        return "SELECT " + string.Join(",\n    ", selects) + "\nFROM " + string.Join("\nCROSS JOIN ", sources) + ";";
    }

    /// <summary>The probe's query at a band, or null when the probe has none there (not a one-batch probe, or below its gate).
    /// The Activity Monitor's probes run several statements each (Activity/ActivityReader.cs and ActivitySql), and the live
    /// checks register their own (LiveTestSql). The SSIS Catalog's views are the same on every version, and Azure SQL Database
    /// reports 12, so its probe runs at any band.</summary>
    public static LiveQuery? For(string probe, int band) => probe switch
    {
        CatalogProbe when band is >= MinBand - 1 and <= MaxBand => new(probe, band, Catalog, CatalogColumns, null, null, [], CatalogStatus, CatalogRestricted),
        _ when band is < MinBand or > MaxBand => null,
        DatabasesProbe => new(probe, band, Databases, [], null, null, []) { Tables = [new(0)] },
        ProgressProbe => new(probe, band, Progress, [], null, null, []) { Tables = [new(0)] },
        AgentProbe => new(probe, band, Agent, ["running_jobs"], null, null, [new("runningJobs", "running_jobs")]),
        AvailabilityProbe => new(probe, band, Availability, [], null, null, []) { Tables = [new(0)] },
        _ => null
    };

    /// <summary>The prologue of a scope: server DMVs always read uncommitted; SSISDB reads committed when it has
    /// READ_COMMITTED_SNAPSHOT on.</summary>
    public static string Prologue(string scope, bool readCommittedSnapshot) => scope == "ssisdb" && readCommittedSnapshot ? CommittedPrologue : UncommittedPrologue;

    public static string Isolation(string prologue) => prologue == CommittedPrologue ? "readCommitted" : "readUncommitted";

    /// <summary>Every query the catalogue's SQL probes run, at every band.</summary>
    public static IEnumerable<LiveQuery> All(LiveCatalog catalog)
    {
        foreach (var probe in catalog.Probes.Values)
            for (var band = MinBand; band <= MaxBand; band++)
                if (For(probe.Id, band) is { } query) yield return query;
    }

    private static readonly string[] Builtins = [.. CatalogSql.Builtins, "DB_NAME(", "DB_ID(", "OBJECT_ID(", "FILE_NAME(", "FILE_ID(", "INDEXPROPERTY(", "COLUMNPROPERTY(", "SCHEMA_ID("];
    /// <summary>The built-ins as words, so a space before the parenthesis hides none (OBJECTPROPERTY also covers OBJECTPROPERTYEX).</summary>
    private static readonly (string Name, Regex Pattern)[] BuiltinPatterns = [.. Builtins.Select(builtin => (builtin.TrimEnd('('),
        new Regex(@"\b" + Regex.Escape(builtin.TrimEnd('(')) + (builtin.EndsWith('(') ? @"\s*\(" : ""), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)))];

    // OPENQUERY, OPENROWSET and OPENDATASOURCE run text on another server (or through a provider), inside a literal the lint blanks.
    [GeneratedRegex(@"\b(CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|DENY|INTO|EXEC|EXECUTE|WAITFOR|USE|KILL|SHUTDOWN|DBCC|RECONFIGURE|BACKUP|RESTORE|OPENQUERY|OPENROWSET|OPENDATASOURCE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex Forbidden();
    [GeneratedRegex(@"\bBEGIN\s+(TRAN|TRANSACTION|DISTRIBUTED)\b|\bSAVE\s+TRAN|\bCOMMIT\b|\bROLLBACK\b", RegexOptions.IgnoreCase)]
    private static partial Regex Transaction();
    [GeneratedRegex(@"\bTOP\b", RegexOptions.IgnoreCase)]
    private static partial Regex Top();
    [GeneratedRegex(@"\bORDER\s+BY\b", RegexOptions.IgnoreCase)]
    private static partial Regex OrderBy();
    /// <summary>One token the lint must not read as code, scanned left to right so each hides only what SQL Server would: a
    /// line or block comment, a string literal, or a bracketed or quoted identifier (any of which can hold a quote).</summary>
    [GeneratedRegex(@"--[^\r\n]*|/\*[\s\S]*?\*/|N?'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|""(?:[^""]|"""")*""")]
    private static partial Regex Token();

    /// <summary>Problems with one command's full text (prologue and statement); empty when it passes.</summary>
    public static List<string> Lint(string text)
    {
        var problems = new List<string>();
        if (!text.StartsWith(UncommittedPrologue, StringComparison.Ordinal) && !text.StartsWith(CommittedPrologue, StringComparison.Ordinal)) problems.Add("does not start with a live prologue");
        // Literals and identifiers are constant text, but a keyword inside one must not hide from the checks below, nor one
        // outside pass. Comments are refused (they belong in C#), and blanked first so a quote in one hides no code after it.
        var commented = false;
        var code = Token().Replace(text, token => token.Value[0] switch
        {
            '-' or '/' => Comment(),
            '[' or '"' => "[x]",
            _ => "''"
        });
        string Comment()
        {
            commented = true;
            return " ";
        }
        if (commented || code.Contains("/*", StringComparison.Ordinal)) problems.Add("has a comment");
        foreach (var (name, pattern) in BuiltinPatterns) if (pattern.IsMatch(code)) problems.Add("uses " + name);
        if (code.Contains('#')) problems.Add("uses a temporary table");
        if (code.Contains("sp_executesql", StringComparison.OrdinalIgnoreCase)) problems.Add("runs dynamic SQL");
        foreach (Match match in Forbidden().Matches(code)) problems.Add("uses " + match.Value.ToUpperInvariant());
        if (Transaction().IsMatch(code)) problems.Add("controls a transaction");
        if (!TopsOrdered(code)) problems.Add("takes TOP without ORDER BY");
        if (code.Contains("@@SPID", StringComparison.OrdinalIgnoreCase) && !text.EndsWith(Session, StringComparison.Ordinal) && !text.EndsWith(SsisSession, StringComparison.Ordinal))
            problems.Add("reads @@SPID outside the session probe");
        return problems;
    }

    /// <summary>Every TOP has an ORDER BY after it at its own level: in its parenthesised query, or in its statement (up to
    /// the next semicolon outside parentheses). An ORDER BY nested deeper, such as a window's OVER (ORDER BY …), orders
    /// nothing TOP takes.</summary>
    private static bool TopsOrdered(string code)
    {
        var depth = new int[code.Length + 1];
        for (int i = 0, level = 0; i < code.Length; i++)
        {
            if (code[i] == ')') level--;
            depth[i] = level;
            if (code[i] == '(') level++;
        }
        var orders = OrderBy().Matches(code).Select(match => match.Index).ToList();
        foreach (Match top in Top().Matches(code))
        {
            var level = depth[top.Index];
            var end = top.Index;
            while (end < code.Length && depth[end] >= level && !(code[end] == ';' && depth[end] == level)) end++;
            if (!orders.Any(order => order > top.Index && order < end && depth[order] == level)) return false;
        }
        return true;
    }
}
