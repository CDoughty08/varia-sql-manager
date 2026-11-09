using System.Data.SqlTypes;
using System.Globalization;
using Varia.Backend.Live;

namespace Varia.Backend.Activity;

/// <summary>One sys.dm_exec_query_stats row as the query statistics probe reads it: a statement of a cached plan, keyed by its
/// sql_handle, plan_handle and offsets, with its totals since the plan was cached.</summary>
internal sealed record QueryStatement(string Key, string Hash, string? PlanHash, byte[] SqlHandle, byte[]? PlanHandle, int Start, int End, DateTime? Created, DateTime? LastRun,
    double[] Totals, long? MaxElapsedUs)
{
    // Totals' places: execution_count, total_worker_time (µs), total_elapsed_time (µs), total_logical_reads, total_physical_reads,
    // total_logical_writes, total_rows, total_grant_kb, total_spills.
    public const int Executions = 0, Worker = 1, Elapsed = 2, LogicalReads = 3, PhysicalReads = 4, Writes = 5, Rows = 6, Grant = 7, Spills = 8, Count = 9;
}

/// <summary>A group of statements that share a query_hash, as one sample saw it: the window's change of each total (null
/// before a window exists), the plans' own totals, and its rank in the sample.</summary>
internal sealed class QueryGroup(string hash)
{
    public string Hash { get; } = hash;
    public List<QueryStatement> Statements { get; } = [];
    public double[] Window { get; } = new double[QueryStatement.Count];
    public double[] Totals { get; } = new double[QueryStatement.Count];
    /// <summary>The statement whose text and database the row shows: the group's most recent execution.</summary>
    public QueryStatement Shown => Statements.MaxBy(statement => statement.LastRun ?? DateTime.MinValue)!;
}

/// <summary>What one query statistics sample built: the groups the pane shows (ranked, at most shownHashes), how many more
/// there were, and the window in milliseconds the rates span (null on a first sample, which has no rates).</summary>
internal sealed record QuerySample(List<QueryGroup> Shown, long More, long? WindowMs, bool Spills);

/// <summary>A statement text the text statement reads into one of its slots.</summary>
internal readonly record struct QueryTextRequest(int Slot, QueryStatement Statement);

/// <summary>Per-statement totals between samples, at most <paramref name="capacity"/> statements (queryDeltaKeys), the one seen
/// least recently dropped first. A statement keeps its totals while it does not run (the stats statement reads only statements
/// that ran since about the previous sample), so a later run's change is measured from them. A plan cached again (another
/// creation_time) or totals that went down start again.</summary>
internal sealed class QueryDeltas(int capacity)
{
    private sealed record Entry(string Key, double[] Totals, DateTime? Created);
    private readonly Dictionary<string, LinkedListNode<Entry>> entries = new(StringComparer.Ordinal);
    private readonly LinkedList<Entry> order = new();

    public int Count => entries.Count;
    public bool Contains(string key) => entries.ContainsKey(key);

    /// <summary>The totals' change since the statement's kept totals; all of them when there are none (or they no longer apply)
    /// and <paramref name="whole"/> says every execution of the plan falls in the window (it was cached since the previous
    /// sample); else null, unknown. Either way the totals are kept for the next sample.</summary>
    public double[]? Apply(string key, double[] totals, DateTime? created, bool whole)
    {
        double[]? delta = null;
        if (entries.Remove(key, out var node))
        {
            order.Remove(node);
            var before = node.Value;
            if (before.Created == created && totals.Zip(before.Totals).All(pair => pair.First >= pair.Second)) delta = [.. totals.Zip(before.Totals, (now, then) => now - then)];
        }
        if (delta is null && whole) delta = [.. totals];
        entries[key] = order.AddLast(new Entry(key, totals, created));
        while (entries.Count > capacity && order.First is { } oldest)
        {
            order.RemoveFirst();
            entries.Remove(oldest.Value.Key);
        }
        return delta;
    }

    public void Clear()
    {
        entries.Clear();
        order.Clear();
    }
}

/// <summary>Statement texts and databases of Recent Expensive Queries, at most <paramref name="capacity"/> (textCache), the one
/// used least recently dropped first. A text SQL Server no longer has (the plan left the cache) is kept as null, so it is not
/// asked for again.</summary>
internal sealed class QueryTexts(int capacity)
{
    internal sealed record Text(string? Statement, string? Database);
    private readonly Dictionary<string, LinkedListNode<(string Key, Text Value)>> entries = new(StringComparer.Ordinal);
    private readonly LinkedList<(string Key, Text Value)> order = new();

