using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Results;

namespace Varia.Backend.Live;

/// <summary>One cell of a live row: the value it sorts by (a long, double, decimal, DateTime, DateTimeOffset, Guid or
/// string; null for NULL) and its display text, exactly what a query of the same value shows (CellFormat), so a stored
/// live table reads, copies and saves like a query result and a key the worker reads equals the backend's.</summary>
internal readonly record struct LiveCell(object? Value, string? Text, bool Truncated = false)
{
    public static readonly LiveCell Null = new(null, null);

    public bool IsNull => Text is null;

    public static LiveCell Of(long value)
    {
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        return new(value, Ascii(buffer[..CellFormat.WriteInteger(buffer, value)]));
    }

    public static LiveCell Of(long? value) => value is { } some ? Of(some) : Null;

    /// <summary>bit: 1 or 0, as SSMS shows it; sorts as 0 and 1.</summary>
    public static LiveCell Bit(bool value) => new(value ? 1L : 0L, value ? "1" : "0");

    public static LiveCell Of(double value)
    {
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        return new(value, Ascii(buffer[..CellFormat.WriteFloat(buffer, value)]));
    }

    /// <summary>real: 7 significant digits, as SSMS shows them.</summary>
    public static LiveCell Real(float value)
    {
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        return new((double)value, Ascii(buffer[..CellFormat.WriteReal(buffer, value)]));
    }

    public static LiveCell Of(decimal value)
    {
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        return new(value, Ascii(buffer[..CellFormat.WriteDecimal(buffer, value)]));
    }

    /// <summary>datetime2(<paramref name="scale"/>).</summary>
    public static LiveCell DateTime2(DateTime value, int scale = 7)
    {
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        return new(value, Ascii(buffer[..CellFormat.WriteDateTime2(buffer, value, scale)]));
    }

    /// <summary>datetime: milliseconds, as SSMS shows them.</summary>
    public static LiveCell DateTime(DateTime value)
    {
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        return new(value, Ascii(buffer[..CellFormat.WriteDateTime(buffer, value)]));
    }

    public static LiveCell Offset(DateTimeOffset value, int scale = 7)
    {
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        return new(value, Ascii(buffer[..CellFormat.WriteDateTimeOffset(buffer, value, scale)]));
    }

    public static LiveCell Of(Guid value)
    {
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        return new(value, Ascii(buffer[..CellFormat.WriteGuid(buffer, value)]));
    }

    /// <summary>Text, cut at the stored cell cap (65,535 characters) and then marked truncated, as a query's would be.</summary>
    public static LiveCell Of(string? value)
    {
        if (value is null) return Null;
        var text = CellFormat.Prefix(value, ColumnPlan.TextCap, out var truncated);
        return truncated ? new(text.ToString(), text.ToString(), true) : new(value, value);
    }

    private static string Ascii(ReadOnlySpan<byte> bytes) => Encoding.ASCII.GetString(bytes);

    /// <summary>NULL first (as ORDER BY sorts it ascending), then by value: numbers as numbers, text case-insensitively and
    /// then exactly, so the order is total.</summary>
    public static int Compare(LiveCell a, LiveCell b)
    {
        if (a.Value is null || b.Value is null) return (a.Value is null ? 0 : 1) - (b.Value is null ? 0 : 1);
        if (a.Value is string x && b.Value is string y)
        {
            var order = string.Compare(x, y, StringComparison.OrdinalIgnoreCase);
            return order != 0 ? order : string.CompareOrdinal(x, y);
        }
        if (a.Value.GetType() == b.Value.GetType() && a.Value is IComparable comparable) return comparable.CompareTo(b.Value);
        if (IsNumber(a.Value) && IsNumber(b.Value)) return Convert.ToDouble(a.Value, CultureInfo.InvariantCulture).CompareTo(Convert.ToDouble(b.Value, CultureInfo.InvariantCulture));
        return string.CompareOrdinal(a.Text, b.Text);
    }

    private static bool IsNumber(object value) => value is long or int or double or decimal or float;
}

