using System.Globalization;
using System.Text;
using Varia.Backend.Live;

namespace Varia.Backend.Activity;

/// <summary>One statement's result as it was read: its column names and rows, NULL as null.</summary>
internal sealed class ActivityResult
{
    private readonly Dictionary<string, int> ordinals;

    public ActivityResult(IReadOnlyList<string> names, List<object?[]> rows)
    {
        Names = names;
        Rows = rows;
        ordinals = names.Select((name, index) => (name, index)).ToDictionary(item => item.name, item => item.index, StringComparer.Ordinal);
    }

    public IReadOnlyList<string> Names { get; }
    public List<object?[]> Rows { get; }

    public object? Get(object?[] row, string column) => row[ordinals[column]];
    public long? Long(object?[] row, string column) => Get(row, column) is { } value ? Convert.ToInt64(value, CultureInfo.InvariantCulture) : null;
    public int? Int(object?[] row, string column) => Get(row, column) is { } value ? Convert.ToInt32(value, CultureInfo.InvariantCulture) : null;
    public double? Double(object?[] row, string column) => Get(row, column) is { } value ? Convert.ToDouble(value, CultureInfo.InvariantCulture) : null;
    public string? Text(object?[] row, string column) => Get(row, column) is { } value ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
    public DateTime? Time(object?[] row, string column) => Get(row, column) is DateTime value ? value : null;
    public bool Flag(object?[] row, string column) => Get(row, column) is { } value && Convert.ToBoolean(value, CultureInfo.InvariantCulture);
    public byte[]? Bytes(object?[] row, string column) => Get(row, column) as byte[];
}

/// <summary>What the capability probe found on a connection: its session, whether the login reads server state, may end
/// sessions (ALTER ANY CONNECTION) and sees every file's name (VIEW ANY DEFINITION), and whether the query statistics have spills.</summary>
internal sealed record ActivityCapabilities(int Spid, bool ServerState, bool AlterAnyConnection, bool ViewAnyDefinition, bool TotalSpills);

/// <summary>Which sessions are Varia's own (D-am §6.8): a session this backend's process (host_process_id) opened from this
/// machine (host_name, the workstation id its connections send) under one of its connections' program names plus a known
/// suffix. Those values are the client's own claims at login, so a pool session (Object Explorer, Scripting, Object Actions,
/// the Activity Monitor, the SSIS pools), which the default filter hides, must also be a session id Varia's own connections
/// were given when they opened (SqlConnection.ServerProcessId): a client that claims Varia's process, machine and program
/// name under any other session id is shown as itself. Plain-name sessions are labelled "Query tab", a plain-name session of
/// this process (a query tab, or a pooled connection of the Connect dialog's database list), which the renderer names by the
/// tab that holds the session id; they are never hidden. The monitor's own session is always one of its pool's.</summary>
internal sealed class VariaSessions
{
    private readonly int processId;
    private readonly IReadOnlySet<int> own;
    private readonly Dictionary<string, (string Label, bool Pool)> programs = new(StringComparer.Ordinal);
    private readonly (string Label, bool Pool) monitor;

    /// <param name="ownSessions">The session ids Varia's pooled and Object Actions connections to this server were given.</param>
    public VariaSessions(ActivityCatalog catalog, int processId, IEnumerable<VariaClient> clients, IReadOnlySet<int> ownSessions)
    {
        this.processId = processId;
        own = ownSessions;
        foreach (var client in clients)
            foreach (var (suffix, kind) in catalog.VariaSuffixes)
            {
                // SQL Server keeps 128 characters of a program name, as SqlService cuts it.
                var program = client.ApplicationName + suffix;
                if (program.Length > 128) program = program[..128];
                var key = Key(program, client.Workstation);
                // A pool's name wins over a query tab's when an application name itself ends with a pool's suffix.
                if (!programs.TryGetValue(key, out var known) || !known.Pool) programs[key] = (catalog.VariaLabels[suffix], kind == "pool");
            }
        monitor = (catalog.VariaLabels[catalog.PoolSuffix], true);
    }

    // Workstation names compare without case, as Windows names machines.
    private static string Key(string program, string host) => program + "\u001f" + host.ToUpperInvariant();

