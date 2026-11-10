using System.Buffers.Binary;
using System.Data.SqlTypes;
using System.Globalization;
using Varia.Backend.Live;

namespace Varia.Backend.Activity;

/// <summary>A map of at most <paramref name="capacity"/> entries that drops the one used least recently first: the query
/// statistics probe's kept totals and its text cache.</summary>
internal sealed class LruMap<TKey, TValue>(int capacity, IEqualityComparer<TKey>? comparer = null) where TKey : notnull
{
    private readonly Dictionary<TKey, LinkedListNode<(TKey Key, TValue Value)>> entries = new(comparer);
    private readonly LinkedList<(TKey Key, TValue Value)> order = new();

    public int Count => entries.Count;
    public bool Contains(TKey key) => entries.ContainsKey(key);
    /// <summary>Every entry, least recently used first; reading them uses none.</summary>
    public IEnumerable<TValue> Values => order.Select(entry => entry.Value);

    /// <summary>The key's value, which becomes the one used most recently.</summary>
    public bool TryGet(TKey key, out TValue value)
    {
        if (!entries.TryGetValue(key, out var node))
        {
            value = default!;
            return false;
        }
        order.Remove(node);
        order.AddLast(node);
        value = node.Value.Value;
        return true;
    }

    public void Set(TKey key, TValue value)
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

/// <summary>A statement of a cached plan: its sql_handle, offsets and plan_handle. The handles are the arrays the stats row
/// read, compared by content, so a key costs no text.</summary>
internal readonly struct StatementKey(byte[] sql, int start, int end, byte[]? plan) : IEquatable<StatementKey>
{
    public byte[] Sql { get; } = sql;
    public int Start { get; } = start;
    public int End { get; } = end;
    public byte[]? Plan { get; } = plan;

    public bool Equals(StatementKey other) => Start == other.Start && End == other.End && Sql.AsSpan().SequenceEqual(other.Sql)
        && (Plan is null ? other.Plan is null : other.Plan is not null && Plan.AsSpan().SequenceEqual(other.Plan));

    public override bool Equals(object? obj) => obj is StatementKey other && Equals(other);

    public override int GetHashCode()
    {
        var hash = new HashCode();
        hash.AddBytes(Sql);
        if (Plan is not null) hash.AddBytes(Plan);
        hash.Add(Start);
        hash.Add(End);
        return hash.ToHashCode();
    }
}

/// <summary>One sys.dm_exec_query_stats row as the query statistics probe reads it: a statement of a cached plan with its
/// query_hash and query_plan_hash (binary(8), kept as numbers) and its totals since the plan was cached.</summary>
internal sealed record QueryStatement(StatementKey Key, ulong Hash, ulong? PlanHash, DateTime? Created, DateTime? LastRun, double[] Totals, long? MaxElapsedUs, double[]? Last = null)
{
    /// <summary>When the last execution ended: its start (last_execution_time) plus its elapsed time.</summary>
    public DateTime? LastEnd => LastRun is { } start && Last is { } last ? start.AddTicks((long)last[Elapsed] * 10) : null;

    // Totals' places: execution_count, total_worker_time (µs), total_elapsed_time (µs), total_logical_reads, total_physical_reads,
    // total_logical_writes, total_rows, total_grant_kb, total_spills. Last holds the last execution's in the same places (one
    // execution).
    public const int Executions = 0, Worker = 1, Elapsed = 2, LogicalReads = 3, PhysicalReads = 4, Writes = 5, Rows = 6, Grant = 7, Spills = 8, Count = 9;

    /// <summary>A binary(8) hash as the grid shows it (0x and 16 hex digits).</summary>
    public static string HashText(ulong hash) => "0x" + hash.ToString("X16", CultureInfo.InvariantCulture);
}

/// <summary>A group of statements that share a query_hash, as one sample saw it: the window's change of each total (null
/// before a window exists), the plans' own totals, and its rank in the sample.</summary>
internal sealed class QueryGroup(ulong hash)
{
    public ulong Hash { get; } = hash;
    private readonly List<QueryStatement> statements = [];
    public IReadOnlyList<QueryStatement> Statements => statements;
    public double[] Window { get; } = new double[QueryStatement.Count];
    public double[] Totals { get; } = new double[QueryStatement.Count];
    /// <summary>The statement whose text and database the row shows: the group's most recent execution (the first of equals),
    /// kept as statements are added, since a group of ad hoc statements can hold thousands.</summary>
    public QueryStatement Shown { get; private set; } = null!;