/// <summary>Reads a live table's cells from SQL Server by the catalogue's declared type, as a query's reader would show them.</summary>
internal static class LiveCells
{
    private static readonly string[] Integers = ["tinyint", "smallint", "int", "bigint"];
    private static readonly string[] Texts = ["nvarchar", "varchar", "nchar", "char", "sysname"];
    private static readonly string[] Others = ["bit", "float", "real", "decimal", "numeric", "datetime", "datetime2", "datetimeoffset", "uniqueidentifier"];

    /// <summary>The SQL types a live table stores (the catalogue's dataType names).</summary>
    public static bool Supports(string dataType) => Integers.Contains(dataType) || Texts.Contains(dataType) || Others.Contains(dataType);

    /// <summary>Whether the type a reader reports is the declared one (sysname reports as nvarchar).</summary>
    public static bool Matches(string declared, string reported) =>
        string.Equals(declared, reported, StringComparison.OrdinalIgnoreCase) || declared == "sysname" && string.Equals(reported, "nvarchar", StringComparison.OrdinalIgnoreCase);

    /// <param name="scale">The column's fractional seconds (datetime2, datetimeoffset), from its schema.</param>
    public static LiveCell Read(SqlDataReader reader, int ordinal, string dataType, int scale)
    {
        if (reader.IsDBNull(ordinal)) return LiveCell.Null;
        return dataType switch
        {
            _ when Integers.Contains(dataType) => LiveCell.Of(Convert.ToInt64(reader.GetValue(ordinal), CultureInfo.InvariantCulture)),
            _ when Texts.Contains(dataType) => LiveCell.Of(reader.GetString(ordinal)),
            "bit" => LiveCell.Bit(reader.GetBoolean(ordinal)),
            "float" => LiveCell.Of(reader.GetDouble(ordinal)),
            "real" => LiveCell.Real(reader.GetFloat(ordinal)),
            "decimal" or "numeric" => LiveCell.Of(reader.GetDecimal(ordinal)),
            "datetime" => LiveCell.DateTime(reader.GetDateTime(ordinal)),
            "datetime2" => LiveCell.DateTime2(reader.GetDateTime(ordinal), scale),
            "datetimeoffset" => LiveCell.Offset(reader.GetDateTimeOffset(ordinal), scale),
            "uniqueidentifier" => LiveCell.Of(reader.GetGuid(ordinal)),
            _ => throw new RequestException("BACKEND_ERROR", "A live table declares a type it cannot store.")
        };
    }
}

/// <summary>One row of a live table: its cells in the catalogue's column order.</summary>
internal sealed class LiveRow(LiveCell[] cells)
{
    public LiveCell[] Cells { get; } = cells;

    /// <summary>The row's key (docs/ipc.md, Live subscriptions): its key cells' texts joined with U+001F, NULL as empty.</summary>
    public string Key(int[] columns)
    {
        if (columns.Length == 1) return Cells[columns[0]].Text ?? "";
        return string.Join('\u001f', columns.Select(column => Cells[column].Text ?? ""));
    }
}

/// <summary>A table write's outcome: the sample (null when nothing was stored or nothing changed) and whether the budget cut
/// it (the probe then reports BUDGET for this table).</summary>
internal readonly record struct LiveTableWrite<T>(T? Sample, bool Budget) where T : class;

/// <summary>What a snapshot revision applies to the source's rows: the user's sort (catalogue column ids; the key breaks
/// ties), a filter on stored cell text, the probe's row view (a predicate the source gives for the chosen view id) and the
/// latest track list.</summary>
internal sealed record LiveSnapshotSettings(LiveSortArgs[]? Sort = null, LiveFilterArgs? Filter = null, Func<LiveRow, bool>? View = null, LiveTrackArgs? Track = null);