    /// <summary>The Varia column's text and whether the session is one of Varia's pools; (null, false) for any other session.</summary>
    public (string? Label, bool Pool) Classify(int sessionId, int? hostProcessId, string? hostName, string? programName, int monitorSpid)
    {
        if (sessionId == monitorSpid) return monitor;
        if (hostProcessId != processId || programName is null || hostName is null || !programs.TryGetValue(Key(programName, hostName), out var found)) return (null, false);
        return found.Pool && !own.Contains(sessionId) ? (null, false) : found;
    }
}

/// <summary>The overview's raw values: each series' value and base from the statements that ran (one that did not leaves its
/// series null), aligned with the probe's series; the delta engine turns them into rates.</summary>
internal static class ActivityOverview
{
    private static readonly Dictionary<string, string> Counters = new(StringComparer.Ordinal)
    {
        ["Batch Requests/sec"] = "batchRequests", ["SQL Compilations/sec"] = "compilations", ["SQL Re-Compilations/sec"] = "recompilations", ["Memory Grants Pending"] = "grantsPending",
        ["Memory Grants Outstanding"] = "grantsOutstanding", ["Lock Waits/sec"] = "lockWaits", ["Number of Deadlocks/sec"] = "deadlocks", ["Page life expectancy"] = "pageLifeExpectancy",
        ["Logins/sec"] = "logins"
    };

    public static (long? MsTicks, long? StartTicks) Clock(IReadOnlyDictionary<string, ActivityResult> results) =>
        results.TryGetValue("clock", out var clock) && clock.Rows is [var row, ..] ? (clock.Long(row, "ms_ticks"), clock.Long(row, "sqlserver_start_time_ms_ticks")) : (null, null);

    public static LiveRawSample Raw(IReadOnlyList<string> series, IReadOnlyDictionary<string, ActivityResult> results, ActivityCatalog catalog)
    {
        var values = new Dictionary<string, (double? Value, double? Base)>(StringComparer.Ordinal);
        if (results.TryGetValue("cpu", out var cpu) && cpu.Rows is [var c, ..])
        {
            var schedulers = cpu.Double(c, "schedulers");
            values["cpuPercent"] = (cpu.Double(c, "cpu_ms"), schedulers);
            values["schedulerDelay"] = (cpu.Double(c, "scheduler_delay_ms"), null);
            values["runnablePerScheduler"] = (schedulers is > 0 && cpu.Double(c, "runnable_tasks") is { } runnable ? runnable / schedulers.Value : null, null);
            values["workQueue"] = (cpu.Double(c, "work_queue"), null);
        }
        if (results.TryGetValue("counters", out var counters))
            foreach (var row in counters.Rows)
                if (counters.Text(row, "counter_name") is { } name && Counters.TryGetValue(name, out var id) && counters.Double(row, "cntr_value") is { } value)
                    values[id] = ((values.GetValueOrDefault(id).Value ?? 0) + value, null);
        if (results.TryGetValue("io", out var io) && io.Rows is [var i, ..])
        {
            values["ioMegabytes"] = (io.Double(i, "bytes_read") + io.Double(i, "bytes_written"), null);
            values["readLatency"] = (io.Double(i, "read_stall_ms"), io.Double(i, "reads"));
            values["writeLatency"] = (io.Double(i, "write_stall_ms"), io.Double(i, "writes"));
        }
        if (results.TryGetValue("waits", out var waits))
        {
            // Wait time less signal wait of every type that counts as waiting: benign waits are threads waiting for work.
            var waiting = 0.0;
            foreach (var row in waits.Rows)
                if (waits.Text(row, "wait_type") is { } type && catalog.Classify(type).CountsAsWaiting)
                    waiting += (waits.Double(row, "wait_time_ms") ?? 0) - (waits.Double(row, "signal_wait_time_ms") ?? 0);
            values["waitingTasks"] = (waiting, null);
        }
        if (results.TryGetValue("blocked", out var blocked) && blocked.Rows is [var b, ..])
        {
            var count = blocked.Double(b, "blocked_sessions") ?? 0;
            values["blockedSessions"] = (count, null);
            values["longestBlock"] = (count > 0 ? blocked.Double(b, "longest_wait_ms") ?? 0 : 0, null);
        }
        if (results.TryGetValue("requests", out var requests) && requests.Rows is [var r, ..])
        {
            values["activeRequests"] = (requests.Double(r, "active_requests") ?? 0, null);
            values["userSessions"] = (requests.Double(r, "user_sessions") ?? 0, null);
        }
        var (ms, start) = Clock(results);
        return new(ms, start, [.. series.Select(id => values.GetValueOrDefault(id).Value)], [.. series.Select(id => values.GetValueOrDefault(id).Base)]);
    }
}