    public void Add(QueryStatement statement)
    {
        statements.Add(statement);
        if (statements.Count == 1 || (statement.LastRun ?? DateTime.MinValue) > (Shown.LastRun ?? DateTime.MinValue)) Shown = statement;
    }
}

/// <summary>What one query statistics sample built: the groups the pane shows (ranked, at most shownHashes), how many more
/// there were, and the window in milliseconds the rates span (null on a first sample, which has no rates).</summary>
internal sealed record QuerySample(List<QueryGroup> Shown, long More, long? WindowMs, bool Spills);

/// <summary>A statement text the text statement reads into one of its slots.</summary>
internal readonly record struct QueryTextRequest(int Slot, QueryStatement Statement);

/// <summary>What the kept statements say about a query_hash: its distinct plans, the oldest plan's creation time and the
/// longest execution.</summary>
internal readonly record struct QueryFacts(int Plans, DateTime? CachedSince, long? MaxElapsedUs);

/// <summary>Per-statement totals between samples, at most <paramref name="capacity"/> statements (queryDeltaKeys), the one seen
/// least recently dropped first. A statement keeps its totals while it does not run (the stats statement reads every statement
/// whose last execution ended since the previous sample, so one it did not read did not run), and a later run's change is
/// measured from them. A plan cached again (another creation_time) or totals that went down start again, and so do totals kept
/// from before a sample whose rows were cut at queryStatsRows: that sample may have missed a run, whose work the next change
/// would charge to one window.</summary>
internal sealed class QueryDeltas(int capacity)
{
    private sealed record Baseline(double[] Totals, DateTime? Created, long Seen, ulong Hash, ulong? PlanHash, long? MaxElapsedUs);
    private readonly LruMap<StatementKey, Baseline> entries = new(capacity);
    private long sample;
    /// <summary>The latest sample whose rows were cut, and the one before the current sample: totals kept before it no longer
    /// apply.</summary>
    private long cut = -1, cutBefore = -1;

    public int Count => entries.Count;
    public bool Contains(StatementKey key) => entries.Contains(key);

    /// <summary>Starts a sample; <paramref name="cut"/> says its rows were cut, so totals kept from before it no longer apply.</summary>
    public void Next(bool cut)
    {
        cutBefore = this.cut;
        sample++;
        if (cut) this.cut = sample;
    }

    /// <summary>The totals' change since the statement's kept totals; all of them when there are none (or they no longer apply)
    /// and <paramref name="whole"/> says every execution of the plan falls in the window (it was cached since the previous
    /// sample); else null, unknown. Either way the totals are kept for the next sample.</summary>
    public double[]? Apply(QueryStatement statement, bool whole)
    {
        double[]? delta = null;
        var totals = statement.Totals;
        if (entries.TryGet(statement.Key, out var before) && Applies(before, statement)) delta = [.. totals.Zip(before.Totals, (now, then) => now - then)];
        if (delta is null && whole) delta = [.. totals];
        entries.Set(statement.Key, new(totals, statement.Created, sample, statement.Hash, statement.PlanHash, statement.MaxElapsedUs));
        return delta;
    }

    /// <summary>Whether kept totals measure the statement's change: kept since the latest cut sample before this one (an
    /// earlier one may have missed a run), from the same plan, and none of them larger now.</summary>
    private bool Applies(Baseline before, QueryStatement statement) =>
        before.Seen >= cutBefore && before.Created == statement.Created && statement.Totals.Zip(before.Totals).All(pair => pair.First >= pair.Second);

    /// <summary>The kept statements' facts for each of <paramref name="hashes"/>: every plan of the query the monitor has seen
    /// since it started reading, not only those that ran in the window.</summary>
    public Dictionary<ulong, QueryFacts> Facts(IReadOnlySet<ulong> hashes)
    {
        var plans = new Dictionary<ulong, (HashSet<ulong> Plans, int Unhashed, DateTime? Since, long? Max)>();
        foreach (var entry in entries.Values)
        {
            if (!hashes.Contains(entry.Hash)) continue;
            var known = plans.TryGetValue(entry.Hash, out var found) ? found : ([], 0, null, null);
            if (entry.PlanHash is { } plan) known.Plans.Add(plan);
            else known.Unhashed++;
            if (entry.Created is { } created && (known.Since is not { } since || created < since)) known.Since = created;
            if (entry.MaxElapsedUs is { } max && (known.Max is not { } most || max > most)) known.Max = max;
            plans[entry.Hash] = known;
        }
        return plans.ToDictionary(pair => pair.Key, pair => new QueryFacts(pair.Value.Plans.Count + pair.Value.Unhashed, pair.Value.Since, pair.Value.Max));
    }