/// <summary>The stored tables of one subscription (docs/ipc.md, Live subscriptions, Tables): every snapshot and append table
/// of its probes, created on first use, sharing one memory limit (64 MiB, LiveBudget) within the live share of the result
/// budget, and a per-tick allowance of facet text. Each revision or segment is its own stored result with its own
/// QueryBudget, so one that did not fit never stops later ones. Used from the subscription's one sampling task only.</summary>
internal sealed class LiveTableSet(ResultStore store, string subscriptionId, LiveLimitsJson limits)
{
    private readonly Dictionary<(string Probe, int Table), LiveSnapshotTable> snapshots = [];
    private readonly Dictionary<(string Probe, int Table), LiveAppendTable> appends = [];
    private int facetBytes = limits.FacetBytes;

    public ResultStore Store => store;
    public LiveLimitsJson Limits => limits;
    public LiveBudget Budget { get; } = new(limits.SubscriptionBytes);
    public string Session { get; } = "live:" + subscriptionId;

    public QueryBudget NewBudget() => new(Session, Budget);

    public LiveSnapshotTable Snapshot(LiveProbeJson probe, int index)
    {
        if (!snapshots.TryGetValue((probe.Id, index), out var table)) snapshots[(probe.Id, index)] = table = new(this, probe.Tables[index], index);
        return table;
    }

    public LiveAppendTable Append(LiveProbeJson probe, int index)
    {
        if (!appends.TryGetValue((probe.Id, index), out var table)) appends[(probe.Id, index)] = table = new(this, probe.Tables[index], index);
        return table;
    }

    public LiveAppendTable? FindAppend(string probe, int index) => appends.GetValueOrDefault((probe, index));

    /// <summary>Starts a tick: the facet allowance (limits.live.facetBytes of UTF-8 text) is whole again.</summary>
    public void BeginTick() => facetBytes = limits.FacetBytes;

    /// <summary>Takes up to <paramref name="bytes"/> of the tick's facet allowance; false when it is spent.</summary>
    internal bool TakeFacetBytes(int bytes)
    {
        if (bytes > facetBytes) return false;
        facetBytes -= bytes;
        return true;
    }

    /// <summary>Where every started append table goes on from (a resume token's cursors).</summary>
    public List<LiveCursor> Cursors() => [.. appends.Where(item => item.Value.Started).Select(item => new LiveCursor(item.Key.Probe, item.Key.Table, item.Value.SettledId))];

    /// <summary>On sourceEnded: the results that stay readable, at most <paramref name="max"/>: each snapshot's newest revision and
    /// each append table's newest segment first, then the older segments while there is room. The rest are released.</summary>
    public uint[] Keep(int max)
    {
        var first = new List<uint>();
        var rest = new List<uint>();
        foreach (var table in snapshots.Values) table.Keep(first, rest);
        foreach (var table in appends.Values) table.Keep(first, rest);
        var kept = first.Concat(rest).Take(max).ToArray();
        store.Release(first.Concat(rest).Skip(max));
        return kept;
    }

    /// <summary>Every result the tables stored (never anything else stored under the session name).</summary>
    public void Release()
    {
        var ids = new List<uint>();
        foreach (var table in snapshots.Values) ids.AddRange(table.Drain());
        foreach (var table in appends.Values) ids.AddRange(table.Drain());
        store.Release(ids);
    }

    /// <summary>The result columns of a catalogue table: every cell is text, as its display.</summary>
    internal static (List<ResultColumn> Columns, WireKind[] Wires) Shape(LiveTableJson spec) =>
        ([.. spec.Columns.Select(column => new ResultColumn(column.Name, column.DataType, "text", Nullable: true))], [.. spec.Columns.Select(_ => WireKind.Text)]);

    /// <summary>Writes one row; false when the set stores nothing more (released, or out of budget).</summary>
    internal static bool Write(ResultSetBuffer set, LiveRow row)
    {
        set.CountRow();
        if (set.BeginRow() is not { } builder) return false;
        var truncated = 0;
        foreach (var cell in row.Cells)
        {
            if (cell.Text is null) builder.AppendNull();
            else builder.AppendText(cell.Text, cell.Truncated);
            if (cell.Truncated) truncated++;
        }
        return set.TryCommitRow(truncated);
    }