/// <summary>Writes a table's cells by catalogue column id, in the catalogue's column order (the live table's).</summary>
internal sealed class ActivityRowWriter
{
    private readonly Dictionary<string, int> index;

    public ActivityRowWriter(ActivityTableSpec spec)
    {
        Spec = spec;
        index = spec.Columns.Select((column, at) => (column.Id, at)).ToDictionary(item => item.Id, item => item.at, StringComparer.Ordinal);
    }

    public ActivityTableSpec Spec { get; }
    public int Count => index.Count;

    public LiveCell[] New() => Enumerable.Repeat(LiveCell.Null, index.Count).ToArray();

    public void Set(LiveCell[] cells, string column, LiveCell cell) =>
        cells[index.TryGetValue(column, out var at) ? at : throw new InvalidOperationException("Unknown Activity Monitor column " + column)] = cell;

    /// <summary>A cell's display text by column id, as the filter engine reads it.</summary>
    public Func<string, string?> Reader(LiveRow row) => column => index.TryGetValue(column, out var at) ? row.Cells[at].Text : null;

    public static LiveCell Decimal(double? value, int places)
    {
        // A rate past this is no measurement (a counter wrapped): blank rather than overflow the decimal.
        if (value is not { } number || !double.IsFinite(number) || Math.Abs(number) > 1e15) return LiveCell.Null;
        // Adding a zero of the right scale keeps the places (12.0, not 12), so a column's values line up.
        var zero = places switch { 1 => 0.0m, 2 => 0.00m, _ => 0.000m };
        return LiveCell.Of(decimal.Round((decimal)number, places, MidpointRounding.AwayFromZero) + zero);
    }

    public static LiveCell Time(DateTime? value) => value is { } time ? LiveCell.DateTime(time) : LiveCell.Null;

    /// <summary>Text on one line (whitespace runs become one space), at most <paramref name="max"/> characters.</summary>
    public static string? OneLine(string? text, long max)
    {
        if (text is null) return null;
        var line = new StringBuilder(Math.Min(text.Length, (int)Math.Min(max, int.MaxValue)));
        var space = false;
        foreach (var character in text.AsSpan().Trim())
        {
            if (line.Length >= max) break;
            if (char.IsWhiteSpace(character)) { space = true; continue; }
            if (space && line.Length > 0) line.Append(' ');
            space = false;
            line.Append(character);
        }
        return line.ToString();
    }

    public static string? Hex(byte[]? bytes) => bytes is null ? null : "0x" + Convert.ToHexString(bytes);
}

/// <summary>What one sessions sample gives the live tables: each table's rows (in catalogue column order), the rows read past a
/// cap, what the view chips and toggles test about each Processes row, the Details flyout's session's rates and how many
/// sessions are blocked.</summary>
internal sealed record ActivitySessionsSample(List<LiveRow> Sessions, long SessionsMore, Dictionary<LiveRow, SessionFacts> Facts, List<LiveRow> Blocking, long BlockingMore,
    List<LiveRow>? Active, long ActiveMore, double? FocusCpuRate, double? FocusReadsRate, int BlockedSessions);

/// <summary>The sessions probe's rows (D-am §6.1-6.3), built from its statements' results: Processes (one row per session,
/// from the statement's row per request), the blocking chains (BlockingGraph) and Active Expensive Queries, with per-session
/// and per-request rates between samples. Rates are keyed by the session's login time or the request's start time, so a reused
/// id never yields a rate across two sessions, and they need two samples of the same key; each baseline keeps the time it was
/// read at, so a row missing from a sample never makes a rate over two intervals. Pure apart from those baselines, so the
/// offline checks feed it rows.</summary>
internal sealed class ActivitySessionRows(ActivityCatalog catalog)
{
    private static readonly string[] Isolation = ["Unspecified", "Read Uncommitted", "Read Committed", "Repeatable Read", "Serializable", "Snapshot"];
    private readonly ActivityRowWriter sessions = new(catalog.Table("sessions"));
    private readonly ActivityRowWriter blocking = new(catalog.Table("blocking"));
    private readonly ActivityRowWriter active = new(catalog.Table("activeQueries"));
    private readonly SessionRates sessionRates = new(catalog.Table("sessions").RowCap);
    private readonly LiveKeyedDeltas requestRates = new(catalog.Table("activeQueries").RowCap);