    public int Count => entries.Count;

    public Text? Get(string key)
    {
        if (!entries.TryGetValue(key, out var node)) return null;
        order.Remove(node);
        order.AddLast(node);
        return node.Value.Value;
    }

    public void Set(string key, Text value)
    {
        if (entries.Remove(key, out var known)) order.Remove(known);
        entries[key] = order.AddLast((key, value));
        while (entries.Count > capacity && order.First is { } oldest)
        {
            order.RemoveFirst();
            entries.Remove(oldest.Value.Key);
        }
    }

    public void Clear()
    {
        entries.Clear();
        order.Clear();
    }
}

/// <summary>The query statistics probe's rows (Recent Expensive Queries), built from its statements' results. The stats
/// statement reads the statements that ran since about the previous sample; each statement's change since its kept totals
/// (<see cref="QueryDeltas"/>) is summed per query_hash, so a sum never depends on which rows a window happens to include.
/// Rates span the window since the previous sample, on the probe's sample clock. A first sample (after a baseline, a resume, a
/// restart or a lost connection) has no window: it shows the groups that ran in the last <see cref="FirstLookback"/> ranked by
/// their plans' totals, with blank rates and per-execution values from those totals. Later samples show the groups that ran in
/// the window, ranked by its CPU. Texts come from a cache filled for the shown rows, textBatch per text statement and
/// textBatchesPerTick statements per sample, most expensive first; a row whose text has not arrived says <see cref="Loading"/>.
/// Pure apart from those baselines and the cache, so the offline checks feed it rows. Nothing is logged.</summary>
internal sealed class ActivityQueryRows(ActivityCatalog catalog)
{
    public const string Loading = "Loading text…";
    /// <summary>How far back a first sample reads: the plan cache's recent statements, which also become the baselines.</summary>
    public static readonly TimeSpan FirstLookback = TimeSpan.FromMinutes(10);
    private static readonly DateTime SqlMin = SqlDateTime.MinValue.Value;
    private readonly ActivityRowWriter writer = new(catalog.Table("recentQueries"));
    private readonly QueryDeltas deltas = new((int)catalog.Limit("queryDeltaKeys"));
    private readonly QueryTexts texts = new((int)catalog.Limit("textCache"));
    /// <summary>The previous sample's time on the probe's clock and the server's local time then (null before one).</summary>
    private (long At, DateTime? Local)? previous;

    public ActivityRowWriter Writer => writer;
    internal int Baselines => deltas.Count;
    internal int Texts => texts.Count;

    /// <summary>After a baseline, a pause or a restart the totals start again; after a lost connection (maybe another server)
    /// the texts too.</summary>
    public void Reset(bool texts = false)
    {
        deltas.Clear();
        previous = null;
        if (texts) this.texts.Clear();
    }

    /// <summary>The stats statement's @since for a sample whose clock read <paramref name="now"/> (the server's local time):
    /// one window before the previous sample, so a statement that started before it and ended after is read again; a first
    /// sample reads <see cref="FirstLookback"/>.</summary>
    public DateTime Since(DateTime? now)
    {
        DateTime since;
        if (previous is { Local: { } then }) since = now is { } current && current > then ? then - (current - then) : then;
        else if (now is { } current) since = current - FirstLookback;
        else since = SqlMin;
        return since < SqlMin ? SqlMin : since;
    }