    internal static bool OverBudget(TruncationReason reason) => reason is TruncationReason.QueryBudget or TruncationReason.GlobalBudget or TruncationReason.SystemMemory;
}

/// <summary>A snapshot table (docs/ipc.md, Live subscriptions, Tables): each write is a new stored result (a revision) built
/// from the rows the source gave, whether a query read them or the source holds them. Two revisions stay readable: the
/// newest, and the one before, which the renderer may still show until it applies the newest (stop and wait means it has
/// applied that one before the next is written), so writing revision k+1 first releases k−1 and names it retired. A write
/// filters (the view, then the text filter), keeps a tracked row that left the source for one more revision (a table with
/// departed rows), sorts (the user's keys, then the key, so equal values never trade places), cuts at the row cap, and
/// reports the diff against the previous revision, where each tracked key went, and the facets when they changed.</summary>
internal sealed class LiveSnapshotTable
{
    private readonly LiveTableSet owner;
    private readonly LiveTableJson spec;
    private readonly int index;
    private readonly int[] key;
    private readonly int rowCap;
    private readonly List<ResultSetBuffer> revisions = [];
    /// <summary>Released before a revision that then did not fit: the next stored revision names them retired.</summary>
    private readonly List<uint> retiring = [];
    // The previous revision as the next one needs it: each key's row and a hash of its cells (for the diff), the keys that
    // were departed and, only in a table that keeps departed rows, the rows themselves (the renderer may track a key after
    // the revision that held it). Holding no more keeps a large snapshot's cells short-lived. The working collections are
    // kept and cleared rather than allocated each sample: at thousands of rows they are large objects, whose churn would run
    // gen2 collections.
    private Dictionary<string, (int Index, ulong Hash)> previousRows = new(StringComparer.Ordinal);
    private Dictionary<string, (int Index, ulong Hash)> currentRows = new(StringComparer.Ordinal);
    private List<LiveRow> previousList = [], currentList = [];
    private readonly HashSet<string> previousDeparted = new(StringComparer.Ordinal);
    private readonly HashSet<string> present = new(StringComparer.Ordinal);
    private readonly List<(LiveRow Row, bool Departed, int At)> rows = [];
    private List<LiveFacet>? sentFacets;
    private long revision;

    public LiveSnapshotTable(LiveTableSet owner, LiveTableJson spec, int index)
    {
        if (spec.Mode != "snapshot") throw new ArgumentException("Not a snapshot table.", nameof(spec));
        this.owner = owner;
        this.spec = spec;
        this.index = index;
        key = [.. spec.Key.Select(id => spec.Columns.FindIndex(column => column.Id == id))];
        rowCap = Math.Clamp(spec.RowCap > 0 ? spec.RowCap : owner.Limits.SnapshotRows, 1, owner.Limits.SnapshotRows);
    }

    public long Revision => revision;