    public ActivityRowWriter SessionsWriter => sessions;
    public ActivityRowWriter BlockingWriter => blocking;
    public ActivityRowWriter ActiveWriter => active;

    /// <summary>After a pause, a restart or a lost connection, rates start again.</summary>
    public void Reset()
    {
        sessionRates.Clear();
        requestRates.Clear();
    }

    private sealed record SessionInfo(string? Status, string? Login, string? Host, string? Application, string? Database, int? OpenTransactions);

    /// <param name="at">This sample's time in milliseconds on the probe's sample clock (the server's own between samples that
    /// read it), which per-row rates measure their span with.</param>
    /// <param name="hideMonitor">False without server state: the monitor's own session is then the only one SQL Server shows, so
    /// it is never hidden as one of Varia's pools.</param>
    public ActivitySessionsSample Build(IReadOnlyDictionary<string, ActivityResult> results, long at, VariaSessions varia, int monitorSpid, int focusSession, bool hideMonitor = true)
    {
        var sessionsCap = (int)catalog.Limit("sessions");
        var rows = results.GetValueOrDefault("sessions");
        var edges = results.GetValueOrDefault("edges");
        var leads = results.GetValueOrDefault("leadBatches");

        // The blocking graph: task waits, and a request's blocker for a session no task wait names.
        var waits = new List<BlockingWait>();
        if (edges is not null)
            foreach (var edge in edges.Rows.Take((int)catalog.Limit("blockingEdges")))
                if (edges.Int(edge, "session_id") is { } waiter && edges.Int(edge, "blocking_session_id") is { } blocker)
                    waits.Add(new(waiter, blocker, edges.Text(edge, "wait_type"), edges.Long(edge, "wait_duration_ms") ?? 0, edges.Text(edge, "resource_description")));
        // The statement returns a row per request, a session's rows together and its first-ranked request first.
        var grouped = new List<(object?[] Head, List<object?[]> Requests)>();
        if (rows is not null)
            foreach (var row in rows.Rows)
            {
                if (grouped.Count == 0 || rows.Int(grouped[^1].Head, "session_id") != rows.Int(row, "session_id")) grouped.Add((row, []));
                if (rows.Get(row, "request_id") is not null) grouped[^1].Requests.Add(row);
            }
        var sessionRows = grouped.Take(sessionsCap).ToList();
        foreach (var (row, _) in sessionRows)
            if (rows!.Int(row, "blocking_session_id") is { } blocker and not 0 && rows.Int(row, "session_id") is { } waiter)
                waits.Add(new(waiter, blocker, rows.Text(row, "wait_type"), rows.Long(row, "wait_time") ?? 0, rows.Text(row, "wait_resource"), FromTask: false));
        var graph = BlockingGraph.Build(waits, (int)catalog.Limit("blockingDepth"), (int)catalog.Limit("blockingRows"));

        var built = new List<LiveRow>(sessionRows.Count);
        var facts = new Dictionary<LiveRow, SessionFacts>(ReferenceEqualityComparer.Instance);
        var infos = new Dictionary<int, SessionInfo>();
        double? focusCpu = null, focusReads = null;
        foreach (var (row, requests) in sessionRows)
        {
            var id = rows!.Int(row, "session_id") ?? 0;
            var cells = sessions.New();
            var node = graph.Of(id);
            var hasRequest = rows.Get(row, "request_id") is not null;
            var command = rows.Text(row, "command");
            var openTransactions = rows.Int(row, "open_transaction_count");
            var rollingBack = command == "KILLED/ROLLBACK";
            var status = Status(rows.Text(row, "request_status"), rows.Text(row, "status"), rollingBack, rows.Double(row, "percent_complete"), openTransactions);
            var (label, pool) = varia.Classify(id, rows.Int(row, "host_process_id"), rows.Text(row, "host_name"), rows.Text(row, "program_name"), monitorSpid);
            if (id == monitorSpid && !hideMonitor) pool = false;
            var database = rows.Text(row, "database_name");

            // A parallel request waits in its tasks: the longest blocking task wait says what it waits on.
            var waitType = rows.Text(row, "wait_type");
            long? waitMs = rows.Long(row, "wait_time");
            var waitResource = rows.Text(row, "wait_resource") is { Length: > 0 } resource ? resource : null;
            if (node is { BlockedBy: > 0, WaitType: { } taskWait } && (waitType is null || (rows.Int(row, "dop") ?? 1) > 1))
                (waitType, waitMs, waitResource) = (taskWait, node.WaitMs, node.WaitResource ?? waitResource);
            waitResource ??= node?.WaitResource;

            var loginTime = rows.Time(row, "login_time");
            var rates = sessionRates.Apply(id, loginTime, new(rows.Double(row, "cpu_time") ?? 0, rows.Double(row, "logical_reads") ?? 0,
                [.. requests.Select(request => new RequestCounters(rows.Int(request, "request_id") ?? 0, rows.Time(request, "start_time"), rows.Double(request, "request_cpu_time") ?? 0,
                    rows.Double(request, "request_logical_reads") ?? 0))]), at);
            if (id == focusSession) (focusCpu, focusReads) = (rates[0], rates[1]);
            var requestCount = rows.Int(row, "request_count") ?? 0;
            var lowest = rows.Int(row, "lowest_request_id");

            sessions.Set(cells, "sessionId", LiveCell.Of(id));
            sessions.Set(cells, "status", LiveCell.Of(status));
            sessions.Set(cells, "login", LiveCell.Of(rows.Text(row, "login_name")));
            sessions.Set(cells, "database", LiveCell.Of(database));
            sessions.Set(cells, "command", LiveCell.Of(command));
            sessions.Set(cells, "application", LiveCell.Of(rows.Text(row, "program_name")));
            sessions.Set(cells, "waitType", LiveCell.Of(waitType));
            sessions.Set(cells, "waitTimeMs", waitType is null ? LiveCell.Null : LiveCell.Of(waitMs));
            sessions.Set(cells, "waitResource", LiveCell.Of(waitResource));
            sessions.Set(cells, "blockedBy", LiveCell.Of((long?)node?.BlockedBy));
            sessions.Set(cells, "headBlocker", LiveCell.Bit(node?.HeadBlocker == true));
            sessions.Set(cells, "blocking", LiveCell.Of(node?.Downstream ?? 0));
            sessions.Set(cells, "cpuRate", ActivityRowWriter.Decimal(rates[0], 1));
            sessions.Set(cells, "totalCpuMs", LiveCell.Of(rows.Long(row, "cpu_time")));
            sessions.Set(cells, "physicalIoMb", ActivityRowWriter.Decimal(((rows.Double(row, "reads") ?? 0) + (rows.Double(row, "writes") ?? 0)) * 8 / 1024, 2));
            sessions.Set(cells, "logicalReadsRate", ActivityRowWriter.Decimal(rates[1], 1));
            sessions.Set(cells, "memoryKb", LiveCell.Of(rows.Long(row, "memory_usage") * 8));
            sessions.Set(cells, "openTransactions", LiveCell.Of(openTransactions));
            sessions.Set(cells, "elapsedSeconds", hasRequest ? ActivityRowWriter.Decimal(rows.Double(row, "total_elapsed_time") / 1000, 3) : LiveCell.Null);
            sessions.Set(cells, "hostName", LiveCell.Of(rows.Text(row, "host_name")));
            sessions.Set(cells, "netAddress", LiveCell.Of(rows.Text(row, "client_net_address")));
            sessions.Set(cells, "loginTime", ActivityRowWriter.Time(loginTime));
            sessions.Set(cells, "lastRequestStart", ActivityRowWriter.Time(rows.Time(row, "last_request_start_time")));
            sessions.Set(cells, "requestId", LiveCell.Of(lowest is { } first ? first.ToString(CultureInfo.InvariantCulture) + (requestCount > 1 ? " +" + (requestCount - 1).ToString(CultureInfo.InvariantCulture) : "") : null));
            sessions.Set(cells, "dop", LiveCell.Of(rows.Long(row, "dop")));
            sessions.Set(cells, "workloadGroup", LiveCell.Of(rows.Text(row, "workload_group")));
            sessions.Set(cells, "originalLogin", LiveCell.Of(rows.Text(row, "original_login_name")));
            sessions.Set(cells, "interface", LiveCell.Of(rows.Text(row, "client_interface_name")));
            sessions.Set(cells, "isolationLevel", LiveCell.Of(rows.Int(row, "transaction_isolation_level") is { } level and >= 0 and < 6 ? Isolation[level] : null));
            sessions.Set(cells, "encrypted", rows.Text(row, "encrypt_option") is { } encrypt ? LiveCell.Bit(string.Equals(encrypt, "TRUE", StringComparison.OrdinalIgnoreCase)) : LiveCell.Null);
            sessions.Set(cells, "authScheme", LiveCell.Of(rows.Text(row, "auth_scheme")));
            sessions.Set(cells, "hostProcessId", LiveCell.Of(rows.Long(row, "host_process_id")));
            sessions.Set(cells, "queryHash", LiveCell.Of(ActivityRowWriter.Hex(rows.Bytes(row, "query_hash"))));
            sessions.Set(cells, "varia", LiveCell.Of(label));
            var live = new LiveRow(cells);
            built.Add(live);
            facts[live] = new(System: !rows.Flag(row, "is_user_process"), VariaPool: pool, Active: hasRequest, Blocked: node?.BlockedBy > 0, Blocking: node?.Downstream > 0,
                IdleOpenTransaction: !hasRequest && openTransactions > 0, RollingBack: rollingBack);
            infos[id] = new(status, rows.Text(row, "login_name"), rows.Text(row, "host_name"), rows.Text(row, "program_name"), database, openTransactions);
        }
        sessionRates.EndSample();

        // The chains: each session once, at its depth, with what it waits on and, for a lead blocker, its last batch.
        var batches = new Dictionary<int, string?>();
        if (leads is not null) foreach (var row in leads.Rows) if (leads.Int(row, "session_id") is { } lead) batches[lead] = leads.Text(row, "event_info");
        var chain = new List<LiveRow>(graph.Rows.Count);
        foreach (var (node, depth) in graph.Rows)
        {
            var cells = blocking.New();
            var info = infos.GetValueOrDefault(node.SessionId);
            var id = node.SessionId.ToString(CultureInfo.InvariantCulture);
            blocking.Set(cells, "session", LiveCell.Of(depth == 0 ? id : new string(' ', 2 * (depth - 1)) + "└─ " + id));
            blocking.Set(cells, "sessionId", LiveCell.Of(node.SessionId));
            blocking.Set(cells, "depth", LiveCell.Of(depth));
            blocking.Set(cells, "status", LiveCell.Of(info?.Status));
            blocking.Set(cells, "blockedSessions", LiveCell.Of(node.Downstream));
            // The wait on its parent; a lead blocker has none, even when it waits on a latch.
            blocking.Set(cells, "waitType", LiveCell.Of(depth > 0 ? node.WaitType : null));
            blocking.Set(cells, "waitTimeMs", depth > 0 ? LiveCell.Of(node.WaitMs) : LiveCell.Null);
            blocking.Set(cells, "waitResource", LiveCell.Of(depth > 0 ? node.WaitResource : null));
            blocking.Set(cells, "login", LiveCell.Of(info?.Login));
            blocking.Set(cells, "hostName", LiveCell.Of(info?.Host));
            blocking.Set(cells, "application", LiveCell.Of(info?.Application));
            blocking.Set(cells, "database", LiveCell.Of(info?.Database));
            blocking.Set(cells, "openTransactions", LiveCell.Of(info?.OpenTransactions));
            blocking.Set(cells, "cycle", LiveCell.Bit(node.Cycle));
            blocking.Set(cells, "lastBatch", LiveCell.Of(depth == 0 ? ActivityRowWriter.OneLine(batches.GetValueOrDefault(node.SessionId), catalog.Limit("lastBatchChars")) : null));
            chain.Add(new LiveRow(cells));
        }

        var (activeRows, activeMore) = Active(results.GetValueOrDefault("activeQueries"), at);
        return new(built, Math.Max(0, grouped.Count - sessionsCap), facts, chain, graph.Truncated ? 1 : 0, activeRows, activeMore,
            focusCpu, focusReads, graph.BlockedSessions);
    }