    public void Clear()
    {
        entries.Clear();
        cut = cutBefore = -1;
    }
}

/// <summary>A statement's text and database, or nulls for one SQL Server no longer has (the plan left the cache).</summary>
internal sealed record QueryText(string? Statement, string? Database);

/// <summary>The query statistics probe's rows (Recent Expensive Queries), built from its statements' results. The stats
/// statement reads the statements whose last execution ended since the previous sample (a long one that started before it
/// included); each statement's change since its kept totals (<see cref="QueryDeltas"/>) is summed per query_hash, so a sum
/// never depends on which rows a window happens to include. Rates span the window since the previous sample, on the probe's
/// sample clock. A first sample (after a baseline, a resume, a restart or a lost connection) has no window: it shows the groups
/// that ran in the last <see cref="FirstLookback"/> ranked by their plans' totals, with blank rates and per-execution values
/// from those totals. Later samples show the groups that ran in the window, ranked by its CPU. Texts come from a cache filled
/// for the shown rows, textBatch per text statement and textBatchesPerTick statements per sample, most expensive first; a row
/// whose text has not arrived says <see cref="Loading"/>, and one whose text the login may not read stays blank. Pure apart
/// from those baselines and the cache, so the offline checks feed it rows. Nothing is logged.</summary>
internal sealed class ActivityQueryRows(ActivityCatalog catalog)
{
    public const string Loading = "Loading text…";
    /// <summary>How far back a first sample reads: the plan cache's recent statements, which also become the baselines.</summary>
    public static readonly TimeSpan FirstLookback = TimeSpan.FromMinutes(10);
    /// <summary>How far before the previous sample's clock a later sample reads: GETDATE() and the times the statistics keep are
    /// datetime (3 ms steps), and the stats statement rounds an execution's end up to the second.</summary>
    public static readonly TimeSpan Overlap = TimeSpan.FromSeconds(2);
    private static readonly DateTime SqlMin = SqlDateTime.MinValue.Value;
    private readonly ActivityRowWriter writer = new(catalog.Table("recentQueries"));
    private readonly QueryDeltas deltas = new((int)catalog.Limit("queryDeltaKeys"));
    private readonly LruMap<StatementKey, QueryText> texts = new((int)catalog.Limit("textCache"));
    /// <summary>The rows the last <see cref="Rows"/> built whose text had not arrived: the filter box does not match the
    /// placeholder. A new set each sample, so a predicate built from one never sees another's rows.</summary>
    private HashSet<LiveRow> loading = new(ReferenceEqualityComparer.Instance);
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

    /// <summary>The stats statement's @since for a sample whose clock statement read <paramref name="now"/> (the server's local
    /// time): the previous sample's server time less <see cref="Overlap"/>, which the stats statement compares with each
    /// statement's last execution's end; a first sample reads <see cref="FirstLookback"/>. When the server's local time stepped
    /// back past the previous sample's (daylight saving ended, the clock was set back), the times the statistics kept before
    /// the step look later than any since, so no window can be measured from them: the sample starts again as a first sample.</summary>
    public DateTime Since(DateTime? now)
    {
        if (previous is { Local: { } before } && now is { } moved && moved < before - Overlap) Reset();
        DateTime since;
        if (previous is { Local: { } then }) since = then - Overlap;
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
        var cap = (int)catalog.Limit("queryStatsRows");
        // Statistics rows past their cap are a cut: the window's sums miss what was not read, and so would the next one's.
        var truncated = stats.Rows.Count > cap;
        deltas.Next(truncated);
        var groups = new Dictionary<ulong, QueryGroup>();
        var seen = new HashSet<StatementKey>();
        foreach (var row in stats.Rows.Take(cap))
        {
            if (Read(stats, row, spills) is not { } statement || !seen.Add(statement.Key)) continue;
            // A plan cached since the previous sample (and not after the server's clock: a time from before a step back) ran
            // wholly in the window. Any other statement without kept totals that apply counts its last execution, which ended in
            // the window; earlier runs in the window are not known, and its next runs count from the totals kept now.
            var delta = deltas.Apply(statement, whole: cachedAfter is { } cutoff && statement.Created >= cutoff && (now is not { } clock || statement.Created <= clock + Overlap));
            if (delta is null && cachedAfter is { } after && statement.LastEnd >= after && (now is not { } read || statement.LastEnd <= read + Overlap)) delta = statement.Last;
            if (!groups.TryGetValue(statement.Hash, out var group)) groups[statement.Hash] = group = new(statement.Hash);
            group.Add(statement);
            for (var i = 0; i < QueryStatement.Count; i++)
            {
                group.Totals[i] += statement.Totals[i];
                if (window is not null && delta is not null) group.Window[i] += delta[i];
            }
        }
        IOrderedEnumerable<QueryGroup> candidates = window is null
            ? groups.Values.OrderByDescending(group => group.Totals[QueryStatement.Worker])
            : groups.Values.Where(group => group.Window[QueryStatement.Executions] > 0).OrderByDescending(group => group.Window[QueryStatement.Worker]);
        var ranked = candidates.ThenByDescending(group => group.Shown.LastRun ?? DateTime.MinValue).ThenBy(group => group.Hash).ToList();
        var shownCap = (int)catalog.Limit("shownHashes");
        previous = (at, now ?? previous?.Local);
        var more = Math.Max(ranked.Count - shownCap, truncated ? 1 : 0);
        return new([.. ranked.Take(shownCap)], more, window, spills);
    }