    /// <param name="more">Rows the source read past its cap and left out: the revision counts them as cut (rowLimit).</param>
    public LiveTableWrite<LiveSnapshotSample> Write(IReadOnlyList<LiveRow> source, LiveSnapshotSettings settings, long more = 0)
    {
        var keyed = key.Length > 0;
        var facets = spec.Facets is { Count: > 0 } named ? Facets(source, named) : null;
        var lingers = spec.Departed && keyed && settings.Track is not null;
        present.Clear();
        if (lingers) foreach (var row in source) present.Add(row.Key(key));
        var filter = Filter(settings.Filter);
        rows.Clear();
        foreach (var row in source) if ((settings.View?.Invoke(row) ?? true) && filter(row)) rows.Add((row, false, rows.Count));
        if (lingers)
        {
            // A tracked row that left the source (not one the view or filter hides) stays one revision, at the row it had.
            foreach (var tracked in settings.Track!.Keys.Distinct(StringComparer.Ordinal))
            {
                if (present.Contains(tracked) || previousDeparted.Contains(tracked) || !previousRows.TryGetValue(tracked, out var at) || at.Index >= previousList.Count) continue;
                rows.Insert(Math.Min(at.Index, rows.Count), (previousList[at.Index], true, 0));
            }
            for (var i = 0; i < rows.Count; i++) rows[i] = rows[i] with { At = i };
        }
        if (settings.Sort is { Length: > 0 } sort)
        {
            var columns = sort.Select(item => (Index: spec.Columns.FindIndex(column => column.Id == item.Column), item.Descending)).Where(item => item.Index >= 0).ToArray();
            rows.Sort((a, b) =>
            {
                foreach (var (column, descending) in columns)
                {
                    var order = LiveCell.Compare(a.Row.Cells[column], b.Row.Cells[column]);
                    if (order != 0) return descending ? -order : order;
                }
                foreach (var column in key)
                {
                    var order = LiveCell.Compare(a.Row.Cells[column], b.Row.Cells[column]);
                    if (order != 0) return order;
                }
                return a.At.CompareTo(b.At);
            });
        }

        // The revision before the previous one goes first: its memory is then free for this one.
        if (revisions.Count >= 2)
        {
            retiring.Add(revisions[0].ResultId);
            owner.Store.Release(revisions[0].ResultId);
            revisions.RemoveAt(0);
        }
        var (columnsOf, wires) = LiveTableSet.Shape(spec);
        if (owner.Store.Open(owner.NewBudget(), 0, 1, 1, "rows", columnsOf, wires) is not { } set) return new(null, true);
        revisions.Add(set);
        var stored = 0;
        foreach (var item in rows)
        {
            if (stored >= rowCap)
            {
                set.CountRow();
                set.Skip(TruncationReason.RowLimit);
                continue;
            }
            if (!LiveTableSet.Write(set, item.Row)) break;
            stored++;
        }
        for (var i = 0L; i < more; i++) set.CountRow();
        if (more > 0) set.Skip(TruncationReason.RowLimit);
        set.Complete();
        revision++;

        var rowsByKey = currentRows;
        rowsByKey.Clear();
        var departed = new List<int>();
        previousDeparted.Clear();
        if (keyed)
        {
            for (var at = 0; at < stored; at++)
            {
                var text = rows[at].Row.Key(key);
                rowsByKey.TryAdd(text, (at, Hash(rows[at].Row)));
                if (rows[at].Departed && departed.Count < owner.Limits.TrackedKeys)
                {
                    departed.Add(at);
                    previousDeparted.Add(text);
                }
            }
        }
        LiveDiff? diff = null;
        if (keyed && revision > 1)
        {
            int added = 0, changed = 0, removed = 0;
            foreach (var (text, (_, hash)) in rowsByKey)
            {
                if (!previousRows.TryGetValue(text, out var before)) added++;
                else if (before.Hash != hash) changed++;
            }
            foreach (var text in previousRows.Keys) if (!rowsByKey.ContainsKey(text)) removed++;
            diff = new(added, removed, changed);
        }
        var trackedRows = keyed && settings.Track is { } list ? new LiveTracked(list.Seq, [.. list.Keys.Select(text => rowsByKey.TryGetValue(text, out var at) ? at.Index : -1)]) : null;
        List<LiveFacet>? changedFacets = null;
        if (facets is not null)
        {
            changedFacets = [.. facets.Where(facet => sentFacets?.Find(sent => sent.Column == facet.Column) is not { } sent || !SameFacet(sent, facet))];
            if (changedFacets.Count == 0) changedFacets = null;
            sentFacets = facets;
        }
        currentList.Clear();
        if (spec.Departed) for (var at = 0; at < stored; at++) currentList.Add(rows[at].Row);
        (previousList, currentList) = (currentList, previousList);
        currentList.Clear();
        (previousRows, currentRows) = (rowsByKey, previousRows);
        // The rows go with this sample: nothing here keeps the source's cells alive until the next one.
        rows.Clear();
        present.Clear();
        uint[]? retired = retiring.Count > 0 ? [.. retiring] : null;
        retiring.Clear();
        return new(new LiveSnapshotSample(index, set.Describe(), revision, retired, diff, trackedRows, departed.Count > 0 ? [.. departed] : null, changedFacets),
            LiveTableSet.OverBudget(set.Truncated));
    }