    private (List<LiveRow>? Rows, long More) Active(ActivityResult? requests, long at)
    {
        if (requests is null)
        {
            requestRates.EndSample();
            return (null, 0);
        }
        var cap = (int)catalog.Limit("activeQueries");
        var rows = new List<LiveRow>(Math.Min(cap, requests.Rows.Count));
        foreach (var row in requests.Rows.Take(cap))
        {
            var cells = active.New();
            var session = requests.Int(row, "session_id") ?? 0;
            var request = requests.Int(row, "request_id") ?? 0;
            var start = requests.Time(row, "start_time");
            var rate = requestRates.Apply(string.Join('\u001f', session.ToString(CultureInfo.InvariantCulture), request.ToString(CultureInfo.InvariantCulture), start?.Ticks.ToString(CultureInfo.InvariantCulture)),
                [requests.Double(row, "cpu_time") ?? 0], at);
            active.Set(cells, "query", LiveCell.Of(ActivityRowWriter.OneLine(requests.Text(row, "statement_text"), catalog.Limit("statementChars"))));
            active.Set(cells, "sessionId", LiveCell.Of(session));
            active.Set(cells, "requestId", LiveCell.Of(request));
            active.Set(cells, "startTime", ActivityRowWriter.Time(start));
            active.Set(cells, "status", LiveCell.Of(requests.Text(row, "status")));
            active.Set(cells, "database", LiveCell.Of(requests.Text(row, "database_name")));
            active.Set(cells, "cpuMs", LiveCell.Of(requests.Long(row, "cpu_time")));
            active.Set(cells, "cpuRate", ActivityRowWriter.Decimal(rate[0], 1));
            active.Set(cells, "elapsedMs", LiveCell.Of(requests.Long(row, "total_elapsed_time")));
            active.Set(cells, "physicalReads", LiveCell.Of(requests.Long(row, "reads")));
            active.Set(cells, "logicalReads", LiveCell.Of(requests.Long(row, "logical_reads")));
            active.Set(cells, "writes", LiveCell.Of(requests.Long(row, "writes")));
            active.Set(cells, "rowCount", LiveCell.Of(requests.Long(row, "row_count")));
            active.Set(cells, "dop", LiveCell.Of(requests.Long(row, "dop")));
            active.Set(cells, "requestedMemoryKb", LiveCell.Of(requests.Long(row, "requested_memory_kb")));
            active.Set(cells, "grantedMemoryKb", LiveCell.Of(requests.Long(row, "granted_memory_kb")));
            active.Set(cells, "requiredMemoryKb", LiveCell.Of(requests.Long(row, "required_memory_kb")));
            active.Set(cells, "usedMemoryKb", LiveCell.Of(requests.Long(row, "used_memory_kb")));
            active.Set(cells, "maxUsedMemoryKb", LiveCell.Of(requests.Long(row, "max_used_memory_kb")));
            active.Set(cells, "grantWaitMs", LiveCell.Of(requests.Long(row, "grant_wait_ms")));
            active.Set(cells, "waitType", LiveCell.Of(requests.Text(row, "wait_type")));
            active.Set(cells, "blockedBy", requests.Long(row, "blocking_session_id") is { } blocker and not 0 ? LiveCell.Of(blocker) : LiveCell.Null);
            active.Set(cells, "percentComplete", requests.Double(row, "percent_complete") is { } percent and > 0 ? ActivityRowWriter.Decimal(percent, 1) : LiveCell.Null);
            active.Set(cells, "queryHash", LiveCell.Of(ActivityRowWriter.Hex(requests.Bytes(row, "query_hash"))));
            rows.Add(new LiveRow(cells));
        }
        requestRates.EndSample();
        return (rows, Math.Max(0, requests.Rows.Count - cap));
    }