    private static QueryStatement? Read(ActivityResult stats, object?[] row, bool spills)
    {
        if (stats.Bytes(row, "query_hash") is not { Length: 8 } hash || stats.Bytes(row, "sql_handle") is not { } sql) return null;
        var planHash = stats.Bytes(row, "query_plan_hash") is { Length: 8 } plan ? BinaryPrimitives.ReadUInt64BigEndian(plan) : (ulong?)null;
        var key = new StatementKey(sql, stats.Int(row, "statement_start_offset") ?? 0, stats.Int(row, "statement_end_offset") ?? -1, stats.Bytes(row, "plan_handle"));
        double[] totals =
        [
            stats.Double(row, "execution_count") ?? 0, stats.Double(row, "total_worker_time") ?? 0, stats.Double(row, "total_elapsed_time") ?? 0, stats.Double(row, "total_logical_reads") ?? 0,
            stats.Double(row, "total_physical_reads") ?? 0, stats.Double(row, "total_logical_writes") ?? 0, stats.Double(row, "total_rows") ?? 0, stats.Double(row, "total_grant_kb") ?? 0,
            spills ? stats.Double(row, "total_spills") ?? 0 : 0
        ];
        double[] last =
        [
            1, stats.Double(row, "last_worker_time") ?? 0, stats.Double(row, "last_elapsed_time") ?? 0, stats.Double(row, "last_logical_reads") ?? 0,
            stats.Double(row, "last_physical_reads") ?? 0, stats.Double(row, "last_logical_writes") ?? 0, stats.Double(row, "last_rows") ?? 0, stats.Double(row, "last_grant_kb") ?? 0,
            spills ? stats.Double(row, "last_spills") ?? 0 : 0
        ];
        return new(key, BinaryPrimitives.ReadUInt64BigEndian(hash), planHash, stats.Time(row, "creation_time"), stats.Time(row, "last_execution_time"), totals, stats.Long(row, "max_elapsed_time"), last);
    }

    /// <summary>The shown rows' statements whose text is not cached, most expensive first, in text statements of textBatch slots,
    /// at most textBatchesPerTick of them.</summary>
    public List<QueryTextRequest[]> TextBatches(QuerySample sample)
    {
        var size = (int)Math.Min(catalog.Limit("textBatch"), ActivitySql.TextSlots);
        var wanted = new List<QueryStatement>();
        var keys = new HashSet<StatementKey>();
        foreach (var group in sample.Shown)
        {
            // The row's statement first; when SQL Server no longer has its text, another statement of the group whose text it
            // may have, so the row is not left blank while one exists.
            if (group.Statements.Any(statement => texts.Contains(statement.Key) && Text(statement.Key)?.Statement is not null)) continue;
            var shown = group.Shown;
            var next = !texts.Contains(shown.Key) ? shown : group.Statements.FirstOrDefault(statement => !texts.Contains(statement.Key));
            if (next is not null && keys.Add(next.Key)) wanted.Add(next);
        }
        return [.. wanted.Take(size * (int)catalog.Limit("textBatchesPerTick")).Chunk(size).Select(chunk => chunk.Select((statement, slot) => new QueryTextRequest(slot, statement)).ToArray())];
    }