    private Func<LiveRow, bool> Filter(LiveFilterArgs? filter)
    {
        if (filter?.Text is not { Length: > 0 } text) return _ => true;
        // Named columns of another of the probe's tables leave this one unfiltered.
        int[] columns = filter.Columns is { Length: > 0 } named
            ? [.. named.Select(id => spec.Columns.FindIndex(column => column.Id == id)).Where(at => at >= 0)]
            : [.. Enumerable.Range(0, spec.Columns.Count)];
        if (columns.Length == 0) return _ => true;
        return row => columns.Any(column => row.Cells[column].Text?.Contains(text, StringComparison.OrdinalIgnoreCase) == true);
    }

    /// <summary>Each facet column's distinct values over every row the source gave (NULL left out), most frequent first,
    /// each cut at the facet text cap, at most the facet value count, within what is left of the tick's facet text.</summary>
    private List<LiveFacet> Facets(IReadOnlyList<LiveRow> source, List<string> named)
    {
        var limits = owner.Limits;
        var facets = new List<LiveFacet>();
        foreach (var id in named.Take(limits.FacetColumns))
        {
            var column = spec.Columns.FindIndex(item => item.Id == id);
            if (column < 0) continue;
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var row in source)
            {
                if (row.Cells[column].Text is not { } text) continue;
                var value = CellFormat.Prefix(text, limits.FacetCharacters, out _).ToString();
                counts[value] = counts.GetValueOrDefault(value) + 1;
            }
            var values = new List<LiveFacetValue>();
            var more = false;
            foreach (var (text, count) in counts.OrderByDescending(item => item.Value).ThenBy(item => item.Key, StringComparer.Ordinal))
            {
                if (values.Count >= limits.FacetValues || !owner.TakeFacetBytes(Encoding.UTF8.GetByteCount(text)))
                {
                    more = true;
                    break;
                }
                values.Add(new(text, count));
            }
            facets.Add(new(id, values, more ? true : null));
        }
        return facets;
    }

    private static bool SameFacet(LiveFacet a, LiveFacet b) => a.More == b.More && a.Values.SequenceEqual(b.Values);

    /// <summary>A 64-bit FNV-1a hash of a row's cell texts (NULL distinct from empty text): whether a kept key's cells changed.</summary>
    private static ulong Hash(LiveRow row)
    {
        var hash = 14695981039346656037UL;
        foreach (var cell in row.Cells)
        {
            if (cell.Text is { } text) foreach (var unit in text) hash = (hash ^ unit) * 1099511628211UL;
            else hash = (hash ^ 0x1_0000) * 1099511628211UL;
            hash = (hash ^ 0x1_0001) * 1099511628211UL;
        }
        return hash;
    }

    internal void Keep(List<uint> first, List<uint> rest)
    {
        if (revisions.Count == 0) return;
        foreach (var older in revisions.Take(revisions.Count - 1)) owner.Store.Release(older.ResultId);
        first.Add(revisions[^1].ResultId);
        revisions.RemoveRange(0, revisions.Count - 1);
    }

    internal uint[] Drain()
    {
        uint[] ids = [.. revisions.Select(set => set.ResultId)];
        revisions.Clear();
        return ids;
    }
}

