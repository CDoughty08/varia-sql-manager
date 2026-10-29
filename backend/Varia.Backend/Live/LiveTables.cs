using System.Data.SqlTypes;
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

    /// <summary>decimal and numeric as a query shows them: up to precision 28 as a .NET decimal, above it as SQL Server's own
    /// text (a .NET decimal cannot hold every such value), sorted then as a double.</summary>
    public static LiveCell Of(SqlDecimal value)
    {
        if (value.IsNull) return Null;
        if (value.Precision <= 28) return Of(value.Value);
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        return new(value.ToDouble(), Ascii(buffer[..CellFormat.WriteSqlDecimal(buffer, value)]));
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

    /// <summary>The SQL types a live table stores, as the catalogue names them (src/shared/live/catalog.ts, liveDataTypes, which
    /// the embedded catalogue carries so a check can compare the two).</summary>
    public static IEnumerable<string> Types => Integers.Concat(Texts).Concat(Others);

    /// <summary>Whether the type a reader reports is the declared one (sysname reports as nvarchar, numeric as decimal).</summary>
    public static bool Matches(string declared, string reported) =>
        string.Equals(declared, reported, StringComparison.OrdinalIgnoreCase) || declared == "sysname" && string.Equals(reported, "nvarchar", StringComparison.OrdinalIgnoreCase)
        || declared == "numeric" && string.Equals(reported, "decimal", StringComparison.OrdinalIgnoreCase);

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
            "decimal" or "numeric" => LiveCell.Of(reader.GetSqlDecimal(ordinal)),
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
internal sealed record LiveSnapshotSettings(LiveSortArgs[]? Sort = null, LiveFilterArgs? Filter = null, Func<LiveRow, bool>? View = null, LiveTrackArgs? Track = null,
    Func<LiveRow, bool>? FacetScope = null);

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

    /// <summary>The result columns of a catalogue table: every cell is text, as its display; a tone column keeps its role, so the grid
    /// hides it and Copy and Save leave it out.</summary>
    internal static (List<ResultColumn> Columns, WireKind[] Wires) Shape(LiveTableJson spec) =>
        ([.. spec.Columns.Select(column => new ResultColumn(column.Name, column.DataType, "text", column.Role, Nullable: true))], [.. spec.Columns.Select(_ => WireKind.Text)]);

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
        var facets = spec.Facets is { Count: > 0 } named ? Facets(source, named, settings.FacetScope) : null;
        var lingers = spec.Departed && keyed && settings.Track is not null;
        present.Clear();
        if (lingers) foreach (var row in source) present.Add(row.Key(key));
        var filter = Filter(settings.Filter);
        rows.Clear();
        foreach (var row in source) if ((settings.View?.Invoke(row) ?? true) && filter(row)) rows.Add((row, false, rows.Count));
        if (lingers)
        {
            // A tracked row that left the source (not one the view or filter hides) stays one revision, at the row it had: the
            // list's first Linger keys (the grid's selected rows), not the rows it follows only to place the selection.
            var track = settings.Track!;
            foreach (var tracked in track.Keys.Take(Math.Clamp(track.Linger ?? track.Keys.Length, 0, track.Keys.Length)).Distinct(StringComparer.Ordinal))
            {
                if (present.Contains(tracked) || previousDeparted.Contains(tracked) || !previousRows.TryGetValue(tracked, out var at) || at.Index >= previousList.Count) continue;
                rows.Insert(Math.Min(at.Index, rows.Count), (previousList[at.Index], true, 0));
            }
            for (var i = 0; i < rows.Count; i++) rows[i] = rows[i] with { At = i };
        }
        // The sort keys for this table: a key naming another table, or a column this table lacks, leaves its order alone.
        var columns = (settings.Sort ?? []).Where(item => item.Table is null || item.Table == index)
            .Select(item => (Index: spec.Columns.FindIndex(column => column.Id == item.Column), item.Descending)).Where(item => item.Index >= 0).ToArray();
        if (columns.Length > 0)
        {
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
            // Only facets that will be sent take from the tick's allowance: a steady table's facets cost nothing, and one cut
            // before is sent whole once a tick has room for it.
            sentFacets ??= [];
            foreach (var facet in facets)
            {
                var sent = sentFacets.FindIndex(item => item.Column == facet.Column);
                if (sent >= 0 && SameFacet(sentFacets[sent], facet)) continue;
                var cut = Cut(facet);
                if (sent >= 0 && SameFacet(sentFacets[sent], cut)) continue;
                if (sent >= 0) sentFacets[sent] = cut;
                else sentFacets.Add(cut);
                (changedFacets ??= []).Add(cut);
            }
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
            ? [.. named.Select(id => spec.Columns.FindIndex(column => column.Id == id && LiveColumnJson.IsData(column))).Where(at => at >= 0)]
            // The hidden tone column is not data: text the user cannot see never matches.
            : [.. Enumerable.Range(0, spec.Columns.Count).Where(at => LiveColumnJson.IsData(spec.Columns[at]))];
        if (columns.Length == 0) return _ => true;
        return row => columns.Any(column => row.Cells[column].Text?.Contains(text, StringComparison.OrdinalIgnoreCase) == true);
    }

    /// <summary>Each facet column's distinct values over the rows the source gave that its facet scope keeps (every row
    /// without one; NULL left out), most frequent first, each cut at the facet text cap, at most the facet value count.</summary>
    private List<LiveFacet> Facets(IReadOnlyList<LiveRow> source, List<string> named, Func<LiveRow, bool>? scope)
    {
        var limits = owner.Limits;
        var facets = new List<LiveFacet>();
        // The scope is asked once a row, not once a row and column.
        bool[]? kept = scope is null ? null : [.. source.Select(scope)];
        foreach (var id in named.Take(limits.FacetColumns))
        {
            var column = spec.Columns.FindIndex(item => item.Id == id);
            if (column < 0) continue;
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var at = 0; at < source.Count; at++)
            {
                if (kept?[at] == false || source[at].Cells[column].Text is not { } text) continue;
                var value = CellFormat.Prefix(text, limits.FacetCharacters, out _).ToString();
                counts[value] = counts.GetValueOrDefault(value) + 1;
            }
            var values = new List<LiveFacetValue>();
            var more = false;
            foreach (var (text, count) in counts.OrderByDescending(item => item.Value).ThenBy(item => item.Key, StringComparer.Ordinal))
            {
                if (values.Count >= limits.FacetValues)
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

    /// <summary>A facet within what is left of the tick's facet text: the values that fit, most frequent first (more past them).</summary>
    private LiveFacet Cut(LiveFacet facet)
    {
        var fits = 0;
        while (fits < facet.Values.Count && owner.TakeFacetBytes(Encoding.UTF8.GetByteCount(facet.Values[fits].Text))) fits++;
        return fits == facet.Values.Count ? facet : new(facet.Column, [.. facet.Values.Take(fits)], true);
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
/// keeping two segments' worth (one that stopped early for memory counts what it holds) in at most limits.live.segmentResults
/// stored results; a new start (another filter or args) retires every segment and starts again. A row that was not
/// stored (out of budget, or past a second segment in one read) is never seen and nothing above it settles before it, so a
/// later read stores it once.</summary>
internal sealed class LiveAppendTable
{
    private readonly LiveTableSet owner;
    private readonly LiveTableJson spec;
    private readonly int index;
    private readonly int key;
    private readonly int batchRows;
    private readonly LiveSettleJson settle;
    /// <summary>The completed segments still readable, oldest first (the current one is not among them).</summary>
    private readonly List<ResultSetBuffer> segments = [];
    /// <summary>The segments of the start before this one: readable (the renderer still shows them) until this start's first read
    /// arrives, which releases them and names them retired, so a read that fails after a restart never leaves the renderer
    /// showing released results with nothing naming them.</summary>
    private readonly List<ResultSetBuffer> superseded = [];
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

    /// <summary>Starts the table, or starts it again: every segment it had is retired by the next read (named in its sample),
    /// and a new one begins with the note row, if any (it says what the start left out). The next read covers the ids after
    /// <paramref name="after"/>, and only those below <paramref name="below"/> when given.</summary>
    public void Start(long after, long? below, LiveRow? note, string? predicate)
    {
        if (Started)
        {
            restarted = true;
            if (current is not null)
            {
                current.Complete();
                segments.Add(current);
            }
            superseded.AddRange(segments);
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
    /// it. One read opens at most one segment, so every segment that holds rows is named by a sample; the rows it left out
    /// are read again next time, since they were never seen.</summary>
    public LiveTableWrite<LiveAppendSample> Append(IReadOnlyList<LiveRow> rows, long nowMs)
    {
        if (!Started) throw new InvalidOperationException("Start the table first.");
        ticks++;
        var budget = false;
        var opened = false;
        // The lowest new id left unstored: nothing at or above it settles this time.
        long? unstored = null;
        if (current is null)
        {
            // A start's segment opens even for an empty read, so its sample says the table restarted.
            opened = true;
            if (!Open()) budget = true;
        }
        foreach (var row in rows)
        {
            if (row.Cells[key].Value is not long id || id <= settled || before is { } end && id >= end || seen.ContainsKey(id)) continue;
            if (unstored is { } low)
            {
                unstored = Math.Min(low, id);
                continue;
            }
            if (current is null || !current.IsOpen || segmentRows >= owner.Limits.SegmentRows || currentBudget!.UsedBytes >= owner.Limits.SegmentBytes)
            {
                // A second new segment in one read would never be described (a sample names only the newest): the rest waits.
                if (opened || !Roll(row, out var refused))
                {
                    unstored = id;
                    budget |= !opened;
                    continue;
                }
                opened = true;
                if (refused)
                {
                    unstored = id;
                    budget = true;
                    continue;
                }
            }
            else if (!LiveTableSet.Write(current, row))
            {
                // Out of budget: this segment stores nothing more (its budget stopped), so it completes; a later read opens the
                // next one only once a row fits, and never retires a segment to make room.
                current.Complete();
                changed = true;
                unstored = id;
                budget = true;
                continue;
            }
            segmentRows++;
            seen[id] = (ticks, nowMs);
            changed = true;
        }
        Settle(nowMs, unstored);
        current?.Seal();
        if (current is null || !changed && !restarted && rolledFrom is null && retiring.Count == 0) return new(null, budget);
        var sample = new LiveAppendSample(index, current.Describe(), segment, rolledFrom, retiring.Count > 0 ? [.. retiring] : null, restarted ? true : null);
        retiring.Clear();
        rolledFrom = null;
        restarted = changed = false;
        return new(sample, budget);
    }

    /// <summary>Opens the first segment of a start, with its note row. The segments the start supersedes are released only
    /// together with an open that succeeds, so the sample that names them retired is always sent: when the budget refuses the
    /// open, they go first and their bytes pay for the new segment's metadata (they have the same columns), which nothing
    /// else can take in between.</summary>
    private bool Open()
    {
        var opened = OpenSet(false);
        if (opened is null && superseded.Count > 0)
        {
            Supersede();
            opened = OpenSet(true);
        }
        if (opened is null) return false;
        Supersede();
        (current, currentBudget) = opened.Value;
        segment++;
        segmentRows = 0;
        changed = true;
        // A note that does not fit is left out: the rows after it hit the same budget, which the sample reports.
        if (pendingNote is { } note) LiveTableSet.Write(current, note);
        pendingNote = null;
        return true;
    }

    /// <summary>A start's first segment is open: the segments it supersedes go now, named by its sample.</summary>
    private void Supersede()
    {
        foreach (var set in superseded)
        {
            retiring.Add(set.ResultId);
            owner.Store.Release(set.ResultId);
        }
        superseded.Clear();
    }

    private (ResultSetBuffer Set, QueryBudget Budget)? OpenSet(bool transfer)
    {
        var budget = owner.NewBudget();
        var (columns, wires) = LiveTableSet.Shape(spec);
        return owner.Store.Open(budget, 0, 1, 1, "rows", columns, wires, transfer) is { } set ? (set, budget) : null;
    }

    /// <summary>Moves on to a new segment whose first row is <paramref name="first"/>: only once that row is stored does the
    /// current segment complete (rolledFrom) and the oldest go, named retired, while the completed ones hold more than the
    /// kept segments' worth (<see cref="OverKept"/>) or the table would hold more than limits.live.segmentResults results.
    /// When the row does not fit, the new segment is dropped unseen and nothing is retired (<paramref name="refused"/>); false
    /// when not even a segment opens.</summary>
    private bool Roll(LiveRow first, out bool refused)
    {
        refused = false;
        if (OpenSet(false) is not { } next) return false;
        if (!LiveTableSet.Write(next.Set, first))
        {
            owner.Store.Release(next.Set.ResultId);
            refused = true;
            return true;
        }
        if (current is not null)
        {
            current.Complete();
            rolledFrom = current.ResultId;
            segments.Add(current);
        }
        while (segments.Count >= owner.Limits.SegmentResults || segments.Count >= owner.Limits.Segments && OverKept())
        {
            retiring.Add(segments[0].ResultId);
            owner.Store.Release(segments[0].ResultId);
            segments.RemoveAt(0);
        }
        (current, currentBudget) = next;
        segment++;
        segmentRows = 0;
        return true;
    }

    /// <summary>Whether the completed segments hold more than the kept segments' worth (limits.live.segments less the current
    /// one, at segmentRows or segmentBytes each). A segment that stopped early for memory counts only what it holds, so the
    /// rolls that follow a budget stop never cost a segment while the table stays under its caps.</summary>
    private bool OverKept()
    {
        var worth = owner.Limits.Segments - 1;
        return segments.Sum(set => set.RowsAvailable) > (long)owner.Limits.SegmentRows * worth || segments.Sum(set => set.Budget.UsedBytes) > owner.Limits.SegmentBytes * worth;
    }

    /// <summary>Settles the highest id first seen at least the settle window ago, then the lowest ids past the dedupe bound,
    /// never at or above an id this read left unstored (a late id below ids already seen would otherwise never be read again).</summary>
    private void Settle(long nowMs, long? unstored)
    {
        var next = settled;
        foreach (var (id, (tick, ms)) in seen)
            if (id > next && ticks - tick >= settle.Ticks && nowMs - ms >= settle.Ms) next = id;
        if (seen.Count > DedupeBound)
        {
            var open = seen.Keys.Where(id => id > next).Order().ToList();
            if (open.Count > DedupeBound) next = open[open.Count - DedupeBound - 1];
        }
        if (unstored is { } low) next = Math.Max(settled, Math.Min(next, low - 1));
        if (next == settled) return;
        settled = next;
        foreach (var id in seen.Keys.Where(id => id <= next).ToList()) seen.Remove(id);
    }

    internal void Keep(List<uint> first, List<uint> rest)
    {
        current?.Complete();
        if (current is not null) first.Add(current.ResultId);
        foreach (var set in Enumerable.Reverse(segments)) rest.Add(set.ResultId);
        // Superseded by a start whose read never arrived: no longer the table's.
        owner.Store.Release(superseded.Select(set => set.ResultId));
        superseded.Clear();
        segments.Clear();
        current = null;
    }

    internal uint[] Drain()
    {
        var ids = superseded.Concat(segments).Select(set => set.ResultId).ToList();
        if (current is not null) ids.Add(current.ResultId);
        superseded.Clear();
        segments.Clear();
        current = null;
        return [.. ids];
    }
}