    /// <summary>Builds a sample from the stats statement's rows. <paramref name="at"/> is the sample's time on the probe's clock
    /// and <paramref name="now"/> the server's local time its clock read.</summary>
    public QuerySample Apply(ActivityResult stats, long at, DateTime? now, bool spills)
    {
        long? window = previous is { } before && at > before.At ? at - before.At : null;
        var cachedAfter = window is not null ? previous!.Value.Local : null;
        var groups = new Dictionary<string, QueryGroup>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in stats.Rows.Take((int)catalog.Limit("queryStatsRows")))
        {
            if (Read(stats, row, spills) is not { } statement || !seen.Add(statement.Key)) continue;
            // A plan cached since the previous sample ran wholly in the window; any other statement new to the baselines counts
            // from its next run.
            var delta = deltas.Apply(statement.Key, statement.Totals, statement.Created, whole: cachedAfter is { } cut && statement.Created >= cut);
            if (!groups.TryGetValue(statement.Hash, out var group)) groups[statement.Hash] = group = new(statement.Hash);
            group.Statements.Add(statement);
            for (var i = 0; i < QueryStatement.Count; i++)
            {
                group.Totals[i] += statement.Totals[i];
                if (window is not null && delta is not null) group.Window[i] += delta[i];
            }
        }
        IOrderedEnumerable<QueryGroup> candidates = window is null
            ? groups.Values.OrderByDescending(group => group.Totals[QueryStatement.Worker])
            : groups.Values.Where(group => group.Window[QueryStatement.Executions] > 0).OrderByDescending(group => group.Window[QueryStatement.Worker]);
        var ranked = candidates.ThenByDescending(group => group.Shown.LastRun ?? DateTime.MinValue).ThenBy(group => group.Hash, StringComparer.Ordinal).ToList();
        var cap = (int)catalog.Limit("shownHashes");
        previous = (at, now ?? previous?.Local);
        // Statistics rows past their cap are a cut too: the window's sums miss what was not read.
        var more = Math.Max(ranked.Count - cap, stats.Rows.Count > catalog.Limit("queryStatsRows") ? 1 : 0);
        return new([.. ranked.Take(cap)], more, window, spills);
    }

    private static QueryStatement? Read(ActivityResult stats, object?[] row, bool spills)
    {
        if (stats.Bytes(row, "query_hash") is not { } hash || stats.Bytes(row, "sql_handle") is not { } sql) return null;
        var plan = stats.Bytes(row, "plan_handle");
        var start = stats.Int(row, "statement_start_offset") ?? 0;
        var end = stats.Int(row, "statement_end_offset") ?? -1;
        var key = string.Join(':', Convert.ToHexString(sql), start.ToString(CultureInfo.InvariantCulture), end.ToString(CultureInfo.InvariantCulture), plan is null ? "" : Convert.ToHexString(plan));
        double[] totals =
        [
            stats.Double(row, "execution_count") ?? 0, stats.Double(row, "total_worker_time") ?? 0, stats.Double(row, "total_elapsed_time") ?? 0, stats.Double(row, "total_logical_reads") ?? 0,
            stats.Double(row, "total_physical_reads") ?? 0, stats.Double(row, "total_logical_writes") ?? 0, stats.Double(row, "total_rows") ?? 0, stats.Double(row, "total_grant_kb") ?? 0,
            spills ? stats.Double(row, "total_spills") ?? 0 : 0
        ];
        return new(key, ActivityRowWriter.Hex(hash)!, ActivityRowWriter.Hex(stats.Bytes(row, "query_plan_hash")), sql, plan, start, end, stats.Time(row, "creation_time"),
            stats.Time(row, "last_execution_time"), totals, stats.Long(row, "max_elapsed_time"));
    }

    /// <summary>The shown rows' statements whose text is not cached, most expensive first, in text statements of textBatch slots,
    /// at most textBatchesPerTick of them.</summary>
    public List<QueryTextRequest[]> TextBatches(QuerySample sample)
    {
        var size = (int)Math.Min(catalog.Limit("textBatch"), ActivitySql.TextSlots);
        var wanted = new List<QueryStatement>();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var group in sample.Shown)
        {
            var shown = group.Shown;
            if (texts.Get(shown.Key) is null && keys.Add(shown.Key)) wanted.Add(shown);
        }
        return [.. wanted.Take(size * (int)catalog.Limit("textBatchesPerTick")).Chunk(size).Select(chunk => chunk.Select((statement, slot) => new QueryTextRequest(slot, statement)).ToArray())];
    }

    /// <summary>The text statement's parameter values for a batch: each slot's handles and offsets, unused slots NULL.</summary>
    public static Func<ActivityParameter, object> TextValues(QueryTextRequest[] batch) => parameter =>
    {
        var slot = int.Parse(parameter.Name.AsSpan(2), CultureInfo.InvariantCulture);
        if (slot >= batch.Length) return DBNull.Value;
        var statement = batch[slot].Statement;
        return parameter.Name[1] switch
        {
            'h' => statement.SqlHandle,
            'p' => (object?)statement.PlanHandle ?? DBNull.Value,
            's' => statement.Start,
            'e' => statement.End,
            _ => throw new RequestException("BACKEND_ERROR", "The text statement has a parameter the source does not fill.")
        };
    };

    /// <summary>Keeps a batch's texts: each slot the statement returned, and an empty entry for a slot it did not (no handle).</summary>
    public void AddTexts(QueryTextRequest[] batch, ActivityResult result)
    {
        var found = new Dictionary<int, object?[]>();
        foreach (var row in result.Rows) if (result.Int(row, "slot") is { } slot) found.TryAdd(slot, row);
        foreach (var request in batch)
        {
            var row = found.GetValueOrDefault(request.Slot);
            texts.Set(request.Statement.Key, row is null ? new(null, null)
                : new(ActivityRowWriter.OneLine(result.Text(row, "statement_text"), catalog.Limit("statementChars")),
                    result.Text(row, "database_name") ?? (result.Int(row, "dbid") is { } dbid ? dbid.ToString(CultureInfo.InvariantCulture) : null)));
        }
    }

    /// <summary>The sample's rows in rank order, in the catalogue's column order.</summary>
    public List<LiveRow> Rows(QuerySample sample)
    {
        var rows = new List<LiveRow>(sample.Shown.Count);
        foreach (var group in sample.Shown)
        {
            var cells = writer.New();
            var windowed = sample.WindowMs is not null;
            // Per-execution values come from the window, or on a first sample from the plans' totals.
            var basis = windowed ? group.Window : group.Totals;
            var executions = basis[QueryStatement.Executions];
            double? Each(int total, double scale = 1) => executions > 0 ? basis[total] / executions / scale : null;
            double? Rate(int total, double perMs) => sample.WindowMs is { } ms ? group.Window[total] * perMs / ms : null;
            var shown = group.Shown;
            var text = texts.Get(shown.Key) ?? group.Statements.Select(statement => texts.Get(statement.Key)).FirstOrDefault(found => found?.Statement is not null);
            writer.Set(cells, "query", LiveCell.Of(text is null ? Loading : text.Statement));
            writer.Set(cells, "executionsPerMinute", ActivityRowWriter.Decimal(Rate(QueryStatement.Executions, 60_000), 1));
            writer.Set(cells, "cpuRate", ActivityRowWriter.Decimal(Rate(QueryStatement.Worker, 1), 1));
            writer.Set(cells, "avgCpuMs", ActivityRowWriter.Decimal(Each(QueryStatement.Worker, 1_000), 1));
            writer.Set(cells, "physicalReadsRate", ActivityRowWriter.Decimal(Rate(QueryStatement.PhysicalReads, 1_000), 1));
            writer.Set(cells, "logicalReadsRate", ActivityRowWriter.Decimal(Rate(QueryStatement.LogicalReads, 1_000), 1));
            writer.Set(cells, "logicalWritesRate", ActivityRowWriter.Decimal(Rate(QueryStatement.Writes, 1_000), 1));
            writer.Set(cells, "averageDurationMs", ActivityRowWriter.Decimal(Each(QueryStatement.Elapsed, 1_000), 1));
            writer.Set(cells, "maxDurationMs", ActivityRowWriter.Decimal(group.Statements.Max(statement => statement.MaxElapsedUs) / 1_000.0, 1));
            writer.Set(cells, "rowsPerExecution", ActivityRowWriter.Decimal(Each(QueryStatement.Rows), 1));
            writer.Set(cells, "avgGrantKb", ActivityRowWriter.Decimal(Each(QueryStatement.Grant), 1));
            writer.Set(cells, "spills", sample.Spills && windowed ? LiveCell.Of((long)group.Window[QueryStatement.Spills]) : LiveCell.Null);
            writer.Set(cells, "planCount", LiveCell.Of(group.Statements.Select(statement => statement.PlanHash ?? statement.Key).Distinct(StringComparer.Ordinal).Count()));
            writer.Set(cells, "database", LiveCell.Of(text?.Database));
            writer.Set(cells, "lastExecution", ActivityRowWriter.Time(shown.LastRun));
            writer.Set(cells, "cachedSince", ActivityRowWriter.Time(group.Statements.Min(statement => statement.Created)));
            writer.Set(cells, "queryHash", LiveCell.Of(group.Hash));
            rows.Add(new LiveRow(cells));
        }
        return rows;
    }
}