/// <summary>An append table (docs/ipc.md, Live subscriptions, Tables): one stored result (a segment) that grows by the rows a
/// source reads above the highest id it has settled, ordered by id. Ids are assigned at insert, not commit, so a lower id
/// can appear after a higher one (under READ COMMITTED, or READ UNCOMMITTED for an instant): every read covers all
/// unsettled ids again (the source reads <see cref="ReadRows"/> rows above <see cref="SettledId"/>), and rows already
/// appended are skipped by id. An id settles once first seen the catalogue's ticks and milliseconds ago; the remembered ids
/// stay within twice the rows a tick reads (the lowest settle early past that). A late row is appended in arrival order.
/// Each write seals what it appended, so the rows are readable at once. A segment rolls to a new one at its row or byte cap,
/// keeping the newest two; a new start (another filter or args) retires every segment and starts again.</summary>
internal sealed class LiveAppendTable
{
    private readonly LiveTableSet owner;
    private readonly LiveTableJson spec;
    private readonly int index;
    private readonly int key;
    private readonly int batchRows;
    private readonly LiveSettleJson settle;
    private readonly List<(ResultSetBuffer Set, QueryBudget Budget)> segments = [];
    private readonly Dictionary<long, (long Tick, long Ms)> seen = [];
    private readonly List<uint> retiring = [];
    private ResultSetBuffer? current;
    private QueryBudget? currentBudget;
    private long settled;
    private long? before;
    private long ticks;
    private long segmentRows;
    private int segment = -1;
    private uint? rolledFrom;
    private bool restarted, changed;
    private LiveRow? pendingNote;

    public LiveAppendTable(LiveTableSet owner, LiveTableJson spec, int index)
    {
        if (spec.Mode != "append" || spec.Key.Count != 1) throw new ArgumentException("An append table has one key, its keyset id.", nameof(spec));
        this.owner = owner;
        this.spec = spec;
        this.index = index;
        key = spec.Columns.FindIndex(column => column.Id == spec.Key[0]);
        batchRows = Math.Clamp(spec.BatchRows > 0 ? spec.BatchRows : 5000, 1, owner.Limits.BatchRows);
        settle = spec.Settle ?? new LiveSettleJson(2, 5000);
    }

    public bool Started { get; private set; }
    /// <summary>Every id up to this one is final: the next read covers only the ids above it.</summary>
    public long SettledId => settled;
    /// <summary>The table holds only ids below this one (a start before an id), or null.</summary>
    public long? Before => before;
    /// <summary>The predicate the table started under (a source's own text: the filter and the args it reads by); a different
    /// one restarts it.</summary>
    public string? Predicate { get; private set; }
    /// <summary>How many rows the next read takes: the rows a tick may add, plus every unsettled id it will see again.</summary>
    public int ReadRows => batchRows + seen.Count;
    public int Unsettled => seen.Count;
    public int Segment => segment;
    /// <summary>The settled ids remembered at most: twice the rows a tick reads.</summary>
    public int DedupeBound => 2 * batchRows;

    /// <summary>Starts the table, or starts it again: every segment it had is retired (named in the next sample), and a new
    /// one begins with the note row, if any (it says what the start left out). The next read covers the ids after
    /// <paramref name="after"/>, and only those below <paramref name="below"/> when given.</summary>
    public void Start(long after, long? below, LiveRow? note, string? predicate)
    {
        if (Started)
        {
            restarted = true;
            if (current is not null) segments.Add((current, currentBudget!));
            foreach (var (set, _) in segments)
            {
                retiring.Add(set.ResultId);
                owner.Store.Release(set.ResultId);
            }
            segments.Clear();
            current = null;
            currentBudget = null;
            rolledFrom = null;
        }
        Started = true;
        seen.Clear();
        settled = Math.Max(0, after);
        before = below;
        Predicate = predicate;
        pendingNote = note;
        changed = true;
    }