    /// <summary>Processes' status (D-am §6.1): rollback progress during KILLED/ROLLBACK, the request's status, else the
    /// session's, with its open transactions when it holds some and runs nothing (SSMS's Task State shows neither).</summary>
    internal static string? Status(string? requestStatus, string? sessionStatus, bool rollingBack, double? percentComplete, int? openTransactions)
    {
        if (rollingBack) return "rolling back " + Math.Round(percentComplete ?? 0, MidpointRounding.AwayFromZero).ToString(CultureInfo.InvariantCulture) + " %";
        if (requestStatus is not null) return requestStatus;
        return openTransactions is > 0 ? sessionStatus + " · " + openTransactions.Value.ToString(CultureInfo.InvariantCulture) + " open tran" : sessionStatus;
    }
}

/// <summary>A session's counters in one sample: its own CPU and logical reads (since login) and each running request's.</summary>
internal sealed record SessionCounters(double Cpu, double Reads, IReadOnlyList<RequestCounters> Requests);

/// <summary>One request's CPU and logical reads so far, by its id and start time (a MARS session runs several).</summary>
internal readonly record struct RequestCounters(int Id, DateTime? Start, double Cpu, double Reads);

/// <summary>Per-session CPU and logical reads per second (D-am §6.1). A session's own counters take in a request's work only
/// when the request ends, and on SQL Server 2025 on a smaller scale than the request reported (a 1.2 s CPU loop: 813 ms
/// against 1,096 ms; the live checks measure it), so session plus request dips at every batch end. Each request is followed
/// by its id and start time: one still running counts by its own change, one that started since the session's last sample
/// counts whole, and the requests that ended add only what the session took in beyond what they had already counted. So a
/// MARS session whose first-ranked request changes, or whose requests end one by one, never counts a request twice, and a
/// rate is never negative; the tail of a request between the last sample and its end may be missed. Keyed by session id and
/// login time, so a reused id starts again; each baseline keeps its sample time, so a session missing from a sample (its
/// statement failed) gets a rate over its own span. At most <paramref name="capacity"/> sessions, each dropped after two
/// samples absent.</summary>
internal sealed class SessionRates(int capacity)
{
    private sealed class Baseline(DateTime? login, SessionCounters counters, long at)
    {
        public DateTime? Login = login;
        public SessionCounters Counters = counters;
        public long At = at;
        public int Absent;
    }
    private readonly Dictionary<int, Baseline> baselines = [];
    private readonly HashSet<int> seen = [];