    /// <summary>The text statement's parameter values for a batch: each slot's handles and offsets, unused slots NULL.</summary>
    public static Func<ActivityParameter, object> TextValues(QueryTextRequest[] batch) => parameter =>
    {
        var slot = int.Parse(parameter.Name.AsSpan(2), CultureInfo.InvariantCulture);
        if (slot >= batch.Length) return DBNull.Value;
        var key = batch[slot].Statement.Key;
        return parameter.Name[1] switch
        {
            'h' => key.Sql,
            'p' => (object?)key.Plan ?? DBNull.Value,
            's' => key.Start,
            'e' => key.End,
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

    private QueryText? Text(StatementKey key) => texts.TryGet(key, out var text) ? text : null;

    /// <summary>The cells the filter box tests for each row of the last <see cref="Rows"/>: a row still loading its text has
    /// no text to match.</summary>
    public Func<LiveRow, Func<string, string?>> FilterCells()
    {
        var waiting = loading;
        return row =>
        {
            var cells = writer.Reader(row);
            return waiting.Contains(row) ? column => column == "query" ? null : cells(column) : cells;
        };
    }

    /// <summary>The sample's rows in rank order, in the catalogue's column order. <paramref name="textsRefused"/> says the login
    /// may not read statement texts, so a row without one stays blank rather than loading.</summary>
    public List<LiveRow> Rows(QuerySample sample, bool textsRefused = false)
    {
        var rows = new List<LiveRow>(sample.Shown.Count);
        loading = new(ReferenceEqualityComparer.Instance);
        var facts = deltas.Facts(sample.Shown.Select(group => group.Hash).ToHashSet());
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
            // The row's statement's text, else (SQL Server no longer has it) another statement's of the group. A row loads while
            // a statement of the group has no text asked for yet.
            var own = Text(shown.Key);
            var text = own?.Statement is not null ? own : group.Statements.Select(statement => Text(statement.Key)).FirstOrDefault(found => found?.Statement is not null) ?? own;
            var waiting = text?.Statement is null && !textsRefused && group.Statements.Any(statement => !texts.Contains(statement.Key));
            var known = facts.GetValueOrDefault(group.Hash);
            writer.Set(cells, "query", LiveCell.Of(waiting ? Loading : text?.Statement));
            writer.Set(cells, "executionsPerMinute", ActivityRowWriter.Decimal(Rate(QueryStatement.Executions, 60_000), 1));
            writer.Set(cells, "cpuRate", ActivityRowWriter.Decimal(Rate(QueryStatement.Worker, 1), 1));
            writer.Set(cells, "avgCpuMs", ActivityRowWriter.Decimal(Each(QueryStatement.Worker, 1_000), 1));
            writer.Set(cells, "physicalReadsRate", ActivityRowWriter.Decimal(Rate(QueryStatement.PhysicalReads, 1_000), 1));
            writer.Set(cells, "logicalReadsRate", ActivityRowWriter.Decimal(Rate(QueryStatement.LogicalReads, 1_000), 1));
            writer.Set(cells, "logicalWritesRate", ActivityRowWriter.Decimal(Rate(QueryStatement.Writes, 1_000), 1));
            writer.Set(cells, "averageDurationMs", ActivityRowWriter.Decimal(Each(QueryStatement.Elapsed, 1_000), 1));
            writer.Set(cells, "maxDurationMs", ActivityRowWriter.Decimal(known.MaxElapsedUs / 1_000.0, 1));
            writer.Set(cells, "rowsPerExecution", ActivityRowWriter.Decimal(Each(QueryStatement.Rows), 1));
            writer.Set(cells, "avgGrantKb", ActivityRowWriter.Decimal(Each(QueryStatement.Grant), 1));
            writer.Set(cells, "spills", sample.Spills && windowed ? LiveCell.Of((long)group.Window[QueryStatement.Spills]) : LiveCell.Null);
            writer.Set(cells, "planCount", LiveCell.Of(known.Plans));
            writer.Set(cells, "database", LiveCell.Of(text?.Database));
            writer.Set(cells, "lastExecution", ActivityRowWriter.Time(shown.LastRun));
            writer.Set(cells, "cachedSince", ActivityRowWriter.Time(known.CachedSince));
            writer.Set(cells, "queryHash", LiveCell.Of(QueryStatement.HashText(group.Hash)));
            var row = new LiveRow(cells);
            if (waiting) loading.Add(row);
            rows.Add(row);
        }
        return rows;
    }
}