    /// <summary>Appends the rows a read returned (ordered by id) that are new: above the settled id, below the end if any, and
    /// not appended already. Returns the sample when anything changed (rows, a roll, a start), and whether the budget stopped
    /// it (rows that did not fit are read again next time, since they were never seen).</summary>
    public LiveTableWrite<LiveAppendSample> Append(IReadOnlyList<LiveRow> rows, long nowMs)
    {
        if (!Started) throw new InvalidOperationException("Start the table first.");
        ticks++;
        var budget = false;
        if (current is null && !Open()) budget = true;
        if (!budget)
        {
            foreach (var row in rows)
            {
                if (row.Cells[key].Value is not long id || id <= settled || before is { } end && id >= end || seen.ContainsKey(id)) continue;
                if ((segmentRows >= owner.Limits.SegmentRows || currentBudget!.UsedBytes >= owner.Limits.SegmentBytes) && !Roll())
                {
                    budget = true;
                    break;
                }
                if (!LiveTableSet.Write(current!, row))
                {
                    // Out of budget: this segment stores nothing more, so the next write starts another; the row is read again.
                    budget = true;
                    Roll();
                    break;
                }
                segmentRows++;
                seen[id] = (ticks, nowMs);
                changed = true;
            }
        }
        Settle(nowMs);
        current?.Seal();
        if (current is null || !changed && !restarted && rolledFrom is null && retiring.Count == 0) return new(null, budget);
        var sample = new LiveAppendSample(index, current.Describe(), segment, rolledFrom, retiring.Count > 0 ? [.. retiring] : null, restarted ? true : null);
        retiring.Clear();
        rolledFrom = null;
        restarted = changed = false;
        return new(sample, budget);
    }

    /// <summary>Opens the first segment of a start, or a new one after a budget stop.</summary>
    private bool Open()
    {
        var budget = owner.NewBudget();
        var (columns, wires) = LiveTableSet.Shape(spec);
        if (owner.Store.Open(budget, 0, 1, 1, "rows", columns, wires) is not { } set) return false;
        current = set;
        currentBudget = budget;
        segment++;
        segmentRows = 0;
        changed = true;
        // A note that does not fit is left out: the rows after it hit the same budget, which the sample reports.
        if (pendingNote is { } note) LiveTableSet.Write(set, note);
        pendingNote = null;
        return true;
    }

    /// <summary>Completes the current segment and opens the next, keeping the newest segments (limits.live.segments): the oldest
    /// beyond them is released and named retired.</summary>
    private bool Roll()
    {
        if (current is not null)
        {
            current.Complete();
            rolledFrom = current.ResultId;
            segments.Add((current, currentBudget!));
            current = null;
            currentBudget = null;
        }
        while (segments.Count >= owner.Limits.Segments)
        {
            retiring.Add(segments[0].Set.ResultId);
            owner.Store.Release(segments[0].Set.ResultId);
            segments.RemoveAt(0);
        }
        return Open();
    }

    /// <summary>Settles the highest id first seen at least the settle window ago, then the lowest ids past the dedupe bound.</summary>
    private void Settle(long nowMs)
    {
        var next = settled;
        foreach (var (id, (tick, ms)) in seen)
            if (id > next && ticks - tick >= settle.Ticks && nowMs - ms >= settle.Ms) next = id;
        if (seen.Count > DedupeBound)
        {
            var open = seen.Keys.Where(id => id > next).Order().ToList();
            if (open.Count > DedupeBound) next = open[open.Count - DedupeBound - 1];
        }
        if (next == settled) return;
        settled = next;
        foreach (var id in seen.Keys.Where(id => id <= next).ToList()) seen.Remove(id);
    }

    internal void Keep(List<uint> first, List<uint> rest)
    {
        current?.Complete();
        if (current is not null) first.Add(current.ResultId);
        foreach (var (set, _) in Enumerable.Reverse(segments)) rest.Add(set.ResultId);
        segments.Clear();
        current = null;
    }

    internal uint[] Drain()
    {
        var ids = segments.Select(item => item.Set.ResultId).ToList();
        if (current is not null) ids.Add(current.ResultId);
        segments.Clear();
        current = null;
        return [.. ids];
    }
}