    /// <summary>CPU (ms/s) and logical reads per second since this session's previous sample; nulls for a new session or no
    /// time between the two.</summary>
    /// <param name="at">This sample's time in milliseconds on the probe's sample clock.</param>
    public double?[] Apply(int session, DateTime? login, SessionCounters counters, long at)
    {
        seen.Add(session);
        if (!baselines.TryGetValue(session, out var baseline) || baseline.Login != login)
        {
            if (baseline is not null) (baseline.Login, baseline.Counters, baseline.At, baseline.Absent) = (login, counters, at, 0);
            else if (baselines.Count < capacity) baselines[session] = new(login, counters, at);
            return [null, null];
        }
        var (before, elapsed) = (baseline.Counters, at - baseline.At);
        (baseline.Counters, baseline.At, baseline.Absent) = (counters, at, 0);
        if (elapsed <= 0) return [null, null];
        var earlier = new Dictionary<(int, DateTime?), RequestCounters>();
        foreach (var request in before.Requests) earlier.TryAdd((request.Id, request.Start), request);
        double cpu = 0, reads = 0;
        foreach (var request in counters.Requests)
        {
            if (earlier.Remove((request.Id, request.Start), out var was))
            {
                cpu += Math.Max(0, request.Cpu - was.Cpu);
                reads += Math.Max(0, request.Reads - was.Reads);
            }
            else
            {
                cpu += request.Cpu;
                reads += request.Reads;
            }
        }
        // What is left in earlier ended since: the session took it in, so only what it took in beyond what was counted is new.
        cpu += Math.Max(0, Math.Max(0, counters.Cpu - before.Cpu) - earlier.Values.Sum(request => request.Cpu));
        reads += Math.Max(0, Math.Max(0, counters.Reads - before.Reads) - earlier.Values.Sum(request => request.Reads));
        return [cpu * 1000 / elapsed, reads * 1000 / elapsed];
    }

    /// <summary>Ends a sample: sessions it did not see age, and go after two.</summary>
    public void EndSample()
    {
        foreach (var (session, baseline) in baselines.ToList())
            if (!seen.Contains(session) && ++baseline.Absent >= 2) baselines.Remove(session);
        seen.Clear();
    }

    public void Clear()
    {
        baselines.Clear();
        seen.Clear();
    }
}
